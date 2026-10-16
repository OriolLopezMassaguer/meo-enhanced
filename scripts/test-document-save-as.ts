import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { URI } from 'vscode-uri';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';

const source = URI.parse('file:///notes/original.md');
const target = URI.parse('file:///elsewhere/new.md');
let text = '# current draft';
let selected: URI | undefined = target;
let saveFailure = false;
let openFailure = false;
let saveCount = 0;
let gate: Promise<void> | undefined;
let onNativeSave = () => undefined;
const opened: unknown[][] = [];
const warnings: { message: string; actions: string[] }[] = [];
let warningChoice: ((actions: string[]) => string | undefined) | undefined;
mock.module('vscode', () => ({
  workspace: { async saveAs(uri: URI) {
    assert.equal(uri, source, 'native Save As must target this document, not the active native editor');
    saveCount += 1;
    await gate;
    if (saveFailure) throw new Error('save refused');
    onNativeSave();
    return selected;
  } },
  commands: { async executeCommand(...args: unknown[]) {
    if (openFailure) throw new Error('open refused');
    opened.push(args);
  } },
  window: { async showWarningMessage(message: string, ...actions: string[]) {
    warnings.push({ message, actions });
    return warningChoice?.(actions);
  } }
}));
const { createVscodeDocumentSaveAsAdapter } = await import('../src/host/vscodeDocumentSaveAsAdapter');
const { createDocumentSaveAsTransport } = await import('../webview/src/adapters/documentSaveAsTransport');
const failures: string[] = [];
let preparations = 0;
const createAdapter = () => createVscodeDocumentSaveAsAdapter({ uri: source, getText: () => text } as never, {
  getUiLanguage: () => 'en',
  markdownEditorViewType: 'meoEnhanced.editor',
  runPreparedSave: async save => { preparations += 1; return save(); },
  onFailure: message => failures.push(message)
});
const request = (requestId: string, snapshot = text) => ({ type: 'saveDocumentAs' as const, requestId, text: snapshot });
assert.deepEqual(decodeWebviewToHostMessage(request('save-as')), request('save-as'));
assert.equal(decodeWebviewToHostMessage({ type: 'saveDocumentAs', requestId: '', text }), null);
assert.equal(decodeWebviewToHostMessage({ type: 'saveDocumentAs', requestId: 'id' }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'documentSaveAsResult', requestId: 'id', result: { ok: true, value: { status: 'bad' } } }), null);

const adapter = createAdapter();
assert.deepEqual((await adapter.handle(request('one'))).result, { ok: true, value: { status: 'saved' } });
assert.deepEqual(opened.at(-1), ['vscode.openWith', target, 'meoEnhanced.editor', { preview: false }]);
await adapter.handle(request('one'));
assert.equal(saveCount, 1, 'duplicate requests must not open another native dialog');
assert.equal(preparations, 1);
selected = undefined;
const openCount = opened.length;
assert.deepEqual((await adapter.handle(request('cancel'))).result, { ok: true, value: { status: 'not-completed' } });
assert.equal(opened.length, openCount);
assert.equal(warnings.length, 0, 'an ambiguous native result must not turn cancellation into an error');
assert.equal(decodeHostToWebviewMessage({ type: 'documentSaveAsResult', requestId: 'old', result: { ok: true, value: { status: 'cancelled' } } }), null);
const beforeStale = saveCount;
assert.equal((await adapter.handle(request('stale', 'obsolete'))).result.ok, false);
assert.equal(saveCount, beforeStale, 'an unaccepted snapshot must not reach native Save As');
selected = URI.parse('vscode-remote://ssh-remote+fixture/notes/new.mdc');
assert.equal((await adapter.handle(request('remote'))).result.ok, true);
assert.equal(opened.at(-1)?.[1], selected, 'remote URI scheme and authority must survive reopening');
selected = URI.parse('file:///notes/plain.txt');
const beforeOtherFile = opened.length;
assert.equal((await adapter.handle(request('other-file'))).result.ok, true);
assert.equal(opened.length, beforeOtherFile, 'other extensions retain the native Save As editor choice');
text = '';
assert.equal((await adapter.handle(request('empty'))).result.ok, true);
text = '# current draft';
saveFailure = true;
const failed = await adapter.handle(request('failed'));
assert.equal(failed.result.ok, false);
if (!failed.result.ok) assert.match(failed.result.error.message, /save refused/);
assert.equal(failures.length, 0, 'the live Webview owns errors without a duplicate native notification');
saveFailure = false;
selected = target;
let release!: () => void;
gate = new Promise(resolve => { release = resolve; });
const pending = adapter.handle(request('pending'));
assert.equal((await adapter.handle(request('second'))).result.ok, false);
release(); await pending; gate = undefined;
adapter.dispose();
assert.equal((await adapter.handle(request('closed'))).result.ok, false);
const replacing = createAdapter();
onNativeSave = () => replacing.dispose();
assert.equal((await replacing.handle(request('native-replacement'))).result.ok, true,
  'native Save As may dispose the old editor before returning its new resource');
assert.equal(opened.at(-1)?.[1], target);
onNativeSave = () => undefined;
const failingOpen = createAdapter();
openFailure = true;
assert.deepEqual((await failingOpen.handle(request('open-failed'))).result, { ok: true, value: { status: 'saved' } });
assert.match(warnings.at(-1)!.message, /saved.*open refused/i, 'report a written file separately from a failed editor open');
assert.ok(warnings.at(-1)!.message.includes(target.fsPath));
const beforeRecovery = saveCount;
warningChoice = actions => { openFailure = false; return actions[0]; };
openFailure = true;
await failingOpen.handle(request('retry-open'));
assert.deepEqual(opened.at(-1), ['vscode.openWith', target, 'meoEnhanced.editor', { preview: false }]);
assert.equal(saveCount, beforeRecovery + 1, 'opening recovery must never repeat Save As');
warningChoice = actions => { openFailure = false; return actions[1]; };
openFailure = true;
await failingOpen.handle(request('use-text-editor'));
assert.deepEqual(opened.at(-1), ['vscode.openWith', target, 'default', { preview: false }]);
warningChoice = undefined;
openFailure = false; failingOpen.dispose();
const replacedOpenFailure = createAdapter();
onNativeSave = () => replacedOpenFailure.dispose();
warningChoice = actions => { openFailure = false; return actions[0]; };
openFailure = true;
assert.deepEqual((await replacedOpenFailure.handle(request('replaced-open-failed'))).result,
  { ok: true, value: { status: 'saved' } });
assert.deepEqual(opened.at(-1), ['vscode.openWith', target, 'meoEnhanced.editor', { preview: false }]);
onNativeSave = () => undefined; warningChoice = undefined;
const closing = createAdapter();
gate = new Promise(resolve => { release = resolve; });
saveFailure = true;
const closeFailure = closing.handle(request('closed-during-save'));
closing.dispose(); release(); await closeFailure;
assert.match(failures.at(-1)!, /save refused/, 'a closed Webview must still get native failure feedback');
gate = undefined; saveFailure = false;

const posted: ReturnType<typeof request>[] = [];
const steps: string[] = [];
const transport = createDocumentSaveAsTransport({
  getUiLanguage: () => 'en',
  commitTransientEdits: () => { steps.push('commit'); text = '# confirmed cell'; },
  whenDocumentIdle: async () => { steps.push('idle'); },
  getCurrentText: () => { steps.push('read'); return text; },
  postMessage: message => posted.push(message)
});
const transported = transport.save();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
assert.deepEqual(steps, ['commit', 'idle', 'read', 'idle']);
assert.equal(posted[0]?.text, '# confirmed cell');
assert.equal(transport.accept({ type: 'documentSaveAsResult', requestId: 'stale', result: { ok: true, value: { status: 'saved' } } }), false);
const response = { type: 'documentSaveAsResult' as const, requestId: posted[0].requestId, result: { ok: true as const, value: { status: 'not-completed' as const } } };
assert.deepEqual(decodeHostToWebviewMessage(response), response);
assert.equal(transport.accept(response), true);
assert.deepEqual(await transported, response.result);
transport.dispose();
assert.equal((await transport.save()).ok, false);
let releaseIdle!: () => void;
let readsAfterClose = 0;
const lateTransport = createDocumentSaveAsTransport({
  getUiLanguage: () => 'en', commitTransientEdits: () => undefined,
  whenDocumentIdle: () => new Promise(resolve => { releaseIdle = resolve; }),
  getCurrentText: () => { readsAfterClose += 1; return text; }, postMessage: () => { throw new Error('must not post'); }
});
const late = lateTransport.save();
lateTransport.dispose(); releaseIdle();
assert.equal((await late).ok, false);
assert.equal(readsAfterClose, 0, 'a closed editor must not be read after its idle barrier');
let expire!: () => void;
const timeoutTransport = createDocumentSaveAsTransport({
  getUiLanguage: () => 'en', commitTransientEdits: () => undefined, whenDocumentIdle: async () => undefined,
  getCurrentText: () => text, postMessage: () => undefined
}, { scheduleTimeout: callback => { expire = callback; return 1; }, cancelTimeout: () => undefined });
const timedOut = timeoutTransport.save();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
expire();
const timedOutResult = await timedOut;
assert.equal(timedOutResult.ok, false);
if (!timedOutResult.ok) assert.equal(timedOutResult.error.code, 'timeout');
assert.equal(timeoutTransport.accept({ type: 'documentSaveAsResult', requestId: 'document-save-as-0', result: { ok: true, value: { status: 'saved' } } }), false);
timeoutTransport.dispose();
console.log('Save As protocol, snapshot preparation, native document replacement, cancellation, failures and idempotence passed');
