// Route test for GET /api/me/active-sessions (src/routes/sessions.js) —
// the cross-app "viewer's own sessions" endpoint. Long the data source
// for the dev tab's "Active Sessions (x/y)" panel, it now also backs the
// home screen's "Your active sessions" section, so its owner scoping,
// status filtering, busy detection, and totals arithmetic are
// load-bearing on a prominent surface.
//
// Same harness shape as tests/github-issues-route.test.js: override
// getPool BEFORE requiring the route module (sessions.js destructures it
// at require time), mount the router on a real express app, and inject
// req.user. The pool stub captures every query so tests can assert the
// SQL's owner/status/headless filters directly — the filtering lives in
// the WHERE clause, so the captured query text is the contract.
//
// Run with: node --test tests/me-active-sessions.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql, params });
    return poolQueryHandler(sql, params);
  },
});

const worker = require('../src/services/worker');
const { activeWorkers } = require('../src/services/active-workers');

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };

function startServer() {
  const app = express();
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(sessionRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function sessionRow(overrides = {}) {
  return {
    id: 1,
    branch_name: 'dev/tester-1',
    pr_number: null,
    pr_url: null,
    pr_title: null,
    status: 'active',
    linked_issues: [],
    created_at: '2026-06-12T00:00:00Z',
    last_activity_at: '2026-06-12T01:00:00Z',
    app_slug: 'demo',
    app_name: 'Demo App',
    ...overrides,
  };
}

async function fetchActiveSessions(server) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/me/active-sessions`);
  return { res, body: await res.json() };
}

test('query is owner-scoped and excludes archived/headless rows', async () => {
  capturedQueries = [];
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServer();
  try {
    const { res, body } = await fetchActiveSessions(server);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(body.sessions, []);

    const q = capturedQueries.find((c) => /FROM chat_sessions cs/.test(c.sql));
    assert.ok(q, 'active-sessions query was issued');
    // Owner scoping: the only filter param is the viewer's own id —
    // another user's rows can never satisfy the WHERE clause.
    assert.match(q.sql, /cs\.user_id = \$1/);
    assert.deepStrictEqual(q.params, [VIEWER.id]);
    // Status filtering: non-archived statuses only, headless excluded.
    assert.match(q.sql, /status IN \('active', 'promoted', 'paused'\)/);
    assert.match(q.sql, /is_headless = FALSE/);
    assert.match(q.sql, /ORDER BY last_activity_at DESC/);
    // shared_at rides along so the owner's pinned cards can render their
    // "Visible to everyone" / "Make visible" state.
    assert.match(q.sql, /cs\.shared_at/);
  } finally {
    server.close();
  }
});

test('response shape: row fields pass through, busy false without a warm worker', async () => {
  capturedQueries = [];
  poolQueryHandler = async () => ({
    rows: [
      sessionRow({ id: 11, status: 'active', pr_title: 'Add leaderboard' }),
      sessionRow({ id: 12, status: 'promoted', app_slug: 'other', app_name: 'Other App' }),
      sessionRow({ id: 13, status: 'paused' }),
    ],
  });
  activeWorkers.clear();
  const realIsInFlight = worker.isInFlight;
  worker.isInFlight = () => false;
  const server = await startServer();
  try {
    const { res, body } = await fetchActiveSessions(server);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.sessions.length, 3);
    for (const s of body.sessions) {
      assert.ok(s.app_slug, 'app_slug present');
      assert.ok(s.app_name, 'app_name present');
      assert.ok(s.last_activity_at, 'last_activity_at present');
      assert.strictEqual(s.busy, false);
    }
    assert.strictEqual(body.sessions[0].pr_title, 'Add leaderboard');
  } finally {
    worker.isInFlight = realIsInFlight;
    server.close();
  }
});

test('busy flag: set via activeWorkers or worker.isInFlight; totals arithmetic consistent', async () => {
  capturedQueries = [];
  poolQueryHandler = async () => ({
    rows: [
      sessionRow({ id: 21, status: 'active' }),   // busy via activeWorkers
      sessionRow({ id: 22, status: 'active' }),   // idle
      sessionRow({ id: 23, status: 'promoted' }), // busy via worker.isInFlight
      sessionRow({ id: 24, status: 'paused' }),
    ],
  });
  activeWorkers.clear();
  activeWorkers.add(21);
  const realIsInFlight = worker.isInFlight;
  worker.isInFlight = (id) => id === 23;
  const server = await startServer();
  try {
    const { body } = await fetchActiveSessions(server);
    const byId = Object.fromEntries(body.sessions.map((s) => [s.id, s]));
    assert.strictEqual(byId[21].busy, true);
    assert.strictEqual(byId[22].busy, false);
    assert.strictEqual(byId[23].busy, true);
    assert.strictEqual(byId[24].busy, false);

    // totals: active counts 'active'-status rows only; busy counts the
    // mid-turn subset; total covers every returned row.
    assert.deepStrictEqual(body.totals, {
      active: 2,
      promoted: 1,
      paused: 1,
      busy: 2,
      total: 4,
    });
  } finally {
    worker.isInFlight = realIsInFlight;
    activeWorkers.clear();
    server.close();
  }
});

test('database failure surfaces as a 500, not a hang or leak', async () => {
  poolQueryHandler = async () => { throw new Error('boom'); };
  const server = await startServer();
  try {
    const { res, body } = await fetchActiveSessions(server);
    assert.strictEqual(res.status, 500);
    assert.ok(body.error);
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});
