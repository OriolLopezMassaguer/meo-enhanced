export type CriticMarkupKind = 'add' | 'del' | 'sub' | 'hl' | 'comment';

export type CriticMarkupMatch = Readonly<{
  kind: CriticMarkupKind;
  /** Exclusive end of the whole mark, closing delimiter included. */
  to: number;
  /** Length of the opening delimiter, e.g. 3 for `{++`. */
  openLength: number;
  /** Length of the closing delimiter, e.g. 3 for `++}`. */
  closeLength: number;
  /** Substitution only: `~>` separator range. */
  separator?: Readonly<{ from: number; to: number }>;
}>;

const OPEN_CHAR = '{';
const DELIMITERS: Readonly<Record<string, Readonly<{ kind: CriticMarkupKind; close: string }>>> = {
  '++': { kind: 'add', close: '++}' },
  '--': { kind: 'del', close: '--}' },
  '~~': { kind: 'sub', close: '~~}' },
  '==': { kind: 'hl', close: '==}' },
  '>>': { kind: 'comment', close: '<<}' }
};

/**
 * CriticMarkup: `{++add++}`, `{--del--}`, `{~~old~>new~~}`, `{==mark==}`, `{>>note<<}`.
 * Content is literal text and must not be empty; an unclosed mark is plain text.
 * Backslash escapes are resolved by the host parser before this runs.
 */
export function matchCriticMarkup(text: string, from: number, end = text.length): CriticMarkupMatch | null {
  if (text[from] !== OPEN_CHAR) return null;
  const delimiter = DELIMITERS[text.slice(from + 1, from + 3)];
  if (!delimiter) return null;
  const contentFrom = from + 3;
  const closeFrom = text.indexOf(delimiter.close, contentFrom + 1);
  if (closeFrom < 0 || closeFrom + delimiter.close.length > end) return null;
  const match = { kind: delimiter.kind, to: closeFrom + delimiter.close.length, openLength: 3, closeLength: 3 };
  if (delimiter.kind !== 'sub') return match;
  const separatorFrom = text.indexOf('~>', contentFrom);
  // Both halves may be empty (pure insertion or deletion), but the separator is required.
  if (separatorFrom < 0 || separatorFrom + 2 > closeFrom) return null;
  return { ...match, separator: { from: separatorFrom, to: separatorFrom + 2 } };
}

/** Closed set of comment types, written `[TODO]` right after the author. */
export const criticCommentTypes = ['TODO', 'DUDA', 'FUENTE', 'REVISAR', 'OK'] as const;
export type CriticCommentType = typeof criticCommentTypes[number];

const TYPE_TAG = new RegExp(`^\\[(${criticCommentTypes.join('|')})\\](?:\\s+|$)`);

export type CriticCommentParts = Readonly<{
  id: string | null;
  author: string | null;
  /** ISO date written after the author: `@Oriol 2026-10-18:`. */
  date: string | null;
  /** A body that starts with `[x] ` is a resolved comment; the marker is not part of `body`. */
  resolved: boolean;
  /** `[TODO]`-style tag after the author (and after the resolved marker); not part of `body`. */
  type: CriticCommentType | null;
  body: string;
}>;

const RESOLVED_MARKER = '[x] ';
const DATE_AFTER_AUTHOR = /^(.*?)\s+(\d{4}-\d{2}-\d{2})$/;

/**
 * `#c17 @Oriol 2026-10-18: [x] text` -> id `c17`, author `Oriol`, date `2026-10-18`, resolved, body `text`.
 * Every prefix is optional. The date stays inside the author token, so tools that read
 * everything up to the first `:` as the author keep working.
 */
export function parseCriticComment(content: string): CriticCommentParts {
  let rest = content.trim();
  let id: string | null = null;
  let author: string | null = null;
  let date: string | null = null;
  const idMatch = /^#([\w.-]+)\s*/.exec(rest);
  if (idMatch) {
    id = idMatch[1];
    rest = rest.slice(idMatch[0].length);
  }
  const authorMatch = /^@([^:\n]+):\s*/.exec(rest);
  if (authorMatch) {
    const token = authorMatch[1].trim();
    const dated = DATE_AFTER_AUTHOR.exec(token);
    author = dated ? dated[1].trim() : token;
    date = dated ? dated[2] : null;
    rest = rest.slice(authorMatch[0].length);
  }
  const resolved = rest.toLowerCase().startsWith(RESOLVED_MARKER);
  if (resolved) rest = rest.slice(RESOLVED_MARKER.length);
  const typeMatch = TYPE_TAG.exec(rest);
  if (typeMatch) rest = rest.slice(typeMatch[0].length);
  return { id, author, date, resolved, type: typeMatch ? typeMatch[1] as CriticCommentType : null, body: rest };
}

/** Where the `[TODO]`-style tag sits inside a comment's content (offsets relative to that content). */
export function criticCommentTagRange(content: string): Readonly<{ from: number; to: number; type: CriticCommentType }> | null {
  const header = /^\s*(?:#[\w.-]+\s*)?(?:@[^:\n]+:\s*)?(?:\[x\]\s+)?/i.exec(content)![0];
  const tag = TYPE_TAG.exec(content.slice(header.length));
  if (!tag) return null;
  return { from: header.length, to: header.length + tag[1].length + 2, type: tag[1] as CriticCommentType };
}

/** Toggle the resolved marker of a comment mark; the change replaces only the marker. */
export function toggleCommentResolved(text: string, mark: CriticMark): CriticResolution {
  const contentFrom = mark.from + mark.openLength;
  const content = text.slice(contentFrom, mark.to - mark.closeLength);
  const header = /^\s*(?:#[\w.-]+\s*)?(?:@[^:\n]+:\s*)?/.exec(content)![0];
  const bodyFrom = contentFrom + header.length;
  const resolved = text.slice(bodyFrom, bodyFrom + RESOLVED_MARKER.length).toLowerCase() === RESOLVED_MARKER;
  return resolved
    ? { from: bodyFrom, to: bodyFrom + RESOLVED_MARKER.length, insert: '' }
    : { from: bodyFrom, to: bodyFrom, insert: RESOLVED_MARKER };
}

export type CriticMark = CriticMarkupMatch & Readonly<{ from: number }>;

/** A review decision covers one unit: a mark, or a highlight with the comment glued to it. */
export type CriticUnit = Readonly<{
  from: number;
  to: number;
  kind: CriticMarkupKind;
  /** The comment glued to a highlight: `{==text==}{>>#c1 note<<}`. */
  comment?: CriticMark;
  mark: CriticMark;
}>;

const CROSS_BLOCK_MAX_LENGTH = 20000;

/**
 * Every mark in the document, sorted by start, including marks that open in one block and close
 * in another and marks nested inside other marks (`{++A {--B--} C++}`). A comment body is plain
 * text, so nothing nests inside a comment. Marks nest but never overlap: an inner match that runs
 * past the content of its parent is not a mark. `skip` lets the caller exclude positions that are
 * not prose (code, escapes, math, link destinations).
 */
export function findCriticMarks(text: string, skip: (position: number) => boolean = () => false): CriticMark[] {
  const marks: CriticMark[] = [];
  // Content ends of the marks that enclose the scan position, innermost last.
  const parents: number[] = [];
  for (let from = text.indexOf('{'); from >= 0; from = text.indexOf('{', from + 1)) {
    while (parents.length && from >= parents[parents.length - 1]) parents.pop();
    const match = matchCriticMarkup(text, from);
    if (!match || match.to - from > CROSS_BLOCK_MAX_LENGTH || skip(from)) continue;
    if (parents.length && match.to > parents[parents.length - 1]) continue;
    marks.push({ ...match, from });
    if (match.kind === 'comment') from = match.to - 1;
    else {
      parents.push(match.to - match.closeLength);
      from += match.openLength - 1;
    }
  }
  return marks;
}

export function groupCriticUnits(marks: readonly CriticMark[]): CriticUnit[] {
  const commentsByStart = new Map<number, CriticMark>();
  for (const mark of marks) if (mark.kind === 'comment') commentsByStart.set(mark.from, mark);
  const glued = new Set<CriticMark>();
  const units: CriticUnit[] = [];
  for (const mark of marks) {
    if (glued.has(mark)) continue;
    // The glued comment starts where the highlight ends; inner marks of the highlight come first.
    const comment = mark.kind === 'hl' ? commentsByStart.get(mark.to) : undefined;
    if (comment) {
      glued.add(comment);
      units.push({ from: mark.from, to: comment.to, kind: 'hl', mark, comment });
    } else {
      units.push({ from: mark.from, to: mark.to, kind: mark.kind, mark });
    }
  }
  return units;
}

/** The innermost unit containing `position` (delimiters included), or null. */
export function criticUnitAt(units: readonly CriticUnit[], position: number): CriticUnit | null {
  let found: CriticUnit | null = null;
  for (const unit of units) {
    if (position < unit.from || position > unit.to) continue;
    if (!found || unit.to - unit.from < found.to - found.from) found = unit;
  }
  return found;
}

export type CriticResolution = Readonly<{ from: number; to: number; insert: string }>;

/** Accept keeps the proposed text, reject keeps the original; both drop the delimiters and notes. */
export function resolveCriticUnit(text: string, unit: CriticUnit, decision: 'accept' | 'reject'): CriticResolution {
  const kept = keptRange(unit, decision);
  return { from: unit.from, to: unit.to, insert: kept ? text.slice(kept.from, kept.to) : '' };
}

/** The part of a unit that survives the decision, or null when nothing does. */
function keptRange(unit: CriticUnit, decision: 'accept' | 'reject'): Readonly<{ from: number; to: number }> | null {
  const { mark } = unit;
  const contentFrom = mark.from + mark.openLength;
  const contentTo = mark.to - mark.closeLength;
  switch (mark.kind) {
    case 'add':
      return decision === 'accept' ? { from: contentFrom, to: contentTo } : null;
    case 'del':
      return decision === 'accept' ? null : { from: contentFrom, to: contentTo };
    case 'sub':
      if (!mark.separator) return null;
      return decision === 'accept' ? { from: mark.separator.to, to: contentTo } : { from: contentFrom, to: mark.separator.from };
    case 'hl':
      return { from: contentFrom, to: contentTo };
    case 'comment':
      return null;
  }
}

/** `c07` -> next is `c08`; keeps the widest zero padding seen. Ids come from comment marks only. */
export function nextCommentId(marks: readonly CriticMark[], text: string, prefix = 'c'): string {
  let highest = 0;
  let width = 2;
  for (const mark of marks) {
    if (mark.kind !== 'comment') continue;
    const { id } = parseCriticComment(text.slice(mark.from + mark.openLength, mark.to - mark.closeLength));
    const found = id && id.startsWith(prefix) ? /^\d+$/.exec(id.slice(prefix.length)) : null;
    if (!found) continue;
    highest = Math.max(highest, Number(found[0]));
    width = Math.max(width, found[0].length);
  }
  return `${prefix}${String(highest + 1).padStart(width, '0')}`;
}

export type CommentInsertion = Readonly<{ insert: string; cursor: number }>;

/** `{==selection==}{>>#c01 @author: <<}`; the cursor lands where the note text goes. */
export function buildCommentInsertion(selected: string, id: string, author: string, date = ''): CommentInsertion {
  // A date rides on the author token; without an author there is nothing to attach it to.
  const who = author.trim() ? ` @${author.trim()}${date ? ` ${date}` : ''}:` : '';
  const head = `{>>#${id}${who} `;
  const highlight = selected ? `{==${selected}==}` : '';
  return { insert: `${highlight}${head}<<}`, cursor: highlight.length + head.length };
}

/** Notes and plain highlights are not changes: a bulk action leaves them alone unless the note is resolved. */
function isOpenReviewNote(text: string, unit: CriticUnit): boolean {
  if (unit.kind !== 'comment' && unit.kind !== 'hl') return false;
  const note = unit.kind === 'comment' ? unit.mark : unit.comment;
  if (!note) return true;
  return !parseCriticComment(text.slice(note.from + note.openLength, note.to - note.closeLength)).resolved;
}

/**
 * Resolve every change (or only those fully inside `range`) as one set of non-overlapping edits,
 * ready to dispatch as a single undoable transaction. Additions, deletions and substitutions are
 * always resolved; a note, or a highlight with a note, is only cleared once it is marked `[x]`,
 * so "accept all" never throws away open comments.
 */
export function resolveAllCriticUnits(
  text: string,
  units: readonly CriticUnit[],
  decision: 'accept' | 'reject',
  range?: Readonly<{ from: number; to: number }>
): CriticResolution[] {
  const resolvable = (node: UnitNode): boolean =>
    (!range || (node.unit.from >= range.from && node.unit.to <= range.to)) && !isOpenReviewNote(text, node.unit);
  // The text of [from, to) with each unit inside it resolved, or kept with its own inner units resolved.
  const render = (from: number, to: number, children: readonly UnitNode[]): string => {
    let output = '';
    let cursor = from;
    for (const child of children) {
      if (child.unit.from < cursor || child.unit.to > to) continue;
      output += text.slice(cursor, child.unit.from) + (resolvable(child) ? resolved(child) : render(child.unit.from, child.unit.to, child.children));
      cursor = child.unit.to;
    }
    return output + text.slice(cursor, to);
  };
  const resolved = (node: UnitNode): string => {
    const kept = keptRange(node.unit, decision);
    return kept ? render(kept.from, kept.to, node.children) : '';
  };
  // A resolved unit is one edit that already covers its inner units; a kept unit lets its inner
  // units resolve as separate edits. Either way the edits never overlap.
  const collect = (nodes: readonly UnitNode[]): CriticResolution[] => nodes.flatMap((node) => resolvable(node)
    ? [{ from: node.unit.from, to: node.unit.to, insert: resolved(node) }]
    : collect(node.children));
  return collect(nestCriticUnits(units));
}

type UnitNode = Readonly<{ unit: CriticUnit; children: UnitNode[] }>;

/** Units as a forest: each unit holds the units nested inside it, in document order. */
function nestCriticUnits(units: readonly CriticUnit[]): UnitNode[] {
  const sorted = [...units].sort((left, right) => left.from - right.from || right.to - left.to);
  const roots: UnitNode[] = [];
  const stack: UnitNode[] = [];
  for (const unit of sorted) {
    while (stack.length && unit.from >= stack[stack.length - 1].unit.to) stack.pop();
    const node: UnitNode = { unit, children: [] };
    const parent = stack[stack.length - 1];
    if (parent && unit.to <= parent.unit.to) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}
