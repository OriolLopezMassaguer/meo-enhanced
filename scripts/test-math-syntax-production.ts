import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-highlight-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser(), page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
let step = 'initial';
try {
  await page.setViewport({ width: 980, height: 660 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  const katexDirectory = path.resolve('node_modules/katex/dist');
  await page.addStyleTag({ content: readFileSync(path.join(katexDirectory, 'katex.min.css'), 'utf8')
    .replace(/url\(([^)]+)\)/g, (_match, fontPath) => `url(data:font/woff2;base64,${readFileSync(path.join(katexDirectory, fontPath)).toString('base64')})`) });
  await page.addStyleTag({ content: ':root{--vscode-editor-font-family:Consolas,monospace;--vscode-editor-font-weight:400;--vscode-editor-font-size:16px;--meo-user-editor-font-size:16px}' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const rules = [
    { scope: 'entity.name.function.math.tex', settings: { foreground: '#cc5500' } },
    { scope: 'constant.character.math.tex', settings: { foreground: '#0066cc' } },
    { scope: 'constant.numeric.math.tex', settings: { foreground: '#008844' } },
    { scope: 'comment.line.math.tex', settings: { foreground: '#885588' } },
    { scope: 'punctuation.math.operator.latex', settings: { foreground: '#aa2277' } }
  ];
  const prepare = async (mode: string, text: string, head = text.indexOf('frac') + 3, theme: any = darkPlus, custom = true) => {
    await page.evaluate(({ mode, text, head, theme, rules, custom }) => {
      const g = window as any, h = g.HighlightHarness;
      g.editor?.destroy();
      const palette = { ...theme, tokenColors: [...theme.tokenColors, ...(custom ? rules : [])] };
      document.body.className = theme.type === 'light' ? 'vscode-light' : 'vscode-dark';
      const style = document.documentElement.style;
      style.setProperty('--vscode-editor-foreground', theme.colors['editor.foreground'] ?? '#d4d4d4');
      style.setProperty('--vscode-editor-background', theme.colors['editor.background'] ?? '#1e1e1e');
      h.applyBuiltInVisualBaseline(theme.type);
      h.setShikiTheme(palette); h.setShikiTheme(palette, 'source');
      style.setProperty('--meo-source-foreground', theme.colors['editor.foreground'] ?? '#d4d4d4');
      style.setProperty('--meo-background', theme.colors['editor.background'] ?? '#1e1e1e');
      style.setProperty('--meo-foreground', theme.colors['editor.foreground'] ?? '#d4d4d4');
      g.editor = h.createEditor({ parent: document.getElementById('app'), text, initialMode: mode,
        initialCursorPos: head, onApplyChanges() {} });
      g.editor.view.dispatch({ selection: { anchor: head } }); g.editor.focus();
    }, { mode, text, head: Math.max(0, head), theme, rules, custom });
  };
  const color = (needle: string, offset = 1) => page.evaluate(({ needle, offset }) => {
    const editor = (window as any).editor, position = editor.getText().indexOf(needle) + offset;
    const dom = editor.view.domAtPos(position), element = dom.node.nodeType === Node.TEXT_NODE ? dom.node.parentElement : dom.node;
    return getComputedStyle(element).color;
  }, { needle, offset });
  const expectColor = async (needle: string, expected: string, offset = 1) => {
    try {
      await page.waitForFunction(({ needle, expected, offset }) => {
        const editor = (window as any).editor, position = editor.getText().indexOf(needle) + offset;
        const dom = editor.view.domAtPos(position), element = dom.node.nodeType === Node.TEXT_NODE ? dom.node.parentElement : dom.node;
        return getComputedStyle(element).color === expected;
      }, { timeout: 6000 }, { needle, expected, offset });
    } catch {
      console.error(JSON.stringify({ step, errors, html: await page.$eval('.cm-content', node => node.innerHTML.slice(0, 5000)) }));
      throw new Error(step + ': ' + needle + ' expected ' + expected + ', got ' + await color(needle, offset));
    }
  };
  const formula = String.raw`\frac{x_1}{2} + \alpha`;
  const fixtures = [
    '行内 $' + formula + '$ 结束', '$$' + formula + '$$', '$$\n' + formula + '\n$$',
    ...['math', 'latex', 'tex', 'katex'].map(language => '```' + language + '\n' + formula + '\n```'),
    '> $$\n> ' + formula + '\n> $$',
    '- 公式\n\n  ```math\n  ' + formula + '\n  ```',
    '$' + formula, '$$\n' + formula, '```math\n' + formula,
    '$$\n\\frac{x}{2} + \\alpha + \\% % 注释\n\\alpha\n$$',
    '$' + formula + '$\n\n```python\nprint(9)\n```'
  ];
  for (const mode of ['source', 'live']) for (const theme of [lightPlus, darkPlus]) {
    for (const text of fixtures) {
      step = mode + '/' + theme.type + '/' + text.split('\n')[0];
      await prepare(mode, text, undefined, theme);
      await expectColor('frac', 'rgb(204, 85, 0)');
      await expectColor('2', 'rgb(0, 136, 68)');
      await expectColor('alpha', 'rgb(0, 102, 204)');
      if (text.includes('注释')) {
        await expectColor('注释', 'rgb(136, 85, 136)');
        assert.notEqual(await color('\\%'), 'rgb(136, 85, 136)', step + ': escaped percent is not a comment');
      }
      assert.equal(await page.evaluate(() => (window as any).editor.getText()), text, step + ': paint preserves source');
    }
    step = mode + '/' + theme.type + '/literal boundaries';
    const literal = String.raw`价格 $5 and $10，转义 \$\alpha，代码 ` + '`$\\alpha$`';
    await prepare(mode, literal, literal.length, theme);
    assert.notEqual(await color('alpha'), 'rgb(0, 102, 204)', step + ': escaped dollars stay literal');
    assert.equal(await page.$$eval('.meo-math-token', nodes => nodes.length), 0, step + ': ordinary code/currency are not Live math');

    step = mode + '/' + theme.type + '/typing and history';
    await prepare(mode, '$\\alph$', 6, theme);
    await expectColor('alph', 'rgb(0, 102, 204)');
    await page.keyboard.type('a');
    await expectColor('alpha', 'rgb(0, 102, 204)');
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as any).editor.undo());
    await expectColor('alph', 'rgb(0, 102, 204)');
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), '$\\alph$');
    await page.evaluate(() => (window as any).editor.redo());
    await expectColor('alpha', 'rgb(0, 102, 204)');
  }

  for (const mode of ['source', 'live']) {
    step = mode + '/multiline token batches';
    const text = '$$\n\\begin{aligned}\n' + Array.from({ length: 140 }, () => formula + String.raw` \\`).join('\n') + '\n\\omega\n\\end{aligned}\n$$';
    await prepare(mode, text);
    await expectColor('frac', 'rgb(204, 85, 0)');
    await page.evaluate(() => {
      const editor = (window as any).editor;
      editor.view.dispatch({ selection: { anchor: editor.getText().indexOf('omega') + 2 }, scrollIntoView: true });
    });
    await expectColor('omega', 'rgb(0, 102, 204)');
  }

  step = 'independent Source theme';
  await prepare('live', '$' + formula + '$');
  await expectColor('frac', 'rgb(204, 85, 0)');
  await page.evaluate(theme => {
    const h = (window as any).HighlightHarness;
    h.setShikiTheme({ ...theme, tokenColors: [...theme.tokenColors,
      { scope: 'entity.name.function.math.tex', settings: { foreground: '#9944cc' } }] }, 'source');
    (window as any).editor.setMode('source');
  }, darkPlus);
  await expectColor('frac', 'rgb(153, 68, 204)');
  await page.evaluate(() => (window as any).editor.setMode('live'));
  await expectColor('frac', 'rgb(204, 85, 0)');

  const artifacts = '.local/test-artifacts/math-syntax';
  await fs.mkdir(artifacts, { recursive: true });
  const sample = '# LaTeX 公式源码高亮\n\n行内公式：$\\frac{x_1}{2} + \\alpha = \\sqrt{y}$\n\n$$\n\\begin{aligned}\n  f(x) &= \\frac{a_1 + b^2}{\\sqrt{x}} \\\\\n  g(x) &= \\sum_{i=1}^{n} x_i % 求和\n\\end{aligned}\n$$\n\n公式后的普通正文。';
  for (const theme of [lightPlus, darkPlus]) for (const mode of ['source', 'live']) {
    step = 'screenshot/' + theme.type + '/' + mode;
    await prepare(mode, sample, sample.indexOf('g(x)'), theme, false);
    await page.waitForFunction(() => {
      const view = (window as any).editor.view;
      return view.dom.querySelector('.meo-source-token, .meo-math-token');
    });
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 200)); });
    await page.screenshot({ path: artifacts + '/' + theme.type + '-' + mode + '.png' });
  }
  assert.deepEqual(errors, [], 'No tokenizer or editor errors');
  console.log('Math syntax: Source/Live, both themes, every math form, containers, unfinished input, literal boundaries, independent palettes and history passed');
} finally { await closeTestBrowser(browser); }
