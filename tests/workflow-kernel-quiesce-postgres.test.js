'use strict';

// The workflow kernel's quiesce (src/workflow/kernel/index.ts), against the
// full PostgreSQL schema: what a process a release replaced does while it
// finishes its work (docs/plans/draining-releases.md). Its loops end, so it
// applies no event, fires no timer and claims no work item, and the work it
// is running goes on, its lease renewed, to the end; its result is applied by
// whichever process still runs slots.
//
// Skipped when no server is reachable, required when TEST_DATABASE_URL is set.
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/workflow-kernel-quiesce-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime, defineMachine, NONE, ok } = require('../src/workflow/kernel/index.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, { timeoutMs = 10000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

// kq-job: Start emits one work item, its result ends the job.
function job() {
  return defineMachine({
    name: 'kq-job',
    version: 1,
    events: { Start: (p) => p || {} },
    create: ['Start'],
    terminal: ['done'],
    decode: (row) => ({ name: row.state, data: row.data }),
    authorize: { Start: () => ok() },
    transitions: {
      [NONE]: { Start: { to: () => ({ next: { name: 'running', data: {} }, work: [{ kind: 'kq.slow', key: 'w', input: {} }] }) } },
      running: {
        Start: { ignore: 'started' },
        WorkSucceeded: { to: (_s, e) => ({ next: { name: 'done', data: { result: e.payload.result } } }) },
        WorkFailed: { to: () => ({ next: { name: 'done', data: { failed: true } } }) },
        WorkExhausted: { to: () => ({ next: { name: 'done', data: { failed: true } } }) },
      },
      done: { '*': { ignore: 'ended' } },
    },
  });
}

test('a quiesced runtime claims nothing new and finishes the work it runs', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'kq_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 10 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('ownership_mode', 'log') ON CONFLICT (key) DO NOTHING`);

  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  const ran = [];
  const handler = (who) => ({
    leaseMs: 1500,
    async run({ key, signal }) {
      ran.push(`${who}:${key}`);
      if (who === 'old') await firstGate;
      if (signal.aborted) throw new Error('aborted');
      return { by: who };
    },
  });
  const old = createRuntime({ pool, machines: [job()], services: { 'kq.slow': handler('old') }, slots: 1, pollMs: 50 });
  const fresh = createRuntime({ pool, machines: [job()], services: { 'kq.slow': handler('new') }, slots: 1, pollMs: 50 });
  t.after(async () => {
    releaseFirst();
    await old.stop().catch(() => {});
    await fresh.stop().catch(() => {});
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  // The old process leads and claims the first job's work.
  await old.start({ loops: true });
  await old.append('kq-job', 'one', { type: 'Start' }, { requestKey: 'start:one', source: { kind: 'system' } });
  await until(() => ran.includes('old:w') && old.running() === 1, { label: 'the old process running the first job' });

  // A release: the old process quiesces, the new one leads.
  await old.quiesce();
  assert.equal(old.running(), 1, 'its work goes on');
  await fresh.start({ loops: true });
  await fresh.append('kq-job', 'two', { type: 'Start' }, { requestKey: 'start:two', source: { kind: 'system' } });
  await until(async () => {
    const { rows } = await pool.query(`SELECT state FROM wf_instances WHERE machine = 'kq-job' AND key = 'two'`);
    return rows[0]?.state === 'done';
  }, { label: 'the new process finishing the second job' });
  assert.deepEqual(ran.filter((r) => r.endsWith(':w')), ['old:w', 'new:w'], 'the new job went to the new process');

  // The old process's lease outlives several lease periods: nobody took it.
  await sleep(4000);
  const { rows: [held] } = await pool.query(
    `SELECT status, attempt_count FROM wf_work WHERE machine = 'kq-job' AND key = 'one'`);
  assert.equal(held.status, 'running');
  assert.equal(held.attempt_count, 1, 'its lease was renewed, so the new process never claimed it');

  // It finishes; its result is applied by the new process's slots.
  releaseFirst();
  await until(() => old.running() === 0, { label: 'the old process done with its work' });
  await until(async () => {
    const { rows } = await pool.query(`SELECT state, data FROM wf_instances WHERE machine = 'kq-job' AND key = 'one'`);
    return rows[0]?.state === 'done' && rows[0].data?.result?.by === 'old';
  }, { label: 'the first job ended with the old process\'s result' });
});
