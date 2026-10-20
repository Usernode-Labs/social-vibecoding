'use strict';

// #3654: a platform redeploy restarts the server, not the worker, so a
// benchmark trial's turn is often still running when the new server comes
// up. A trial runs as a durable build of the workflow kernel
// (services/build-runs.js, docs/plans/bot-build-workflow.md), and nothing in
// restart recovery finishes it any more:
//
//   * a durable trial's session carries the build that owns it
//     (chat_sessions.workflow_owner), and while that build is under way
//     restart recovery (server.js adoptOrphanWorker) leaves the session's
//     worker and its turn to it;
//   * the next attempt of the build follows the turn the restart caught
//     through its journal to its end (services/durable-turn.js), counts its
//     looks once and writes its transcript's lines once, and records the
//     trial once, charged once: no PR, no staging, no notification, no chat
//     row;
//   * a trial's worker no build holds any more (its build ended or failed)
//     has its turn abandoned and its session archived; the trial is its
//     build's to record (bot-build's build.lost), never put back here.
//
// server.js only boots when run as the entry point, so requiring it exposes
// adoptOrphanWorker without starting anything. The worker, the agent-turn
// ledger settlement and every outward call are stubbed; the database is a
// real one with the full schema.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { asTransition } = require('./lib/as-transition');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

// ── worker stub (restart recovery's) ───────────────────────────────────
const workerCalls = [];
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  usesKubernetesWorkers: () => false,
  resumeTurnFromJournal: async (sessionId) => { workerCalls.push(['resume', sessionId]); return {}; },
  stopTurn: async (sessionId) => { workerCalls.push(['stopTurn', sessionId]); return true; },
  clearPendingStop: () => {},
  finishTurn: async (sessionId) => { workerCalls.push(['finishTurn', sessionId]); return true; },
  clearActiveTurn: async (sessionId) => { workerCalls.push(['clearActiveTurn', sessionId]); return true; },
  markTurnTail: async () => true,
  noteTailMilestone: async () => true,
  adoptWarmWorker: (sessionId) => { workerCalls.push(['adoptWarmWorker', sessionId]); },
  destroyWorker: async (name) => { workerCalls.push(['destroyWorker', name]); },
  evictWorker: async (id) => { workerCalls.push(['evictWorker', id]); },
  isWorkerExecuting: async () => false,
  getTurnByokCents: () => 0,
  getActiveTurnMode: () => null,
  workerContainerName: (id) => `usernode-worker-${id}`,
};

const wsPath = require.resolve('../src/services/ws');
const realWs = require(wsPath);
require.cache[wsPath].exports = { ...realWs, broadcastGlobal: () => {}, pushNotificationToUser: () => 0, pushToUser: () => 0 };

const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...a) => { const t = origSetInterval(...a); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...a) => { const t = origSetTimeout(...a); if (t && t.unref) t.unref(); return t; };
let adoptOrphanWorker;
try {
  ({ adoptOrphanWorker } = require('../server'));
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

const lane = require('../src/services/bench/lane');
const suites = require('../src/services/bench/suites');
const studio = require('../src/services/bench/studio');
const snapshots = require('../src/services/homeroom-bot-snapshots');
const durableSteps = require('../src/services/durable-steps');
const agentTurn = require('../src/services/agent-turn');
const prMetadata = require('../src/services/pr-metadata');
const notifications = require('../src/services/notifications');
const githubModule = require('../src/services/github');
const managedKeys = require('../src/services/openrouter-managed-keys');
const limits = require('../src/services/limits');

// What would leave the benchmark, spied: none of it may be called.
const outward = [];
prMetadata.applyPrMetadata = async () => { outward.push('applyPrMetadata'); return {}; };
for (const name of ['createSessionDoneNotification', 'createSessionStalledNotification', 'hydrateAndPush']) {
  notifications[name] = async () => { outward.push(name); return []; };
}
for (const name of ['createPR', 'createIssueComment', 'updatePR', 'mergePR']) {
  githubModule[name] = async () => { outward.push(`github.${name}`); return null; };
}
const staging = { async buildAndDeployStaging() { outward.push('staging'); return {}; } };
agentTurn.completeCodexAttempt = async () => {};
const debits = [];
managedKeys.usesIncludedKey = async () => true;
limits.recordSpend = async (_p, userId, cents) => { debits.push(cents); };

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const BASE = 'a'.repeat(40);
const VERDICT = '```json\n{"verdict":"ready","build_note":"Pin the markers.","reason":"clear"}\n```';

test('benchmark trials across a restart, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bench_recover_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  // A trial's session takes its slot, rests and is closed through the
  // proposal machine (session-lifecycle's takeSlot, restSession and
  // closeOwnSession): the workflow runtime runs here, on this database, its
  // pipeline only (no timers, no work).
  const platform = require('../src/workflow/platform.ts');
  require('../src/db/pool').getPool = () => pool;
  t.after(async () => {
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await platform.startWorkflow({ databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2 }, { loops: false });

  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, status, repo_url) VALUES ('Todo', 'todo', 'running', 'https://github.com/o/todo') RETURNING id",
  );
  const { rows: [user] } = await pool.query(
    "INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bench', 'x', TRUE) RETURNING id, username",
  );
  const { suite } = await suites.createSuite(pool, { name: 'recover' });
  for (let i = 1; i <= 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { rows: [r] } = await pool.query(
      "INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, $2, 'shadow', 'ready') RETURNING id", [app.id, i],
    );
    for (const stage of ['triage', 'build']) {
      // eslint-disable-next-line no-await-in-loop
      await snapshots.recordSnapshot(pool, { runId: r.id, stage, appId: app.id, issueNumber: i, baseSha: BASE, texts: { seed: `s${i}`, prompt: `p${i}` } });
      // eslint-disable-next-line no-await-in-loop
      await suites.addTaskFromRun(pool, { suiteId: suite.id, runId: r.id, stage });
    }
  }

  const turnOf = (mode, extra = {}) => ({
    turnId: `turn-${crypto.randomUUID()}`, journal: '/journals/t.log', mode, phase: 'executing',
    backend: 'codex_openrouter', model: 'z-ai/glm-5.3-flash', startedAt: new Date().toISOString(), attemptNumber: 1, ...extra,
  });
  const newSession = async (activeTurn, { status = 'active', owner = null } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, is_headless, linked_issues, session_title,
                                agent_backend, agent_provider, agent_model, active_turn, workflow_owner)
     VALUES ($1, $2, $4, FALSE, '{}', 'bench', 'codex_openrouter', 'openrouter', 'z-ai/glm-5.3-flash', $3::jsonb, $5)
     RETURNING id`,
    [app.id, user.id, activeTurn ? JSON.stringify(activeTurn) : null, status, owner],
  )).rows[0].id;
  const spend = (sessionId, usd) => pool.query(
    `INSERT INTO agent_turns (id, session_id, user_id, backend, status, estimated_cost_usd, routed_model)
     VALUES ($1, $2, $3, 'codex_openrouter', 'completed', $4, 'z-ai/glm-5.3-flash')`,
    [crypto.randomUUID(), sessionId, user.id, usd],
  );
  const launch = async (stages) => {
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages, repeats: 1 });
    const { rows } = await pool.query(
      `SELECT tr.id, tr.run_id, t.stage FROM bench_trials tr JOIN bench_tasks t ON t.id = tr.task_id
        WHERE tr.run_id = $1 ORDER BY tr.id`, [run.id],
    );
    return { run, trials: rows };
  };
  // A claim as the bench lane's transition writes it (only it may).
  const claimAs = (trialId, sessionId, { claims = 1 } = {}) => asTransition(pool,
    `UPDATE bench_trials SET status = 'running', claims = $2, started_at = NOW() - INTERVAL '3 minutes',
            session_id = $3, base_sha = $4, build_branch = 'bench/r' || run_id || '-t' || id
      WHERE id = $1`,
    [trialId, claims, sessionId, BASE],
  );
  const trialRow = async (id) => (await pool.query(
    `SELECT status, error, claims, parsed, cost_usd::float8 AS cost, interrupted_cost_usd::float8 AS interrupted,
            session_id, checkpoint, recovered_at
       FROM bench_trials WHERE id = $1`, [id],
  )).rows[0];
  const sessionRow = async (id) => (await pool.query('SELECT status, active_turn FROM chat_sessions WHERE id = $1', [id])).rows[0];
  const chatRows = async (id) => Number((await pool.query(
    'SELECT COUNT(*) AS n FROM chat_session_messages WHERE session_id = $1', [id],
  )).rows[0].n);
  const spent = async (runId) => (await pool.query('SELECT spent_usd::float8 AS s FROM bench_runs WHERE id = $1', [runId])).rows[0].s;
  const adopt = (sessionId, state = 'running') => adoptOrphanWorker(
    { name: `usernode-worker-${sessionId}`, sessionId, state },
    { config: {}, pool, staging, ghub: githubModule, broadcastGlobal: () => {} },
  );
  // An instance is the kernel's to write (wf_require_writer): written here
  // as its transition pipeline writes one.
  const asKernel = (sql) => pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'; ${sql}; COMMIT`);
  const reset = () => {
    workerCalls.length = 0; outward.length = 0; debits.length = 0;
  };

  await t.test('a durable trial\'s worker and turn are left to the build that owns it; once that build is over, the turn is an orphan\'s', async () => {
    reset();
    const { trials: [trial] } = await launch(['triage']);
    const key = `trial:${trial.id}@c1.x`;
    const turn = turnOf('scout');
    const sid = await newSession(turn, { owner: `bot-build/${key}` });
    await claimAs(trial.id, sid);
    await asKernel(`INSERT INTO wf_instances (machine, key, state, machine_version) VALUES ('bot-build', '${key}', 'building', 1)`);
    await adopt(sid);
    assert.deepEqual(workerCalls, [['adoptWarmWorker', sid]], 'its worker registered, and nothing else done to it');
    assert.equal((await trialRow(trial.id)).status, 'running', 'its build carries it on');
    const session = await sessionRow(sid);
    assert.equal(session.status, 'active');
    assert.equal(session.active_turn.turnId, turn.turnId, 'its turn record kept, for the build to follow');
    assert.deepEqual(outward, []);

    // A build that is over owns nothing: what it left is abandoned as any
    // orphan's is. The trial is its build's to record (build.lost), never
    // put back here: a second run of it would pay twice.
    reset();
    await asKernel(`UPDATE wf_instances SET state = 'failed' WHERE machine = 'bot-build' AND key = '${key}'`);
    await adopt(sid);
    assert.deepEqual(workerCalls.map((c) => c[0]), ['adoptWarmWorker', 'stopTurn', 'finishTurn', 'destroyWorker'],
      'its turn stopped and its record cleared, then its worker removed');
    assert.equal((await sessionRow(sid)).status, 'archived');
    assert.equal((await trialRow(trial.id)).status, 'running', 'left to its build\'s record');
    assert.deepEqual(outward, []);
  });

  await t.test('a durable triage trial a restart caught mid-turn: the next attempt follows the turn to its end, its looks and lines once, and records the trial once', async () => {
    reset();
    const { run, trials: [trial] } = await launch(['triage']);
    await asTransition(pool, "UPDATE bench_trials SET status = 'running', claims = 1, started_at = NOW() WHERE id = $1", [trial.id]);
    const branch = `bench/r${run.id}-t${trial.id}`;
    const gh = { pinned: [], deleted: [] };
    const github = {
      isEnabled: () => true,
      async getBranchSha() { return BASE; },
      async ensureBranchAtSha(_o, _r, b, sha) { gh.pinned.push({ branch: b, sha }); },
      async deleteBenchBranch(_o, _r, b) { gh.deleted.push(b); return true; },
    };
    const graded = [];
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const record = { turnId: 'turn-triage', journal: '/journals/triage.log' };
    const before = ['Using browser_navigate', 'Using browser_take_screenshot'];
    const after = ['Using browser_take_screenshot', 'Using browser_navigate'];
    const calls = [];
    const fakeWorker = {
      async ensureWorkerImage() {},
      async ensureWorker(id, opts) { calls.push(['ensure', Number(id), opts.pinnedBase]); return `w-${id}`; },
      async stopTurn() {},
      clearPendingStop() {},
      async evictWorker() {},
    };
    const deps = (worker, agentTurnDeps) => ({
      user, worker, github, limits, managedOpenRouter: managedKeys, afterTrial: async (_p, id) => { graded.push(id); },
      activeWorkers: new Set(),
      sessions: {
        async runCodexAttemptLoop(args) {
          await args.resolveRuntime();
          return { result: await args.dispatchOnce({}), error: null, estimatedCostUsd: 0.42 };
        },
      },
      agentTurn: { async resolveCodexRuntimeContext() { return {}; }, ...agentTurnDeps },
    });

    // The first attempt: its triage turn is dispatched, its worker writes the
    // turn's record and the turn's first lines come through, and the
    // platform stops while the turn runs on.
    const saves = [];
    const stop = new AbortController();
    const first = durableSteps.durable({ signal: stop.signal, owner: `bot-build/trial:${trial.id}@c1.x`, checkpoint: async (s) => { saves.push(s); } });
    const firstWorker = {
      ...fakeWorker,
      async execInWorker(sessionId, opts) {
        calls.push(['dispatch', Number(sessionId)]);
        await pool.query('UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1', [Number(sessionId), JSON.stringify({
          ...record, mode: 'scout', phase: 'executing', backend: 'codex_openrouter', model: 'z-ai/glm-5.3-flash', startedAt, attemptNumber: 1,
        })]);
        for (const line of before) opts.onProgress(line);
        await opts.onTurnRecord(record);
        stop.abort();
        return new Promise(() => {});
      },
    };
    await assert.rejects(lane.runTrial({ pool, config: {}, id: trial.id, steps: first, deps: deps(firstWorker) }), { code: 'steps_stopped' },
      'a stop is not the trial\'s failure: its next attempt carries it on');
    const kept = saves.at(-1);
    const sid = kept['session:triage'].id;
    assert.deepEqual(kept['turn:triage'].record, record, 'the turn\'s record, kept as it was written');
    assert.equal((await trialRow(trial.id)).status, 'running', 'nothing recorded yet');
    assert.equal((await trialRow(trial.id)).session_id, sid, 'its session on its row before its turn ran');
    const { rows: [{ workflow_owner: owner }] } = await pool.query('SELECT workflow_owner FROM chat_sessions WHERE id = $1', [sid]);
    assert.equal(owner, `bot-build/trial:${trial.id}@c1.x`, 'the session carries the build that owns it');
    // What the turn spent, as its ledger has it.
    await spend(sid, 0.42);

    // The next attempt: the worker the restart left running, with the turn in
    // it, followed through its journal from its start.
    const followed = [];
    const nextWorker = {
      ...fakeWorker,
      async execInWorker() { throw new Error('the turn is not dispatched again'); },
      workerRuntimeName: (id) => `w-${id}`,
      async getWorkerStatus() { return 'running'; },
      adoptWarmWorker(id, n) { followed.push(['adopt', n]); },
      async resumeTurnFromJournal(id, opts) {
        followed.push(['resume', Number(id), opts.journal]);
        for (const line of [...before, ...after]) opts.onProgress(line);
        return { lastResultText: VERDICT, exitCode: 0, resultSeen: true, providerDispatched: true };
      },
      async markTurnTail() { return true; },
      async finishTurn(id, ids) {
        followed.push(['finish', Number(id), ids.turnId]);
        await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [Number(id)]);
        return true;
      },
    };
    const next = durableSteps.durable({ resumeFrom: kept, lostAttempts: 1, owner: `bot-build/trial:${trial.id}@c1.x`, checkpoint: async (s) => { saves.push(s); } });
    const out = await lane.runTrial({
      pool, config: {}, id: trial.id, steps: next,
      deps: deps(nextWorker, {
        async persistRecoveredAgentThread() {},
        async settleRecoveredAgentAttempt() { return { estimatedCost: { estimatedCostUsd: 0.42 } }; },
      }),
    });
    assert.deepEqual(out, { status: 'ok' });
    assert.deepEqual(followed, [['adopt', `w-${sid}`], ['resume', sid, record.journal], ['finish', sid, record.turnId]],
      'followed to its end in the worker the restart left, its record released only then');
    assert.deepEqual(calls.filter((c) => c[0] === 'dispatch'), [['dispatch', sid]], 'dispatched once, by the first attempt');
    assert.deepEqual(gh.pinned, [{ branch, sha: BASE }], 'its branch cut once, by the first attempt');

    const row = await trialRow(trial.id);
    assert.equal(row.status, 'ok');
    assert.equal(row.parsed.verdict, 'ready', 'read as the live stage reads it');
    assert.deepEqual(row.parsed.sight, { told: null, passed: null, screenshots: 2, snapshots: 0, navigations: 2 },
      'every look its turn took, none twice');
    assert.equal(row.cost, 0.42, 'its cost from its session\'s ledger');
    assert.equal(await spent(run.id), 0.42, 'charged to its run once');
    assert.deepEqual(debits, [42]);
    assert.deepEqual(row.checkpoint, { handBacks: 1 }, 'how often a restart carried it on, which the studio shows');
    assert.ok(row.recovered_at);
    assert.deepEqual(graded, [trial.id], 'graded once, as any trial');
    assert.deepEqual(gh.deleted, [branch], 'its empty branch removed');
    assert.equal((await sessionRow(sid)).status, 'archived');
    assert.deepEqual(outward, [], 'no PR, staging or notification');
    assert.equal(await chatRows(sid), 0, 'no completion card, breadcrumb or wrap-up row');

    // Its transcript: the lines it had before the restart, then the replay's
    // new ones, marked so.
    const { rows: lines } = await pool.query('SELECT line, replayed FROM bench_trial_lines WHERE trial_id = $1 ORDER BY id', [trial.id]);
    assert.deepEqual(lines.map((l) => [l.line, l.replayed]), [...before.map((l) => [l, false]), ...after.map((l) => [l, true])],
      'none of the turn\'s lines twice, none lost');
    const timeline = await studio.timelineOf(pool, trial.id);
    assert.deepEqual(timeline.map((e) => [e.lines, e.replayed]), [[4, 2]]);

    // And an attempt after that one returns what was recorded, doing nothing.
    const again = durableSteps.durable({ resumeFrom: saves.at(-1), lostAttempts: 2, checkpoint: async () => {} });
    assert.deepEqual(await lane.runTrial({ pool, config: {}, id: trial.id, steps: again, deps: deps(fakeWorker) }), { status: 'ok' });
    assert.equal(await spent(run.id), 0.42);
    assert.deepEqual(graded, [trial.id]);
  });

  await t.test('a trial\'s transcript is paged in id order, as numbers', async () => {
    const { rows: [trial] } = await pool.query('SELECT id FROM bench_trials ORDER BY id LIMIT 1');
    await pool.query(
      `INSERT INTO bench_trial_lines (trial_id, at, step, kind, line) VALUES
         ($1, NOW() - INTERVAL '1 hour', 'build', 'step', 'build'),
         ($1, NOW(), 'build', 'line', 'Using browser_navigate'),
         ($1, NOW(), 'build', 'line', 'Using browser_take_screenshot')`,
      [trial.id],
    );
    const page = await studio.transcriptOf(pool, trial.id, { limit: 2 });
    assert.equal(page.total, 3);
    assert.equal(page.lines.length, 2);
    const rest = await studio.transcriptOf(pool, trial.id, { after: page.next });
    assert.equal(rest.lines.length, 1);
    assert.equal(rest.next, null, 'the end');
    assert.equal((await studio.transcriptOf(pool, trial.id, { step: 'triage' })).lines.length, 0, 'one step\'s lines only');
    // Run 190's transcripts, ordered as text, put 1000 before 999 and a
    // cursor skipped the lines between.
    await pool.query(`INSERT INTO bench_trial_lines (id, trial_id, at, step, kind, line) VALUES
      (9999, $1, NOW(), 'build', 'line', 'a'), (10000, $1, NOW(), 'build', 'line', 'b'), (100000, $1, NOW(), 'build', 'line', 'c')`, [trial.id]);
    const seen = [];
    let after = null;
    do {
      // eslint-disable-next-line no-await-in-loop
      const p = await studio.transcriptOf(pool, trial.id, { limit: 2, after });
      seen.push(...p.lines.map((l) => l.id));
      after = p.next;
    } while (after);
    assert.equal(seen.length, 6, 'every line, none skipped');
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
    assert.deepEqual(seen.slice(-3), [9999, 10000, 100000]);
  });
});
