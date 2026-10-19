'use strict';

// A restart no longer loses a finished build, against the FULL PostgreSQL
// schema: server.js's restart recovery leaves a durable build's worker to
// its build, and the build's next attempt follows the turn the restart
// caught and reads it the way the live path reads a turn it ran itself.
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
// That recovery is gone. A build is a durable build on the workflow kernel
// (docs/plans/bot-build-workflow.md): its session carries `workflow_owner`,
// which server.js reads against the build's instance, and the same pipeline
// (homeroom-bot-live.js buildAndPropose) runs again after the restart,
// on a durable context whose build turn was under way when the restart
// came. Its turn step follows the turn (services/durable-turn.js) and hands
// the pipeline what the live path would have had.
//
// The worker is a fake that writes a real journal: each turn's lines are
// written to a file, and the replay reads that file through the worker's own
// parser (parseLine, finalizeHarnessResult), as resumeTurnFromJournal does
// with a journal tailed from a live worker. The sessions, their turn
// records, the build's instance, the restart count, the clock's saved stop
// and the events are real.
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

const calls = [];
// The database finishTurn clears a turn's record in, as the real one does
// (the proposal machine never rests a session under a turn record).
let turnPool = null;
const pushes = [];
let pushAnswer = async () => ({ sha: null });
const dispatches = [];
let nudgeJournal = null;
const fakeWorker = {
  ...realWorker,
  usesKubernetesWorkers: () => false,
  // The turn the restart caught, followed through its journal.
  resumeTurnFromJournal: async (sessionId, opts) => {
    calls.push(['resume', sessionId]);
    return replay(opts.journal, opts.agentHarness || 'claude');
  },
  execPushFromWorker: async (sessionId, branch) => {
    pushes.push([sessionId, branch]);
    return pushAnswer(sessionId, branch);
  },
  // A new turn in the same worker (the spec, the nudge), its journal written here.
  execInWorker: async (sessionId, opts) => {
    if (opts.mode === 'scout') return { lastResultText: '' };
    dispatches.push({ sessionId, ...opts });
    return replay(writeJournal(`nudge-${sessionId}`, nudgeJournal));
  },
  ensureWorkerImage: async () => {},
  ensureWorker: async (sessionId) => `usernode-worker-${sessionId}`,
  stopTurn: async (sessionId) => { calls.push(['stopTurn', sessionId]); return true; },
  finishTurn: async (sessionId) => {
    calls.push(['finishTurn', sessionId]);
    if (turnPool) await turnPool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [sessionId]);
    return true;
  },
  markTurnTail: async () => true,
  noteTailMilestone: async () => true,
  clearActiveTurn: async (sessionId) => { calls.push(['clearActiveTurn', sessionId]); return true; },
  adoptWarmWorker: (sessionId) => { calls.push(['adoptWarmWorker', sessionId]); },
  destroyWorker: async (name) => { calls.push(['destroyWorker', name]); },
  isWorkerExecuting: async () => true,
  getTurnByokCents: () => 0,
  getPendingStop: () => null,
};
require.cache[workerPath].exports = fakeWorker;
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
const durableSteps = require('../src/services/durable-steps');
const agentTurn = require('../src/services/agent-turn');

// A turn recovery stops has its ledger attempt closed; the attempts here
// are not in the ledger, so the close is recorded instead.
const abandoned = [];
agentTurn.completeCodexAttempt = async ({ turnUuid, errorCode }) => { abandoned.push({ turnUuid, errorCode }); return { updated: true }; };

const BUDGET_MS = bot.DEFAULTS.turnSeconds * 1000;
const MODEL = 'z-ai/glm-5.3-flash';
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test('a restart no longer loses a finished bot build: recovery leaves it to its build, which reads its turn as the live path does', { timeout: 120000 }, async (t) => {
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
  // A session's rest and close are the proposal machine's moves
  // (session-lifecycle's restSession and closeOwnSession): the workflow
  // runtime runs here, on this database, its pipeline only (no timers, no
  // work).
  const platform = require('../src/workflow/platform.ts');
  require('../src/db/pool').getPool = () => pool;
  turnPool = pool;
  t.after(async () => {
    bot._resetForTests();
    turnPool = null;
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
    fs.rmSync(journalDir, { recursive: true, force: true });
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await platform.startWorkflow({ databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2 }, { loops: false });

  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Page Turners', 'page-turners-30094f', 'running', $1)
     RETURNING id, slug, name, repo_url, self_hosted`,
    ['https://github.com/usernode-bot/page-turners-30094f'],
  );
  const REPO = { owner: 'usernode-bot', repo: 'page-turners-30094f' };
  const reset = () => {
    calls.length = 0; pushes.length = 0; dispatches.length = 0; abandoned.length = 0;
    pushAnswer = async () => ({ sha: null });
    nudgeJournal = null;
  };
  const turnOf = (journal, extra = {}) => {
    const turnId = `turn-${crypto.randomBytes(4).toString('hex')}`;
    return {
      turnId, turnUuid: `uuid-${turnId}`, journal, phase: 'executing', mode: 'build',
      backend: 'codex_openrouter', harness: 'claude', model: MODEL, startedAt: ago(60_000), attemptNumber: 1,
      ...extra,
    };
  };
  const sessionRow = async (id) => (await pool.query('SELECT status, active_turn, workflow_owner FROM chat_sessions WHERE id = $1', [id])).rows[0];
  // The build's instance on the bot-build machine, written as the kernel
  // writes it (only the transition pipeline may).
  const instance = async (key, state) => pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
    INSERT INTO wf_instances (machine, key, app_id, state, data, machine_version)
      VALUES ('bot-build', '${key}', ${Number(app.id)}, '${state}', '{"target":"live"}', 1)
      ON CONFLICT (machine, key) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW();
    COMMIT`);

  // ── server.js's restart recovery ──────────────────────────────────────

  await t.test('server.js leaves a durable build\'s worker to its build while the build is under way, and only then', async () => {
    reset();
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note) VALUES ($1, 20, 'live', 'ready', 'build it') RETURNING id`,
      [app.id],
    );
    const key = `run:${run.id}`;
    const activeTurn = turnOf(writeJournal('owned', { ahead: 1, sha: 'a'.repeat(40) }));
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, active_turn, workflow_owner)
       VALUES ($1, $2, 'dev/homeroom_bot-owned', 'active', FALSE, '{}', $3, $4) RETURNING id`,
      [app.id, botUser.id, JSON.stringify(activeTurn), `bot-build/${key}`],
    );
    await instance(key, 'building');
    const recover = () => adoptOrphanWorker(
      { name: `usernode-worker-${s.id}`, sessionId: s.id, state: 'running' },
      { config: {}, pool, staging: {}, ghub: {}, broadcastGlobal: () => {} },
    );
    await recover();
    assert.deepEqual(calls, [['adoptWarmWorker', s.id]], 'its worker is kept, and nothing else is done to it');
    const kept = await sessionRow(s.id);
    assert.equal(kept.status, 'active');
    assert.equal(kept.active_turn.turnId, activeTurn.turnId, 'its turn record is the build\'s to follow');
    assert.deepEqual(abandoned, []);

    // Once its build has ended, the session is no build's: what is left on
    // it is stopped, and the session put to rest.
    reset();
    await instance(key, 'failed');
    await recover();
    assert.deepEqual(calls.map((c) => c[0]), ['adoptWarmWorker', 'stopTurn', 'finishTurn']);
    assert.deepEqual(abandoned, [{ turnUuid: activeTurn.turnUuid, errorCode: 'recovery_abandoned' }]);
    assert.equal((await sessionRow(s.id)).status, 'paused');
  });

  // ── The build's next attempt ──────────────────────────────────────────

  const deps = {
    worker: fakeWorker,
    sessions: {
      async runCodexAttemptLoop(args) {
        // The spec turn writes nothing: the build goes on from the plan.
        if (args.mode === 'scout') return { result: await args.dispatchOnce({}), error: null };
        return { result: await args.dispatchOnce({ agentHarness: 'claude', resumeSessionId: args.resumeThreadId }), error: null };
      },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: {
      async resolveCodexRuntimeContext() { return {}; },
      async persistRecoveredAgentThread() {},
      async settleRecoveredAgentAttempt() { return { estimatedCost: { estimatedCostUsd: 0.3 } }; },
    },
    sessionLifecycle: {
      async ensureSessionBranch({ sessionId }) {
        const branchName = `dev/homeroom_bot-s${sessionId}`;
        await pool.query('UPDATE chat_sessions SET branch_name = $2 WHERE id = $1', [sessionId, branchName]);
        return { branchName };
      },
    },
    activeWorkers: new Set(),
    votesRouter: (() => {
      const router = require('express').Router();
      router.post('/api/sessions/:id/promote', (req, res) => { proposed.push(Number(req.params.id)); res.json({ ok: true, prNumber: 70 + proposed.length }); });
      return router;
    })(),
    seesImages: false,
  };
  const proposed = [];

  /**
   * The pipeline run again after a restart, as the build's work item runs
   * it on its next claim: its build turn (`journal`) was dispatched by the
   * attempt before, which saved it as under way, and its record is on the
   * session. `clockAgoMs` is when the build's clock started; `botStop` that
   * the clock had stopped the turn before the restart.
   */
  const carriedOn = async (issueNumber, journal, { clockAgoMs = 60_000, botStop = false, propose = true } = {}) => {
    const activeTurn = turnOf(journal, { startedAt: ago(clockAgoMs) });
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note) VALUES ($1, $2, $3, 'ready', 'build it') RETURNING id`,
      [app.id, issueNumber, propose ? 'live' : 'shadow'],
    );
    const saves = [];
    const steps = durableSteps.durable({
      resumeFrom: {
        build_clock: Date.now() - clockAgoMs,
        'turn:build': {
          phase: 'started', mode: 'build', deadlineAt: Date.now() - clockAgoMs + BUDGET_MS, headBefore: null,
          record: { turnId: activeTurn.turnId, journal },
        },
      },
      checkpoint: async (v) => { saves.push(v); },
      signal: new AbortController().signal,
      owner: `bot-build/run:${run.id}`,
    });
    let sessionId = null;
    const out = await live.buildAndPropose({
      pool, config: {}, bot: botUser, app, repo: REPO, issueNumber, issue: { title: `Request ${issueNumber}` },
      seed: `Request #${issueNumber}: show who hosts each meeting.`, buildNote: 'build it',
      turnBudgetMs: BUDGET_MS, model: MODEL, propose, origin: { lane: propose ? 'live' : 'shadow', runId: run.id },
      // The turn the attempt before dispatched, on the session it opened.
      onSession: async (session) => {
        sessionId = Number(session.id);
        await pool.query('UPDATE chat_sessions SET active_turn = $2 WHERE id = $1', [session.id, JSON.stringify(activeTurn)]);
        if (botStop) {
          // What the bot's clock saved as it stopped the turn (homeroom-bot-live.js stopOnClock).
          await live.stopOnClock(pool, { stopTurn: async () => true }, session.id);
          assert.ok(live.botStopOf((await sessionRow(session.id)).active_turn));
        }
      },
      deps: { ...deps, durable: steps },
    });
    return { out, sessionId, runId: run.id, saves, turnId: activeTurn.turnId };
  };
  const followed = (sessionId) => calls.filter((c) => c[0] === 'resume' && c[1] === sessionId).length;

  await t.test('(i) a commit the restart kept from being pushed is pushed from the worker, and proposed', async () => {
    reset();
    const sha = 'c'.repeat(40);
    pushAnswer = async () => ({ sha });
    const journal = writeJournal('push-caught', { said: 'Added the host column.', ahead: 1, sha, pushOk: 0 });
    const { out, sessionId, runId, saves, turnId } = await carriedOn(21, journal);
    assert.equal(followed(sessionId), 1, 'the turn was followed, not dispatched again');
    assert.equal(dispatches.length, 0);
    assert.deepEqual(pushes, [[sessionId, `dev/homeroom_bot-s${sessionId}`]], 'pushed once, from the worker, to the session branch');
    assert.equal(out.ok, true, out.error);
    assert.equal(out.sha, sha);
    assert.equal(out.commits, 1);
    assert.deepEqual(proposed.slice(-1), [sessionId], 'proposed');
    const kept = saves.find((v) => v['turn:build']?.phase === 'done')['turn:build'];
    assert.deepEqual(kept.record, { turnId, journal }, 'the followed turn\'s result is kept, under its record');
    assert.equal(kept.out.routed.result.repushed, true);
    assert.equal((await sessionRow(sessionId)).workflow_owner, `bot-build/run:${runId}`,
      'the session carries the build that owns it, which server.js reads');
  });

  await t.test('(i) a commit that still cannot be pushed is a push failure, never "no change to propose"', async () => {
    reset();
    pushAnswer = async () => { throw Object.assign(new Error('git push: connection reset'), { code: 'push_failed' }); };
    const journal = writeJournal('push-lost', { ahead: 1, sha: 'd'.repeat(40), pushOk: 0 });
    const before = proposed.length;
    const { out, sessionId } = await carriedOn(22, journal);
    assert.equal(pushes.length, 1);
    assert.equal(proposed.length, before, 'not proposed');
    assert.equal(dispatches.length, 0, 'a push that did not go through is not nudged');
    assert.equal(out.ok, false);
    assert.match(out.error, /^couldn't push the build's commit \(push_failed\)/,
      'the build\'s commit is in its worker: its push failed, it did not come to nothing');
    assert.equal((await sessionRow(sessionId)).status, 'archived');
  });

  await t.test('(ii) a journal ending in 143 with the bot\'s own stop saved is the time-out it was', async () => {
    reset();
    // The turn the bot's clock stopped just before the restart: its journal
    // ends in the 143 the stop left, with no RESULT line.
    const journal = writeJournal('clock-stop', { finished: false, exit: 143 });
    assert.ok(live.failedClaudeTurn(replay(journal)), 'read alone, the journal says the agent failed');
    const { out, sessionId } = await carriedOn(23, journal, { botStop: true });
    assert.equal(followed(sessionId), 1);
    assert.equal(out.ok, false);
    assert.match(out.error, /^the build ran past its time limit/, 'with the live path\'s wording, not "the agent exited with code 143"');
    assert.equal(dm.buildFailedWords(out.error), 'I couldn\'t finish building this: it took longer than I\'m allowed.',
      'and its person is told so');
    assert.equal(dispatches.length, 0, 'a turn its clock stopped is not nudged');
  });

  await t.test('a journal ending in 143 with no saved stop is still the agent\'s failure', async () => {
    reset();
    const journal = writeJournal('agent-died', { finished: false, exit: 143 });
    const { out } = await carriedOn(24, journal);
    assert.equal(out.ok, false);
    assert.match(out.error, /^the build turn failed \(the agent exited with code 143\)/);
  });

  await t.test('(iii) a followed build that changed nothing, with time left, is nudged once, and the nudge proposed', async () => {
    reset();
    const journal = writeJournal('no-change', { said: 'Here is my plan: ...', threadId: 'thread-first', ahead: 0, pushOk: 1 });
    const sha = 'e'.repeat(40);
    nudgeJournal = { said: 'Added it.', threadId: 'thread-first', ahead: 1, sha, pushOk: 1 };
    const { out, sessionId } = await carriedOn(25, journal);

    assert.equal(followed(sessionId), 1);
    assert.equal(dispatches.length, 1, 'one nudge');
    const [nudge] = dispatches;
    assert.equal(nudge.mode, 'build');
    assert.equal(nudge.resumeSessionId, 'thread-first', 'continuing the agent\'s own conversation, as the followed turn reported it');
    assert.equal(nudge.branchName, `dev/homeroom_bot-s${sessionId}`);
    assert.equal(nudge.telemetryComponent, live.BUILD_NUDGE_TELEMETRY);
    assert.match(nudge.prompt, /^The plan is approved\. You ended your turn without changing anything/);
    assert.match(nudge.resumeFallbackPrompt, /Request #25: show who hosts each meeting\./,
      'with the whole build prompt, should the conversation not continue');
    assert.equal(out.ok, true, out.error);
    assert.equal(out.sha, sha);
    assert.deepEqual(proposed.slice(-1), [sessionId], 'what the nudge built is proposed');
    assert.equal(out.noChange.nudged, true);
    assert.equal(out.noChange.committed, true);
    assert.deepEqual(out.noChange.turns.map((x) => [x.turn, x.ended]), [['build', 'no_change'], ['nudge', 'changed']]);
    const { rows: counted } = await pool.query(
      `SELECT event_type AS type FROM events WHERE session_id = $1 AND event_type IN ('bot_build_no_change', 'bot_build_nudged') ORDER BY id`, [sessionId],
    );
    assert.deepEqual(counted.map((e) => e.type), ['bot_build_no_change', 'bot_build_nudged'], 'counted as the live path counts them');
  });

  await t.test('a followed build that changed nothing with too little of its clock left is not nudged, and says why', async () => {
    reset();
    const journal = writeJournal('no-change-late', { ahead: 0, pushOk: 1 });
    // Its clock started a whole budget ago: what is left is less than a nudge needs.
    const { out } = await carriedOn(26, journal, { clockAgoMs: BUDGET_MS });
    assert.equal(dispatches.length, 0);
    assert.equal(out.ok, false);
    assert.equal(out.error, 'the build produced no change to propose');
    assert.equal(out.noChange.nudged, false);
    assert.match(out.noChange.notNudged, /minutes of its clock were left/);
  });
});
