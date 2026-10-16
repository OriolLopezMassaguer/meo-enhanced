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
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(label('The file was saved, but could not be opened in MEO: ', '文件已另存，但无法在 MEO 中打开：') + detail);
      }
    }
    return { type: 'documentSaveAsResult', requestId: request.requestId,
      result: { ok: true, value: { status: target ? 'saved' : 'cancelled' } } };
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
        try { options.onFailure(message); } catch { /* Keep the correlated failure response. */ }
        return failure(request.requestId, message);
      }).finally(() => { active = false; });
      requests.set(request.requestId, operation);
      while (requests.size > 16) requests.delete(requests.keys().next().value!);
      return operation;
    },
    dispose() { disposed = true; requests.clear(); }
  };
}
