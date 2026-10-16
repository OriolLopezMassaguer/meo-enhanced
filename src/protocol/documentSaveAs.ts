import { decodeRequestResult, type RequestResult } from './requestResult';

export const DOCUMENT_SAVE_AS_TIMEOUT_MS = 600_000;
export type SaveDocumentAsRequest = {
  readonly type: 'saveDocumentAs';
  readonly requestId: string;
  readonly text: string;
};
/** VS Code does not distinguish cancellation from an unsuccessful native save. */
export type DocumentSaveAsOutcome = { readonly status: 'saved' | 'not-completed' };
export type DocumentSaveAsResult = RequestResult<DocumentSaveAsOutcome>;
export type DocumentSaveAsResponse = {
  readonly type: 'documentSaveAsResult';
  readonly requestId: string;
  readonly result: DocumentSaveAsResult;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export function decodeSaveDocumentAsRequest(value: unknown): SaveDocumentAsRequest | null {
  return isRecord(value) && value.type === 'saveDocumentAs'
    && typeof value.requestId === 'string' && value.requestId.length > 0 && typeof value.text === 'string'
    ? { type: 'saveDocumentAs', requestId: value.requestId, text: value.text } : null;
}

export function decodeDocumentSaveAsResponse(value: unknown): DocumentSaveAsResponse | null {
  if (!isRecord(value) || value.type !== 'documentSaveAsResult'
    || typeof value.requestId !== 'string' || value.requestId.length === 0) return null;
  const result = decodeRequestResult(value.result, (outcome): DocumentSaveAsOutcome | null =>
    isRecord(outcome) && (outcome.status === 'saved' || outcome.status === 'not-completed')
      ? { status: outcome.status } : null);
  return result ? { type: 'documentSaveAsResult', requestId: value.requestId, result } : null;
}
