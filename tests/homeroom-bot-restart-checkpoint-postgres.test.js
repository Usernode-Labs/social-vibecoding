'use strict';

// A restart BETWEEN two steps of a Homeroom bot build carries the build on
// from the step it was at (src/services/homeroom-bot-checkpoint.js), so a
// redeploy no longer has to wait for the bot (homeroom-bot-drain.js's
// deadline is 0 by default).
//
// The live path (buildOne → buildLive → buildAndPropose) runs for real
// against the FULL PostgreSQL schema, with a fake worker that writes real
// journals and reads them through the worker's own parser, as #4882's
// restart tests do. A build is "killed" at a step boundary: the step's
// checkpoint is written (or, for "before", not yet), then the build never
// goes on, and the process's memory is wiped (_resetForTests), as a
// SIGTERM with no wait leaves it. Recovery then runs as the next leader
// runs it: server.js's restart recovery (adoptOrphanWorker), or the sweep
// for builds left between steps (resumeStalledLiveBuilds), or the one for
// reviews a restart cut short (finishInterruptedReviews).
//
// Each must end where an uninterrupted build ends: ONE pull request, ONE
// proposal post (and one plan post), ONE debit, nothing triaged again, and
// no build turn run again for work that was already pushed.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
process.env.DATABASE_URL = process.env.DATABASE_URL || DSN;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbot-checkpoint-journals-'));

// ── the fake worker ─────────────────────────────────────────────────────
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);

/** A turn's journal as the worker's runner writes it (run-cc.sh). */
function journalLines({ said = 'Done.', threadId = 'thread-x', ahead = 0, sha = '', pushOk = 1 }) {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: threadId }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: said, session_id: threadId }),
    '__USERNODE_PHASE__ commit', '__USERNODE_PHASE__ push', `__USERNODE_PHASE__ ${pushOk ? 'done' : 'push_failed'}`,
    `__USERNODE_RESULT__ cc_exit=0 ahead=${ahead} behind=0 sha=${sha} push_ok=${pushOk} mode=build`,
    '__USERNODE_EXIT__ 0',
  ];
}

let journals = 0;
function writeJournal(opts) {
  journals += 1;
  const file = path.join(journalDir, `turn-${journals}.log`);
  fs.writeFileSync(file, `${journalLines(opts).join('\n')}\n`);
  return file;
}

/** Read a journal file as the worker reads one, through its own parser. */
function replay(file) {
  const state = realWorker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  state.agentHarness = 'claude';
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    state.rawStdout += `${line}\n`;
    realWorker.parseLine(line, () => {}, state);
  }
  return realWorker.finalizeHarnessResult(state);
}

const SHA = 'b'.repeat(40);
const SAID = 'Added the host column.\n==== DESCRIPTION ====\nEach meeting shows who hosts it.\n==== END DESCRIPTION ====';
// Every build turn the worker is asked to run, and what it ran.
const dispatches = [];
const fakeWorker = {
  ...realWorker,
  usesKubernetesWorkers: () => false,
  resumeTurnFromJournal: async (_sessionId, opts) => replay(opts.journal),
  execInWorker: async (sessionId, opts) => {
    dispatches.push({ sessionId, mode: opts.mode });
    return replay(writeJournal({ said: SAID, ahead: 1, sha: SHA, pushOk: 1 }));
  },
  execPushFromWorker: async () => ({ sha: SHA }),
  ensureWorkerImage: async () => {},
  ensureWorker: async (sessionId) => `usernode-worker-${sessionId}`,
  clearPendingStop: () => {},
  getPendingStop: () => null,
  stopTurn: async () => true,
  finishTurn: async () => true,
  markTurnTail: async () => true,
  noteTailMilestone: async () => true,
  clearActiveTurn: async () => true,
  adoptWarmWorker: () => {},
  destroyWorker: async () => {},
  isWorkerExecuting: async () => true,
  getTurnByokCents: () => 0,
};
require.cache[workerPath].exports = fakeWorker;
const wsPath = require.resolve('../src/services/ws');
const realWs = require(wsPath);
require.cache[wsPath].exports = {
  ...realWs,
  broadcastGlobal: () => {},
  broadcastToSession: () => {},
  pushNotificationToUser: () => 0,
  pushToUser: () => 0,
  sendBotMessage: async () => null,
  sendSystemMessage: async () => null,
};

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

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const checkpoint = require('../src/services/homeroom-bot-checkpoint');
const github = require('../src/services/github');
const agentTurn = require('../src/services/agent-turn');
const sessionsRoutes = require('../src/routes/sessions');
const managedKeys = require('../src/services/openrouter-managed-keys');
const limits = require('../src/services/limits');

agentTurn.persistRecoveredAgentThread = async () => {};
agentTurn.settleRecoveredAgentAttempt = async () => null;
sessionsRoutes.resumeRecoveredCodexFreshRetry = async () => null;
// The bot pays from the platform's included key, so each build is debited.
managedKeys.usesIncludedKey = async () => true;
const spends = [];
// Set to hang the live path right after its debit: a restart there.
let hangAfterSpend = null;
limits.recordSpend = async (_pool, userId, cents) => {
  spends.push(cents);
  if (hangAfterSpend) { hangAfterSpend(); return new Promise(() => {}); }
  return null;
};

// ── killing a build at a step boundary ───────────────────────────────────
// The live path saves each step through checkpoint.save. Armed, the save of
// `step` (after it is written, or before with `before`) never returns: the
// build stops exactly there, as a process that exits would leave it.
const realSave = checkpoint.save;
let kill = null;
checkpoint.save = async (...args) => {
  const step = args[3];
  if (kill && kill.step === step && kill.before) { kill.reached(); return new Promise(() => {}); }
  const out = await realSave(...args);
  if (kill && kill.step === step) { kill.reached(); return new Promise(() => {}); }
  return out;
};
function armKill(step, { before = false } = {}) {
  return new Promise((resolve) => { kill = { step, before, reached: resolve }; });
}

const COST_USD = 0.5;
const COST_CENTS = 50;
const SPEC = '# Spec\n\n## User-facing changes\n\nShow who hosts each meeting.\n\n## Technical implementation\n\nA host column.';

test('a restart between two steps of a bot build carries it on from where it was', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_checkpoint_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const real = {
    post: live.post, mentionTargets: live.mentionTargets, botUsernameOf: live.botUsernameOf,
    promoteAsBot: live.promoteAsBot, postSpecOnProposal: live.postSpecOnProposal, advanceSeen: live.advanceSeen,
    fetchPublicIssue: github.fetchPublicIssue, fetchIssueComments: github.fetchIssueComments,
    runCodexAttemptLoop: sessionsRoutes.runCodexAttemptLoop,
  };
  t.after(async () => {
    Object.assign(live, {
      post: real.post, mentionTargets: real.mentionTargets, botUsernameOf: real.botUsernameOf,
      promoteAsBot: real.promoteAsBot, postSpecOnProposal: real.postSpecOnProposal, advanceSeen: real.advanceSeen,
    });
    github.fetchPublicIssue = real.fetchPublicIssue;
    github.fetchIssueComments = real.fetchIssueComments;
    sessionsRoutes.runCodexAttemptLoop = real.runCodexAttemptLoop;
    checkpoint.save = realSave;
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
    fs.rmSync(journalDir, { recursive: true, force: true });
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [botUser] } = await pool.query(
    "INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username",
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Page Turners', 'page-turners-30094f', 'running', $1)
     RETURNING id, slug, name, repo_url, self_hosted`,
    ['https://github.com/usernode-bot/page-turners-30094f'],
  );

  // What people see: every post (written to homeroom_bot_posts first, as
  // live.post writes it), and every pull request the promote route opens.
  const posts = [];
  live.post = async ({ pool: p, app: a, issueNumber, kind, runId }) => {
    await p.query('INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind) VALUES ($1, $2, $3, $4)', [a.id, issueNumber, runId, kind]);
    posts.push({ kind, runId });
    return { postId: posts.length };
  };
  live.mentionTargets = async () => [];
  live.botUsernameOf = async () => 'usernode-bot';
  live.postSpecOnProposal = async () => {};
  live.advanceSeen = async () => ({ advanced: true });
  github.fetchPublicIssue = async (_o, _r, n) => ({ issue: { number: n, title: `Request ${n}`, state: 'open' } });
  github.fetchIssueComments = async () => ({ comments: [] });

  // The promote route, as far as these tests need it: it promotes only an
  // active or paused session, and opens a pull request for its branch
  // unless one is open already (applyPrMetadata adopts that one).
  let prSeq = 100;
  const openPrs = new Map();
  const promoteCalls = [];
  const promote = async (sessionId) => {
    promoteCalls.push(Number(sessionId));
    const { rows: [s] } = await pool.query('SELECT status, branch_name, pr_number FROM chat_sessions WHERE id = $1', [sessionId]);
    if (!s || !['active', 'paused'].includes(s.status)) return { status: 409, body: { error: 'This change is not open to propose.' } };
    let pr = s.pr_number || openPrs.get(s.branch_name);
    if (!pr) { prSeq += 1; pr = prSeq; openPrs.set(s.branch_name, pr); }
    await pool.query("UPDATE chat_sessions SET status = 'promoted', pr_number = $2 WHERE id = $1", [sessionId, pr]);
    return { status: 200, body: { ok: true, prNumber: pr } };
  };
  live.promoteAsBot = ({ sessionId }) => promote(sessionId);
  const votesRouter = {
    handle(req, res) {
      promote(Number(String(req.url).match(/sessions\/(\d+)/)[1])).then((r) => res.status(r.status).json(r.body));
    },
  };

  // The build turn's runtime: one attempt, dispatched to the worker, on the
  // agent-turn ledger with its cost (which restart recovery reads).
  sessionsRoutes.runCodexAttemptLoop = async ({ session, dispatchOnce, resumeThreadId }) => {
    const result = await dispatchOnce({ agentHarness: 'claude', resumeSessionId: resumeThreadId });
    const logicalTurnId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO agent_turns (id, session_id, user_id, backend, status, estimated_cost_usd, logical_turn_id)
       VALUES ($1, $2, $3, 'codex_openrouter', 'completed', $4, $1)`,
      [logicalTurnId, session.id, botUser.id, COST_USD],
    );
    return { result, estimatedCostUsd: COST_USD, logicalTurnId };
  };

  const deps = {
    github: {
      isEnabled: () => true,
      fetchPublicIssue: (...a) => github.fetchPublicIssue(...a),
      fetchIssueComments: async () => ({ comments: [] }),
      getFileContent: async () => null,
      getBranchSha: async () => 'a'.repeat(40),
    },
    worker: fakeWorker,
    agentTurn,
    limits,
    managedOpenRouter: managedKeys,
    sessions: sessionsRoutes,
    activeWorkers: new Set(),
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
    sessionLifecycle: {
      async ensureSessionBranch({ pool: p, sessionId }) {
        const branchName = `dev/homeroom_bot-s${sessionId}`;
        await p.query('UPDATE chat_sessions SET branch_name = $2 WHERE id = $1', [sessionId, branchName]);
        return { branchName };
      },
    },
    domain: 'app.test',
    votesRouter,
    seesImages: false,
    dm: { async requesterOf() { return null; }, async noteBuildRestarted() {} },
  };

  // A later change waiting for its build, with the plan it builds from.
  const waitingRun = async (issueNumber) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, live_build_waiting_at, build_spec_md)
       VALUES ($1, $2, 'live', 'ready', 'Show who hosts each meeting.', NOW(), $3) RETURNING id`,
      [app.id, issueNumber, SPEC],
    );
    return r.id;
  };
  const runRow = async (id) => (await pool.query('SELECT * FROM homeroom_bot_runs WHERE id = $1', [id])).rows[0];
  const buildOne = async (runId) => bot.buildOne(pool, {}, {
    bot: botUser, app, run: await runRow(runId), settings: await bot.readSettings(pool), deps,
  });
  // Start a build and kill it at `step`; the next leader's memory is empty.
  const killedAt = async (runId, step, opts) => {
    const reached = armKill(step, opts);
    void buildOne(runId);
    await reached;
    kill = null;
    bot._resetForTests();
  };
  // The sweep runs once a step is older than any step that saves nothing.
  const sweepLater = async (runId) => {
    await pool.query(
      "UPDATE homeroom_bot_runs SET build_checkpoint = build_checkpoint || jsonb_build_object('at', NOW() - INTERVAL '11 minutes') WHERE id = $1",
      [runId],
    );
    const started = await bot.resumeStalledLiveBuilds(pool, {}, {});
    // Each runs on in the background, outside the loop's pass.
    await bot._awaitStalledResumesForTests();
    return started;
  };
  const recover = (sessionId, state = 'running') => adoptOrphanWorker(
    { name: `usernode-worker-${sessionId}`, sessionId, state },
    { config: {}, pool, staging: {}, ghub: {}, broadcastGlobal: () => {} },
  );
  const reset = () => {
    posts.length = 0; promoteCalls.length = 0; dispatches.length = 0; spends.length = 0; openPrs.clear();
    hangAfterSpend = null; kill = null;
    bot._resetForTests();
  };
  const queued = async (issueNumber) => (await pool.query(
    'SELECT COUNT(*)::int AS n FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = $2', [app.id, issueNumber],
  )).rows[0].n;

  // Where an uninterrupted build ends, and what it took to get there.
  const endedAsBuilt = async (runId, issueNumber, label) => {
    const row = await runRow(runId);
    assert.equal(row.build_ok, true, `${label}: built`);
    assert.equal(row.build_sha, SHA, `${label}: what the build turn pushed`);
    assert.equal(row.build_commits, 1, label);
    assert.ok(row.proposal_session_id, `${label}: its proposal is recorded`);
    const { rows: [s] } = await pool.query('SELECT status, pr_number FROM chat_sessions WHERE id = $1', [row.proposal_session_id]);
    assert.equal(s.status, 'promoted', `${label}: up for a vote`);
    assert.equal(openPrs.size, 1, `${label}: ONE pull request`);
    assert.deepEqual(posts.filter((p) => p.kind === 'proposal').length, 1, `${label}: the proposal said once`);
    assert.deepEqual(posts.filter((p) => p.kind === 'spec').length, 1, `${label}: the plan said once`);
    assert.equal(posts.some((p) => p.kind === 'build_failed'), false, `${label}: nothing said about a failure`);
    assert.equal(spends.reduce((a, b) => a + b, 0), COST_CENTS, `${label}: ONE debit of the build's cost`);
    assert.equal(dispatches.length, 1, `${label}: ONE build turn; pushed work is not built again`);
    assert.equal(await queued(issueNumber), 0, `${label}: not sent back to be triaged`);
    return row;
  };

  await t.test('uninterrupted: the baseline every restart below must end at', async () => {
    reset();
    const runId = await waitingRun(40);
    const out = await buildOne(runId);
    assert.equal(out.acted, 'proposed');
    await endedAsBuilt(runId, 40, 'uninterrupted');
    assert.deepEqual(spends, [COST_CENTS]);
    const cp = (await runRow(runId)).build_checkpoint;
    assert.equal(cp.step, 'proposed', 'each step was saved, the last one the proposal');
    assert.equal(cp.landed.sha, SHA);
    assert.equal(cp.prNumber, 101);
    assert.equal(Number(cp.once.debited[String(cp.sessionId)]), COST_USD, 'the debit is kept against its session');
  });

  await t.test('plan published, build turn not started: built from the plan, the plan not said again', async () => {
    reset();
    const runId = await waitingRun(41);
    await killedAt(runId, 'build_turn');
    const first = await runRow(runId);
    assert.equal(first.build_checkpoint.step, 'build_turn');
    assert.deepEqual(posts.map((p) => p.kind), ['spec'], 'the plan was said before the restart');
    // The worker outlived the restart, with no turn in it.
    await recover(first.build_session_id);
    const resumed = await runRow(runId);
    assert.equal(resumed.build_session_id, null, 'handed back to be built from its plan');
    assert.ok(resumed.live_build_waiting_at, 'waiting for the lane');
    assert.equal(resumed.build_spec_md, SPEC);
    assert.equal(await queued(41), 0, 'not triaged again');
    // The lane builds it.
    assert.equal((await buildOne(runId)).acted, 'proposed');
    await endedAsBuilt(runId, 41, 'plan published');
  });

  await t.test('landed, not proposed (plan-docs gap 5): proposed from what it pushed, not built again', async () => {
    reset();
    const runId = await waitingRun(42);
    await killedAt(runId, 'landed');
    const first = await runRow(runId);
    assert.equal(first.build_checkpoint.step, 'landed');
    assert.equal(dispatches.length, 1);
    // Its session rests paused after its turn, so restart recovery does not
    // adopt it: the sweep carries it on.
    await recover(first.build_session_id);
    assert.equal((await runRow(runId)).build_ok, null);
    assert.equal(await bot.resumeStalledLiveBuilds(pool, {}, {}), 0, 'not before its step is stale');
    assert.equal(await sweepLater(runId), 1);
    await endedAsBuilt(runId, 42, 'landed');
    assert.deepEqual(promoteCalls, [first.build_session_id]);
    assert.equal((await runRow(runId)).build_checkpoint.step, 'proposed');
  });

  await t.test('the pull request opened, the checkpoint not yet saved: adopted, never promoted again', async () => {
    reset();
    const runId = await waitingRun(43);
    await killedAt(runId, 'proposed', { before: true });
    const first = await runRow(runId);
    assert.equal(first.build_checkpoint.step, 'landed');
    assert.equal(promoteCalls.length, 1);
    assert.equal(posts.some((p) => p.kind === 'proposal'), false, 'not said yet');
    assert.equal(spends.length, 0, 'not debited yet');
    assert.equal(await sweepLater(runId), 1);
    await endedAsBuilt(runId, 43, 'PR opened');
    assert.equal(promoteCalls.length, 1, 'the promote route was not asked again');
  });

  await t.test('debited and then the restart, before it was said: said once, never debited twice', async () => {
    reset();
    const runId = await waitingRun(44);
    const debited = new Promise((resolve) => { hangAfterSpend = resolve; });
    void buildOne(runId);
    await debited;
    hangAfterSpend = null;
    bot._resetForTests();
    assert.deepEqual(spends, [COST_CENTS], 'the live path debited it');
    assert.equal((await runRow(runId)).build_ok, null, 'and was cut short before it recorded it');
    assert.equal(await sweepLater(runId), 1);
    await endedAsBuilt(runId, 44, 'debited');
    assert.deepEqual(spends, [COST_CENTS], 'recovery did not debit it again');
  });

  await t.test('a second restart before recovery acted on a finished turn (plan-docs gap 4)', async () => {
    reset();
    const runId = await waitingRun(45);
    await killedAt(runId, 'build_turn');
    const { build_session_id: sessionId } = await runRow(runId);
    posts.length = 0;
    // The first restart's recovery followed the build turn to its end (the
    // turn ran on in its worker), noted it, and cleared the turn record.
    const result = replay(writeJournal({ said: SAID, ahead: 1, sha: SHA, pushOk: 1 }));
    assert.equal(await bot.finishRecoveredTurn({
      pool, session: { id: sessionId, user_id: botUser.id }, activeTurn: { mode: 'build', harness: 'claude' }, result,
    }), 'live_pending');
    // The second restart came before it proposed it: its note is gone from
    // memory, kept on the run.
    bot._resetForTests();
    await recover(sessionId);
    const row = await runRow(runId);
    assert.equal(row.build_ok, true, 'proposed from the turn the first recovery followed');
    assert.equal(row.build_sha, SHA);
    assert.equal(openPrs.size, 1);
    assert.deepEqual(posts.map((p) => p.kind), ['proposal']);
    assert.equal(dispatches.length, 0, 'nothing built again');
    assert.equal(await queued(45), 0);
  });

  await t.test('mid-review: proposed where the review got to, once', async () => {
    reset();
    const runId = await waitingRun(46);
    await killedAt(runId, 'landed');
    const { build_session_id: sessionId } = await runRow(runId);
    // A review round had pushed a fix (r1) and seen it boot when the restart
    // came, during the next round's capture (bot-review.js saves each round).
    const r1 = 'c'.repeat(40);
    const updatedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await pool.query('UPDATE homeroom_bot_runs SET review = $2::jsonb WHERE id = $1', [runId, JSON.stringify({
      state: 'capturing', round: 2, finalSha: r1, finalCommits: 2, lastBooted: { sha: r1, commits: 2 },
      buildText: SAID, updatedAt, rounds: [],
    })]);
    assert.equal(await sweepLater(runId), 0, 'a review in progress is not the stalled-step sweep\'s');
    assert.equal(await bot.finishInterruptedReviews(pool, {}, {}), 1);
    // Finished in the background, holding its project's build slot.
    await bot._awaitStalledResumesForTests();
    const row = await runRow(runId);
    assert.equal(row.build_ok, true);
    assert.equal(row.build_sha, r1, 'where the review got to');
    assert.equal(openPrs.size, 1);
    assert.deepEqual(promoteCalls, [sessionId]);
    assert.deepEqual(posts.filter((p) => p.kind === 'proposal').length, 1);
    assert.equal(spends.reduce((a, b) => a + b, 0), COST_CENTS, 'one debit');
    assert.equal(dispatches.length, 1, 'nothing built again');
    assert.equal(await queued(46), 0);
    assert.equal(row.review.stop, 'interrupted');
  });

  await t.test('reviewed, not proposed: proposed at the reviewed commit without reviewing again', async () => {
    reset();
    const runId = await waitingRun(47);
    await killedAt(runId, 'landed');
    const { build_session_id: sessionId } = await runRow(runId);
    // The review ended (its last round approved r2) and saved its step.
    const r2 = 'd'.repeat(40);
    await pool.query("UPDATE homeroom_bot_runs SET review = '{\"state\":\"done\",\"stop\":\"approved\"}'::jsonb WHERE id = $1", [runId]);
    await realSave(pool, runId, sessionId, 'reviewed', { reviewed: { finalSha: r2, finalCommits: 3, costUsd: 0 } });
    assert.equal(await sweepLater(runId), 1);
    const row = await runRow(runId);
    assert.equal(row.build_ok, true);
    assert.equal(row.build_sha, r2);
    assert.equal(row.build_commits, 3);
    assert.equal(openPrs.size, 1);
    assert.equal(spends.reduce((a, b) => a + b, 0), COST_CENTS);
    assert.equal(dispatches.length, 1);
  });

  await t.test('caught before anything was spent: started again from the lane, not triaged', async () => {
    reset();
    const runId = await waitingRun(48);
    // No plan kept on the run: the build writes its own.
    await pool.query('UPDATE homeroom_bot_runs SET build_spec_md = NULL WHERE id = $1', [runId]);
    await killedAt(runId, 'session');
    const { build_session_id: sessionId } = await runRow(runId);
    await recover(sessionId);
    const row = await runRow(runId);
    assert.equal(row.build_session_id, null);
    assert.ok(row.live_build_waiting_at, 'waiting for the lane to start it again');
    assert.equal(row.build_ok, null);
    assert.equal(await queued(48), 0, 'not sent back to be triaged');
    assert.deepEqual(posts, [], 'nothing said');
  });

  await t.test('a shadow build that had pushed is recorded built when its worker is gone', async () => {
    reset();
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, active_turn)
       VALUES ($1, $2, 'dev/homeroom_bot-shadow', 'active', FALSE, '{}', $3) RETURNING id`,
      [app.id, botUser.id, JSON.stringify({ turnId: 't-s', turnUuid: 'u-s', journal: '/gone.log', mode: 'build', phase: 'executing' })],
    );
    const { rows: [r] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, build_session_id, build_at)
       VALUES ($1, 49, 'shadow', 'ready', 'x', $2, NOW()) RETURNING id`,
      [app.id, s.id],
    );
    await realSave(pool, r.id, s.id, 'landed', { landed: { sha: SHA, commits: 2, pushOk: true, text: 'Built.' } });
    await recover(s.id, 'exited');
    const row = await runRow(r.id);
    assert.equal(row.build_ok, true, 'recorded built, not handed back to be built again');
    assert.equal(row.build_sha, SHA);
    assert.equal(row.build_commits, 2);
    assert.equal(row.build_attempts, 0);
  });
});
