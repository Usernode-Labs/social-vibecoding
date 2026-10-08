'use strict';

// The workflow worker (workflow-worker.js): the platform runtime started in
// worker mode runs the loops and no pipeline slots, so what it appends waits
// for a web process's slots, and it records no booted build, since it serves
// none. Against the full PostgreSQL schema.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the platform runtime in worker mode', { timeout: 60000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_worker_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const id = require.resolve('../src/db/pool');
  require.cache[id] = { id, filename: id, loaded: true, exports: { getPool: () => pool }, paths: [] };

  const config = {
    databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfGovernanceEnabled: true,
    wfPoolMax: 4, wfSlots: 2, wfOwnershipMode: 'raise',
  };
  const platform = require('../src/workflow/platform.ts');
  const gitSha = process.env.GIT_SHA;
  process.env.GIT_SHA = 'a'.repeat(40);
  t.after(async () => {
    if (gitSha === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = gitSha;
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ('author', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, self_hosted) VALUES ('Homeroom', 'homeroom', $1, TRUE) RETURNING *`, [u.id]);
  const { rows: [issue] } = await pool.query(
    `INSERT INTO issues (app_id, kind, status, title, payload, created_by)
     VALUES ($1, 'secret_change', 'open', 'Set KEY', '{"key":"KEY"}', $2) RETURNING id`, [app.id, u.id]);
  const filed = async () => (await pool.query(
    `SELECT status FROM wf_events WHERE type = 'Filed' AND key = $1`, [`issue:${issue.id}`])).rows[0]?.status;
  const booted = async () => (await pool.query('SELECT booted_shas FROM apps WHERE id = $1', [app.id])).rows[0].booted_shas;

  await t.test('the worker runs the loops, applies nothing, and records no booted build', async () => {
    await platform.startWorkflow(config, { loops: true, worker: true });
    assert.ok(platform.workflowRunning());
    // The loops' backfill enrolls the open proposal; no slot here applies it.
    const started = Date.now();
    while (!(await filed())) {
      assert.ok(Date.now() - started < 5000, 'the backfill appended Filed');
      await sleep(50);
    }
    await sleep(500);
    assert.equal(await filed(), 'pending', 'left for a web process\'s slots');
    assert.deepEqual(await booted(), [], 'the worker serves no build');
    await platform.stopWorkflow();
  });

  await t.test('a web process applies it, and records the build it booted', async () => {
    await platform.startWorkflow(config, { loops: false });
    const started = Date.now();
    while ((await filed()) !== 'processed') {
      assert.ok(Date.now() - started < 5000, 'applied by the web process\'s slots');
      await sleep(50);
    }
    assert.deepEqual((await booted()).map((b) => b.sha), ['a'.repeat(40)]);
  });
});

test('the worker entry point starts the loops and publishes, and serves no app', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'workflow-worker.js'), 'utf8');
  assert.match(src, /startWorkflow\(config, \{ loops: true, worker: true \}\)/);
  assert.match(src, /ws\.startPublisher\(config\)/, 'what it broadcasts reaches the web Pods');
  assert.match(src, /bootstrap\.initServices\(config\)/);
  assert.match(src, /bootstrap\.registerHooks\(config\)/);
  assert.doesNotMatch(src, /require\('express'\)|ws\.attach\(|becomeLeader|createLeadership/, 'no app, no sockets, no election');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /if \(config\.wfLoops !== 'worker'\) \{\s*\n\s*await require\('\.\/src\/workflow\/platform\.ts'\)\.startWorkflowLoops\(\)/,
    'the leader leaves the loops to the worker');
});
