import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-html-content-'));
const artifacts = path.join(repoRoot, '.local', 'html-fragment-acceptance');
fs.mkdirSync(artifacts, { recursive: true });
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n5QAAAAASUVORK5CYII=';
const source = [
  'HTML fragment acceptance', '', 'Prelude paragraph.', '',
  'Inline <span style="color:red">**bold** <span>nested</span></span>, <u>underlined</u>, <kbd>Ctrl</kbd>, and <ruby>字<rt>zi</rt></ruby>.', '',
  '<p id="center" align="center" style="color:red;position:fixed;background-image:url(https://example.com/x)" onclick="alert(1)">',
  '  <a href="#target">English</a> · <strong>简体中文</strong>',
  '  <a href="https://example.com/docs">Docs</a>',
  '</p>', '',
  '<div id="html-test-top"></div>',
  '<div id="target"><p>Adjacent visible fragment</p></div>', '',
  '<div hidden>Hidden content</div>', '',
  '<div style="display:none">Styled hidden content</div>', '',
  '<div style="color:transparent">Transparent content</div>', '',
  '<div style="color:#1230">Transparent short hex</div>', '',
  '<div style="color:#12345600">Transparent hex</div>', '',
  '<div style="color:transparent;background-color:currentColor"><span style="color:inherit">Inherited transparent content</span></div>', '',
  '<div style="font-size:0">Zero-size content</div>', '',
  '<div style="height:12px"></div>', '',
  '<div id="color-box" style="height:12px;background-color:red"></div>', '',
  '<h2>HTML heading</h2>', '',
  '<section><p>Semantic section</p></section>', '',
  '<details open>',
  '<summary><strong>Rich summary</strong> <kbd>Enter</kbd></summary>',
  '<p>First details paragraph.</p>',
  '<p>Second details paragraph.</p>',
  '</details>', '',
  '<blockquote><p><strong>HTML quote:</strong> quoted text.</p></blockquote>', '',
  '<table><caption>HTML table caption</caption><thead><tr><th>Type</th><th>Result</th></tr></thead>',
  '<tbody><tr><td rowspan="2">HTML</td><td>Rendered</td></tr><tr><td>Second row</td></tr></tbody></table>', '',
  `<figure><img src="${image}" alt="Nested image" width="40" style="width:60px"><figcaption>Image caption</figcaption></figure>`, '',
  `<div id="hidden-children">Visible sibling <a hidden href="https://example.com/hidden">Hidden link</a><img hidden src="${image}"><a hidden href="https://example.com/image"><img src="${image}"></a></div>`, '',
  `<img id="standalone-image" src="${image}" width="24" height="24">`, '',
  `Inline image <img id="inline-image" src="${image}" width="16" height="16"> in prose.`, '',
  '<pre><code>**literal** &lt;tag&gt;</code></pre>', '',
  '<div><p>First raw paragraph.</p>', '', '<p>Second raw paragraph.</p></div>', '',
  '<script>window.__htmlExecuted=1;const raw="<div>";</script>', '',
  '<p id="after-script">After unsupported script</p>', '',
  '<custom-html>Unsupported source remains visible</custom-html>', '',
  '<!-- visible comment -->', '', 'Tail paragraph.'
].join('\n');

async function frames(page: Page, count = 6): Promise<void> {
  await page.evaluate(async n => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); }, count);
}

async function select(page: Page, needle: string, offset = 0): Promise<void> {
  await page.evaluate(({ needle, offset }) => {
    const view = (window as any).__htmlEditor.view;
    const position = view.state.doc.toString().indexOf(needle);
    if (position < 0) throw new Error(`Missing source: ${needle}`);
    view.dispatch({ selection: { anchor: position + offset }, scrollIntoView: true });
    view.focus();
  }, { needle, offset });
  await frames(page);
}

function checkExport(): void {
  for (const target of ['html', 'pdf', 'docx'] as const) {
    const html = renderMarkdownToHtml({ markdownText: source, markdownFilePath: path.join(tempDir, 'source.md'), target }).html;
    assert.match(html, /<p[^>]*id="center"[^>]*style="color:red"/);
    assert.match(html, /<h2>HTML heading<\/h2>/);
    assert.match(html, /<section><p>Semantic section<\/p><\/section>/);
    assert.match(html, /<ruby>字<rt>zi<\/rt><\/ruby>/);
    assert.match(html, /<caption>HTML table caption<\/caption>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<code>\*\*literal\*\* &lt;tag&gt;<\/code>/);
    assert.match(html, /<div id="html-test-top"><\/div>/);
    assert.match(html, /<div hidden="hidden">Hidden content<\/div>/);
    assert.match(html, /&lt;custom-html&gt;/);
    assert.doesNotMatch(html, /onclick=|position:fixed|background-image|meo-md-html-invisible-source/);
    assert.doesNotMatch(html, /visible comment/);
  }
  const unsafe = renderMarkdownToHtml({ markdownText: '<p style="constructor:bad;__proto__:bad;color:expression(alert(1));width:10px;background:url(javascript:alert(1))"><a href="javascript:alert(1)">safe text</a></p>', markdownFilePath: path.join(tempDir, 'unsafe.md'), target: 'html' }).html;
  assert.doesNotMatch(unsafe, /javascript:|expression\(|background:/);
  assert.match(unsafe, /width:10px/);
  const mixed = renderMarkdownToHtml({ markdownText: '<div>\n\n**Markdown body**\n\n</div>', markdownFilePath: path.join(tempDir, 'mixed.md'), target: 'html' }).html;
  assert.match(mixed, /<div[^>]*>\s*<p[^>]*><strong>Markdown body<\/strong><\/p>\s*<\/div>/);
}

async function main(): Promise<void> {
  checkExport();
  const build = await Bun.build({ entrypoints: [path.join(repoRoot, 'scripts/test-html-content-entry.ts')], outdir: tempDir,
    target: 'browser', format: 'iife', naming: 'bundle.js' });
  assert.ok(build.success, build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 1000, height: 1200, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-light"><div id="app"></div></body>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview/src/styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(text => {
      (window as any).__htmlLinks = [];
      (window as any).__htmlEditor = (window as any).HtmlContentHarness.createEditor({ parent: document.getElementById('app'),
        text, initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {},
        onOpenLink(href: string) { (window as any).__htmlLinks.push(href); } });
    }, source);
    await frames(page, 12);
    assert.deepEqual(errors, [], 'Editor initialization');
    const initial = await page.evaluate(() => {
      const root = document.querySelector('.cm-editor')!;
      const empty = root.querySelector<HTMLElement>('.meo-md-html-invisible-source-text');
      const center = root.querySelector<HTMLElement>('#center');
      const image = root.querySelector<HTMLImageElement>('.meo-md-html-content img');
      return { raw: (window as any).__htmlEditor.view.state.doc.toString(),
        buttons: root.querySelectorAll('.meo-md-html-source-toggle, .meo-md-html-preview-toggle').length,
        center: center?.textContent, red: center?.style.color, position: center?.style.position,
        onclick: center?.getAttribute('onclick'), empty: empty?.textContent, emptyHeight: empty?.getBoundingClientRect().height,
        emptyBackground: empty ? getComputedStyle(empty).backgroundColor : null,
        heading: root.querySelector('.meo-md-html-content h2')?.textContent,
        section: root.querySelector('.meo-md-html-content section')?.textContent,
        caption: root.querySelector('.meo-md-html-content caption')?.textContent,
        quote: root.querySelector('.meo-md-html-content blockquote')?.textContent,
        inlineBold: root.querySelector('.meo-md-html-inline strong')?.textContent,
        ruby: root.querySelector('.meo-md-html-inline ruby')?.textContent,
        code: root.querySelector('.meo-md-html-content pre code')?.textContent,
        adjacent: root.querySelector('#target')?.textContent,
        afterScript: root.querySelector('#after-script')?.textContent,
        executed: (window as any).__htmlExecuted ?? 0,
        blankLines: Array.from(root.querySelectorAll('.meo-md-html-content')).some(node => node.textContent?.includes('First raw paragraph.') && node.textContent.includes('Second raw paragraph.')),
        imageWidth: image?.getBoundingClientRect().width,
        standaloneImageWidth: root.querySelector('#standalone-image')?.getBoundingClientRect().width,
        inlineImageWidth: root.querySelector('#inline-image')?.getBoundingClientRect().width,
        hiddenImageHeights: Array.from(root.querySelectorAll('.meo-md-html-content #hidden-children .meo-md-html-image'))
          .map(node => node.getBoundingClientRect().height),
        hiddenLinkButtons: root.querySelectorAll('#hidden-children .meo-md-html-link-button').length,
        hiddenRows: root.querySelectorAll('.meo-md-html-invisible-source').length,
        unsupported: root.textContent?.includes('<custom-html>'),
        warning: Boolean(root.querySelector('.meo-md-html-warning')),
        comment: root.textContent?.includes('<!-- visible comment -->') };
    });
    assert.equal(initial.raw, source);
    assert.equal(initial.buttons, 0);
    assert.ok(initial.center?.includes('English'));
    assert.equal(initial.red, 'red');
    assert.equal(initial.position, '');
    assert.equal(initial.onclick, null);
    assert.equal(initial.empty, '<div id="html-test-top"></div>');
    assert.ok(initial.emptyHeight! > 5);
    assert.equal(initial.emptyBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(initial.heading, 'HTML heading');
    assert.equal(initial.section, 'Semantic section');
    assert.equal(initial.caption, 'HTML table caption');
    assert.ok(initial.quote?.includes('quoted text'));
    assert.equal(initial.inlineBold, 'bold');
    assert.equal(initial.ruby, '字zi');
    assert.equal(initial.code, '**literal** <tag>');
    assert.equal(initial.adjacent, 'Adjacent visible fragment');
    assert.equal(initial.afterScript, 'After unsupported script');
    assert.equal(initial.executed, 0);
    assert.equal(initial.blankLines, true);
    assert.ok(Math.abs(initial.imageWidth! - 60) < 1, `HTML image width: ${initial.imageWidth}`);
    assert.ok(Math.abs(initial.standaloneImageWidth! - 24) < 1, 'Standalone HTML image renders at its authored size');
    assert.ok(Math.abs(initial.inlineImageWidth! - 16) < 1, 'Inline HTML image renders in prose');
    assert.deepEqual(initial.hiddenImageHeights, [0, 0], 'Image enhancements retain hidden attributes on images and their links');
    assert.equal(initial.hiddenLinkButtons, 0, 'Hidden links do not gain visible helper controls');
    assert.equal(initial.hiddenRows, 9);
    assert.equal(initial.unsupported, true);
    assert.equal(initial.warning, true);
    assert.equal(initial.comment, true);
    await page.screenshot({ path: path.join(artifacts, 'light-reading.png') });

    const beforeTop = await page.$eval('#center', node => node.getBoundingClientRect().top);
    await page.click('#center', { offset: { x: 10, y: 10 } });
    await frames(page);
    const editing = await page.evaluate(() => {
      const source = document.querySelector<HTMLElement>('.meo-md-html-source-range-start');
      const last = document.querySelector<HTMLElement>('.meo-md-html-source-range-end');
      const result = document.querySelector<HTMLElement>('.meo-md-html-live-result');
      return { source: source?.textContent, count: document.querySelectorAll('.meo-md-html-source-range').length,
        top: source?.getBoundingClientRect().top, sourceBottom: last?.getBoundingClientRect().bottom,
        sourceBackground: source && getComputedStyle(source).backgroundColor,
        resultBackground: result && getComputedStyle(result).backgroundColor,
        resultLabel: result?.querySelector('.meo-md-html-result-status')?.textContent,
        joinedEnd: last?.classList.contains('meo-md-html-source-has-preview'),
        sourceLeft: source?.getBoundingClientRect().left, sourceWidth: source?.getBoundingClientRect().width,
        resultLeft: result?.getBoundingClientRect().left, resultWidth: result?.getBoundingClientRect().width,
        resultBottom: result?.getBoundingClientRect().bottom,
        previewTop: result?.getBoundingClientRect().top, preview: result?.textContent };
    });
    assert.ok(editing.source?.includes('<p id="center"'));
    assert.equal(editing.count, 4);
    assert.ok(editing.preview?.includes('English'));
    assert.ok(editing.previewTop! >= editing.sourceBottom! - 1);
    assert.ok(editing.previewTop! <= editing.sourceBottom! + 1, 'Source and result form a continuous editing surface');
    assert.equal(editing.resultBackground, editing.sourceBackground, 'Source and result share the block surface');
    assert.equal(editing.resultLabel, '预览');
    assert.equal(editing.joinedEnd, true, 'The source bottom joins the result instead of closing a separate box');
    assert.ok(Math.abs(editing.sourceLeft! - editing.resultLeft!) < 1 && Math.abs(editing.sourceWidth! - editing.resultWidth!) < 1,
      'Source and result share the same outer edges');
    assert.ok(Math.abs(editing.top! - beforeTop) < 3, 'Opening source keeps its reading anchor');
    await page.screenshot({ path: path.join(artifacts, 'light-editing.png') });
    await page.screenshot({ path: path.join(artifacts, 'html-editing-surface.png'), clip: {
      x: editing.sourceLeft! - 2, y: editing.top! - 2,
      width: editing.sourceWidth! + 4, height: editing.resultBottom! - editing.top! + 4
    } });
    await select(page, 'English', 'English'.length);
    await page.keyboard.type('X');
    await frames(page);
    assert.ok(await page.$eval('.meo-md-html-live-result', node => node.textContent?.includes('EnglishX')));
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await frames(page);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString()), source);
    await page.keyboard.press('Escape');
    await frames(page);
    assert.equal(await page.$('.meo-md-html-source-range-start'), null);
    assert.ok(Math.abs(await page.$eval('#center', node => node.getBoundingClientRect().top) - beforeTop) < 3);

    // Dragging selects rendered words without entering HTML source.
    const word = await page.$eval('#center .meo-md-html-link', node => {
      const range = document.createRange(); range.selectNodeContents(node);
      const box = range.getBoundingClientRect(); return { x: box.left, y: box.top + box.height / 2, width: box.width };
    });
    await page.mouse.move(word.x + 1, word.y); await page.mouse.down();
    await page.mouse.move(word.x + word.width - 1, word.y, { steps: 8 }); await page.mouse.up();
    await frames(page);
    assert.ok(await page.evaluate(() => Boolean(document.getSelection()?.toString().trim())));
    assert.equal(await page.$('.meo-md-html-source-range-start'), null);
    await page.evaluate(() => document.getSelection()?.removeAllRanges());
    await page.keyboard.down('Control'); await page.click('#center .meo-md-html-link[data-meo-link-href="https://example.com/docs"]'); await page.keyboard.up('Control');
    await frames(page);
    assert.deepEqual(await page.evaluate(() => (window as any).__htmlLinks), ['https://example.com/docs']);
    assert.equal(await page.$('.meo-md-html-source-range-start'), null);

    await page.click('.meo-md-html-content details > summary');
    await frames(page);
    assert.equal(await page.$eval('.meo-md-html-content details', node => (node as HTMLDetailsElement).open), false);
    assert.equal(await page.$('.meo-md-html-source-range-start'), null);
    await page.click('.meo-md-html-content details > summary');
    await frames(page);
    assert.equal(await page.$eval('.meo-md-html-content details', node => (node as HTMLDetailsElement).open), true);

    // Keyboard navigation reaches an otherwise invisible anchor as ordinary source.
    await select(page, '<div id="html-test-top"', 9);
    assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll('.meo-md-html-invisible-source-text'))
      .some(node => node.textContent?.includes('html-test-top'))), false);
    assert.ok(await page.$eval('.meo-md-html-source-range-start', node => node.textContent?.includes('html-test-top')));
    assert.equal(await page.$('.meo-md-html-live-result'), null, 'No empty preview frame');
    await page.keyboard.type('X');
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await select(page, 'Tail paragraph.');
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString()), source);
    assert.ok(await page.$('.meo-md-html-invisible-source-text'));

    // Incomplete HTML stays editable and current safe content can still render.
    await select(page, 'English', 2);
    await page.evaluate(() => {
      const view = (window as any).__htmlEditor.view;
      const end = view.state.doc.toString().indexOf('</p>');
      view.dispatch({ changes: { from: end, to: end + 4, insert: '</p' } });
    });
    await frames(page);
    assert.ok(await page.$('.meo-md-html-source-range-start'));
    assert.ok(await page.$eval('.meo-md-html-live-result', node => node.textContent?.includes('English')));
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await select(page, 'Tail paragraph.');
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString()), source);
    for (const mode of ['source', 'live'] as const) {
      await page.evaluate(mode => (window as any).__htmlEditor.setMode(mode), mode); await frames(page);
      assert.equal(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString()), source);
    }

    const htmlFrom = source.indexOf('<p id="center"'), htmlTo = source.indexOf('</p>') + 4;
    for (const [key, position] of [['ArrowDown', htmlFrom - 1], ['ArrowRight', htmlFrom - 1],
      ['ArrowUp', htmlTo + 1], ['ArrowLeft', htmlTo]] as const) {
      await select(page, 'Prelude paragraph.');
      await page.evaluate(position => {
        const view = (window as any).__htmlEditor.view;
        view.dispatch({ selection: { anchor: position }, scrollIntoView: true }); view.focus();
      }, position);
      await frames(page);
      await page.keyboard.press(key); await frames(page);
      assert.ok(await page.$('.meo-md-html-source-range-start'), `${key} enters HTML source`);
      assert.equal(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString()), source);
    }

    await select(page, '<p id="center"', 2);
    await page.keyboard.type(' ti');
    await page.keyboard.down('Control'); await page.keyboard.press('Space'); await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelector('.cm-tooltip-autocomplete')?.textContent?.includes('title'), { timeout: 3000 });
    await frames(page);
    await page.keyboard.press('Enter'); await frames(page);
    const completed = await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString());
    assert.ok(completed.includes('<p title id="center"'), `HTML attribute completion edits the main document: ${completed.slice(htmlFrom, htmlFrom + 60)}`);
    await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);
    await select(page, '  <a href="#target">');
    await page.keyboard.type('<span>'); await frames(page);
    assert.ok(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString().includes('<span></span>')),
      'HTML tags close automatically in the main source');
    await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);
    await select(page, '<div id="target">', '<div id="target">'.length);
    await page.keyboard.type('<div>'); await frames(page);
    assert.ok(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString()
      .includes('<div id="target"><div></div><p>')),
      'Nested tags do not consume an existing same-name parent closing tag');
    await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);
    await select(page, 'English', 7);
    const input = await page.createCDPSession();
    try {
      await input.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
      await input.send('Input.insertText', { text: '中文' });
    } finally { await input.detach(); }
    await frames(page);
    assert.ok(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString().includes('English中文')));
    assert.ok(await page.$eval('.meo-md-html-live-result', node => node.textContent?.includes('English中文')));
    await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);
    await select(page, 'English', 7);
    await page.evaluate(() => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'Pasted');
      clipboardData.setData('text/html', '<strong>Pasted</strong>');
      (window as any).__htmlEditor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    await frames(page);
    assert.ok(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString().includes('EnglishPasted')),
      'HTML source paste retains literal text instead of converting it to Markdown');
    await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);
    await select(page, 'English', 2);
    await page.evaluate(({ from, to }) => {
      const view = (window as any).__htmlEditor.view;
      view.dispatch({ changes: { from, to, insert: 'Replacement paragraph.' }, selection: { anchor: from + 8 } });
    }, { from: htmlFrom, to: htmlTo });
    await frames(page);
    assert.equal(await page.$('.meo-md-html-source-range-start'), null, 'Replacing the complete HTML fragment releases its source range');
    await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);

    for (const appearance of ['light', 'dark'] as const) for (const language of ['zh-CN', 'en'] as const) {
      await page.evaluate(({ appearance, language }) => {
        const style = document.documentElement.style;
        style.setProperty('--meo-foreground', appearance === 'dark' ? '#d4d4d4' : '#1f2328');
        style.setProperty('--vscode-editor-foreground', appearance === 'dark' ? '#d4d4d4' : '#1f2328');
        style.setProperty('--vscode-editor-background', appearance === 'dark' ? '#121314' : '#ffffff');
        (window as any).HtmlContentHarness.applyUiTheme(appearance, true);
        (window as any).__htmlEditor.setUiLanguage(language);
      }, { appearance, language });
      await select(page, 'Prelude paragraph.');
      await page.setViewport({ width: language === 'en' ? 520 : 1000, height: 1000 });
      await frames(page);
      await page.screenshot({ path: path.join(artifacts, `${appearance}-${language}-reading.png`) });
      await select(page, 'English', 2);
      assert.equal(await page.$eval('.meo-md-html-result-status', node => node.textContent),
        language === 'zh-CN' ? '预览' : 'Preview');
      await page.screenshot({ path: path.join(artifacts, `${appearance}-${language}-editing.png`) });
    }
    assert.deepEqual(errors, [], 'No runtime errors');
    console.log(`HTML fragment rendering, source editing and invisible-source tests passed. Screenshots: ${artifacts}`);
  } finally { await browser.close(); }
}

await main();
