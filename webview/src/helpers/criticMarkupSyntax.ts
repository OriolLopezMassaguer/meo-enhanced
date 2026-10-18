import { RangeSetBuilder, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { SyntaxNodeRef } from '@lezer/common';
import { tags } from '@lezer/highlight';
import type { Element, MarkdownConfig } from '@lezer/markdown';
import {
  criticCommentTagRange, findCriticMarks, matchCriticMarkup, type CriticMark, type CriticMarkupKind
} from '../../../src/foundation/criticMarkup';
import { currentSyntaxTree, syntaxTreeChanged } from './markdownSyntax';

const OPEN_BRACE_CODE = 123;

const nodeNames: Readonly<Record<CriticMarkupKind, string>> = {
  add: 'CriticAdd',
  del: 'CriticDel',
  sub: 'CriticSub',
  hl: 'CriticHighlight',
  comment: 'CriticComment'
};

/** Presentation class for a content range, shared by Live and Source. */
export const criticContentClass: Readonly<Record<string, string>> = {
  CriticAdd: 'meo-md-critic-add',
  CriticDel: 'meo-md-critic-del',
  CriticHighlight: 'meo-md-critic-hl',
  CriticComment: 'meo-md-critic-comment'
};

export const criticNodeNames: ReadonlySet<string> = new Set([...Object.values(nodeNames), 'CriticMark', 'CriticSubSep']);

export const criticMarkdownExtension: MarkdownConfig = {
  defineNodes: [
    ...Object.values(nodeNames),
    { name: 'CriticMark', style: tags.processingInstruction },
    { name: 'CriticSubSep', style: tags.processingInstruction }
  ],
  parseInline: [{
    name: 'CriticMarkup',
    // `{` starts nothing else in Markdown; consuming the whole mark here also keeps
    // `~~` inside {~~old~>new~~} away from the Strikethrough delimiter run.
    before: 'Escape',
    parse(context, next, pos) {
      if (next !== OPEN_BRACE_CODE) return -1;
      const start = pos - context.offset;
      const match = matchCriticMarkup(context.text, start);
      if (!match) return -1;
      const from = pos;
      const to = context.offset + match.to;
      // Emphasis, links, code and inner marks keep working inside a mark; a comment is plain text.
      const inner = (innerFrom: number, innerTo: number): Element[] => match.kind === 'comment' || innerTo <= innerFrom
        ? []
        : context.parser.parseInline(context.slice(innerFrom, innerTo), innerFrom);
      const contentFrom = from + match.openLength;
      const contentTo = to - match.closeLength;
      const children: Element[] = [context.elt('CriticMark', from, contentFrom)];
      if (match.separator) {
        const separatorFrom = context.offset + match.separator.from;
        const separatorTo = context.offset + match.separator.to;
        children.push(...inner(contentFrom, separatorFrom), context.elt('CriticSubSep', separatorFrom, separatorTo), ...inner(separatorTo, contentTo));
      } else {
        children.push(...inner(contentFrom, contentTo));
      }
      children.push(context.elt('CriticMark', contentTo, to));
      return context.addElement(context.elt(nodeNames[match.kind], from, to, children));
    }
  }]
};

/** Ranges that carry presentation: content between the delimiters; `sub` yields old and new. */
export function criticContentRanges(node: SyntaxNodeRef): Array<{ from: number; to: number; className: string }> {
  const ranges: Array<{ from: number; to: number; className: string }> = [];
  const className = criticContentClass[node.name];
  if (className && node.to - node.from > 6) {
    ranges.push({ from: node.from + 3, to: node.to - 3, className });
  } else if (node.name === 'CriticSub') {
    const separator = node.node.getChild('CriticSubSep');
    if (!separator) return ranges;
    if (separator.from > node.from + 3) ranges.push({ from: node.from + 3, to: separator.from, className: 'meo-md-critic-del' });
    if (node.to - 3 > separator.to) ranges.push({ from: separator.to, to: node.to - 3, className: 'meo-md-critic-add' });
  }
  return ranges;
}

const markDecorations = new Map<string, Decoration>();
export function criticMarkDecoration(className: string): Decoration {
  let decoration = markDecorations.get(className);
  if (!decoration) {
    decoration = Decoration.mark({ class: className });
    markDecorations.set(className, decoration);
  }
  return decoration;
}

/** Decorations for the `[TODO]`-style tag of a comment mark spanning `markFrom..markTo` (delimiters included). */
export function criticTagDecorations(text: string, markFrom: number, markTo: number): Array<{ from: number; to: number; decoration: Decoration }> {
  const contentFrom = markFrom + 3;
  const tag = criticCommentTagRange(text.slice(contentFrom, markTo - 3));
  return tag ? [{
    from: contentFrom + tag.from,
    to: contentFrom + tag.to,
    decoration: criticMarkDecoration(`meo-md-critic-tag meo-md-critic-tag-${tag.type.toLowerCase()}`)
  }] : [];
}

const sourceMarkerDecoration = Decoration.mark({ class: 'meo-md-critic-marker' });

function buildSourceCriticDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];
  currentSyntaxTree(state).iterate({
    enter(node: SyntaxNodeRef) {
      if (node.name === 'CriticMark' || node.name === 'CriticSubSep') {
        ranges.push({ from: node.from, to: node.to, decoration: sourceMarkerDecoration });
        return;
      }
      for (const range of criticContentRanges(node)) {
        ranges.push({ from: range.from, to: range.to, decoration: criticMarkDecoration(range.className) });
      }
      if (node.name === 'CriticComment') ranges.push(...criticTagDecorations(text, node.from, node.to));
    }
  });
  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) builder.add(range.from, range.to, range.decoration);
  return builder.finish();
}

/** Source keeps every character visible; it only tints the marks. */
export const sourceCriticField = StateField.define<DecorationSet>({
  create: buildSourceCriticDecorations,
  update(decorations, transaction) {
    return transaction.docChanged || syntaxTreeChanged(transaction)
      ? buildSourceCriticDecorations(transaction.state)
      : decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

// A mark can open in one block and close in another ({== before a list, ==} after it).
// Lezer parses inline syntax one block at a time, so those marks are found here, on the
// document text, and decorated for both Live and Source.
const CROSS_BLOCK_MAX_LENGTH = 20000;
const nonProseAncestors = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'CodeText', 'HTMLBlock', 'Comment', 'CommentBlock']);
const crossBlockMarker = Decoration.mark({ class: 'meo-md-marker meo-md-critic-marker' });
const crossBlockMarkerActive = Decoration.mark({ class: 'meo-md-marker-active meo-md-critic-marker-active' });

function insideNonProse(tree: ReturnType<typeof currentSyntaxTree>, position: number): boolean {
  for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(position, 1); node; node = node.parent) {
    if (nonProseAncestors.has(node.name)) return true;
  }
  return false;
}

const marksCache = new WeakMap<object, { tree: object; marks: CriticMark[] }>();

/**
 * Every CriticMarkup mark in the document, code excluded; shared by review actions, the comment list
 * and the cross-block decorations. Cached per document and syntax tree, so moving the cursor does not
 * rescan the whole text.
 */
export function criticMarksInState(state: EditorState): CriticMark[] {
  const tree = currentSyntaxTree(state);
  const cached = marksCache.get(state.doc);
  if (cached && cached.tree === tree) return cached.marks;
  const marks = findCriticMarks(state.doc.toString(), (position) => insideNonProse(tree, position));
  marksCache.set(state.doc, { tree, marks });
  return marks;
}

function buildCrossBlockCriticDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const tree = currentSyntaxTree(state);
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];
  for (const mark of criticMarksInState(state)) {
    const from = mark.from;
    // Marks that sit inside one block are decorated from the Lezer tree.
    if (tree.resolveInner(from, 1).name.startsWith('Critic')) continue;
    const active = state.selection.ranges.some((range) => range.from <= mark.to && range.to >= from);
    const marker = active ? crossBlockMarkerActive : crossBlockMarker;
    const contentFrom = from + mark.openLength;
    const contentTo = mark.to - mark.closeLength;
    ranges.push({ from, to: contentFrom, decoration: marker }, { from: contentTo, to: mark.to, decoration: marker });
    if (mark.kind === 'sub' && mark.separator) {
      ranges.push({ from: mark.separator.from, to: mark.separator.to, decoration: marker });
      if (mark.separator.from > contentFrom) ranges.push({ from: contentFrom, to: mark.separator.from, decoration: criticMarkDecoration('meo-md-critic-del') });
      if (contentTo > mark.separator.to) ranges.push({ from: mark.separator.to, to: contentTo, decoration: criticMarkDecoration('meo-md-critic-add') });
    } else {
      const className = { add: 'meo-md-critic-add', del: 'meo-md-critic-del', hl: 'meo-md-critic-hl', comment: 'meo-md-critic-comment' }[mark.kind as 'add'];
      if (className && contentTo > contentFrom) ranges.push({ from: contentFrom, to: contentTo, decoration: criticMarkDecoration(className) });
      if (mark.kind === 'comment') ranges.push(...criticTagDecorations(text, from, mark.to));
    }
  }
  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) builder.add(range.from, range.to, range.decoration);
  return builder.finish();
}

export const crossBlockCriticField = StateField.define<DecorationSet>({
  create: buildCrossBlockCriticDecorations,
  update(decorations, transaction) {
    return transaction.docChanged || transaction.selection || syntaxTreeChanged(transaction)
      ? buildCrossBlockCriticDecorations(transaction.state)
      : decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});
