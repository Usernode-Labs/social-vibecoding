'use strict';

// #5634: the Compliance report against the full PostgreSQL schema, through
// its routes: every admin reads it, only a full admin saves a status or
// scans; a status saved with no note keeps the note; a scan keeps each
// check's result, the database checks find what is really there, and an
// item a scan fails on is listed first without its status changing.
// TEST_DATABASE_URL selects a local test database, like the other
// *-postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');

// No workflow runtime here: Scan now finds the clock unarmed, as on a
// staging preview, and scans on the spot.
const clocks = require('../src/services/clocks');
clocks.status = async () => null;
clocks.runNow = async () => { throw Object.assign(new Error('not armed'), { code: 'not_armed' }); };

const { adminRoutes } = require('../src/routes/admin');

const FULL = { id: 1, username: 'comp-full', isAdmin: true, canAdminWrite: true, adminReadonly: false };
const VIEW = { id: 2, username: 'comp-view', isAdmin: true, canAdminWrite: false, adminReadonly: true };

test('the compliance report reads, saves statuses and keeps scans', { timeout: 120000 }, async (t) => {
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
  }
  const name = 'compliance_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const dbUrl = String(url);
  const routePool = require('../src/db/pool').getPool({ databaseUrl: dbUrl });
  const pool = new Pool({ connectionString: dbUrl, max: 4 });
  // The LICENSE check would ask GitHub: no apps have a repo here.
  let server;
  t.after(async () => {
    if (server) server.close();
    await routePool.end();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  // Applying the schema a second time is what every boot does.
  await pool.query(schema);

  await pool.query(
    `INSERT INTO users (id, username, password, is_admin, admin_readonly) VALUES
       (1, 'comp-full', 'not-a-login', TRUE, FALSE),
       (2, 'comp-view', 'not-a-login', TRUE, TRUE)`
  );
  // One address kept past the period: the I-05 check fails on it.
  await pool.query(
    `INSERT INTO db_exports (user_id, username, db_name, status, ip, requested_at)
     VALUES (1, 'comp-full', 'app_x', 'done', '192.0.2.1', NOW() - INTERVAL '400 days')`
  );

  let user = FULL;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(adminRoutes({ jwtSecret: 'test', databaseUrl: dbUrl }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  // Before anything is saved: the plan's starting values, no scan.
  let r = await call('GET', '/api/admin/compliance');
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 65);
  assert.equal(r.body.scans.length, 0);
  const i05 = r.body.items.find((i) => i.code === 'I-05');
  assert.equal(i05.fromPlan, true);
  const x05 = r.body.items.find((i) => i.code === 'X-05');
  assert.equal(x05.status, 'partial');
  assert.ok(x05.note, 'a partly done item starts with its note');

  // A view-only admin reads, but neither saves nor scans.
  user = VIEW;
  assert.equal((await call('GET', '/api/admin/compliance')).status, 200);
  assert.equal((await call('GET', '/api/admin/compliance/items/I-05')).status, 200);
  assert.equal((await call('POST', '/api/admin/compliance/items/I-05/status', { status: 'done' })).status, 403);
  assert.equal((await call('POST', '/api/admin/compliance/scan', {})).status, 403);
  user = FULL;

  // A save, then a save with no note: the note stays.
  r = await call('POST', '/api/admin/compliance/items/X-05/status', { status: 'done', note: 'Export shipped in #9999' });
  assert.equal(r.status, 200);
  r = await call('POST', '/api/admin/compliance/items/X-05/status', { status: 'partial' });
  const x05b = r.body.items.find((i) => i.code === 'X-05');
  assert.equal(x05b.status, 'partial');
  assert.equal(x05b.note, 'Export shipped in #9999', 'a blank note keeps the last one');
  assert.equal(x05b.setBy, 'comp-full');
  assert.equal(x05b.fromPlan, false);
  assert.equal((await call('POST', '/api/admin/compliance/items/Z-99/status', { status: 'done' })).status, 404);
  assert.equal((await call('POST', '/api/admin/compliance/items/X-05/status', { status: 'nope' })).status, 400);

  // I-05 marked done by hand, then the scan finds the old address.
  await call('POST', '/api/admin/compliance/items/I-05/status', { status: 'done' });
  r = await call('POST', '/api/admin/compliance/scan', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.scans.length, 1);
  const states = Object.fromEntries(r.body.scans[0].results.map((x) => [x.key, x.state]));
  assert.equal(states['ip-retention'], 'fail', 'the 400-day-old address is found');
  assert.equal(states['admin-access-review'], 'fail', 'never reviewed');
  assert.equal(states['account-deletions'], 'pass');
  assert.equal(states['app-data-deletion'], 'pass');
  assert.equal(states['repo-license'], 'pass', 'no project has a repository here');
  assert.ok(['pass', 'fail'].includes(states['db-tls']));
  const i05b = r.body.items.find((i) => i.code === 'I-05');
  assert.equal(i05b.status, 'done', 'a failing scan does not change what a person set');
  assert.equal(i05b.attention, true);
  assert.equal(r.body.items[0].attention, true, 'an item a scan fails on is listed first');
  assert.ok(r.body.attention >= 2);

  // The address cleared, a second scan passes and both are kept.
  await pool.query('UPDATE db_exports SET ip = NULL');
  r = await call('POST', '/api/admin/compliance/scan', {});
  assert.equal(r.body.scans.length, 2);
  assert.equal(r.body.items.find((i) => i.code === 'I-05').attention, false);

  r = await call('GET', '/api/admin/compliance/items/I-05');
  assert.equal(r.body.changes.length, 1);
  assert.equal(r.body.scans.length, 2);
  assert.deepEqual(r.body.scans.map((s) => s.state), ['pass', 'fail'], 'newest first');
  assert.equal((await call('GET', '/api/admin/compliance/items/Z-99')).status, 404);
});
