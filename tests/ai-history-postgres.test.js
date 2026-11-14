'use strict';

// The Homeroom bot tab's History card (services/ai-history.js) against the
// FULL PostgreSQL schema in a throwaway database, and its route.
//
// What this pins:
//   1. History is the person's threads once they have left the lists: a
//      change live for more than Live this week's week, one closed unmerged,
//      a request closed with nothing built, a decided vote. One row a thing,
//      in the person's own terms: a change they built or Homeroom bot built
//      from their request, a request somebody else built, a vote they cast.
//   2. What is still on the lists (live this week, going live, open) is not
//      History's, and a thread they only wrote in is nobody's history.
//   3. A private project they left keeps only their own changes and
//      requests; their votes there go.
//   4. Private threads: done more than a week ago, put away, or filed as a
//      request that has finished, which then leaves Needs you.
//   5. Pages, a kind and a project narrow it; the route is signed in only.
//   6. Staging's seeded private thread about a change that is live
//      (migrate.js seedStagingLiveChangePrivateThread) is History's for the
//      shots' member fixture, and not Needs you's.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/ai-history-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const DAY = 86400000;

test('the Homeroom bot tab\'s History against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `ai_history_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  require('../src/db/pool').getPool = () => pool;
  const aiWork = require('../src/services/ai-work');
  const aiHistory = require('../src/services/ai-history');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username, synthetic = false) => one(
    `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id, username`, [username, synthetic]);
  const ada = await user('ah_ada');
  const bob = await user('ah_bob');
  const bot = await user('homeroom-bot-ah', true);
  const project = (slug, visibility) => one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ($1, $1, 'running', $2, $3, $3) RETURNING id, slug`, [slug, bob.id, visibility]);
  const garden = await project('ah-garden', 'public');
  const club = await project('ah-club', 'private');
  const request = (a, number, by, title, state = 'open') => one(
    `INSERT INTO requests (app_id, number, title, created_by, state, closed_at)
     VALUES ($1, $2, $3, $4, $5::text, CASE WHEN $5::text = 'closed' THEN NOW() - interval '3 days' END) RETURNING id, thread_id`,
    [a.id, number, title, by.id, state]);
  const live = (a, pr, by, issue, daysAgo) => one(
    `INSERT INTO chat_sessions (app_id, user_id, pr_number, linked_issues, status, shared_at, promoted_at, merged_at, live_at)
     VALUES ($1, $2, $3, $4, 'merged', NOW(), NOW() - make_interval(days => $5::int + 1), NOW() - make_interval(days => $5::int), NOW() - make_interval(days => $5::int))
     RETURNING id`, [a.id, by.id, pr, [issue], daysAgo]);
  const closedChange = (a, pr, by, issue) => one(
    `INSERT INTO chat_sessions (app_id, user_id, pr_number, linked_issues, status, shared_at, promoted_at, archived_at)
     VALUES ($1, $2, $3, $4, 'archived', NOW(), NOW() - interval '6 days', NOW() - interval '5 days') RETURNING id`,
    [a.id, by.id, pr, [issue]]);
  const vote = (session, who, v) => pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, $3, 0)`, [session.id, who.id, v]);

  // Hers, live ten days ago: her change.
  await request(garden, 1, ada, 'Plot map');
  await live(garden, 2, ada, 1, 10);
  // Hers, built by Homeroom bot from her request: her change, by the bot.
  await request(garden, 3, ada, 'Watering reminders');
  await pool.query(`INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, 3, $2)`, [garden.id, ada.id]);
  await live(garden, 4, bot, 3, 12);
  // Hers, built by Bob: her request, shipped.
  await request(garden, 5, ada, 'Export to a spreadsheet');
  await live(garden, 6, bob, 5, 14);
  // Bob's, which she voted No on: her vote, merged.
  await request(garden, 7, bob, 'Gluten-free tag');
  await vote(await live(garden, 8, bob, 7, 11), ada, 'no');
  // Hers, closed without merging: her change, closed.
  await request(garden, 9, bob, 'Calendar sync');
  await closedChange(garden, 10, ada, 9);
  // Hers, closed with nothing built: her request, closed.
  await request(garden, 11, ada, 'Sign in with a code', 'closed');
  // Still on the lists: hers live yesterday (Live this week), and Bob's that
  // she only wrote in, live long ago (nobody's history).
  await request(garden, 13, ada, 'Weekly digest');
  await live(garden, 14, ada, 13, 1);
  await request(garden, 15, bob, 'Tag filter');
  await live(garden, 16, bob, 15, 20);
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, 'nice', 'issue', 15)`,
    [garden.id, ada.id]);
  // A decision she opened, passed by the group.
  const decision = await one(
    `INSERT INTO issues (app_id, kind, title, created_by, payload) VALUES ($1, 'rename', 'Rename to Garden club', $2, '{}') RETURNING id, thread_id`,
    [garden.id, ada.id]);
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(`SELECT set_config('app.wf_writer', 'transition', true)`);
    await tx.query(
      `UPDATE issues SET status = 'closed', payload = jsonb_build_object('appliedAt', (NOW() - interval '4 days')::text, 'appliedBy', 'group-vote')
        WHERE id = $1`, [decision.id]);
    await tx.query('COMMIT');
  } finally { tx.release(); }
  // A private project she is not in (any more): her own change stays, her vote goes.
  await request(club, 1, ada, 'Swap requests');
  await live(club, 2, ada, 1, 15);
  await request(club, 3, bob, 'Club colours');
  await vote(await live(club, 4, bob, 3, 16), ada, 'yes');

  const page = await aiHistory.historyFor(pool, { user: { id: ada.id }, deps: { bot } });
  const said = page.rows.filter((r) => r.kind !== 'solo').map((r) => `${r.title}:${r.kind}:${r.outcome}`);
  assert.deepEqual(said.sort(), [
    'Calendar sync:change:closed',
    'Export to a spreadsheet:request:shipped',
    'Gluten-free tag:vote:merged',
    'Plot map:change:live',
    'Rename to Garden club:vote:passed',
    'Sign in with a code:request:closed',
    'Swap requests:change:live',
    'Watering reminders:change:live',
  ].sort());
  const of = (title) => page.rows.find((r) => r.title === title);
  assert.equal(of('Watering reminders').by, 'bot', 'Homeroom bot built it from her request');
  assert.equal(of('Plot map').by, 'you');
  assert.equal(of('Gluten-free tag').myVote, 'no');
  assert.equal(of('Rename to Garden club').decision, true);
  assert.equal(of('Rename to Garden club').number, null, 'a decision has no number');
  assert.equal(of('Swap requests').left, true, 'a private project she is not in');
  assert.ok(!page.rows.some((r) => r.title === 'Club colours'), 'her vote there goes');
  assert.ok(!page.rows.some((r) => r.title === 'Weekly digest'), 'live this week is the lists\' own');
  assert.ok(!page.rows.some((r) => r.title === 'Tag filter'), 'one she only wrote in is nobody\'s history');
  const at = page.rows.map((r) => r.at);
  assert.deepEqual(at, [...at].sort().reverse(), 'newest first');
  assert.equal(of('Plot map').href, '#app/ah-garden/dev/issues/1');
  assert.equal(page.next, null, 'one page holds it all');

  // A kind and a project narrow it.
  const votes = await aiHistory.historyFor(pool, { user: { id: ada.id }, kind: 'vote', deps: { bot } });
  assert.deepEqual(votes.rows.map((r) => r.title).sort(), ['Gluten-free tag', 'Rename to Garden club']);
  const inClub = await aiHistory.historyFor(pool, { user: { id: ada.id }, project: 'ah-club', deps: { bot } });
  assert.deepEqual(inClub.rows.map((r) => r.title), ['Swap requests']);

  // Pages: two at a time, each page's `next` reading on from its last row.
  const seen = [];
  let before = null;
  for (let i = 0; i < 10; i++) {
    const p = await aiHistory.historyFor(pool, { user: { id: ada.id }, limit: 2, before, deps: { bot } });
    seen.push(...p.rows.map((r) => r.key));
    if (!p.next) break;
    before = p.next;
  }
  assert.deepEqual([...seen].sort(), page.rows.map((r) => r.key).sort(), 'paging reads every row once');

  // Private threads with Homeroom bot.
  const convo = await one(`INSERT INTO conversations (kind) VALUES ('direct') RETURNING id`);
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, status) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
    [convo.id, ada.id, bot.id]);
  const say = (sender, content, root = null) => one(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [convo.id, sender.id, content, root]);
  const thread = async (title, state, extra = {}) => {
    const root = await say(ada, title);
    await say(bot, 'Noted.', root.id);
    await pool.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state, result_ref, done_at)
       VALUES ($1, $2, $3, $4, 'idea', $5, $6, $7)`,
      [ada.id, convo.id, root.id, extra.app ? extra.app.id : null, state, extra.ref || null, extra.doneAt || null]);
    return root;
  };
  await thread('Ideas for a seed swap', 'done', { doneAt: new Date(Date.now() - 10 * DAY) });
  await thread('Done this week', 'done', { doneAt: new Date(Date.now() - 2 * DAY) });
  await thread('A put-away draft', 'dropped', { app: garden });
  const filedDone = await thread('Filed and closed', 'filed', { app: garden, ref: 11 });
  await thread('Filed, live this week', 'filed', { app: garden, ref: 13 });
  const solo = (await aiHistory.historyFor(pool, { user: { id: ada.id }, kind: 'solo', deps: { bot } })).rows;
  assert.deepEqual(solo.map((r) => `${r.title}:${r.outcome}`).sort(), [
    'A put-away draft:put_away',
    'Filed and closed:filed_closed',
    'Ideas for a seed swap:done',
  ].sort());
  assert.equal(solo.find((r) => r.title === 'Filed and closed').resultRef, 11);
  assert.equal(solo.find((r) => r.title === 'Ideas for a seed swap').app, null, 'an idea in no project');
  // The finished filed thread leaves Needs you: the lists read it as done.
  const work = await aiWork.workFor(pool, { user: { id: ada.id }, deps: { bot } });
  assert.equal(work.private.find((p) => p.rootId === filedDone.id).resultDone, true);
  const lists = aiWork.listsOf([], work);
  assert.ok(!lists.needsYou.some((r) => r.title === 'Filed and closed'), 'a filed thread whose request finished is History\'s');
  assert.ok(lists.needsYou.some((r) => r.title === 'A put-away draft'), 'a put-away one stays listed, as it was');

  // The route.
  const httpApp = express();
  httpApp.use((req, _res, next) => { req.user = req.get('x-test-user') ? { id: Number(req.get('x-test-user')) } : null; next(); });
  httpApp.use(require('../src/routes/ai-work').aiWorkRoutes({}));
  server = await new Promise((resolve) => { const s = httpApp.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/ai/history`)).status, 401);
  const headers = { 'x-test-user': String(ada.id) };
  assert.equal((await fetch(`${base}/api/ai/history?before=nonsense`, { headers })).status, 400);
  const res = await fetch(`${base}/api/ai/history?kind=change`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.rows) && body.rows.length > 0 && body.rows.every((r) => r.kind === 'change'));
  assert.ok('next' in body);

  // Staging's seed (13 Nov 2026): a private thread about the fake change
  // seedStagingMergedVoteRow puts live, for the shots' member fixture. It is
  // History's ("Live"), never a Needs you row, and seeding twice adds nothing.
  const migrate = require('../src/db/migrate');
  const source = require('node:fs').readFileSync(require.resolve('../src/db/migrate'), 'utf8');
  assert.equal(source.split('\'staging-fixture/merged-vote-row\'').length - 1, 2,
    'the thread is about the change seedStagingMergedVoteRow seeds, found by its branch');
  assert.ok(source.indexOf('await seedStagingLiveChangePrivateThread(pool);') > source.indexOf('await seedStagingMergedVoteRow(pool, config);'),
    'seeded after its change');
  const capture = await user('usernode-capture');
  const stagingBot = await user('homeroom_bot', true);
  const home = await project('ah-home', 'public');
  await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, pr_number, pr_title, session_title, status, merged_at, live_at, created_at)
     VALUES ($1, $2, 'staging-fixture/merged-vote-row', 9042, '[staging fixture] Books read list', '[staging fixture] Books read list',
             'merged', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '1 day')`,
    [home.id, bob.id]);
  const theirs = await one(`INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`, [capture.id]);
  await pool.query(
    `INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id) VALUES ($1, $2, $3)`,
    [theirs.id, Math.min(capture.id, stagingBot.id), Math.max(capture.id, stagingBot.id)]);
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role, status) VALUES ($1, $2, 'member', 'member'), ($1, $3, 'member', 'member')`,
    [theirs.id, capture.id, stagingBot.id]);
  const env = process.env.USERNODE_ENV;
  try {
    delete process.env.USERNODE_ENV;
    await migrate.seedStagingLiveChangePrivateThread(pool);
    assert.equal((await one('SELECT COUNT(*)::int AS n FROM private_threads WHERE user_id = $1', [capture.id])).n, 0, 'a no-op outside staging');
    process.env.USERNODE_ENV = 'staging';
    await migrate.seedStagingLiveChangePrivateThread(pool);
    await migrate.seedStagingLiveChangePrivateThread(pool);
  } finally {
    if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
  }
  const seeded = (await pool.query(
    'SELECT root_message_id, about_kind, about_number, state FROM private_threads WHERE user_id = $1', [capture.id])).rows;
  assert.deepEqual(seeded.map((r) => [r.about_kind, r.about_number, r.state]), [['change', 9042, 'open']], 'one thread, however often it is seeded');
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1', [theirs.id])).n, 3);
  const theirWork = await aiWork.workFor(pool, { user: { id: capture.id }, deps: { bot: stagingBot } });
  assert.equal(theirWork.private.find((p) => p.rootId === Number(seeded[0].root_message_id)).resultDone, true);
  assert.deepEqual(aiWork.listsOf([], theirWork).needsYou.filter((r) => /Books read list/.test(r.title)), [], 'not under Needs you');
  const theirPast = (await aiHistory.historyFor(pool, { user: { id: capture.id }, kind: 'solo', deps: { bot: stagingBot } })).rows;
  assert.deepEqual(theirPast.map((r) => `${r.title}:${r.outcome}:${r.app.slug}`), ['[staging fixture] Books read list:live:ah-home']);
});

test('History\'s demo rows are obviously fake, two pages of them', () => {
  const { demoHistory } = require('../src/routes/ai-work');
  const first = demoHistory();
  assert.ok(first.rows.length > 0 && first.next);
  for (const row of first.rows) assert.match(row.title, /^Staging demo/);
  const second = demoHistory({ before: first.next });
  assert.ok(second.rows.length > 0, 'Earlier months has something to show');
  assert.equal(second.next, null);
  const keys = new Set([...first.rows, ...second.rows].map((r) => r.key));
  assert.equal(keys.size, first.rows.length + second.rows.length, 'no row on both pages');
  assert.ok(first.rows.some((r) => r.left), 'a community the person left');
  assert.deepEqual(demoHistory({ kind: 'vote' }).rows.map((r) => r.kind).filter((k) => k !== 'vote'), []);
});
