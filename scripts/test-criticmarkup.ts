import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import exportRuntime from '../src/export/runtime';
import { matchCriticMarkup, parseCriticComment } from '../src/foundation/criticMarkup';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-criticmarkup-'));

// Scanner: one source of truth for Lezer and markdown-it.
const match = (text: string, from = 0) => matchCriticMarkup(text, from);
assert.deepEqual(match('{++new++}'), { kind: 'add', to: 9, openLength: 3, closeLength: 3 });
assert.equal(match('{--old--}')?.kind, 'del');
assert.equal(match('{==mark==}')?.kind, 'hl');
assert.equal(match('{>>note<<}')?.kind, 'comment');
assert.deepEqual(match('{~~a~>b~~}')?.separator, { from: 4, to: 6 });
assert.equal(match('{~~a~>b~~}')?.to, 10);
assert.equal(match('{~~no separator~~}'), null, 'substitution requires ~>');
assert.equal(match('{++unclosed'), null, 'unclosed mark stays text');
assert.equal(match('{++++}'), null, 'empty content is not a mark');
assert.equal(match('{+x+}'), null);
assert.equal(match('see {++x++} here', 4)?.to, 11, 'matches from an offset');
assert.equal(match('{++a++} and {--b--}')?.to, 7, 'stops at the first closing delimiter');
assert.equal(matchCriticMarkup('{++a++}', 0, 5), null, 'does not read past the end bound');
assert.deepEqual(parseCriticComment('#c17 @DEBATE: why not?'), { id: 'c17', author: 'DEBATE', date: null, resolved: false, body: 'why not?' });
assert.deepEqual(parseCriticComment('plain note'), { id: null, author: null, date: null, resolved: false, body: 'plain note' });
assert.deepEqual(parseCriticComment('@Oriol: no id'), { id: null, author: 'Oriol', date: null, resolved: false, body: 'no id' });
assert.deepEqual(parseCriticComment('#c2 @Oriol 2026-10-18: [x] done'), { id: 'c2', author: 'Oriol', date: '2026-10-18', resolved: true, body: 'done' });
assert.deepEqual(parseCriticComment('@Ana Maria 2026-01-02: n'), { id: null, author: 'Ana Maria', date: '2026-01-02', resolved: false, body: 'n' });
assert.equal(parseCriticComment('@Oriol: [X] upper').resolved, true, 'marker is case-insensitive');
assert.equal(parseCriticComment('@Oriol: [x]no space').resolved, false, 'the marker needs a following space');

// Export / Preview.
const markdown = [
  'A {++added++} and {--removed--} and {~~bad~>good~~} and {==marked==}{>>#c1 @Oriol: check <b>this</b><<} end.',
  '',
  '`{++code++}` and \\{++escaped++} stay literal.',
  '',
  '```',
  '{--fenced--}',
  '```',
  '',
  'Unclosed {++ stays text and ~~real strike~~ still works.'
].join('\n');
const preview = exportRuntime.renderPreviewDocument({
  markdownText: markdown, sourceDocumentPath: 'C:/tmp/critic.md', uiLanguage: 'en', styleEnvironment: { previewFontFamily: '' }
});
const html = preview.html;
for (const expected of [
  '<span class="critic-add">added</span>',
  '<span class="critic-del">removed</span>',
  '<span class="critic-del">bad</span><span class="critic-add">good</span>',
  '<span class="critic-hl">marked</span>',
  '<span class="critic-note"><span class="critic-badge" tabindex="0" role="button" title="#c1">1</span><span class="critic-body">Oriol: check &lt;b&gt;this&lt;/b&gt;</span></span>',
  '<code>{++code++}</code>',
  '<s>real strike</s>'
]) assert(html.includes(expected), `Preview missing ${expected}\n${html}`);
assert(!html.includes('critic-add">escaped'), 'escaped brace must not open a mark');
assert(html.includes('{--fenced--}') && !html.includes('critic-del">fenced'), 'fenced code must stay literal');
assert(preview.styles.dark.includes('.critic-add') && preview.styles.light.includes('.critic-del'), 'Preview styles carry the palette');

// Editor: Live and Source.
const build = await Bun.build({
  entrypoints: [path.join(repoRoot, 'scripts', 'test-highlight-entry.ts')],
  outdir: tempDir, target: 'browser', format: 'iife', naming: 'bundle.js'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
  // The setting defaults to off; the editor toggles this class (see setCriticMarkupEnabled).
  await page.evaluate(() => document.documentElement.classList.add('meo-critic-markup'));

  const source = [
    '# Title',
    '',
    'Line with {++added++} and {--removed--} and {~~bad~>good~~} text.',
    '',
    'Marked {==phrase==}{>>#t01 @Oriol: note<<} and ~~strike~~ here.',
    '',
    'Last paragraph.'
  ].join('\n');

  const result = await page.evaluate(async (text) => {
    const harness = (window as any).HighlightHarness;
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const editor = harness.createEditor({ parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {} });
    // Park the caret on the last paragraph so the marks above are not on the active line.
    editor.view.dispatch({ selection: { anchor: text.length } });
    await settle();
    const texts = (selector: string) => Array.from(document.querySelectorAll(selector)).map((node) => node.textContent);
    const snapshot = () => ({
      add: texts('.meo-md-critic-add'),
      del: texts('.meo-md-critic-del'),
      hl: texts('.meo-md-critic-hl'),
      // the #t01 id is split out by the hashtag decoration, so compare the trimmed remainder
      comment: texts('.meo-md-critic-comment').map((value) => value!.trim()).filter((value) => value !== '#t01'),
      strike: texts('.meo-md-strike'),
      markerDisplay: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-critic-marker')).map((node) => getComputedStyle(node).display)
    });
    const live = snapshot();
    const delStyle = getComputedStyle(document.querySelector('.meo-md-critic-del')!);
    const liveDelDecoration = delStyle.textDecorationLine;
    editor.setMode('source');
    await settle();
    const sourceView = snapshot();
    const sourceText = editor.getText();
    editor.setMode('live');
    await settle();
    return { live, liveDelDecoration, sourceView, sourceText, restored: snapshot() };
  }, source);

  const expectedContent = {
    add: ['added'], del: ['removed', 'bad'], hl: ['phrase'], comment: ['@Oriol: note'], strike: ['strike']
  };
  const content = (snapshot: typeof result.live) => ({
    add: snapshot.add, del: snapshot.del, hl: snapshot.hl, comment: snapshot.comment, strike: snapshot.strike
  });
  assert.deepEqual(content(result.live), { ...expectedContent, add: ['added', 'good'] }, 'Live content ranges');
  assert.equal(result.liveDelDecoration, 'line-through', 'Live deletion is struck through');
  assert(result.live.markerDisplay.length > 0 && result.live.markerDisplay.every((display) => display === 'none'),
    `Live hides delimiters off the active line: ${JSON.stringify(result.live.markerDisplay)}`);
  assert.deepEqual(content(result.sourceView).add, ['added', 'good'], 'Source tints the same ranges');
  assert.deepEqual(content(result.sourceView).del, ['removed', 'bad']);
  assert(result.sourceView.markerDisplay.every((display) => display !== 'none'), 'Source keeps every delimiter visible');
  assert.equal(result.sourceText, source, 'Mode switches must preserve Markdown source');
  assert.deepEqual(content(result.restored), content(result.live), 'Live/Source roundtrip');

  // A mark that opens before a list and closes after it spans several blocks.
  const crossBlock = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    (window as any).__highlightEditor?.destroy();
    document.getElementById('app')!.replaceChildren();
    const text = ['{==- first item', '- second item==}{>>#c2 @Oriol: spans a list<<}', '', '```', '{==in code==}', '```', '', 'Last paragraph.'].join('\n');
    const editor = harness.createEditor({ parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {} });
    editor.view.dispatch({ selection: { anchor: text.length } });
    await settle();
    const joined = (selector: string) => Array.from(document.querySelectorAll(selector)).map((node) => node.textContent).join('|');
    const live = { hl: joined('.meo-md-critic-hl'), markers: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-critic-marker')).map((node) => getComputedStyle(node).display) };
    editor.setMode('source');
    await settle();
    const source = { hl: joined('.meo-md-critic-hl'), markers: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-critic-marker')).map((node) => getComputedStyle(node).display) };
    editor.destroy();
    return { live, source };
  });
  for (const mode of ['live', 'source'] as const) {
    assert(crossBlock[mode].hl.includes('first item') && crossBlock[mode].hl.includes('second item'), `${mode}: cross-block highlight: ${JSON.stringify(crossBlock[mode])}`);
    assert(!crossBlock[mode].hl.includes('in code'), `${mode}: fenced code must stay literal`);
  }
  assert(crossBlock.live.markers.every((display) => display === 'none'), 'Live hides cross-block delimiters off the active mark');
  assert(crossBlock.source.markers.every((display) => display !== 'none'), 'Source keeps cross-block delimiters visible');

  // The checkbox off: delimiters visible, no color, no strike-through, identical to plain Markdown text.
  const off = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    document.getElementById('app')!.replaceChildren();
    const text = ['Line {++added++} and {--removed--} here.', '', 'Last paragraph.'].join('\n');
    const editor = harness.createEditor({ parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {} });
    editor.view.dispatch({ selection: { anchor: text.length } });
    const probe = () => {
      const added = document.querySelector<HTMLElement>('.meo-md-critic-add')!;
      const removed = document.querySelector<HTMLElement>('.meo-md-critic-del')!;
      const body = getComputedStyle(document.querySelector('.cm-content')!).color;
      return {
        addColored: getComputedStyle(added).color !== body,
        delStruck: getComputedStyle(removed).textDecorationLine.includes('line-through'),
        markers: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-critic-marker')).map((node) => getComputedStyle(node).display)
      };
    };
    await settle();
    const on = probe();
    document.documentElement.classList.remove('meo-critic-markup');
    await settle();
    const disabled = probe();
    document.documentElement.classList.add('meo-critic-markup');
    editor.destroy();
    return { on, disabled };
  });
  assert(off.on.addColored && off.on.delStruck && off.on.markers.every((display) => display === 'none'), `enabled state: ${JSON.stringify(off.on)}`);
  assert(!off.disabled.addColored && !off.disabled.delStruck && off.disabled.markers.every((display) => display !== 'none'),
    `disabled state must read as plain text: ${JSON.stringify(off.disabled)}`);

  // Preview notes: a numbered badge that opens its text on focus, without JavaScript.
  const notePage = await browser.newPage();
  try {
    await notePage.setContent(`<style>${preview.styles.dark}</style><main class="meo-export-doc">${preview.html}</main>`);
    const note = await notePage.evaluate(() => {
      const badge = document.querySelector<HTMLElement>('.critic-badge')!;
      const body = document.querySelector<HTMLElement>('.critic-body')!;
      const closed = getComputedStyle(body).display;
      badge.focus();
      const opened = getComputedStyle(body).display;
      return { closed, opened, label: badge.textContent, tabbable: badge.tabIndex === 0 };
    });
    assert.deepEqual(note, { closed: 'none', opened: 'block', label: '1', tabbable: true }, 'Preview note opens on focus');
  } finally { await notePage.close(); }


  // Nested syntax: emphasis, links and inner marks work inside a mark; a comment stays plain text.
  const nestedPreview = exportRuntime.renderPreviewDocument({
    markdownText: [
      '{++**bold** and [link](https://example.com)++}',
      '',
      '{~~*old*~>**new**~~}',
      '',
      '{==outer {++inner++} text==}',
      '',
      '{>>#c9 note with **stars**<<}'
    ].join('\n'),
    sourceDocumentPath: 'C:/tmp/nested.md', uiLanguage: 'en', styleEnvironment: { previewFontFamily: '' }
  }).html;
  for (const expected of [
    '<span class="critic-add"><strong>bold</strong> and <a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a></span>',
    '<span class="critic-del"><em>old</em></span><span class="critic-add"><strong>new</strong></span>',
    '<span class="critic-hl">outer <span class="critic-add">inner</span> text</span>',
    '<span class="critic-body">note with **stars**</span>'
  ]) assert(nestedPreview.includes(expected), `nested preview missing ${expected}\n${nestedPreview}`);

  const nestedEditor = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    document.getElementById('app')!.replaceChildren();
    const text = ['{++**bold** inside++}', '', '{==outer {++inner++} text==}', '', 'Last paragraph.'].join('\n');
    const editor = harness.createEditor({ parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {} });
    editor.view.dispatch({ selection: { anchor: text.length } });
    await settle();
    const found = (selector: string) => Array.from(document.querySelectorAll(selector)).map((node) => node.textContent);
    const result = {
      strongInsideAdd: found('.meo-md-critic-add .meo-md-strong'),
      addInsideHighlight: found('.meo-md-critic-hl .meo-md-critic-add'),
      markers: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-critic-marker')).map((node) => getComputedStyle(node).display)
    };
    editor.destroy();
    return result;
  });
  assert.deepEqual(nestedEditor.strongInsideAdd, ['bold'], 'emphasis renders inside a mark');
  assert.deepEqual(nestedEditor.addInsideHighlight, ['inner'], 'a mark renders inside another');
  assert(nestedEditor.markers.every((display) => display === 'none'), 'delimiters hide off the active line, nested ones included');

  console.log('CriticMarkup test passed');
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
