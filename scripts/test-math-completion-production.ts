import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';

const build = await Bun.build({ entrypoints: ['scripts/test-editing-features-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser(), page = await browser.newPage();
const errors: string[] = [];
let step = 'initial';
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error' && /plugin crashed/i.test(message.text())) errors.push(message.text()); });
try {
  await page.setViewport({ width: 1000, height: 720 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  const prepare = async (mode: string, marked = '$|$', input = {}) => {
    await page.evaluate(({ mode, marked, input }) => {
      const g = window as any, position = marked.indexOf('|');
      g.editor?.destroy();
      g.editor = g.EditingFeaturesHarness.createEditor({ parent: document.getElementById('app')!,
        text: marked.replace('|', ''), initialMode: mode, initialCursorPos: position,
        initialInputAssistance: input, onApplyChanges() {} });
      g.editor.view.dispatch({ selection: { anchor: position } }); g.editor.view.focus();
    }, { mode, marked, input: { ...defaultInputAssistance, ...input } });
  };
  const text = () => page.evaluate(() => (window as any).editor.getText());
  const caret = () => page.evaluate(() => (window as any).editor.view.state.selection.main.head);
  const open = () => page.waitForSelector('.meo-math-suggestions:not([hidden])', { timeout: 4000 });
  const closed = async () => {
    try { await page.waitForFunction(() => !document.querySelector('.meo-input-suggestions:not([hidden])'), { timeout: 2000 }); }
    catch (error) { throw new Error(step + ': menu remained open: ' + await text(), { cause: error }); }
  };
  const waitText = (expected: string) => page.waitForFunction(expected => (window as any).editor.getText() === expected, { timeout: 4000 }, expected);
  const choose = async (label: string) => {
    await open();
    await page.evaluate(label => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-math-command]')].find(row => row.dataset.mathCommand === label);
      if (!row) throw new Error('Missing math candidate: ' + label);
      row.click();
    }, label);
    await closed();
  };
  for (const mode of ['source', 'live']) {
    step = mode + ': templates';
    await prepare(mode); await page.keyboard.type('\\fr'); await choose('\\frac');
    await waitText('$\\frac{}{}$'); assert.equal(await caret(), 7);
    await page.keyboard.type('\\sq'); await choose('\\sqrt');
    await page.keyboard.type('x'); await page.keyboard.press('Tab');
    await page.keyboard.type('y'); await page.keyboard.press('Tab');
    await waitText('$\\frac{\\sqrt{x}}{y}$');
    assert.equal(await caret(), (await text()).length - 1, mode + ': nested template resumes the denominator and exits at the root end');
    await page.evaluate(() => (window as any).editor.undo());
    await page.evaluate(() => (window as any).editor.redo());
    await waitText('$\\frac{\\sqrt{x}}{y}$');

    await prepare(mode); await page.keyboard.type('\\fr'); await choose('\\frac');
    await page.keyboard.type('a'); await page.keyboard.press('Tab'); await page.keyboard.type('b');
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); await page.keyboard.type('c');
    await waitText('$\\frac{c}{b}$');
    await page.keyboard.press('Escape'); await closed();

    await prepare(mode); await page.keyboard.type('\\sq'); await choose('\\sqrt');
    await page.keyboard.type('x}'); await waitText('$\\sqrt{x}$');
    assert.equal(await caret(), 9, mode + ': typing a generated closer skips it');

    await prepare(mode, '$\\fr|ac{x}{y}$'); await open(); await page.keyboard.press('Enter');
    await waitText('$\\frac{x}{y}$');
    await page.evaluate(() => (window as any).editor.undo()); await waitText('$\\frac{x}{y}$');

    for (const marked of ['$|', '$$\n|\n$$', '$$\n|', ...['math', 'latex', 'tex', 'katex'].map(language => '```' + language + '\n|\n```'), '```math\n|']) {
      await prepare(mode, marked); await page.keyboard.type('\\alp'); await open(); await page.keyboard.press('Tab');
      await waitText(marked.replace('|', '\\alpha'));
    }
    for (const marked of ['|', 'Price $20 and |', '`$|$`', '```js\n|\n```', '[link](|)', '<!-- $|$ -->', '$$\n% |\n$$']) {
      step = mode + ': excluded ' + marked;
      await prepare(mode, marked); await page.keyboard.type('\\alp'); await closed();
      assert.equal(await text(), marked.replace('|', '\\alp'), mode + ': excluded context retains literal input');
    }
    step = mode + ': disabled';
    await prepare(mode, '$|$', { math: false }); await page.keyboard.type('\\alp'); await closed();
    assert.equal(await text(), '$\\alp$');
    await prepare(mode); await page.keyboard.type('\\alp'); await open();
    await page.evaluate(input => (window as any).editor.setInputAssistance(input), { ...defaultInputAssistance, math: false });
    await closed(); assert.equal(await text(), '$\\alp$', mode + ': disabling an open menu leaves the source unchanged');

    step = mode + ': history and dismissal';
    await prepare(mode); await page.keyboard.type('\\sq'); await choose('\\sqrt');
    await page.evaluate(() => (window as any).editor.undo()); await waitText('$\\sq$');
    await page.evaluate(() => (window as any).editor.redo()); await waitText('$\\sqrt{}$');
    await prepare(mode); await page.keyboard.type('\\alp'); await open(); await page.keyboard.press('Escape'); await closed();
    await page.keyboard.press('Enter');
    assert.ok((await text()).includes('\\alp'), mode + ': dismissal does not commit a candidate');

    step = mode + ': environments';
    await prepare(mode, '> $$\n> |\n> $$'); await page.keyboard.type('\\begin{ali'); await choose('\\begin{aligned}');
    await page.keyboard.type('x &= y');
    await waitText('> $$\n> \\begin{aligned}\n>   x &= y\n> \\end{aligned}\n> $$');
    await prepare(mode, '$$\n\\begin{ali|}\nx &= y\n\\end{aligned}\n$$');
    await choose('\\begin{aligned}');
    await waitText('$$\n\\begin{aligned}\nx &= y\n\\end{aligned}\n$$');

    step = mode + ': composition';
    await prepare(mode); await page.keyboard.type('\\alp'); await open();
    const ime = await page.createCDPSession();
    await ime.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 0, selectionEnd: 5 });
    const beforeImeEnter = await text();
    await page.evaluate(() => (window as any).editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(await text(), beforeImeEnter, mode + ': IME Enter never commits a completion');
    await ime.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); await ime.detach();

    step = mode + ': modes';
    await prepare(mode); await page.keyboard.type('\\alp'); await open();
    await page.evaluate(mode => (window as any).editor.setMode(mode === 'source' ? 'live' : 'source'), mode); await closed();
    await page.evaluate(mode => (window as any).editor.setMode(mode), mode);
    assert.equal(await text(), '$\\alp$', mode + ': mode changes do not apply suggestions');
    await prepare(mode); await page.keyboard.type('\\alp'); await open();
    await page.evaluate(() => {
      const g = window as any;
      g.editor.view.dispatch({ effects: g.EditingFeaturesHarness.StateEffect.appendConfig.of(g.EditingFeaturesHarness.EditorState.readOnly.of(true)) });
    }); await closed();
    await page.keyboard.press('Enter'); assert.equal(await text(), '$\\alp$', mode + ': read-only state cannot accept a candidate');
  }

  await fs.mkdir('.local/test-artifacts/math-completion', { recursive: true });
  for (const theme of ['light', 'dark']) for (const language of ['zh-CN', 'en']) {
    await prepare('source', '$|$', { slashPreferAbove: theme === 'dark' });
    await page.evaluate(({ theme, language }) => {
      const g = window as any;
      document.body.classList.toggle('vscode-dark', theme === 'dark');
      document.body.classList.toggle('vscode-light', theme === 'light');
      document.documentElement.style.background = theme === 'dark' ? '#181818' : '#ffffff';
      g.EditingFeaturesHarness.applyUiTheme(theme, false);
      g.editor.setUiLanguage(language);
    }, { theme, language });
    await page.keyboard.type('\\sq'); await open();
    assert.match(await page.$eval('.meo-input-suggestion-detail', node => node.textContent), language === 'en' ? /root/ : /根式/);
    await page.screenshot({ path: '.local/test-artifacts/math-completion/' + theme + '-' + language + '.png' });
  }
  await page.setViewport({ width: 360, height: 420 });
  await prepare('source', '$|$'); await page.keyboard.type('\\alp'); await open();
  const bounds = await page.$eval('.meo-math-suggestions', node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
  assert.ok(bounds.left >= 0 && bounds.right <= 360 && bounds.top >= 0 && bounds.bottom <= 420, 'narrow viewport contains the entire menu');
  assert.deepEqual(errors, []);
  console.log('Math completion production input, nested fields, history, modes, IME and bilingual themes passed');
} finally { await closeTestBrowser(browser); }
