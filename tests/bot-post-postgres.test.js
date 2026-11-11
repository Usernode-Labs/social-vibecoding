'use strict';

// Homeroom bot, one model, step 4 (11 Nov 2026): the posting function
// (src/services/bot-post.js) against the full schema. A post is claimed by
// its key before anything is sent and said once; the place's rules refuse
// what is not said there (recorded); a person's chat with the bot records
// its messages through its transport (homeroom-bot-dm.js sendDm); and the
// migration gives the posts said before keys of their own, so a durable
// build sent back across the release says nothing twice.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/bot-post-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the posting function against the full schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`PostgreSQL unavailable: ${err.message}`);
    return;
  }
  const name = `bot_post_${crypto.randomBytes(6).toString('hex')}`;
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

  const botPost = require('../src/services/bot-post');
  const ws = require('../src/services/ws');
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const owner = await one(`INSERT INTO users (username, password) VALUES ('bp_owner', 'x') RETURNING id, username`);
  const bot = await one(`INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`);
  const app = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Posts', 'bp-posts', 'running', $1, 'public', 'public') RETURNING id, slug, name`, [owner.id]);
  const row = (key) => one('SELECT * FROM bot_posts WHERE said_key = $1', [key]);

  await t.test('a post is claimed, said with its record in the message\'s transaction, and said once', async () => {
    const spec = {
      place: { type: 'issue', ref: 9 }, appId: app.id, kind: 'question', words: 'Which colour?', author: bot,
      issueNumber: 9, version: 'run-1',
    };
    const out = await botPost.post(pool, spec, { ws });
    assert.equal(out.outcome, 'said');
    const key = `question:request:${app.id}-9:run-1`;
    const said = await row(key);
    assert.equal(said.outcome, 'said');
    assert.equal(said.chat_message_id, out.messageId, 'its record names its message');
    assert.ok(said.said_at);
    assert.ok(said.words_digest);
    const projected = await one('SELECT kind, thread_message_id FROM homeroom_bot_posts WHERE id = $1', [said.request_post_id]);
    assert.deepEqual(projected, { kind: 'question', thread_message_id: out.messageId }, 'on the request\'s record once said');
    const again = await botPost.post(pool, spec, { ws });
    assert.deepEqual([again.outcome, again.messageId], ['again', out.messageId]);
    assert.equal((await row(key)).asked, 2, 'asked twice, said once');
    const n = await one(`SELECT COUNT(*)::int AS n FROM chat_messages WHERE thread_type = 'issue' AND thread_ref = 9`);
    assert.equal(n.n, 1);
  });

  await t.test('what a request\'s thread does not hear is recorded as refused, and never a message', async () => {
    const out = await botPost.post(pool, {
      place: { type: 'issue', ref: 10 }, appId: app.id, kind: 'looking', words: 'Looking at this now.', author: bot,
      issueNumber: 10, version: 'once',
    }, { ws });
    assert.equal(out.outcome, 'refused');
    const refused = await row(`looking:request:${app.id}-10:once`);
    assert.deepEqual([refused.outcome, refused.why, refused.chat_message_id], ['refused', 'not_in_place', null]);
    const n = await one(`SELECT COUNT(*)::int AS n FROM chat_messages WHERE thread_type = 'issue' AND thread_ref = 10`);
    assert.equal(n.n, 0);
  });

  await t.test('Homeroom\'s own line about what a person did is said once, with no author', async () => {
    const spec = {
      place: { type: 'issue', ref: 11 }, appId: app.id, kind: 'moved', words: 'bp_owner moved this request to Homeroom as #4 and closed it here',
      issueNumber: 11, version: 'to-4', record: false,
    };
    const out = await botPost.post(pool, spec, { ws });
    assert.equal(out.outcome, 'said');
    const msg = await one('SELECT user_id, msg_type FROM chat_messages WHERE id = $1', [out.messageId]);
    assert.deepEqual(msg, { user_id: null, msg_type: 'system' });
    assert.equal((await row(`moved:request:${app.id}-11:to-4`)).chat_message_id, out.messageId, 'named in the line\'s transaction');
    assert.equal((await botPost.post(pool, spec, { ws })).outcome, 'again');
  });

  await t.test('a newer failure note\'s card supersedes the older card of its kind; a question beside another does not', async () => {
    const tryAgain = () => ({ kind: 'try_again', forUserId: owner.id, args: { issueNumber: 12, sessionId: 5 } });
    const first = await botPost.post(pool, {
      place: { type: 'issue', ref: 12 }, appId: app.id, kind: 'followup_person', words: 'Its checks still fail.', author: bot,
      issueNumber: 12, card: tryAgain(),
    }, { ws });
    const second = await botPost.post(pool, {
      place: { type: 'issue', ref: 12 }, appId: app.id, kind: 'followup_person', words: 'Its checks fail in a new way.', author: bot,
      issueNumber: 12, card: tryAgain(),
    }, { ws });
    const status = async (id) => (await one('SELECT status, retired_reason FROM bot_cards WHERE id = $1', [id]));
    assert.deepEqual(await status(first.cardId), { status: 'retired', retired_reason: 'superseded' });
    assert.deepEqual(await status(second.cardId), { status: 'open', retired_reason: null });
    // Two overlaps on one request, each about another request: both stay.
    const overlap = (other) => botPost.post(pool, {
      place: { type: 'issue', ref: 13 }, appId: app.id, kind: 'overlap', words: `This overlaps with #${other}.`, author: bot,
      issueNumber: 13, card: { kind: 'overlap', forUserId: owner.id, args: { issueNumber: 13, other } },
    }, { ws });
    const a = await overlap(30);
    const b = await overlap(31);
    assert.equal((await status(a.cardId)).status, 'open');
    assert.equal((await status(b.cardId)).status, 'open');
  });

  await t.test('a person\'s chat with the bot records its messages through its transport, and refuses request news', async () => {
    await botPost.recordDm(pool, { userId: owner.id, kind: 'reply', key: 'answer-1', messageId: 77, words: 'Hi.' });
    await botPost.recordDm(pool, { userId: owner.id, kind: 'reply', key: 'answer-1', messageId: 77, words: 'Hi.' });
    const dmRow = await row(`reply:dm:${owner.id}:key-answer-1`);
    assert.deepEqual([dmRow.outcome, dmRow.place_type, dmRow.conversation_message_id, dmRow.asked], ['said', 'dm', 77, 2]);
    // Request news is not a message in their chat: sendDm refuses it, recorded.
    const dm = require('../src/services/homeroom-bot-dm');
    const sent = await dm.sendDm(pool, {
      bot, userId: owner.id, content: 'Your request is built.', idempotencyKey: 'request-news-1',
      metadata: { kind: 'proposal', appSlug: app.slug, issueNumber: 9 },
    });
    assert.equal(sent, null);
    const news = await row(`proposal:dm:${owner.id}:key-request-news-1`);
    assert.equal(news.outcome, 'refused');
  });

  await t.test('the migration keys the posts said before, so a run sent back across the release says nothing twice', async () => {
    const run = await one(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, verdict, mode) VALUES ($1, 20, 'ready', 'live') RETURNING id`, [app.id]);
    const msg = await one(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref) VALUES ($1, $2, 'Built it.', 'message', 'issue', 20) RETURNING id`,
      [app.id, bot.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind, thread_message_id) VALUES ($1, 20, $2, 'proposal', $3)`,
      [app.id, run.id, msg.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind, pending) VALUES ($1, 20, $2, 'spec', TRUE)`,
      [app.id, run.id]);
    await pool.query(`INSERT INTO homeroom_bot_posts (app_id, issue_number, kind) VALUES ($1, 21, 'looking')`, [app.id]);
    // Its statements are idempotent: run again over rows from before.
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src/db/migrations/bot-posts.sql'), 'utf8'));
    const said = await row(`proposal:request:${app.id}-20:run-${run.id}`);
    assert.deepEqual([said.outcome, said.chat_message_id], ['said', msg.id]);
    assert.equal((await row(`spec:request:${app.id}-20:run-${run.id}`)).outcome, 'pending', 'one going out is taken up');
    assert.equal((await row(`looking:request:${app.id}-21:once`)).outcome, 'refused', '"looking" was said once per request, ever');
    const live = require('../src/services/homeroom-bot-live');
    const again = await live.post({
      pool, github: { async createIssueComment() { throw new Error('not again'); } }, ws, app,
      repo: { owner: 'a', repo: 'b' }, issueNumber: 20, kind: 'proposal', runId: run.id, text: 'Built it.', sender: bot,
    });
    assert.equal(again.again, true, 'said before the release: not said again');
  });

  // ── Step 4's review (11 Nov 2026) ─────────────────────────────────────

  await t.test('two asks at once say a post once: the second finds its claim held; a lapsed claim is taken over', async () => {
    const spec = {
      place: { type: 'issue', ref: 30 }, appId: app.id, kind: 'question', words: 'Which size?', author: bot,
      issueNumber: 30, version: 'run-2',
    };
    const key = `question:request:${app.id}-30:run-2`;
    // The first ask holds the claim while its message is being written.
    let entered;
    const sending = new Promise((resolve) => { entered = resolve; });
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const slow = { ...ws, async sendBotMessage(db, appId, msg) { entered(); await gate; return ws.sendBotMessage(db, appId, msg); } };
    const first = botPost.post(pool, spec, { ws: slow });
    await sending;
    const held = await row(key);
    assert.equal(held.outcome, 'pending');
    assert.ok(held.claimed_at && held.claimed_by, 'held while it is said');
    await assert.rejects(botPost.post(pool, spec, { ws }), (err) => err.code === 'post_busy', 'a durable caller is told, and retries');
    const soft = await botPost.post(pool, { ...spec, soft: true }, { ws });
    assert.equal(soft.outcome, 'busy');
    open();
    const said = await first;
    assert.equal(said.outcome, 'said');
    const n = await one(`SELECT COUNT(*)::int AS n FROM chat_messages WHERE thread_type = 'issue' AND thread_ref = 30`);
    assert.equal(n.n, 1, 'said once');
    assert.equal((await botPost.post(pool, spec, { ws })).outcome, 'again', 'and the retry finds it said');

    // A pending post a crash left: once its claim has lapsed, the next ask
    // takes it over (one conditional UPDATE) and says it; before, it waits.
    const crashed = { ...spec, place: { type: 'issue', ref: 33 }, issueNumber: 33, version: 'run-3' };
    const crashedKey = `question:request:${app.id}-33:run-3`;
    const left = await botPost.claim(pool, {
      key: crashedKey, kind: 'question', subject: `request:${app.id}-33`, version: 'run-3',
      place: { type: 'issue', ref: 33 }, appId: app.id, issueNumber: 33,
    });
    assert.equal(left.held, true);
    await assert.rejects(botPost.post(pool, crashed, { ws }), (err) => err.code === 'post_busy');
    await pool.query(`UPDATE bot_posts SET claimed_at = NOW() - INTERVAL '10 minutes' WHERE said_key = $1`, [crashedKey]);
    const taken = await botPost.post(pool, crashed, { ws });
    assert.equal(taken.outcome, 'said');
    assert.notEqual((await row(crashedKey)).claimed_by, left.token, 'under the new ask\'s claim');
    // Two asks taking one lapsed claim over: exactly one gets it.
    await pool.query(`UPDATE bot_posts SET outcome = 'pending', claimed_at = NOW() - INTERVAL '10 minutes' WHERE said_key = $1`, [crashedKey]);
    const claimSpec = {
      key: crashedKey, kind: 'question', subject: `request:${app.id}-33`, version: 'run-3',
      place: { type: 'issue', ref: 33 }, appId: app.id, issueNumber: 33,
    };
    const both = await Promise.all([botPost.claim(pool, claimSpec), botPost.claim(pool, claimSpec)]);
    assert.deepEqual(both.map((c) => c.held).sort(), [false, true]);

    // A durable work's own post (keyed by its run): its next attempt after
    // a crash takes the claim its last one left at once, as before claims
    // (its runtime runs one attempt at a time); anybody else waits.
    const runSpec = { ...spec, place: { type: 'issue', ref: 43 }, issueNumber: 43, version: 'run-4', durable: true };
    const runKey = `question:request:${app.id}-43:run-4`;
    await botPost.claim(pool, {
      key: runKey, kind: 'question', subject: `request:${app.id}-43`, version: 'run-4',
      place: { type: 'issue', ref: 43 }, appId: app.id, issueNumber: 43,
    }, { durable: true });
    assert.equal((await row(runKey)).claim_durable, true);
    await assert.rejects(botPost.post(pool, { ...runSpec, durable: false }, { ws }), (err) => err.code === 'post_busy');
    assert.equal((await botPost.post(pool, runSpec, { ws })).outcome, 'said', 'its own work, asked again, says it');
  });

  await t.test('a send that fails leaves its post pending, its claim let go: the retry says it, once', async () => {
    const spec = {
      place: { type: 'issue', ref: 31 }, appId: app.id, kind: 'reply', words: 'Here it is.', author: bot,
      issueNumber: 31, version: 'turn-b', record: false,
    };
    const key = `reply:request:${app.id}-31:turn-b`;
    const down = { ...ws, async sendBotMessage() { throw new Error('room down'); } };
    await assert.rejects(botPost.post(pool, spec, { ws: down }), /room down/);
    const left = await row(key);
    assert.deepEqual([left.outcome, left.chat_message_id, left.claimed_at], ['pending', null, null]);
    const out = await botPost.post(pool, spec, { ws });
    assert.equal(out.outcome, 'said');
    const n = await one(`SELECT COUNT(*)::int AS n FROM chat_messages WHERE thread_type = 'issue' AND thread_ref = 31`);
    assert.equal(n.n, 1);

    // The voice's say keeps its work's retry: a failed send throws, and the
    // retried turn says it once, found by its key after.
    const voice = require('../src/services/homeroom-bot-voice');
    const place = { type: 'issue', ref: 32 };
    await assert.rejects(voice.say(pool, {
      app, place, bot, text: 'Yes, it does.', answer: [], mark: { key: 'turn-32' }, suggest: false, deps: { ws: down },
    }), /room down/);
    assert.equal(await voice.replyOf(pool, { app, place, bot, turnKey: 'turn-32' }), null, 'nothing said yet');
    const sent = await voice.say(pool, {
      app, place, bot, text: 'Yes, it does.', answer: [], mark: { key: 'turn-32' }, suggest: false, deps: { ws },
    });
    assert.ok(sent?.id);
    assert.equal((await voice.replyOf(pool, { app, place, bot, turnKey: 'turn-32' })).id, sent.id);
    // A turn retried across the release posted its reply before keys: its
    // mark is read when the key names none (for one release).
    const before = await one(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
       VALUES ($1, $2, 'Said before keys.', 'message', $3, 'issue', 34) RETURNING id`,
      [app.id, bot.id, JSON.stringify({ homeroomBot: { kind: 'voice', turn: { key: 'turn-old', through: 7 } } })]);
    assert.deepEqual(await voice.replyOf(pool, { app, place: { type: 'issue', ref: 34 }, bot, turnKey: 'turn-old' }),
      { id: before.id, through: 7 });
  });

  await t.test('"looking" is said at most once, ever: a second ask never takes its row up', async () => {
    const live = require('../src/services/homeroom-bot-live');
    let comments = 0;
    const github = { async createIssueComment() { comments += 1; return { id: 7000 + comments }; } };
    // A pass began it and is gone (or is still saying it).
    await botPost.claim(pool, {
      key: `looking:request:${app.id}-35:once`, kind: 'looking', subject: `request:${app.id}-35`, version: 'once',
      place: { type: 'issue', ref: 35 }, appId: app.id, issueNumber: 35,
    });
    await pool.query(`UPDATE bot_posts SET claimed_at = NOW() - INTERVAL '1 day' WHERE said_key = $1`, [`looking:request:${app.id}-35:once`]);
    const out = await live.post({
      pool, github, ws, app, repo: { owner: 'a', repo: 'b' }, issueNumber: 35, kind: 'looking', text: live.lookingText(), sender: bot,
    });
    assert.equal(out.again, true);
    assert.equal(comments, 0, 'no second comment');
  });

  await t.test('a post from before the release keeps its DM relay\'s key, and its copy on a change is said once', async () => {
    const live = require('../src/services/homeroom-bot-live');
    const dm = require('../src/services/homeroom-bot-dm');
    const relayed = [];
    const relay = dm.relayIssuePost;
    dm.relayIssuePost = async (args) => { relayed.push(args.postKey); return null; };
    t.after(() => { dm.relayIssuePost = relay; });
    const run = await one(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, verdict, mode) VALUES ($1, 36, 'ready', 'live') RETURNING id`, [app.id]);
    const before = await one(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind, pending) VALUES ($1, 36, $2, 'question', TRUE) RETURNING id`,
      [app.id, run.id]);
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src/db/migrations/bot-posts.sql'), 'utf8'));
    const github = { async createIssueComment() { return { id: 7100 }; } };
    const out = await live.post({
      pool, github, ws, app, repo: { owner: 'a', repo: 'b' }, issueNumber: 36, kind: 'question', runId: run.id,
      text: 'Which colour?', sender: bot, dm: { question: 'Which colour?' },
    });
    assert.equal(out.thread, true);
    assert.deepEqual(relayed, [`hrbot-post-${before.id}`], 'the key its relay was sent by before the release');
    const projected = await one('SELECT pending FROM homeroom_bot_posts WHERE id = $1', [before.id]);
    assert.equal(projected.pending, null, 'the row from before, finished');
    relayed.length = 0;
    await live.post({
      pool, github, ws, app, repo: { owner: 'a', repo: 'b' }, issueNumber: 37, kind: 'question', runId: run.id,
      text: 'Which size?', sender: bot, dm: { question: 'Which size?' },
    });
    assert.match(relayed[0], /^bot-post-\d+$/, 'a post of this release relays by its own');

    // A copy on a change (no request page of its own) is its own post: a
    // strict retry, after a GitHub comment failed, never says it twice.
    let down = true;
    const flaky = {
      async createIssueComment() { if (down) throw Object.assign(new Error('GitHub is down'), { status: 502 }); return { id: 7200 }; },
      async listIssueComments() { return []; },
    };
    const announce = () => live.post({
      pool, github: flaky, ws, app, repo: { owner: 'a', repo: 'b' }, issueNumber: 38, kind: 'live', runId: run.id,
      text: 'It\'s live.', sender: bot, proposalSessionId: 601, skipIssueThread: true, strict: true,
    });
    await assert.rejects(announce(), /GitHub is down/);
    down = false;
    const done = await announce();
    assert.equal(done.github, true);
    const copies = await one(`SELECT COUNT(*)::int AS n FROM chat_messages WHERE thread_type = 'session' AND thread_ref = 601`);
    assert.equal(copies.n, 1, 'the copy on the change, once');

    // Said on the change alone: its place is the change's thread.
    const only = await live.post({
      pool, github, ws, app, repo: { owner: 'a', repo: 'b' }, issueNumber: 39, kind: 'followup_failed', runId: run.id,
      text: 'Homeroom bot couldn\'t do it.', sender: bot, proposalSessionId: 602, onlyProposal: true,
    });
    assert.ok(only.messageId);
    const placed = await row(`followup_failed:request:${app.id}-39:run-${run.id}`);
    assert.deepEqual([placed.place_type, Number(placed.place_ref), placed.chat_message_id], ['session', 602, only.messageId]);
  });

  await t.test('the last failure note is the newest message; the review\'s migration places and digests the posts from before', async () => {
    const live = require('../src/services/homeroom-bot-live');
    const words = 'I couldn\'t finish building this.';
    const note = async (content) => one(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref) VALUES ($1, $2, $3, 'message', 'issue', 41) RETURNING id`,
      [app.id, bot.id, content]);
    // Copied from before in no particular order: the newer message has the
    // older row.
    const older = await note('I couldn\'t finish writing the plan.');
    const newer = await note(words);
    const insert = (key, messageId, digest) => pool.query(
      `INSERT INTO bot_posts (said_key, kind, subject, version, place_type, app_id, place_ref, issue_number, chat_message_id,
                              words_digest, outcome)
       VALUES ($1, 'build_failed', $2, $1, 'issue', $3, 41, 41, $4, $5, 'said')`,
      [key, `request:${app.id}-41`, app.id, messageId, digest]);
    await insert('old-a', newer.id, null);
    await insert('old-b', older.id, botPost.digestOf('I couldn\'t finish writing the plan.'));
    // A note said on a change, copied as the request's.
    const onChange = await one(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref) VALUES ($1, $2, 'On the change.', 'message', 'session', 603) RETURNING id`,
      [app.id, bot.id]);
    await pool.query(
      `INSERT INTO bot_posts (said_key, kind, subject, version, place_type, app_id, place_ref, issue_number, chat_message_id, outcome)
       VALUES ('old-c', 'followup_failed', $1, 'old-c', 'issue', $2, 41, 41, $3, 'said')`,
      [`request:${app.id}-41`, app.id, onChange.id]);
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src/db/migrations/bot-posts-claims.sql'), 'utf8'));
    assert.equal((await row('old-a')).words_digest, botPost.digestOf(words), 'digested as digestOf does');
    const moved = await row('old-c');
    assert.deepEqual([moved.place_type, Number(moved.place_ref)], ['session', 603], 'placed where its message is');
    // So the same failure after the release is a repeat of the newest note.
    const again = await live.post({
      pool, github: { async createIssueComment() { throw new Error('not said'); } }, ws, app, repo: { owner: 'a', repo: 'b' },
      issueNumber: 41, kind: 'build_failed', text: 'Homeroom bot couldn\'t finish building this.', sender: bot,
    });
    assert.equal(again.repeated, true);
    assert.equal(again.messageId, newer.id);
  });

  await t.test('a message in a person\'s chat with the bot is recorded in its own transaction', async () => {
    const dm = require('../src/services/homeroom-bot-dm');
    const ada = await one(`INSERT INTO users (username, password, has_platform_access) VALUES ('bp_ada', 'x', TRUE) RETURNING id`);
    const sent = await dm.sendDm(pool, { bot, userId: ada.id, content: 'Hello there.', idempotencyKey: 'hello-ada-1', postKind: 'reply' });
    assert.ok(sent?.messageId);
    const said = await row(`reply:dm:${ada.id}:key-hello-ada-1`);
    assert.deepEqual([said.outcome, Number(said.conversation_message_id), said.asked], ['said', Number(sent.messageId), 1]);
    const twice = await dm.sendDm(pool, { bot, userId: ada.id, content: 'Hello there.', idempotencyKey: 'hello-ada-1', postKind: 'reply' });
    assert.equal(twice.duplicate, true);
    assert.equal((await row(`reply:dm:${ada.id}:key-hello-ada-1`)).asked, 2, 'its duplicate asked again, after');
  });

  await t.test('a held answer decided before the release is keyed by its row, which it finishes: counted once', async () => {
    const holds = require('../src/services/homeroom-bot-holds');
    await pool.query(`UPDATE apps SET repo_url = 'https://github.com/a/b' WHERE id = $1`, [app.id]);
    const before = await one(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, kind, pending) VALUES ($1, 42, 'going_ahead', TRUE) RETURNING id`, [app.id]);
    let fail = true;
    const github = { async createIssueComment() { if (fail) throw Object.assign(new Error('GitHub is down'), { status: 502 }); return { id: 7300 }; }, async listIssueComments() { return []; } };
    const deps = { github, ws, botSvc: { parseRepo: () => ({ owner: 'a', repo: 'b' }) } };
    const input = { appId: app.id, issueNumber: 42, kind: 'going_ahead', text: 'Homeroom bot is taking this up now, as asked.' };
    await assert.rejects(holds.sayHeld(pool, { ...input, deps }), /GitHub is down/);
    fail = false;
    await holds.sayHeld(pool, { ...input, deps });
    const rows = (await pool.query(`SELECT id, pending FROM homeroom_bot_posts WHERE app_id = $1 AND issue_number = 42`, [app.id])).rows;
    assert.deepEqual(rows.map((r) => [r.id, r.pending]), [[before.id, null]], 'one row, finished');
    const said = await row(`going_ahead:request:${app.id}-42:post-${before.id}`);
    assert.deepEqual([said.outcome, said.request_post_id], ['said', before.id]);
    const n = await one(`SELECT COUNT(*)::int AS n FROM chat_messages WHERE thread_type = 'issue' AND thread_ref = 42`);
    assert.equal(n.n, 1, 'said once across the retry');
  });
});
