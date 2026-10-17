import assert from 'node:assert/strict';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
const root = path.resolve(import.meta.dir, '..');
const cases = [
  '- 1. 内容', '1. - 内容', '> - 1. [x] 内容', '- 1. - 2. [~] 内容', '- [ ] 1. 内容',
  '- > 1. 内容', '1. > - [x] 内容', '> - > 1. [ ] 内容',
  '- first<br>- second', '- 1. first<br>- 2. second', '- 1. first<br>  2. second', '- 1. first<br>     - nested', '- 1. first<br>     continuation', '- 1. [ ] task<br>     > - quoted child', '3. first<br>4. second',
  'plain<br>3. first', 'plain<br>- first', '> first<br>outside', '> - first<br>> - second',
  '- parent<br>  > - [x] child', '- > first<br>  > - [x] child', '- parent<br>  - child<br>    1. grandchild',
  '- [literal<br>- label](https://example.com)', '- parent<br>\t- child',
  '- [ ] task<br>  > - nested', '- first<br><br>- second', '3. first<br><br>4. second',
  '`literal<br>- not a list`', '- `literal<br>- not a list`', '- \\* escaped<br>- **bold** $x^2$',
  '> [!NOTE]<br>> - task', '- <kbd>Ctrl</kbd> [link](https://example.com)',
];
const codeCases = [
  { cell: 'before `foo` after', text: 'before foo after', codes: ['foo'] },
  { cell: 'before `foo after', text: 'before `foo after', codes: [] },
  { cell: 'before `foo``bar after', text: 'before `foo``bar after', codes: [] },
  { cell: 'before ``foo```bar`` after', text: 'before foo```bar after', codes: ['foo```bar'] },
  { cell: '```a``b`c```', text: 'a``b`c', codes: ['a``b`c'] },
  { cell: '\\`foo\\`', text: '`foo`', codes: [] },
  { cell: '`foo\\`bar`', text: 'foo\\bar`', codes: ['foo\\'] },
  { cell: '`\\d`', text: '\\d', codes: ['\\d'] },
  { cell: '`\\\\d`', text: '\\\\d', codes: ['\\\\d'] },
  { cell: '`\\*\\_\\[\\]\\+\\.`', text: '\\*\\_\\[\\]\\+\\.', codes: ['\\*\\_\\[\\]\\+\\.'] },
  { cell: '`` foo ` bar ``', text: 'foo ` bar', codes: ['foo ` bar'] },
  { cell: '`  foo  `', text: ' foo ', codes: [' foo '] },
  { cell: '`   `', text: '   ', codes: ['   '] },
  { cell: '` `', text: ' ', codes: [' '] },
  { cell: '`  `', text: '  ', codes: ['  '] },
  { cell: '``   ``', text: '   ', codes: ['   '] },
  { cell: '` foo`', text: ' foo', codes: [' foo'] },
  { cell: '`foo `', text: 'foo ', codes: ['foo '] },
  { cell: '`\tfoo\t`', text: '\tfoo\t', codes: ['\tfoo\t'] },
  { cell: '`**bold** <br> $x$`', text: '**bold** <br> $x$', codes: ['**bold** <br> $x$'] },
  { cell: '**``a`b``**', text: 'a`b', codes: ['a`b'] },
  { cell: '[``a`b``](https://example.com)', text: 'a`b', codes: ['a`b'] },
  { cell: '`\\|`', text: '|', codes: ['|'] },
  { cell: '`cat\\|dog`', text: 'cat|dog', codes: ['cat|dog'] },
  { cell: '``left\\|right ` tick``', text: 'left|right ` tick', codes: ['left|right ` tick'] },
  { cell: '`\\\\\\|`', text: '\\\\|', codes: ['\\\\|'] },
  { cell: '`left\\\\|right`', text: '`left\\', codes: [], other: 'right`' },
  { cell: '`foo`', text: 'foo', codes: ['foo'], other: 'end|', rowEnd: 'end\\|' },
  { cell: '`foo`', text: 'foo', codes: ['foo'], header: '`a\\\\|b`', third: 'tail', rowEnd: 'witness | tail |' },
  { cell: '[a|b](https://example.com)', text: '[a', codes: [], other: 'b](https://example.com)' },
  { cell: '`|`', text: '`', codes: [], other: '`' },
  { cell: 'before `a|b` after', text: 'before `a', codes: [], other: 'b` after' },
];
const build = await Bun.build({ entrypoints: [path.join(root, 'scripts/test-list-editing-entry.ts')], target: 'browser', format: 'iife' });
if (!build.success) throw Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
const out: any[] = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 2000 });
  await page.setContent('<div id="live"></div><div id="preview"></div>');
  await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
  await page.addStyleTag({ content: ':root{--meo-semantic-blockquoteBorder:#8c959f;--meo-semantic-blockquoteForeground:#24292f}' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const headingCases = [
    '你好\n---', '你好\n===', 'first\nsecond\n---',
    '**你好**\n---\n*你好*\n---\n==好==\n---\n~~删除~~\n---',
    '你好\n\n---', '你好\n***', '你好\n- - -', '# Heading\n---',
    '> **Quote**\n> ---', '> first\n> *second*\n> ===', '- **List**\n  ---',
    '```text\n你好\n---\n```', '    你好\n    ---',
    '---\ntitle: test\n---\n\nVisible\n---',
    '| A |\n| --- |\n| value |\n---', '| A |\n| --- |\n| value |\n===',
    '| A |\n| --- |\n---', '> | A |\n> | --- |\n> | value |\n> ---',
    'a | b\ninvalid\n---'
  ];
  for (const fixture of headingCases) {
    const source = fixture + '\n\nAfter';
    const html = renderMarkdownToHtml({ markdownText: source, markdownFilePath: 'D:/audit.md', target: 'html' }).html;
    const result = await page.evaluate(async ({ source, html }) => {
      const host = document.querySelector('#live')!;
      const editor = (window as any).ListEditingHarness.createEditor({ parent: host, text: source, initialMode: 'live', onApplyChanges() {} });
      try {
        editor.view.dispatch({ selection: { anchor: source.length } });
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        document.querySelector('#preview')!.innerHTML = html;
        const headings = editor.getHeadings();
        const tables = (root: Element) => Array.from(root.querySelectorAll('table:not(.meo-md-html-table-sticky-table)'), table => Array.from(table.querySelectorAll('th,td'), cell => (cell.querySelector('.meo-md-html-table-cell-preview') ?? cell).textContent!.trim()));
        const live = { headings: headings.map((heading: any) => ({ level: heading.level, text: heading.text })), hr: host.querySelectorAll('.meo-md-hr:not(.meo-md-frontmatter-boundary)').length, tables: tables(host) };
        const preview = { headings: Array.from(document.querySelectorAll('#preview :is(h1,h2,h3,h4,h5,h6)'), node => ({ level: Number(node.tagName.slice(1)), text: node.textContent!.replace(/\s+/g, ' ').trim() })), hr: document.querySelectorAll('#preview hr').length, tables: tables(document.querySelector('#preview')!) };
        const styled = headings.every((heading: any) => {
          const node = editor.view.domAtPos(heading.from).node;
          return (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement).closest('.cm-line')?.classList.contains('meo-md-h' + heading.level);
        });
        editor.setMode('source'); editor.setMode('live');
        return { live, preview, styled, unchanged: editor.getText() === source };
      } finally { editor.destroy(); }
    }, { source, html });
    assert.deepEqual(result.live, result.preview, 'Live/Preview heading semantics: ' + fixture);
    assert.ok(result.styled, 'headings use the existing Live title style: ' + fixture);
    assert.ok(result.unchanged, 'mode switches preserve heading source: ' + fixture);
  }
  const headingEditing = await page.evaluate(async () => {
    const source = '**Title**\n---\n\nAfter';
    const editor = (window as any).ListEditingHarness.createEditor({ parent: document.querySelector('#live'), text: source, initialMode: 'live', onApplyChanges() {} });
    try {
      const revealed = [];
      for (const anchor of [3, source.indexOf('---'), source.length]) {
        editor.view.dispatch({ selection: { anchor } });
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        revealed.push(Array.from(editor.view.dom.querySelectorAll('.meo-md-marker-active')).some((node: any) => node.textContent === '---' && node.getBoundingClientRect().width > 0));
      }
      return { revealed, headings: editor.getHeadings(), history: editor.getHistoryDepth() };
    } finally { editor.destroy(); }
  });
  assert.deepEqual(headingEditing.revealed, [true, true, false], 'editing either heading line reveals its underline');
  assert.ok(headingEditing.headings[0].inlineSegments.some((segment: any) => segment.text === 'Title' && segment.strong), 'Setext outline retains rich inline formatting');
  assert.deepEqual(headingEditing.history, { undo: 0, redo: 0 }, 'syntax reveal does not create undo entries');
  await page.evaluate(() => {
    const editor = (window as any).__headingEditor = (window as any).ListEditingHarness.createEditor({ parent: document.querySelector('#live'), text: 'Title\n\nAfter', initialMode: 'live', onApplyChanges() {} });
    editor.view.dispatch({ selection: { anchor: 5 } }); editor.focus();
  });
  try {
    await page.keyboard.press('Enter'); await page.keyboard.type('---');
    await page.waitForFunction(() => (window as any).__headingEditor.getHeadings()[0]?.level === 2);
    await page.evaluate(() => {
      const editor = (window as any).__headingEditor;
      const { isolateHistory } = (window as any).ListEditingHarness;
      editor.view.dispatch({ selection: { anchor: 6, head: 9 }, annotations: isolateHistory.of('full') });
    });
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => (window as any).__headingEditor.getHeadings().length === 0);
    await page.evaluate(() => (window as any).__headingEditor.undo());
    await page.waitForFunction(() => (window as any).__headingEditor.getHeadings()[0]?.level === 2);
  } finally {
    await page.evaluate(() => { (window as any).__headingEditor.destroy(); delete (window as any).__headingEditor; });
  }
  for (const [mode, anchor] of [['live', 3], ['live', 11], ['source', 3], ['source', 11]] as const) {
    for (const [command, expected] of [
      ['heading1', '# **Title**\n\nAfter'], ['heading2', '**Title**\n\nAfter'],
      ['heading3', '### **Title**\n\nAfter'], ['headingUp', '# **Title**\n\nAfter'],
      ['headingDown', '### **Title**\n\nAfter']
    ] as const) {
      const result = await page.evaluate(async ({ command, mode, anchor }) => {
        const source = '**Title**\n---\n\nAfter';
        const editor = (window as any).ListEditingHarness.createEditor({ parent: document.querySelector('#live'), text: source, initialMode: mode, onApplyChanges() {} });
        try {
          editor.view.dispatch({ selection: { anchor } });
          editor.executeCommand(command); const changed = editor.getText(), caret = editor.view.state.selection.main.head;
          await editor.undo(); return { changed, caret, undone: editor.getText(), source };
        } finally { editor.destroy(); }
      }, { command, mode, anchor });
      assert.equal(result.changed, expected, 'heading toolbar updates the whole Setext heading: ' + command);
      assert.equal(result.caret, expected.indexOf('**Title**') + (anchor === 3 ? 3 : 9), 'heading conversion preserves the content caret');
      assert.equal(result.undone, result.source, 'heading toolbar change undoes as one step');
    }
  }
  for (const [source, anchor, head, expected] of [
    ['first\n*second*\n---\n\nAfter', 2, 12, '### first *second*\n\nAfter'],
    ['> **Title**\n> ---\n\nAfter', 4, 4, '> ### **Title**\n\nAfter'],
    ['- Title\n  ---\n\nAfter', 11, 11, '- ### Title\n\nAfter']
  ] as const) {
    const result = await page.evaluate(({ source, anchor, head }) => {
      const editor = (window as any).ListEditingHarness.createEditor({ parent: document.querySelector('#live'), text: source, initialMode: 'live', onApplyChanges() {} });
      try {
        editor.view.dispatch({ selection: { anchor, head } }); editor.executeCommand('headingDown'); return editor.getText();
      } finally { editor.destroy(); }
    }, { source, anchor, head });
    assert.equal(result, expected, 'heading conversion preserves containers and joins multiline content once');
  }
  for (const mode of ['source', 'live']) {
    for (const [source, anchor, expected] of [
      ['word', 4, 'word\n\n---\n\n'],
      ['before\n\nafter', 7, 'before\n\n---\n\nafter'],
      ['before\nafter', 2, 'before\n\n---\n\nafter'],
      ['before\n\n\nafter', 8, 'before\n\n---\n\nafter'],
      ['', 0, '\n---\n\n']
    ] as const) {
      const result = await page.evaluate(async ({ mode, source, anchor }) => {
        const editor = (window as any).ListEditingHarness.createEditor({ parent: document.querySelector('#live'), text: source, initialMode: mode, onApplyChanges() {} });
        try {
          editor.view.dispatch({ selection: { anchor } }); editor.executeCommand('rule');
          const inserted = editor.getText();
          const caret = editor.view.state.selection.main.head;
          await editor.undo(); const undone = editor.getText();
          await editor.redo();
          return { inserted, undone, redone: editor.getText(), caret };
        } finally { editor.destroy(); }
      }, { mode, source, anchor });
      assert.equal(result.inserted, expected, mode + ': divider button separates surrounding paragraphs');
      assert.equal(result.caret, expected.indexOf('---') + 3, 'divider caret stays after its marker');
      assert.equal(result.undone, source); assert.equal(result.redone, expected);
      const html = renderMarkdownToHtml({ markdownText: result.inserted, markdownFilePath: 'D:/audit.md', target: 'html' }).html;
      assert.equal((html.match(/<hr\b/g) ?? []).length, 1, 'inserted divider remains a divider in Preview');
      assert.ok(!/<h[12]\b/.test(html), 'divider insertion never creates a Setext heading');
    }
  }
  console.log('PASS Setext heading parity, syntax reveal and divider insertion');
  for (const cell of cases) {
    const source = '| Content |\n| --- |\n| ' + cell + ' |';
    const html = renderMarkdownToHtml({ markdownText: source, markdownFilePath: 'D:/audit.md', target: 'html', uiLanguage: 'zh-CN' }).html;
    const observation = await page.evaluate(async ({ source, html }) => {
      const host = document.getElementById('live')!; host.replaceChildren();
      const editor = (window as any).ListEditingHarness.createEditor({ parent: host, text: source, initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() { } });
      for (let i = 0; i < 4; i++) await new Promise<void>(r => requestAnimationFrame(() => r()));
      document.getElementById('preview')!.innerHTML = html;
      const signature = (root: Element | null) => root ? {
        lists: [...root.querySelectorAll('ul,ol')].map(e => { const ancestors: string[] = []; let p: Element | null = e; while (p && p !== root) { if (['UL', 'OL', 'BLOCKQUOTE'].includes(p.tagName)) ancestors.unshift(p.tagName.toLowerCase()); p = p.parentElement; } return { path: ancestors.join('/'), start: e.getAttribute('start') ?? '1', items: e.children.length }; }),
        quotes: root.querySelectorAll('blockquote').length,
        tasks: [...root.querySelectorAll('li')].filter(e => e.classList.contains('meo-md-html-table-cell-task') || e.classList.contains('meo-export-task-item')).map(e => [...e.classList].find(x => x.startsWith('is-'))),
        codes: [...root.querySelectorAll('code')].map(e => e.textContent),
        text: root.textContent?.replace(/\s+/g, '').trim(),
        outside: (() => { let text = ''; const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); while (walker.nextNode()) { const node = walker.currentNode; if (!node.parentElement?.closest('blockquote,li')) text += node.textContent; } return text.replace(/\s+/g, ''); })(),
      } : null;
      const live = signature(host.querySelector('tbody td .meo-md-html-table-cell-preview'));
      const preview = signature(document.querySelector('#preview tbody td'));
      const unchanged = editor.getText() === source; editor.destroy(); return { live, preview, unchanged };
    }, { source, html });
    out.push({ cell, ...observation });
  }

  for (const fixture of codeCases) {
    const source = 'intro\n\n| ' + (fixture.header ?? 'Content') + ' | Other |\n| --- | --- |\n| ' + fixture.cell + ' | ' + (fixture.rowEnd ?? 'witness |');
    const html = renderMarkdownToHtml({ markdownText: source, markdownFilePath: 'D:/audit.md', target: 'html' }).html;
    const result = await page.evaluate(async ({ source, html }) => {
      const host = document.getElementById('live')!; host.replaceChildren();
      const editor = (window as any).ListEditingHarness.createEditor({ parent: host, text: source, initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() { } });
      for (let i = 0; i < 4; i++) await new Promise<void>(r => requestAnimationFrame(() => r()));
      document.getElementById('preview')!.innerHTML = html;
      const signature = (cells: Element[]) => cells.map(cell => ({ text: cell.textContent, codes: [...cell.querySelectorAll('code')].map(code => code.textContent) }));
      const result = {
        live: signature([...host.querySelectorAll('tbody .meo-md-html-table-cell-preview')]),
        preview: signature([...document.querySelectorAll('#preview tbody td')]),
        liveHeader: signature([...host.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead .meo-md-html-table-cell-preview')]),
        previewHeader: signature([...document.querySelectorAll('#preview thead th')]),
        unchanged: editor.getText() === source
      };
      editor.destroy(); return result;
    }, { source, html });
    const expected = [{ text: fixture.text, codes: fixture.codes }, { text: fixture.other ?? 'witness', codes: [] }];
    if (fixture.third) expected.push({ text: fixture.third, codes: [] });
    assert.deepEqual(result.preview, expected, 'Preview code/cell boundaries: ' + fixture.cell);
    assert.deepEqual(result.live, expected, 'Live code/cell boundaries: ' + fixture.cell);
    assert.ok(result.unchanged, 'code rendering must leave source unchanged: ' + fixture.cell);
    assert.deepEqual(result.liveHeader, result.previewHeader, 'header code/cell boundaries: ' + (fixture.header ?? 'Content'));
  }
  console.log('PASS', codeCases.length, 'table code spans: delimiter runs, literals, whitespace and escaped pipes');

  for (const cell of ['`` padded TARGET ``', '`left\\|TARGET`', '`\\\\TARGET`']) {
    const source = 'intro\n\n| Content | Other |\n| --- | --- |\n| ' + cell + ' | witness |';
    const point = await page.evaluate(async (source) => {
      const host = document.getElementById('live')!; host.replaceChildren();
      (window as any).__codeEditor = (window as any).ListEditingHarness.createEditor({ parent: host, text: source, initialMode: 'live', onApplyChanges() { } });
      for (let i = 0; i < 4; i++) await new Promise<void>(r => requestAnimationFrame(() => r()));
      const span = [...host.querySelectorAll('tbody code [data-meo-source-from]')].find(element => element.textContent?.includes('TARGET'))!;
      const offset = span.textContent!.indexOf('TARGET');
      const range = document.createRange();
      range.setStart(span.firstChild!, offset); range.setEnd(span.firstChild!, offset + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 0.1, y: rect.top + rect.height / 2 };
    }, source);
    await page.mouse.click(point.x, point.y);
    const input = await page.evaluate(async () => {
      for (let i = 0; i < 4; i++) await new Promise<void>(r => requestAnimationFrame(() => r()));
      const input = document.querySelector<HTMLTextAreaElement>('#live tbody textarea')!;
      return { focused: document.activeElement === input, value: input.value, offset: input.selectionStart };
    });
    assert.ok(input.focused, 'code click must enter its source cell: ' + cell);
    assert.equal(input.value, cell, 'code click must retain raw delimiters and escapes: ' + cell);
    assert.equal(input.offset, cell.indexOf('TARGET'), 'code click source offset: ' + cell);
    await page.keyboard.type('X');
    await page.keyboard.press('Tab');
    await page.waitForFunction((expected) => (window as any).__codeEditor.getText() === expected, {}, source.replace('TARGET', 'XTARGET'));
    await page.evaluate(() => { (window as any).__codeEditor.destroy(); delete (window as any).__codeEditor; });
  }
  console.log('PASS 3 normalized code click/edit source positions');
  for (const target of ['html', 'pdf', 'docx'] as const) {
    const html = renderMarkdownToHtml({ markdownText: 'before ` \n ` after', markdownFilePath: 'D:/audit.md', target }).html;
    assert.ok(html.includes('<code>   </code>'), target + ': line breaks in all-space code must become spaces without trimming');
    const prose = renderMarkdownToHtml({ markdownText: 'Header\n---\nliteral \\\\|', markdownFilePath: 'D:/audit.md', target }).html;
    assert.ok(prose.includes('literal \\|'), target + ': table pipe normalization must not alter ordinary prose after a setext heading');
    const followingHtml = renderMarkdownToHtml({ markdownText: '| A |\n| --- |\n| value |\n<div>literal \\\\|</div>', markdownFilePath: 'D:/audit.md', target }).html;
    assert.ok(followingHtml.includes('literal \\\\|'), target + ': table pipe normalization must not alter a following HTML block');
  }

  const fence = '\x60'.repeat(3);
  const containers = [
    { name: 'root', lead: '', prefix: '' },
    { name: 'quote', lead: '', prefix: '> ' },
    { name: 'double quote', lead: '', prefix: '> > ' },
    { name: 'list', lead: '- parent\n\n', prefix: '  ' },
    { name: 'ordered task', lead: '1. [ ] parent\n\n', prefix: '   ' },
    { name: 'compound list', lead: '- 1. [ ] parent\n\n', prefix: '     ' },
    { name: 'interleaved quote/list', lead: '> - > 1. [ ] parent\n>   >\n', prefix: '>   >    ' },
    { name: 'quote/list', lead: '> - parent\n>\n', prefix: '>   ' },
    { name: 'task/quote', lead: '- [x] parent\n\n', prefix: '  > ' },
    { name: 'footnote/list/quote', lead: '[^deep]: parent\n\n    - parent\n\n', prefix: '      > ' },
  ];
  let blocks = 0;
  for (const container of containers) {
    const payload = 'const literal = "<br>- text [^note]";';
    const inner = [fence + 'js', payload, '  const child = 2;', '| field | other |', '| --- |', fence, '',
      '| Key | Value |', '| --- | --- |', '| nested | $x^2$ [^note] |', '',
    fence + 'mermaid', 'flowchart LR', '  A["<br>- text [^note]"] --> B', fence, '',
      '$$', 'x^2 = 1', '$$', ''];
    const source = '# ' + container.name + '\n\nReference[^note]' + (container.name.startsWith('footnote') ? '[^deep]' : '')
      + '.\n\n' + container.lead + inner.map(line => container.prefix + line).join('\n') + '\n\n[^note]: Note body';
    const rendered = renderMarkdownToHtml({ markdownText: source, markdownFilePath: 'D:/audit.md', target: 'html', uiLanguage: 'zh-CN' });
    const result = await page.evaluate(async ({ source, html }) => {
      const host = document.getElementById('live')!; host.replaceChildren();
      const editor = (window as any).ListEditingHarness.createEditor({ parent: host, text: source, initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() { } });
      for (let i = 0; i < 8; i++) await new Promise<void>(r => requestAnimationFrame(() => r()));
      document.getElementById('preview')!.innerHTML = html;
      const preview = document.getElementById('preview')!;
      const block = preview.querySelector('.meo-export-code-block-wrap');
      const diagram = preview.querySelector('.meo-export-mermaid');
      const graphSource = diagram?.getAttribute('data-source-b64');
      const graphShell = host.querySelector<HTMLElement>('.meo-rendered-block-preview[data-meo-rendered-block-kind="mermaid"]')!;
      const mathShell = host.querySelector<HTMLElement>('.meo-md-math-fenced-display:not(.meo-math-live-result)')!;
      const graphBottom = graphShell.getBoundingClientRect().bottom;
      const mathTop = mathShell.getBoundingClientRect().top;
      const gapLines = [...graphShell.parentElement!.children].filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.height > 0 && rect.top >= graphBottom - 0.1 && rect.bottom <= mathTop + 0.1;
      }).map(element => ({
        height: element.getBoundingClientRect().height,
        quoted: element.classList.contains('meo-md-quote'),
        rail: getComputedStyle(element, '::before').backgroundImage
      }));
      const result = {
        liveTables: host.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table)').length,
        previewTables: preview.querySelectorAll('table').length,
        liveMath: host.querySelectorAll('.meo-md-math-fenced-display').length,
        previewMath: preview.querySelectorAll('.meo-export-math-fenced-display').length,
        liveGraphs: host.querySelectorAll('.meo-mermaid-block').length,
        previewGraphs: preview.querySelectorAll('.meo-export-mermaid').length,
        code: [...(block?.querySelectorAll('.meo-export-code-line-source') ?? [])].map(e => e.textContent).join('\n'),
        codeBlocks: preview.querySelectorAll('.meo-export-code-block-wrap').length,
        codeRefCount: block?.querySelectorAll('a[id^=fnref-]').length,
        diagramSource: graphSource ? decodeURIComponent(escape(atob(graphSource))) : null,
        refs: preview.querySelectorAll('a[id^=fnref-]').length,
        liveRefs: host.querySelectorAll('.meo-md-footnote-ref').length,
        renderedGap: mathTop - graphBottom, gapLines,
        sourceUnchanged: editor.getText() === source,
      }; editor.destroy(); return result;
    }, { source, html: rendered.html });
    assert.ok(result.sourceUnchanged, container.name + ': rendering changes source');
    assert.equal(result.gapLines.length, 1, container.name + ': only the source blank line may separate rendered blocks');
    assert.ok(Math.abs(result.renderedGap - result.gapLines[0]!.height) < 1, container.name + ': extra widget spacing');
    if (container.prefix.includes('>')) {
      assert.ok(result.gapLines[0]!.quoted && result.gapLines[0]!.rail !== 'none', container.name + ': source blank loses its quote rail');
    }
    assert.equal(result.liveTables, 1, container.name + ': Live nested table missing');
    assert.equal(result.previewTables, 1, container.name + ': Preview nested table missing');
    assert.equal(result.liveGraphs, 1, container.name + ': Live nested diagram missing');
    assert.equal(result.previewGraphs, 1, container.name + ': Preview nested diagram missing');
    assert.equal(result.liveMath, 1, container.name + ': Live nested formula missing');
    assert.equal(result.previewMath, 1, container.name + ': Preview nested formula missing');
    assert.equal(result.codeBlocks, 1, container.name + ': code split into blocks');
    assert.equal(result.code, [payload, '  const child = 2;', '| field | other |', '| --- |'].join('\n'), container.name + ': code payload altered');
    assert.ok(result.diagramSource?.includes('<br>- text [^note]'), container.name + ': diagram payload altered');
    assert.equal(result.codeRefCount, 0, container.name + ': literal footnote in code converted');
    assert.equal(result.refs, container.name.startsWith('footnote') ? 3 : 2, container.name + ': Preview note references incorrect');
    assert.equal(result.liveRefs, result.refs, container.name + ': Live note references incorrect');
    blocks++;
  }
  for (const container of containers.filter(item => item.name !== 'footnote/list/quote')) {
    const source = '# Loose table\n\n' + container.lead + ['| A | B |', '| --- |', '| one | two |'].map(line => container.prefix + line).join('\n');
    const html = renderMarkdownToHtml({ markdownText: source, markdownFilePath: 'D:/audit.md', target: 'html' }).html;
    const result = await page.evaluate(async ({ source, html }) => {
      const host = document.getElementById('live')!; host.replaceChildren();
      const editor = (window as any).ListEditingHarness.createEditor({ parent: host, text: source, initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() { } });
      for (let i = 0; i < 5; i++)await new Promise<void>(r => requestAnimationFrame(() => r()));
      document.getElementById('preview')!.innerHTML = html;
      const result = { live: host.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table)').length, preview: document.querySelectorAll('#preview table').length };
      editor.destroy(); return result;
    }, { source, html });
    assert.equal(result.live, 1, container.name + ': Live loose table missing');
    assert.equal(result.preview, 1, container.name + ': Preview loose table missing');
  }
  const graphLines = [fence + 'mermaid', 'flowchart LR', 'A --> B', fence];
  const mathLines = ['$$', 'x = 1', '$$'];
  let spacingCases = 0;
  for (const quoted of [false, true]) {
    const prefix = quoted ? '> ' : '';
    for (const [first, second] of [[graphLines, mathLines], [graphLines, graphLines], [mathLines, graphLines]]) {
      for (const blankCount of [0, 1, 2]) {
        const source = ['# Spacing', '', ...[...first!, ...Array<string>(blankCount).fill(''), ...second!].map(line => prefix + line)].join('\n');
        const result = await page.evaluate(async source => {
          const host = document.getElementById('live')!; host.replaceChildren();
          const editor = (window as any).ListEditingHarness.createEditor({ parent: host, text: source, initialMode: 'live', onApplyChanges() { } });
          for (let i = 0; i < 5; i++) await new Promise<void>(r => requestAnimationFrame(() => r()));
          const widgets = [...host.querySelectorAll<HTMLElement>('.meo-rendered-block-preview, .meo-md-math-fenced-display:not(.meo-math-live-result)')];
          const first = widgets[0]!.getBoundingClientRect(), last = widgets[1]!.getBoundingClientRect();
          const siblings = [...widgets[0]!.parentElement!.children];
          const gapLines = siblings.filter(element => {
            const rect = element.getBoundingClientRect();
            return rect.height > 0 && rect.top >= first.bottom - 0.1 && rect.bottom <= last.top + 0.1;
          }).map(element => ({ height: element.getBoundingClientRect().height, rail: getComputedStyle(element, '::before').backgroundImage }));
          const trailingLines = siblings.filter(element => element.getBoundingClientRect().height > 0 && element.getBoundingClientRect().top >= last.bottom - 0.1);
          const result = { widgets: widgets.length, gap: last.top - first.bottom, gapLines, trailingLines: trailingLines.length, unchanged: editor.getText() === source };
          editor.destroy(); return result;
        }, source);
        const label = (quoted ? 'quote ' : 'root ') + first![0] + ' → ' + second![0] + ' / ' + blankCount + ' blank lines';
        assert.equal(result.widgets, 2, label + ': blocks missing');
        assert.equal(result.gapLines.length, blankCount, label + ': phantom line between widgets');
        assert.ok(Math.abs(result.gap - result.gapLines.reduce((sum, line) => sum + line.height, 0)) < 1, label + ': unexpected block spacing');
        assert.equal(result.trailingLines, 0, label + ': phantom line after the final block at EOF');
        if (quoted) assert.ok(result.gapLines.every(line => line.rail !== 'none'), label + ': blank line loses its quote rail');
        assert.ok(result.unchanged, label + ': rendering changes source');
        spacingCases++;
      }
    }
  }
  console.log('PASS', spacingCases, 'rendered block boundaries: real blank lines, continuous quote rails and EOF');
  const ordinary = renderMarkdownToHtml({ markdownText: 'paragraph\n3. literal', markdownFilePath: 'D:/audit.md', target: 'html' }).html;
  assert.ok(!ordinary.includes('<ol'), 'cell-specific ordered interruption must not change ordinary prose');
  const cyclic = renderMarkdownToHtml({ markdownText: 'See[^a].\n\n[^a]: First[^b].\n\n[^b]: Second[^a].', markdownFilePath: 'D:/audit.md', target: 'html' }).html;
  assert.equal((cyclic.match(/class="footnote-item"/g) ?? []).length, 2, 'nested footnote definitions must render once');
  assert.ok(cyclic.includes('id="fnref-1-2"'), 'cyclic references must resolve and terminate');
  const indented = '- parent\n\n      const literal = "<br>- text [^note]";\n\n[^note]: Definition';
  const codeHtml = renderMarkdownToHtml({ markdownText: indented, markdownFilePath: 'D:/audit.md', target: 'html' }).html;
  assert.ok(codeHtml.includes('&lt;br&gt;- text [^note]'), 'indented code must keep breaks and note labels literal');
  assert.ok(!codeHtml.includes('footnote-ref'), 'unused note referenced in code must stay unused');
  const paragraph = '- parent\n\n  - child[^note]\n\n    paragraph[^note]\n\n[^note]: Definition';
  const paragraphHtml = renderMarkdownToHtml({ markdownText: paragraph, markdownFilePath: 'D:/audit.md', target: 'html' }).html;
  assert.equal((paragraphHtml.match(/id="fnref-[^"]+"/g) ?? []).length, 2, 'list continuation references must render');
  assert.ok(paragraphHtml.includes('fnref-1-2'), 'repeated note must keep independent reference IDs');
  console.log('PASS', blocks, 'Live/Preview code/table/diagram/math/footnote container combinations');
} finally { await closeTestBrowser(browser); }
for (const o of out) {
  assert.equal(o.unchanged, true, 'rendering must leave source unchanged: ' + o.cell);
  assert.deepEqual(o.preview, o.live, 'Live/Preview cell semantics differ: ' + o.cell);
}
console.log('PASS', out.length, 'Live/Preview cell combinations');
