import { enterDisplayMathSource, displayMathSourceBounds, findDisplayMathOpening } from './history-display-math-chromium';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-editor-history-production-'));

async function waitForFrames(page: any, count = 8): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function assertTallNativeFormulaHistory(page: any): Promise<void> {
  const text = [...Array.from({ length: 200 }, () => 'History viewport spacer.'), '$$', 'x = 1',
    ...Array.from({ length: 75 }, (_, index) => `% formula spacer ${index}`), '$$'].join('\n');
  const opening = 201;
  await page.evaluate(text => {
    (window as any).__historyProductionEditor?.destroy(); document.getElementById('app')!.replaceChildren();
    (window as any).__historyProductionEditor = (window as any).MermaidEditingHarness.createEditor({ parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {} });
  }, text);
  await enterDisplayMathSource(page, '__historyProductionEditor', opening);
  await page.keyboard.press('Enter'); await page.keyboard.press('ArrowUp');
  await page.keyboard.type('% HISTORY_MARKER'); await waitForFrames(page, 12);
  const edited = await page.evaluate(() => (window as any).__historyProductionEditor.getText());
  assert.ok(edited.includes('HISTORY_MARKER'));
  await page.evaluate(() => (window as any).__historyProductionEditor.undo());
  for (const visible of [true, false]) {
    await page.evaluate(({ opening, visible }) => (window as any).__historyProductionEditor.scrollToLine(visible ? opening : 1, 'center'), { opening, visible });
    await waitForFrames(page, 20);
    const result = await page.evaluate(async expected => {
      const editor = (window as any).__historyProductionEditor, view = editor.view;
      const samples = [view.scrollDOM.scrollTop]; let sampling = true;
      const sample = () => { if (sampling) { samples.push(view.scrollDOM.scrollTop); requestAnimationFrame(sample); } };
      requestAnimationFrame(sample); await editor.redo();
      for (let frame = 0; frame < 20; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      sampling = false;
      const head = view.state.selection.main.head, coords = view.coordsAtPos(head), viewport = view.scrollDOM.getBoundingClientRect();
      return { span: Math.max(...samples) - Math.min(...samples), textMatches: editor.getText() === expected,
        focused: view.hasFocus && document.activeElement === view.contentDOM,
        headMatches: head === expected.indexOf('HISTORY_MARKER') + 'HISTORY_MARKER'.length,
        lineVisible: !!coords && coords.top >= viewport.top && coords.bottom <= viewport.bottom };
    }, edited);
    assert.ok(result.textMatches && result.focused && result.headMatches && result.lineVisible, JSON.stringify(result));
    if (visible) assert.ok(result.span <= 2, `Visible formula history moved: ${JSON.stringify(result)}`);
    else assert.ok(result.span > 20, 'Offscreen formula history must reveal the native caret');
    await page.evaluate(() => (window as any).__historyProductionEditor.undo());
  }
  await enterDisplayMathSource(page, '__historyProductionEditor', opening, 'end');
  await page.keyboard.press('Enter'); await page.keyboard.type('% DEEP_MARKER'); await waitForFrames(page, 12);
  const deepEdited = await page.evaluate(() => (window as any).__historyProductionEditor.getText());
  await page.evaluate(() => (window as any).__historyProductionEditor.undo());
  await page.evaluate(opening => (window as any).__historyProductionEditor.scrollToLine(opening, 'center'), opening);
  await waitForFrames(page, 20);
  const bounds = await displayMathSourceBounds(page, '__historyProductionEditor', opening);
  const beforeDeep = await page.evaluate(bounds => {
    const view = (window as any).__historyProductionEditor.view, viewport = view.scrollDOM.getBoundingClientRect();
    const first = view.coordsAtPos(bounds.from);
    const bottom = view.documentTop + view.lineBlockAt(bounds.to).bottom;
    return { top: view.scrollDOM.scrollTop, rootVisible: !!first && first.top < viewport.bottom && bottom > viewport.top, bottomOffscreen: bottom > viewport.bottom + 500 };
  }, bounds);
  assert.ok(beforeDeep.rootVisible && beforeDeep.bottomOffscreen, 'Tall formula source fixture must span beyond the viewport');
  await page.evaluate(() => (window as any).__historyProductionEditor.redo()); await waitForFrames(page, 20);
  const deepState = await page.evaluate(() => {
    const view = (window as any).__historyProductionEditor.view, coords = view.coordsAtPos(view.state.selection.main.head), viewport = view.scrollDOM.getBoundingClientRect();
    return { top: view.scrollDOM.scrollTop, text: view.state.doc.toString(), caretVisible: !!coords && coords.top >= viewport.top && coords.bottom <= viewport.bottom };
  });
  assert.equal(deepState.text, deepEdited); assert.ok(deepState.caretVisible && Math.abs(deepState.top - beforeDeep.top) > 20);
  await page.keyboard.type('Z'); await waitForFrames(page);
  assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.getText()), deepEdited.replace('DEEP_MARKER', 'DEEP_MARKERZ'));
}

async function assertTallRenderedHistoryViewport(page: any): Promise<void> {
  for (const kind of ['mermaid', 'math'] as const) {
    if (kind === 'math') { await assertTallNativeFormulaHistory(page); continue; }
    const prefix = Array.from({ length: 100 }, () => 'History viewport spacer.\n').join('\n');
    const body = kind === 'mermaid'
      ? ['flowchart TB', ...Array.from({ length: 75 }, (_, i) => `N${i} --> N${i + 1}`)]
      : ['x = 1', ...Array.from({ length: 75 }, (_, i) => `% formula spacer ${i}`)];
    const fence = kind === 'mermaid' ? '```mermaid' : '$$';
    const text = `${prefix}\n${fence}\n${body.join('\n')}\n${kind === 'mermaid' ? '```' : '$$'}`;
    const opening = prefix.split('\n').length + 1;
    const source = kind === 'mermaid' ? '.meo-mermaid-source-editor' : '.meo-latex-math-source-editor';
    const button = kind === 'mermaid' ? '.meo-mermaid-mode-btn' : '.meo-latex-math-mode-btn';
    await page.evaluate(({ text, opening }) => {
      (window as any).__historyProductionEditor?.destroy();
      document.getElementById('app')!.replaceChildren();
      const editor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
      (window as any).__historyProductionEditor = editor;
      editor.scrollToLine(opening, 'center');
    }, { text, opening });
    await waitForFrames(page, 12);
    await page.evaluate((selector) => (document.querySelector(selector) as HTMLButtonElement).click(), button);
    await page.waitForSelector(`${source} .cm-content`);
    await waitForFrames(page, 12);
    await page.evaluate((selector) => {
      const content = document.querySelector(`${selector} .cm-content`)! as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(content);
      range.collapse(true);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      content.focus({ preventScroll: true });
    }, source);
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.type(`${kind === 'mermaid' ? '%%' : '%'} HISTORY_MARKER`);
    await waitForFrames(page, 12);
    const edited = await page.evaluate(() => (window as any).__historyProductionEditor.getText());
    assert.ok(edited.includes('HISTORY_MARKER'));
    await page.evaluate(() => (window as any).__historyProductionEditor.undo());
    for (const visible of [true, false]) {
      await page.evaluate(({ opening, visible }) => (window as any).__historyProductionEditor.scrollToLine(visible ? opening : 1, 'center'), { opening, visible });
      await waitForFrames(page, 20);
      const result = await page.evaluate(async ({ source, expected }) => {
        const editor = (window as any).__historyProductionEditor;
        const samples = [editor.view.scrollDOM.scrollTop];
        let sampling = true;
        const sample = () => { if (sampling) { samples.push(editor.view.scrollDOM.scrollTop); requestAnimationFrame(sample); } };
        requestAnimationFrame(sample);
        await editor.redo();
        for (let i = 0; i < 20; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        sampling = false;
        const content = document.querySelector(`${source} .cm-content`);
        const line = content?.querySelector('.cm-line')?.getBoundingClientRect();
        const viewport = editor.view.scrollDOM.getBoundingClientRect();
        return {
          span: Math.max(...samples) - Math.min(...samples),
          textMatches: editor.getText() === expected,
          focused: content === document.activeElement,
          lineVisible: Boolean(line && line.top >= viewport.top && line.bottom <= viewport.bottom)
        };
      }, { source, expected: edited });
      assert.ok(result.textMatches && result.focused && result.lineVisible, `${kind} history target: ${JSON.stringify(result)}`);
      if (visible) assert.ok(result.span <= 2, `${kind} visible redo moved: ${JSON.stringify(result)}`);
      else assert.ok(result.span > 20, `${kind} offscreen redo must reveal`);
      await page.evaluate(() => (window as any).__historyProductionEditor.undo());
    }
    // A tall replacement can intersect the viewport while its inner caret is
    // far below it. The outer visible line range alone cannot decide reveal.
    await page.evaluate((selector) => (document.querySelector(`${selector} .cm-content`) as HTMLElement).focus({ preventScroll: true }), source);
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.type(`${kind === 'mermaid' ? '%%' : '%'} DEEP_MARKER`);
    await waitForFrames(page, 12);
    const deepEdited = await page.evaluate(() => (window as any).__historyProductionEditor.getText());
    assert.ok(deepEdited.includes('DEEP_MARKER'));
    await page.evaluate(() => (window as any).__historyProductionEditor.undo());
    await page.evaluate((opening) => (window as any).__historyProductionEditor.scrollToLine(opening, 'center'), opening);
    await waitForFrames(page, 20);
    const beforeDeep = await page.evaluate((source) => {
      const root = document.querySelector(source)!.closest('[role="region"]')!.getBoundingClientRect();
      const editor = (window as any).__historyProductionEditor;
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return { top: editor.view.scrollDOM.scrollTop, rootVisible: root.top < viewport.bottom && root.bottom > viewport.top, bottomOffscreen: root.bottom > viewport.bottom + 500 };
    }, source);
    assert.ok(beforeDeep.rootVisible && beforeDeep.bottomOffscreen, `${kind} deep target fixture must span beyond viewport`);
    await page.evaluate(() => (window as any).__historyProductionEditor.redo());
    await waitForFrames(page, 20);
    const deepState = await page.evaluate(() => {
      const editor = (window as any).__historyProductionEditor;
      const range = window.getSelection()?.getRangeAt(0);
      const caret = range?.getBoundingClientRect();
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return { top: editor.view.scrollDOM.scrollTop, caretVisible: Boolean(caret && caret.height > 0 && caret.top >= viewport.top && caret.bottom <= viewport.bottom), text: editor.getText() };
    });
    assert.equal(deepState.text, deepEdited);
    assert.ok(deepState.caretVisible && Math.abs(deepState.top - beforeDeep.top) > 20, `${kind} deep caret was not revealed`);
    await page.keyboard.type('Z');
    await waitForFrames(page, 8);
    assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.getText()), deepEdited.replace('DEEP_MARKER', 'DEEP_MARKERZ'), `${kind} DOM caret must match restored history selection`);
  }
}

async function assertDistantNestedFormulaHistory(page: any): Promise<void> {
  const text = [
    ...Array.from({ length: 180 }, () => 'Leading history spacer.\n'),
    '- Outer list', '', '  - Inner list', '',
    '    $$', '    E = mc^2', '', '    $$', '',
    ...Array.from({ length: 1200 }, () => 'Trailing history spacer.\n')
  ].join('\n');
  const opening = text.split('\n').findIndex(line => line.trim() === '$$') + 1;
  await page.evaluate(({ text, opening }) => {
    (window as any).__historyProductionEditor?.destroy();
    document.getElementById('app')!.replaceChildren();
    const editor = (window as any).MermaidEditingHarness.createEditor({ parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {} });
    (window as any).__historyProductionEditor = editor;
    editor.scrollToLine(opening, 'center');
  }, { text, opening });
  await waitForFrames(page, 20);
  await enterDisplayMathSource(page, '__historyProductionEditor', opening);
  await page.keyboard.press('End');
  await page.keyboard.type(' % NESTED_HISTORY');
  await waitForFrames(page, 12);
  await page.evaluate(() => {
    const editor = (window as any).__historyProductionEditor;
    editor.scrollToLine(editor.view.state.doc.lines, 'center');
  });
  await waitForFrames(page, 20);
  const result = await page.evaluate(async () => {
    const editor = (window as any).__historyProductionEditor;
    const before = editor.view.scrollDOM.scrollTop;
    await editor.undo();
    for (let i = 0; i < 12; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const content = editor.view.contentDOM;
    return { before, after: editor.view.scrollDOM.scrollTop, focused: content === document.activeElement, text: editor.getText() };
  });
  assert.ok(result.before - result.after > 20000, 'Nested fixture must exercise distant history navigation');
  assert.equal(result.text, text);
  assert.ok(result.focused, 'Distant nested formula history must restore main document focus and source');
}

async function assertFormulaToolbarHistoryHitability(page: any): Promise<void> {
  const formulaText = [
    ...Array.from({ length: 72 }, (_, index) => `formula history line ${index + 1}`),
    '$$',
    'x = 1',
    '$$',
    'formula history tail'
  ].join('\n');
  await page.evaluate((text) => {
    const previous = (window as any).__historyProductionEditor;
    previous?.destroy();
    document.getElementById('app')!.replaceChildren();
    (window as any).__historyProductionEditor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app')!,
      text,
      initialMode: 'live',
      onApplyChanges() {}
    });
  }, formulaText);
  await waitForFrames(page, 12);

  const formulaLine = await page.evaluate(() => {
    const editor = (window as any).__historyProductionEditor;
    const lineNumber = editor.getText().split('\n').findIndex((line: string) => line.trim() === '$$') + 1;
    if (lineNumber > 0) return lineNumber;
    throw new Error('Missing Formula opening line in History hitability fixture');
  });
  const readTarget = () => page.$eval('.meo-math-copy-actions .meo-copy-code-btn', button => {
    const rect = button.getBoundingClientRect();
    return { connected: button.isConnected, point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
  });
  const showReading = async () => {
    await page.evaluate(line => {
      const editor = (window as any).__historyProductionEditor;
      editor.scrollToLine(line, 'center');
    }, formulaLine);
    await waitForFrames(page, 8);
    await page.evaluate(() => (window as any).__historyProductionEditor.revealSelection(0, 0, { align: 'none' }));
    await waitForFrames(page, 8);
  };
  await showReading();
  assert.equal((await readTarget()).connected, true);
  await page.click('.cm-content'); await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
  await page.keyboard.type(' HISTORY_EDIT'); await waitForFrames(page);
  assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.getText().endsWith('formula history tail HISTORY_EDIT')), true);
  assert.deepEqual(await page.evaluate(async () => {
    const editor = (window as any).__historyProductionEditor; return { undone: await editor.undo(), redone: await editor.redo() };
  }), { undone: true, redone: true });
  await showReading(); await page.mouse.move(5, 5); await waitForFrames(page, 2);
  const fresh = await readTarget(); assert.equal(fresh.connected, true);
  const hit = () => page.evaluate(point => {
    const button = document.querySelector('.meo-math-copy-actions .meo-copy-code-btn')!, target = document.elementFromPoint(point.x, point.y);
    return button === target || button.contains(target);
  }, fresh.point);
  assert.equal(await hit(), false, 'Hidden formula action must not intercept a pointer');
  await page.mouse.move(fresh.point.x, fresh.point.y); assert.equal(await hit(), true, 'The fresh action must become the browser hit target on hover');
  await page.mouse.down(); await page.mouse.up(); await waitForFrames(page);
  assert.equal(await page.$('.meo-math-copy-actions .meo-select-all-code-btn'), null, 'Reading formula hides source selection');
  await page.click('.meo-md-math-fenced-display .katex'); await waitForFrames(page);
  await page.click('.meo-math-source-actions .meo-select-all-code-btn'); await waitForFrames(page);
  const readSelection = () => page.evaluate(() => {
    const view = (window as any).__historyProductionEditor.view;
    return { source: view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), focused: view.hasFocus && document.activeElement === view.contentDOM, legacyMode: !!document.querySelector('.meo-latex-math-mode-btn') };
  });
  assert.deepEqual(await readSelection(), { source: 'x = 1', focused: true, legacyMode: false });
  await showReading(); await page.click('.meo-md-math-fenced-display .katex'); await waitForFrames(page);
  await page.focus('.meo-math-source-actions .meo-select-all-code-btn');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('meo-format-math-btn')), true,
    'Formula Format follows Select in keyboard order');
  await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  await page.keyboard.press('Enter'); await waitForFrames(page);
  assert.deepEqual(await readSelection(), { source: 'x = 1', focused: true, legacyMode: false });

}

async function assertHistoryViewportPolicy(page: any): Promise<void> {
  const targetLineNumber = 96;
  const marker = ' HISTORY_VIEWPORT_EDIT';
  const text = Array.from({ length: 180 }, (_, index) => `history viewport line ${index + 1}`).join('\n');
  await page.evaluate((fixture) => {
    const previous = (window as any).__historyProductionEditor;
    previous?.destroy();
    document.getElementById('app')!.replaceChildren();
    (window as any).__historyProductionEditor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app')!,
      text: fixture,
      initialMode: 'source',
      onApplyChanges() {}
    });
  }, text);
  await waitForFrames(page, 10);

  await page.evaluate(({ lineNumber, insert }) => {
    const editor = (window as any).__historyProductionEditor;
    const line = editor.view.state.doc.line(lineNumber);
    editor.view.dispatch({
      changes: { from: line.to, insert },
      selection: { anchor: line.to + insert.length }
    });
    editor.scrollToLine(lineNumber, 'center');
  }, { lineNumber: targetLineNumber, insert: marker });
  await waitForFrames(page, 10);

  const capture = () => page.evaluate((lineNumber) => {
    const editor = (window as any).__historyProductionEditor;
    const scroller = editor.view.scrollDOM as HTMLElement;
    const line = editor.view.state.doc.line(lineNumber);
    const coords = editor.view.coordsAtPos(line.from);
    const viewport = scroller.getBoundingClientRect();
    return {
      bottomGap: coords ? viewport.bottom - coords.bottom : null,
      contextMargin: Math.min(editor.view.defaultLineHeight * 2.5, viewport.height * 0.2),
      scrollTop: scroller.scrollTop,
      topGap: coords ? coords.top - viewport.top : null,
      visible: Boolean(coords && coords.bottom > viewport.top && coords.top < viewport.bottom)
    };
  }, targetLineNumber);

  const beforeVisibleUndo = await capture();
  assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.undo()), true);
  await waitForFrames(page, 12);
  const afterVisibleUndo = await capture();
  assert.equal(afterVisibleUndo.visible, true, 'visible Undo target must stay visible');
  assert.ok(
    Math.abs(afterVisibleUndo.scrollTop - beforeVisibleUndo.scrollTop) <= 2,
    `visible Undo moved the viewport: ${JSON.stringify({ beforeVisibleUndo, afterVisibleUndo })}`
  );

  const beforeVisibleRedo = await capture();
  assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.redo()), true);
  await waitForFrames(page, 12);
  const afterVisibleRedo = await capture();
  assert.equal(afterVisibleRedo.visible, true, 'visible Redo target must stay visible');
  assert.ok(
    Math.abs(afterVisibleRedo.scrollTop - beforeVisibleRedo.scrollTop) <= 2,
    `visible Redo moved the viewport: ${JSON.stringify({ beforeVisibleRedo, afterVisibleRedo })}`
  );

  const moveAway = async () => {
    await page.evaluate(() => {
      const editor = (window as any).__historyProductionEditor;
      editor.scrollToLine(4, 'center');
    });
    await waitForFrames(page, 10);
    assert.equal((await capture()).visible, false, 'history target fixture did not move offscreen');
  };
  const replayWithFrameTrace = (direction: 'undo' | 'redo') => page.evaluate(async (replayDirection) => {
    const editor = (window as any).__historyProductionEditor;
    const trace = [editor.view.scrollDOM.scrollTop as number];
    const frames = new Promise<void>((resolve) => {
      let remaining = 24;
      const sample = () => {
        trace.push(editor.view.scrollDOM.scrollTop);
        remaining -= 1;
        if (remaining > 0) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    const applied = await editor[replayDirection]();
    await frames;
    return { applied, trace };
  }, direction);
  const assertSingleVisibleReveal = (trace: number[], label: string) => {
    const significant = trace.reduce<number[]>((values, value) => {
      if (values.length === 0 || Math.abs(value - values.at(-1)!) > 2) values.push(value);
      return values;
    }, []);
    assert.ok(
      significant.length <= 2,
      `${label} used more than one visible viewport movement: ${JSON.stringify({ significant, trace })}`
    );
  };
  await moveAway();
  const undoReplay = await replayWithFrameTrace('undo');
  assert.equal(undoReplay.applied, true);
  assertSingleVisibleReveal(undoReplay.trace, 'offscreen Undo');
  await waitForFrames(page, 12);
  const offscreenUndo = await capture();
  assert.equal(offscreenUndo.visible, true, 'offscreen Undo target was not revealed');
  assert.ok(
    offscreenUndo.bottomGap !== null && offscreenUndo.bottomGap >= offscreenUndo.contextMargin - 2,
    `offscreen Undo target lacked visual context: ${JSON.stringify(offscreenUndo)}`
  );

  await moveAway();
  const redoReplay = await replayWithFrameTrace('redo');
  assert.equal(redoReplay.applied, true);
  assertSingleVisibleReveal(redoReplay.trace, 'offscreen Redo');
  await waitForFrames(page, 12);
  const offscreenRedo = await capture();
  assert.equal(offscreenRedo.visible, true, 'offscreen Redo target was not revealed');
  assert.ok(
    offscreenRedo.bottomGap !== null && offscreenRedo.bottomGap >= offscreenRedo.contextMargin - 2,
    `offscreen Redo target lacked visual context: ${JSON.stringify(offscreenRedo)}`
  );
}

async function assertRenderedHistoryViewportPolicy(page: any): Promise<void> {
  const text = [
    ...Array.from({ length: 72 }, (_, index) => `rendered viewport before ${index + 1}`),
    '```mermaid',
    'graph TD',
    'A --> B',
    '```',
    ...Array.from({ length: 72 }, (_, index) => `rendered viewport after ${index + 1}`)
  ].join('\n');
  await page.evaluate((fixture) => {
    const previous = (window as any).__historyProductionEditor;
    previous?.destroy();
    document.getElementById('app')!.replaceChildren();
    (window as any).__historyProductionEditor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app')!,
      text: fixture,
      initialMode: 'live',
      onApplyChanges() {}
    });
  }, text);
  await waitForFrames(page, 12);
  await page.evaluate(() => (window as any).__historyProductionEditor.scrollToLine(73, 'center'));
  await waitForFrames(page, 10);
  await page.click('.meo-mermaid-mode-btn');
  await waitForFrames(page, 10);
  await page.click('.meo-mermaid-source-editor .cm-content');
  await page.keyboard.down('Control');
  await page.keyboard.press('End');
  await page.keyboard.up('Control');
  await page.keyboard.type('\nB --> C');
  await waitForFrames(page, 10);

  const capture = () => page.evaluate(() => {
    const editor = (window as any).__historyProductionEditor;
    const scroller = editor.view.scrollDOM as HTMLElement;
    const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
    const rect = block?.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    return {
      scrollTop: scroller.scrollTop,
      visible: Boolean(rect && rect.bottom > viewport.top && rect.top < viewport.bottom),
      blockTop: rect?.top ?? null,
      blockBottom: rect?.bottom ?? null,
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom
    };
  });
  const beforeVisibleUndo = await capture();
  assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.undo()), true);
  await waitForFrames(page, 14);
  const afterVisibleUndo = await capture();
  assert.equal(afterVisibleUndo.visible, true, 'visible Mermaid Undo target must stay visible');
  assert.ok(
    Math.abs(afterVisibleUndo.scrollTop - beforeVisibleUndo.scrollTop) <= 2,
    `visible Mermaid Undo moved the viewport: ${JSON.stringify({ beforeVisibleUndo, afterVisibleUndo })}`
  );

  const beforeVisibleRedo = await capture();
  assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.redo()), true);
  await waitForFrames(page, 14);
  const afterVisibleRedo = await capture();
  assert.equal(afterVisibleRedo.visible, true, 'visible Mermaid Redo target must stay visible');
  assert.ok(
    Math.abs(afterVisibleRedo.scrollTop - beforeVisibleRedo.scrollTop) <= 2,
    `visible Mermaid Redo moved the viewport: ${JSON.stringify({ beforeVisibleRedo, afterVisibleRedo })}`
  );

  const moveAway = async () => {
    await page.evaluate(() => (window as any).__historyProductionEditor.scrollToLine(3, 'center'));
    await waitForFrames(page, 10);
    const moved = await capture();
    assert.equal(moved.visible, false, `Mermaid history target fixture did not move offscreen: ${JSON.stringify(moved)}`);
  };
  await moveAway();
  assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.undo()), true);
  await waitForFrames(page, 14);
  assert.equal((await capture()).visible, true, 'offscreen Mermaid Undo target was not revealed');

  await moveAway();
  assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.redo()), true);
  await waitForFrames(page, 14);
  assert.equal((await capture()).visible, true, 'offscreen Mermaid Redo target was not revealed');
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'production.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 460, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'production.js') });
    await page.evaluate(() => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, text: string) {
          return { svg: `<svg width="320" height="120"><text>${text.length}</text></svg>` };
        }
      };
      const text = Array.from(
        { length: 90 },
        (_, index) => index === 44 ? 'production history plain | pipe' : `production history line ${index + 1}`
      ).join('\n');
      (window as any).__historyProductionEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'source',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);

    if (process.argv.includes('--viewport-policy-only')) {
      await assertHistoryViewportPolicy(page);
      await assertRenderedHistoryViewportPolicy(page);
      await page.evaluate(() => (window as any).__historyProductionEditor.destroy());
      console.log('Editor History viewport policy checks passed');
      return;
    }

    const publicReplay = await page.evaluate(async () => {
      const editor = (window as any).__historyProductionEditor;
      const view = editor.view;
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert: ' PUBLIC_EDIT' }, selection: { anchor: end + 12 } });
      const replay = editor.undo();
      const promiseLike = typeof replay?.then === 'function';
      const applied = await replay;
      return {
        promiseLike,
        applied,
        text: view.state.doc.toString(),
        focused: view.hasFocus,
        head: view.state.selection.main.head
      };
    });
    assert.equal(publicReplay.promiseLike, true, 'public undo must return the Runtime completion Promise');
    assert.equal(publicReplay.applied, true);
    assert.equal(publicReplay.text.includes('PUBLIC_EDIT'), false);
    assert.equal(publicReplay.focused, true);
    assert.equal(publicReplay.head, publicReplay.text.length);

    const plainPipeReplay = await page.evaluate(async () => {
      const editor = (window as any).__historyProductionEditor;
      const view = editor.view;
      const line = view.state.doc.line(45);
      view.dispatch({ changes: { from: line.to, insert: ' EDIT' }, selection: { anchor: line.to + 5 } });
      const applied = await editor.undo();
      return {
        applied,
        line: view.state.doc.line(45).text,
        focused: view.hasFocus,
        head: view.state.selection.main.head,
        expectedHead: line.to
      };
    });
    await waitForFrames(page, 12);
    assert.deepEqual(plainPipeReplay, {
      applied: true,
      line: 'production history plain | pipe',
      focused: true,
      head: plainPipeReplay.expectedHead,
      expectedHead: plainPipeReplay.expectedHead
    });

    const keymapConsumed = await page.evaluate(() => {
      const editor = (window as any).__historyProductionEditor;
      const view = editor.view;
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert: ' KEYMAP_EDIT' }, selection: { anchor: end + 12 } });
      view.focus();
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: 'z'
      });
      const dispatched = view.contentDOM.dispatchEvent(event);
      return !dispatched && event.defaultPrevented;
    });
    assert.equal(keymapConsumed, true, 'keymap runner must synchronously consume the browser event');
    await waitForFrames(page);
    assert.equal(
      await page.evaluate(() => (window as any).__historyProductionEditor.getText().includes('KEYMAP_EDIT')),
      false
    );

    while (await page.evaluate(() => (window as any).__historyProductionEditor.undo())) {
      // Exhaust native history through the public asynchronous contract.
    }
    const boundaryConsumed = await page.evaluate(() => {
      const editor = (window as any).__historyProductionEditor;
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: 'z'
      });
      const dispatched = editor.view.contentDOM.dispatchEvent(event);
      return !dispatched && event.defaultPrevented;
    });
    assert.equal(boundaryConsumed, true, 'native no-op boundary must still be consumed synchronously');
    await waitForFrames(page);
    assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.undo()), false);

    const reloadClearsUndo = await page.evaluate(async () => {
      const editor = (window as any).__historyProductionEditor;
      const view = editor.view;
      view.dispatch({ changes: { from: view.state.doc.length, insert: ' LOCAL_TEXT_TO_DISCARD' } });
      editor.setText('disk version after reload', true);
      return {
        text: editor.getText(),
        undoApplied: await editor.undo()
      };
    });
    assert.deepEqual(reloadClearsUndo, {
      text: 'disk version after reload',
      undoApplied: false
    }, 'a disk reload must not leave discarded local text reachable by normal undo');

    await assertHistoryViewportPolicy(page);
    await assertRenderedHistoryViewportPolicy(page);

    const renderedHistoryEditorReady = await page.evaluate(async () => {
      const previous = (window as any).__historyProductionEditor;
      previous.destroy();
      document.getElementById('app')!.replaceChildren();
      const editor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text: ['```mermaid', 'graph TD', 'A --> B', '```'].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__historyProductionEditor = editor;
      return true;
    });
    assert.equal(renderedHistoryEditorReady, true);
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    const sourceContentSelector = '.meo-mermaid-source-editor .cm-content';
    await page.click(sourceContentSelector);
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    const before = await page.$eval(sourceContentSelector, (content) => (
      Array.from(content.querySelectorAll<HTMLElement>('.cm-line'))
        .map((line) => line.textContent ?? '')
        .join('\n').length
    ));
    await page.keyboard.press('Enter');
    await page.keyboard.type('C --> D');
    const positions = { before, after: before + 8 };
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page, 2);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);

    const readBlock = () => page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
      const content = block?.querySelector<HTMLElement>('.meo-mermaid-source-editor .cm-content');
      const selection = window.getSelection();
      const focusNode = selection?.focusNode ?? null;
      const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement ?? null;
      const focusLine = focusElement?.closest<HTMLElement>('.cm-line') ?? null;
      const lines = content ? Array.from(content.querySelectorAll<HTMLElement>('.cm-line')) : [];
      const focusLineIndex = focusLine ? lines.indexOf(focusLine) : -1;
      let head: number | null = null;
      if (selection && focusNode && focusLine && content?.contains(focusNode) && focusLineIndex >= 0) {
        const range = document.createRange();
        range.selectNodeContents(focusLine);
        range.setEnd(focusNode, selection.focusOffset);
        head = lines.slice(0, focusLineIndex)
          .reduce((offset, line) => offset + (line.textContent?.length ?? 0) + 1, 0)
          + range.toString().length;
      }
      return {
        split: Boolean(block?.classList.contains('is-split')),
        source: Boolean(block?.classList.contains('is-source')),
        head,
        focused: Boolean(content && document.activeElement === content)
      };
    });
    await page.evaluate(() => (window as any).__historyProductionEditor.undo());
    await waitForFrames(page);
    const previewUndo = await readBlock();
    await page.evaluate(() => (window as any).__historyProductionEditor.redo());
    await waitForFrames(page);
    const splitRedo = await readBlock();
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    await page.click(`${sourceContentSelector} .cm-line:last-child`);
    await page.keyboard.press('End');
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await waitForFrames(page);
    const sourceUndo = await readBlock();
    await page.keyboard.down('Control');
    await page.keyboard.press('y');
    await page.keyboard.up('Control');
    await waitForFrames(page);
    const sourceRedo = await readBlock();

    const renderedHistoryPresentation = {
      positions,
      previewUndo: { split: previewUndo.split, head: previewUndo.head, focused: previewUndo.focused },
      splitRedo: { split: splitRedo.split, head: splitRedo.head, focused: splitRedo.focused },
      sourceUndo: { source: sourceUndo.source, head: sourceUndo.head, focused: sourceUndo.focused },
      sourceRedo: { source: sourceRedo.source, head: sourceRedo.head, focused: sourceRedo.focused }
    };
    assert.deepEqual(renderedHistoryPresentation, {
      positions: { before: 16, after: 24 },
      previewUndo: { split: false, head: null, focused: false },
      splitRedo: { split: false, head: null, focused: false },
      sourceUndo: { source: true, head: 16, focused: true },
      sourceRedo: { source: true, head: 24, focused: true }
    });

    await assertTallRenderedHistoryViewport(page);
    await assertDistantNestedFormulaHistory(page);
    await assertFormulaToolbarHistoryHitability(page);
    await page.evaluate(() => (window as any).__historyProductionEditor.destroy());
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('Editor History production Chromium trace passed');
}

await main();
