// /api/home-folders — folder CRUD for the home-screen grid
// (src/routes/home-layout.js).
//
// The contracts guarded here:
//
//   1. A FOLDER IS MADE BY FOLDING TWO VISIBLE APPS. POST takes exactly two
//      different visible slugs, memberships at positions 0 and 1, removes
//      both tiles from the canvas in EVERY width, and places the folder at
//      the dropped cell in the width it was dropped at.
//   2. AN APP LIVES IN ONE PLACE. Adding an app to a folder removes its
//      canvas rows; a canvas layout can never carry an app a folder owns.
//   3. NOTHING IS LOST ON REMOVAL. Deleting a folder keeps the apps (the
//      client's repair() re-places them); an emptied folder deletes itself.
//   4. ID SCOPING IS QUIET. Another user's folder id is 404, not 403 — not
//      a thing to know exists — and every write locks both widths first,
//      because a folder spans them.
//
// HTTP tests against a throwaway express app over a stateful
// substring-dispatching mock pool — the idiom of tests/home-layout-api.test.js.
//
// Run with: node --test tests/home-folders-api.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SCHEMA = read('src/db/schema.sql');
const ROUTE = read('src/routes/home-layout.js');

const USER = { id: 7, username: 'tester', isAdmin: false };
const OTHER = { id: 8, username: 'other', isAdmin: false };

const APPS = [
  { id: 101, slug: 'alpha' },
  { id: 102, slug: 'beta' },
  { id: 103, slug: 'gamma' },
];

function norm(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

// A small in-memory stand-in for the four tables the routes touch, enough
// for the assertions to read REAL post-conditions (the state the client
// would see on its next GET) rather than just call shapes.
function makeMockPool(state) {
  const calls = [];
  state.folderSeq = state.folderSeq || 0;
  const client = {
    async query(sql, params = []) {
      const q = norm(sql);
      calls.push({ sql: q, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(q) || q.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      if (q.includes('SELECT id FROM user_home_folders WHERE id = $1 AND user_id = $2')) {
        return {
          rows: (state.folders || []).filter(
            (f) => f.id === Number(params[0]) && f.user_id === params[1]).map((f) => ({ id: f.id })),
        };
      }
      if (q.includes('INSERT INTO user_home_folders')) {
        const id = ++state.folderSeq;
        (state.folders = state.folders || []).push({ id, user_id: params[0], name: 'New folder' });
        return { rows: [{ id }] };
      }
      if (q.includes('INSERT INTO user_home_folder_apps')) {
        const [folder_id, user_id, app_id, position] = params;
        (state.members = state.members || []).push({ folder_id, user_id, app_id, position });
        return { rows: [] };
      }
      if (q.includes('SELECT COALESCE(MAX(position)')) {
        const next = (state.members || [])
          .filter((m) => m.folder_id === Number(params[0]))
          .reduce((max, m) => Math.max(max, m.position), -1) + 1;
        return { rows: [{ next }] };
      }
      if (q.includes('DELETE FROM user_home_folder_apps')) {
        const folderId = Number(params[0]);
        const appId = APPS.find((a) => a.slug === params[1])?.id;
        const before = (state.members || []).length;
        state.members = (state.members || []).filter(
          (m) => !(m.folder_id === folderId && m.app_id === appId));
        return { rows: [], rowCount: before - state.members.length };
      }
      if (q.includes('DELETE FROM user_home_folders f WHERE f.id = $1')) {
        // Emulate NOT EXISTS: the folder goes only when it has no members.
        const folderId = Number(params[0]);
        const empty = !(state.members || []).some((m) => m.folder_id === folderId);
        state.folders = (state.folders || []).filter((f) => f.id !== folderId || !empty);
        // The FK cascade takes the folder's layout tiles with it.
        if (empty) {
          state.rows = (state.rows || []).filter((r) => r.folder_id !== folderId);
        }
        return { rows: [], rowCount: empty ? 1 : 0 };
      }
      if (q.includes('UPDATE user_home_folders')) {
        // UPDATE ... SET name = $3 ... WHERE id = $1 AND user_id = $2
        const folder = (state.folders || []).find(
          (f) => f.id === Number(params[0]) && f.user_id === params[1]);
        if (!folder) return { rows: [], rowCount: 0 };
        folder.name = params[2];
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM user_home_folders WHERE id = \$1 AND user_id = \$2/.test(q)) {
        const folderId = Number(params[0]);
        const had = (state.folders || []).some(
          (f) => f.id === folderId && f.user_id === params[1]);
        state.folders = (state.folders || []).filter(
          (f) => !(f.id === folderId && f.user_id === params[1]));
        state.members = (state.members || []).filter((m) => m.folder_id !== folderId);
        state.rows = (state.rows || []).filter((r) => r.folder_id !== folderId);
        return { rows: [], rowCount: had ? 1 : 0 };
      }
      if (q.includes('DELETE FROM user_home_layout WHERE user_id = $1 AND app_id = ANY($2)')) {
        const ids = new Set(params[1].map(Number));
        state.rows = (state.rows || []).filter(
          (r) => !(r.user_id === params[0] && ids.has(Number(r.app_id))));
        return { rows: [] };
      }
      if (q.includes('DELETE FROM user_home_layout WHERE user_id = $1 AND app_id = $2')) {
        state.rows = (state.rows || []).filter(
          (r) => !(r.user_id === params[0] && Number(r.app_id) === Number(params[1])));
        return { rows: [] };
      }
      if (q.includes("VALUES ($1, $2, 'folder'")) {
        // The fold's tile insert: the literals are inline, the params are
        // (user_id, cols, folder_id, grid_col, grid_row).
        const [user_id, cols, folder_id, grid_col, grid_row] = params;
        (state.rows = state.rows || []).push({
          user_id, cols, item_type: 'folder', app_id: null, widget_key: null,
          folder_id, grid_col, grid_row,
        });
        return { rows: [] };
      }
      if (q.includes('INSERT INTO user_home_layout')) {
        const [user_id, cols, item_type, app_id, widget_key, folder_id, grid_col, grid_row] = params;
        (state.rows = state.rows || []).push({
          user_id, cols, item_type, app_id, widget_key, folder_id, grid_col, grid_row,
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const slugOf = (id) => (state.apps || APPS).find((a) => a.id === Number(id))?.slug || null;
  const pool = {
    async connect() { return client; },
    async query(rawSql, params = []) {
      const q = norm(rawSql);
      calls.push({ sql: q, params });
      if (q.includes('FROM apps a')) {
        return { rows: (state.apps || APPS).map((a) => ({ id: a.id, slug: a.slug })) };
      }
      if (q.includes('FROM user_home_layout l')) {
        return {
          rows: (state.rows || [])
            .filter((r) => r.user_id === params[0])
            .map((r) => ({
              cols: r.cols, item_type: r.item_type, widget_key: r.widget_key,
              grid_col: r.grid_col, grid_row: r.grid_row, folder_id: r.folder_id ?? null,
              slug: slugOf(r.app_id),
            })),
        };
      }
      if (q.includes('FROM user_home_folders f')) {
        // readFolders joins memberships and app slugs; folderSets needs only
        // (folder id, app id) pairs.
        const folders = (state.folders || []).filter((f) => f.user_id === params[0]);
        if (q.includes('ORDER BY')) {
          const rows = [];
          for (const f of folders) {
            const members = (state.members || [])
              .filter((m) => m.folder_id === f.id)
              .sort((a, b) => a.position - b.position);
            if (!members.length) rows.push({ id: f.id, name: f.name, app_id: null, position: 0, slug: null });
            for (const m of members) {
              rows.push({ id: f.id, name: f.name, app_id: m.app_id, position: m.position, slug: slugOf(m.app_id) });
            }
          }
          return { rows };
        }
        return {
          rows: folders.flatMap((f) => {
            const members = (state.members || []).filter((m) => m.folder_id === f.id);
            return members.length
              ? members.map((m) => ({ id: f.id, app_id: m.app_id }))
              : [{ id: f.id, app_id: null }];
          }),
        };
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
const post = (app, url, payload) => req(app, 'POST', url, payload);
const patch = (app, url, payload) => req(app, 'PATCH', url, payload);
const del = (app, url) => req(app, 'DELETE', url);

const FOLD = (slugs, cols, col, row) => ({ slugs, cols, col, row });

// ── POST /api/home-folders ────────────────────────────────────────────

test('POST folds two visible apps into a new folder and clears their tiles', async () => {
  const { app, state } = makeApp({
    rows: [
      { user_id: USER.id, cols: 4, item_type: 'app', app_id: 101, widget_key: null, folder_id: null, grid_col: 0, grid_row: 0 },
      { user_id: USER.id, cols: 4, item_type: 'app', app_id: 102, widget_key: null, folder_id: null, grid_col: 1, grid_row: 0 },
      { user_id: USER.id, cols: 5, item_type: 'app', app_id: 101, widget_key: null, folder_id: null, grid_col: 2, grid_row: 0 },
      { user_id: USER.id, cols: 5, item_type: 'app', app_id: 103, widget_key: null, folder_id: null, grid_col: 3, grid_row: 0 },
    ],
  }, { user: USER });
  const { status, body } = await post(app, '/api/home-folders', FOLD(['alpha', 'beta'], 4, 0, 0));
  assert.equal(status, 201);
  // Memberships at positions 0 and 1, in drop order.
  assert.deepEqual(body.folders, [
    { id: 1, name: 'New folder', apps: ['alpha', 'beta'] },
  ]);
  // Both tiles left the canvas in EVERY width; the folder took the dropped
  // cell in the dropped width; gamma stays put.
  assert.deepEqual(body.layouts['4'], [
    { type: 'folder', id: 1, col: 0, row: 0 },
  ]);
  assert.deepEqual(body.layouts['5'], [
    { type: 'app', slug: 'gamma', col: 3, row: 0 },
  ]);
  assert.equal(state.folderSeq, 1);
});

test('POST refuses the same slug twice, an unknown app and a bad cell', async () => {
  const { app } = makeApp({}, { user: USER });
  assert.equal((await post(app, '/api/home-folders', FOLD(['alpha', 'alpha'], 4, 0, 0))).status, 400);
  assert.equal((await post(app, '/api/home-folders', FOLD(['alpha', 'ghost'], 4, 0, 0))).status, 400);
  assert.equal((await post(app, '/api/home-folders', FOLD(['alpha', 'beta'], 3, 0, 0))).status, 400,
    '3 is not one of the breakpoints');
  assert.equal((await post(app, '/api/home-folders', FOLD(['alpha', 'beta'], 4, 4, 0))).status, 400,
    'col 4 does not exist on a 4-wide canvas');
});

test('POST refuses an app that is already in a folder', async () => {
  const { app } = makeApp({
    folders: [{ id: 1, user_id: USER.id, name: 'New folder' }],
    members: [
      { folder_id: 1, user_id: USER.id, app_id: 101, position: 0 },
      { folder_id: 1, user_id: USER.id, app_id: 103, position: 1 },
    ],
  }, { user: USER });
  const res = await post(app, '/api/home-folders', FOLD(['alpha', 'beta'], 4, 0, 0));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'App is already in a folder');
});

// ── POST /:id/apps ────────────────────────────────────────────────────

test('adding an app appends it to the folder and clears its tile', async () => {
  const { app, state } = makeApp({
    folders: [{ id: 1, user_id: USER.id, name: 'New folder' }],
    members: [{ folder_id: 1, user_id: USER.id, app_id: 101, position: 0 }],
    rows: [
      { user_id: USER.id, cols: 4, item_type: 'app', app_id: 102, widget_key: null, folder_id: null, grid_col: 1, grid_row: 0 },
    ],
  }, { user: USER });
  const { status, body } = await post(app, '/api/home-folders/1/apps', { slug: 'beta' });
  assert.equal(status, 200);
  assert.deepEqual(body.folders, [
    { id: 1, name: 'New folder', apps: ['alpha', 'beta'] },
  ], 'appended after the existing member');
  assert.deepEqual(body.layouts['4'], [], 'the tile left the canvas');
  assert.deepEqual(state.members, [
    { folder_id: 1, user_id: USER.id, app_id: 101, position: 0 },
    { folder_id: 1, user_id: USER.id, app_id: 102, position: 1 },
  ]);
});

test('adding to another user\'s folder is 404, not 403', async () => {
  const { app } = makeApp({
    folders: [{ id: 1, user_id: OTHER.id, name: 'Not yours' }],
    members: [{ folder_id: 1, user_id: OTHER.id, app_id: 101, position: 0 }],
  }, { user: USER });
  const res = await post(app, '/api/home-folders/1/apps', { slug: 'beta' });
  assert.equal(res.status, 404);
});

// ── DELETE /:id/apps/:slug ────────────────────────────────────────────

test('taking the last app out deletes the folder with it', async () => {
  const { app, state } = makeApp({
    folders: [{ id: 1, user_id: USER.id, name: 'New folder' }],
    members: [
      { folder_id: 1, user_id: USER.id, app_id: 101, position: 0 },
      { folder_id: 1, user_id: USER.id, app_id: 102, position: 1 },
    ],
    rows: [
      { user_id: USER.id, cols: 4, item_type: 'folder', app_id: null, widget_key: null, folder_id: 1, grid_col: 0, grid_row: 0 },
    ],
  }, { user: USER });
  const { status, body } = await del(app, '/api/home-folders/1/apps/beta');
  assert.equal(status, 200);
  assert.deepEqual(body.folders, [{ id: 1, name: 'New folder', apps: ['alpha'] }]);
  const { status: s2, body: b2 } = await del(app, '/api/home-folders/1/apps/alpha');
  assert.equal(s2, 200);
  // The emptied folder is gone and its layout row with it; the client's
  // repair() re-places the app and the write persists from there.
  assert.deepEqual(b2.folders, []);
  assert.deepEqual(b2.layouts['4'], []);
  assert.equal((state.folders || []).length, 0);
});

// ── PATCH /:id ────────────────────────────────────────────────────────

test('PATCH renames a folder; a blank name falls back to the default', async () => {
  const { app, state } = makeApp({
    folders: [{ id: 1, user_id: USER.id, name: 'New folder' }],
  }, { user: USER });
  const { status, body } = await patch(app, '/api/home-folders/1', { name: '  Games  ' });
  assert.equal(status, 200);
  assert.deepEqual(body.folders, [{ id: 1, name: 'Games', apps: [] }]);
  assert.equal(state.folders[0].name, 'Games');
  const blank = await patch(app, '/api/home-folders/1', { name: '   ' });
  assert.equal(blank.body.folders[0].name, 'New folder', 'blank is the default, not a 400');
});

test('PATCH rejects a name over 40 characters and misses another user\'s folder', async () => {
  const { app } = makeApp({
    folders: [{ id: 1, user_id: OTHER.id, name: 'Not yours' }],
  }, { user: USER });
  const long = await patch(app, '/api/home-folders/1', { name: 'x'.repeat(41) });
  assert.equal(long.status, 400);
  const gone = await patch(app, '/api/home-folders/1', { name: 'Mine now' });
  assert.equal(gone.status, 404);
});

// ── DELETE /:id ───────────────────────────────────────────────────────

test('DELETE removes the folder and keeps the apps for re-placement', async () => {
  const { app, state } = makeApp({
    folders: [{ id: 1, user_id: USER.id, name: 'Games' }],
    members: [
      { folder_id: 1, user_id: USER.id, app_id: 101, position: 0 },
      { folder_id: 1, user_id: USER.id, app_id: 102, position: 1 },
    ],
    rows: [
      { user_id: USER.id, cols: 4, item_type: 'folder', app_id: null, widget_key: null, folder_id: 1, grid_col: 0, grid_row: 0 },
    ],
  }, { user: USER });
  const { status, body } = await del(app, '/api/home-folders/1');
  assert.equal(status, 200);
  assert.deepEqual(body.folders, []);
  assert.deepEqual(body.layouts['4'], [], 'the folder tile is gone');
  assert.deepEqual((state.members || []).length, 0, 'memberships cascade');
  assert.deepEqual((state.folders || []).length, 0);
  // The apps themselves were never deleted — alpha and beta are still
  // visible, so repair() finds them.
  const { body: after } = await get(app, '/api/home-layout');
  assert.ok(after.folders !== undefined);
  const missing = await del(app, '/api/home-folders/1');
  assert.equal(missing.status, 404);
});

// ── Auth ──────────────────────────────────────────────────────────────

test('every folder route is 401 unauthenticated', async () => {
  const { app } = makeApp({});
  assert.equal((await post(app, '/api/home-folders', FOLD(['alpha', 'beta'], 4, 0, 0))).status, 401);
  assert.equal((await post(app, '/api/home-folders/1/apps', { slug: 'beta' })).status, 401);
  assert.equal((await del(app, '/api/home-folders/1/apps/alpha')).status, 401);
  assert.equal((await patch(app, '/api/home-folders/1', { name: 'Games' })).status, 401);
  assert.equal((await del(app, '/api/home-folders/1')).status, 401);
});

// ── Source pins ───────────────────────────────────────────────────────

test('both widths are locked for every folder write', () => {
  const locks = [...ROUTE.matchAll(/await client\.query\(FOLDER_LOCKS_SQL/g)].length;
  const opens = [...ROUTE.matchAll(/router\.(post|patch|delete)\('\/api\/home-folders/g)].length;
  assert.equal(locks, opens, 'each folder route takes the pair of locks');
  assert.match(ROUTE, /hashtextextended\('home-layout:' \|\| \$1 \|\| ':4', 0\)/);
  assert.match(ROUTE, /hashtextextended\('home-layout:' \|\| \$1 \|\| ':5', 0\)/);
});

test('the folder tables key and clean up the way the routes assume', () => {
  // One membership per app per user — POST /:id/apps relies on it to mean
  // "this app is in exactly one folder".
  assert.match(SCHEMA, /UNIQUE \(user_id, app_id\)/);
  // Deleting a folder takes the memberships and the folder's layout tiles.
  assert.match(SCHEMA, /REFERENCES user_home_folders\(id\) ON DELETE CASCADE/);
  // The name cap lives in the table, so the PATCH cap cannot drift from it.
  assert.match(SCHEMA, /user_home_folder_name CHECK \(char_length\(name\) BETWEEN 1 AND 40\)/);
  // A folder appears at most once per stored width.
  assert.match(SCHEMA, /idx_user_home_layout_folder\s+ON user_home_layout\(user_id, cols, folder_id\)/);
});