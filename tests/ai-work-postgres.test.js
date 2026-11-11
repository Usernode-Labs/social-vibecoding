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
//   4. A request somebody pressed Claim on is being built, by who has it
//      (30 Oct 2026), and Homeroom bot's status answer reads the lists the
//      page draws (pageLists): the Needs you feed for her threads, then these.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/ai-work-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { settleWorkStates } = require('./lib/work-states');
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
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
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
    `INSERT INTO chat_sessions (app_id, user_id, pr_number, linked_issues, status, shared_at, promoted_at, merged_at, live_at, check_state)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9) RETURNING id`,
    [a.id, by.id, pr, [issue], status, extra.promotedAt || null, extra.mergedAt || null, extra.liveAt || null, extra.checkState || null]);

  // Hers: asked for, nothing in flight. 1 Nov 2026: her posted plan for it
  // (request-specs.js, no branch) is no change in flight.
  await request(app, 1, ada, 'Print view');
  await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, source, created_from_issue_number, linked_issues, issue_link_seeded, session_title)
     VALUES ($1, $2, NULL, 'paused', 'request_spec', 1, '{1}', TRUE, 'Plan for #1 Print view')`, [app.id, ada.id]);
  // Hers, with Bob's change up for a vote she has not voted on: Needs you's.
  await request(app, 2, ada, 'Dark mode');
  await change(app, 3, bob, 2, 'promoted', { promotedAt: new Date(), checkState: 'passing' });
  // Bob's, which she only voted on: nothing left for her, so not listed.
  await request(app, 4, bob, 'Search');
  const searched = await change(app, 5, bob, 4, 'promoted', { promotedAt: new Date(Date.now() - 3600000), checkState: 'passing' });
  await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [searched.id, ada.id]);
  // Hers, with Bob's change she voted Yes on: In progress, saying so.
  await request(app, 12, ada, 'Filters');
  const filters = await change(app, 13, bob, 12, 'promoted', { promotedAt: new Date(Date.now() - 2 * 3600000), checkState: 'passing' });
  await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [filters.id, ada.id]);
  // Hers, with Bob's change she voted Yes on whose checks have not passed yet:
  // it waits for its checks, not for votes (#6060).
  await request(app, 21, ada, 'Check pending');
  const pending = await change(app, 22, bob, 21, 'promoted', { promotedAt: new Date(Date.now() - 3600000), checkState: 'pending' });
  await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [pending.id, ada.id]);
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
  await request(app, 6, ada, 'Digest', 'closed');
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
  // 5 Nov 2026: each row says its stored work state's stage (services/work-state.js).
  const titles = (list) => list.map((r) => `${r.title}:${r.work.stage}`);
  assert.deepEqual(titles(work.next), ['Filters:going_live', 'Digest:going_live', 'Calendar:building'],
    'hers, being worked on, soonest first');
  assert.equal(work.next.find((r) => r.title === 'Calendar').by, 'bot', 'Homeroom bot is building it');
  assert.ok(!work.next.some((r) => r.title === 'Print view'), 'a posted plan is not a change being built');
  // Waiting: a change still waiting on its checks first, then the requests
  // nobody has picked up.
  // #6594: Filters has the yes its rule needs, so it is going live (In
  // progress), not waiting to be voted on; Check pending is approved too and
  // its line says what it waits on.
  assert.equal(titles(work.waiting)[0], 'Check pending:checking', 'its checks have not passed: it says checks, not votes');
  assert.deepEqual(work.waiting[0].work.line, { code: 'approved_checking' }, 'approved, and waiting on its own checks');
  assert.deepEqual(titles(work.waiting).slice(1).sort(), ['Print view:reading', 'Tags:reading'].sort());
  assert.deepEqual(work.waiting.find((r) => r.title === 'Tags').work.line, { code: 'waiting' }, 'nobody has started on it');
  assert.deepEqual(work.needs, [], 'no plan of the bot\'s waits for her');
  assert.deepEqual(titles(work.live), ['Badges:live']);
  const all = [...work.needs, ...work.next, ...work.waiting, ...work.live];
  assert.ok(!all.some((r) => r.title === 'Dark mode'), 'a vote she owes is Needs you\'s');
  assert.ok(!all.some((r) => r.title === 'Search'), 'one she only voted on');
  assert.ok(!all.some((r) => r.title === 'Export'), 'one she only wrote in, being built');
  assert.ok(!all.some((r) => r.title === 'Muted one'), 'muted');
  assert.ok(!all.some((r) => r.title === 'Secret'), 'a private project she is not in');
  assert.equal(work.waiting.find((r) => r.title === 'Tags').threadId, Number(tags.thread_id));
  assert.deepEqual(work.next[0].app, { slug: 'aw-seeds', name: 'Seed swap', icon_url: null, icon_emoji: null, changesOnGithub: false },
    'the project\'s host rides along as a word, never the address');
  // 3 Nov 2026: on GitHub a change's number is GitHub's own (written "PR N"),
  // so the app says so; the git host shares one counter and keeps "#N".
  await pool.query(`UPDATE apps SET repo_url = 'https://github.com/acme/seed-swap' WHERE id = $1`, [app.id]);
  const onGithub = await aiWork.workFor(pool, { user: { id: ada.id }, deps: { bot } });
  assert.equal(onGithub.next[0].app.changesOnGithub, true, 'a github.com repository');
  assert.ok(!('repo_url' in onGithub.next[0].app), 'the address itself is not sent');
  await pool.query(`UPDATE apps SET repo_url = 'https://git.onhomeroom.com/apps/aw-seeds' WHERE id = $1`, [app.id]);
  const onGitHost = await aiWork.workFor(pool, { user: { id: ada.id }, deps: { bot } });
  assert.equal(onGitHost.next[0].app.changesOnGithub, false, 'Homeroom\'s git host');
  await pool.query(`UPDATE apps SET repo_url = NULL WHERE id = $1`, [app.id]);
  assert.equal(work.next.find((r) => r.title === 'Digest').href, '#app/aw-seeds/dev/issues/6',
    'a request\'s thread opens on its page');

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
  const decisions = (await aiWork.workFor(pool, { user: { id: ada.id }, deps: { bot } })).waiting
    .filter((r) => r.kind === 'decision');
  const decided = decisions.map((r) => [r.title, r.work.stage, r.myVote, r.number]);
  assert.deepEqual(decided.sort(), [
    ['Rename to Seed Box', 'up_for_vote', null, null],
    ['Rename to Seeds', 'up_for_vote', 'no', null],
  ], 'they wait for votes, not for somebody to build them; the one she owes is Needs you\'s');
  // 1 Nov 2026: a decision's row opens the decision's own page, not the Workshop.
  assert.equal(decisions.find((r) => r.title === 'Rename to Seeds').href, `#app/aw-seeds/dev/governance/${votedOn.id}`);

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
  // Homeroom bot's plan for it waits for her Build it.
  await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, 1, $2)', [busy.id, cara.id]);
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, awaiting_go_at, created_at)
     VALUES ($1, 1, 'live', 'ready', NOW() - interval '2 days', NOW() - interval '2 days')`, [busy.id]);
  const planned = {};
  const read = await pool.query(aiWork.THREADS_SQL, [cara.id, false, false, aiWork.THREADS_MAX, aiWork.LIVE_DAYS]);
  assert.ok(!read.rows.some((r) => r.state === 'closed' && r.change_status !== 'merged'), 'closed with nothing merged: not read');
  const busyWork = await aiWork.workFor(pool, { user: { id: cara.id }, deps: { bot, ...planned } });
  assert.deepEqual(busyWork.needs.map((r) => `${r.title}:${r.work.stage}:${r.work.why}`), ['Her old plan:waiting_for_you:plan'],
    'the bot\'s plan waits for her Build it');
  assert.equal(busyWork.live.length, aiWork.THREADS_MAX, 'Live this week reads its own most rows');

  // 30 Oct 2026: claimed, with no change yet. Bob's claim on hers is In
  // progress, named for him; her own claim is hers; a claim older than the
  // week the bot gives one is no claim.
  await request(app, 18, ada, 'Sound toggle');
  await request(app, 19, ada, 'Pause button');
  await request(app, 20, ada, 'Old claim');
  await pool.query(
    `INSERT INTO issue_claims (app_id, github_issue_number, user_id, claimed_at)
     VALUES ($1, 18, $2, NOW()), ($1, 19, $3, NOW()), ($1, 20, $2, NOW() - interval '8 days')`,
    [app.id, bob.id, ada.id]);
  const claimed = await aiWork.workFor(pool, { user: { id: ada.id }, deps: { bot } });
  const of = (title) => [...claimed.next, ...claimed.waiting].find((r) => r.title === title);
  assert.deepEqual([of('Sound toggle').work.stage, of('Sound toggle').by, of('Sound toggle').work.line], ['building', 'someone', { code: 'claimed', by: 'aw_bob' }]);
  assert.deepEqual([of('Pause button').work.stage, of('Pause button').by], ['building', 'you']);
  assert.deepEqual([of('Old claim').work.stage, of('Old claim').work.line], ['reading', { code: 'waiting' }],
    'a claim past its week, and no bot run: nobody has started on it');

  // #6158: the bot's own records say what a request waits on, whoever filed
  // it. Two requests held for a vote slot carry their place among the
  // project's held builds, oldest first; one in the bot's queue carries its
  // place in the project's line.
  for (const [number, days] of [[30, 2], [31, 1]]) {
    await request(app, number, bob, `Held ${number}`);
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cap_suppressed, created_at)
       VALUES ($1, $2, 'live', 'ready', 'proposals_per_app', NOW() - make_interval(days => $3))`,
      [app.id, number, days]);
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref)
       VALUES ($1, $2, 'me too', 'issue', $3)`, [app.id, ada.id, number]);
  }
  await request(app, 32, bob, 'Queued for a read');
  await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, enqueued_at)
     VALUES ($1, 32, 2, NOW() - INTERVAL '1 hour')`, [app.id]);
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref)
     VALUES ($1, $2, 'me too', 'issue', 32)`, [app.id, ada.id]);
  const withFacts = await aiWork.workFor(pool, { user: { id: ada.id }, deps: { bot, settings: { mode: 'live' } } });
  const fact = (title) => withFacts.waiting.find((r) => r.title === title);
  assert.deepEqual([fact('Held 30').work.stage, fact('Held 30').work.line], ['building', { code: 'held_waiting', position: 1 }],
    'ready to build, held for a vote slot');
  assert.deepEqual([fact('Queued for a read').work.stage, fact('Queued for a read').work.line], ['reading', { code: 'queued', place: 1 }],
    'its place in the project\'s line, from the bot\'s queue');

  // Homeroom bot's answer: the page's lists. The votes she owes (Bob's change
  // for her Dark mode, the rename) are Needs you's, from the feed (a
  // member's, so she joins); the rest are the lists above.
  await pool.query(
    `INSERT INTO community_members (community_id, user_id) SELECT community_id, $2 FROM apps WHERE id = $1 ON CONFLICT DO NOTHING`,
    [app.id, ada.id]);
  const page = await aiWork.pageLists(pool, { user: { id: ada.id }, deps: { bot } });
  assert.ok(page.needsYou.some((r) => r.number === 2 && r.says === 'waits for their vote'), 'Bob\'s change, by her request\'s number');
  assert.ok(page.needsYou.some((r) => r.title === 'Rename to Seed Shop' && r.says === 'waits for their vote'), 'and the decision she owes');
  assert.ok(page.inProgress.some((r) => r.title === 'Sound toggle' && r.says === 'Building · aw_bob is building it'));
  // #6594: Filters has the yes its rule needs, so the bot's answer puts it
  // in progress, going live, not among the votes she is waiting on.
  assert.ok(page.inProgress.some((r) => r.title === 'Filters' && r.says === 'Going live'));
  assert.deepEqual(page.liveThisWeek.map((r) => r.title), ['Badges']);
  assert.equal(page.counts.inProgress, page.inProgress.length);

  // #6245 (4 Nov 2026): opening a change's page, or its preview waking,
  // writes chat_sessions.last_activity_at. No list's sort reads it any more,
  // so neither a row's place nor its sort key moves.
  const threadRows = async () => (await pool.query(
    aiWork.THREADS_SQL, [ada.id, false, false, aiWork.THREADS_MAX, aiWork.LIVE_DAYS])).rows;
  const beforeView = await threadRows();
  await pool.query('UPDATE chat_sessions SET last_activity_at = NOW() WHERE app_id = $1', [app.id]);
  const afterView = await threadRows();
  assert.deepEqual(afterView.map((r) => r.id), beforeView.map((r) => r.id), 'looking at something moves no row');
  assert.deepEqual(afterView.map((r) => r.sort_at), beforeView.map((r) => r.sort_at), 'and changes no sort key');

  // #6245: Needs you is ordered by when each item began needing you, newest
  // first. A change promoted earlier but touched more recently stays below
  // the one promoted later, and each card is timed from when its vote opened.
  await request(app, 40, ada, 'Gallery A');
  const earlier = await change(app, 41, bob, 40, 'promoted', { promotedAt: new Date(Date.now() - 7200000), checkState: 'passing' });
  await request(app, 42, ada, 'Gallery B');
  const later = await change(app, 43, bob, 42, 'promoted', { promotedAt: new Date(Date.now() - 3600000), checkState: 'passing' });
  await pool.query('UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1', [earlier.id]);
  const workshop = require('../src/routes/workshop-overview');
  await settleWorkStates(pool);
  const feed = await workshop.needsFeedFor(pool, { user: { id: ada.id }, inThreads: true });
  const pair = feed.filter((item) => item.kind === 'proposal' && [41, 43].includes(item.number));
  assert.deepEqual(pair.map((item) => item.number), [43, 41], 'the vote that opened later comes first');
  const promotedAt = async (id) => (await one('SELECT promoted_at FROM chat_sessions WHERE id = $1', [id])).promoted_at.toISOString();
  assert.equal(pair[0].at, await promotedAt(later.id), 'timed from when its vote opened, not its last activity');
  assert.equal(pair[1].at, await promotedAt(earlier.id));

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
    ['Already filed', 'draft_request', 'aw-seeds'],
    ['I drafted it as a request.', 'draft_request', 'aw-seeds'],
  ].sort(), '#6250: a filed thread stays listed, as an open one does');
  // #6153: one holding a design stays listed once filed, and says where it
  // went: the tab draws it as that request's row (model.ts needsYou).
  await pool.query(
    `INSERT INTO design_threads (private_thread_id, title, surface, width, height)
     SELECT id, 'Seed packets', 'app', 390, 844 FROM private_threads WHERE root_message_id = $1`, [filed.id]);
  const listedNow = (await aiWork.workFor(pool, { user: { id: ada.id }, deps: { bot } })).private;
  const design = listedNow.find((p) => p.rootId === filed.id);
  assert.deepEqual([design.title, design.state, design.resultRef, design.app.slug], ['Seed packets', 'filed', 12, 'aw-seeds']);
  assert.equal(listedNow.find((p) => p.rootId === opened.id).state, 'open');
  assert.equal(listedNow.find((p) => p.rootId === idea.id).resultRef, undefined, 'one that went nowhere has no number');

  // #6271: a private thread marked done this week stays listed for a week
  // (Live this week's), with the day it closed; one closed longer ago goes.
  const closed = await say(ada, 'Swap reminders by email');
  await say(bot, 'Done.', closed.id);
  await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state, done_at)
     VALUES ($1, $2, $3, $4, 'idea', 'done', NOW() - INTERVAL '2 days')`,
    [ada.id, convo.id, closed.id, app.id]);
  const oldClosed = await say(ada, 'An older finished idea');
  await say(bot, 'Done.', oldClosed.id);
  await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state, done_at)
     VALUES ($1, $2, $3, $4, 'idea', 'done', NOW() - INTERVAL '10 days')`,
    [ada.id, convo.id, oldClosed.id, app.id]);
  const afterDone = (await aiWork.workFor(pool, { user: { id: ada.id }, deps: { bot } })).private;
  const closedRow = afterDone.find((p) => p.rootId === closed.id);
  assert.deepEqual([closedRow.state, typeof closedRow.doneAt], ['done', 'string'], 'a done thread is read with the day it closed');
  assert.equal(afterDone.find((p) => p.rootId === oldClosed.id), undefined, 'one closed longer than a week is not read');
  assert.equal(aiWork.shapePrivate({ root_id: 1, content: 'x', state: 'done', done_at: null }).doneAt, undefined,
    'a done thread with no day says none');
  // Homeroom bot's answer reads it as Live this week's, never Needs you's.
  const afterLists = await aiWork.pageLists(pool, { user: { id: ada.id }, deps: { bot } });
  assert.equal(afterLists.needsYou.some((r) => r.title === 'Swap reminders by email'), false, 'closed is not Needs you\'s');
  const liveClosed = afterLists.liveThisWeek.filter((r) => r.title === 'Swap reminders by email');
  assert.equal(liveClosed.length, 1, 'it is Live this week\'s');
  assert.match(liveClosed[0].says, /^closed/);
  assert.equal(afterLists.liveThisWeek.some((r) => r.title === 'An older finished idea'), false);
  assert.equal(afterLists.counts.liveThisWeek, afterLists.liveThisWeek.length, 'the heading\'s count includes it');

  // A request of Bob's she pressed Claim on is hers to build, though she
  // never filed it, wrote in it or started a change: the Workshop listed it
  // as her work (AppView._issueIsMine), and the tab does too.
  await request(app, 50, bob, 'Seed labels');
  await pool.query('INSERT INTO issue_claims (app_id, github_issue_number, user_id) VALUES ($1, 50, $2)', [app.id, ada.id]);
  // Her own change whose checks failed waits on her fix: Needs you's, with
  // Fix it, never "Waiting for checks". One whose preview did not build is
  // too; Homeroom bot's change with failing checks is the bot's to fix.
  await request(app, 51, ada, 'Frost alerts');
  await change(app, 52, ada, 51, 'promoted', { promotedAt: new Date(), checkState: 'failing' });
  await request(app, 53, ada, 'Rain gauge');
  const broken = await change(app, 54, ada, 53, 'promoted', { promotedAt: new Date(), checkState: 'error' });
  await pool.query(`UPDATE chat_sessions SET staging_url = NULL, check_error_detail = 'image did not boot' WHERE id = $1`, [broken.id]);
  await request(app, 55, ada, 'Bot fixes its own');
  await change(app, 56, bot, 55, 'promoted', { promotedAt: new Date(), checkState: 'failing' });
  const fixes = await aiWork.workFor(pool, { user: { id: ada.id }, deps: { bot } });
  const claimedBySelf = [...fixes.next, ...fixes.waiting].find((r) => r.title === 'Seed labels');
  assert.deepEqual([claimedBySelf?.group, claimedBySelf?.work.stage, claimedBySelf?.work.line?.code, claimedBySelf?.by],
    ['next', 'building', 'claimed', 'you'], 'her claim on Bob\'s request is her work');
  assert.deepEqual(fixes.needs.filter((r) => r.fixYours === true).map((r) => r.title).sort(), ['Frost alerts', 'Rain gauge']);
  const everything = [...fixes.needs, ...fixes.next, ...fixes.waiting];
  assert.ok(!everything.some((r) => r.title === 'Bot fixes its own' && r.fixYours), 'the bot\'s change is the bot\'s to fix');
  assert.ok(!fixes.waiting.some((r) => r.title === 'Frost alerts'), 'not Waiting under "Checks failing"');
  const fixLists = await aiWork.pageLists(pool, { user: { id: ada.id }, deps: { bot } });
  assert.match(fixLists.needsYou.find((r) => r.title === 'Frost alerts').says, /waits for their fix/,
    'Homeroom bot\'s answer says the same');

  // All items' Yours filter (5 Nov 2026): the same threads, on one project,
  // as the board names its cards. Hers (asked for), one she claimed, one she
  // only wrote in, a decision she voted on; never one she muted, nor
  // another project's.
  const yours = await aiWork.yoursOn(pool, { user: { id: ada.id }, appId: app.id });
  for (const n of [1, 2, 10, 50]) assert.ok(yours.requests.includes(n), `#${n} is hers`);
  assert.ok(!yours.requests.includes(11), 'not the one she muted');
  assert.ok(yours.requests.includes(4), 'a thread she voted in counts too');
  assert.ok(yours.decisions.includes(votedOn.id), 'a decision she voted on');
  assert.ok(yours.sessions.length > 0, 'the changes in her threads, by id');
  const elsewhere = await aiWork.yoursOn(pool, { user: { id: ada.id }, appId: hidden.id });
  assert.deepEqual(elsewhere.requests, [1], 'one project at a time');

  // #6421: a merged thread is one row, named by its change while one lives
  // there, and says how many requests it holds.
  const held = await request(app, 60, ada, 'Watering times');
  await request(app, 61, ada, 'Water at dawn');
  await pool.query('UPDATE requests SET thread_id = $1 WHERE app_id = $2 AND number = 61', [held.thread_id, app.id]);
  const gathered = await one(
    `INSERT INTO chat_sessions (app_id, user_id, pr_number, linked_issues, status, shared_at, promoted_at, check_state, pr_title)
     VALUES ($1, $2, 62, '{60,61}', 'promoted', NOW(), NOW(), 'passing', 'Water at dawn') RETURNING id`,
    [app.id, bob.id]);
  await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [gathered.id, ada.id]);
  const withGathered = await aiWork.workFor(pool, { user: { id: ada.id }, deps: { bot } });
  const mergedRow = [...withGathered.next, ...withGathered.waiting].find((r) => r.threadId === Number(held.thread_id));
  assert.equal(mergedRow.requests, 2, 'one row for the thread, with its count');
  assert.equal(mergedRow.title, 'Water at dawn', 'called by its change');
  // #6594: its yes is the one it needs, so it is going live (in progress)
  // rather than waiting; either way it is one row for the thread.
  assert.equal([...withGathered.next, ...withGathered.waiting].filter((r) => Number(r.threadId) === Number(held.thread_id)).length, 1, 'not one row per request');

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
  assert.equal((await fetch(`${base}/api/apps/aw-seeds/threads/yours`)).status, 401);
});

test('#6246: a waiting plan stays in Needs you past the 25-request window and a reply', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `ai_plan_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  const aiWork = require('../src/services/ai-work');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username, synthetic = false) => one(
    `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id, username`,
    [username, synthetic]);
  const ada = await user('ap_ada');
  const bot = await user('homeroom_bot', true);
  const app = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Previews', 'ap-previews', 'running', $1, 'public', 'public') RETURNING id, slug`, [ada.id]);
  await one(
    `INSERT INTO requests (app_id, number, title, created_by)
     VALUES ($1, 1, 'Previews: a schema change rolling out', $2) RETURNING id`, [app.id, ada.id]);
  await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, 1, $2)', [app.id, ada.id]);
  await one(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, awaiting_go_at, created_at)
     VALUES ($1, 1, 'live', 'ready', NOW() - INTERVAL '50 minutes', NOW() - INTERVAL '1 hour') RETURNING id`, [app.id]);

  const deps = { bot, liveSvc: { isStaging: () => false }, settings: { mode: 'live' } };
  // The writes below go straight to the bot's tables; on the platform the
  // machine or route that makes them refreshes the stored work state, as this does.
  const workState = require('../src/services/work-state');
  const needs = async () => {
    await workState.refresh(pool, [{ appId: app.id, issueNumber: 1 }]);
    return (await aiWork.workFor(pool, { user: { id: ada.id }, deps })).needs.filter((r) => r.number === 1).map((r) => r.work.why);
  };
  assert.deepEqual(await needs(), ['plan'], 'the plan waits for her Build it');
  // A person's reply newer than the plan does not hide it.
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, created_at)
     VALUES ($1, $2, 'looks good', 'issue', 1, NOW() - INTERVAL '5 minutes')`, [app.id, ada.id]);
  assert.deepEqual(await needs(), ['plan'], 'a reply does not hide the plan');
  // 26 newer requests with runs push #1 out of the bot's 25-row window. The
  // facts path must still list it (the bug #6246 fixes).
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id)
     SELECT $1, n, $2 FROM generate_series(2, 27) n`, [app.id, ada.id]);
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, created_at)
     SELECT $1, n, 'live', 'empty', NOW() - make_interval(mins => n) FROM generate_series(2, 27) n`, [app.id]);
  assert.deepEqual(await needs(), ['plan'], 'past the 25-request window');
  // Build it tapped: the build waits its turn, not a plan.
  await pool.query('UPDATE homeroom_bot_runs SET live_build_waiting_at = NOW() WHERE app_id = $1 AND issue_number = 1', [app.id]);
  assert.deepEqual(await needs(), [], 'a queued build is not a waiting plan');
});

test('the demo rows are obviously fake, and staging-only', () => {
  const src = fs.readFileSync(require.resolve('../src/routes/ai-work.js'), 'utf8');
  assert.match(src, /if \(IS_STAGING && req\.query\.demo === '1'\) return res\.json\(demoWork\(\)\);/);
  const { demoWork } = require('../src/routes/ai-work');
  const demo = demoWork();
  for (const row of [...demo.private, ...demo.needs, ...demo.next, ...demo.waiting, ...demo.live]) {
    assert.match(row.title, /^Staging demo/, row.title);
  }
  // One story with the Needs you feed's demo cards: their projects, so the
  // page groups the two, and every kind of row. Four more projects only wait
  // or went live, so the filter has more projects than its three chips and
  // shows its More.
  const { DEMO_NEEDS_FEED } = require('../src/routes/workshop-overview');
  const feedSlugs = new Set(DEMO_NEEDS_FEED.map((it) => it.app.slug));
  const rows = [...demo.needs, ...demo.next, ...demo.waiting, ...demo.live];
  assert.ok([...demo.needs, ...demo.next].every((r) => feedSlugs.has(r.app.slug)), 'what needs you and what is under way is on the feed\'s demo projects');
  assert.equal(new Set(rows.filter((r) => feedSlugs.has(r.app.slug)).map((r) => r.app.slug)).size, 2);
  assert.equal(new Set(rows.map((r) => r.app.slug)).size, 6, 'three chips and "3 more"');
  assert.ok(rows.every((r) => /^staging-demo-/.test(r.app.slug)), 'on demo projects only');
  // #6284: the bot stopped at its own limit on a change's checks; and a
  // change of the person's own whose checks failed, which waits on their fix.
  assert.deepEqual(demo.needs.map((r) => (r.fixYours ? 'fix_yours' : r.work.why || r.work.reason)),
    ['plan', 'decide', 'build_failed', 'fix_stopped', 'fix_yours']);
  assert.ok(demo.next.some((r) => r.work.line?.by === 'staging-demo-partner'), 'a claim');
  const { STAGES } = require('../src/services/work-state');
  assert.ok(rows.every((r) => STAGES.includes(r.work.stage)), 'every demo row says a stage the screens know');
  // #6515: the busy card splits each project's rows by the reader's day
  // (#6401), and the declared check reads this project's first three as
  // siblings (#6160). Its five moving rows share one day and keep their
  // order, whatever the hour the page loads at.
  const sameDay = (list) => {
    assert.equal(new Set(list.map((r) => new Date(r.at).toISOString().slice(0, 10))).size, 1, 'one UTC day');
    for (const shift of [-11, 11]) {
      const days = new Set(list.map((r) => new Date(Date.parse(r.at) + shift * 3600000).toISOString().slice(0, 10)));
      assert.equal(days.size, 1, `one day read at UTC${shift > 0 ? '+' : ''}${shift}`);
    }
  };
  const busyOf = (demo) => {
    const busy = [...demo.next, ...demo.waiting].filter((r) => r.app.slug === 'staging-demo-your-app' && r.work.line?.code !== 'waiting');
    assert.deepEqual(busy.map((r) => r.work.stage),
      ['going_live', 'building', 'up_for_vote', 'up_for_vote', 'building'], 'under way, then what waits');
    assert.equal(busy[busy.length - 1].work.line.code, 'held_waiting', 'a held build comes last');
    assert.ok(busy.every((r) => Date.parse(r.at) < Date.now()), 'no row from the future');
    sameDay(busy);
  };
  busyOf(demo);
  // The hours that used to split the rows: the anchor moves, the day does not.
  const realNow = Date.now;
  try {
    const today = new Date();
    for (const [h, m] of [[0, 30], [7, 30], [11, 59], [12, 30], [23, 30]]) {
      Date.now = () => Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), h, m);
      busyOf(demoWork());
    }
  } finally {
    Date.now = realNow;
  }
});

test('#6282: a change with an update on its way is Updating, then Update queued', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const crypto = require('node:crypto');
  const name = `ai_work_update_${crypto.randomBytes(6).toString('hex')}`;
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
  const aiWork = require('../src/services/ai-work');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username, synthetic = false) => one(
    `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id, username`, [username, synthetic]);
  const ada = await user('uw_ada');
  const bob = await user('uw_bob');
  const bot = await user('homeroom-bot-uw', true);
  const app = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Updates', 'uw-updates', 'running', $1, 'public', 'public') RETURNING id, slug`, [bob.id]);
  for (const u of [ada, bob]) {
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [app.id, u.id]);
  }
  await pool.query(`INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 1, 'Bigger buttons', $2)`, [app.id, ada.id]);
  const change = await one(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number, pr_title, check_state, promoted_at, last_activity_at)
     VALUES ($1, $2, 'promoted', ARRAY[1]::int[], 12, 'Bigger buttons', 'passing', NOW(), NOW() - INTERVAL '10 minutes')
     RETURNING id`, [app.id, bob.id]);

  const deps = { bot, liveSvc: { isStaging: () => false }, settings: { mode: 'live' } };
  // The asks below are written straight to their table; on the platform the
  // machine that takes them refreshes the stored work state, as this does.
  const workState = require('../src/services/work-state');
  const all = async (viewer) => {
    await workState.refresh(pool, [{ sessionId: change.id }]);
    const work = await aiWork.workFor(pool, { user: { id: viewer.id }, deps });
    return [...work.needs, ...work.next, ...work.waiting].filter((r) => Number(r.number) === 1);
  };
  const what = async (viewer) => (await all(viewer)).map((r) => (r.work.line ? `${r.work.stage}:${r.work.line.code}` : r.work.stage));
  const ask = async (status) => one(
    `INSERT INTO homeroom_bot_change_asks (app_id, session_id, issue_number, instruction, status, taken_at)
     VALUES ($1, $2, 1, 'drop the second credit line', $3, CASE WHEN $3 = 'taken' THEN NOW() ELSE NULL END)
     RETURNING id`, [app.id, change.id, status]);

  // ada still owes the vote: none of these lists is where it stands (the
  // Needs you feed asks for it).
  assert.deepEqual(await what(ada), []);
  // An ask waits its turn: Waiting, Update queued, with what was asked
  // (11 Nov 2026: the bot's, waiting its turn; not open for votes).
  const queued = await ask('queued');
  assert.deepEqual(await what(ada), ['building:update_queued']);
  const [queuedRow] = await all(ada);
  assert.equal(queuedRow.group, 'waiting');
  assert.equal(queuedRow.ask, 'drop the second credit line');
  // Taken: In progress, Updating, the same words.
  await pool.query(`UPDATE homeroom_bot_change_asks SET status = 'taken', taken_at = NOW() WHERE id = $1`, [queued.id]);
  assert.deepEqual(await what(ada), ['building:revising']);
  assert.equal((await all(ada))[0].group, 'next');
  // Done: the update landed, and the change is the feed's to ask about.
  await pool.query(`UPDATE homeroom_bot_change_asks SET status = 'done', done_at = NOW() WHERE id = $1`, [queued.id]);
  assert.deepEqual(await what(ada), []);
  // A turn in flight without an ask: Updating the change, with no ask.
  await pool.query(`UPDATE chat_sessions SET active_turn = '{}'::jsonb WHERE id = $1`, [change.id]);
  const [running] = await all(ada);
  assert.deepEqual([running.work.stage, running.work.line], ['building', { code: 'revising' }]);
  assert.equal(running.ask, undefined);
  await pool.query(`UPDATE chat_sessions SET active_turn = NULL WHERE id = $1`, [change.id]);
  // Its author sees the update instead of waiting on the vote.
  assert.deepEqual(await what(bob), ['up_for_vote']);
  const second = await ask('queued');
  assert.deepEqual(await what(bob), ['building:update_queued']);
  await pool.query(`UPDATE homeroom_bot_change_asks SET status = 'done', done_at = NOW() WHERE id = $1`, [second.id]);
  assert.deepEqual(await what(bob), ['up_for_vote']);
});
