import type MarkdownIt from 'markdown-it';
import { findCriticMarks, matchCriticMarkup, parseCriticComment, type CriticMarkupKind } from '../foundation/criticMarkup';

const OPEN_BRACE_CODE = 0x7B;

const spanClass: Readonly<Record<CriticMarkupKind, string>> = {
  add: 'critic-add',
  del: 'critic-del',
  sub: 'critic-del',
  hl: 'critic-hl',
  comment: 'critic-comment'
};

function pushSpan(state: any, className: string, content: string, title?: string): void {
  const open = state.push('critic_open', 'span', 1);
  open.attrs = [['class', className], ...(title ? [['title', title]] : [])];
  // Inline Markdown (emphasis, links, code, inner marks) renders inside the mark.
  if (content) state.md.inline.parse(content, state.md, state.env, state.tokens);
  state.push('critic_close', 'span', -1);
}

/** A note is a numbered badge; its text opens on focus (click or Tab), without JavaScript. */
function pushNote(state: any, label: string, body: string, title?: string, type?: string | null, resolved = false): void {
  const classes = ['critic-note', ...(type ? [`critic-type-${type.toLowerCase()}`] : []), ...(resolved ? ['is-resolved'] : [])];
  state.push('critic_open', 'span', 1).attrs = [['class', classes.join(' ')]];
  const badge = state.push('critic_open', 'span', 1);
  badge.attrs = [['class', 'critic-badge'], ['tabindex', '0'], ['role', 'button'], ...(title ? [['title', title]] : [])];
  state.push('text', '', 0).content = label;
  state.push('critic_close', 'span', -1);
  state.push('critic_open', 'span', 1).attrs = [['class', 'critic-body']];
  if (body) state.push('text', '', 0).content = body;
  state.push('critic_close', 'span', -1);
  state.push('critic_close', 'span', -1);
}

function tokenize(state: any, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== OPEN_BRACE_CODE) return false;
  const match = matchCriticMarkup(state.src, state.pos, state.posMax);
  if (!match) return false;
  if (!silent) {
    const content = state.src.slice(state.pos + match.openLength, match.to - match.closeLength);
    if (match.kind === 'sub' && match.separator) {
      pushSpan(state, 'critic-del', state.src.slice(state.pos + match.openLength, match.separator.from));
      pushSpan(state, 'critic-add', state.src.slice(match.separator.to, match.to - match.closeLength));
    } else if (match.kind === 'comment') {
      const { id, author, date, body, type, resolved } = parseCriticComment(content);
      state.env.criticNotes = (state.env.criticNotes ?? 0) + 1;
      const label = type ? `${type} ${state.env.criticNotes}` : String(state.env.criticNotes);
      pushNote(state, label, author ? `${author}${date ? ` ${date}` : ''}: ${body}` : body, id ? `#${id}` : undefined, type, resolved);
    } else {
      pushSpan(state, spanClass[match.kind], content);
    }
  }
  state.pos = match.to;
  return true;
}

const CLOSE_DELIMITER: Readonly<Record<CriticMarkupKind, string>> = { add: '++}', del: '--}', sub: '~~}', hl: '==}', comment: '<<}' };
const SOURCE_BLOCKS = new Set(['fence', 'code_block', 'html_block']);

type TextHit = Readonly<{ child: number; offset: number }>;

/** Where `needle` sits among an inline token's top-level text children (first or last hit). */
function findInText(children: any[], needle: string, last: boolean): TextHit | null {
  let hit: TextHit | null = null;
  for (let child = 0; child < children.length; child += 1) {
    if (children[child].type !== 'text') continue;
    const offset = last ? children[child].content.lastIndexOf(needle) : children[child].content.indexOf(needle);
    if (offset < 0) continue;
    hit = { child, offset };
    if (!last) return hit;
  }
  return hit;
}

/** Replace `length` characters of a text child with `inserted` tokens; returns the index after them. */
function spliceText(state: any, children: any[], hit: TextHit, length: number, inserted: any[]): number {
  const token = children[hit.child];
  const before = token.content.slice(0, hit.offset);
  const after = token.content.slice(hit.offset + length);
  const parts: any[] = [];
  const text = (content: string) => {
    const part = new state.Token('text', '', 0);
    part.content = content;
    return part;
  };
  if (before) parts.push(text(before));
  parts.push(...inserted);
  const next = hit.child + parts.length;
  if (after) parts.push(text(after));
  children.splice(hit.child, 1, ...parts);
  return next;
}

function criticToken(state: any, nesting: 1 | -1, className = ''): any {
  const token = new state.Token(nesting === 1 ? 'critic_open' : 'critic_close', 'span', nesting);
  if (nesting === 1) token.attrs = [['class', className]];
  return token;
}

/**
 * A mark that opens in one block and closes in another (`{==` before a list, `==}` after it) never
 * reaches the inline rule whole. Once every block is parsed, its delimiters are still plain text:
 * remove them and wrap each block's share in its own span, so the HTML stays valid and source lines
 * stay where they were. A cross-block comment renders as styled text, not a numbered note.
 */
function crossBlockRule(state: any): void {
  const src: string = state.src;
  if (!src.includes('{')) return;
  const lineStarts = [0];
  for (let index = src.indexOf('\n'); index >= 0; index = src.indexOf('\n', index + 1)) lineStarts.push(index + 1);
  const lineOf = (position: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= position) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const sourceLines = new Set<number>();
  const inlines: any[] = [];
  for (const token of state.tokens) {
    if (!token.map) continue;
    if (SOURCE_BLOCKS.has(token.type)) for (let line = token.map[0]; line < token.map[1]; line += 1) sourceLines.add(line);
    if (token.type === 'inline' && token.children) inlines.push(token);
  }
  const blockAt = (line: number) => inlines.findIndex((token) => line >= token.map[0] && line < token.map[1]);
  const escaped = (position: number) => {
    let backslashes = 0;
    for (let index = position - 1; index >= 0 && src[index] === '\\'; index -= 1) backslashes += 1;
    return backslashes % 2 === 1;
  };
  let coveredTo = -1;
  for (const mark of findCriticMarks(src, (position) => sourceLines.has(lineOf(position)) || escaped(position))) {
    if (mark.from < coveredTo) continue;
    const first = blockAt(lineOf(mark.from));
    const last = blockAt(lineOf(mark.to - 1));
    if (first < 0 || last <= first) continue;
    const opener = src.slice(mark.from, mark.from + mark.openLength);
    const closer = CLOSE_DELIMITER[mark.kind];
    // The opener left as text is the last one in its block: earlier marks there were already parsed.
    const openHit = findInText(inlines[first].children, opener, true);
    const closeHit = findInText(inlines[last].children, closer, false);
    if (!openHit || !closeHit) continue;
    coveredTo = mark.to;
    const separatorBlock = mark.separator ? blockAt(lineOf(mark.separator.from)) : -1;
    const classAt = (block: number) => mark.kind === 'sub'
      ? (separatorBlock >= 0 && block > separatorBlock ? 'critic-add' : 'critic-del')
      : spanClass[mark.kind];
    // Closer first, so the opener's offsets in the first block stay valid when both are rewritten.
    spliceText(state, inlines[last].children, closeHit, closer.length, [criticToken(state, -1)]);
    inlines[last].children.unshift(criticToken(state, 1, classAt(last)));
    for (let block = first + 1; block < last; block += 1) {
      inlines[block].children.unshift(criticToken(state, 1, classAt(block)));
      inlines[block].children.push(criticToken(state, -1));
    }
    spliceText(state, inlines[first].children, openHit, opener.length, [criticToken(state, 1, classAt(first))]);
    inlines[first].children.push(criticToken(state, -1));
    // A substitution switches from the old text to the new one at `~>`, wherever that block is.
    if (separatorBlock >= first && separatorBlock <= last) {
      const separatorHit = findInText(inlines[separatorBlock].children, '~>', separatorBlock === first);
      if (separatorHit) spliceText(state, inlines[separatorBlock].children, separatorHit, 2, [criticToken(state, -1), criticToken(state, 1, 'critic-add')]);
    }
  }
}

export function installCriticMarkupTransform(md: MarkdownIt): void {
  // `{` is a text terminator, so this runs before Strikethrough can split {~~old~>new~~}.
  md.inline.ruler.before('text', 'meo_critic_markup', tokenize);
  // After text_join, so escaped and plain text sit in one token per run.
  md.core.ruler.after('text_join', 'meo_critic_cross_block', crossBlockRule);
}
