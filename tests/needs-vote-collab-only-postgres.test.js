'use strict';
// test:changed: when public/js/app-view.js (the client's "waits on your vote" predicate)
// test:changed: when src/services/app-access.js (the take-part rule the queue now mirrors)

// #6664 (14 Nov 2026): a vote on a project where only its collaborators may
// take part is not one everyone owes. The vote guard refuses a non-collaborator
// with 403 `collab_required`, so the queues that say "a vote waits on you" must
// not count or list it either.
//
// Against the REAL schema in a throwaway PostgreSQL database.
//
// What this pins, for a viewer who is a community member but not a
// collaborator on a project that is view-public and collab-private:
//   1. COUNTS_SQL, ITEMS_SQL, NEEDS_FEED_SQL, NEEDS_FEED_IN_THREADS_SQL and
//      owedByCommunity count and list neither the open change nor the open
//      settings decision.
//   2. A bot question to that viewer on the same project still appears.
//   3. Adding an accepted app_collaborators row, reading as an admin, or
//      switching the project to collab-public brings both votes back.
//   4. The client's predicate, run over /promoted rows with
//      can_collaborate false, counts nothing (and counts them again when true).
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/needs-vote-collab-only-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { loadAppView } = require('./lib/app-view-vm');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('#6664: a project only collaborators take part in owes no vote to a non-collaborator', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `needs_collab_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup) await step();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  require('../src/db/pool').getPool = () => pool;
  const overview = require('../src/routes/workshop-overview');
  const workState = require('../src/services/work-state');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username, synthetic = false) => one(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic)
     VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic]);
  const bot = await user('homeroom_bot', true);
  const ada = await user('ncc_ada');   // the viewer: a member, not a collaborator
  const bob = await user('ncc_bob');   // the project's author and collaborator
  const app = await one(
    `INSERT INTO apps (name, slug, view_visibility, collab_visibility, created_by)
     VALUES ('Trading journal', 'ncc-trading', 'public', 'private', $1) RETURNING id, slug`, [bob.id]);
  await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`,
    [app.id, bob.id]);
  for (const u of [ada, bob]) {
    await pool.query(`INSERT INTO community_members (community_id, user_id) SELECT community_id, $2 FROM apps WHERE id = $1
                      ON CONFLICT DO NOTHING`,
      [app.id, u.id]);
  }

  // An open change and an open settings decision, both owed by everyone who
  // may take part. The change's work state (vote_open) is derived by the
  // service, as the drain does within seconds.
  const change = await one(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number, pr_title, check_state,
                                integration_merges_clean, promoted_at)
     VALUES ($1, $2, 'promoted', '{}'::int[], 6664, 'Add a monthly summary', 'passing', TRUE, NOW())
     RETURNING id, approval_epoch`, [app.id, bob.id]);
  const gov = await one(
    `INSERT INTO issues (app_id, kind, title, created_by, payload)
     VALUES ($1, 'rename', 'Rename to Trading journal', $2, '{}') RETURNING id`, [app.id, bob.id]);
  await workState.refresh(pool, [{ sessionId: change.id }]);
  const openVote = async () => (await pool.query(
    `SELECT vote_open FROM work_states WHERE app_id = $1 AND item_kind = 'change' AND item_ref = $2`,
    [app.id, change.id])).rows[0]?.vote_open === true;
  assert.equal(await openVote(), true, 'the change is open for votes');

  // The five readers, each for one viewer.
  const counts = async (viewer, isAdmin = false) => {
    const row = (await pool.query(overview.COUNTS_SQL, [viewer.id, false, isAdmin])).rows
      .find((r) => r.slug === app.slug);
    return row ? { needs: Number(row.needs), owed: row.owed } : { needs: 0, owed: [] };
  };
  const items = async (viewer, isAdmin = false) => (await pool.query(
    overview.ITEMS_SQL, [viewer.id, false, isAdmin, overview.ITEMS_PER_APP, overview.ITEMS_TOTAL])).rows
    .filter((r) => r.slug === app.slug)
    .map((r) => `${r.section}:${r.kind}:${r.id}`);
  const feed = async (viewer, isAdmin = false, inThreads = false) => (await pool.query(
    inThreads ? overview.NEEDS_FEED_IN_THREADS_SQL : overview.NEEDS_FEED_SQL,
    [viewer.id, false, isAdmin, overview.NEEDS_FEED_MAX])).rows
    .filter((r) => Number(r.app_id) === Number(app.id))
    .map((r) => `${r.kind}:${r.id}`);
  const waiting = async (viewer, isAdmin = false) => {
    const row = (await overview.owedByCommunity(pool, viewer.id, { isAdmin })).find((r) => r.slug === app.slug);
    return row ? { waiting: Number(row.waiting), paying: Number(row.paying) } : { waiting: 0, paying: 0 };
  };

  const voteRows = [`proposal:${change.id}@${change.approval_epoch}`, `governance:${gov.id}`];

  await t.test('neither vote is counted or listed for a non-collaborator', async () => {
    assert.deepEqual(await counts(ada), { needs: 0, owed: [] }, 'no count beside the project');
    assert.deepEqual(await items(ada), [], 'no needs row in the all-apps Workshop');
    assert.deepEqual(await feed(ada), [], 'not in Communities › Needs you');
    assert.deepEqual(await feed(ada, false, true), [], 'not in the Homeroom bot tab\'s Needs you');
    assert.deepEqual(await waiting(ada), { waiting: 0, paying: 0 }, 'not in the project\'s or community\'s count');
  });

  await t.test('the bot\'s question to that viewer still shows', async () => {
    const conversation = await one(`INSERT INTO conversations (kind) VALUES ('direct') RETURNING id`);
    const dm = await one(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata)
       VALUES ($1, $2, 'A question', jsonb_build_object('homeroomBot', jsonb_build_object('question', 'Weekly or monthly?')))
       RETURNING id`,
      [conversation.id, bot.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, question_status)
       VALUES ($1, $2, $3, $4, 7, 'question', 'open')`,
      [dm.id, ada.id, conversation.id, app.id]);
    const question = `question:${dm.id}`;
    assert.deepEqual(await counts(ada), { needs: 1, owed: [question] }, 'the question is still owed');
    assert.deepEqual(await items(ada), [`needs:question:${dm.id}`]);
    assert.deepEqual(await feed(ada), [question]);
    assert.deepEqual(await feed(ada, false, true), [question]);
    assert.deepEqual(await waiting(ada), { waiting: 1, paying: 0 }, 'a question pays no vote');
  });

  await t.test('an accepted collaborator sees both votes again', async () => {
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [app.id, ada.id]);
    const owed = (await counts(ada)).owed.slice().sort();
    assert.deepEqual(owed, [...voteRows, `question:${(await pool.query('SELECT message_id FROM homeroom_bot_dm_messages ORDER BY message_id LIMIT 1')).rows[0].message_id}`].sort());
    const listed = await feed(ada);
    assert.ok(listed.includes(`proposal:${change.id}`) && listed.includes(`governance:${gov.id}`), 'both votes are listed');
    assert.ok((await items(ada)).some((row) => row.startsWith('needs:proposal:')), 'the change is a needs row');
    assert.ok((await items(ada)).some((row) => row.startsWith('needs:governance:')), 'the decision is a needs row');
    assert.equal((await waiting(ada)).waiting, 3, 'the project counts all three');
    await pool.query(`DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2`, [app.id, ada.id]);
    // Leaving the collaborators takes her membership with it (the
    // app_collaborators trigger); she is still a member of the community.
    await pool.query(
      `INSERT INTO community_members (community_id, user_id) SELECT community_id, $2 FROM apps WHERE id = $1
       ON CONFLICT DO NOTHING`, [app.id, ada.id]);
  });

  await t.test('an admin sees them without a collaborator row', async () => {
    const listed = await feed(ada, true);
    assert.ok(listed.includes(`proposal:${change.id}`) && listed.includes(`governance:${gov.id}`), 'both votes are listed for an admin');
    assert.equal((await counts(ada, true)).owed.filter((k) => k.startsWith('proposal:') || k.startsWith('governance:')).length, 2);
    assert.equal((await waiting(ada, true)).waiting, 3);
  });

  await t.test('a project that lets everyone take part shows them', async () => {
    await pool.query(`UPDATE apps SET collab_visibility = 'public' WHERE id = $1`, [app.id]);
    const listed = await feed(ada);
    assert.ok(listed.includes(`proposal:${change.id}`) && listed.includes(`governance:${gov.id}`), 'both votes are listed');
    assert.equal((await counts(ada)).owed.filter((k) => k.startsWith('proposal:') || k.startsWith('governance:')).length, 2);
    assert.equal((await waiting(ada)).waiting, 3);
    await pool.query(`UPDATE apps SET collab_visibility = 'private' WHERE id = $1`, [app.id]);
  });

  await t.test('the client predicate counts nothing over /promoted when can_collaborate is false', async () => {
    const express = require('express');
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.user = { id: ada.id, username: ada.username, isAdmin: false, hasPlatformAccess: true };
      next();
    });
    server.use(require('../src/routes/votes').voteRoutes({ databaseUrl: String(url) }));
    const listener = await new Promise((resolve) => {
      const l = server.listen(0, '127.0.0.1', () => resolve(l));
    });
    cleanup.push(() => new Promise((resolve) => listener.close(resolve)));
    const base = `http://127.0.0.1:${listener.address().port}`;
    const res = await fetch(`${base}/api/apps/${app.slug}/promoted?results=failing`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(res.status, 200);
    const rows = (await res.json()).promoted;
    assert.ok(rows.some((r) => Number(r.id) === Number(change.id)), 'the board still lists the change');
    const AppView = loadAppView();
    const counted = () => rows.filter((r) => AppView._devCardMatches('proposal', r, { needsVote: true }));
    AppView.appData = { slug: app.slug, can_collaborate: false };
    assert.deepEqual(counted(), [], 'a non-collaborator counts nothing');
    assert.equal(AppView._devCardMatches('gov', { kind: 'rename', my_vote: null }, { needsVote: true }), false,
      'nor the settings decision');
    AppView.appData = { slug: app.slug, can_collaborate: true };
    assert.deepEqual(counted().map((r) => Number(r.id)), [Number(change.id)], 'a collaborator counts the change again');
    assert.equal(AppView._devCardMatches('gov', { kind: 'rename', my_vote: null }, { needsVote: true }), true,
      'and the settings decision');
  });
});
