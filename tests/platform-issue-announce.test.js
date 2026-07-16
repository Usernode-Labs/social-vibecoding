// Tests for src/services/issue-announce.js — the shared #125/#192
// "announce a just-created GitHub issue" helper used by routes/feedback.js
// and the platform-issue draft confirm path in routes/sessions.js. It must
// (a) record the issue in github's recently-created overlay so every
// fetchPublicIssues consumer sees it immediately, (b) broadcast an
// issue_update targeted at the app backed by the repo (looked up by
// repo_url when the caller passes app = null), and (c) never throw — it
// runs after the issue is already filed, so a failure here must not fail
// the request.
//
// pushIssueUpdate is stubbed by pre-seeding require.cache for services/ws
// BEFORE issue-announce is required (it destructures the function at load
// time); fetchPublicIssues network reads are stubbed via global fetch,
// same as tests/github-issues-cache.test.js.
//
// Run with: node --test tests/platform-issue-announce.test.js

const { test } = require('node:test');
const assert = require('node:assert');

let pushHandler = () => {};
const wsPath = require.resolve('../src/services/ws');
require.cache[wsPath] = {
  id: wsPath,
  filename: wsPath,
  loaded: true,
  exports: { pushIssueUpdate: (data) => pushHandler(data) },
};

const github = require('../src/services/github');
const { announceIssueCreated } = require('../src/services/issue-announce');

function fakeIssue(number) {
  return {
    number,
    title: `issue #${number}`,
    body: `body of #${number}`,
    labels: [{ name: 'usernode' }],
    updated_at: '2026-06-10T00:00:00Z',
    html_url: `https://github.com/o/r/issues/${number}`,
    user: { login: `gh-user-${number}` },
  };
}

function fakePool(rows) {
  return { query: async () => ({ rows }) };
}

function stubEmptyFetch() {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => [],
  });
}

test('announce records the overlay and broadcasts to the repo-backed app', async () => {
  const origFetch = global.fetch;
  const pushed = [];
  pushHandler = (data) => pushed.push(data);
  try {
    const pool = fakePool([
      { id: 7, slug: 'other-app', repo_url: 'https://github.com/Someone/else' },
      // Case-differing owner + trailing .git must still match.
      { id: 42, slug: 'self-app', repo_url: 'https://github.com/AnnOwner/platform-repo.git' },
    ]);
    await announceIssueCreated(pool, 'annowner', 'platform-repo', fakeIssue(655), null);

    assert.strictEqual(pushed.length, 1, 'exactly one issue_update broadcast');
    assert.deepStrictEqual(pushed[0], {
      action: 'created',
      source: 'github',
      appSlug: 'self-app',
      appId: 42,
      issueNumber: 655,
    });

    // The #192 overlay makes the issue visible through fetchPublicIssues
    // even with no live cache entry and a stale (empty) fresh list.
    stubEmptyFetch();
    const result = await github.fetchPublicIssues('annowner', 'platform-repo');
    assert.ok(
      result.issues.some((i) => i.number === 655),
      'fetchPublicIssues must include the just-announced issue'
    );
  } finally {
    global.fetch = origFetch;
    pushHandler = () => {};
  }
});

test('a known app row skips the lookup and is broadcast as-is', async () => {
  const pushed = [];
  pushHandler = (data) => pushed.push(data);
  try {
    const pool = { query: async () => { throw new Error('must not query'); } };
    await announceIssueCreated(
      pool, 'ownr', 'known-app-repo', fakeIssue(9),
      { id: 3, slug: 'known-app' }
    );
    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0].appSlug, 'known-app');
    assert.strictEqual(pushed[0].appId, 3);
  } finally {
    pushHandler = () => {};
  }
});

test('no matching app: overlay still recorded, no broadcast, no throw', async () => {
  const origFetch = global.fetch;
  const pushed = [];
  pushHandler = (data) => pushed.push(data);
  try {
    await announceIssueCreated(fakePool([]), 'ownr', 'unregistered-repo', fakeIssue(11), null);
    assert.strictEqual(pushed.length, 0, 'no broadcast without a target app');

    stubEmptyFetch();
    const result = await github.fetchPublicIssues('ownr', 'unregistered-repo');
    assert.ok(result.issues.some((i) => i.number === 11));
  } finally {
    global.fetch = origFetch;
    pushHandler = () => {};
  }
});

test('a throwing app lookup never propagates', async () => {
  const pool = { query: async () => { throw new Error('db down'); } };
  await assert.doesNotReject(
    announceIssueCreated(pool, 'ownr', 'lookup-fails-repo', fakeIssue(12), null)
  );
});

test('a throwing broadcast never propagates', async () => {
  pushHandler = () => { throw new Error('ws down'); };
  try {
    await assert.doesNotReject(
      announceIssueCreated(
        fakePool([{ id: 1, slug: 'a', repo_url: 'https://github.com/ownr/push-fails-repo' }]),
        'ownr', 'push-fails-repo', fakeIssue(13), null
      )
    );
  } finally {
    pushHandler = () => {};
  }
});
