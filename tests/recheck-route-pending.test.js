// #607: POST /api/sessions/:id/recheck answers check_state 'pending' so the
// client's immediate refresh shows the in-progress state, and hands the run
// to the preview machine (staging-recovery.recheckSessionChecks →
// services/preview-workflow.js), which stamps and announces the pending
// state itself. The route writes nothing to the row.
//
// Same harness shape as tests/me-active-sessions.test.js: override getPool
// BEFORE requiring the route module, mount the router on a real express app,
// inject req.user, and monkeypatch the staging-recovery module export the
// handler reaches at call time.
//
// Run with: node --test tests/recheck-route-pending.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({
  query: (sql, params) => poolQueryHandler(sql, params),
});

const stagingRecovery = require('../src/services/staging-recovery');
const { beginSessionOperation } = require('../src/services/active-workers');

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
  test(`recheck ${status} answers pending, hands off, and keeps coding status unchanged`, async () => {
    const calls = [];
    const row = sessionRow({ status });
    poolQueryHandler = async (sql) => {
      if (/FROM chat_sessions cs JOIN apps a/.test(String(sql))) {
        return { rows: [row] };
      }
      assert.doesNotMatch(String(sql), /UPDATE chat_sessions|INSERT INTO/);
      return { rows: [] };
    };
    const origRecheck = stagingRecovery.recheckSessionChecks;
    let handedOff;
    const ran = new Promise((resolve) => { handedOff = resolve; });
    stagingRecovery.recheckSessionChecks = async ({ session, reason }) => {
      assert.equal(session.status, status);
      assert.equal(reason, 'manual-recheck');
      calls.push(['recheckSessionChecks', session.id]);
      handedOff();
      return 'rechecked';
    };
    const server = await startServer();
    try {
      const { res, body } = await postRecheck(server);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(body.status, 'running');
      assert.equal(row.status, status, 'rechecking must not resume coding');
      // #607: the response tells the client the row is pending.
      assert.strictEqual(body.checkState, 'pending');
      await ran;
      assert.deepStrictEqual(calls, [['recheckSessionChecks', 42]]);
    } finally {
      stagingRecovery.recheckSessionChecks = origRecheck;
      server.close();
    }
  });
}

// A turn or an operation holding the session (a local proposal submission
// among them) is the run being asked for: nothing is started behind it.
test('recheck refuses to queue behind a turn or operation holding the session', async () => {
  poolQueryHandler = async (sql) => {
    if (/FROM chat_sessions cs JOIN apps a/.test(String(sql))) {
      return { rows: [sessionRow({ status: 'paused' })] };
    }
    return { rows: [] };
  };
  const calls = [];
  const origRecheck = stagingRecovery.recheckSessionChecks;
  stagingRecovery.recheckSessionChecks = async () => { calls.push('recheckSessionChecks'); };
  const release = beginSessionOperation(42, 'test');
  const server = await startServer();
  try {
    const { res, body } = await postRecheck(server);
    assert.equal(res.status, 200);
    assert.deepEqual(body, { status: 'running' });
    assert.equal(calls.length, 0);
  } finally {
    release();
    server.close();
    stagingRecovery.recheckSessionChecks = origRecheck;
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
  const origRecheck = stagingRecovery.recheckSessionChecks;
  stagingRecovery.recheckSessionChecks = async (...args) => { calls.push(args); };
  const server = await startServer();
  try {
    const { res, body } = await postRecheck(server);
    assert.equal(res.status, 409);
    assert.equal(body.error, 'proposal_closed');
    assert.equal(calls.length, 0);
  } finally {
    server.close();
    stagingRecovery.recheckSessionChecks = origRecheck;
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
  const origRecheck = stagingRecovery.recheckSessionChecks;
  stagingRecovery.recheckSessionChecks = async () => 'rechecked';
  const server = await startServer({ id: 8, username: 'admin', isAdmin: true, canAdminWrite: true });
  try {
    const { res, body } = await postRecheck(server);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.status, 'running');
  } finally {
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

test('a non-owner non-admin is rejected before anything is handed off', async () => {
  const calls = [];
  poolQueryHandler = async (sql) => {
    if (/FROM chat_sessions cs JOIN apps a/.test(String(sql))) {
      return { rows: [sessionRow({ status: 'paused', user_id: 999 })] };
    }
    return { rows: [] };
  };
  const origRecheck = stagingRecovery.recheckSessionChecks;
  stagingRecovery.recheckSessionChecks = async (...args) => { calls.push(['recheckSessionChecks', args]); };
  const server = await startServer({ id: 8, username: 'someone-else' });
  try {
    const { res } = await postRecheck(server);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(calls.length, 0, 'nothing handed off on a rejected request');
  } finally {
    stagingRecovery.recheckSessionChecks = origRecheck;
    server.close();
  }
});
