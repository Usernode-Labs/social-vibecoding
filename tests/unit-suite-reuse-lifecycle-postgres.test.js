'use strict';

// services/visuals.js requestOwedFreshRun with the preview lifecycle on: the
// run a person asked for, started after a run that copied a unit-suite pass
// had its verdict refused, must leave the finishing run's lifecycle operation
// and its guarded pool, or it is cancelled with it and nothing runs.
//
// A file of its own: db/pool.js keeps ONE process-wide pool, created by the
// first getPool call, and this test needs it to point at its own database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const reuse = require('../src/services/unit-suite-reuse');
const visuals = require('../src/services/visuals');

const SHA = 'a'.repeat(40);
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'src/db/schema.sql'), 'utf8');

async function fullSchemaDb(t) {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { t.skip('the pg driver is not installed in this environment'); return null; }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end().catch(() => {});
    t.skip(`no postgres reachable at ${DSN}: ${err.message || err.code}`);
    return null;
  }
  const dbName = `unit_suite_lc_${process.pid}`;
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN);
  url.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: url.toString(), max: 3 });
  await pool.query(SCHEMA_SQL);
  t.after(async () => {
    await pool.end().catch(() => {});
    await require('../src/db/pool').getPool({}).end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  return { pool, url: url.toString() };
}

test('postgres, preview lifecycle on: the owed run after a refused copied verdict leaves the finishing run\'s operation', async (t) => {
  const db = await fullSchemaDb(t);
  if (!db) return;
  const { pool } = db;
  const savedRuntime = process.env.APP_RUNTIME;
  const savedFlag = process.env.PREVIEW_LIFECYCLE_ENABLED;
  process.env.APP_RUNTIME = 'kubernetes';
  process.env.PREVIEW_LIFECYCLE_ENABLED = 'true';
  t.after(() => {
    if (savedRuntime === undefined) delete process.env.APP_RUNTIME; else process.env.APP_RUNTIME = savedRuntime;
    if (savedFlag === undefined) delete process.env.PREVIEW_LIFECYCLE_ENABLED; else process.env.PREVIEW_LIFECYCLE_ENABLED = savedFlag;
  });
  const lifecycle = require('../src/services/preview-lifecycle');
  const recovery = require('../src/services/staging-recovery');
  const kubernetesMod = require('../src/services/kubernetes');
  t.mock.method(kubernetesMod, 'stopCheckJobs', async () => []);
  t.mock.method(kubernetesMod, 'deleteRunCheckJobs', async () => 0);
  t.mock.method(kubernetesMod, 'cancelPreviewChecks', async () => 0);
  t.mock.method(kubernetesMod, 'findCheckJobs', async () => ({}));
  const { rows: [app] } = await pool.query("INSERT INTO apps (slug, name, repo_url) VALUES ('lc-test', 'T', 'https://github.com/o/r') RETURNING id, slug, name, repo_url");
  const { rows: [u] } = await pool.query("INSERT INTO users (username, password) VALUES ('lc-test', 'x') RETURNING id");
  const { rows: [s] } = await pool.query(
    "INSERT INTO chat_sessions (user_id, app_id, status, source, checks_commit_sha, check_state) VALUES ($1, $2, 'promoted', 'cli_handoff', $3, 'pending') RETURNING *",
    [u.id, app.id, SHA]);
  await reuse.markFreshOwed(pool, { sessionId: s.id, commitSha: SHA });
  const cfg = { appRuntime: 'kubernetes', databaseUrl: db.url, kubernetes: {} };
  const seen = [];
  t.mock.method(recovery, 'recheckSessionChecks', async (args) => {
    seen.push({ reason: args.reason, insideOldRun: !!lifecycle.current(), basePool: args.pool === require('../src/db/pool').getPool(cfg) });
  });
  // The run that copied a pass settles inside its own lifecycle operation,
  // on that operation's guarded pool.
  let operationPool = null;
  await lifecycle.run(cfg, s, SHA, 'capture', async (operation) => {
    operationPool = operation.pool;
    assert.ok(lifecycle.current(), 'inside the finishing run');
    await visuals.requestOwedFreshRun(cfg, operation.pool, s, SHA);
    return { state: 'pending' };
  }, { force: true });
  for (let i = 0; i < 100 && !seen.length; i += 1) await new Promise((res) => setTimeout(res, 10));
  assert.ok(operationPool);
  assert.deepEqual(seen, [{ reason: 'manual-recheck', insideOldRun: false, basePool: true }]);
});
