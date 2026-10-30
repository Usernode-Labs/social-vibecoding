'use strict';

// The AI tab's main view (#6019 follow-up) against the FULL PostgreSQL
// schema in a throwaway database: services/ai-work.js, and its route.
//
// What this pins:
//   1. A person's threads are the ones they are in by the followers' rule:
//      asked for it, built in it, voted in it, wrote in it, or chose Notify
//      me; never one they muted, or one in a private project they are not in.
//   2. Each is in one list: In progress (theirs, being made, up for a vote
//      they voted on or own, merging, going live), Waiting (nothing in
//      flight), Live this week. A vote they still owe is Needs you's, so it
//      is in none, and one they only voted or wrote in is in progress
//      without asking anything of them, so it is not listed (29 Oct 2026).
//   3. Private threads are their own threads in the chat with the bot that
//      have gone nowhere yet, and the bot's drafts for them.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/ai-work-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the AI tab\'s work against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `ai_work_${crypto.randomBytes(6).toString('hex')}`;
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
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);
  require('../src/db/pool').getPool = () => pool;
  const aiWork = require('../src/services/ai-work');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username, synthetic = false) => one(
    `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id, username`, [username, synthetic]);
  const ada = await user('aw_ada');
  const bob = await user('aw_bob');
  const bot = await user('homeroom-bot-aw', true);
  const app = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Seed swap', 'aw-seeds', 'running', $1, 'public', 'public') RETURNING id, slug`, [bob.id]);
  const hidden = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Hidden', 'aw-hidden', 'running', $1, 'private', 'private') RETURNING id, slug`, [bob.id]);
  const request = (a, number, by, title, state = 'open') => one(
    `INSERT INTO requests (app_id, number, title, created_by, state) VALUES ($1, $2, $3, $4, $5) RETURNING id, thread_id`,
    [a.id, number, title, by.id, state]);
  const change = (a, pr, by, issue, status, extra = {}) => one(
    `INSERT INTO chat_sessions (app_id, user_id, pr_number, linked_issues, status, shared_at, promoted_at, merged_at, live_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8) RETURNING id`,
    [a.id, by.id, pr, [issue], status, extra.promotedAt || null, extra.mergedAt || null, extra.liveAt || null]);

  // Hers: asked for, nothing in flight.
  await request(app, 1, ada, 'Print view');
  // Hers, with Bob's change up for a vote she has not voted on: Needs you's.
  await request(app, 2, ada, 'Dark mode');
  await change(app, 3, bob, 2, 'promoted', { promotedAt: new Date() });
  // Bob's, which she only voted on: nothing left for her, so not listed.
  await request(app, 4, bob, 'Search');
  const searched = await change(app, 5, bob, 4, 'promoted', { promotedAt: new Date(Date.now() - 3600000) });
  await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [searched.id, ada.id]);
  // Hers, with Bob's change she voted Yes on: In progress, saying so.
  await request(app, 12, ada, 'Filters');
  const filters = await change(app, 13, bob, 12, 'promoted', { promotedAt: new Date(Date.now() - 2 * 3600000) });
  await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [filters.id, ada.id]);
  // Hers, which Homeroom bot is building; and Bob's, being built, where she
  // only wrote.
  await request(app, 14, ada, 'Calendar');
  await change(app, 15, bot, 14, 'active');
  await request(app, 16, bob, 'Export');
  await change(app, 17, bob, 16, 'active');
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, 'csv please', 'issue', 16)`,
    [app.id, ada.id]);
  // Hers, merged and going live; and hers, live yesterday. Only the merge
  // machine makes a merged row that is not live yet (schema.sql
  // chat_sessions_inserted_merged_live), so the first is written as it.
  await request(app, 6, ada, 'Digest');
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(`SELECT set_config('app.wf_writer', 'transition', true)`);
    await tx.query(
      `INSERT INTO chat_sessions (app_id, user_id, pr_number, linked_issues, status, shared_at, merged_at)
       VALUES ($1, $2, 7, '{6}', 'merged', NOW(), NOW())`, [app.id, bob.id]);
    await tx.query('COMMIT');
  } finally { tx.release(); }
  await request(app, 8, ada, 'Badges');
  await change(app, 9, bob, 8, 'merged', { mergedAt: new Date(Date.now() - 2 * 86400000), liveAt: new Date(Date.now() - 86400000) });
  // Bob's, where she only wrote; and Bob's, which she muted.
  await request(app, 10, bob, 'Tags');
  const tags = await one('SELECT thread_id FROM requests WHERE app_id = $1 AND number = 10', [app.id]);
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, 'yes please', 'issue', 10)`,
    [app.id, ada.id]);
  await request(app, 11, ada, 'Muted one');
  const muted = await one('SELECT thread_id FROM requests WHERE app_id = $1 AND number = 11', [app.id]);
  await pool.query('INSERT INTO thread_followers (thread_id, user_id, muted_at) VALUES ($1, $2, NOW())', [muted.thread_id, ada.id]);
  // Hers, in a private project she is not in.
  await request(hidden, 1, ada, 'Secret');

  const work = await aiWork.workFor(pool, { user: { id: ada.id }, deps: { bot } });
  const titles = (list) => list.map((r) => `${r.title}:${r.what}`);
  assert.deepEqual(titles(work.next), ['Digest:going_live', 'Calendar:building'], 'hers only, being worked on, soonest first');
  assert.equal(work.next.find((r) => r.title === 'Calendar').by, 'bot', 'Homeroom bot is building it');
  // Up next: hers waiting on other people's votes first, then the requests nobody has picked up.
  assert.equal(titles(work.waiting)[0], 'Filters:vote');
  assert.equal(work.waiting[0].myVote, 'yes');
  assert.deepEqual(titles(work.waiting).slice(1).sort(), ['Print view:not_picked_up', 'Tags:not_picked_up'].sort());
  assert.deepEqual(work.needs, [], 'no plan of the bot\'s waits for her');
  assert.deepEqual(titles(work.live), ['Badges:live']);
  const all = [...work.needs, ...work.next, ...work.waiting, ...work.live];
  assert.ok(!all.some((r) => r.title === 'Dark mode'), 'a vote she owes is Needs you\'s');
  assert.ok(!all.some((r) => r.title === 'Search'), 'one she only voted on');
  assert.ok(!all.some((r) => r.title === 'Export'), 'one she only wrote in, being built');
  assert.ok(!all.some((r) => r.title === 'Muted one'), 'muted');
  assert.ok(!all.some((r) => r.title === 'Secret'), 'a private project she is not in');
  assert.equal(work.waiting.find((r) => r.title === 'Tags').threadId, Number(tags.thread_id));
  assert.deepEqual(work.next[0].app, { slug: 'aw-seeds', name: 'Seed swap', icon_url: null, icon_emoji: null });
  assert.equal(work.next[0].href, '#app/aw-seeds/dev/issues/6', 'a request\'s thread opens on its page');

  // 30 Oct 2026: a decision up for the group's vote has nothing to build. Hers
  // waits for votes; one she voted on and follows says how she voted; one
  // whose vote she still owes is the Needs you feed's.
  const decision = (by, title) => one(
    `INSERT INTO issues (app_id, kind, title, created_by, payload) VALUES ($1, 'rename', $2, $3, '{}') RETURNING id, thread_id`,
    [app.id, title, by.id]);
  await decision(ada, 'Rename to Seed Box');
  const owed = await decision(bob, 'Rename to Seed Shop');
  const votedOn = await decision(bob, 'Rename to Seeds');
  await pool.query(`INSERT INTO issue_votes (issue_id, user_id, vote) VALUES ($1, $2, 'no')`, [votedOn.id, ada.id]);
  await pool.query('INSERT INTO thread_followers (thread_id, user_id) VALUES ($1, $3), ($2, $3)',
    [owed.thread_id, votedOn.thread_id, ada.id]);
  const decided = (await aiWork.workFor(pool, { user: { id: ada.id }, deps: { bot } })).waiting
    .filter((r) => r.kind === 'decision').map((r) => [r.title, r.what, r.myVote, r.number]);
  assert.deepEqual(decided.sort(), [
    ['Rename to Seed Box', 'decision', null, null],
    ['Rename to Seeds', 'decision', 'no', null],
  ], 'they wait for votes, not for somebody to build them; the one she owes is Needs you\'s');

  // 30 Oct 2026: somebody who votes on everything. A week of changes going
  // live and of requests she only wrote in no longer push her own request off
  // the end: Homeroom bot's plan for it, waiting for her Build it, is read and
  // listed, and so is Live this week, up to its own most rows. A thread
  // closed with nothing merged can never be listed, so it is not read.
  const busy = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Busy', 'aw-busy', 'running', $1, 'public', 'public') RETURNING id, slug`, [bob.id]);
  const cara = await user('aw_cara');
  await pool.query(
    `INSERT INTO requests (app_id, number, title, created_by, updated_at) VALUES ($1, 1, 'Her old plan', $2, NOW() - interval '3 days')`,
    [busy.id, cara.id]);
  await pool.query(
    `INSERT INTO requests (app_id, number, title, created_by) SELECT $1, n, 'Live ' || n, $2 FROM generate_series(100, 189) n`,
    [busy.id, bob.id]);
  await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, pr_number, linked_issues, status, shared_at, merged_at, live_at)
     SELECT $1, $2, n + 1000, ARRAY[n], 'merged', NOW(), NOW() - interval '2 hours', NOW() - interval '1 hour'
       FROM generate_series(100, 189) n`, [busy.id, bob.id]);
  await pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) SELECT id, $2, 'yes', 0 FROM chat_sessions WHERE app_id = $1`,
    [busy.id, cara.id]);
  for (const [from, to, state] of [[200, 289, 'open'], [300, 389, 'closed']]) {
    await pool.query(
      `INSERT INTO requests (app_id, number, title, created_by, state) SELECT $1, n, 'Asked ' || n, $2, $5 FROM generate_series($3::int, $4::int) n`,
      [busy.id, bob.id, from, to, state]);
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) SELECT $1, $2, '+1', 'issue', n FROM generate_series($3::int, $4::int) n`,
      [busy.id, cara.id, from, to]);
  }
  const planned = {
    liveSvc: { isStaging: () => false },
    settings: { mode: 'live' },
    progress: { requestStates: async () => [{ row: { slug: 'aw-busy', issue_number: 1 }, state: { stage: 'plan', since: null } }] },
  };
  const read = await pool.query(aiWork.THREADS_SQL, [cara.id, false, false, aiWork.THREADS_MAX, aiWork.LIVE_DAYS]);
  assert.ok(!read.rows.some((r) => r.state === 'closed' && r.change_status !== 'merged'), 'closed with nothing merged: not read');
  const busyWork = await aiWork.workFor(pool, { user: { id: cara.id }, deps: { bot, ...planned } });
  assert.deepEqual(busyWork.needs.map((r) => `${r.title}:${r.what}`), ['Her old plan:plan'], 'the bot\'s plan waits for her Build it');
  assert.equal(busyWork.live.length, aiWork.THREADS_MAX, 'Live this week reads its own most rows');

  // Private threads: her own message with replies, and the bot's draft for her.
  const convo = await one(`INSERT INTO conversations (kind) VALUES ('direct') RETURNING id`);
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, status) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
    [convo.id, ada.id, bot.id]);
  const say = (sender, content, root = null) => one(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [convo.id, sender.id, content, root]);
  const idea = await say(ada, 'A calendar for the garden\nwith frost dates');
  await say(bot, 'Who is it for?', idea.id);
  await say(ada, 'just a thought'); // no replies: not a thread
  const opened = await say(bot, 'I drafted it as a request.');
  await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state)
     VALUES ($1, $2, $3, $4, 'draft_request', 'open')`,
    [ada.id, convo.id, opened.id, app.id]);
  const filed = await say(ada, 'Already filed');
  await say(bot, 'Filed.', filed.id);
  await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state, result_ref)
     VALUES ($1, $2, $3, $4, 'draft_request', 'filed', 12)`,
    [ada.id, convo.id, filed.id, app.id]);
  const mine = (await aiWork.workFor(pool, { user: { id: ada.id }, deps: { bot } })).private;
  assert.deepEqual(mine.map((p) => [p.title, p.kind, p.app ? p.app.slug : null]).sort(), [
    ['A calendar for the garden', 'idea', null],
    ['I drafted it as a request.', 'draft_request', 'aw-seeds'],
  ].sort(), 'open ones only; a filed one is a public thread now');

  // The route: signed in only.
  const httpApp = express();
  httpApp.use((req, _res, next) => { req.user = req.get('x-test-user') ? { id: Number(req.get('x-test-user')) } : null; next(); });
  httpApp.use(require('../src/routes/ai-work').aiWorkRoutes({}));
  server = await new Promise((resolve) => { const s = httpApp.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/ai/work`)).status, 401);
  const res = await fetch(`${base}/api/ai/work`, { headers: { 'x-test-user': String(ada.id) } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.private) && Array.isArray(body.needs) && Array.isArray(body.next) && Array.isArray(body.waiting) && Array.isArray(body.live));
});

test('the demo rows are obviously fake, and staging-only', () => {
  const src = fs.readFileSync(require.resolve('../src/routes/ai-work.js'), 'utf8');
  assert.match(src, /if \(IS_STAGING && req\.query\.demo === '1'\) return res\.json\(demoWork\(\)\);/);
  const { demoWork } = require('../src/routes/ai-work');
  const demo = demoWork();
  for (const row of [...demo.private, ...demo.needs, ...demo.next, ...demo.waiting, ...demo.live]) {
    assert.match(row.title, /^Staging demo/, row.title);
  }
});
