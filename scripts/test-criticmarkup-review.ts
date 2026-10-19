import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import {
  buildCommentInsertion, criticUnitAt, findCriticMarks, groupCriticUnits, nextCommentId, resolveAllCriticUnits, resolveCriticUnit,
  toggleCommentResolved
} from '../src/foundation/criticMarkup';

const resolve = (text: string, position: number, decision: 'accept' | 'reject') => {
  const marks = findCriticMarks(text);
  const unit = criticUnitAt(groupCriticUnits(marks), position);
  assert(unit, `no unit at ${position} in ${text}`);
  const change = resolveCriticUnit(text, unit, decision);
  return text.slice(0, change.from) + change.insert + text.slice(change.to);
};

// Accept / reject table.
const cases: Array<[string, number, string, string]> = [
  ['A {++new++} b', 5, 'A new b', 'A  b'],
  ['A {--old--} b', 5, 'A  b', 'A old b'],
  ['A {~~bad~>good~~} b', 6, 'A good b', 'A bad b'],
  ['A {~~~>added~~} b', 6, 'A added b', 'A  b'],
  ['A {~~gone~>~~} b', 6, 'A  b', 'A gone b'],
  ['A {==mark==} b', 6, 'A mark b', 'A mark b'],
  ['A {==mark==}{>>#c1 @O: why<<} b', 6, 'A mark b', 'A mark b'],
  ['A {>>#c1 note<<} b', 6, 'A  b', 'A  b']
];
for (const [text, position, accepted, rejected] of cases) {
  assert.equal(resolve(text, position, 'accept'), accepted, `accept ${text}`);
  assert.equal(resolve(text, position, 'reject'), rejected, `reject ${text}`);
}

// A highlight and the comment glued to it are one unit; a space breaks the pairing.
const glued = groupCriticUnits(findCriticMarks('{==a==}{>>#c1 n<<}'));
assert.equal(glued.length, 1);
assert.equal(glued[0].comment?.kind, 'comment');
assert.equal(groupCriticUnits(findCriticMarks('{==a==} {>>#c1 n<<}')).length, 2);
// The cursor on either delimiter edge belongs to the unit; outside does not.
assert.equal(criticUnitAt(groupCriticUnits(findCriticMarks('x {++a++} y')), 1), null);
assert.ok(criticUnitAt(groupCriticUnits(findCriticMarks('x {++a++} y')), 2));
assert.ok(criticUnitAt(groupCriticUnits(findCriticMarks('x {++a++} y')), 9));

// Marks that span blocks resolve like any other.
const spanning = '{==- one\n\n- two==}{>>#c3 n<<} tail';
assert.equal(resolve(spanning, 2, 'accept'), '- one\n\n- two tail');
// Skipped positions (code) are not marks.
assert.equal(findCriticMarks('`{++x++}` {++y++}', (position) => position < 9).length, 1);
// Unclosed text is not a mark and does not swallow the next one.
assert.equal(findCriticMarks('{++ open and {--del--}').length, 1);

// Comment ids: the highest existing id wins; padding follows the widest id; other # are ignored.
const ids = (text: string) => nextCommentId(findCriticMarks(text), text);
assert.equal(ids('no comments'), 'c01');
assert.equal(ids('{>>#c01 a<<} {>>#c07 b<<} {>>#c03 c<<}'), 'c08');
assert.equal(ids('{>>#c99 a<<}'), 'c100');
assert.equal(ids('# Heading #c40\n{>>#t02 other prefix<<} {>>no id<<}'), 'c01');
assert.equal(ids('{>>#c0009 wide<<}'), 'c0010');
assert.equal(ids('`{>>#c50 x<<}` {>>#c02 y<<}'), 'c51', 'the pure scanner has no code context; callers pass skip');

// Comment insertion with and without a selection and an author.
assert.deepEqual(buildCommentInsertion('text', 'c04', 'Oriol'), { insert: '{==text==}{>>#c04 @Oriol: <<}', cursor: 26 });
assert.deepEqual(buildCommentInsertion('', 'c04', ''), { insert: '{>>#c04 <<}', cursor: 8 });
assert.equal(buildCommentInsertion('x', 'c04', '  ').insert, '{==x==}{>>#c04 <<}', 'blank author is omitted');
const inserted = buildCommentInsertion('text', 'c04', 'Oriol');
assert.equal(inserted.insert.slice(inserted.cursor), '<<}', 'cursor sits before the closing delimiter');


// Dates ride on the author token; resolved comments toggle a leading [x] marker.
assert.deepEqual(buildCommentInsertion('t', 'c05', 'Oriol', '2026-10-18'), { insert: '{==t==}{>>#c05 @Oriol 2026-10-18: <<}', cursor: 34 });
assert.equal(buildCommentInsertion('', 'c05', '', '2026-10-18').insert, '{>>#c05 <<}', 'a date without an author is dropped');
const toggle = (text: string) => {
  const mark = findCriticMarks(text).find((candidate) => candidate.kind === 'comment')!;
  const change = toggleCommentResolved(text, mark);
  return text.slice(0, change.from) + change.insert + text.slice(change.to);
};
assert.equal(toggle('a {>>#c1 @O 2026-10-18: note<<}'), 'a {>>#c1 @O 2026-10-18: [x] note<<}');
assert.equal(toggle('a {>>#c1 @O: [x] note<<}'), 'a {>>#c1 @O: note<<}');
assert.equal(toggle('a {>>plain<<}'), 'a {>>[x] plain<<}');
assert.equal(toggle('a {>>#c1 only id<<}'), 'a {>>#c1 [x] only id<<}');

// Accept / reject all: one set of changes, optionally limited to a range.
const doc = 'A {++one++} B {--two--} C {~~x~>y~~} D {==h==}{>>#c1 n<<}';
const apply = (decision: 'accept' | 'reject', range?: { from: number; to: number }) => {
  const changes = resolveAllCriticUnits(doc, groupCriticUnits(findCriticMarks(doc)), decision, range);
  return [...changes].sort((left, right) => right.from - left.from)
    .reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), doc);
};
assert.equal(apply('accept'), 'A one B  C y D {==h==}{>>#c1 n<<}', 'bulk accept keeps open notes and highlights');
assert.equal(apply('reject'), 'A  B two C x D {==h==}{>>#c1 n<<}', 'bulk reject keeps open notes and highlights');
const closed = 'A {++one++} {==h==}{>>#c1 [x] n<<} {>>#c2 [x] loose<<} {>>#c3 open<<}';
const closedChanges = resolveAllCriticUnits(closed, groupCriticUnits(findCriticMarks(closed)), 'accept');
assert.equal([...closedChanges].sort((left, right) => right.from - left.from)
  .reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), closed), 'A one h  {>>#c3 open<<}', 'resolved notes are cleared, open ones stay');
assert.equal(apply('accept', { from: 0, to: doc.indexOf(' B ') }), 'A one B {--two--} C {~~x~>y~~} D {==h==}{>>#c1 n<<}', 'a range limits the units');
assert.equal(resolveAllCriticUnits('plain', [], 'accept').length, 0);

// Nested marks: the scanner finds inner marks, and bulk review resolves them with their parent.
const applyAll = (text: string, decision: 'accept' | 'reject', range?: { from: number; to: number }) =>
  [...resolveAllCriticUnits(text, groupCriticUnits(findCriticMarks(text)), decision, range)]
    .sort((left, right) => right.from - left.from)
    .reduce((output, change) => output.slice(0, change.from) + change.insert + output.slice(change.to), text);
assert.deepEqual(findCriticMarks('{++A {--B--} C++}').map((mark) => [mark.kind, mark.from, mark.to]), [['add', 0, 17], ['del', 5, 12]], 'inner marks are found');
assert.equal(applyAll('{++A {--B--} C++}', 'accept'), 'A  C', 'accepting an addition resolves the deletion inside it');
assert.equal(applyAll('{++A {--B--} C++}', 'reject'), '', 'rejecting an addition drops everything inside it');
assert.equal(applyAll('{--A {++B++} C--}', 'reject'), 'A  C', 'rejecting a deletion rejects the addition inside it');
assert.equal(applyAll('x {~~a {++b++}~>c {--d--}~~} y', 'accept'), 'x c  y', 'substitution halves resolve their inner marks');
assert.equal(applyAll('x {~~a {++b++}~>c {--d--}~~} y', 'reject'), 'x a  y');
assert.equal(applyAll('{==see {++new++} text==}{>>#c1 open<<}', 'accept'), '{==see new text==}{>>#c1 open<<}', 'an open note stays; changes inside its highlight resolve');
assert.equal(applyAll('{==see {++new++} text==}{>>#c1 [x] done<<}', 'accept'), 'see new text', 'a resolved note clears its highlight and inner changes');
assert.equal(applyAll('{++a {>>#c1 open<<} b++}', 'reject'), '', 'rejecting an addition drops a note proposed with it');
assert.equal(applyAll('{++a {>>#c1 open<<} b++}', 'accept'), 'a {>>#c1 open<<} b', 'accepting keeps the open note inside');
const nestedDoc = 'P {++outer {--inner--} end++} Q';
const innerFrom = nestedDoc.indexOf('{--');
assert.equal(applyAll(nestedDoc, 'accept', { from: innerFrom, to: nestedDoc.indexOf('--}') + 3 }), 'P {++outer  end++} Q', 'a range around an inner mark resolves only that mark');
// The highlight's glued comment is found past its inner marks; the cursor picks the innermost unit.
const gluedNested = groupCriticUnits(findCriticMarks('{==a {++b++} c==}{>>#c1 n<<}'));
assert.deepEqual(gluedNested.map((unit) => [unit.kind, unit.from, unit.to, !!unit.comment]), [['hl', 0, 28, true], ['add', 5, 12, false]]);
assert.equal(criticUnitAt(groupCriticUnits(findCriticMarks(nestedDoc)), innerFrom + 4)?.kind, 'del', 'the cursor resolves the innermost mark');
assert.equal(resolve(nestedDoc, innerFrom + 4, 'reject'), 'P {++outer inner end++} Q');
// Overlapping (not nested) matches are not marks; a comment body holds no marks.
assert.deepEqual(findCriticMarks('{>>note {++x++}<<}').map((mark) => mark.kind), ['comment']);
assert.deepEqual(findCriticMarks('{==a {++b==} c++}').map((mark) => mark.kind), ['hl'], 'an inner match crossing its parent is not a mark');

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-criticmarkup-review-'));
const build = await Bun.build({
  entrypoints: [path.join(repoRoot, 'scripts', 'test-highlight-entry.ts')],
  outdir: tempDir, target: 'browser', format: 'iife', naming: 'bundle.js'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
  await page.evaluate(() => document.documentElement.classList.add('meo-critic-markup'));

  // Review buttons: appear with the cursor in a mark, resolve it, and undo restores it.
  const review = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 80));
    const text = 'Say {++new++} and {~~old~>fresh~~} now.\n\nSecond paragraph.';
    const editor = harness.createEditor({ parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {} });
    const place = async (anchor: number) => { editor.view.dispatch({ selection: { anchor } }); await settle(); };
    const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.meo-critic-review-button')).map((button) => button.dataset.decision);
    const visible = () => { const tip = document.querySelector<HTMLElement>('.cm-tooltip.meo-critic-review'); return !!tip && getComputedStyle(tip).display !== 'none'; };
    await place(text.length);
    const outside = { buttons: buttons(), visible: visible() };
    await place(8);
    const inside = { buttons: buttons(), visible: visible() };
    document.documentElement.classList.remove('meo-critic-markup');
    await settle();
    const whileOff = visible();
    document.documentElement.classList.add('meo-critic-markup');
    await settle();
    document.querySelector<HTMLButtonElement>('.meo-critic-review-button.is-accept')!.click();
    await settle();
    const accepted = editor.getText();
    editor.undo();
    await settle();
    const undone = editor.getText();
    const second = text.indexOf('fresh');
    await place(second);
    document.querySelector<HTMLButtonElement>('.meo-critic-review-button.is-reject')!.click();
    await settle();
    const rejected = editor.getText();
    editor.destroy();
    return { outside, inside, whileOff, accepted, undone, rejected, text };
  });
  assert.deepEqual(review.outside, { buttons: [], visible: false }, 'no review buttons outside a mark');
  assert.deepEqual(review.inside, { buttons: ['accept', 'reject'], visible: true }, 'review buttons inside a mark');
  assert.equal(review.whileOff, false, 'review buttons are hidden while CriticMarkup is off');
  assert.equal(review.accepted, 'Say new and {~~old~>fresh~~} now.\n\nSecond paragraph.');
  assert.equal(review.undone, review.text, 'undo restores the mark');
  assert.equal(review.rejected, 'Say {++new++} and old now.\n\nSecond paragraph.');

  // Comment button: wraps the selection, picks the next #cNN and leaves the cursor in the note.
  const comment = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 80));
    const text = 'Pick this phrase now.\n{>>#c07 @Old: earlier<<}';
    const editor = harness.createEditor({ parent: document.getElementById('app')!, text, initialMode: 'source', onApplyChanges() {} });
    const from = text.indexOf('this phrase');
    editor.view.dispatch({ selection: { anchor: from, head: from + 'this phrase'.length } });
    harness.setCriticCommentAuthor('Oriol');
    document.documentElement.classList.add('meo-critic-markup');
    editor.insertFormat('criticComment');
    await settle();
    const withSelection = editor.getText();
    const cursorAfter = editor.view.state.selection.main.head;
    const cursorContext = withSelection.slice(cursorAfter - 10, cursorAfter + 3);
    editor.view.dispatch({ selection: { anchor: 0 } });
    harness.setCriticCommentAuthor('');
    editor.insertFormat('criticComment');
    await settle();
    const withoutSelection = editor.getText();
    const buttonHiddenWhenOff = (() => {
      const menu = harness.createSelectionMenu().menu;
      document.body.append(menu);
      const button = menu.querySelector<HTMLElement>('[data-action="criticComment"]')!;
      document.documentElement.classList.remove('meo-critic-markup');
      const hidden = getComputedStyle(button).display === 'none';
      document.documentElement.classList.add('meo-critic-markup');
      const shown = getComputedStyle(button).display !== 'none';
      menu.remove();
      return { hidden, shown };
    })();
    editor.destroy();
    return { withSelection, cursorContext, withoutSelection, buttonHiddenWhenOff };
  });
  assert.equal(comment.withSelection, 'Pick {==this phrase==}{>>#c08 @Oriol: <<} now.\n{>>#c07 @Old: earlier<<}');
  assert.equal(comment.cursorContext, '8 @Oriol: <<}', 'cursor sits in the note, before the closing delimiter');
  assert.ok(comment.withoutSelection.startsWith('{>>#c09 <<}Pick '), `no selection, no author: ${comment.withoutSelection}`);
  assert.deepEqual(comment.buttonHiddenWhenOff, { hidden: true, shown: true }, 'toolbar button follows the checkbox');

  // Comment list: one row per comment (a highlight glued to it counts as its anchor), click jumps.
  const list = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 80));
    const text = ['Alpha {==anchor==}{>>#c01 @Oriol: first note<<} beta.', '', 'Gamma {>>#c02 loose note<<} delta.', '', 'Skip `{>>#c03 code<<}` here.'].join('\n');
    const editor = harness.createEditor({ parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {} });
    const panel = harness.createCriticCommentsPanel({ getView: () => editor.view, getStrings: () => ({ title: 'Comments', empty: 'None', acceptAll: 'Accept all', rejectAll: 'Reject all', hideResolved: 'Hide resolved', markResolved: 'Resolved' }) });
    document.body.append(panel.element);
    panel.open();
    const rows = Array.from(panel.element.querySelectorAll('.meo-critic-comments-row')).map((row: any) => ({
      meta: row.querySelector('.meo-critic-comments-meta').textContent, body: row.querySelector('.meo-critic-comments-body').textContent
    }));
    (panel.element.querySelectorAll('.meo-critic-comments-row')[1] as HTMLElement).click();
    await settle();
    const selection = editor.view.state.selection.main;
    const selected = text.slice(selection.from, selection.to);
    const closed = panel.element.hidden;
    const first = text.indexOf('{==anchor');
    (panel.element.querySelectorAll('.meo-critic-comments-row')[0] as HTMLElement)?.click();
    panel.open();
    (panel.element.querySelectorAll('.meo-critic-comments-row')[0] as HTMLElement).click();
    const firstSelection = editor.view.state.selection.main;
    editor.setText('No marks at all.');
    panel.open();
    const empty = panel.element.querySelector('.meo-critic-comments-empty')?.textContent;
    panel.element.remove();
    editor.destroy();
    return { rows, selected, closed, firstFrom: firstSelection.from === first, empty };
  });
  assert.deepEqual(list.rows, [
    { meta: '#c01 @Oriol L1', body: 'first note' },
    { meta: '#c02 L3', body: 'loose note' }
  ], 'comments are listed in order, code excluded');
  assert.equal(list.selected, '{>>#c02 loose note<<}', 'a row selects its comment');
  assert.equal(list.closed, true, 'the panel closes after a jump');
  assert.equal(list.firstFrom, true, 'a glued comment selects from its highlight');
  assert.equal(list.empty, 'None', 'empty state');

  // Resolved toggle, hide-resolved filter, accept/reject all (document or selection) and dates.
  const extras = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 80));
    const text = 'A {++new++} b {--old--} c {==h==}{>>#c01 @O 2026-10-18: pending<<} d {>>#c02 [x] done<<}';
    const editor = harness.createEditor({ parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {} });
    const panel = harness.createCriticCommentsPanel({ getView: () => editor.view, getStrings: () => ({ title: 'Comments', empty: 'None', acceptAll: 'Accept all', rejectAll: 'Reject all', hideResolved: 'Hide resolved', markResolved: 'Resolved' }) });
    document.body.append(panel.element);
    panel.open();
    const rows = () => Array.from(panel.element.querySelectorAll('.meo-critic-comments-item')).map((item: any) => ({
      meta: item.querySelector('.meo-critic-comments-meta').textContent, resolved: item.classList.contains('is-resolved'),
      body: item.querySelector('.meo-critic-comments-body').textContent
    }));
    const initial = rows();
    (panel.element.querySelectorAll('.meo-critic-comments-check')[0] as HTMLInputElement).click();
    await settle();
    const afterToggle = editor.getText();
    (panel.element.querySelectorAll('.meo-critic-comments-check')[0] as HTMLInputElement).click();
    await settle();
    const afterUntoggle = editor.getText();
    (panel.element.querySelector('.meo-critic-comments-filter input') as HTMLInputElement).click();
    const filtered = rows();
    (panel.element.querySelector('.meo-critic-comments-filter input') as HTMLInputElement).click();
    const action = (name: string) => (panel.element.querySelector(`.meo-critic-comments-action.${name}`) as HTMLElement).click();
    action('is-accept');
    await settle();
    const acceptedAll = editor.getText();
    editor.undo();
    await settle();
    const restored = editor.getText();
    action('is-reject');
    await settle();
    const rejectedAll = editor.getText();
    editor.undo();
    await settle();
    editor.view.dispatch({ selection: { anchor: 0, head: text.indexOf(' b ') } });
    action('is-accept');
    await settle();
    const acceptedInSelection = editor.getText();
    panel.element.remove();
    editor.destroy();
    return { text, initial, afterToggle, afterUntoggle, filtered, acceptedAll, restored, rejectedAll, acceptedInSelection };
  });
  assert.deepEqual(extras.initial, [
    { meta: '#c01 @O 2026-10-18 L1', resolved: false, body: 'pending' },
    { meta: '#c02 L1', resolved: true, body: 'done' }
  ], 'the list shows date and resolved state');
  assert.equal(extras.afterToggle, extras.text.replace('2026-10-18: pending', '2026-10-18: [x] pending'), 'toggle adds the marker');
  assert.equal(extras.afterUntoggle, extras.text, 'toggling twice restores the text');
  assert.deepEqual(extras.filtered.map((row: { body: string }) => row.body), ['pending'], 'hide resolved filters the list');
  assert.equal(extras.acceptedAll, 'A new b  c {==h==}{>>#c01 @O 2026-10-18: pending<<} d ', 'accept all resolves changes and resolved notes, keeping open ones');
  assert.equal(extras.restored, extras.text, 'accept all is one undo step');
  assert.equal(extras.rejectedAll, 'A  b old c {==h==}{>>#c01 @O 2026-10-18: pending<<} d ', 'reject all keeps the originals and open notes');
  assert.equal(extras.acceptedInSelection, extras.text.replace('{++new++}', 'new'), 'a selection limits accept all');

  // Accept / reject all respect syntax contexts the renderer treats as literal, and resolve nested marks.
  const contexts = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 80));
    const text = [
      'Escaped \\{++keep++} here.',
      'Math $x{++y++}$ stays.',
      '',
      '$$',
      'a{--b--}',
      '$$',
      '',
      'Link [t](http://x/{++a++}) and <http://y/{--b--}>.',
      'Code `{++c++}` stays.',
      '',
      'Nested {++A {--B--} C++} and {==mark {>>#c05 @O: inner note<<} text==}.'
    ].join('\n');
    const editor = harness.createEditor({ parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {} });
    const panel = harness.createCriticCommentsPanel({ getView: () => editor.view, getStrings: () => ({ title: 'C', empty: 'None', acceptAll: 'A', rejectAll: 'R', hideResolved: 'H', markResolved: 'M' }) });
    document.body.append(panel.element);
    panel.open();
    await settle();
    const listed = Array.from(panel.element.querySelectorAll('.meo-critic-comments-body')).map((node) => node.textContent);
    const action = (name: string) => (panel.element.querySelector(`.meo-critic-comments-action.${name}`) as HTMLElement).click();
    action('is-accept');
    await settle();
    const accepted = editor.getText();
    editor.undo();
    await settle();
    action('is-reject');
    await settle();
    const rejected = editor.getText();
    panel.element.remove();
    editor.destroy();
    return { text, listed, accepted, rejected };
  });
  const untouched = contexts.text.split('\n').slice(0, 9).join('\n');
  assert.deepEqual(contexts.listed, ['inner note'], 'a comment nested in a highlight is listed');
  assert.equal(contexts.accepted, `${untouched}\n\nNested A  C and {==mark {>>#c05 @O: inner note<<} text==}.`, 'accept all leaves escapes, math, URLs and code alone and resolves nested marks');
  assert.equal(contexts.rejected, `${untouched}\n\nNested  and {==mark {>>#c05 @O: inner note<<} text==}.`, 'reject all does the same');

  // Dates: the comment button writes today after the author.
  const dated = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const editor = harness.createEditor({ parent: document.getElementById('app')!, text: 'Pick this.', initialMode: 'source', onApplyChanges() {} });
    editor.view.dispatch({ selection: { anchor: 5, head: 9 } });
    harness.setCriticCommentAuthor('Oriol');
    harness.setCriticCommentDates(true);
    editor.insertFormat('criticComment');
    const withDate = editor.getText();
    harness.setCriticCommentDates(false);
    editor.destroy();
    return withDate;
  });
  assert.match(dated, /^Pick \{==this==\}\{>>#c01 @Oriol \d{4}-\d{2}-\d{2}: <<\}\.$/, `date after the author: ${dated}`);

  // The list shows a comment's type tag next to its id and author.
  const typedRow = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const text = 'x {>>#c1 @O: [FUENTE] cite it<<} y';
    const editor = harness.createEditor({ parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {} });
    const panel = harness.createCriticCommentsPanel({ getView: () => editor.view, getStrings: () => ({ title: 'C', empty: 'None', acceptAll: 'A', rejectAll: 'R', hideResolved: 'H', markResolved: 'M' }) });
    document.body.append(panel.element);
    panel.open();
    const item = panel.element.querySelector('.meo-critic-comments-item') as HTMLElement;
    const result = { meta: item.querySelector('.meo-critic-comments-meta')!.textContent, body: item.querySelector('.meo-critic-comments-body')!.textContent, typed: item.classList.contains('is-type-fuente') };
    panel.element.remove();
    editor.destroy();
    return result;
  });
  assert.deepEqual(typedRow, { meta: '#c1 @O [FUENTE] L1', body: 'cite it', typed: true }, 'type shows in the list');

  // A selection that already holds a highlight gets its note after it instead of a nested highlight.
  const conflict = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const text = 'a {==b==} c';
    const editor = harness.createEditor({ parent: document.getElementById('app')!, text, initialMode: 'source', onApplyChanges() {} });
    editor.view.dispatch({ selection: { anchor: 0, head: text.length } });
    harness.setCriticCommentAuthor('');
    editor.insertFormat('criticComment');
    const result = editor.getText();
    editor.destroy();
    return result;
  });
  assert.equal(conflict, 'a {==b==} c{>>#c01 <<}', 'no nested highlight');

} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('CriticMarkup review logic test passed');
