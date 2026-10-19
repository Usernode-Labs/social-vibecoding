'use strict';

// #5121: a deleted app leaves a receipt naming what it had in storage, each
// step is stamped as it is removed, a step that failed is retried from the
// receipt after the row is gone (never against a database a live app now
// holds), and the admin report lists apps idle past the inactivity window.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const retention = require('../src/services/app-data-retention');

test('the policy stages and purge states read as documented', () => {
  assert.equal(retention.inactiveStage(10), 'active');
  assert.equal(retention.inactiveStage(180), 'notify_owners');
  assert.equal(retention.inactiveStage(209), 'notify_owners');
  assert.equal(retention.inactiveStage(210), 'stop_eligible');
  const at = new Date();
  assert.equal(retention.purgeState({ database_dropped_at: at, template_dropped_at: at, files_removed_at: at, attempts: 1 }), 'purged');
  assert.equal(retention.purgeState({ database_dropped_at: null, template_dropped_at: at, files_removed_at: at, attempts: 1 }), 'pending');
  assert.equal(retention.purgeState({ database_dropped_at: null, template_dropped_at: at, files_removed_at: at, attempts: retention.MAX_ATTEMPTS }), 'needs_operator');
});

test('a deleted app is purged from its receipt, retried, and the report lists idle apps', async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `app_retention_${crypto.randomBytes(5).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 3 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // idempotent

  const { rows: [owner] } = await pool.query("INSERT INTO users (username, password) VALUES ('ret-owner', 'x') RETURNING id");
  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, status, created_by, runtime_kind, runtime_name) VALUES ('Gone', 'gone-app', 'running', $1, 'docker', 'usernode-app-gone-app') RETURNING *",
    [owner.id]);

  const runtime = require('../src/services/application-runtime');
  t.mock.method(runtime, 'remove', async () => {});
  const dbManager = require('../src/services/db-manager');
  const dropped = [];
  let failDrop = true;
  t.mock.method(dbManager, 'dropDatabase', async (db, opts) => {
    assert.equal(opts?.strict, true, 'a failed drop is reported so it can be recorded');
    if (failDrop) throw new Error('database "app_gone_app" is being accessed by other users');
    dropped.push(db);
  });
  const templates = [];
  t.mock.method(dbManager, 'dropStagingTemplates', async (db) => { templates.push(db); });
  const appFiles = require('../src/services/app-files');
  const prefixes = [];
  t.mock.method(appFiles, 'getStore', () => ({ async removeAppPrefix(id) { prefixes.push(id); return 2; } }));

  const teardown = require('../src/services/app-teardown');
  await teardown.teardownApp(pool, {}, app);

  assert.equal((await pool.query('SELECT 1 FROM apps WHERE id = $1', [app.id])).rows.length, 0, 'the row still goes');
  let { rows: [receipt] } = await pool.query('SELECT * FROM deleted_app_purges WHERE app_id = $1', [app.id]);
  assert.equal(receipt.slug, 'gone-app');
  assert.equal(receipt.db_name, 'app_gone_app');
  assert.equal(receipt.storage_prefix, `app/${app.id}/`);
  assert.ok(receipt.runtime_removed_at && receipt.template_dropped_at && receipt.files_removed_at);
  assert.equal(receipt.database_dropped_at, null);
  assert.match(receipt.errors.database, /being accessed/);
  assert.deepEqual(templates, ['app_gone_app']);
  assert.deepEqual(prefixes, [app.id]);

  // Not due yet: a retry waits an hour after the last attempt.
  assert.equal((await retention.retryPendingPurges(pool, {})).examined, 0);

  // Due: the database drop is retried alone, and the error goes.
  failDrop = false;
  const summary = await retention.retryPendingPurges(pool, {}, { retryAfterMs: 0 });
  assert.deepEqual(summary, { examined: 1, retried: 1, completed: 1, skippedNameInUse: 0 });
  assert.deepEqual(dropped, ['app_gone_app']);
  assert.deepEqual(templates, ['app_gone_app'], 'a step already done is not repeated');
  ({ rows: [receipt] } = await pool.query('SELECT * FROM deleted_app_purges WHERE app_id = $1', [app.id]));
  assert.ok(receipt.database_dropped_at);
  assert.deepEqual(receipt.errors, {});
  assert.equal(receipt.attempts, 2);
  assert.equal((await retention.retryPendingPurges(pool, {}, { retryAfterMs: 0 })).examined, 0, 'a purged receipt is done');

  // A live app holding the name of an old receipt (made before the receipt
  // existed; the trigger refuses it after): its database is never dropped
  // from the old receipt.
  await pool.query("INSERT INTO apps (name, slug, status, created_by) VALUES ('Reused', 'reused', 'running', $1)", [owner.id]);
  await pool.query(
    "INSERT INTO deleted_app_purges (app_id, slug, db_name, storage_prefix, attempts, last_attempt_at) VALUES (999999, 'reused', 'app_reused', 'app/999999/', 1, NOW() - INTERVAL '2 hours')");
  dropped.length = 0;
  const reused = await retention.retryPendingPurges(pool, {});
  assert.equal(reused.skippedNameInUse, 1);
  assert.deepEqual(dropped, []);
  ({ rows: [receipt] } = await pool.query('SELECT * FROM deleted_app_purges WHERE app_id = 999999'));
  assert.equal(receipt.database_dropped_at, null);
  assert.match(receipt.errors.database, /live app/);
  assert.ok(receipt.files_removed_at, 'its files, keyed by the old id, are still removed');

  // The report: an app idle past the window, an active one, the platform's own.
  await pool.query(
    "INSERT INTO apps (name, slug, status, created_by, created_at, last_deploy_at) VALUES ('Old', 'old-app', 'running', $1, NOW() - INTERVAL '400 days', NOW() - INTERVAL '300 days')",
    [owner.id]);
  const { rows: [quiet] } = await pool.query(
    "INSERT INTO apps (name, slug, status, created_by, created_at, last_deploy_at) VALUES ('Quiet', 'quiet-app', 'running', $1, NOW() - INTERVAL '400 days', NOW() - INTERVAL '300 days') RETURNING id",
    [owner.id]);
  await pool.query('INSERT INTO app_activity (app_id, user_id, seconds_spent, date) VALUES ($1, $2, 30, CURRENT_DATE - 190)', [quiet.id, owner.id]);
  await pool.query(
    "INSERT INTO apps (name, slug, status, created_by, created_at, last_deploy_at, self_hosted) VALUES ('Core', 'core-app', 'running', $1, NOW() - INTERVAL '400 days', NOW() - INTERVAL '400 days', TRUE)",
    [owner.id]);
  const report = await retention.adminReport(pool, {});
  assert.equal(report.policy.inactiveAfterDays, 180);
  const bySlug = Object.fromEntries(report.inactiveApps.map((r) => [r.slug, r]));
  assert.deepEqual(Object.keys(bySlug).sort(), ['old-app', 'quiet-app']);
  assert.equal(bySlug['old-app'].stage, 'stop_eligible');
  assert.equal(bySlug['quiet-app'].stage, 'notify_owners');
  assert.ok(bySlug['quiet-app'].idle_days >= 189 && bySlug['quiet-app'].idle_days <= 191);
  const states = Object.fromEntries(report.deletedApps.map((r) => [r.slug, r.state]));
  assert.deepEqual(states, { 'gone-app': 'purged', reused: 'pending' });

  // ── The name is reserved while its purge is unfinished ──
  const purged = (db) => pool.query(
    'UPDATE deleted_app_purges SET database_dropped_at = NOW(), template_dropped_at = NOW() WHERE db_name = $1', [db]);
  await pool.query(
    "INSERT INTO deleted_app_purges (app_id, slug, db_name, storage_prefix, attempts) VALUES (999990, 'taken-x', 'app_taken_x', 'app/999990/', 1)");
  const create = (slug) => pool.query(
    "INSERT INTO apps (name, slug, status, created_by) VALUES ('Taken', $1, 'creating', $2) RETURNING id", [slug, owner.id]);
  await assert.rejects(create('taken-x'), (err) => err.code === retention.NAME_BEING_PURGED
    && err.message === retention.NAME_BEING_PURGED_ERROR);
  // The same normalised name from another slug, and a rename onto it.
  await assert.rejects(create('taken_x'), (err) => err.code === retention.NAME_BEING_PURGED);
  const { rows: [other] } = await create('other-x');
  await assert.rejects(pool.query("UPDATE apps SET slug = 'taken-x' WHERE id = $1", [other.id]),
    (err) => err.code === retention.NAME_BEING_PURGED);
  await pool.query("UPDATE apps SET name = 'Other X' WHERE id = $1", [other.id]); // other columns are untouched
  // Database dropped but the template not yet: still reserved.
  await pool.query("UPDATE deleted_app_purges SET database_dropped_at = NOW() WHERE db_name = 'app_taken_x'");
  await assert.rejects(create('taken-x'), (err) => err.code === retention.NAME_BEING_PURGED);
  await purged('app_taken_x');
  const { rows: [retaken] } = await create('taken-x');
  assert.ok(retaken.id, 'free again once purged');

  // A creation that reaches the name while a purge holds its lock waits for
  // it, then finds the receipt still pending and is refused.
  await pool.query(
    "INSERT INTO deleted_app_purges (app_id, slug, db_name, storage_prefix, attempts) VALUES (999991, 'held-y', 'app_held_y', 'app/999991/', 1)");
  const { APP_NAME_PURGE_LOCK } = require('../src/services/advisory-locks');
  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))', [APP_NAME_PURGE_LOCK, 'app_held_y']);
  let settled = false;
  const waiting = create('held-y').then(() => 'created', (err) => err.code).finally(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(settled, false, 'the insert waits on the purge lock');
  await holder.query('COMMIT');
  holder.release();
  assert.equal(await waiting, retention.NAME_BEING_PURGED);

  // The race the lock closes: the sweep's first look finds the name free,
  // and an app takes it (outside the trigger, as one made before its receipt
  // existed would) before the drop. The re-check under the lock sees it, and
  // nothing is dropped.
  await pool.query(
    "INSERT INTO deleted_app_purges (app_id, slug, db_name, storage_prefix, attempts, last_attempt_at) VALUES (999992, 'race-z', 'app_race_z', 'app/999992/', 1, NOW() - INTERVAL '2 hours')");
  const racing = Object.create(pool);
  let raced = false;
  racing.connect = async () => {
    if (!raced) {
      raced = true;
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica'); // past the trigger
        await c.query("INSERT INTO apps (name, slug, status, created_by) VALUES ('Race', 'race-z', 'running', $1)", [owner.id]);
        await c.query('COMMIT');
      } finally { c.release(); }
    }
    return pool.connect();
  };
  racing.query = (...args) => pool.query(...args);
  dropped.length = 0;
  templates.length = 0;
  const race = await retention.retryPendingPurges(racing, {});
  assert.ok(raced, 'the app was taken after the first look');
  assert.deepEqual(dropped, [], 'a database a live app holds is never dropped');
  assert.deepEqual(templates, [], 'nor its staging template');
  assert.equal(race.skippedNameInUse, 1);
  ({ rows: [receipt] } = await pool.query('SELECT * FROM deleted_app_purges WHERE app_id = 999992'));
  assert.equal(receipt.database_dropped_at, null);
  assert.equal(receipt.template_dropped_at, null);
  assert.match(receipt.errors.database, /held by a live app/);
  assert.match(receipt.errors.template, /held by a live app/);
});

test('the trigger and the service take the same name lock', () => {
  const { APP_NAME_PURGE_LOCK } = require('../src/services/advisory-locks');
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  assert.ok(schema.includes(`pg_advisory_xact_lock(${APP_NAME_PURGE_LOCK}, hashtext(db))`));
  assert.ok(schema.includes("'app_' || regexp_replace(NEW.slug, '[^a-z0-9_]', '_', 'g')"),
    'the trigger builds the name as db-manager.appDbName does');
  const dbManager = require('../src/services/db-manager');
  assert.equal(dbManager.appDbName('taken-x'), 'app_taken_x');
});
