'use strict';

// #6651 (13 Nov 2026): the Needs you badge and page count the same change.
// A change the viewer made was dropped from the feed by a gate weaker than
// the one the counts read: every counted Yes looked like an approval, even a
// non-approver's on an approver project. The feed now reads `votes_in` from
// governance.governedGate, the same call services/work-state.js makes for
// work_states.vote_open, so a change still waiting on a vote stays listed
// under a non-zero badge.
//
// Against the REAL schema in a throwaway PostgreSQL database.
//
// What this pins:
//   1. While the only Yes is a non-approver's, the author owes the change:
//      OWED_BY_COMMUNITY_SQL counts it, COUNTS_SQL names it, and
//      needsFeedFor lists it as a Vote.
//   2. Once an approver's Yes is in, the gate is mergeable and work-state
//      closes the vote; the change is in neither the count nor the feed.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/needs-feed-author-gate-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('#6651: the feed lists a change its badge counts while a vote still waits', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `needs_author_gate_${crypto.randomBytes(6).toString('hex')}`;
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

  const overview = require('../src/routes/workshop-overview');
  const workState = require('../src/services/work-state');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username) => one(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [username]);
  const ada = await user('nr6651_ada');
  const bob = await user('nr6651_bob');
  const cat = await user('nr6651_cat');
  const app = await one(
    `INSERT INTO apps (name, slug, view_visibility, collab_visibility, created_by)
     VALUES ('Author gate', 'nr6651-gate', 'public', 'public', $1) RETURNING id, slug`, [ada.id]);
  for (const u of [ada, bob, cat]) {
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [app.id, u.id]);
  }
  // An approver project: ada invited bob, and nobody else's Yes counts.
  await pool.query(`UPDATE apps SET approver_policy = 'invited', approvals_required = 1 WHERE id = $1`, [app.id]);
  await pool.query(`INSERT INTO app_approvers (app_id, user_id) VALUES ($1, $2)`, [app.id, bob.id]);
  await pool.query(`INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 7, 'Night mode', $2)`,
    [app.id, ada.id]);
  const change = await one(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number, pr_title, check_state,
                                merge_conflict_state, integration_merges_clean, promoted_at)
     VALUES ($1, $2, 'promoted', ARRAY[7]::int[], 6651, 'Show the reason beside each credit', 'passing',
             NULL, TRUE, NOW()) RETURNING id, approval_epoch`, [app.id, ada.id]);

  const derive = async () => { await workState.refresh(pool, [{ sessionId: change.id }]); };
  const voteOpen = async () => {
    const row = (await pool.query(
      `SELECT vote_open FROM work_states
        WHERE app_id = $1 AND item_kind = 'change' AND item_ref = $2`, [app.id, change.id])).rows[0];
    return row ? row.vote_open === true : null;
  };
  const counts = async () => {
    const row = (await pool.query(overview.COUNTS_SQL, [ada.id, false, false])).rows
      .find((r) => r.slug === app.slug);
    return row ? { needs: Number(row.needs), owed: row.owed } : { needs: 0, owed: [] };
  };
  const waiting = async () => {
    const row = (await overview.owedByCommunity(pool, ada.id)).find((r) => r.slug === app.slug);
    return row ? Number(row.waiting) : 0;
  };
  const feed = async () => overview.needsFeedFor(pool, { user: { id: ada.id, isAdmin: false } });
  const castVote = (by, vote) => pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch)
     SELECT cs.id, $2, $3, cs.approval_epoch FROM chat_sessions cs WHERE cs.id = $1`,
    [change.id, by.id, vote]);

  await derive();
  assert.equal(await voteOpen(), true, 'a change with no Yes at all is open for votes');

  // The reported bug: a non-approver's Yes made the weaker gate look met, so
  // the author's own row vanished from the feed while the counts kept it.
  await castVote(cat, 'yes');
  await derive();
  assert.equal(await voteOpen(), true, 'a non-approver\'s Yes does not close an approver project\'s vote');
  const { needs, owed } = await counts();
  assert.equal(await waiting(), 1, 'the badge\'s count still owes the change');
  assert.equal(needs, 1, 'and COUNTS_SQL\'s needs too');
  assert.deepEqual(owed, [`proposal:${change.id}@${change.approval_epoch}`],
    'and names it in the keys the client reads');
  const listed = await feed();
  const mine = listed.find((item) => item.kind === 'proposal' && Number(item.id) === Number(change.id));
  assert.ok(mine, 'the page lists the vote its badge counts');
  assert.ok(!('waitingOn' in mine), 'as a Vote, not a fix');

  // The approver's Yes is the one the rule asks for: the gate is mergeable,
  // work-state closes the vote, and the change leaves both readers together.
  await castVote(bob, 'yes');
  await derive();
  assert.equal(await voteOpen(), false, 'the real gate has its votes');
  assert.equal(await waiting(), 0, 'the badge stops counting it');
  const after = await counts();
  assert.equal(after.needs, 0);
  assert.deepEqual(after.owed, [], 'and names nothing');
  const afterFeed = await feed();
  assert.ok(!afterFeed.some((item) => item.kind === 'proposal' && Number(item.id) === Number(change.id)),
    'and the page stops listing it');
});
