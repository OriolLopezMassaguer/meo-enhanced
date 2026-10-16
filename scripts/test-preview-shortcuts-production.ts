import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const text = '## Reading\n\n[Jump to destination](#destination)\n\nSelect and copy this paragraph.\n\n'
  + 'More reading content.\n\n'.repeat(30) + '## Destination\n\nEnd of the document.';
const build = await Bun.build({
  entrypoints: ['scripts/test-settings-window-production-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  for (const surface of ['full', 'side'] as const) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1200, height: 800 });
      await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.exposeFunction('__renderShortcutPreview', (message: any) => {
        if (message.type === 'applyChanges') return { type: 'applied', version: message.baseVersion + 1 };
        if (message.type === 'saveDocumentAs') return {
          type: 'documentSaveAsResult', requestId: message.requestId,
          result: { ok: true, value: { status: 'not-completed' } }
        };
        if (message.type === 'saveDocumentRevision') return {
          type: 'saveDocumentRevisionResult', requestId: message.requestId,
          result: { ok: true, value: { revision: message.revision } }
        };
        if (message.type !== 'requestPreviewRender') return null;
        return {
          type: 'previewRenderResult', requestId: message.requestId,
          result: { ok: true, value: exportRuntime.renderPreviewDocument({
            markdownText: message.text, sourceDocumentPath: 'C:/tmp/preview-shortcuts.md',
            uiLanguage: message.uiLanguage, styleEnvironment: message.environment
          }) }
        };
      });
      await page.addScriptTag({ content: `window.__shortcutMessages=[];window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__shortcutMessages.push(message);window.__renderShortcutPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
      await page.addScriptTag({ content: bundle });
      await page.evaluate(({ text, surface }) => {
        const global = window as any;
        global.__shortcutPreferences = {
          input: global.EditingSettingsHarness.defaultInputAssistance,
          shortcuts: { preview: ['Ctrl + Alt + V'] }
        };
        window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'init', documentId: 'file:///preview-shortcuts.md', text, version: 1,
          savedRevision: { version: 1, text }, diagnostics: [], mode: surface === 'full' ? 'live' : 'source',
          uiLanguage: 'en', sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '',
          previewSourceColoring: true, editorAppearance: 'dark', gitChangesGutter: false,
          gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
          fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
          findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right',
          outlineVisible: false, outlineWidth: 260, restoreReadingPositionOnOpen: false, vscodeTheme: null,
          editingPreferences: global.__shortcutPreferences, editingPreferencesRevision: 0
        } }));
      }, { text, surface });
      await page.waitForFunction(() => Boolean(document.querySelector('.editor-host > .cm-editor'))
        && !document.querySelector('.editor-wrapper')?.classList.contains('meo-preload-editor-shell'));
      // Give the hidden/unfocused editor something to undo, so a scope leak is observable.
      const editedText = await page.evaluate(() => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        view.dispatch({ changes: { from: view.state.doc.length, insert: '\nEditor history witness' } });
        return view.state.doc.toString() as string;
      });
      await page.click(surface === 'full' ? '[data-mode="preview"]' : '.source-preview-button');
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden === true
        && document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.getElementById('reading'));
      await new Promise(resolve => setTimeout(resolve, 250));
      const frame = await (await page.$('.preview-frame'))!.contentFrame();
      assert.ok(frame);
      const chord = async (key: string, alt = false) => {
        await page.keyboard.down('Control');
        if (alt) await page.keyboard.down('Alt');
        try { await page.keyboard.press(key); }
        finally { if (alt) await page.keyboard.up('Alt'); await page.keyboard.up('Control'); }
      };
      const focusBody = () => frame.click('#reading');
      // Model the outer VS Code key listener, rather than another MEO command.
      await page.evaluate(() => {
        const global = window as any;
        global.__hostKeys = [];
        for (const type of ['keydown', 'keyup']) window.addEventListener(type, event => {
          const key = event as KeyboardEvent;
          global.__hostKeys.push({ type, key: key.key, code: key.code, keyCode: key.keyCode,
            ctrl: key.ctrlKey, alt: key.altKey, shift: key.shiftKey, meta: key.metaKey,
            repeat: key.repeat, target: (key.target as Element)?.className });
          if (key.ctrlKey && key.altKey && key.code === 'KeyP') key.preventDefault();
        });
      });
      await focusBody();
      await chord('p', true);
      const hostKeys = await page.evaluate(() => (window as any).__hostKeys);
      assert.deepEqual(hostKeys, ['keydown', 'keyup'].map(type => ({
        type, key: 'p', code: 'KeyP', keyCode: 80, ctrl: true, alt: true,
        shift: false, meta: false, repeat: false, target: 'preview-frame'
      })), `${surface}: unhandled Ctrl+Alt+P never reached the VS Code key listener`);
      assert.equal(await page.$eval('#app', app => (app as HTMLElement).dataset.mode), surface === 'full' ? 'preview' : 'source');
      await page.evaluate(() => { (window as any).__hostKeys = []; });
      await page.keyboard.press('F1');
      assert.deepEqual(await page.evaluate(() => (window as any).__hostKeys.map((event: any) => [event.type, event.key])),
        [['keydown', 'F1'], ['keyup', 'F1']], `${surface}: function keys must reach the host`);
      await page.evaluate(() => { (window as any).__hostKeys = []; });
      await chord('k'); await chord('m');
      assert.deepEqual(await page.evaluate(() => (window as any).__hostKeys.map((event: any) => [event.type, event.key])),
        [['keydown', 'k'], ['keyup', 'k'], ['keydown', 'm'], ['keyup', 'm']], `${surface}: host chords must retain both strokes`);
      await page.evaluate(() => { (window as any).__hostKeys = []; });
      await page.keyboard.down('Control'); await page.keyboard.down('Alt');
      try { await page.keyboard.down('p'); await page.keyboard.down('p'); await page.keyboard.up('p'); }
      finally { await page.keyboard.up('Alt'); await page.keyboard.up('Control'); }
      assert.deepEqual(await page.evaluate(() => (window as any).__hostKeys.map((event: any) => [event.type, event.repeat])),
        [['keydown', false], ['keydown', true], ['keyup', false]], `${surface}: repeats must not duplicate keyup`);
      await page.evaluate(() => { (window as any).__hostKeys = []; });
      await focusBody();
      await chord('f');
      await page.waitForSelector('.find-panel.is-visible', { timeout: 3000 });
      await page.click('.find-close-button');
      await page.evaluate(() => {
        const global = window as any;
        global.__shortcutPreferences = { ...global.__shortcutPreferences,
          shortcuts: { preview: ['Ctrl + Alt + V'], find: ['Ctrl + Alt + F'], saveAs: ['Ctrl + Alt + S'] } };
        window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'editingPreferencesChanged', preferences: global.__shortcutPreferences, revision: 1
        } }));
      });
      await focusBody();
      await chord('f');
      assert.equal(await page.$('.find-panel.is-visible'), null, `${surface}: old Ctrl+F binding remained active`);
      await chord('f', true);
      await page.waitForSelector('.find-panel.is-visible', { timeout: 3000 });
      await page.click('.find-close-button');
      await focusBody();
      await chord('h');
      await page.waitForSelector('.find-panel.is-visible', { timeout: 3000 });
      assert.equal(await page.$eval('.find-replace-row .find-input', input => (input as HTMLInputElement).disabled), surface === 'full');
      await page.click('.find-close-button');
      await focusBody();
      await chord('s');
      await page.waitForFunction(() => (window as any).__shortcutMessages.some((message: any) => message.type === 'saveDocumentRevision'), { timeout: 3000 });
      const saves = await page.evaluate(() => (window as any).__shortcutMessages.filter((message: any) => message.type === 'saveDocumentRevision'));
      assert.equal(saves.length, 1, `${surface}: Save must dispatch exactly once`);
      assert.equal(saves[0].revision.text, editedText);
      assert.ok(!(await page.evaluate(() => (window as any).__hostKeys)).some((event: any) => event.key === 's'),
        `${surface}: handled MEO Save must not also reach the host`);
      await page.evaluate(() => { (window as any).__hostKeys = []; });
      await focusBody();
      await chord('s', true);
      await page.waitForFunction(() => (window as any).__shortcutMessages.some((message: any) => message.type === 'saveDocumentAs'), { timeout: 3000 });
      const saveAsRequests = await page.evaluate(() => (window as any).__shortcutMessages.filter((message: any) => message.type === 'saveDocumentAs'));
      assert.equal(saveAsRequests.length, 1, `${surface}: Save As must dispatch exactly once`);
      assert.equal(saveAsRequests[0].text, editedText);
      assert.ok(!(await page.evaluate(() => (window as any).__hostKeys)).some((event: any) => event.key === 's'),
        `${surface}: handled MEO Save As must not also reach the host`);
      await page.evaluate(() => { (window as any).__hostKeys = []; });
      await chord('a');
      assert.ok(await frame.evaluate(() => (getSelection()?.toString().length ?? 0) > 0), `${surface}: native Preview selection was stolen`);
      await chord('c');
      await chord('z');
      assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView
        .findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString()), editedText,
      `${surface}: Preview undo modified the other editor`);
      const untouched = await frame.evaluate(() => {
        const results: boolean[] = [];
        for (const key of ['c', 'a', 'z', 'ArrowDown']) {
          const event = new KeyboardEvent('keydown', { key, ctrlKey: key !== 'ArrowDown', bubbles: true, cancelable: true });
          document.body.dispatchEvent(event);
          results.push(event.defaultPrevented);
        }
        const composition = new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, altKey: true, isComposing: true, bubbles: true, cancelable: true });
        document.body.dispatchEvent(composition);
        results.push(composition.defaultPrevented);
        const editable = document.createElement('div');
        editable.contentEditable = 'true';
        const child = document.createElement('span');
        editable.append(child);
        const input = document.createElement('input');
        const textarea = document.createElement('textarea');
        document.body.append(input, textarea, editable);
        for (const target of [input, textarea, child]) {
          const inputShortcut = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
          target.dispatchEvent(inputShortcut);
          results.push(inputShortcut.defaultPrevented);
        }
        input.remove(); textarea.remove(); editable.remove();
        return results;
      });
      assert.ok(untouched.every(prevented => !prevented), `${surface}: native/input/IME keys were intercepted: ${untouched}`);
      assert.deepEqual(await page.evaluate(() => (window as any).__hostKeys), [],
        `${surface}: native reading and synthetic input must not reach the host`);
      assert.equal(await page.$('.find-panel.is-visible'), null);
      if (surface === 'full') {
        // Clicking a reading margin must work just like clicking the actual text.
        await focusBody();
        const margin = await frame.evaluate(() => ({ x: 5, y: document.getElementById('reading')!.getBoundingClientRect().top + 12 }));
        const bounds = await page.$eval('.preview-frame', element => ({ x: element.getBoundingClientRect().left, y: element.getBoundingClientRect().top }));
        await page.mouse.click(bounds.x + margin.x, bounds.y + margin.y);
        await chord('v', true);
        await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live', { timeout: 3000 });
        await page.click('[data-mode="preview"]');
        await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden === true);
        await new Promise(resolve => setTimeout(resolve, 250));
        await focusBody();
        await page.evaluate(() => { (window as any).__hostKeys = []; });
        await chord('p', true);
        assert.equal(await page.evaluate(() => (window as any).__hostKeys.length), 2,
          're-entering Preview must not duplicate its host keyboard listeners');
        await chord('v', true);
        await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live', { timeout: 3000 });
        const previousScroll = await page.$eval('.cm-scroller', element => element.scrollTop);
        await page.click('[data-mode="preview"]');
        await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden === true);
        await new Promise(resolve => setTimeout(resolve, 250));
        await page.evaluate(() => {
          const global = window as any;
          global.__shortcutPreferences = global.EditingSettingsHarness.changeEditingPreferences(
            global.__shortcutPreferences,
            { type: 'bind', command: 'preview', keys: ['Ctrl + Enter'], replaceConflicts: true }, 'other'
          );
          window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'editingPreferencesChanged', preferences: global.__shortcutPreferences, revision: 2
          } }));
        });
        await frame.focus('a[data-meo-preview-href="#destination"]');
        await chord('Enter');
        await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live'
          && document.querySelector<HTMLElement>('.preview-host')?.hidden === true, { timeout: 3000 });
        assert.ok(Math.abs(await page.$eval('.cm-scroller', element => element.scrollTop) - previousScroll) <= 1,
          'a handled global Enter shortcut must not also activate the focused fragment link');
      } else {
        await focusBody();
        await page.keyboard.down('Alt'); await page.keyboard.down('Shift');
        try { await page.keyboard.press('m'); }
        finally { await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); }
        await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live', { timeout: 3000 });
      }
      console.log(`PASS ${surface} Preview: current bindings, find/replace/save/save-as/mode, native selection and isolated editor history`);
    } finally {
      await page.close();
    }
  }
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (primaryError !== undefined) await closeTestBrowser(browser, primaryError);
  else await closeTestBrowser(browser);
}
console.log('Preview production shortcut checks passed');
