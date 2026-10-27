'use strict';

// The real kernel and full schema, with only GitHub/worker I/O standing in.
// The HTTP/web side never performs that I/O, even when no conductor decides.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { workerPush, MACHINE, WORK, pushKey } = require('../src/workflow/worker-push/machine.ts');
const { workerPushServices } = require('../src/workflow/worker-push/services.ts');
const { requestWorkerPush } = require('../src/workflow/worker-push/request.ts');

test('conductor-owned worker pushes', { timeout: 60000 }, async t => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (e) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw e;
    t.skip('PostgreSQL unavailable; TEST_DATABASE_URL requires this regression'); return;
  }
  const dbName = `worker_push_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(admin.options.connectionString); url.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const worker = require('../src/services/worker');
  const github = require('../src/services/github');
  const role = process.env.PROCESS_ROLE;
  process.env.PROCESS_ROLE = 'conductor';
  t.after(() => { if (role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = role; });
  const pushes = []; const privacyCalls = [];
  let privacy = { ok: true, private: false }; let pushError = null;
  t.mock.method(github, 'checkRepoPublic', async (...args) => { privacyCalls.push(args); return privacy; });
  t.mock.method(worker, 'execPushFromWorker', async (...args) => {
    assert.equal(process.env.PROCESS_ROLE, 'conductor');
    pushes.push(args);
    if (pushError) throw pushError;
    return { sha: 'a'.repeat(40), stderr: '' };
  });
  const machine = workerPush();
  const services = workerPushServices({ pool });
  const make = slots => {
    const r = createRuntime({ pool, machines: [machine], services, slots, pollMs: 10 });
    runtimes.push(r); return r;
  };
  const web = make(0); const conductor = make(1);
  let seq = 0;
  async function session() {
    const n = ++seq;
    const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [`push_${n}`]);
    const { rows: [a] } = await pool.query(`INSERT INTO apps (name, slug, created_by, repo_url, status)
      VALUES ($1, $1, $2, 'https://github.com/Trusted-Owner/repo', 'running') RETURNING id`, [`push-app-${n}`, u.id]);
    const { rows: [s] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, branch_name, status)
      VALUES ($1, $2, $3, 'active') RETURNING id`, [a.id, u.id, `dev/test-${n}`]);
    return { sessionId: s.id, appId: a.id, userId: u.id, branchName: `dev/test-${n}` };
  }
  async function enqueue(s, o = {}) {
    const requestId = randomUUID(); const key = o.key || pushKey(s.sessionId, requestId);
    const event = await web.append(MACHINE, key, { type: 'Requested', payload: {
      sessionId: s.sessionId, branchName: s.branchName, requestId, ...o.payload,
    } }, { appId: s.appId, source: { kind: 'route', name: WORK }, requestKey: requestId, ...o.options });
    await conductor.drain();
    return { key, event, outcome: await web.waitForEvent(event, 1000) };
  }
  async function settle() { await conductor.runServices(); await conductor.drain(); }
  async function result(key) {
    return (await pool.query('SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, key])).rows[0];
  }
  async function until(check) {
    const deadline = Date.now() + 3000;
    while (!await check()) {
      if (Date.now() >= deadline) throw new Error('fixture did not reach its expected state');
      await new Promise(r => setTimeout(r, 10));
    }
  }
  await t.test('web append/wait does no Git or exec; a separate conductor settles and returns the original result', async () => {
    const s = await session(); const before = pushes.length;
    const request = requestWorkerPush(web, pool, s, 2000);
    await until(async () => (await pool.query('SELECT 1 FROM wf_events WHERE machine = $1 AND processed_at IS NULL', [MACHINE])).rowCount > 0);
    assert.equal(pushes.length, before);
    await conductor.drain();
    assert.equal(pushes.length, before, 'admission alone cannot push');
    assert.equal((await pool.query('SELECT data FROM wf_instances WHERE machine = $1', [MACHINE])).rows[0].data, null, 'target lives only in the work item');
    await settle();
    assert.deepEqual(await request, { sha: 'a'.repeat(40), branch: s.branchName, stderr: '' });
    assert.deepEqual(pushes.at(-1), [s.sessionId, s.branchName, { expectedRepoUrl: 'https://github.com/Trusted-Owner/repo', expectedAppId: s.appId }]);
    const { rows: [i] } = await pool.query('SELECT data FROM wf_instances WHERE machine = $1 ORDER BY updated_at DESC LIMIT 1', [MACHINE]);
    assert.deepEqual(i.data, { result: { ok: true, sha: 'a'.repeat(40) } }, 'terminal instance retains no repository address');
  });
  await t.test('admission rejects wrong session/app scope, wrong producers and malformed commands', async () => {
    const s = await session();
    for (const o of [
      { key: pushKey(s.sessionId + 1, randomUUID()) },
      { options: { appId: s.appId + 1 } },
      { options: { source: { kind: 'system' } } },
    ]) assert.equal((await enqueue(s, o)).outcome.status, 'rejected');
    for (const payload of [{ branchName: '--upload-pack=steal' }, { sessionId: -1 }]) {
      await assert.rejects(enqueue(s, { payload }), e => e.code === 'invalid_payload');
    }
    assert.equal((await pool.query('SELECT 1 FROM wf_work WHERE machine = $1 AND status = \'queued\'', [MACHINE])).rowCount, 0);
  });
  await t.test('closing, changing a branch or erasing an account before admission refuses the command', async () => {
    for (const change of ['closed', 'branch', 'erased']) {
      const s = await session();
      if (change === 'closed') await pool.query(`UPDATE chat_sessions SET status = 'closed' WHERE id = $1`, [s.sessionId]);
      if (change === 'branch') await pool.query(`UPDATE chat_sessions SET branch_name = 'dev/changed' WHERE id = $1`, [s.sessionId]);
      if (change === 'erased') await pool.query(`UPDATE users SET anonymised_at = now() WHERE id = $1`, [s.userId]);
      assert.equal((await enqueue(s)).outcome.status, 'rejected', change);
    }
  });
  await t.test('queued work rechecks every inactive status, branch, repo, account and disappearance before external I/O', async () => {
    for (const change of ['closed', 'archived', 'merged', 'failed', 'branch', 'repo', 'app', 'erased', 'missing']) {
      const s = await session(); const before = pushes.length; const reads = privacyCalls.length;
      const queued = await enqueue(s); assert.equal(queued.outcome.status, 'accepted');
      if (['closed', 'archived', 'merged', 'failed'].includes(change)) await pool.query('UPDATE chat_sessions SET status = $2 WHERE id = $1', [s.sessionId, change]);
      if (change === 'branch') await pool.query(`UPDATE chat_sessions SET branch_name = 'dev/changed' WHERE id = $1`, [s.sessionId]);
      if (change === 'repo') await pool.query(`UPDATE apps SET repo_url = 'https://github.com/Trusted-Owner/other' WHERE id = $1`, [s.appId]);
      if (change === 'app') await pool.query('UPDATE chat_sessions SET app_id = $2 WHERE id = $1', [s.sessionId, (await session()).appId]);
      if (change === 'erased') await pool.query('UPDATE users SET anonymised_at = now() WHERE id = $1', [s.userId]);
      if (change === 'missing') await pool.query('DELETE FROM chat_sessions WHERE id = $1', [s.sessionId]);
      await settle();
      assert.equal((await result(queued.key)).data.result.ok, false, change);
      assert.equal(pushes.length, before, change); assert.equal(privacyCalls.length, reads, change);
    }
  });
  await t.test('private and unverifiable repositories fail closed on the conductor', async () => {
    for (const value of [{ ok: true, private: true }, { ok: false, code: 'github_error', message: 'Unavailable' }]) {
      privacy = value; const s = await session(); const before = pushes.length;
      const queued = await enqueue(s); await settle();
      const out = (await result(queued.key)).data.result;
      assert.equal(out.ok, false); assert.equal(out.status, value.ok ? 403 : 502);
      assert.equal(pushes.length, before);
    }
    privacy = { ok: true, private: false };
  });
  await t.test('expired queued work never pushes after its caller has given up', async () => {
    const s = await session(); const queued = await enqueue(s); const before = pushes.length;
    await pool.query(`UPDATE wf_work SET input = jsonb_set(input, '{expiresAt}', '0'::jsonb) WHERE machine = $1 AND key = $2`, [MACHINE, queued.key]);
    await settle();
    assert.equal((await result(queued.key)).data.result.code, 'push_expired');
    assert.equal(pushes.length, before);
  });
  await t.test('a forged result from a route cannot settle a pending push', async () => {
    const s = await session(); const queued = await enqueue(s);
    const { rows: [work] } = await pool.query('SELECT id FROM wf_work WHERE machine = $1 AND key = $2', [MACHINE, queued.key]);
    const event = await web.append(MACHINE, queued.key, { type: 'WorkSucceeded', payload: {
      workId: work.id, kind: WORK, workKey: 'push', attempt: 1, result: { ok: true, sha: 'b'.repeat(40) },
    } }, { requestKey: randomUUID(), source: { kind: 'route', name: WORK } });
    await conductor.drain();
    assert.equal((await web.waitForEvent(event, 1000)).status, 'rejected');
    assert.equal((await result(queued.key)).state, 'pushing'); await settle();
  });
  await t.test('request results remain separate when one session pushes twice', async () => {
    const s = await session(); const a = await enqueue(s); await settle();
    pushError = Object.assign(new Error('fake redacted Git failure'), { code: 'no_token', userMessage: 'Ask an admin.', permanent: true });
    const b = await enqueue(s); await settle(); pushError = null;
    assert.equal((await result(a.key)).data.result.ok, true);
    assert.deepEqual((await result(b.key)).data.result, { ok: false, code: 'no_token', message: 'fake redacted Git failure', detail: 'Ask an admin.', permanent: true, status: 502 });
    const { rows: [w] } = await pool.query('SELECT input FROM wf_work WHERE machine = $1 AND key = $2', [MACHINE, a.key]);
    assert.deepEqual(Object.keys(w.input).sort(), ['appId', 'branchName', 'expiresAt', 'repoUrl', 'sessionId']);
  });
  await t.test('the conductor reports a transient push database error as a retryable 502', async () => {
    const s = await session();
    pushError = Object.assign(new Error('Synthetic temporary database outage'), { code: '08006' });
    const queued = await enqueue(s); await settle(); pushError = null;
    assert.deepEqual((await result(queued.key)).data.result, {
      ok: false, code: '08006', message: 'Synthetic temporary database outage', detail: null, permanent: false, status: 502,
    });
  });
  await t.test('a handler accidentally invoked in a web process refuses before any database or worker access', async () => {
    process.env.PROCESS_ROLE = 'web'; const before = pushes.length;
    const unsafe = workerPushServices({ pool: { query() { throw new Error('web touched database'); } } });
    await assert.rejects(unsafe[WORK].run({ input: {}, signal: new AbortController().signal }), /require a workflow process/);
    assert.equal(pushes.length, before); process.env.PROCESS_ROLE = 'conductor';
  });
  await t.test('an unavailable conductor returns a bounded failure without a privileged fallback', async () => {
    const s = await session(); const before = pushes.length;
    // Real kernel: nothing consumes its pending event. Shorten only the
    // caller's admission wait, keeping the real refuse-if-pending behavior.
    const impatient = Object.create(web);
    impatient.appendAndWait = (m, k, e, o) => web.appendAndWait(m, k, e, { ...o, waitMs: 10 });
    await assert.rejects(requestWorkerPush(impatient, pool, s, 10), e => e.code === 'push_unavailable' && e.httpStatus === 503 && !e.permanent);
    await conductor.drain(); await settle(); assert.equal(pushes.length, before);
  });
  await t.test('admission accepted while refusal catches up returns the conductor result without another push', async () => {
    const s = await session(); const before = pushes.length;
    const racing = Object.create(web);
    racing.appendAndWait = async (m, k, e, o) => {
      const eventId = await web.append(m, k, e, o);
      await conductor.drain();
      // The caller observed its deadline before the concurrent decision
      // committed. Refusal must observe and preserve the real decision.
      return { status: 'pending', eventId, requestKey: o.requestKey };
    };
    racing.refuseIfPending = async (eventId, reason) => {
      const settled = await web.refuseIfPending(eventId, reason);
      assert.equal(settled.status, 'accepted');
      await settle();
      return settled;
    };
    assert.deepEqual(await requestWorkerPush(racing, pool, s, 1000), { sha: 'a'.repeat(40), branch: s.branchName, stderr: '' });
    assert.equal(pushes.length, before + 1);
    const { rows: [commands] } = await pool.query(
      'SELECT count(*)::int AS n FROM wf_events WHERE machine = $1 AND app_id = $2 AND type = $3', [MACHINE, s.appId, 'Requested']);
    assert.equal(commands.n, 1, 'only the original command is submitted');
  });
  await t.test('an admitted request whose work is delayed returns a retryable timeout without local execution', async () => {
    const s = await session(); const before = pushes.length;
    const request = requestWorkerPush(web, pool, s, 10);
    // Observe the rejection immediately, before advancing its event.
    const refusal = assert.rejects(request, e => e.code === 'push_pending' && e.httpStatus === 503 && !e.permanent);
    await until(async () => (await pool.query('SELECT 1 FROM wf_events WHERE machine = $1 AND processed_at IS NULL', [MACHINE])).rowCount > 0);
    await conductor.drain(); await refusal;
    assert.equal(pushes.length, before);
    await pool.query(`UPDATE wf_work SET input = jsonb_set(input, '{expiresAt}', '0'::jsonb) WHERE machine = $1 AND status = 'queued'`, [MACHINE]);
    await settle(); assert.equal(pushes.length, before);
  });
  await t.test('a real separate conductor settles a push requested by a web process with no local I/O', async () => {
    await pool.query('CREATE TABLE wf_test_push_effects (pid integer, session_id integer)');
    const child = fork(require.resolve('./fixtures/worker-command-conductor'), [], {
      env: { PATH: process.env.PATH, TZ: 'UTC', PROCESS_ROLE: 'conductor', WORKER_COMMAND_TEST: JSON.stringify({ kind: 'push', databaseUrl: String(url) }) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const exited = once(child, 'exit');
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    try {
      const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`conductor exited: ${stderr}`); })]);
      assert.deepEqual(message, { ready: true });
      process.env.PROCESS_ROLE = 'web'; const before = pushes.length;
      const s = await session();
      assert.deepEqual(await requestWorkerPush(web, pool, s, 3000), { sha: 'c'.repeat(40), branch: s.branchName, stderr: '' });
      assert.equal(pushes.length, before, 'no parent-process worker or Git call');
      assert.deepEqual((await pool.query('SELECT pid, session_id FROM wf_test_push_effects')).rows,
        [{ pid: child.pid, session_id: s.sessionId }]);
    } finally {
      process.env.PROCESS_ROLE = 'conductor';
      if (child.exitCode === null) child.send('stop');
      const [code] = await exited; assert.equal(code, 0, stderr);
    }
  });
});
