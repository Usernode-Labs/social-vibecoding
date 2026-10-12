'use strict';

// The error lane's platform-fault rule against a real PostgreSQL
// (tests/platform-fault-retry.test.js pins its shape): storeChecks writes
// chat_sessions.check_error_platform, findStuckCheckSessions keeps such a row
// past CHECK_MAX_AUTO_RETRIES for a day from its first failure, and
// rearmPlatformFaults makes it due at boot.
//
// Skips when no postgres is reachable (TEST_DATABASE_URL, else DATABASE_URL,
// else localhost); a set TEST_DATABASE_URL that cannot be reached fails.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const visuals = require('../src/services/visuals');
const stagingRecovery = require('../src/services/staging-recovery');

const ROOT = path.join(__dirname, '..');
const SCHEMA_SQL = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';
const COLLISION = 'The unit suite could not start: a job with the same name was already there.';

// The smallest tables the statements read, with the failure-streak columns
// taken from schema.sql so a rename there fails here.
const STREAK_COLUMNS = SCHEMA_SQL.match(
  /^ALTER TABLE chat_sessions\s+ADD COLUMN IF NOT EXISTS (?:check_error_detail|consecutive_check_failures|first_check_failure_at|last_check_failure_at|check_next_retry_at|check_error_notified_at|check_error_platform)\b[^;]*;/gm
) || [];
const DDL = [
  'CREATE TABLE apps (id SERIAL PRIMARY KEY, slug TEXT, name TEXT, repo_url TEXT)',
  `CREATE TABLE chat_sessions (
     id SERIAL PRIMARY KEY, app_id INTEGER REFERENCES apps(id), status TEXT NOT NULL DEFAULT 'promoted',
     source TEXT NOT NULL DEFAULT 'native', branch_name TEXT, check_state TEXT, check_phase TEXT,
     checks_commit_sha TEXT, checks_checked_at TIMESTAMPTZ, checks_progress JSONB,
     test_results JSONB NOT NULL DEFAULT '[]', handoff_head_sha TEXT, handoff_uploaded_sha TEXT,
     handoff_upload_checked_sha TEXT, promoted_at TIMESTAMPTZ, last_activity_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ DEFAULT NOW())`,
  'CREATE TABLE check_runs (run_id TEXT PRIMARY KEY, session_id INTEGER, admitted_at TIMESTAMPTZ)',
  ...STREAK_COLUMNS,
].join(';\n');

async function connect() {
  let Client;
  try { ({ Client } = require('pg')); } catch { return null; }
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    try { await client.end(); } catch { /* never connected */ }
    return { error: err.message || err.code || String(err) };
  }
  return { client };
}

test('every failure-streak column comes from schema.sql', () => {
  assert.equal(STREAK_COLUMNS.length, 7);
});

test('a platform fault is retried past the cap for a day, any other error is not, and a boot makes it due', async (t) => {
  const conn = await connect();
  if (!conn) { t.skip('the pg driver is not installed in this environment'); return; }
  if (conn.error) {
    if (process.env.TEST_DATABASE_URL) throw new Error(`TEST_DATABASE_URL is set but unreachable: ${conn.error}`);
    t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
    return;
  }
  const { client } = conn;
  const schema = `platform_fault_retry_${process.pid}`;
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(DDL);
    const { rows: [app] } = await client.query("INSERT INTO apps (slug, name, repo_url) VALUES ('usernode-2d5619', 'Homeroom', '') RETURNING id");
    const session = async (sha) => (await client.query(
      `INSERT INTO chat_sessions (app_id, branch_name, check_state, checks_commit_sha, promoted_at)
       VALUES ($1, 'b', 'pending', $2, NOW()) RETURNING id`, [app.id, sha])).rows[0].id;
    const errorSix = async (id, sha, platformFault, detail) => {
      for (let i = 0; i < 6; i += 1) {
        assert.equal(await visuals.storeChecks(client, id, sha, { state: 'error', results: [], platformFault }, detail), true);
      }
      // Its scheduled retry has come.
      await client.query("UPDATE chat_sessions SET check_next_retry_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [id]);
    };
    const stuckIds = async () => (await stagingRecovery.findStuckCheckSessions({ pool: client, staleMs: 600000, maxAutoRetries: 6 }))
      .rows.map((r) => r.id);
    const row = async (id) => (await client.query('SELECT * FROM chat_sessions WHERE id = $1', [id])).rows[0];

    const platform = await session('sha-platform');
    const boot = await session('sha-boot');
    const old = await session('sha-old');
    await errorSix(platform, 'sha-platform', true, COLLISION);
    await errorSix(boot, 'sha-boot', false, 'The staging preview did not start.');
    await errorSix(old, 'sha-old', true, COLLISION);
    await client.query("UPDATE chat_sessions SET first_check_failure_at = NOW() - INTERVAL '25 hours' WHERE id = $1", [old]);

    const p = await row(platform);
    assert.equal(p.consecutive_check_failures, 6);
    assert.equal(p.check_error_platform, true);
    assert.equal((await row(boot)).check_error_platform, false);
    assert.deepEqual(await stuckIds(), [platform], 'past the cap only the platform fault inside its day is retried');
    assert.equal(stagingRecovery.errorWithinAutoRetries(p, { maxAutoRetries: 6 }), true, 'the code says the same');
    assert.equal(stagingRecovery.errorWithinAutoRetries(await row(boot), { maxAutoRetries: 6 }), false);
    assert.equal(stagingRecovery.errorWithinAutoRetries(await row(old), { maxAutoRetries: 6 }), false);

    // Waiting out its backoff, nothing picks it up, until a boot makes it due.
    await client.query("UPDATE chat_sessions SET check_next_retry_at = NOW() + INTERVAL '30 minutes'");
    assert.deepEqual(await stuckIds(), []);
    assert.deepEqual(await stagingRecovery.rearmPlatformFaults(client), [platform], 'only the platform fault inside its day');
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(await stuckIds(), [platform]);

    // Another error on the same head is that error, and stops at the cap.
    await visuals.storeChecks(client, platform, 'sha-platform', { state: 'error', results: [] }, 'The staging preview did not start.');
    assert.equal((await row(platform)).check_error_platform, false);
    // A verdict clears the streak and the flag.
    await visuals.storeChecks(client, platform, 'sha-platform', { state: 'error', results: [], platformFault: true }, COLLISION);
    await visuals.storeChecks(client, platform, 'sha-platform', { state: 'passing', results: [] });
    const done = await row(platform);
    assert.equal(done.check_state, 'passing');
    assert.equal(done.check_error_platform, false);
    assert.equal(done.consecutive_check_failures, 0);

    // A preview that has failed a thousand times still stores its error. The
    // backoff's power(2, n) overflowed past about 1,017 and threw the whole
    // write away (proposal 5638, 10 Oct 2026, rebuilt every few minutes).
    await assert.rejects(client.query('SELECT 120 * power(2, 1018::double precision) AS s'), /out of range/,
      'the expression as it was');
    const dead = await session('sha-dead');
    await client.query("UPDATE chat_sessions SET check_state = 'error', consecutive_check_failures = 1018 WHERE id = $1", [dead]);
    assert.equal(await visuals.storeChecks(client, dead, 'sha-dead', { state: 'error', results: [] }, 'The staging preview did not start.'), true);
    const d = await row(dead);
    assert.equal(d.consecutive_check_failures, 1019);
    const waitMin = (new Date(d.check_next_retry_at) - new Date(d.last_check_failure_at)) / 60000;
    assert.ok(Math.abs(waitMin - 30) < 0.1, `it waits the 30-minute ceiling: ${waitMin}`);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end().catch(() => {});
  }
});
