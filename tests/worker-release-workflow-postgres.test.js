'use strict';

// Real schema, reset transaction, kernel and release handler. Only worker
// I/O is faked; web requests must leave all of it to the conductor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const express = require('express');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { workerRelease, MACHINE, WORK, releaseKey } = require('../src/workflow/worker-release/machine.ts');
const { workerReleaseServices } = require('../src/workflow/worker-release/services.ts');

test('requested worker releases are conductor work', { timeout: 60000 }, async t => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (e) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw e;
    t.skip('PostgreSQL unavailable; TEST_DATABASE_URL requires this check'); return;
  }
  const name = `worker_release_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(admin.options.connectionString); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  t.mock.method(require('../src/db/pool'), 'getPool', () => pool);
  const worker = require('../src/services/worker');
  const { switchSessionAgent } = require('../src/routes/sessions');
  const { appendWorkerRelease } = require('../src/workflow/platform.ts');
  const removals = []; const effects = []; let beforeProceed = null;
  t.mock.method(worker, 'evictWorker', () => { throw new Error('direct eviction must not run'); });
  t.mock.method(worker, 'destroyWorker', () => { throw new Error('direct destruction must not run'); });
  t.mock.method(worker, 'isInFlight', () => false);
  t.mock.method(worker, 'rescueUnpushedCommit', async id => { effects.push(['rescue', id]); return { attempted: false }; });
  t.mock.method(worker, 'removeWorker', async (id, options) => {
    assert.equal(process.env.PROCESS_ROLE, 'conductor');
    if (beforeProceed) await beforeProceed(id);
    if (!(await options.proceed())) return { skipped: true };
    await options.renew(); effects.push(['remove', id]); removals.push(id); return { removed: true };
  });
  const role = process.env.PROCESS_ROLE; process.env.PROCESS_ROLE = 'web';
  const machine = workerRelease();
  const services = workerReleaseServices({ pool });
  const web = createRuntime({ pool, machines: [machine], services, slots: 0 });
  const conductor = createRuntime({ pool, machines: [machine], services, slots: 1 });
  t.after(async () => {
    await web.stop(); await conductor.stop(); await pool.end();
    await admin.query(`DROP DATABASE ${name}`); await admin.end();
    if (role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = role;
  });
  let seq = 0;
  async function session(status = 'active', turnId = null) {
    const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [`release_${++seq}`]);
    const { rows: [a] } = await pool.query(`INSERT INTO apps (name, slug, created_by, status) VALUES ($1, $1, $2, 'running') RETURNING id`, [`release-${seq}`, u.id]);
    const { rows: [s] } = await pool.query(`INSERT INTO chat_sessions
      (app_id, user_id, status, agent_config_version, agent_context_reset_at, active_turn)
      VALUES ($1, $2, $3, 2, NOW() - interval '1 minute', $4::jsonb) RETURNING id`,
      [a.id, u.id, status, turnId ? JSON.stringify({ turnId }) : null]);
    await pool.query(`INSERT INTO session_workers (session_id, last_used_at) VALUES ($1, NOW() - interval '10 minutes')`, [s.id]);
    return { sessionId: s.id, appId: a.id, userId: u.id, configVersion: 2, turnId };
  }
  const row = async s => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.sessionId])).rows[0];
  const outcome = id => web.waitForEvent(id, 1000);
  const queue = (s, reason = 'agent-reset') => appendWorkerRelease(pool, { ...s, reason });
  async function settle() {
    process.env.PROCESS_ROLE = 'conductor';
    try { await conductor.runServices(); await conductor.drain(); } finally { process.env.PROCESS_ROLE = 'web'; }
  }

  await t.test('reset and its release intent commit together, and only the conductor removes the worker', async () => {
    const s = await session(); const before = removals.length;
    const reset = await switchSessionAgent(pool, { sessionId: s.sessionId, userId: s.userId,
      pref: { backend: 'claude_code', provider: 'anthropic', model: null, reasoningEffort: null } });
    assert.equal(reset.ok, true); assert.equal((await row(s)).agent_config_version, 3);
    const { rows: [event] } = await pool.query('SELECT id, key, payload, source, actor FROM wf_events WHERE machine = $1 AND app_id = $2', [MACHINE, s.appId]);
    assert.equal(event.payload.configVersion, 3); assert.equal(event.actor, `user:${s.userId}`);
    assert.deepEqual(event.source, { kind: 'route', name: WORK });
    assert.equal(removals.length, before);
    await conductor.drain(); assert.equal((await outcome(Number(event.id))).status, 'accepted');
    await settle(); assert.deepEqual(removals.slice(before), [s.sessionId]);
    const { rows: [item] } = await pool.query('SELECT input FROM wf_work WHERE machine = $1 AND key = $2', [MACHINE, event.key]);
    assert.deepEqual(Object.keys(item.input).sort(), ['appId', 'configVersion', 'reason', 'requestedAt', 'sessionId', 'turnId', 'userId']);
  });
  await t.test('a failure appending the intent rolls back the reset and transcript', async () => {
    const s = await session();
    const failing = { connect: async () => {
      const client = await pool.connect();
      return { release: () => client.release(), query: (sql, params) => {
        if (String(sql).includes('INSERT INTO wf_events')) throw new Error('synthetic append failure');
        return client.query(sql, params);
      } };
    } };
    await assert.rejects(switchSessionAgent(failing, { sessionId: s.sessionId, userId: s.userId,
      pref: { backend: 'claude_code', provider: 'anthropic', model: null, reasoningEffort: null } }), /synthetic append failure/);
    assert.equal((await row(s)).agent_config_version, 2);
    assert.equal((await pool.query('SELECT 1 FROM chat_session_messages WHERE session_id = $1', [s.sessionId])).rowCount, 0);
  });
  await t.test('an older conductor leaves the intent pending until a build that knows the machine runs', async () => {
    const s = await session(); const id = await queue(s);
    const { workerPush } = require('../src/workflow/worker-push/machine.ts');
    const old = createRuntime({ pool, machines: [workerPush()], slots: 1 });
    try {
      assert.equal(await old.drain(), 0);
      assert.equal((await web.waitForEvent(id, 0)).status, 'pending');
    } finally { await old.stop(); }
    await conductor.drain(); await settle(); assert.equal(removals.at(-1), s.sessionId);
  });
  await t.test('scope, producer, owner, erased account and configuration mismatches never queue removal', async () => {
    const s = await session();
    for (const change of ['key', 'app', 'owner', 'source', 'actor', 'version', 'erased']) {
      const requestId = randomUUID();
      const payload = { ...s, reason: 'agent-reset', requestId };
      if (change === 'owner') payload.userId++;
      if (change === 'version') payload.configVersion++;
      if (change === 'erased') await pool.query('UPDATE users SET anonymised_at = NOW() WHERE id = $1', [s.userId]);
      const id = await web.append(MACHINE, releaseKey(change === 'key' ? s.sessionId + 1 : s.sessionId, requestId),
        { type: 'Requested', payload }, { requestKey: requestId, appId: change === 'app' ? s.appId + 1 : s.appId,
          actor: change === 'actor' ? 'user:9999' : `user:${payload.userId}`, source: change === 'source' ? { kind: 'system' } : { kind: 'route', name: WORK } });
      await conductor.drain(); assert.equal((await outcome(id)).status, 'rejected', change);
    }
  });
  await t.test('a later context reset, worker use, turn or ownership change spares the worker', async () => {
    for (const change of ['version', 'used', 'turn', 'owner', 'erased']) {
      const s = await session(); const before = removals.length;
      await queue(s); await conductor.drain();
      if (change === 'version') await pool.query('UPDATE chat_sessions SET agent_config_version = 3 WHERE id = $1', [s.sessionId]);
      if (change === 'used') await pool.query('UPDATE session_workers SET last_used_at = NOW() WHERE session_id = $1', [s.sessionId]);
      if (change === 'turn') await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"new-turn"}'::jsonb WHERE id = $1`, [s.sessionId]);
      if (change === 'owner') await pool.query('UPDATE chat_sessions SET user_id = NULL WHERE id = $1', [s.sessionId]);
      if (change === 'erased') await pool.query('UPDATE users SET anonymised_at = NOW() WHERE id = $1', [s.userId]);
      await settle(); assert.equal(removals.length, before, change);
    }
  });
  await t.test('a change between reading the runtime identity and deletion also spares the worker', async () => {
    const s = await session(); const before = removals.length;
    beforeProceed = id => pool.query('UPDATE chat_sessions SET agent_config_version = 3 WHERE id = $1', [id]);
    try { await queue(s); await conductor.drain(); await settle(); } finally { beforeProceed = null; }
    assert.equal(removals.length, before);
  });
  await t.test('promoted Pause releases only its current worker and keeps the proposal up for voting', async () => {
    const s = await session('promoted', 'requested-turn');
    const start = effects.length;
    await queue(s, 'promoted-pause'); await conductor.drain(); await settle();
    assert.deepEqual(effects.slice(start), [['rescue', s.sessionId], ['remove', s.sessionId]], 'even captured running turns pass the rescue check before removal');
    assert.equal(removals.at(-1), s.sessionId); assert.equal((await row(s)).status, 'promoted');
    for (const change of ['status', 'turn', 'used']) {
      const next = await session('promoted'); const before = removals.length;
      await queue(next, 'promoted-pause'); await conductor.drain();
      if (change === 'status') await pool.query(`UPDATE chat_sessions SET status = 'active' WHERE id = $1`, [next.sessionId]);
      if (change === 'turn') await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"new-turn"}'::jsonb WHERE id = $1`, [next.sessionId]);
      if (change === 'used') await pool.query('UPDATE session_workers SET last_used_at = NOW() WHERE session_id = $1', [next.sessionId]);
      await settle(); assert.equal(removals.length, before, change);
    }
  });
  await t.test('promoted Pause still frees a captured turn that finishes before admission or execution', async () => {
    for (const stage of ['admission', 'execution']) {
      const s = await session('promoted', 'finishing-turn'); const before = removals.length;
      const id = await queue(s, 'promoted-pause');
      if (stage === 'execution') await conductor.drain();
      await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [s.sessionId]);
      await pool.query('UPDATE session_workers SET last_used_at = NOW() WHERE session_id = $1', [s.sessionId]);
      if (stage === 'admission') await conductor.drain();
      assert.equal((await outcome(id)).status, 'accepted', stage);
      await settle(); assert.deepEqual(removals.slice(before), [s.sessionId], stage);
      assert.equal((await row(s)).status, 'promoted');
    }
  });
  await t.test('promoted Pause refuses a different running turn before admission', async () => {
    const s = await session('promoted', 'captured-turn'); const before = removals.length;
    const id = await queue(s, 'promoted-pause');
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"later-turn"}'::jsonb WHERE id = $1`, [s.sessionId]);
    await conductor.drain(); assert.equal((await outcome(id)).status, 'rejected');
    await settle(); assert.equal(removals.length, before);
  });
  await t.test('the promoted Pause HTTP path only enqueues and leaves worker I/O to the conductor', async () => {
    const s = await session('promoted', 'pause-this-turn'); const before = removals.length;
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: s.userId, username: 'owner' }; next(); });
    app.use(require('../src/routes/sessions').sessionRoutes({}));
    const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${s.sessionId}/pause`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}',
      });
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, keptPromoted: true });
      assert.equal(removals.length, before); assert.equal((await row(s)).status, 'promoted');
      await conductor.drain(); await settle(); assert.equal(removals.at(-1), s.sessionId);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
  await t.test('release work accidentally invoked on a web process refuses before I/O', async () => {
    await assert.rejects(services[WORK].run({ input: {}, checkpoint: () => { throw new Error('web touched checkpoint'); } }), /requires a workflow process/);
  });
  await t.test('a separate conductor performs the release requested by the web process', async () => {
    await pool.query('CREATE TABLE wf_test_release_effects (pid integer, session_id integer)');
    const child = fork(require.resolve('./fixtures/worker-command-conductor'), [], {
      env: { PATH: process.env.PATH, TZ: 'UTC', PROCESS_ROLE: 'conductor', WORKER_COMMAND_TEST: JSON.stringify({ kind: 'release', databaseUrl: String(url) }) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const exited = once(child, 'exit'); let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    try {
      const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`conductor exited: ${stderr}`); })]);
      assert.deepEqual(message, { ready: true });
      const s = await session(); const before = removals.length;
      const id = await queue(s);
      assert.equal((await web.waitForEvent(id, 5000)).status, 'accepted');
      const { rows: [e] } = await pool.query('SELECT key FROM wf_events WHERE id = $1', [id]);
      const completed = await web.waitFor(MACHINE, e.key, i => i.state === 'done', 5000);
      assert.equal(completed.state, 'done'); assert.equal(removals.length, before, 'no parent-process worker I/O');
      assert.deepEqual((await pool.query('SELECT pid, session_id FROM wf_test_release_effects')).rows,
        [{ pid: child.pid, session_id: s.sessionId }]);
    } finally {
      if (child.exitCode === null) child.send('stop');
      const [code] = await exited; assert.equal(code, 0, stderr);
    }
  });
});
