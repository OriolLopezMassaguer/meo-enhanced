type LatexNode = { type: string; content?: string | LatexNode[]; args?: LatexNode[];
  _renderInfo?: { inMathMode?: boolean }; position?: { start: { offset: number }; end: { offset: number } } };

function protectedContent(ast: LatexNode, source: string): string | null {
  const values: string[] = [];
  let definition = false;
  const visit = (node: LatexNode, math = true) => {
    if (node.type === 'macro' && /^(?:[gex]?def|let|futurelet|(?:re|provide|new)command|DeclareMathOperator)$/.test(String(node.content))) definition = true;
    math = node._renderInfo?.inMathMode ?? math;
    if (node.type === 'comment') values.push(`comment:${node.content}`);
    if (!math && (node.type === 'whitespace' || node.type === 'parbreak') && node.position) {
      values.push(source.slice(node.position.start.offset, node.position.end.offset));
    }
    if (Array.isArray(node.content)) node.content.forEach(child => visit(child, math));
    node.args?.forEach(child => visit(child, math));
  };
  visit(ast);
  return definition ? null : JSON.stringify(values);
}

/** Format math syntax, keeping text-mode whitespace, comments and TeX tokens intact. */
export async function formatLatexSource(source: string, offsets: readonly number[]) {
  const unchanged = (kind: 'preserved' | 'unchanged') => ({ kind, source, offsets: [...offsets] });
  const [prettier, { prettierPluginLatex: plugin }] = await Promise.all([
    import('prettier/standalone'), import('@unified-latex/unified-latex-prettier')
  ]);
  const wrapped = `\\[\n${source}\n\\]`;
  const parser = plugin.parsers!['latex-parser'];
  const signature = (text: string) => protectedContent(parser.parse(text, {} as never) as LatexNode, text);
  const before = signature(wrapped);
  if (before === null) return unchanged('preserved');
  const results = new Map<number, Awaited<ReturnType<typeof prettier.formatWithCursor>>>();
  for (const offset of new Set(offsets.length ? offsets : [0])) results.set(offset,
    await prettier.formatWithCursor(wrapped, { parser: 'latex-parser', plugins: [plugin],
      tabWidth: 2, printWidth: 100, cursorOffset: offset + 3 }));
  const printed = results.values().next().value!.formatted;
  if (!printed.startsWith('\\[\n') || !printed.trimEnd().endsWith('\n\\]')) return unchanged('preserved');
  const body = printed.slice(3, printed.lastIndexOf('\n\\]'));
  const unindent = (text: string) => text.split('\n').map(line => line.startsWith('  ') ? line.slice(2) : line).join('\n');
  const formatted = unindent(body);
  if (before !== signature(printed) || source.replace(/\s/g, '') !== formatted.replace(/\s/g, '')) return unchanged('preserved');
  if (formatted === source) return unchanged('unchanged');
  return { kind: 'formatted' as const, source: formatted, offsets: offsets.map(offset => {
    if (offset === 0) return 0;
    if (offset === source.length) return formatted.length;
    const position = Math.max(0, Math.min(body.length, results.get(offset)!.cursorOffset - 3));
    return unindent(body.slice(0, position)).length;
  }) };
}
