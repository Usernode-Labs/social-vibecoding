// Tests for src/services/issue-claims.js (#2364) — the claim write extracted
// from POST /api/apps/:slug/github-issues/:number/claim so starting work on
// an issue (POST /sessions with issueNumber, the headless-session route) can
// claim and assign it the same way the Claim button does.
//
// Asserted here, against a capturing mock pool:
//   1. The per-user upsert and its params.
//   2. The #1648 assignee vote for the claimer — on renewals too.
//   3. The thread note only on a FRESH claim, and a failing note never
//      fails the claim.
//   4. The issue_update push payload, and that a ws module without
//      pushIssueUpdate (the headless route tests' stub) is tolerated.
//
// The route's own contract (open-issue verification, response shape) stays
// in tests/issue-claims.test.js.
//
// Run with: node --test tests/issue-claims-service.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ws.js is required lazily inside claimIssueForUser and read at call time,
// so a require.cache stub swapped per test is what the service sees.
const wsPath = require.resolve('../src/services/ws');
let systemMessages = [];
let issuePushes = [];
let wsExports = null;
function installWs({ withPush = true, messageThrows = false } = {}) {
  wsExports = {
    sendSystemMessage: async (pool, appId, content, msgType, metadata, thread) => {
      if (messageThrows) throw new Error('ws down');
      systemMessages.push({ appId, content, msgType, thread: thread || null });
    },
  };
  if (withPush) wsExports.pushIssueUpdate = (payload) => { issuePushes.push(payload); };
  require.cache[wsPath] = {
    exports: wsExports, loaded: true, id: wsPath, filename: wsPath, paths: [],
  };
}
installWs();

const { claimIssueForUser } = require('../src/services/issue-claims');

const APP = { id: 3, slug: 'demo' };
const USER = { id: 7, username: 'tester' };

function makePool({ created }) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const s = String(sql);
      calls.push({ sql: s, params });
      if (/INSERT INTO issue_claims/.test(s)) {
        return { rows: [{ claimed_at: '2026-09-17T00:00:00Z', created }] };
      }
      return { rows: [] };
    },
  };
}

function reset(opts) {
  systemMessages = [];
  issuePushes = [];
  installWs(opts);
}

test('a fresh claim upserts, assigns, announces in the thread and pushes', async () => {
  reset();
  const pool = makePool({ created: true });
  const result = await claimIssueForUser(pool, { app: APP, issueNumber: 42, user: USER });
  assert.deepEqual(result, { created: true, claimedAt: '2026-09-17T00:00:00Z' });

  const upsert = pool.calls.find((c) => /INSERT INTO issue_claims/.test(c.sql));
  assert.ok(upsert, 'claim upsert was issued');
  assert.match(upsert.sql, /ON CONFLICT \(app_id, github_issue_number, user_id\)/);
  assert.match(upsert.sql, /DO UPDATE SET claimed_at = NOW\(\)/);
  assert.match(upsert.sql, /RETURNING claimed_at, \(xmax = 0\) AS created/);
  assert.deepEqual(upsert.params, [3, 42, 7]);

  const vote = pool.calls.find((c) => /INSERT INTO topic_attribute_votes/.test(c.sql));
  assert.ok(vote, 'the claimer\'s assignee vote was cast');
  assert.deepEqual(vote.params, [3, 'issue', 42, 'assignee', 'tester', 7]);

  assert.equal(systemMessages.length, 1);
  assert.equal(systemMessages[0].content, 'tester claimed this issue');
  assert.equal(systemMessages[0].msgType, 'system');
  assert.deepEqual(systemMessages[0].thread, { type: 'issue', ref: 42 });

  assert.deepEqual(issuePushes, [
    { action: 'claimed', appSlug: 'demo', appId: 3, issueNumber: 42 },
  ]);
});

test('a renewal re-assigns and pushes but posts no thread note', async () => {
  reset();
  const pool = makePool({ created: false });
  const result = await claimIssueForUser(pool, { app: APP, issueNumber: 42, user: USER });
  assert.equal(result.created, false);
  assert.ok(pool.calls.some((c) => /INSERT INTO topic_attribute_votes/.test(c.sql)),
    'renewal still repairs the self-assignment');
  assert.equal(systemMessages.length, 0);
  assert.equal(issuePushes.length, 1);
});

test('a failing thread note does not fail the claim', async () => {
  reset({ messageThrows: true });
  const pool = makePool({ created: true });
  const result = await claimIssueForUser(pool, { app: APP, issueNumber: 9, user: USER });
  assert.equal(result.created, true);
  assert.equal(issuePushes.length, 1);
});

test('a ws module without pushIssueUpdate is tolerated', async () => {
  reset({ withPush: false });
  const pool = makePool({ created: true });
  const result = await claimIssueForUser(pool, { app: APP, issueNumber: 9, user: USER });
  assert.equal(result.created, true);
  assert.equal(systemMessages.length, 1);
});

test('a failing upsert rejects so the caller decides (500 or best-effort)', async () => {
  reset();
  const pool = {
    query: async (sql) => {
      if (/INSERT INTO issue_claims/.test(String(sql))) throw new Error('db down');
      return { rows: [] };
    },
  };
  await assert.rejects(
    claimIssueForUser(pool, { app: APP, issueNumber: 9, user: USER }),
    /db down/
  );
  assert.equal(systemMessages.length, 0);
  assert.equal(issuePushes.length, 0);
});
