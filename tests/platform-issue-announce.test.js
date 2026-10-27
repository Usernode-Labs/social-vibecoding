// Tests for src/services/issue-announce.js — the shared #125/#192
// "announce a just-created issue" helper used by routes/feedback.js and the
// platform-issue draft confirm path in routes/sessions.js. It must
// (a) broadcast an issue_update targeted at the app backed by the repo
// (looked up by repo_url when the caller passes app = null), and (b) never
// throw — it runs after the request is already filed, so a failure here
// must not fail the request.
//
// It used to also record the issue in github's recently-created overlay so
// fetchPublicIssues saw it at once. Requests are rows now (services/
// requests.js) and a board is a query, so a filed request is on the board
// with nothing recorded; the first test pins that with an in-memory store
// (tests/helpers/fake-requests.js).
//
// pushIssueUpdate is stubbed by pre-seeding require.cache for services/ws
// BEFORE issue-announce is required (it destructures the function at load
// time).
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
const { installFakeRequests } = require('./helpers/fake-requests');
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

test('announce broadcasts to the repo-backed app, and the filed request is on the board at once', async (t) => {
  installFakeRequests(t, { 'annowner/platform-repo': [] }, { firstNumber: 655 });
  const pushed = [];
  pushHandler = (data) => pushed.push(data);
  try {
    const pool = fakePool([
      { id: 7, slug: 'other-app', repo_url: 'https://github.com/Someone/else' },
      // Case-differing owner + trailing .git must still match.
      { id: 42, slug: 'self-app', repo_url: 'https://github.com/AnnOwner/platform-repo.git' },
    ]);
    const filed = await github.createIssue('annowner', 'platform-repo', { title: 'issue #655', body: 'body of #655' });
    assert.strictEqual(filed.number, 655);
    await announceIssueCreated(pool, 'annowner', 'platform-repo', filed, null);

    assert.strictEqual(pushed.length, 1, 'exactly one issue_update broadcast');
    assert.deepStrictEqual(pushed[0], {
      action: 'created',
      source: 'github',
      appSlug: 'self-app',
      appId: 42,
      issueNumber: 655,
    });

    // No overlay to seed: the board is a query of the store, so the request
    // just filed is listed by the very next read.
    const result = await github.fetchPublicIssues('annowner', 'platform-repo');
    assert.ok(
      result.issues.some((i) => i.number === 655),
      'fetchPublicIssues must include the just-filed request'
    );
  } finally {
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

// The overlay half of this case is gone with the overlay: a request is filed
// only on an app's board, so there is nothing to record for a repo no app has.
test('no matching app: no broadcast, no throw', async () => {
  const pushed = [];
  pushHandler = (data) => pushed.push(data);
  try {
    await assert.doesNotReject(
      announceIssueCreated(fakePool([]), 'ownr', 'unregistered-repo', fakeIssue(11), null)
    );
    assert.strictEqual(pushed.length, 0, 'no broadcast without a target app');
  } finally {
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
