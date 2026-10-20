'use strict';

// The turn machine (src/workflow/turn/) against the full PostgreSQL schema:
// a person's turn asked for with its conversation's claim, run as one work
// item, its claim released when the item ends however it ends, the turns
// asked for meanwhile run after it in order, a person's Stop, the six-hour
// limit. Then the item's handler (services/turns.js) with the Mayor and the
// coding run's recovery standing in: what a run is handed, and how a turn
// whose process went is carried on or ended.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-turn-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { turnMachine, agentKey, MACHINE, WORK, INTERRUPTED_TEXT, MAX_TURN_MS } = require('../src/workflow/turn/machine.ts');
const { TURN_STOP } = require('../src/workflow/rules/turn-stop.ts');

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
  const sessionBus = require('../src/services/session-bus');
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    sessionBus.init({ memory: true });
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1') ON CONFLICT DO NOTHING`);
  sessionBus.init({ pool });

  const agentSessions = require('../src/services/agent-sessions');
  const platform = require('../src/workflow/platform.ts');

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  async function conversation() {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [`tu_${++seq}`]);
    const s = await agentSessions.createAgentSession(pool, { user: { id: u.id } });
    return { id: s.id, user: u, key: agentKey(s.id) };
  }
  // A coding run's record on a change, owned by the conversation's item.
  async function ownedChange(c, workId) {
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by) VALUES ($1::text, $1::text, $2) RETURNING id`, [`tu-app-${++seq}`, c.user.id]);
    const { rows: [ch] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, agent_session_id, active_turn) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [a.id, c.user.id, c.id, JSON.stringify({ turnId: `job-${seq}`, mode: 'build',
        owner: { machine: MACHINE, key: c.key, kind: WORK.run, workKey: 'run:x', workId } })]);
    return ch.id;
  }
  const claim = async (c) => (await pool.query('SELECT active_turn, last_done_at FROM agent_sessions WHERE id = $1', [c.id])).rows[0];
  const instance = async (c) => (await pool.query('SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, c.key])).rows[0];
  const items = async (c, kind) => (await pool.query(
    `SELECT id, kind, work_key, input, status FROM wf_work WHERE machine = $1 AND key = $2 AND ($3::text IS NULL OR kind = $3)
      ORDER BY created_at, work_key`, [MACHINE, c.key, kind || null])).rows;
  const notes = async (c) => (await pool.query(
    `SELECT content, metadata FROM chat_session_messages WHERE agent_session_id = $1 AND role = 'system' ORDER BY id`, [c.id])).rows;
  // What the route does: the claim and the turn's Asked, one transaction.
  const ask = (c, turnId, input = {}) => agentSessions.acquireTurnLease(pool, {
    agentSessionId: c.id, userId: c.user.id, turnId,
    ask: (db) => platform.askTurn(db, { key: c.key, turnId, kind: 'agent', input: { agentSessionId: c.id, userId: c.user.id, ...input } }),
  });

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
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50, publish: async () => {},
    services: { [WORK.run]: fake(WORK.run), [TURN_STOP]: fake(TURN_STOP) },
  });
  runtimes.push(rt);
  let rk = 0;
  const send = (c, type, payload = {}, source = { kind: 'route' }) => rt.append(machine, c.key,
    { type, payload }, { requestKey: `t-${++rk}`, source });
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const runs = (c) => work.calls.filter((w) => w.kind === WORK.run && w.input.instanceKey === c.key);

  await t.test('T1 asked with its claim: one work item runs the turn, and its claim is released as the item ends', async () => {
    work.answer = null;
    const c = await conversation();
    assert.equal(await ask(c, 'turn-1', { messageText: 'Make it blue' }), true);
    assert.equal((await claim(c)).active_turn.id, 'turn-1');
    await rt.drain();
    assert.equal((await instance(c)).state, 'running');
    const [item] = await items(c, WORK.run);
    assert.equal(item.work_key, 'run:turn-1');
    assert.deepEqual(item.input, {
      agentSessionId: c.id, userId: c.user.id, messageText: 'Make it blue', turnId: 'turn-1', kind: 'agent', instanceKey: c.key,
    }, 'what the run needs: never a key or a secret');
    await settle();
    assert.equal(runs(c).length, 1);
    assert.equal((await instance(c)).state, 'idle');
    const after = await claim(c);
    assert.equal(after.active_turn, null, 'released');
    assert.ok(after.last_done_at, 'the green dot');
    assert.deepEqual(await notes(c), [], 'a turn that finished says nothing more');

    // Without its claim, no turn: a busy conversation asks for nothing.
    assert.equal(await ask(c, 'turn-2'), true);
    assert.equal(await ask(c, 'turn-3'), false);
    await settle();
    assert.deepEqual(runs(c).map((r) => r.input.turnId), ['turn-1', 'turn-2']);
  });

  await t.test('T2 a turn asked for while one runs waits its turn, in order; the same turn twice is one', async () => {
    const c = await conversation();
    await send(c, 'Asked', { turnId: 'a', kind: 'agent', input: {} });
    await send(c, 'Asked', { turnId: 'b', kind: 'agent', input: {} });
    await send(c, 'Asked', { turnId: 'b', kind: 'agent', input: {} });
    await send(c, 'Asked', { turnId: 'a', kind: 'agent', input: {} });
    await send(c, 'Asked', { turnId: 'c', kind: 'agent', input: {} });
    await rt.drain();
    const i = await instance(c);
    assert.equal(i.data.running.turnId, 'a');
    assert.deepEqual(i.data.waiting.map((w) => w.turnId), ['b', 'c']);
    await settle();
    assert.deepEqual(runs(c).map((r) => r.input.turnId), ['a', 'b', 'c']);
    assert.equal((await instance(c)).state, 'idle');
  });

  await t.test('T3 a run that fails for good: its claim released and the turn ended as interrupted, with Retry; only its own claim', async () => {
    const c = await conversation();
    work.answer = () => { throw new Error('the Mayor fell over'); };
    try {
      assert.equal(await ask(c, 'turn-f'), true);
      await settle();
    } finally { work.answer = null; }
    assert.equal((await claim(c)).active_turn, null);
    assert.deepEqual((await notes(c)).map((n) => [n.content, n.metadata.agentSessionEvent, n.metadata.retryable, n.metadata.agentTurnId]),
      [[INTERRUPTED_TEXT, 'turn_interrupted', true, 'turn-f']]);

    // The run released its claim early and the next turn has taken one: the
    // item's end leaves the new claim alone.
    const d = await conversation();
    work.answer = async (ctx) => {
      await agentSessions.releaseTurnLease(pool, { agentSessionId: d.id, turnId: ctx.input.turnId });
      await agentSessions.acquireTurnLease(pool, { agentSessionId: d.id, userId: d.user.id, turnId: 'someone-else' });
      throw new Error('late failure');
    };
    try {
      await ask(d, 'turn-g');
      await settle();
    } finally { work.answer = null; }
    assert.equal((await claim(d)).active_turn.id, 'someone-else', 'not that turn\'s claim');
    assert.deepEqual(await notes(d), [], 'and no note: that turn is not the one ended');
  });

  await t.test('T4 a person\'s Stop: recorded on the turn, and its coding run stopped by its journal when it has one', async () => {
    const c = await conversation();
    let release;
    const gate = new Promise((r) => { release = r; });
    work.answer = async () => { await gate; return { ok: true }; };
    try {
      await ask(c, 'turn-s');
      await rt.drain();
      const running = rt.runServices();
      await new Promise((r) => setTimeout(r, 50));
      await send(c, 'StopRequested', { by: 'ada' });
      await rt.drain();
      assert.equal((await instance(c)).data.running.stoppedBy, 'ada');
      assert.deepEqual(await items(c, TURN_STOP), [], 'no coding run: nothing to stop by a journal');
      const [item] = await items(c, WORK.run);
      const change = await ownedChange(c, item.id);
      await send(c, 'StopRequested', { by: 'ada' });
      await rt.drain();
      const [stop] = await items(c, TURN_STOP);
      assert.deepEqual(stop.input, {
        sessionId: change, machine: MACHINE, key: c.key, kinds: [WORK.run], workKey: 'run:turn-s', by: 'ada', release: false,
      }, 'its record kept, for the run to end it as stopped');
      release();
      await running;
      await settle();
      await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [change]);
    } finally { work.answer = null; release(); }
    assert.equal((await instance(c)).state, 'idle');
    assert.equal((await claim(c)).active_turn, null);
    await send(c, 'StopRequested', { by: 'ada' });
    await rt.drain();
    assert.equal((await instance(c)).state, 'idle', 'a Stop with nothing running changes nothing');
  });

  await t.test('T5 past six hours: the run cancelled, its coding run stopped and released, the claim released as interrupted', async () => {
    assert.equal(MAX_TURN_MS, 6 * 60 * 60 * 1000);
    const c = await conversation();
    let release;
    const gate = new Promise((r) => { release = r; });
    work.answer = async () => { await gate; return { ok: true }; };
    try {
      await ask(c, 'turn-t');
      await ask(c, 'never');
      await send(c, 'Asked', { turnId: 'next', kind: 'agent', input: {} });
      await rt.drain();
      const running = rt.runServices();
      await new Promise((r) => setTimeout(r, 50));
      const [item] = await items(c, WORK.run);
      const change = await ownedChange(c, item.id);
      const c2 = await pool.connect();
      try {
        await c2.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
        await c2.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [MACHINE, c.key]);
        await c2.query('COMMIT');
      } finally { c2.release(); }
      await rt.fireTimers();
      await rt.drain();
      const [stop] = await items(c, TURN_STOP);
      assert.deepEqual([stop.input.sessionId, stop.input.release, stop.input.by], [change, true, null]);
      assert.equal((await claim(c)).active_turn, null);
      assert.deepEqual((await notes(c)).map((n) => n.metadata.agentTurnId), ['turn-t'], 'ended as interrupted, with Retry');
      assert.equal((await instance(c)).data.running.turnId, 'next', 'the next one starts');
      release();
      await running;
      await settle();
    } finally { work.answer = null; release(); }
    assert.equal((await items(c, WORK.run)).find((w) => w.work_key === 'run:turn-t').status, 'settled');
  });

  await t.test('T6 only a conversation or a change is a turn\'s stream, and only the platform asks', async () => {
    const asked = { type: 'Asked', payload: { turnId: 'x', kind: 'agent', input: {} } };
    const outcome = async (id) => {
      await rt.drain();
      const { rows: [e] } = await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [id]);
      return [e.result, e.reason];
    };
    const bad = await rt.append(machine, 'agent:abc', asked, { requestKey: `t-${++rk}`, source: { kind: 'route' } });
    assert.deepEqual(await outcome(bad), ['rejected', 'bad_key']);
    const c = await conversation();
    const o = await rt.append(machine, c.key, asked,
      { requestKey: `t-${++rk}`, source: { kind: 'message', from: { machine: 'x', key: 'y', eventId: 1 } } });
    assert.deepEqual(await outcome(o), ['rejected', 'not_the_platform']);
    await assert.rejects(send(c, 'Asked', { turnId: 'x', kind: 'nope', input: {} }), /Asked needs a kind/);
    assert.equal(await instance(c), undefined, 'nothing started');
  });

  // ── 2. The item's handler (services/turns.js) ───────────────────────
  const turns = require('../src/services/turns');
  const agentTurn = require('../src/services/mayor/agent-turn');
  const recovery = require('../src/services/turn-recovery');
  const localRecovery = require('../src/services/local-agent-recovery');
  const saved = {
    runAgentTurn: agentTurn.runAgentTurn, resolveAgentMayor: agentTurn.resolveAgentMayor,
    recoverOwnedTurn: recovery.recoverOwnedTurn, releaseLeftRecord: recovery.releaseLeftRecord,
    finishAdoptedTurn: localRecovery.finishAdoptedTurn,
  };
  const seen = { runs: [], recovered: [], released: [], local: [] };
  t.after(() => { Object.assign(agentTurn, { runAgentTurn: saved.runAgentTurn, resolveAgentMayor: saved.resolveAgentMayor }); Object.assign(recovery, { recoverOwnedTurn: saved.recoverOwnedTurn, releaseLeftRecord: saved.releaseLeftRecord }); });
  let mayorRun = async () => {};
  agentTurn.resolveAgentMayor = async () => ({ ok: true, provider: 'anthropic', model: 'm' });
  agentTurn.runAgentTurn = async (args) => { seen.runs.push(args); await mayorRun(args); };
  recovery.recoverOwnedTurn = async (args) => { seen.recovered.push(args.sessionId); };
  recovery.releaseLeftRecord = async (args) => { seen.released.push(args.workId); return null; };
  localRecovery.finishAdoptedTurn = async (args) => { seen.local.push(args); return { outcome: 'completed' }; };
  t.after(() => { localRecovery.finishAdoptedTurn = saved.finishAdoptedTurn; });
  const ctxFor = (c, turnId, { lost = 0, aborted = false, input = {} } = {}) => {
    const abort = new AbortController();
    if (aborted) abort.abort();
    return {
      workId: crypto.randomUUID(), kind: WORK.run, key: `run:${turnId}`, resumeFrom: null, lostAttempts: lost, signal: abort.signal,
      input: { agentSessionId: c.id, userId: c.user.id, turnId, kind: 'agent', instanceKey: c.key, ...input },
    };
  };
  const streamTypes = async (c) => (await sessionBus.snapshot(agentTurn.busKey(c.id))).map((e) => e.event?.type ?? e.type);
  const reset = () => {
    for (const list of Object.values(seen)) list.length = 0;
    mayorRun = async () => {};
  };

  await t.test('H1 a run hands the Mayor what was asked, and its coding run\'s owner is this item', async () => {
    reset();
    const c = await conversation();
    const ctx = ctxFor(c, 'h1', { input: { messageText: 'hi', attachments: [{ id: 'f' }], recorded: { id: 9, clientMessageId: null }, model: 'claude-x' } });
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'done' });
    const [r] = seen.runs;
    assert.deepEqual([r.agentSessionId, r.user.id, r.turnId, r.messageText, r.attachments, r.recorded, r.retry, r.followUp, r.res],
      [c.id, c.user.id, 'h1', 'hi', [{ id: 'f' }], { id: 9, clientMessageId: null }, false, null, null]);
    assert.deepEqual(r.owner, { machine: MACHINE, key: c.key, kind: WORK.run, workKey: 'run:h1', workId: ctx.workId },
      'a person\'s Stop and the next claim find the coding run by it');
    assert.deepEqual(seen.recovered, []);
    assert.deepEqual(seen.released, [ctx.workId], 'a record it still holds as it ends is released');
  });

  await t.test('H2 a coding run still owned when the Mayor returned is carried to its end here', async () => {
    reset();
    const c = await conversation();
    const ctx = ctxFor(c, 'h2');
    let change = null;
    mayorRun = async () => { change = await ownedChange(c, ctx.workId); };
    await turns.run(ctx, { config: {}, pool });
    assert.deepEqual(seen.recovered, [change]);
  });

  await t.test('H3 a turn that cannot start says so on its stream, which settles', async () => {
    reset();
    const c = await conversation();
    agentTurn.resolveAgentMayor = async () => ({ ok: false, error: 'Weekly limit reached.' });
    try {
      assert.deepEqual(await turns.run(ctxFor(c, 'h3'), { config: {}, pool }), { ended: 'no_payer' });
    } finally { agentTurn.resolveAgentMayor = async () => ({ ok: true }); }
    assert.deepEqual(await streamTypes(c), ['error', 'done']);
    assert.deepEqual(seen.runs, []);
    const ctx = ctxFor(await conversation(), 'h3b');
    ctx.input.userId = 2147483000;
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'no_user' }, 'the account that asked is gone');
  });

  await t.test('H4 resumed after its process went: its coding run carried on from its record', async () => {
    reset();
    const c = await conversation();
    const ctx = ctxFor(c, 'h4', { lost: 1 });
    const change = await ownedChange(c, ctx.workId);
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'recovered' });
    assert.deepEqual(seen.recovered, [change]);
    assert.deepEqual(seen.runs, [], 'the Mayor is not asked again');
  });

  await t.test('H4b resumed: a local agent\'s turn it dispatched is taken over and finished here, the coding run\'s retries bounded', async () => {
    reset();
    const c = await conversation();
    const ctx = ctxFor(c, 'h4b', { lost: 1 });
    const change = await ownedChange(c, ctx.workId);
    const { rows: [lease] } = await pool.query(
      `INSERT INTO session_agent_leases (session_id, user_id, label, expires_at) VALUES ($1, $2, 'laptop', NOW() + interval '2 minutes') RETURNING id`,
      [change, c.user.id]);
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [change]);
    const queued = await require('../src/services/local-agent').enqueueTurn(pool, {
      sessionId: change, userId: c.user.id, prompt: 'p', owner: { machine: MACHINE, key: c.key, kind: WORK.run, workKey: 'run:h4b', workId: ctx.workId },
    });
    assert.ok(queued && lease);
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'recovered' });
    assert.equal(seen.local.length, 1);
    assert.equal(String(seen.local[0].turn.id), String(queued.turn.id));
    assert.notEqual(seen.local[0].turn.waiter_id, queued.waiterId, 'waited for under the item\'s new claim');
    assert.equal(typeof seen.local[0].deps.finalizeRecoveredTurn, 'function');
    assert.deepEqual(seen.recovered, []);

    // A coding run whose recovery cannot read the worker yet: tried again.
    reset();
    const d = await conversation();
    const ctx2 = ctxFor(d, 'h4c', { lost: 1 });
    await ownedChange(d, ctx2.workId);
    let fails = 2;
    recovery.recoverOwnedTurn = async (args) => {
      seen.recovered.push(args.sessionId);
      if (fails-- > 0) throw Object.assign(new Error('runtime unavailable'), { retryWorkerRecovery: true });
    };
    const was = { ...turns.RECOVERY_RETRY };
    Object.assign(turns.RECOVERY_RETRY, { ms: 1, tries: 3 });
    try {
      assert.deepEqual(await turns.run(ctx2, { config: {}, pool }), { ended: 'recovered' });
      assert.equal(seen.recovered.length, 3);
      fails = 5;
      const ctx3 = ctxFor(d, 'h4e', { lost: 1 });
      await ownedChange(d, ctx3.workId);
      seen.recovered.length = 0;
      await assert.rejects(turns.run(ctx3, { config: {}, pool }), /runtime unavailable/);
      assert.equal(seen.recovered.length, 3, 'given up after its tries');
    } finally {
      Object.assign(turns.RECOVERY_RETRY, was);
      recovery.recoverOwnedTurn = async (args) => { seen.recovered.push(args.sessionId); };
    }
  });

  await t.test('H5 resumed: an answer already written is over; one cut before it ends as interrupted, once', async () => {
    reset();
    const c = await conversation();
    await agentSessions.acquireTurnLease(pool, { agentSessionId: c.id, userId: c.user.id, turnId: 'h5' });
    await pool.query(
      `INSERT INTO chat_session_messages (agent_session_id, role, content, metadata) VALUES ($1, 'assistant', 'Done.', $2::jsonb)`,
      [c.id, JSON.stringify({ agentTurnId: 'h5' })]);
    assert.deepEqual(await turns.run(ctxFor(c, 'h5', { lost: 1 }), { config: {}, pool }), { ended: 'done' });
    assert.deepEqual(await notes(c), []);
    assert.deepEqual(await streamTypes(c), ['done']);

    const d = await conversation();
    await agentSessions.acquireTurnLease(pool, { agentSessionId: d.id, userId: d.user.id, turnId: 'h5b' });
    await pool.query(
      `INSERT INTO chat_session_messages (agent_session_id, role, content, metadata) VALUES ($1, 'assistant', 'On it.', $2::jsonb)`,
      [d.id, JSON.stringify({ agentTurnId: 'h5b', dispatch: { tool: 'start_build' } })]);
    assert.deepEqual(await turns.run(ctxFor(d, 'h5b', { lost: 1 }), { config: {}, pool }), { ended: 'interrupted' },
      'a dispatch whose coding run never started is not an answer');
    assert.deepEqual((await notes(d)).map((n) => [n.content, n.metadata.retryable]), [[INTERRUPTED_TEXT, true]]);
    assert.equal((await claim(d)).active_turn, null);
    assert.deepEqual(await streamTypes(d), ['done']);
  });

  await t.test('H6 a process that lost the item leaves its record to the next claim', async () => {
    reset();
    const c = await conversation();
    await turns.run(ctxFor(c, 'h6', { aborted: true }), { config: {}, pool });
    assert.deepEqual(seen.released, [], 'released only by the attempt that ends the item');
  });

  await t.test('H7 the item runs the real handler through the workflow', async () => {
    reset();
    const c = await conversation();
    const { turnServices } = require('../src/workflow/turn/services.ts');
    const rt2 = createRuntime({
      pool, machines: [turnMachine()], pollMs: 50, publish: async () => {},
      services: { ...turnServices({ config: {}, pool }), [TURN_STOP]: fake(TURN_STOP) },
    });
    runtimes.push(rt2);
    mayorRun = async (args) => {
      await pool.query(
        `INSERT INTO chat_session_messages (agent_session_id, role, content, metadata) VALUES ($1, 'assistant', 'Hello.', $2::jsonb)`,
        [args.agentSessionId, JSON.stringify({ agentTurnId: args.turnId })]);
    };
    await ask(c, 'h7', { messageText: 'hello' });
    for (let i = 0; i < 30; i++) {
      await rt2.drain();
      if (!(await rt2.runServices())) { await rt2.drain(); break; }
    }
    assert.deepEqual(seen.runs.map((r) => [r.turnId, r.messageText]), [['h7', 'hello']]);
    assert.equal((await claim(c)).active_turn, null);
    assert.equal((await instance(c)).state, 'idle');
  });
});
