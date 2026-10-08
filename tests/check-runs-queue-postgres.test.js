'use strict';

// The check-run queue (#4317), executed by a REAL postgres
// (services/check-runs.js).
//
// A burst of wanted check runs larger than the cluster can run must end with
// every run granted in turn: at most MAX_CONCURRENT in flight at once, FIFO
// within each priority group, proposals up for a vote (promoted / merging)
// ahead of drafts, a draft that has waited past the age cap ranked with
// them, a newer commit replacing its session's queued run while keeping its
// place, and a refused run held back by retry_at.
//
// Skips when no postgres is reachable (TEST_DATABASE_URL, else
// DATABASE_URL, else localhost).
//
// Run with: node --test tests/check-runs-queue-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const checkRuns = require('../src/services/check-runs');

const ROOT = path.join(__dirname, '..');
const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

// check_runs as schema.sql declares it: the CREATE TABLE block, less the
// foreign key, then the queue columns the table gained later (they live in
// idempotent ALTERs beside it, the repo's convention for later columns) and
// the queue index.
const SCHEMA_SQL = (() => {
  const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS check_runs');
  if (start < 0) throw new Error('check_runs is not in schema.sql any more');
  const end = schema.indexOf(');', start) + 2;
  const alters = schema.split('\n')
    .filter((l) => l.startsWith('ALTER TABLE check_runs ADD COLUMN IF NOT EXISTS'));
  if (alters.length < 4) throw new Error('the check_runs queue columns are not in schema.sql any more');
  return [schema.slice(start, end)
    .replace('IF NOT EXISTS ', '')
    .replace(/\s*REFERENCES chat_sessions\(id\) ON DELETE CASCADE/, ''), ...alters].join('\n');
})();
const INDEX_SQL = (() => {
  const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
  const line = schema.split('\n').find((l) => l.includes('idx_check_runs_queue'));
  if (!line) throw new Error('idx_check_runs_queue is not in schema.sql any more');
  return line.trim().replace('IF NOT EXISTS ', '');
})();

async function connect() {
  let Client;
  try { ({ Client } = require('pg')); } catch { return { noDriver: true }; }
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    try { await client.end(); } catch { /* never connected */ }
    return { error: err.message || err.code || String(err) };
  }
  return { client };
}

// dispatch() goes through pool.connect() and calls release() on what it
// hands back; the other queue functions call pool.query directly. A thin
// adapter over one real client satisfies both, so every query here still
// runs against postgres itself.
function asPool(client) {
  return {
    query: (...args) => client.query(...args),
    connect: async () => ({
      query: (...args) => client.query(...args),
      release: () => {},
    }),
  };
}

let schemaNo = 0;

// A fresh schema per test: chat_sessions (its status column only) and
// check_runs with its queue index.
async function withSchema(client, fn) {
  const name = `check_runs_queue_test_${process.pid}_${++schemaNo}`;
  await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await client.query(`CREATE SCHEMA ${name}`);
  try {
    await client.query(`SET search_path TO ${name}`);
    await client.query('CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, status VARCHAR(16))');
    await client.query(SCHEMA_SQL);
    await client.query(INDEX_SQL);
    return await fn();
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => {});
    await client.query('SET search_path TO public').catch(() => {});
  }
}

async function seedSession(pool, id, status) {
  await pool.query('INSERT INTO chat_sessions (id, status) VALUES ($1, $2)', [id, status]);
}

// record() then enqueue(): a run in line, the way waitForSlot does it.
async function queueRun(pool, sessionId, commitSha = 'abc123') {
  const runId = randomUUID();
  await checkRuns.record(pool, { runId, sessionId, commitSha, manifest: { launched: true } });
  await checkRuns.enqueue(pool, runId, sessionId);
  return runId;
}

async function stateOf(pool, runId) {
  const { rows: [row] = [] } = await pool.query('SELECT state FROM check_runs WHERE run_id = $1', [runId]);
  return row ? row.state : null;
}

// finish() hands its slot on with a fire-and-forget dispatch, so the tests
// drive dispatch themselves until the expected row is running (or the queue
// is empty) instead of reading one call's return value.
async function drain(pool) {
  for (let i = 0; i < 5; i += 1) await checkRuns.dispatch(pool);
}

test('dispatch grants at most the limit: votes first, then drafts in arrival order', async (t) => {
  const conn = await connect();
  if (conn.noDriver) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  const pool = asPool(client);
  try {
    await withSchema(client, async () => {
      const limit = checkRuns.MAX_CONCURRENT;
      assert.ok(limit >= 2, 'the default limit leaves room to prove ordering');

      // Three drafts first, then a promoted, a merging, and drafts again.
      await seedSession(pool, 1, 'active');
      await seedSession(pool, 2, 'active');
      await seedSession(pool, 3, 'active');
      await seedSession(pool, 4, 'promoted');
      await seedSession(pool, 5, 'merging');
      await seedSession(pool, 6, 'active');

      const r1 = await queueRun(pool, 1);
      const r2 = await queueRun(pool, 2);
      const r3 = await queueRun(pool, 3);
      const r4 = await queueRun(pool, 4);
      const r5 = await queueRun(pool, 5);
      const r6 = await queueRun(pool, 6);

      assert.equal(await stateOf(pool, r1), 'queued');
      assert.equal(await stateOf(pool, r4), 'queued');

      // First dispatch: exactly `limit` slots, the two votes ahead of every
      // draft, the drafts in arrival order.
      const granted = await checkRuns.dispatch(pool);
      assert.equal(granted.length, limit);
      const expectedFirst = [r4, r5, r1, r2].slice(0, limit);
      assert.deepEqual([...granted].sort(), [...expectedFirst].sort());
      assert.equal(await stateOf(pool, r4), 'running');
      assert.equal(await stateOf(pool, r6), 'queued');

      // The queue snapshot lists what is still waiting, in dispatch order,
      // from 1.
      const snap = await checkRuns.queueSnapshot(pool);
      const wantOrder = [r4, r5, r1, r2, r3, r6].filter((id) => !granted.includes(id));
      assert.deepEqual(snap.map((s) => s.runId), wantOrder);
      assert.deepEqual(snap.map((s) => s.position), wantOrder.map((_, i) => i + 1));

      // The admin card's numbers.
      const stats = await checkRuns.queueStats(pool);
      assert.deepEqual(
        { running: stats.running, limit: stats.limit, queued: stats.queued },
        { running: limit, limit, queued: 6 - limit },
      );
      assert.equal(typeof stats.oldestWaitSeconds, 'number');
      assert.ok(stats.oldestWaitSeconds >= 0);
    });
  } finally {
    await client.end();
  }
});

test('finish hands the slot on; a legacy NULL row still occupies one; retry_at holds a refused run back', async (t) => {
  const conn = await connect();
  if (conn.noDriver) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  const pool = asPool(client);
  try {
    await withSchema(client, async () => {
      for (let id = 1; id <= 6; id += 1) await seedSession(pool, id, 'active');

      const r1 = await queueRun(pool, 1);
      const r2 = await queueRun(pool, 2);
      const r3 = await queueRun(pool, 3);
      const r4 = await queueRun(pool, 4);
      const r5 = await queueRun(pool, 5);

      const first = await checkRuns.dispatch(pool);
      assert.equal(first.length, checkRuns.MAX_CONCURRENT);
      assert.ok(!first.includes(r5), 'the run past the limit stays queued');

      // A legacy row (state NULL, written before the queue existed) occupies
      // a slot: it counts as running until it settles.
      await pool.query('UPDATE check_runs SET state = NULL WHERE run_id = $1', [first[0]]);

      // Settle one granted run: its slot is freed and handed on, and the
      // waiting run takes it.
      await checkRuns.finish(pool, first[1]);
      await drain(pool);
      assert.equal(await stateOf(pool, r5), 'running', 'the freed slot goes to the next run in line');

      // Three real running rows plus the NULL legacy row: the limit is
      // reached, so a newly queued run is not granted.
      const running = await pool.query(
        `SELECT COUNT(*)::int AS n FROM check_runs
          WHERE state = 'running' OR state IS NULL`
      );
      assert.equal(running.rows[0].n, checkRuns.MAX_CONCURRENT);
      const late = await queueRun(pool, 6);
      const granted = await checkRuns.dispatch(pool);
      assert.ok(!granted.includes(late), 'the legacy NULL row still occupies its slot');

      // Settle the legacy row; the late run starts.
      await checkRuns.finish(pool, first[0]);
      await drain(pool);
      assert.equal(await stateOf(pool, late), 'running', 'the slot is freed when the legacy row settles');

      // A refused run is held back: requeue puts it back in line behind a
      // retry pause, and it is not granted until the pause is past.
      await pool.query('DELETE FROM check_runs');
      const held = await queueRun(pool, 1);
      await checkRuns.requeue(pool, held);
      const heldRow = (await pool.query('SELECT state, retry_at FROM check_runs WHERE run_id = $1', [held])).rows[0];
      assert.equal(heldRow.state, 'queued');
      assert.ok(heldRow.retry_at > new Date(), 'the requeued run waits out its pause');
      const refused = await checkRuns.dispatch(pool);
      assert.ok(!refused.includes(held), 'a run inside its retry pause is not dispatched');
      await pool.query('UPDATE check_runs SET retry_at = NOW() - INTERVAL \'1 second\' WHERE run_id = $1', [held]);
      const retried = await checkRuns.dispatch(pool);
      assert.ok(retried.includes(held), 'the run is granted once its pause is past');
      assert.deepEqual(await checkRuns.queueSnapshot(pool), []);
    });
  } finally {
    await client.end();
  }
});

test('a newer commit replaces its session\'s queued run and keeps its place in line', async (t) => {
  const conn = await connect();
  if (conn.noDriver) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  const pool = asPool(client);
  try {
    await withSchema(client, async () => {
      for (let id = 1; id <= 6; id += 1) await seedSession(pool, id, 'active');

      const r1 = await queueRun(pool, 1, 'commit-old');
      const r2 = await queueRun(pool, 2);
      const r3 = await queueRun(pool, 3);
      const first = await checkRuns.dispatch(pool); // grants r1..r3 (limit is 4)
      assert.deepEqual([...first].sort(), [r1, r2, r3].sort());
      const r1New = await queueRun(pool, 1, 'commit-new');

      // A queued run is replaced by its session's newer commit; a running
      // one is not touched.
      const r4 = await queueRun(pool, 4);
      const r4New = await queueRun(pool, 4, 'commit-newer');
      const dupes = await pool.query(
        'SELECT COUNT(*)::int AS n FROM check_runs WHERE session_id = 4 AND state = \'queued\''
      );
      assert.equal(dupes.rows[0].n, 1, 'a session holds at most one queued run');
      assert.equal(await stateOf(pool, r4), null, 'the replaced queued row is deleted');
      assert.equal(await stateOf(pool, r1), 'running', 'the running run is left alone');

      // The replacement inherits the replaced run's queued_at, so it stands
      // ahead of runs that arrived later.
      const r5 = await queueRun(pool, 5);
      const r6 = await queueRun(pool, 6);
      const before = await checkRuns.queueSnapshot(pool);
      const posNew4 = before.find((s) => s.runId === r4New);
      const pos5 = before.find((s) => s.runId === r5);
      assert.ok(posNew4 && pos5 && posNew4.position < pos5.position,
        'the replacement keeps the replaced run\'s place in line');

      // Settle the three running runs; everything queued is granted in turn,
      // replacement included.
      await checkRuns.finish(pool, r1);
      await checkRuns.finish(pool, r2);
      await checkRuns.finish(pool, r3);
      await drain(pool);
      assert.equal(await stateOf(pool, r4New), 'running', 'the replacement run is dispatched');
      assert.equal(await stateOf(pool, r5), 'running');
      assert.equal(await stateOf(pool, r6), 'running');
      assert.deepEqual(await checkRuns.queueSnapshot(pool), []);
      void r1New;
    });
  } finally {
    await client.end();
  }
});

test('a draft that has waited past the age cap ranks with the proposals up for a vote', async (t) => {
  const conn = await connect();
  if (conn.noDriver) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  const pool = asPool(client);
  try {
    await withSchema(client, async () => {
      for (let id = 1; id <= 5; id += 1) await seedSession(pool, id, 'active');
      await seedSession(pool, 6, 'promoted');

      const oldDraft = await queueRun(pool, 1);
      const freshDraft = await queueRun(pool, 2);
      const laterDraft = await queueRun(pool, 3);
      const lastDraft = await queueRun(pool, 4);
      const vote = await queueRun(pool, 6);
      // The draft joined the line 21 minutes ago — past the 20-minute cap.
      await pool.query(
        `UPDATE check_runs SET queued_at = NOW() - ($2::int * INTERVAL '1 millisecond') WHERE run_id = $1`,
        [oldDraft, checkRuns.AGE_CAP_MS + 60_000]
      );

      const granted = await checkRuns.dispatch(pool);
      // With five runs for four slots, the aged draft and the vote take the
      // first two places whatever their order between them, and the last
      // fresh draft is the one left waiting.
      assert.equal(granted.length, checkRuns.MAX_CONCURRENT);
      assert.deepEqual(granted.slice(0, 2).sort(), [oldDraft, vote].sort());
      assert.ok(granted.includes(freshDraft), 'the first fresh draft is next after the priority pair');
      assert.equal(await stateOf(pool, lastDraft), 'queued', 'the run behind them stays in line');
      void laterDraft;
    });
  } finally {
    await client.end();
  }
});
