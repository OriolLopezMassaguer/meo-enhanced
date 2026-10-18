import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { parseCriticComment } from '../../../src/foundation/criticMarkup';
import { criticMarksInState } from './criticMarkupSyntax';

export type CriticComment = Readonly<{
  id: string | null;
  author: string | null;
  body: string;
  line: number;
  from: number;
  to: number;
}>;

/** Every comment mark in document order, with the highlight it is glued to included in the range. */
export function listCriticComments(state: EditorState): CriticComment[] {
  const text = state.doc.toString();
  const marks = criticMarksInState(state);
  const comments: CriticComment[] = [];
  marks.forEach((mark, index) => {
    if (mark.kind !== 'comment') return;
    const parts = parseCriticComment(text.slice(mark.from + mark.openLength, mark.to - mark.closeLength));
    const previous = marks[index - 1];
    const from = previous?.kind === 'hl' && previous.to === mark.from ? previous.from : mark.from;
    comments.push({ ...parts, line: state.doc.lineAt(mark.from).number, from, to: mark.to });
  });
  return comments;
}

/** Put the cursor on a range and bring it into view. */
export function selectCriticRange(view: EditorView, from: number, to: number): void {
  view.dispatch({
    selection: { anchor: from, head: to },
    effects: EditorView.scrollIntoView(from, { y: 'center' })
  });
  view.focus();
}

export type CriticCommentsPanelStrings = Readonly<{ title: string; empty: string }>;

/** A popover that lists the document's comments; a row jumps to its comment. */
export function createCriticCommentsPanel(options: {
  readonly getView: () => EditorView | null;
  readonly getStrings: () => CriticCommentsPanelStrings;
}) {
  const panel = document.createElement('div');
  panel.className = 'meo-critic-comments';
  panel.setAttribute('role', 'dialog');
  panel.hidden = true;

  const close = (): void => { panel.hidden = true; };
  const render = (): void => {
    const view = options.getView();
    const strings = options.getStrings();
    panel.replaceChildren();
    panel.setAttribute('aria-label', strings.title);
    const heading = document.createElement('div');
    heading.className = 'meo-critic-comments-title';
    heading.textContent = strings.title;
    panel.append(heading);
    const comments = view ? listCriticComments(view.state) : [];
    if (!comments.length) {
      const empty = document.createElement('div');
      empty.className = 'meo-critic-comments-empty';
      empty.textContent = strings.empty;
      panel.append(empty);
      return;
    }
    const list = document.createElement('ul');
    list.className = 'meo-critic-comments-list';
    for (const comment of comments) {
      const item = document.createElement('li');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'meo-critic-comments-row';
      const meta = document.createElement('span');
      meta.className = 'meo-critic-comments-meta';
      meta.textContent = [comment.id ? `#${comment.id}` : '', comment.author ? `@${comment.author}` : '', `L${comment.line}`]
        .filter(Boolean).join(' ');
      const body = document.createElement('span');
      body.className = 'meo-critic-comments-body';
      body.textContent = comment.body;
      row.append(meta, body);
      row.addEventListener('click', () => {
        const current = options.getView();
        if (current) selectCriticRange(current, comment.from, comment.to);
        close();
      });
      item.append(row);
      list.append(item);
    }
    panel.append(list);
  };

  document.addEventListener('mousedown', (event) => {
    if (!panel.hidden && event.target instanceof Node && !panel.contains(event.target)) close();
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
    options.getView()?.focus();
  });

  return {
    element: panel,
    open(): void { render(); panel.hidden = false; panel.querySelector<HTMLElement>('.meo-critic-comments-row')?.focus(); },
    close,
    refresh(): void { if (!panel.hidden) render(); },
    isOpen: () => !panel.hidden
  };
}
