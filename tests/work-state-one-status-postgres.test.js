'use strict';

// #6821 (18 Nov 2026): a change's status is the same on its page and in every
// list, against the REAL schema in a throwaway PostgreSQL database.
//
// The change page worked its status out live, while the Homeroom bot tab, the
// Needs you feed and the badge counts read the stored work state, and the two
// disagreed: an approved change catching up with main read "Approved ·
// Syncing with main … You said yes" on its page and "Up for a vote" in the
// tab. Two things put that right:
//
//   1. the derivation: once the votes are in, a stored 'awaiting_approval'
//      reason no longer makes the change a vote (services/work-state.js
//      standOf), so it reads checking/syncing and its vote is closed;
//   2. the store's freshness: the writes that move it mark it themselves
//      (migration work-state-marks-all-inputs), so the 3 s drain refreshes
//      the row whatever wrote the fact.
//
// What this pins, after each drainDirty: the stage and line the proposal
// route serves as `work` (forChanges + forViewer) are the ones the bot tab's
// lists give the same change (services/ai-work.js), through yes → syncing →
// merging, through a follow-up turn starting and ending, and through a
// before & after shots run publishing and failing (Evan's follow-up); never
// up_for_vote once the yes votes are in, and the viewer's own yes is theirs
// at every stage.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/work-state-one-status-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('one status on the change page and in the lists', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `work_one_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  require('../src/db/pool').getPool = () => pool;
  const workState = require('../src/services/work-state');
  const aiWork = require('../src/services/ai-work');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username) => one(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [username]);
  const ada = await user('w1_ada');
  const barn = await user('w1_barn');
  const cat = await user('w1_cat');
  const app = await one(
    `INSERT INTO apps (name, slug, view_visibility, collab_visibility, created_by)
     VALUES ('One status', 'w1-status', 'public', 'public', $1) RETURNING id, slug`, [ada.id]);
  for (const u of [ada, barn, cat]) {
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [app.id, u.id]);
  }
  // An approver project: barn's Yes alone is the one the rule asks for.
  await pool.query(`UPDATE apps SET approver_policy = 'invited', approvals_required = 1 WHERE id = $1`, [app.id]);
  await pool.query(`INSERT INTO app_approvers (app_id, user_id) VALUES ($1, $2)`, [app.id, barn.id]);

  const thread = await one(
    `INSERT INTO threads (app_id, number, kind, title) VALUES ($1, 7, 'work', 'Show the count') RETURNING id`,
    [app.id]);
  await pool.query(
    `INSERT INTO requests (app_id, number, thread_id, title, created_by, state) VALUES ($1, 7, $2, 'Show the count', $3, 'open')`,
    [app.id, thread.id, ada.id]);
  const change = await one(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, created_from_issue_number, thread_id,
                                pr_number, pr_title, check_state, checks_checked_at, reviewed_head_sha,
                                checks_commit_sha, integration_merges_clean, promoted_at)
     VALUES ($1, $2, 'promoted', ARRAY[7]::int[], 7, $3, 7001, 'Show the count', 'passing', NOW(), 'h1', 'h1', TRUE, NOW())
     RETURNING id, approval_epoch`, [app.id, ada.id, thread.id]);

  // The 3 s drain: everything the triggers marked, derived again.
  const settle = async () => { while ((await workState.drainDirty(pool)).taken) { /* until none is left */ } };
  const vote = (by, v) => pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch)
     SELECT cs.id, $2, $3, cs.approval_epoch FROM chat_sessions cs WHERE cs.id = $1`, [change.id, by.id, v]);

  /** What the page draws (the proposal route's `work`) and what the tab lists, after a drain. */
  const everywhere = async () => {
    await settle();
    const { rows: threadRows } = await pool.query(aiWork.THREADS_SQL, [ada.id, false, false, 80, 7]);
    const states = await aiWork.statesFor(pool, threadRows);
    const lists = aiWork.arrange(threadRows, ada.id, new Date(), null, states);
    const items = [...lists.needs, ...lists.next, ...lists.waiting, ...lists.live];
    const listed = items.find((i) => i.work) || null;
    const stored = (await workState.forChanges(pool, [change.id])).get(Number(change.id));
    const mine = (await one(
      `SELECT vote FROM pr_votes WHERE session_id = $1 AND user_id = $2 AND approval_epoch = $3`,
      [change.id, ada.id, change.approval_epoch]));
    const page = workState.forViewer(stored, { viewerId: ada.id, myVote: mine ? mine.vote : null });
    const row = (await one(
      `SELECT stage, line, vote_open FROM work_states
        WHERE app_id = $1 AND item_kind = 'change' AND item_ref = $2`, [app.id, change.id]));
    return { page, list: listed ? listed.work : null, row, listed };
  };
  const sameAsList = (now, stage, code) => {
    assert.equal(now.page.stage, stage, 'the page says so');
    assert.equal(now.page.line && now.page.line.code, code);
    assert.ok(now.list, 'the tab lists it');
    assert.equal(now.list.stage, stage, 'the tab\'s list says the same stage as the page');
    assert.equal(now.list.line && now.list.line.code, code, 'and the same line');
  };

  await t.test('with no yes yet, it is up for a vote', async () => {
    const now = await everywhere();
    assert.deepEqual([now.page.stage, now.page.line], ['up_for_vote', null]);
    assert.equal(now.row.vote_open, true);
    // The vote the viewer owes is the Needs you feed's, not a row in the tab
    // (work-state.js placeFor): the page and the feed are where it shows.
    assert.equal(now.list, null, 'the tab holds no vote the viewer owes');
  });

  await t.test('a yes in, with a stale awaiting_approval: both say Syncing with main', async () => {
    // The merge queue has not measured it since the yes: the reason and the
    // conflict it came with are still stored, which used to keep it a vote.
    await pool.query(
      `UPDATE chat_sessions SET integration_merges_clean = FALSE,
                                integration_block_reasons = '["awaiting_approval"]'::jsonb
        WHERE id = $1`, [change.id]);
    await vote(barn, 'yes');
    const now = await everywhere();
    sameAsList(now, 'checking', 'syncing');
    assert.notEqual(now.row.stage, 'up_for_vote', 'no list asks for a vote on an approved change');
    assert.equal(now.row.vote_open, false);
    assert.equal(workState.stageSays(now.page), 'Syncing with main');
    assert.equal(workState.stageSays(now.list), 'Syncing with main');
  });

  await t.test('the viewer\'s own yes is theirs at any stage, on both', async () => {
    await vote(ada, 'yes');
    const now = await everywhere();
    sameAsList(now, 'checking', 'syncing');
    assert.equal(now.page.myVote, 'yes');
    assert.equal(now.listed.myVote, 'yes', 'the tab\'s row carries it from the same row');
  });

  await t.test('a follow-up turn starting and ending: both follow it within a drain', async () => {
    // A turn is "running" for six hours of wall clock (UPDATE_TURN_HOURS),
    // so the start is relative to now: a fixed 10:00 would stop counting
    // once the clock passed it.
    await pool.query(
      `UPDATE chat_sessions
          SET active_turn = jsonb_build_object('mode', 'fix', 'startedAt',
                to_char(NOW() AT TIME ZONE 'UTC' - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        WHERE id = $1`, [change.id]);
    const started = await everywhere();
    sameAsList(started, 'building', 'revising');
    assert.equal(started.page.myVote, 'yes', 'still their yes while it is fixed');

    // The turn's end marks it again: no sweep is needed to notice.
    await pool.query(`UPDATE chat_sessions SET active_turn = NULL WHERE id = $1`, [change.id]);
    const ended = await everywhere();
    sameAsList(ended, 'checking', 'syncing');
  });

  await t.test('a shots run publishing or failing: both stop saying Taking screenshots at once (Evan)', async () => {
    // Checks passed on the head, the votes are in, it merges cleanly: only
    // its before & after shots are left, and they are being taken. The
    // shot machine writes the run's row and the slot it shows; either write
    // marks the change (chat_sessions, and shot_runs by migration
    // work-state-marks-shots), so the lists follow within the drain, not
    // the next sweep.
    const runId = crypto.randomBytes(16).toString('hex');
    const head = 'd'.repeat(40);
    await pool.query(
      `UPDATE chat_sessions
          SET integration_merges_clean = TRUE, integration_block_reasons = '[]'::jsonb,
              check_phase = NULL, merge_conflict_state = NULL,
              shots_state = 'exploring', shots_run_id = $2,
              shots_detail = jsonb_build_object('headSha', 'h1', 'intent', jsonb_build_object('stories', '[]'::jsonb)),
              shots_updated_at = NOW(), checks_checked_at = NOW()
        WHERE id = $1`, [change.id, runId]);
    await pool.query(
      `INSERT INTO shot_runs (id, session_id, base_sha, head_sha, intent, state, started_at)
       VALUES ($1, $2, $3, $4, '{"impact":"ui"}'::jsonb, 'exploring', NOW())`,
      [runId, change.id, 'e'.repeat(40), head]);

    const taking = await everywhere();
    sameAsList(taking, 'checking', 'shots');
    assert.equal(workState.stageSays(taking.page), 'Taking screenshots');
    assert.equal(workState.stageSays(taking.list), 'Taking screenshots');

    // The run publishes: the slot it shows moves to verified in the same
    // transaction (shots/machine.ts showRun).
    await pool.query(
      `UPDATE shot_runs SET state = 'verified', plan_hash = $2, hard_verdict = '{}'::jsonb, completed_at = NOW()
        WHERE id = $1`, [runId, 'f'.repeat(64)]);
    await pool.query(
      `UPDATE chat_sessions SET shots_state = 'verified', shots_updated_at = NOW()
        WHERE id = $1 AND shots_run_id = $2`, [change.id, runId]);
    const published = await everywhere();
    sameAsList(published, 'going_live', null);
    assert.equal(published.page.myVote, 'yes');
    assert.equal(published.listed.myVote, 'yes');

    // A retry that fails: the run that went stale, then a new run failing.
    await pool.query(`UPDATE shot_runs SET state = 'stale' WHERE id = $1`, [runId]);
    const retry = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `UPDATE chat_sessions
          SET shots_state = 'provisioning', shots_run_id = $2, shots_updated_at = NOW(), checks_checked_at = NOW()
        WHERE id = $1`, [change.id, retry]);
    await pool.query(
      `INSERT INTO shot_runs (id, session_id, base_sha, head_sha, intent, state)
       VALUES ($1, $2, $3, $4, '{"impact":"ui"}'::jsonb, 'provisioning')`,
      [retry, change.id, 'e'.repeat(40), head]);
    const retrying = await everywhere();
    sameAsList(retrying, 'checking', 'shots');

    await pool.query(
      `UPDATE shot_runs SET state = 'failed', failure_code = 'shots_agent_timeout', completed_at = NOW()
        WHERE id = $1`, [retry]);
    await pool.query(
      `UPDATE chat_sessions SET shots_state = 'failed', shots_updated_at = NOW()
        WHERE id = $1 AND shots_run_id = $2`, [change.id, retry]);
    const failed = await everywhere();
    sameAsList(failed, 'going_live', null);
    assert.equal(failed.page.myVote, 'yes', 'their yes is still theirs after a failed run');
    assert.equal(failed.listed.myVote, 'yes');
  });

  await t.test('merging: Going live on both, never a vote', async () => {
    await pool.query(`UPDATE chat_sessions SET status = 'merging' WHERE id = $1`, [change.id]);
    const now = await everywhere();
    sameAsList(now, 'going_live', null);
    assert.notEqual(now.row.stage, 'up_for_vote');
    assert.equal(now.page.myVote, 'yes');
    assert.equal(now.listed.myVote, 'yes');
  });
});
