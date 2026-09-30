'use strict';

// "Your changes" on Me (issue #3204): GET /api/me/proposal-history's SQL
// against the full PostgreSQL schema (src/routes/profile.js
// MY_PROPOSALS_SQL). An open-for-vote row carries its current-vote tally
// (pr_votes under the shared current-epoch rule) and the merge-state
// columns the proposal page reads, so the one cross-project list can say how
// each vote is going without opening every app.
//
// Run with: node --test tests/me-proposal-history-postgres.test.js
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const profile = require('../src/routes/profile');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('your proposal history against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'me_proposals_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  const { rows: [me] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('me_history', 'x') RETURNING id`);
  const { rows: [someone] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('someone_else', 'x') RETURNING id`);
  const { rows: [third] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('third_voter', 'x') RETURNING id`);
  const { rows: [run] } = await pool.query(
    `INSERT INTO apps (name, slug, repo_url) VALUES ('Run Club', 'run-club', 'https://github.com/acme/run-club')
     RETURNING id`);

  const session = (over) => pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, session_title, status, promoted_at,
                                last_activity_at, is_headless, behind_main,
                                merge_conflict_state, check_state)
     VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, $8, $9) RETURNING id`,
    [run.id, me.id, over.title, over.status, over.promotedAt || null,
      over.at, over.behindMain || 0, over.conflict || null, over.checks || null]);
  const vote = (sessionId, userId, dir, epoch = 0) => pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, $3, $4)`,
    [sessionId, userId, dir, epoch]);

  // In vote: 2 current yes, 1 current no, and one stale yes on an earlier
  // approval epoch that must not count. Behind main by 4.
  const { rows: [voted] } = await session({
    title: 'Fix pace rounding', status: 'promoted', at: new Date(Date.now() - 86400000),
    promotedAt: new Date(Date.now() - 86400000), behindMain: 4,
  });
  await vote(voted.id, someone.id, 'yes');
  await vote(voted.id, third.id, 'yes');
  await vote(voted.id, me.id, 'no');
  // A fourth voter casts a stale yes against an earlier epoch.
  const { rows: [fourth] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('fourth_voter', 'x') RETURNING id`);
  await vote(voted.id, fourth.id, 'yes', 1);

  // A second, newer proposal carries all three problem states at once, so
  // the response demonstrably carries conflict + failing + behind together.
  await session({
    title: 'All three problems', status: 'promoted', at: new Date(Date.now() - 3600000),
    promotedAt: new Date(Date.now() - 3600000), behindMain: 7,
    conflict: 'failed', checks: 'failing',
  });
  // No votes at all: 0 yes · 0 no is the honest tally.

  // A merged change of mine, so the merged bucket is real and not absent.
  await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, session_title, status, merged_at,
                                last_activity_at, is_headless)
     VALUES ($1, $2, 'Old change', 'merged', NOW(), NOW(), FALSE)`,
    [run.id, me.id]);

  const read = async (limit = profile.PROPOSALS_PER_BUCKET) => profile.shapeProposals(
    (await pool.query(profile.MY_PROPOSALS_SQL, [me.id, limit])).rows);

  const body = await read();
  assert.deepEqual(body.proposals.openForVote.map((r) => r.title),
    ['All three problems', 'Fix pace rounding'], 'newest first');
  const row = body.proposals.openForVote.find((r) => r.title === 'Fix pace rounding');
  assert.deepEqual(
    { yesCount: row.yesCount, noCount: row.noCount, behindMain: row.behindMain,
      mergeConflictState: row.mergeConflictState, checkState: row.checkState },
    { yesCount: 2, noCount: 1, behindMain: 4, mergeConflictState: null, checkState: null });

  // The merge-state columns arrive for the view to pick one word from: the
  // conflict state set here outranks the failing checks and the behind-main
  // count on the same row, and the view's precedence test pins which word
  // wins — the route's job is only to carry all three faithfully.
  const conflicted = body.proposals.openForVote.find((r) => r.title === 'All three problems');
  assert.deepEqual(
    { yesCount: conflicted.yesCount, noCount: conflicted.noCount, behindMain: conflicted.behindMain,
      mergeConflictState: conflicted.mergeConflictState, checkState: conflicted.checkState },
    { yesCount: 0, noCount: 0, behindMain: 7, mergeConflictState: 'failed', checkState: 'failing' });

  // Merged and closed rows carry the three state columns but null counts —
  // they are not votes, so the view keeps its own lines for them.
  assert.deepEqual(
    body.proposals.merged.map((r) => ({ yesCount: r.yesCount, noCount: r.noCount })),
    [{ yesCount: null, noCount: null }]);
});
