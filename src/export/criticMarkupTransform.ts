import type MarkdownIt from 'markdown-it';
import { matchCriticMarkup, parseCriticComment, type CriticMarkupKind } from '../foundation/criticMarkup';

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
  if (content) state.push('text', '', 0).content = content;
  state.push('critic_close', 'span', -1);
}

/** A note is a numbered badge; its text opens on focus (click or Tab), without JavaScript. */
function pushNote(state: any, label: string, body: string, title?: string): void {
  state.push('critic_open', 'span', 1).attrs = [['class', 'critic-note']];
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
      const { id, author, body } = parseCriticComment(content);
      state.env.criticNotes = (state.env.criticNotes ?? 0) + 1;
      pushNote(state, String(state.env.criticNotes), author ? `${author}: ${body}` : body, id ? `#${id}` : undefined);
    } else {
      pushSpan(state, spanClass[match.kind], content);
    }
  }
  state.pos = match.to;
  return true;
}

export function installCriticMarkupTransform(md: MarkdownIt): void {
  // `{` is a text terminator, so this runs before Strikethrough can split {~~old~>new~~}.
  md.inline.ruler.before('text', 'meo_critic_markup', tokenize);
}
