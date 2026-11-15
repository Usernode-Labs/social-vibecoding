'use strict';

// The turn machine (src/workflow/turn/) against the full PostgreSQL schema:
// a `recover` turn on a change, run as one work item, the turns asked for
// meanwhile run after it in order, the six-hour limit, and the change's
// working state told as a turn starts and ends. Then the item's handler
// (services/turns.js) with the coding run's recovery standing in, and the
// turn-leftovers clock (services/turn-leftovers.js) that asks for those
// turns: a coding record nothing carries, taken to an end.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-turn-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { turnMachine, MACHINE, WORK, MAX_TURN_MS } = require('../src/workflow/turn/machine.ts');
const { asTransition } = require('./lib/as-transition');
const { waitFor, within, deferred } = require('./lib/wait-for');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('turn machine against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_turn_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 10 });
  pool.on('error', () => {});
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1') ON CONFLICT DO NOTHING`);

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  // A change, whose turns run on its own instance (`session:<id>`).
  async function change() {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [`tc_${++seq}`]);
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url) VALUES ($1::text, $1::text, $2, 'https://github.com/acme/x') RETURNING id, slug`,
      [`tc-app-${++seq}`, u.id]);
    const { rows: [cs] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name) VALUES ($1, $2, 'active', 'dev/x') RETURNING id`,
      [a.id, u.id]);
    return { id: cs.id, user: u, appSlug: a.slug, key: `session:${cs.id}` };
  }
  const instance = async (c) => (await pool.query('SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, c.key])).rows[0];
  const items = async (c, kind) => (await pool.query(
    `SELECT id, kind, work_key, input, status FROM wf_work WHERE machine = $1 AND key = $2 AND ($3::text IS NULL OR kind = $3)
      ORDER BY created_at, work_key`, [MACHINE, c.key, kind || null])).rows;

  // ── 1. The machine, with its work standing in ───────────────────────
  const work = { calls: [], answer: null };
  const fake = (kind) => ({
    maxAttempts: 1, backoffMs: () => 0, leaseMs: 600,
    async run(ctx) {
      work.calls.push({ kind, key: ctx.key, input: ctx.input, workId: ctx.workId });
      if (kind === WORK.run && work.answer) return work.answer(ctx);
      return { ok: true };
    },
  });
  const machine = turnMachine();
  const pushed = [];
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50, publish: async (_q, list) => { pushed.push(...list); },
    services: { [WORK.run]: fake(WORK.run) },
  });
  runtimes.push(rt);
  let rk = 0;
  const send = (c, type, payload = {}, source = { kind: 'route' }) => rt.append(machine, c.key,
    { type, payload }, { requestKey: `t-${++rk}`, source });
  // What the turn-leftovers clock asks.
  const recover = (c, turnId, input = {}) => send(c, 'Asked', { turnId, kind: 'recover', input: { sessionId: c.id, ...input } }, { kind: 'system' });
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const runs = (c) => work.calls.filter((w) => w.kind === WORK.run && w.input.instanceKey === c.key);

  await t.test('T1 a recover turn is one work item, handed only what it needs, and the instance is idle as the item ends', async () => {
    work.answer = null;
    const c = await change();
    await recover(c, 'turn-1');
    await rt.drain();
    assert.equal((await instance(c)).state, 'running');
    const [item] = await items(c, WORK.run);
    assert.equal(item.work_key, 'run:turn-1');
    assert.deepEqual(item.input, { sessionId: c.id, turnId: 'turn-1', kind: 'recover', instanceKey: c.key },
      'what the run needs: never a key or a secret');
    await settle();
    assert.equal(runs(c).length, 1);
    assert.equal((await instance(c)).state, 'idle');
  });

  // A change's own turn starting and ending is its working state, told by
  // the transition from whichever process runs it (pushes.ts sessionState):
  // it was left to the memory of the process that last published it.
  await t.test('T1d a change\'s turn says the change is busy as it starts and idle as it ends, to its owner', async () => {
    const c = await change();
    pushed.length = 0;
    work.answer = null;
    await recover(c, 'turn-c1');
    await rt.drain();
    await settle();
    const states = pushed.filter((p) => p.data.type === 'session_state').map((p) => [p.kind, p.routing.userId, p.data.sessionId, p.data.busy, p.data.appSlug]);
    assert.deepEqual(states, [['user', c.user.id, c.id, true, c.appSlug], ['user', c.user.id, c.id, false, c.appSlug]]);
  });

  // A Pod of the release before this machine version (4) would still run a
  // person's turn here: it leaves the instance's events to this release,
  // whose version is newer.
  await t.test('T1f a turn this release started is never ended by an older Pod', async () => {
    const c = await change();
    await recover(c, 'turn-v1');
    await rt.drain();
    const { rows: [i] } = await pool.query('SELECT state, machine_version FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, c.key]);
    assert.deepEqual([i.state, Number(i.machine_version)], ['running', machine.version]);
    assert.equal(machine.version, 5);
    const older = createRuntime({ pool, machines: [{ ...machine, version: 4 }], pollMs: 50, publish: async () => {}, services: {} });
    runtimes.push(older);
    const tick = await send(c, 'Tick', {}, { kind: 'system' });
    await older.drain();
    const status = async () => (await pool.query('SELECT status FROM wf_events WHERE id = $1', [tick])).rows[0].status;
    assert.equal(await status(), 'pending', 'the older Pod leaves it');
    await rt.drain();
    assert.equal(await status(), 'processed');
    assert.equal((await instance(c)).state, 'idle');
    await settle();
    work.calls.length = 0;
  });

  await t.test('T2 a turn asked for while one runs waits its turn, in order; the same turn twice is one', async () => {
    const c = await change();
    await recover(c, 'a');
    await recover(c, 'b');
    await recover(c, 'b');
    await recover(c, 'a');
    await recover(c, 'c');
    await rt.drain();
    const i = await instance(c);
    assert.equal(i.data.running.turnId, 'a');
    assert.deepEqual(i.data.waiting.map((w) => w.turnId), ['b', 'c']);
    await settle();
    assert.deepEqual(runs(c).map((r) => r.input.turnId), ['a', 'b', 'c']);
    assert.equal((await instance(c)).state, 'idle');
  });

  await t.test('T3 a run that fails for good ends its turn, and the next one starts', async () => {
    const c = await change();
    work.answer = (ctx) => { if (ctx.input.turnId === 'turn-f') throw new Error('the recovery fell over'); return { ok: true }; };
    try {
      await recover(c, 'turn-f');
      await recover(c, 'turn-after');
      await settle();
    } finally { work.answer = null; }
    assert.deepEqual(runs(c).map((r) => r.input.turnId), ['turn-f', 'turn-after']);
    assert.equal((await instance(c)).state, 'idle');
  });

  await t.test('T5 past six hours: the run cancelled, and the next one starts', async () => {
    assert.equal(MAX_TURN_MS, 6 * 60 * 60 * 1000);
    const c = await change();
    let release;
    const gate = new Promise((r) => { release = r; });
    work.answer = async () => { await gate; return { ok: true }; };
    try {
      await recover(c, 'turn-t');
      await recover(c, 'next');
      await rt.drain();
      const running = rt.runServices();
      await waitFor(() => runs(c).length === 1, { label: 'the turn\'s run to start' });
      const c2 = await pool.connect();
      try {
        await c2.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
        await c2.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [MACHINE, c.key]);
        await c2.query('COMMIT');
      } finally { c2.release(); }
      await rt.fireTimers();
      await rt.drain();
      assert.equal((await instance(c)).data.running.turnId, 'next', 'the next one starts');
      release();
      await running;
      await settle();
    } finally { work.answer = null; release(); }
    assert.equal((await items(c, WORK.run)).find((w) => w.work_key === 'run:turn-t').status, 'settled');
  });

  // #6068: the turn-leftovers clock ends an instance nothing runs on with a
  // Tick that names its turn, so a pass that races the real result never
  // ends the turn that follows.
  await t.test('T5b a Tick names its turn: another turn\'s is ignored, this one\'s ends it', async () => {
    const c = await change();
    let release;
    const gate = new Promise((r) => { release = r; });
    work.answer = async () => { await gate; return { ok: true }; };
    try {
      await recover(c, 'turn-named');
      await rt.drain();
      const running = rt.runServices();
      await waitFor(() => runs(c).length === 1, { label: 'the turn\'s run to start' });
      await send(c, 'Tick', { turnId: 'another-turn' }, { kind: 'system' });
      await rt.drain();
      assert.equal((await instance(c)).state, 'running', 'not the turn running here');
      await send(c, 'Tick', { turnId: 'turn-named' }, { kind: 'system' });
      await rt.drain();
      assert.equal((await instance(c)).state, 'idle', 'its own turn, past its time');
      release();
      await running;
      await settle();
    } finally { work.answer = null; release(); }
  });

  await t.test('T6 only a change is a turn\'s instance, only a recover turn is asked, and only the platform asks', async () => {
    const asked = { type: 'Asked', payload: { turnId: 'x', kind: 'recover', input: {} } };
    const outcome = async (id) => {
      await rt.drain();
      const { rows: [e] } = await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [id]);
      return [e.result, e.reason];
    };
    for (const key of ['session:abc', 'agent:1']) {
      const bad = await rt.append(machine, key, asked, { requestKey: `t-${++rk}`, source: { kind: 'system' } });
      assert.deepEqual(await outcome(bad), ['rejected', 'bad_key'], key);
    }
    const c = await change();
    const o = await rt.append(machine, c.key, asked,
      { requestKey: `t-${++rk}`, source: { kind: 'message', from: { machine: 'x', key: 'y', eventId: 1 } } });
    assert.deepEqual(await outcome(o), ['rejected', 'not_the_platform']);
    for (const kind of ['agent', 'classic', 'headless', 'nope']) {
      await assert.rejects(send(c, 'Asked', { turnId: 'x', kind, input: {} }), /Asked needs a kind/, kind);
    }
    await assert.rejects(send(c, 'StopRequested', { by: 'ada' }), /has no event StopRequested/, 'a person\'s Stop is not this machine\'s');
    assert.equal(await instance(c), undefined, 'nothing started');
  });

  // ── 2. The item's handler (services/turns.js) ───────────────────────
  const turns = require('../src/services/turns');
  const recovery = require('../src/services/turn-recovery');
  const saved = { recoverTurn: recovery.recoverTurn };
  t.after(() => { recovery.recoverTurn = saved.recoverTurn; });
  const seen = { recovered: [] };
  let recoverRun = async () => {};
  const standIn = async (args) => { seen.recovered.push(args.sessionId); await recoverRun(args); };
  recovery.recoverTurn = standIn;
  const recoverCtx = (c, turnId, { lost = 0, input = {} } = {}) => ({
    workId: crypto.randomUUID(), kind: WORK.run, key: `run:${turnId}`, resumeFrom: null, lostAttempts: lost,
    signal: new AbortController().signal,
    input: { sessionId: c.id, turnId, kind: 'recover', instanceKey: c.key, ...input },
  });
  const reset = () => {
    for (const list of Object.values(seen)) list.length = 0;
    recoverRun = async () => {};
  };

  await t.test('H1 a recover turn takes its change through the adoption; any other kind is refused for good', async () => {
    reset();
    const c = await change();
    assert.deepEqual(await turns.run(recoverCtx(c, 'h1'), { config: {}, pool }), { ended: 'recovered' });
    assert.deepEqual(seen.recovered, [c.id]);
    for (const kind of ['agent', 'classic', 'headless']) {
      await assert.rejects(turns.run({ ...recoverCtx(c, 'h1b'), input: { ...recoverCtx(c, 'h1b').input, kind } }, { config: {}, pool }),
        (err) => err.permanent === true, kind);
    }
    assert.deepEqual(seen.recovered, [c.id], 'and nothing is recovered for them');
  });

  await t.test('H4 a coding run whose recovery cannot read the worker yet is tried again, a bounded number of times', async () => {
    reset();
    const d = await change();
    let fails = 2;
    recoverRun = async () => {
      if (fails-- > 0) throw Object.assign(new Error('runtime unavailable'), { retryWorkerRecovery: true });
    };
    const was = { ...turns.RECOVERY_RETRY };
    Object.assign(turns.RECOVERY_RETRY, { ms: 1, tries: 3 });
    try {
      assert.deepEqual(await turns.run(recoverCtx(d, 'h4c', { lost: 1 }), { config: {}, pool }), { ended: 'recovered' });
      assert.equal(seen.recovered.length, 3);
      fails = 5;
      seen.recovered.length = 0;
      await assert.rejects(turns.run(recoverCtx(d, 'h4e', { lost: 1 }), { config: {}, pool }), /runtime unavailable/);
      assert.equal(seen.recovered.length, 3, 'given up after its tries');
    } finally {
      Object.assign(turns.RECOVERY_RETRY, was);
      reset();
    }
  });

  await t.test('H10 a turn whose item loses its lease while it runs on ends its process, unless the item was settled or the process is stopping', async () => {
    const { LeaseLost } = require('../src/workflow/kernel/services.ts');
    const exits = [];
    const was = turns.LOST_LEASE.exit;
    turns.LOST_LEASE.exit = (code) => { exits.push(code); };
    // endOnLostLease (services/turns.js) reads its item's status before it
    // decides to end the process: counting that read waits for the decision
    // instead of sleeping past it.
    let leaseCheck = null;
    const query = pool.query;
    pool.query = function countedLeaseCheck(...args) {
      const text = typeof args[0] === 'string' ? args[0] : args[0] && args[0].text;
      const result = query.apply(this, args);
      if (typeof text === 'string' && text.includes('SELECT status FROM wf_work WHERE id = $1')) {
        const checked = leaseCheck;
        const done = () => setImmediate(() => { if (checked) checked.resolve(); });
        result.then(done, done);
      }
      return result;
    };
    const withItem = async (status) => {
      const c = await change();
      const ctx = recoverCtx(c, `h10-${status}`);
      const abort = new AbortController();
      const db = await pool.connect();
      try {
        await db.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
        await db.query(
          `INSERT INTO wf_work (id, machine, key, kind, work_key, input, status, claim_id, lease_until)
           VALUES ($1, 'turn', $2, 'turn.run', $3, '{}', $4, CASE WHEN $4 = 'running' THEN gen_random_uuid() END,
                   CASE WHEN $4 = 'running' THEN NOW() + interval '1 minute' END)`,
          [ctx.workId, c.key, ctx.key, status]);
        await db.query('COMMIT');
      } finally { db.release(); }
      return { ctx: { ...ctx, signal: abort.signal }, abort };
    };
    const runAborting = async ({ ctx, abort }, reason) => {
      reset();
      const checked = deferred();
      // A stopping process returns from the abort at once, before any read.
      const waiting = reason && reason.stopping === true ? null : checked;
      leaseCheck = waiting;
      try {
        // The turn is held open until the lease check has decided: its
        // finally must not clear `running` before the check reads it.
        recoverRun = async () => {
          abort.abort(reason);
          if (waiting) await within(checked.promise, 5000, 'the turn to read its item after its lease was lost');
          else await new Promise((r) => setImmediate(r));
        };
        await turns.run(ctx, { config: {}, pool });
      } finally {
        leaseCheck = null;
      }
    };
    try {
      await runAborting(await withItem('running'), new LeaseLost());
      assert.deepEqual(exits, [1], 'its lease lost, its item still outstanding: the process ends');
      exits.length = 0;
      await runAborting(await withItem('settled'), new LeaseLost());
      assert.deepEqual(exits, [], 'a cancelled item runs nowhere again');
      await runAborting(await withItem('running'), new LeaseLost({ stopping: true }));
      assert.deepEqual(exits, [], 'a process stopping ends by itself');
    } finally {
      pool.query = query;
      turns.LOST_LEASE.exit = was;
    }
  });

  await t.test('H7 the item runs the real handler through the workflow', async () => {
    reset();
    const c = await change();
    const { turnServices } = require('../src/workflow/turn/services.ts');
    const machine2 = turnMachine();
    const rt2 = createRuntime({
      pool, machines: [machine2], pollMs: 50, publish: async () => {},
      services: turnServices({ config: {}, pool }),
    });
    runtimes.push(rt2);
    await rt2.append(machine2, c.key, { type: 'Asked', payload: { turnId: 'h7', kind: 'recover', input: { sessionId: c.id } } },
      { requestKey: `t-${++rk}`, source: { kind: 'system' } });
    for (let i = 0; i < 30; i++) {
      await rt2.drain();
      if (!(await rt2.runServices())) { await rt2.drain(); break; }
    }
    assert.deepEqual(seen.recovered, [c.id]);
    assert.equal((await instance(c)).state, 'idle');
  });

  const leftovers = require('../src/services/turn-leftovers');
  const leftoverPass = () => leftovers.sweep(pool);
  const askedOn = async (key) => (await pool.query(
    `SELECT payload FROM wf_events WHERE machine = 'turn' AND key = $1 AND type = 'Asked' ORDER BY id`, [key])).rows.map((r) => r.payload);

  await t.test('L2 a coding record no work item holds: a recover turn asked once, never while its item holds it, whatever other release serves', async () => {
    const quiet = (turnId, extra = {}) => JSON.stringify({ turnId, mode: 'build', startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), ...extra });
    const c = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [c.id, quiet('old-job')]);
    const fresh = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [fresh.id,
      JSON.stringify({ turnId: 'fresh-job', mode: 'build', startedAt: new Date().toISOString() })]);
    // An item that settled without releasing its record (its release failed).
    const { rows: [doneItem] } = await pool.query(`SELECT id FROM wf_work WHERE kind = $1 AND status = 'settled' LIMIT 1`, [WORK.run]);
    const settledOwner = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [settledOwner.id,
      quiet('settled-job', { owner: { machine: MACHINE, key: settledOwner.key, kind: WORK.run, workKey: 'run:s', workId: doneItem.id } })]);
    // A process of another release, serving: no leader of an older release
    // recovers anything any more, so the pass does not wait for it.
    await pool.query(`INSERT INTO platform_processes (id, release, state) VALUES ('old-pod', 'old', 'serving')`);
    // Being stopped (its time ran out): its stop work releases the record.
    const stopping = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [stopping.id, quiet('stopping-job')]);
    await asTransition(pool, `INSERT INTO wf_work (machine, key, kind, work_key, input, status) VALUES ('turn', $1, 'turn.stop', $2, '{}', 'queued')`,
      [stopping.key, `stop:${stopping.id}:timeout-x`]);
    // An item still outstanding: a turn asked on another change, not yet run.
    const holder = await change();
    await recover(holder, 'held');
    await rt.drain();
    const { rows: [liveItem] } = await pool.query(`SELECT id FROM wf_work WHERE kind = $1 AND status IN ('queued', 'running') LIMIT 1`, [WORK.run]);
    const owned = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [owned.id,
      quiet('owned-job', { owner: { machine: MACHINE, key: owned.key, kind: WORK.run, workKey: 'run:o', workId: liveItem.id } })]);
    const before = (await leftoverPass()).records;
    assert.ok(before >= 1);
    assert.deepEqual((await askedOn(c.key)).map((p) => [p.kind, p.turnId, p.input.sessionId]), [['recover', 'leftover-old-job', c.id]]);
    assert.deepEqual(await askedOn(owned.key), [], 'a record its outstanding item owns is that item\'s');
    assert.deepEqual(await askedOn(stopping.key), [], 'nor one whose stop is under way');
    assert.deepEqual(await askedOn(fresh.key), [], 'one that just moved may still be its process\'s');
    assert.deepEqual((await askedOn(settledOwner.key)).map((p) => p.kind), ['recover'], 'one its settled item left is nobody\'s');
    await leftoverPass();
    assert.equal((await askedOn(c.key)).length, 1, 'asked once');
    await pool.query(`DELETE FROM platform_processes WHERE id = 'old-pod'`);
    await asTransition(pool, `UPDATE wf_work SET status = 'settled', settled_at = NOW() WHERE work_key = $1`, [`stop:${stopping.id}:timeout-x`]);
    for (const x of [c, owned, fresh, settledOwner, stopping]) await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [x.id]);
    await settle();
    // A recover turn runs the adoption for its change.
    reset();
    assert.deepEqual(await turns.run({ ...recoverCtx(c, 'leftover-old-job'), input: { sessionId: c.id, kind: 'recover', turnId: 'x', instanceKey: c.key } },
      { config: {}, pool }), { ended: 'recovered' });
    assert.deepEqual(seen.recovered, [c.id]);
  });

  await t.test('L6 a record a recover turn left is asked for again after a while, a bounded number of times, and the last ask ends it', async () => {
    const quiet = (turnId) => JSON.stringify({ turnId, mode: 'build', startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    const c = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [c.id, quiet('stuck-job')]);
    const backdate = async () => {
      const db = await pool.connect();
      try {
        await db.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
        await db.query(
          `UPDATE wf_events SET created_at = created_at - make_interval(mins => $2) WHERE machine = 'turn' AND key = $1 AND type = 'Asked'`,
          [c.key, leftovers.RECORD_RETRY.minutes + 1]);
        await db.query('COMMIT');
      } finally { db.release(); }
    };
    await leftoverPass();
    await leftoverPass();
    assert.equal((await askedOn(c.key)).length, 1, 'not again at once');
    for (let i = 1; i < leftovers.RECORD_RETRY.asks + 2; i += 1) { await backdate(); await leftoverPass(); }
    const asked = await askedOn(c.key);
    assert.equal(asked.length, leftovers.RECORD_RETRY.asks, 'a bounded number of times');
    assert.deepEqual(asked.map((p) => [p.turnId, p.input.last]), [
      ['leftover-stuck-job', false], ['leftover-stuck-job-2', false], ['leftover-stuck-job-3', false], ['leftover-stuck-job-4', true]]);
    // The last ask: recovery leaves the record, so it is ended; a record
    // that moved on (another turn's) is not.
    const forceStop = require('../src/services/worker-force-stop');
    const wasForce = forceStop.run;
    const forced = [];
    reset();
    forceStop.run = async (_pool, target) => {
      assert.equal(target.userId, null, 'system recovery runs on the conductor');
      assert.equal(target.turnId, 'stuck-job');
      forced.push([target.sessionId, 'homeroom']);
    };
    const lastCtx = (identity) => ({ ...recoverCtx(c, 'leftover-x'), input: { sessionId: c.id, kind: 'recover', turnId: 'x', instanceKey: c.key, identity, last: true } });
    try {
      assert.deepEqual(await turns.run(lastCtx('stuck-job'), { config: {}, pool }), { ended: 'ended' });
      assert.deepEqual(forced, [[c.id, 'homeroom']]);
      assert.deepEqual(await turns.run(lastCtx('some-other-job'), { config: {}, pool }), { ended: 'recovered' });
      assert.equal(forced.length, 1, 'only the record it was asked for');
      recoverRun = async () => { throw new Error('the cluster did not answer'); };
      assert.deepEqual(await turns.run(lastCtx('stuck-job'), { config: {}, pool }), { ended: 'ended' }, 'a recovery that fails on the last ask ends it too');
      assert.deepEqual(await turns.run({ ...lastCtx('stuck-job'), input: { ...lastCtx('stuck-job').input, last: false } }, { config: {}, pool })
        .then(() => 'returned', (err) => err.message), 'the cluster did not answer', 'an earlier ask fails as its item, to be asked again');
    } finally {
      reset();
      forceStop.run = wasForce;
      await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [c.id]);
    }
  });

  // #6068: a turn instance still `running` whose run item settled without
  // ending it (a result the kernel refused) is an orphan: nothing will ever
  // end it, and it held its change for up to six hours with no record.
  const { workedOnSql } = require('../src/workflow/session-work.ts');
  const workedOn = async (id) => (await pool.query(
    `SELECT ${workedOnSql()} AS busy FROM chat_sessions cs WHERE cs.id = $1`, [id])).rows[0].busy;
  const ageTurn = (key) => asTransition(pool,
    `UPDATE wf_instances SET data = jsonb_set(data, '{running,startedAt}', to_jsonb(NOW() - make_interval(secs => 600)))
      WHERE machine = 'turn' AND key = $1`, [key]);
  const settleRun = (key) => asTransition(pool,
    `UPDATE wf_work SET status = 'settled', settled_at = NOW()
      WHERE machine = 'turn' AND key = $1 AND kind = $2 AND status <> 'settled'`, [key, WORK.run]);


  await t.test('L7 a turn instance whose run item settled without ending it holds nothing, and the clock ends it once', async () => {
    const c = await change();
    await recover(c, 'orphan-run');
    await rt.drain();
    assert.equal((await instance({ key: c.key })).state, 'running');
    assert.equal(await workedOn(c.id), true, 'its run item is outstanding');
    // The item settles (a result the kernel refused) and the instance is
    // left running with nothing behind it.
    await settleRun(c.key);
    assert.equal(await workedOn(c.id), false, 'an instance nothing runs on holds nothing');
    // A turn that has just started is never mistaken for one.
    assert.equal((await leftoverPass()).orphanTurns, 0, 'it has not been still for two minutes');
    await ageTurn(c.key);
    assert.equal((await leftoverPass()).orphanTurns, 1);
    await rt.drain();
    await waitFor(async () => (await instance({ key: c.key })).state !== 'running', { label: 'the orphan to end' });
    const { rows: ticks } = await pool.query(
      `SELECT payload FROM wf_events WHERE machine = 'turn' AND key = $1 AND type = 'Tick' ORDER BY id`, [c.key]);
    assert.deepEqual(ticks.map((r) => r.payload), [{ turnId: 'orphan-run' }], 'one Tick, naming its turn');
    assert.equal((await leftoverPass()).orphanTurns, 0, 'a second pass finds nothing (and a repeat is a replay)');
    await settle();
  });

  // The same orphan blocked the record recovery (its `NOT EXISTS … running`
  // clause): a record beside it is now asked a recover turn, and the Tick
  // that ends the orphan starts it.
  await t.test('L9 a record left beside an orphan turn instance is asked its recover turn', async () => {
    const c = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [c.id,
      JSON.stringify({ turnId: 'stuck-job', mode: 'build', startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() })]);
    try {
      await recover(c, 'orphan-with-record');
      await rt.drain();
      await settleRun(c.key);
      await ageTurn(c.key);
      const pass = await leftoverPass();
      assert.equal(pass.records >= 1, true);
      assert.equal(pass.orphanTurns, 1);
      // The clock's ask, beside the orphan's own.
      assert.deepEqual((await askedOn(c.key)).filter((p) => p.turnId !== 'orphan-with-record')
        .map((p) => [p.kind, p.turnId, p.input.sessionId]),
        [['recover', 'leftover-stuck-job', c.id]]);
      await rt.drain();
      await waitFor(async () => (await instance({ key: c.key })).data.running?.turnId === 'leftover-stuck-job',
        { label: 'the recover turn the orphan held to start' });
      await settle();
    } finally {
      await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [c.id]);
    }
  });
});
