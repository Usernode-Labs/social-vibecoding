'use strict';

// #6821 (18 Nov 2026): every input a change's work state is derived from
// marks it dirty, against the REAL schema in a throwaway PostgreSQL database.
//
// The work state is stored (work_states) and refreshed when its item is
// marked (work_state_dirty, drained every 3 s) or when the one-minute sweep
// reaches the row. A fact written where nothing marked the item left the row
// saying the old thing until the sweep came round: an approved change
// catching up with main read "Up for a vote" in the lists while its page said
// Approved. The migration work-state-marks-all-inputs puts a trigger on each
// of those writes.
//
// What this pins:
//   1. Each watched chat_sessions column marks the change: its status, its
//      turn (a mode or a start, not a heartbeat), the head it is checked at,
//      its merge, its shots, its verdict, the request it was opened from.
//   2. A vote marks it, as do an ask of Homeroom bot (however it moves), a
//      takeover look and a wait on a fix for a check that is not its own.
//   3. A heartbeat on a turn, and anything about a headless session, marks
//      nothing.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/work-state-marks-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('every input of a change\'s work state marks it', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `work_marks_${crypto.randomBytes(6).toString('hex')}`;
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

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username) => one(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [username]);
  const ada = await user('wm_ada');
  const app = await one(
    `INSERT INTO apps (name, slug, view_visibility, collab_visibility, created_by)
     VALUES ('Marks', 'wm-marks', 'public', 'public', $1) RETURNING id, slug`, [ada.id]);
  const change = await one(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number, pr_title, check_state,
                                integration_merges_clean, promoted_at)
     VALUES ($1, $2, 'promoted', '{}'::int[], 7001, 'Marks', 'passing', TRUE, NOW()) RETURNING id`,
    [app.id, ada.id]);
  const headless = await one(
    `INSERT INTO chat_sessions (app_id, user_id, status, is_headless, pr_number, pr_title)
     VALUES ($1, $2, 'active', TRUE, 7002, 'Headless') RETURNING id`, [app.id, ada.id]);

  const clear = () => pool.query('DELETE FROM work_state_dirty');
  const marks = async () => (await pool.query('SELECT session_id FROM work_state_dirty')).rows
    .map((r) => Number(r.session_id));
  /** Run one write: true when it left the change marked (and nothing else). */
  const marks_ = async (sql, params = [change.id]) => {
    await clear();
    await pool.query(sql, params);
    const out = await marks();
    await clear();
    return out;
  };

  const columns = [
    ['status', `UPDATE chat_sessions SET status = 'merging' WHERE id = $1`],
    ['the turn\'s mode', `UPDATE chat_sessions SET active_turn = '{"mode":"build","startedAt":"2026-11-18T10:00:00Z"}'::jsonb WHERE id = $1`],
    ['the turn\'s start', `UPDATE chat_sessions SET active_turn = jsonb_set(COALESCE(active_turn, '{}'::jsonb), '{startedAt}', '"2026-11-18T11:00:00Z"') WHERE id = $1`],
    ['the turn\'s end', `UPDATE chat_sessions SET active_turn = NULL WHERE id = $1`],
    ['its imported head', `UPDATE chat_sessions SET imported_pr_head_sha = 'importhead' WHERE id = $1`],
    ['its reviewed head', `UPDATE chat_sessions SET reviewed_head_sha = 'reviewedhead' WHERE id = $1`],
    ['the head it is checked at', `UPDATE chat_sessions SET checks_commit_sha = 'checkedhead' WHERE id = $1`],
    ['its merge', `UPDATE chat_sessions SET merged_at = NOW() WHERE id = $1`],
    ['its shots\' state', `UPDATE chat_sessions SET shots_state = 'running' WHERE id = $1`],
    ['its shots\' run', `UPDATE chat_sessions SET shots_run_id = 42 WHERE id = $1`],
    ['its shots\' detail', `UPDATE chat_sessions SET shots_detail = '{"verified": true}'::jsonb WHERE id = $1`],
    ['its shots\' time', `UPDATE chat_sessions SET shots_updated_at = NOW() WHERE id = $1`],
    ['its verdict', `UPDATE chat_sessions SET test_results = '[{"name":"a","status":"fail"}]'::jsonb WHERE id = $1`],
    ['the request it was opened from', `UPDATE chat_sessions SET created_from_issue_number = 7 WHERE id = $1`],
  ];
  for (const [what, sql] of columns) {
    await t.test(`${what} marks its change`, async () => {
      assert.deepEqual(await marks_(sql), [Number(change.id)]);
    });
  }

  await t.test('a heartbeat on the turn marks nothing', async () => {
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"mode":"build","startedAt":"2026-11-18T10:00:00Z","beatAt":"2026-11-18T10:00:05Z"}'::jsonb WHERE id = $1`, [change.id]);
    assert.deepEqual(
      await marks_(`UPDATE chat_sessions SET active_turn = jsonb_set(active_turn, '{beatAt}', '"2026-11-18T10:00:10Z"') WHERE id = $1`),
      [],
      'a beat every few seconds would fill the marks table for a fact no stage reads');
  });

  await t.test('a vote marks it', async () => {
    assert.deepEqual(
      await marks_(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch)
                    SELECT cs.id, $2, 'yes', cs.approval_epoch FROM chat_sessions cs WHERE cs.id = $1`,
      [change.id, ada.id]),
      [Number(change.id)]);
  });

  await t.test('an ask of Homeroom bot marks it, however it moves', async () => {
    await clear();
    const ask = await one(
      `INSERT INTO homeroom_bot_change_asks (app_id, session_id, issue_number, instruction)
       VALUES ($1, $2, 7, 'Make it show the count') RETURNING id`, [app.id, change.id]);
    assert.deepEqual(await marks(), [Number(change.id)], 'asked');
    await clear();
    await pool.query(`UPDATE homeroom_bot_change_asks SET taken_at = NOW() WHERE id = $1`, [ask.id]);
    assert.deepEqual(await marks(), [Number(change.id)], 'taken');
    await clear();
    await pool.query(`UPDATE homeroom_bot_change_asks SET instruction = 'Make it show the tally' WHERE id = $1`, [ask.id]);
    assert.deepEqual(await marks(), [Number(change.id)], 'its words moved');
    await clear();
    await pool.query('DELETE FROM homeroom_bot_change_asks WHERE id = $1', [ask.id]);
    assert.deepEqual(await marks(), [Number(change.id)], 'withdrawn');
    await clear();
  });

  await t.test('a takeover look marks it', async () => {
    await clear();
    const look = await one(
      `INSERT INTO homeroom_bot_looks (user_id, app_id, session_id, question, kind)
       VALUES ($1, $2, $3, 'Why is it failing?', 'update') RETURNING id`, [ada.id, app.id, change.id]);
    assert.deepEqual(await marks(), [Number(change.id)], 'started');
    await clear();
    await pool.query(`UPDATE homeroom_bot_looks SET state = 'failed', error = 'it ran out of time' WHERE id = $1`, [look.id]);
    assert.deepEqual(await marks(), [Number(change.id)], 'failed');
    await clear();
    await pool.query(`UPDATE homeroom_bot_looks SET ended_at = NOW() WHERE id = $1`, [look.id]);
    assert.deepEqual(await marks(), [Number(change.id)], 'ended');
    await clear();
  });

  await t.test('a wait on a fix for another change\'s check marks it', async () => {
    await clear();
    await pool.query(
      `INSERT INTO homeroom_bot_flake_waits (session_id, app_id, issue_number, stage)
       VALUES ($1, $2, 7, 'synced')`, [change.id, app.id]);
    assert.deepEqual(await marks(), [Number(change.id)], 'opened');
    await clear();
    await pool.query(`UPDATE homeroom_bot_flake_waits SET stage = 'fixing' WHERE session_id = $1`, [change.id]);
    assert.deepEqual(await marks(), [Number(change.id)], 'moved');
    await clear();
    await pool.query(`UPDATE homeroom_bot_flake_waits SET ended_at = NOW() WHERE session_id = $1`, [change.id]);
    assert.deepEqual(await marks(), [Number(change.id)], 'ended');
    await clear();
    await pool.query('DELETE FROM homeroom_bot_flake_waits WHERE session_id = $1', [change.id]);
    assert.deepEqual(await marks(), [Number(change.id)], 'gone');
    await clear();
  });

  await t.test('a headless session marks nothing', async () => {
    assert.deepEqual(
      await marks_(`UPDATE chat_sessions SET status = 'promoted', test_results = '[]'::jsonb, shots_state = 'done'
                     WHERE id = $1`, [headless.id]),
      []);
    assert.deepEqual(
      await marks_(`INSERT INTO chat_sessions (app_id, user_id, status, is_headless, active_turn)
                    VALUES ($1, $2, 'active', TRUE, '{"mode":"build"}'::jsonb)`, [app.id, ada.id]),
      [],
      'a headless session is nobody\'s work item');
  });
});
