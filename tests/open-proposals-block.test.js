// Tests for buildOpenProposalsBlock (src/routes/sessions.js) — the #199
// OPEN PROPOSALS block injected into the Mayor's system prompt on the first
// turn of a fresh session so it can flag requests that duplicate an existing
// promoted/merging proposal. Pure rendering over candidate-query rows.
//
// Run with: node --test tests/open-proposals-block.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOpenProposalsBlock } = require('../src/routes/sessions.js');

function proposal(overrides = {}) {
  return {
    id: 7,
    pr_number: 12,
    pr_url: 'https://github.com/org/repo/pull/12',
    pr_title: 'Add leaderboard',
    status: 'promoted',
    linked_issues: [5, 9],
    spec_md: '# Spec: Leaderboard\n\nShow top scores.',
    username: 'evan',
    ...overrides,
  };
}

test('empty or missing list renders nothing', () => {
  assert.equal(buildOpenProposalsBlock([], 'alice'), '');
  assert.equal(buildOpenProposalsBlock(null, 'alice'), '');
  assert.equal(buildOpenProposalsBlock(undefined, 'alice'), '');
  assert.equal(buildOpenProposalsBlock([null, undefined], 'alice'), '');
});

test('renders PR reference, author, status, url, issues, and spec excerpt', () => {
  const block = buildOpenProposalsBlock([proposal()], 'alice');
  assert.match(block, /==== OPEN PROPOSALS IN THIS APP ====/);
  assert.match(block, /==== END OPEN PROPOSALS ====/);
  assert.match(block, /PR #12 — "Add leaderboard"/);
  assert.match(block, /Author: evan · Status: promoted · https:\/\/github\.com\/org\/repo\/pull\/12/);
  assert.match(block, /Issues: #5, #9/);
  assert.match(block, /Spec excerpt: # Spec: Leaderboard Show top scores\./);
});

test('contains the duplicate-detection instruction text', () => {
  const block = buildOpenProposalsBlock([proposal()], 'alice');
  assert.match(block, /Before dispatching ANY tool/);
  assert.match(block, /SUBSTANTIALLY duplicates/);
  assert.match(block, /Want to vote on that in the group chat instead\?/);
  assert.match(block, /How this differs from PR #N/);
});

test('annotates the caller\'s own proposal', () => {
  const block = buildOpenProposalsBlock([proposal()], 'evan');
  assert.match(block, /Author: evan \(this user's own proposal\)/);
  // Another author is NOT annotated.
  const other = buildOpenProposalsBlock([proposal()], 'alice');
  assert.doesNotMatch(other, /this user's own proposal/);
});

test('falls back gracefully when fields are missing', () => {
  const block = buildOpenProposalsBlock([proposal({
    pr_number: null,
    pr_url: null,
    pr_title: null,
    linked_issues: [],
    spec_md: '',
    username: null,
    status: null,
  })], 'alice');
  assert.match(block, /Untitled proposal \(no PR yet\)/);
  assert.match(block, /Author: unknown · Status: promoted/);
  assert.doesNotMatch(block, /Issues:/);
  assert.doesNotMatch(block, /Spec excerpt:/);
});

test('titled proposal without a PR number renders the title with no-PR marker', () => {
  const block = buildOpenProposalsBlock([proposal({ pr_number: null })], 'alice');
  assert.match(block, /"Add leaderboard" \(no PR yet\)/);
});

test('spec excerpt is truncated to ~500 chars on a word boundary with ellipsis', () => {
  const long = 'word '.repeat(300); // 1500 chars
  const block = buildOpenProposalsBlock([proposal({ spec_md: long })], 'alice');
  const line = block.split('\n').find((l) => l.includes('Spec excerpt:'));
  assert.ok(line, 'spec excerpt line present');
  const excerpt = line.split('Spec excerpt: ')[1];
  assert.ok(excerpt.length <= 502, `excerpt too long: ${excerpt.length}`);
  assert.match(excerpt, /…$/);
  // Word-boundary cut: no sliced fragment of "word" right before the ellipsis.
  assert.doesNotMatch(excerpt, /wor…$/);
});

test('spec excerpt collapses newlines so each proposal stays one entry', () => {
  const block = buildOpenProposalsBlock([proposal({ spec_md: 'line one\n\nline two' })], 'alice');
  assert.match(block, /Spec excerpt: line one line two/);
});

test('caps the list at 10 entries', () => {
  const many = Array.from({ length: 14 }, (_, i) => proposal({
    pr_number: 100 + i,
    pr_title: `Proposal ${i}`,
  }));
  const block = buildOpenProposalsBlock(many, 'alice');
  for (let i = 0; i < 10; i++) assert.match(block, new RegExp(`PR #${100 + i} `));
  for (let i = 10; i < 14; i++) assert.doesNotMatch(block, new RegExp(`PR #${100 + i} `));
});

test('non-integer linked issue values are filtered out', () => {
  const block = buildOpenProposalsBlock([proposal({ linked_issues: [3, 'x', null, 8] })], 'alice');
  assert.match(block, /Issues: #3, #8/);
});
