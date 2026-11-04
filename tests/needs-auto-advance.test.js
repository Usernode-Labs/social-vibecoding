'use strict';

// #5179, as the review flow replaced the reel (#6276): a saved vote no
// longer moves the viewer on its own. The vote sheet's control becomes Next,
// and Next is the only move forward; Skip turns the page without recording
// anything. All moves go through the flow's `goTo`, which guards one move in
// flight and ends the run on the last change.
//
// Pinned from source (the behaviour is effects and a promise callback, which
// renderToStaticMarkup cannot reach).
//
// Run with: node --test tests/needs-auto-advance.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const FLOW = read('frontend/src/features/review-flow/review-flow.tsx');
const SHEET = read('frontend/src/features/review-flow/vote-sheet.tsx');

const slice = (src, from, to) => {
  const start = src.indexOf(from);
  return src.slice(start, src.indexOf(to, start));
};

test('a saved vote keeps the change on screen; Next is the move', () => {
  // The vote function records the vote, tells the screen that owns the feed,
  // and returns true. It does not call goTo or goNext: the page waits for
  // the viewer's next press.
  const saved = slice(FLOW, 'const vote = async', 'const undo = async');
  assert.match(saved, /onAnswered\?\.\(item\.id, item\.epoch\);\s*\n\s*return true;/,
    'the saved vote is reported and returns, without a move');
  assert.ok(!/goTo\(|goNext\(/.test(saved), 'a saved vote never advances on its own');
  // The sheet's one control is Skip before a vote and Next after it.
  assert.match(SHEET, /onClick=\{vote \? onNext : onSkip\}/,
    'the vote sheet hands its press to Next once there is a vote');
});

test('Next and Skip both move through goTo, and the last change ends the run', () => {
  assert.match(FLOW, /const goNext = \(\) => goTo\(next\);/,
    'Next is one step through goTo');
  assert.match(FLOW, /goTo\(nextIndex\(run, index, now\)\);/,
    'Skip turns the page through the same goTo, with the skip passed in');
  assert.match(FLOW, /if \(n < 0\) \{ finishAll\(\); return; \}/,
    'past the last change, goTo ends the run instead of moving');
});

test('Skip records nothing: it marks the change passed over and turns the page', () => {
  const skip = slice(FLOW, 'const skip = () =>', 'useLayoutEffect');
  assert.match(skip, /setSkipped\(\(cur\) => \(\{ \.\.\.cur, \[item\.key\]: true \}\)\);/,
    'the change is marked passed over, not voted on');
  assert.match(skip, /goTo\(nextIndex\(run, index, now\)\);/,
    'and the flow moves on with that mark');
  assert.ok(!/castVote|retractVote/.test(skip), 'Skip never reaches the vote API');
});

test('one move is in flight at a time, and it is released when it lands', () => {
  assert.match(FLOW, /const goTo = \(n: number\) => \{\s*\n\s*if \(busy\.current \|\| !item\) return;/,
    'a second move is refused while one is running');
  assert.match(FLOW, /busy\.current = true;\s*\n\s*setSheet\(/,
    'the move marks itself in flight before it changes the index');
  assert.match(FLOW, /const settle = \(\) => \{ setFrom\(null\); busy\.current = false; \};/,
    'and the landing releases it');
});
