import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchTestBrowser } from './browser-test-helpers';
import runtime from '../src/export/runtime';

const build = await Bun.build({ entrypoints: ['scripts/test-settings-window-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const browser = await launchTestBrowser();
const original = '# Toolbar\n\nEditable paragraph.\n\n| Header |\n| --- |\n| Cell |';
const directory = 'tmp/document-toolbar';
mkdirSync(directory, { recursive: true });
try {
  for (const theme of ['light', 'dark']) {
    for (const language of ['en', 'zh-CN']) {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.setViewport({ width: 1200, height: 760 });
      await page.setContent(`<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-${theme}"><div id="app"></div></body>`);
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.addStyleTag({ content: `:root{--vscode-font-family:Arial;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-background:${theme === 'dark' ? '#202124' : '#ffffff'};--vscode-editor-foreground:${theme === 'dark' ? '#dddddd' : '#222222'};--vscode-foreground:${theme === 'dark' ? '#dddddd' : '#222222'};--vscode-editorWidget-background:${theme === 'dark' ? '#28292c' : '#f3f3f3'}}` });
      await page.exposeFunction('__toolbarHost', (message: any) => {
        if (message.type === 'applyChanges') return { type: 'applied', version: message.baseVersion + 1 };
        if (message.type === 'saveDocumentCopy') return { type: 'documentCopyResult', requestId: message.requestId, result: { ok: true, value: { status: 'saved' } } };
        if (message.type !== 'requestPreviewRender') return null;
        return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value: runtime.renderPreviewDocument({
          markdownText: message.text, sourceDocumentPath: 'C:/notes/toolbar.md', uiLanguage: language as 'en' | 'zh-CN',
          styleEnvironment: message.environment, preset: message.preset
        }) } };
      });
      await page.addScriptTag({ content: `window.__toolbarMessages=[];window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__toolbarMessages.push(message);window.__toolbarHost(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
      await page.addScriptTag({ content: bundle });
      await page.evaluate(({ original, theme, language }) => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', documentId: 'file:///notes/toolbar.md', text: original, version: 1, savedRevision: { version: 1, text: original },
        diagnostics: [], mode: 'source', uiLanguage: language, sourceLineNumbers: 'on', previewAppearance: theme,
        previewFontFamily: '', previewSourceColoring: false, previewShowComments: false, editorAppearance: theme,
        gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
        fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
        findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false,
        outlineWidth: 260, restoreReadingPositionOnOpen: false, vscodeTheme: null
      } })), { original, theme, language });
      await page.waitForFunction(() => !document.querySelector('.meo-preload-toolbar') && !!document.querySelector('.cm-editor')
        && !document.querySelector<HTMLButtonElement>('[data-action="saveAs"]')?.disabled);
      const read = () => page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.doc.toString());
      const edit = (insert: string) => page.evaluate(insert => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        view.dispatch({ changes: { from: view.state.doc.length, insert }, selection: { anchor: view.state.doc.length + insert.length } });
        view.focus();
      }, insert);
      assert.deepEqual(await page.$$eval('.format-group > button[data-action]', buttons => buttons.map(button => (button as HTMLElement).dataset.action).filter(action =>
        ['save', 'saveAs', 'undo', 'redo', 'discard'].includes(action!))), ['save', 'saveAs', 'undo', 'redo', 'discard']);
      assert.equal(await page.$eval('[data-action="undo"]', button => (button as HTMLButtonElement).disabled), true);
      assert.equal(await page.$eval('[data-action="redo"]', button => (button as HTMLButtonElement).disabled), true);
      assert.equal(await page.$eval('[data-action="saveAs"]', button => button.getAttribute('aria-label')), language === 'en' ? 'Save as…' : '另存为…');
      await page.click('[data-mode="live"]');
      await page.waitForSelector('textarea[data-table-col="0"]');
      await page.evaluate(() => {
        const input = document.querySelector<HTMLTextAreaElement>('textarea[data-table-col="0"]')!;
        input.focus(); input.value = 'First pending cell'; input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled);
      await page.click('[data-action="undo"]');
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-action="redo"]')!.disabled);
      assert.equal(await read(), original, 'pending cells must enable Undo even without earlier document history');
      for (const mode of ['source', 'live']) {
        await page.click(`[data-mode="${mode}"]`);
        await page.waitForFunction(mode => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === mode, {}, mode);
        const before = await read();
        await edit('\nNew history');
        await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled);
        await page.click('[data-action="undo"]');
        await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-action="redo"]')!.disabled);
        assert.equal(await read(), before);
        await page.click('[data-action="redo"]');
        await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled);
        assert.equal(await read(), before + '\nNew history');
      }
      await page.evaluate(() => {
        const content = document.querySelector('.editor-host > .cm-editor .cm-content')!;
        content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      });
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled);
      await page.evaluate(() => document.querySelector('.editor-host > .cm-editor .cm-content')!
        .dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled);
      await page.evaluate(() => {
        const content = document.querySelector('.editor-host > .cm-editor .cm-content')!;
        content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      });
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled);
      await page.evaluate(() => document.querySelector('.editor-host > .cm-editor .cm-content')!
        .dispatchEvent(new FocusEvent('blur')));
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled);
      await page.evaluate(() => document.querySelector('.editor-host > .cm-editor .cm-content')!
        .dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
      await page.evaluate(() => {
        const global = window as any;
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'editingPreferencesChanged', revision: 1,
          preferences: { input: global.EditingSettingsHarness.defaultInputAssistance, shortcuts: { undo: ['Ctrl + Alt + Z'], redo: ['Ctrl + Alt + Y'] } } } }));
      });
      assert.equal(await page.$eval('[data-action="undo"]', button => (button as HTMLElement).dataset.tooltipShortcut), 'Ctrl + Alt + Z');
      const beforeCell = await read();
      await page.evaluate(() => {
        const input = document.querySelector<HTMLTextAreaElement>('textarea[data-table-col="0"]')!;
        input.focus(); input.value = 'Pending cell'; input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.click('[data-action="undo"]');
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-action="redo"]')!.disabled);
      assert.equal(await read(), beforeCell, 'one toolbar undo must commit and undo the pending native cell');
      await page.evaluate(() => {
        const input = document.querySelector<HTMLTextAreaElement>('textarea[data-table-col="0"]')!;
        input.focus(); input.value = 'Save confirmed cell'; input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      for (const status of ['not-completed', 'error', 'saved', 'timeout']) {
        await page.evaluate(() => { (window as any).__toolbarMessages.length = 0; });
        await page.click('[data-action="saveAs"]');
        await page.waitForFunction(() => (window as any).__toolbarMessages.some((message: any) => message.type === 'saveDocumentAs'));
        const requests = await page.evaluate(() => (window as any).__toolbarMessages.filter((message: any) => message.type === 'saveDocumentAs'));
        assert.equal(requests.length, 1);
        assert.ok(requests[0].text.includes('Save confirmed cell'));
        assert.equal(await page.$eval('[data-action="saveAs"]', button => (button as HTMLButtonElement).disabled), true);
        assert.equal(await page.$eval('[data-action="saveAs"]', button => button.getAttribute('aria-busy')), 'true');
        await page.evaluate(({ requestId, status, language }) => window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'documentSaveAsResult', requestId, result: status === 'error' || status === 'timeout'
            ? { ok: false, error: { code: status === 'timeout' ? 'timeout' : 'operation-failed', message: status === 'timeout' ? 'Timed out' :
              (language === 'en' ? 'Pending editor changes have not reached the document. Try Save As again.' : '编辑内容尚未同步到文档，请重试另存为。') } }
            : { ok: true, value: { status } }
        } })), { requestId: requests[0].requestId, status, language });
        await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-action="saveAs"]')!.disabled);
        assert.equal(await page.$eval('[data-action="saveAs"]', button => button.getAttribute('aria-busy')), 'false');
        if (status === 'not-completed' || status === 'saved') {
          assert.equal(await page.$eval('.editor-notice', notice => (notice as HTMLElement).hidden), true);
        } else {
          await page.waitForSelector('.editor-notice.is-visible', { visible: true });
          assert.equal(await page.$eval('.editor-notice', notice => (notice as HTMLElement).dataset.kind), status === 'timeout' ? 'warning' : 'error');
          await page.screenshot({ path: `${directory}/save-as-${status}-${theme}-${language}.png`, clip: { x: 0, y: 0, width: 1200, height: 400 } });
          await page.setViewport({ width: 540, height: 760 });
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await page.screenshot({ path: `${directory}/save-as-${status}-${theme}-${language}-narrow.png`, clip: { x: 0, y: 0, width: 540, height: 260 } });
          await page.setViewport({ width: 1200, height: 760 });
        }
        if (status === 'error') {
          assert.equal(await page.$eval('.editor-notice-title', title => title.textContent), language === 'en' ? 'Save As failed' : '另存为失败');
          await edit('\nRetry with latest changes');
          await page.click('.editor-notice-action[data-action="retry-save-as"]');
          await page.waitForFunction(() => (window as any).__toolbarMessages.filter((message: any) => message.type === 'saveDocumentAs').length === 2);
          const retry = await page.evaluate(() => (window as any).__toolbarMessages.filter((message: any) => message.type === 'saveDocumentAs').at(-1));
          assert.notEqual(retry.requestId, requests[0].requestId);
          assert.equal(retry.text, await read(), 'retry must prepare the latest draft instead of reusing a failed snapshot');
          await page.evaluate(requestId => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'documentSaveAsResult', requestId, result: { ok: true, value: { status: 'saved' } }
          } })), retry.requestId);
          await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-action="saveAs"]')!.disabled);
        }
        if (status === 'timeout') {
          assert.equal(await page.$('.editor-notice-action[data-action="retry-save-as"]'), null,
            'an unknown in-flight save must not offer an immediate repeat-write action');
          assert.equal((await page.evaluate(() => (window as any).__toolbarMessages.filter((message: any) => message.type === 'saveDocumentAs'))).length, 1);
          await page.click('.editor-notice-close');
        }
      }
      for (const trigger of ['toolbar', 'keyboard']) {
        const beforeFailure = await read();
        await page.evaluate(() => {
          const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
          const dispatch = view.dispatch;
          view.focus();
          view.dispatch = (...args: any[]) => {
            if (args.some(transaction => transaction?.isUserEvent?.('undo') || transaction?.userEvent === 'undo')) {
              view.dispatch = dispatch;
              throw new Error('Injected native history failure');
            }
            return dispatch.apply(view, args);
          };
        });
        if (trigger === 'toolbar') await page.click('[data-action="undo"]');
        else {
          await page.keyboard.down('Control'); await page.keyboard.down('Alt');
          await page.keyboard.press('z');
          await page.keyboard.up('Alt'); await page.keyboard.up('Control');
        }
        await page.waitForFunction(language => document.querySelector('.editor-notice-title')?.textContent ===
          (language === 'zh-CN' ? '撤销或重做未能完成' : 'Undo/Redo could not finish'), {}, language);
        assert.equal(await read(), beforeFailure, 'a failed replay must not trigger an automatic second Undo');
        await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled);
        await page.screenshot({ path: `${directory}/history-error-${theme}-${language}-${trigger}.png`, clip: { x: 0, y: 0, width: 1200, height: 400 } });
        if (trigger === 'keyboard') {
          await page.setViewport({ width: 540, height: 760 });
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await page.screenshot({ path: `${directory}/history-error-${theme}-${language}-narrow.png`, clip: { x: 0, y: 0, width: 540, height: 260 } });
          await page.setViewport({ width: 1200, height: 760 });
        }
        const copyCount = await page.evaluate(() => (window as any).__toolbarMessages.filter((message: any) => message.type === 'saveDocumentCopy').length);
        await page.click('.editor-notice-action[data-action="save-copy"]');
        await page.waitForFunction(count => (window as any).__toolbarMessages.filter((message: any) => message.type === 'saveDocumentCopy').length === count + 1, {}, copyCount);
        const copy = await page.evaluate(() => (window as any).__toolbarMessages.filter((message: any) => message.type === 'saveDocumentCopy').at(-1));
        assert.equal(copy.text, beforeFailure);
        await page.click('.editor-notice-close');
      }
      await page.screenshot({ path: `${directory}/${theme}-${language}.png`, clip: { x: 0, y: 0, width: 1200, height: 80 } });
      const beforeOverflowUndo = await read();
      await page.click('[data-action="undo"]');
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-action="redo"]')!.disabled);
      await page.setViewport({ width: 540, height: 760 });
      await page.waitForSelector('#toolbar-overflow-panel [data-action="redo"]');
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.click('.toolbar-overflow-indicator');
      await page.waitForSelector('#toolbar-overflow-panel [data-action="redo"]', { visible: true });
      await page.click('#toolbar-overflow-panel [data-action="redo"]');
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled);
      assert.equal(await read(), beforeOverflowUndo, 'the moved overflow button must replay the same document history');
      await page.keyboard.press('Escape');
      await page.screenshot({ path: `${directory}/${theme}-${language}-narrow.png`, clip: { x: 0, y: 0, width: 540, height: 80 } });
      await page.setViewport({ width: 1200, height: 760 });
      await page.click('[data-mode="preview"]');
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'preview');
      assert.equal(await page.$eval('[data-action="undo"]', button => (button as HTMLButtonElement).disabled), true);
      assert.equal(await page.$eval('[data-action="redo"]', button => (button as HTMLButtonElement).disabled), true);
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  console.log('Document toolbar: button order, Live/Source history, native cells, Save As latest-draft retry, unknown outcomes, toolbar/keyboard failure recovery, Preview, bindings and bilingual/theme screenshots passed');
} finally { await browser.close(); }
