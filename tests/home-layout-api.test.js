// GET / PUT /api/home-layout — the write side of free-form home-screen
// placement (src/routes/home-layout.js).
//
// The contracts guarded here:
//
//   1. GEOMETRY IS STRICT, MEMBERSHIP IS LAX. Bad coordinates, unknown
//      widget keys and overlapping footprints are 400s (a client that can
//      produce them is broken); an app slug the viewer can no longer see is
//      silently DROPPED, because losing access to one app must not wedge
//      the whole home screen.
//   2. Overlap is checked against the SERVER's own footprints, so a patched
//      client cannot persist a self-overlapping layout.
//   3. `create` is accepted from ANY authenticated viewer. The widget is on
//      every home screen regardless of app quota, so a no-quota account's
//      drag must not 400 — this is the regression guard for the retired
//      "absent for non-creators" behaviour.
//   4. A PUT is a full replace of ONE width, in a transaction, leaving the
//      other width untouched (that separation is the whole reason `cols` is
//      part of the key).
//
// HTTP tests against a throwaway express app over a substring-dispatching
// mock pool — the idiom of tests/home-panels-api.test.js.
//
// Run with: node --test tests/home-layout-api.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SCHEMA = read('src/db/schema.sql');
const ROUTE = read('src/routes/home-layout.js');
const SERVER = read('server.js');
const LIMITS = read('src/middleware/rate-limits.js');

const USER = { id: 7, username: 'tester', isAdmin: false };

// Every app the fixture viewer can see. `staging-demo-*` names keep the
// stored rows obviously synthetic.
const APPS = [
  { id: 101, slug: 'alpha' },
  { id: 102, slug: 'beta' },
  { id: 103, slug: 'gamma' },
];

function makeMockPool(state) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/^\s*DELETE FROM user_home_layout/i.test(sql)) {
        const [userId, cols] = params;
        state.rows = (state.rows || []).filter(
          (r) => !(r.user_id === userId && r.cols === cols));
        return { rows: [] };
      }
      if (/INSERT INTO user_home_layout/i.test(sql)) {
        const [user_id, cols, item_type, app_id, widget_key, grid_col, grid_row] = params;
        (state.rows = state.rows || []).push({
          user_id, cols, item_type, app_id, widget_key, grid_col, grid_row,
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
    async query(rawSql, params = []) {
      const sql = String(rawSql).replace(/\s+/g, ' ').trim();
      calls.push({ sql, params });
      if (sql.includes('FROM apps a')) {
        return { rows: (state.apps || APPS).map((a) => ({ id: a.id, slug: a.slug })) };
      }
      if (sql.includes('FROM user_home_layout l')) {
        const rows = (state.rows || [])
          .filter((r) => r.user_id === params[0])
          .map((r) => ({
            cols: r.cols, item_type: r.item_type, widget_key: r.widget_key,
            grid_col: r.grid_col, grid_row: r.grid_row,
            slug: (state.apps || APPS).find((a) => a.id === r.app_id)?.slug || null,
          }));
        return { rows };
      }
      return client.query(rawSql, params);
    },
  };
  return { pool, calls };
}

function makeApp(state = {}, { user } = {}) {
  const { pool, calls } = makeMockPool(state);
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  poolModule.getPool = () => pool;
  let routes;
  try {
    delete require.cache[require.resolve('../src/routes/home-layout')];
    routes = require('../src/routes/home-layout').homeLayoutRoutes();
  } finally {
    poolModule.getPool = originalGetPool;
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use(routes);
  return { app, calls, state };
}

async function req(app, method, url, payload) {
  const server = app.listen(0);
  // The harness preload (tests/lib/test-net.js) pins hostless listens to
  // 127.0.0.1, which makes the bind complete on the next tick instead of
  // synchronously — so wait for it before reading the assigned port.
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      ...(payload === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    server.close();
  }
}
const get = (app, url) => req(app, 'GET', url);
const put = (app, url, payload) => req(app, 'PUT', url, payload);

const A = (slug, col, row) => ({ type: 'app', slug, col, row });
const W = (key, col, row) => ({ type: 'widget', key, col, row });

// ── GET ───────────────────────────────────────────────────────────────

test('GET describes the canvas, the widget registry and both widths', async () => {
  const { app } = makeApp({}, { user: USER });
  const { status, body } = await get(app, '/api/home-layout');
  assert.equal(status, 200);
  assert.equal(body.maxCols, 5);
  assert.equal(body.maxRows, 8);
  assert.deepEqual(body.breakpoints, [4, 5]);
  // Footprints ride along so the client lays out against the same numbers
  // the overlap check below validates with.
  assert.deepEqual(body.widgets.map((w) => w.key), ['challenges', 'discover', 'create']);
  // Create app is a full-width strip on a phone and a single tile on
  // desktop — the server's numbers, so a client that laid out otherwise
  // would fail the PUT's own overlap check.
  assert.deepEqual(body.widgets.find((w) => w.key === 'create').sizes, { 4: [4, 1], 5: [1, 1] });
  // A width with nothing stored is an EMPTY array, not an error: it means
  // "never dragged here", and the client derives that view itself.
  assert.deepEqual(body.layouts['4'], []);
  assert.deepEqual(body.layouts['5'], []);
});

test('GET is 401 unauthenticated', async () => {
  const { app } = makeApp({});
  assert.equal((await get(app, '/api/home-layout')).status, 401);
});

test('GET returns stored cells, per width, with slugs resolved', async () => {
  const { app } = makeApp({}, { user: USER });
  await put(app, '/api/home-layout', { cols: 5, items: [A('alpha', 2, 3), W('create', 4, 4)] });
  const { body } = await get(app, '/api/home-layout');
  assert.deepEqual(body.layouts['5'], [
    { type: 'app', slug: 'alpha', col: 2, row: 3 },
    { type: 'widget', key: 'create', col: 4, row: 4 },
  ]);
  assert.deepEqual(body.layouts['4'], [], 'the other width is untouched');
});

// ── PUT: the happy path ───────────────────────────────────────────────

test('PUT stores exactly the cells it was given — holes and all', async () => {
  const { app, state } = makeApp({}, { user: USER });
  // A deliberately hole-bearing arrangement: nothing at (1,0), (2,0), (3,0).
  const items = [A('alpha', 0, 0), A('beta', 4, 0), W('discover', 0, 1)];
  const { status, body } = await put(app, '/api/home-layout', { cols: 5, items });
  assert.equal(status, 200);
  assert.equal(state.rows.length, 3);
  assert.deepEqual(body.layouts['5'], [
    { type: 'app', slug: 'alpha', col: 0, row: 0 },
    { type: 'app', slug: 'beta', col: 4, row: 0 },
    { type: 'widget', key: 'discover', col: 0, row: 1 },
  ]);
});

test('PUT replaces one width and leaves the other alone', async () => {
  const { app, state } = makeApp({}, { user: USER });
  await put(app, '/api/home-layout', { cols: 5, items: [A('alpha', 0, 0)] });
  await put(app, '/api/home-layout', { cols: 4, items: [A('beta', 3, 7)] });
  assert.equal(state.rows.filter((r) => r.cols === 5).length, 1);
  assert.equal(state.rows.filter((r) => r.cols === 4).length, 1);

  // A second write to 5 is a FULL replace of that width only.
  await put(app, '/api/home-layout', { cols: 5, items: [A('gamma', 1, 1), A('alpha', 2, 2)] });
  assert.equal(state.rows.filter((r) => r.cols === 5).length, 2);
  assert.equal(state.rows.filter((r) => r.cols === 4).length, 1, '4 is untouched');
});

test('PUT writes the whole width in one transaction', async () => {
  const { app, calls } = makeApp({}, { user: USER });
  await put(app, '/api/home-layout', { cols: 5, items: [A('alpha', 0, 0), A('beta', 1, 0)] });
  const tx = calls.map((c) => c.sql).filter((s) => /^(BEGIN|COMMIT|ROLLBACK|DELETE|INSERT)/i.test(s));
  assert.equal(tx[0], 'BEGIN');
  assert.match(tx[1], /^DELETE FROM user_home_layout/);
  assert.equal(tx[tx.length - 1], 'COMMIT', 'a reader never sees a half-written width');
});

// ── PUT: the create widget is never quota-gated ───────────────────────

// The regression guard for the retired "absent for non-creators" rule. The
// widget is on every home screen, so an account with no app quota must be
// able to place it exactly like anyone else.
test('PUT accepts the create widget from any authenticated viewer', async () => {
  for (const user of [USER, { id: 9, username: 'noquota', isAdmin: false }]) {
    const { app } = makeApp({}, { user });
    const { status, body } = await put(app, '/api/home-layout',
      { cols: 5, items: [W('create', 4, 4)] });
    assert.equal(status, 200, user.username);
    assert.deepEqual(body.layouts['5'], [{ type: 'widget', key: 'create', col: 4, row: 4 }]);
  }
  // Nothing anywhere in the route may consult quota — not on the read, not
  // on the write, not in validation.
  assert.doesNotMatch(ROUTE.replace(/^\s*\/\/.*$/gm, ''), /canCreateApps|app_quota/);
});

// ── PUT: validation ───────────────────────────────────────────────────

test('PUT rejects an unknown column count', async () => {
  const { app } = makeApp({}, { user: USER });
  for (const cols of [3, 6, 0, 'five', undefined]) {
    const { status } = await put(app, '/api/home-layout', { cols, items: [] });
    assert.equal(status, 400, String(cols));
  }
});

test('PUT rejects out-of-range coordinates', async () => {
  const { app } = makeApp({}, { user: USER });
  const bad = [
    A('alpha', -1, 0), A('alpha', 5, 0), A('alpha', 0, -1), A('alpha', 0, 8),
    A('alpha', 1.5, 0), A('alpha', 0, 'x'),
  ];
  for (const item of bad) {
    const { status } = await put(app, '/api/home-layout', { cols: 5, items: [item] });
    assert.equal(status, 400, JSON.stringify(item));
  }
  // Column 4 is legal at 5 columns but not at 4.
  assert.equal((await put(app, '/api/home-layout', { cols: 5, items: [A('alpha', 4, 0)] })).status, 200);
  assert.equal((await put(app, '/api/home-layout', { cols: 4, items: [A('alpha', 4, 0)] })).status, 400);
});

test('PUT rejects a footprint that runs off the canvas', async () => {
  const { app } = makeApp({}, { user: USER });
  // Challenges is 2x2 at five columns: column 4 leaves it one short.
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [W('challenges', 4, 0)] })).status, 400);
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [W('challenges', 3, 0)] })).status, 200);
  // ...and the HEIGHT overhang is checked the same way: 2x2 on row 7 needs a
  // ninth row the canvas does not have.
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [W('challenges', 3, 7)] })).status, 400);
  // At four columns challenges is 4x1 (#968), so column 0 is the only column
  // it can start in — and the LAST row is now a legal home for it, which the
  // two-row footprint's own last row never was.
  assert.equal((await put(app, '/api/home-layout',
    { cols: 4, items: [W('challenges', 1, 0)] })).status, 400);
  assert.equal((await put(app, '/api/home-layout',
    { cols: 4, items: [W('challenges', 0, 7)] })).status, 200);
});

// The server checks overlap against ITS OWN footprints, so a patched client
// claiming a widget is 1x1 still cannot persist a layout that overlaps.
test('PUT rejects overlapping footprints', async () => {
  const { app, state } = makeApp({}, { user: USER });
  // Two tiles in the same cell.
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [A('alpha', 0, 0), A('beta', 0, 0)] })).status, 400);
  // A tile inside a 2x2 widget's footprint — invisible unless the server
  // knows how big the widget is.
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [W('challenges', 0, 0), A('alpha', 1, 1)] })).status, 400);
  // Two widgets sharing one cell of their footprints.
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [W('challenges', 0, 0), W('discover', 1, 1)] })).status, 400);
  assert.equal(state.rows, undefined, 'a rejected write stores nothing');
  // Adjacent, not overlapping, is fine.
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [W('challenges', 0, 0), W('discover', 2, 0)] })).status, 200);
});

test('PUT rejects unknown widgets and duplicate items', async () => {
  const { app } = makeApp({}, { user: USER });
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [W('not-a-widget', 0, 0)] })).status, 400);
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [W('create', 0, 0), W('create', 1, 0)] })).status, 400);
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [A('alpha', 0, 0), A('alpha', 1, 0)] })).status, 400);
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [{ type: 'mystery', col: 0, row: 0 }] })).status, 400);
  assert.equal((await put(app, '/api/home-layout', { cols: 5, items: 'nope' })).status, 400);
});

// Losing access to ONE app must not wedge the whole home screen, so an
// unresolvable slug is dropped rather than failing the write.
test('PUT silently drops an app the viewer cannot see', async () => {
  const { app, state } = makeApp({}, { user: USER });
  const { status, body } = await put(app, '/api/home-layout', {
    cols: 5,
    items: [A('alpha', 0, 0), A('deleted-or-private', 1, 0), A('beta', 2, 0)],
  });
  assert.equal(status, 200);
  assert.equal(state.rows.length, 2);
  assert.deepEqual(body.layouts['5'].map((i) => i.slug), ['alpha', 'beta']);
});

test('PUT caps the item count', async () => {
  const { app } = makeApp({}, { user: USER });
  const items = Array.from({ length: 200 }, (_, i) => A('alpha', i % 5, i % 8));
  assert.equal((await put(app, '/api/home-layout', { cols: 5, items })).status, 400);
});

test('PUT is 401 unauthenticated', async () => {
  const { app } = makeApp({});
  assert.equal((await put(app, '/api/home-layout', { cols: 5, items: [] })).status, 401);
});

// ── Staging demo ──────────────────────────────────────────────────────

// user_home_layout is created by this change, so a staging clone starts
// empty and every preview would show the DERIVED default — i.e. exactly
// today's arrangement, with the feature invisible.
test('the staging demo layout is hole-bearing and includes the create widget', () => {
  const { demoLayouts } = require('../src/routes/home-layout');
  const demo = demoLayouts();
  for (const cols of ['4', '5']) {
    const items = demo[cols];
    assert.ok(items.length >= 6, `${cols}-column demo has content`);
    assert.ok(items.some((i) => i.key === 'create'),
      'the create widget is present unconditionally, matching the always-on rule');
    // The gaps ARE the feature: an arrangement no ordering can express.
    const row0 = items.filter((i) => i.row === 0);
    assert.ok(row0.length >= 2 && row0.length < Number(cols),
      `${cols}: row 0 has visible holes`);
  }
  // It is read-only and strictly staging-gated.
  assert.match(ROUTE, /IS_STAGING && req\.query\.demo === '1'/);
  assert.match(ROUTE, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging'/);
});

// ── Source pins ───────────────────────────────────────────────────────

test('the route is mounted and rate limited per user', () => {
  assert.match(SERVER, /homeLayoutRoutes\(config\)/);
  assert.match(ROUTE, /put\('\/api\/home-layout', homeLayoutLimiter/);
  // A drag is bursty — tidying a home screen easily lands twenty drops in a
  // minute — so the ceiling is well above the panel-pref limiter's.
  assert.match(LIMITS, /name: 'home-layout'[\s\S]*?}\)/);
  const limiter = LIMITS.match(/const homeLayoutLimiter = makeLimiter\(\{[\s\S]*?\}\);/)[0];
  assert.match(limiter, /keyByUser: true/);
  assert.match(limiter, /max: 120/);
});

test('schema keys the layout by (user, width) with a cascading app FK', () => {
  const block = SCHEMA.slice(
    SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS user_home_layout'),
    SCHEMA.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_home_layout_app'));
  // The FK is the whole reason this is a table and not a JSONB column: a
  // deleted app vacates its cell without anyone filtering dead ids.
  assert.match(block, /app_id\s+INTEGER REFERENCES apps\(id\) ON DELETE CASCADE/);
  assert.match(block, /user_id\s+INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  // Exactly one of app_id / widget_key on any row.
  assert.match(block, /CONSTRAINT user_home_layout_kind CHECK/);
  assert.match(block, /CONSTRAINT user_home_layout_cols CHECK \(cols IN \(4, 5\)\)/);
  assert.match(block, /CONSTRAINT user_home_layout_col CHECK \(grid_col >= 0 AND grid_col < cols\)/);
  assert.match(block, /CONSTRAINT user_home_layout_row CHECK \(grid_row >= 0 AND grid_row < 8\)/);
  // One cell per item per width.
  assert.match(SCHEMA, /idx_user_home_layout_app[\s\S]*?WHERE app_id IS NOT NULL/);
  assert.match(SCHEMA, /idx_user_home_layout_widget[\s\S]*?WHERE widget_key IS NOT NULL/);
});

test('staging seeds a layout for every capture identity', () => {
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /async function seedStagingHomeLayout/);
  assert.match(migrate, /await seedStagingHomeLayout\(pool, config\)/);
  const seed = migrate.match(/async function seedStagingHomeLayout[\s\S]*?\n\}/)[0];
  assert.match(seed, /USERNODE_ENV !== 'staging'/, 'a strict no-op outside staging');
  assert.match(seed, /usernode-capture', 'usernode-capture-admin'/);
  assert.match(seed, /widget:create/, 'the create widget is seeded unconditionally');
  // Idempotent: a rebuild must not clobber a reviewer's own drags.
  assert.match(seed, /SELECT 1 FROM user_home_layout WHERE user_id = \$1 LIMIT 1/);
  assert.match(seed, /ON CONFLICT DO NOTHING/);
});

test('staging home fixtures use distinct app ids and are visible to capture viewers', () => {
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /VALUES \(900044, 'Staging demo failed app'/);
  assert.match(migrate, /\(900040, 'Staging demo Chess Arena'/);
  assert.match(migrate, /seedStagingFailedApp\(pool, config\)/);
  assert.match(migrate, /seedStagingForkLineage\(pool, config\)/);
  assert.match(migrate, /SELECT id, \$1, 2 FROM apps WHERE slug = 'staging-demo-failed-app'/);
  assert.match(migrate, /VALUES \(900031, \$1, 1\)/);
});
