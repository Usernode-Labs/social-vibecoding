// Tests for GET /api/leaderboard/users (src/routes/kudos.js) — specifically
// the `issues_created` per-user count added alongside the kudos/PR stats.
//
// issues_created counts rows in `issues` whose created_by is the user, on
// PUBLIC apps only, windowed by created_at when window=week. It's computed
// in its own LEFT JOIN LATERAL so it cannot cross-multiply the pr_kudos
// fan-out — this test guards that the kudos columns and the row ordering are
// unchanged by the presence of issues.
//
// Same harness style as tests/leaderboard-user-prs.test.js: kudosRoutes()
// mounted on a throwaway Express app, getPool() swapped for an in-memory
// mock that recognises the one leaderboard/users query and reproduces its
// filter semantics in JS over seeded state. The mock also records the SQL so
// the test can assert the public-app scoping predicate is present in the
// LATERAL itself.
//
// Run with: node --test tests/leaderboard-users-issues.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// ─── Module-cache pool/ws stubbing (same pattern as the sibling test) ───

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
  delete require.cache[require.resolve('../src/routes/kudos')];
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

// weekStartUtc() is exported by the route module — reuse it so the mock
// buckets issue created_at into the exact Monday-00:00-UTC week the handler
// compares against.
const { weekStartUtc } = require('../src/routes/kudos');

// ─── In-memory mock pool ─────────────────────────────────────────
//
// State shape:
//   users:    [{ id, username }]
//   sessions: [{ id, user_id, status, app_public }]
//   kudos:    [{ session_id, week_start }]   (direct pr_kudos, received-side)
//   issues:   [{ created_by, app_public, created_at }]
function makeMockPool(state) {
  const calls = [];

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    if (!/AS issues_created/i.test(s)) {
      throw new Error(`unhandled mock SQL: ${s.slice(0, 80)}`);
    }

    // Week mode is detectable from the kudos-window clause the handler only
    // emits for window=week; params[0] is then the weekStart date string.
    const isWeek = /pk\.week_start = \$1/.test(s);
    const weekStart = isWeek ? params[0] : null;

    const sessionsOf = (userId) =>
      state.sessions.filter((cs) => cs.user_id === userId && cs.app_public);

    const kudosOnSession = (sessionId) =>
      state.kudos.filter(
        (k) => k.session_id === sessionId &&
          (!isWeek || k.week_start === weekStart)
      );

    const rows = state.users.map((u) => {
      const sessions = sessionsOf(u.id);
      let kudosReceived = 0;
      let kudosMerged = 0;
      const kudosedSessions = new Set();
      for (const cs of sessions) {
        const ks = kudosOnSession(cs.id);
        kudosReceived += ks.length;
        if (ks.length) kudosedSessions.add(cs.id);
        if (cs.status === 'merged') kudosMerged += ks.length;
      }
      const prsMerged = sessions.filter((cs) => cs.status === 'merged').length;

      // issues_created: public-app issues by this user, windowed by week.
      const issuesCreated = state.issues.filter(
        (i) => i.created_by === u.id && i.app_public &&
          (!isWeek || weekStartUtc(new Date(i.created_at)) === weekStart)
      ).length;

      return {
        user_id: u.id,
        username: u.username,
        kudos_received: kudosReceived,
        prs_kudosed: kudosedSessions.size,
        kudos_received_prs_merged: kudosMerged,
        kudos_received_prs_unmerged: kudosReceived - kudosMerged,
        prs_merged: prsMerged,
        last_kudos_at: null,
        kudos_given: {},
        issues_created: issuesCreated,
      };
    });

    // Mirror the handler's ORDER BY: merged-kudos, then prs_merged, then
    // total kudos, then (last_kudos_at — null here) then username ASC.
    rows.sort((a, b) =>
      b.kudos_received_prs_merged - a.kudos_received_prs_merged ||
      b.prs_merged - a.prs_merged ||
      b.kudos_received - a.kudos_received ||
      a.username.localeCompare(b.username)
    );

    return { rows };
  }

  return { query, calls };
}

async function startTestServer(pool) {
  return withMockPool(pool, async () => {
    const { kudosRoutes } = require('../src/routes/kudos');
    const app = express();
    app.use(express.json());
    app.use(kudosRoutes({}));
    return new Promise((resolve) => {
      const server = app.listen(0, () => {
        const port = server.address().port;
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((r) => server.close(r)),
        });
      });
    });
  });
}

// alice and bob earn identical kudos (both: one merged PR with 2 kudos this
// week) so they tie on every ranking key and fall back to username ASC —
// the order must stay [alice, bob] no matter how many issues alice files.
// alice has filed issues, bob none.
function fixtureState() {
  const thisWeek = weekStartUtc();
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  // "Recent" must land inside the CURRENT UTC week for the window=week
  // assertions. A plain now-1d crosses the week boundary when the suite runs
  // on the week's first day (every Monday), so clamp to just after the week
  // start when yesterday would fall outside it.
  const weekStartMs = Date.parse(`${thisWeek}T00:00:00.000Z`);
  const recent = new Date(
    Math.max(Date.now() - 1 * 24 * 3600 * 1000, weekStartMs + 60 * 1000)
  ).toISOString();
  return {
    users: [{ id: 1, username: 'alice' }, { id: 2, username: 'bob' }],
    sessions: [
      { id: 10, user_id: 1, status: 'merged', app_public: true },
      { id: 20, user_id: 2, status: 'merged', app_public: true },
      // A private-app merged session for alice with kudos that must NOT
      // count (public-app scoping on the chat_sessions join).
      { id: 11, user_id: 1, status: 'merged', app_public: false },
    ],
    kudos: [
      { session_id: 10, week_start: thisWeek },
      { session_id: 10, week_start: thisWeek },
      { session_id: 20, week_start: thisWeek },
      { session_id: 20, week_start: thisWeek },
      { session_id: 11, week_start: thisWeek }, // private app — excluded
    ],
    issues: [
      { created_by: 1, app_public: true, created_at: recent }, // this week
      { created_by: 1, app_public: true, created_at: recent }, // this week
      { created_by: 1, app_public: true, created_at: old },    // older
      { created_by: 1, app_public: false, created_at: recent }, // private — excluded
      // bob files none
    ],
  };
}

// ─── Tests ───────────────────────────────────────────────────────

test('every row carries an integer issues_created', async () => {
  const pool = makeMockPool(fixtureState());
  const srv = await startTestServer(pool);
  try {
    const res = await fetch(`${srv.baseUrl}/api/leaderboard/users`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.items));
    for (const row of body.items) {
      assert.equal(typeof row.issues_created, 'number');
      assert.ok(Number.isInteger(row.issues_created));
    }
  } finally { await srv.close(); }
});

test('all-time counts public-app issues per user, excludes private-app issues', async () => {
  const pool = makeMockPool(fixtureState());
  const srv = await startTestServer(pool);
  try {
    const res = await fetch(`${srv.baseUrl}/api/leaderboard/users`);
    const body = await res.json();
    const alice = body.items.find((i) => i.username === 'alice');
    const bob = body.items.find((i) => i.username === 'bob');
    // 3 public (2 recent + 1 old); the private-app issue is excluded.
    assert.equal(alice.issues_created, 3);
    assert.equal(bob.issues_created, 0);
  } finally { await srv.close(); }
});

test('window=week counts only issues created in the current UTC week', async () => {
  const pool = makeMockPool(fixtureState());
  const srv = await startTestServer(pool);
  try {
    const res = await fetch(`${srv.baseUrl}/api/leaderboard/users?window=week`);
    const body = await res.json();
    assert.equal(body.window, 'week');
    const alice = body.items.find((i) => i.username === 'alice');
    // Only the 2 recent public issues fall in the current week; the old one
    // and the private one are excluded.
    assert.equal(alice.issues_created, 2);
  } finally { await srv.close(); }
});

test('issues do not change kudos columns or row ordering', async () => {
  const pool = makeMockPool(fixtureState());
  const srv = await startTestServer(pool);
  try {
    const res = await fetch(`${srv.baseUrl}/api/leaderboard/users`);
    const body = await res.json();
    // Tie on kudos → username ASC → alice first, bob second, despite alice
    // having 3 issues and bob 0 (no cross-multiplication of the kudos count).
    assert.deepEqual(body.items.map((i) => i.username), ['alice', 'bob']);
    const alice = body.items.find((i) => i.username === 'alice');
    const bob = body.items.find((i) => i.username === 'bob');
    // Private-app kudos (session 11) excluded → 2 each, not 3.
    assert.equal(alice.kudos_received, 2);
    assert.equal(alice.prs_kudosed, 1);
    assert.equal(alice.kudos_received_prs_merged, 2);
    assert.equal(bob.kudos_received, 2);
    assert.equal(bob.prs_kudosed, 1);
  } finally { await srv.close(); }
});

test('the issues_created LATERAL is scoped to public apps in the SQL itself', async () => {
  const pool = makeMockPool(fixtureState());
  const srv = await startTestServer(pool);
  try {
    await fetch(`${srv.baseUrl}/api/leaderboard/users`);
    const sql = pool.calls.find((c) => /AS issues_created/.test(c.sql)).sql;
    // Counts off issues.created_by, scoped to public apps like the other cols.
    assert.match(sql, /FROM issues i/);
    assert.match(sql, /i\.created_by = u\.id/);
    assert.match(sql, /ap\.id = i\.app_id AND ap\.view_visibility = 'public'/);
  } finally { await srv.close(); }
});
