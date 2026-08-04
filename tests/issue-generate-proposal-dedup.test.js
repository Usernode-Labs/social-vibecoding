// #918: proposal actions are now deliberately single-path. Ready results
// enter Easy review, question reruns live inside that modal, and a result
// already cloned by this viewer has only Go to session.
//
// app-view.js has no DOM harness, so these are regex-over-source invariants
// in the style of issue-proposal-icon.test.js — cheap insurance against the
// guard being dropped in a future refactor of _renderIssueRow.
//
// Run with: node --test tests/issue-generate-proposal-dedup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf-8'
);

test('ready un-cloned issue rows open Easy review instead of cloning directly', () => {
  assert.match(src, /openEasyReview\(\$\{n\}, \$\{h\.sessionId\}\)/);
  assert.doesNotMatch(src, /autoBtn \+= .*Generate proposal/);
});

test('the mySessionId branch emits Go to session without review or generation calls', () => {
  // Isolate the `if (h.mySessionId) { ... }` body and confirm it offers
  // "Go to session" (goToAutoSessionClone) and does NOT itself call
  // confirmAutoSession or render a "Generate proposal" button.
  const m = src.match(/if\s*\(\s*h\.mySessionId\s*\)\s*\{([\s\S]*?)\n\s*\}\s*else\s*\{/);
  assert.ok(m, 'expected an `if (h.mySessionId) { ... } else {` block in _renderIssueRow');
  const branch = m[1];
  assert.match(branch, /goToAutoSessionClone\(/);
  assert.doesNotMatch(branch, /confirmAutoSession\(/);
  assert.doesNotMatch(branch, /openEasyReview\(/);
  assert.doesNotMatch(branch, /Generate proposal/);
});
