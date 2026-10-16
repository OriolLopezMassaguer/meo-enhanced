import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'bun:test';
import { URI, Utils } from 'vscode-uri';
import { collectWikiReferences, parseWikiReference, wikiImageSrc } from '../src/foundation/wikiReference';
import runtime from '../src/export/runtime';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-wiki-'));
const vault = path.join(directory, 'vault');
const otherVault = path.join(directory, 'other');
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function write(relative: string, content: string | Uint8Array = bytes) {
  const file = path.join(vault, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return URI.file(file);
}
fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
fs.mkdirSync(otherVault, { recursive: true });
const document = write('notes/note.md', '# Note');
const image = write('assets/图片 50%🖼️.png');
const percentImage = write('assets/字面%E8%AE%BE.png');
const localImage = write('notes/assets/图片 50%🖼️.png', Buffer.from('local fixture'));
write('notes/other.md', '# Other');
write('assets/a/same.png');
write('assets/b/same.png');
fs.writeFileSync(path.join(otherVault, 'same.png'), bytes);

const watchers: Array<{ disposed: boolean; handlers: Record<string, ((uri: URI) => void)[]> }> = [];
const searches: string[] = [];
const opened: string[] = [];
const openRoutes: Array<{ command: string; editor: unknown }> = [];
const warnings: string[] = [];
let overflow = false;
let workspaceEnabled = true;
mock.module('vscode', () => ({
  Uri: { file: URI.file, parse: URI.parse, joinPath: Utils.joinPath },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  env: { language: 'zh-cn' },
  RelativePattern: class { constructor(readonly baseUri: URI, readonly pattern: string) {} },
  CancellationTokenSource: class {
    private cancellationState = { isCancellationRequested: false };
    get token() { return this.cancellationState; }
    cancel() { this.cancellationState.isCancellationRequested = true; }
    dispose() {}
  },
  commands: { executeCommand: async (command: string, uri: URI, editor: unknown) => {
    opened.push(uri.toString()); openRoutes.push({ command, editor });
  } },
  window: { showWarningMessage: (message: string) => { warnings.push(message); } },
  workspace: {
    getWorkspaceFolder: (uri: URI) => workspaceEnabled ? ({ uri: URI.file(uri.fsPath.toLowerCase().startsWith(otherVault.toLowerCase()) ? otherVault : directory) }) : undefined,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    fs: {
      stat: async (uri: URI) => { const info = fs.statSync(uri.fsPath); return { type: info.isDirectory() ? 2 : 1 }; },
      readFile: async (uri: URI) => fs.readFileSync(uri.fsPath),
      readDirectory: async (uri: URI) => fs.readdirSync(uri.fsPath, { withFileTypes: true }).map(entry => [entry.name, entry.isDirectory() ? 2 : 1])
    },
    findFiles: async (pattern: { baseUri: URI }) => {
      searches.push(pattern.baseUri.fsPath);
      if (overflow) return Array.from({ length: 50_001 }, () => image);
      const files: URI[] = [];
      const visit = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          if (['.obsidian', '.git', 'node_modules', 'dist', '.cache'].includes(entry.name)) continue;
          const file = path.join(current, entry.name);
          if (entry.isDirectory()) visit(file); else files.push(URI.file(file));
        }
      };
      visit(pattern.baseUri.fsPath);
      return files;
    },
    createFileSystemWatcher: () => {
      const watcher = { disposed: false, handlers: { create: [] as ((uri: URI) => void)[], delete: [] as ((uri: URI) => void)[], change: [] as ((uri: URI) => void)[] },
        onDidCreate(callback: (uri: URI) => void) { this.handlers.create.push(callback); },
        onDidDelete(callback: (uri: URI) => void) { this.handlers.delete.push(callback); },
        onDidChange(callback: (uri: URI) => void) { this.handlers.change.push(callback); },
        dispose() { this.disposed = true; }
      };
      watchers.push(watcher); return watcher;
    }
  }
}));
const { resolveWikiResource, resolveDocumentWikiResources, onDidChangeWikiResources, disposeWikiResources } = await import('../src/host/wikiResources');
const { resolveWebviewImageSrc, resolveLocalLinkTargetUri, openLink } = await import('../src/shared/documentLinks');
const webview = { options: { localResourceRoots: [] }, asWebviewUri: (uri: URI) => uri };
try {
  assert.equal(parseWikiReference('![[图片.png|300x200]]')?.height, 200);
  assert.equal(parseWikiReference('![[图片.png\\|300]]')?.width, 300);
  assert.equal(parseWikiReference('![[图片.png|0]]')?.width, undefined);
  assert.equal(parseWikiReference('![[nested.png]](normal.png)'), null);
  assert.equal(parseWikiReference('[[label]](normal.md)'), null);
  assert.deepEqual(collectWikiReferences('<code>![[literal.png]]</code> <kbd>[[literal]]</kbd>'), []);
  const source = '[[notes/other|说明]]\n\n![[assets/图片 50%🖼️.png|300]]\n\n`![[hidden.png]]`\n\n```md\n[[hidden]]\n```\n\n\\[[escaped]]';
  assert.deepEqual(collectWikiReferences(source).map(reference => reference.target), ['notes/other', 'assets/图片 50%🖼️.png']);
  assert.equal((await resolveWikiResource('assets/图片 50%🖼️.png', document as never)).uri?.toString(), image.toString());
  assert.equal((await resolveWikiResource('./assets/图片 50%🖼️.png', document as never)).uri?.toString(), localImage.toString());
  assert.equal((await resolveLocalLinkTargetUri('assets/图片%2050%25🖼️.png', document as never))?.toString(), localImage.toString(), 'standard Markdown remains relative to its document');
  for (const target of ['图片 50%🖼️.png', '字面%E8%AE%BE.png', 'a/same.png', '../assets/字面%E8%AE%BE.png', percentImage.toString()]) {
    const resolved = await resolveWikiResource(target, document as never);
    if (target === '图片 50%🖼️.png') assert.equal(resolved.candidates?.length, 2, 'bare duplicate names cannot choose silently');
    else assert.ok(resolved.uri, `target must resolve: ${target}`);
  }
  // Only drive-qualified native paths are absolute Wiki targets; /... is vault-root syntax.
  if (process.platform === 'win32') {
    assert.equal((await resolveWikiResource(percentImage.fsPath, document as never)).uri?.toString(), percentImage.toString());
  }
  assert.equal((await resolveWikiResource('/assets/字面%E8%AE%BE.png', document as never)).uri?.toString(), percentImage.toString());
  const ambiguous = await resolveWikiResource('same.png', document as never);
  assert.deepEqual(ambiguous.candidates, ['assets/a/same.png', 'assets/b/same.png']);
  assert.ok(searches.every(root => root.toLowerCase() === vault.toLowerCase()), 'lookup must not enter another workspace/vault');
  const count = searches.length;
  await resolveWikiResource('字面%E8%AE%BE.png', document as never);
  assert.equal(searches.length, count, 'index is reused');
  const otherDocument = URI.file(path.join(otherVault, 'note.md'));
  assert.equal((await resolveWikiResource('same.png', otherDocument as never)).uri?.toString(), URI.file(path.join(otherVault, 'same.png')).toString(), 'another workspace has its own index');
  assert.equal((await resolveWikiResource('notes/other#Heading', document as never)).uri?.fragment, 'Heading');
  await openLink(`meo-wiki:${encodeURIComponent('assets/字面%E8%AE%BE.png')}`, document as never);
  assert.equal(opened.at(-1), percentImage.toString(), 'Wiki image links open through the associated editor');
  assert.equal(openRoutes.at(-1)?.command, 'vscode.open');
  await openLink('meo-wiki:notes%2Fother%23Heading', document as never);
  assert.equal(opened.at(-1), URI.file(path.join(vault, 'notes/other.md')).with({ fragment: 'Heading' }).toString());
  assert.deepEqual(openRoutes.at(-1), { command: 'vscode.openWith', editor: 'meoEnhanced.editor' },
    'Wiki Markdown targets use MEO and preserve their fragment');
  await openLink('meo-wiki:same.png', document as never);
  assert.match(warnings.at(-1)!, /assets\/a\/same.png/);
  assert.equal(await resolveWebviewImageSrc(wikiImageSrc('assets/字面%E8%AE%BE.png'), document as never, webview as never), `data:image/png;base64,${bytes.toString('base64')}`);
  await assert.rejects(resolveWebviewImageSrc(wikiImageSrc('same.png'), document as never, webview as never), /重名/);

  const resources = await resolveDocumentWikiResources(source + '\n\n![[same.png]]', document as never);
  const preview = runtime.renderPreviewDocument({ markdownText: source + '\n\n![[same.png]]', sourceDocumentPath: document.fsPath, uiLanguage: 'en', wikiResources: resources });
  assert.match(preview.html, /href="meo-wiki:notes%2Fother"/);
  assert.match(preview.html, /width="300"/);
  assert.ok(preview.html.includes(wikiImageSrc('assets/图片 50%🖼️.png')));
  assert.match(preview.html, /Wiki 目标重名/);
  assert.equal((preview.html.match(/<img /g) ?? []).length, 1, 'code and ambiguous targets do not render images');
  assert.equal((runtime.renderPreviewDocument({ markdownText: source, sourceDocumentPath: document.fsPath, uiLanguage: 'en', preset: 'github-readme' }).html.match(/<img /g) ?? []).length, 0, 'GitHub preset keeps its Markdown semantics');
  for (const target of ['html', 'pdf', 'docx'] as const) {
    const exported = await runtime.renderExportHtmlDocument({ wikiResources: resources, sourceDocumentPath: document.fsPath,
      readingSnapshot: { snapshotId: `wiki-${target}`, text: source, appearance: 'light', uiLanguage: 'en', environment: { previewSourceColoring: false } },
      outputFilePath: path.join(directory, `output.${target}`), target, mermaidRuntimeSrc: '', baseHref: '', title: 'Wiki test', shikiLanguageAssetsRoot: '' });
    assert.ok(!exported.htmlDocument.includes('meo-wiki-image:'), 'exports must contain resolved assets');
    assert.ok(exported.htmlDocument.includes(target === 'pdf' ? pathToFileURL(image.fsPath).toString() : `data:image/png;base64,${bytes.toString('base64')}`), `${target}: ${exported.htmlDocument.match(/<img[^>]+>/)?.[0]}`);
    assert.match(exported.htmlDocument, /width="300"/);
  }

  let notifications = 0;
  const subscription = onDidChangeWikiResources(() => notifications++);
  write('new/moved.png');
  for (const callback of watchers[0].handlers.create) callback(URI.file(path.join(vault, 'new/moved.png')));
  assert.ok((await resolveWikiResource('moved.png', document as never)).uri, 'new files invalidate the index');
  fs.renameSync(path.join(vault, 'new/moved.png'), path.join(vault, 'new/renamed.png'));
  for (const callback of watchers[0].handlers.delete) callback(URI.file(path.join(vault, 'new/moved.png')));
  assert.ok(!(await resolveWikiResource('moved.png', document as never)).uri);
  assert.ok((await resolveWikiResource('renamed.png', document as never)).uri);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(notifications, 1, 'filesystem bursts are coalesced');
  subscription.dispose();
  disposeWikiResources();
  assert.ok(watchers.every(watcher => watcher.disposed));
  workspaceEnabled = false;
  const beforeStandalone = searches.length;
  assert.equal((await resolveWikiResource('字面%E8%AE%BE.png', document as never)).uri?.toString(), percentImage.toString(), 'a standalone Obsidian vault works without an open workspace');
  assert.equal(searches.length, beforeStandalone, 'standalone lookup uses its filesystem provider');
  disposeWikiResources();
  workspaceEnabled = true;
  overflow = true;
  const incomplete = await resolveWikiResource('missing.png', document as never);
  assert.match(incomplete.issue!, /未完成/);
  assert.ok(!incomplete.uri, 'an incomplete index cannot claim a unique match');
  assert.ok((await resolveWikiResource('./assets/图片 50%🖼️.png', document as never)).uri, 'explicit paths work even when an index is too large');
  console.log('Wiki syntax, vault lookup, conflicts, invalidation, Preview and export checks passed');
} finally {
  disposeWikiResources();
  fs.rmSync(directory, { recursive: true, force: true });
}
