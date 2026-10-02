'use strict';

// #3654: a platform redeploy restarts the server, not the worker, so a
// benchmark trial's turn is often still running when the new server comes
// up. Restart recovery used to abandon every one and leave the trial
// `running` for an hour and a half before the lane ran it again. Now:
//
//   * a turn that is the trial's last (a triage, a follow-up, a checks fix,
//     a build's build turn) is followed to its end through the same journal
//     machinery as any recovered turn, and the trial is recorded by the
//     lane's shared finisher, holding its lane slot meanwhile: no PR, no
//     staging, no notification, no chat row;
//   * any other (a build's spec turn) is abandoned and the trial put back in
//     the queue at once, what it spent charged; after a second interruption
//     it fails;
//   * a recovery that cannot finish the trial puts it back in the queue.
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

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

// ── worker stub ─────────────────────────────────────────────────────────
let journalTail = async () => ({});
let stopped = null;
const workerCalls = [];
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  usesKubernetesWorkers: () => false,
  resumeTurnFromJournal: async (sessionId, opts) => {
    workerCalls.push(['resume', sessionId]);
    return journalTail(sessionId, opts);
  },
  stopTurn: async (sessionId) => { workerCalls.push(['stopTurn', sessionId]); stopped?.(); return true; },
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
const graders = require('../src/services/bench/graders');
const snapshots = require('../src/services/homeroom-bot-snapshots');
const agentTurn = require('../src/services/agent-turn');
const sessionsRoutes = require('../src/routes/sessions');
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
// Reads and the trial's own branch: recorded.
const gh = { compared: [], deleted: [] };
githubModule.compareFiles = async (o, r, range) => {
  gh.compared.push(range);
  return { files: [{ filename: 'app.js', status: 'modified' }], diff: 'diff --git a/app.js b/app.js\n+x', complete: true, truncated: false };
};
githubModule.deleteBenchBranch = async (o, r, branch) => { gh.deleted.push(branch); return true; };
const graded = [];
graders.gradeTrial = async (_pool, id) => { graded.push(id); };
agentTurn.persistRecoveredAgentThread = async () => {};
agentTurn.settleRecoveredAgentAttempt = async () => null;
agentTurn.completeCodexAttempt = async () => {};
sessionsRoutes.resumeRecoveredCodexFreshRetry = async () => null;
const debits = [];
managedKeys.usesIncludedKey = async () => true;
limits.recordSpend = async (_p, userId, cents) => { debits.push(cents); };

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const BASE = 'a'.repeat(40);
const VERDICT = '```json\n{"verdict":"ready","build_note":"Pin the markers.","reason":"clear"}\n```';

test('restart recovery of benchmark trials, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
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
  t.after(async () => {
    lane._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, status, repo_url) VALUES ('Todo', 'todo', 'running', 'https://github.com/o/todo') RETURNING id",
  );
  const { rows: [user] } = await pool.query(
    "INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bench', 'x', TRUE) RETURNING id",
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
  const newSession = async (activeTurn, { specMd = '' } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, is_headless, linked_issues, session_title,
                                agent_backend, agent_provider, agent_model, active_turn, spec_md)
     VALUES ($1, $2, 'active', FALSE, '{}', 'bench', 'codex_openrouter', 'openrouter', 'z-ai/glm-5.3-flash', $3::jsonb, $4)
     RETURNING id`,
    [app.id, user.id, activeTurn ? JSON.stringify(activeTurn) : null, specMd],
  )).rows[0].id;
  const spend = (sessionId, usd) => pool.query(
    `INSERT INTO agent_turns (id, session_id, user_id, backend, status, estimated_cost_usd, routed_model)
     VALUES ($1, $2, $3, 'codex_openrouter', 'completed', $4, 'z-ai/glm-5.3-flash')`,
    [crypto.randomUUID(), sessionId, user.id, usd],
  );
  const launch = async (stages) => {
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages, repeats: 1 });
    const { rows } = await pool.query(
      `SELECT tr.id, t.stage FROM bench_trials tr JOIN bench_tasks t ON t.id = tr.task_id
        WHERE tr.run_id = $1 ORDER BY tr.id`, [run.id],
    );
    return { run, trials: rows };
  };
  const claimAs = (trialId, sessionId, { claims = 1, baseSha = BASE } = {}) => pool.query(
    `UPDATE bench_trials SET status = 'running', claims = $2, started_at = NOW() - INTERVAL '3 minutes',
            session_id = $3, base_sha = $4, build_branch = 'bench/r' || run_id || '-t' || id
      WHERE id = $1`,
    [trialId, claims, sessionId, baseSha],
  );
  const trialRow = async (id) => (await pool.query(
    `SELECT status, error, parsed, cost_usd::float8 AS cost, interrupted_cost_usd::float8 AS interrupted,
            recovered_at, build_commits, diff, session_id
       FROM bench_trials WHERE id = $1`, [id],
  )).rows[0];
  const sessionRow = async (id) => (await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [id])).rows[0];
  const chatRows = async (id) => Number((await pool.query(
    'SELECT COUNT(*) AS n FROM chat_session_messages WHERE session_id = $1', [id],
  )).rows[0].n);
  const spent = async (runId) => (await pool.query('SELECT spent_usd::float8 AS s FROM bench_runs WHERE id = $1', [runId])).rows[0].s;
  const adopt = (sessionId, state = 'running') => adoptOrphanWorker(
    { name: `usernode-worker-${sessionId}`, sessionId, state },
    { config: {}, pool, staging, ghub: githubModule, broadcastGlobal: () => {} },
  );
  const reset = () => {
    workerCalls.length = 0; outward.length = 0; graded.length = 0; debits.length = 0;
    gh.compared.length = 0; gh.deleted.length = 0;
    journalTail = async () => ({});
    stopped = null;
    lane._resetForTests();
  };

  await t.test('a triage turn still running is followed to its end and recorded, holding its slot, with nothing said anywhere', async () => {
    reset();
    const { run, trials } = await launch(['triage']);
    const trial = trials[0];
    const sid = await newSession(turnOf('scout'));
    await claimAs(trial.id, sid);
    await spend(sid, 0.42);
    let heldDuring = null;
    journalTail = async () => {
      heldDuring = lane._inFlightForTests().get(trial.id) || null;
      return { lastResultText: VERDICT, exitCode: 0, resultSeen: true };
    };
    await adopt(sid);

    assert.deepEqual(workerCalls.map((c) => c[0]), ['adoptWarmWorker', 'resume', 'finishTurn', 'destroyWorker'],
      'followed, its turn record cleared, then its worker removed');
    assert.equal(heldDuring?.runId, run.id, 'the trial held a lane slot while recovery followed it');
    assert.equal(heldDuring?.sessionId, sid);
    assert.equal(lane._inFlightForTests().has(trial.id), false, 'and let it go after');
    const row = await trialRow(trial.id);
    assert.equal(row.status, 'ok');
    assert.equal(row.parsed.verdict, 'ready');
    assert.equal(row.cost, 0.42);
    assert.ok(row.recovered_at);
    assert.equal(await spent(run.id), 0.42);
    assert.deepEqual(debits, [42]);
    assert.deepEqual(graded, [trial.id]);
    assert.equal((await sessionRow(sid)).status, 'archived');
    assert.deepEqual(outward, [], 'no PR, staging or notification');
    assert.equal(await chatRows(sid), 0, 'no completion card, breadcrumb or wrap-up row');
  });

  await t.test('a build turn still running is finished with its diff; the branch with its commits is kept', async () => {
    reset();
    const { trials } = await launch(['build']);
    const trial = trials[0];
    const sid = await newSession(turnOf('build'), { specMd: '# Pin the markers' });
    await claimAs(trial.id, sid);
    await spend(sid, 0.6);
    journalTail = async () => ({ pushOk: true, ahead: 3, sha: 'c'.repeat(40), exitCode: 0 });
    await adopt(sid);
    const row = await trialRow(trial.id);
    assert.equal(row.status, 'ok');
    assert.equal(row.build_commits, 3);
    assert.match(row.diff, /app\.js/);
    assert.equal(row.parsed.spec, '# Pin the markers');
    assert.equal(gh.compared.length, 1);
    assert.deepEqual(gh.deleted, []);
    assert.deepEqual(outward, []);
    assert.equal(await chatRows(sid), 0);
  });

  await t.test('the trial\'s own clock ends a recovered turn that runs past it', async () => {
    reset();
    const { trials } = await launch(['triage']);
    const trial = trials[0];
    const sid = await newSession(turnOf('scout', { startedAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString() }));
    await claimAs(trial.id, sid);
    journalTail = () => new Promise((resolve) => { stopped = () => resolve({ lastResultText: '', exitCode: 143 }); });
    await adopt(sid);
    assert.ok(workerCalls.some((c) => c[0] === 'stopTurn'), 'stopped on the trial\'s clock');
    const row = await trialRow(trial.id);
    assert.equal(row.status, 'timeout');
    assert.deepEqual(outward, []);
  });

  await t.test('a build\'s spec turn is abandoned and the trial is back in the queue at once, its spend charged', async () => {
    reset();
    const { run, trials } = await launch(['build']);
    const trial = trials[0];
    const sid = await newSession(turnOf('scout'));
    await claimAs(trial.id, sid);
    await spend(sid, 0.15);
    await adopt(sid);
    assert.deepEqual(workerCalls.map((c) => c[0]), ['adoptWarmWorker', 'stopTurn', 'finishTurn', 'destroyWorker'],
      'stopped and abandoned, never followed');
    const row = await trialRow(trial.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.session_id, null);
    assert.equal(row.interrupted, 0.15);
    assert.equal(await spent(run.id), 0.15);
    assert.deepEqual(debits, [15]);
    assert.equal((await sessionRow(sid)).status, 'archived');
    assert.deepEqual(outward, []);
  });

  await t.test('a trial interrupted a second time fails; one whose worker had already exited is released too', async () => {
    reset();
    const { trials } = await launch(['build']);
    const [twice, exited] = trials;
    const s1 = await newSession(turnOf('scout'));
    await claimAs(twice.id, s1, { claims: 2 });
    await adopt(s1);
    const row = await trialRow(twice.id);
    assert.equal(row.status, 'infra_fail');
    assert.match(row.error, /restarted during it twice/);

    const s2 = await newSession(turnOf('build'));
    await claimAs(exited.id, s2);
    await adopt(s2, 'exited');
    assert.equal(workerCalls.filter((c) => c[0] === 'resume').length, 0, 'an exited worker is not followed');
    assert.equal((await trialRow(exited.id)).status, 'pending');
  });

  await t.test('a recovery that cannot finish the trial puts it back in the queue', async () => {
    reset();
    const { trials } = await launch(['triage', 'build']);
    const tri = trials.find((x) => x.stage === 'triage');
    const build = trials.find((x) => x.stage === 'build');

    // The journal replay fails.
    const s1 = await newSession(turnOf('scout'));
    await claimAs(tri.id, s1);
    journalTail = async () => { throw new Error('journal unreadable'); };
    await adopt(s1);
    assert.equal((await trialRow(tri.id)).status, 'pending');
    assert.ok(workerCalls.some((c) => c[0] === 'finishTurn'));

    // The finish fails: a build with no base on record cannot be diffed.
    const s2 = await newSession(turnOf('build'));
    await claimAs(build.id, s2, { baseSha: null });
    journalTail = async () => ({ pushOk: true, ahead: 1, sha: 'd'.repeat(40), exitCode: 0 });
    await adopt(s2);
    assert.equal((await trialRow(build.id)).status, 'pending');
    assert.deepEqual(graded, []);
    assert.deepEqual(outward, [], 'no stalled notification either');
    assert.equal(await chatRows(s1) + await chatRows(s2), 0);
  });
});
