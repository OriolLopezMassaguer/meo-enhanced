import { RangeSetBuilder, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { SyntaxNodeRef } from '@lezer/common';
import { tags } from '@lezer/highlight';
import type { Element, MarkdownConfig } from '@lezer/markdown';
import { matchCriticMarkup, type CriticMarkupKind } from '../../../src/foundation/criticMarkup';
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
      const children: Element[] = [context.elt('CriticMark', from, from + match.openLength)];
      if (match.separator) {
        children.push(context.elt('CriticSubSep', context.offset + match.separator.from, context.offset + match.separator.to));
      }
      children.push(context.elt('CriticMark', to - match.closeLength, to));
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
