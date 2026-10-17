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
assert.deepEqual(parseCriticComment('#c17 @DEBATE: why not?'), { id: 'c17', author: 'DEBATE', body: 'why not?' });
assert.deepEqual(parseCriticComment('plain note'), { id: null, author: null, body: 'plain note' });
assert.deepEqual(parseCriticComment('@Oriol: no id'), { id: null, author: 'Oriol', body: 'no id' });

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
  '<span class="critic-comment" title="#c1">Oriol: check &lt;b&gt;this&lt;/b&gt;</span>',
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

  console.log('CriticMarkup test passed');
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
