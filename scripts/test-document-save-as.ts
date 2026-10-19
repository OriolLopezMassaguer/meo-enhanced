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
let targetEditorActive = true;
let beforePreparedSave = () => undefined;
let reportSavedDocument = true;
let uriSaveCount = 0;
class TabInputText { constructor(readonly uri: URI) {} }
class TabInputCustom { constructor(readonly uri: URI, readonly viewType: string) {} }
type TestTab = { input: TabInputText | TabInputCustom; group: TestGroup };
type TestGroup = { viewColumn: number; tabs: TestTab[]; activeTab?: TestTab };
const tabGroups = { all: [] as TestGroup[], activeTabGroup: null as unknown as TestGroup };
const savedListeners = new Set<(document: { uri: URI }) => void>();
const willSaveListeners = new Set<(event: { document: { uri: URI }; reason: number }) => void>();
const saveTargets: TestTab[] = [];
function resetTabs(separateGroups = false) {
  const nativeGroup: TestGroup = { viewColumn: 1, tabs: [] };
  const meoGroup: TestGroup = separateGroups ? { viewColumn: 2, tabs: [] } : nativeGroup;
  const native = { input: new TabInputText(source), group: nativeGroup };
  const meo = { input: new TabInputCustom(source, 'meoEnhanced.editor'), group: meoGroup };
  nativeGroup.tabs.push(native); nativeGroup.activeTab = native;
  meoGroup.tabs.push(meo); meoGroup.activeTab = meo;
  tabGroups.all = separateGroups ? [nativeGroup, meoGroup] : [meoGroup];
  tabGroups.activeTabGroup = meoGroup;
  targetEditorActive = true;
  return { native, meo, meoGroup };
}
async function nativeSave(tab: TestTab) {
  saveCount += 1;
  saveTargets.push(tab);
  tabGroups.activeTabGroup = tab.group;
  tab.group.activeTab = tab;
  await gate;
  if (saveFailure) throw new Error('save refused');
  if (selected) {
    if (reportSavedDocument) {
      for (const listener of willSaveListeners) listener({ document: { uri: selected }, reason: 1 });
      for (const listener of savedListeners) listener({ uri: selected });
    }
    if (selected.toString() !== source.toString()) {
      const replacement = { input: new TabInputText(selected), group: tab.group };
      tab.group.tabs.splice(tab.group.tabs.indexOf(tab), 1, replacement);
      tab.group.activeTab = replacement;
    }
  }
  onNativeSave();
  return selected;
}
resetTabs();
const opened: unknown[][] = [];
const warnings: { message: string; actions: string[] }[] = [];
let warningChoice: ((actions: string[]) => string | undefined) | undefined;
mock.module('vscode', () => ({
  TabInputText, TabInputCustom, TextDocumentSaveReason: { Manual: 1, AfterDelay: 2 },
  workspace: { async saveAs(uri: URI) {
    // Mirror VS Code's URI-based lookup: two editor types share this resource.
    uriSaveCount += 1;
    const tab = tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input.uri.toString() === uri.toString());
    return tab ? nativeSave(tab) : undefined;
  }, onWillSaveTextDocument(listener: (event: { document: { uri: URI }; reason: number }) => void) {
    willSaveListeners.add(listener);
    return { dispose: () => willSaveListeners.delete(listener) };
  }, onDidSaveTextDocument(listener: (document: { uri: URI }) => void) {
    savedListeners.add(listener);
    return { dispose: () => savedListeners.delete(listener) };
  } },
  commands: { async executeCommand(...args: unknown[]) {
    if (args[0] === 'workbench.action.files.saveAs') {
      assert.equal(args.length, 1, 'Save As must use the guarded active editor, without a URI lookup');
      const tab = tabGroups.activeTabGroup.activeTab;
      if (tab) await nativeSave(tab);
      return; // The native command does not return a destination URI.
    }
    if (openFailure) throw new Error('open refused');
    opened.push(args);
  } },
  window: { tabGroups, async showWarningMessage(message: string, ...actions: string[]) {
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
  isTargetEditorActive: () => targetEditorActive,
  runPreparedSave: async save => { preparations += 1; beforePreparedSave(); return save(); },
  onFailure: message => failures.push(message)
});
const request = (requestId: string, snapshot = text) => ({ type: 'saveDocumentAs' as const, requestId, text: snapshot });
const viewState = { mode: 'live' as const, position: { line: 25, lineOffset: 8 }, selection: { anchor: 3, head: 7 } };
const handle = (adapter: ReturnType<typeof createAdapter>, requestId: string, snapshot = text) => {
  resetTabs();
  return adapter.handle(request(requestId, snapshot));
};
assert.deepEqual(decodeWebviewToHostMessage(request('save-as')), request('save-as'));
assert.equal(decodeWebviewToHostMessage({ type: 'saveDocumentAs', requestId: '', text }), null);
assert.equal(decodeWebviewToHostMessage({ type: 'saveDocumentAs', requestId: 'id' }), null);
assert.deepEqual(decodeWebviewToHostMessage({ ...request('view-state'), viewState }), { ...request('view-state'), viewState });
assert.equal(decodeWebviewToHostMessage({ ...request('bad-view-state'), viewState: { ...viewState, selection: { anchor: -1, head: 0 } } }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'documentSaveAsResult', requestId: 'id', result: { ok: true, value: { status: 'bad' } } }), null);

const adapter = createAdapter();
assert.deepEqual((await handle(adapter, 'one')).result, { ok: true, value: { status: 'saved' } });
assert.deepEqual(opened.at(-1), ['vscode.openWith', target, 'meoEnhanced.editor', { preview: false }]);
await handle(adapter, 'one');
assert.equal(saveCount, 1, 'duplicate requests must not open another native dialog');
assert.equal(preparations, 1);
selected = undefined;
const openCount = opened.length;
assert.deepEqual((await handle(adapter, 'cancel')).result, { ok: true, value: { status: 'not-completed' } });
assert.equal(opened.length, openCount);
assert.equal(warnings.length, 0, 'an ambiguous native result must not turn cancellation into an error');
assert.equal(decodeHostToWebviewMessage({ type: 'documentSaveAsResult', requestId: 'old', result: { ok: true, value: { status: 'cancelled' } } }), null);
const beforeStale = saveCount;
assert.equal((await handle(adapter, 'stale', 'obsolete')).result.ok, false);
assert.equal(saveCount, beforeStale, 'an unaccepted snapshot must not reach native Save As');
selected = URI.parse('vscode-remote://ssh-remote+fixture/notes/new.mdc');
assert.equal((await handle(adapter, 'remote')).result.ok, true);
assert.equal(opened.at(-1)?.[1], selected, 'remote URI scheme and authority must survive reopening');
selected = URI.parse('file:///notes/plain.txt');
const beforeOtherFile = opened.length;
assert.equal((await handle(adapter, 'other-file')).result.ok, true);
assert.equal(opened.length, beforeOtherFile, 'other extensions retain the native Save As editor choice');
text = '';
assert.equal((await handle(adapter, 'empty')).result.ok, true);
text = '# current draft';
saveFailure = true;
const failed = await handle(adapter, 'failed');
assert.equal(failed.result.ok, false);
if (!failed.result.ok) assert.match(failed.result.error.message, /save refused/);
assert.equal(failures.length, 0, 'the live Webview owns errors without a duplicate native notification');
saveFailure = false;
selected = target;
let release!: () => void;
gate = new Promise(resolve => { release = resolve; });
const pending = handle(adapter, 'pending');
assert.equal((await adapter.handle(request('second'))).result.ok, false);
release(); await pending; gate = undefined;
adapter.dispose();
assert.equal((await adapter.handle(request('closed'))).result.ok, false);
const replacing = createAdapter();
onNativeSave = () => replacing.dispose();
assert.equal((await handle(replacing, 'native-replacement')).result.ok, true,
  'native Save As may dispose the old editor before returning its new resource');
assert.equal(opened.at(-1)?.[1], target);
onNativeSave = () => undefined;
const failingOpen = createAdapter();
openFailure = true;
assert.deepEqual((await handle(failingOpen, 'open-failed')).result, { ok: true, value: { status: 'saved' } });
assert.match(warnings.at(-1)!.message, /saved.*open refused/i, 'report a written file separately from a failed editor open');
assert.ok(warnings.at(-1)!.message.includes(target.fsPath));
const beforeRecovery = saveCount;
warningChoice = actions => { openFailure = false; return actions[0]; };
openFailure = true;
await handle(failingOpen, 'retry-open');
assert.deepEqual(opened.at(-1), ['vscode.openWith', target, 'meoEnhanced.editor', { preview: false }]);
assert.equal(saveCount, beforeRecovery + 1, 'opening recovery must never repeat Save As');
warningChoice = actions => { openFailure = false; return actions[1]; };
openFailure = true;
await handle(failingOpen, 'use-text-editor');
assert.deepEqual(opened.at(-1), ['vscode.openWith', target, 'default', { preview: false }]);
warningChoice = undefined;
openFailure = false; failingOpen.dispose();
const replacedOpenFailure = createAdapter();
onNativeSave = () => replacedOpenFailure.dispose();
warningChoice = actions => { openFailure = false; return actions[0]; };
openFailure = true;
assert.deepEqual((await handle(replacedOpenFailure, 'replaced-open-failed')).result,
  { ok: true, value: { status: 'saved' } });
assert.deepEqual(opened.at(-1), ['vscode.openWith', target, 'meoEnhanced.editor', { preview: false }]);
onNativeSave = () => undefined; warningChoice = undefined;
const closing = createAdapter();
gate = new Promise(resolve => { release = resolve; });
saveFailure = true;
const closeFailure = handle(closing, 'closed-during-save');
closing.dispose(); release(); await closeFailure;
assert.match(failures.at(-1)!, /save refused/, 'a closed Webview must still get native failure feedback');
gate = undefined; saveFailure = false;

for (const separateGroups of [false, true]) {
  const focusAdapter = createAdapter();
  for (const destination of [undefined, target, source]) {
    const { native, meo, meoGroup } = resetTabs(separateGroups);
    selected = destination;
    const before = saveCount;
    const result = await focusAdapter.handle(request(`focus-${separateGroups}-${destination?.path}`));
    assert.equal(result.result.ok, true);
    assert.equal(saveCount, before + 1, 'two views of the same file must still show only one Save As dialog');
    assert.equal(saveTargets.at(-1), meo, 'the dialog must belong to the initiating MEO tab');
    assert.ok(native.group.tabs.includes(native), 'the original native tab must not be replaced');
    assert.equal(native.input.uri, source);
    if (!destination) {
      assert.equal(meoGroup.activeTab, meo, 'cancellation must leave the initiating MEO tab active');
      assert.deepEqual(result.result, { ok: true, value: { status: 'not-completed' } });
    } else {
      assert.deepEqual(result.result, { ok: true, value: { status: 'saved' } });
      assert.equal(opened.at(-1)?.[1], destination);
    }
  }
  focusAdapter.dispose();
}
assert.equal(uriSaveCount, 0, 'URI-only Save As cannot distinguish native and custom editors');

const guarded = createAdapter();
for (const scenario of ['inactive-panel', 'native-tab', 'different-document', 'different-custom-editor', 'preparation-focus-change']) {
  const { native, meo, meoGroup } = resetTabs();
  if (scenario === 'inactive-panel') targetEditorActive = false;
  if (scenario === 'native-tab') meoGroup.activeTab = native;
  if (scenario === 'different-document') meo.input = new TabInputCustom(target, 'meoEnhanced.editor');
  if (scenario === 'different-custom-editor') meo.input = new TabInputCustom(source, 'other.editor');
  if (scenario === 'preparation-focus-change') beforePreparedSave = () => { meoGroup.activeTab = native; };
  const before = saveCount;
  const result = await guarded.handle(request(scenario));
  assert.equal(result.result.ok, false, `${scenario} must reject a request that no longer owns the active MEO tab`);
  assert.equal(saveCount, before, 'a stale request must not save another editor');
  beforePreparedSave = () => undefined;
}

resetTabs(); selected = undefined;
const beforeUnrelated = opened.length;
onNativeSave = () => {
  for (const listener of willSaveListeners) listener({ document: { uri: target }, reason: 1 });
  for (const listener of savedListeners) listener({ uri: target });
  const unrelated = { input: new TabInputText(target), group: tabGroups.activeTabGroup };
  unrelated.group.tabs.push(unrelated);
  unrelated.group.activeTab = unrelated;
};
assert.deepEqual((await guarded.handle(request('unrelated-save'))).result,
  { ok: true, value: { status: 'not-completed' } }, 'an unrelated save must not turn cancellation into success');
assert.equal(opened.length, beforeUnrelated, 'cancellation must not reopen an unrelated document');
onNativeSave = () => undefined;

resetTabs(); selected = undefined;
onNativeSave = () => {
  for (const listener of willSaveListeners) listener({ document: { uri: source }, reason: 2 });
  for (const listener of savedListeners) listener({ uri: source });
};
assert.deepEqual((await guarded.handle(request('auto-save-during-dialog'))).result,
  { ok: true, value: { status: 'not-completed' } }, 'source auto-save while the dialog is open must not turn cancellation into success');
assert.equal(opened.length, beforeUnrelated);
onNativeSave = () => undefined;

resetTabs(); selected = target; reportSavedDocument = false;
assert.deepEqual((await guarded.handle(request('unconfirmed-replacement'))).result,
  { ok: true, value: { status: 'not-completed' } }, 'a tab change without a native save receipt must not claim a saved file');
reportSavedDocument = true;
guarded.dispose();
assert.equal(savedListeners.size, 0, 'save listeners must not outlive completion, cancellation or failure');
assert.equal(willSaveListeners.size, 0, 'will-save listeners must not outlive the operation');

const posted: ReturnType<typeof request>[] = [];
const steps: string[] = [];
const transport = createDocumentSaveAsTransport({
  getUiLanguage: () => 'en',
  commitTransientEdits: () => { steps.push('commit'); text = '# confirmed cell'; },
  whenDocumentIdle: async () => { steps.push('idle'); },
  getCurrentText: () => { steps.push('read'); return text; },
  getViewState: () => { steps.push('view'); return viewState; },
  postMessage: message => posted.push(message)
});
const transported = transport.save();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
assert.deepEqual(steps, ['commit', 'idle', 'read', 'idle', 'view']);
assert.equal(posted[0]?.text, '# confirmed cell');
assert.deepEqual((posted[0] as typeof posted[0] & { viewState: unknown }).viewState, viewState);
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
console.log('Save As protocol, snapshots, same-file native/MEO tabs and split groups, active-editor guards, native replacement, cancellation, failures and idempotence passed');
