'use strict';

// test:changed: when src/services/worker.js (both live and replay completion)
// test:changed: when src/services/durable-turn.js (publication cannot redispatch)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const publication = require('../src/services/turn-publication');
const steps = require('../src/services/durable-steps');
const durableTurn = require('../src/services/durable-turn');
const db = require('../src/db/pool');
const SHA = 'a'.repeat(40);

test('conductor completion durably publishes a committed turn without repeating its agent', { timeout: 60000 }, async t => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; TEST_DATABASE_URL requires this suite'); return;
  }
  const name = `turn_publication_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(admin.options.connectionString); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url) });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  t.mock.method(db, 'getPool', () => pool);
  const previousRole = process.env.PROCESS_ROLE;
  process.env.PROCESS_ROLE = 'conductor';
  t.after(async () => {
    if (previousRole === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = previousRole;
    await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end();
  });
  let seq = 0;
  async function fixture(mode = 'build') {
    const n = ++seq;
    const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [`publisher-${n}`]);
    const { rows: [a] } = await pool.query(`INSERT INTO apps (name, slug, created_by, repo_url, status)
      VALUES ($1, $1, $2, 'https://github.com/acme/demo', 'running') RETURNING id`, [`publisher-${n}`, u.id]);
    const branchName = `dev/publisher-${n}`;
    const turn = { turnId: randomUUID(), mode, phase: 'executing', backend: 'claude_code', journal: `/home/node/.claude/turn-${randomUUID()}.log` };
    const { rows: [s] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, branch_name, active_turn)
      VALUES ($1, $2, $3, $4::jsonb) RETURNING id`, [a.id, u.id, branchName, JSON.stringify(turn)]);
    const target = await publication.captureTarget(pool, s.id, turn.turnId, branchName);
    turn.publicationTarget = target;
    const result = { resultSeen: true, sha: SHA, ahead: mode === 'sync' ? 0 : 1, pushOk: false,
      ...(mode === 'sync' ? { syncResult: 'clean' } : {}) };
    let clock = Date.now(); const pushes = [];
    const options = { pool, sessionId: s.id, turnId: turn.turnId, journal: turn.journal, mode, branchName, result,
      now: () => clock, sleep: async ms => { clock += ms; },
      push: async (branch, expected) => { pushes.push({ branch, expected }); return { sha: SHA }; } };
    return { ...options, options, turn, target, pushes, id: s.id,
      receipt: async () => (await pool.query('SELECT * FROM turn_effects WHERE turn_id = $1 AND effect_key = $2', [publication.receiptId(turn), publication.EFFECT])).rows[0],
      saved: async () => (await pool.query('SELECT unpushed_sha FROM session_workers WHERE session_id = $1', [s.id])).rows[0]?.unpushed_sha };
  }
  for (const mode of ['build', 'sync']) await t.test(`${mode}: exact target/commit, including a sync fast-forward with no commits ahead`, async () => {
    const f = await fixture(mode);
    const out = await publication.publish(f.options);
    assert.equal(out.pushOk, true);
    assert.deepEqual(f.pushes, [{ branch: f.branchName, expected: { expectedAppId: f.target.appId,
      expectedUserId: f.target.userId, expectedRepoUrl: f.target.repoUrl, expectedSha: SHA } }]);
    assert.equal((await f.receipt()).state, 'completed');
    assert.equal(await f.saved(), null);
    assert.equal((await publication.publish(f.options)).pushOk, true);
    assert.equal(f.pushes.length, 1, 'completed publication is replayed');
  });
  await t.test('a transient failure retries publication with the commit durably saved before every push', async () => {
    const f = await fixture(); let calls = 0;
    const out = await publication.publish({ ...f.options, push: async () => {
      assert.equal(await f.saved(), SHA);
      assert.equal((await f.receipt()).state, 'pending');
      if (++calls < 3) throw new Error('temporary outage');
      return { sha: SHA };
    } });
    assert.equal(calls, 3); assert.equal(out.pushOk, true);
  });
  for (const code of ['github_paused', 'no_token', 'bad_branch']) await t.test(`${code}: permanent failure is recorded and the commit retained`, async () => {
    const f = await fixture(); let calls = 0;
    const opts = { ...f.options, push: async () => { calls++; throw Object.assign(new Error(code), { code, permanent: true }); } };
    const out = await publication.publish(opts);
    assert.equal(out.pushOk, false); assert.equal(out.pushFailure.permanent, true);
    assert.equal(out.pushFailure.code, code); assert.equal(calls, 1);
    assert.equal((await f.receipt()).state, 'completed'); assert.equal(await f.saved(), SHA);
    assert.equal((await publication.publish(opts)).pushOk, false); assert.equal(calls, 1);
  });
  await t.test('an exhausted transient failure records its cause and keeps the saved commit', async () => {
    const f = await fixture(); let calls = 0;
    const out = await publication.publish({ ...f.options, push: async () => { calls++; throw new Error('still unavailable'); } });
    assert.equal(calls, 5); assert.equal(out.pushFailure.permanent, false);
    assert.equal(await f.saved(), SHA); assert.equal((await f.receipt()).state, 'completed');
  });
  await t.test('restart after intent/before retry resumes only publication', async () => {
    const f = await fixture();
    await assert.rejects(publication.publish({ ...f.options,
      push: async () => { throw new Error('outage'); }, sleep: async () => { throw new Error('process restarted'); },
    }), err => err.retainActiveTurn && err.retryWorkerRecovery);
    assert.equal((await f.receipt()).state, 'pending'); assert.equal(await f.saved(), SHA);
    const out = await publication.publish(f.options);
    assert.equal(out.pushOk, true); assert.equal(f.pushes.length, 1);
  });
  for (const committed of [false, true]) await t.test(`restart ${committed ? 'after' : 'before'} receipt commit after a successful push`, async () => {
    const f = await fixture(); let failed = false;
    const connection = { ...pool, query: async (sql, args) => {
      if (!failed && /SET state = 'completed'/.test(sql)) {
        failed = true;
        if (committed) await pool.query(sql, args);
        throw new Error('database response lost');
      }
      return pool.query(sql, args);
    } };
    await assert.rejects(publication.publish({ ...f.options, pool: connection }), e => e.retainActiveTurn);
    assert.equal(f.pushes.length, 1);
    assert.equal((await publication.publish(f.options)).pushOk, true);
    assert.equal(f.pushes.length, committed ? 1 : 2, 'uncertain pushes replay only the same non-forcing publication');
  });
  await t.test('Stop before publication retains a finished commit without publishing it', async () => {
    const f = await fixture();
    await pool.query(`UPDATE chat_sessions SET active_turn = active_turn || $2::jsonb WHERE id = $1`, [f.id, JSON.stringify({ stopRequestedAt: new Date().toISOString() })]);
    const out = await publication.publish(f.options);
    assert.equal(out.pushFailure.code, 'turn_stopped'); assert.equal(f.pushes.length, 0); assert.equal(await f.saved(), SHA);
  });
  await t.test('pending publication cannot be cleaned up; explicit Stop records its cancellation first', async () => {
    const f = await fixture(); const worker = require('../src/services/worker');
    await assert.rejects(publication.publish({ ...f.options, push: async () => { throw new Error('outage'); },
      sleep: async () => {
        assert.equal(await worker.finishTurn(f.id, { turnId: f.turnId }), false, 'ordinary cleanup retains the replay source');
        assert.ok((await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [f.id])).rows[0].active_turn);
        await pool.query("UPDATE chat_sessions SET status = 'promoted' WHERE id = $1", [f.id]);
        await assert.rejects(require('../src/services/worker-eviction').releaseRequested(pool, {
          sessionId: f.id, appId: f.target.appId, userId: f.target.userId, reason: 'promoted-pause',
          configVersion: 1, turnId: f.turnId, requestedAt: new Date().toISOString(),
        }), e => e.code === 'session_busy');
        assert.equal(await f.saved(), SHA, 'Pause cannot remove a worker awaiting publication');
        await pool.query(`UPDATE chat_sessions SET active_turn = active_turn || $2::jsonb WHERE id = $1`, [f.id, JSON.stringify({ stopRequestedAt: new Date().toISOString() })]);
        assert.equal(await worker.clearActiveTurn(f.id, { turnId: f.turnId }), true);
        throw new Error('explicitly stopped');
      } }), e => e.retainActiveTurn);
    assert.equal((await f.receipt()).result.code, 'turn_stopped');
    assert.equal((await f.receipt()).state, 'completed'); assert.equal(await f.saved(), SHA);
  });
  await t.test('an old failed/discarded or physically stopped runner has no publishable result', async () => {
    const f = await fixture();
    for (const result of [{ ...f.result, resultSeen: false }, { ...f.result, ahead: 0, sha: '' }, { ...f.result, branchMismatch: true }]) {
      assert.equal((await publication.publish({ ...f.options, result })).pushOk, false);
    }
    assert.equal(f.pushes.length, 0); assert.equal(await f.receipt(), undefined);
  });
  await t.test('paid turn completion survives publication recovery with no redispatch', async () => {
    const f = await fixture(); let dispatched = 0;
    let checkpoint;
    const first = steps.durable({ checkpoint: async value => { checkpoint = value; }, signal: new AbortController().signal });
    const worker = { markTurnTail: async () => {}, finishTurn: async () => true,
      resumeTurnFromJournal: async () => publication.publish(f.options) };
    await assert.rejects(durableTurn.runTurn(first, 'build', { pool, session: { id: f.id, branch_name: f.branchName }, mode: 'build', budgetMs: 60000,
      dispatch: async extra => { dispatched++; await extra.onTurnRecord(f.turn); throw Object.assign(new Error('restart before result'), { retainActiveTurn: true }); },
      deps: { worker } }), /restart/);
    const recovered = steps.durable({ resumeFrom: checkpoint, checkpoint: async value => { checkpoint = value; }, signal: new AbortController().signal });
    const out = await durableTurn.runTurn(recovered, 'build', { pool, session: { id: f.id, branch_name: f.branchName }, mode: 'build', budgetMs: 60000,
      dispatch: async () => { dispatched++; throw new Error('must never rerun the paid agent'); },
      deps: { worker, agentTurn: { persistRecoveredAgentThread: async () => {}, settleRecoveredAgentAttempt: async () => ({}) } } });
    assert.equal(out.routed.result.pushOk, true); assert.equal(dispatched, 1); assert.equal(f.pushes.length, 1);
  });
  await t.test('live and replay share publication for both harnesses, sync and old/new worker results', async t => {
    const worker = require('../src/services/worker');
    const kube = require('../src/services/kubernetes');
    const git = require('../src/services/worker-git-push');
    const github = require('../src/services/github');
    const before = { runtime: process.env.WORKER_RUNTIME, secret: process.env.WORKER_JWT_SECRET };
    process.env.WORKER_RUNTIME = 'kubernetes'; process.env.WORKER_JWT_SECRET = 'publication-test-worker-secret';
    t.after(() => {
      for (const [key, value] of [['WORKER_RUNTIME', before.runtime], ['WORKER_JWT_SECRET', before.secret]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    t.mock.method(github, 'canActOn', () => true);
    t.mock.method(github, 'checkRepoPublic', async () => ({ ok: true, private: false }));
    t.mock.method(github, 'getInstallationToken', async () => 'credential-only-in-trusted-pusher');
    let journalText = ''; let publishes = 0; const dispatches = [];
    t.mock.method(kube, 'execInWorker', async (_cfg, _name, args, stdin) => {
      assert.ok(!JSON.stringify([args, stdin]).includes('credential-only-in-trusted-pusher'));
      if (args[0] === 'tail') return { stdout: journalText, stderr: '' };
      if (stdin?.includes('nohup sh -c')) dispatches.push(stdin);
      return { stdout: 'credential-free-export', stderr: '' };
    });
    t.mock.method(git, 'push', async opts => {
      publishes++;
      assert.equal(opts.expectedSha, SHA); assert.equal(opts.token, 'credential-only-in-trusted-pusher');
      await opts.exportWorker('export'); return { sha: SHA, stderr: '' };
    });
    for (const preregistered of [false, true]) for (const cause of ['inactive', 'anonymised', 'branch_changed', 'database']) {
      await t.test(`target capture failure: ${cause}, pre-registered=${preregistered}`, async t => {
        const f = await fixture(); const dispatched = dispatches.length;
        const turnId = randomUUID(); const turnUuid = preregistered ? randomUUID() : null;
        const pending = preregistered ? { turnId, turnUuid, backend: 'codex_openrouter', phase: 'dispatch_pending',
          mode: 'build', journal: `/home/node/.claude/turn-${turnUuid}.log` } : null;
        await pool.query('UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1', [f.id, JSON.stringify(pending)]);
        if (cause === 'inactive') await pool.query("UPDATE chat_sessions SET status = 'archived' WHERE id = $1", [f.id]);
        if (cause === 'anonymised') await pool.query('UPDATE users SET anonymised_at = NOW() WHERE id = $1', [f.target.userId]);
        if (cause === 'branch_changed') await pool.query("UPDATE chat_sessions SET branch_name = 'dev/changed' WHERE id = $1", [f.id]);
        if (cause === 'database') t.mock.method(publication, 'captureTarget', async () => { throw new Error('temporary capture database failure'); });
        worker.adoptWarmWorker(f.id, `sv-worker-s${f.id}`);
        try {
          await assert.rejects(worker.execInWorker(f.id, { mode: 'build', branchName: f.branchName,
            logicalTurnId: turnId, turnUuid, journalPath: pending?.journal, prompt: 'No runner may start.',
            agentBackend: preregistered ? 'codex_openrouter' : 'claude_code', agentHarness: preregistered ? 'codex' : null,
            systemPrompt: preregistered ? null : 'Synthetic build instructions.',
            model: 'claude-sonnet-5-5', agentModel: 'synthetic/model', openrouterApiKey: 'synthetic-key' }),
          e => e.code === 'durable_turn_persist_failed');
          assert.equal(dispatches.length, dispatched);
          assert.equal((await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [f.id])).rows[0].active_turn, null);
          assert.equal(worker.isInFlight(f.id), false);
        } finally { worker._registryForgetForTests(f.id); }
      });
    }
    await t.test('failed-capture cleanup never clears a replacement pending attempt', async t => {
      const f = await fixture(); const dispatched = dispatches.length;
      await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [f.id]);
      const replacement = { turnId: randomUUID(), phase: 'dispatch_pending', journal: '/home/node/.claude/turn-replacement.log' };
      t.mock.method(publication, 'captureTarget', async () => { throw new Error('capture failed'); });
      const query = pool.query.bind(pool); let replaced = false;
      t.mock.method(pool, 'query', async (sql, args) => {
        if (!replaced && sql.includes("active_turn->>'turnUuid' IS NOT DISTINCT FROM $4::text")) {
          replaced = true;
          await query('UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1', [f.id, JSON.stringify(replacement)]);
        }
        return query(sql, args);
      });
      worker.adoptWarmWorker(f.id, `sv-worker-s${f.id}`);
      try {
        await assert.rejects(worker.execInWorker(f.id, { mode: 'build', branchName: f.branchName,
          prompt: 'No runner starts.', systemPrompt: 'Synthetic instructions.', model: 'claude-sonnet-5-5' }),
        e => e.code === 'durable_turn_persist_failed');
        assert.equal(replaced, true); assert.equal(dispatches.length, dispatched);
        assert.deepEqual((await query('SELECT active_turn FROM chat_sessions WHERE id = $1', [f.id])).rows[0].active_turn, replacement);
      } finally { worker._registryForgetForTests(f.id); }
    });
    await t.test('target capture cannot mutate a replacement physical attempt with the same logical id', async t => {
      const f = await fixture(); const turnId = randomUUID(); const turnUuid = randomUUID();
      const pending = { turnId, turnUuid, backend: 'codex_openrouter', phase: 'dispatch_pending',
        mode: 'build', journal: `/home/node/.claude/turn-${turnUuid}.log` };
      const replacement = { ...pending, turnUuid: randomUUID(), journal: '/home/node/.claude/turn-next-attempt.log' };
      await pool.query('UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1', [f.id, JSON.stringify(pending)]);
      const capture = publication.captureTarget;
      t.mock.method(publication, 'captureTarget', async (...args) => {
        await pool.query('UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1', [f.id, JSON.stringify(replacement)]);
        return capture(...args);
      });
      const dispatched = dispatches.length;
      worker.adoptWarmWorker(f.id, `sv-worker-s${f.id}`);
      try {
        await assert.rejects(worker.execInWorker(f.id, { mode: 'build', branchName: f.branchName,
          logicalTurnId: turnId, turnUuid, journalPath: pending.journal, prompt: 'No runner starts.',
          agentBackend: 'codex_openrouter', agentHarness: 'codex', agentModel: 'synthetic/model', openrouterApiKey: 'synthetic-key' }),
        e => e.code === 'durable_turn_persist_failed' && e.persistCode === 'session_changed');
        assert.equal(dispatches.length, dispatched);
        assert.deepEqual((await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [f.id])).rows[0].active_turn, replacement);
      } finally { worker._registryForgetForTests(f.id); }
    });
    await t.test('a branch mismatch ends both live and replay progress as failed, with no publication', async () => {
      const f = await fixture(); const prior = publishes;
      await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [f.id]);
      worker.adoptWarmWorker(f.id, `sv-worker-s${f.id}`);
      journalText = '__USERNODE_RESULT__ cc_exit=0 ahead=0 sha= push_ok=0 branch_mismatch=1 mode=build\n__USERNODE_EXIT__ 0\n';
      const progress = [];
      const result = await worker.execInWorker(f.id, { mode: 'build', branchName: f.branchName,
        prompt: 'Synthetic mismatch', systemPrompt: 'Synthetic build instructions.', model: 'claude-sonnet-5-5',
        holdTurnRecord: true, onProgress: p => progress.push(p) });
      assert.equal(result.branchMismatch, true); assert.equal(progress.at(-1), '[push_failed]');
      const { rows: [row] } = await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [f.id]);
      progress.length = 0;
      await worker.resumeTurnFromJournal(f.id, { mode: 'build', branchName: f.branchName,
        journal: row.active_turn.journal, turnId: row.active_turn.turnId, onProgress: p => progress.push(p) });
      assert.equal(progress.at(-1), '[push_failed]'); assert.equal(publishes, prior);
      await worker.finishTurn(f.id, { turnId: row.active_turn.turnId }); worker._registryForgetForTests(f.id);
    });
    for (const [backend, harness, mode] of [['claude_code', null, 'build'], ['codex_openrouter', 'codex', 'build'],
      ['codex_openrouter', 'claude', 'build'], ['claude_code', null, 'sync']]) {
      for (const legacyPush of [false, true]) await t.test(`${backend}/${harness}/${mode}, legacy push_ok=${legacyPush}`, async () => {
        const f = await fixture(mode);
        await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [f.id]);
        worker.adoptWarmWorker(f.id, `sv-worker-s${f.id}`);
        let reset = null;
        if (mode === 'build') {
          await pool.query(`UPDATE chat_sessions SET agent_backend = $2, cc_session_id = 'old-claude-thread',
            agent_thread_id = 'old-openrouter-thread', agent_model = 'old/model' WHERE id = $1`, [f.id, backend]);
          const { switchSessionAgent } = require('../src/routes/sessions');
          reset = await switchSessionAgent(pool, { sessionId: f.id, userId: f.target.userId,
            pref: { backend, provider: backend === 'claude_code' ? 'anthropic' : 'openrouter', model: backend === 'claude_code' ? 'claude-sonnet-5-5' : 'new/model', reasoningEffort: null } });
          assert.equal(reset.ok, true);
          assert.equal(reset.session.cc_session_id, null); assert.equal(reset.session.agent_thread_id, null);
          assert.equal(reset.session.agent_config_version, 2);
          assert.equal((await pool.query(`SELECT 1 FROM wf_events WHERE machine = 'worker-release'`)).rowCount, 0, 'reset never schedules eviction');
          if (backend === 'codex_openrouter') {
            const agent = require('../src/services/agent-turn');
            await assert.rejects(agent.startCodexAttempt({ pool, session: reset.session, userId: f.target.userId,
              logicalTurnId: randomUUID(), attemptNumber: 1, model: 'old/model', mode,
              runtimeContext: { agentConfigVersion: 1 } }), e => e.code === 'agent_context_changed');
          }
        }
        const prior = publishes; const dispatched = dispatches.length;
        journalText = `__USERNODE_RESULT__ cc_exit=0 ahead=${mode === 'sync' ? 0 : 1} sha=${SHA} push_ok=${legacyPush ? 1 : 0} mode=${mode}`
          + `${mode === 'sync' ? ' sync_result=clean' : ''}\n__USERNODE_EXIT__ 0\n`;
        const out = await worker.execInWorker(f.id, { mode, branchName: f.branchName, prompt: 'No paid model runs in this test.',
          model: reset ? reset.session.agent_model : 'claude-test', systemPrompt: backend === 'claude_code' ? 'A synthetic system prompt.' : null, agentBackend: backend, agentHarness: harness,
          agentModel: reset ? reset.session.agent_model : 'test/model', resumeSessionId: reset?.session.agent_thread_id || reset?.session.cc_session_id || null,
          openrouterApiKey: 'synthetic-provider-key', holdTurnRecord: true });
        assert.equal(out.pushOk, true); assert.equal(publishes, prior + 1); assert.equal(dispatches.length, dispatched + 1);
        if (reset) {
          assert.ok(dispatches.at(-1).includes(`export ${backend === 'claude_code' ? 'MODEL' : 'AGENT_MODEL'}='${reset.session.agent_model}'`));
          assert.ok(!dispatches.at(-1).includes('old-claude-thread') && !dispatches.at(-1).includes('old-openrouter-thread'));
          assert.match(dispatches.at(-1), /export (?:AGENT_THREAD_ID|CLAUDE_RESUME_SESSION_ID)=''/);
        }
        const { rows: [row] } = await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [f.id]);
        assert.equal(row.active_turn.tail.pushOk, true);
        worker._registryForgetForTests(f.id);
        const replay = await worker.resumeTurnFromJournal(f.id, { journal: row.active_turn.journal, turnId: row.active_turn.turnId,
          mode, branchName: f.branchName, agentBackend: backend, agentHarness: harness });
        assert.equal(replay.pushOk, true); assert.equal(publishes, prior + 1);
        assert.equal(dispatches.length, dispatched + 1, 'replay never dispatches the runner');
        assert.equal(await worker.finishTurn(f.id, { turnId: row.active_turn.turnId }), true);
        worker._registryForgetForTests(f.id);
      });
    }
    await t.test('a reset keeps saved work and a failed rescue prevents every reused-worker harness from starting', async t => {
      t.mock.method(github, 'getInstallationToken', async () => null);
      for (const harness of ['codex', 'claude']) {
        const f = await fixture(); const count = dispatches.length;
        await pool.query(`UPDATE chat_sessions SET active_turn = NULL, agent_backend = 'codex_openrouter',
          cc_session_id = 'old', agent_thread_id = 'old' WHERE id = $1`, [f.id]);
        assert.equal(await require('../src/services/worker-unpushed-commit').record(pool, f.id, { sha: SHA, branchName: f.branchName }), true);
        worker.adoptWarmWorker(f.id, `sv-worker-s${f.id}`);
        const reset = await require('../src/routes/sessions').switchSessionAgent(pool, { sessionId: f.id, userId: f.target.userId,
          pref: { backend: 'codex_openrouter', provider: 'openrouter', model: 'new/model', reasoningEffort: null } });
        assert.equal(reset.ok, true); assert.equal(await f.saved(), SHA);
        await assert.rejects(worker.execInWorker(f.id, { mode: 'build', branchName: f.branchName, prompt: 'not dispatched',
          agentBackend: 'codex_openrouter', agentHarness: harness, agentModel: 'new/model', openrouterApiKey: 'synthetic-key' }),
        e => e.unpushedCommit && e.code === 'no_token' && e.permanent);
        assert.equal(dispatches.length, count); assert.equal(await f.saved(), SHA);
        assert.equal((await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [f.id])).rows[0].active_turn, null);
        worker._registryForgetForTests(f.id);
      }
    });
  });
});
