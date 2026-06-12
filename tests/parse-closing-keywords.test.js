// Tests for parseClosingKeywords (src/services/pr-metadata.js) — the regex the
// migrate-time backfill uses to recover linked_issues from historical PR
// bodies that carry GitHub closing keywords but predate the #75 plumbing.
//
// Run with: node --test tests/parse-closing-keywords.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClosingKeywords } = require('../src/services/pr-metadata');

test('parses a single Closes #N line', () => {
  assert.deepEqual(parseClosingKeywords('Some body.\n\nCloses #68'), [68]);
});

test('parses all GitHub closing-keyword variants', () => {
  const body = 'close #1\ncloses #2\nclosed #3\nfix #4\nfixes #5\nfixed #6\nresolve #7\nresolves #8\nresolved #9';
  assert.deepEqual(parseClosingKeywords(body), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('is case-insensitive and tolerates an optional colon', () => {
  assert.deepEqual(parseClosingKeywords('CLOSES #75\nFixed: #80'), [75, 80]);
});

test('dedupes and sorts ascending', () => {
  assert.deepEqual(parseClosingKeywords('Closes #80\nfixes #12\nresolved #80'), [12, 80]);
});

test('ignores bare #N without a closing keyword', () => {
  assert.deepEqual(parseClosingKeywords('See #61 and issue #99 for context.'), []);
});

test('does not match keywords embedded in other words', () => {
  // "discloses", "prefixes", "unresolved-ish" should not trigger.
  assert.deepEqual(parseClosingKeywords('This discloses #5 and prefixes #6.'), []);
});

test('ignores cross-repo references (owner/repo#N)', () => {
  assert.deepEqual(parseClosingKeywords('Closes octocat/Hello-World#12'), []);
});

test('handles a realistic PR body (the #82 case)', () => {
  const body = [
    "Show linked GitHub issues on PR cards.",
    "",
    "- plumbed linked_issues into three queries",
    "",
    "Closes #80",
    "",
    "---",
    "_Dev session by evan via Usernode_",
  ].join('\n');
  assert.deepEqual(parseClosingKeywords(body), [80]);
});

test('handles empty / non-string input', () => {
  assert.deepEqual(parseClosingKeywords(''), []);
  assert.deepEqual(parseClosingKeywords(null), []);
  assert.deepEqual(parseClosingKeywords(undefined), []);
});
