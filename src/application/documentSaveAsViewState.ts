import { normalizeDocumentText } from '../foundation/documentText';
import type { DocumentViewState } from '../foundation/documentViewState';

/** One-shot handoff while native Save As replaces an editor, before its command returns. */
export function createDocumentSaveAsViewStateHandoff() {
  const pending = new Map<string, { text: string; state: DocumentViewState }>();
  return {
    stage(documentKey: string, text: string, state: DocumentViewState): () => void {
      const entry = { text: normalizeDocumentText(text), state };
      pending.set(documentKey, entry);
      return () => { if (pending.get(documentKey) === entry) pending.delete(documentKey); };
    },
    take(documentKey: string, text: string): DocumentViewState | null {
      const entry = pending.get(documentKey);
      if (!entry || entry.text !== normalizeDocumentText(text)) return null;
      pending.delete(documentKey);
      return entry.state;
    }
  };
}
