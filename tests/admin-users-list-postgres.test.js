'use strict';

// #3938: the admin Users list (the rows of /#admin/users) reads the podium
// flag off every account, so the Podium column can say yes or no and the
// inline switch can flip it. The list query and the toggle the switch calls
// run here against the full PostgreSQL schema, like the other *-postgres
// tests. TEST_DATABASE_URL selects a local test database.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');

const { adminRoutes } = require('../src/routes/admin');
const { usersAdminRoutes } = require('../src/routes/topochain/admin/users');

test('the admin users list carries each account, and the inline podium switch flips it', { timeout: 120000 }, async (t) => {
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
  }
  const name = 'admin_users_list_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const dbUrl = String(url);
  const config = { databaseUrl: dbUrl };
  // The route modules resolve their shared pool on first use, so point it
  // at the scratch database before mounting them.
  const routePool = require('../src/db/pool').getPool(config);
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  const pool = new Pool({ connectionString: dbUrl, max: 8 });
  t.after(async () => {
    await routePool.end();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  await pool.query(schema);
  await pool.query(
    `INSERT INTO users (id, username, password, is_admin, admin_readonly) VALUES
       (1, 'podium-admin', 'not-a-login', TRUE, FALSE),
       (2, 'podium-ranked', 'not-a-login', FALSE, FALSE),
       (3, 'podium-excluded', 'not-a-login', FALSE, FALSE)`);
  await pool.query('UPDATE users SET exclude_podium = TRUE WHERE id = 3');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, username: 'podium-admin', isAdmin: true, canAdminWrite: true, adminReadonly: false };
    next();
  });
  app.use(adminRoutes(config));
  app.use(usersAdminRoutes(config));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, route, body) => {
    const response = await fetch(base + route, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  t.after(() => server.close());

  const listPodium = async () => {
    const response = await request('GET', '/api/admin/users');
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(response.data), true);
    return new Map(response.data.map((u) => [Number(u.id), u.exclude_podium]));
  };

  await t.test('every row states its podium flag', async () => {
    const podium = await listPodium();
    assert.equal(podium.get(2), false, 'a ranked account reads podium yes');
    assert.equal(podium.get(3), true, 'an excluded account reads podium no');
  });

  await t.test('the inline switch flips the flag and the list follows', async () => {
    const toggle = await request('PATCH', '/api/v4/admin/users/3/toggle-exclude-podium');
    assert.equal(toggle.status, 200);
    assert.equal(toggle.data.success, true);
    assert.equal(toggle.data.data.exclude_podium, false, 'the refreshed row is ranked again');
    const podium = await listPodium();
    assert.equal(podium.get(3), false, 'the next list read shows the flipped value');
    // And back, so the seeded state is left as it started.
    const back = await request('PATCH', '/api/v4/admin/users/3/toggle-exclude-podium');
    assert.equal(back.data.data.exclude_podium, true);
  });
});
