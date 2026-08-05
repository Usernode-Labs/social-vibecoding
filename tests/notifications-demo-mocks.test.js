// Route tests for the staging (?demo=1) session-notification mocks and
// the kind-scoped mark-all on POST /api/notifications/read.
//
// GET /api/notifications?demo=1 in staging injects four unread mock rows
// — one per session-related kind (session_done / auto_solve_done /
// stale_pr / check_failed) — so the header cog's pinned "Needs
// attention" section, its green badge, and the bell's EXCLUSION of
// these kinds are reviewable in a staging preview. Per the "Staging
// mock data" convention the injection is request-time only, first page
// only, bumps the unread aggregate to match, and is strictly a no-op
// outside staging (or without ?demo=1).
//
// Harness shape mirrors tests/me-proposals-approver-tally.test.js: stub
// getPool BEFORE requiring the route module (destructured at require
// time), mount on a real express app, inject req.user. The route module
// captures USERNODE_ENV at load, so each environment gets a fresh
// require.
//
// Run with: node --test tests/notifications-demo-mocks.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');

// In-memory pool answering the three queries the GET route issues plus
// the mark-read UPDATEs, recording every call.
function makeMockPool() {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql: String(sql), params });
      // Count now shares the same aliased current-access predicate as list
      // and exact-id hydration, so recognize it before the generic feed
      // SELECT below.
      if (/COUNT\(\*\)::int AS c[\s\S]*FROM notifications n/.test(sql)) {
        return Promise.resolve({ rows: [{ c: 2 }] });
      }
      if (/FROM notifications n/.test(sql)) {
        // One real row so mock-vs-real ordering is observable.
        return Promise.resolve({
          rows: [{
            id: 1, kind: 'mention', read_at: null,
            created_at: '2026-07-01T00:00:00Z', app_id: 5,
            app_slug: 'real-app', app_name: 'Real App',
            chat_message_id: 10, message_content: 'hi @you',
            thread_type: null, thread_ref: null, session_id: null,
            pr_title: null, pr_number: null, headless_issue_number: null,
            branch_name: null, source_username: 'alice', detail: null,
          }],
        });
      }
      if (/FROM app_collaborators/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/UPDATE notifications SET read_at/.test(sql)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

// Load ../src/routes/notifications fresh under a given USERNODE_ENV.
function loadRoutes(env, pool) {
  const prevEnv = process.env.USERNODE_ENV;
  if (env == null) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = env;
  const prevGetPool = poolMod.getPool;
  poolMod.getPool = () => pool;
  const routePath = require.resolve('../src/routes/notifications');
  delete require.cache[routePath];
  const mod = require('../src/routes/notifications');
  // Restore for other test files; the loaded module keeps its capture.
  if (prevEnv == null) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = prevEnv;
  poolMod.getPool = prevGetPool;
  delete require.cache[routePath];
  return mod;
}

function startServer(mod) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(mod.notificationsRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

const SESSION_KINDS = ['session_done', 'auto_solve_done', 'stale_pr', 'check_failed'];

test('staging + ?demo=1: four unread mock session-kind rows prepend and bump unread', async () => {
  const pool = makeMockPool();
  const mod = loadRoutes('staging', pool);
  const { server, port } = await startServer(mod);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/notifications?limit=100&demo=1`);
    assert.equal(res.status, 200);
    const body = await res.json();

    const mocks = body.notifications.filter((n) => n.id >= 990000);
    assert.equal(mocks.length, 4, 'exactly four mock rows injected');
    assert.deepEqual(
      mocks.map((n) => n.kind).sort(),
      [...SESSION_KINDS].sort(),
      'one mock per session-related kind'
    );
    assert.ok(mocks.every((n) => !n.readAt), 'mock rows are unread (they feed the cog badge)');
    assert.ok(mocks.every((n) => n.appSlug === 'staging-demo'), 'obviously-fake app attribution');
    assert.equal(
      mocks.find((n) => n.kind === 'auto_solve_done').detail, 'failed',
      'the auto-solve mock exercises the failed variant'
    );
    // Real rows survive after the mocks; unread bumped by the mock count
    // so the client's red-badge subtraction stays honest.
    assert.ok(body.notifications.some((n) => n.id === 1), 'real rows still present');
    assert.equal(body.unread, 2 + 4);
  } finally {
    server.close();
  }
});

test('staging WITHOUT ?demo=1 and follow-up pages stay mock-free', async () => {
  const pool = makeMockPool();
  const mod = loadRoutes('staging', pool);
  const { server, port } = await startServer(mod);
  try {
    const first = await (await fetch(`http://127.0.0.1:${port}/api/notifications?limit=100`)).json();
    assert.ok(first.notifications.every((n) => n.id < 990000), 'no mocks without demo=1');
    assert.equal(first.unread, 2);

    // Cursor follow-up WITH demo=1: mocks are first-page-only (they would
    // duplicate on every older page otherwise).
    const paged = await (await fetch(
      `http://127.0.0.1:${port}/api/notifications?limit=100&demo=1&before=2026-07-01T00:00:00Z&before_id=1`
    )).json();
    assert.ok(paged.notifications.every((n) => n.id < 990000), 'no mocks on cursor pages');
    assert.equal(paged.unread, undefined, 'unread aggregate stays first-page-only');
  } finally {
    server.close();
  }
});

test('production: ?demo=1 is a strict no-op', async () => {
  const pool = makeMockPool();
  const mod = loadRoutes('production', pool);
  const { server, port } = await startServer(mod);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/notifications?limit=100&demo=1`)).json();
    assert.ok(body.notifications.every((n) => n.id < 990000), 'no mock rows in production');
    assert.equal(body.unread, 2);
  } finally {
    server.close();
  }
});

test('stagingMockNotifications rows carry the fields the shared row renderers read', () => {
  const pool = makeMockPool();
  const mod = loadRoutes('staging', pool);
  const rows = mod.stagingMockNotifications();
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.ok(r.id >= 990000 && r.id < 1000000, 'ids sit in the 99xxxx mock range');
    assert.equal(r.readAt, null);
    assert.ok(r.createdAt, 'timestamp present for relativeTime');
    assert.equal(r.appName, 'Staging demo app');
  }
  const sessionDone = rows.find((r) => r.kind === 'session_done');
  assert.match(sessionDone.prTitle, /^\[Mock\]/, 'mock titles are obviously fake');
  const autoSolve = rows.find((r) => r.kind === 'auto_solve_done');
  assert.ok(autoSolve.headlessIssueNumber, 'auto-solve row points at an issue number');
});

// ── POST /api/notifications/read kind scoping ───────────────────────────

test('POST /read {all, kinds} and {all, exclude_kinds} reach the service scoped', async () => {
  const pool = makeMockPool();
  const mod = loadRoutes('production', pool);
  const { server, port } = await startServer(mod);
  try {
    await fetch(`http://127.0.0.1:${port}/api/notifications/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true, kinds: SESSION_KINDS }),
    });
    let update = pool.calls.find((c) => /UPDATE notifications SET read_at/.test(c.sql));
    assert.ok(update, 'update issued');
    assert.match(update.sql, /kind = ANY\(\$2\)/);
    assert.deepEqual(update.params, [7, SESSION_KINDS]);

    pool.calls.length = 0;
    await fetch(`http://127.0.0.1:${port}/api/notifications/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true, exclude_kinds: SESSION_KINDS }),
    });
    update = pool.calls.find((c) => /UPDATE notifications SET read_at/.test(c.sql));
    assert.match(update.sql, /NOT \(kind = ANY\(\$2\)\)/);
    assert.deepEqual(update.params, [7, SESSION_KINDS]);

    // Non-array / junk kind values are ignored → unscoped clear-all.
    pool.calls.length = 0;
    await fetch(`http://127.0.0.1:${port}/api/notifications/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true, kinds: 'session_done' }),
    });
    update = pool.calls.find((c) => /UPDATE notifications SET read_at/.test(c.sql));
    assert.doesNotMatch(update.sql, /ANY/);
    assert.deepEqual(update.params, [7]);
  } finally {
    server.close();
  }
});
