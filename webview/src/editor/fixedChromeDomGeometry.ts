import {
  fixedChromeAffineMappingFromSamples,
  type FixedChromeAffineMapping
} from './fixedChromeGeometry';

const sampleDistance = 100;
const samplesByParent = new WeakMap<HTMLElement, readonly HTMLSpanElement[]>();

/** Samples the complete local-to-viewport mapping for an element's fixed containing block. */
export function measureFixedContainingBlockMapping(
  element: HTMLElement
): FixedChromeAffineMapping | null {
  const parent = element.parentElement;
  if (!parent) return null;
  const probe = (left: number, top: number): HTMLSpanElement => {
    const sample = parent.ownerDocument.createElement('span');
    sample.setAttribute('aria-hidden', 'true');
    sample.style.cssText = `position:fixed;inset:auto;left:${left}px;top:${top}px;` +
      'display:block;width:0;height:0;margin:0;padding:0;border:0;visibility:hidden;pointer-events:none;';
    return sample;
  };
  let samples = samplesByParent.get(parent);
  if (!samples || samples.some(sample => sample.parentElement !== parent)) {
    for (const sample of samples ?? []) sample.remove();
    samples = [probe(0, 0), probe(sampleDistance, 0), probe(0, sampleDistance)];
    parent.append(...samples);
    samplesByParent.set(parent, samples);
  }
  const [origin, horizontal, vertical] = samples;
  try {
    // Keep the zero-size probes with their parent. Inserting/removing them on
    // every scroll invalidates layout and feeds CodeMirror's DOM observer.
    // Read fresh rectangles so host zoom, transforms and scrolling still apply.
    const originRect = origin.getBoundingClientRect();
    const horizontalRect = horizontal.getBoundingClientRect();
    const verticalRect = vertical.getBoundingClientRect();
    return fixedChromeAffineMappingFromSamples(
      { x: originRect.left, y: originRect.top },
      { x: horizontalRect.left, y: horizontalRect.top },
      { x: verticalRect.left, y: verticalRect.top },
      sampleDistance
    );
  } catch {
    return null;
  }
}
