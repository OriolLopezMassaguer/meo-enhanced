export type AutomaticTableWidthPlan = {
  readonly widths: readonly number[];
  readonly totalWidth: number;
  readonly overflows: false;
};

/**
 * Fits rendered column widths (including padding/borders) to the desired table width.
 * The readability floor is soft; spare space retains the existing equal-fill behavior.
 */
export function planAutomaticTableWidths(
  preferredWidths: readonly number[],
  availableWidth: number,
  minimumColumnWidth = 90
): AutomaticTableWidthPlan {
  if (!preferredWidths.length) return { widths: [], totalWidth: 0, overflows: false };
  const available = Math.max(0, availableWidth);
  const minimum = Math.max(1, minimumColumnWidth);
  const preferred = preferredWidths.map(width => Math.max(1, Number.isFinite(width) ? width : minimum));
  const preferredCap = Math.max(minimum, Math.min(640, Math.max(360, available * 0.62)));
  const capped = preferred.map(width => Math.min(width, preferredCap));
  const floors = preferred.map(width => Math.min(width, minimum));
  const widths = [...floors];
  let remaining = available - floors.reduce((sum, width) => sum + width, 0);

  if (remaining < 0) {
    let active = preferred.map((_, index) => index);
    remaining = available;
    // Keep genuinely short values whole when they fit an equal share. Releasing
    // their unused share lets the remaining columns retain content-based weights.
    while (active.length) {
      const share = remaining / active.length;
      const compact = active.filter(index => preferred[index] <= share);
      if (!compact.length) break;
      for (const index of compact) {
        widths[index] = preferred[index];
        remaining -= widths[index];
      }
      active = active.filter(index => !compact.includes(index));
    }
    if (active.length) {
      // Retain the existing narrow-table balance: a common 35% share prevents
      // starvation, while the rest follows bounded content demand.
      const equalShare = remaining * 0.35 / active.length;
      const demandTotal = active.reduce((sum, index) => sum + capped[index], 0);
      for (const index of active) widths[index] = equalShare + remaining * 0.65 * capped[index] / demandTotal;
      remaining = 0;
    }
  } else {
    const growToward = (targets: readonly number[]) => {
      const demands = targets.map((target, index) => Math.max(0, target - widths[index]));
      const total = demands.reduce((sum, demand) => sum + demand, 0);
      const budget = Math.min(remaining, total);
      if (total <= 0) return;
      for (let index = 0; index < widths.length; index++) widths[index] += budget * demands[index] / total;
      remaining -= budget;
    };
    growToward(capped);
    // The cap limits an outlier's initial weight, not useful space: give any
    // remainder to still-wrapping content before enlarging already-fitted cells.
    growToward(preferred);
  }
  if (remaining > 0) {
    const extra = remaining / widths.length;
    for (let index = 0; index < widths.length; index++) widths[index] += extra;
  }
  return { widths, totalWidth: available, overflows: false };
}
