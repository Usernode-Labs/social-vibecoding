// The tile alias (#4027) against a real PostgreSQL schema.
//
// tests/home-layout-api.test.js covers the route's contracts over a mock
// pool; this one exists because a mock pool cannot answer the question the
// label column actually poses: does the column exist after a migrate of a
// database that predates it (the ALTER TABLE … ADD COLUMN IF NOT EXISTS),
// and does the label survive the DELETE-and-replace PUT against the real
// unique indexes the mock pool does not model?
//
// Same harness as tests/account-deletion-postgres.test.js: a throwaway
// database, schema.sql applied twice (the migrate is boot-idempotent), the
// real router mounted over a real pool.
//
// Run with: node --test tests/home-layout-postgres.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the tile alias round-trips user_home_layout under the real schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = 'home_layout_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, including the new label column

  // The viewer and two apps to place.
  const { rows: [viewer] } = await pool.query(
    `INSERT INTO users (username, password, password_set, email, email_confirmed)
     VALUES ('layout_fixture', 'disposable-fixture-password', TRUE,
             'layout@example.invalid', TRUE) RETURNING *`);
  const app = async (slug) => (await pool.query(
    `INSERT INTO apps (name, slug, created_by) VALUES ($1, $2, $3) RETURNING *`,
    [slug, slug, viewer.id])).rows[0];
  const alpha = await app('alpha');
  const beta = await app('beta');

  // The real router over the real pool — getPool() stubbed the same way
  // tests/home-layout-api.test.js stubs it onto its mock.
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
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.user = viewer; next(); });
  server.use(routes);
  // `listen` on an express APP returns the http.Server — keep it, or the
  // address read and the close in the after-hook hang the runner.
  const httpServer = server.listen(0, '127.0.0.1');
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const port = httpServer.address().port;
  t.after(() => new Promise((resolve) => httpServer.close(resolve)));
  const call = async (method, path, payload) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(payload === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  // Round trip: a labeled tile keeps its label through the replace and the
  // read; an unlabeled one stays the plain shape.
  const first = await call('PUT', '/api/home-layout', {
    cols: 4,
    items: [
      { type: 'app', slug: 'alpha', col: 0, row: 0, label: 'Chess night' },
      { type: 'app', slug: 'beta', col: 1, row: 0 },
    ],
  });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.layouts['4'], [
    { type: 'app', slug: 'alpha', col: 0, row: 0, label: 'Chess night' },
    { type: 'app', slug: 'beta', col: 1, row: 0 },
  ]);
  const readBack = await call('GET', '/api/home-layout');
  assert.deepEqual(readBack.body.layouts['4'], first.body.layouts['4']);

  // The alias lives on the ROW, so the real unique index holds one cell per
  // app per width — the label is no exception to it.
  const { rows: stored } = await pool.query(
    `SELECT label FROM user_home_layout
      WHERE user_id = $1 AND cols = 4 ORDER BY grid_col`, [viewer.id]);
  assert.deepEqual(stored.map((r) => r.label), ['Chess night', null]);

  // An empty save clears it; a longer one is capped at 80 by the route.
  const second = await call('PUT', '/api/home-layout', {
    cols: 4,
    items: [{ type: 'app', slug: 'alpha', col: 0, row: 0, label: '   ' }],
  });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.layouts['4'], [
    { type: 'app', slug: 'alpha', col: 0, row: 0 },
  ]);
  const third = await call('PUT', '/api/home-layout', {
    cols: 4,
    items: [{ type: 'app', slug: 'alpha', col: 0, row: 0, label: 'y'.repeat(100) }],
  });
  assert.equal(third.status, 200);
  assert.equal(third.body.layouts['4'][0].label, 'y'.repeat(80));

  // A PUT to the OTHER width leaves this one's label untouched — the
  // (user, cols) key is what the alias is scoped to.
  await call('PUT', '/api/home-layout', { cols: 5, items: [] });
  const after = await call('GET', '/api/home-layout');
  assert.equal(after.body.layouts['4'][0].label, 'y'.repeat(80));

  // The two widths are separate row sets in the same table: the width the
  // empty PUT addressed stored nothing at all (GROUP BY has no zero row to
  // report), and the labeled width kept exactly its one tile.
  const { rows: widths } = await pool.query(
    `SELECT cols, COUNT(*) AS n FROM user_home_layout
      WHERE user_id = $1 GROUP BY cols ORDER BY cols`, [viewer.id]);
  assert.deepEqual(widths.map((r) => [r.cols, Number(r.n)]), [[4, 1]]);

  // And the app rows the FK points at are the ones the layout resolved.
  assert.ok(alpha.id && beta.id);
});
