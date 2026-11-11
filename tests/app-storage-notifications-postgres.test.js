'use strict';

// #6494: a storage notice must reach the project's admins even when some
// other app_health row (a failed deploy) is still unread, and a newer
// storage notice must replace an unread older one for the same project.
// Both rules live in one INSERT ... WHERE NOT EXISTS and a supersede UPDATE,
// so they are checked against the real PostgreSQL schema rather than a
// string match on the query.
//
// Run with: node --test tests/app-storage-notifications-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('storage notices supersede each other and are not blocked by another unread app health row', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'app_storage_notif_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);

  const { rows: [creator] } = await pool.query(
    "INSERT INTO users (username, password) VALUES ('storage_owner', 'x') RETURNING id"
  );
  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, created_by, status) VALUES ('Recipe Box', 'recipe-box-6494', $1, 'running') RETURNING id",
    [creator.id]
  );
  const notifications = require('../src/services/notifications');
  const unread = async (userId = creator.id) => (await pool.query(
    "SELECT id, detail, read_at FROM notifications WHERE user_id = $1 AND app_id = $2 AND kind = 'app_health' ORDER BY id",
    [userId, app.id]
  )).rows;
  const insert = (detail, readAt = null) => pool.query(
    "INSERT INTO notifications (user_id, app_id, kind, detail, read_at) VALUES ($1, $2, 'app_health', $3, $4) RETURNING id",
    [creator.id, app.id, detail, readAt]
  );
  const notifyStorage = (detail) => notifications.createAppHealthNotification(pool, { appId: app.id, detail });

  // An unread deploy failure is still waiting: it must not swallow the
  // storage notice.
  await insert('deploy_failed');
  const first = await notifyStorage('storage_warn:2560:3072');
  assert.equal(first.length, 1, 'the storage notice was inserted');
  assert.equal(first[0].detail, 'storage_warn:2560:3072');

  // A newer storage notice marks the unread older one read, and lands.
  const older = await insert('storage_early:1638:3072');
  assert.equal((await unread()).filter((r) => r.read_at === null).length, 3, 'the older notices and the deploy failure are unread');
  const second = await notifyStorage('storage_warn:2560:3072');
  assert.equal(second.length, 1);
  const after = await unread();
  const superseded = after.find((r) => r.id === older.rows[0].id);
  assert.ok(superseded.read_at, 'the older storage notice was marked read');
  assert.equal(after.filter((r) => r.read_at === null && String(r.detail).startsWith('storage_')).length, 1,
    'one unread storage notice remains: the newer one');

  // A non-storage token keeps the old any-unread guard.
  const blocked = await notifications.createAppHealthNotification(pool, { appId: app.id, detail: 'deploy_failed' });
  assert.deepEqual(blocked, [], 'a second deploy failure is held while an app_health row is unread');

  // The freeze notice supersedes the unread warning too.
  const full = await notifyStorage('storage_full');
  assert.equal(full.length, 1);
  assert.equal((await unread()).filter((r) => r.read_at === null && String(r.detail).startsWith('storage_')).length, 1);

  // The level writes the sweep adds also run here, against the real column:
  // early, then the warning, then back down through early to none.
  const cap = require('../src/services/app-storage-cap');
  const GIB = 1024 * 1024 * 1024;
  const sweepAt = async (bytes) => {
    const execute = async (sql) => (/pg_database_size/.test(sql) ? `app_recipe_box_6494|${Math.floor(bytes)}` : '');
    return cap.sweep(pool, { execute, staging: true });
  };
  const level = async () => (await pool.query('SELECT db_storage_warn_level, db_storage_warned_at FROM apps WHERE id = $1', [app.id])).rows[0];

  let out = await sweepAt(1.6 * GIB);
  assert.equal(out.earlyWarned, 1);
  assert.deepEqual((({ db_storage_warn_level: l }) => [l])(await level()), [1]);
  out = await sweepAt(2.5 * GIB);
  assert.equal(out.warned, 1);
  assert.equal((await level()).db_storage_warn_level, 2);
  assert.ok((await level()).db_storage_warned_at, 'the warning line is stamped');
  out = await sweepAt(2.0 * GIB);
  assert.equal(out.cleared, 1);
  assert.deepEqual(await level(), { db_storage_warn_level: 1, db_storage_warned_at: null });
  out = await sweepAt(0.4 * GIB);
  assert.equal(out.cleared, 1);
  assert.deepEqual(await level(), { db_storage_warn_level: null, db_storage_warned_at: null });
});
