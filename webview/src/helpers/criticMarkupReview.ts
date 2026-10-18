import { StateField, type EditorState } from '@codemirror/state';
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view';
import {
  buildCommentInsertion, criticUnitAt, groupCriticUnits, nextCommentId, resolveCriticUnit, type CriticUnit
} from '../../../src/foundation/criticMarkup';
import { getUiStrings } from '../application/uiLanguage';
import { uiLanguageFacet } from '../editor/uiLanguage';
import { criticMarksInState } from './criticMarkupSyntax';

let commentAuthor = '';
let commentDates = false;
/** Name written after @ in new comments; the host resolves the setting and its fallback. */
export function setCriticCommentAuthor(author: string): void {
  commentAuthor = author;
}

/** Whether new comments carry today's date after the author. */
export function setCriticCommentDates(enabled: boolean): void {
  commentDates = enabled;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Wrap the selection in a highlight with a new `#cNN` comment and leave the cursor in the note. */
export function insertCriticComment(view: EditorView): void {
  const { state } = view;
  const selection = state.selection.main;
  const text = state.doc.toString();
  const id = nextCommentId(criticMarksInState(state), text);
  const { insert, cursor } = buildCommentInsertion(state.doc.sliceString(selection.from, selection.to), id, commentAuthor, commentDates ? todayIso() : '');
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: { anchor: selection.from + cursor },
    userEvent: 'input.criticComment',
    scrollIntoView: true
  });
  view.focus();
}

/** The unit under the cursor, or null when the cursor is outside every mark. */
function reviewUnit(state: EditorState): CriticUnit | null {
  const selection = state.selection.main;
  if (state.doc.length === 0 || state.doc.length > 400_000) return null;
  const units = groupCriticUnits(criticMarksInState(state));
  const unit = criticUnitAt(units, selection.head);
  return unit && selection.from >= unit.from && selection.to <= unit.to ? unit : null;
}

/** Resolve one unit as a single undoable change. */
export function resolveCriticUnitInView(view: EditorView, unit: CriticUnit, decision: 'accept' | 'reject'): void {
  const change = resolveCriticUnit(view.state.doc.toString(), unit, decision);
  view.dispatch({
    changes: change,
    selection: { anchor: change.from + change.insert.length },
    userEvent: 'input.criticReview',
    scrollIntoView: true
  });
  view.focus();
}

function createTooltip(unit: CriticUnit): Tooltip {
  return {
    pos: unit.from,
    above: true,
    strictSide: false,
    create(view) {
      const strings = getUiStrings(view.state.facet(uiLanguageFacet));
      const dom = document.createElement('div');
      dom.className = 'meo-critic-review';
      dom.setAttribute('role', 'toolbar');
      for (const [decision, label] of [['accept', strings.criticAccept], ['reject', strings.criticReject]] as const) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `meo-critic-review-button is-${decision}`;
        button.dataset.decision = decision;
        button.textContent = label;
        // Keep the editor selection: the button must not steal focus before the click lands.
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', () => {
          const current = reviewUnit(view.state);
          if (current) resolveCriticUnitInView(view, current, decision);
        });
        dom.append(button);
      }
      return { dom };
    }
  };
}

/** Accept / Reject buttons that float over the mark the cursor is in (Live and Source). */
export const criticReviewField = StateField.define<Tooltip | null>({
  create: (state) => {
    const unit = reviewUnit(state);
    return unit ? createTooltip(unit) : null;
  },
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection) return value;
    const unit = reviewUnit(transaction.state);
    return unit ? createTooltip(unit) : null;
  },
  provide: (field) => showTooltip.from(field)
});
