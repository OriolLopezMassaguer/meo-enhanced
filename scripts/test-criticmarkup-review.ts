import assert from 'node:assert/strict';
import {
  buildCommentInsertion, criticUnitAt, findCriticMarks, groupCriticUnits, nextCommentId, resolveCriticUnit
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

console.log('CriticMarkup review logic test passed');
