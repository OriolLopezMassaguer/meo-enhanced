import assert from 'node:assert/strict';
import { planPreviewTableWidths } from '../webview/src/helpers/previewTableLayout';

const contentAware = planPreviewTableWidths([110, 760, 150], 720);
assert.equal(Math.round(contentAware.widths.reduce((sum, width) => sum + width, 0)), 720);
assert.ok(contentAware.widths.every((width) => width >= 90));
assert.ok(contentAware.widths[1] > contentAware.widths[0] * 2, JSON.stringify(contentAware));
assert.ok(contentAware.widths[1] > contentAware.widths[2] * 2, JSON.stringify(contentAware));
assert.equal(contentAware.overflows, false);

const tightlyFitted = planPreviewTableWidths([110, 760, 150], 220);
assert.equal(Math.round(tightlyFitted.widths.reduce((sum, width) => sum + width, 0)), 220);
assert.ok(tightlyFitted.widths.every((width) => width > 0));
assert.ok(tightlyFitted.widths[1] > tightlyFitted.widths[0], JSON.stringify(tightlyFitted));
assert.ok(tightlyFitted.widths[1] > tightlyFitted.widths[2], JSON.stringify(tightlyFitted));
assert.equal(tightlyFitted.totalWidth, 220);
assert.equal(tightlyFitted.overflows, false);

const spareSpace = planPreviewTableWidths([100, 100], 500);
assert.equal(Math.round(spareSpace.widths.reduce((sum, width) => sum + width, 0)), 500);
assert.deepEqual(spareSpace.widths.map(Math.round), [250, 250]);

const compactColumns = planPreviewTableWidths([40, 65, 900], 600);
assert.deepEqual(compactColumns.widths.map(Math.round), [40, 65, 495],
  'short columns should fit their contents while a wrapping description uses the remaining space');
const longDescription = planPreviewTableWidths([110, 760, 150], 720);
assert.deepEqual(longDescription.widths.map(Math.round), [110, 460, 150],
  'space above the long-content demand cap should go to content that still wraps');
const narrowCompact = planPreviewTableWidths([40, 760, 150], 180);
assert.equal(Math.round(narrowCompact.widths[0]), 40,
  'a short column that fits an equal share should remain unwrapped in a narrow table');
assert.equal(Math.round(narrowCompact.totalWidth), 180);
assert.equal(narrowCompact.overflows, false);

console.log('Preview table width planning checks passed');
