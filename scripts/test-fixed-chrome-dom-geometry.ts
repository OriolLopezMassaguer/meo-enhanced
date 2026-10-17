import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-fixed-chrome-dom-'));
const build = await Bun.build({ entrypoints: ['scripts/test-fixed-chrome-dom-geometry-entry.ts'],
  outdir: temp, naming: 'bundle.js', target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  await page.setContent('<div id="parent" style="transform-origin:0 0;width:300px;height:200px"><button id="control" style="position:fixed;left:10px;top:20px;width:0;height:0;padding:0;border:0"></button></div>');
  await page.addScriptTag({ path: path.join(temp, 'bundle.js') });
  const result = await page.evaluate(() => {
    const measure = (window as any).measureFixedContainingBlockMapping;
    const parent = document.getElementById('parent')!;
    const control = document.getElementById('control')!;
    measure(control);
    const mutations = new MutationObserver(() => undefined);
    mutations.observe(parent, { childList: true });
    for (let n = 0; n < 160; n++) measure(control);
    const steadyMutations = mutations.takeRecords().length;
    const errors: number[] = [];
    for (const transform of ['translate(37px,21px) scale(1.25)', 'translate(80px,50px) rotate(12deg)', 'scale(.8)', 'none']) {
      parent.style.transform = transform;
      const map = measure(control);
      const rect = control.getBoundingClientRect();
      errors.push(Math.abs(map.a * 10 + map.c * 20 + map.e - rect.left),
        Math.abs(map.b * 10 + map.d * 20 + map.f - rect.top));
    }
    const before = [...parent.querySelectorAll('span[aria-hidden="true"]')];
    parent.replaceChildren(control);
    const afterReplacement = measure(control);
    const restored = [...parent.querySelectorAll('span[aria-hidden="true"]')];
    mutations.disconnect();
    return { steadyMutations, errors, before: before.length, restored: restored.length,
      afterReplacement, probeRecreated: restored.every(probe => !before.includes(probe)) };
  });
  assert.equal(result.steadyMutations, 0, 'steady scroll measurements must not mutate widget DOM or retrigger CodeMirror layout');
  assert.ok(result.errors.every(error => error < .1), `mapping must follow transform changes: ${JSON.stringify(result.errors)}`);
  assert.equal(result.before, 3);
  assert.equal(result.restored, 3);
  assert.equal(result.probeRecreated, true, 'removed probes must be recreated for the current parent');
  assert.ok(result.afterReplacement);
  console.log('Fixed chrome DOM measurement reuse, live transform changes and parent replacement passed');
} catch (error) { primaryError = error; }
finally {
  fs.rmSync(temp, { recursive: true, force: true });
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
