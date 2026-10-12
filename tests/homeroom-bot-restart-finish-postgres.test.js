'use strict';

// A restart no longer loses a finished build: restart recovery of a Homeroom
// bot build does what the live path does, against the FULL PostgreSQL schema
// and through server.js's own restart recovery.
//
// From 5 to 12 Oct 2026, 25 bot builds failed because the platform restarted
// under them, though each agent turn ran on in its worker and finished. What
// failed was recovery, which re-implemented only part of the live path:
//   - a commit whose push landed while the platform was down (push_ok=0,
//     ahead=1) was read as "the build produced no change to propose";
//   - a turn the bot's own clock had stopped (its journal ends in 143) was
//     read as the agent's own failure, "the agent exited with code 143";
//   - a build turn that changed nothing was failed, where the live path
//     nudges it once.
//
// The worker is a fake that writes a real journal: each turn's lines are
// written to a file, and the replay reads that file through the worker's own
// parser (parseLine, finalizeHarnessResult), as resumeTurnFromJournal does
// with a journal tailed from a live worker. The run rows, the session, its
// turn record, the snapshot and the events are real.
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

const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbot-journals-'));

// ── the fake worker ─────────────────────────────────────────────────────
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);

/** A turn's journal as the worker's runner writes it (run-cc.sh). */
function journalLines({ said = null, threadId = null, ahead = 0, sha = '', pushOk = 1, exit = 0, finished = true }) {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: threadId || 'thread-x' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } }),
  ];
  if (finished) {
    lines.push(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: said || 'Done.', session_id: threadId || 'thread-x',
    }));
    lines.push('__USERNODE_PHASE__ commit', '__USERNODE_PHASE__ push');
    lines.push(`__USERNODE_PHASE__ ${pushOk ? 'done' : 'push_failed'}`);
    lines.push(`__USERNODE_RESULT__ cc_exit=0 ahead=${ahead} behind=0 sha=${sha} push_ok=${pushOk} mode=build`);
  }
  lines.push(`__USERNODE_EXIT__ ${exit}`);
  return lines;
}

function writeJournal(name, opts) {
  const file = path.join(journalDir, `${name}.log`);
  fs.writeFileSync(file, `${journalLines(opts).join('\n')}\n`);
  return file;
}

/** Read a journal file as the worker reads one, through its own parser. */
function replay(file, harness = 'claude') {
  const state = realWorker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  state.agentHarness = harness;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    state.rawStdout += `${line}\n`;
    realWorker.parseLine(line, () => {}, state);
  }
  return realWorker.finalizeHarnessResult(state);
}

const pushes = [];
let pushAnswer = async () => ({ sha: null });
const dispatches = [];
let nudgeJournal = null;
require.cache[workerPath].exports = {
  ...realWorker,
  usesKubernetesWorkers: () => false,
  resumeTurnFromJournal: async (_sessionId, opts) => replay(opts.journal, opts.agentHarness || 'claude'),
  execPushFromWorker: async (sessionId, branch) => {
    pushes.push([sessionId, branch]);
    return pushAnswer(sessionId, branch);
  },
  // The nudge: a new turn in the same worker, whose journal is written here.
  execInWorker: async (sessionId, opts) => {
    dispatches.push({ sessionId, ...opts });
    return replay(writeJournal(`nudge-${sessionId}`, nudgeJournal));
  },
  ensureWorkerImage: async () => {},
  ensureWorker: async (sessionId) => `usernode-worker-${sessionId}`,
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
const live = require('../src/services/homeroom-bot-live');
const dm = require('../src/services/homeroom-bot-dm');
const snapshots = require('../src/services/homeroom-bot-snapshots');
const github = require('../src/services/github');
const agentTurn = require('../src/services/agent-turn');
const sessionsRoutes = require('../src/routes/sessions');
const managedKeys = require('../src/services/openrouter-managed-keys');

agentTurn.persistRecoveredAgentThread = async () => {};
agentTurn.settleRecoveredAgentAttempt = async () => null;
sessionsRoutes.resumeRecoveredCodexFreshRetry = async () => null;
managedKeys.usesIncludedKey = async () => false;
// The nudge's runtime: one attempt, dispatched to the worker as it is.
sessionsRoutes.runCodexAttemptLoop = async ({ dispatchOnce, resumeThreadId }) => ({
  result: await dispatchOnce({ agentHarness: 'claude', resumeSessionId: resumeThreadId }),
});

const BUDGET_MS = bot.DEFAULTS.turnSeconds * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test('restart recovery finishes a bot build the way the live path would have', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_finish_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const real = {
    post: live.post, mentionTargets: live.mentionTargets, botUsernameOf: live.botUsernameOf,
    prepareProposal: live.prepareProposal, promoteAsBot: live.promoteAsBot, postSpecOnProposal: live.postSpecOnProposal,
    fetchPublicIssue: github.fetchPublicIssue,
  };
  t.after(async () => {
    Object.assign(live, {
      post: real.post, mentionTargets: real.mentionTargets, botUsernameOf: real.botUsernameOf,
      prepareProposal: real.prepareProposal, promoteAsBot: real.promoteAsBot, postSpecOnProposal: real.postSpecOnProposal,
    });
    github.fetchPublicIssue = real.fetchPublicIssue;
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
    fs.rmSync(journalDir, { recursive: true, force: true });
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const posts = [];
  const promoted = [];
  live.post = async (args) => { posts.push(args); return { postId: posts.length }; };
  live.mentionTargets = async () => [];
  live.botUsernameOf = async () => 'usernode-bot';
  live.prepareProposal = async () => ({});
  live.postSpecOnProposal = async () => {};
  live.promoteAsBot = async ({ sessionId }) => { promoted.push(sessionId); return { status: 200, body: { ok: true, prNumber: 70 + promoted.length } }; };
  github.fetchPublicIssue = async (_o, _r, n) => ({ issue: { number: n, title: `Request ${n}`, state: 'open' } });

  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Page Turners', 'page-turners-30094f', 'running', $1)
     RETURNING id, slug, name, repo_url`,
    ['https://github.com/usernode-bot/page-turners-30094f'],
  );

  // A live build's session, its build turn in flight (`journal`, already
  // written: the turn finished while the platform was down), and its run.
  const build = async (issueNumber, journal, { startedAt = ago(60_000), extra = {} } = {}) => {
    const turnId = `turn-${crypto.randomBytes(4).toString('hex')}`;
    const activeTurn = {
      turnId, turnUuid: `uuid-${turnId}`, journal, phase: 'executing', mode: 'build',
      backend: 'codex_openrouter', harness: 'claude', model: 'z-ai/glm-5.3-flash', startedAt, attemptNumber: 1,
      ...extra,
    };
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, active_turn, spec_md, agent_model)
       VALUES ($1, $2, $3, 'active', FALSE, '{}', $4, '# Spec\n\nAdd a host column.', 'z-ai/glm-5.3-flash') RETURNING id, branch_name`,
      [app.id, botUser.id, `dev/homeroom_bot-${turnId}`, JSON.stringify(activeTurn)],
    );
    const { rows: [r] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, build_session_id)
       VALUES ($1, $2, 'live', 'ready', 'build it', $3) RETURNING id`,
      [app.id, issueNumber, s.id],
    );
    return { sessionId: s.id, runId: r.id, turnId, branch: s.branch_name };
  };
  const recover = (sessionId) => adoptOrphanWorker(
    { name: `usernode-worker-${sessionId}`, sessionId, state: 'running' },
    { config: {}, pool, staging: {}, ghub: {}, broadcastGlobal: () => {} },
  );
  const runRow = async (id) => (await pool.query(
    'SELECT build_ok, build_error, build_sha, build_commits, build_no_change FROM homeroom_bot_runs WHERE id = $1', [id],
  )).rows[0];
  const reset = () => {
    pushes.length = 0; dispatches.length = 0; posts.length = 0; promoted.length = 0;
    pushAnswer = async () => ({ sha: null });
  };
  const context = { appName: 'Page Turners', issueTitle: 'Display location and host information' };

  await t.test('(i) a commit the restart kept from being pushed is pushed from the worker, and proposed', async () => {
    reset();
    const sha = 'c'.repeat(40);
    pushAnswer = async () => ({ sha });
    const journal = writeJournal('push-caught', { said: 'Added the host column.', ahead: 1, sha, pushOk: 0 });
    const { sessionId, runId, branch } = await build(21, journal);
    await recover(sessionId);
    assert.deepEqual(pushes, [[sessionId, branch]], 'pushed once, from the worker, to the session branch');
    assert.deepEqual(promoted, [sessionId], 'proposed');
    const row = await runRow(runId);
    assert.equal(row.build_ok, true);
    assert.equal(row.build_error, null);
    assert.equal(row.build_sha, sha);
    assert.equal(row.build_commits, 1);
    assert.equal(posts.some((p) => p.kind === 'build_failed'), false, 'nothing said about a failure');
  });

  await t.test('(i) a commit that still cannot be pushed is a push failure, never "no change to propose"', async () => {
    reset();
    pushAnswer = async () => { throw Object.assign(new Error('git push: connection reset'), { code: 'push_failed' }); };
    const journal = writeJournal('push-lost', { ahead: 1, sha: 'd'.repeat(40), pushOk: 0 });
    const { sessionId, runId } = await build(22, journal);
    await recover(sessionId);
    assert.equal(pushes.length, 1);
    assert.deepEqual(promoted, []);
    const row = await runRow(runId);
    assert.equal(row.build_ok, false);
    assert.equal(row.build_error, 'couldn\'t push the build\'s commit (push_failed) (finished after a restart)');
    assert.equal(dispatches.length, 0, 'a push that did not go through is not nudged');
  });

  await t.test('(ii) a journal ending in 143 with the bot\'s own stop saved is the time-out it was', async () => {
    reset();
    // The turn the bot's clock stopped just before the restart: its journal
    // ends in the 143 the stop left, with no RESULT line.
    const journal = writeJournal('clock-stop', { finished: false, exit: 143 });
    const { sessionId, runId, turnId } = await build(23, journal);
    // What the clock saved before it stopped the turn (homeroom-bot-live.js).
    const stops = [];
    await live.stopOnClock(pool, { stopTurn: async (id) => { stops.push(id); return true; } }, sessionId);
    assert.deepEqual(stops, [sessionId]);
    const { rows: [{ active_turn: saved }] } = await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [sessionId]);
    assert.equal(saved.turnId, turnId);
    assert.equal(saved.botStop.why, 'time_limit');
    assert.ok(live.botStopOf(saved));
    assert.ok(live.failedClaudeTurn(replay(journal)), 'read alone, the journal says the agent failed');

    await recover(sessionId);
    const row = await runRow(runId);
    assert.equal(row.build_ok, false);
    assert.equal(row.build_error, 'the build ran past its time limit (finished after a restart)',
      'with the live path\'s wording, not "the agent exited with code 143"');
    const failed = posts.find((p) => p.kind === 'build_failed');
    assert.ok(failed);
    assert.equal(dm.dmText('build_failed', failed.dm, { ...context, issueNumber: 23 }).split('\n\n')[1],
      'I couldn\'t finish building this: it took longer than I\'m allowed. Reply here and I\'ll try again.');
  });

  await t.test('a journal ending in 143 with no saved stop is still the agent\'s failure', async () => {
    reset();
    const journal = writeJournal('agent-died', { finished: false, exit: 143 });
    const { sessionId, runId } = await build(24, journal);
    await recover(sessionId);
    assert.equal((await runRow(runId)).build_error, 'the build turn failed (the agent exited with code 143) (finished after a restart)');
  });

  await t.test('(iii) a recovered build that changed nothing, with time left, is nudged once, and the nudge proposed', async () => {
    reset();
    const journal = writeJournal('no-change', { said: 'Here is my plan: ...', threadId: 'thread-first', ahead: 0, pushOk: 1 });
    const { sessionId, runId, branch } = await build(25, journal);
    await snapshots.recordSnapshot(pool, {
      runId, stage: 'build', appId: app.id, issueNumber: 25,
      texts: { seed: 'Request #25: show who hosts each meeting.', build_note: 'build it', preset_spec: '' },
      extra: { model: 'z-ai/glm-5.3-flash', firstVersion: false, platformRepo: false },
    });
    const sha = 'e'.repeat(40);
    nudgeJournal = { said: 'Added it.', threadId: 'thread-first', ahead: 1, sha, pushOk: 1 };
    await recover(sessionId);

    assert.equal(dispatches.length, 1, 'one nudge');
    const [nudge] = dispatches;
    assert.equal(nudge.mode, 'build');
    assert.equal(nudge.resumeSessionId, 'thread-first', 'continuing the agent\'s own conversation');
    assert.equal(nudge.branchName, branch);
    assert.equal(nudge.telemetryComponent, live.BUILD_NUDGE_TELEMETRY);
    assert.match(nudge.prompt, /^The plan is approved\. You ended your turn without changing anything/);
    assert.match(nudge.resumeFallbackPrompt, /Request #25: show who hosts each meeting\./,
      'with the whole build prompt, should the conversation not continue');
    assert.deepEqual(promoted, [sessionId], 'what the nudge built is proposed');
    const row = await runRow(runId);
    assert.equal(row.build_ok, true);
    assert.equal(row.build_sha, sha);
    assert.equal(row.build_no_change.nudged, true);
    assert.equal(row.build_no_change.committed, true);
    assert.deepEqual(row.build_no_change.turns.map((x) => [x.turn, x.ended]), [['build', 'no_change'], ['nudge', 'changed']]);
    const { rows: counted } = await pool.query(
      `SELECT event_type AS type FROM events WHERE session_id = $1 AND event_type IN ('bot_build_no_change', 'bot_build_nudged') ORDER BY id`, [sessionId],
    );
    assert.deepEqual(counted.map((e) => e.type), ['bot_build_no_change', 'bot_build_nudged'], 'counted as the live path counts them');
  });

  await t.test('(iii) a shadow build is nudged the same way, once its session is free, and recorded built', async () => {
    reset();
    const journal = writeJournal('shadow-no-change', { threadId: 'thread-shadow', ahead: 0, pushOk: 1 });
    const { sessionId, runId } = await build(27, journal);
    await pool.query("UPDATE homeroom_bot_runs SET mode = 'shadow', build_at = NOW() WHERE id = $1", [runId]);
    await snapshots.recordSnapshot(pool, {
      runId, stage: 'build', appId: app.id, issueNumber: 27, texts: { seed: 'Request #27.', build_note: '', preset_spec: '' },
    });
    const sha = 'f'.repeat(40);
    nudgeJournal = { threadId: 'thread-shadow', ahead: 2, sha, pushOk: 1 };
    await recover(sessionId);
    assert.equal(dispatches.length, 1, 'one nudge');
    assert.equal(dispatches[0].resumeSessionId, 'thread-shadow');
    assert.deepEqual(promoted, [], 'a shadow build is never proposed');
    const row = await runRow(runId);
    assert.equal(row.build_ok, true);
    assert.equal(row.build_sha, sha);
    assert.equal(row.build_commits, 2);
    assert.deepEqual(row.build_no_change.turns.map((x) => [x.turn, x.ended]), [['build', 'no_change'], ['nudge', 'changed']]);
    const { rows: [s] } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [sessionId]);
    assert.equal(s.status, 'archived', 'put away once it is recorded');
  });

  await t.test('a recovered build that changed nothing with too little time left is not nudged, and says why', async () => {
    reset();
    const journal = writeJournal('no-change-late', { ahead: 0, pushOk: 1 });
    // Its clock gives back one restart's time, less than a nudge needs.
    const { sessionId, runId } = await build(26, journal, { startedAt: ago(BUDGET_MS) });
    await recover(sessionId);
    assert.equal(dispatches.length, 0);
    const row = await runRow(runId);
    assert.equal(row.build_error, 'the build produced no change to propose (finished after a restart)');
    assert.equal(row.build_no_change.nudged, false);
    assert.match(row.build_no_change.notNudged, /minutes of its clock were left/);
  });
});
