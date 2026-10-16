import * as vscode from 'vscode';
import { normalizeDocumentText } from '../foundation/documentText';
import { markdownFileExtensions } from '../foundation/markdownFileExtensions';
import type { DocumentSaveAsResponse, SaveDocumentAsRequest } from '../protocol/documentSaveAs';

/** Native Save As owns file replacement and dirty state; MEO only prepares its draft. */
export function createVscodeDocumentSaveAsAdapter(document: vscode.TextDocument, options: {
  readonly getUiLanguage: () => 'en' | 'zh-CN';
  readonly markdownEditorViewType: string;
  readonly runPreparedSave: <Result>(save: () => Promise<Result>) => Promise<Result>;
  readonly onFailure: (message: string) => void;
}) {
  const requests = new Map<string, Promise<DocumentSaveAsResponse>>();
  let active = false;
  let disposed = false;
  const label = (en: string, zh: string) => options.getUiLanguage() === 'zh-CN' ? zh : en;
  const failure = (requestId: string, message: string): DocumentSaveAsResponse => ({
    type: 'documentSaveAsResult', requestId, result: { ok: false, error: { code: 'operation-failed', message } }
  });
  const reportFailure = (message: string) => {
    try { options.onFailure(message); } catch { /* Feedback must not change the save result. */ }
  };
  const recoverSavedFileOpen = async (target: vscode.Uri, error: unknown): Promise<void> => {
    const retry = label('Retry Opening in MEO', '重试用 MEO 打开');
    const useTextEditor = label('Open in Text Editor', '用文本编辑器打开');
    // This notification must outlive the old panel, which native Save As may replace.
    while (true) {
      const detail = error instanceof Error ? error.message : String(error);
      const location = target.scheme === 'file' ? target.fsPath : target.toString();
      const choice = await vscode.window.showWarningMessage(
        label('The file was saved to ', '文件已保存到 ') + location
          + label(', but could not be opened in MEO. ', '，但无法在 MEO 中打开。') + detail,
        retry, useTextEditor
      );
      if (choice !== retry && choice !== useTextEditor) return;
      try {
        await vscode.commands.executeCommand('vscode.openWith', target,
          choice === retry ? options.markdownEditorViewType : 'default', { preview: false });
        return;
      } catch (openError) { error = openError; }
    }
  };
  const save = async (request: SaveDocumentAsRequest): Promise<DocumentSaveAsResponse> => {
    if (normalizeDocumentText(document.getText()) !== normalizeDocumentText(request.text)) {
      throw new Error(label('Pending editor changes have not reached the document. Try Save As again.',
        '编辑内容尚未同步到文档，请重试另存为。'));
    }
    const target = await options.runPreparedSave(async () => vscode.workspace.saveAs(document.uri));
    if (target && markdownFileExtensions.some(extension => target.path.toLowerCase().endsWith(extension))) {
      // Native replacement may dispose the old panel before saveAs resolves.
      // Its successful destination must still retain MEO over file associations.
      try {
        await vscode.commands.executeCommand('vscode.openWith', target, options.markdownEditorViewType, { preview: false });
      } catch (error) {
        // Saving succeeded. Recovery only opens that destination; it never writes again.
        void recoverSavedFileOpen(target, error).catch(error => reportFailure(
          label('The file was saved, but opening recovery failed: ', '文件已保存，但打开恢复操作失败：')
            + (error instanceof Error ? error.message : String(error))
        ));
      }
    }
    return { type: 'documentSaveAsResult', requestId: request.requestId,
      // Native save errors already have VS Code's own recovery notification.
      // An undefined result must stay quiet for cancellation and must not claim why it stopped.
      result: { ok: true, value: { status: target ? 'saved' : 'not-completed' } } };
  };
  return {
    handle(request: SaveDocumentAsRequest): Promise<DocumentSaveAsResponse> {
      const previous = requests.get(request.requestId);
      if (previous) return previous;
      if (disposed || active) return Promise.resolve(failure(request.requestId, disposed
        ? label('The editor is closed.', '编辑器已关闭。')
        : label('Another Save As operation is in progress.', '另一项另存为操作仍在进行。')));
      active = true;
      const operation = save(request).catch((error): DocumentSaveAsResponse => {
        const message = error instanceof Error ? error.message : label('Save As failed.', '另存为失败。');
        // A live Webview owns this error; use a native notification only if it has closed.
        if (disposed) reportFailure(message);
        return failure(request.requestId, message);
      }).finally(() => { active = false; });
      requests.set(request.requestId, operation);
      while (requests.size > 16) requests.delete(requests.keys().next().value!);
      return operation;
    },
    dispose() { disposed = true; requests.clear(); }
  };
}
