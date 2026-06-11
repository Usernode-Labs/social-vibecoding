// Tests for PUT /api/favorites/order (src/routes/apps.js, issue #128).
//
// Route-handler tests following the tests/kudos.test.js pattern:
// appRoutes(config) is mounted onto a throwaway Express app with
// getPool() swapped for an in-memory mock whose query() does SQL
// pattern matching against the statements the handler issues. The
// reorder route runs inside a transaction (pool.connect() → BEGIN /
// COMMIT), so the mock also implements connect(), and every statement
// — including the client-scoped ones — lands in a shared `queries`
// log the assertions read.
//
// Covered paths:
//   - 400 on malformed body (missing / non-array / non-string entries
//     / over the 200-slug cap), with no SQL issued at all
//   - a valid PUT issues the NULL-reset plus the indexed ordinality
//     update inside one BEGIN/COMMIT, scoped to the caller's user id
//     only (another user's rows are untouched)
//   - non-favorited / unknown slugs in the body produce no update and
//     no error; favorites missing from the body fall back to NULL
//
// Run with: node --test tests/favorites-order.test.js
//
// No real Postgres needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Swap getPool() at the module level so appRoutes() receives the mock.
// Same require.cache surgery as kudos.test.js.
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
  // Force apps.js to re-resolve so it picks up the stubbed getPool.
  delete require.cache[require.resolve('../src/routes/apps')];
  try {
    return fn();
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[require.resolve('../src/routes/apps')];
  }
}

// In-memory mock pool. State:
//   apps:      Map slug → app_id
//   favorites: array of { app_id, user_id, sort_order }
// query() faithfully implements the two UPDATE statements the reorder
// handler issues; connect() hands out a client whose query() funnels
// into the same implementation, so transaction-scoped statements hit
// the same state and the same log.
function makeMockPool(initial = {}) {
  const state = {
    apps: new Map(initial.apps || []),
    favorites: (initial.favorites || []).map((f) => ({ sort_order: null, ...f })),
  };
  const queries = []; // every { sql, params } in execution order
  let connectCount = 0;
  let releaseCount = 0;

  async function query(sql, params = []) {
    const s = String(sql);
    queries.push({ sql: s, params });
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(s)) {
      return { rows: [] };
    }
    // ------------ NULL-reset of all of the caller's favorites ------------
    if (/UPDATE app_favorites SET sort_order = NULL WHERE user_id = \$1/i.test(s)) {
      const [userId] = params;
      for (const f of state.favorites) {
        if (f.user_id === userId) f.sort_order = null;
      }
      return { rows: [] };
    }
    // ------------ Indexed update via unnest WITH ORDINALITY ------------
    if (/UPDATE app_favorites f[\s\S]*WITH ORDINALITY/i.test(s)) {
      const [userId, order] = params;
      order.forEach((slug, idx) => {
        const appId = state.apps.get(slug);
        if (appId === undefined) return; // unknown slug — JOIN apps misses
        const fav = state.favorites.find(
          (f) => f.app_id === appId && f.user_id === userId
        );
        if (fav) fav.sort_order = idx; // non-favorited slug — WHERE misses
      });
      return { rows: [] };
    }
    throw new Error(`unhandled mock SQL: ${s.slice(0, 80)}`);
  }

  async function connect() {
    connectCount++;
    return {
      query,
      release: () => { releaseCount++; },
    };
  }

  return {
    query,
    connect,
    state,
    queries,
    counts: { get connects() { return connectCount; }, get releases() { return releaseCount; } },
  };
}

// Throwaway Express app with appRoutes mounted and req.user injected.
async function startTestServer(pool, user = { id: 1, username: 'alice' }) {
  return withMockPool(pool, async () => {
    const { appRoutes } = require('../src/routes/apps');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use(appRoutes({}));
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

function putOrder(baseUrl, body) {
  return fetch(`${baseUrl}/api/favorites/order`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── 400s for malformed bodies ────────────────────────────────────

test('PUT order: malformed bodies are rejected with 400 and no SQL runs', async () => {
  const pool = makeMockPool();
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const badBodies = [
      {},                                    // order missing
      { order: 'a,b,c' },                    // not an array
      { order: [1, 2] },                     // non-string entries
      { order: ['ok', null] },               // null entry
      { order: Array(201).fill('s') },       // over the 200-slug cap
    ];
    for (const body of badBodies) {
      const r = await putOrder(baseUrl, body);
      assert.equal(r.status, 400, `body ${JSON.stringify(body).slice(0, 40)} should 400`);
      const data = await r.json();
      assert.match(data.error, /order/i);
    }
    assert.equal(pool.queries.length, 0, 'validation failures must not touch the DB');
    assert.equal(pool.counts.connects, 0);
  } finally {
    await close();
  }
});

test('PUT order: exactly 200 slugs is accepted (cap is inclusive)', async () => {
  const pool = makeMockPool();
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const r = await putOrder(baseUrl, { order: Array(200).fill('nonexistent') });
    assert.equal(r.status, 200);
  } finally {
    await close();
  }
});

// ─── The happy path: transaction shape + per-user scoping ─────────

test('PUT order: NULL-reset + indexed updates inside one transaction, caller-scoped', async () => {
  const pool = makeMockPool({
    apps: [['app-a', 10], ['app-b', 11], ['app-c', 12]],
    favorites: [
      { app_id: 10, user_id: 1, sort_order: 2 },   // stale prior order
      { app_id: 11, user_id: 1, sort_order: 0 },
      { app_id: 12, user_id: 1, sort_order: 1 },
      { app_id: 10, user_id: 2, sort_order: 7 },   // another user — untouched
    ],
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const r = await putOrder(baseUrl, { order: ['app-b', 'app-a', 'app-c'] });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });

    // New order persisted: array index = sort_order.
    const byApp = (appId, userId) =>
      pool.state.favorites.find((f) => f.app_id === appId && f.user_id === userId);
    assert.equal(byApp(11, 1).sort_order, 0, 'app-b first');
    assert.equal(byApp(10, 1).sort_order, 1, 'app-a second');
    assert.equal(byApp(12, 1).sort_order, 2, 'app-c third');
    assert.equal(byApp(10, 2).sort_order, 7, "other user's row untouched");

    // Transaction shape: BEGIN → reset → ordinality update → COMMIT.
    const sqls = pool.queries.map((q) => q.sql.trim());
    assert.match(sqls[0], /^BEGIN$/i);
    assert.match(sqls[1], /UPDATE app_favorites SET sort_order = NULL WHERE user_id = \$1/i);
    assert.match(sqls[2], /WITH ORDINALITY/i);
    assert.match(sqls[3], /^COMMIT$/i);
    assert.equal(sqls.length, 4);
    // Both UPDATEs are scoped to the caller's user id only.
    assert.equal(pool.queries[1].params[0], 1);
    assert.equal(pool.queries[2].params[0], 1);
    assert.deepEqual(pool.queries[2].params[1], ['app-b', 'app-a', 'app-c']);
    assert.equal(pool.counts.releases, 1, 'client released after the transaction');
  } finally {
    await close();
  }
});

// ─── Stale-client tolerance ───────────────────────────────────────

test('PUT order: non-favorited and unknown slugs produce no update, no error', async () => {
  const pool = makeMockPool({
    apps: [['app-a', 10], ['app-b', 11]],   // app-b exists but is NOT favorited
    favorites: [{ app_id: 10, user_id: 1, sort_order: null }],
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const r = await putOrder(baseUrl, { order: ['no-such-app', 'app-b', 'app-a'] });
    assert.equal(r.status, 200, 'stale client list must not 400 the whole save');

    // Only the actually-favorited slug got an order — at its array
    // index (2), not a compacted one.
    const fav = pool.state.favorites.find((f) => f.app_id === 10 && f.user_id === 1);
    assert.equal(fav.sort_order, 2);
    // app-b exists but was never favorited → no row sprang into being.
    assert.equal(pool.state.favorites.length, 1);
  } finally {
    await close();
  }
});

test('PUT order: favorites missing from the body are reset to NULL (fall to the back)', async () => {
  const pool = makeMockPool({
    apps: [['app-a', 10], ['app-b', 11]],
    favorites: [
      { app_id: 10, user_id: 1, sort_order: 0 },
      { app_id: 11, user_id: 1, sort_order: 1 },
    ],
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const r = await putOrder(baseUrl, { order: ['app-b'] });
    assert.equal(r.status, 200);
    const byApp = (appId) =>
      pool.state.favorites.find((f) => f.app_id === appId && f.user_id === 1);
    assert.equal(byApp(11).sort_order, 0, 'mentioned favorite gets its index');
    assert.equal(byApp(10).sort_order, null, 'unmentioned favorite falls back to NULL');
  } finally {
    await close();
  }
});

test('PUT order: empty array resets every favorite to NULL', async () => {
  const pool = makeMockPool({
    apps: [['app-a', 10]],
    favorites: [{ app_id: 10, user_id: 1, sort_order: 0 }],
  });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const r = await putOrder(baseUrl, { order: [] });
    assert.equal(r.status, 200);
    assert.equal(pool.state.favorites[0].sort_order, null);
    // No ordinality UPDATE is issued for an empty list — just the reset.
    const sqls = pool.queries.map((q) => q.sql.trim());
    assert.equal(sqls.filter((s) => /WITH ORDINALITY/i.test(s)).length, 0);
    assert.match(sqls[sqls.length - 1], /^COMMIT$/i);
  } finally {
    await close();
  }
});

// ─── Failure path: rollback + 500 ─────────────────────────────────

test('PUT order: a mid-transaction error rolls back and returns 500', async () => {
  const pool = makeMockPool({
    apps: [['app-a', 10]],
    favorites: [{ app_id: 10, user_id: 1, sort_order: 0 }],
  });
  // Sabotage the ordinality UPDATE only.
  const realQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/WITH ORDINALITY/i.test(String(sql))) {
      pool.queries.push({ sql: String(sql), params });
      throw new Error('boom');
    }
    return realQuery(sql, params);
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const r = await putOrder(baseUrl, { order: ['app-a'] });
    assert.equal(r.status, 500);
    const sqls = pool.queries.map((q) => q.sql.trim());
    assert.match(sqls[sqls.length - 1], /^ROLLBACK$/i);
    assert.equal(sqls.filter((s) => /^COMMIT$/i.test(s)).length, 0);
  } finally {
    await close();
  }
});
