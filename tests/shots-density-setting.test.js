'use strict';

// Before/after shots at the screen's own density (3x phone, 2x desktop) are
// experimental: off until an admin switches them on (services/shots-density.js,
// PUT /api/admin/shots/device-density). Off, a run takes every still at 1x
// exactly as before; a run reads the switch once as it starts.

const test = require('node:test');
const assert = require('node:assert/strict');

// One platform_settings table, in memory.
const settings = new Map();
const queries = [];
const pool = {
  async query(sql, params = []) {
    queries.push(sql);
    if (/^SELECT value FROM platform_settings WHERE key = \$1/.test(sql)) {
      return { rows: settings.has(params[0]) ? [{ value: settings.get(params[0]) }] : [] };
    }
    if (/^INSERT INTO platform_settings/.test(sql.trim())) { settings.set(params[0], 'on'); return { rows: [] }; }
    if (/^DELETE FROM platform_settings WHERE key = \$1/.test(sql)) { settings.delete(params[0]); return { rows: [] }; }
    return { rows: [] };
  },
};
const poolMod = require('../src/db/pool');
poolMod.getPool = () => pool;

const density = require('../src/services/shots-density');
const { adminRoutes } = require('../src/routes/admin');
const express = require('express');

test('off with no row, on only with "on", and never fails a run', async () => {
  density.invalidate();
  assert.equal(await density.enabled(pool), false);
  for (const value of ['true', '1', 'ON', '']) {
    settings.set(density.KEY, value);
    density.invalidate();
    assert.equal(await density.enabled(pool), false, value);
  }
  settings.set(density.KEY, 'on');
  density.invalidate();
  assert.equal(await density.enabled(pool), true);
  settings.delete(density.KEY);
  density.invalidate();
  const broken = { query: async () => { throw new Error('database down'); } };
  assert.equal(await density.enabledOrOff(broken), false, 'a setting that cannot be read is today\'s shots');
});

test('read through a short cache; a switch clears it at once', async () => {
  density.invalidate();
  queries.length = 0;
  await density.enabled(pool, { now: 1000 });
  await density.enabled(pool, { now: 1000 + density.CACHE_MS - 1 });
  assert.equal(queries.length, 1);
  await density.setEnabled(pool, true, 7);
  assert.equal(await density.enabled(pool), true);
  await density.setEnabled(pool, false, 7);
  assert.equal(await density.enabled(pool), false);
  assert.equal(settings.has(density.KEY), false, 'off removes the row');
});

test('a full admin switches it; a view-only admin may read it; nobody else reaches it', async (t) => {
  let who = null;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = who; next(); });
  app.use(adminRoutes({ jwtSecret: 'test' }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/admin/shots/device-density`;
  const put = (body) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
  density.invalidate();
  settings.delete(density.KEY);

  who = { id: 2, username: 'pat', isAdmin: false, canAdminWrite: false };
  const outsider = await put({ enabled: true });
  assert.ok(outsider.status === 302 || outsider.status === 403, String(outsider.status));
  who = { id: 3, username: 'viewer', isAdmin: true, canAdminWrite: false };
  assert.deepEqual(await (await fetch(url)).json(), { enabled: false });
  assert.equal((await put({ enabled: true })).status, 403);
  assert.equal(settings.has(density.KEY), false);

  who = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };
  for (const bad of [{}, { enabled: 'yes' }, { enabled: 1 }]) assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual(await (await put({ enabled: true })).json(), { enabled: true });
  assert.deepEqual(await (await fetch(url)).json(), { enabled: true });
  assert.deepEqual(await (await put({ enabled: false })).json(), { enabled: false });
  assert.equal(settings.has(density.KEY), false);
});
