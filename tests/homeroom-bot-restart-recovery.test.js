'use strict';

// #3401: a platform redeploy restarts the server, not the worker, so a
// Homeroom bot turn may still be running when the new server comes up, and
// restart recovery finds its worker. Recovery used to finish the bot's
// builds itself, in a second copy of the pipeline. Now each build is a
// durable build on the workflow kernel (services/build-runs.js,
// docs/plans/bot-build-workflow.md): its session carries `workflow_owner`,
// server.js leaves its worker to the build, and the build's next attempt
// follows the turn the restart caught (services/durable-turn.js).
//
// The bot's reads and follow-ups are the same now: each is a look of its
// request's instance (bot-request), whose turn is a durable step its record
// names (active_turn.owner), and server.js leaves it to that work item while
// the item is outstanding. What is left for recovery is a bot turn no
// workflow work holds: one an older release started, which its request
// reads again. Its turn is stopped, its record cleared, its ledger attempt
// closed and its session put back to rest. None of it may reach a person's
// dev-chat tail: no draft PR, no staging preview, no wrap-up and no
// notification.
//
// These pin, without a database: which sessions are the bot's, what
// server.js does with a bot worker it finds, the stale-turn watchdog's
// hand-off, that recovery arms no clock of the bot's (a follow-up's turn is
// its look's: tests/homeroom-bot-followup-restart.test.js), a build's turn
// replayed with its own harness, and the pieces that still read runs a
// restart sent back before builds were durable.
//
// server.js only boots when run as the entry point, so requiring it exposes
// adoptOrphanWorker without starting anything. The worker, the ws, the
// ledger and the spend helpers are stubbed before the require.
//
// Run with: node --test tests/homeroom-bot-restart-recovery.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

// ── worker stub ─────────────────────────────────────────────────────────
// Every call recovery makes on a worker is recorded; following a journal
// (resumeTurnFromJournal) is one that no bot turn may get any more.
const workerCalls = [];
// What this process's own dispatch says is running on a session (a turn it
// is following itself).
let activeMode = null;
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  usesKubernetesWorkers: () => false,
  getActiveTurnMode: () => activeMode,
  resumeTurnFromJournal: async (sessionId) => { workerCalls.push(['resume', sessionId]); return {}; },
  stopTurn: async (sessionId) => { workerCalls.push(['stopTurn', sessionId]); return true; },
  finishTurn: async (sessionId) => { workerCalls.push(['finishTurn', sessionId]); return true; },
  clearActiveTurn: async (sessionId) => { workerCalls.push(['clearActiveTurn', sessionId]); return true; },
  markTurnTail: async () => true,
  noteTailMilestone: async () => true,
  adoptWarmWorker: (sessionId) => { workerCalls.push(['adoptWarmWorker', sessionId]); },
  destroyWorker: async (name) => { workerCalls.push(['destroyWorker', name]); },
  isWorkerExecuting: async () => false,
  getTurnByokCents: () => 0,
  workerContainerName: (id) => `usernode-worker-${id}`,
};

const wsPath = require.resolve('../src/services/ws');
const realWs = require(wsPath);
require.cache[wsPath].exports = {
  ...realWs,
  broadcastGlobal: () => {},
  pushNotificationToUser: () => 0,
  pushToUser: () => 0,
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
const agentTurn = require('../src/services/agent-turn');
const prMetadata = require('../src/services/pr-metadata');
const managedKeys = require('../src/services/openrouter-managed-keys');
const limits = require('../src/services/limits');
const { activeWorkers } = require('../src/services/active-workers');

// The ledger attempt of a turn recovery stops is closed as abandoned.
const ledger = [];
agentTurn.completeCodexAttempt = async ({ turnUuid, status, errorCode }) => { ledger.push({ turnUuid, status, errorCode }); return { updated: true }; };
// Anything reaching the dev-chat tail would open a PR through this.
const prCalls = [];
prMetadata.applyPrMetadata = async (args) => { prCalls.push(args); return {}; };
const spends = [];
managedKeys.usesIncludedKey = async () => true;
limits.recordSpend = async (_pool, userId, cents) => { spends.push({ userId, cents }); };
// A recovered session is put back at rest (or closed) through the proposal
// machine (session-lifecycle's restSession and archiveSession), which no
// fake pool runs: recorded here instead.
const sessionLifecycle = require('../src/services/session-lifecycle');
const lifecycleCalls = [];
sessionLifecycle.restSession = async ({ sessionId }) => { lifecycleCalls.push(['restSession', sessionId]); return true; };
sessionLifecycle.archiveSession = async ({ sessionId, reason }) => { lifecycleCalls.push(['archiveSession', sessionId, reason]); return { archived: true }; };

// ── fixtures ────────────────────────────────────────────────────────────

const BOT_ID = 77;

function botSession(extra = {}) {
  return {
    id: 6001, status: 'active', is_headless: false, user_id: BOT_ID, app_id: 5,
    username: 'homeroom_bot', user_is_synthetic: true,
    app_slug: 'todo', app_name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo',
    branch_name: 'dev/homeroom_bot-s6001',
    workflow_owner: null, workflow_owned: false,
    active_turn: turn(),
    ...extra,
  };
}

function turn(extra = {}) {
  return {
    turnId: 'turn-1', turnUuid: 'uuid-1', journal: '/journals/turn-1.log',
    phase: 'executing', mode: 'build', backend: 'codex_openrouter', model: 'z-ai/glm-5.3-flash',
    startedAt: new Date().toISOString(), attemptNumber: 1,
    ...extra,
  };
}

/** A pool that answers adoptOrphanWorker's read of the session, and records every query. */
function makePool({ session }) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const s = String(sql);
      calls.push({ sql: s, params });
      if (/SELECT cs\.\*/.test(s) && /FROM chat_sessions cs/.test(s)) return { rows: session ? [session] : [] };
      return { rows: [], rowCount: 1 };
    },
  };
}

const staging = { calls: [], async buildAndDeployStaging(...a) { this.calls.push(a); return {}; } };

async function adopt(pool, session, state = 'running') {
  await adoptOrphanWorker(
    { name: `usernode-worker-${session.id}`, sessionId: session.id, state },
    { config: {}, pool, staging, ghub: {}, broadcastGlobal: () => {} },
  );
}

const runUpdates = (pool) => pool.calls.filter((c) => /homeroom_bot_runs/.test(c.sql));
const devChatRows = (pool) => pool.calls.filter((c) => /INSERT INTO chat_session_messages/.test(c.sql));
// What putAwayRecoveredSession does with a session it rests: paused, if it
// was still active (session-lifecycle.restSession, the proposal machine's
// 'rest' pause), and nothing else. No status is written past the machine.
function assertRested(pool, sessionId) {
  assert.deepEqual(lifecycleCalls, [['restSession', sessionId]], 'the session is put back to rest, once');
  assert.deepEqual(pool.calls.filter((c) => /UPDATE chat_sessions SET status/.test(c.sql)), []);
}

test.beforeEach(() => {
  workerCalls.length = 0; prCalls.length = 0; spends.length = 0; ledger.length = 0; staging.calls.length = 0;
  lifecycleCalls.length = 0;
  activeMode = null;
  bot._resetForTests();
});

// ── Which sessions are the bot's ─────────────────────────────────────────

test('only the bot\'s own active sessions are handed to it; a person\'s, and the bot\'s proposal, keep dev-chat recovery', () => {
  assert.equal(bot.isRecoveredBotSession(botSession()), true);
  assert.equal(bot.isRecoveredBotSession(botSession({ username: 'alice', user_is_synthetic: false })), false, 'a person');
  assert.equal(bot.isRecoveredBotSession(botSession({ user_is_synthetic: false })), false, 'a real account that took the name');
  assert.equal(bot.isRecoveredBotSession(botSession({ status: 'promoted' })), false,
    'a follow-up on the bot\'s proposal: updating its PR and staging is the right end');
});

// A mark only a release from before the bot's looks were workflow work put
// on a follow-up's turn record makes nothing the bot's: a look's turn is its
// item's, and a change up for a vote keeps its own end.
test('a turn record marked homeroomBotFollowUp on the bot\'s change up for a vote is not handed to the bot', () => {
  const mark = { followUp: 'reply', appId: 9, issueNumber: 3, deadlineAt: '2026-10-17T12:00:00Z' };
  assert.equal(bot.isRecoveredBotSession(botSession({ status: 'promoted', active_turn: { turnId: 't', homeroomBotFollowUp: mark } })), false);
});

// ── A bot session found paused under a turn (#1006) ──────────────────────
// Before #1006 the triage pass took a running build's session (the bot's
// newest) and paused it under the build. The next deploy's recovery read the
// pause as "nobody wants this", destroyed the worker in silence and left the
// turn record for the watchdog: six platform builds lost on 10-02.

test('a bot session paused with a turn record is the bot\'s; one paused with none is not', () => {
  assert.equal(bot.isRecoveredBotSession(botSession({ status: 'paused' })), true);
  assert.equal(bot.isRecoveredBotSession(botSession({ status: 'paused', active_turn: null })), false,
    'nothing in flight: a paused session at rest is still dropped');
  assert.equal(bot.isRecoveredBotSession(botSession({ status: 'archived' })), false);
  assert.equal(bot.isRecoveredBotSession(botSession({ status: 'paused', username: 'alice', user_is_synthetic: false })), false,
    'a person\'s paused session keeps its own rule');
});

test('a paused bot session with no turn record is still dropped, as before', async () => {
  const session = botSession({ status: 'paused', active_turn: null });
  const pool = makePool({ session });
  await adopt(pool, session);
  assert.deepEqual(workerCalls.map((c) => c[0]), ['destroyWorker']);
  assert.deepEqual(runUpdates(pool), []);
});

// ── A durable build's worker ─────────────────────────────────────────────

test('a durable build\'s worker is left to its build: kept, never stopped, followed or removed, even at rest between its turns', async () => {
  // Its turn in flight, and its session paused with none (a first version's
  // capture in its review runs in the worker with no turn record: R5).
  for (const extra of [{}, { status: 'paused', active_turn: null }]) {
    workerCalls.length = 0;
    const session = botSession({ workflow_owner: 'bot-build/run:900', workflow_owned: true, ...extra });
    const pool = makePool({ session });
    await adopt(pool, session, 'running');
    assert.deepEqual(workerCalls, [['adoptWarmWorker', 6001]], 'kept and registered, nothing else');
    assert.equal(pool.calls.length, 1, 'nothing but the read of the session: no run, session or turn record is touched');
    assert.deepEqual(ledger, []);

    workerCalls.length = 0;
    const exited = makePool({ session });
    await adopt(exited, session, 'exited');
    assert.deepEqual(workerCalls, [], 'a worker that did not survive is not removed either: the build reads that for itself');
    assert.equal(exited.calls.length, 1);
  }
});

test('the session read says whether the build that owns it, or the work its turn names, is still under way', async () => {
  const session = botSession({ workflow_owner: 'bot-build/run:900', workflow_owned: true });
  const pool = makePool({ session });
  await adopt(pool, session);
  const read = pool.calls[0].sql;
  assert.match(read, /\(\(cs\.workflow_owner IS NOT NULL AND EXISTS \(\s*SELECT 1 FROM wf_instances w\s+WHERE w\.machine = split_part\(cs\.workflow_owner, '\/', 1\)\s+AND w\.key = substr\(cs\.workflow_owner, length\(split_part\(cs\.workflow_owner, '\/', 1\)\) \+ 2\)\s+AND w\.state = 'building'\s*\)\) OR /,
    'the owner names its machine and its key; only an instance still building holds the session');
  // A read's or a follow-up's turn (a look of bot-request) names its work
  // item on its record: held while that item is outstanding, in any process.
  const { workflowTurnHeldSql } = require('../src/workflow/session-work.ts');
  assert.ok(read.includes(`OR ${workflowTurnHeldSql('cs.active_turn')}) AS workflow_owned`),
    'a turn whose work item is outstanding is that work\'s, like a build\'s');
});

test('a session whose build has ended is no build\'s: its bot turn is stopped like any other', async () => {
  const session = botSession({ workflow_owner: 'bot-build/run:900', workflow_owned: false });
  const pool = makePool({ session });
  await adopt(pool, session);
  assert.deepEqual(workerCalls.map((c) => c[0]), ['adoptWarmWorker', 'stopTurn', 'finishTurn']);
  assertRested(pool, 6001);
});

test('a bot turn this process is following itself is not adopted', async () => {
  // A follower serves requests and starts turns during a rollout's overlap,
  // before it is promoted: its own live turn is no orphan.
  const session = botSession();
  activeMode = 'build';
  let pool = makePool({ session });
  await adopt(pool, session);
  assert.deepEqual(workerCalls, [], 'dispatched here: left to its dispatch');
  assert.equal(pool.calls.length, 1);

  activeMode = null;
  activeWorkers.add(session.id);
  try {
    pool = makePool({ session });
    await adopt(pool, session);
    assert.deepEqual(workerCalls, [], 'held busy here: left to whatever holds it');
    assert.equal(pool.calls.length, 1);
  } finally {
    activeWorkers.delete(session.id);
  }
});

// ── A bot turn no build owns ─────────────────────────────────────────────

test('a bot turn no build owns is stopped and its session rested: never followed, recorded or finished as a dev chat', async () => {
  // A read (its triage, which its request reads again), and a build that
  // started before builds were durable, both from an older release.
  for (const mode of ['scout', 'build']) {
    workerCalls.length = 0; ledger.length = 0; lifecycleCalls.length = 0;
    const session = botSession({ active_turn: turn({ mode }) });
    const pool = makePool({ session });
    await adopt(pool, session);
    assert.deepEqual(workerCalls.map((c) => c[0]), ['adoptWarmWorker', 'stopTurn', 'finishTurn'],
      `${mode}: its turn is stopped and its record cleared; its journal is not followed`);
    assert.deepEqual(ledger, [{ turnUuid: 'uuid-1', status: 'failed', errorCode: 'recovery_abandoned' }], `${mode}: its ledger attempt is closed`);
    assertRested(pool, 6001);
    assert.deepEqual(runUpdates(pool), [], `${mode}: nothing is recorded on a run`);
    assert.deepEqual(spends, [], 'nothing is debited');
    assert.deepEqual(prCalls, [], 'no PR');
    assert.deepEqual(staging.calls, [], 'no staging');
    assert.deepEqual(devChatRows(pool), [], 'no completion card, breadcrumb or wrap-up row');
  }
});

test('a bot turn on a session paused under it is stopped and its record cleared, not destroyed in silence', async () => {
  const session = botSession({ status: 'paused' });
  const pool = makePool({ session });
  await adopt(pool, session);
  assert.deepEqual(workerCalls.map((c) => c[0]), ['adoptWarmWorker', 'stopTurn', 'finishTurn'],
    'stopped like an active one; the worker is not destroyed first');
  assert.deepEqual(ledger.map((l) => l.errorCode), ['recovery_abandoned']);
  assert.deepEqual(runUpdates(pool), []);
  assert.deepEqual(devChatRows(pool), []);
});

test('a bot turn whose worker did not survive has its record cleared and its worker removed', async () => {
  for (const status of ['active', 'paused']) {
    workerCalls.length = 0; ledger.length = 0;
    const session = botSession({ status });
    const pool = makePool({ session });
    await adopt(pool, session, 'exited');
    assert.deepEqual(workerCalls.map((c) => c[0]), ['clearActiveTurn', 'destroyWorker'], `${status}: nothing to stop or follow`);
    assert.deepEqual(ledger.map((l) => l.errorCode), ['recovery_abandoned']);
    assert.deepEqual(runUpdates(pool), []);
    assert.deepEqual(devChatRows(pool), []);
  }
});

// ── The bot's clock across a restart ─────────────────────────────────────

test('each restart that reaches a turn gives its clock back two minutes, up to ten restarts', async () => {
  // The rule is durable-turn.js's, read off the turn's `restarts`.
  const { allowanceMs, RESTART_ALLOWANCE_MS } = require('../src/services/durable-turn');
  assert.equal(bot.RESTART_ALLOWANCE_MS, 2 * 60 * 1000);
  assert.equal(RESTART_ALLOWANCE_MS, bot.RESTART_ALLOWANCE_MS);
  assert.equal(allowanceMs(turn().restarts), 0, 'a turn no restart reached');
  assert.equal(allowanceMs(turn({ restarts: 3 }).restarts), 3 * bot.RESTART_ALLOWANCE_MS);
  assert.equal(allowanceMs(turn({ restarts: 50 }).restarts), 10 * bot.RESTART_ALLOWANCE_MS, 'a run of restarts is not followed for ever');
  assert.equal(allowanceMs(turn({ restarts: 'x' }).restarts), 0);
});

test('server.js arms no clock of the bot\'s: every bot turn\'s clock is its durable step\'s', () => {
  // A build's turns, a read's and a follow-up's keep their own clock
  // (durable-turn.js, from the deadline their step saved), and recovery
  // leaves each to its work item. The follow-up's clock recovery used to
  // arm through the person's tail (#4533) is gone with it.
  const src = require('node:fs').readFileSync(require.resolve('../server'), 'utf8');
  assert.doesNotMatch(src, /botClock|botFollowUp|isRecoveredBotFollowUp|recoveryDeadline|finishRecoveredFollowUp/);
  assert.doesNotMatch(src, /clockLeftMs/, 'nothing reads what the clock had left any more');
  assert.equal(bot.recoveryDeadline, undefined);
  assert.equal(bot.isRecoveredBotFollowUp, undefined);
});

// ── #1080 ────────────────────────────────────────────────────────────────

test('a build\'s turn a restart caught is replayed with its own harness\'s parser', async () => {
  // GLM runs in Claude Code since #3749. Replayed with the default (Codex)
  // parser, a recovered turn came back with no result text, progress or
  // usage: a recovered spec lost its spec, a triage its verdict. A build's
  // next attempt follows its turn through durable-turn.js followTurn.
  const durableTurn = require('../src/services/durable-turn');
  const replays = [];
  const worker = {
    async resumeTurnFromJournal(_id, opts) { replays.push(opts); return { pushOk: true, ahead: 1, sha: 'd'.repeat(40), exitCode: 0, providerDispatched: true }; },
    async markTurnTail() {},
  };
  const ledgerStub = {
    async persistRecoveredAgentThread() {},
    async settleRecoveredAgentAttempt() { return { estimatedCost: { estimatedCostUsd: 0.1 } }; },
  };
  const follow = (activeTurn) => durableTurn.followTurn({
    pool: makePool({}), session: botSession(), activeTurn, deps: { worker, agentTurn: ledgerStub },
  });
  await follow(turn({ harness: 'claude' }));
  assert.equal(replays.at(-1).agentHarness, 'claude');
  await follow(turn());
  assert.equal(replays.at(-1).agentHarness, null, 'a record from before harnesses: the registry\'s own default');
  const src = require('node:fs').readFileSync(require.resolve('../src/routes/sessions'), 'utf8');
  assert.match(src, /agentHarness: activeTurn\.harness \|\| null,/, 'the same as the dev chat\'s own recovery');
});

// ── Runs a restart sent back before builds were durable ──────────────────
// No restart sends a build back to be triaged any more: a build outlives
// the restart. These still read the runs that were (RESTARTED_BUILD_NOTE).

test('an issue a restart sent back is not told "looking" a second time', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot'), 'utf8');
  assert.equal(bot.RESTART_REASON, 'restart');
  assert.match(src, /const looked = item\.reason === RESTART_REASON \|\| item\.reason === APP_AGAIN_REASON \|\| item\.reason === BACKLOG_REASON\n\s+\|\| item\.reason === RETRY_FAILED_REASON \|\| item\.reason === READ_AGAIN_REASON \? null : await live\.post\(\{\n\s+pool, github, ws: liveD\.ws, app, repo, issueNumber,\n\s+kind: 'looking'/,
    'nor is a request whose failed read is tried again (#1080)');
});

// #4210: a first version sent back to be read again, with no plan to carry
// on from, is not put to its creator a second time: the plan they approved,
// and the answers they tapped, go onto the new run, which builds at once.
function carryPool({ prev, updated = 1 }) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/SELECT id, plan, build_error FROM homeroom_bot_runs/.test(sql)) return { rows: prev ? [prev] : [] };
      if (/UPDATE homeroom_bot_runs SET build_note = CONCAT/.test(sql)) return { rows: [], rowCount: updated };
      return { rows: [], rowCount: 0 };
    },
  };
}
const APPROVED = {
  bullets: ['A list of restaurants', 'Drag them into tiers'],
  questions: [{ question: 'Which city?', answers: ['SF', 'Oakland'] }],
  chosen: [{ question: 'Which city?', answer: 'Oakland', suggested: false }],
};

test('a first version its creator approved, sent back by a restart, keeps their plan and answers and is not asked again', async () => {
  const pool = carryPool({ prev: { id: 940, plan: APPROVED, build_error: `interrupted: the worker is gone ${bot.RESTARTED_BUILD_NOTE}` } });
  assert.equal(await bot.carryApprovedPlan(pool, { runId: 951, appId: 5, issueNumber: 12 }), true);
  const read = pool.calls[0];
  assert.match(read.sql, /mode = 'live' AND id < \$3\s+ORDER BY id DESC LIMIT 1/);
  assert.deepEqual(read.params, [5, 12, 951]);
  const write = pool.calls[1];
  assert.equal(write.params[0], 951);
  assert.match(write.params[1], /Drag them into tiers/, 'the bullets they approved');
  assert.match(write.params[1], /Which city\? Oakland/, 'and the answer they tapped');
  assert.deepEqual(JSON.parse(write.params[2]), APPROVED);
  assert.match(write.sql, /awaiting_go_at IS NULL/);
});

test('a plan nobody approved, or a run that ended some other way, is asked about as before', async () => {
  const unapproved = { ...APPROVED, chosen: undefined };
  const sentBackNote = `interrupted: the worker is gone ${bot.RESTARTED_BUILD_NOTE}`;
  assert.equal(await bot.carryApprovedPlan(carryPool({ prev: { id: 940, plan: unapproved, build_error: sentBackNote } }), { runId: 951, appId: 5, issueNumber: 12 }), false);
  assert.equal(await bot.carryApprovedPlan(carryPool({ prev: { id: 940, plan: APPROVED, build_error: 'the build ran past its time limit' } }), { runId: 951, appId: 5, issueNumber: 12 }), false);
  assert.equal(await bot.carryApprovedPlan(carryPool({ prev: null }), { runId: 951, appId: 5, issueNumber: 12 }), false);
});

test('a first version\'s ready verdict looks for an approved plan before it sends the plan card', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot'), 'utf8');
  assert.match(src, /if \(firstVersion && await carryApprovedPlan\(pool, \{ runId, appId: app\.id, issueNumber \}\)\) \{\n\s+await queueLiveBuild\(pool, \{ runId, appId: app\.id \}\);\n\s+acted = 'build_queued';\n\s+\} else if \(firstVersion\) \{\n\s+acted = PLAN_ACTED\[await awaitGo\(/);
});

test('admins read the week\'s incidents newest first, and a line says what happened', async () => {
  const incidents = require('../src/services/platform-incidents');
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/COUNT/.test(sql)) return { rows: [{ n: 3 }] };
      return { rows: [{ created_at: new Date('2026-10-07T12:00:00Z'), app_slug: 'tiers', metadata: { kind: 'build_interrupted', runId: 950, issueNumber: 1, why: 'the worker is gone', outcome: 'resumed' } }] };
    },
  };
  const out = await incidents.recent(pool);
  assert.equal(out.total, 3);
  assert.deepEqual(out.items[0], {
    at: '2026-10-07T12:00:00.000Z', kind: 'build_interrupted', app: 'tiers', runId: 950, issueNumber: 1, why: 'the worker is gone', outcome: 'resumed',
  });
  assert.match(calls[0].sql, /event_type = \$1 AND e\.created_at > NOW\(\) - make_interval\(days => \$2\)/);
  assert.deepEqual(calls[0].params, ['platform_incident', 7, 20]);
  assert.equal(await incidents.recent({ query: async () => { throw new Error('down'); } }), null, 'never throws');
  const src = require('node:fs').readFileSync(require.resolve('../frontend/src/features/admin/admin-homeroom-bot-health.tsx'), 'utf8');
  assert.match(src, /id="admin-homeroom-bot-unexpected"/);
  assert.match(src, /resumed: 'carried on from its plan'/);
});

// ── Shutdown ─────────────────────────────────────────────────────────────

test('neither the bot nor the benchmark has a loop of its own for shutdown to stop', async () => {
  const src = require('node:fs').readFileSync(require.resolve('../server'), 'utf8');
  // The bot's loop is the bot-request and bot-lane machines, the
  // benchmark's the bench-lane machine, whose work stops with the workflow
  // runtime: nothing in server.js starts or stops either.
  assert.doesNotMatch(src, /require\('\.\/src\/services\/homeroom-bot'\)\.(start|stop)\(/);
  assert.doesNotMatch(src, /require\('\.\/src\/services\/bench\/lane'\)\.(start|stop)\(/);
  for (const gone of ['start', 'stop', 'drainBuilds', 'runOnce']) assert.equal(bot[gone], undefined, gone);
});
