'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { workerStop, MACHINE, WORK, WAIT_MS, stopKey } = require('../src/workflow/worker-stop/machine.ts');
const { stopTarget, snapshot, legacyTurnKey } = require('../src/workflow/worker-stop/target.ts');
const { requestWorkerStop } = require('../src/workflow/worker-stop/request.ts');
const { workerStopServices, workerInterruptServices } = require('../src/workflow/worker-stop/services.ts');
const { workerInterrupt, requestWorkerInterrupt, interruptKey, MACHINE: INTERRUPT, WORK: INTERRUPT_WORK, DISPATCH } = require('../src/workflow/worker-stop/interrupt.ts');
const { asTransition } = require('./lib/as-transition');

test('force-stop commands against the full PostgreSQL schema', { timeout: 60000 }, async t => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; TEST_DATABASE_URL requires this regression'); return;
  }
  const name = `worker_stop_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(admin.options.connectionString); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  t.mock.method(require('../src/db/pool'), 'getPool', () => pool);
  const worker = require('../src/services/worker');
  const calls = []; const announcements = [];
  let kill = 'stopped'; let beforeDelete = null; let rescueError = null; let afterKill = null; let removalError = null;
  let afterRescue = null;
  const removalWaits = []; const killTimeouts = [];
  let ordinary = false; let executing = false; let beforeProbe = null;
  t.mock.method(worker, 'stopTurn', () => { throw new Error('registry-based signalling is forbidden'); });
  t.mock.method(worker, 'signalLegacyTurn', async id => {
    if (!ordinary) throw new Error('generic process-tree kill is forbidden');
    calls.push(['legacy-signal', id]);
  });
  t.mock.method(worker, 'evictWorker', () => { throw new Error('unfenced eviction is forbidden'); });
  t.mock.method(worker, 'isWorkerExecuting', async () => {
    if (!ordinary) throw new Error('a root-only probe is not force-stop confirmation');
    calls.push(['probe']); if (beforeProbe) await beforeProbe(); return executing;
  });
  t.mock.method(worker, 'stopTurnByJournal', async (id, journal, options) => {
    calls.push([options.force === false ? 'signal' : 'kill', id, journal, process.env.PROCESS_ROLE]);
    killTimeouts.push(options.timeoutMs);
    if (afterKill) await afterKill(id);
    if (kill instanceof Error) throw kill;
    return kill;
  });
  t.mock.method(worker, 'rescueUnpushedCommit', async id => {
    calls.push(['rescue', id]); if (rescueError) throw rescueError;
    if (afterRescue) await afterRescue(id);
    return { attempted: false };
  });
  t.mock.method(worker, 'removeWorker', async (id, options) => {
    removalWaits.push(options.waitMs);
    calls.push(['identity', id]);
    if (beforeDelete) await beforeDelete(id);
    if (!(await options.proceed())) return { skipped: true };
    calls.push(['delete', id]); await options.renew();
    if (removalError) throw removalError;
    await pool.query('DELETE FROM session_workers WHERE session_id = $1', [id]);
    return { removed: true };
  });
  t.mock.method(require('../src/services/ws'), 'broadcastGlobal', event => announcements.push(event));
  t.mock.method(require('../src/services/session-bus'), 'publish', () => {});
  const role = process.env.PROCESS_ROLE; process.env.PROCESS_ROLE = 'web';
  const services = { ...workerStopServices({ pool }), ...workerInterruptServices({ pool }) };
  const web = createRuntime({ pool, machines: [workerStop(), workerInterrupt()], services, slots: 0 });
  const conductor = createRuntime({ pool, machines: [workerStop(), workerInterrupt()], services, slots: 1 });
  t.after(async () => {
    await web.stop(); await conductor.stop(); await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end();
    if (role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = role;
  });
  let seq = 0;
  async function session({ active = true, actor = null } = {}) {
    const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [`stop_${++seq}`]);
    const { rows: [a] } = await pool.query(`INSERT INTO apps (name, slug, status, created_by) VALUES ($1, $1, 'running', $2) RETURNING id`, [`stop-${seq}`, u.id]);
    const turn = active ? { turnId: `job-${seq}`, journal: `/home/node/.claude/turn-job-${seq}.log`, phase: 'executing', mode: 'build', backend: 'claude_code' } : null;
    const { rows: [s] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, status, active_turn)
      VALUES ($1, $2, 'active', $3::jsonb) RETURNING id`, [a.id, u.id, turn ? JSON.stringify(turn) : null]);
    await pool.query('INSERT INTO session_workers (session_id) VALUES ($1)', [s.id]);
    return { sessionId: s.id, userId: actor || u.id, ownerId: u.id, appId: a.id, turn };
  }
  const current = async s => (await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [s.sessionId])).rows[0].active_turn;
  const request = s => ({ sessionId: s.sessionId, userId: s.userId, expectedTurnId: s.turn?.turnId || null });
  async function append(s, over = {}, envelope = {}) {
    const target = await stopTarget(pool, s.sessionId, s.userId); assert.ok(target);
    const requestId = randomUUID();
    const payload = { ...snapshot(target), requestId, ...over };
    const key = stopKey(s.sessionId, requestId);
    const id = await web.append(MACHINE, key, { type: 'Requested', payload }, {
      appId: s.appId, actor: `user:${s.userId}`, source: { kind: 'route', name: WORK }, requestKey: requestId, ...envelope,
    });
    return { id, key, payload };
  }
  async function settle(rt = conductor) {
    process.env.PROCESS_ROLE = 'conductor';
    try { await rt.runServices(); await rt.drain(); } finally { process.env.PROCESS_ROLE = 'web'; }
  }
  async function result(e) {
    const out = await web.waitFor(MACHINE, e.key, i => i.state === 'done', 1000);
    assert.equal(out?.state, 'done'); return out.data.result;
  }
  function reset() {
    calls.length = 0; announcements.length = 0; kill = 'stopped'; beforeDelete = null;
    rescueError = null; afterKill = null; removalError = null;
    afterRescue = null; removalWaits.length = 0; killTimeouts.length = 0; ordinary = false; executing = false; beforeProbe = null;
  }

  async function interrupt(s, strategy = 'turn', over = {}, envelope = {}) {
    const target = await stopTarget(pool, s.sessionId, s.userId); const requestId = randomUUID();
    const payload = { ...snapshot(target), userId: s.userId, strategy, requestId, legacy: legacyTurnKey(target.turn), ...over };
    const key = interruptKey(payload);
    const id = await web.append(INTERRUPT, key, { type: 'Requested', payload }, {
      appId: s.appId, actor: `user:${s.userId}`, source: { kind: 'route', name: INTERRUPT_WORK }, requestKey: requestId, ...envelope,
    });
    return { id, key, payload };
  }
  const interruptState = async e => (await pool.query('SELECT state, data, deadline_at FROM wf_instances WHERE machine = $1 AND key = $2', [INTERRUPT, e.key])).rows[0];
  async function dispatched(s, turn = s.turn, by = null) {
    let id; process.env.PROCESS_ROLE = 'conductor';
    try {
      id = await require('../src/services/worker-interrupt').confirmDispatchedStop(pool, { sessionId: s.sessionId, ...turn, by });
    } finally { process.env.PROCESS_ROLE = 'web'; }
    if (id == null) return null;
    return (await pool.query('SELECT id, key, source, actor, payload FROM wf_events WHERE id = $1', [id])).rows[0];
  }
  async function tick(e, rt = conductor) {
    await asTransition(pool, 'UPDATE wf_instances SET deadline_at = NOW() WHERE machine = $1 AND key = $2 AND deadline_at IS NOT NULL', [INTERRUPT, e.key]);
    await rt.fireTimers(); await rt.drain();
  }

  await t.test('web only appends; the conductor kills the captured journal and confirms before clearing', async () => {
    reset(); const s = await session(); const e = await append(s);
    afterKill = async () => { assert.ok((await current(s)).stopRequestedAt, 'stop intent survives a conductor exit after the kill'); };
    assert.deepEqual(calls, []); assert.ok(await current(s));
    await conductor.drain(); assert.equal((await web.waitForEvent(e.id, 1000)).status, 'accepted');
    await settle(); assert.equal((await result(e)).ok, true);
    assert.deepEqual(calls, [['kill', s.sessionId, s.turn.journal, 'conductor']]);
    assert.equal(await current(s), null);
    const { rows } = await pool.query('SELECT content, metadata FROM chat_session_messages WHERE session_id = $1', [s.sessionId]);
    assert.equal(rows.length, 1); assert.match(rows[0].content, /Stopped by @stop_1 \(forced\)/);
    assert.equal(rows[0].metadata.workerStopRequest, e.payload.requestId);
    assert.deepEqual(announcements.map(a => a.event), ['status', 'stopped', 'done']);
    assert.ok(announcements.every(a => a.type === 'session_event' && a.sessionId === s.sessionId));
  });
  await t.test('unconfirmed kill uses identity-fenced removal, preserves the volume and confirms before release', async () => {
    reset(); kill = new Error('exec unavailable'); const s = await session(); const e = await append(s);
    await conductor.drain(); await settle(); assert.equal((await result(e)).ok, true);
    assert.deepEqual(calls.map(c => c[0]), ['kill', 'identity', 'rescue', 'delete']);
    assert.equal(await current(s), null);
  });
  await t.test('failed removal/rescue does not clear the turn or discard its worker row', async () => {
    reset(); kill = new Error('exec unavailable'); rescueError = Object.assign(new Error('push paused'), { permanent: true });
    const s = await session(); await pool.query(`UPDATE session_workers SET unpushed_sha = $2, unpushed_branch_name = 'b' WHERE session_id = $1`, [s.sessionId, 'a'.repeat(40)]);
    const e = await append(s); await conductor.drain(); await settle();
    assert.equal((await result(e)).code, 'stop_unconfirmed'); assert.ok(await current(s));
    assert.equal(calls.some(c => c[0] === 'delete'), false); assert.equal(announcements.length, 0);
    assert.equal((await pool.query('SELECT unpushed_sha FROM session_workers WHERE session_id = $1', [s.sessionId])).rows[0].unpushed_sha, 'a'.repeat(40));
  });
  await t.test('an unconfirmed runtime removal retains ownership until its resources are confirmed gone', async () => {
    reset(); kill = new Error('kill failed'); removalError = new Error('worker_removal_pending');
    const s = await session(); const e = await append(s); await conductor.drain(); await settle();
    assert.equal((await result(e)).code, 'stop_unconfirmed'); assert.ok(await current(s));
    assert.equal((await pool.query('SELECT 1 FROM session_workers WHERE session_id = $1', [s.sessionId])).rowCount, 1);
    assert.deepEqual(announcements, []);
  });
  await t.test('a replacement job, lost claim or lost session lock after the kill prevents settlement', async () => {
    for (const change of ['job', 'claim', 'lock']) {
      reset(); const s = await session(); const controller = new AbortController();
      const target = await stopTarget(pool, s.sessionId, s.userId);
      const input = { ...snapshot(target), requestId: randomUUID(), expiresAt: Date.now() + 30000 };
      afterKill = async () => {
        if (change === 'job') await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"replacement","journal":"/home/node/.claude/turn-replacement.log"}'::jsonb WHERE id = $1`, [s.sessionId]);
        if (change === 'claim') controller.abort();
        if (change === 'lock') {
          const { rowCount } = await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = current_database() AND application_name LIKE '%-locks'`);
          assert.ok(rowCount > 0, 'terminated the actual advisory-lock connection');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      };
      process.env.PROCESS_ROLE = 'conductor';
      try {
        const work = services[WORK].run({ input, signal: controller.signal, checkpoint: async () => {} });
        if (change === 'claim') await assert.rejects(work, /lost its claim/);
        else assert.equal((await work).ok, false);
      } finally { process.env.PROCESS_ROLE = 'web'; }
      assert.deepEqual(calls.map(c => c[0]), ['kill']); assert.ok(await current(s)); assert.deepEqual(announcements, []);
    }
  });
  await t.test('failed Codex ledger settlement retains the stopped record for recovery', async tt => {
    reset(); const s = await session();
    await pool.query(`UPDATE chat_sessions SET active_turn = active_turn || '{"backend":"codex_openrouter","turnUuid":"stopped-attempt"}'::jsonb WHERE id = $1`, [s.sessionId]);
    const agent = require('../src/services/agent-turn');
    tt.mock.method(agent, 'getCodexAttemptRecoveryState', async () => ({ status: 'running' }));
    tt.mock.method(agent, 'completeCodexAttempt', async () => { throw new Error('ledger unavailable'); });
    const e = await append(s); await conductor.drain(); await settle();
    assert.equal((await result(e)).retained, true); assert.ok(await current(s));
    assert.deepEqual(calls.map(c => c[0]), ['kill']);
  });
  await t.test('a newer job, context, owner or actor revocation after admission prevents every runtime operation', async () => {
    for (const change of ['turn', 'context', 'owner', 'erased']) {
      reset(); const s = await session(); const e = await append(s); await conductor.drain();
      if (change === 'turn') await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"new-job","journal":"/home/node/.claude/turn-new-job.log"}'::jsonb WHERE id = $1`, [s.sessionId]);
      if (change === 'context') await pool.query('UPDATE chat_sessions SET agent_config_version = agent_config_version + 1 WHERE id = $1', [s.sessionId]);
      if (change === 'owner') await pool.query('UPDATE chat_sessions SET user_id = NULL WHERE id = $1', [s.sessionId]);
      if (change === 'erased') await pool.query('UPDATE users SET anonymised_at = NOW() WHERE id = $1', [s.userId]);
      await settle(); assert.equal((await result(e)).ok, false, change); assert.deepEqual(calls, [], change);
    }
  });
  await t.test('scope/actor/source and captured-job mismatches are rejected at admission', async () => {
    for (const change of ['actor', 'source', 'scope', 'turn']) {
      reset(); const s = await session(); const e = await append(s, change === 'turn' ? { turnId: 'different-job' } : {},
        change === 'actor' ? { actor: 'user:99999' } : change === 'source' ? { source: { kind: 'system' } } : change === 'scope' ? { appId: s.appId + 1 } : {});
      await conductor.drain(); assert.equal((await web.waitForEvent(e.id, 1000)).status, 'rejected', change);
      assert.deepEqual(calls, []);
    }
  });
  await t.test('only a current full admin may stop another owner, including after admission', async () => {
    reset(); const s = await session();
    const { rows: [u] } = await pool.query(`INSERT INTO users (username, password, is_admin, admin_readonly) VALUES ('stop_admin', 'x', TRUE, TRUE) RETURNING id`);
    s.userId = u.id;
    assert.equal(await stopTarget(pool, s.sessionId, u.id), null);
    await pool.query('UPDATE users SET admin_readonly = FALSE WHERE id = $1', [u.id]);
    const e = await append(s); await conductor.drain();
    await pool.query('UPDATE users SET admin_readonly = TRUE WHERE id = $1', [u.id]);
    await settle(); assert.equal((await result(e)).ok, false); assert.deepEqual(calls, []);
    await pool.query('UPDATE users SET admin_readonly = FALSE WHERE id = $1', [u.id]);
    const permitted = await append(s); await conductor.drain(); await settle(); assert.equal((await result(permitted)).ok, true);
  });
  await t.test('a job ending while queued needs no runtime work; a used orphan and an identity change before deletion are spared', async () => {
    reset(); const ended = await session(); const e = await append(ended); await conductor.drain();
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [ended.sessionId]);
    await settle(); assert.equal((await result(e)).ok, true); assert.deepEqual(calls, []);
    const orphan = await session({ active: false }); const old = await append(orphan); await conductor.drain();
    await pool.query('UPDATE session_workers SET last_used_at = NOW() WHERE session_id = $1', [orphan.sessionId]);
    await settle(); assert.equal((await result(old)).ok, false); assert.deepEqual(calls, []);
    reset(); kill = new Error('exec unavailable'); const raced = await session(); const r = await append(raced); await conductor.drain();
    beforeDelete = id => pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"later-job"}'::jsonb WHERE id = $1`, [id]);
    await settle(); assert.equal((await result(r)).code, 'turn_changed'); assert.equal(calls.some(c => c[0] === 'delete'), false);
  });
  await t.test('an unchanged executing record whose journal is missing is ended by fenced removal', async () => {
    reset(); kill = 'not_current'; const s = await session(); const e = await append(s); await conductor.drain(); await settle();
    assert.equal((await result(e)).ok, true);
    assert.deepEqual(calls.map(c => c[0]), ['kill', 'identity', 'rescue', 'delete']); assert.equal(await current(s), null);
  });
  await t.test('the last recovery ask ends an unchanged executing record without its journal', async tt => {
    reset(); kill = 'not_current'; const s = await session();
    const recovery = require('../src/services/turn-recovery');
    tt.mock.method(recovery, 'recoverOwnedTurn', async () => {});
    const ctx = { workId: randomUUID(), resumeFrom: null, signal: new AbortController().signal,
      checkpoint: async () => {}, input: { kind: 'recover', sessionId: s.sessionId, identity: s.turn.turnId, last: true } };
    process.env.PROCESS_ROLE = 'conductor';
    try {
      assert.deepEqual(await require('../src/services/turns').run(ctx, { config: {}, pool }), { ended: 'ended' });
    } finally { process.env.PROCESS_ROLE = 'web'; }
    assert.equal(await current(s), null);
    assert.deepEqual(calls.map(c => c[0]), ['kill', 'identity', 'rescue', 'delete']);
  });
  await t.test('removal uses only the remaining request time, and rescue cannot start a late delete', async tt => {
    const base = Date.now(); let now = base;
    tt.mock.method(Date, 'now', () => now);
    for (const expiry of [null, 'request', 'removal']) {
      const expired = expiry !== null;
      reset(); now = base; kill = 'not_current'; const s = await session();
      const target = await stopTarget(pool, s.sessionId, s.userId);
      const input = { ...snapshot(target), requestId: randomUUID(), expiresAt: base + (expiry === 'removal' ? 30000 : 3000) };
      afterKill = async () => { now += 1000; };
      afterRescue = async () => { if (expired) now = expiry === 'removal' ? base + 21000 : input.expiresAt; };
      process.env.PROCESS_ROLE = 'conductor';
      try {
        const out = await services[WORK].run({ input, signal: new AbortController().signal, checkpoint: async () => {} });
        assert.equal(out.ok, !expired);
      } finally { process.env.PROCESS_ROLE = 'web'; }
      assert.deepEqual(killTimeouts, [expiry === 'removal' ? 5000 : 3000], 'the kill also uses the remaining runtime budget');
      assert.deepEqual(removalWaits, [expiry === 'removal' ? 20000 : 2000], 'time already spent in the handler is not added to the removal wait');
      assert.equal(calls.some(c => c[0] === 'delete'), !expired);
      assert.equal((await current(s)) == null, !expired);
      if (expired) assert.deepEqual(announcements, []);
    }
  });
  await t.test('expiry while recording stop intent prevents a late runtime kill', async tt => {
    reset(); const s = await session(); const target = await stopTarget(pool, s.sessionId, s.userId);
    let now = Date.now();
    const input = { ...snapshot(target), requestId: randomUUID(), expiresAt: now + 1000 };
    tt.mock.method(Date, 'now', () => now);
    const lifecycle = require('../src/services/turn-lifecycle');
    const mark = lifecycle.markStopRequested;
    tt.mock.method(lifecycle, 'markStopRequested', async (...args) => {
      const out = await mark(...args); now = input.expiresAt; return out;
    });
    process.env.PROCESS_ROLE = 'conductor';
    try {
      assert.equal((await services[WORK].run({ input, signal: new AbortController().signal, checkpoint: async () => {} })).code, 'stop_unconfirmed');
    } finally { process.env.PROCESS_ROLE = 'web'; }
    assert.deepEqual(calls, []); assert.ok(await current(s));
  });
  await t.test('web role, expired requests and a lost work claim refuse before worker I/O', async () => {
    reset(); const s = await session(); const target = await stopTarget(pool, s.sessionId, s.userId);
    const input = { ...snapshot(target), requestId: randomUUID(), expiresAt: Date.now() - 1 };
    const ctx = { input, signal: new AbortController().signal, checkpoint: async () => {} };
    await assert.rejects(services[WORK].run(ctx), /requires? a workflow process/);
    process.env.PROCESS_ROLE = 'conductor';
    try {
      assert.equal((await services[WORK].run(ctx)).code, 'stop_unconfirmed');
      const lost = await services[WORK].run({ ...ctx, input: { ...input, expiresAt: Date.now() + 1000 }, checkpoint: async () => { throw new Error('claim lost'); } });
      assert.equal(lost.ok, false); assert.deepEqual(calls, []);
    } finally { process.env.PROCESS_ROLE = 'web'; }
  });
  await t.test('a job changing while the route unwinds its handle cannot retarget the queued stop', async () => {
    for (const active of [true, false]) {
      reset(); const s = await session({ active });
      const expectedJob = { active, turnId: s.turn?.turnId || null, journal: s.turn?.journal || null };
      await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"new-job"}'::jsonb WHERE id = $1`, [s.sessionId]);
      const noAppend = { appendAndWait: () => { throw new Error('a stale route must not append'); } };
      await assert.rejects(requestWorkerStop(noAppend, pool, { sessionId: s.sessionId, userId: s.userId, expectedJob }), err => err.httpStatus === 409);
      assert.deepEqual(calls, []);
    }
  });
  await t.test('a captured job ending before preflight succeeds without queueing or worker I/O', async () => {
    reset(); const s = await session();
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [s.sessionId]);
    const noAppend = { appendAndWait: () => { throw new Error('an ended job needs no command'); } };
    const expectedJob = { active: true, turnId: s.turn.turnId, journal: s.turn.journal };
    for (const expected of [{ expectedTurnId: s.turn.turnId }, { expectedJob }, { expectedJob, expectedTurnId: s.turn.turnId }]) {
      assert.deepEqual(await requestWorkerStop(noAppend, pool, { sessionId: s.sessionId, userId: s.userId, ...expected }), { ok: true, stopped: true });
    }
    assert.deepEqual(calls, []);
    await pool.query('UPDATE users SET anonymised_at = NOW() WHERE id = $1', [s.userId]);
    await assert.rejects(requestWorkerStop(noAppend, pool, { ...request(s), expectedJob }), err => err.httpStatus === 404);
  });
  await t.test('the web leaves time after the runtime deadline for the conductor result to settle', async () => {
    reset(); const s = await session(); let timeout;
    const done = { appendAndWait: async () => ({ status: 'accepted' }),
      waitFor: async (_machine, _key, _predicate, waitMs) => { timeout = waitMs; return { data: { result: { ok: true, stopped: true } } }; } };
    assert.equal((await requestWorkerStop(done, pool, request(s))).ok, true);
    assert.equal(timeout, WAIT_MS + 5000); assert.deepEqual(calls, []);
  });
  await t.test('request refusal never falls back locally, and a raced accepted admission uses its settled outcome', async () => {
    reset(); const s = await session();
    const unavailable = { appendAndWait: async () => ({ status: 'pending', eventId: 1 }), refuseIfPending: async () => ({ status: 'rejected', reason: 'stop_unavailable' }) };
    await assert.rejects(requestWorkerStop(unavailable, pool, request(s), 0), err => err.httpStatus === 503);
    assert.deepEqual(calls, []);
    const racing = { ...web, appendAndWait: async (...args) => {
      const id = await web.append(...args); await conductor.drain(); await settle(); return { status: 'pending', eventId: id };
    } };
    const out = await requestWorkerStop(racing, pool, request(s), 1000); assert.equal(out.ok, true);
  });
  await t.test('a separate conductor confirms the web request, with no runtime I/O in the web process', async () => {
    reset();
    await pool.query('CREATE TABLE wf_test_stop_effects (pid integer, session_id integer, journal text)');
    const child = fork(require.resolve('./fixtures/worker-command-conductor'), [], {
      env: { PATH: process.env.PATH, TZ: 'UTC', PROCESS_ROLE: 'conductor', WORKER_COMMAND_TEST: JSON.stringify({ kind: 'stop', databaseUrl: String(url) }) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const exited = once(child, 'exit'); let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    try {
      const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`conductor exited: ${stderr}`); })]);
      assert.deepEqual(message, { ready: true });
      const s = await session();
      const out = await requestWorkerStop(web, pool, request(s), 5000);
      assert.equal(out.ok, true); assert.deepEqual(calls, []); assert.equal(await current(s), null);
      assert.deepEqual((await pool.query('SELECT pid, session_id, journal FROM wf_test_stop_effects')).rows,
        [{ pid: child.pid, session_id: s.sessionId, journal: s.turn.journal }]);
    } finally {
      if (child.exitCode === null) child.send('stop');
      const [code] = await exited; assert.equal(code, 0, stderr);
    }
  });
  await t.test('ordinary Stop persists one confirmation run across duplicate clicks and conductor restart', async () => {
    reset(); ordinary = true; const s = await session(); const e = await interrupt(s);
    assert.deepEqual(calls, []); await conductor.drain(); await settle();
    assert.deepEqual(calls.map(c => c[0]), ['signal']);
    assert.ok((await current(s)).stopRequestedAt, 'the conductor records stop intent even without the HTTP producer');
    const waiting = await interruptState(e); assert.equal(waiting.state, 'waiting'); assert.ok(waiting.deadline_at);
    const duplicate = await interrupt(s); assert.equal(duplicate.key, e.key);
    await conductor.drain(); await settle(); assert.equal(calls.length, 1, 'no second signal loop');
    const fresh = createRuntime({ pool, machines: [workerInterrupt()], services, slots: 1 });
    try {
      await tick(e, fresh); await settle(fresh);
      assert.equal((await interruptState(e)).data.result.confirmed, true);
      assert.deepEqual(calls.map(c => c[0]), ['signal', 'probe']); assert.ok(await current(s), 'only the turn owner releases its record');
      await interrupt(s); await fresh.drain(); await settle(fresh);
      assert.equal(calls.filter(c => c[0] === 'signal').length, 2, 'a completed confirmation may be requested again');
      await tick(e, fresh); await settle(fresh);
    } finally { await fresh.stop(); }
  });
  await t.test('ordinary confirmation retains the three-signal limit and retries an unknown probe', async () => {
    for (const busy of [true, null]) {
      reset(); ordinary = true; executing = busy; const s = await session(); const e = await interrupt(s);
      await conductor.drain(); await settle();
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await tick(e); await settle(); if (attempt < 3) await settle();
      }
      const state = await interruptState(e); assert.equal(state.state, 'done');
      assert.equal(state.data.attempts, 3); assert.equal(state.data.result.reason, 'giveup');
      assert.equal(calls.filter(c => c[0] === 'signal').length, 3); assert.equal(calls.filter(c => c[0] === 'probe').length, 3);
      assert.ok(await current(s)); assert.equal(calls.some(c => ['delete', 'runtime'].includes(c[0])), false);
    }
  });
  await t.test('repeat requestWorkerInterrupt calls acknowledge the same pending confirmation', async () => {
    reset(); ordinary = true; const s = await session();
    const accepting = { ...web, appendAndWait: async (...args) => {
      const id = await web.append(...args); await conductor.drain(); return web.waitForEvent(id, 1000);
    } };
    const p = { ...request(s), strategy: 'turn' };
    await requestWorkerInterrupt(accepting, pool, p);
    await requestWorkerInterrupt(accepting, pool, p);
    await settle();
    await requestWorkerInterrupt(accepting, pool, p);
    assert.deepEqual(calls.map(c => c[0]), ['signal']);
    const raced = { appendAndWait: async () => ({ status: 'pending', eventId: 1 }),
      refuseIfPending: async () => ({ status: 'rejected', reason: 'already_stopping', eventId: 1 }) };
    await requestWorkerInterrupt(raced, pool, p);
    const target = await stopTarget(pool, s.sessionId, s.userId);
    const e = { key: interruptKey({ ...snapshot(target), strategy: 'turn' }) };
    await tick(e); await settle();
    assert.equal((await interruptState(e)).data.result.confirmed, true);
  });
  await t.test('a dispatcher queues bounded confirmation for its own late-starting record only', async () => {
    reset(); ordinary = true; executing = true; const s = await session({ active: false });
    await requestWorkerInterrupt({ ...web, appendAndWait: async (...args) => {
      const id = await web.append(...args); await conductor.drain(); return web.waitForEvent(id, 1000);
    } }, pool, { ...request(s), strategy: 'turn' });
    await settle(); assert.deepEqual(calls, []);
    const turn = { turnId: randomUUID(), journal: '/home/node/.claude/turn-late.log', phase: 'executing' };
    await pool.query('UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1', [s.sessionId, JSON.stringify(turn)]);
    const e = await dispatched(s, turn, 'root');
    assert.deepEqual(e.source, { kind: 'system', name: DISPATCH });
    assert.equal(e.actor, null); assert.equal(e.payload.userId, null); assert.equal(e.payload.by, 'root');
    const target = await stopTarget(pool, s.sessionId, s.userId);
    assert.notEqual(e.key, interruptKey({ ...snapshot(target), strategy: 'turn' }), 'system confirmation is independent of owner clicks');
    await conductor.drain(); await settle();
    assert.equal((await current(s)).stopRequestedBy, 'root', 'an admin Stop is not attributed to the session owner');
    for (let n = 0; n < 3; n += 1) { await tick(e); await settle(); await settle(); }
    assert.equal((await interruptState(e)).data.result.reason, 'giveup');
    assert.equal(calls.filter(c => c[0] === 'signal').length, 3);
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"newer","journal":"/home/node/.claude/turn-newer.log"}'::jsonb WHERE id = $1`, [s.sessionId]);
    await assert.rejects(dispatched(s, turn), err => err.code === 'turn_changed');
    assert.equal(calls.filter(c => c[0] === 'signal').length, 3);
  });
  await t.test('system backstops still signal and confirm for anonymised owners, with real or absent attribution', async () => {
    for (const by of ['root', null]) {
      reset(); ordinary = true; const s = await session();
      await pool.query('UPDATE users SET anonymised_at = NOW() WHERE id = $1', [s.ownerId]);
      await assert.rejects(requestWorkerInterrupt(web, pool, { ...request(s), strategy: 'turn' }), err => err.code === 'not_authorized');
      const e = await dispatched(s, s.turn, by); await conductor.drain();
      assert.equal((await web.waitForEvent(e.id, 1000)).status, 'accepted');
      await settle(); assert.equal((await current(s)).stopRequestedBy, by);
      const fresh = createRuntime({ pool, machines: [workerInterrupt()], services, slots: 1 });
      try {
        await tick(e, fresh); await settle(fresh);
        assert.equal((await interruptState(e)).data.result.confirmed, true);
        assert.equal((await current(s)).stopRequestedBy, by, 'attribution survives a conductor restart');
        assert.deepEqual(calls.map(c => c[0]), ['signal', 'probe']);
      } finally { await fresh.stop(); }
    }
  });
  await t.test('system admission requires its dedicated source, null actor and exact active journalled job', async () => {
    reset(); ordinary = true;
    const source = { kind: 'system', name: DISPATCH };
    for (const invalid of [
      { envelope: { source: { kind: 'route', name: INTERRUPT_WORK }, actor: 'user:null' } },
      { envelope: { actor: 'user:1' } },
      { over: { userId: 1 } },
      { envelope: { source: { kind: 'system', name: 'another-producer' } } },
      { over: { active: false, turnId: null, journal: null } },
      { over: { turnId: null } }, { over: { journal: null } },
    ]) {
      const s = await session(); const e = await interrupt(s, 'turn', { userId: null, ...invalid.over },
        { source, actor: null, ...invalid.envelope });
      await conductor.drain(); const out = await web.waitForEvent(e.id, 1000);
      assert.equal(out.status, 'rejected'); assert.equal(out.reason, 'not_a_producer');
    }
    for (const ended of [false, true]) {
      const s = await session(); const e = await dispatched(s);
      await pool.query('UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1', [s.sessionId,
        ended ? null : JSON.stringify({ ...s.turn, turnId: 'replacement' })]);
      await conductor.drain(); const out = await web.waitForEvent(e.id, 1000);
      assert.equal(out.status, 'rejected'); assert.equal(out.reason, 'turn_changed');
    }
    assert.deepEqual(calls, []);
  });
  await t.test('human stop attribution comes from the authenticated actor, ignoring a payload name', async () => {
    reset(); ordinary = true; const s = await session();
    const e = await interrupt(s, 'turn', { by: 'somebody_else' });
    await conductor.drain(); await settle();
    const { rows: [owner] } = await pool.query('SELECT username FROM users WHERE id = $1', [s.ownerId]);
    assert.equal((await current(s)).stopRequestedBy, owner.username);
    await tick(e); await settle();
  });
  await t.test('an owner Stop is independent of a queued admin Stop whose authority was revoked', async () => {
    reset(); ordinary = true; const s = await session();
    const { rows: [adminUser] } = await pool.query(`INSERT INTO users (username, password, is_admin) VALUES ('interrupt_admin', 'x', TRUE) RETURNING id`);
    const adminStop = await interrupt({ ...s, userId: adminUser.id }); const ownerStop = await interrupt(s);
    assert.notEqual(adminStop.key, ownerStop.key, 'commands with different authority must not share pending work');
    await conductor.drain(); await pool.query('UPDATE users SET is_admin = FALSE WHERE id = $1', [adminUser.id]);
    await settle();
    assert.equal((await interruptState(adminStop)).data.result.confirmed, false);
    assert.equal((await interruptState(ownerStop)).state, 'waiting');
    await tick(ownerStop); await settle();
    assert.equal((await interruptState(ownerStop)).data.result.confirmed, true);
    assert.deepEqual(calls.map(c => c[0]), ['signal', 'probe']);
  });
  await t.test('every later confirmation step rechecks job, configuration, owner and current actor authority', async () => {
    for (const change of ['job', 'context', 'owner', 'actor']) {
      reset(); ordinary = true; const s = await session(); const e = await interrupt(s); await conductor.drain(); await settle();
      if (change === 'job') await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"new-job","journal":"/home/node/.claude/turn-new-job.log"}'::jsonb WHERE id = $1`, [s.sessionId]);
      if (change === 'context') await pool.query('UPDATE chat_sessions SET agent_config_version = agent_config_version + 1 WHERE id = $1', [s.sessionId]);
      if (change === 'owner') await pool.query('UPDATE chat_sessions SET user_id = NULL WHERE id = $1', [s.sessionId]);
      if (change === 'actor') await pool.query('UPDATE users SET anonymised_at = NOW() WHERE id = $1', [s.userId]);
      await tick(e); await settle();
      assert.equal((await interruptState(e)).data.result.confirmed, false); assert.deepEqual(calls.map(c => c[0]), ['signal'], change);
    }
  });
  await t.test('a finished job or an expired queued request needs no runtime work', async () => {
    for (const expired of [false, true]) {
      reset(); ordinary = true; const s = await session(); const e = await interrupt(s); await conductor.drain();
      if (expired) {
        await asTransition(pool, `UPDATE wf_work SET input = jsonb_set(input, '{target,expiresAt}', '0'::jsonb) WHERE machine = $1 AND key = $2`, [INTERRUPT, e.key]);
      } else await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [s.sessionId]);
      await settle(); assert.equal((await interruptState(e)).state, 'done'); assert.deepEqual(calls, []);
      assert.equal((await interruptState(e)).data.result.confirmed, !expired);
    }
  });
  await t.test('journal-less legacy records retain their supported signal and probe path', async () => {
    reset(); ordinary = true; const legacy = await session();
    await pool.query(`UPDATE chat_sessions SET active_turn = active_turn - 'journal' WHERE id = $1`, [legacy.sessionId]);
    const l = await interrupt(legacy); await conductor.drain(); await settle(); await tick(l); await settle();
    assert.deepEqual(calls.map(c => c[0]), ['legacy-signal', 'probe']);

  });
  await t.test('identity-less legacy records are signalled and fenced by their stored contents', async () => {
    for (const replaced of [false, true]) {
      reset(); ordinary = true; const s = await session();
      await pool.query(`UPDATE chat_sessions SET active_turn = active_turn - 'journal' - 'turnId' WHERE id = $1`, [s.sessionId]);
      const e = await interrupt(s); await conductor.drain();
      if (replaced) await pool.query(`UPDATE chat_sessions SET active_turn = active_turn || '{"startedAt":"replacement"}'::jsonb WHERE id = $1`, [s.sessionId]);
      await settle();
      if (replaced) {
        assert.deepEqual(calls, []); assert.equal((await interruptState(e)).data.result.reason, 'turn_changed');
      } else {
        assert.ok((await current(s)).stopRequestedAt);
        await tick(e); await settle(); assert.deepEqual(calls.map(c => c[0]), ['legacy-signal', 'probe']);
      }
    }
  });
  await t.test('admission refuses changed targets; a web process cannot run interruption work', async () => {
    reset(); ordinary = true;
    for (const change of ['actor', 'source', 'scope', 'snapshot']) {
      const s = await session(); const e = await interrupt(s, 'turn', change === 'snapshot' ? { turnId: 'other-job' } : {},
        change === 'actor' ? { actor: 'user:99999' } : change === 'source' ? { source: { kind: 'system' } } : change === 'scope' ? { appId: s.appId + 1 } : {});
      await conductor.drain(); const out = await web.waitForEvent(e.id, 1000);
      assert.equal(out.status, 'rejected', change);
      if (change === 'actor' || change === 'source') assert.equal(out.reason, 'not_a_producer');
    }
    assert.deepEqual(calls, []);
    await assert.rejects(services[INTERRUPT_WORK].run({ input: {}, checkpoint: () => { throw new Error('web checkpoint'); } }), /requires a workflow process/);

  });
  await t.test('ordinary admission is asynchronous and unavailable admission never falls back to local runtime access', async () => {
    reset(); ordinary = true; const s = await session();
    const unavailable = { appendAndWait: async () => ({ status: 'pending', eventId: 1 }), refuseIfPending: async () => ({ status: 'rejected' }) };
    await assert.rejects(requestWorkerInterrupt(unavailable, pool, { ...request(s), strategy: 'turn' }), err => err.httpStatus === 503);
    assert.deepEqual(calls, []);
    const accepting = { ...web, appendAndWait: async (...args) => {
      const id = await web.append(...args); await conductor.drain(); return web.waitForEvent(id, 1000);
    }, waitFor: () => { throw new Error('ordinary Stop must not await confirmation'); } };
    await requestWorkerInterrupt(accepting, pool, { ...request(s), strategy: 'turn' }); assert.deepEqual(calls, []);
    await settle();
    const target = await stopTarget(pool, s.sessionId, s.userId);
    await tick({ key: interruptKey({ ...snapshot(target), strategy: 'turn' }) }); await settle();
  });

  await t.test('a separate conductor signals and confirms an ordinary Stop; the web does no runtime I/O', async () => {
    reset(); ordinary = true; const s = await session();
    await pool.query('CREATE TABLE wf_test_interrupt_effects (pid integer, session_id integer, action text)');
    const child = fork(require.resolve('./fixtures/worker-command-conductor'), [], {
      env: { PATH: process.env.PATH, TZ: 'UTC', PROCESS_ROLE: 'conductor', WORKER_COMMAND_TEST: JSON.stringify({ kind: 'interrupt', databaseUrl: String(url), sessionId: s.sessionId }) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    try {
      const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`conductor exited: ${stderr}`); })]);
      assert.deepEqual(message, { ready: true });
      const target = await stopTarget(pool, s.sessionId, s.userId);
      const key = interruptKey({ ...snapshot(target), strategy: 'turn' });
      await requestWorkerInterrupt(web, pool, { ...request(s), strategy: 'turn' });
      const done = await web.waitFor(INTERRUPT, key, i => i.state === 'done', 7000);
      assert.equal(done?.data.result.confirmed, true); assert.deepEqual(calls, []); assert.ok(await current(s));
      assert.deepEqual((await pool.query('SELECT pid, session_id, action FROM wf_test_interrupt_effects ORDER BY action DESC')).rows,
        [{ pid: child.pid, session_id: s.sessionId, action: 'signal' }, { pid: child.pid, session_id: s.sessionId, action: 'probe' }]);
    } finally {
      if (child.exitCode === null) child.send('stop'); const [code] = await exited; assert.equal(code, 0, stderr);
    }
  });

});
