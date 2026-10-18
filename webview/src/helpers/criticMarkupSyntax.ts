import { RangeSetBuilder, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { SyntaxNodeRef } from '@lezer/common';
import { tags } from '@lezer/highlight';
import type { Element, MarkdownConfig } from '@lezer/markdown';
import { findCriticMarks, matchCriticMarkup, type CriticMark, type CriticMarkupKind } from '../../../src/foundation/criticMarkup';
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

const sourceMarkerDecoration = Decoration.mark({ class: 'meo-md-critic-marker' });

function buildSourceCriticDecorations(state: EditorState): DecorationSet {
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

/** Every CriticMarkup mark in the document, code excluded; shared by review actions and the comment list. */
export function criticMarksInState(state: EditorState): CriticMark[] {
  const tree = currentSyntaxTree(state);
  return findCriticMarks(state.doc.toString(), (position) => insideNonProse(tree, position));
}

function buildCrossBlockCriticDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const tree = currentSyntaxTree(state);
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];
  for (let from = text.indexOf('{'); from >= 0; from = text.indexOf('{', from + 1)) {
    const match = matchCriticMarkup(text, from);
    if (!match || match.to - from > CROSS_BLOCK_MAX_LENGTH) continue;
    const start = tree.resolveInner(from, 1);
    if (start.name.startsWith('Critic')) continue;
    if (insideNonProse(tree, from)) continue;
    const active = state.selection.ranges.some((range) => range.from <= match.to && range.to >= from);
    const marker = active ? crossBlockMarkerActive : crossBlockMarker;
    const contentFrom = from + match.openLength;
    const contentTo = match.to - match.closeLength;
    ranges.push({ from, to: contentFrom, decoration: marker }, { from: contentTo, to: match.to, decoration: marker });
    if (match.kind === 'sub' && match.separator) {
      ranges.push({ from: match.separator.from, to: match.separator.to, decoration: marker });
      if (match.separator.from > contentFrom) ranges.push({ from: contentFrom, to: match.separator.from, decoration: criticMarkDecoration('meo-md-critic-del') });
      if (contentTo > match.separator.to) ranges.push({ from: match.separator.to, to: contentTo, decoration: criticMarkDecoration('meo-md-critic-add') });
    } else {
      const className = { add: 'meo-md-critic-add', del: 'meo-md-critic-del', hl: 'meo-md-critic-hl', comment: 'meo-md-critic-comment' }[match.kind as 'add'];
      if (className && contentTo > contentFrom) ranges.push({ from: contentFrom, to: contentTo, decoration: criticMarkDecoration(className) });
    }
    from = match.to - 1;
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
