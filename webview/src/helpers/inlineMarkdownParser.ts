import { markdownLanguage } from '@codemirror/lang-markdown';
import type { MarkdownParser } from '@lezer/markdown';
import { criticMarkdownExtension } from './criticMarkupSyntax';
import { footnoteMarkdownExtension } from './footnotes';
import { highlightMarkdownExtension } from './highlightSyntax';
import { inlineScriptMarkdownExtension } from './inlineStyles';
import { collectInlineMathExcludedRanges, createMathLiteralSyntaxExtension, htmlCodeLiteralSyntaxExtension } from './markdownLiteralSyntax';
import { createPunctuationInlineStyleExtension } from './punctuationSyntax';
import { wikiImageMarkdownExtension } from '../../../src/foundation/wikiReference';

const literalExtensions = [footnoteMarkdownExtension, criticMarkdownExtension, highlightMarkdownExtension, inlineScriptMarkdownExtension, htmlCodeLiteralSyntaxExtension, wikiImageMarkdownExtension];
const literalParser = (markdownLanguage.parser as MarkdownParser).configure(literalExtensions);
export const inlineMarkdownExtensions = [...literalExtensions, createMathLiteralSyntaxExtension(literalParser), createPunctuationInlineStyleExtension(literalParser)];
const inlineParser = (markdownLanguage.parser as MarkdownParser).configure(inlineMarkdownExtensions);

/** Tables adapt the same resolved inline tree as prose, retaining source offsets. */
export function parseTableInlineSyntax(text: string, offset: number) {
  const spans = new Map<number, { kind: 'em' | 'strong' | 'strike' | 'highlight'; contentFrom: number; contentTo: number; to: number }>();
  const scripts = new Set<number>();
  const htmlTags = new Map<number, number>();
  const codes = new Map<number, { contentFrom: number; contentTo: number; to: number }>();
  const links = new Map<number, { image: boolean; labelFrom: number; labelTo: number; urlFrom: number; urlTo: number; to: number }>();
  inlineParser.parse(`x ${text}`).iterate({ enter(node) {
    if (node.name === 'InlineCode') {
      const first = node.node.firstChild, last = node.node.lastChild;
      if (first && last) codes.set(offset + node.from - 2, { contentFrom: offset + first.to - 2, contentTo: offset + last.from - 2, to: offset + node.to - 2 });
    }
    if (node.name === 'Subscript' || node.name === 'Superscript') scripts.add(offset + node.from - 2);
    if (/^(?:HTMLTag|Comment|CommentBlock)$/.test(node.name)) htmlTags.set(offset + node.from - 2, offset + node.to - 2);
    if (node.name === 'Link' || node.name === 'Image') {
      const open = node.node.firstChild, url = node.node.getChild('URL');
      let close = open?.nextSibling ?? null;
      while (close && !(close.name === 'LinkMark' && text.slice(close.from - 2, close.to - 2) === ']')) close = close.nextSibling;
      if (open && close && text[close.to - 2] === '(') links.set(offset + node.from - 2, {
        image: node.name === 'Image', labelFrom: offset + open.to - 2, labelTo: offset + close.from - 2,
        urlFrom: offset + (url?.from ?? close.to + 1) - 2, urlTo: offset + (url?.to ?? close.to + 1) - 2, to: offset + node.to - 2
      });
    }
    const kind = ({ Emphasis: 'em', StrongEmphasis: 'strong', Strikethrough: 'strike', Highlight: 'highlight' } as const)[node.name as 'Emphasis'];
    if (!kind) return;
    const first = node.node.firstChild, last = node.node.lastChild;
    if (first && last) spans.set(offset + node.from - 2, { kind, contentFrom: offset + first.to - 2, contentTo: offset + last.from - 2, to: offset + node.to - 2 });
  } });
  return { spans, scripts, htmlTags, codes, links, mathExcludedRanges: text.includes('$') ? collectInlineMathExcludedRanges(literalParser, text).map(range => ({ from: offset + range.from, to: offset + range.to })) : [] };
}
