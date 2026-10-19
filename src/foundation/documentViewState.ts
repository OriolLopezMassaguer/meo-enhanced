/** View state that can follow unchanged text to a new document resource. */
export type DocumentViewState = {
  readonly mode: 'live' | 'source' | 'preview';
  readonly position: { readonly line: number; readonly lineOffset: number };
  readonly selection: { readonly anchor: number; readonly head: number };
};
