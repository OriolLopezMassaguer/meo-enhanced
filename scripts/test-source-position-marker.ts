import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({
  entrypoints: ['scripts/test-settings-window-production-entry.ts'],
  target: 'browser',
  format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 720 });
  await page.exposeFunction('__renderSourcePositionPreview', async (message: any) => {
    if (message.type !== 'requestPreviewRender') return null;
    return {
      type: 'previewRenderResult',
      requestId: message.requestId,
      result: {
        ok: true,
        value: exportRuntime.renderPreviewDocument({
          markdownText: message.text,
          sourceDocumentPath: 'C:/tmp/source-position-marker.md',
          uiLanguage: message.uiLanguage,
          styleEnvironment: message.environment
        })
      }
    };
  });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){return {}},setState(){},postMessage(message){window.__renderSourcePositionPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });

  const text = [
    '# Marker fixture',
    '',
    'The first paragraph stays visible in Source.',
    'A multiline paragraph starts here.\nIts second source line shares one rendered paragraph.',
    '> An indented quotation must not move the Preview locator horizontally.',
    '- An indented list item must use the same Preview locator gutter.',
    '- Reverse locator middle item.',
    '- Reverse locator lower item.',
    '```text\n' + Array.from({ length: 60 }, (_, index) => `Locator code line ${index}`).join('\n') + '\n```',
    ...Array.from({ length: 90 }, (_, index) => (
      `## Section ${index + 1}\n\nParagraph ${index + 1} with enough text to create a distant Preview position.`
    )),
    '## Nested locator fixture',
    '- [ ] > A task followed by a quote marker.\n- > - [ ] Nested task for bottom-edge navigation.',
    'Following paragraph keeps the nested task independently scrollable.',
    '<!-- Hidden source-only navigation target -->'
  ].join('\n\n');
  await page.evaluate(text => {
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', documentId: 'file:///source-position-marker.md', text, version: 1,
      savedRevision: { version: 1, text }, diagnostics: [], mode: 'source', uiLanguage: 'en',
      uiLanguagePreference: 'auto', automaticUiLanguage: 'en', sourceLineNumbers: 'on',
      previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
      editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
      gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
      diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
      contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
      outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
      restoreReadingPositionOnOpen: false, vscodeTheme: null
    } }));
  }, text);
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLElement>('.source-preview-button');
    return button?.offsetParent !== null && getComputedStyle(button).visibility === 'visible';
  });
  await page.click('.source-preview-button');
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
    const previewHost = document.querySelector<HTMLElement>('.preview-host');
    return document.querySelector('.editor-surface')?.hasAttribute('data-source-preview')
      && frame?.contentDocument?.body.textContent?.includes('Section 90')
      && previewHost?.inert === false
      && getComputedStyle(previewHost).visibility !== 'hidden'
      && !frame.contentDocument?.querySelector<HTMLElement>('.meo-preview-source-position-marker')?.hidden;
  });
  await new Promise(resolve => setTimeout(resolve, 120));

  const markerPresentation = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    const style = frameDocument.defaultView!.getComputedStyle(marker);
    const cursor = marker.querySelector<HTMLElement>('.meo-preview-source-position-cursor')!;
    const rail = marker.querySelector<HTMLElement>('.meo-preview-source-position-rail')!;
    const cursorRect = cursor.getBoundingClientRect();
    const readingRoot = frameDocument.querySelector<HTMLElement>('main.meo-export-doc')!;
    const activeLineBackground = getComputedStyle(document.querySelector<HTMLElement>('.cm-activeLine')!).backgroundColor;
    return {
      active: marker.classList.contains('is-active'),
      line: marker.dataset.meoSourcePositionLine,
      width: Number.parseFloat(style.width),
      height: Number.parseFloat(style.height),
      position: style.position,
      pointerEvents: style.pointerEvents,
      backgroundColor: style.backgroundColor,
      activeLineBackground,
      zIndex: style.zIndex,
      kind: marker.dataset.meoSourcePositionKind,
      ownerDocument: marker.ownerDocument === frameDocument,
      parentIsReadingRoot: marker.parentElement === readingRoot,
      cursorWidth: cursorRect.width,
      cursorDisplay: frameDocument.defaultView!.getComputedStyle(cursor).display,
      railDisplay: frameDocument.defaultView!.getComputedStyle(rail).display,
      usesTextCursorIcon: cursor.querySelector('svg')?.classList.contains('lucide-text-cursor'),
      railBorderRadius: frameDocument.defaultView!.getComputedStyle(rail).borderRadius,
      markerLeft: marker.getBoundingClientRect().left,
      markerRight: marker.getBoundingClientRect().right,
      positioningWidth: marker.offsetParent!.getBoundingClientRect().width
    };
  });
  assert.equal(markerPresentation.active, true);
  assert.equal(markerPresentation.line, '1');
  assert.ok(markerPresentation.width >= 3, JSON.stringify(markerPresentation));
  assert.ok(markerPresentation.height > 1, JSON.stringify(markerPresentation));
  assert.equal(markerPresentation.position, 'absolute');
  assert.equal(markerPresentation.pointerEvents, 'none');
  assert.notEqual(markerPresentation.backgroundColor, 'rgba(0, 0, 0, 0)', 'Preview locator stays visible with a transparent native Source line highlight');
  assert.equal(markerPresentation.zIndex, '-1');
  assert.equal(markerPresentation.kind, 'line');
  assert.equal(markerPresentation.ownerDocument, true);
  assert.equal(markerPresentation.parentIsReadingRoot, true);
  assert.equal(markerPresentation.cursorWidth, 0);
  assert.equal(markerPresentation.cursorDisplay, 'none');
  assert.equal(markerPresentation.railDisplay, 'none');
  assert.equal(markerPresentation.usesTextCursorIcon, true);
  assert.equal(markerPresentation.railBorderRadius, '0px');
  assert.ok(Math.abs(markerPresentation.markerLeft) <= 0.5, JSON.stringify(markerPresentation));
  assert.ok(Math.abs(markerPresentation.markerRight - markerPresentation.positioningWidth) <= 0.5, JSON.stringify(markerPresentation));

  await page.$eval('.preview-appearance-select', element => {
    const select = element as HTMLSelectElement;
    select.value = 'light';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction((darkBackground) => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    return frameDocument.defaultView!.getComputedStyle(marker).backgroundColor !== darkBackground;
  }, {}, markerPresentation.backgroundColor);
  const lightMarkerBackground = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    return frameDocument.defaultView!.getComputedStyle(marker).backgroundColor;
  });
  assert.notEqual(lightMarkerBackground, 'rgba(0, 0, 0, 0)');
  assert.notEqual(lightMarkerBackground, markerPresentation.backgroundColor, 'Preview locator follows the independently selected Preview theme');
  assert.equal(await page.$eval('.cm-activeLine', element => getComputedStyle(element).backgroundColor), markerPresentation.activeLineBackground,
    'Changing Preview theme must not change the native Source line highlight');
  await page.$eval('.preview-appearance-select', element => {
    const select = element as HTMLSelectElement;
    select.value = 'dark';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction((darkBackground) => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    return frameDocument.defaultView!.getComputedStyle(marker).backgroundColor === darkBackground;
  }, {}, markerPresentation.backgroundColor);

  const nativeScrollAttachment = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    const target = frameDocument.querySelector<HTMLElement>('[data-source-line="1"]')!;
    const before = marker.getBoundingClientRect().top - target.getBoundingClientRect().top;
    frameDocument.scrollingElement!.scrollTop += 80;
    const after = marker.getBoundingClientRect().top - target.getBoundingClientRect().top;
    return { before, after };
  });
  assert.ok(
    Math.abs(nativeScrollAttachment.after - nativeScrollAttachment.before) <= 0.1,
    `Marker must move in the Preview document's native scroll layer: ${JSON.stringify(nativeScrollAttachment)}`
  );

  const multilineSourceTarget = await page.$$eval('.cm-line', elements => {
    const line = elements.find(element => element.textContent?.includes('Its second source line'))!;
    const rect = line.getBoundingClientRect();
    return { x: rect.left + 24, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(multilineSourceTarget.x, multilineSourceTarget.y);
  await new Promise(resolve => setTimeout(resolve, 80));
  const blockProjection = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    const line = Number(marker.dataset.meoSourcePositionLine);
    const mapped = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
      .map(element => ({
        element,
        start: Number(element.dataset.sourceLine),
        end: Number(element.dataset.sourceEndLine ?? element.dataset.sourceLine)
      }))
      .filter(entry => entry.start <= line && entry.end >= line)
      .sort((left, right) => left.start - right.start || right.end - left.end)[0]!;
    const markerRect = marker.getBoundingClientRect();
    const mappedRect = mapped.element.getBoundingClientRect();
    return {
      kind: marker.dataset.meoSourcePositionKind,
      topDelta: markerRect.top - mappedRect.top,
      bottomDelta: markerRect.bottom - mappedRect.bottom
    };
  });
  assert.equal(blockProjection.kind, 'block', JSON.stringify(blockProjection));
  assert.ok(Math.abs(blockProjection.topDelta) <= 0.5, JSON.stringify(blockProjection));
  assert.ok(Math.abs(blockProjection.bottomDelta) <= 0.5, JSON.stringify(blockProjection));

  for (const sourceText of ['An indented quotation', 'An indented list item']) {
    const indentedTarget = await page.$$eval('.cm-line', (elements, expectedText) => {
      const line = elements.find(element => element.textContent?.includes(expectedText))!;
      const rect = line.getBoundingClientRect();
      return { x: rect.left + 24, y: rect.top + rect.height / 2 };
    }, sourceText);
    await page.mouse.click(indentedTarget.x, indentedTarget.y);
    await new Promise(resolve => setTimeout(resolve, 40));
    const markerLeft = await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      return frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!
        .getBoundingClientRect().left;
    });
    assert.ok(
      Math.abs(markerLeft - markerPresentation.markerLeft) <= 0.5,
      `Preview locator must use a fixed horizontal gutter: ${JSON.stringify({ sourceText, markerLeft, expected: markerPresentation.markerLeft })}`
    );
  }

  const sourceTarget = await page.$eval('.cm-line', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + rect.height / 2 };
  });
  const movePreviewToBottom = () => page.evaluate(() => {
    const scrollElement = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!;
    scrollElement.scrollTop = scrollElement.scrollHeight - scrollElement.clientHeight;
    return scrollElement.scrollTop;
  });

  const bottomBeforeKeyboard = await movePreviewToBottom();
  await new Promise(resolve => setTimeout(resolve, 40));
  const lineBeforeKeyboard = await page.evaluate(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
      .querySelector<HTMLElement>('.meo-preview-source-position-marker')!.dataset.meoSourcePositionLine
  ));
  await page.keyboard.press('ArrowDown');
  await new Promise(resolve => setTimeout(resolve, 40));
  const afterKeyboard = await page.evaluate(() => ({
    previewTop: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop,
    markerLine: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
      .querySelector<HTMLElement>('.meo-preview-source-position-marker')!.dataset.meoSourcePositionLine
  }));
  assert.notEqual(afterKeyboard.markerLine, lineBeforeKeyboard);
  assert.ok(Math.abs(afterKeyboard.previewTop - bottomBeforeKeyboard) <= 1, JSON.stringify(afterKeyboard));

  await page.mouse.click(sourceTarget.x, sourceTarget.y);
  await new Promise(resolve => setTimeout(resolve, 80));
  const afterExplicitClick = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    const markerRect = marker.getBoundingClientRect();
    return {
      previewTop: frameDocument.scrollingElement!.scrollTop,
      visible: markerRect.bottom > 0 && markerRect.top < frameDocument.documentElement.clientHeight,
      active: marker.classList.contains('is-active')
    };
  });
  assert.equal(afterExplicitClick.visible, true, JSON.stringify(afterExplicitClick));
  assert.equal(afterExplicitClick.active, true, JSON.stringify(afterExplicitClick));
  assert.ok(afterExplicitClick.previewTop < 100, JSON.stringify(afterExplicitClick));

  await page.mouse.click(sourceTarget.x, sourceTarget.y);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(
    await page.evaluate(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
    )),
    afterExplicitClick.previewTop,
    'A repeated click in the visible block must not move Preview'
  );

  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * 0.45;
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  const editingTarget = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const bounds = scroller.getBoundingClientRect();
    const lines = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .map(line => ({ line, rect: line.getBoundingClientRect() }))
      .filter(({ rect }) => rect.top >= bounds.top && rect.bottom <= bounds.bottom);
    const candidate = lines[Math.max(0, Math.floor(lines.length * 0.75))]!;
    return { x: candidate.rect.left + 24, y: candidate.rect.top + candidate.rect.height / 2 };
  });
  await movePreviewToBottom();
  await page.mouse.click(editingTarget.x, editingTarget.y);
  await new Promise(resolve => setTimeout(resolve, 80));
  const heldPreviewTop = await page.evaluate(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  ));
  await page.keyboard.type('x');
  await new Promise(resolve => setTimeout(resolve, 240));
  const previewTopAfterTyping = await page.evaluate(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  ));
  assert.ok(
    Math.abs(previewTopAfterTyping - heldPreviewTop) <= 2,
    `Typing after an explicit locate must retain the Preview attention position: ${JSON.stringify({ heldPreviewTop, previewTopAfterTyping })}`
  );

  const sourceScrollerPoint = await page.$eval('.cm-scroller', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(sourceScrollerPoint.x, sourceScrollerPoint.y);
  await page.mouse.wheel({ deltaY: 240 });
  await new Promise(resolve => setTimeout(resolve, 120));
  const previewTopAfterSourceScroll = await page.evaluate(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  ));
  assert.ok(
    Math.abs(previewTopAfterSourceScroll - previewTopAfterTyping) > 2,
    'A deliberate Source scroll must release the attention hold and resume linked scrolling'
  );

  const previewBounds = await page.$eval('.preview-frame', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + 80 };
  });
  await page.mouse.click(previewBounds.x, previewBounds.y);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(
    await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const marker = frameDocument.querySelector('.meo-preview-source-position-marker');
      const cursor = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-cursor')!;
      return {
        active: marker?.classList.contains('is-active'),
        cursorDisplay: frameDocument.defaultView!.getComputedStyle(cursor).display,
        backgroundColor: frameDocument.defaultView!.getComputedStyle(marker!).backgroundColor,
        activeLineBackground: getComputedStyle(document.querySelector<HTMLElement>('.cm-activeLine')!).backgroundColor
      };
    }),
    {
      active: false,
      cursorDisplay: 'none',
      backgroundColor: markerPresentation.backgroundColor,
      activeLineBackground: markerPresentation.activeLineBackground
    }
  );

  await page.click('.source-preview-scroll-sync-button');
  assert.equal(
    await page.$eval('.source-preview-scroll-sync-button', button => button.getAttribute('aria-pressed')),
    'false'
  );
  const independentTop = await movePreviewToBottom();
  await new Promise(resolve => setTimeout(resolve, 40));
  await page.mouse.click(sourceTarget.x, sourceTarget.y);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(Math.abs(await page.evaluate(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  )) - independentTop) <= 1, 'Independent panes must not auto-locate');

  const frameRect = await page.$eval('.preview-frame', element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  });
  await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const middle = Array.from(frameDocument.querySelectorAll<HTMLElement>('li[data-source-line]'))
      .find(element => element.textContent?.trim() === 'Reverse locator middle item.')!;
    middle.style.marginBottom = '28px';
    const lower = Array.from(frameDocument.querySelectorAll<HTMLElement>('li[data-source-line]'))
      .find(element => element.textContent?.trim() === 'Reverse locator lower item.')!;
    lower.scrollIntoView({ block: 'center' });
  });
  await new Promise(resolve => setTimeout(resolve, 80));
  const listGapTarget = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const items = Array.from(frameDocument.querySelectorAll<HTMLElement>('li[data-source-line]'));
    const middle = items.find(element => element.textContent?.trim() === 'Reverse locator middle item.')!;
    const lower = items.find(element => element.textContent?.trim() === 'Reverse locator lower item.')!;
    const middleRect = middle.getBoundingClientRect();
    const lowerRect = lower.getBoundingClientRect();
    const gap = lowerRect.top - middleRect.bottom;
    const x = lowerRect.left + Math.min(32, lowerRect.width / 2);
    const y = lowerRect.top - Math.min(4, gap / 4);
    const rawMappedTarget = frameDocument.elementFromPoint(x, y)?.closest<HTMLElement>('[data-source-line]');
    return {
      expectedLine: Number(lower.dataset.sourceLine),
      rawMappedLine: Number(rawMappedTarget?.dataset.sourceLine),
      gap,
      x,
      y
    };
  });
  assert.ok(listGapTarget.gap >= 20, JSON.stringify(listGapTarget));
  assert.notEqual(listGapTarget.rawMappedLine, listGapTarget.expectedLine, JSON.stringify(listGapTarget));
  await page.mouse.move(4, 4);
  await page.mouse.move(frameRect.left + listGapTarget.x, frameRect.top + listGapTarget.y);
  await page.waitForFunction((line) => {
    return Number(document.querySelector<HTMLElement>('.meo-preview-source-navigation.is-visible')
      ?.dataset.meoSourceNavigationLine) === line;
  }, {}, listGapTarget.expectedLine);

  const reverseTarget = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const target = Array.from(frameDocument.querySelectorAll<HTMLElement>('h2[data-source-line]'))
      .find(element => element.textContent?.trim() === 'Section 70')!;
    target.scrollIntoView({ block: 'center' });
    const targetRect = target.getBoundingClientRect();
    const readingRoot = frameDocument.querySelector<HTMLElement>('main.meo-export-doc')!;
    const rootRect = readingRoot.getBoundingClientRect();
    const rootStyle = frameDocument.defaultView!.getComputedStyle(readingRoot);
    return {
      line: Number(target.dataset.sourceLine),
      contentLeft: rootRect.left + Number.parseFloat(rootStyle.paddingLeft),
      targetTop: targetRect.top,
      targetHeight: targetRect.height,
      previewTop: frameDocument.scrollingElement!.scrollTop
    };
  });
  await page.mouse.move(4, 4);
  await page.mouse.move(
    frameRect.left + reverseTarget.contentLeft - 14,
    frameRect.top + reverseTarget.targetTop + Math.min(10, reverseTarget.targetHeight / 2)
  );
  await page.waitForFunction(() => {
    return document.querySelector('.meo-preview-source-navigation.is-visible') !== null;
  });
  const reverseAction = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const navigation = document.querySelector<HTMLElement>('.meo-preview-source-navigation')!;
    const navigationRect = navigation.getBoundingClientRect();
    const textProbe = document.createElement('span');
    textProbe.style.color = 'var(--meo-ui-text-muted)';
    navigation.appendChild(textProbe);
    const textColor = getComputedStyle(textProbe).color;
    textProbe.remove();
    return {
      line: Number(navigation.dataset.meoSourceNavigationLine),
      left: navigationRect.left,
      right: navigationRect.right,
      top: navigationRect.top,
      height: navigationRect.height,
      color: getComputedStyle(navigation).color,
      textColor,
      radius: getComputedStyle(navigation).borderRadius,
      usesArrowLeftIcon: navigation.querySelector('svg')?.classList.contains('lucide-arrow-left'),
      oldFrameButton: frameDocument.querySelector('.meo-preview-source-navigation') !== null,
      markerCursorDisplay: frameDocument.defaultView!.getComputedStyle(
        frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-cursor')!
      ).display
    };
  });
  assert.equal(reverseAction.line, reverseTarget.line, JSON.stringify({ reverseAction, reverseTarget }));
  assert.ok(Math.abs((reverseAction.left + reverseAction.right) / 2 - (frameRect.left - 1)) <= 0.5, JSON.stringify(reverseAction));
  assert.ok(Math.abs(reverseAction.top + reverseAction.height / 2 - (frameRect.top + reverseTarget.targetTop + reverseTarget.targetHeight / 2)) <= 1, JSON.stringify(reverseAction));
  assert.equal(reverseAction.height, 26);
  assert.equal(reverseAction.radius, '50%');
  assert.equal(reverseAction.color, reverseAction.textColor);
  assert.equal(reverseAction.usesArrowLeftIcon, true);
  assert.equal(reverseAction.oldFrameButton, false);
  assert.equal(reverseAction.markerCursorDisplay, 'none');
  const hintPoint = await page.$eval('.meo-preview-source-navigation', element => {
    const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(hintPoint.x, hintPoint.y, { steps: 4 });
  try {
    await page.waitForFunction(() => !!document.querySelector('.meo-tooltip.is-visible'), { timeout: 5000 });
  } catch (error) {
    throw new Error('Source locator hint did not appear: ' + JSON.stringify(await page.evaluate(() => {
      const doc = document;
      const button = doc.querySelector<HTMLElement>('.meo-preview-source-navigation')!;
      const hint = doc.querySelector<HTMLElement>('.meo-tooltip');
      return {
        hidden: button.hidden, tooltip: button.dataset.tooltip, label: button.getAttribute('aria-label'),
        described: button.getAttribute('aria-describedby'), button: button.getBoundingClientRect().toJSON(),
        hintClass: hint?.className, hint: hint?.getBoundingClientRect().toJSON(),
        viewport: [doc.defaultView!.innerWidth, doc.defaultView!.innerHeight],
        styles: doc.querySelectorAll('[data-meo-tooltip-style]').length
      };
    })), { cause: error });
  }
  const sourceHint = await page.evaluate(() => {
    const doc = document;
    const button = doc.querySelector<HTMLElement>('.meo-preview-source-navigation')!;
    const hint = doc.getElementById(button.getAttribute('aria-describedby')!)!;
    const rect = hint.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return {
      text: hint.querySelector('.meo-tooltip-label')!.textContent,
      label: button.getAttribute('aria-label'),
      key: hint.querySelector('kbd:not([hidden])')?.textContent ?? null,
      title: button.getAttribute('title'),
      buttonPositioned: Math.abs(rect.bottom - (buttonRect.top - 6)) <= 1,
      inside: rect.left >= 8 && rect.right <= doc.defaultView!.innerWidth - 8
    };
  });
  assert.deepEqual(sourceHint, {
    text: 'Click to reveal in source', label: 'Click to reveal in source', key: null, title: null, buttonPositioned: true, inside: true
  }, 'the source locator uses the ordinary button-anchored hint');
  const hintBounds = await page.$eval('.meo-tooltip.is-visible', hint => {
    const rect = hint.getBoundingClientRect(); return { x: rect.left, y: rect.top };
  });
  await page.mouse.move(hintPoint.x + 4, hintPoint.y + 4);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.$eval('.meo-tooltip.is-visible', hint => {
    const rect = hint.getBoundingClientRect(); return { x: rect.left, y: rect.top };
  }), hintBounds, 'moving inside the button must not move the hint');
  assert.equal(await page.$eval('.meo-preview-source-navigation', button => (button as HTMLElement).hidden), false,
    'crossing the iframe boundary and hovering the divider must retain the target');
  if (process.env.MEO_TOOLTIP_SCREENSHOT_DIR) {
    await page.screenshot({ path: process.env.MEO_TOOLTIP_SCREENSHOT_DIR + '/source-navigation.png' });
  }

  await page.mouse.click(hintPoint.x, hintPoint.y);
  await page.waitForFunction((line) => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return Number(frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')
      ?.dataset.meoSourcePositionLine) === line;
  }, {}, reverseTarget.line);
  await new Promise(resolve => setTimeout(resolve, 120));
  const reverseResult = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return {
      previewTop: frameDocument.scrollingElement!.scrollTop,
      navigationHidden: document.querySelector<HTMLElement>('.meo-preview-source-navigation')?.hidden,
      direction: document.querySelector<HTMLElement>('.meo-preview-source-navigation')?.dataset.meoSourceNavigationDirection,
      activeSourceText: document.querySelector<HTMLElement>('.cm-activeLine')?.textContent ?? ''
    };
  });
  assert.ok(Math.abs(reverseResult.previewTop - reverseTarget.previewTop) <= 2, JSON.stringify(reverseResult));
  assert.ok(reverseResult.navigationHidden || reverseResult.direction === 'preview',
    'revealing Source may offer the reverse direction, never retain the previous left arrow');
  assert.match(reverseResult.activeSourceText, /Section 70/);

  const directGutterTarget = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const target = Array.from(frameDocument.querySelectorAll<HTMLElement>('h2[data-source-line]'))
      .find(element => element.textContent?.trim() === 'Section 71')!;
    target.scrollIntoView({ block: 'center' });
    const targetRect = target.getBoundingClientRect();
    const readingRoot = frameDocument.querySelector<HTMLElement>('main.meo-export-doc')!;
    const rootRect = readingRoot.getBoundingClientRect();
    const rootStyle = frameDocument.defaultView!.getComputedStyle(readingRoot);
    return {
      line: Number(target.dataset.sourceLine),
      x: rootRect.left + Number.parseFloat(rootStyle.paddingLeft) - 14,
      y: targetRect.top + Math.min(10, targetRect.height / 2)
    };
  });
  await page.mouse.move(4, 4);
  await page.mouse.move(frameRect.left + directGutterTarget.x, frameRect.top + directGutterTarget.y);
  await page.mouse.click(frameRect.left + directGutterTarget.x, frameRect.top + directGutterTarget.y);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.match(await page.$eval('.cm-activeLine', line => line.textContent ?? ''), /Section 70/,
    'the old paragraph-height gutter must no longer navigate on click');
  const linkedPreviewTop = await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!
    .contentDocument!.scrollingElement!.scrollTop);
  await page.click('.source-preview-scroll-sync-button');
  await page.mouse.move(frameRect.left + directGutterTarget.x, frameRect.top + directGutterTarget.y);
  await page.click('.meo-preview-source-navigation');
  await page.waitForFunction((line) => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return Number(frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')
      ?.dataset.meoSourcePositionLine) === line;
  }, {}, directGutterTarget.line);
  assert.ok(Math.abs(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!
    .contentDocument!.scrollingElement!.scrollTop) - linkedPreviewTop) <= 2,
  'explicit source navigation must preserve the linked Preview reading position');
  console.log('Preview-to-Source navigation passed with independent and linked panes');

  await page.click('.source-preview-scroll-sync-button');
  const tallTarget = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const doc = frame.contentDocument!;
    const code = doc.querySelector('pre')!;
    code.scrollIntoView({ block: 'start' });
    const rect = code.getBoundingClientRect();
    return { x: frame.getBoundingClientRect().left + rect.left + 30, y: frame.getBoundingClientRect().top + 160 };
  });
  await page.mouse.move(tallTarget.x, tallTarget.y);
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('.meo-preview-source-navigation')?.hidden);
  const tallButtonTop = await page.$eval('.meo-preview-source-navigation', button => button.getBoundingClientRect().top);
  await page.mouse.move(tallTarget.x + 60, tallTarget.y + 100);
  assert.ok(Math.abs(await page.$eval('.meo-preview-source-navigation', button => button.getBoundingClientRect().top) - tallButtonTop) <= 1,
    'moving within one tall block must not move the divider button');
  await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const code = doc.querySelector('pre')!;
    doc.scrollingElement!.scrollTop += code.getBoundingClientRect().bottom - 250;
  });
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const doc = frame.contentDocument!;
    const code = doc.querySelector('pre')!.getBoundingClientRect();
    const button = document.querySelector('.meo-preview-source-navigation')!.getBoundingClientRect();
    return Math.abs(button.top + button.height / 2 - (frame.getBoundingClientRect().top + Math.max(0, code.top) / 2 + code.bottom / 2)) <= 1;
  });
  const topAvoidance = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const doc = frame.contentDocument!;
    doc.scrollingElement!.scrollTop += doc.querySelector('pre')!.getBoundingClientRect().bottom - 100;
    return { top: frame.getBoundingClientRect().top };
  });
  await page.mouse.move(tallTarget.x, topAvoidance.top + 50);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const shiftedTopButton = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const button = document.querySelector<HTMLElement>('.meo-preview-source-navigation')!;
    const rect = button.getBoundingClientRect();
    const toolsBottom = Math.max(...Array.from(document.querySelectorAll('.source-preview-tool-button'), tool => tool.getBoundingClientRect().bottom));
    return { hidden: button.hidden, top: rect.top, center: rect.top + rect.height / 2,
      nearestCenter: toolsBottom + 4 + rect.height / 2,
      contentBottom: frame.getBoundingClientRect().top + frame.contentDocument!.querySelector('pre')!.getBoundingClientRect().bottom };
  });
  assert.equal(shiftedTopButton.hidden, false, 'a tall block must move its button past the top tools when space remains');
  assert.ok(Math.abs(shiftedTopButton.center - shiftedTopButton.nearestCenter) <= 1, JSON.stringify(shiftedTopButton));
  assert.ok(shiftedTopButton.center <= shiftedTopButton.contentBottom, 'at most half the button may extend outside the block');
  await page.focus('.meo-preview-source-navigation');
  await page.mouse.move(4, 4);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(await page.$eval('.meo-preview-source-navigation', button => (button as HTMLElement).hidden), false,
    'keyboard focus must keep the divider button available');
  await page.focus('.source-preview-more-button');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.meo-preview-source-navigation')?.hidden);

  const edgeTarget = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const doc = frame.contentDocument!;
    const target = Array.from(doc.querySelectorAll<HTMLElement>('h2[data-source-line]'))
      .find(element => element.textContent?.trim() === 'Section 70')!;
    const rect = target.getBoundingClientRect();
    return { documentCenter: doc.scrollingElement!.scrollTop + rect.top + rect.height / 2,
      x: frame.getBoundingClientRect().left + rect.left + 30, frameTop: frame.getBoundingClientRect().top,
      viewportHeight: doc.scrollingElement!.clientHeight };
  });
  const moveEdgeTarget = async (center: number): Promise<void> => {
    await page.evaluate(({ documentCenter, center }) => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      doc.scrollingElement!.scrollTop = documentCenter - center;
    }, { documentCenter: edgeTarget.documentCenter, center });
    await page.mouse.move(edgeTarget.x, edgeTarget.frameTop + center);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  await moveEdgeTarget(200);
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('.meo-preview-source-navigation')?.hidden);
  await page.hover('.meo-preview-source-navigation');
  await page.waitForSelector('.meo-tooltip.is-visible');
  await page.evaluate(documentCenter => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    doc.scrollingElement!.scrollTop = documentCenter - 26;
  }, edgeTarget.documentCenter);
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.meo-preview-source-navigation')?.hidden
    && !document.querySelector('.meo-tooltip.is-visible'));
  await moveEdgeTarget(26);
  assert.equal(await page.$eval('.meo-preview-source-navigation', button => (button as HTMLElement).hidden), true,
    'overlap with either top Preview tool must hide the button rather than move it');
  assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
    .querySelector<HTMLElement>('.meo-preview-source-navigation-highlight')?.hidden), false,
  'toolbar overlap must retain the hovered block highlight');
  await moveEdgeTarget(6);
  assert.equal(await page.$eval('.meo-preview-source-navigation', button => (button as HTMLElement).hidden), true,
    'a sliver of content at the top must not push the button below its block');
  assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
    .querySelector<HTMLElement>('.meo-preview-source-navigation-highlight')?.hidden), false,
  'top-edge button hiding must retain the hovered block highlight');
  const nestedTarget = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const doc = frame.contentDocument!;
    const target = Array.from(doc.querySelectorAll<HTMLElement>('li[data-source-line]'))
      .find(element => element.textContent?.trim() === 'Nested task for bottom-edge navigation.')!;
    const rect = target.getBoundingClientRect();
    return { documentTop: doc.scrollingElement!.scrollTop + rect.top, height: rect.height,
      line: target.dataset.sourceLine, x: frame.getBoundingClientRect().left + rect.left + 4,
      frameTop: frame.getBoundingClientRect().top, viewportHeight: doc.scrollingElement!.clientHeight };
  });
  for (const remainingHeight of [60, 40, 30, 20, 6]) {
    await page.evaluate(({ nestedTarget, remainingHeight }) => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      doc.scrollingElement!.scrollTop = nestedTarget.documentTop - nestedTarget.viewportHeight + remainingHeight;
    }, { nestedTarget, remainingHeight });
    await page.mouse.move(nestedTarget.x, nestedTarget.frameTop + nestedTarget.viewportHeight - remainingHeight
      + Math.min(remainingHeight, nestedTarget.height) / 2);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const placement = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const doc = frame.contentDocument!;
      const button = document.querySelector<HTMLElement>('.meo-preview-source-navigation')!;
      const rect = button.getBoundingClientRect();
      const highlight = doc.querySelector<HTMLElement>('.meo-preview-source-navigation-highlight')!;
      const block = highlight.getBoundingClientRect();
      return { hidden: button.hidden, line: button.dataset.meoSourceNavigationLine,
        center: rect.top + rect.height / 2 - frame.getBoundingClientRect().top,
        bottom: rect.bottom - frame.getBoundingClientRect().top, radius: rect.height / 2,
        blockTop: Math.max(0, block.top), blockBottom: Math.min(doc.scrollingElement!.clientHeight, block.bottom),
        highlightHidden: highlight.hidden };
    });
    assert.equal(placement.highlightHidden, false, 'bottom-edge placement must retain the hovered block highlight');
    if (remainingHeight === 6) {
      assert.equal(placement.hidden, true, 'hide only when a fully visible button cannot keep its center in the block');
      continue;
    }
    assert.equal(placement.hidden, false, `nested task with ${remainingHeight}px to the viewport edge still has room for a button`);
    assert.equal(placement.line, nestedTarget.line);
    assert.ok(placement.center >= placement.blockTop - 0.5 && placement.center <= placement.blockBottom + 0.5,
      `at most half the button may extend outside the block: ${JSON.stringify(placement)}`);
    assert.ok(placement.bottom <= nestedTarget.viewportHeight + 0.5, JSON.stringify(placement));
    const nearestCenter = Math.min((placement.blockTop + placement.blockBottom) / 2, nestedTarget.viewportHeight - placement.radius);
    assert.ok(Math.abs(placement.center - nearestCenter) <= 1, JSON.stringify(placement));
  }
  await moveEdgeTarget(200);
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('.meo-preview-source-navigation')?.hidden);

  const forwardButton = '.meo-preview-source-navigation[data-meo-source-navigation-direction="preview"]:not([hidden])';
  const waitForForward = async (step: string): Promise<void> => {
    try { await page.waitForSelector(forwardButton, { timeout: 5000 }); }
    catch (error) {
      throw new Error(`${step}: ${JSON.stringify(await page.evaluate(() => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        const button = document.querySelector<HTMLElement>('.meo-preview-source-navigation');
        const caret = view.coordsAtPos(view.state.selection.main.head);
        return { focused: view.hasFocus, caret: { top: caret?.top, bottom: caret?.bottom }, scrollTop: view.scrollDOM.scrollTop,
          line: view.state.doc.lineAt(view.state.selection.main.head).number,
          button: { hidden: button?.hidden, direction: button?.dataset.meoSourceNavigationDirection, line: button?.dataset.meoSourceNavigationLine } };
      }))}`, { cause: error });
    }
  };
  console.log('Locator boundary, focus and nested-list checks passed');
  const snapshotSource = () => page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    return { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head,
      scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft, focused: view.hasFocus,
      length: view.state.doc.length };
  });
  for (const synchronized of [false, true]) {
    const enabled = await page.$eval('.source-preview-scroll-sync-button', button => button.getAttribute('aria-pressed') === 'true');
    if (enabled !== synchronized) await page.click('.source-preview-scroll-sync-button');
    await page.evaluate(() => { document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop = 0; });
    const sourcePoint = await page.$$eval('.cm-line', elements => {
      const target = elements.find(element => element.textContent?.includes('## Section 71'))!;
      const rect = target.getBoundingClientRect(); return { x: rect.left + 42, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(sourcePoint.x, sourcePoint.y);
    await waitForForward(`source click (sync=${synchronized})`);
    const before = await snapshotSource();
    await page.click(forwardButton);
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const doc = frame.contentDocument!;
      const target = [...doc.querySelectorAll('h2')].find(element => element.textContent?.trim() === 'Section 71')!.getBoundingClientRect();
      return Math.abs(target.top + target.height / 2 - doc.scrollingElement!.clientHeight / 2) < 2;
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await snapshotSource(), before, `revealing Preview must retain Source caret, selection, focus and viewport (sync=${synchronized})`);
    assert.equal(await page.$eval('.source-preview-scroll-sync-button', button => button.getAttribute('aria-pressed')), String(synchronized));
    console.log(`Source-to-Preview navigation retained Source state (sync=${synchronized})`);
  }
  await page.click('.source-preview-scroll-sync-button');
  await page.setViewport({ width: 760, height: 720 });
  const wrappedTargets = await page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    const line = [...Array(view.state.doc.lines)].map((_, i) => view.state.doc.line(i + 1))
      .find(line => line.text.startsWith('Paragraph 71 '));
    view.focus();
    view.dispatch({ selection: { anchor: line.from + 2 }, scrollIntoView: true });
    return { first: line.from + 2, last: line.to - 2, from: line.from };
  });
  await waitForForward('first wrapped row');
  const firstRowCenter = await page.$eval(forwardButton, button => { const rect = button.getBoundingClientRect(); return rect.top + rect.height / 2; });
  await page.evaluate(last => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    view.dispatch({ selection: { anchor: last }, scrollIntoView: true });
  }, wrappedTargets.last);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const wrappedPlacement = await page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    const caret = view.coordsAtPos(view.state.selection.main.head);
    const button = document.querySelector<HTMLElement>('.meo-preview-source-navigation')!;
    const rect = button.getBoundingClientRect();
    return { hidden: button.hidden, top: caret.top, bottom: caret.bottom, center: rect.top + rect.height / 2,
      size: rect.width, iconSize: button.querySelector('svg')!.getBoundingClientRect().width,
      rightArrow: getComputedStyle(button.querySelector('svg')!).transform };
  });
  assert.ok(!wrappedPlacement.hidden && wrappedPlacement.center > firstRowCenter + 5,
    `button must follow the wrapped visual row: ${JSON.stringify({ firstRowCenter, wrappedPlacement })}`);
  assert.ok(wrappedPlacement.center >= wrappedPlacement.top && wrappedPlacement.center <= wrappedPlacement.bottom, JSON.stringify(wrappedPlacement));
  assert.equal(wrappedPlacement.size, 26);
  assert.equal(wrappedPlacement.iconSize, 22);
  assert.match(wrappedPlacement.rightArrow, /matrix\(-1,/);
  console.log('Wrapped Source visual-row alignment passed');
  await page.hover(forwardButton);
  const lockedLine = await page.$eval(forwardButton, button => (button as HTMLElement).dataset.meoSourceNavigationLine);
  await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const target = [...doc.querySelectorAll('h2')].find(element => element.textContent?.trim() === 'Section 71')!;
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new doc.defaultView!.PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: rect.left + 15, clientY: rect.top + 5 }));
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.$eval(forwardButton, button => (button as HTMLElement).dataset.meoSourceNavigationLine), lockedLine,
    'hovering the divider must lock its direction and target against queued Preview hover events');
  await page.mouse.move(100, 180);
  await page.evaluate(from => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    view.dispatch({ selection: { anchor: from + 4, head: from + 15 }, scrollIntoView: true });
    view.focus();
  }, wrappedTargets.from);
  await waitForForward('selected Source text');
  const selectedSource = await snapshotSource();
  await page.click(forwardButton);
  assert.deepEqual(await snapshotSource(), selectedSource, 'mouse navigation must preserve a Source text selection');
  await page.evaluate(from => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    view.dispatch({ selection: { anchor: from + 4, head: from + 16 } });
  }, wrappedTargets.from);
  await waitForForward('keyboard navigation');
  const keyboardSource = await snapshotSource();
  await page.focus(forwardButton);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as any).EditingSettingsHarness.EditorView
    .findFromDOM(document.querySelector('.editor-host > .cm-editor')).hasFocus);
  assert.deepEqual(await snapshotSource(), keyboardSource, 'keyboard navigation must return to Source without editing or changing its selection');
  await page.evaluate(from => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    view.dispatch({ selection: { anchor: from + 4 }, scrollIntoView: true });
  }, wrappedTargets.from);
  await waitForForward('visible Source before clipping');
  await page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    view.scrollDOM.scrollTop += view.scrollDOM.clientHeight;
  });
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.meo-preview-source-navigation')?.hidden);
  console.log('Source visual-row geometry, direction lock, selection and viewport clipping passed');
  await page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    const line = [...Array(view.state.doc.lines)].map((_, i) => view.state.doc.line(i + 1))
      .find(line => line.text === '## Section 71');
    view.focus();
    view.dispatch({ selection: { anchor: line.to },
      effects: (window as any).EditingSettingsHarness.EditorView.scrollIntoView(line.to, { y: 'center' }) });
  });
  await waitForForward('Source before editing');
  await page.keyboard.type(' updated');
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
    .body.textContent?.includes('Section 71 updated'));
  await waitForForward('updated Preview presentation');
  const editedSource = await snapshotSource();
  await page.click(forwardButton);
  assert.deepEqual(await snapshotSource(), editedSource, 'Preview refresh must retain the current Source navigation target and caret');
  console.log('Source navigation survived an asynchronous Preview update');
  await page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    const line = [...Array(view.state.doc.lines)].map((_, i) => view.state.doc.line(i + 1))
      .find(line => line.text === 'Locator code line 35');
    view.dispatch({ selection: { anchor: line.from + 5 },
      effects: (window as any).EditingSettingsHarness.EditorView.scrollIntoView(line.from, { y: 'center' }) });
  });
  await waitForForward('long code block');
  const codeSource = await snapshotSource();
  await page.click(forwardButton);
  await page.waitForFunction(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const line = [...doc.querySelectorAll('.meo-export-code-line')].find(element => element.textContent?.includes('Locator code line 35'))!;
    const rect = line.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= doc.scrollingElement!.clientHeight;
  });
  assert.deepEqual(await snapshotSource(), codeSource, 'long-block navigation must retain Source and reveal the requested inner line');
  await page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    const line = [...Array(view.state.doc.lines)].map((_, i) => view.state.doc.line(i + 1))
      .find(line => line.text.includes('Hidden source-only navigation target'));
    view.dispatch({ selection: { anchor: line.from + 8 }, scrollIntoView: true });
    view.focus();
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.meo-preview-source-navigation')?.hidden);
  assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!
    .contentDocument!.querySelector<HTMLElement>('.meo-preview-source-position-marker')?.hidden), true,
  'a hidden comment must not offer a misleading Preview target');

  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
  assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
    .querySelector<HTMLElement>('.meo-preview-source-position-marker')?.hidden), true);
  assert.equal(await page.$eval('.meo-preview-source-navigation', button => (button as HTMLElement).hidden), true);
} catch (error) {
  primaryError = error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}

console.log('Source position marker checks passed');
