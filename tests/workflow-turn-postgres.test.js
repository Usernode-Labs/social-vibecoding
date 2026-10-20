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

  // ── 3. A change's own dev chat turn (the classic kind) ──────────────
  const mayorTurn = require('../src/services/mayor/turn');
  const sessionsRoutes = require('../src/routes/sessions');
  const limits = require('../src/services/limits');
  const savedClassic = {
    runMayorTurn: mayorTurn.runMayorTurn, requestSessionStop: sessionsRoutes.requestSessionStop,
    notifySessionStalled: sessionsRoutes.notifySessionStalled, resolveBillingPath: limits.resolveBillingPath,
  };
  t.after(() => {
    mayorTurn.runMayorTurn = savedClassic.runMayorTurn;
    sessionsRoutes.requestSessionStop = savedClassic.requestSessionStop;
    sessionsRoutes.notifySessionStalled = savedClassic.notifySessionStalled;
    limits.resolveBillingPath = savedClassic.resolveBillingPath;
  });
  const classic = { turns: [], stops: [], stalled: [] };
  let classicRun = async () => {};
  mayorTurn.runMayorTurn = async (args, deps) => { classic.turns.push({ args, deps }); await classicRun(args); };
  sessionsRoutes.requestSessionStop = async (args) => { classic.stops.push(args); return { status: 202, body: {} }; };
  sessionsRoutes.notifySessionStalled = async (_pool, id) => { classic.stalled.push(id); };
  limits.resolveBillingPath = async () => ({ apiKey: 'their-own-key' });
  async function change() {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [`tc_${++seq}`]);
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url) VALUES ($1::text, $1::text, $2, 'https://github.com/acme/x') RETURNING id`,
      [`tc-app-${++seq}`, u.id]);
    const { rows: [cs] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name, source) VALUES ($1, $2, 'active', 'dev/x', 'cli_handoff') RETURNING id`,
      [a.id, u.id]);
    return { id: cs.id, user: u, key: `session:${cs.id}` };
  }
  const classicCtx = (c, turnId, { lost = 0, input = {} } = {}) => ({
    workId: crypto.randomUUID(), kind: WORK.run, key: `run:${turnId}`, resumeFrom: null, lostAttempts: lost,
    signal: new AbortController().signal,
    input: { sessionId: c.id, userId: c.user.id, messageText: 'Add a toggle', selectedModel: 'claude-x', isOpenRouterSession: false,
      turnAttachments: [{ id: 'f1' }], userMessageId: 77, clientMessageId: 'c-1', turnId, kind: 'classic', instanceKey: c.key, ...input },
  });

  await t.test('C1 a dev chat turn runs the Mayor with what was asked, its payer read as it runs, its owner this item', async () => {
    classic.turns.length = 0;
    const c = await change();
    const ctx = classicCtx(c, 'c1');
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'done' });
    const [{ args, deps }] = classic.turns;
    assert.equal(args.session.id, c.id);
    assert.deepEqual([args.req.user.id, args.messageText, args.selectedModel, args.turnAttachments, args.userMessageId, args.clientMessageId],
      [c.user.id, 'Add a toggle', 'claude-x', [{ id: 'f1' }], 77, 'c-1']);
    assert.equal(args.userApiKey, 'their-own-key', 'the key is read when the turn runs, never carried in what it was asked');
    assert.deepEqual(args.owner, { machine: MACHINE, key: c.key, kind: WORK.run, workKey: 'run:c1', workId: ctx.workId });
    assert.equal(args.res, turns.NO_RESPONSE, 'its events reach the request through its stream');
    assert.equal(await args.scheduleInteractiveRecovery(c.id), true, 'a retained record is the item\'s own to carry on');
    assert.equal(deps, sessionsRoutes.MAYOR_TURN_DEPS);

    // A change that can no longer take a message here: said on its stream.
    classic.turns.length = 0;
    await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [c.id]);
    assert.deepEqual(await turns.run(classicCtx(c, 'c1b'), { config: {}, pool }), { ended: 'gone' });
    assert.deepEqual(classic.turns, []);
    assert.deepEqual((await sessionBus.snapshot(c.id)).map((e) => (e.event || e).type).slice(-2), ['error', 'done']);
  });

  await t.test('C2 a person\'s Stop reaches the running turn from its instance, wherever it runs, once', async () => {
    classic.turns.length = 0; classic.stops.length = 0;
    const c = await change();
    const was = turns.STOP_POLL.ms;
    turns.STOP_POLL.ms = 20;
    let release;
    const gate = new Promise((r) => { release = r; });
    classicRun = () => gate;
    work.answer = () => new Promise(() => {});
    try {
      await send(c, 'Asked', { turnId: 'c2', kind: 'classic', input: {} });
      await rt.drain();
      const running = turns.run(classicCtx(c, 'c2'), { config: {}, pool });
      await new Promise((r) => setTimeout(r, 80));
      assert.deepEqual(classic.stops, [], 'nothing until a person stops it');
      // The Stop route, from any process: the turn's instance is where it lands.
      const { rows: [owner] } = await pool.query(require('../src/workflow/session-work.ts').TURN_OWNER_SQL, [c.id]);
      assert.deepEqual({ ...owner }, { machine: 'turn', key: c.key }, 'a Mayor turn with no record yet is found by its instance');
      await send(c, 'StopRequested', { by: 'ada' });
      await rt.drain();
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(classic.stops.length, 1, 'applied once');
      assert.deepEqual([classic.stops[0].sessionId, classic.stops[0].forwarded, classic.stops[0].user.username, classic.stops[0].user.id],
        [c.id, true, 'ada', c.user.id], 'through the turn\'s own handle, past the routing it already went through');
      release();
      await running;
    } finally {
      turns.STOP_POLL.ms = was; classicRun = async () => {}; work.answer = null; release();
    }
  });

  await t.test('C3 resumed: what it dispatched is carried on; a turn cut before its reply gets the dev chat\'s note, once', async () => {
    reset(); classic.turns.length = 0; classic.stalled.length = 0;
    const c = await change();
    const ctx = classicCtx(c, 'c3', { lost: 1 });
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [c.id, JSON.stringify({
      turnId: 'job', mode: 'build', owner: { machine: MACHINE, key: c.key, kind: WORK.run, workKey: 'run:c3', workId: ctx.workId } })]);
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'recovered' });
    assert.deepEqual(seen.recovered, [c.id]);
    assert.deepEqual(classic.turns, [], 'the Mayor is not asked again');

    const d = await change();
    await pool.query(`INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'user', 'Add a toggle', '{}')`, [d.id]);
    assert.deepEqual(await turns.run(classicCtx(d, 'c3b', { lost: 1 }), { config: {}, pool }), { ended: 'interrupted' });
    assert.deepEqual(await turns.run(classicCtx(d, 'c3b', { lost: 2 }), { config: {}, pool }), { ended: 'interrupted' });
    const { rows: crumbs } = await pool.query(
      `SELECT content, metadata FROM chat_session_messages WHERE session_id = $1 AND role = 'system'`, [d.id]);
    assert.equal(crumbs.length, 1, 'once');
    assert.equal(crumbs[0].metadata.recoveredReason, 'unanswered');
    assert.ok(Array.isArray(crumbs[0].metadata.quickReplies), 'with its pills');
    assert.deepEqual(classic.stalled, [d.id], 'and the bell says it stopped before finishing');
    assert.equal((await sessionBus.snapshot(d.id)).map((e) => (e.event || e).type).pop(), 'done');
  });

  // ── 4. A headless run (an auto session on a request) ────────────────
  const github = require('../src/services/github');
  const savedHeadless = {
    runHeadlessSessionInner: sessionsRoutes.runHeadlessSessionInner, resumeOneHeadlessRun: sessionsRoutes.resumeOneHeadlessRun,
    failHeadlessRun: sessionsRoutes.failHeadlessRun, fetchPublicIssue: github.fetchPublicIssue,
    fetchIssueComments: github.fetchIssueComments, getBotUsername: github.getBotUsername,
  };
  t.after(() => { Object.assign(sessionsRoutes, {
    runHeadlessSessionInner: savedHeadless.runHeadlessSessionInner, resumeOneHeadlessRun: savedHeadless.resumeOneHeadlessRun,
    failHeadlessRun: savedHeadless.failHeadlessRun });
  Object.assign(github, { fetchPublicIssue: savedHeadless.fetchPublicIssue, fetchIssueComments: savedHeadless.fetchIssueComments,
    getBotUsername: savedHeadless.getBotUsername }); });
  const headless = { runs: [], resumes: [], failed: [] };
  let headlessRun = async () => {};
  let headlessResume = async () => {};
  sessionsRoutes.runHeadlessSessionInner = async (args) => { headless.runs.push(args); await headlessRun(args); };
  sessionsRoutes.resumeOneHeadlessRun = async (args) => { headless.resumes.push(args); await headlessResume(args); };
  sessionsRoutes.failHeadlessRun = async (_pool, session, message) => { headless.failed.push([session.id, message]); };
  github.fetchPublicIssue = async (_o, _r, n) => ({ issue: { number: n, title: 'Make it better' } });
  github.fetchIssueComments = async () => ({ comments: [{ body: 'yes please' }] });
  github.getBotUsername = async () => 'usernode-bot';
  const resetHeadless = () => { for (const l of Object.values(headless)) l.length = 0; headlessRun = async () => {}; headlessResume = async () => {}; };
  async function autoRun({ status = 'generating' } = {}) {
    const c = await change();
    await pool.query(
      `UPDATE chat_sessions SET is_headless = TRUE, headless_status = $2, headless_step = 'planning', headless_issue_number = 5 WHERE id = $1`,
      [c.id, status]);
    return c;
  }
  const headlessCtx = (c, turnId, { lost = 0 } = {}) => ({
    workId: crypto.randomUUID(), kind: WORK.run, key: `run:${turnId}`, resumeFrom: null, lostAttempts: lost,
    signal: new AbortController().signal,
    input: { sessionId: c.id, userId: c.user.id, selectedModel: 'claude-x', turnId, kind: 'headless', instanceKey: c.key },
  });

  await t.test('A1 a headless run reads its request and payer as it runs, its coding runs owned by its item', async () => {
    resetHeadless();
    const c = await autoRun();
    const ctx = headlessCtx(c, 'a1');
    assert.deepEqual(await turns.run(ctx, { config: { dataEncryptionKey: 'k' }, pool }), { ended: 'done' });
    const [r] = headless.runs;
    assert.equal(r.session.id, c.id);
    assert.deepEqual([r.user.id, r.user.username, r.selectedModel, r.repoOwner, r.repoName, r.issueNumber],
      [c.user.id, c.user.username, 'claude-x', 'acme', 'x', 5]);
    assert.deepEqual([r.issue.title, r.comments, r.botUsername], ['Make it better', [{ body: 'yes please' }], 'usernode-bot'],
      'read here, never carried in what the turn was asked');
    assert.equal(r.userApiKey, 'their-own-key');
    assert.deepEqual(r.owner, { machine: MACHINE, key: c.key, kind: WORK.run, workKey: 'run:a1', workId: ctx.workId });
    assert.deepEqual(headless.resumes, []);

    resetHeadless();
    const done = await autoRun({ status: 'ready' });
    assert.deepEqual(await turns.run(headlessCtx(done, 'a1b'), { config: {}, pool }), { ended: 'gone' }, 'over before it ran');
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"t","phase":"cleanup_pending"}'::jsonb WHERE id = $1`, [done.id]);
    assert.deepEqual(await turns.run(headlessCtx(done, 'a1c'), { config: {}, pool }), { ended: 'gone' },
      'a finished run whose record still awaits its cleanup is not run again');
    assert.deepEqual(headless.runs, []);
  });

  await t.test('A2 a run whose durable state is retained is carried on from its row by its own item, then failed if it never settles', async () => {
    resetHeadless();
    const c = await autoRun();
    const was = { ...turns.RECOVERY_RETRY };
    Object.assign(turns.RECOVERY_RETRY, { ms: 1, tries: 3 });
    try {
      headlessRun = async (args) => { args.onRetained(new Error('worker unreachable')); };
      let retainedTimes = 1;
      headlessResume = async (args) => { if (retainedTimes-- > 0) args.onRetained(new Error('still')); };
      const ctx = headlessCtx(c, 'a2');
      assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'done' });
      assert.equal(headless.resumes.length, 2, 'carried on until it settles');
      assert.deepEqual(headless.resumes[0].owner, { machine: MACHINE, key: c.key, kind: WORK.run, workKey: 'run:a2', workId: ctx.workId });
      assert.deepEqual(headless.failed, []);

      resetHeadless();
      headlessRun = async (args) => { args.onRetained(new Error('worker unreachable')); };
      headlessResume = async (args) => { args.onRetained(new Error('never')); };
      await turns.run(headlessCtx(c, 'a2b'), { config: {}, pool });
      assert.equal(headless.resumes.length, 3, 'its tries, no more');
      assert.equal(headless.failed.length, 1);
      assert.equal(headless.failed[0][0], c.id);

      resetHeadless();
      headlessResume = async () => { throw Object.assign(new Error('worker state unreadable'), { retainActiveTurn: true, retryWorkerRecovery: true }); };
      await turns.run(headlessCtx(c, 'a2c', { lost: 1 }), { config: {}, pool });
      assert.equal(headless.resumes.length, 3, 'a retained error is tried again too');
      assert.equal(headless.failed.length, 1);
      resetHeadless();
      headlessResume = async () => { throw new Error('a bug'); };
      await turns.run(headlessCtx(c, 'a2d', { lost: 1 }), { config: {}, pool });
      assert.deepEqual([headless.resumes.length, headless.failed.length], [1, 1], 'anything else fails the run at once');
    } finally {
      Object.assign(turns.RECOVERY_RETRY, was);
    }
  });

  await t.test('A3 resumed after its process went: carried on from its row; a run already over is left', async () => {
    resetHeadless();
    const c = await autoRun();
    const ctx = headlessCtx(c, 'a3', { lost: 1 });
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'recovered' });
    assert.deepEqual(headless.runs, [], 'not started again');
    assert.equal(headless.resumes.length, 1);
    assert.equal(headless.resumes[0].session.id, c.id);
    resetHeadless();
    await pool.query(`UPDATE chat_sessions SET headless_status = 'ready' WHERE id = $1`, [c.id]);
    await turns.run(headlessCtx(c, 'a3b', { lost: 1 }), { config: {}, pool });
    assert.deepEqual(headless.resumes, []);
  });

  // ── 5. ROLLOUT-ONLY: what an older release leaves (turn-leftovers.js) ─
  const leftovers = require('../src/services/turn-leftovers');
  const leftoverPass = () => leftovers.sweep(pool, { config: {}, deps: { localPass: async () => ({ adopted: 0 }) } });
  const askedOn = async (key) => (await pool.query(
    `SELECT payload FROM wf_events WHERE machine = 'turn' AND key = $1 AND type = 'Asked' ORDER BY id`, [key])).rows.map((r) => r.payload);
  const oldClaim = async (c, { turnId, renewedSecondsAgo }) => pool.query(
    `UPDATE agent_sessions SET active_turn = jsonb_build_object('id', $2::text, 'phase', 'mayor',
        'startedAt', NOW() - make_interval(secs => $3 + 60), 'renewedAt', NOW() - make_interval(secs => $3)) WHERE id = $1`,
    [c.id, turnId, renewedSecondsAgo]);

  await t.test('L1 an older release\'s conversation claim: ended once stale, quietly when it was answered, never one still renewed or still working', async () => {
    const dead = await conversation();
    await oldClaim(dead, { turnId: 'old-1', renewedSecondsAgo: 200 });
    const answered = await conversation();
    await oldClaim(answered, { turnId: 'old-2', renewedSecondsAgo: 200 });
    await pool.query(`INSERT INTO chat_session_messages (agent_session_id, role, content, metadata) VALUES ($1, 'assistant', 'Done.', '{}')`, [answered.id]);
    const live = await conversation();
    await oldClaim(live, { turnId: 'old-3', renewedSecondsAgo: 10 });
    const building = await conversation();
    await oldClaim(building, { turnId: 'old-4', renewedSecondsAgo: 200 });
    const change = await ownedChange(building, 'someone');
    await pool.query(`UPDATE chat_sessions SET active_turn = active_turn - 'owner' WHERE id = $1`, [change]);
    await pool.query('UPDATE agent_sessions SET active_change_id = $2 WHERE id = $1', [building.id, change]);
    const mine = await conversation();
    await ask(mine, 'new-1');
    const running = await conversation();
    work.answer = () => new Promise(() => {});
    await ask(running, 'new-2');
    await rt.drain();
    // A long turn of this release: its claim is old and never renewed, and
    // its instance runs it.
    await pool.query(`UPDATE agent_sessions SET active_turn = active_turn || jsonb_build_object('startedAt', NOW() - interval '2 hours') WHERE id = $1`, [running.id]);

    const out = await leftoverPass();
    assert.equal(out.claims, 2);
    assert.equal((await claim(dead)).active_turn, null);
    assert.deepEqual((await notes(dead)).map((n) => [n.metadata.agentTurnId, n.metadata.retryable]), [['old-1', true]], 'interrupted, with Retry');
    const a = await claim(answered);
    assert.equal(a.active_turn, null);
    assert.ok(a.last_done_at, 'finished: the dot');
    assert.deepEqual(await notes(answered), [], 'and no note');
    assert.equal((await claim(live)).active_turn.id, 'old-3', 'still renewed: its process runs it');
    assert.equal((await claim(building)).active_turn.id, 'old-4', 'its build is still to be recovered');
    assert.equal((await claim(mine)).active_turn.id, 'new-1', 'a turn the machine was asked for is the machine\'s');
    assert.equal((await claim(running)).active_turn.id, 'new-2', 'and one it runs, however long');
    work.answer = null;
    assert.equal((await leftoverPass()).claims, 0, 'once');
    await rt.drain();
  });

  await t.test('L2 a coding record no work item holds: a recover turn asked once, never while a live process or its item holds it', async () => {
    const quiet = (turnId, extra = {}) => JSON.stringify({ turnId, mode: 'build', startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), ...extra });
    const c = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [c.id, quiet('old-job')]);
    const held = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [held.id, quiet('held-job')]);
    const fresh = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [fresh.id,
      JSON.stringify({ turnId: 'fresh-job', mode: 'build', startedAt: new Date().toISOString() })]);
    // An item that settled without releasing its record (its release failed).
    const { rows: [doneItem] } = await pool.query(`SELECT id FROM wf_work WHERE kind = $1 AND status = 'settled' LIMIT 1`, [WORK.run]);
    const settledOwner = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [settledOwner.id,
      quiet('settled-job', { owner: { machine: MACHINE, key: settledOwner.key, kind: WORK.run, workKey: 'run:s', workId: doneItem.id } })]);
    await pool.query(`INSERT INTO platform_processes (id, release) VALUES ('old-pod', 'old')`);
    await pool.query(`INSERT INTO process_holds (process_id, kind, ref) VALUES ('old-pod', 'session', $1::text)`, [held.id]);
    const { rows: [liveItem] } = await pool.query(`SELECT id FROM wf_work WHERE kind = $1 AND status IN ('queued', 'running') LIMIT 1`, [WORK.run]);
    const owned = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [owned.id,
      quiet('owned-job', { owner: { machine: MACHINE, key: owned.key, kind: WORK.run, workKey: 'run:o', workId: liveItem.id } })]);
    const before = (await leftoverPass()).records;
    assert.ok(before >= 1);
    assert.deepEqual((await askedOn(c.key)).map((p) => [p.kind, p.turnId, p.input.sessionId]), [['recover', 'leftover-old-job', c.id]]);
    assert.deepEqual(await askedOn(held.key), [], 'its process finishes it');
    assert.deepEqual(await askedOn(owned.key), [], 'a record its outstanding item owns is that item\'s');
    assert.deepEqual(await askedOn(fresh.key), [], 'one that just moved may still be its process\'s');
    assert.deepEqual((await askedOn(settledOwner.key)).map((p) => p.kind), ['recover'], 'one its settled item left is nobody\'s');
    await leftoverPass();
    assert.equal((await askedOn(c.key)).length, 1, 'asked once');
    await pool.query(`UPDATE platform_processes SET heartbeat_at = NOW() - interval '5 minutes' WHERE id = 'old-pod'`);
    await leftoverPass();
    assert.deepEqual((await askedOn(held.key)).map((p) => p.kind), ['recover'], 'once its process is gone');
    await pool.query(`DELETE FROM platform_processes WHERE id = 'old-pod'`);
    for (const x of [c, held, owned, fresh, settledOwner]) await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [x.id]);
    // A recover turn runs the leader's adoption, as an unowned one.
    reset();
    const was = recovery.recoverOwnedTurn;
    const args = [];
    recovery.recoverOwnedTurn = async (a) => { args.push(a); };
    try {
      assert.deepEqual(await turns.run({ ...classicCtx(c, 'leftover-old-job'), input: { sessionId: c.id, kind: 'recover', turnId: 'x', instanceKey: c.key } },
        { config: {}, pool }), { ended: 'recovered' });
    } finally { recovery.recoverOwnedTurn = was; }
    assert.deepEqual(args.map((a) => [a.sessionId, a.owned]), [[c.id, false]]);
  });

  await t.test('L3 a headless run no turn carries is resumed by one asked once; a run with its turn is left', async () => {
    resetHeadless();
    const old = await autoRun();
    const carried = await autoRun();
    await send(carried, 'Asked', { turnId: 'mine', kind: 'headless', input: {} });
    await rt.drain();
    // A staging fixture's run: nobody behind it, never resumed (migrate.js).
    const fixture = await autoRun();
    await pool.query('UPDATE chat_sessions SET user_id = NULL WHERE id = $1', [fixture.id]);
    await leftoverPass();
    await leftoverPass();
    assert.deepEqual((await askedOn(old.key)).map((p) => [p.kind, p.input.resume]), [['headless', true]]);
    assert.equal((await askedOn(carried.key)).length, 1, 'only its own');
    assert.deepEqual(await askedOn(fixture.key), [], 'a run with no person behind it is left as it is');
    // Asked to resume, it resumes rather than starting the run again.
    const ctx = { ...headlessCtx(old, 'leftover-headless'), input: { ...headlessCtx(old, 'x').input, resume: true } };
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'recovered' });
    assert.deepEqual([headless.runs.length, headless.resumes.length], [0, 1]);
    for (const x of [old, carried, fixture]) await pool.query(`UPDATE chat_sessions SET headless_status = 'failed' WHERE id = $1`, [x.id]);
  });

  await t.test('L4 dev chat turns an older release cut are repaired once per release, once no process of it is live', async () => {
    classic.stalled.length = 0;
    const d = await change();
    await pool.query(`INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'user', 'Add a toggle', '{}')`, [d.id]);
    await pool.query(`INSERT INTO platform_processes (id, release) VALUES ('old-pod-2', 'old-release')`);
    const pass = (previous) => leftovers.sweep(pool, { config: {}, previous, deps: { release: 'new-release', localPass: async () => ({ adopted: 0 }) } });
    const crumbs = async () => (await pool.query(
      `SELECT metadata FROM chat_session_messages WHERE session_id = $1 AND role = 'system'`, [d.id])).rows;
    let out = await pass(null);
    assert.equal(out.unanswered, null, 'an older release still runs: its turns may still answer');
    assert.equal(out.backfilled, null);
    assert.deepEqual(await crumbs(), []);
    await pool.query(`DELETE FROM platform_processes WHERE id = 'old-pod-2'`);
    out = await pass(out);
    assert.equal(out.backfilled, 'new-release');
    assert.ok(out.unanswered.breadcrumb >= 1);
    assert.deepEqual((await crumbs()).map((c) => c.metadata.recoveredReason), ['unanswered']);
    await pool.query(`INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'user', 'Still there?', '{}')`, [d.id]);
    out = await pass(out);
    assert.equal(out.unanswered, null, 'once per release');
    assert.equal((await crumbs()).length, 1);
  });

  // ── 6. Global Chat: request-scoped, its Stop from any process ───────
  await t.test('G1 a Stop is stamped on the thread\'s running turn and read by it; a later turn is not stopped by it', async () => {
    const store = require('../src/services/global-chat/store');
    const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [`gc_${++seq}`]);
    const thread = await store.createThread(pool, u.id);
    const args = { userId: u.id, threadId: thread.id };
    assert.equal(await store.requestTurnCancel(pool, args), null, 'nothing runs: nothing to stop');
    const first = await store.claimTurn(pool, args);
    assert.equal(await store.turnCancelled(pool, args), false);
    assert.equal(await store.requestTurnCancel(pool, args), first);
    assert.equal(await store.turnCancelled(pool, args), true, 'the turn reads it on whichever process runs it');
    await store.releaseTurn(pool, { ...args, turnId: first });
    await store.claimTurn(pool, args);
    assert.equal(await store.turnCancelled(pool, args), false, 'a Stop of one turn never stops the next');
    await store.deleteThread(pool, u.id, thread.id);
    assert.equal(await store.turnCancelled(pool, args), true, 'nor runs one on a thread that was deleted');
  });

  await t.test('G2 usage a turn never settled is settled as an interrupted error at its estimate, once no turn could settle it', async () => {
    const accounting = require('../src/services/global-chat/accounting');
    const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [`gu_${++seq}`]);
    const row = async (age, outcome = 'unknown') => (await pool.query(
      `INSERT INTO global_chat_usage (id, user_id, cost_usd, cost_source, outcome, created_at)
       VALUES (gen_random_uuid(), $1, 0.01, 'catalog_estimate', $2, NOW() - make_interval(mins => $3)) RETURNING id`,
      [u.id, outcome, age])).rows[0].id;
    const left = await row(30);
    const running = await row(2);
    const settled = await row(30, 'success');
    assert.deepEqual(await accounting.settleAbandonedReservations(pool), { settled: 1 });
    const read = async (id) => (await pool.query('SELECT outcome, error_code, cost_usd::text AS cost FROM global_chat_usage WHERE id = $1', [id])).rows[0];
    assert.deepEqual({ ...(await read(left)) }, { outcome: 'error', error_code: 'interrupted', cost: '0.01000000' }, 'kept at its estimate');
    assert.equal((await read(running)).outcome, 'unknown', 'a turn may still settle it');
    assert.equal((await read(settled)).outcome, 'success');
    assert.deepEqual(await accounting.settleAbandonedReservations(pool), { settled: 0 });
  });
});
