import type { LanguageRegistration } from 'shiki/core';
import math from './grammars/md-math.json';
import inline from './grammars/md-math-inline.json';
import block from './grammars/md-math-block.json';

/** VS Code's math-body scopes, also used for exposed Live formula source. */
export const mathSyntaxGrammar: LanguageRegistration = { ...math, name: 'meo-math' };

/** Keep Markdown's multiline stack while adding math in its original contexts. */
export function withMarkdownMath(grammars: readonly LanguageRegistration[]): LanguageRegistration[] {
  const single = structuredClone(inline.repository.math_inline_single);
  const double = structuredClone(inline.repository.math_inline_double);
  // Escaped dollars remain prose; an unfinished inline formula stops at EOL.
  single.match = String.raw`(?<![\\$])(\$)(?![\s$])((?:\\.|[^$\\\r\n\x60])+?)(?<!\s)(\$)(?![$\w])`;
  double.match = String.raw`(?<![\\$])(\${2})(?![\s$])((?:\\.|[^$\\\r\n\x60])+?)(?<!\s)(\${2})(?!\$)`;
  const inlinePatterns: LanguageRegistration['patterns'] = [
    { include: '#math_inline_double' }, { include: '#math_inline_single' }, {
      name: 'markup.math.inline.markdown', contentName: 'meta.embedded.math.markdown',
      begin: String.raw`(?<![\\$])(\$)(?![\s$\d])`, end: String.raw`(\$)|$`,
      beginCaptures: { 1: { name: 'punctuation.definition.math.begin.markdown' } },
      endCaptures: { 1: { name: 'punctuation.definition.math.end.markdown' } },
      patterns: [{ include: math.scopeName + '#math' }]
    }
  ];
  const display = structuredClone(block.repository.double_dollar_math_block);
  display.begin = String.raw`(?<=^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?)(\${2})[ \t]*$`;
  display.end = String.raw`^([ \t]*(?:>[ \t]*)*)(\${2})[ \t]*$`;
  display.patterns[0].begin = String.raw`(^|\G)([ \t]*(?:>[ \t]*)*)`;
  display.patterns[0].while = String.raw`(^|\G)(?![ \t]*(?:>[ \t]*)*\${2}[ \t]*$)([ \t]*(?:>[ \t]*)*)`;
  const quoteCaptures = { 2: { name: 'punctuation.definition.quote.begin.markdown' } };
  const displayRule = {
    ...display,
    endCaptures: {
      1: { name: 'punctuation.definition.quote.begin.markdown' },
      2: { name: 'punctuation.definition.math.end.markdown' }
    },
    patterns: [{ ...display.patterns[0], beginCaptures: quoteCaptures, whileCaptures: quoteCaptures }]
  };
  const markdown = grammars.map(grammar => {
    if (grammar.name !== 'markdown') return grammar;
    const fence = grammar.repository!.fenced_code_block_latex;
    return { ...grammar,
      // Local injections survive later lazy language loads in Shiki's registry.
      injections: { ...grammar.injections,
        [inline.injectionSelector]: { patterns: inlinePatterns },
        // MEO uses $$ for multiline math, never a single-dollar block.
        [block.injectionSelector]: { patterns: [{ include: '#double_dollar_math_block' }] }
      },
      repository: {
        ...grammar.repository, math_inline_single: single, math_inline_double: double,
        double_dollar_math_block: displayRule,
        fenced_code_block_latex: {
          ...fence,
          begin: typeof fence.begin === 'string' ? fence.begin.replace('(?:la|)tex', '(?:math|latex|tex|katex)') : fence.begin,
          patterns: [{ ...fence.patterns![0], patterns: [{ include: math.scopeName + '#math' }] }, ...fence.patterns!.slice(1)]
        }
      }
    };
  });
  return [mathSyntaxGrammar, ...markdown];
}
