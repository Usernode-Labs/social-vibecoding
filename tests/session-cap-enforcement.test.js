// Enforcement test for the per-user ACTIVE-session cap on
// POST /api/apps/:slug/sessions (src/routes/sessions.js).
//
// Two things are load-bearing here and were previously untested:
//   1. The ceiling is per-REQUESTER: full platform admins get the raised
//      cap (5 by default), everyone else the base cap (3). Gating is on
//      canAdminWrite — a view-only admin must be refused at the base cap
//      like any regular user.
//   2. The 429 message must quote the SAME number that was enforced, so a
//      user is never told "you already have 3" while sitting at 5.
//
// Also pinned: the GLOBAL ceiling has NO admin tier. It's a host-resource
// bound (warm workers + staging containers on one box), so a full admin at
// the platform cap gets the capacity 429 like everyone else — the per-user
// tier must not be mistaken for a global exemption.
//
// Same harness shape as tests/me-active-sessions.test.js: override getPool
// BEFORE requiring the route module, mount on a real express app, inject
// req.user. The count queries are answered by regex so each test can put
// the user at an exact occupancy.
//
// Run with: node --test tests/session-cap-enforcement.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({ query: (sql, params) => poolQueryHandler(sql, params) });

const appAccess = require('../src/services/app-access');
const github = require('../src/services/github');
const sessionLifecycle = require('../src/services/session-lifecycle');
const events = require('../src/services/events');

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const APP = {
  id: 5, slug: 'whiteboard', name: 'Whiteboard',
  repo_url: 'https://github.com/acme/whiteboard',
};

const USER = { id: 7, username: 'tester' };
const FULL_ADMIN = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };
const VIEW_ADMIN = { id: 2, username: 'viewadmin', isAdmin: true, canAdminWrite: false };

// Occupancy fixture: `own` = the caller's 'active' rows, `global` = the
// platform-wide active+promoted count. Everything else returns the
// inserted row so a successful create resolves.
function occupancy({ own, global: globalCount }) {
  return async (sql) => {
    const s = String(sql);
    if (/status = 'active' AND is_headless = FALSE/.test(s)) return { rows: [{ cnt: String(own) }] };
    if (/status IN \('active', 'promoted'\)/.test(s)) return { rows: [{ cnt: String(globalCount) }] };
    if (/INSERT INTO chat_sessions/.test(s)) {
      return { rows: [{ id: 99, app_id: APP.id, user_id: 7, status: 'active', branch_name: 'dev/tester-1' }] };
    }
    return { rows: [] };
  };
}

async function createSession({ user, config }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use(sessionRoutes(config || {}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/whiteboard/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

// Keep every side effect of a successful create inert.
const restores = [];
test.before(() => {
  restores.push([appAccess, 'getAppForUser', appAccess.getAppForUser]);
  appAccess.getAppForUser = async () => ({ ...APP });
  restores.push([github, 'isEnabled', github.isEnabled]);
  github.isEnabled = () => false;
  restores.push([events, 'record', events.record]);
  events.record = () => {};
});

test.after(() => {
  for (const [obj, key, val] of restores) obj[key] = val;
});

test('regular user is refused at the base cap of 3, and the message quotes 3', async () => {
  poolQueryHandler = occupancy({ own: 3, global: 0 });
  const { status, body } = await createSession({ user: USER });
  assert.strictEqual(status, 429);
  assert.match(body.error, /already have 3 running sessions/);
});

test('regular user below the base cap is admitted', async () => {
  poolQueryHandler = occupancy({ own: 2, global: 0 });
  const { status, body } = await createSession({ user: USER });
  assert.strictEqual(status, 201);
  assert.ok(body.session, 'session created');
});

test('full admin is admitted at 3 — where a regular user is refused', async () => {
  poolQueryHandler = occupancy({ own: 3, global: 0 });
  const { status, body } = await createSession({ user: FULL_ADMIN });
  assert.strictEqual(status, 201);
  assert.ok(body.session, 'session created');
});

test('full admin is refused at the raised cap of 5, and the message quotes 5', async () => {
  poolQueryHandler = occupancy({ own: 5, global: 0 });
  const { status, body } = await createSession({ user: FULL_ADMIN });
  assert.strictEqual(status, 429);
  assert.match(body.error, /already have 5 running sessions/);
});

// The regression this guards: gating on isAdmin instead of canAdminWrite
// would silently hand the bump to every view-only admin.
test('view-only admin is refused at the base cap of 3 like a regular user', async () => {
  poolQueryHandler = occupancy({ own: 3, global: 0 });
  const { status, body } = await createSession({ user: VIEW_ADMIN });
  assert.strictEqual(status, 429);
  assert.match(body.error, /already have 3 running sessions/);
});

test('a tuned admin cap is enforced and quoted', async () => {
  const config = { maxUserSessions: 3, maxAdminUserSessions: 9 };
  poolQueryHandler = occupancy({ own: 8, global: 0 });
  const admitted = await createSession({ user: FULL_ADMIN, config });
  assert.strictEqual(admitted.status, 201);

  poolQueryHandler = occupancy({ own: 9, global: 0 });
  const refused = await createSession({ user: FULL_ADMIN, config });
  assert.strictEqual(refused.status, 429);
  assert.match(refused.body.error, /already have 9 running sessions/);
});

// ── the global ceiling has no admin tier ────────────────────────────────
test('full admin still gets the capacity 429 at the global cap when nothing can be freed', async () => {
  const realFree = sessionLifecycle.freeGlobalSlot;
  sessionLifecycle.freeGlobalSlot = async () => ({ freed: false });
  try {
    // Well under the raised per-user cap, but the platform is full.
    poolQueryHandler = occupancy({ own: 0, global: 25 });
    const { status, body } = await createSession({
      user: FULL_ADMIN, config: { maxGlobalSessions: 25 },
    });
    assert.strictEqual(status, 429);
    assert.match(body.error, /Platform is at capacity/);
  } finally {
    sessionLifecycle.freeGlobalSlot = realFree;
  }
});

test('at the global cap, an admin is admitted once a slot is reclaimed', async () => {
  const realFree = sessionLifecycle.freeGlobalSlot;
  sessionLifecycle.freeGlobalSlot = async () => ({ freed: true });
  try {
    poolQueryHandler = occupancy({ own: 0, global: 25 });
    const { status } = await createSession({
      user: FULL_ADMIN, config: { maxGlobalSessions: 25 },
    });
    assert.strictEqual(status, 201);
  } finally {
    sessionLifecycle.freeGlobalSlot = realFree;
  }
});
