// Tests for the duplicate "Generate proposal" button fix: when a headless
// auto-solve run finished with a *question* outcome AND the viewer has
// already cloned it into their own session (h.mySessionId set), the issue
// row used to render BOTH "Go to session" and a second "Generate proposal"
// button — two competing actions for a proposal that already exists. The
// fix guards the question-outcome append with `!h.mySessionId` so the
// rerun affordance only appears on the no-session path.
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

test('the question-outcome Generate proposal append is guarded by !h.mySessionId', () => {
  // The `if (h.outcome === 'question')` block that appends the second
  // "Generate proposal" button must also test for the absence of a cloned
  // session, so it never fires alongside "Go to session".
  assert.match(
    src,
    /if\s*\(\s*h\.outcome === 'question'\s*&&\s*!h\.mySessionId\s*\)/
  );
});

test('the mySessionId branch emits Go to session without a Generate proposal call', () => {
  // Isolate the `if (h.mySessionId) { ... }` body and confirm it offers
  // "Go to session" (goToAutoSessionClone) and does NOT itself call
  // confirmAutoSession or render a "Generate proposal" button.
  const m = src.match(/if\s*\(\s*h\.mySessionId\s*\)\s*\{([\s\S]*?)\n\s*\}\s*else\s*\{/);
  assert.ok(m, 'expected an `if (h.mySessionId) { ... } else {` block in _renderIssueRow');
  const branch = m[1];
  assert.match(branch, /goToAutoSessionClone\(/);
  assert.doesNotMatch(branch, /confirmAutoSession\(/);
  assert.doesNotMatch(branch, /Generate proposal/);
});
