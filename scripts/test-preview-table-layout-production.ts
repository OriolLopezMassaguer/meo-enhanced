import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-table-layout-'));
const entry = path.join(temporary, 'entry.ts');
fs.writeFileSync(entry, `
  import { createPreviewTableLayoutController } from ${JSON.stringify(path.resolve(import.meta.dir, '../webview/src/helpers/previewTableLayout.ts'))};
  import { createEditor } from ${JSON.stringify(path.resolve(import.meta.dir, './test-editor-factory.ts'))};
  import { applyBuiltInVisualBaseline } from ${JSON.stringify(path.resolve(import.meta.dir, '../webview/src/helpers/theme.ts'))};
  (window as any).createWidthEditor = createEditor;
  (window as any).applyTableTheme = applyBuiltInVisualBaseline;
  (window as any).startTables = () => {
    (window as any).tableController = createPreviewTableLayoutController(document);
  };
`);
const markdown = Array.from({ length: 80 }, (_, index) => (
  `| Metric ${index} | Description | Value |\n|---|---|---|\n| row-${index} | A_long_word_with_中文_and_emoji_😀_that_must_wrap | ${index} |`
)).join('\n\n');
const payload = exportRuntime.renderPreviewDocument({
  markdownText: markdown, sourceDocumentPath: 'C:/table-layout.md', uiLanguage: 'en'
});

try {
  const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
  assert.ok(build.success, build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    for (const width of [280, 640, 1100]) {
      for (const theme of ['light', 'dark'] as const) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 720, deviceScaleFactor: 1.5 });
        await page.setContent(`<!doctype html><style>${payload.styles[theme]}</style><main class="meo-export-doc">${payload.html}</main>`);
        await page.addScriptTag({ content: await build.outputs[0].text() });
        const client = await page.createCDPSession();
        await client.send('Performance.enable');
        for (const stage of ['initial', 'cached', 'content', 'font', 'resize']) {
          if (stage === 'resize') await page.setViewport({ width: width + 95, height: 720, deviceScaleFactor: 1.5 });
          const before = (await client.send('Performance.getMetrics')).metrics;
          await page.evaluate(stage => {
            if (stage === 'initial') (window as any).startTables();
            else {
              if (stage === 'content') document.querySelector('td')!.textContent = 'Changed longer content '.repeat(8);
              if (stage === 'font') document.querySelector<HTMLElement>('main')!.style.fontSize = '22px';
              (window as any).tableController.refresh();
            }
            void document.body.offsetHeight;
          }, stage);
          const after = (await client.send('Performance.getMetrics')).metrics;
          const layouts = after.find(item => item.name === 'LayoutCount')!.value
            - before.find(item => item.name === 'LayoutCount')!.value;
          // Enforce bounded layout work without a machine-dependent time budget.
          // The former per-table read/write loop incurred 320 layouts here.
          assert.ok(layouts <= 16, JSON.stringify({ width, theme, stage, layouts }));
          const geometry = await page.evaluate(() => Array.from(
            document.querySelectorAll<HTMLTableElement>('.meo-table-scroll > table')
          ).map(table => {
            const wrapper = table.parentElement!;
            return {
              rightOverhang: table.getBoundingClientRect().right
                - (wrapper.getBoundingClientRect().left + wrapper.clientLeft + wrapper.clientWidth),
              cellWidths: Array.from(table.rows[0].cells).map(cell => cell.getBoundingClientRect().width)
            };
          }));
          assert.equal(geometry.length, 80);
          assert.ok(geometry.every(table => table.rightOverhang <= 0.1
            && table.cellWidths.every(value => value > 0)), JSON.stringify({ width, theme, stage, geometry }));
        }
        await page.evaluate(() => (window as any).tableController.dispose());
        await page.close();
      }
    }
    const description = '这段说明包含需要换行的正文，应该使用短列以外的剩余宽度。'.repeat(8);
    const labels = Array.from({ length: 12 }, (_, index) => String(index + 1));
    const narrowMarkdown = `| ${labels.join(' | ')} |\n| ${labels.map(() => '---').join(' | ')} |\n| ${labels.map(() => '内容 abc').join(' | ')} |`;
    const narrowHtml = `<table><tr>${labels.map(label => `<th>${label}</th>`).join('')}</tr><tr>${labels.map(() => '<td>内容 abc</td>').join('')}</tr></table>`;
    const fixture = [
      '| ID | 状态 | 说明 |', '| --- | --- | --- |', `| 1 | 完成 | **说明** ${description} |`, '',
      `<table><thead><tr><th>ID</th><th>状态</th><th>说明</th></tr></thead><tbody><tr><td>1</td><td>完成</td><td><strong>说明</strong> ${description}</td></tr></tbody></table>`, '',
      `<table><tbody><tr><td rowspan="2">ID</td><td>状态</td></tr><tr><td>完成</td><td>${description}</td></tr><tr><td colspan="2">合计</td><td>1</td></tr></tbody></table>`, '',
      narrowMarkdown, '', narrowHtml
    ].join('\n');
    const fittedPayload = exportRuntime.renderPreviewDocument({ markdownText: fixture, sourceDocumentPath: 'C:/table-layout.md', uiLanguage: 'en' });
    for (const width of [360, 720]) for (const theme of ['light', 'dark'] as const) {
      for (const surface of ['preview', 'live'] as const) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 1600, deviceScaleFactor: 1.5 });
        await page.setContent(surface === 'preview'
          ? `<!doctype html><style>${fittedPayload.styles[theme]}</style><main class="meo-export-doc">${fittedPayload.html}</main>`
          : `<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-${theme}"><div id="app"></div></body>`);
        if (surface === 'live') await page.addStyleTag({ path: path.resolve('webview/src/styles.css') });
        await page.addScriptTag({ content: await build.outputs[0].text() });
        await page.evaluate(({ surface, text, theme }) => {
          const g = window as any;
          if (surface === 'preview') g.startTables();
          else {
            g.applyTableTheme(theme);
            g.widthEditor = g.createWidthEditor({ parent: document.getElementById('app'), text, initialMode: 'live', onApplyChanges() {} });
          }
        }, { surface, text: fixture, theme });
        const selector = surface === 'preview' ? '.meo-table-scroll > table, .meo-export-html-block table'
          : '.meo-md-html-table:not(.meo-md-html-table-sticky-table), .meo-md-html-content table';
        await page.waitForFunction(selector => {
          const tables = Array.from(document.querySelectorAll<HTMLTableElement>(selector));
          return tables.length === 5 && tables.every(table => table.style.tableLayout === 'fixed');
        }, {}, selector);
        const geometry = await page.$$eval(selector, tables => tables.map(table => {
          const element = table as HTMLTableElement;
          const cells = Array.from(element.rows[0].cells);
          const wrapper = element.closest<HTMLElement>('.meo-table-scroll, .meo-export-html-block, .meo-md-html-content, .meo-md-html-table-wrap')!;
          return {
            widths: cells.map(cell => cell.getBoundingClientRect().width),
            columns: element.querySelectorAll(':scope > colgroup > col').length,
            overhang: element.getBoundingClientRect().right - wrapper.getBoundingClientRect().right,
            scroll: wrapper.scrollWidth - wrapper.clientWidth
          };
        }));
        assert.ok(geometry.every((table, index) => table.columns === (index < 3 ? 3 : 12) && table.overhang <= 1 && table.scroll <= 1),
          JSON.stringify({ surface, width, theme, geometry }));
        for (const table of geometry.slice(0, 2)) {
          assert.ok(table.widths[2] > table.widths[0] * 2 && table.widths[2] > table.widths[1] * 2,
            JSON.stringify({ surface, width, theme, geometry }));
        }
        if (width === 720 && theme === 'dark') {
          fs.mkdirSync(path.resolve('tmp'), { recursive: true });
          await page.screenshot({ path: path.resolve(`tmp/table-width-layout-${surface}.png`) });
        }
        if (surface === 'live') {
          await page.evaluate(() => (window as any).widthEditor.setMode('source'));
          assert.equal(await page.evaluate(() => (window as any).widthEditor.getText()), fixture);
          await page.evaluate(() => (window as any).widthEditor.setMode('live'));
          await page.waitForFunction(() => document.querySelector('.meo-md-html-content table')?.getAttribute('style')?.includes('table-layout: fixed'));
          await page.evaluate(() => (window as any).widthEditor.destroy());
        } else await page.evaluate(() => (window as any).tableController.dispose());
        await page.close();
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
  console.log('Table layout: batched reads/writes, compact columns, Markdown/HTML, merged cells, Live/Source round trips and theme/container fitting passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
