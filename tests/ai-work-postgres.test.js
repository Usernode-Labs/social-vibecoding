'use strict';

// The AI tab's main view (#6019 follow-up) against the FULL PostgreSQL
// schema in a throwaway database: services/ai-work.js, and its route.
//
// What this pins:
//   1. A person's threads are the ones they are in by the followers' rule:
//      asked for it, built in it, voted in it, wrote in it, or chose Notify
//      me; never one they muted, or one in a private project they are not in.
//   2. Each is in one list: Up next (being made, up for a vote they voted on
//      or own, merging, going live), Waiting (nothing in flight), Live this
//      week. A vote they still owe is Needs you's, so it is in none.
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
  // Bob's, which she voted on: Up next.
  await request(app, 4, bob, 'Search');
  const searched = await change(app, 5, bob, 4, 'promoted', { promotedAt: new Date(Date.now() - 3600000) });
  await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [searched.id, ada.id]);
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
  assert.deepEqual(titles(work.next), ['Digest:going_live', 'Search:vote'], 'soonest first');
  assert.deepEqual(titles(work.waiting).sort(), ['Print view:not_picked_up', 'Tags:not_picked_up'].sort());
  assert.deepEqual(titles(work.live), ['Badges:live']);
  const all = [...work.next, ...work.waiting, ...work.live];
  assert.ok(!all.some((r) => r.title === 'Dark mode'), 'a vote she owes is Needs you\'s');
  assert.ok(!all.some((r) => r.title === 'Muted one'), 'muted');
  assert.ok(!all.some((r) => r.title === 'Secret'), 'a private project she is not in');
  assert.equal(work.waiting.find((r) => r.title === 'Tags').threadId, Number(tags.thread_id));
  assert.deepEqual(work.next[0].app, { slug: 'aw-seeds', name: 'Seed swap', icon_url: null, icon_emoji: null });
  assert.equal(work.next[0].href, '#app/aw-seeds/dev/issues/6', 'a request\'s thread opens on its page');

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
  assert.ok(Array.isArray(body.private) && Array.isArray(body.next) && Array.isArray(body.waiting) && Array.isArray(body.live));
});

test('the demo rows are obviously fake, and staging-only', () => {
  const src = fs.readFileSync(require.resolve('../src/routes/ai-work.js'), 'utf8');
  assert.match(src, /if \(IS_STAGING && req\.query\.demo === '1'\) return res\.json\(demoWork\(\)\);/);
  const { demoWork } = require('../src/routes/ai-work');
  const demo = demoWork();
  for (const row of [...demo.private, ...demo.next, ...demo.waiting, ...demo.live]) {
    assert.match(row.title, /^Staging demo/, row.title);
  }
});
