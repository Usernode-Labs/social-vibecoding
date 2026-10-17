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

test('the teardown mark is on the row, read by a deploy in any process', async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `teardown_mark_${crypto.randomBytes(5).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 3 });
  t.after(async () => {
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

  // A teardown that fails at its first step clears its mark: the app is as
  // it was.
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
  assert.deepEqual(removed, ['usernode-app-mark-app']);
  assert.equal(await teardown.isTearingDown(pool, { id: app.id }), true);
  assert.equal(await teardown.isTearingDown(pool, (await pool.query('SELECT * FROM apps WHERE id = $1', [app.id])).rows[0]), true);

  // Gone altogether: removed too.
  await pool.query('DELETE FROM apps WHERE id = $1', [app.id]);
  assert.equal(await teardown.removeRuntimeIfDeleted({}, pool, deployed), true);
});
