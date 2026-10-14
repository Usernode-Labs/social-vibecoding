'use strict';

// The stale-preview pass (services/staging-reap.js) against the full
// PostgreSQL schema: classify reads whether a session's checks run is on the
// cluster (a check_runs row), and selectStale leaves that preview alone until
// the run settles. tests/staging-reap.test.js has the rest with a fake pool.
//
// A boot runs the pass while the harvest (services/check-harvest.js) seats
// the old leader's runs, and their capture Jobs run against the preview.
//
// Skips when no postgres is reachable; set TEST_DATABASE_URL to require it.
//
// Run with: node --test tests/staging-reap-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const reap = require('../src/services/staging-reap');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a preview whose checks run is on the cluster is not out of date enough to take', { timeout: 60000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'staging_reap_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  // An idle client the server drops (the database is dropped WITH (FORCE)
  // below) is not this test's failure.
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ('reaper', 'x') RETURNING id`);
  const { rows: [a] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, repo_url) VALUES ('Pond', 'pond', $1, 'https://github.com/acme/pond') RETURNING id`, [u.id]);
  const session = async () => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, staging_runtime_kind, staging_runtime_name)
     VALUES ($1, $2, 'active', 'kubernetes', 'preview-' || md5(random()::text)) RETURNING id, staging_runtime_name`,
    [a.id, u.id])).rows[0];
  const checking = await session();
  const idle = await session();
  // A run whose process died: its owner handed it over, and the harvest has
  // not read its Jobs yet.
  await pool.query(
    `INSERT INTO check_runs (run_id, session_id, commit_sha, owner, manifest, heartbeat_at)
     VALUES ($1, $2, $3, 'platform-old:1:exited', '{"launched": true}', 'epoch')`,
    [crypto.randomUUID(), checking.id, 'a'.repeat(40)]);

  const preview = (s) => ({ name: s.staging_runtime_name, slug: null, sessionId: s.id, state: 'running', fingerprint: 'stale', runtimeKind: 'kubernetes' });
  let items = await reap.classify(pool, [preview(checking), preview(idle)]);
  assert.deepEqual(items.map((i) => [i.sessionId, i.session.check_run_open]), [[checking.id, true], [idle.id, false]]);
  assert.deepEqual(reap.selectStale(items, 'current').map((i) => i.sessionId), [idle.id],
    'the preview its capture runs against is left alone');

  // The run settles (check-runs.finish): the next pass takes it.
  await pool.query('DELETE FROM check_runs WHERE session_id = $1', [checking.id]);
  items = await reap.classify(pool, [preview(checking), preview(idle)]);
  assert.deepEqual(reap.selectStale(items, 'current').map((i) => i.sessionId).sort(), [checking.id, idle.id].sort());
});
