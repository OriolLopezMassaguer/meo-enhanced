import { AlertTriangle, BrushCleaning, Check, createElement } from 'lucide';

export type SourceFormatOutcome = 'formatted' | 'unchanged' | 'preserved' | 'invalid' | 'changed' | 'unavailable';
type Messages = Record<SourceFormatOutcome, string> & { idle: string; busy: string };

/** Owns feedback and timers; the widget owner must dispose it when unmounted. */
export function createSourceFormatButton(document: Document, messages: () => Messages,
  run: (isCurrent: () => boolean) => Promise<SourceFormatOutcome>) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'meo-source-format-btn';
  button.contentEditable = 'false';
  button.dataset.tooltipLiveUpdate = 'true';
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  button.append(icon);
  let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
  const label = (value: string) => { button.dataset.tooltip = value; button.setAttribute('aria-label', value); };
  const refresh = () => {
    if (button.disabled || timer !== undefined) return;
    icon.replaceChildren(createElement(BrushCleaning, { width: 14, height: 14 }));
    label(messages().idle);
    // Retain the persisted command ID so existing customized bindings still apply.
    button.dataset.tooltipCommand = 'formatHtml';
  };
  for (const type of ['pointerdown', 'mousedown']) button.addEventListener(type, event => {
    event.preventDefault(); event.stopPropagation();
  });
  button.addEventListener('click', async event => {
    event.preventDefault(); event.stopPropagation();
    if (button.disabled || disposed) return;
    clearTimeout(timer); timer = undefined;
    delete button.dataset.tooltipCommand;
    delete button.dataset.tooltipShortcut;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    label(messages().busy);
    let outcome: SourceFormatOutcome;
    try { outcome = await run(() => !disposed && button.isConnected); }
    catch { outcome = 'invalid'; }
    if (disposed || !button.isConnected) return;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    label(messages()[outcome]);
    icon.replaceChildren(createElement(outcome === 'formatted' || outcome === 'unchanged' ? Check : AlertTriangle,
      { width: 14, height: 14 }));
    timer = setTimeout(() => { timer = undefined; if (!disposed) refresh(); }, 2500);
  });
  refresh();
  return { button, refresh, dispose() { disposed = true; clearTimeout(timer); } };
}
