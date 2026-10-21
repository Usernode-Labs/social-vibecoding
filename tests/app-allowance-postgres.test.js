// Execute the real allowance service, migration, and HTTP routes against
// PostgreSQL. Uses an isolated schema; never provisions repositories/apps.
// TEST_DATABASE_URL selects a local test database, like the other *-postgres tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const express = require('express');

const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
const migration = schema.match(/-- #1559: grant existing accounts[\s\S]*?END \$\$;/)[0];
const defaults = schema.match(/^ALTER TABLE users (?:ADD COLUMN IF NOT EXISTS app_quota\b|ALTER COLUMN app_quota\b|ADD COLUMN IF NOT EXISTS app_quota_requested_at\b).*;$/gm).join('\n');

let client;
let user;
let pushes = [];
let failNotifications = false;
const pool = {
  async query(sql, params) {
    if (failNotifications && /INSERT INTO notifications/.test(sql)) throw new Error('Notification write failed');
    return client.query(sql, params);
  },
  // The create route writes a project in one transaction: on the one
  // connection this test has, one statement after another.
  async connect() { return { query: (sql, params) => pool.query(sql, params), release() {} }; },
};
require('../src/db/pool').getPool = () => pool;
require('../src/services/notifications').hydrateAndPush = async (_pool, row) => { pushes.push(row); };
require('../src/services/ws').pushNotificationToUser = (id, event) => { pushes.push({ userId: id, ...event }); };
require('../src/services/events').record = async () => {};
const allowance = require('../src/services/app-allowance');
const { appRoutes } = require('../src/routes/apps');
const { adminRoutes } = require('../src/routes/admin');

test('app allowances: migration, create/fork, requests and admin review', async (t) => {
  client = new Client({
    connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
    connectionTimeoutMillis: 1500,
  });
  try { await client.connect(); }
  catch {
    await client.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not reachable');
    return t.skip('No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.');
  }
  const namespace = `app_allowance_test_${process.pid}`;
  let server;
  try {
    await client.query(`CREATE SCHEMA ${namespace}`);
    await client.query(`SET search_path TO ${namespace}, public`);
    await client.query(`
      CREATE TABLE users (id SERIAL PRIMARY KEY, username VARCHAR(255),
        is_admin BOOLEAN DEFAULT FALSE, admin_readonly BOOLEAN NOT NULL DEFAULT FALSE,
        app_quota INTEGER NOT NULL DEFAULT 0,
        has_platform_access BOOLEAN NOT NULL DEFAULT TRUE, private_member_since TIMESTAMPTZ);
      CREATE TABLE platform_settings (key VARCHAR(255) PRIMARY KEY, value TEXT);
      CREATE TABLE notifications (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id),
        source_user_id INTEGER REFERENCES users(id), kind VARCHAR(32), detail VARCHAR(32),
        created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE apps (id SERIAL PRIMARY KEY, name TEXT, slug TEXT, repo_url TEXT,
        created_by INTEGER REFERENCES users(id), status VARCHAR(32),
        collab_visibility VARCHAR(16) DEFAULT 'public', view_visibility VARCHAR(16) DEFAULT 'public',
        self_hosted BOOLEAN DEFAULT FALSE, forked_from JSONB,
        -- #4666: a new project's approval rule (You or the group) is written on create.
        governance_rules JSONB,
        -- The workflow makes a new project (src/workflow/app-creation/).
        creating_owner TEXT, creating_heartbeat_at TIMESTAMPTZ);
      CREATE TABLE user_app_blocks (user_id INTEGER, app_id INTEGER, PRIMARY KEY (user_id, app_id));
      CREATE TABLE app_collaborators (app_id INTEGER, user_id INTEGER, status TEXT,
        accepted_at TIMESTAMPTZ, PRIMARY KEY(app_id, user_id));
      INSERT INTO users (id, username, app_quota, is_admin, admin_readonly) VALUES
        (1, 'admin', 5, TRUE, FALSE), (2, 'alice', 0, FALSE, FALSE),
        (3, 'bob', 1, FALSE, FALSE), (4, 'trusted', 7, FALSE, FALSE),
        (5, 'viewer', 0, TRUE, TRUE);
    `);

    await t.test('existing low allowances become two once; higher values and later restrictions survive', async () => {
      await client.query(defaults);
      await client.query(migration);
      assert.deepEqual((await client.query('SELECT app_quota FROM users ORDER BY id')).rows.map((r) => r.app_quota), [5, 2, 2, 7, 2]);
      assert.equal((await client.query('SELECT * FROM notifications')).rows.length, 3);
      await client.query('UPDATE users SET app_quota = 0 WHERE id = 3');
      await client.query(migration);
      assert.equal((await client.query('SELECT app_quota FROM users WHERE id = 3')).rows[0].app_quota, 0);
      assert.equal((await client.query('SELECT * FROM notifications')).rows.length, 3);
      const fresh = (await client.query("INSERT INTO users (id, username) VALUES (6, 'new') RETURNING app_quota")).rows[0];
      assert.equal(fresh.app_quota, 2);
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use(appRoutes({ maxApps: 0 }));
    app.use(adminRoutes({}));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (method, route, body) => {
      const response = await fetch(base + route, {
        method, headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };
    const alice = { id: 2, username: 'alice', appQuota: 0, isAdmin: false, canAdminWrite: false };
    const admin = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };
    const viewer = { id: 5, username: 'viewer', isAdmin: true, canAdminWrite: false };
    const trusted = { id: 4, username: 'trusted', appQuota: 7, isAdmin: false, canAdminWrite: false };

    await t.test('a stale zero allowance on the session cannot block two available slots', async () => {
      user = alice;
      const response = await request('GET', '/api/me/app-allowance');
      assert.equal(response.status, 200);
      assert.deepEqual(response.data.quota, { used: 0, limit: 2, remaining: 2 });
      const first = await request('POST', '/api/apps', { name: 'First app' });
      assert.equal(first.status, 201, JSON.stringify(first.data));
      await client.query("UPDATE apps SET status = 'running', repo_url = 'https://github.com/example/test' WHERE id = $1", [first.data.app.id]);
      const fork = await request('POST', `/api/apps/${first.data.app.slug}/fork`, { name: 'Second app' });
      assert.equal(fork.status, 201, JSON.stringify(fork.data));
      const third = await request('POST', '/api/apps', { name: 'Third app' });
      assert.equal(third.status, 403);
      assert.equal(third.data.code, 'app_allowance_exhausted');
      assert.deepEqual(third.data.quota, { used: 2, limit: 2, remaining: 0 });
      const thirdFork = await request('POST', `/api/apps/${first.data.app.slug}/fork`, { name: 'Third fork' });
      assert.equal(thirdFork.status, 403);
      await client.query("UPDATE apps SET status = 'error' WHERE id = $1", [fork.data.app.id]);
      assert.equal((await allowance.read(pool, alice)).quota.remaining, 1);
      await client.query('DELETE FROM apps WHERE id = $1', [first.data.app.id]);
      assert.equal((await allowance.read(pool, alice)).quota.remaining, 2);
    });

    await t.test('duplicate requests persist once and notify both admin roles', async () => {
      user = alice;
      await client.query('DELETE FROM notifications');
      const first = await request('POST', '/api/me/app-allowance/request');
      const again = await request('POST', '/api/me/app-allowance/request');
      assert.equal(first.status, 200);
      assert.ok(first.data.requestedAt);
      assert.equal(again.data.requestedAt, first.data.requestedAt);
      const rows = (await client.query("SELECT user_id FROM notifications WHERE kind = 'app_quota_requested' ORDER BY user_id")).rows;
      assert.deepEqual(rows.map((r) => r.user_id), [1, 5]);
    });

    await t.test('admin increase resolves the request and notifies only an actual change', async () => {
      user = admin;
      const response = await request('POST', '/api/admin/users/2/app-quota-request/approve');
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.app_quota, 4);
      assert.equal((await allowance.read(pool, alice)).requestedAt, null);
      assert.equal((await request('POST', '/api/admin/users/2/app-quota-request/approve')).status, 409);
      await request('PUT', '/api/admin/users/2/app-quota', { quota: 4 });
      const rows = (await client.query("SELECT detail FROM notifications WHERE user_id = 2 AND kind = 'app_quota_changed'")).rows;
      assert.deepEqual(rows, [{ detail: '2:4' }]);
      assert.ok(pushes.some((p) => p.userId === 2 && p.type === 'app_allowance_changed'));
    });

    await t.test('a failed notification insert rolls the allowance edit back', async () => {
      failNotifications = true;
      const response = await request('PUT', '/api/admin/users/2/app-quota', { quota: 9 });
      failNotifications = false;
      assert.equal(response.status, 500);
      assert.equal((await allowance.read(pool, alice)).quota.limit, 4);
    });

    await t.test('request decline is visible to the user and retries do not duplicate it', async () => {
      user = alice;
      await request('POST', '/api/me/app-allowance/request');
      user = viewer;
      assert.equal((await request('POST', '/api/admin/users/2/app-quota-request/approve')).status, 403);
      assert.equal((await request('DELETE', '/api/admin/users/2/app-quota-request')).status, 403);
      assert.equal((await request('PUT', '/api/admin/users/2/app-quota', { quota: 6 })).status, 403);
      assert.equal((await allowance.read(pool, viewer)).quota.limit, 2);
      assert.equal((await allowance.read(pool, admin)).quota.limit, null);
      user = admin;
      assert.equal((await request('DELETE', '/api/admin/users/2/app-quota-request')).status, 200);
      await request('DELETE', '/api/admin/users/2/app-quota-request');
      assert.equal((await allowance.read(pool, alice)).requestedAt, null);
      assert.equal((await client.query("SELECT * FROM notifications WHERE kind = 'app_quota_request_declined'")).rows.length, 1);
    });

    // #5737: somebody who pressed "Request more" before filling the form in
    // takes the request back, then asks again with the right details.
    await t.test('a person can take their own pending request back, and ask again', async () => {
      user = trusted;
      await client.query('UPDATE users SET app_quota_requested_at = NULL WHERE id = 4');
      await client.query('DELETE FROM notifications');
      const made = await request('POST', '/api/me/app-allowance/request');
      assert.ok(made.data.requestedAt);
      const seen = pushes.length;
      const undone = await request('DELETE', '/api/me/app-allowance/request');
      assert.equal(undone.status, 200, JSON.stringify(undone.data));
      assert.equal(undone.data.requestedAt, null);
      assert.equal((await allowance.read(pool, trusted)).requestedAt, null);
      assert.ok(pushes.slice(seen).some((p) => p.userId === 4 && p.type === 'app_allowance_changed'),
        'the person\'s other tabs refresh');
      assert.equal((await client.query("SELECT * FROM notifications WHERE kind = 'app_quota_requested'")).rows.length, 2,
        'the admins\' original notice stays, and the undo inserts none');
      // Nothing pending is the current allowance, not an error (a second tab,
      // or an admin who already answered).
      const again = await request('DELETE', '/api/me/app-allowance/request');
      assert.equal(again.status, 200);
      assert.equal(again.data.requestedAt, null);
      // An admin approving after the undo meets the existing 409.
      user = admin;
      assert.equal((await request('POST', '/api/admin/users/4/app-quota-request/approve')).status, 409);
      // Asking again works straight away, with a fresh set of notices.
      user = trusted;
      const remade = await request('POST', '/api/me/app-allowance/request');
      assert.ok(remade.data.requestedAt);
      assert.equal((await client.query("SELECT * FROM notifications WHERE kind = 'app_quota_requested'")).rows.length, 4);
      // A full admin has no request to undo.
      user = admin;
      assert.equal((await request('DELETE', '/api/me/app-allowance/request')).status, 400);
      user = null;
      assert.equal((await request('DELETE', '/api/me/app-allowance/request')).status, 401);
    });

    await t.test('bulk changes notify each changed user and reject malformed allowance values', async () => {
      await client.query('DELETE FROM notifications');
      user = admin;
      const bulk = await request('PUT', '/api/admin/users/app-quota', { quota: 2 });
      assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
      assert.equal((await client.query("SELECT * FROM notifications WHERE kind = 'app_quota_changed'")).rows.length, 4);
      for (const quota of [null, '', true, 1.5, -1, 2147483648]) {
        assert.equal((await request('PUT', '/api/admin/users/2/app-quota', { quota })).status, 400);
      }
      assert.equal((await request('PUT', '/api/admin/users/20000/app-quota', { quota: 2 })).status, 404);
      assert.equal((await request('PUT', '/api/admin/users/2oops/app-quota', { quota: 2 })).status, 400);
      user = null;
      assert.equal((await request('GET', '/api/me/app-allowance')).status, 401);
      assert.equal((await request('POST', '/api/me/app-allowance/request')).status, 401);
    });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await client.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`).catch(() => {});
    await client.end();
  }
});
