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
  // The real notifications service freezes the generic outbox event.
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
      // Voided self-bounties are refunded — they don't count against the
      // weekly allowance (mirrors the `status <> 'voided'` filter in
      // countWeeklyAllowanceUsed).
      const b = state.bounties.filter(
        (x) => x.giver_user_id === userId && x.week_start === weekStart
          && x.status !== 'voided'
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
    // ------------ DELETE pr_kudos (retract) ------------
    if (/^\s*DELETE FROM pr_kudos/i.test(s)) {
      const [sessionId, giverId] = params;
      const idx = state.kudos.findIndex(
        (k) => k.session_id === sessionId && k.giver_user_id === giverId
      );
      if (idx === -1) return { rows: [], rowCount: 0 };
      const [row] = state.kudos.splice(idx, 1);
      return { rows: [{ id: row.id, week_start: row.week_start }], rowCount: 1 };
    }
    // ------------ DELETE notifications (retract cleanup) ------------
    if (/^\s*DELETE FROM notifications/i.test(s)) {
      const [sessionId, sourceUserId] = params;
      const before = state.notifications.length;
      state.notifications = state.notifications.filter(
        (n) => !(n.kind === 'kudos' && n.session_id === sessionId && n.source_user_id === sourceUserId)
      );
      return { rows: [], rowCount: before - state.notifications.length };
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
    // ------------ Generic occurrence hydrate + outbox update ------------
    if (/SELECT n\.id, n\.user_id, n\.kind[\s\S]*FROM notifications n/i.test(s)) {
      const ids = params[0];
      return {
        rows: state.notifications.filter((x) => ids.includes(x.id)).map((n) => ({
          ...n,
          app_slug: 'app', app_name: 'App', message_content: null,
          thread_type: null, thread_ref: null,
          pr_title: null, pr_number: null, headless_issue_number: null,
          branch_name: null, source_username: null, detail: null,
        })),
      };
    }
    if (/UPDATE notifications AS n[\s\S]*activity_event = payload\.event/i.test(s)) {
      for (const item of JSON.parse(params[0])) {
        const row = state.notifications.find((n) => n.id === item.id);
        if (row) row.activity_event = item.event;
      }
      return { rows: [], rowCount: JSON.parse(params[0]).length };
    }
    // ------------ COUNT per session ------------
    if (/SELECT COUNT\(\*\)::int AS c FROM pr_kudos WHERE session_id = \$1/i.test(s)) {
      const [sid] = params;
      const c = state.kudos.filter((k) => k.session_id === sid).length;
      return { rows: [{ c }] };
    }
    // ------------ Hydrate kudos givers for GET ------------
    // Mirrors loadKudosForSession's union: direct pr_kudos rows tagged
    // source='pr' plus issue bounties AWARDED to the session tagged
    // source='bounty' (drives the my_kudos_direct distinction).
    if (/SELECT pk\.created_at, u\.username/i.test(s)) {
      const [sid] = params;
      const direct = state.kudos
        .filter((k) => k.session_id === sid)
        .map((k) => ({ created_at: k.created_at, username: `u${k.giver_user_id}`, user_id: k.giver_user_id, source: 'pr' }));
      const awarded = state.bounties
        .filter((b) => b.awarded_session_id === sid && b.status === 'awarded')
        .map((b) => ({ created_at: b.awarded_at || null, username: `u${b.giver_user_id}`, user_id: b.giver_user_id, source: 'bounty' }));
      return { rows: [...direct, ...awarded] };
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

// ─── 2b. DELETE /api/sessions/:id/kudos — retract (issue #197) ───
//
// The clock is frozen at Wed 2026-05-20 12:00 UTC, so the current
// week bucket is 2026-05-18 and the prior week's is 2026-05-11.

test('DELETE kudos: removes the row, refunds the slot, cleans the notification', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 999, status: 'merged', app_id: 1 }]],
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const give = await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'POST' });
    assert.equal(give.status, 200);
    assert.equal(pool.state.kudos.length, 1);
    assert.equal(pool.state.notifications.length, 1, 'give created the author notification');

    const r = await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.remaining, 5, 'current-week slot is refunded');
    assert.equal(body.limit, 5);
    assert.equal(pool.state.kudos.length, 0, 'pr_kudos row is gone');
    assert.equal(pool.state.notifications.length, 0, 'author notification cleaned up');

    const budget = await (await fetch(`${baseUrl}/api/me/kudos-budget`)).json();
    assert.equal(budget.given_this_week, 0);
    assert.equal(budget.remaining, 5);
  } finally {
    await close();
  }
});

test('DELETE kudos: 404 when the viewer has no kudos on the PR', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 999, status: 'merged', app_id: 1 }]],
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const r = await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'DELETE' });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.match(body.error, /no kudos to retract/i);
  } finally {
    await close();
  }
});

test('DELETE kudos: 404 when the session does not exist', async () => {
  const pool = makeMockPool({ sessions: [] });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const r = await fetch(`${baseUrl}/api/sessions/999/kudos`, { method: 'DELETE' });
    assert.equal(r.status, 404);
  } finally {
    await close();
  }
});

test('DELETE kudos: give → retract → give again succeeds (no 409)', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 999, status: 'merged', app_id: 1 }]],
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    assert.equal((await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'DELETE' })).status, 200);
    const again = await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'POST' });
    assert.equal(again.status, 200, 'UNIQUE row was deleted, so re-give is not a dupe');
  } finally {
    await close();
  }
});

test('DELETE kudos: quota refund lets a 6th give through after a retract', async () => {
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
      assert.equal((await fetch(`${baseUrl}/api/sessions/${i}/kudos`, { method: 'POST' })).status, 200);
    }
    assert.equal((await fetch(`${baseUrl}/api/sessions/15/kudos`, { method: 'POST' })).status, 429,
      'quota exhausted before the retract');
    const retract = await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'DELETE' });
    assert.equal(retract.status, 200);
    assert.equal((await retract.json()).remaining, 1);
    assert.equal((await fetch(`${baseUrl}/api/sessions/15/kudos`, { method: 'POST' })).status, 200,
      'freed slot is spendable on another PR');
  } finally {
    await close();
  }
});

test('DELETE kudos: retracting a previous-week kudos does not refund this week', async () => {
  const pool = makeMockPool({
    sessions: [
      [10, { id: 10, user_id: 999, status: 'merged', app_id: 1 }],
      [11, { id: 11, user_id: 999, status: 'merged', app_id: 1 }],
      [12, { id: 12, user_id: 999, status: 'merged', app_id: 1 }],
      [13, { id: 13, user_id: 999, status: 'merged', app_id: 1 }],
      [14, { id: 14, user_id: 999, status: 'merged', app_id: 1 }],
      [20, { id: 20, user_id: 999, status: 'merged', app_id: 1 }],
    ],
  });
  // A kudos given in the PRIOR week bucket, seeded directly.
  pool.state.kudos.push({
    id: 9000, session_id: 20, giver_user_id: 1,
    week_start: '2026-05-11', created_at: '2026-05-12T00:00:00.000Z',
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    // Exhaust the current week.
    for (let i = 10; i <= 14; i++) {
      assert.equal((await fetch(`${baseUrl}/api/sessions/${i}/kudos`, { method: 'POST' })).status, 200);
    }
    const retract = await fetch(`${baseUrl}/api/sessions/20/kudos`, { method: 'DELETE' });
    assert.equal(retract.status, 200, 'old-week kudos is still retractable');
    assert.equal((await retract.json()).remaining, 0,
      'expired-week slot does not come back to the current week');
    const budget = await (await fetch(`${baseUrl}/api/me/kudos-budget`)).json();
    assert.equal(budget.given_this_week, 5);
    assert.equal(budget.remaining, 0);
  } finally {
    await close();
  }
});

test('DELETE kudos: bounty-derived credit only (no pr_kudos row) → 404', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 999, status: 'merged', app_id: 1 }]],
  });
  // Viewer's bounty was awarded to this session — counts as my_kudos
  // credit, but there is no direct pr_kudos row to retract.
  pool.state.bounties.push({
    id: 500, app_id: 1, github_issue_number: 7, giver_user_id: 1,
    week_start: '2026-05-18', status: 'awarded',
    awarded_user_id: 999, awarded_session_id: 10,
    awarded_at: '2026-05-19T00:00:00.000Z',
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const r = await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'DELETE' });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.match(body.error, /no kudos to retract/i);
  } finally {
    await close();
  }
});

test('GET kudos: my_kudos_direct is true for a direct kudos, false for bounty-only credit', async () => {
  const pool = makeMockPool({
    sessions: [
      [10, { id: 10, user_id: 999, status: 'merged', app_id: 1 }],
      [11, { id: 11, user_id: 999, status: 'merged', app_id: 1 }],
    ],
  });
  pool.state.bounties.push({
    id: 500, app_id: 1, github_issue_number: 7, giver_user_id: 1,
    week_start: '2026-05-18', status: 'awarded',
    awarded_user_id: 999, awarded_session_id: 11,
    awarded_at: '2026-05-19T00:00:00.000Z',
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    assert.equal((await fetch(`${baseUrl}/api/sessions/10/kudos`, { method: 'POST' })).status, 200);

    const direct = await (await fetch(`${baseUrl}/api/sessions/10/kudos`)).json();
    assert.equal(direct.count, 1);
    assert.equal(direct.my_kudos, true);
    assert.equal(direct.my_kudos_direct, true, 'direct pr_kudos row → retractable');

    const bountyOnly = await (await fetch(`${baseUrl}/api/sessions/11/kudos`)).json();
    assert.equal(bountyOnly.count, 1);
    assert.equal(bountyOnly.my_kudos, true, 'awarded bounty still reads as the viewer’s credit');
    assert.equal(bountyOnly.my_kudos_direct, false, 'but it is not retractable');
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

// ─── 4. Issue-bounty self-award guard (resolveIssueBounty) ───────
//
// Regression coverage for the self-kudos loophole: a user could pledge a
// bounty on an open issue and then author the PR that closes it, awarding
// the bounty to themselves. resolveIssueBounty (extracted from votes.js
// checkAndMerge) must VOID the pledger's own bounty rather than award it,
// while still awarding everyone else's bounty on the same issue to the PR
// author. Mirrors the direct PR-kudos 403 self-kudos check.

// Minimal mock pool that faithfully implements the two UPDATE statements
// resolveIssueBounty issues, over an in-memory `bounties` array. Each bounty
// row: { id, app_id, github_issue_number, giver_user_id, status,
//        awarded_user_id, awarded_session_id }.
function makeBountyPool(bounties) {
  const state = { bounties };
  // a IS DISTINCT FROM b — NULL is a comparable value (NULL vs non-null is
  // distinct; NULL vs NULL is not).
  const distinct = (a, b) => (a === null || a === undefined ? b !== null && b !== undefined
    : b === null || b === undefined ? true : a !== b);
  async function query(sql, params = []) {
    const s = String(sql);
    // Combined weekly-allowance count (countWeeklyAllowanceUsed): pr_kudos
    // (none in this pool) + non-voided issue_bounties for the user/week. The
    // `status <> 'voided'` filter is what refunds a voided self-bounty.
    if (/FROM issue_bounties\s+WHERE giver_user_id = \$1 AND week_start = \$2/i.test(s)) {
      const [userId, weekStart] = params;
      const c = state.bounties.filter(
        (b) => b.giver_user_id === userId && b.week_start === weekStart
          && b.status !== 'voided'
      ).length;
      return { rows: [{ c }] };
    }
    // Award: status='awarded' WHERE ... AND giver_user_id IS DISTINCT FROM $2
    if (/UPDATE issue_bounties[\s\S]*status = 'awarded'[\s\S]*IS DISTINCT FROM/i.test(s)) {
      const [sessionId, awardeeUserId, appId, issueNumber] = params;
      const hit = state.bounties.filter((b) =>
        b.app_id === appId && b.github_issue_number === issueNumber &&
        b.status === 'open' && distinct(b.giver_user_id ?? null, awardeeUserId ?? null));
      for (const b of hit) {
        b.status = 'awarded';
        b.awarded_user_id = awardeeUserId ?? null;
        b.awarded_session_id = sessionId;
      }
      return { rows: hit.map((b) => ({ id: b.id })) };
    }
    // Void: status='voided' WHERE ... AND giver_user_id = $4
    if (/UPDATE issue_bounties[\s\S]*status = 'voided'/i.test(s)) {
      const [sessionId, appId, issueNumber, giverUserId] = params;
      const hit = state.bounties.filter((b) =>
        b.app_id === appId && b.github_issue_number === issueNumber &&
        b.status === 'open' && b.giver_user_id === giverUserId);
      for (const b of hit) {
        b.status = 'voided';
        b.awarded_session_id = sessionId;
        // awarded_user_id intentionally left untouched (stays null).
      }
      return { rows: hit.map((b) => ({ id: b.id })) };
    }
    throw new Error(`unhandled bounty mock SQL: ${s.slice(0, 60)}`);
  }
  return { query, state };
}

test('resolveIssueBounty: self-pledged bounty is voided, not awarded', async () => {
  const { resolveIssueBounty } = require('../src/routes/votes');
  // Author U (id 1) pledged bounty #100 on issue 7; another user (id 2) also
  // pledged #200 on the same issue. U authors the closing PR (session 50).
  const pool = makeBountyPool([
    { id: 100, app_id: 1, github_issue_number: 7, giver_user_id: 1, status: 'open', awarded_user_id: null, awarded_session_id: null },
    { id: 200, app_id: 1, github_issue_number: 7, giver_user_id: 2, status: 'open', awarded_user_id: null, awarded_session_id: null },
  ]);
  const { awarded, voided } = await resolveIssueBounty(pool, {
    appId: 1, sessionId: 50, awardeeUserId: 1, issueNumber: 7,
  });
  // Other user's bounty awards to U; U's own bounty voids.
  assert.deepEqual(awarded.map((r) => r.id), [200]);
  assert.deepEqual(voided.map((r) => r.id), [100]);
  const self = pool.state.bounties.find((b) => b.id === 100);
  const other = pool.state.bounties.find((b) => b.id === 200);
  assert.equal(self.status, 'voided');
  assert.equal(self.awarded_user_id, null, 'voided self-bounty earns no credit');
  assert.equal(self.awarded_session_id, 50, 'voided row records session for audit');
  assert.equal(other.status, 'awarded');
  assert.equal(other.awarded_user_id, 1, 'other pledger credits the PR author');
});

test('resolveIssueBounty: U gains no received-kudos credit from their own bounty', async () => {
  const { resolveIssueBounty } = require('../src/routes/votes');
  // Only a self-pledged bounty exists on the issue.
  const pool = makeBountyPool([
    { id: 100, app_id: 1, github_issue_number: 7, giver_user_id: 1, status: 'open', awarded_user_id: null, awarded_session_id: null },
  ]);
  const { awarded, voided } = await resolveIssueBounty(pool, {
    appId: 1, sessionId: 50, awardeeUserId: 1, issueNumber: 7,
  });
  assert.equal(awarded.length, 0, 'no award emitted (so no BOUNTY_AWARDED event / chat noise)');
  assert.equal(voided.length, 1);
  // Leaderboard credits via `awarded_user_id = u.id AND status = 'awarded'`;
  // a voided row matches neither, so U's kudos_received is unaffected.
  const credited = pool.state.bounties.filter(
    (b) => b.status === 'awarded' && b.awarded_user_id === 1
  );
  assert.equal(credited.length, 0);
});

test('resolveIssueBounty: deleted PR author (null awardee) still awards normally', async () => {
  const { resolveIssueBounty } = require('../src/routes/votes');
  const pool = makeBountyPool([
    { id: 100, app_id: 1, github_issue_number: 7, giver_user_id: 2, status: 'open', awarded_user_id: null, awarded_session_id: null },
  ]);
  const { awarded, voided } = await resolveIssueBounty(pool, {
    appId: 1, sessionId: 50, awardeeUserId: null, issueNumber: 7,
  });
  assert.deepEqual(awarded.map((r) => r.id), [100]);
  assert.equal(voided.length, 0, 'no void pass runs when there is no PR author');
  assert.equal(pool.state.bounties[0].status, 'awarded');
});

test('voiding a self-bounty refunds the weekly allowance slot', async () => {
  const { resolveIssueBounty } = require('../src/routes/votes');
  const { countWeeklyAllowanceUsed } = require('../src/routes/kudos');
  const week = '2026-05-18';
  // U (id 1) pledged a bounty on their own issue this week → 1 slot used.
  const pool = makeBountyPool([
    { id: 100, app_id: 1, github_issue_number: 7, giver_user_id: 1, week_start: week, status: 'open', awarded_user_id: null, awarded_session_id: null },
  ]);
  assert.equal(await countWeeklyAllowanceUsed(pool, 1, week), 1,
    'open self-bounty consumes a slot at pledge time');

  // U authors the PR that closes the issue → self-bounty is voided.
  const { voided } = await resolveIssueBounty(pool, {
    appId: 1, sessionId: 50, awardeeUserId: 1, issueNumber: 7,
  });
  assert.equal(voided.length, 1);

  // The slot is reclaimed: usage drops back to 0, free to spend elsewhere.
  assert.equal(await countWeeklyAllowanceUsed(pool, 1, week), 0,
    'voided self-bounty no longer counts against the weekly limit');
});

test('weekly allowance: a voided self-bounty refund does not leak to other users/weeks', async () => {
  const { countWeeklyAllowanceUsed } = require('../src/routes/kudos');
  const week = '2026-05-18';
  const pool = makeBountyPool([
    // U's voided self-bounty (refunded) ...
    { id: 100, app_id: 1, github_issue_number: 7, giver_user_id: 1, week_start: week, status: 'voided', awarded_user_id: null, awarded_session_id: 50 },
    // ... U's still-open bounty on another issue (counts) ...
    { id: 101, app_id: 1, github_issue_number: 8, giver_user_id: 1, week_start: week, status: 'open', awarded_user_id: null, awarded_session_id: null },
    // ... and another user's awarded bounty (counts toward THEIR limit).
    { id: 102, app_id: 1, github_issue_number: 9, giver_user_id: 2, week_start: week, status: 'awarded', awarded_user_id: 1, awarded_session_id: 60 },
  ]);
  assert.equal(await countWeeklyAllowanceUsed(pool, 1, week), 1,
    'U: only the still-open bounty counts; the voided one is refunded');
  assert.equal(await countWeeklyAllowanceUsed(pool, 2, week), 1,
    'other user: their awarded bounty still counts');
});
