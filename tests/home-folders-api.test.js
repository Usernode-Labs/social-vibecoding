// POST/PUT/DELETE /api/home-layout/folders — the folder CRUD side of app
// foldering (src/routes/home-layout.js), beside tests/home-layout-api.test.js
// which owns the layout write itself.
//
// The contracts guarded here:
//
//   1. A folder belongs to exactly one viewer (`user_id` on the row), and a
//      lookup that is not theirs is a 404 — not a 403, so another person's
//      folder id discloses nothing.
//   2. Membership validates against the SAME visibility predicate the grid
//      uses (visibleAppIds): a folder can never carry an app its owner
//      cannot see.
//   3. A re-add is a no-op (the (folder_id, app_id) unique pair backs it), a
//      member is appended at max(sort_order) + 1 — the add order — and an
//      unknown slug on remove is a harmless 200 because the end state is
//      already true.
//   4. The name defaults to 'New folder', is trimmed and capped at 60
//      characters; a rename requires a non-empty name.
//   5. Every route carries the same limiter and 401 guard as the layout PUT.
//
// HTTP tests against a throwaway express app over a substring-dispatching
// mock pool — the idiom of tests/home-layout-api.test.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const ROUTE = read('src/routes/home-layout.js');
const SERVER = read('server.js');
const LIMITS = read('src/middleware/rate-limits.js');

const USER = { id: 7, username: 'tester', isAdmin: false };
const OTHER = { id: 9, username: 'other', isAdmin: false };

const APPS = [
  { id: 101, slug: 'alpha' },
  { id: 102, slug: 'beta' },
  { id: 103, slug: 'gamma' },
];

// A small model of the folder tables, not an SQL engine: each branch matches
// one statement the routes issue, over state.folders / state.items /
// state.layoutRows. Membership writes go through the client inside a
// transaction, so every branch must live on client.query.
function makeMockPool(state) {
  const calls = [];
  const nextId = () => ++state.seq;
  const client = {
    async query(sql, params = []) {
      sql = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql, params });
      if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(sql)) return { rows: [] };
      if (/INSERT INTO user_home_folders/i.test(sql)) {
        const [user_id, name] = params;
        const row = { id: nextId(), user_id, name };
        (state.folders = state.folders || []).push(row);
        return { rows: [{ id: row.id, name: row.name }] };
      }
      if (/SELECT id, name FROM user_home_folders WHERE id = \$1 AND user_id = \$2/i.test(sql)) {
        const [id, userId] = params;
        const row = (state.folders || []).find(
          (f) => f.id === Number(id) && f.user_id === userId);
        return { rows: row ? [{ id: row.id, name: row.name }] : [] };
      }
      if (/UPDATE user_home_folders SET name/i.test(sql)) {
        const [id, name] = params;
        const row = (state.folders || []).find((f) => f.id === Number(id));
        if (row) row.name = name;
        return { rows: [] };
      }
      if (/DELETE FROM user_home_folders WHERE id/i.test(sql)) {
        const [id] = params;
        // The schema's ON DELETE CASCADE: membership and any layout position
        // row go away with the folder.
        state.folders = (state.folders || []).filter((f) => f.id !== Number(id));
        state.items = (state.items || []).filter((i) => i.folder_id !== Number(id));
        state.layoutRows = (state.layoutRows || []).filter(
          (r) => r.folder_id !== Number(id));
        return { rows: [] };
      }
      if (/INSERT INTO user_home_folder_items.*SELECT \$1, \$2, COALESCE\(MAX/i.test(sql)) {
        const [folderId, appId] = params;
        const items = state.items = state.items || [];
        if (items.some((i) => i.folder_id === folderId && i.app_id === appId)) {
          return { rows: [] }; // ON CONFLICT DO NOTHING
        }
        const order = items.filter((i) => i.folder_id === folderId)
          .reduce((max, i) => Math.max(max, i.sort_order), -1) + 1;
        items.push({ folder_id: folderId, app_id: appId, sort_order: order });
        return { rows: [] };
      }
      if (/INSERT INTO user_home_folder_items/i.test(sql)) {
        const [folder_id, app_id, sort_order] = params;
        (state.items = state.items || []).push({ folder_id, app_id, sort_order });
        return { rows: [] };
      }
      if (/SELECT fi.app_id FROM user_home_folder_items/i.test(sql)) {
        const [folderId, slug] = params;
        const item = (state.items || []).filter((i) => i.folder_id === folderId)
          .map((i) => ({ i, a: APPS.find((a) => a.id === i.app_id) }))
          .find((x) => x.a && x.a.slug === slug);
        return { rows: item ? [{ app_id: item.i.app_id }] : [] };
      }
      if (/SELECT a.slug FROM user_home_folder_items/i.test(sql)) {
        const [folderId] = params;
        const rows = (state.items || []).filter((i) => i.folder_id === folderId)
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((i) => APPS.find((a) => a.id === i.app_id))
          .filter(Boolean)
          .map((a) => ({ slug: a.slug }));
        return { rows };
      }
      if (/DELETE FROM user_home_folder_items WHERE folder_id = \$1 AND app_id = \$2/i.test(sql)) {
        const [folderId, appId] = params;
        state.items = (state.items || []).filter(
          (i) => !(i.folder_id === folderId && i.app_id === appId));
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
      if (/SELECT id FROM user_home_folders WHERE user_id = \$1/i.test(sql)) {
        return {
          rows: (state.folders || [])
            .filter((f) => f.user_id === params[0])
            .map((f) => ({ id: f.id })),
        };
      }
      return client.query(rawSql, params);
    },
  };
  return { pool, calls };
}

function makeApp(state = {}, { user = USER } = {}) {
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
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(routes);
  return { app, calls, state };
}

async function req(app, method, url, payload) {
  const server = app.listen(0);
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
const post = (app, url, payload) => req(app, 'POST', url, payload);
const put = (app, url, payload) => req(app, 'PUT', url, payload);
const del = (app, url) => req(app, 'DELETE', url);

// ── POST: create ──────────────────────────────────────────────────────

test('POST creates a folder for the dropped pair, in drop order', async () => {
  const { app, state } = makeApp();
  const { status, body } = await post(app, '/api/home-layout/folders',
    { slugs: ['alpha', 'beta'] });
  assert.equal(status, 201);
  assert.equal(body.name, 'New folder', 'no name given: the default');
  assert.deepEqual(body.apps, ['alpha', 'beta']);
  // Membership rows are written in drop order, sort_order 0..n-1.
  assert.deepEqual(state.items.map((i) => [i.app_id, i.sort_order]),
    [[101, 0], [102, 1]]);
  assert.equal(state.folders[0].user_id, USER.id, 'the folder belongs to this viewer');
});

test('POST trims the name, caps it at 60 characters and honours a given one', async () => {
  const { app } = makeApp();
  const { body } = await post(app, '/api/home-layout/folders',
    { slugs: ['alpha'], name: '  Game Corner  ' });
  assert.equal(body.name, 'Game Corner');
  const long = await post(app, '/api/home-layout/folders',
    { slugs: ['alpha'], name: 'x'.repeat(70) });
  assert.equal(long.body.name.length, 60);
  assert.equal(long.status, 201);
});

test('POST rejects an empty slug list and an app the viewer cannot see', async () => {
  const { app, state } = makeApp();
  assert.equal((await post(app, '/api/home-layout/folders', { slugs: [] })).status, 400);
  assert.equal((await post(app, '/api/home-layout/folders', {})).status, 400);
  assert.equal((await post(app, '/api/home-layout/folders',
    { slugs: ['alpha', 'not-visible'] })).status, 400);
  assert.equal(state.folders, undefined, 'a rejected create stores nothing');
});

// ── POST /:id/apps: membership ────────────────────────────────────────

test('POST /:id/apps appends and a re-add is a no-op', async () => {
  const { app, state } = makeApp();
  state.folders = [{ id: 5, user_id: USER.id, name: 'New folder' }];
  state.items = [{ folder_id: 5, app_id: 101, sort_order: 0 }];
  const first = await post(app, '/api/home-layout/folders/5/apps', { slug: 'beta' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.apps, ['alpha', 'beta'], 'appended at max(sort_order) + 1');
  const again = await post(app, '/api/home-layout/folders/5/apps', { slug: 'beta' });
  assert.equal(again.status, 200);
  assert.equal(state.items.length, 2, 'the unique pair backs the no-op');
  assert.equal(state.items[1].sort_order, 1, 'the sort order did not move');
});

test('POST /:id/apps is 400 on an invisible app and 404 on another viewer\'s folder', async () => {
  const { app } = makeApp();
  assert.equal((await post(app, '/api/home-layout/folders/5/apps',
    { slug: 'not-visible' })).status, 400);
  assert.equal((await post(app, '/api/home-layout/folders/5/apps',
    { slug: 'alpha' })).status, 404);
  assert.equal((await post(app, '/api/home-layout/folders/also-not-a-number/apps',
    { slug: 'alpha' })).status, 404);
});

// ── PUT: rename ───────────────────────────────────────────────────────

test('PUT renames and returns the membership', async () => {
  const { app, state } = makeApp();
  state.folders = [{ id: 5, user_id: USER.id, name: 'New folder' }];
  state.items = [{ folder_id: 5, app_id: 102, sort_order: 0 }];
  const { status, body } = await put(app, '/api/home-layout/folders/5',
    { name: 'Game Corner' });
  assert.equal(status, 200);
  assert.equal(body.id, 5);
  assert.equal(body.name, 'Game Corner');
  assert.deepEqual(body.apps, ['beta']);
  assert.equal(state.folders[0].name, 'Game Corner');
});

test('PUT requires a non-empty name', async () => {
  const { app } = makeApp();
  assert.equal((await put(app, '/api/home-layout/folders/5', { name: '   ' })).status, 400);
  assert.equal((await put(app, '/api/home-layout/folders/5', {})).status, 400);
});

test('PUT is 404 on another viewer\'s folder, even for an admin-shaped id', async () => {
  const { app, state } = makeApp({}, { user: OTHER });
  state.folders = [{ id: 5, user_id: USER.id, name: 'Mine' }];
  // The lookup is by (id, user_id): another viewer's id simply is not found.
  const { status } = await put(app, '/api/home-layout/folders/5', { name: 'Stolen' });
  assert.equal(status, 404);
  assert.equal(state.folders[0].name, 'Mine', 'nothing was renamed');
});

// ── DELETE: remove folder and remove member ───────────────────────────

test('DELETE removes the folder, its membership and its layout positions', async () => {
  const { app, state } = makeApp();
  state.folders = [{ id: 5, user_id: USER.id, name: 'New folder' }];
  state.items = [{ folder_id: 5, app_id: 101, sort_order: 0 }];
  state.layoutRows = [
    { user_id: USER.id, cols: 4, item_type: 'folder', folder_id: 5, app_id: null, widget_key: null, grid_col: 0, grid_row: 0 },
    { user_id: USER.id, cols: 4, item_type: 'app', app_id: 102, folder_id: null, widget_key: null, grid_col: 1, grid_row: 0 },
  ];
  const { status, body } = await del(app, '/api/home-layout/folders/5');
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(state.folders.length, 0);
  assert.equal(state.items.length, 0, 'membership cascades away');
  assert.equal(state.layoutRows.length, 1, 'the position cascades; the app tile stays');
  assert.equal(state.layoutRows[0].item_type, 'app');
});

test('DELETE is 404 on another viewer\'s folder and on a nonsense id', async () => {
  const { app, state } = makeApp();
  state.folders = [{ id: 5, user_id: USER.id, name: 'Mine' }];
  assert.equal((await del(app, '/api/home-layout/folders/999')).status, 404);
  assert.equal((await del(app, '/api/home-layout/folders/nope')).status, 404);
  assert.equal(state.folders.length, 1, 'nothing owned was deleted');
});

test('DELETE /:id/apps/:slug removes the member; an unknown slug is a harmless 200', async () => {
  const { app, state } = makeApp();
  state.folders = [{ id: 5, user_id: USER.id, name: 'New folder' }];
  state.items = [
    { folder_id: 5, app_id: 101, sort_order: 0 },
    { folder_id: 5, app_id: 102, sort_order: 1 },
  ];
  const gone = await del(app, '/api/home-layout/folders/5/apps/alpha');
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.body.apps, ['beta']);
  assert.equal((await del(app, '/api/home-layout/folders/5/apps/never-there')).status, 200);
  assert.equal(state.items.length, 1, 'the member that exists was still removed');
});

// ── Auth, wiring and schema pins ──────────────────────────────────────

test('folder routes are 401 unauthenticated', async () => {
  const { app } = makeApp({}, { user: null });
  // The mock middleware sets req.user = null, exercising the `!req.user?.id`
  // guard the routes answer 401 on.
  assert.equal((await post(app, '/api/home-layout/folders', { slugs: ['alpha'] })).status, 401);
  assert.equal((await put(app, '/api/home-layout/folders/5', { name: 'x' })).status, 401);
  assert.equal((await del(app, '/api/home-layout/folders/5')).status, 401);
  assert.equal((await post(app, '/api/home-layout/folders/5/apps', { slug: 'alpha' })).status, 401);
  assert.equal((await del(app, '/api/home-layout/folders/5/apps/alpha')).status, 401);
});

test('folder routes are mounted and share the layout limiter', () => {
  assert.match(SERVER, /homeLayoutRoutes\(config\)/);
  for (const line of [
    /router\.post\('\/api\/home-layout\/folders', homeLayoutLimiter/,
    /router\.put\('\/api\/home-layout\/folders\/:id', homeLayoutLimiter/,
    /router\.delete\('\/api\/home-layout\/folders\/:id', homeLayoutLimiter/,
    /router\.post\('\/api\/home-layout\/folders\/:id\/apps', homeLayoutLimiter/,
    /router\.delete\('\/api\/home-layout\/folders\/:id\/apps\/:slug', homeLayoutLimiter/,
  ]) {
    assert.match(ROUTE, line);
  }
  assert.match(LIMITS, /name: 'home-layout'[\s\S]*?}\)/);
});

test('membership validates against the same visibility predicate the grid uses', () => {
  // Both the create and the add resolve the slug through visibleAppIds — the
  // grid's own visibility query — so a folder can never carry an app its
  // owner cannot see.
  const uses = ROUTE.match(/const appIds = await visibleAppIds\(pool, req\.user\)/g) || [];
  assert.ok(uses.length >= 2, 'create and add both consult visibleAppIds');
});

test('schema: folders key on the owner, membership on a unique pair, both cascading', () => {
  const schema = read('src/db/schema.sql');
  const folders = schema.match(/CREATE TABLE IF NOT EXISTS user_home_folders[\s\S]*?\);/)[0];
  const items = schema.match(/CREATE TABLE IF NOT EXISTS user_home_folder_items[\s\S]*?\);/)[0];
  assert.match(folders, /user_id\s+INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(items, /folder_id\s+INTEGER NOT NULL REFERENCES user_home_folders\(id\) ON DELETE CASCADE/);
  assert.match(items, /app_id\s+INTEGER NOT NULL REFERENCES apps\(id\) ON DELETE CASCADE/);
  assert.match(items, /UNIQUE \(folder_id, app_id\)/);
  // The layout position row references the folder too, so a deleted folder
  // vacates its cell.
  assert.match(schema, /folder_id\s+INTEGER REFERENCES user_home_folders\(id\) ON DELETE CASCADE/);
  assert.match(schema, /idx_user_home_layout_folder[\s\S]*?WHERE folder_id IS NOT NULL/);
});