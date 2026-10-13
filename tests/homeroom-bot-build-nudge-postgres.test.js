'use strict';

// A build turn that changed nothing, and its nudge (homeroom-bot-live.js
// buildNudgePrompt), recorded against the FULL PostgreSQL schema: kept on
// its run before the nudge starts, completed by the outcome or by restart
// recovery, read by the console's runs query and left out of the CSV
// export; counted as `events` rows that hold no text.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const QUIT = Object.freeze({
  agentHarness: 'claude', ccExit: 0, exitCode: 0, pushOk: true, ahead: 0,
  routedProvider: 'GMICloud', providerTurnCount: 2, toolCallCount: 1, fileChangeCount: 0, outputTokens: 157,
  lastResultText: 'The plan is ready. Shall I go ahead?',
});
const BUILT = Object.freeze({
  agentHarness: 'claude', ccExit: 0, exitCode: 0, pushOk: true, ahead: 3, sha: 'a'.repeat(40),
  routedProvider: 'Together', providerTurnCount: 152, toolCallCount: 150, fileChangeCount: 29, outputTokens: 48000,
  lastResultText: 'Built it.',
});

test('a build turn that changed nothing is kept on its run and counted, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_nudge_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, the new column and its comment included

  const { rows: [{ comment }] } = await pool.query(
    `SELECT col_description('homeroom_bot_runs'::regclass, attnum) AS comment
       FROM pg_attribute WHERE attrelid = 'homeroom_bot_runs'::regclass AND attname = 'build_no_change'`,
  );
  assert.equal(comment, 'staging:private', 'what the agent said can quote a private project');

  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('hiking', 'hiking', 'running', 'https://github.com/usernode-bot/hiking')
     RETURNING id, slug`,
  );
  const newSession = async () => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, agent_model)
     VALUES ($1, $2, $3, 'paused', FALSE, '{}', 'z-ai/glm-5.3-flash') RETURNING *`,
    [app.id, botUser.id, `dev/homeroom_bot-${crypto.randomBytes(3).toString('hex')}`],
  )).rows[0];
  const newRun = async (sessionId, { lane = false } = {}) => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, build_session_id, build_at)
     VALUES ($1, 1, $2, 'ready', 'build it', $3, $4) RETURNING id`,
    [app.id, lane ? 'shadow' : 'live', sessionId, lane ? new Date() : null],
  )).rows[0].id;
  const kept = async (runId) => (await pool.query(
    'SELECT build_no_change, build_ok, build_error FROM homeroom_bot_runs WHERE id = $1', [runId],
  )).rows[0];
  const counted = async (sessionId) => (await pool.query(
    `SELECT event_type, metadata FROM events
      WHERE event_type IN ('bot_build_no_change', 'bot_build_nudged') AND session_id = $1 ORDER BY id`,
    [sessionId],
  )).rows;

  // A live build: its first turn's record kept before the nudge starts.
  const session = await newSession();
  const runId = await newRun(session.id);
  const first = {
    turns: [{ ...live.turnFacts({ routed: { result: QUIT } }, { turn: 'build', model: 'z-ai/glm-5.3-flash', seconds: 34 }), said: QUIT.lastResultText }],
    nudged: true, notNudged: null, committed: null,
  };
  await bot.keepNoChange(pool, runId, first);
  await live.recordNoChange(pool, {
    appId: app.id, sessionId: session.id, userId: botUser.id, issueNumber: 1,
    origin: { lane: 'live', runId }, noChange: first, which: 'first',
  });
  assert.deepEqual((await kept(runId)).build_no_change, first);

  // A restart catches the nudge, which built it: recovery completes the
  // record from what was kept, and counts the nudge.
  const merged = await bot.recoveredNoChange(pool, {
    runId, session, result: { ...BUILT }, component: live.BUILD_NUDGE_TELEMETRY,
    origin: { lane: 'live', runId }, appId: app.id, issueNumber: 1,
  });
  assert.deepEqual(merged.turns.map((x) => [x.turn, x.ended, x.said]), [
    ['build', 'no_change', QUIT.lastResultText], ['nudge', 'changed', null],
  ]);
  assert.equal(merged.committed, true);
  await bot.recordLiveBuild(pool, runId, { ok: true, sessionId: session.id, sha: BUILT.sha, commits: 3, noChange: merged });
  let row = await kept(runId);
  assert.equal(row.build_ok, true);
  assert.equal(row.build_no_change.committed, true);
  assert.equal(row.build_no_change.turns[1].provider, 'Together');
  // An outcome with none leaves what is there.
  await bot.recordLiveBuild(pool, runId, { ok: true, sessionId: session.id });
  assert.equal((await kept(runId)).build_no_change.committed, true);

  const events = await counted(session.id);
  assert.deepEqual(events.map((e) => [e.event_type, e.metadata.turn]), [
    ['bot_build_no_change', 'build'], ['bot_build_nudged', 'nudge'],
  ]);
  assert.equal(events[0].metadata.provider, 'GMICloud');
  assert.equal(events[0].metadata.requests, 2);
  assert.equal(events[0].metadata.nudged, true);
  assert.equal(events[0].metadata.lane, 'live');
  assert.equal(events[0].metadata.runId, runId);
  assert.equal(events[1].metadata.committed, true);
  assert.equal(events[1].metadata.recovered, true);
  for (const e of events) assert.ok(!JSON.stringify(e.metadata).includes('Shall I go ahead'), 'no text in a counter');

  // The rate per provider, the way a weekly query reads it.
  const { rows: rate } = await pool.query(
    `SELECT metadata->>'provider' AS provider, COUNT(*)::int AS quits
       FROM events WHERE event_type = 'bot_build_no_change' AND metadata->>'turn' = 'build'
      GROUP BY 1`,
  );
  assert.deepEqual(rate, [{ provider: 'GMICloud', quits: 1 }]);

  // The console's runs query reads it; the CSV export carries none of it.
  let exported = null;
  for await (const chunk of bot.iterateRunsForExport(pool, {})) { exported = chunk; break; }
  const listed = exported.find((r) => r.id === runId);
  assert.equal(listed.build_no_change.turns[0].said, QUIT.lastResultText);
  assert.ok(!bot.exportRow(listed).some((v) => String(v).includes('Shall I go ahead')));

  // The lane's own recovery of a build turn that changed nothing, which it
  // does not nudge: recorded on the run, with the outcome said as before.
  const laneSession = await newSession();
  const laneRun = await newRun(laneSession.id, { lane: true });
  const outcome = await bot.finishRecoveredTurn({
    pool, session: laneSession, activeTurn: { mode: 'build', telemetryComponent: 'homeroom_bot_build' },
    result: { ...QUIT },
  });
  assert.equal(outcome, 'shadow_failed');
  row = await kept(laneRun);
  assert.equal(row.build_ok, false);
  assert.equal(row.build_error, 'the build produced no change to propose (finished after a restart)');
  assert.equal(row.build_no_change.recovered, true);
  assert.equal(row.build_no_change.nudged, false);
  assert.equal(row.build_no_change.turns[0].said, QUIT.lastResultText);
  const laneEvents = await counted(laneSession.id);
  assert.deepEqual(laneEvents.map((e) => [e.event_type, e.metadata.lane, e.metadata.recovered]), [
    ['bot_build_no_change', 'shadow', true],
  ]);
});
