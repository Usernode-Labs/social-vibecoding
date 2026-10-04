'use strict';

// #3401: a platform redeploy restarts the server, not the worker, so a
// Homeroom bot build is still running when the new server comes up, and
// restart recovery adopts it. Recovery used to finish it as a person's dev
// chat: a draft PR on the app's repository, a staging preview, a wrap-up
// and a notification, while the bot's run stayed "building" until it was
// requeued and built a second time. Now recovery follows the journal as
// before and hands the result to the bot, which records it on its run.
//
// server.js only boots when run as the entry point, so requiring it exposes
// adoptOrphanWorker without starting anything. The worker, the agent-turn
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
// resumeTurnFromJournal stands in for following the journal; `journalTail`
// is what each test's turn returns.
let journalTail = async () => ({});
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
  finishTurn: async (sessionId) => { workerCalls.push(['finishTurn', sessionId]); return true; },
  markTurnTail: async () => true,
  noteTailMilestone: async () => true,
  clearActiveTurn: async () => true,
  adoptWarmWorker: (sessionId) => { workerCalls.push(['adoptWarmWorker', sessionId]); },
  destroyWorker: async (name) => { workerCalls.push(['destroyWorker', name]); },
  isWorkerExecuting: async () => false,
  getTurnByokCents: () => 0,
  workerContainerName: (id) => `usernode-worker-${id}`,
};
let stopped = null;

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
const sessionsRoutes = require('../src/routes/sessions');
const prMetadata = require('../src/services/pr-metadata');
const managedKeys = require('../src/services/openrouter-managed-keys');
const limits = require('../src/services/limits');

// The ledger and the thread are settled exactly as for any recovered turn;
// what they do is covered elsewhere, and here they only have to succeed.
const settled = [];
agentTurn.persistRecoveredAgentThread = async () => {};
agentTurn.settleRecoveredAgentAttempt = async ({ activeTurn }) => { settled.push(activeTurn.turnUuid); return null; };
sessionsRoutes.resumeRecoveredCodexFreshRetry = async () => null;
// Anything reaching the dev-chat tail would open a PR through this.
const prCalls = [];
prMetadata.applyPrMetadata = async (args) => { prCalls.push(args); return {}; };
const spends = [];
managedKeys.usesIncludedKey = async () => true;
limits.recordSpend = async (_pool, userId, cents) => { spends.push({ userId, cents }); };

// ── fixtures ────────────────────────────────────────────────────────────

const BOT_ID = 77;
const RUN = { id: 900, app_id: 5, issue_number: 12, build_attempts: 1 };

function botSession(extra = {}) {
  return {
    id: 6001, status: 'active', is_headless: false, user_id: BOT_ID, app_id: 5,
    username: 'homeroom_bot', user_is_synthetic: true,
    app_slug: 'todo', app_name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo',
    branch_name: 'dev/homeroom_bot-s6001',
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

/** A pool that answers the session read, the run lookup and the cost sum. */
function makePool({ session, run = RUN, cost = 0.42, liveRun = null, earlierBuilds = [] }) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const s = String(sql);
      calls.push({ sql: s, params });
      // The request's earlier live builds, newest first (restartedBuildsBefore).
      if (/SELECT build_error FROM homeroom_bot_runs/.test(s)) return { rows: earlierBuilds };
      // A live run put back in line with its kept plan (resumeLiveBuildFromSpec).
      if (/SET build_spec_md = \$2, build_cost_usd = \$3, build_session_id = NULL/.test(s)) return { rows: [{ id: params[0] }] };
      if (/SELECT cs\.\*/.test(s) && /FROM chat_sessions cs/.test(s)) return { rows: session ? [session] : [] };
      if (/WHERE build_session_id = \$1 AND mode = 'live'/.test(s)) return { rows: liveRun ? [liveRun] : [] };
      if (/FROM homeroom_bot_runs\s+WHERE build_session_id = \$1/.test(s)) return { rows: run ? [run] : [] };
      // What completeRecoveredLive reads once the session is free.
      if (/spec_version/.test(s) && /FROM chat_sessions cs WHERE cs\.id = \$1/.test(s)) {
        return { rows: [{ id: session.id, user_id: BOT_ID, status: 'active', branch_name: session.branch_name, spec_md: '# Spec', spec_version: 2 }] };
      }
      if (/FROM apps WHERE id = \$1/.test(s)) return { rows: [{ id: 5, slug: 'todo', name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo' }] };
      if (/FROM users WHERE username = \$1/.test(s)) return { rows: [{ id: BOT_ID, username: 'homeroom_bot', weekly_limit_cents: 15000 }] };
      if (/SUM\(estimated_cost_usd\)/.test(s)) return { rows: [{ cost }] };
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

const runUpdates = (pool) => pool.calls.filter((c) => /UPDATE homeroom_bot_runs/.test(c.sql));
const sessionUpdates = (pool) => pool.calls.filter((c) => /UPDATE chat_sessions SET status/.test(c.sql));
const devChatRows = (pool) => pool.calls.filter((c) => /INSERT INTO chat_session_messages/.test(c.sql));

test.beforeEach(() => {
  workerCalls.length = 0; prCalls.length = 0; spends.length = 0; settled.length = 0; staging.calls.length = 0;
  journalTail = async () => ({});
  stopped = null;
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

test('a build whose session was paused under it is followed and recorded, not destroyed in silence', async () => {
  journalTail = async () => ({ pushOk: true, ahead: 1, sha: 'c'.repeat(40), exitCode: 0 });
  const session = botSession({ status: 'paused' });
  const pool = makePool({ session });
  await adopt(pool, session);
  assert.deepEqual(workerCalls.map((c) => c[0]), ['adoptWarmWorker', 'resume', 'finishTurn'],
    'followed like an active one; the worker is not destroyed first');
  const rec = runUpdates(pool).find((c) => /SET build_ok = \$2/.test(c.sql));
  assert.ok(rec, 'the run is recorded');
  assert.equal(rec.params[1], true);
  assert.deepEqual(devChatRows(pool), []);
});

test('a paused bot session whose worker is gone hands its run back unspent', async () => {
  const session = botSession({ status: 'paused' });
  const pool = makePool({ session });
  await adopt(pool, session, 'exited');
  assert.deepEqual(workerCalls.map((c) => c[0]), ['finishTurn', 'destroyWorker']);
  assert.ok(runUpdates(pool).some((c) => /build_attempts = GREATEST\(build_attempts - 1, 0\)/.test(c.sql)),
    'a deploy is not the build\'s failure');
});

test('a paused bot session with no turn record is still dropped, as before', async () => {
  const session = botSession({ status: 'paused', active_turn: null });
  const pool = makePool({ session });
  await adopt(pool, session);
  assert.deepEqual(workerCalls.map((c) => c[0]), ['destroyWorker']);
  assert.deepEqual(runUpdates(pool), []);
});

// ── A turn the stale-turn watchdog reaped (#1006) ───────────────────────

test('a reaped bot build goes back in the queue unspent, with nothing said to a person', async () => {
  const session = botSession({ status: 'paused' });
  const pool = makePool({ session });
  const outcome = await bot.settleReapedTurn({ pool, config: {}, session });
  assert.equal(outcome, 'requeued');
  assert.ok(runUpdates(pool).some((c) => /build_attempts = GREATEST\(build_attempts - 1, 0\), build_session_id = NULL/.test(c.sql)));
  assert.ok(sessionUpdates(pool).some((c) => /'archived'/.test(c.sql)), 'the dead build session is put away');
  assert.deepEqual(devChatRows(pool), []);
});

test('a reaped turn of a build this process is still running is left to that build', async () => {
  const session = botSession();
  const pool = makePool({ session });
  let finish;
  const holding = bot.holdSlotDuringRecovery(pool, session.id, new Promise((r) => { finish = r; }));
  for (let i = 0; i < 20 && !bot._buildsInFlightForTests().length; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual(bot._buildsInFlightForTests(), [900]);
  const before = runUpdates(pool).length;
  assert.equal(await bot.settleReapedTurn({ pool, config: {}, session }), 'in_flight');
  assert.equal(runUpdates(pool).length, before, 'the run is untouched');
  finish();
  await holding;
});

test('the stale-turn watchdog hands a bot or bench turn to its owner before a person\'s breadcrumb', () => {
  const src = require('node:fs').readFileSync(require.resolve('../server'), 'utf8');
  const start = src.indexOf('Stale active_turn watchdog');
  const body = src.slice(start, src.indexOf('Stale active_turn watchdog sweep failed', start));
  assert.match(body, /u\.username, u\.is_synthetic AS user_is_synthetic/, 'the sweep reads who owns the session');
  const reaped = body.indexOf('worker.clearActiveTurn(row.id');
  const bench = body.indexOf("isBenchSession(row)");
  const botAt = body.indexOf('settleReapedTurn({ pool, config, session: row })');
  const breadcrumb = body.indexOf('TURN_UNFINISHED_BREADCRUMB');
  assert.ok(reaped > 0 && bench > reaped && botAt > bench && breadcrumb > botAt,
    'cleared first (a CAS miss hands nothing back), then the owner, then the person path');
  assert.match(body.slice(bench, breadcrumb), /releaseTrialOfSession\(pool, row\.id/);
});

// ── A build turn ─────────────────────────────────────────────────────────

test('a build that finished while the server was down is recorded on its run, with no PR, staging or dev-chat rows', async () => {
  journalTail = async () => ({ pushOk: true, ahead: 2, sha: 'a'.repeat(40), exitCode: 0 });
  const session = botSession();
  const pool = makePool({ session });
  await adopt(pool, session);

  assert.deepEqual(workerCalls.map((c) => c[0]), ['adoptWarmWorker', 'resume', 'finishTurn'],
    'the journal is followed and the turn record cleared, as for any recovered turn');
  assert.deepEqual(settled, ['uuid-1'], 'the ledger attempt is settled');
  const rec = runUpdates(pool).find((c) => /SET build_ok = \$2/.test(c.sql));
  assert.ok(rec, 'the run is recorded');
  assert.deepEqual(rec.params.slice(0, 7), [900, true, 'dev/homeroom_bot-s6001', 'a'.repeat(40), 2, null, 0.42]);
  assert.match(rec.sql, /build_spec_md = COALESCE\(r\.build_spec_md, \(SELECT spec_md FROM chat_sessions WHERE id = \$8\)\)/,
    'the spec the session wrote before the restart is kept');
  assert.ok(sessionUpdates(pool).some((c) => /'archived'/.test(c.sql)), 'the build session is put away');
  assert.deepEqual(spends, [{ userId: BOT_ID, cents: 42 }], 'debited from the bot\'s allowance');
  assert.deepEqual(prCalls, [], 'no PR');
  assert.deepEqual(staging.calls, [], 'no staging');
  assert.deepEqual(devChatRows(pool), [], 'no completion card, breadcrumb or wrap-up row');
});

test('a build that pushed nothing is recorded failed, and says it finished after a restart', async () => {
  journalTail = async () => ({ pushOk: false, ahead: 0, exitCode: 0 });
  const session = botSession();
  const pool = makePool({ session });
  await adopt(pool, session);
  const rec = runUpdates(pool).find((c) => /SET build_ok = \$2/.test(c.sql));
  assert.equal(rec.params[1], false);
  assert.equal(rec.params[5], 'the build produced no change to propose (finished after a restart)');
});

test('the bot\'s clock carries across the restart: a turn past its budget is stopped and recorded as a time-out', async () => {
  // Started 25 minutes ago against the default 20-minute turn budget.
  journalTail = () => new Promise((resolve) => { stopped = () => resolve({ exitCode: 143, pushOk: false, ahead: 0 }); });
  const session = botSession({ active_turn: turn({ startedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString() }) });
  const pool = makePool({ session });
  await adopt(pool, session);
  assert.ok(workerCalls.some((c) => c[0] === 'stopTurn'), 'stopped at once: its time was already up');
  const rec = runUpdates(pool).find((c) => /SET build_ok = \$2/.test(c.sql));
  assert.equal(rec.params[5], 'the build ran past its time limit (finished after a restart)');
});

test('a clock already past its deadline is not unref\'d, so the stop it owes always comes', () => {
  // The case above awaits a journal that only the clock's stopTurn resolves.
  // An unref'd 0 ms timer can be skipped when nothing else holds the event
  // loop open, and node:test then cancels this test and every one after it
  // ("17 cancelled, 0 failed" in the platform's unit run).
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const at = src.indexOf('botClock = setTimeout(');
  assert.ok(at > 0, 'the bot clock is armed in server.js');
  const block = src.slice(at - 200, at + 900);
  assert.match(block, /const botClockMs = Math\.max\(0, deadline - Date\.now\(\)\);/);
  assert.match(block, /if \(botClockMs > 0 && typeof botClock\.unref === 'function'\) botClock\.unref\(\);/);
  assert.doesNotMatch(block, /^\s*if \(typeof botClock\.unref === 'function'\) botClock\.unref\(\);/m,
    'never unref the clock unconditionally');
});

// ── A spec turn ──────────────────────────────────────────────────────────

const SPEC = '# Refresh feeds\n\n## User-facing changes\n\nFeeds refresh.\n\n## Technical implementation\n\nPoll hourly.';

test('a spec turn keeps its spec on the run and puts the build back in the queue, no attempt spent', async () => {
  journalTail = async () => ({ lastResultText: `Done reading.\n${SPEC}`, exitCode: 0 });
  const session = botSession({ active_turn: turn({ mode: 'scout' }) });
  const pool = makePool({ session });
  await adopt(pool, session);
  const kept = runUpdates(pool).find((c) => /SET build_spec_md = \$2/.test(c.sql));
  assert.deepEqual(kept.params, [900, SPEC], 'read as the live path reads it: from its title');
  const back = runUpdates(pool).find((c) => /build_attempts = GREATEST\(build_attempts - 1, 0\)/.test(c.sql));
  assert.match(back.sql, /SET build_at = NULL/);
  assert.match(back.sql, /build_session_id = NULL/);
  assert.deepEqual(spends, [{ userId: BOT_ID, cents: 42 }], 'the spec turn\'s cost is debited too');
  assert.deepEqual(prCalls, []);
  assert.deepEqual(devChatRows(pool), [], 'no spec card or wrap-up on the bot\'s session');
});

test('a spec turn that found the request impossible is recorded as blocked', async () => {
  journalTail = async () => ({ lastResultText: 'BLOCKED: the app has no accounts to rank.', exitCode: 0 });
  const session = botSession({ active_turn: turn({ mode: 'scout' }) });
  const pool = makePool({ session });
  await adopt(pool, session);
  const rec = runUpdates(pool).find((c) => /SET build_ok = FALSE, build_error = \$2/.test(c.sql));
  assert.deepEqual(rec.params, [900, 'blocked: the app has no accounts to rank. (finished after a restart)', 0.42]);
});

// ── Nothing to follow ────────────────────────────────────────────────────

test('a worker that did not survive puts the run back in the queue unspent', async () => {
  const session = botSession();
  const pool = makePool({ session });
  await adopt(pool, session, 'exited');
  assert.deepEqual(workerCalls.map((c) => c[0]), ['finishTurn', 'destroyWorker'], 'nothing to follow');
  assert.ok(runUpdates(pool).some((c) => /build_attempts = GREATEST\(build_attempts - 1, 0\)/.test(c.sql)));
  assert.deepEqual(prCalls, []);
  assert.deepEqual(devChatRows(pool), []);
});

test('a journal replay that fails puts the run back too, with no stalled notice', async () => {
  journalTail = async () => { throw new Error('journal unreadable'); };
  const session = botSession();
  const pool = makePool({ session });
  agentTurn.completeCodexAttempt = async () => ({ updated: true });
  await adopt(pool, session);
  assert.ok(runUpdates(pool).some((c) => /build_attempts = GREATEST\(build_attempts - 1, 0\)/.test(c.sql)));
  assert.deepEqual(devChatRows(pool), [], 'no "turn unfinished" breadcrumb');
  assert.ok(workerCalls.some((c) => c[0] === 'finishTurn'));
});

test('a triage turn, which no build run owns, rests its session and records nothing', async () => {
  journalTail = async () => ({ lastResultText: '{"verdict":"ready"}', exitCode: 0 });
  const session = botSession({ active_turn: turn({ mode: 'scout' }) });
  const pool = makePool({ session, run: null });
  await adopt(pool, session);
  assert.deepEqual(runUpdates(pool), []);
  assert.ok(sessionUpdates(pool).some((c) => /'paused'/.test(c.sql)), 'the triage session rests paused');
  assert.deepEqual(devChatRows(pool), [], 'its verdict is not published as a spec');
});

test('while recovery finishes a build it holds that build\'s lane slot', async () => {
  let release;
  journalTail = () => new Promise((resolve) => { release = () => resolve({ pushOk: true, ahead: 1, sha: 'b'.repeat(40) }); });
  const session = botSession();
  const pool = makePool({ session });
  const running = adopt(pool, session);
  for (let i = 0; i < 50 && !release; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual(bot._buildsInFlightForTests(), [900], 'counted against buildConcurrency, and never released as stale');
  release();
  await running;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(bot._buildsInFlightForTests(), []);
});

// ── A live build (#3471) ─────────────────────────────────────────────────
// Its triage pass is gone with the restart: it had dropped the queue row and
// said it was looking. Recovery finishes it the way the live path would.

const live = require('../src/services/homeroom-bot-live');
const github = require('../src/services/github');
const LIVE_RUN = { id: 950, app_id: 5, issue_number: 12 };
const liveCalls = [];
function stubLive({ promote = { status: 200, body: { ok: true, prNumber: 77 } }, issueState = 'open' } = {}) {
  liveCalls.length = 0;
  live.promoteAsBot = async ({ sessionId }) => { liveCalls.push(['promote', sessionId, workerCalls.map((c) => c[0]).join(',')]); return promote; };
  // #3518: named and described before the route runs, as the live path does.
  live.prepareProposal = async ({ sessionId, spec, buildText }) => { liveCalls.push(['prepare', sessionId, spec, buildText || null]); return {}; };
  live.post = async ({ kind, text, metadata }) => { liveCalls.push(['post', kind, text, metadata || null]); return {}; };
  live.postSpecOnProposal = async ({ sessionId, version, spec }) => { liveCalls.push(['specOnProposal', sessionId, version, spec]); };
  live.mentionTargets = async () => [];
  live.botUsernameOf = async () => 'usernode-bot';
  github.fetchPublicIssue = async (_o, _r, n) => ({ issue: { number: n, title: 'Issue', state: issueState } });
}
const requeues = (pool) => pool.calls.filter((c) => /INSERT INTO homeroom_bot_queue/.test(c.sql));
const liveOutcome = (pool) => pool.calls.filter((c) => /SET build_ok = \$2, build_error = \$3/.test(c.sql)).at(-1)?.params;

test('a live build that committed is proposed once recovery lets go, and the proposal is said on the issue', async () => {
  stubLive();
  journalTail = async () => ({ pushOk: true, ahead: 1, sha: 'c'.repeat(40), exitCode: 0, lastResultText: 'Built it.' });
  const session = botSession();
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await adopt(pool, session);

  const promote = liveCalls.find((c) => c[0] === 'promote');
  assert.ok(promote, 'proposed');
  // #3518: its name from the spec the session wrote before the restart, and
  // its description from the build's own message, both before the route.
  const prepare = liveCalls.findIndex((c) => c[0] === 'prepare');
  assert.deepEqual(liveCalls[prepare], ['prepare', 6001, '# Spec', 'Built it.']);
  assert.ok(prepare < liveCalls.indexOf(promote), 'named and described before it is proposed');
  assert.equal(promote[1], 6001);
  assert.match(promote[2], /finishTurn/, 'after the turn record is cleared, as the live path promotes after the build turn');
  const said = liveCalls.find((c) => c[0] === 'post' && c[1] === 'proposal');
  assert.ok(said, 'the proposal is said on the issue');
  assert.deepEqual(said[3], { vote: { sessionId: 6001, prNumber: 77 } }, 'with the live vote card');
  assert.deepEqual(liveCalls.find((c) => c[0] === 'specOnProposal'), ['specOnProposal', 6001, 2, '# Spec'], 'and the spec on the proposal');
  assert.ok(pool.calls.some((c) => /SET proposal_session_id = \$2/.test(c.sql) && c.params[0] === 950), 'recorded on the live run');
  const outcome = liveOutcome(pool);
  assert.deepEqual([outcome[0], outcome[1], outcome[2], outcome[4], outcome[5], outcome[6], outcome[7]],
    [950, true, null, 'c'.repeat(40), 1, 0.42, 6001], 'and what it built, as the live path records it (#3509)');
  assert.deepEqual(prCalls, [], 'not the dev-chat PR path');
  assert.deepEqual(requeues(pool), []);
  assert.deepEqual(spends, [{ userId: BOT_ID, cents: 42 }], 'debited as the live path debits a build');
});

test('a live build that pushed nothing says so on the issue, instead of going silent', async () => {
  stubLive();
  journalTail = async () => ({ pushOk: false, ahead: 0, exitCode: 0 });
  const session = botSession();
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await adopt(pool, session);
  assert.equal(liveCalls.some((c) => c[0] === 'promote'), false);
  const failed = liveCalls.find((c) => c[0] === 'post' && c[1] === 'build_failed');
  assert.ok(failed, 'the build-failed note is posted');
  assert.match(failed[2], /the build produced no change to propose \(finished after a restart\)/);
  assert.deepEqual(liveOutcome(pool).slice(0, 3), [950, false, 'the build produced no change to propose (finished after a restart)']);
  assert.ok(sessionUpdates(pool).some((c) => /'archived'/.test(c.sql)));
});

const SPEC_TEXT = '# Spec\n\n## User-facing changes\n\nx\n\n## Technical implementation\n\ny';
const resumes = (pool) => pool.calls.filter((c) => /SET build_spec_md = \$2, build_cost_usd = \$3, build_session_id = NULL/.test(c.sql));

test('a live spec turn that wrote a plan keeps it, and the build goes on from it', async () => {
  stubLive();
  journalTail = async () => ({ lastResultText: SPEC_TEXT, exitCode: 0 });
  const session = botSession({ active_turn: turn({ mode: 'scout' }) });
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await adopt(pool, session);
  assert.deepEqual(requeues(pool), [], 'not sent back to be triaged and planned again');
  const [resume] = resumes(pool);
  assert.ok(resume, 'its run is back in line for its build');
  assert.deepEqual(resume.params, [950, SPEC_TEXT, 0.42], 'with the plan, and what writing it cost');
  assert.match(resume.sql, /live_build_waiting_at = NOW\(\)/);
  assert.match(resume.sql, /WHERE id = \$1 AND mode = 'live' AND build_ok IS NULL AND proposal_session_id IS NULL/);
  assert.equal(liveOutcome(pool), undefined, 'no outcome recorded: the build is not over');
  assert.deepEqual(liveCalls.filter((c) => c[0] === 'post'), [], 'nothing said on the issue yet: the build says the plan when it starts');
  assert.ok(sessionUpdates(pool).some((c) => /'archived'/.test(c.sql)), 'the interrupted session is put away');
});

test('a live spec turn with no usable plan sends the issue back to be triaged, and a BLOCKED one says so', async () => {
  stubLive();
  journalTail = async () => ({ lastResultText: '', exitCode: 0 });
  let session = botSession({ active_turn: turn({ mode: 'scout' }) });
  let pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await adopt(pool, session);
  const [requeue] = requeues(pool);
  assert.ok(requeue, 'back in the queue: its row was gone with the pass');
  assert.deepEqual(requeue.params, [5, 12, 'restart']);
  assert.deepEqual(resumes(pool), []);
  assert.deepEqual(liveCalls.filter((c) => c[0] === 'post'), [], 'nothing said: the fresh triage speaks');

  stubLive();
  journalTail = async () => ({ lastResultText: 'BLOCKED: the app keeps no scores to rank.', exitCode: 0 });
  session = botSession({ active_turn: turn({ mode: 'scout' }) });
  pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await adopt(pool, session);
  const blocked = liveCalls.find((c) => c[0] === 'post' && c[1] === 'blocked');
  assert.ok(blocked, 'the blocked note is posted');
  assert.match(blocked[2], /the app keeps no scores to rank\./);
  assert.deepEqual(liveOutcome(pool).slice(0, 2), [950, false]);
  assert.match(liveOutcome(pool)[2], /^blocked: the app keeps no scores to rank\./);
  assert.deepEqual(requeues(pool), []);
  assert.deepEqual(resumes(pool), []);
});

test('a live build whose worker did not survive sends the issue back to be triaged', async () => {
  stubLive();
  const session = botSession();
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await adopt(pool, session, 'exited');
  assert.deepEqual(requeues(pool).map((c) => c.params), [[5, 12, 'restart']]);
  assert.equal(liveCalls.some((c) => c[0] === 'promote'), false);
});

// Restarts that keep cutting one request's builds short before there is a
// plan to keep, or taking the worker with them: the third in a row is not
// sent round again, but said as a failed build.
const sentBack = (why) => ({ build_error: `interrupted: ${why} ${bot.RESTARTED_BUILD_NOTE}` });

test('the third build in a row a restart cuts short is said to have failed, not sent round again', async () => {
  stubLive();
  journalTail = async () => ({ lastResultText: '', exitCode: 0 });
  const session = botSession({ active_turn: turn({ mode: 'scout' }) });
  const pool = makePool({
    session, run: null, liveRun: LIVE_RUN,
    earlierBuilds: [sentBack('the spec turn was cut short'), sentBack('the worker did not survive')],
  });
  await adopt(pool, session);
  assert.deepEqual(requeues(pool), [], 'not back in the queue');
  const failed = liveCalls.find((c) => c[0] === 'post' && c[1] === 'build_failed');
  assert.ok(failed, 'the person is told, as for any failed build');
  assert.match(failed[2], /the platform restarted in the middle of each of its last 3 tries at building this/);
  const outcome = liveOutcome(pool);
  assert.deepEqual(outcome.slice(0, 2), [950, false]);
  assert.equal(outcome[2], 'the platform restarted in the middle of each of its last 3 tries at building this');
  assert.ok(!outcome[2].endsWith(bot.RESTARTED_BUILD_NOTE), 'the activity card stops on it rather than reading past it');
  // The count reads this request's earlier live builds, newest first, in the window.
  const lookup = pool.calls.find((c) => /SELECT build_error FROM homeroom_bot_runs/.test(c.sql));
  assert.match(lookup.sql, /mode = 'live' AND id < \$3/);
  assert.match(lookup.sql, /build_session_id IS NOT NULL/);
  assert.deepEqual(lookup.params, [5, 12, 950, 24, 2]);
});

test('a lost build after two sent back is stopped the same way', async () => {
  stubLive();
  const session = botSession();
  const pool = makePool({
    session, run: null, liveRun: LIVE_RUN,
    earlierBuilds: [sentBack('the spec turn was cut short'), sentBack('the spec turn was cut short')],
  });
  await adopt(pool, session, 'exited');
  assert.deepEqual(requeues(pool), []);
  assert.ok(liveCalls.some((c) => c[0] === 'post' && c[1] === 'build_failed'));
});

test('restarts that are not back to back still send the build round again', async () => {
  stubLive();
  journalTail = async () => ({ lastResultText: '', exitCode: 0 });
  const session = botSession({ active_turn: turn({ mode: 'scout' }) });
  const pool = makePool({
    session, run: null, liveRun: LIVE_RUN,
    // Newest first: one sent back, then a build that ended some other way.
    earlierBuilds: [sentBack('the spec turn was cut short'), { build_error: 'the build ran past its time limit' }],
  });
  await adopt(pool, session);
  assert.deepEqual(requeues(pool).map((c) => c.params), [[5, 12, 'restart']]);
  assert.deepEqual(liveCalls.filter((c) => c[0] === 'post'), [], 'nothing said: the fresh triage speaks');
  assert.ok(liveOutcome(pool)[2].endsWith(bot.RESTARTED_BUILD_NOTE));
});

test('an issue a restart sent back is not told "looking" a second time', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot'), 'utf8');
  assert.equal(bot.RESTART_REASON, 'restart');
  assert.match(src, /const looked = item\.reason === RESTART_REASON \|\| item\.reason === APP_AGAIN_REASON \? null : await live\.post\(\{\n\s+pool, github, ws: liveD\.ws, app, repo, issueNumber,\n\s+kind: 'looking'/);
});

// #1006, after the live stubs above.
test('a reaped live build is settled the way restart recovery settles one it could not follow', async () => {
  stubLive();
  const session = botSession();
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await bot.settleReapedTurn({ pool, config: {}, session });
  assert.deepEqual(requeues(pool).map((c) => c.params), [[5, 12, 'restart']], 'the issue goes back to be triaged');
});
