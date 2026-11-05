'use strict';

// #5404: a real sweep of the Monday row against the full schema: who is
// counted, that a second sweep sends nothing, and that a reader who lost a
// private project neither sees it named nor has it counted.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/voted-digest-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const digest = require('../src/services/voted-digest');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// A Monday, and when the week it reports on falls.
const MONDAY = new Date('2026-11-09T14:00:00Z');
const IN_WEEK = '2026-11-06T10:00:00Z';
const BEFORE_WEEK = '2026-11-01T10:00:00Z';
const AFTER_MARK = '2026-11-09T13:30:00Z';

test('the Monday row against the full schema', async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `voted_digest_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id`, [username],
  )).rows[0].id;
  const maker = await user('maker');
  const ana = await user('ana');
  const ben = await user('ben');
  const cy = await user('cy');
  const dee = await user('dee');
  const eve = await user('eve');

  const app = async (slug, view = 'public', collab = view) => (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ($1, $1, 'running', $2, $3, $4) RETURNING id`, [slug, maker, view, collab],
  )).rows[0].id;
  const open = await app('open-project');
  const secret = await app('secret-project', 'private');

  let branch = 0;
  const change = async (appId, { status = 'promoted', merged = null, archived = null } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, merged_at, archived_at)
     VALUES ($1, $2, $3, $4, 'A change', NOW(), $5, $6) RETURNING id`,
    [appId, maker, `b/${branch += 1}`, status, merged, archived],
  )).rows[0].id;
  const vote = (sessionId, userId, side = 'yes') => pool.query(
    'INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, $3)', [sessionId, userId, side]);

  const merged = await change(open, { status: 'merged', merged: IN_WEEK });
  const closed = await change(open, { status: 'archived', archived: IN_WEEK });
  const stillOpen = await change(open);
  const lastWeek = await change(open, { status: 'merged', merged: BEFORE_WEEK });
  const thisMorning = await change(open, { status: 'merged', merged: AFTER_MARK });
  const secretMerged = await change(secret, { status: 'merged', merged: IN_WEEK });

  // Ana: one merged, one closed (a no counts too), and three that did not move this week.
  await vote(merged, ana);
  await vote(closed, ana, 'no');
  await vote(stillOpen, ana);
  await vote(lastWeek, ana);
  await vote(thisMorning, ana);
  // Ben voted only on what did not move.
  await vote(stillOpen, ben);
  // Cy left the private project; his one vote there counts for nothing.
  await vote(secretMerged, cy);
  // Dee is still in it, so hers does.
  await vote(secretMerged, dee);
  await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [secret, dee]);
  // Eve turned the switch off.
  await vote(merged, eve);
  await pool.query(
    `INSERT INTO notification_preferences (user_id, app_id, category_key, enabled) VALUES ($1, NULL, 'voted_digest', FALSE)`, [eve]);

  const rows = async () => (await pool.query(
    `SELECT user_id, app_id, session_id, detail, mailed_at IS NOT NULL AS mailed
       FROM notifications WHERE kind = 'voted_digest' ORDER BY user_id`)).rows;

  const first = await digest.sweep(pool, MONDAY);
  assert.equal(first.sent, 2);
  const written = await rows();
  assert.deepEqual(written.map((row) => [row.user_id, row.detail]), [[ana, '2'], [dee, '1']],
    'counted once each; no row for nothing moved, a lost project or a switched-off person');
  for (const row of written) {
    assert.equal(row.app_id, null, 'it names no project');
    assert.equal(row.session_id, null, 'nor a change');
    assert.equal(row.mailed, true, 'it owes no email');
  }

  // Later the same Monday, and a sweep racing it: one row each, still.
  const again = await digest.sweep(pool, new Date('2026-11-09T15:00:00Z'));
  assert.equal(again.sent, 0);
  assert.equal(again.candidates, 0, 'the row already made takes them out of the query');
  assert.equal((await rows()).length, 2);

  // Next Monday reports the change merged after this week's mark.
  const next = await digest.sweep(pool, new Date('2026-11-16T14:00:00Z'));
  assert.equal(next.sent, 1);
  const ana2 = (await rows()).filter((row) => row.user_id === ana);
  assert.deepEqual(ana2.map((row) => row.detail).sort(), ['1', '2'], 'and never counts a change twice');

  // The phone gets it: the migration seeded the kind.
  const { rows: [policy] } = await pool.query(
    `SELECT category, default_enabled FROM mobile_push_kind_categories WHERE kind = 'voted_digest'`);
  assert.deepEqual(policy, { category: 'proposal_alerts', default_enabled: true });
});
