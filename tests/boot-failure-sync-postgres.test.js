'use strict';

// services/boot-failure-sync.js against the FULL PostgreSQL schema: the row
// its plan reads, and the once-per-head stamp it honours. The sync itself
// and the stamp's write are the proposal machine's
// (tests/workflow-merge-postgres.test.js M8). The mirror is stubbed.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const subject = require('../src/services/boot-failure-sync');

const HEAD = 'a'.repeat(40);
const MERGED = 'b'.repeat(40);

test('a proposal is synced once for a head, and only while it is the head', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `boot_sync_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [user] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('evan', 'x') RETURNING id`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Homeroom', 'usernode-2d5619', 'running', $1) RETURNING id`,
    ['https://github.com/Usernode-Labs/social-vibecoding'],
  );
  const { rows: [session] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, source, checks_commit_sha, check_state)
     VALUES ($1, $2, 'dev/cli-u1-test-phone-sign-ins-1007', 'promoted', 'cli_handoff', $3, 'error') RETURNING id`,
    [app.id, user.id, HEAD],
  );

  const synced = [];
  const deps = {
    integration: { measure: async () => ({ headSha: HEAD, behindBy: 2, mergesClean: true }) },
    syncMain: {
      runSyncMain: async (_config, _pool, id, opts) => {
        synced.push({ id, opts });
        return { ok: true, syncResult: 'clean', pushOk: true, sha: MERGED };
      },
    },
    activeWorkers: { isSessionBusy: () => false },
    mergeQueue: { isIntegratingSession: () => false },
    votes: () => ({ reconcileNativeReviewedHead: async () => ({}) }),
    sleep: async () => {},
    now: () => 0,
  };

  const found = await subject.plan({ pool, sessionId: session.id, commitHash: HEAD }, deps);
  assert.equal(found.sync, true, 'the real row reads as promoted, native, on the failed head');
  assert.equal(found.row.repo_url, 'https://github.com/Usernode-Labs/social-vibecoding', 'with its app\'s repo');

  // The stamp the proposal machine writes with the sync: a second failure on
  // the same head waits for a person.
  await pool.query('UPDATE chat_sessions SET boot_failure_sync_head = $2 WHERE id = $1', [session.id, HEAD]);
  assert.equal((await subject.plan({ pool, sessionId: session.id, commitHash: HEAD }, deps)).why, 'already_tried');

  // A head that is no longer the checked one is not synced.
  await pool.query('UPDATE chat_sessions SET checks_commit_sha = $2, boot_failure_sync_head = NULL WHERE id = $1', [session.id, MERGED]);
  assert.equal((await subject.plan({ pool, sessionId: session.id, commitHash: HEAD }, deps)).why, 'head_moved');

  // A draft is never synced.
  await pool.query(`UPDATE chat_sessions SET status = 'active', checks_commit_sha = $2 WHERE id = $1`, [session.id, HEAD]);
  assert.equal((await subject.plan({ pool, sessionId: session.id, commitHash: HEAD }, deps)).why, 'not_promoted');
  void synced;
});
