// Tests for GET /api/leaderboard/users (src/routes/kudos.js) — the optional
// `fields` allowlist param and the `include_0_values` zero/null filter.
//
// `fields` projects each item down to the requested allowlisted fields (plus
// `username`, always); unknown names are silently ignored. `include_0_values=0`
// drops any field whose value is literally 0 or null (strict equality — an
// empty {} kudos_given map or a present timestamp is KEPT). Projection happens
// first, then zero/null filtering, and `username` is ALWAYS present.
//
// Same harness style as tests/leaderboard-users-issues.test.js: kudosRoutes()
// mounted on a throwaway Express app, getPool() swapped for an in-memory mock
// that recognises the one leaderboard/users query and returns canned rows. The
// shaping logic lives entirely in JS after the query, so the mock can return a
// fixed set of rows regardless of the params and let the handler shape them.
//
// Run with: node --test tests/leaderboard-users-fields.test.js

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

// The keys every unshaped row carries (matches the SELECT aliases).
const ALL_KEYS = [
  'user_id',
  'username',
  'kudos_received',
  'prs_kudosed',
  'kudos_received_prs_merged',
  'kudos_received_prs_unmerged',
  'prs_merged',
  'last_kudos_at',
  'kudos_given',
  'issues_created',
  'address',
  'active_apps',
];

// ─── In-memory mock pool ─────────────────────────────────────────
//
// The handler shapes rows in JS after the query, so the mock just returns a
// canned two-row result for the leaderboard/users query. Rows mirror the
// real column shape:
//   - alice: a rich row — every field non-zero, a present timestamp, a
//     non-empty kudos_given map, a linked `address`.
//   - bob:   a sparse row — issues_created = 0, last_kudos_at = null,
//     kudos_given = {} (empty map), address = null (unlinked wallet).
//     Exercises the zero/null drop rules.
// They tie on the ranking keys → username ASC keeps order [alice, bob]; the
// handler does no re-sorting, but we keep the order so the envelope/order
// assertions match the sibling test's expectations.
function makeMockPool() {
  const calls = [];
  const rows = [
    {
      user_id: 1,
      username: 'alice',
      kudos_received: 5,
      prs_kudosed: 2,
      kudos_received_prs_merged: 4,
      kudos_received_prs_unmerged: 1,
      prs_merged: 3,
      last_kudos_at: '2026-06-15T12:00:00.000Z',
      kudos_given: { '2026-06-15': 3 },
      issues_created: 5,
      address: 'ut1aliceaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      // Active on two apps — a populated array that must survive projection
      // and the zero/null drop (an array is neither 0 nor null).
      active_apps: [
        { slug: 'demo-app', name: 'Demo App' },
        { slug: 'second-app', name: 'Second App' },
      ],
    },
    {
      user_id: 2,
      username: 'bob',
      kudos_received: 0,
      prs_kudosed: 0,
      kudos_received_prs_merged: 0,
      kudos_received_prs_unmerged: 0,
      prs_merged: 0,
      last_kudos_at: null,
      kudos_given: {},
      issues_created: 0,
      address: null,
      // Active on nothing — empty array. Must be KEPT under include_0_values=0
      // (it's neither 0 nor null), mirroring the empty {} kudos_given map.
      active_apps: [],
    },
  ];

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });
    if (!/AS issues_created/i.test(s)) {
      throw new Error(`unhandled mock SQL: ${s.slice(0, 80)}`);
    }
    // Return clones so per-request shaping can't mutate the canned source.
    return { rows: rows.map((r) => ({ ...r })) };
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
      const server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((r) => server.close(r)),
        });
      });
    });
  });
}

function get(baseUrl, qs) {
  return fetch(`${baseUrl}/api/leaderboard/users${qs}`).then(async (res) => ({
    status: res.status,
    body: await res.json(),
  }));
}

// ─── fields ──────────────────────────────────────────────────────

test('no fields → items carry the full key set (unchanged)', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { status, body } = await get(srv.baseUrl, '');
    assert.equal(status, 200);
    for (const item of body.items) {
      assert.deepEqual(Object.keys(item).sort(), [...ALL_KEYS].sort());
    }
  } finally { await srv.close(); }
});

test('no fields → each item carries its wallet address (null when unlinked)', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '');
    const alice = body.items.find((i) => i.username === 'alice');
    const bob = body.items.find((i) => i.username === 'bob');
    assert.equal(alice.address, 'ut1aliceaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(bob.address, null);
  } finally { await srv.close(); }
});

test('fields=address → exactly username + address', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '?fields=address');
    const alice = body.items.find((i) => i.username === 'alice');
    assert.deepEqual(Object.keys(alice).sort(), ['address', 'username']);
    assert.equal(alice.address, 'ut1aliceaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  } finally { await srv.close(); }
});

test('fields=kudos_received → exactly username + kudos_received', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '?fields=kudos_received');
    const alice = body.items.find((i) => i.username === 'alice');
    assert.deepEqual(Object.keys(alice).sort(), ['kudos_received', 'username']);
    assert.equal(alice.kudos_received, 5);
  } finally { await srv.close(); }
});

test('fields with whitespace → trimmed; multiple fields kept', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '?fields=kudos_received, prs_merged');
    const alice = body.items.find((i) => i.username === 'alice');
    assert.deepEqual(
      Object.keys(alice).sort(),
      ['kudos_received', 'prs_merged', 'username']
    );
  } finally { await srv.close(); }
});

test('fields=bogus (all unknown) → only username', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '?fields=bogus');
    for (const item of body.items) {
      assert.deepEqual(Object.keys(item), ['username']);
    }
  } finally { await srv.close(); }
});

test('fields=kudos_received,bogus → unknown ignored, known kept', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '?fields=kudos_received,bogus');
    const alice = body.items.find((i) => i.username === 'alice');
    assert.deepEqual(Object.keys(alice).sort(), ['kudos_received', 'username']);
  } finally { await srv.close(); }
});

test('username always present even when not listed in fields', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '?fields=prs_merged');
    for (const item of body.items) {
      assert.ok('username' in item);
    }
  } finally { await srv.close(); }
});

test('empty token in fields list is dropped', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '?fields=kudos_received,,prs_merged');
    const alice = body.items.find((i) => i.username === 'alice');
    assert.deepEqual(
      Object.keys(alice).sort(),
      ['kudos_received', 'prs_merged', 'username']
    );
  } finally { await srv.close(); }
});

// ─── include_0_values ────────────────────────────────────────────

test('include_0_values=1 (and unset) → zero/null fields still present', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    for (const qs of ['', '?include_0_values=1']) {
      const { body } = await get(srv.baseUrl, qs);
      const bob = body.items.find((i) => i.username === 'bob');
      assert.equal(bob.issues_created, 0);
      assert.equal(bob.last_kudos_at, null);
      assert.ok('kudos_given' in bob);
    }
  } finally { await srv.close(); }
});

test('include_0_values=0 → zero/null keys dropped, non-zero kept', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '?include_0_values=0');
    const alice = body.items.find((i) => i.username === 'alice');
    const bob = body.items.find((i) => i.username === 'bob');
    // alice: every count non-zero → all kept; present timestamp kept.
    assert.deepEqual(Object.keys(alice).sort(), [...ALL_KEYS].sort());
    // bob: zero counts and null timestamp dropped; username + kudos_given ({})
    // survive. user_id is 2 (non-zero) so it stays too.
    assert.ok(!('issues_created' in bob));
    assert.ok(!('kudos_received' in bob));
    assert.ok(!('prs_merged' in bob));
    assert.ok(!('last_kudos_at' in bob));
    assert.ok('username' in bob);
  } finally { await srv.close(); }
});

test('include_0_values=0 → empty {} kudos_given is KEPT, null timestamp DROPPED', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '?include_0_values=0');
    const bob = body.items.find((i) => i.username === 'bob');
    assert.ok('kudos_given' in bob, 'empty {} map must survive (not 0/null)');
    assert.deepEqual(bob.kudos_given, {});
    assert.ok(!('last_kudos_at' in bob), 'null timestamp must be dropped');
  } finally { await srv.close(); }
});

test('include_0_values=0 → present timestamp is kept', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '?include_0_values=0');
    const alice = body.items.find((i) => i.username === 'alice');
    assert.equal(alice.last_kudos_at, '2026-06-15T12:00:00.000Z');
  } finally { await srv.close(); }
});

test('unrecognized include_0_values (2, true, empty) → treated as default 1', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    for (const qs of ['?include_0_values=2', '?include_0_values=true', '?include_0_values=']) {
      const { body } = await get(srv.baseUrl, qs);
      const bob = body.items.find((i) => i.username === 'bob');
      assert.ok('issues_created' in bob, `kept for ${qs}`);
      assert.equal(bob.issues_created, 0);
    }
  } finally { await srv.close(); }
});

// ─── combined ────────────────────────────────────────────────────

test('fields + include_0_values=0 → projection first, then drop empties', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(
      srv.baseUrl,
      '?fields=issues_created&include_0_values=0'
    );
    const alice = body.items.find((i) => i.username === 'alice');
    const bob = body.items.find((i) => i.username === 'bob');
    // alice issues_created=5 → kept alongside username.
    assert.deepEqual(Object.keys(alice).sort(), ['issues_created', 'username']);
    // bob issues_created=0 → dropped, leaving only username.
    assert.deepEqual(Object.keys(bob), ['username']);
  } finally { await srv.close(); }
});

test('envelope and order unaffected by fields/include_0_values', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(
      srv.baseUrl,
      '?fields=kudos_received&include_0_values=0&window=week'
    );
    assert.equal(body.window, 'week');
    assert.ok('weekStart' in body);
    assert.deepEqual(body.items.map((i) => i.username), ['alice', 'bob']);
  } finally { await srv.close(); }
});

// ─── active_apps ─────────────────────────────────────────────────

test('no fields → each item carries active_apps as an array of {slug, name}', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '');
    const alice = body.items.find((i) => i.username === 'alice');
    const bob = body.items.find((i) => i.username === 'bob');
    assert.ok(Array.isArray(alice.active_apps));
    assert.deepEqual(alice.active_apps, [
      { slug: 'demo-app', name: 'Demo App' },
      { slug: 'second-app', name: 'Second App' },
    ]);
    assert.deepEqual(bob.active_apps, []);
  } finally { await srv.close(); }
});

test('fields=active_apps → exactly username + active_apps', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '?fields=username,active_apps');
    const alice = body.items.find((i) => i.username === 'alice');
    assert.deepEqual(Object.keys(alice).sort(), ['active_apps', 'username']);
    assert.equal(alice.active_apps.length, 2);
  } finally { await srv.close(); }
});

test('fields without active_apps → active_apps omitted', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '?fields=username');
    for (const item of body.items) {
      assert.ok(!('active_apps' in item));
    }
  } finally { await srv.close(); }
});

test('include_0_values=0 → empty active_apps [] is KEPT (array is not 0/null)', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '?include_0_values=0');
    const alice = body.items.find((i) => i.username === 'alice');
    const bob = body.items.find((i) => i.username === 'bob');
    // Populated array survives, and the empty [] survives too.
    assert.equal(alice.active_apps.length, 2);
    assert.ok('active_apps' in bob, 'empty [] must survive (not 0/null)');
    assert.deepEqual(bob.active_apps, []);
  } finally { await srv.close(); }
});

test('fields=active_apps + include_0_values=0 → populated array survives unchanged', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(
      srv.baseUrl,
      '?fields=username,active_apps&include_0_values=0'
    );
    const alice = body.items.find((i) => i.username === 'alice');
    const bob = body.items.find((i) => i.username === 'bob');
    assert.deepEqual(Object.keys(alice).sort(), ['active_apps', 'username']);
    assert.deepEqual(alice.active_apps, [
      { slug: 'demo-app', name: 'Demo App' },
      { slug: 'second-app', name: 'Second App' },
    ]);
    // bob's empty array is kept under the projection too.
    assert.deepEqual(Object.keys(bob).sort(), ['active_apps', 'username']);
    assert.deepEqual(bob.active_apps, []);
  } finally { await srv.close(); }
});

// ─── active_apps: private-view apps are included (SQL-level) ─────────
//
// The active_apps LATERAL runs entirely in SQL, so — like the sibling
// issues.test.js — we assert against the query string the handler emits
// (the mock records every call in `pool.calls`). A user's own activity
// on a private-VIEW app is not private data about anyone else, so the
// LATERAL must NOT restrict on ap.view_visibility: a private-view app the
// user is active on should surface alongside public-view ones.

// Isolate the active_apps LATERAL from the SQL so per-branch assertions
// don't accidentally match the view_visibility='public' filters that
// legitimately live on the OTHER LATERALs (bounties / issues-created).
function activeAppsLateral(sql) {
  const m = /\)\s+AS active_apps\b/.exec(sql);
  assert.ok(m, 'active_apps LATERAL not found in SQL');
  // The LATERAL body runs from `FROM apps ap` up to its closing `) aa ON true`.
  const from = sql.indexOf('FROM apps ap', m.index);
  const end = sql.indexOf(') aa ON true', from);
  assert.ok(from !== -1 && end !== -1, 'active_apps LATERAL bounds not found');
  return sql.slice(from, end);
}

test('active_apps LATERAL does NOT filter on view_visibility (private-view apps included)', async () => {
  const pool = makeMockPool();
  const srv = await startTestServer(pool);
  try {
    await fetch(`${srv.baseUrl}/api/leaderboard/users`);
    const sql = pool.calls.find((c) => /AS active_apps/.test(c.sql)).sql;
    const lateral = activeAppsLateral(sql);
    // The public-view restriction must be gone from this LATERAL.
    assert.doesNotMatch(
      lateral,
      /view_visibility/,
      'active_apps LATERAL must not restrict on view_visibility'
    );
  } finally { await srv.close(); }
});

test('active_apps LATERAL keeps the activity guards (self_hosted, 10-day, ≥60s)', async () => {
  const pool = makeMockPool();
  const srv = await startTestServer(pool);
  try {
    await fetch(`${srv.baseUrl}/api/leaderboard/users`);
    const sql = pool.calls.find((c) => /AS active_apps/.test(c.sql)).sql;
    const lateral = activeAppsLateral(sql);
    // Self-hosted apps stay excluded.
    assert.match(lateral, /ap\.self_hosted = FALSE/);
    // Recency: visited within the last 10 days.
    assert.match(lateral, /r\.date >= CURRENT_DATE - 10/);
    // Sticky qualification: ever spent >= 60s in a day.
    assert.match(lateral, /q\.seconds_spent >= 60/);
  } finally { await srv.close(); }
});

// active_apps is a PURE ACTIVITY signal ("apps the user has tested"),
// deliberately decoupled from collab-eligibility (see the LATERAL comment in
// src/routes/kudos.js and the two-concept split in
// src/services/active-users.js). A user who spent >=60s/day on an app has
// tested it whether or not they're a member collaborator, so the LATERAL must
// NOT re-apply the collab-private membership gate — doing so hid collab-private
// apps (e.g. goalio) from their own testers. Eligibility stays a separate
// concern (vote-write layer + getActiveUserStats' vote-majority denominator).
test('active_apps LATERAL does NOT apply the collab-private membership gate', async () => {
  const pool = makeMockPool();
  const srv = await startTestServer(pool);
  try {
    await fetch(`${srv.baseUrl}/api/leaderboard/users`);
    const sql = pool.calls.find((c) => /AS active_apps/.test(c.sql)).sql;
    const lateral = activeAppsLateral(sql);
    assert.doesNotMatch(
      lateral,
      /collab_visibility/,
      'active_apps LATERAL must not gate on collab_visibility'
    );
    assert.doesNotMatch(
      lateral,
      /app_collaborators/,
      'active_apps LATERAL must not join app_collaborators'
    );
  } finally { await srv.close(); }
});
