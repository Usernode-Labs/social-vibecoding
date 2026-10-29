'use strict';

// An operation's large input (services/platform-operations.js, "an
// operation's large input") against a real PostgreSQL and the platform's
// own workflow runtime (src/workflow/platform.ts runOperation,
// appendOperationRequest, settleOperation): kept before its request is
// appended, or in the caller's transaction; found by the conductor's run
// and dropped by it; dropped when the request is refused or asked again
// after its run; swept after two days by the upload-gc clock's pass.
//
// TEST_DATABASE_URL selects a local test database, like the other
// *-postgres tests; without a reachable server it skips.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { waitFor } = require('./lib/wait-for');

const loggerId = require.resolve('../src/services/logger');
require.cache[loggerId] = {
  id: loggerId, filename: loggerId, loaded: true, paths: [],
  exports: { info() {}, debug() {}, warn() {}, error() {} },
};

const operations = require('../src/services/platform-operations');
const { MAX_INPUT_BYTES, OPERATIONS: MACHINE_OPERATIONS } = require('../src/workflow/platform-operation/machine.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const OP = 'test.input';

const until = (label, check) => waitFor(check, { label, timeoutMs: 30000, everyMs: 50 });

test('a platform operation\'s large input', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `op_inputs_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // as on every boot
  const dbPool = require('../src/db/pool');
  const realGetPool = dbPool.getPool;
  dbPool.getPool = () => pool;

  // An operation of the test's own, run by the machine's own handler
  // (platform-operation/services.ts makes one per operation it knows).
  MACHINE_OPERATIONS.add(OP);
  const seen = [];
  operations.OPERATIONS.set(OP, () => ({
    authorize: async () => null,
    run: async ({ pool: db }, request) => {
      const payload = await operations.inputOf(db, request.requestId);
      seen.push({ request, payload });
      await operations.dropInput(db, request.requestId);
      return { size: payload ? payload.patch.length : null };
    },
  }));

  const platform = require('../src/workflow/platform.ts');
  await platform.startWorkflow({ databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2 }, { loops: true });
  t.after(async () => {
    await platform.stopWorkflow();
    MACHINE_OPERATIONS.delete(OP);
    operations.OPERATIONS.delete(OP);
    dbPool.getPool = realGetPool;
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });

  let seq = 0;
  const person = async () => {
    seq += 1;
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id`, [`op_input_${seq}`]);
    return u.id;
  };
  const kept = async (requestId) => (await pool.query(
    'SELECT op, payload FROM platform_operation_inputs WHERE request_id = $1', [requestId])).rows[0] || null;
  const runsOf = (requestId) => seen.filter((s) => s.request.requestId === requestId);
  const eventOf = async (requestId) => (await pool.query(
    `SELECT payload, octet_length(payload::text) AS bytes FROM wf_events
      WHERE machine = 'platform-operation' AND request_key = $1 AND type = 'Requested'`, [requestId])).rows[0] || null;

  await t.test('a payload past the request\'s 64 KB reaches the conductor\'s run beside the request, which drops it', async () => {
    const userId = await person();
    const patch = 'p'.repeat(MAX_INPUT_BYTES * 3);
    const out = await operations.request({ op: OP, userId, input: { n: 1 }, payload: { patch } });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.size, patch.length, 'the run read all of it');
    const [run] = runsOf(out.requestId);
    assert.deepEqual(run.request, { op: OP, requestId: out.requestId, appId: null, userId, input: { n: 1 } },
      'the request itself carries no payload');
    const event = await eventOf(out.requestId);
    assert.ok(event.bytes < 1024, `the event is small (${event.bytes} bytes)`);
    assert.equal(await kept(out.requestId), null, 'dropped by its run');
  });

  await t.test('a request without a payload is what it always was', async () => {
    const userId = await person();
    const before = (await pool.query('SELECT count(*)::int AS n FROM platform_operation_inputs')).rows[0].n;
    const out = await operations.request({ op: OP, userId, input: { n: 2 } });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.size, null);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_operation_inputs')).rows[0].n, before);
    assert.equal('payload' in (await eventOf(out.requestId)).payload, false);
  });

  await t.test('asked again under the caller\'s own id, it is the same request: one run, and nothing left behind', async () => {
    const userId = await person();
    const requestId = crypto.randomUUID();
    const first = await operations.request({ op: OP, userId, input: {}, requestId, payload: { patch: 'abc' } });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.requestId, requestId);
    const again = await operations.request({ op: OP, userId, input: {}, requestId, payload: { patch: 'abc' } });
    assert.deepEqual(again, first, 'the same answer');
    assert.equal(runsOf(requestId).length, 1, 'run once');
    assert.equal(await kept(requestId), null, 'the second ask keeps nothing its run would never read');
    await assert.rejects(operations.request({ op: OP, userId, input: {}, requestId: 'not-a-uuid', payload: { patch: 'x' } }),
      /name its request/);
  });

  await t.test('a request refused before it runs has its payload dropped', async () => {
    const userId = await person();
    await pool.query('UPDATE users SET anonymised_at = NOW() WHERE id = $1', [userId]);
    const requestId = crypto.randomUUID();
    const out = await operations.request({ op: OP, userId, input: {}, requestId, payload: { patch: 'refused' } });
    assert.equal(out.ok, false);
    assert.equal(out.status, 403);
    assert.equal(runsOf(requestId).length, 0);
    assert.equal(await kept(requestId), null);
  });

  await t.test('admit keeps the payload in the caller\'s transaction: rolled back, nothing; committed, its run finds it', async () => {
    const userId = await person();
    const client = await pool.connect();
    try {
      const lost = crypto.randomUUID();
      await client.query('BEGIN');
      await operations.admit(client, { op: OP, userId, requestId: lost, input: {}, payload: { patch: 'never' } });
      await client.query('ROLLBACK');
      assert.equal(await kept(lost), null);
      assert.equal(await eventOf(lost), null);

      const requestId = crypto.randomUUID();
      const patch = 'q'.repeat(MAX_INPUT_BYTES * 2);
      await client.query('BEGIN');
      const ticket = await operations.admit(client, { op: OP, userId, requestId, input: { n: 3 }, payload: { patch } });
      await client.query('COMMIT');
      assert.deepEqual(await ticket.settle(), { status: 'accepted' });
      const [run] = await until('the admitted run', () => (runsOf(requestId).length ? runsOf(requestId) : null));
      assert.equal(run.payload.patch.length, patch.length);
      await until('its input dropped', async () => (await kept(requestId)) === null);
    } finally {
      client.release();
    }
  });

  await t.test('an admitted request refused at settle has its payload dropped', async () => {
    const userId = await person();
    await pool.query('UPDATE users SET anonymised_at = NOW() WHERE id = $1', [userId]);
    const requestId = crypto.randomUUID();
    const client = await pool.connect();
    let ticket;
    try {
      await client.query('BEGIN');
      ticket = await operations.admit(client, { op: OP, userId, requestId, input: {}, payload: { patch: 'refused' } });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    assert.equal(await kept(requestId) !== null, true, 'kept until it is settled');
    assert.equal((await ticket.settle()).status, 'refused');
    assert.equal(await kept(requestId), null);
    assert.equal(runsOf(requestId).length, 0);
  });

  await t.test('the upload-gc pass deletes inputs past two days and keeps newer ones', async () => {
    const old = crypto.randomUUID();
    const fresh = crypto.randomUUID();
    await pool.query(
      `INSERT INTO platform_operation_inputs (request_id, op, payload, created_at)
       VALUES ($1, $3, '{"patch":"old"}', NOW() - INTERVAL '3 days'), ($2, $3, '{"patch":"new"}', NOW() - INTERVAL '1 day')`,
      [old, fresh, OP]);
    // The pass's other steps need an object store this test has none of;
    // each step runs whatever the others do.
    await require('../src/services/upload-retention').sweep(pool, {}).catch(() => {});
    assert.equal(await kept(old), null);
    assert.deepEqual(await kept(fresh), { op: OP, payload: { patch: 'new' } });
    assert.equal(await operations.pruneInputs(pool), 0);
  });

  await t.test('an admission still being decided keeps the submission request for recovery', async (t) => {
    await platform.stopWorkflow();
    await platform.startWorkflow({ databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 0 }, { loops: false });
    const userId = await person();
    const broker = require('../src/services/work-submission-request');
    let receipt = null;
    const taskDb = { async query(sql, params) {
      if (/COALESCE\(submit_operation/.test(sql)) {
        receipt ||= JSON.parse(params[3]);
        return { rows: [{ submit_operation: receipt }] };
      }
      if (/submit_operation = NULL/.test(sql)) { receipt = null; return { rows: [] }; }
      throw new Error('Unexpected task query');
    } };
    const ids = [];
    const realRequest = operations.request;
    t.mock.method(operations, 'request', (p, opts) => {
      ids.push(p.requestId);
      return realRequest(p, { ...opts, admitMs: 500, waitMs: 1000 });
    });
    const p = { op: OP, appId: null, userId, input: { taskId: 31 }, payload: { patch: 'kept until decided' } };
    const answer = broker.request(taskDb, p);
    const event = await until('the submission event', async () => receipt && (await pool.query(
      "SELECT id FROM wf_events WHERE machine = 'platform-operation' AND request_key = $1", [receipt.requestId])).rows[0]);
    const locker = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM wf_events WHERE id = $1 FOR UPDATE', [event.id]);
      // Hold the row through the refusal's bounded lock wait, as a slot
      // still deciding it can: nobody can promise that it will not run.
      const out = await answer;
      assert.equal(out.pending, true, JSON.stringify(out));
      assert.equal(receipt.requestId, ids[0], 'the task keeps its recovery handle');
      assert.equal((await pool.query('SELECT status FROM wf_events WHERE id = $1', [event.id])).rows[0].status, 'pending');
      assert.deepEqual(await kept(ids[0]), { op: OP, payload: p.payload }, 'its input stays available');
    } finally {
      await locker.query('ROLLBACK'); locker.release();
    }
    const { createRuntime } = require('../src/workflow/kernel/index.ts');
    const { platformOperation } = require('../src/workflow/platform-operation/machine.ts');
    const { platformOperationServices } = require('../src/workflow/platform-operation/services.ts');
    const conductor = createRuntime({ pool, machines: [platformOperation()], services: platformOperationServices({ pool, config: {} }), slots: 1 });
    try {
      await conductor.drain(); await conductor.runServices(); await conductor.drain();
      const retry = broker.request(taskDb, p);
      await until('the replay request', async () => (await pool.query(
        "SELECT count(*)::int AS n FROM wf_events WHERE machine = 'platform-operation' AND request_key = $1 AND type = 'Requested'",
        [ids[0]])).rows[0].n === 2);
      await conductor.drain();
      const again = await retry;
      assert.equal(again.ok, true, JSON.stringify(again));
      assert.equal(ids[1], ids[0], 'a second HTTP attempt uses the same operation');
      assert.equal(runsOf(ids[0]).length, 1, 'the late decision runs once');
      assert.equal(await kept(ids[0]), null);
    } finally { await conductor.stop(); }
  });

});
