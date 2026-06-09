// Tests for src/routes/kudos.js
//
// Two layers:
//   1. Pure-function unit tests for weekStartUtc() (the Monday-00-UTC
//      bucket helper that drives the quota check).
//   2. Route-handler tests that wire kudosRoutes(config) onto a
//      throwaway Express app, swap getPool() out for an in-memory mock
//      that intercepts pool.query() calls, and assert on HTTP status +
//      response body for the five paths the plan calls out:
//        - quota cap (5 succeed, 6th = 429)
//        - self-kudos blocked (403)
//        - dupe-per-PR (409 via PG unique_violation)
//        - eligibility state filter (404 for 'active' / 'paused')
//        - week-boundary bucketing (kudos at Sunday 23:59:59 UTC vs.
//          Monday 00:00:00 UTC land in different buckets)
//
// Run with: node --test tests/kudos.test.js
//
// No real Postgres needed. The mock pool returns canned rows based on
// SQL pattern matching — light enough to keep the test file readable
// without pulling in a sql-parser.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// ─── Freeze the clock for the route-handler integration tests ────
//
// The route handlers call weekStartUtc() (which reads the real wall
// clock) once per request. The quota / budget tests fire several
// sequential requests and assume every one lands in the SAME UTC week
// bucket — the 5 inserts and the 6th request's COUNT must agree on
// `week_start` for the 429 to fire, and the budget test's POST + re-read
// must share a bucket for `given_this_week` to tick up.
//
// That assumption silently breaks if the suite happens to run across the
// Monday-00:00-UTC rollover: the requests straddle two buckets, the
// count comes up short, and the quota test sees 200 instead of 429. A
// genuine once-a-week flake. Pinning "now" to a fixed mid-week instant
// (Wed 2026-05-20 12:00 UTC — nowhere near a boundary) makes every
// weekStartUtc() evaluation deterministic.
//
// Only the argless `new Date()` / `Date.now()` path is frozen; callers
// that pass an explicit timestamp (the mock pool's created_at, and the
// weekStartUtc unit tests below, which always pass a Date) are untouched.
const RealDate = Date;
const FROZEN_NOW = RealDate.UTC(2026, 4, 20, 12, 0, 0);
class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FROZEN_NOW);
    else super(...args);
  }
  static now() { return FROZEN_NOW; }
}
FrozenDate.UTC = RealDate.UTC;
FrozenDate.parse = RealDate.parse;
global.Date = FrozenDate;
test.after(() => { global.Date = RealDate; });

// We need to swap getPool() at the module level so kudosRoutes()
// receives the mock. Patch the singleton's cache by reaching into
// require.cache and replacing the module export. Cheaper than full
// proxyquire and avoids pulling in another dev dep.
function withMockPool(mockPool, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const original = require.cache[poolModulePath];
  const stub = {
    exports: { getPool: () => mockPool },
    loaded: true,
    id: poolModulePath,
    filename: poolModulePath,
    paths: original ? original.paths : [],
  };
  require.cache[poolModulePath] = stub;
  // Force kudos.js to re-resolve so it picks up the stubbed getPool.
  delete require.cache[require.resolve('../src/routes/kudos')];
  // ws.js calls pushNotificationToUser / pushKudosUpdate — replace
  // those with no-ops so the tests don't try to broadcast over a
  // nonexistent WS server.
  const wsPath = require.resolve('../src/services/ws');
  const origWs = require.cache[wsPath];
  require.cache[wsPath] = {
    exports: {
      pushNotificationToUser: () => 0,
      pushKudosUpdate: () => {},
    },
    loaded: true,
    id: wsPath,
    filename: wsPath,
    paths: origWs ? origWs.paths : [],
  };
  // notifications.js's serialize() is called during the hydrate path;
  // we don't need to stub it — it's a pure function on the row shape.
  try {
    return fn();
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    if (origWs) require.cache[wsPath] = origWs;
    else delete require.cache[wsPath];
    delete require.cache[require.resolve('../src/routes/kudos')];
  }
}

// In-memory mock pool. Query handlers are registered as (regex, fn);
// the first match wins. Each test sets up its own mock so behavior
// is isolated.
function makeMockPool(initial = {}) {
  const state = {
    sessions: new Map(initial.sessions || []),
    users: new Map(initial.users || []),
    kudos: [], // array of { session_id, giver_user_id, week_start }
    bounties: [], // array of { app_id, github_issue_number, giver_user_id, week_start }
    notifications: [],
    nextId: 1,
  };
  const seq = () => state.nextId++;

  async function query(sql, params = []) {
    const s = String(sql);
    // ------------ SELECT session + app context ------------
    if (/SELECT[\s\S]*FROM chat_sessions cs[\s\S]*JOIN apps a/i.test(s)) {
      const id = params[0];
      const session = state.sessions.get(id);
      if (!session) return { rows: [] };
      return { rows: [{ ...session, app_slug: 'app', app_name: 'App' }] };
    }
    // ------------ SELECT existence check ------------
    if (/^\s*SELECT id FROM chat_sessions WHERE id = \$1\s*$/i.test(s)) {
      const id = params[0];
      return { rows: state.sessions.has(id) ? [{ id }] : [] };
    }
    // ------------ Combined weekly allowance (pr_kudos + issue_bounties) ------------
    // countWeeklyAllowanceUsed: the give-quota + budget endpoints now draw
    // from a shared cap across both ledgers. Matched specifically on the
    // bounty subquery's `giver_user_id = $1 AND week_start = $2` predicate so
    // this DOESN'T also catch the leaderboard/users query (whose awarded-
    // bounty LATERAL filters on awarded_user_id, not giver_user_id).
    if (/FROM issue_bounties\s+WHERE giver_user_id = \$1 AND week_start = \$2/i.test(s)) {
      const [userId, weekStart] = params;
      const k = state.kudos.filter(
        (x) => x.giver_user_id === userId && x.week_start === weekStart
      ).length;
      const b = state.bounties.filter(
        (x) => x.giver_user_id === userId && x.week_start === weekStart
      ).length;
      return { rows: [{ c: k + b }] };
    }
    // ------------ Count this week ------------
    if (/SELECT COUNT\(\*\)::int AS c FROM pr_kudos[\s\S]*giver_user_id = \$1 AND week_start = \$2/i.test(s)) {
      const [userId, weekStart] = params;
      const c = state.kudos.filter(
        (k) => k.giver_user_id === userId && k.week_start === weekStart
      ).length;
      return { rows: [{ c }] };
    }
    // ------------ INSERT pr_kudos ------------
    if (/^\s*INSERT INTO pr_kudos/i.test(s)) {
      const [sessionId, giverId, weekStart] = params;
      const dup = state.kudos.find(
        (k) => k.session_id === sessionId && k.giver_user_id === giverId
      );
      if (dup) {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      const id = seq();
      const row = { id, session_id: sessionId, giver_user_id: giverId, week_start: weekStart, created_at: new Date().toISOString() };
      state.kudos.push(row);
      return { rows: [{ id, created_at: row.created_at }] };
    }
    // ------------ INSERT notifications ------------
    if (/^\s*INSERT INTO notifications/i.test(s)) {
      const [userId, appId, sessionId, sourceUserId] = params;
      const id = seq();
      const row = {
        id, user_id: userId, app_id: appId, session_id: sessionId,
        source_user_id: sourceUserId, kind: 'kudos',
        chat_message_id: null, read_at: null,
        created_at: new Date().toISOString(),
      };
      state.notifications.push(row);
      return { rows: [row] };
    }
    // ------------ SELECT notification hydrate ------------
    if (/SELECT n\.id, n\.kind[\s\S]*FROM notifications n/i.test(s)) {
      const id = params[0];
      const n = state.notifications.find((x) => x.id === id);
      if (!n) return { rows: [] };
      return { rows: [{ ...n, app_slug: 'app', app_name: 'App', message_content: null, pr_title: null, pr_number: null, source_username: null }] };
    }
    // ------------ COUNT per session ------------
    if (/SELECT COUNT\(\*\)::int AS c FROM pr_kudos WHERE session_id = \$1/i.test(s)) {
      const [sid] = params;
      const c = state.kudos.filter((k) => k.session_id === sid).length;
      return { rows: [{ c }] };
    }
    // ------------ Hydrate kudos givers for GET ------------
    if (/SELECT pk\.created_at, u\.username/i.test(s)) {
      const [sid] = params;
      const rows = state.kudos
        .filter((k) => k.session_id === sid)
        .map((k) => ({ created_at: k.created_at, username: `u${k.giver_user_id}`, user_id: k.giver_user_id }));
      return { rows };
    }
    // ------------ Leaderboard: users (with kudos_given map) ------------
    // Mirrors the GET /api/leaderboard/users query: received-side
    // aggregates keyed off each user's authored sessions, plus the new
    // given-side `kudos_given` {week_start: count} map (capped at 5).
    // Window is detected from the SQL: the `gk.week_start = $N` filter
    // is only present when window=week, and its value is params[0].
    if (/FROM users u[\s\S]*kudos_given/i.test(s)) {
      const isWeek = /gk\.week_start = \$/.test(s);
      const weekStart = isWeek ? params[0] : null;
      const hasLimit = /LIMIT \$/i.test(s);
      const limit = hasLimit ? params[params.length - 1] : null;
      const inWindow = (k) => !isWeek || k.week_start === weekStart;
      const statusOf = new Map([...state.sessions.values()].map((cs) => [cs.id, cs.status]));

      const rows = [];
      for (const [uid, u] of state.users) {
        const authored = [...state.sessions.values()]
          .filter((cs) => cs.user_id === uid)
          .map((cs) => cs.id);
        const received = state.kudos.filter(
          (k) => authored.includes(k.session_id) && inWindow(k)
        );
        // Given-side: group this user's kudos by week, cap each at 5.
        const byWeek = {};
        for (const k of state.kudos) {
          if (k.giver_user_id !== uid || !inWindow(k)) continue;
          byWeek[k.week_start] = (byWeek[k.week_start] || 0) + 1;
        }
        const kudos_given = {};
        for (const wk of Object.keys(byWeek)) kudos_given[wk] = Math.min(byWeek[wk], 5);

        rows.push({
          user_id: uid,
          username: u.username,
          kudos_received: received.length,
          prs_kudosed: new Set(received.map((k) => k.session_id)).size,
          kudos_received_prs_merged: received.filter((k) => statusOf.get(k.session_id) === 'merged').length,
          kudos_received_prs_unmerged: received.filter((k) => statusOf.get(k.session_id) !== 'merged').length,
          prs_merged: authored.filter((sid) => statusOf.get(sid) === 'merged').length,
          last_kudos_at: received.map((k) => k.created_at).sort().pop() || null,
          kudos_given,
        });
      }
      rows.sort((a, b) =>
        b.kudos_received_prs_merged - a.kudos_received_prs_merged ||
        b.prs_merged - a.prs_merged ||
        b.kudos_received - a.kudos_received ||
        (a.username < b.username ? -1 : a.username > b.username ? 1 : 0)
      );
      return { rows: hasLimit ? rows.slice(0, limit) : rows };
    }
    throw new Error(`unhandled mock SQL: ${s.slice(0, 80)}`);
  }

  return { query, state };
}

// Build an Express app with the kudos routes mounted and a tiny
// shim that injects req.user from the X-Test-User header. Returns
// `{ app, baseUrl, close }` once the http server is listening.
async function startTestServer(pool, user = { id: 1, username: 'alice' }) {
  return withMockPool(pool, async () => {
    const { kudosRoutes } = require('../src/routes/kudos');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use(kudosRoutes({}));
    return new Promise((resolve) => {
      const server = app.listen(0, () => {
        const port = server.address().port;
        resolve({
          app,
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((r) => server.close(r)),
        });
      });
    });
  });
}

// ─── 1. Pure-function unit tests ─────────────────────────────

test('weekStartUtc: Monday 00:00 UTC maps to itself', () => {
  const { weekStartUtc } = require('../src/routes/kudos');
  // 2026-05-18 is a Monday (confirmed)
  const t = new Date(Date.UTC(2026, 4, 18, 0, 0, 0));
  assert.equal(weekStartUtc(t), '2026-05-18');
});

test('weekStartUtc: Sunday 23:59:59 UTC maps back to previous Monday', () => {
  const { weekStartUtc } = require('../src/routes/kudos');
  // Sunday May 17, 2026
  const t = new Date(Date.UTC(2026, 4, 17, 23, 59, 59));
  assert.equal(weekStartUtc(t), '2026-05-11');
});

test('weekStartUtc: Sunday and the following Monday land in different buckets', () => {
  const { weekStartUtc } = require('../src/routes/kudos');
  const sun = new Date(Date.UTC(2026, 4, 17, 23, 59, 59));
  const mon = new Date(Date.UTC(2026, 4, 18, 0, 0, 1));
  assert.notEqual(weekStartUtc(sun), weekStartUtc(mon));
  assert.equal(weekStartUtc(sun), '2026-05-11');
  assert.equal(weekStartUtc(mon), '2026-05-18');
});

test('weekStartUtc: Wednesday rolls back 2 days', () => {
  const { weekStartUtc } = require('../src/routes/kudos');
  const wed = new Date(Date.UTC(2026, 4, 20, 17, 30, 0));
  assert.equal(weekStartUtc(wed), '2026-05-18');
});

test('weekStartUtc: crossing month/year boundary', () => {
  const { weekStartUtc } = require('../src/routes/kudos');
  // Jan 1 2027 is a Friday → Monday Dec 28 2026
  const t = new Date(Date.UTC(2027, 0, 1, 12, 0, 0));
  assert.equal(weekStartUtc(t), '2026-12-28');
});

// ─── 2. Route handler integration tests with mock pool ────────

test('POST kudos: succeeds 5 times, 6th hits 429 quota', async () => {
  const pool = makeMockPool({
    sessions: [
      [10, { id: 10, user_id: 999, status: 'merged', app_id: 1 }],
      [11, { id: 11, user_id: 999, status: 'merged', app_id: 1 }],
      [12, { id: 12, user_id: 999, status: 'merged', app_id: 1 }],
      [13, { id: 13, user_id: 999, status: 'merged', app_id: 1 }],
      [14, { id: 14, user_id: 999, status: 'merged', app_id: 1 }],
      [15, { id: 15, user_id: 999, status: 'merged', app_id: 1 }],
    ],
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    for (let i = 10; i <= 14; i++) {
      const r = await fetch(`${baseUrl}/api/sessions/${i}/kudos`, { method: 'POST' });
      assert.equal(r.status, 200, `kudos #${i - 9} should succeed`);
    }
    const sixth = await fetch(`${baseUrl}/api/sessions/15/kudos`, { method: 'POST' });
    assert.equal(sixth.status, 429);
    const body = await sixth.json();
    assert.match(body.error, /quota/i);
  } finally {
    await close();
  }
});

test('POST kudos: self-kudos blocked with 403', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 1, status: 'merged', app_id: 1 }]],
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const r = await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'POST' });
    assert.equal(r.status, 403);
    const body = await r.json();
    assert.match(body.error, /your own PR/i);
  } finally {
    await close();
  }
});

test('POST kudos: duplicate on same PR returns 409', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 999, status: 'merged', app_id: 1 }]],
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const first = await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'POST' });
    assert.equal(first.status, 200);
    const second = await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'POST' });
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.match(body.error, /already/i);
  } finally {
    await close();
  }
});

test('POST kudos: ineligible state (active) returns 404', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 999, status: 'active', app_id: 1 }]],
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const r = await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'POST' });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.match(body.error, /promoted, merging, or merged/i);
  } finally {
    await close();
  }
});

test('POST kudos: ineligible state (paused) returns 404', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 999, status: 'paused', app_id: 1 }]],
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const r = await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'POST' });
    assert.equal(r.status, 404);
  } finally {
    await close();
  }
});

test('POST kudos: 404 when session does not exist', async () => {
  const pool = makeMockPool({ sessions: [] });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const r = await fetch(`${baseUrl}/api/sessions/999/kudos`, { method: 'POST' });
    assert.equal(r.status, 404);
  } finally {
    await close();
  }
});

test('POST kudos: each of promoted/merging/merged is accepted', async () => {
  for (const status of ['promoted', 'merging', 'merged']) {
    const pool = makeMockPool({
      sessions: [[10, { id: 10, user_id: 999, status, app_id: 1 }]],
    });
    const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
    try {
      const r = await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'POST' });
      assert.equal(r.status, 200, `state ${status} should accept kudos`);
    } finally {
      await close();
    }
  }
});

test('GET kudos-budget reports remaining count', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 999, status: 'merged', app_id: 1 }]],
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    let budget = await (await fetch(`${baseUrl}/api/me/kudos-budget`)).json();
    assert.equal(budget.given_this_week, 0);
    assert.equal(budget.remaining, 5);
    assert.equal(budget.limit, 5);
    await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'POST' });
    budget = await (await fetch(`${baseUrl}/api/me/kudos-budget`)).json();
    assert.equal(budget.given_this_week, 1);
    assert.equal(budget.remaining, 4);
  } finally {
    await close();
  }
});

// ─── 3. leaderboard/users: kudos_given map ────────────────────
//
// The clock is frozen at Wed 2026-05-20 12:00 UTC, so the current
// week bucket (weekStartUtc()) is the Monday 2026-05-18.

// Seed a pool with three users and a giver (bob) who gave kudos across
// two weeks — including an over-cap week to exercise the LEAST(.,5).
function seedGivenPool() {
  const pool = makeMockPool({
    users: [
      [1, { username: 'alice' }],
      [2, { username: 'bob' }],
      [3, { username: 'carol' }],
    ],
  });
  // bob (id 2) gave 3 kudos in the prior week and 6 in the current week
  // (one above the cap, to prove it's clamped to 5). carol (id 3) gave
  // nothing.
  const prior = '2026-05-11';
  const current = '2026-05-18';
  let sid = 100;
  for (let i = 0; i < 3; i++) {
    pool.state.kudos.push({ id: sid, session_id: sid, giver_user_id: 2, week_start: prior, created_at: '2026-05-12T00:00:00.000Z' });
    sid++;
  }
  for (let i = 0; i < 6; i++) {
    pool.state.kudos.push({ id: sid, session_id: sid, giver_user_id: 2, week_start: current, created_at: '2026-05-19T00:00:00.000Z' });
    sid++;
  }
  return pool;
}

test('leaderboard/users: kudos_given is a multi-week map (window=all), capped at 5', async () => {
  const pool = seedGivenPool();
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const data = await (await fetch(`${baseUrl}/api/leaderboard/users?window=all`)).json();
    assert.equal(data.window, 'all');
    assert.equal(data.weekStart, null);
    const bob = data.items.find((r) => r.username === 'bob');
    assert.deepEqual(bob.kudos_given, { '2026-05-11': 3, '2026-05-18': 5 });
  } finally {
    await close();
  }
});

test('leaderboard/users: kudos_given holds at most the current week (window=week)', async () => {
  const pool = seedGivenPool();
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const data = await (await fetch(`${baseUrl}/api/leaderboard/users?window=week`)).json();
    assert.equal(data.window, 'week');
    assert.equal(data.weekStart, '2026-05-18');
    const bob = data.items.find((r) => r.username === 'bob');
    // Only the current week bucket survives the window filter; still capped.
    assert.deepEqual(bob.kudos_given, { '2026-05-18': 5 });
  } finally {
    await close();
  }
});

test('leaderboard/users: a user who gave nothing gets an empty map', async () => {
  const pool = seedGivenPool();
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const all = await (await fetch(`${baseUrl}/api/leaderboard/users?window=all`)).json();
    const carol = all.items.find((r) => r.username === 'carol');
    assert.deepEqual(carol.kudos_given, {});
    const week = await (await fetch(`${baseUrl}/api/leaderboard/users?window=week`)).json();
    // bob gave none in... he did give this week; check alice (gave nothing ever)
    const aliceWeek = week.items.find((r) => r.username === 'alice');
    assert.deepEqual(aliceWeek.kudos_given, {});
  } finally {
    await close();
  }
});
