'use strict';

// An app's teardown is marked on its row (apps.teardown_started_at), not held
// in the memory of the process running it: a deploy that finishes while it
// runs (the app-delivery machine's work, in whichever process claims it)
// removes the runtime it put back, and the heal sweep leaves the app alone.
// Before, "tearing down" was the process's own hold plus a two-second copy of
// the others' (services/processes.js), so a deploy ending on another process
// in that window kept its runtime, and the row was deleted under it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// pool.end() resolves once its idle connections are handed their end, not
// once their sockets close, so the teardown's DROP DATABASE ... WITH (FORCE)
// can reach one still closing. The server then terminates it (57P01) and the
// pool re-emits that as 'error', which without a listener is an
// uncaughtException that fails whatever test is running (the same race in
// tests/username-invite-join-postgres.test.js and
// tests/orphan-adoption-postgres.test.js). A drop DURING the checks is still
// this file's failure: the test asserts none was recorded.
let closing = false;
const dropped = [];
const onPoolError = (err) => {
  if (closing) return; // the teardown's own DROP closes this test's connections
  dropped.push(`${err.code || ''} ${err.message}`);
};

test('the teardown mark is on the row, read by a deploy in any process', async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', onPoolError);
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `teardown_mark_${crypto.randomBytes(5).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 3 });
  pool.on('error', onPoolError);
  t.after(async () => {
    closing = true; // from here a drop is this teardown's own doing
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { rows: [owner] } = await pool.query("INSERT INTO users (username, password) VALUES ('mark-owner', 'x') RETURNING id");
  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, status, created_by, runtime_kind, runtime_name) VALUES ('Mark', 'mark-app', 'running', $1, 'docker', 'usernode-app-mark-app') RETURNING *",
    [owner.id]);

  const runtime = require('../src/services/application-runtime');
  const removed = [];
  t.mock.method(runtime, 'remove', async (config, ref) => { removed.push(ref.runtimeName); });
  const teardown = require('../src/services/app-teardown');
  const deployed = { id: app.id, slug: app.slug, runtime_kind: 'docker', runtime_name: app.runtime_name };

  // Nobody is taking it down: a deploy keeps what it put up.
  assert.equal(await teardown.removeRuntimeIfDeleted({}, pool, deployed), false);
  assert.equal(await teardown.isTearingDown(pool, { id: app.id }), false);

  // A teardown refused at its first step (a preview not retired yet) leaves
  // the app as it was, and unmarked: a process that dies there leaves no mark
  // that would remove a live app's runtime on its next deploy.
  const previews = require('../src/services/preview-workflow');
  await pool.query(`INSERT INTO chat_sessions (app_id, user_id, status, staging_url) VALUES ($1, $2, 'active', 'https://p.example')`,
    [app.id, owner.id]);
  t.mock.method(previews, 'retire', async () => ({ retired: false, status: 'rejected', reason: 'busy' }));
  await assert.rejects(teardown.teardownApp(pool, {}, app), /not retired yet/);
  assert.equal((await pool.query('SELECT teardown_started_at FROM apps WHERE id = $1', [app.id])).rows[0].teardown_started_at, null);

  // Marked (as the first statement of a teardown under way, from another
  // process): a deploy that finishes now removes its runtime, and the heal
  // sweep reads it from the row it already has.
  await pool.query('UPDATE apps SET teardown_started_at = NOW() WHERE id = $1', [app.id]);
  assert.equal(await teardown.removeRuntimeIfDeleted({}, pool, deployed), true);
  assert.ok(removed.includes('usernode-app-mark-app'));
  assert.equal(await teardown.isTearingDown(pool, { id: app.id }), true);
  assert.equal(await teardown.isTearingDown(pool, (await pool.query('SELECT * FROM apps WHERE id = $1', [app.id])).rows[0]), true);

  // Past the previews the mark goes on before anything is removed, and stays
  // when a later step fails (a half-removed app is never rebuilt).
  t.mock.method(previews, 'retire', async () => ({ retired: true, status: 'accepted' }));
  await pool.query('UPDATE apps SET teardown_started_at = NULL WHERE id = $1', [app.id]);
  const dbManager = require('../src/services/db-manager');
  t.mock.method(dbManager, 'dropDatabase', async () => {
    assert.ok((await pool.query('SELECT teardown_started_at FROM apps WHERE id = $1', [app.id])).rows[0].teardown_started_at,
      'marked before the database goes');
    throw new Error('drop refused');
  });
  const appFiles = require('../src/services/app-files');
  t.mock.method(appFiles, 'getStore', () => null);
  const realQuery = pool.query.bind(pool);
  const refusing = t.mock.method(pool, 'query', (sql, params) => (/^DELETE FROM apps/.test(sql) ? Promise.reject(new Error('delete refused')) : realQuery(sql, params)));
  await assert.rejects(teardown.teardownApp(pool, {}, app), /delete refused/);
  refusing.mock.restore();
  assert.ok((await pool.query('SELECT teardown_started_at FROM apps WHERE id = $1', [app.id])).rows[0].teardown_started_at, 'the mark stays');

  // Gone altogether: removed too.
  await pool.query('DELETE FROM apps WHERE id = $1', [app.id]);
  assert.equal(await teardown.removeRuntimeIfDeleted({}, pool, deployed), true);
  assert.deepEqual(dropped, [], 'no connection was dropped during the checks');
});
