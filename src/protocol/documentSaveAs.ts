import { decodeRequestResult, type RequestResult } from './requestResult';
import { decodeReadingPosition } from './readingPosition';
import type { DocumentViewState } from '../foundation/documentViewState';

export const DOCUMENT_SAVE_AS_TIMEOUT_MS = 600_000;
export type SaveDocumentAsRequest = {
  readonly type: 'saveDocumentAs';
  readonly requestId: string;
  readonly text: string;
  readonly viewState?: DocumentViewState;
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
  if (isRecord(value) && value.viewState !== undefined && !decodeDocumentViewState(value.viewState)) return null;
  return isRecord(value) && value.type === 'saveDocumentAs'
    && typeof value.requestId === 'string' && value.requestId.length > 0 && typeof value.text === 'string'
    ? { type: 'saveDocumentAs', requestId: value.requestId, text: value.text,
      ...(value.viewState === undefined ? {} : { viewState: decodeDocumentViewState(value.viewState)! }) } : null;
}

export function decodeDocumentViewState(value: unknown): DocumentViewState | null {
  if (!isRecord(value) || !['live', 'source', 'preview'].includes(value.mode as string)
    || !decodeReadingPosition(value.position) || !isRecord(value.selection)
    || !Number.isSafeInteger(value.selection.anchor) || Number(value.selection.anchor) < 0
    || !Number.isSafeInteger(value.selection.head) || Number(value.selection.head) < 0) return null;
  return value as unknown as DocumentViewState;
}

export function decodeDocumentSaveAsResponse(value: unknown): DocumentSaveAsResponse | null {
  if (!isRecord(value) || value.type !== 'documentSaveAsResult'
    || typeof value.requestId !== 'string' || value.requestId.length === 0) return null;
  const result = decodeRequestResult(value.result, (outcome): DocumentSaveAsOutcome | null =>
    isRecord(outcome) && (outcome.status === 'saved' || outcome.status === 'not-completed')
      ? { status: outcome.status } : null);
  return result ? { type: 'documentSaveAsResult', requestId: value.requestId, result } : null;
}
