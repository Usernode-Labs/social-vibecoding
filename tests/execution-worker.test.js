'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createExecutionDatabase } = require('./lib/execution-database');
const { createSessionDecisionRuntime } = require('../src/services/decision-runtime');
const { createExecutionStore } = require('../src/services/execution/store');
const { createExecutionWorker, retryDelay } = require('../src/services/execution/worker');
const { createPreviewFlow } = require('../src/services/preview-flow/store');

const databaseUrl = process.env.PREVIEW_FLOW_TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;

async function fixture(t) {
  const db = await createExecutionDatabase(databaseUrl);
  t.after(() => db.close());
  const runtime = createSessionDecisionRuntime(db.pool);
  const store = createExecutionStore(db.pool, { leaseMs: 1000 });
  await db.pool.query("INSERT INTO chat_sessions (id, checks_commit_sha) VALUES (1, $1)", ['a'.repeat(40)]);
  async function enqueue(input = {}) {
    return runtime.transact(transaction => store.enqueue(transaction, {
      id: randomUUID(), effectKey: randomUUID(), sessionId: 1, workflow: 'fixture', version: 1,
      causedBy: randomUUID(), input,
    }));
  }
  return { ...db, runtime, store, enqueue };
}

test('execution backoff is bounded without discarding pending work', () => {
  assert.equal(retryDelay(1, 1000, 60000), 1000);
  assert.equal(retryDelay(1000000, 1000, 60000), 60000);
});

test('real PostgreSQL: stable admission, claims, interruption and stale completion fencing', { skip: !databaseUrl }, async t => {
  const { pool, store, runtime } = await fixture(t);
  const request = { id: randomUUID(), effectKey: 'effect', sessionId: 1, workflow: 'fixture', version: 1,
    causedBy: randomUUID(), input: { head: 'pinned' } };
  const first = await runtime.transact(tx => store.enqueue(tx, request));
  const duplicate = await runtime.transact(tx => store.enqueue(tx, { ...request, id: randomUUID() }));
  assert.equal(duplicate.id, first.id);
  await assert.rejects(runtime.transact(tx => store.enqueue(tx, { ...request, input: { head: 'different' } })));
  const claims = await Promise.all([store.claim(randomUUID(), ['fixture']), store.claim(randomUUID(), ['fixture'])]);
  assert.equal(claims.flat().length, 1);
  const old = claims.flat()[0];
  await store.checkpoint(old, { creationStarted: true });
  await pool.query("UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL '1 second'");
  assert.equal(await store.renew(old), false);
  const [next] = await store.claim(randomUUID(), ['fixture']);
  assert.notEqual(old.claim_id, next.claim_id);
  assert.equal(next.id, old.id);
  assert.deepEqual(next.checkpoint, { creationStarted: true });
  let called = false;
  assert.deepEqual(await store.settle(old, { outcome: 'succeeded' }, () => { called = true; }), { lostClaim: true });
  assert.equal(called, false);
  await store.settle(next, { outcome: 'succeeded' });
  assert.deepEqual((await pool.query('SELECT outcome FROM execution_work_attempts ORDER BY number')).rows.map(row => row.outcome),
    ['interrupted', 'succeeded']);
  assert.deepEqual((await store.trace(next.id)).map(row => row.kind), ['admitted', 'claimed', 'checkpoint', 'claimed', 'settled']);
});

test('real PostgreSQL: caught mapping error rolls back earlier domain decisions and settlement journals', { skip: !databaseUrl }, async t => {
  const { pool, store, enqueue } = await fixture(t);
  await enqueue();
  const [attempt] = await store.claim(randomUUID(), ['fixture']);
  const owner = createPreviewFlow(pool);
  await assert.rejects(store.settle(attempt, { outcome: 'succeeded' }, async transaction => {
    await owner.applyInTransaction(transaction, { type: 'RequestPreview', actionId: randomUUID(), sessionId: 1,
      headSha: 'a'.repeat(40), startedStatus: 'active' });
    try {
      await transaction.withSession(1, async client => {
        await client.query("UPDATE chat_sessions SET staging_url = 'https://wrong.test' WHERE id = 1");
        throw new Error('Mapping wrote then failed');
      });
    } catch {}
    return { outcome: 'succeeded' };
  }), /transaction|failed|committable/i);
  assert.equal((await pool.query('SELECT staging_url FROM chat_sessions')).rows[0].staging_url, 'https://serving.test');
  assert.equal((await store.read(attempt.id)).status, 'running');
  assert.equal((await pool.query('SELECT * FROM preview_flow_decisions')).rowCount, 0);
  assert.equal((await pool.query('SELECT * FROM preview_action_receipts')).rowCount, 0);
  assert.equal((await pool.query("SELECT * FROM execution_work_events WHERE kind = 'settled'")).rowCount, 0);
});

test('real PostgreSQL: more than one batch progresses while oldest work fails or remains busy', { skip: !databaseUrl }, async t => {
  const { pool, store, enqueue } = await fixture(t);
  const work = [];
  for (let index = 0; index < 34; index++) work.push(await enqueue({ index }));
  const [firstBatch, competingBatch] = await Promise.all([
    store.claim(randomUUID(), ['fixture'], 25), store.claim(randomUUID(), ['fixture'], 25),
  ]);
  assert.equal(firstBatch.length + competingBatch.length, 34);
  for (const attempt of [...firstBatch, ...competingBatch]) {
    await store.settle(attempt, { outcome: attempt.input.index < 25 ? 'retry' : 'succeeded', code: 'fixture', delayMs: 100 });
  }
  const arrival = await enqueue({ index: 34 });
  await pool.query("UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE status = 'queued'");
  const batch = await store.claim(randomUUID(), ['fixture'], 25);
  assert.equal(batch.length, 25);
  for (const attempt of batch) await store.settle(attempt, { outcome: 'waiting', code: 'resource_busy', delayMs: 100 });
  const later = await store.claim(randomUUID(), ['fixture'], 25);
  assert.ok(later.some(row => row.id === arrival.id), 'new work is reachable beyond repeatedly pending oldest batch');
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM execution_work_requests WHERE status != 'succeeded'")).rows[0].count, 26);
  await pool.query("UPDATE execution_work_requests SET due_at = clock_timestamp(), lease_until = CASE WHEN claim_id IS NULL THEN NULL ELSE clock_timestamp() - INTERVAL '1 second' END WHERE status != 'succeeded'");
  const retry = await store.claim(randomUUID(), ['fixture'], 32);
  assert.equal(retry.length, 26, 'early obligations remain retryable');
});

test('real PostgreSQL: overlapping polls respect concurrency and long work does not block another slot', { skip: !databaseUrl }, async t => {
  const { store, enqueue } = await fixture(t);
  for (let index = 0; index < 6; index++) await enqueue({ index });
  let release;
  const busy = new Promise(resolve => { release = resolve; });
  let completed = 0;
  const worker = createExecutionWorker({ store, concurrency: 2, handlers: { fixture: { version: 1,
    async run({ attempt }) {
      if (attempt.input.index === 0) await busy;
      else completed++;
      return { outcome: 'succeeded' };
    },
  } } });
  t.after(async () => { release(); await worker.drain(); });
  await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
  assert.ok(worker.activeCount() <= 2);
  for (let index = 0; index < 30 && completed < 5; index++) {
    await new Promise(resolve => setTimeout(resolve, 15));
    await worker.tick();
  }
  assert.equal(completed, 5);
  release();
  await worker.drain();
});

test('real PostgreSQL: queue persists retry classes, blocks unknown versions, and retains timed-out ownership', { skip: !databaseUrl }, async t => {
  const { pool, store, runtime, enqueue } = await fixture(t);
  const failed = await enqueue({ mode: 'error' });
  const unknown = await runtime.transact(transaction => store.enqueue(transaction, {
    id: randomUUID(), effectKey: randomUUID(), sessionId: 1, workflow: 'fixture', version: 2,
    causedBy: randomUUID(), input: { mode: 'unknown' },
  }));
  const hanging = await enqueue({ mode: 'hang' });
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let timeoutObserved;
  const timeout = new Promise(resolve => { timeoutObserved = resolve; });
  const worker = createExecutionWorker({ store, concurrency: 3, attemptTimeoutMs: 100,
    retryMinimumMs: 100, retryMaximumMs: 100,
    onUnresponsive: timeoutObserved,
    handlers: { fixture: { version: 1, async run({ attempt }) {
      if (attempt.input.mode === 'error') throw new Error('secret-that-must-not-be-stored');
      if (attempt.input.mode === 'hang') await hold;
      return { outcome: 'succeeded' };
    } } },
  });
  t.after(async () => { release(); await worker.drain(); });
  await worker.tick();
  await timeout;
  assert.equal((await store.read(failed.id)).last_code, 'execution_retry');
  assert.equal((await store.read(unknown.id)).status, 'blocked');
  assert.equal((await store.read(unknown.id)).last_code, 'unsupported_contract');
  assert.equal((await store.read(hanging.id)).status, 'running', 'timeout requests abort without settling while callback lives');
  assert.equal((await pool.query("SELECT * FROM execution_work_events WHERE detail::text LIKE '%secret-that%'")).rowCount, 0);
  release();
  await worker.drain();
  assert.equal((await store.read(hanging.id)).status, 'running', 'restart must reclaim and reconcile the abandoned claim');
});
