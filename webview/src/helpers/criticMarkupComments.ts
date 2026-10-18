import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  groupCriticUnits, parseCriticComment, resolveAllCriticUnits, toggleCommentResolved, type CriticCommentType, type CriticMark
} from '../../../src/foundation/criticMarkup';
import { criticMarksInState } from './criticMarkupSyntax';

export type CriticComment = Readonly<{
  id: string | null;
  author: string | null;
  date: string | null;
  resolved: boolean;
  type: CriticCommentType | null;
  /** The comment mark itself, for toggling its resolved marker. */
  mark: CriticMark;
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
    comments.push({ ...parts, mark, line: state.doc.lineAt(mark.from).number, from, to: mark.to });
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

export type CriticCommentsPanelStrings = Readonly<{
  title: string; empty: string; acceptAll: string; rejectAll: string; hideResolved: string; markResolved: string;
}>;

/** Accept or reject every mark in the selection, or in the whole document when nothing is selected. */
export function resolveAllInView(view: EditorView, decision: 'accept' | 'reject'): number {
  const text = view.state.doc.toString();
  const selection = view.state.selection.main;
  const units = groupCriticUnits(criticMarksInState(view.state));
  const changes = resolveAllCriticUnits(text, units, decision, selection.empty ? undefined : { from: selection.from, to: selection.to });
  if (!changes.length) return 0;
  view.dispatch({ changes, userEvent: 'input.criticReview' });
  view.focus();
  return changes.length;
}

/** Flip a comment between pending and resolved by editing its `[x] ` marker. */
export function toggleResolvedInView(view: EditorView, comment: CriticComment): void {
  view.dispatch({ changes: toggleCommentResolved(view.state.doc.toString(), comment.mark), userEvent: 'input.criticResolve' });
}

/** A popover that lists the document's comments; a row jumps to its comment. */
export function createCriticCommentsPanel(options: {
  readonly getView: () => EditorView | null;
  readonly getStrings: () => CriticCommentsPanelStrings;
}) {
  const panel = document.createElement('div');
  panel.className = 'meo-critic-comments';
  panel.setAttribute('role', 'dialog');
  panel.hidden = true;

  let hideResolved = false;
  const close = (): void => { panel.hidden = true; };
  const button = (className: string, label: string, onClick: () => void): HTMLButtonElement => {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = className;
    control.textContent = label;
    control.addEventListener('click', onClick);
    return control;
  };
  const render = (): void => {
    const view = options.getView();
    const strings = options.getStrings();
    panel.replaceChildren();
    panel.setAttribute('aria-label', strings.title);
    const header = document.createElement('div');
    header.className = 'meo-critic-comments-header';
    const heading = document.createElement('span');
    heading.className = 'meo-critic-comments-title';
    heading.textContent = strings.title;
    const filter = document.createElement('label');
    filter.className = 'meo-critic-comments-filter';
    const filterBox = document.createElement('input');
    filterBox.type = 'checkbox';
    filterBox.checked = hideResolved;
    filterBox.addEventListener('change', () => { hideResolved = filterBox.checked; render(); });
    filter.append(filterBox, document.createTextNode(strings.hideResolved));
    header.append(heading, filter);
    panel.append(header);
    const all = view ? listCriticComments(view.state) : [];
    const comments = hideResolved ? all.filter((comment) => !comment.resolved) : all;
    if (!comments.length) {
      const empty = document.createElement('div');
      empty.className = 'meo-critic-comments-empty';
      empty.textContent = strings.empty;
      panel.append(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'meo-critic-comments-list';
      for (const comment of comments) {
        const item = document.createElement('li');
        item.className = 'meo-critic-comments-item';
        item.classList.toggle('is-resolved', comment.resolved);
        if (comment.type) item.classList.add(`is-type-${comment.type.toLowerCase()}`);
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'meo-critic-comments-check';
        check.checked = comment.resolved;
        check.setAttribute('aria-label', strings.markResolved);
        check.addEventListener('change', () => {
          const current = options.getView();
          if (current) toggleResolvedInView(current, comment);
          render();
        });
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'meo-critic-comments-row';
        const meta = document.createElement('span');
        meta.className = 'meo-critic-comments-meta';
        meta.textContent = [comment.id ? `#${comment.id}` : '', comment.author ? `@${comment.author}` : '', comment.date ?? '', comment.type ? `[${comment.type}]` : '', `L${comment.line}`]
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
        item.append(check, row);
        list.append(item);
      }
      panel.append(list);
    }
    const footer = document.createElement('div');
    footer.className = 'meo-critic-comments-footer';
    const resolveAll = (decision: 'accept' | 'reject') => () => {
      const current = options.getView();
      if (current) resolveAllInView(current, decision);
      render();
    };
    footer.append(
      button('meo-critic-comments-action is-accept', strings.acceptAll, resolveAll('accept')),
      button('meo-critic-comments-action is-reject', strings.rejectAll, resolveAll('reject'))
    );
    panel.append(footer);
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
