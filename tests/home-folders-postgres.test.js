// The folder tables (user_home_folders / user_home_folder_items) and the
// folder routes (src/routes/home-layout.js) against the REAL schema in a
// throwaway PostgreSQL database: schema.sql applied twice (the boot
// migration is idempotent), then real creates, adds, renames, deletes and
// cascades. Same contract as tests/user-merge-postgres.test.js: skipped when
// no server is reachable, required when TEST_DATABASE_URL is set.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('home folders against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'home_folders_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);

  const userId = (await pool.query(
    `INSERT INTO users (username, password, has_platform_access)
     VALUES ('folder-owner', 'x', TRUE) RETURNING id`)).rows[0].id;
  const appIds = {};
  for (const slug of ['alpha', 'beta', 'gamma']) {
    appIds[slug] = (await pool.query(
      `INSERT INTO apps (slug, name, repo_url, view_visibility, status, created_by)
       VALUES ($1, $1, 'https://example.invalid', 'public', 'ready', $2) RETURNING id`,
      [slug, userId])).rows[0].id;
  }

  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  poolModule.getPool = () => pool;
  delete require.cache[require.resolve('../src/routes/home-layout')];
  const { homeLayoutRoutes } = require('../src/routes/home-layout');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: userId, isAdmin: false }; next(); });
  app.use(homeLayoutRoutes());

  async function req(method, url, payload) {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
        method,
        ...(payload === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    } finally { server.close(); }
  }

  const members = async () => (await pool.query(
    `SELECT a.slug, fi.sort_order FROM user_home_folder_items fi
       JOIN apps a ON a.id = fi.app_id ORDER BY fi.sort_order, a.slug`)).rows;
  const folderRows = async () => (await pool.query(
    'SELECT id, name FROM user_home_folders ORDER BY id')).rows;

  await t.test('create, membership order and rename round-trip', async () => {
    const created = await req('POST', '/api/home-layout/folders', { slugs: ['beta', 'alpha'] });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'New folder');
    assert.deepEqual(await members(), [
      { slug: 'beta', sort_order: 0 }, { slug: 'alpha', sort_order: 1 },
    ]);
    const renamed = await req('PUT', `/api/home-layout/folders/${created.body.id}`,
      { name: 'Game Corner' });
    assert.equal(renamed.status, 200);
    assert.deepEqual((await folderRows()).map((f) => f.name), ['Game Corner']);
  });

  await t.test('add appends at max(sort_order) + 1 and a re-add is a no-op', async () => {
    const rows = await folderRows();
    const added = await req('POST', `/api/home-layout/folders/${rows[0].id}/apps`,
      { slug: 'gamma' });
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.apps, ['beta', 'alpha', 'gamma']);
    const again = await req('POST', `/api/home-layout/folders/${rows[0].id}/apps`,
      { slug: 'gamma' });
    assert.equal(again.status, 200);
    assert.equal((await members()).length, 3, 'the unique pair backs the re-add');
  });

  await t.test('a folder tile is a layout row the CHECK admits, one per width', async () => {
    const rows = await folderRows();
    const folderId = rows[0].id;
    const put = await req('PUT', '/api/home-layout', {
      cols: 4,
      items: [
        { type: 'folder', id: folderId, col: 0, row: 0 },
        { type: 'app', slug: 'gamma', col: 1, row: 0 },
      ],
    });
    assert.equal(put.status, 200);
    const layout = (await pool.query(
      'SELECT item_type, app_id, widget_key, folder_id, grid_col, grid_row FROM user_home_layout ORDER BY item_type'))
      .rows;
    assert.deepEqual(layout, [
      { item_type: 'app', app_id: appIds.gamma, widget_key: null, folder_id: null, grid_col: 1, grid_row: 0 },
      { item_type: 'folder', app_id: null, widget_key: null, folder_id: folderId, grid_col: 0, grid_row: 0 },
    ]);
    // The widened CHECK refuses a row that is two kinds at once.
    await assert.rejects(
      pool.query(
        `INSERT INTO user_home_layout (user_id, cols, item_type, app_id, folder_id, grid_col, grid_row)
         VALUES ($1, 4, 'folder', $2, $3, 2, 0)`,
        [userId, appIds.alpha, folderId]),
      /user_home_layout_kind/);
    // And the partial unique index refuses two tiles for one folder at a width.
    await assert.rejects(
      pool.query(
        `INSERT INTO user_home_layout (user_id, cols, item_type, folder_id, grid_col, grid_row)
         VALUES ($1, 4, 'folder', $2, 3, 0)`,
        [userId, folderId]));
  });

  await t.test('deleting the folder cascades membership AND the layout position', async () => {
    const rows = await folderRows();
    const folderId = rows[0].id;
    const gone = await req('DELETE', `/api/home-layout/folders/${folderId}`);
    assert.equal(gone.status, 200);
    assert.deepEqual(await folderRows(), [], 'the folder row is gone');
    assert.deepEqual(await members(), [], 'membership cascaded');
    assert.deepEqual(
      (await pool.query('SELECT item_type FROM user_home_layout')).rows,
      [{ item_type: 'app' }], 'the app tile survives; the folder position cascaded');
  });

  await t.test('another viewer cannot read, rename or delete a foreign folder', async () => {
    const created = await req('POST', '/api/home-layout/folders', { slugs: ['alpha'] });
    const folderId = created.body.id;
    // Same routes, different viewer.
    const other = express();
    other.use(express.json());
    other.use((rq, _res, next) => { rq.user = { id: userId + 1, isAdmin: false }; next(); });
    other.use(homeLayoutRoutes());
    const hit = (method, u, payload) => {
      const server = other.listen(0);
      return new Promise((resolve) => server.once('listening', async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${server.address().port}${u}`, {
            method,
            ...(payload === undefined ? {} : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }),
          });
          resolve(res.status);
        } finally { server.close(); }
      }));
    };
    assert.equal(await hit('PUT', `/api/home-layout/folders/${folderId}`, { name: 'Mine' }), 404);
    assert.equal(await hit('DELETE', `/api/home-layout/folders/${folderId}`), 404);
    assert.equal(await hit('POST', `/api/home-layout/folders/${folderId}/apps`, { slug: 'alpha' }), 404);
    // And the foreign id is invisible on the other viewer's layout write,
    // not an error — the tile is dropped and nothing is stored.
    assert.equal(await hit('PUT', '/api/home-layout', {
      cols: 4, items: [{ type: 'folder', id: folderId, col: 0, row: 0 }],
    }), 200);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM user_home_layout WHERE item_type = \'folder\'')).rows[0].n, 0);
  });

  poolModule.getPool = originalGetPool;
});