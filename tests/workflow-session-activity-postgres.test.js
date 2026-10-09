'use strict';

// The session-activity machine (src/workflow/session-activity/) against the
// full PostgreSQL schema: what may overlap, leases that run out, the turn's
// journal, a Stop reaching the turn's holder, and a worker's retirement that
// waits for what still uses the session. The retirement's work is faked.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { sessionActivity, sessionKey, MACHINE, WORK, LEASE_MS } = require('../src/workflow/session-activity/machine.ts');
const { LIVE_TURN_PHASES } = require('../src/workflow/session-activity/facts.ts');
const { renewLease, readActivities } = require('../src/workflow/session-activity/lease.ts');
const turnLifecycle = require('../src/services/turn-lifecycle');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the facts\' live turn phases are the journal\'s recoverable phases', () => {
  assert.deepEqual([...LIVE_TURN_PHASES].sort(), [...turnLifecycle.RECOVERABLE_PHASES].sort());
});

test('session-activity machine against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_sessions_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 10 });
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);

  let seq = 0;
  const { rows: [owner] } = await pool.query(`INSERT INTO users (username, password) VALUES ('sa_owner', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by) VALUES ('sa-app', 'sa-app', $1) RETURNING id`, [owner.id]);
  const session = async () => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`, [app.id, owner.id])).rows[0].id;

  const pushed = [];
  const retired = [];
  const rt = createRuntime({
    pool, machines: [sessionActivity()], pollMs: 50, publish: async (q, list) => { pushed.push(...list); },
    services: { [WORK.retire]: { maxAttempts: 2, backoffMs: () => 0, async run({ input }) { retired.push(input.sessionId); return { retired: true }; } } },
  });
  runtimes.push(rt);

  const ask = async (sessionId, kind, extra = {}) => {
    const activityId = crypto.randomUUID();
    const id = await rt.append(MACHINE, sessionKey(sessionId), { type: 'Requested', payload: {
      sessionId, activityId, kind, holder: extra.holder || 'proc-a', label: null, turnId: extra.turnId ?? null, parent: extra.parent ?? null,
      stoppable: extra.stoppable ?? (kind === 'turn' || kind === 'chat'),
    } }, { requestKey: `activity:${activityId}`, source: { kind: 'system' } });
    await rt.drain();
    const { rows: [e] } = await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [id]);
    return { activityId, granted: e.result === 'accepted', reason: e.reason };
  };
  const end = async (sessionId, activityId) => {
    await rt.append(MACHINE, sessionKey(sessionId), { type: 'Ended', payload: { sessionId, activityId } },
      { requestKey: `ended:${activityId}`, source: { kind: 'system' } });
    await rt.drain();
  };
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const state = async (sessionId) => (await pool.query(
    'SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(sessionId)])).rows[0];
  const lapse = (activityId) => pool.query(`UPDATE wf_session_activities SET lease_until = now() - interval '1 second' WHERE id = $1`, [activityId]);

  await t.test('two turns never overlap, whichever process asks; the second is told what is in the way', async () => {
    const s = await session();
    const a = await ask(s, 'turn', { holder: 'proc-a' });
    assert.equal(a.granted, true);
    const b = await ask(s, 'turn', { holder: 'proc-b' });
    assert.deepEqual([b.granted, b.reason], [false, 'busy_turn']);
    await end(s, a.activityId);
    assert.equal((await ask(s, 'turn', { holder: 'proc-b' })).granted, true);
  });

  await t.test('what excludes what', async () => {
    const s = await session();
    const op = await ask(s, 'operation');
    assert.equal(op.granted, true);
    assert.equal((await ask(s, 'operation')).reason, 'busy_operation', 'two branch moves');
    assert.equal((await ask(s, 'turn')).reason, 'busy_operation');
    assert.equal((await ask(s, 'destroy')).reason, 'busy_operation');
    assert.equal((await ask(s, 'hold')).granted, true, 'a hold keeps only a destroy out');
    assert.equal((await ask(s, 'chat')).granted, true, 'a Mayor chat turn keeps nothing out and is kept out by nothing');
  });

  await t.test('a hold keeps a destroy and other turns out, but not its own turn', async () => {
    const s = await session();
    const running = await ask(s, 'turn');
    const hold = await ask(s, 'hold');
    assert.equal(hold.granted, true, 'a screenshot run holds the worker, then waits for the turn to end');
    await end(s, running.activityId);
    assert.equal((await ask(s, 'destroy')).reason, 'busy_hold');
    assert.equal((await ask(s, 'turn')).reason, 'busy_hold', 'a coding turn while the screenshot run sets up (B7)');
    const own = await ask(s, 'turn', { parent: hold.activityId });
    assert.equal(own.granted, true, "the screenshot run's own turn");
  });

  await t.test('an activity whose lease ran out stops counting, and is cleared at the next decision', async () => {
    const s = await session();
    const a = await ask(s, 'turn');
    await lapse(a.activityId);
    const b = await ask(s, 'turn');
    assert.equal(b.granted, true);
    const { data } = await state(s);
    assert.deepEqual(data.activities.map((x) => x.id), [b.activityId]);
    const { rows } = await pool.query('SELECT id FROM wf_session_activities WHERE session_id = $1', [s]);
    assert.deepEqual(rows.map((r) => r.id), [b.activityId]);
  });

  await t.test("a running turn's journal keeps out what a turn does, except whoever names that turn", async () => {
    const s = await session();
    await turnLifecycle.persistNewTurn(pool, s, { turnId: 'turn-1', mode: 'chat', phase: 'executing' });
    assert.equal((await ask(s, 'destroy')).reason, 'busy_turn', 'a pause under a detached turn (B2)');
    assert.equal((await ask(s, 'operation')).reason, 'busy_turn', 'a branch move under it (B10)');
    const takeover = await ask(s, 'turn', { turnId: 'turn-1' });
    assert.equal(takeover.granted, true, 'recovery taking its turn over');
    assert.equal((await ask(s, 'destroy', { turnId: 'turn-1' })).reason, 'busy_turn', 'not while a live holder runs it');
    await end(s, takeover.activityId);
    assert.equal((await ask(s, 'destroy', { turnId: 'turn-1' })).granted, true, 'the watchdog reaping a turn nobody holds');
  });

  await t.test("a turn continuing the journal's turn is not kept out by a screenshot run waiting for it", async () => {
    const s = await session();
    await turnLifecycle.persistNewTurn(pool, s, { turnId: 'turn-r', mode: 'chat', phase: 'tail_pending' });
    const hold = await ask(s, 'hold');
    assert.equal(hold.granted, true);
    assert.equal((await ask(s, 'turn')).reason, 'busy_hold', 'a new turn waits for the run');
    assert.equal((await ask(s, 'destroy', { turnId: 'turn-r' })).granted, true, 'the watchdog reaping it once nobody holds it');
    assert.equal((await ask(s, 'turn', { turnId: 'turn-r' })).granted, false, 'not while the reap runs');
    assert.equal((await ask(s, 'destroy')).reason, 'busy_hold', 'any other destroy still waits for the run');
  });

  await t.test('a journal that runs nothing does not count', async () => {
    const s = await session();
    await turnLifecycle.persistNewTurn(pool, s, { turnId: 'turn-q', mode: 'chat', phase: 'quarantined' });
    assert.equal((await ask(s, 'destroy')).granted, true);
  });

  await t.test('a Stop goes to the process holding the turn', async () => {
    const s = await session();
    const turn = await ask(s, 'turn', { holder: 'proc-a', turnId: 'turn-s' });
    pushed.length = 0;
    const id = await rt.append(MACHINE, sessionKey(s), { type: 'StopRequested', payload: {
      sessionId: s, by: { id: owner.id, username: 'sa_owner', canAdminWrite: false }, force: false, immediate: false, expectedTurnId: null,
    } }, { requestKey: 'stop-1', source: { kind: 'route' } });
    await rt.drain();
    const { rows: [e] } = await pool.query('SELECT result, reply FROM wf_events WHERE id = $1', [id]);
    assert.equal(e.result, 'accepted');
    assert.deepEqual(e.reply, { holder: 'proc-a', activityId: turn.activityId });
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].kind, 'session_stop');
    assert.deepEqual(pushed[0].routing, { holder: 'proc-a' });
    assert.equal(pushed[0].data.activityId, turn.activityId);
    const renewal = await renewLease(pool, turn.activityId);
    assert.equal(renewal.held, true);
    assert.equal(renewal.stop.by.username, 'sa_owner', 'a missed push is caught at the next renewal');
    assert.equal(renewal.stop.n, 1);
    // A forced Stop after the first is a Stop of its own, keeping when the first was.
    await rt.append(MACHINE, sessionKey(s), { type: 'StopRequested', payload: {
      sessionId: s, by: { id: owner.id, username: 'sa_owner', canAdminWrite: false }, force: true, immediate: false, expectedTurnId: null,
    } }, { requestKey: 'stop-1b', source: { kind: 'route' } });
    await rt.drain();
    const again = await renewLease(pool, turn.activityId);
    assert.deepEqual([again.stop.n, again.stop.force, again.stop.at], [2, true, renewal.stop.at]);
    const seen = await readActivities(pool, [s]);
    assert.deepEqual(seen.get(s), [{ id: turn.activityId, kind: 'turn', stopping: true }]);
    const none = await session();
    const nid = await rt.append(MACHINE, sessionKey(none), { type: 'StopRequested', payload: {
      sessionId: none, by: { id: owner.id, username: 'sa_owner', canAdminWrite: false }, force: false, immediate: false, expectedTurnId: null,
    } }, { requestKey: 'stop-2', source: { kind: 'route' } });
    await rt.drain();
    assert.equal((await pool.query('SELECT result FROM wf_events WHERE id = $1', [nid])).rows[0].result, 'rejected', 'no turn: the route falls back on the journal');
    // A turn with no stop handle where it runs (a sync with main) is not sent one.
    const sync = await session();
    await ask(sync, 'turn', { stoppable: false });
    const sid = await rt.append(MACHINE, sessionKey(sync), { type: 'StopRequested', payload: {
      sessionId: sync, by: { id: owner.id, username: 'sa_owner', canAdminWrite: false }, force: false, immediate: false, expectedTurnId: null,
    } }, { requestKey: 'stop-3', source: { kind: 'route' } });
    await rt.drain();
    assert.equal((await pool.query('SELECT reason FROM wf_events WHERE id = $1', [sid])).rows[0].reason, 'no_turn');
  });

  const retire = async (s, by = 'merge') => {
    await rt.append(MACHINE, sessionKey(s), { type: 'RetireRequested', payload: { sessionId: s, by } },
      { requestKey: `retire-${++seq}`, source: { kind: 'system' } });
    await settle();
  };

  await t.test('a retirement runs at once when nothing uses the session', async () => {
    const s = await session();
    await retire(s);
    assert.deepEqual(retired.filter((x) => x === s), [s]);
    assert.equal((await state(s)).state, 'idle');
  });

  await t.test('a retirement waits for the hold, runs once when it ends, and nothing starts meanwhile (B6)', async () => {
    const s = await session();
    const hold = await ask(s, 'hold');
    await retire(s);
    await retire(s, 'included');
    assert.deepEqual(retired.filter((x) => x === s), [], 'kept while the screenshot run holds it');
    assert.equal((await state(s)).state, 'retiring');
    assert.equal((await ask(s, 'turn', { parent: hold.activityId })).reason, 'retiring', 'nothing new on a worker about to go');
    await end(s, hold.activityId);
    await settle();
    assert.deepEqual(retired.filter((x) => x === s), [s], 'once');
    assert.equal((await state(s)).state, 'idle');
  });

  await t.test("a retirement whose hold's holder died runs when its timer finds the lease gone", async () => {
    const s = await session();
    const hold = await ask(s, 'hold');
    await retire(s);
    const { rows: [i] } = await pool.query('SELECT deadline_at FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s)]);
    assert.ok(i.deadline_at, 'a timer only while something waits');
    assert.ok(new Date(i.deadline_at) - Date.now() <= LEASE_MS + 1000);
    await lapse(hold.activityId);
    // The timer is due: as the pipeline would see it once the lease time passed.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL app.wf_writer = 'transition'`);
      await c.query(`UPDATE wf_instances SET deadline_at = now() - interval '1 second' WHERE machine = $1 AND key = $2`, [MACHINE, sessionKey(s)]);
      await c.query('COMMIT');
    } finally { c.release(); }
    await rt.fireTimers();
    await settle();
    assert.deepEqual(retired.filter((x) => x === s), [s]);
  });

  await t.test('a lease is renewed, never revived, and nothing else of the row changes outside the pipeline', async () => {
    const s = await session();
    const a = await ask(s, 'turn');
    const before = (await pool.query('SELECT lease_until FROM wf_session_activities WHERE id = $1', [a.activityId])).rows[0].lease_until;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await renewLease(pool, a.activityId)).held, true);
    const after = (await pool.query('SELECT lease_until FROM wf_session_activities WHERE id = $1', [a.activityId])).rows[0].lease_until;
    assert.ok(after > before);
    await assert.rejects(pool.query(`UPDATE wf_session_activities SET kind = 'hold' WHERE id = $1`, [a.activityId]), /WF_OWNERSHIP_VIOLATION/);
    await assert.rejects(pool.query('DELETE FROM wf_session_activities WHERE id = $1', [a.activityId]), /WF_OWNERSHIP_VIOLATION/);
    await lapse(a.activityId);
    assert.deepEqual(await renewLease(pool, a.activityId), { held: false, stop: null });
    assert.equal((await readActivities(pool, [s])).has(s), false, 'readers see it gone at once');
  });
});
