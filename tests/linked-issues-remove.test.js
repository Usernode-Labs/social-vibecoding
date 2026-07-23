// Tests for the #733 issue-unlinking helpers in src/services/pr-metadata.js:
//
//  - applyIssueDeclarations(existing, adds, removes) — the dispatch-time set
//    arithmetic behind `addresses_issues` / `removes_issues`: union the
//    additions, subtract the removals (removal wins on a same-call conflict).
//  - stripClosingLines(body, numbers) — the targeted PR-body patch that
//    removes platform-format `Closes #N` lines for unlinked numbers without
//    touching anything else in the body.
//
// Run with: node --test tests/linked-issues-remove.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyIssueDeclarations, stripClosingLines, sameIssueSet, parseClosingKeywords,
} = require('../src/services/pr-metadata');

// ---------------------------------------------------------------- applyIssueDeclarations

test('add-only matches the legacy union behavior', () => {
  assert.deepEqual(applyIssueDeclarations([1, 3], [2, 3], []), [1, 2, 3]);
  assert.deepEqual(applyIssueDeclarations([], [7], undefined), [7]);
});

test('remove-only subtracts from the existing set', () => {
  assert.deepEqual(applyIssueDeclarations([1, 166, 200], [], [166]), [1, 200]);
});

test('removal wins when the same number is added and removed in one call', () => {
  assert.deepEqual(applyIssueDeclarations([1], [166], [166]), [1]);
});

test('removing a number that was never linked is a no-op', () => {
  assert.deepEqual(applyIssueDeclarations([1, 2], [], [999]), [1, 2]);
});

test('removal can empty the set', () => {
  assert.deepEqual(applyIssueDeclarations([166], [], [166]), []);
});

test('sanitizes and dedupes both declaration lists', () => {
  assert.deepEqual(
    applyIssueDeclarations([3, 1], ['2', 2, -5, 4.5, null], ['1', NaN]),
    [2, 3]
  );
});

test('a later addition re-links a previously removed number (no tombstones)', () => {
  const afterCut = applyIssueDeclarations([1, 166], [], [166]);
  assert.deepEqual(applyIssueDeclarations(afterCut, [166], []), [1, 166]);
});

test('a strict subset reports as a changed set (the drift gate fires on shrinkage)', () => {
  assert.equal(sameIssueSet([1, 2, 3], [1, 2]), false);
  assert.equal(sameIssueSet([1, 2], [2, 1]), true);
});

// ---------------------------------------------------------------- stripClosingLines

test('strips exactly the named Closes line and consumes its newline', () => {
  const body = 'Summary.\n\nCloses #75\nCloses #166\nCloses #200\n\n---\n_footer_';
  assert.equal(
    stripClosingLines(body, [166]),
    'Summary.\n\nCloses #75\nCloses #200\n\n---\n_footer_'
  );
});

test('strips several numbers in one call', () => {
  const body = 'Closes #1\nCloses #2\nCloses #3';
  // Each stripped line consumes its OWN trailing newline; the newline
  // preceding an end-of-body line belongs to the line above and stays.
  assert.equal(stripClosingLines(body, [1, 3]), 'Closes #2\n');
});

test('leaves hand-written closing variants and prose mentions untouched', () => {
  const body = 'Fixes #166\nAlso see #166 for context.\nCloses #166\ncloses #166 too';
  assert.equal(
    stripClosingLines(body, [166]),
    'Fixes #166\nAlso see #166 for context.\ncloses #166 too'
  );
});

test('does not touch a longer number sharing a prefix (#1660 vs #166)', () => {
  const body = 'Closes #1660\nCloses #166';
  assert.equal(stripClosingLines(body, [166]), 'Closes #1660\n');
});

test('tolerates trailing whitespace on the platform line', () => {
  assert.equal(stripClosingLines('Closes #166  \nCloses #2', [166]), 'Closes #2');
});

test('strips a Closes line at the very end of the body (no trailing newline)', () => {
  assert.equal(stripClosingLines('Body.\n\nCloses #166', [166]), 'Body.\n\n');
});

test('is a no-op when the number appears nowhere', () => {
  const body = 'Body.\n\nCloses #75';
  assert.equal(stripClosingLines(body, [166]), body);
});

test('handles non-string and empty bodies without throwing', () => {
  assert.equal(stripClosingLines('', [166]), '');
  assert.equal(stripClosingLines(null, [166]), '');
  assert.equal(stripClosingLines(undefined, [166]), '');
});

test('stripped body no longer parses the removed number as a closing keyword', () => {
  const body = 'Summary.\n\nCloses #75\nCloses #166\n\n---\n_footer_';
  const stripped = stripClosingLines(body, [166]);
  assert.deepEqual(parseClosingKeywords(stripped), [75]);
});
