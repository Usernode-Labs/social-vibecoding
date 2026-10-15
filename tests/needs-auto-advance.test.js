'use strict';

// #5179: once a vote is SAVED in Needs you, the feed moves to the next row
// on its own — the same smooth scroll the chevron and a swipe use — instead
// of waiting for the viewer to swipe up or press the arrow. After the last
// row it lands on the end card.
//
// Pinned from source (the behaviour is effects and a promise callback, which
// renderToStaticMarkup cannot reach): the advance is marked only where the
// vote is saved, spent after the render that records it, through the feed's
// own `go`, and it does not pull the viewer away from where they have got
// to in the meantime.
//
// Run with: node --test tests/needs-auto-advance.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');

const okBranch = WORKSHOP.slice(
  WORKSHOP.indexOf('if (ok === true) {'),
  WORKSHOP.indexOf('} else if (pinnedHere) {')
);

test('the feed owes an advance only where the vote is saved', () => {
  // Inside answer's ok === true branch, right beside setAnswered.
  assert.match(okBranch, /setAnswered\(\(cur\) => \(\{ \.\.\.cur, \[key\]: which \}\)\);\s*\n\s*\/\/ #5179[\s\S]*?advanceRef\.current = key;/,
    'the mark sits in the saved-vote branch, right after the vote is recorded');
  // The else branch (cancel, refusal, network failure) unpins and moves
  // nothing: no advance mark anywhere outside the ok branch.
  const elseBranch = WORKSHOP.slice(
    WORKSHOP.indexOf('} else if (pinnedHere) {'),
    WORKSHOP.indexOf('if (settled) settled();', WORKSHOP.indexOf('} else if (pinnedHere) {'))
  );
  assert.ok(!/advanceRef/.test(elseBranch), 'a vote not saved leaves the feed where it is');
});

test('the advance is spent after the render that records the vote, through the feed\'s own go', () => {
  // An effect keyed on `answered` — which only a saved vote changes — reads
  // the mark, clears it, and moves one row through goRef: the chevron's own
  // move, clamped to the end card on the last row. No second scroller.
  const effect = WORKSHOP.slice(WORKSHOP.indexOf('useEffect(() => {\n    const key = advanceRef.current;'), WORKSHOP.indexOf('}, [answered]);') + '}, [answered]);'.length);
  assert.ok(effect, 'the spending effect exists');
  assert.match(effect, /const key = advanceRef\.current;\s*\n\s*if \(!key\) return;\s*\n\s*advanceRef\.current = null;/,
    'it reads the mark and spends it, so a second answered render moves nothing');
  assert.match(effect, /goRef\.current\(1\);/, 'one row forward, through the feed\'s own go');
  assert.ok(!/scrollTo/.test(effect), 'no scrolling of its own: the move is the feed\'s smooth scroll');
  assert.match(effect, /}, \[answered\]\);/, 'keyed on the answered record, which only a saved vote changes');
});

test('the advance does not pull the viewer away from where they have got to', () => {
  const effect = WORKSHOP.slice(WORKSHOP.indexOf('useEffect(() => {\n    const key = advanceRef.current;'), WORKSHOP.indexOf('}, [answered]);') + '}, [answered]);'.length);
  // Still on the row they voted on: a swipe or a press got there first, no
  // move. curKeyRef is what the feed is re-synced and landed by.
  assert.match(effect, /if \(curKeyRef\.current !== key \|\| sheetRef\.current !== null\) return;/,
    'no move when the viewer moved on or a sheet (Comments, Ask, Vote) is up');
  // sheetRef mirrors the sheet of the render in view: answer's promise
  // closes over the stale one from the render that cast the vote.
  assert.match(WORKSHOP, /const sheetRef = useRef<SheetKind \| null>\(sheet\);/,
    'the sheet is mirrored in a ref, seeded from the state');
  assert.match(WORKSHOP, /useLayoutEffect\(\(\) => \{ sheetRef\.current = sheet; \}\);/,
    'and refreshed every render, the way goRef is');
});

test('the voted card stays in its slot, so the next row is the next one owed', () => {
  // The pin (QA 2026-09-24) is what keeps the voted row in place while the
  // feed advances past it — the advance relies on it: index i + 1 is the
  // next owed row, and swiping back still shows "Voted yes/no".
  assert.match(WORKSHOP, /const pinnedHere = !pinsRef\.current\.has\(row\.key\);/,
    'the row is pinned when the vote is cast');
  assert.match(WORKSHOP, /for \(const \[key, pin\] of pinsRef\.current\) \{/,
    'and the pin keeps it in items while its store copy drops it');
});
