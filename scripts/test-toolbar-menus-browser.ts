import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 700 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ content: ':root{--vscode-font-family:"Segoe WPC","Segoe UI",sans-serif}' });
  const assertSegmentedLabelAlignment = async () => {
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const labels = await page.$$eval('.segmented-control-button', buttons => buttons
      .filter(button => button.getBoundingClientRect().width > 0)
      .map(button => {
        const label = button.querySelector('.segmented-control-button-label')!.getBoundingClientRect();
        const indicator = button.querySelector('.segmented-control-button-indicator')!.getBoundingClientRect();
        return { text: button.textContent, offset: (label.top + label.bottom - indicator.top - indicator.bottom) / 2 };
      }));
    assert.ok(labels.length > 0 && labels.every(label => Math.abs(label.offset) <= 0.05),
      `Segmented labels should share the pill's vertical center: ${JSON.stringify(labels)}`);
  };
  await page.exposeFunction('__renderPreview', (message: any) => exportRuntime.renderPreviewDocument({
    markdownText: message.text, sourceDocumentPath: 'C:/tmp/preview-toolbar.md', uiLanguage: message.uiLanguage,
    styleEnvironment: message.environment, preset: message.preset, contentWidth: message.contentWidth
  }));
  await page.addScriptTag({ content: `window.__hostMessages=[];window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__hostMessages.push(message);if(message.type==='requestPreviewRender')window.__renderPreview(message).then(value=>window.dispatchEvent(new MessageEvent('message',{data:{type:'previewRenderResult',requestId:message.requestId,result:{ok:true,value}}})));}});` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const text = '# Export menu';
  await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///preview-export-menu.md', text, version: 1,
    savedRevision: { version: 1, text }, diagnostics: [], mode: 'preview', uiLanguage: 'zh-CN',
    sourceLineNumbers: 'on', previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true,
    previewShowComments: false,
    editorAppearance: 'dark', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
    contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
    outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null
  } })), text);
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'preview');
  await page.waitForFunction(() => !document.querySelector('.meo-preload-toolbar'));

  const options = [
    ['html', false], ['html', true], ['pdf', false], ['pdf', true], ['docx', false], ['docx', true]
  ] as const;
  assert.deepEqual(await page.$$eval('.preview-format-group > div', elements => elements.map(element => element.className)), [
    'preview-select-control preview-preset-control',
    'preview-select-control preview-setting-control preview-appearance-control',
    'preview-options-control', 'preview-export-control'
  ]);
  await page.hover('.preview-preset-dropdown');
  assert.equal(await page.$eval('.preview-preset-dropdown-panel', element => (element as HTMLElement).hidden), true, 'Preset selection still requires a click');
  assert.equal(await page.$eval('.preview-preset-dropdown', element => element.hasAttribute('data-tooltip') || element.hasAttribute('title')), false);
  await page.click('.preview-preset-dropdown');
  await page.hover('.preview-preset-dropdown-panel [data-value="github-readme"]');
  await page.waitForFunction(() => {
    const hint = document.querySelector<HTMLElement>('.meo-tooltip.is-visible');
    return hint?.dataset.side === 'right' && hint.textContent?.includes('与真实 GitHub README 的差异');
  });
  assert.equal(await page.$eval('.preview-preset-dropdown-panel', element => (element as HTMLElement).hidden), false, 'Preset explanations keep the selection menu open');
  mkdirSync('tmp/preview-toolbar', { recursive: true });
  await page.screenshot({ path: 'tmp/preview-toolbar/preset-hover-dark-zh.png' });
  await page.click('.preview-preset-dropdown-panel [data-value="default"]');
  await page.hover('.preview-options-trigger');
  assert.equal(await page.$eval('.preview-options-panel', el => (el as HTMLElement).hidden), true, 'Hover does not open Preview Options');
  await page.click('.preview-options-trigger');
  await page.waitForFunction(() => document.querySelector('.preview-options-trigger')?.getAttribute('aria-expanded') === 'true');
  assert.equal(await page.$eval('.preview-options-trigger svg', element => element.getAttribute('data-icon')), 'settings-2');
  const hoverGap = await page.$eval('.preview-options-trigger', element => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.bottom + 2 };
  });
  await page.mouse.move(hoverGap.x, hoverGap.y);
  await page.hover('.preview-font-family-dropdown');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 160)));
  assert.equal(await page.$eval('.preview-options-panel', element => (element as HTMLElement).hidden), false, 'Moving across the gap into Preview Options keeps it open');
  await page.mouse.move(0, 0);
  assert.equal(await page.$eval('.preview-options-panel', el => (el as HTMLElement).hidden), false, 'Pointer exit keeps options open');
  await page.click('.preview-options-trigger');
  await page.click('.preview-options-trigger');
  assert.equal(await page.$eval('.preview-options-panel', element => (element as HTMLElement).hidden), false, 'Clicking the already hovered Preview Options keeps it open');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.preview-options-panel', element => (element as HTMLElement).hidden), true, 'Escape stays closed after restoring Preview Options trigger focus');
  await page.mouse.move(0, 0);
  await page.hover('.preview-options-trigger');
  await page.click('.preview-options-trigger');
  assert.deepEqual(await page.$$eval('.preview-options-panel > .preview-select-control', elements => elements.map(element => ({
    visible: (element as HTMLElement).getBoundingClientRect().height > 0, label: element.querySelector('.preview-select-label')?.textContent
  }))), ['正文字体', '代码字体', '正文宽度', '代码着色', 'HTML 注释'].map(label => ({ visible: true, label })));
  assert.equal(await page.$eval('.preview-width-dropdown', button => (button as HTMLButtonElement).disabled), true);
  await page.hover('.preview-width-dropdown');
  await page.waitForFunction(() => document.querySelector('.meo-tooltip.is-visible .meo-tooltip-label')?.textContent === '此预设不支持此选项');
  await page.click('.preview-width-dropdown');
  assert.equal(await page.$eval('.preview-options-panel', panel => (panel as HTMLElement).hidden), false, 'Clicking a disabled option keeps Preview Options open');
  assert.equal(await page.$eval('.meo-tooltip.is-visible .meo-tooltip-label', label => label.textContent), '此预设不支持此选项', 'A disabled option retains its explanation after a click');
  await page.click('.preview-width-control .preview-select-label');
  assert.equal(await page.$eval('.meo-tooltip.is-visible .meo-tooltip-label', label => label.textContent), '此预设不支持此选项', 'Clicking the disabled setting label also retains its explanation');
  mkdirSync('tmp/preview-toolbar', { recursive: true });
  await page.screenshot({ path: 'tmp/preview-toolbar/options-dark-zh.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.preview-options-panel', panel => (panel as HTMLElement).hidden), true);
  await page.focus('.preview-options-trigger');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('preview-font-family-dropdown')), true);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.preview-font-family-dropdown-panel', panel => (panel as HTMLElement).hidden), true);
  assert.equal(await page.$eval('.preview-options-panel', panel => (panel as HTMLElement).hidden), false, 'Escape closes a nested dropdown before the options panel');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.preview-options-panel', panel => (panel as HTMLElement).hidden), true);
  assert.equal(await page.$eval('.preview-export-trigger', element => element.textContent?.trim()), '导出为…');
  assert.equal(await page.$eval('.preview-export-trigger svg path', path => path.getAttribute('d')?.startsWith('M14 17a1 1 0 1 0 0 2z') && path.getAttribute('fill') === 'currentColor'), true);
  assert.equal(await page.$$eval('.preview-export-menu-action', elements => elements.length), 6);
  const formatIconColors = await page.$$eval('.preview-export-menu-action', elements => elements.map(element => {
    const icon = element.querySelector('img');
    const svg = icon ? decodeURIComponent(icon.src.split(',')[1] ?? '') : '';
    const pageFill = svg.match(/<path fill="(#[0-9a-f]{6})" d="M6 2h8l6 6/)?.[1];
    return [element.getAttribute('data-format'), icon?.getAttribute('src')?.startsWith('data:image/svg+xml,'),
      pageFill, (svg.match(/<path /g) ?? []).length, svg.match(/transform="(translate\(0 -\d\))"/)?.[1],
      svg.includes('fill="#fff"') || svg.includes('stroke="#fff"')];
  }));
  assert.deepEqual(formatIconColors, options.map(([format]) => [format, true,
    { html: '#e65100', pdf: '#ef5350', docx: '#01579b' }[format], 2,
    { html: 'translate(0 -1)', pdf: 'translate(0 -1)', docx: 'translate(0 -3)' }[format], true
  ]));
  await page.click('.preview-options-trigger');
  await page.click('.preview-font-family-dropdown');
  await page.hover('.preview-export-trigger');
  assert.equal(await page.$eval('.preview-options-panel', panel => (panel as HTMLElement).hidden), true, 'Export dismisses the options menu');
  assert.equal(await page.$eval('.preview-font-family-dropdown-panel', panel => (panel as HTMLElement).hidden), true, 'Dismissing options also closes its nested dropdown');
  await page.hover('.preview-options-trigger');
  assert.equal(await page.$eval('.preview-options-panel', el => (el as HTMLElement).hidden), true, 'Hover does not open Preview Options');
  await page.click('.preview-options-trigger');
  await page.waitForFunction(() => document.querySelector('.preview-options-trigger')?.getAttribute('aria-expanded') === 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.preview-options-panel', panel => (panel as HTMLElement).hidden), true, 'Escape dismisses Preview Options while its trigger remains hovered');
  await page.mouse.move(0, 0);
  for (const [format, includeTableOfContents] of options) {
    await page.hover('.preview-export-trigger');
    await page.waitForFunction(() => getComputedStyle(document.querySelector<HTMLElement>('.preview-export-menu')!).visibility === 'visible');
    const geometry = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('.preview-export-trigger')!.getBoundingClientRect();
      const menu = document.querySelector<HTMLElement>('.preview-export-menu')!.getBoundingClientRect();
      const menuStyle = getComputedStyle(document.querySelector<HTMLElement>('.preview-export-menu')!);
      const tableStyle = getComputedStyle(document.querySelector<HTMLElement>('.table-dropdown')!);
      return {
        below: menu.top >= button.bottom,
        leftAligned: Math.abs(menu.left - button.left) <= 0.5,
        inViewport: menu.left >= 0 && menu.right <= innerWidth,
        sameSurface: menuStyle.backgroundColor === tableStyle.backgroundColor
          && menuStyle.borderTopColor === tableStyle.borderTopColor
      };
    });
    assert.deepEqual(geometry, { below: true, leftAligned: true, inViewport: true, sameSurface: true });
    await page.click(`.preview-export-menu-action[data-format="${format}"][data-include-table-of-contents="${includeTableOfContents}"]`);
    assert.equal(await page.$eval('.preview-export-trigger', element => element.getAttribute('aria-expanded')), 'false');
    await page.mouse.move(0, 0);
  }
  const requests = await page.evaluate(() => (
    (window as typeof window & { __hostMessages: Array<{ type: string; format?: string; includeTableOfContents?: boolean }> }).__hostMessages
      .filter(message => message.type === 'exportDocument')
      .map(({ format, includeTableOfContents }) => [format, includeTableOfContents])
  ));
  assert.deepEqual(requests, options.map(option => [...option]));
  const exportState = () => page.$eval('.preview-export-menu', menu => ({
    expanded: document.querySelector('.preview-export-trigger')!.getAttribute('aria-expanded'),
    opacity: getComputedStyle(menu).opacity, visibility: getComputedStyle(menu).visibility
  }));
  await page.hover('.preview-export-trigger');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.preview-export-menu')!).opacity === '1');
  await page.mouse.move(4, 400);
  assert.deepEqual(await exportState(), { expanded: 'true', opacity: '1', visibility: 'visible' }, 'Pointer exit preserves the interactive menu during the close delay');
  await page.hover('.preview-export-menu-action');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 450)));
  assert.equal((await exportState()).expanded, 'true', 'Entering the menu cancels the pending close');
  await page.mouse.move(4, 400);
  await page.waitForFunction(() => document.querySelector('.preview-export-trigger')!.getAttribute('aria-expanded') === 'false');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.preview-export-menu')!).visibility === 'hidden');
  await page.hover('.preview-export-trigger');
  await page.keyboard.press('Escape');
  assert.deepEqual(await exportState(), { expanded: 'false', opacity: '0', visibility: 'hidden' }, 'Escape closes immediately even while hovered');
  await page.mouse.move(4, 400); await page.hover('.preview-export-trigger');
  await page.mouse.click(4, 10);
  assert.deepEqual(await exportState(), { expanded: 'false', opacity: '0', visibility: 'hidden' }, 'An outside click closes immediately');
  await page.hover('.preview-export-trigger');
  const frameBounds = (await page.$('.preview-frame'))!;
  const frameRect = (await frameBounds.boundingBox())!;
  await page.mouse.click(frameRect.x + 20, frameRect.y + 20);
  assert.deepEqual(await exportState(), { expanded: 'false', opacity: '0', visibility: 'hidden' }, 'Clicking the Preview iframe also closes immediately');
  await page.$eval('.preview-export-trigger', element => (element as HTMLElement).focus());
  await page.keyboard.press('ArrowDown');
  await page.mouse.move(4, 400);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 450)));
  assert.equal((await exportState()).expanded, 'true', 'Keyboard focus inside the menu survives pointer exit');
  await page.keyboard.press('Escape');
  await page.hover('.preview-export-trigger');
  await page.click('.preview-export-trigger');
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => getComputedStyle(document.querySelector<HTMLElement>('.preview-export-menu')!).visibility === 'hidden');
  assert.equal(await page.$eval('.preview-export-trigger', element => element.getAttribute('aria-expanded')), 'false');
  await page.setViewport({ width: 420, height: 700 });
  await page.waitForFunction(() => document.querySelector('.toolbar-overflow-panel .preview-export-control'));
  await page.click('.toolbar-overflow-indicator');
  await page.hover('.preview-export-trigger');
  const narrowMenu = await page.$eval('.preview-export-menu', element => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, visibility: getComputedStyle(element).visibility };
  });
  assert.equal(narrowMenu.visibility, 'visible');
  assert.ok(narrowMenu.left >= 0 && narrowMenu.right <= 420, JSON.stringify(narrowMenu));
  await page.setViewport({ width: 1400, height: 700 });
  await page.click('.more-tools-wrapper > .format-button');
  const settingsChoices = [
    '.ui-language-button[data-ui-language="zh-CN"]',
    '.ui-language-button[data-ui-language="en"]',
    '.ui-language-button[data-ui-language="auto"]',
    '.editor-appearance-button[data-editor-appearance="light"]',
    '.editor-appearance-button[data-editor-appearance="dark"]',
    '.editor-appearance-button[data-editor-appearance="auto"]',
    '.editor-font-size-mode-button[data-editor-font-size-mode="custom"]',
    '.editor-font-size-mode-button[data-editor-font-size-mode="auto"]'
  ];
  const modeWidthsByLanguage: number[] = [];
  for (const [language, label, choices] of [['zh-CN', 'HTML 注释', ['显示', '隐藏']], ['en', 'HTML comments', ['Show', 'Hide']]] as const) {
    await page.click(`.ui-language-button[data-ui-language="${language}"]`);
    assert.equal(await page.$eval('.preview-show-comments .preview-select-label', element => element.textContent), label);
    assert.deepEqual(await page.$$eval('.preview-show-comments .segmented-control-button-label', elements => elements.map(element => element.textContent)), [...choices]);
  }
  for (const selector of settingsChoices) {
    await page.click(selector);
    const menuState = await page.evaluate(() => ({
      hidden: document.querySelector<HTMLElement>('.more-tools-panel')!.hidden,
      expanded: document.querySelector<HTMLElement>('.more-tools-wrapper > .format-button')!.getAttribute('aria-expanded')
    }));
    assert.deepEqual(menuState, { hidden: false, expanded: 'true' }, selector);
    if (selector === '.ui-language-button[data-ui-language="en"]') {
      const clippedLabels = await page.$$eval('.more-tools-control-label', labels => labels
        .filter(label => label.scrollWidth > label.clientWidth)
        .map(label => label.textContent));
      assert.deepEqual(clippedLabels, []);
    }
    if (selector.includes('data-ui-language')) {
      const modeLayout = await page.$eval('.mode-group', control => ({
        width: control.getBoundingClientRect().width,
        optionWidths: Array.from(control.querySelectorAll<HTMLElement>('.mode-button'))
          .map(button => button.getBoundingClientRect().width),
        contentFits: Array.from(control.querySelectorAll<HTMLElement>('.mode-button'))
          .every(button => {
            const content = button.querySelector<HTMLElement>('.segmented-control-button-content')!.getBoundingClientRect();
            const bounds = button.getBoundingClientRect();
            return content.left >= bounds.left && content.right <= bounds.right;
          })
      }));
      modeWidthsByLanguage.push(modeLayout.width);
      assert.ok(modeLayout.optionWidths.every(width => Math.abs(width - (170 - 4) / 3) <= 0.05) && modeLayout.contentFits, JSON.stringify(modeLayout));
    }
  }
  assert.deepEqual(modeWidthsByLanguage, [170, 170, 170]);
  for (const action of [
    'sourceLineNumbers', 'longCodeBlockFolding', 'contentMaxWidth', 'liveStrongColoring',
    'boldHeadings', 'tableStickyHeader'
  ]) {
    const selector = `.more-tools-panel [data-action="${action}"]`;
    if (await page.$eval(selector, button => (button as HTMLButtonElement).disabled)) continue;
    await page.click(selector);
    assert.equal(await page.$eval('.more-tools-panel', panel => (panel as HTMLElement).hidden), false, action);
  }
  const settingsLayout = await page.evaluate(() => {
    const controls = [
      '.editor-appearance-control', '.ui-language-control', '.editor-font-size-mode-control'
    ].map(selector => document.querySelector<HTMLElement>(selector)!);
    return {
      controls: controls.map(control => ({
        left: control.getBoundingClientRect().left,
        right: control.getBoundingClientRect().right,
        configuredWidth: control.style.width,
        optionWidths: Array.from(control.querySelectorAll<HTMLElement>('.segmented-control-button'))
          .map(button => button.getBoundingClientRect().width),
        contentFits: Array.from(control.querySelectorAll<HTMLElement>('.segmented-control-button'))
          .every(button => {
            const content = button.querySelector<HTMLElement>('.segmented-control-button-content')!.getBoundingClientRect();
            const bounds = button.getBoundingClientRect();
            return content.left >= bounds.left && content.right <= bounds.right;
          })
      })),
      stepperRight: document.querySelector<HTMLElement>('.editor-font-size-stepper')!.getBoundingClientRect().right,
      stepperLeft: document.querySelector<HTMLElement>('.editor-font-size-stepper')!.getBoundingClientRect().left,
      modeWidth: document.querySelector<HTMLElement>('.mode-group')!.style.width
    };
  });
  assert.equal(settingsLayout.modeWidth, '170px');
  assert.ok(settingsLayout.controls.every(control => control.configuredWidth === '100%' && control.contentFits), JSON.stringify(settingsLayout));
  assert.ok(Math.max(...settingsLayout.controls.map(control => control.left))
    - Math.min(...settingsLayout.controls.map(control => control.left)) <= 0.5, JSON.stringify(settingsLayout));
  assert.ok(Math.abs(settingsLayout.controls[0].right - settingsLayout.controls[1].right) <= 0.5, JSON.stringify(settingsLayout));
  assert.ok(Math.abs(settingsLayout.controls[1].right - settingsLayout.stepperRight) <= 0.5, JSON.stringify(settingsLayout));
  assert.ok(Math.abs(settingsLayout.stepperLeft - settingsLayout.controls[2].right - 4) <= 0.5, JSON.stringify(settingsLayout));
  assert.ok(settingsLayout.controls.every(control => Math.max(...control.optionWidths) - Math.min(...control.optionWidths) <= 0.5), JSON.stringify(settingsLayout));
  await page.click('.editor-appearance-button[data-editor-appearance="light"]');
  await page.click('.preview-options-trigger');
  const segmentSpacing = await page.$eval('.preview-show-comments [data-preview-comments="false"]', button => {
    const outer = button.getBoundingClientRect();
    const content = button.querySelector<HTMLElement>('.segmented-control-button-content')!.getBoundingClientRect();
    return { horizontal: (outer.width - content.width) / 2, vertical: (outer.height - content.height) / 2 };
  });
  assert.ok(Math.abs(segmentSpacing.horizontal - segmentSpacing.vertical) <= 3, JSON.stringify(segmentSpacing));
  await page.screenshot({ path: 'tmp/preview-toolbar/options-light-zh.png' });
  const segmentGaps = await page.$eval('.preview-show-comments', control => {
    const outer = control.querySelector<HTMLElement>('.segmented-control')!.getBoundingClientRect();
    const indicators = Array.from(control.querySelectorAll<HTMLElement>('.segmented-control-button-indicator'))
      .map(element => element.getBoundingClientRect());
    return {
      outerLeft: indicators[0].left - outer.left,
      between: indicators[1].left - indicators[0].right,
      outerRight: outer.right - indicators[1].right
    };
  });
  assert.deepEqual(segmentGaps, { outerLeft: 2, between: 0, outerRight: 2 }, 'shared outer insets preserve seamless internal segments');
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations()
      .filter(animation => (animation.effect as KeyframeEffect | null)?.target instanceof Element
        && ((animation.effect as KeyframeEffect).target as Element).classList.contains('segmented-control-button-indicator'))
      .map(animation => animation.finished));
  });
  const segmentCenters = await page.$$eval('.segmented-control', controls => controls
    .filter(control => control.getBoundingClientRect().width > 0)
    .flatMap(control => Array.from(control.querySelectorAll('.segmented-control-button')).map(button => {
      const indicator = button.querySelector('.segmented-control-button-indicator')!.getBoundingClientRect();
      const content = button.querySelector('.segmented-control-button-content')!.getBoundingClientRect();
      return { text: button.textContent, offset: (content.left + content.right - indicator.left - indicator.right) / 2 };
    })));
  assert.ok(segmentCenters.every(segment => Math.abs(segment.offset) <= 0.05), JSON.stringify(segmentCenters));
  for (const scale of [1, 1.2, 2]) {
    await page.setViewport({ width: 1400, height: 700, deviceScaleFactor: scale });
    await assertSegmentedLabelAlignment();
  }
  await page.setViewport({ width: 1400, height: 700, deviceScaleFactor: 1 });
  await page.mouse.click(4, 10);
  assert.equal(await page.$eval('.more-tools-panel', panel => (panel as HTMLElement).hidden), true);
  assert.equal(await page.$eval('.preview-options-panel', panel => (panel as HTMLElement).hidden), true);
  await page.click('.more-tools-wrapper > .format-button');
  await page.click('.ui-language-button[data-ui-language="en"]');
  await page.click('.editor-appearance-button[data-editor-appearance="dark"]');
  await page.click('.preview-options-trigger');
  assert.deepEqual(await page.$$eval('.preview-options-panel .preview-select-label', labels => labels.map(label => label.textContent)), ['Body font', 'Code font', 'Width', 'Code color', 'HTML comments']);
  for (const scale of [1, 1.2, 2]) {
    await page.setViewport({ width: 1400, height: 700, deviceScaleFactor: scale });
    await assertSegmentedLabelAlignment();
  }
  await page.setViewport({ width: 1400, height: 700, deviceScaleFactor: 1 });
  await page.screenshot({ path: 'tmp/preview-toolbar/options-dark-en.png' });
  await page.keyboard.press('Escape');
  await page.setViewport({ width: 420, height: 700 });
  await page.waitForFunction(() => document.querySelector('.toolbar-overflow-panel .preview-options-control'));
  await page.click('.toolbar-overflow-indicator');
  await page.click('.preview-options-trigger');
  await page.click('.preview-font-family-dropdown');
  assert.equal(await page.$eval('.toolbar-overflow-panel', panel => (panel as HTMLElement).hidden), false, 'Nested option controls keep the overflow menu open');
  await page.click('.preview-font-family-dropdown-panel .preview-font-results [role="option"]:first-child');
  assert.equal(await page.$eval('.preview-font-family-dropdown-panel', panel => (panel as HTMLElement).hidden), false);
  assert.equal(await page.$eval('.preview-options-panel', panel => (panel as HTMLElement).hidden), false);
  const optionsBounds = await page.$eval('.preview-options-panel', panel => {
    const bounds = panel.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
  });
  assert.ok(optionsBounds.left >= 0 && optionsBounds.right <= 420 && optionsBounds.top >= 0 && optionsBounds.bottom <= 700, JSON.stringify(optionsBounds));
  await page.screenshot({ path: 'tmp/preview-toolbar/options-narrow-en.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.preview-font-family-dropdown-panel', panel => (panel as HTMLElement).hidden), true, 'First Escape dismisses the font comparison');
  assert.equal(await page.$eval('.preview-options-panel', panel => (panel as HTMLElement).hidden), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.toolbar-overflow-panel', panel => (panel as HTMLElement).hidden), false, 'Second Escape dismisses options');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.toolbar-overflow-panel', panel => (panel as HTMLElement).hidden), true, 'Third Escape dismisses overflow');
  await page.setViewport({ width: 1400, height: 700 });
  await page.waitForFunction(() => document.querySelector('.preview-format-group .preview-export-control'));
  for (const language of ['zh-CN', 'en']) for (const appearance of ['light', 'dark']) {
    await page.click('.more-tools-wrapper > .format-button');
    await page.click(`.ui-language-button[data-ui-language="${language}"]`);
    await page.click(`.editor-appearance-button[data-editor-appearance="${appearance}"]`);
    await page.click('.more-tools-wrapper > .format-button');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.$eval('.preview-export-trigger', el => el.textContent?.trim()), language === 'zh-CN' ? '导出为…' : 'Export as…');
    await page.hover('.preview-export-trigger');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.preview-export-menu')!).opacity === '1');
    assert.equal(await page.$eval('.preview-export-trigger .preview-toolbar-action-label', el => el.scrollWidth <= el.clientWidth), true, 'Export wording fits the toolbar');
    await page.screenshot({ path: `tmp/preview-toolbar/export-${appearance}-${language}.png` });
    await page.keyboard.press('Escape');
  }
  await page.close();
  console.log('Toolbar menus browser test passed.');
} finally {
  await browser.close();
}
