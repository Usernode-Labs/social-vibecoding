'use strict';

// A build turn that deploys land in keeps the time they cost it, against
// the FULL PostgreSQL schema.
//
// Page Turners #3 (5 Oct 2026): its build turn started about 12:31; four
// platform PRs merged between 12:33 and 12:41, each deployed, and each new
// server followed the build's journal. The bot's clock was the turn's start
// plus its budget, counted across every restart, so the last one's clock
// ended the turn at 12:51 and the run was recorded as "the build ran past
// its time limit (finished after a restart)".
//
// #3895 answered that by sending such a build round again from the start.
// On 7 Oct 2026 two requests were each built three times that way: the
// worker had run on through every restart, and each try was stopped at the
// same 20-minute clock. Now each restart that reaches the turn is counted on
// its record (turn-lifecycle noteRestart) and gives the clock back
// RESTART_ALLOWANCE_MS, which is what a restart costs a worker that runs on;
// a turn whose clock still runs out ran too long on its own.
//
// A build is a durable build now (docs/plans/bot-build-workflow.md): the
// step that runs a turn saves its deadline before it dispatches it, and the
// build's next attempt, after a restart, follows the turn it caught
// (services/durable-turn.js runTurn), its clock re-armed from that deadline
// plus what the restarts counted on the record give back. These drive that
// next attempt. The worker is stubbed (the journal runs until the bot's
// clock stops it, or ends on its own); the session, its turn record, the
// restart count and the stop the clock saves on it are real.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const durableSteps = require('../src/services/durable-steps');
const durableTurn = require('../src/services/durable-turn');
const turnLifecycle = require('../src/services/turn-lifecycle');
const live = require('../src/services/homeroom-bot-live');
const bot = require('../src/services/homeroom-bot');

const BUDGET_MS = bot.DEFAULTS.turnSeconds * 1000;
const ALLOWANCE_MS = bot.RESTART_ALLOWANCE_MS;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// The ledger and the agent thread are settled as for any followed turn;
// what they do is covered elsewhere.
const agentTurn = {
  async persistRecoveredAgentThread() {},
  async settleRecoveredAgentAttempt() { return { estimatedCost: { estimatedCostUsd: 0.2 } }; },
  async completeCodexAttempt() {},
};

test('a build turn keeps the time restarts cost it; one that still runs out ran too long on its own', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_restart_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Page Turners', 'page-turners-30094f', 'running', $1)
     RETURNING id, slug, name, repo_url`,
    ['https://github.com/usernode-bot/page-turners-30094f'],
  );

  // A build's session, its turn in flight since `startedAt` (the restarts
  // that reached it before this one counted on it).
  const build = async (startedAt, { restarts = null } = {}) => {
    const turnId = `turn-${crypto.randomBytes(4).toString('hex')}`;
    const journal = `/journals/${turnId}.log`;
    const activeTurn = {
      turnId, turnUuid: `uuid-${turnId}`, journal, phase: 'executing', mode: 'build',
      backend: 'codex_openrouter', model: 'z-ai/glm-5.3-flash', startedAt, attemptNumber: 1,
      ...(restarts == null ? {} : { restarts }),
    };
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, active_turn)
       VALUES ($1, $2, $3, 'active', FALSE, '{}', $4) RETURNING id, branch_name`,
      [app.id, botUser.id, `dev/homeroom_bot-${turnId}`, JSON.stringify(activeTurn)],
    );
    return { session: { id: s.id, branch_name: s.branch_name, repo_url: app.repo_url }, turnId, journal };
  };
  const restartsOf = async (id) => (await pool.query(
    `SELECT (active_turn->>'restarts')::int AS n FROM chat_sessions WHERE id = $1`, [id],
  )).rows[0].n;
  const recordOf = async (id) => (await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [id])).rows[0].active_turn;

  // The worker: its turn, still running, until the bot's clock stops it
  // (or `endsAfterMs`, when it finishes on its own).
  const worker = ({ onFollow = null, endsAfterMs = null } = {}) => {
    const calls = { stops: [], stopTimes: [], followedAt: 0, finished: [] };
    let onStop = null;
    return {
      calls,
      async resumeTurnFromJournal(sessionId) {
        calls.followedAt = Date.now();
        if (onFollow) await onFollow(sessionId);
        return new Promise((resolve) => {
          onStop = () => resolve({ exitCode: 143, pushOk: false, ahead: 0 });
          if (endsAfterMs != null) setTimeout(() => resolve({ exitCode: 0, pushOk: true, ahead: 1, sha: 'e'.repeat(40) }), endsAfterMs);
        });
      },
      async stopTurn(sessionId) { calls.stops.push(sessionId); calls.stopTimes.push(Date.now()); onStop?.(); return true; },
      async markTurnTail() {},
      async finishTurn(sessionId, ids) { calls.finished.push([sessionId, ids.turnId]); return true; },
    };
  };
  // The build's next attempt, carried on from the step it saved before the
  // restart: its turn started, its deadline and its record kept.
  const nextAttempt = (saved) => {
    const saves = [];
    const steps = durableSteps.durable({
      resumeFrom: { 'turn:build': { phase: 'started', mode: 'build', headBefore: null, ...saved } },
      checkpoint: async (v) => { saves.push(v); },
      signal: new AbortController().signal,
    });
    return { steps, saves };
  };
  const follow = ({ steps, session, w, budgetMs = BUDGET_MS }) => durableTurn.runTurn(steps, 'build', {
    pool, session, mode: 'build', budgetMs, deps: { worker: w, agentTurn },
    stop: () => live.stopOnClock(pool, w, session.id),
    dispatch: async () => { throw new Error('a turn a restart caught is never dispatched again'); },
  });

  await t.test('issue #9, 7 Oct: the fourth restart gives the turn back the time all four cost it', async () => {
    // Three restarts had reached it before this one: without their time it
    // would be minutes past its clock and stopped at once. With it, the
    // clock has LEFT_MS left (both outcomes read the same, so the wait is
    // what tells them apart).
    const LEFT_MS = 3000;
    let restartsSeen = null;
    const w = worker({ onFollow: async (id) => { restartsSeen = await restartsOf(id); } });
    const { session, turnId, journal } = await build(ago(BUDGET_MS + 4 * ALLOWANCE_MS - LEFT_MS), { restarts: 3 });
    const { steps, saves } = nextAttempt({ deadlineAt: Date.now() - 4 * ALLOWANCE_MS + LEFT_MS, record: { turnId, journal } });
    const t0 = Date.now();
    const out = await follow({ steps, session, w });
    assert.equal(restartsSeen, 4, 'this restart counted on the turn before its clock was read');
    assert.equal(out.followed, true, 'followed through its journal, not started again');
    assert.deepEqual(w.calls.stops, [session.id], 'the bot\'s clock still ends the turn');
    assert.ok(w.calls.stopTimes[0] - w.calls.followedAt >= LEFT_MS / 2,
      `followed until its clock ran out, not stopped at once (${w.calls.stopTimes[0] - w.calls.followedAt} ms)`);
    assert.ok(Date.now() - t0 < 60_000, 'at the turn\'s own deadline: the restarts did not re-arm a fresh budget');
    assert.equal(out.stopped, true, 'its own time ran out: the build says it ran past its time limit');
    assert.equal((await recordOf(session.id)).botStop.why, 'time_limit', 'and the clock\'s stop is saved on the turn\'s record');
    const done = saves.at(-1)['turn:build'];
    assert.equal(done.phase, 'done');
    assert.equal(done.out.stopped, true, 'kept as stopped, for any attempt after this one');
    assert.deepEqual(w.calls.finished, [[session.id, turnId]], 'its record released once its result was kept');
  });

  await t.test('a restart is counted on its own turn only, and the count survives the turn\'s phase changes', async () => {
    const { session: { id: sessionId }, turnId } = await build(ago(0));
    assert.equal(await turnLifecycle.noteRestart(pool, { sessionId, turnId }), 1);
    assert.equal(await turnLifecycle.noteRestart(pool, { sessionId, turnId }), 2);
    await turnLifecycle.markTailPending(pool, { sessionId, turnId });
    assert.equal(await restartsOf(sessionId), 2, 'a phase change merges into the record: the count stays');
    assert.equal(await turnLifecycle.noteRestart(pool, { sessionId, turnId }), 3);
    assert.equal(await turnLifecycle.noteRestart(pool, { sessionId, turnId: 'turn-another' }), null,
      'a restart that finds another turn there counts nothing on it');
    assert.equal(await restartsOf(sessionId), 3);
    assert.equal(await turnLifecycle.noteRestart(pool, { sessionId, turnId: null }), null);
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [sessionId]);
    assert.equal(await turnLifecycle.noteRestart(pool, { sessionId, turnId }), null, 'no turn, nothing counted');
  });

  await t.test('a turn whose time was up before any restart reached it ran too long on its own', async () => {
    const w = worker();
    const { session, turnId, journal } = await build(ago(BUDGET_MS + 5 * 60 * 1000));
    const { steps } = nextAttempt({ deadlineAt: Date.now() - 5 * 60 * 1000, record: { turnId, journal } });
    const t0 = Date.now();
    const out = await follow({ steps, session, w });
    assert.equal(await restartsOf(session.id), 1);
    assert.deepEqual(w.calls.stops, [session.id], 'stopped at once: its time, and this restart\'s two minutes, were already up');
    assert.ok(Date.now() - t0 < 10_000);
    assert.equal(out.stopped, true);
    assert.equal(out.followed, true, 'not sent round again from the start');
  });

  await t.test('a first version keeps its doubled clock across a restart: the clock is the deadline its step saved', async () => {
    // Started 25 minutes ago: past a plain build's budget and this restart's
    // two minutes, so a clock rebuilt from the record's start would stop it
    // at once (5 Oct 2026: a restart halved a first version's clock). Its
    // step saved the deadline its doubled budget gave it; the next attempt
    // is run with the plain budget, and the turn finishes on its own.
    assert.equal(bot.FIRST_VERSION_BUILD_TIME_FACTOR, 2);
    const startedAt = ago(BUDGET_MS + 5 * 60 * 1000);
    const w = worker({ endsAfterMs: 300 });
    const { session, turnId, journal } = await build(startedAt);
    const { steps } = nextAttempt({
      deadlineAt: Date.parse(startedAt) + BUDGET_MS * bot.FIRST_VERSION_BUILD_TIME_FACTOR,
      record: { turnId, journal },
    });
    const out = await follow({ steps, session, w });
    assert.deepEqual(w.calls.stops, [], 'not stopped: its own deadline is a quarter of an hour away');
    assert.equal(out.stopped, false);
    assert.equal(out.routed.result.sha, 'e'.repeat(40), 'what it built is its result');
  });
});
