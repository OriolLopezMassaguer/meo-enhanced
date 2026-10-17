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
