import { DOCUMENT_SAVE_AS_TIMEOUT_MS, type DocumentSaveAsOutcome, type DocumentSaveAsResponse, type DocumentSaveAsResult, type SaveDocumentAsRequest } from '../../../src/protocol/documentSaveAs';
import { createRequestLifecycle, type RequestLifecycleOptions } from './requestLifecycle';
import type { UiLanguage } from '../application/uiLanguage';

export function createDocumentSaveAsTransport(dependencies: {
  readonly postMessage: (message: SaveDocumentAsRequest) => void;
  readonly getUiLanguage: () => UiLanguage;
  readonly commitTransientEdits: () => void;
  readonly getCurrentText: () => string | null;
  readonly whenDocumentIdle: () => Promise<void>;
}, options: RequestLifecycleOptions = {}) {
  const requests = createRequestLifecycle<DocumentSaveAsOutcome>(
    'document-save-as', DOCUMENT_SAVE_AS_TIMEOUT_MS, options);
  let disposed = false;
  const label = (en: string, zh: string) => dependencies.getUiLanguage() === 'zh-CN' ? zh : en;
  return {
    async save(): Promise<DocumentSaveAsResult> {
      try {
        if (disposed) throw new Error(label('The editor is closed.', '编辑器已关闭。'));
        dependencies.commitTransientEdits();
        await dependencies.whenDocumentIdle();
        if (disposed) throw new Error(label('The editor is closed.', '编辑器已关闭。'));
        const text = dependencies.getCurrentText();
        if (text === null) throw new Error(label('The current document content is unavailable.', '无法取得当前文档内容。'));
        // Reading can commit a native table cell; wait for its accepted revision.
        await dependencies.whenDocumentIdle();
        if (disposed) throw new Error(label('The editor is closed.', '编辑器已关闭。'));
        return requests.start(requestId => dependencies.postMessage({ type: 'saveDocumentAs', requestId, text }), {
          timeout: label('Timed out while waiting for Save As.', '等待另存为操作超时。'),
          sendFailed: label('Could not start Save As.', '无法开始另存为。')
        });
      } catch (error) {
        return { ok: false, error: { code: 'operation-failed', message: error instanceof Error ? error.message
          : label('Could not prepare Save As.', '无法准备另存为。') } };
      }
    },
    accept(response: DocumentSaveAsResponse) { return requests.accept(response.requestId, response.result); },
    dispose() {
      disposed = true;
      requests.cancelAll(label('The editor closed before Save As completed.', '编辑器已关闭，另存为尚未完成。'));
    }
  };
}
