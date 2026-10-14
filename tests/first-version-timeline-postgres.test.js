'use strict';

// A first version's recorded timings against the real schema (newcomer run
// five, 13 October 2026): its timeline rows (services/first-version-timeline.js,
// events 'first_version_stage') for its maker and project, and none for a
// run that is not a first version; when it went ahead (go_ahead_at, which
// the build's start leaves) and how long it then waited for its slot
// (claimLiveBuild's waitedMs); its plan written at Make it and by the triage;
// its merge and the moment it was live (homeroom-bot-dm.js
// noteProposalMerged); and the shape of a plan reply that could not be used
// (homeroom_bot_first_versions.early_plan_reply), never its words.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/first-version-timeline-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

let pool = null;
require('../src/db/pool').getPool = () => pool;

const bot = require('../src/services/homeroom-bot');
const dm = require('../src/services/homeroom-bot-dm');
const timeline = require('../src/services/first-version-timeline');
const fvPlan = require('../src/services/first-version-plan');

test('a first version\'s timings are recorded where a run report reads them', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `fv_timeline_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  // The schema is idempotent: the new columns survive a second apply.
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [username],
  )).rows[0];
  const maker = await user('alex_t1013');
  const other = await user('sam_t1013');
  const app = async (slug, by) => (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by) VALUES ($1, $1, 'running', $2) RETURNING id, slug, name`,
    [slug, by.id],
  )).rows[0];
  const clubVotes = await app('club-votes', maker);
  const older = await app('older-project', other);
  await pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds, status, issue_number)
     VALUES ($1, $2, 'Polls for the club', TRUE, 'filed', 1)`,
    [clubVotes.id, maker.id],
  );
  const run = async (appId, issue, fields = {}) => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, awaiting_go_at, plan)
     VALUES ($1, $2, $3, 'ready', $4, $5::jsonb) RETURNING id`,
    [appId, issue, fields.mode || 'live', fields.awaiting || null, JSON.stringify(fields.plan || null)],
  )).rows[0].id;
  const stages = async (appId) => (await pool.query(
    `SELECT user_id, app_id, session_id, metadata FROM events
      WHERE event_type = 'first_version_stage' AND app_id = $1 ORDER BY id`,
    [appId],
  )).rows;

  await t.test('a stage is a row for the first version\'s maker and project; any other run writes none', async () => {
    const first = await run(clubVotes.id, 1);
    const later = await run(clubVotes.id, 2);
    const shadow = await run(clubVotes.id, 1, { mode: 'shadow' });
    const elsewhere = await run(older.id, 1);
    assert.equal(await timeline.record(pool, { runId: first, stage: 'build_started', detail: { partial: false, note: 'Free text is left out' } }), true);
    assert.equal(await timeline.record(pool, { runId: later, stage: 'build_started' }), false, 'a later request on the project');
    assert.equal(await timeline.record(pool, { runId: shadow, stage: 'build_started' }), false, 'a shadow build of it');
    assert.equal(await timeline.record(pool, { runId: elsewhere, stage: 'build_started' }), false, 'a project with no first version');
    assert.equal(await timeline.record(pool, { runId: first, stage: 'not_a_stage' }), false);
    assert.equal(await timeline.record(pool, { runId: first, stage: 'review_round', sessionId: 999999 }), false,
      'a session that is not there is a row not written, never a throw');
    // A plan written at Make it, before there is a run.
    assert.equal(await timeline.record(pool, { appId: clubVotes.id, stage: 'plan_written', detail: { source: 'make_it', questions: 2 } }), true);
    assert.equal(await timeline.record(pool, { appId: older.id, stage: 'plan_written' }), false);
    const rows = await stages(clubVotes.id);
    assert.deepEqual(rows.map((r) => [r.user_id, r.app_id, r.session_id]), [[maker.id, clubVotes.id, null], [maker.id, clubVotes.id, null]]);
    assert.deepEqual(rows[0].metadata, { stage: 'build_started', partial: false, runId: first, issueNumber: 1 });
    assert.deepEqual(rows[1].metadata, { stage: 'plan_written', source: 'make_it', questions: 2, issueNumber: 1 });
    assert.deepEqual(await stages(older.id), []);
    await pool.query(`DELETE FROM events WHERE event_type = 'first_version_stage'`);
  });

  await t.test('Build it keeps when it went ahead, and the build says how long it then waited for its slot', async () => {
    const PLAN = { bullets: ['Make a poll'], questions: [{ question: 'Who can make a poll?', answers: ['Anyone', 'Only you'] }] };
    const runId = await run(clubVotes.id, 1, { awaiting: new Date(), plan: PLAN });
    const went = await bot.goAhead(pool, { runId, answers: ['Only you'] });
    assert.equal(went.ok, true);
    const { rows: [after] } = await pool.query('SELECT go_ahead_at, live_build_waiting_at FROM homeroom_bot_runs WHERE id = $1', [runId]);
    assert.ok(after.go_ahead_at && after.live_build_waiting_at);
    // Its go-ahead, as a stage too (recorded without waiting on it).
    for (let i = 0; i < 50 && !(await stages(clubVotes.id)).length; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual((await stages(clubVotes.id)).map((r) => r.metadata), [{ stage: 'go_ahead', answers: 1, runId, issueNumber: 1 }]);

    // Ninety seconds later, the build takes its slot.
    await pool.query(`UPDATE homeroom_bot_runs SET go_ahead_at = NOW() - INTERVAL '90 seconds' WHERE id = $1`, [runId]);
    const { rows: [session] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title) VALUES ($1, $2, 'bot-1', 'active', 'x') RETURNING id`,
      [clubVotes.id, maker.id],
    );
    const claim = await bot.claimLiveBuild(pool, { runId, sessionId: session.id });
    assert.equal(claim.claimed, true);
    assert.ok(claim.waitedMs >= 89000 && claim.waitedMs < 120000, `waited ${claim.waitedMs} ms`);
    const { rows: [claimed] } = await pool.query(
      'SELECT go_ahead_at, live_build_waiting_at, build_session_id FROM homeroom_bot_runs WHERE id = $1', [runId],
    );
    assert.equal(claimed.live_build_waiting_at, null, 'the wait is over');
    assert.ok(claimed.go_ahead_at, 'and when it went ahead is kept');
    assert.equal(Number(claimed.build_session_id), Number(session.id));
    // Once: another build's claim is refused, and says nothing about waiting.
    const { rows: [other] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title) VALUES ($1, $2, 'bot-2', 'active', 'x') RETURNING id`,
      [clubVotes.id, maker.id],
    );
    assert.deepEqual(await bot.claimLiveBuild(pool, { runId, sessionId: other.id }), { claimed: false, waitedMs: null });
    // The same build claiming again (a restart before it saved its claim) keeps its claim.
    assert.equal((await bot.claimLiveBuild(pool, { runId, sessionId: session.id })).claimed, true);
    await pool.query(`DELETE FROM events WHERE event_type = 'first_version_stage'`);
  });

  await t.test('a ready verdict queued with no Build it to wait for goes ahead as it is queued, once', async () => {
    const runId = await run(older.id, 5);
    await bot.queueLiveBuild(pool, { runId, appId: older.id });
    const { rows: [first] } = await pool.query('SELECT go_ahead_at FROM homeroom_bot_runs WHERE id = $1', [runId]);
    assert.ok(first.go_ahead_at);
    await pool.query(`UPDATE homeroom_bot_runs SET go_ahead_at = go_ahead_at - INTERVAL '1 hour', live_build_waiting_at = NULL WHERE id = $1`, [runId]);
    await bot.queueLiveBuild(pool, { runId, appId: older.id });
    const { rows: [again] } = await pool.query(
      'SELECT go_ahead_at < NOW() - INTERVAL \'59 minutes\' AS kept FROM homeroom_bot_runs WHERE id = $1', [runId],
    );
    assert.equal(again.kept, true, 'queued again, it keeps the first go-ahead');
  });

  await t.test('the plan: written by the triage at its run, and at Make it before there is one', async () => {
    const sent = [];
    const deps = { dm: { async sendPlanCard(_pool, args) { sent.push(args.runId); return { messageId: 7 }; } } };
    const triaged = await run(clubVotes.id, 1);
    const parsed = { plan: { bullets: ['Make a poll'], questions: [{ question: 'Who?', answers: ['a', 'b'] }] } };
    assert.equal(await bot.awaitGo(pool, { runId: triaged, app: clubVotes, issueNumber: 1, parsed, bot: { id: 1 }, deps }), 'waiting');
    // From Make it (planFromEarly): recorded when it was written, not again here.
    const early = await run(clubVotes.id, 1);
    assert.equal(await bot.awaitGo(pool, { runId: early, app: clubVotes, issueNumber: 1, parsed: { ...parsed, fromMakeIt: true }, bot: { id: 1 }, deps }), 'waiting');
    assert.deepEqual(sent, [triaged, early]);
    for (let i = 0; i < 50 && !(await stages(clubVotes.id)).length; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual((await stages(clubVotes.id)).map((r) => r.metadata),
      [{ stage: 'plan_written', source: 'triage', questions: 1, runId: triaged, issueNumber: 1 }]);
    await pool.query(`DELETE FROM events WHERE event_type = 'first_version_stage'`);

    // At Make it: a plan written is a stage of its own; a reply that could
    // not be used keeps its shape on the row, and no word of it.
    const madeApp = await app('trivia-night', maker);
    await pool.query(
      `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds) VALUES ($1, $2, 'Trivia', TRUE)`,
      [madeApp.id, maker.id],
    );
    const llm = (reply) => ({
      isEnabled: () => true, estimateCostCents: () => 0,
      async generateFirstVersionPlan() { return reply; },
    });
    const base = { limits: { async recordSpend() {} }, bot: { projectMembers: async () => null, starterOfApp: async () => null }, botConfigs: { async currentVersion() { return null; } } };
    const secret = 'A private sentence about the club';
    assert.equal(await fvPlan.startEarlyPlan(pool, { app: madeApp, user: maker, brief: 'Trivia' }, {
      ...base,
      llm: llm({
        text: JSON.stringify({ plan: [{ line: secret }], choices: [], build_note: secret, assumptions: [] }),
        reply: { finishReason: 'tool_calls', toolCallCount: 1, textChars: 0, routedProvider: 'Z.AI' },
      }),
    }), true);
    await fvPlan._pendingForTests.get(madeApp.id);
    const { rows: [failed] } = await pool.query(
      'SELECT early_plan_status, early_plan_error, early_plan_reply FROM homeroom_bot_first_versions WHERE app_id = $1', [madeApp.id],
    );
    assert.equal(failed.early_plan_status, 'failed');
    assert.equal(failed.early_plan_error, 'unusable_reply');
    assert.equal(failed.early_plan_reply.why, 'no_plan');
    assert.deepEqual(failed.early_plan_reply.keys.find((k) => k.key === 'plan'), { key: 'plan', type: 'array', length: 1, items: ['object'] });
    assert.equal(failed.early_plan_reply.routedProvider, 'Z.AI');
    assert.equal(failed.early_plan_reply.finishReason, 'tool_calls');
    assert.equal(JSON.stringify(failed.early_plan_reply).includes(secret), false, 'its shape, never its words');
    assert.deepEqual(await stages(madeApp.id), [], 'no plan, no stage');

    // Asked again (a new project), it is used: the row has no shape, and its
    // timeline starts.
    const usedApp = await app('book-swap', maker);
    await pool.query(
      `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds) VALUES ($1, $2, 'Books', TRUE)`,
      [usedApp.id, maker.id],
    );
    await fvPlan.startEarlyPlan(pool, { app: usedApp, user: maker, brief: 'Books' }, {
      ...base,
      llm: llm({ text: JSON.stringify({ plan: ['Swap books', 'See who has what', 'Ask for one'], choices: [], build_note: 'One list.', assumptions: [] }) }),
    });
    await fvPlan._pendingForTests.get(usedApp.id);
    const { rows: [used] } = await pool.query(
      'SELECT early_plan_status, early_plan_reply FROM homeroom_bot_first_versions WHERE app_id = $1', [usedApp.id],
    );
    assert.deepEqual([used.early_plan_status, used.early_plan_reply], ['ready', null]);
    const written = await stages(usedApp.id);
    assert.deepEqual(written.map((r) => [r.user_id, r.metadata]), [[maker.id, { stage: 'plan_written', source: 'make_it', questions: 0, issueNumber: null }]]);
  });

  await t.test('its merge, and the moment it is live, from the bot\'s own merge path', async () => {
    const { rows: [proposal] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, linked_issues)
       VALUES ($1, $2, 'bot-merged', 'merged', 'Club Votes', '{1}') RETURNING id, app_id, user_id`,
      [clubVotes.id, maker.id],
    );
    const runId = await run(clubVotes.id, 1);
    await pool.query('UPDATE homeroom_bot_runs SET proposal_session_id = $2, build_ok = TRUE WHERE id = $1', [runId, proposal.id]);
    await dm.noteProposalMerged(pool, proposal, { live: true, deps: { voice: { async dropAsks() {} } } });
    for (let i = 0; i < 50 && (await stages(clubVotes.id)).length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
    const rows = await stages(clubVotes.id);
    assert.deepEqual(rows.map((r) => r.metadata.stage).sort(), ['live', 'merged']);
    for (const r of rows) {
      assert.equal(r.metadata.runId, runId);
      assert.equal(Number(r.session_id), Number(proposal.id));
      assert.equal(r.user_id, maker.id);
    }
  });
});
