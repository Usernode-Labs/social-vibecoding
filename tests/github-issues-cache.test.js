// Tests for src/services/github.js noteIssueCreated() — the open-issues
// cache seeding used by routes/feedback.js (#125) so a just-submitted
// feedback issue shows up in the "Open Issues" panel without waiting out
// the 5-minute cache TTL or re-hitting GitHub's anonymous rate limit.
//
// fetchPublicIssues talks to api.github.com via global fetch, so we stub
// fetch with a canned issues payload to populate the cache, then assert
// that noteIssueCreated prepends into the cached result (visible through
// a second, fetch-free fetchPublicIssues call).
//
// Run with: node --test tests/github-issues-cache.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const github = require('../src/services/github');

function fakeIssue(number, title, updatedAt) {
  return {
    number,
    title,
    body: `body of #${number}`,
    labels: [{ name: 'usernode' }],
    updated_at: updatedAt,
    html_url: `https://github.com/o/r/issues/${number}`,
  };
}

function stubFetch(issues) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null }, // no Link header, no rate-limit header
      json: async () => issues,
    };
  };
  return calls;
}

test('noteIssueCreated returns false when the repo has no cache entry', () => {
  assert.strictEqual(
    github.noteIssueCreated('nobody', 'nothing-cached', fakeIssue(1, 'x', '2026-06-10T00:00:00Z')),
    false
  );
});

test('noteIssueCreated rejects malformed input', () => {
  assert.strictEqual(github.noteIssueCreated(null, 'r', fakeIssue(1, 'x')), false);
  assert.strictEqual(github.noteIssueCreated('o', null, fakeIssue(1, 'x')), false);
  assert.strictEqual(github.noteIssueCreated('o', 'r', null), false);
  assert.strictEqual(github.noteIssueCreated('o', 'r', { title: 'no number' }), false);
});

test('seeds a cached repo so the next fetchPublicIssues sees the new issue without a network call', async () => {
  const origFetch = global.fetch;
  try {
    const calls = stubFetch([fakeIssue(1, 'first', '2026-06-09T00:00:00Z')]);

    const before = await github.fetchPublicIssues('SeedOwner', 'seed-repo');
    assert.strictEqual(before.issues.length, 1);
    assert.strictEqual(calls.length, 1);

    const created = fakeIssue(2, 'fresh feedback', '2026-06-10T00:00:00Z');
    assert.strictEqual(github.noteIssueCreated('SeedOwner', 'seed-repo', created), true);

    const after = await github.fetchPublicIssues('SeedOwner', 'seed-repo');
    assert.strictEqual(calls.length, 1, 'second read must come from cache');
    assert.strictEqual(after.issues.length, 2);
    assert.strictEqual(after.issues[0].number, 2, 'new issue is prepended');
    assert.strictEqual(after.issues[0].title, 'fresh feedback');
    assert.strictEqual(after.issues[0].htmlUrl, 'https://github.com/o/r/issues/2');
  } finally {
    global.fetch = origFetch;
  }
});

test('matches the cache key case-insensitively and ignores a trailing .git', async () => {
  const origFetch = global.fetch;
  try {
    stubFetch([fakeIssue(10, 'existing', '2026-06-09T00:00:00Z')]);
    await github.fetchPublicIssues('CaseOwner', 'case-repo');

    assert.strictEqual(
      github.noteIssueCreated('caseowner', 'Case-Repo.git', fakeIssue(11, 'new', '2026-06-10T00:00:00Z')),
      true
    );
    const after = await github.fetchPublicIssues('CaseOwner', 'case-repo');
    assert.strictEqual(after.issues[0].number, 11);
  } finally {
    global.fetch = origFetch;
  }
});

test('dedupes by issue number instead of double-inserting', async () => {
  const origFetch = global.fetch;
  try {
    stubFetch([fakeIssue(5, 'already listed', '2026-06-09T00:00:00Z')]);
    await github.fetchPublicIssues('DupOwner', 'dup-repo');

    assert.strictEqual(
      github.noteIssueCreated('DupOwner', 'dup-repo', fakeIssue(5, 'already listed (updated)', '2026-06-10T00:00:00Z')),
      true
    );
    const after = await github.fetchPublicIssues('DupOwner', 'dup-repo');
    assert.strictEqual(after.issues.length, 1);
    assert.strictEqual(after.issues[0].title, 'already listed (updated)');
  } finally {
    global.fetch = origFetch;
  }
});
