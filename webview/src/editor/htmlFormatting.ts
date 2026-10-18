import { parseDocument } from 'htmlparser2';
import type { ChildNode } from 'domhandler';

export type HtmlFormatResult = {
  kind: 'formatted' | 'unchanged' | 'preserved';
  source: string;
  offsets: number[];
};

function refineCursorOffset(source: string, formatted: string, offset: number, approximate: number): number {
  if (offset === 0) return 0;
  if (offset === source.length) return formatted.length;
  // HTML printers can place a text-boundary cursor just inside the preceding tag.
  // Retained nearby source text identifies the same editing boundary precisely.
  let best = approximate, matched = 0;
  for (let length = 32; length >= 4; length--) for (const before of [false, true]) {
    const fragment = before ? source.slice(Math.max(0, offset - length), offset) : source.slice(offset, offset + length);
    if (fragment.length < length) continue;
    const start = Math.max(0, approximate - 4 - (before ? length : 0));
    let found = formatted.indexOf(fragment, start);
    while (found >= 0) {
      const candidate = found + (before ? length : 0);
      if (candidate > approximate + 4) break;
      if (Math.abs(candidate - approximate) <= 4 && (length > matched || length === matched && Math.abs(candidate - approximate) < Math.abs(best - approximate))) {
        best = candidate; matched = length;
      }
      found = formatted.indexOf(fragment, found + 1);
    }
  }
  return Math.max(0, Math.min(formatted.length, best));
}

function contentSignature(source: string): string {
  const tree = parseDocument(source);
  const hasInlineOverride = (node: ChildNode): boolean => 'attribs' in node && 'children' in node
    && (/(?:^|;)\s*display\s*:\s*inline(?:-block)?\b/i.test(node.attribs.style ?? '') || node.children.some(hasInlineOverride));
  const preserveLayout = tree.children.some(hasInlineOverride);
  const visit = (node: ChildNode, preserve = false): unknown => {
    if (node.type === 'text') {
      const text = preserve ? node.data : node.data.replace(/[\t\n\f\r ]+/g, ' ').replace(/^ +| +$/g, '');
      return text ? ['text', text] : null;
    }
    if (node.type === 'comment') return ['comment', node.data];
    if (!('attribs' in node) || !('children' in node)) return [node.type];
    const sensitive = preserve || /^(?:pre|code|textarea|script|style)$/.test(node.name)
      || /(?:^|;)\s*white-space\s*:\s*(?:pre(?:-wrap|-line)?|break-spaces)\b/i.test(node.attribs.style ?? '');
    return [node.name, Object.entries(node.attribs).sort(([left], [right]) => left.localeCompare(right)),
      node.children.map(child => visit(child, sensitive)).filter(child => child !== null)];
  };
  return JSON.stringify(tree.children.map(node => visit(node, preserveLayout)).filter(node => node !== null));
}

/** Explicit fragment formatting retains text/attribute semantics, including authored whitespace. */
export async function formatHtmlFragment(source: string, offsets: readonly number[], tabSize = 2): Promise<HtmlFormatResult> {
  const [prettier, html] = await Promise.all([import('prettier/standalone'), import('prettier/plugins/html')]);
  const options = { parser: 'html', plugins: [html], htmlWhitespaceSensitivity: 'css' as const,
    embeddedLanguageFormatting: 'off' as const, printWidth: 100, tabWidth: tabSize, endOfLine: 'auto' as const };
  const results = new Map<number, Awaited<ReturnType<typeof prettier.formatWithCursor>>>();
  for (const offset of new Set(offsets.length ? offsets : [0])) {
    results.set(offset, await prettier.formatWithCursor(source, { ...options, cursorOffset: offset }));
  }
  const first = results.values().next().value!;
  const formatted = source.endsWith('\n') ? first.formatted : first.formatted.replace(/\r?\n$/, '');
  if (contentSignature(source) !== contentSignature(formatted)) return { kind: 'preserved', source, offsets: [...offsets] };
  return { kind: formatted === source ? 'unchanged' : 'formatted', source: formatted,
    offsets: offsets.map(offset => refineCursorOffset(source, formatted, offset, results.get(offset)!.cursorOffset)) };
}
