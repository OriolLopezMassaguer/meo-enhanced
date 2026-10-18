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

export type CriticCommentParts = Readonly<{ id: string | null; author: string | null; body: string }>;

/** `#c17 @Oriol: text` -> id `c17`, author `Oriol`, body `text`. Both prefixes are optional. */
export function parseCriticComment(content: string): CriticCommentParts {
  let rest = content.trim();
  let id: string | null = null;
  let author: string | null = null;
  const idMatch = /^#([\w.-]+)\s*/.exec(rest);
  if (idMatch) {
    id = idMatch[1];
    rest = rest.slice(idMatch[0].length);
  }
  const authorMatch = /^@([^:\n]+):\s*/.exec(rest);
  if (authorMatch) {
    author = authorMatch[1].trim();
    rest = rest.slice(authorMatch[0].length);
  }
  return { id, author, body: rest };
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
 * Every mark in the document, including marks that open in one block and close in another.
 * `skip` lets the caller exclude positions that are not prose (code spans, fenced code).
 */
export function findCriticMarks(text: string, skip: (position: number) => boolean = () => false): CriticMark[] {
  const marks: CriticMark[] = [];
  for (let from = text.indexOf('{'); from >= 0; from = text.indexOf('{', from + 1)) {
    const match = matchCriticMarkup(text, from);
    if (!match || match.to - from > CROSS_BLOCK_MAX_LENGTH || skip(from)) continue;
    marks.push({ ...match, from });
    from = match.to - 1;
  }
  return marks;
}

export function groupCriticUnits(marks: readonly CriticMark[]): CriticUnit[] {
  const units: CriticUnit[] = [];
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    const next = marks[index + 1];
    if (mark.kind === 'hl' && next?.kind === 'comment' && next.from === mark.to) {
      units.push({ from: mark.from, to: next.to, kind: 'hl', mark, comment: next });
      index += 1;
    } else {
      units.push({ from: mark.from, to: mark.to, kind: mark.kind, mark });
    }
  }
  return units;
}

/** The unit containing `position` (delimiters included), or null. */
export function criticUnitAt(units: readonly CriticUnit[], position: number): CriticUnit | null {
  return units.find((unit) => position >= unit.from && position <= unit.to) ?? null;
}

export type CriticResolution = Readonly<{ from: number; to: number; insert: string }>;

/** Accept keeps the proposed text, reject keeps the original; both drop the delimiters and notes. */
export function resolveCriticUnit(text: string, unit: CriticUnit, decision: 'accept' | 'reject'): CriticResolution {
  const { mark } = unit;
  const contentFrom = mark.from + mark.openLength;
  const contentTo = mark.to - mark.closeLength;
  let insert = '';
  switch (mark.kind) {
    case 'add':
      insert = decision === 'accept' ? text.slice(contentFrom, contentTo) : '';
      break;
    case 'del':
      insert = decision === 'accept' ? '' : text.slice(contentFrom, contentTo);
      break;
    case 'sub':
      insert = mark.separator
        ? decision === 'accept' ? text.slice(mark.separator.to, contentTo) : text.slice(contentFrom, mark.separator.from)
        : '';
      break;
    case 'hl':
      insert = text.slice(contentFrom, contentTo);
      break;
    case 'comment':
      insert = '';
      break;
  }
  return { from: unit.from, to: unit.to, insert };
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
export function buildCommentInsertion(selected: string, id: string, author: string): CommentInsertion {
  const head = `{>>#${id}${author.trim() ? ` @${author.trim()}:` : ''} `;
  const highlight = selected ? `{==${selected}==}` : '';
  return { insert: `${highlight}${head}<<}`, cursor: highlight.length + head.length };
}
