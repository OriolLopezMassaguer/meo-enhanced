import { createElement } from 'lucide';

// Based on VS Code Codicons, adapted to the toolbar's stroke weight.
// Upstream sources and attribution are listed in THIRD_PARTY_NOTICES.md.
// Disk and pane edges stop short of the secondary glyphs to keep a visible gap.
const paths = {
  save: 'M3 1.5h8.38a1.5 1.5 0 0 1 1.06.44l1.62 1.62a1.5 1.5 0 0 1 .44 1.06V13a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 13V3A1.5 1.5 0 0 1 3 1.5ZM5.5 1.5v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2M4.5 14.5v-5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5',
  'save-as': 'M5.75 14.5H3A1.5 1.5 0 0 1 1.5 13V3A1.5 1.5 0 0 1 3 1.5h8.38a1.5 1.5 0 0 1 1.06.44l1.62 1.62a1.5 1.5 0 0 1 .44 1.06V5.25M5.5 1.5v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2M4.5 14.5v-5a1 1 0 0 1 1-1h4M9 13l4.5-4.5a1.06 1.06 0 0 1 1.5 1.5l-4.5 4.5-2 .5.5-2Z',
  'open-preview': 'M2.5 4.75V3.5a2 2 0 0 1 2-2H13a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-1.5M8.75 1.5v10.25M6.5 10.25a2.75 2.75 0 1 1-5.5 0 2.75 2.75 0 0 1 5.5 0ZM5.7 12.2l3.05 3.05'
} as const;

export function createCodicon(name: keyof typeof paths): SVGElement {
  return createElement([['path', { d: paths[name] }]], {
    width: 18,
    height: 18,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    // 18 / 16 × 4 / 3 = 1.5px, matching the neighboring Lucide icons.
    'stroke-width': 4 / 3,
    'aria-hidden': 'true',
    'data-icon': name
  });
}
