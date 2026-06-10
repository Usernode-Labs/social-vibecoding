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
    user: { login: `gh-user-${number}` },
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
    // #133: the GitHub-side creator login rides along so the Open Issues
    // panel's creator fallback chain works for seeded issues too.
    assert.strictEqual(after.issues[0].user, 'gh-user-2');
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

// ------------------------------------------------------------------
// #144: noteIssuesClosed / unsuppressIssues — the known-closed
// suppression list that keeps just-closed issues out of every
// fetchPublicIssues result (cached AND fresh), defeating GitHub's
// eventually-consistent anonymous list endpoint re-reporting a
// `Closes #N`-closed issue as open right after a merge.
// ------------------------------------------------------------------

test('noteIssuesClosed hides suppressed issues from cached results without a network call', async () => {
  const origFetch = global.fetch;
  try {
    const calls = stubFetch([
      fakeIssue(1, 'stays open', '2026-06-09T00:00:00Z'),
      fakeIssue(2, 'closed by merge', '2026-06-09T01:00:00Z'),
    ]);

    const before = await github.fetchPublicIssues('SupOwner', 'sup-repo');
    assert.strictEqual(before.issues.length, 2);
    assert.strictEqual(calls.length, 1);

    assert.strictEqual(github.noteIssuesClosed('SupOwner', 'sup-repo', [2]), 1);

    const after = await github.fetchPublicIssues('SupOwner', 'sup-repo');
    assert.strictEqual(calls.length, 1, 'must come from cache');
    assert.deepStrictEqual(after.issues.map((i) => i.number), [1]);
  } finally {
    global.fetch = origFetch;
  }
});

test('suppression also filters a FRESH fetch whose payload is stale (still lists the closed issue)', async () => {
  const origFetch = global.fetch;
  try {
    // No prior cache entry: suppression recorded first (merge path order),
    // then GitHub's stale list still carries the closed issue.
    assert.strictEqual(github.noteIssuesClosed('FreshOwner', 'fresh-repo', [7]), 1);
    stubFetch([
      fakeIssue(6, 'open', '2026-06-09T00:00:00Z'),
      fakeIssue(7, 'closed but list is stale', '2026-06-09T01:00:00Z'),
    ]);

    const res = await github.fetchPublicIssues('FreshOwner', 'fresh-repo');
    assert.deepStrictEqual(res.issues.map((i) => i.number), [6]);
  } finally {
    global.fetch = origFetch;
  }
});

test('unsuppressIssues resurfaces the issue from the (unfiltered) cache', async () => {
  const origFetch = global.fetch;
  try {
    const calls = stubFetch([fakeIssue(3, 'maybe closed', '2026-06-09T00:00:00Z')]);
    await github.fetchPublicIssues('UnsupOwner', 'unsup-repo');

    github.noteIssuesClosed('UnsupOwner', 'unsup-repo', [3]);
    const hidden = await github.fetchPublicIssues('UnsupOwner', 'unsup-repo');
    assert.strictEqual(hidden.issues.length, 0);

    assert.strictEqual(github.unsuppressIssues('UnsupOwner', 'unsup-repo', [3]), 1);
    const back = await github.fetchPublicIssues('UnsupOwner', 'unsup-repo');
    assert.strictEqual(calls.length, 1, 'all reads served from cache');
    assert.deepStrictEqual(back.issues.map((i) => i.number), [3]);
  } finally {
    global.fetch = origFetch;
  }
});

test('suppression expires after its TTL, resurfacing the issue without a refetch', async () => {
  const origFetch = global.fetch;
  try {
    const calls = stubFetch([fakeIssue(4, 'wrongly suppressed', '2026-06-09T00:00:00Z')]);
    await github.fetchPublicIssues('TtlOwner', 'ttl-repo');

    // ttlMs 0 → expiresAt === now → treated as already expired.
    github.noteIssuesClosed('TtlOwner', 'ttl-repo', [4], 0);
    const res = await github.fetchPublicIssues('TtlOwner', 'ttl-repo');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(res.issues.map((i) => i.number), [4]);
  } finally {
    global.fetch = origFetch;
  }
});

test('noteIssuesClosed/unsuppressIssues reject malformed input', () => {
  assert.strictEqual(github.noteIssuesClosed(null, 'r', [1]), 0);
  assert.strictEqual(github.noteIssuesClosed('o', null, [1]), 0);
  assert.strictEqual(github.noteIssuesClosed('o', 'r', []), 0);
  assert.strictEqual(github.noteIssuesClosed('o', 'r', 'not-an-array'), 0);
  assert.strictEqual(github.noteIssuesClosed('o', 'r', ['junk', -3, 0]), 0);
  assert.strictEqual(github.unsuppressIssues('o', 'r', [99]), 0);
});

test('suppression matches owner/repo case-insensitively and ignores a trailing .git', async () => {
  const origFetch = global.fetch;
  try {
    stubFetch([fakeIssue(8, 'closed via other casing', '2026-06-09T00:00:00Z')]);
    await github.fetchPublicIssues('CaseSup', 'case-sup-repo');

    github.noteIssuesClosed('casesup', 'Case-Sup-Repo.git', [8]);
    const res = await github.fetchPublicIssues('CaseSup', 'case-sup-repo');
    assert.strictEqual(res.issues.length, 0);
  } finally {
    global.fetch = origFetch;
  }
});
