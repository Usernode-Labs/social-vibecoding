'use strict';

// Idle workers, evicted by the worker-eviction clock from session_workers
// (services/worker-eviction.js), against the FULL PostgreSQL schema: not by
// which process's registry has a worker, and never one something works on
// (a turn, a durable build, a recorded operation). The runtime is a fake.
//
// Skipped when no server is reachable, required when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const eviction = require('../src/services/worker-eviction');
const unpushedCommits = require('../src/services/worker-unpushed-commit');
const { waitFor, deferred } = require('./lib/wait-for');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('idle workers are the eviction clock\'s, against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `worker_eviction_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { rows: [user] } = await pool.query("INSERT INTO users (username, password) VALUES ('w', 'x') RETURNING id");
  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, status, created_by) VALUES ('W', 'w', 'running', $1) RETURNING id", [user.id]);
  const session = async (extra = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, active_turn, workflow_owner)
     VALUES ($1, $2, 'b', 'active', $3::jsonb, $4) RETURNING id`,
    [app.id, user.id, extra.turn ? JSON.stringify(extra.turn) : null, extra.owner || null])).rows[0].id;
  const used = (id, ago) => pool.query(
    `INSERT INTO session_workers (session_id, last_used_at) VALUES ($1, NOW() - $2::interval)
     ON CONFLICT (session_id) DO UPDATE SET last_used_at = EXCLUDED.last_used_at`, [id, ago]);
  // The runtime: the workers it runs, and what was evicted or destroyed.
  const runtime = { running: [], evicted: [], destroyed: [] };
  const worker = {
    listOrphanWorkers: async () => runtime.running.map((id) => ({ name: `usernode-worker-${id}`, sessionId: id, state: 'running' })),
    evictWorker: async (id) => {
      runtime.evicted.push(id);
      await pool.query('DELETE FROM session_workers WHERE session_id = $1', [id]);
    },
    rescueUnpushedCommit: async () => ({ attempted: false }),
    removeWorker: async (id, options) => {
      if (!(await options.proceed())) return { skipped: true };
      runtime.evicted.push(id); await options.renew(); return { removed: true };
    },
    destroyWorker: async (n) => { runtime.destroyed.push(n); },
    workerContainerName: (id) => `usernode-worker-${id}`,
  };
  const sweep = () => eviction.sweep(pool, { idleMs: 10 * 60 * 1000, deps: { worker } });
  const reset = () => { runtime.evicted.length = 0; runtime.destroyed.length = 0; };

  await t.test('a worker nobody used for the window is evicted, one used lately is kept, whichever process used them', async () => {
    reset();
    const idle = await session();
    const recent = await session();
    await used(idle, '11 minutes');
    await used(recent, '2 minutes');
    runtime.running = [idle, recent];
    await sweep();
    assert.deepEqual(runtime.evicted, [idle]);
    const { rows } = await pool.query('SELECT session_id FROM session_workers ORDER BY session_id');
    assert.deepEqual(rows.map((r) => r.session_id), [recent], 'the evicted worker\'s row goes with it');
  });

  await t.test('never a worker something works on: a turn, a durable build', async () => {
    reset();
    const turning = await session({ turn: { turnId: crypto.randomUUID(), phase: 'executing' } });
    // #6068: a durable build holds while its build.run item is outstanding,
    // as the kernel's pipeline writes it.
    {
      const c = await pool.connect();
      try {
        await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
        await c.query(`INSERT INTO wf_instances (machine, key, state, data, machine_version) VALUES ('bot-build', 'run:9', 'building', '{}'::jsonb, 1)`);
        await c.query(`INSERT INTO wf_work (machine, key, kind, work_key, input, status, claim_id, lease_until)
                       VALUES ('bot-build', 'run:9', 'build.run', 'run', '{}'::jsonb, 'running',
                               gen_random_uuid(), NOW() + interval '1 hour')`);
        await c.query('COMMIT');
      } finally { c.release(); }
    }
    const building = await session({ owner: 'bot-build/run:9' });
    await used(turning, '1 hour');
    await used(building, '1 hour');
    runtime.running = [turning, building];
    await sweep();
    assert.deepEqual(runtime.evicted, []);
  });

  await t.test('a running worker with no row is counted as used from now; one whose change is gone is destroyed', async () => {
    reset();
    const unknown = await session();
    runtime.running = [unknown, 999999];
    await sweep();
    assert.deepEqual(runtime.evicted, []);
    const { rows: [row] } = await pool.query('SELECT last_used_at > NOW() - interval \'1 minute\' AS fresh FROM session_workers WHERE session_id = $1', [unknown]);
    assert.equal(row.fresh, true);
    assert.deepEqual(runtime.destroyed, ['usernode-worker-999999']);
  });

  await t.test('a worker used between the read and the claim is kept', async () => {
    reset();
    const raced = await session();
    await used(raced, '20 minutes');
    runtime.running = [raced];
    const realQuery = pool.query.bind(pool);
    pool.query = async (sql, params) => {
      if (/SELECT sw.session_id FROM session_workers sw JOIN chat_sessions cs/.test(sql)) {
        await realQuery('UPDATE session_workers SET last_used_at = NOW() WHERE session_id = $1', [raced]);
      }
      return realQuery(sql, params);
    };
    try { await sweep(); } finally { pool.query = realQuery; }
    assert.deepEqual(runtime.evicted, []);
  });

  await t.test('a turn that starts between the read and the claim keeps its worker', async () => {
    reset();
    const raced = await session();
    await used(raced, '20 minutes');
    runtime.running = [raced];
    const realQuery = pool.query.bind(pool);
    pool.query = async (sql, params) => {
      if (/SELECT sw.session_id FROM session_workers sw JOIN chat_sessions cs/.test(sql)) {
        // Its turn is recorded; its note of use has not come yet.
        await realQuery(`UPDATE chat_sessions SET active_turn = '{"turnId":"t-raced"}'::jsonb WHERE id = $1`, [raced]);
      }
      return realQuery(sql, params);
    };
    try { await sweep(); } finally { pool.query = realQuery; }
    assert.deepEqual(runtime.evicted, []);
  });

  await t.test('a turn that comes while its worker is evicted waits for the eviction, then finds the worker gone', async () => {
    reset();
    const evicting = await session();
    await used(evicting, '20 minutes');
    runtime.running = [evicting];
    let release;
    const gate = new Promise((r) => { release = r; });
    const realEvict = worker.evictWorker;
    const entered = deferred();
    worker.evictWorker = async (id) => { runtime.evicted.push(id); entered.resolve(); await gate; };
    try {
      const swept = sweep();
      await waitFor(() => runtime.evicted.length > 0, { label: 'the eviction under way' });
      // The holder is inside the session lock before the note is started, so
      // the window below only has to catch a note that did not wait.
      await entered.promise;
      assert.deepEqual(runtime.evicted, [evicting], 'the eviction is under way');
      let noted = false;
      const note = eviction.noteUsed(pool, evicting).then(() => { noted = true; });
      // fixed wait: an absence check — nothing observable says the note has queued behind the in-process session lock, and a shorter window could only under-detect a note that failed to wait.
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(noted, false, 'its note of use waits for the eviction');
      release();
      await swept;
      await note;
      const { rows: [row] } = await pool.query('SELECT last_used_at > NOW() - interval \'1 minute\' AS fresh FROM session_workers WHERE session_id = $1', [evicting]);
      assert.equal(row.fresh, true, 'and it is used from now: the next ensure starts the worker again');
    } finally {
      worker.evictWorker = realEvict;
      release();
    }
  });

  async function requested() {
    const id = await session();
    const { rows: [r] } = await pool.query(`UPDATE chat_sessions SET status = 'promoted', agent_config_version = 2,
      agent_context_reset_at = NOW() - interval '1 minute' WHERE id = $1 RETURNING agent_context_reset_at::text AS at`, [id]);
    await used(id, '10 minutes');
    return { sessionId: id, appId: app.id, userId: user.id, configVersion: 2, reason: 'promoted-pause', requestedAt: r.at, turnId: null };
  }
  const release = target => eviction.releaseRequested(pool, target, { worker });
  await t.test('requested removal checks its claim again after reading runtime identity', async () => {
    reset(); const target = await requested(); const remove = worker.removeWorker;
    worker.removeWorker = async (id, options) => {
      await pool.query('UPDATE session_workers SET last_used_at = NOW() WHERE session_id = $1', [id]);
      return remove(id, options);
    };
    try {
      assert.deepEqual(await release(target), { skipped: 'changed_or_used' });
      assert.deepEqual(runtime.evicted, []);
    } finally { worker.removeWorker = remove; }
  });
  await t.test('a new turn waits until requested removal has finished before noting worker use', async () => {
    reset(); const target = await requested(); const remove = worker.removeWorker;
    let reached = false; let unblock;
    const gate = new Promise(resolve => { unblock = resolve; });
    worker.removeWorker = async (id, options) => { reached = true; await gate; return remove(id, options); };
    let running; let noting;
    try {
      running = release(target); await waitFor(() => reached, { label: 'the requested removal under way' });
      let noted = false; noting = eviction.noteUsed(pool, target.sessionId).then(() => { noted = true; });
      // fixed wait: an absence check — the removal holds the in-process session lock and nothing observable says the note has queued behind it; a shorter window could only under-detect a note that failed to wait.
      await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(noted, false);
      unblock(); assert.deepEqual(await running, { released: true }); await noting;
      assert.deepEqual(runtime.evicted, [target.sessionId]);
      const { rows: [r] } = await pool.query(`SELECT last_used_at > $2::timestamptz AS fresh FROM session_workers WHERE session_id = $1`, [target.sessionId, target.requestedAt]);
      assert.equal(r.fresh, true);
    } finally { unblock(); await Promise.allSettled([running, noting]); worker.removeWorker = remove; }
  });
  await t.test('losing the session lock after reading runtime identity prevents deletion', async () => {
    reset(); const target = await requested(); const remove = worker.removeWorker;
    const locks = require('../src/db/session-locks');
    const { WORKER_EVICTION_LOCK } = require('../src/services/advisory-locks');
    let reached = false; let unblock;
    const gate = new Promise(resolve => { unblock = resolve; });
    worker.removeWorker = async (id, options) => { reached = true; await gate; return remove(id, options); };
    let running;
    try {
      running = release(target);
      const refusal = assert.rejects(running, /lost its session lock/);
      await waitFor(() => reached, { label: 'the requested removal under way' });
      const { rows: [lock] } = await pool.query(`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid::bigint = $1 AND objid::bigint = $2`, [WORKER_EVICTION_LOCK, target.sessionId]);
      assert.ok(lock, 'only the synthetic fixture database lock is targeted');
      await pool.query('SELECT pg_terminate_backend($1)', [lock.pid]);
      await waitFor(() => locks.openConnections() === 0, { label: 'the terminated lock connection gone' });
      unblock(); await refusal; assert.deepEqual(runtime.evicted, []);
    } finally { unblock(); await Promise.allSettled([running]); worker.removeWorker = remove; }
  });
  await t.test('a lost work claim or failed preservation of unpushed work prevents removal', async () => {
    reset(); const target = await requested();
    await assert.rejects(eviction.releaseRequested(pool, target, { worker, renew: async () => { throw new Error('lease lost'); } }), /lease lost/);
    const rescue = worker.rescueUnpushedCommit;
    worker.rescueUnpushedCommit = async () => { throw Object.assign(new Error('Could not preserve committed worker changes'), { permanent: true, code: 'github_paused' }); };
    try { await assert.rejects(release(target), err => /Could not preserve/.test(err.message) && err.permanent !== true && err.code === 'github_paused'); }
    finally { worker.rescueUnpushedCommit = rescue; }
    assert.deepEqual(runtime.evicted, []);
  });
  await t.test('turn preparation keeps the eviction lock through rescue and notes use before release can proceed', async () => {
    reset(); const target = await requested(); let reached = false; let unblock;
    const gate = new Promise(resolve => { unblock = resolve; });
    const preparing = eviction.noteUsed(pool, target.sessionId, { prepare: async () => { reached = true; await gate; } });
    let releasing;
    try {
      await waitFor(() => reached, { label: 'the preparation holding the lock' }); let finished = false;
      releasing = release(target).then(out => { finished = true; return out; });
      // fixed wait: an absence check — the release waits on the in-process session lock preparation holds, and nothing observable says it has queued; a shorter window could only under-detect a release that failed to wait.
      await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(finished, false);
      unblock(); await preparing;
      assert.deepEqual(await releasing, { skipped: 'changed_or_used' });
      assert.deepEqual(runtime.evicted, []);
    } finally { unblock(); await Promise.allSettled([preparing, releasing]); }
  });
  await t.test('another conductor rescues durable commits before Pause/idle removal and keeps failed rescues', async t => {
    const actualWorker = require('../src/services/worker');
    const kubernetes = require('../src/services/kubernetes');
    const teardownQueries = [];
    const query = pool.query.bind(pool);
    t.mock.method(pool, 'query', (...args) => {
      const pending = query(...args);
      teardownQueries.push(pending);
      return pending;
    });
    t.mock.method(require('../src/db/pool'), 'getPool', () => pool);
    t.mock.method(require('../src/services/github'), 'canActOn', () => true);
    t.mock.method(require('../src/services/github'), 'checkRepoPublic', async () => ({ ok: true, private: false }));
    t.mock.method(require('../src/services/github'), 'getInstallationToken', async () => 'fake-rescue-token');
    const calls = []; let pushFails = true;
    t.mock.method(require('../src/services/worker-git-push'), 'push', async options => {
      assert.equal(options.token, 'fake-rescue-token'); calls.push('push');
      if (pushFails) throw Object.assign(new Error('synthetic push outage'), { permanent: true });
      return { sha: 'a'.repeat(40), stderr: '' };
    });
    t.mock.method(kubernetes, 'execInWorker', async (_config, _runtime, command) => ({
      stdout: command[0] === 'tail'
        ? `__USERNODE_RESULT__ cc_exit=0 ahead=1 sha=${'a'.repeat(40)} push_ok=0\n__USERNODE_EXIT__ 0\n` : '', stderr: '',
    }));
    t.mock.method(kubernetes, 'deleteWorker', async () => { calls.push('remove'); });
    t.mock.method(kubernetes, 'getWorkerStatus', async () => 'running');
    t.mock.method(kubernetes, 'getWorkerRuntimeMetadata', async config => ({
      contractVersion: config.workerContractVersion, imageRef: config.kubernetes.workerImage, storageMode: 'persistent',
    }));
    const prior = process.env.WORKER_RUNTIME; process.env.WORKER_RUNTIME = 'kubernetes';
    t.after(() => { if (prior === undefined) delete process.env.WORKER_RUNTIME; else process.env.WORKER_RUNTIME = prior; });
    await pool.query("UPDATE apps SET repo_url = 'https://github.com/Trusted-Owner/stored-repo.git' WHERE id = $1", [app.id]);
    for (const kind of ['idle', 'promoted-pause', 'turn-start']) {
      reset(); calls.length = 0; pushFails = true;
      await pool.query('UPDATE session_workers SET last_used_at = NOW()');
      const target = await requested(); const id = target.sessionId;
      await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"finished-build","mode":"build","journal":"/home/node/.claude/turn-rescue-test.log"}'::jsonb WHERE id = $1`, [id]);
      const commit = { sha: 'a'.repeat(40), branchName: 'b' };
      const state = await actualWorker.resumeTurnFromJournal(id, {
        journal: '/home/node/.claude/turn-rescue-test.log', turnId: 'finished-build', mode: 'build', branchName: 'b',
      });
      assert.equal(state.pushOk, false);
      calls.length = 0; // Publication's recorded failure is separate from the rescue below.
      // Recovery notes last use asynchronously. Finish that write before
      // dating the fixture's later Pause/idle request; a late write would
      // correctly spare a worker used after the request.
      while (teardownQueries.length) await Promise.all(teardownQueries.splice(0));
      await eviction.noteUsed(pool, id);
      await used(id, '10 minutes');
      const { rows: [ended] } = await pool.query(`UPDATE chat_sessions SET active_turn = NULL,
        agent_context_reset_at = NOW() WHERE id = $1 RETURNING agent_context_reset_at::text AS at`, [id]);
      target.requestedAt = ended.at;
      if (kind === 'promoted-pause') {
        target.reason = 'promoted-pause';
        await pool.query("UPDATE chat_sessions SET status = 'promoted' WHERE id = $1", [id]);
      }
      // No registry entry: this process never ran the turn that recorded it.
      actualWorker._registryForgetForTests(id);
      const registerNext = () => pool.query(`UPDATE chat_sessions
        SET active_turn = '{"turnId":"next-turn","phase":"dispatch_pending","journal":"/home/node/.claude/turn-next-turn.log"}'::jsonb WHERE id = $1`, [id]);
      if (kind === 'turn-start') await registerNext();
      const otherConductor = { ...worker, rescueUnpushedCommit: actualWorker.rescueUnpushedCommit,
        evictWorker: actualWorker.evictWorker,
        removeWorker: async (...args) => { calls.push('remove'); return worker.removeWorker(...args); } };
      const run = () => kind === 'turn-start' ? actualWorker.ensureWorker(id, { branchName: 'b', turnId: 'next-turn' }) : kind !== 'idle'
        ? eviction.releaseRequested(pool, target, { worker: otherConductor })
        : eviction.sweep(pool, { idleMs: 1000, deps: { worker: otherConductor } });
      runtime.running = [id];
      if (kind !== 'idle') await assert.rejects(run(), /An earlier build's commit aaaaaaaa/);
      else assert.equal((await run()).evicted, 0);
      assert.deepEqual(calls, ['push'], `${kind}: failure prevents deletion`);
      assert.equal((await unpushedCommits.read(pool, id)).sha, commit.sha);
      if (kind === 'turn-start') {
        assert.equal((await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [id])).rows[0].active_turn, null, 'a refused new turn releases its own real PostgreSQL record');
        await registerNext();
      }
      pushFails = false; calls.length = 0;
      await run(); assert.deepEqual(calls, kind === 'turn-start' ? ['push'] : ['push', 'remove'], `${kind}: push precedes reuse or removal`);
      if (kind === 'turn-start') {
        await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [id]);
        actualWorker._registryForgetForTests(id);
      }
      assert.equal(await unpushedCommits.read(pool, id), null, 'successful push clears the durable record');
    }
    calls.length = 0;
    const running = await requested(); running.reason = 'promoted-pause'; running.turnId = 'captured-turn';
    await pool.query(`UPDATE chat_sessions SET status = 'promoted', active_turn = '{"turnId":"captured-turn","phase":"executing"}'::jsonb WHERE id = $1`, [running.sessionId]);
    await eviction.releaseRequested(pool, running, { worker: { ...worker, rescueUnpushedCommit: actualWorker.rescueUnpushedCommit,
      removeWorker: async (...args) => { calls.push('remove'); return worker.removeWorker(...args); } } });
    assert.deepEqual(calls, ['remove'], 'a captured running turn with no finished commit is still released');
    for (const status of ['archived', 'merged', 'closed', 'failed', 'anonymised']) {
      calls.length = 0; pushFails = false;
      const id = await session();
      await unpushedCommits.record(pool, id, { sha: 'a'.repeat(40), branchName: 'b' });
      if (status === 'anonymised') await pool.query('UPDATE users SET anonymised_at = NOW() WHERE id = $1', [user.id]);
      else await pool.query('UPDATE chat_sessions SET status = $2 WHERE id = $1', [id, status]);
      try {
        actualWorker._registryForgetForTests(id);
        await actualWorker.evictWorker(id);
        assert.deepEqual(calls, ['push', 'remove'], `${status}: preserve the exact saved commit before eviction`);
        assert.equal((await pool.query('SELECT 1 FROM session_workers WHERE session_id = $1', [id])).rowCount, 0);
      } finally {
        await pool.query('UPDATE users SET anonymised_at = NULL WHERE id = $1', [user.id]);
        actualWorker._registryForgetForTests(id);
      }
    }
  });
  await t.test('only the new attempt itself can see an older commit through its pending active_turn', async () => {
    const id = await session(); const commit = { sha: 'a'.repeat(40), branchName: 'b' };
    await unpushedCommits.record(pool, id, commit);
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"new-turn","phase":"dispatch_pending"}'::jsonb WHERE id = $1`, [id]);
    assert.equal(await unpushedCommits.read(pool, id), null);
    assert.equal((await unpushedCommits.read(pool, id, { turnId: 'new-turn' })).sha, commit.sha);
    assert.equal(await unpushedCommits.read(pool, id, { turnId: 'other-turn' }), null);
    await pool.query(`UPDATE chat_sessions SET active_turn = active_turn || '{"phase":"executing"}'::jsonb WHERE id = $1`, [id]);
    assert.equal(await unpushedCommits.read(pool, id, { turnId: 'new-turn' }), null, 'even a matching identity cannot rescue over an executing turn');
  });
  await t.test('late teardown and push completion cannot clear a newer durable commit', async () => {
    const id = await session({ turn: { turnId: 'new-turn' } });
    const old = { sha: 'a'.repeat(40), branchName: 'b' };
    const next = { sha: 'b'.repeat(40), branchName: 'b' };
    await unpushedCommits.record(pool, id, next, 'new-turn');
    await unpushedCommits.record(pool, id, null, 'old-turn');
    await unpushedCommits.clear(pool, id, old.sha, old.branchName);
    assert.equal(await unpushedCommits.read(pool, id), null, 'an active turn cannot be rescued');
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [id]);
    assert.equal((await unpushedCommits.read(pool, id)).sha, next.sha);
    await unpushedCommits.clear(pool, id, next.sha, next.branchName);
    assert.equal(await unpushedCommits.read(pool, id), null);
  });
});
