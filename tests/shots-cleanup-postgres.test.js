'use strict';

// Exercise the actual retry/retention SQL, including JSONB completion markers
// and retry ordering. All fixtures are temporary tables in a rolled-back tx.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const gc = require('../src/services/shots-gc');
const { RESOURCE_CLEANUP_VERSION } = require('../src/services/shots-environment');

test('terminal cleanup selection, retry backoff and retention against PostgreSQL', async (t) => {
  const client = new Client({
    connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
    connectionTimeoutMillis: 2000,
  });
  try { await client.connect(); } catch (error) {
    await client.end();
    if (process.env.TEST_DATABASE_URL) throw error;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  t.after(async () => { try { await client.query('ROLLBACK'); } finally { await client.end(); } });
  await client.query(`BEGIN;
    CREATE TEMP TABLE apps (id int PRIMARY KEY, slug text) ON COMMIT DROP;
    CREATE TEMP TABLE chat_sessions (id int PRIMARY KEY, app_id int, shots_run_id text) ON COMMIT DROP;
    CREATE TEMP TABLE shot_runs (
      id varchar(32) PRIMARY KEY, session_id int, state text, failure_code text,
      trace_summary jsonb, completed_at timestamptz, updated_at timestamptz
    ) ON COMMIT DROP;
    CREATE TEMP TABLE shot_artifacts (run_id varchar(32)) ON COMMIT DROP;
    INSERT INTO apps VALUES (1, 'demo');
    INSERT INTO chat_sessions VALUES (42, 1, repeat('7', 32));`);
  const id = (n) => n.toString(16).repeat(32);
  const old = new Date(Date.now() - 40 * 86_400_000);
  const fresh = new Date();
  const cases = [
    [1, 'cancelled', { cleanupComplete: true }, old, 'superseded'],
    [2, 'stale', { cleanupComplete: true, cleanupVersion: 1 }, old, 'evidence_run_interrupted'],
    [3, 'verified', null, old, null],
    [4, 'failed', null, old, 'another_failure'],
    [5, 'not_required', null, old, null],
    [6, 'overridden', null, old, null],
    [7, 'stale', { cleanupComplete: true, cleanupVersion: RESOURCE_CLEANUP_VERSION }, old, null],
    [8, 'exploring', null, fresh, null],
    [9, 'failed', null, fresh, 'shots_run_interrupted'],
    [10, 'failed', { cleanupAttemptAt: Date.now() }, old, null],
  ];
  for (const [n, state, trace, updated, failure] of cases) {
    await client.query('INSERT INTO shot_runs VALUES ($1, 42, $2, $3, $4, $5, $5)',
      [id(n), state, failure, trace, updated]);
  }
  const attempted = [];
  let unavailable = true;
  const options = { limit: 2, cleanup: async (_config, run) => {
    attempted.push(run.id);
    if (run.id === id(1) && unavailable) throw new Error('transient API failure');
    return [];
  } };
  const first = await gc.recoverInterrupted({}, client, options);
  assert.equal(first.cleanupRetried, 1);
  assert.deepEqual(attempted, [id(1), id(2)]);
  const { rows: [pending] } = await client.query('SELECT trace_summary FROM shot_runs WHERE id=$1', [id(1)]);
  assert.equal(pending.trace_summary.cleanupComplete, false);
  assert.ok(pending.trace_summary.cleanupAttemptAt > 0);

  attempted.length = 0;
  const next = await gc.recoverInterrupted({}, client, { ...options, limit: 100 });
  assert.equal(next.cleanupRetried, 4);
  assert.deepEqual(attempted, [3, 4, 5, 6].map(id), 'failed/recent/live/already-cleaned rows must not starve or join this batch');

  await gc.prune(client);
  const { rows: retained } = await client.query('SELECT id FROM shot_runs ORDER BY id');
  assert.ok(retained.some((row) => row.id === id(1)), 'unfinished cleanup keeps its durable row');
  assert.ok(!retained.some((row) => row.id === id(2)), 'old cleaned metadata is pruned');
  assert.ok(retained.some((row) => row.id === id(7)), 'current session-owned run is retained');

  unavailable = false;
  await client.query(`UPDATE shot_runs SET trace_summary = trace_summary
    || jsonb_build_object('cleanupAttemptAt', $2::bigint) WHERE id=$1`, [id(1), Date.now() - 600_000]);
  attempted.length = 0;
  const retry = await gc.recoverInterrupted({}, client, options);
  assert.equal(retry.cleanupRetried, 1);
  assert.deepEqual(attempted, [id(1)]);
  const { rows: [done] } = await client.query('SELECT trace_summary FROM shot_runs WHERE id=$1', [id(1)]);
  assert.equal(done.trace_summary.cleanupComplete, true);
  assert.equal(done.trace_summary.cleanupVersion, RESOURCE_CLEANUP_VERSION);
});
