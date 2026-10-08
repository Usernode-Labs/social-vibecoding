// #607: POST /api/sessions/:id/recheck must stamp check_state='pending' and
// broadcast the pending transition BEFORE responding, so the client's
// immediate refresh deterministically sees the in-progress state (the
// fire-and-forget recheckSessionChecks that follows re-stamps idempotently).
//
// Same harness shape as tests/me-active-sessions.test.js: override getPool
// BEFORE requiring the route module, mount the router on a real express app,
// inject req.user, and monkeypatch the visuals / staging-recovery module
// exports the handler reaches at call time.
//
// Run with: node --test tests/recheck-route-pending.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({
  query: (sql, params) => poolQueryHandler(sql, params),
});

const visuals = require('../src/services/visuals');
const stagingRecovery = require('../src/services/staging-recovery');

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const OWNER = { id: 7, username: 'tester' };

const sessionRow = (overrides = {}) => ({
  id: 42,
  user_id: OWNER.id,
  status: 'promoted',
  branch_name: 'dev/tester-42',
  checks_commit_sha: 'abc123',
  app_slug: 'demo',
  app_name: 'Demo App',
  repo_url: 'https://github.com/acme/demo',
  // appAccess.sessionCollabGuard selects a.collab_visibility +
  // a.view_visibility alongside the session; checkAppAccess THROWS when handed
  // a row without them. Model what the real SQL returns — the old
  // default-to-public branch meant this stub never exercised the gate at all.
  collab_visibility: 'public',
  view_visibility: 'public',
  ...overrides,
});

function startServer(user = OWNER) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use(sessionRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function postRecheck(server, id = 42) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/recheck`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  return { res, body: await res.json() };
}

for (const status of ['active', 'paused', 'promoted']) {
  test(`recheck ${status} stamps pending and keeps coding status unchanged`, async () => {
    const calls = [];
    const row = sessionRow({ status });
    poolQueryHandler = async (sql) => {
      if (/FROM chat_sessions cs JOIN apps a/.test(String(sql))) {
        return { rows: [row] };
      }
      assert.doesNotMatch(String(sql), /UPDATE chat_sessions|INSERT INTO/);
      return { rows: [] };
    };
    const origSet = visuals.setChecksPending;
    const origNotify = visuals.notifyChecksPending;
    const origRecheck = stagingRecovery.recheckSessionChecks;
    visuals.setChecksPending = async (_pool, sessionId, commitSha) => {
      calls.push(['setChecksPending', sessionId, commitSha]);
    };
    visuals.notifyChecksPending = (sessionId, commitSha) => {
      calls.push(['notifyChecksPending', sessionId, commitSha]);
    };
    stagingRecovery.recheckSessionChecks = async ({ session, reason }) => {
      assert.equal(session.status, status);
      assert.equal(reason, 'manual-recheck');
      calls.push(['recheckSessionChecks']);
      return 'rechecked';
    };
    const server = await startServer();
    try {
      const { res, body } = await postRecheck(server);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(body.status, 'running');
      assert.equal(row.status, status, 'rechecking must not resume coding');
      // #607: the response tells the client the row is already 'pending'.
      assert.strictEqual(body.checkState, 'pending');
      // The stamp + broadcast happened before the response settled (the
      // fire-and-forget recheck may or may not have run yet — order of the
      // first two entries is the contract).
      assert.deepStrictEqual(calls[0], ['setChecksPending', 42, 'abc123']);
      assert.deepStrictEqual(calls[1], ['notifyChecksPending', 42, 'abc123']);
      assert.deepStrictEqual(calls[2], ['recheckSessionChecks']);
    } finally {
      visuals.setChecksPending = origSet;
      visuals.notifyChecksPending = origNotify;
      stagingRecovery.recheckSessionChecks = origRecheck;
      server.close();
    }
  });
}

test('recheck refuses to queue behind an existing capture pipeline', async () => {
  poolQueryHandler = async (sql) => {
    if (/FROM chat_sessions cs JOIN apps a/.test(String(sql))) {
      return { rows: [sessionRow({ status: 'paused' })] };
    }
    return { rows: [] };
  };
  const original = visuals.hasInFlightCapture;
  visuals.hasInFlightCapture = () => true;
  const server = await startServer();
  try {
    const { res, body } = await postRecheck(server);
    assert.equal(res.status, 200);
    assert.deepEqual(body, { status: 'running' });
  } finally {
    server.close();
    visuals.hasInFlightCapture = original;
  }
});

// A run of this commit another process launched, still on the cluster and
// not yet read, is the run being asked for, as a capture in flight here is.
// Nothing is stamped or started; the client is told why (`collecting`). With
// nothing left to collect the button starts a fresh run, as the loop above
// pins.
test('recheck leaves a run of the commit still on the cluster to the harvest', async () => {
  const calls = [];
  poolQueryHandler = async (sql) => {
    if (/FROM chat_sessions cs JOIN apps a/.test(String(sql))) return { rows: [sessionRow({ check_state: 'pending' })] };
    return { rows: [] };
  };
  const harvest = require('../src/services/check-harvest');
  const saved = {
    runToCollect: harvest.runToCollect,
    setChecksPending: visuals.setChecksPending,
    notifyChecksPending: visuals.notifyChecksPending,
    recheckSessionChecks: stagingRecovery.recheckSessionChecks,
  };
  harvest.runToCollect = async (_config, _pool, sessionId, commitSha) => {
    calls.push(['runToCollect', sessionId, commitSha]);
    return { runId: 'f7895663', owner: 'old-pod:1:exited', capture: 'running', unitSuite: 'succeeded' };
  };
  visuals.setChecksPending = async () => { calls.push(['setChecksPending']); };
  stagingRecovery.recheckSessionChecks = async () => { calls.push(['recheckSessionChecks']); };
  const server = await startServer();
  try {
    const { res, body } = await postRecheck(server);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(body, { status: 'running', checkState: 'pending', collecting: true });
    assert.deepStrictEqual(calls, [['runToCollect', 42, 'abc123']]);
    // The coalesce does not hold the session: a press once the verdict is
    // stored reaches the run again.
    harvest.runToCollect = async () => null;
    stagingRecovery.recheckSessionChecks = async () => 'rechecked';
    visuals.notifyChecksPending = () => {};
    const again = await postRecheck(server);
    assert.deepStrictEqual(again.body, { status: 'running', checkState: 'pending' });
  } finally {
    harvest.runToCollect = saved.runToCollect;
    visuals.setChecksPending = saved.setChecksPending;
    visuals.notifyChecksPending = saved.notifyChecksPending;
    stagingRecovery.recheckSessionChecks = saved.recheckSessionChecks;
    server.close();
  }
});

test('recheck never revives checks on an archived proposal', async () => {
  const calls = [];
  poolQueryHandler = async (sql) => {
    if (/FROM chat_sessions cs JOIN apps a/.test(String(sql))) {
      return { rows: [sessionRow({ status: 'archived', check_state: 'pending' })] };
    }
    return { rows: [] };
  };
  const origSet = visuals.setChecksPending;
  visuals.setChecksPending = async (...args) => { calls.push(args); };
  const server = await startServer();
  try {
    const { res, body } = await postRecheck(server);
    assert.equal(res.status, 409);
    assert.equal(body.error, 'proposal_closed');
    assert.equal(calls.length, 0);
  } finally {
    server.close();
    visuals.setChecksPending = origSet;
  }
});

// Regression for the campaign-dashboard 403: req.user carries camelCase
// isAdmin/canAdminWrite (middleware/auth.js) — the route once checked the
// nonexistent `is_admin`, so admins were rejected on every proposal they
// didn't own (campaign sessions belong to usernode-platform).
test('a write-capable admin can recheck a session they do not own', async () => {
  poolQueryHandler = async (sql) => {
    if (/FROM chat_sessions cs JOIN apps a/.test(String(sql))) {
      return { rows: [sessionRow({ status: 'paused', user_id: 999 })] };
    }
    return { rows: [] };
  };
  const origSet = visuals.setChecksPending;
  const origNotify = visuals.notifyChecksPending;
  const origRecheck = stagingRecovery.recheckSessionChecks;
  visuals.setChecksPending = async () => {};
  visuals.notifyChecksPending = () => {};
  stagingRecovery.recheckSessionChecks = async () => 'rechecked';
  const server = await startServer({ id: 8, username: 'admin', isAdmin: true, canAdminWrite: true });
  try {
    const { res, body } = await postRecheck(server);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.status, 'running');
  } finally {
    visuals.setChecksPending = origSet;
    visuals.notifyChecksPending = origNotify;
    stagingRecovery.recheckSessionChecks = origRecheck;
    server.close();
  }
});

test('a read-only admin is rejected — rechecks mutate state and cost a build', async () => {
  poolQueryHandler = async (sql) => {
    if (/FROM chat_sessions cs JOIN apps a/.test(String(sql))) {
      return { rows: [sessionRow({ status: 'paused', user_id: 999 })] };
    }
    return { rows: [] };
  };
  const server = await startServer({ id: 9, username: 'viewer', isAdmin: true, canAdminWrite: false });
  try {
    const { res } = await postRecheck(server);
    assert.strictEqual(res.status, 403);
  } finally {
    server.close();
  }
});

test('a non-owner non-admin is rejected before any pending stamp', async () => {
  const calls = [];
  poolQueryHandler = async (sql) => {
    if (/FROM chat_sessions cs JOIN apps a/.test(String(sql))) {
      return { rows: [sessionRow({ status: 'paused', user_id: 999 })] };
    }
    return { rows: [] };
  };
  const origSet = visuals.setChecksPending;
  const origNotify = visuals.notifyChecksPending;
  visuals.setChecksPending = async (...args) => { calls.push(['setChecksPending', args]); };
  visuals.notifyChecksPending = (...args) => { calls.push(['notifyChecksPending', args]); };
  const server = await startServer({ id: 8, username: 'someone-else' });
  try {
    const { res } = await postRecheck(server);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(calls.length, 0, 'no stamp / broadcast on a rejected request');
  } finally {
    visuals.setChecksPending = origSet;
    visuals.notifyChecksPending = origNotify;
    server.close();
  }
});
