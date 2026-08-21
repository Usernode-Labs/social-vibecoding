// GET / PUT /api/home-layout — the write side of free-form home-screen
// placement (src/routes/home-layout.js).
//
// The contracts guarded here:
//
//   1. GEOMETRY IS STRICT, MEMBERSHIP IS LAX. Bad coordinates and
//      overlapping tiles are 400s (a client that can produce them is
//      broken); an app slug the viewer can no longer see is silently
//      DROPPED, because losing access to one app must not wedge the whole
//      home screen.
//   2. Overlap is checked SERVER-SIDE, so a patched client cannot persist a
//      self-overlapping layout.
//   3. WIDGET ITEMS ARE GONE, on both sides. THE UI OVERHAUL made Discover,
//      Challenges and Create app fixed sections below the grid rather than
//      draggable items on it, so the canvas holds app tiles alone: stored
//      widget rows are skipped on the way out, and a `type: 'widget'` entry
//      in a PUT — a tab left open across the deploy — is dropped rather than
//      failing that viewer's whole write.
//   4. A PUT is a full replace of ONE width, in a transaction, leaving the
//      other width untouched (that separation is the whole reason `cols` is
//      part of the key). Five columns is a LEGACY width the client only ever
//      reads now, as the seed for a first four-column visit.
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

test('GET describes the canvas and both widths', async () => {
  const { app } = makeApp({}, { user: USER });
  const { status, body } = await get(app, '/api/home-layout');
  assert.equal(status, 200);
  assert.equal(body.maxCols, 5);
  assert.equal(body.maxRows, 8);
  assert.deepEqual(body.breakpoints, [4, 5]);
  // The widget REGISTRY used to ride along, footprints and all, so the client
  // laid out against the same numbers the overlap check validated with. App
  // tiles are the only thing placed now and their footprint is 1x1 by
  // definition, so there is nothing to agree on.
  assert.equal(body.widgets, undefined);
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
  await put(app, '/api/home-layout', { cols: 5, items: [A('alpha', 2, 3), A('beta', 4, 4)] });
  const { body } = await get(app, '/api/home-layout');
  assert.deepEqual(body.layouts['5'], [
    { type: 'app', slug: 'alpha', col: 2, row: 3 },
    { type: 'app', slug: 'beta', col: 4, row: 4 },
  ]);
  assert.deepEqual(body.layouts['4'], [], 'the other width is untouched');
});

// A pre-overhaul arrangement carries cells for the three widgets. They are
// dropped on the way OUT rather than migrated away: the rows cost nothing
// where they are, and the client's HomeLayout.repair() has to reclaim their
// cells anyway, so an app dragged onto one after this ships lands cleanly.
test('GET skips the widget rows a pre-overhaul arrangement still carries', async () => {
  const { app, state } = makeApp({}, { user: USER });
  state.rows = [
    { user_id: USER.id, cols: 5, item_type: 'app', app_id: 101, widget_key: null, grid_col: 0, grid_row: 0 },
    { user_id: USER.id, cols: 5, item_type: 'widget', app_id: null, widget_key: 'challenges', grid_col: 3, grid_row: 1 },
    { user_id: USER.id, cols: 5, item_type: 'widget', app_id: null, widget_key: 'create', grid_col: 4, grid_row: 4 },
  ];
  const { body } = await get(app, '/api/home-layout');
  assert.deepEqual(body.layouts['5'], [
    { type: 'app', slug: 'alpha', col: 0, row: 0 },
  ], 'the app tile survives; the widget cells simply are not there');
});

// ── PUT: the happy path ───────────────────────────────────────────────

test('PUT stores exactly the cells it was given — holes and all', async () => {
  const { app, state } = makeApp({}, { user: USER });
  // A deliberately hole-bearing arrangement: nothing at (1,0), (2,0), (3,0).
  const items = [A('alpha', 0, 0), A('beta', 4, 0), A('gamma', 0, 1)];
  const { status, body } = await put(app, '/api/home-layout', { cols: 5, items });
  assert.equal(status, 200);
  assert.equal(state.rows.length, 3);
  assert.deepEqual(body.layouts['5'], [
    { type: 'app', slug: 'alpha', col: 0, row: 0 },
    { type: 'app', slug: 'beta', col: 4, row: 0 },
    { type: 'app', slug: 'gamma', col: 0, row: 1 },
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

test('PUT serializes concurrent replaces of the same (user, cols)', async () => {
  // Two racing PUTs — e.g. several freshly-opened tabs each persisting the
  // same layout repair on load (session 3193's checks run) — interleave the
  // delete-then-insert under READ COMMITTED: the second DELETE cannot see
  // the first's uncommitted inserts, and its own inserts then die on
  // idx_user_home_layout_*. The advisory lock makes them take turns.
  const { app, calls } = makeApp({}, { user: USER });
  await put(app, '/api/home-layout', { cols: 5, items: [A('alpha', 0, 0)] });
  const inTx = [];
  let open = false;
  for (const c of calls) {
    if (/^BEGIN/i.test(c.sql)) open = true;
    else if (/^(COMMIT|ROLLBACK)/i.test(c.sql)) open = false;
    else if (open) inTx.push(c);
  }
  assert.match(inTx[0].sql, /pg_advisory_xact_lock/,
    'the per-(user, cols) lock is the first statement inside the transaction');
  assert.deepEqual(inTx[0].params, [USER.id, 5], 'keyed on user AND width');
  assert.match(inTx[1].sql, /^DELETE FROM user_home_layout/,
    'nothing is deleted before the lock is held');
  // xact-scoped, so an early throw can never leak a held lock.
  assert.doesNotMatch(ROUTE, /pg_advisory_lock\(/);
});

// ── PUT: the create widget is never quota-gated ───────────────────────

// The regression guard for the retired "absent for non-creators" rule. The
// widget is on every home screen, so an account with no app quota must be
// able to place it exactly like anyone else.
// A `type: 'widget'` entry means a browser tab that was open across the
// deploy. Failing that viewer's whole layout write is a worse answer than
// ignoring three cells they can no longer see — so it is dropped, exactly as
// an app slug they cannot see is, and the rest of the arrangement lands.
test('PUT drops a stale widget item instead of failing the write', async () => {
  const { app, state } = makeApp({}, { user: USER });
  const { status, body } = await put(app, '/api/home-layout', {
    cols: 5,
    items: [A('alpha', 0, 0), W('create', 4, 4), W('challenges', 0, 1)],
  });
  assert.equal(status, 200);
  assert.equal(state.rows.length, 1, 'only the app tile is stored');
  assert.deepEqual(body.layouts['5'], [{ type: 'app', slug: 'alpha', col: 0, row: 0 }]);
  // An unknown key is dropped the same way — it used to be a 400, because
  // then it meant the client and the server disagreed about the registry.
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [W('not-a-widget', 0, 0)] })).status, 200);
  // Nothing anywhere in the route may consult app quota — not on the read,
  // not on the write, not in validation. The create block is on every home
  // screen regardless of quota, and always was.
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

// An app tile is 1x1, so the last column and the last row are both legal
// starts for one. This used to be the multi-cell WIDGET footprints' test —
// challenges at 2x2 could not start in column 4 of 5, or on row 7 of 8 — and
// the overhang check it exercises is the same one, now with the only
// footprint left.
test('PUT rejects a tile that runs off the canvas', async () => {
  const { app } = makeApp({}, { user: USER });
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [A('alpha', 4, 7)] })).status, 200, 'the last cell is a cell');
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [A('alpha', 5, 0)] })).status, 400);
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [A('alpha', 0, 8)] })).status, 400);
  // And column 4 is off the canvas at four columns, which is the width the
  // client writes now.
  assert.equal((await put(app, '/api/home-layout',
    { cols: 4, items: [A('alpha', 3, 7)] })).status, 200);
  assert.equal((await put(app, '/api/home-layout',
    { cols: 4, items: [A('alpha', 4, 0)] })).status, 400);
});

// Overlap is checked SERVER-side, so a patched client cannot persist a
// layout that overlaps.
test('PUT rejects overlapping tiles', async () => {
  const { app, state } = makeApp({}, { user: USER });
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [A('alpha', 0, 0), A('beta', 0, 0)] })).status, 400);
  assert.equal(state.rows, undefined, 'a rejected write stores nothing');
  // Adjacent, not overlapping, is fine.
  assert.equal((await put(app, '/api/home-layout',
    { cols: 5, items: [A('alpha', 0, 0), A('beta', 1, 0)] })).status, 200);
});

test('PUT rejects duplicate items and unknown item types', async () => {
  const { app } = makeApp({}, { user: USER });
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
test('the staging demo layout is hole-bearing, app-only and two rows deep', () => {
  const { demoLayouts } = require('../src/routes/home-layout');
  const demo = demoLayouts();
  for (const cols of ['4', '5']) {
    const items = demo[cols];
    assert.ok(items.length >= 6, `${cols}-column demo has content`);
    // APP TILES ONLY. The three widgets it used to place are fixed sections
    // below the grid now.
    assert.ok(items.every((i) => i.type === 'app'), `${cols}: no widget items`);
    // …and inside the two rows shown by default (HomeLayout.DEFAULT_ROWS), or
    // the demo would sit behind "Show all" — the opposite of a preview.
    assert.ok(items.every((i) => i.row < 2), `${cols}: within the default rows`);
    // The gaps ARE the feature: an arrangement no ordering can express.
    const row0 = items.filter((i) => i.row === 0);
    assert.ok(row0.length >= 2 && row0.length < 4,
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

test('staging home fixtures are slug-keyed and visible to capture viewers', () => {
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /seedStagingFailedApp\(pool, config\)/);
  assert.match(migrate, /seedStagingForkLineage\(pool, config\)/);
  assert.match(migrate, /ON CONFLICT \(slug\) DO UPDATE/,
    'fixture slugs, not collision-prone cloned ids, are the stable key');
  assert.match(migrate, /SELECT id, \$1, 2 FROM apps WHERE slug = 'staging-demo-failed-app'/);
  assert.match(migrate, /SELECT id, \$1, 1 FROM apps WHERE slug = 'staging-demo-fork'/);
  assert.match(migrate, /SELECT id, \$1, 0 FROM apps WHERE slug = 'staging-demo-chess-arena'/);
  assert.match(migrate, /SET hidden = FALSE, sort_order = EXCLUDED\.sort_order/,
    'a stale hidden preference cannot suppress a deterministic capture fixture');
});
