/** One menu and its authoritative controls, opened from either preview surface. */
export function createPreviewOptionsMenu(label: string, controls: readonly HTMLElement[], onClose: () => void) {
  const panel = document.createElement('div');
  panel.id = 'preview-options-panel';
  panel.className = 'preview-options-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', label);
  panel.hidden = true;
  panel.append(...controls);
  document.body.append(panel);

  const triggers = new Set<HTMLButtonElement>();
  let activeTrigger: HTMLButtonElement | null = null;
  const ownsPopup = (target: Node): boolean => {
    const popup = target instanceof Element ? target.closest<HTMLElement>('.preview-dropdown-panel') : null;
    const control = popup?.dataset.previewControl;
    return Boolean(control && panel.querySelector(`.${control}`));
  };
  const close = (): void => {
    const wasOpen = !panel.hidden;
    panel.hidden = true;
    for (const trigger of triggers) trigger.setAttribute('aria-expanded', 'false');
    if (wasOpen) onClose();
  };
  const position = (): void => {
    if (panel.hidden || !activeTrigger) return;
    const bounds = activeTrigger.getBoundingClientRect();
    const below = window.innerHeight - bounds.bottom - 8;
    const above = bounds.top - 8;
    panel.style.maxHeight = `${Math.max(0, below, above)}px`;
    const openAbove = panel.offsetHeight > below && above > below;
    panel.style.maxHeight = `${Math.max(0, openAbove ? above : below)}px`;
    panel.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - panel.getBoundingClientRect().width - 8))}px`;
    panel.style.top = openAbove
      ? `${Math.max(8, bounds.top - panel.offsetHeight - 4)}px`
      : `${bounds.bottom + 4}px`;
  };
  const open = (trigger: HTMLButtonElement): void => {
    if (!panel.hidden && activeTrigger === trigger) return;
    close();
    activeTrigger = trigger;
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    position();
  };
  const bindTrigger = (trigger: HTMLButtonElement): void => {
    triggers.add(trigger);
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', panel.id);
    trigger.addEventListener('click', () => {
      if (!panel.hidden && activeTrigger === trigger) close();
      else open(trigger);
    });
    trigger.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      open(trigger);
      panel.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    });
  };
  document.addEventListener('pointerdown', event => {
    if (panel.hidden || !(event.target instanceof Node)) return;
    const target = event.target;
    if (panel.contains(target) || [...triggers].some(trigger => trigger.contains(target))) return;
    if (ownsPopup(target)) return;
    close();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || panel.hidden) return;
    event.preventDefault();
    close();
    activeTrigger?.focus({ preventScroll: true });
  });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  return {
    panel,
    bindTrigger,
    close,
    setLabel(nextLabel: string) {
      panel.setAttribute('aria-label', nextLabel);
      position();
    }
  };
}
