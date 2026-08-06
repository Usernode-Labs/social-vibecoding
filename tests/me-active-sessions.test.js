// Route test for GET /api/me/active-sessions (src/routes/sessions.js) —
// the cross-app "viewer's own sessions" endpoint. Long the data source
// for the dev tab's "Active Sessions (x/y)" panel, it now also backs the
// header cog's "Your sessions" drawer section, so its owner scoping,
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

// `viewer` / `config` are overridable so the caps tests can mount the
// same router as a full admin, a view-only admin, and with a tuned
// config — the payload's `caps` field is per-requester.
function startServer({ viewer = VIEWER, config = {} } = {}) {
  const app = express();
  app.use((req, res, next) => { req.user = viewer; next(); });
  app.use(sessionRoutes(config));
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
    // CLI drafts have no PR number, so expose only a derived boolean proving
    // an uploaded revision exists — never the handoff commit SHA itself.
    assert.match(q.sql, /\(cs\.pr_number IS NOT NULL OR cs\.handoff_uploaded_sha IS NOT NULL\) AS can_review_changes/);
    assert.doesNotMatch(q.sql, /cs\.handoff_uploaded_sha,/);
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

// ── caps: the per-viewer "(N/M)" denominators ───────────────────────────
//
// The dev drawer used to hardcode "/3", which lied the moment an operator
// retuned MAX_USER_SESSIONS and could never express the raised admin caps.
// The server now ships the viewer's own effective ceilings, so display and
// enforcement can't drift. Gating is on canAdminWrite (NOT isAdmin) —
// view-only admins stay on the base caps.
test('caps: regular viewer gets the base 3/5 tier', async () => {
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServer();
  try {
    const { body } = await fetchActiveSessions(server);
    assert.deepStrictEqual(body.caps, { activeSessions: 3, promotedSessions: 5 });
  } finally {
    server.close();
  }
});

test('caps: full platform admin gets the raised 5/8 tier', async () => {
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServer({
    viewer: { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true },
  });
  try {
    const { body } = await fetchActiveSessions(server);
    assert.deepStrictEqual(body.caps, { activeSessions: 5, promotedSessions: 8 });
  } finally {
    server.close();
  }
});

test('caps: view-only admin stays on the base tier', async () => {
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServer({
    viewer: { id: 2, username: 'viewadmin', isAdmin: true, canAdminWrite: false },
  });
  try {
    const { body } = await fetchActiveSessions(server);
    assert.deepStrictEqual(body.caps, { activeSessions: 3, promotedSessions: 5 });
  } finally {
    server.close();
  }
});

test('caps: a tuned config is reflected per tier', async () => {
  poolQueryHandler = async () => ({ rows: [] });
  const config = {
    maxUserSessions: 2, maxUserPromotedSessions: 4,
    maxAdminUserSessions: 9, maxAdminUserPromotedSessions: 10,
  };
  const asUser = await startServer({ config });
  try {
    const { body } = await fetchActiveSessions(asUser);
    assert.deepStrictEqual(body.caps, { activeSessions: 2, promotedSessions: 4 });
  } finally {
    asUser.close();
  }
  const asAdmin = await startServer({
    config, viewer: { id: 1, username: 'admin', canAdminWrite: true },
  });
  try {
    const { body } = await fetchActiveSessions(asAdmin);
    assert.deepStrictEqual(body.caps, { activeSessions: 9, promotedSessions: 10 });
  } finally {
    asAdmin.close();
  }
});

// Mounting with an empty config (what most route tests do) must still
// yield numbers — the client renders these directly, so `undefined` here
// would paint "(N/undefined)".
test('caps: never undefined even with an empty config, and totals still ride along', async () => {
  poolQueryHandler = async () => ({
    rows: [sessionRow({ id: 31, status: 'active' }), sessionRow({ id: 32, status: 'promoted' })],
  });
  const realIsInFlight = worker.isInFlight;
  worker.isInFlight = () => false;
  activeWorkers.clear();
  const server = await startServer();
  try {
    const { body } = await fetchActiveSessions(server);
    assert.ok(body.caps, 'caps present');
    assert.ok(Number.isInteger(body.caps.activeSessions) && body.caps.activeSessions > 0);
    assert.ok(Number.isInteger(body.caps.promotedSessions) && body.caps.promotedSessions > 0);
    assert.strictEqual(body.totals.active, 1);
    assert.strictEqual(body.totals.promoted, 1);
  } finally {
    worker.isInFlight = realIsInFlight;
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

// ── shared-sessions: linked_issues rides along for the "#N" chips ────────
//
// The Dev board's shared-session cards render one "#N" chip per linked
// issue (reverse of the issue list's "In progress" chip), so the
// metadata-only /shared-sessions payload must include linked_issues.
// Issue numbers are group-visible data — the issue list itself is
// view-level — so this widens nothing sensitive.
test('shared-sessions returns linked_issues per row', async () => {
  const appAccess = require('../src/services/app-access');
  const prevGet = appAccess.getAppForUser;
  appAccess.getAppForUser = async () => ({ id: 1, slug: 'demo' });
  capturedQueries = [];
  poolQueryHandler = async (sql) => {
    if (/shared_at IS NOT NULL/.test(String(sql))) {
      return {
        rows: [{
          id: 9, session_title: 'Shared work', pr_title: null,
          branch_name: 'dev/maya-1', status: 'active',
          staging_url: null, can_preview: false,
          linked_issues: [12, 34],
          user_id: 3, username: 'maya',
          shared_at: '2026-06-12T00:00:00Z', created_at: '2026-06-11T00:00:00Z',
          last_activity_at: '2026-06-12T00:00:00Z',
          chat_count: 0, last_message_at: null,
        }],
      };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/shared-sessions`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.sessions.length, 1);
    assert.deepStrictEqual(body.sessions[0].linked_issues, [12, 34]);

    const q = capturedQueries.find((c) => /shared_at IS NOT NULL/.test(c.sql));
    assert.ok(q, 'shared-sessions query was issued');
    assert.match(q.sql, /cs\.linked_issues/);
  } finally {
    appAccess.getAppForUser = prevGet;
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});
