import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-list-editing-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const themeBuild = await Bun.build({ entrypoints: ['webview/src/helpers/theme.ts'], target: 'browser', format: 'esm' });
assert.ok(themeBuild.success, themeBuild.logs.map(String).join('\n'));
const themeBundle = await themeBuild.outputs[0]!.text();
const text = 'Ordinary line\n\n> Quoted line\n> > ```mermaid\n> > A --> B\n> > ```\n\nAfter';
const profiles = [
  { name: 'Light 2026', appearance: 'light', background: '#EAEAEA40', border: '#eeeeee' },
  { name: 'Dark 2026', appearance: 'dark', background: '#242526', border: '#282828' },
  { name: 'Custom translucent', appearance: 'light', background: '#2475ab55', border: '#ff0000' },
  { name: 'Transparent', appearance: 'dark', background: 'transparent', border: '#ff0000' },
  { name: 'No native highlight', appearance: 'light', background: '', border: '#eeeeee' },
  { name: 'Built-in light', appearance: 'light', hostAppearance: 'dark', background: '#242526', border: '#282828' },
  { name: 'Built-in dark', appearance: 'dark', hostAppearance: 'light', background: '#EAEAEA40', border: '#eeeeee' }
];
const browser = await launchTestBrowser();
try {
  for (const profile of profiles) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 900, height: 500 });
      await page.setContent('<!doctype html><style>html,body,#host{height:100%;margin:0}</style><div id="host"></div>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.evaluate(profile => {
        document.body.className = 'vscode-' + (profile.hostAppearance ?? profile.appearance);
        document.documentElement.dataset.editorAppearance = profile.appearance;
        const style = document.documentElement.style;
        for (const [name, value] of Object.entries({
          '--vscode-editor-lineHighlightBackground': profile.background,
          '--vscode-editor-lineHighlightBorder': profile.border,
          '--meo-background': profile.appearance === 'light' ? '#ffffff' : '#1f1f1f',
          '--meo-source-foreground': profile.appearance === 'light' ? '#333333' : '#cccccc',
          '--meo-font-source': 'monospace', '--meo-font-source-size': '14px'
        })) style.setProperty(name, value);
      }, profile);
      await page.addScriptTag({ type: 'module', content: themeBundle + '\nwindow.ActiveLineTheme = { applyBuiltInVisualBaseline };' });
      await page.waitForFunction(() => !!(window as any).ActiveLineTheme);
      await page.evaluate(appearance => (window as any).ActiveLineTheme.applyBuiltInVisualBaseline(appearance), profile.appearance);
      await page.addScriptTag({ content: bundle });
      await page.evaluate(text => {
        (window as any).activeLineEditor = (window as any).ListEditingHarness.createEditor({
          parent: document.getElementById('host')!, text, initialMode: 'source', onApplyChanges() {}
        });
      }, text);
      for (const number of [1, 3, 4, 5, 6]) {
        const actual = await page.evaluate(async ({ number, builtIn }) => {
          const editor = (window as any).activeLineEditor;
          editor.view.dispatch({ selection: { anchor: editor.view.state.doc.line(number).from } });
          editor.focus();
          for (let frame = 0; frame < 3; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const line = document.querySelector<HTMLElement>('.cm-editor.meo-mode-source .cm-line.cm-activeLine')!;
          const probe = document.createElement('i');
          probe.style.backgroundColor = builtIn ? 'var(--meo-document-active-line)' : 'var(--vscode-editor-lineHighlightBackground)';
          document.body.append(probe);
          const expectedBackground = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const style = getComputedStyle(line);
          return { text: line.textContent, background: style.backgroundColor, expectedBackground,
            editorBackground: getComputedStyle(editor.view.dom).backgroundColor,
            shadow: style.boxShadow, border: style.borderTopWidth, outline: style.outlineStyle };
        }, { number, builtIn: !!profile.hostAppearance });
        assert.equal(actual.text, text.split('\n')[number - 1], `${profile.name}: selected source line ${number}`);
        assert.equal(actual.background, actual.expectedBackground, `${profile.name}: line ${number} uses the ${profile.hostAppearance ? 'built-in' : 'native'} highlight background`);
        if (profile.hostAppearance) {
          assert.notEqual(actual.background, 'rgba(0, 0, 0, 0)', `${profile.name}: line ${number} has a visible highlight`);
          assert.notEqual(actual.background, actual.editorBackground, `${profile.name}: line ${number} differs from the editor background`);
        }
        assert.equal(actual.shadow, 'none', `${profile.name}: line ${number} has no rectangular highlight shadow`);
        assert.equal(actual.border, '0px', `${profile.name}: line ${number} has no border`);
        assert.equal(actual.outline, 'none', `${profile.name}: line ${number} has no outline`);
      }
      console.log(`${profile.name}: ordinary, quoted and code source lines match the theme highlight without an outline`);
    } finally {
      await page.evaluate(() => (window as any).activeLineEditor?.destroy());
      await page.close();
    }
  }
} finally {
  await closeTestBrowser(browser);
}
