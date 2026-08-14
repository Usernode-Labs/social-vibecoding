// Tests for src/services/github.js noteIssueCreated() — the open-issues
// cache seeding used by routes/feedback.js (#125) so a just-submitted
// feedback issue shows up in the "Open Issues" panel without waiting out
// the 5-minute cache TTL or re-hitting GitHub's anonymous rate limit —
// plus the #192 recently-created overlay (which makes noteIssueCreated
// work even with no live cache entry / a stale fresh fetch) and
// refreshPublicIssues (the panel's throttled manual refresh).
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
    created_at: `2026-06-0${(number % 9) + 1}T00:00:00Z`,
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

test('noteIssueCreated records into the overlay even with no cache entry (#192)', () => {
  // Pre-#192 this returned false (the cache seeding was a no-op); the
  // overlay now records the issue regardless, so any valid input is true.
  assert.strictEqual(
    github.noteIssueCreated('nobody', 'nothing-cached', fakeIssue(1, 'x', '2026-06-10T00:00:00Z')),
    true
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
    // #1221: BOTH timestamps survive normalization — dropping created_at
    // here is what made every agent surface report createdAt: null.
    assert.strictEqual(after.issues[0].createdAt, '2026-06-03T00:00:00Z');
    assert.strictEqual(after.issues[0].updatedAt, '2026-06-10T00:00:00Z');
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

// ------------------------------------------------------------------
// #158: full issue bodies. fetchPublicIssues must NOT truncate bodies
// (the web route / "Create PR" seeding needs the whole text); the
// agent surfaces clip via truncateIssueBodies instead.
// ------------------------------------------------------------------

test('fetchPublicIssues keeps the full issue body untruncated (#158)', async () => {
  const origFetch = global.fetch;
  try {
    const longBody = 'x'.repeat(5000);
    stubFetch([{ ...fakeIssue(20, 'verbose', '2026-06-09T00:00:00Z'), body: longBody }]);

    const res = await github.fetchPublicIssues('FullOwner', 'full-repo');
    assert.strictEqual(res.issues[0].body, longBody);
  } finally {
    global.fetch = origFetch;
  }
});

test('truncateIssueBodies clips long bodies at 500 chars with an explicit marker, leaving short ones alone', () => {
  const longBody = 'y'.repeat(5000);
  const input = {
    issues: [
      { number: 1, title: 'long', body: longBody },
      { number: 2, title: 'short', body: 'short body' },
    ],
    truncatedList: false,
  };
  const out = github.truncateIssueBodies(input);
  // Default marker names the Mayor's get_github_issue tool with the
  // issue's own number, so the agent knows the cut happened and how to
  // get the rest.
  assert.strictEqual(
    out.issues[0].body,
    `${'y'.repeat(500)}… [truncated — use get_github_issue(1) for full text]`
  );
  assert.strictEqual(out.issues[1].body, 'short body');
  assert.strictEqual(out.truncatedList, false);
  // Must not mutate the input — it may be the shared cache entry.
  assert.strictEqual(input.issues[0].body, longBody);
});

test('truncateIssueBodies accepts a surface-specific full-text hint (worker CLI form)', () => {
  const out = github.truncateIssueBodies(
    { issues: [{ number: 42, title: 'long', body: 'z'.repeat(501) }], truncatedList: false },
    (n) => `usernode-issues ${n}`
  );
  assert.strictEqual(
    out.issues[0].body,
    `${'z'.repeat(500)}… [truncated — use usernode-issues 42 for full text]`
  );
});

test('truncateIssueBodies passes through degenerate inputs', () => {
  assert.strictEqual(github.truncateIssueBodies(null), null);
  const noIssues = { truncatedList: false, note: 'no repo' };
  assert.strictEqual(github.truncateIssueBodies(noIssues), noIssues);
});

// ------------------------------------------------------------------
// #158: fetchPublicIssue — single-issue, full-body lookup backing the
// Mayor's get_github_issue tool and `usernode-issues <number>`.
// ------------------------------------------------------------------

test('fetchPublicIssue serves a cached open issue without a network call, full body intact', async () => {
  const origFetch = global.fetch;
  try {
    const longBody = 'w'.repeat(3000);
    const calls = stubFetch([{ ...fakeIssue(30, 'cached', '2026-06-09T00:00:00Z'), body: longBody }]);

    await github.fetchPublicIssues('OneOwner', 'one-repo'); // warm the cache
    assert.strictEqual(calls.length, 1);

    const res = await github.fetchPublicIssue('OneOwner', 'one-repo', 30);
    assert.strictEqual(calls.length, 1, 'must come from cache');
    assert.strictEqual(res.issue.number, 30);
    assert.strictEqual(res.issue.body, longBody);
    assert.strictEqual(res.note, undefined);
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchPublicIssue falls through to the single-issue endpoint on a cache miss', async () => {
  const origFetch = global.fetch;
  try {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => fakeIssue(77, 'closed but fetchable', '2026-06-09T00:00:00Z'),
      };
    };
    const res = await github.fetchPublicIssue('MissOwner', 'miss-repo', 77);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].endsWith('/repos/MissOwner/miss-repo/issues/77'));
    assert.strictEqual(res.issue.number, 77);
    assert.strictEqual(res.issue.title, 'closed but fetchable');
    assert.strictEqual(res.issue.body, 'body of #77');
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchPublicIssue maps 404, PR numbers, and bad input to well-formed notes', async () => {
  const origFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: false, status: 404, headers: { get: () => null }, json: async () => ({}),
    });
    assert.deepStrictEqual(
      await github.fetchPublicIssue('NfOwner', 'nf-repo', 999),
      { issue: null, note: 'not found' }
    );

    // The /issues/:n endpoint resolves PR numbers too — refuse those.
    global.fetch = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ ...fakeIssue(12, 'a PR', '2026-06-09T00:00:00Z'), pull_request: { url: 'x' } }),
    });
    assert.deepStrictEqual(
      await github.fetchPublicIssue('PrOwner', 'pr-repo', 12),
      { issue: null, note: 'not an issue (pull request)' }
    );

    // Bad input never reaches the network.
    global.fetch = async () => { throw new Error('must not fetch'); };
    assert.deepStrictEqual(await github.fetchPublicIssue('o', 'r', 'junk'), { issue: null, note: 'bad issue number' });
    assert.deepStrictEqual(await github.fetchPublicIssue('o', 'r', -1), { issue: null, note: 'bad issue number' });
    assert.deepStrictEqual(await github.fetchPublicIssue(null, 'r', 1), { issue: null, note: 'bad issue number' });
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchPublicIssue reports rate limiting when the issue is nowhere in cache', async () => {
  const origFetch = global.fetch;
  try {
    // Cache holds issue 50 only; asking for 51 misses it, goes to network,
    // and hits the 429 — the stale-cache fallback has no #51 either, so a
    // clean rate-limited note comes back instead of a throw or empty body.
    stubFetch([fakeIssue(50, 'cached neighbor', '2026-06-09T00:00:00Z')]);
    await github.fetchPublicIssues('RlOwner', 'rl-repo');

    global.fetch = async () => ({
      ok: false,
      status: 429,
      headers: { get: (h) => (h === 'x-ratelimit-remaining' ? '0' : null) },
      json: async () => ({}),
    });
    assert.deepStrictEqual(
      await github.fetchPublicIssue('RlOwner', 'rl-repo', 51),
      { issue: null, note: 'rate limited' }
    );
  } finally {
    global.fetch = origFetch;
  }
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

// ------------------------------------------------------------------
// #192: recently-created overlay — the create-side mirror of #144.
// noteIssueCreated records every created issue in a TTL'd per-repo
// overlay that is merged into EVERY fetchPublicIssues result, so a
// just-created issue renders even when there is no live cache entry
// and GitHub's eventually-consistent anonymous list still omits it.
// ------------------------------------------------------------------

function rateLimitedStub() {
  global.fetch = async () => ({
    ok: false,
    status: 429,
    headers: { get: (h) => (h === 'x-ratelimit-remaining' ? '0' : null) },
    json: async () => ({}),
  });
}

test('overlay surfaces a just-created issue when the fresh fetch payload omits it (the #192 repro)', async () => {
  const origFetch = global.fetch;
  try {
    // No cache entry at creation time; GitHub's list lags the create.
    assert.strictEqual(
      github.noteIssueCreated('OvOwner', 'ov-repo', fakeIssue(31, 'created via platform', '2026-06-10T00:00:00Z')),
      true
    );
    const calls = stubFetch([fakeIssue(30, 'older', '2026-06-09T00:00:00Z')]);

    const fresh = await github.fetchPublicIssues('OvOwner', 'ov-repo');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(fresh.issues.map((i) => i.number), [31, 30], 'overlay issue is prepended');
    assert.strictEqual(fresh.issues[0].title, 'created via platform');
    assert.strictEqual(fresh.note, undefined);

    // The (stale) fetched payload was cached; a cache-hit read still
    // shows the overlay issue.
    const cachedRead = await github.fetchPublicIssues('OvOwner', 'ov-repo');
    assert.strictEqual(calls.length, 1, 'second read must come from cache');
    assert.deepStrictEqual(cachedRead.issues.map((i) => i.number), [31, 30]);
  } finally {
    global.fetch = origFetch;
  }
});

test('overlay survives the rate-limited EMPTY fallback (nothing cached)', async () => {
  const origFetch = global.fetch;
  try {
    github.noteIssueCreated('RlovOwner', 'rlov-repo', fakeIssue(2, 'fresh feedback', '2026-06-10T00:00:00Z'));
    rateLimitedStub();

    const res = await github.fetchPublicIssues('RlovOwner', 'rlov-repo');
    assert.strictEqual(res.note, 'rate limited');
    assert.deepStrictEqual(res.issues.map((i) => i.number), [2]);
  } finally {
    global.fetch = origFetch;
  }
});

test('overlay survives the rate-limited STALE-cache fallback', async () => {
  const origFetch = global.fetch;
  try {
    stubFetch([fakeIssue(1, 'pre-existing', '2026-06-09T00:00:00Z')]);
    await github.fetchPublicIssues('RlstOwner', 'rlst-repo');

    github.noteIssueCreated('RlstOwner', 'rlst-repo', fakeIssue(3, 'fresh', '2026-06-10T00:00:00Z'));
    rateLimitedStub();

    // Force past the still-valid cache; the refetch 429s and falls back
    // to the stale entry — the new issue must still be there.
    const res = await github.refreshPublicIssues('RlstOwner', 'rlst-repo');
    assert.strictEqual(res.note, 'rate limited');
    assert.deepStrictEqual(res.issues.map((i) => i.number), [3, 1]);
  } finally {
    global.fetch = origFetch;
  }
});

test('a fresh fetch that contains the issue prunes the overlay (fetched copy wins)', async () => {
  const origFetch = global.fetch;
  try {
    github.noteIssueCreated('PruneOwner', 'prune-repo', fakeIssue(9, 'local copy', '2026-06-10T00:00:00Z'));
    stubFetch([fakeIssue(9, 'from github', '2026-06-10T01:00:00Z')]);

    const res = await github.fetchPublicIssues('PruneOwner', 'prune-repo');
    assert.strictEqual(res.issues.length, 1, 'no duplicate');
    assert.strictEqual(res.issues[0].title, 'from github', 'fetched copy wins over the overlay copy');

    // Pruned for real: a later forced fetch whose payload no longer
    // lists #9 must NOT resurface it from the overlay.
    stubFetch([]);
    const after = await github.refreshPublicIssues('PruneOwner', 'prune-repo');
    assert.strictEqual(after.refreshed, true);
    assert.deepStrictEqual(after.issues, []);
  } finally {
    global.fetch = origFetch;
  }
});

test('suppression wins over the overlay — created then quickly closed stays hidden', async () => {
  const origFetch = global.fetch;
  try {
    github.noteIssueCreated('CcOwner', 'cc-repo', fakeIssue(12, 'created then closed', '2026-06-10T00:00:00Z'));
    github.noteIssuesClosed('CcOwner', 'cc-repo', [12]);
    stubFetch([]);

    const res = await github.fetchPublicIssues('CcOwner', 'cc-repo');
    assert.deepStrictEqual(res.issues, []);
  } finally {
    global.fetch = origFetch;
  }
});

test('overlay entries expire after their TTL', async () => {
  const origFetch = global.fetch;
  try {
    // ttlMs 0 → expiresAt === now → treated as already expired (same
    // convention as the suppression TTL test above).
    github.noteIssueCreated('ExpOwner', 'exp-repo', fakeIssue(13, 'expired overlay', '2026-06-10T00:00:00Z'), 0);
    stubFetch([]);

    const res = await github.fetchPublicIssues('ExpOwner', 'exp-repo');
    assert.deepStrictEqual(res.issues, []);
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchPublicIssue resolves a just-created issue from the overlay without a network call', async () => {
  const origFetch = global.fetch;
  try {
    const longBody = 'v'.repeat(3000);
    github.noteIssueCreated('SingleOwner', 'single-repo', {
      ...fakeIssue(14, 'overlaid', '2026-06-10T00:00:00Z'),
      body: longBody,
    });
    global.fetch = async () => { throw new Error('must not fetch'); };

    const res = await github.fetchPublicIssue('SingleOwner', 'single-repo', 14);
    assert.strictEqual(res.issue.number, 14);
    assert.strictEqual(res.issue.body, longBody, 'overlay carries the FULL body');
    assert.strictEqual(res.note, undefined);
  } finally {
    global.fetch = origFetch;
  }
});

// ------------------------------------------------------------------
// #192: refreshPublicIssues — the throttled force-refresh behind the
// Open Issues panel's manual refresh button.
// ------------------------------------------------------------------

test('refreshPublicIssues bypasses a valid cache TTL, caches the result, then honors the cooldown', async () => {
  const origFetch = global.fetch;
  try {
    stubFetch([fakeIssue(1, 'v1', '2026-06-09T00:00:00Z')]);
    await github.fetchPublicIssues('RefOwner', 'ref-repo'); // warm, still-valid cache

    const calls = stubFetch([
      fakeIssue(2, 'created on github', '2026-06-10T00:00:00Z'),
      fakeIssue(1, 'v1', '2026-06-09T00:00:00Z'),
    ]);

    const forced = await github.refreshPublicIssues('RefOwner', 'ref-repo');
    assert.strictEqual(forced.refreshed, true);
    assert.strictEqual(forced.retryInMs, 60 * 1000);
    assert.strictEqual(calls.length, 1, 'force must refetch past the valid cache');
    assert.deepStrictEqual(forced.issues.map((i) => i.number), [2, 1]);

    // The forced result replaced the cache entry: a plain read is fetch-free.
    const cached = await github.fetchPublicIssues('RefOwner', 'ref-repo');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(cached.issues.map((i) => i.number), [2, 1]);

    // Within the cooldown a second refresh serves the cache with a retry hint.
    const second = await github.refreshPublicIssues('RefOwner', 'ref-repo');
    assert.strictEqual(second.refreshed, false);
    assert.ok(second.retryInMs > 0 && second.retryInMs <= 60 * 1000);
    assert.strictEqual(calls.length, 1, 'throttled refresh must not hit the network');
    assert.deepStrictEqual(second.issues.map((i) => i.number), [2, 1]);
  } finally {
    global.fetch = origFetch;
  }
});

// ── #396: issue comment threads ─────────────────────────────────────────
// fetchIssueComments follows the Link header (oldest-first), caps at
// ISSUE_COMMENTS_MAX_PAGES, and flags `truncated`; clipIssueComments keeps
// the most-recent N and clips long bodies.

function fakeComment(id) {
  return {
    user: { login: `commenter-${id}` },
    body: `comment ${id}`,
    created_at: `2026-06-${String((id % 28) + 1).padStart(2, '0')}T00:00:00Z`,
  };
}

// Stub fetch with a page sequence. Each entry is { body, next } — `next`
// becomes the Link header's rel="next" URL (null = last page). Records the
// URLs requested so we can assert pagination stopped at the ceiling.
function stubCommentPages(pages) {
  const calls = [];
  let i = 0;
  global.fetch = async (url) => {
    calls.push(String(url));
    const page = pages[i] || { body: [], next: null };
    i += 1;
    return {
      ok: true,
      status: 200,
      headers: {
        get: (h) => (h && h.toLowerCase() === 'link' && page.next
          ? `<${page.next}>; rel="next"`
          : null),
      },
      json: async () => page.body,
    };
  };
  return calls;
}

test('fetchIssueComments follows Link pages oldest-first and caps at the page ceiling', async () => {
  const origFetch = global.fetch;
  try {
    // 4 pages of 100 available, but ISSUE_COMMENTS_MAX_PAGES is 3 → stop
    // after 3 pages with a next link still pending → truncated.
    const mk = (start) => Array.from({ length: 100 }, (_, k) => fakeComment(start + k));
    const calls = stubCommentPages([
      { body: mk(0), next: 'https://api.github.com/p2' },
      { body: mk(100), next: 'https://api.github.com/p3' },
      { body: mk(200), next: 'https://api.github.com/p4' },
      { body: mk(300), next: null },
    ]);
    const res = await github.fetchIssueComments('O', 'r', 7);
    assert.strictEqual(calls.length, 3, 'must stop at ISSUE_COMMENTS_MAX_PAGES');
    assert.strictEqual(res.comments.length, 300);
    assert.strictEqual(res.truncated, true);
    // Oldest-first, normalized shape.
    assert.strictEqual(res.comments[0].author, 'commenter-0');
    assert.deepStrictEqual(Object.keys(res.comments[0]).sort(), ['author', 'body', 'createdAt']);
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchIssueComments returns a short thread without truncation', async () => {
  const origFetch = global.fetch;
  try {
    const calls = stubCommentPages([
      { body: [fakeComment(1), fakeComment(2), fakeComment(3)], next: null },
    ]);
    const res = await github.fetchIssueComments('O', 'r', 8);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(res.comments.length, 3);
    assert.strictEqual(res.truncated, false);
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchIssueComments maps rate-limit, 404, non-array, and bad input to empty + note', async () => {
  const origFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: false, status: 403,
      headers: { get: (h) => (h === 'x-ratelimit-remaining' ? '0' : null) },
      json: async () => [],
    });
    assert.deepStrictEqual(
      await github.fetchIssueComments('O', 'r', 1),
      { comments: [], truncated: false, note: 'rate limited' }
    );

    global.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) });
    assert.deepStrictEqual(
      await github.fetchIssueComments('O', 'r', 1),
      { comments: [], truncated: false, note: 'not found' }
    );

    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ not: 'an array' }) });
    assert.deepStrictEqual(
      await github.fetchIssueComments('O', 'r', 1),
      { comments: [], truncated: false, note: 'fetch failed' }
    );

    // Bad input never touches the network.
    assert.deepStrictEqual(
      await github.fetchIssueComments('O', 'r', 'junk'),
      { comments: [], truncated: false, note: 'bad issue number' }
    );
  } finally {
    global.fetch = origFetch;
  }
});

test('clipIssueComments keeps the most-recent max, clips long bodies, and flags truncation', () => {
  const comments = Array.from({ length: 40 }, (_, k) => ({
    author: `u${k}`, body: 'x'.repeat(k === 39 ? 5000 : 10), createdAt: `2026-06-01T00:00:0${k % 10}Z`,
  }));
  const { comments: kept, truncated } = github.clipIssueComments(comments, { max: 30, bodyMax: 2000 });
  assert.strictEqual(kept.length, 30, 'keeps at most max');
  assert.strictEqual(kept[0].author, 'u10', 'keeps the TAIL (most recent)');
  assert.strictEqual(truncated, true, 'older comments were dropped');
  // The long last body is clipped with the marker.
  const last = kept[kept.length - 1];
  assert.ok(last.body.endsWith('… [truncated]'));
  assert.ok(last.body.length <= 2000 + '… [truncated]'.length);
});

test('clipIssueComments carries through upstream truncation even under the keep cap', () => {
  const { truncated } = github.clipIssueComments(
    [{ author: 'a', body: 'short', createdAt: '' }],
    { max: 30, wasTruncated: true }
  );
  assert.strictEqual(truncated, true);
});

test('clipIssueComments on an empty/absent thread is a clean no-op', () => {
  assert.deepStrictEqual(github.clipIssueComments([]), { comments: [], truncated: false });
  assert.deepStrictEqual(github.clipIssueComments(undefined), { comments: [], truncated: false });
});
