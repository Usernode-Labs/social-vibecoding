'use strict';

// #6313 (4 Nov 2026): "I couldn't finish building this: something went wrong
// during the build. Reply here and I'll try again." was posted five times in
// 28 minutes on #6306 and four times on #6225, each a new post that marked the
// request as having news and rang its requester again.
//
// Step 4 (11 Nov 2026, docs/plans/bot-one-model.md, decision 6 as Evan
// amended it): failure notes are never edited. A new failure is a new note,
// said only when its words differ from the last failure note in that place
// or somebody has replied since; a repeat says nothing at all (no post, no
// GitHub comment, no mention: the status card already shows it); and a newer
// note retires the older note's buttons. #6581: words already on screen
// never change, so "(Tried 3 times.)" is never written over a note.
//
// Against the full schema, through live.post and the change's notes
// (live.postOnProposal), both of which say through services/bot-post.js.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-failure-repeat-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const PLAN = 'Homeroom bot couldn\'t finish writing the plan for this. It is trying again.';
const TIME = 'Homeroom bot couldn\'t finish building this: the build took longer than it\'s allowed. '
  + 'Reply here (or on the GitHub issue) and it will try again.';

async function freshDatabase(t) {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`PostgreSQL unavailable: ${err.message}`);
    return null;
  }
  const name = `hrbot_repeat_${crypto.randomBytes(6).toString('hex')}`;
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
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  return pool;
}

test('a failure note is said once, a new one only when it says something new, and none is ever rewritten', { timeout: 120000 }, async (t) => {
  const pool = await freshDatabase(t);
  if (!pool) return;
  const live = require('../src/services/homeroom-bot-live');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const owner = await one(
    `INSERT INTO users (username, password) VALUES ('hr_owner', 'x') RETURNING id, username, is_synthetic`);
  const bot = await one(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`);
  const app = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Repeat', 'hr-repeat', 'running', $1, 'public', 'public') RETURNING id, slug, name`, [owner.id]);

  // The real ws send (its message written with its card and its record in
  // one transaction); the room's broadcasts land nowhere.
  const ws = require('../src/services/ws');
  let comments = 0;
  const github = {
    isEnabled: () => true,
    async createIssueComment() { comments += 1; return { id: 9000 + comments, created_at: new Date().toISOString() }; },
  };
  const say = (text, more = {}) => live.post({
    pool, github, ws, app, repo: { owner: 'acme', repo: 'repeat' }, issueNumber: 42,
    kind: 'build_failed', text, sender: bot, senderId: bot.id, ...more,
  });
  const sayKind = (kind, text, more = {}) => live.post({
    pool, github, ws, app, repo: { owner: 'acme', repo: 'repeat' }, issueNumber: 42,
    kind, text, sender: bot, senderId: bot.id, ...more,
  });
  const tryAgain = () => ({ kind: 'try_again', forUserId: owner.id, args: { issueNumber: 42, sessionId: 77 } });
  const posts = async () => (await pool.query(
    'SELECT id, kind, thread_message_id FROM homeroom_bot_posts ORDER BY id')).rows;
  const messages = async () => (await pool.query(
    `SELECT id, content, metadata, edited_at FROM chat_messages WHERE thread_type = 'issue' AND thread_ref = 42 ORDER BY id`)).rows;
  const cardOn = async (messageId) => one('SELECT id, status, retired_reason FROM bot_cards WHERE chat_message_id = $1', [messageId]);
  // Somebody answers in the thread: the words a reply was written against.
  const replyUnder = () => one(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref)
     VALUES ($1, $2, 'Has it finished?', 'message', 'issue', 42) RETURNING id`,
    [app.id, owner.id]);

  // The first failure says itself, once, with Let it try again under it.
  const first = await say(PLAN, { card: tryAgain() });
  assert.equal(first.thread, true);
  assert.ok(first.cardId, 'its card is written with it');
  assert.equal(comments, 1, 'the first failure is said once on GitHub');
  assert.equal((await posts()).length, 1);
  const saidOnce = await messages();
  assert.equal(saidOnce.length, 1);
  assert.equal(saidOnce[0].content, 'I couldn\'t finish writing the plan for this. I\'m trying again.');

  // The same failure again, nobody writing since: nothing anywhere.
  const second = await say(PLAN, { card: tryAgain() });
  assert.equal(second.repeated, true);
  assert.equal(second.threadMessageId, saidOnce[0].id, 'the note already shown says it');
  assert.equal(comments, 1, 'no second GitHub comment');
  assert.equal((await posts()).length, 1, 'no second post on the request');
  const afterTwo = await messages();
  assert.equal(afterTwo.length, 1, 'and no second message in the thread');
  assert.equal(afterTwo[0].content, saidOnce[0].content, 'its words are as they were shown');
  assert.equal(afterTwo[0].edited_at, null, 'never edited');
  assert.equal((await cardOn(saidOnce[0].id)).status, 'open', 'its buttons stay: nothing newer took its place');
  const repeat = await one(`SELECT outcome, why FROM bot_posts WHERE kind = 'build_failed' ORDER BY id DESC LIMIT 1`);
  assert.deepEqual(repeat, { outcome: 'repeat', why: 'same_words' }, 'recorded as a repeat');

  // A failure that says something different is a new note below the old one.
  // The old note's words stay; its buttons go, the line under them says why.
  const third = await say(TIME, { card: tryAgain() });
  assert.equal(third.thread, true);
  assert.equal(comments, 2, 'its own GitHub comment');
  const rows = await posts();
  assert.equal(rows.length, 2, 'recorded as its own post');
  const afterOther = await messages();
  assert.equal(afterOther.length, 2, 'a new note below, never a rewrite of the old words');
  assert.equal(Number(rows[1].thread_message_id), afterOther[1].id, 'the new post is a new message');
  assert.equal(afterOther[0].content, saidOnce[0].content, 'the earlier note is untouched');
  assert.match(afterOther[1].content, /^I couldn't finish building this: the build took longer than I'm allowed\./);
  assert.match(afterOther[1].metadata.hrbotPost, /^post-\d+$/, 'marked as its post');
  const older = await cardOn(afterOther[0].id);
  assert.deepEqual({ status: older.status, why: older.retired_reason }, { status: 'retired', why: 'superseded' },
    'the newer note retires the older one\'s buttons');
  const olderMeta = afterOther[0].metadata.homeroomBot;
  assert.equal(olderMeta.offer.status, 'retired');
  assert.deepEqual(olderMeta.actions, [], 'its buttons are gone from its message');
  assert.equal((await cardOn(afterOther[1].id)).status, 'open', 'the newer note\'s buttons are the ones up');

  // Once somebody has replied since, the same words are a new note below
  // the reply, and the one they answered is unchanged.
  await replyUnder();
  const again = await say(TIME);
  assert.equal(again.thread, true);
  const afterReply = await messages();
  assert.equal(afterReply.length, 4, 'a new note below the reply');
  assert.equal(afterReply[1].content, afterOther[1].content, 'the note they answered is unchanged');
  assert.match(afterReply[3].content, /^I couldn't finish building this: the build took longer than I'm allowed\./);
  assert.equal((await cardOn(afterReply[1].id)).status, 'retired', 'and its buttons gave way to the newer note');

  // The same rule for the other failure kinds: the same words, nobody
  // writing since, say nothing; after a reply, a new note.
  await sayKind('blocked', 'I can\'t build it as written.');
  const blockedMessage = (await messages()).at(-1);
  const blockedRepeat = await sayKind('blocked', 'I can\'t build it as written.');
  assert.equal(blockedRepeat.repeated, true);
  assert.equal((await messages()).at(-1).id, blockedMessage.id, 'the one note stays, as it was');
  await replyUnder();
  await sayKind('blocked', 'I can\'t build it as written.');
  const blockedNew = (await messages()).at(-1);
  assert.notEqual(blockedNew.id, blockedMessage.id, 'a reply since: the new words go below');
  assert.equal(blockedNew.content, 'I can\'t build it as written.');

  // A note the bot said in between (a proposal) is news after which the
  // same failure is said again: the last thing said there is not a failure.
  await sayKind('proposal', 'It is built and up for a vote.');
  const beforeSame = (await messages()).length;
  const afterProposal = await sayKind('blocked', 'I can\'t build it as written.');
  assert.equal(afterProposal.thread, true);
  assert.equal((await messages()).length, beforeSame + 1);

  // A reply UNDER the failure note (its reply thread, where people answer
  // it and the voice answers them) is a reply since, too: the same words
  // are then a new note. The bot's own answer there is nobody replying.
  const FIX = 'Homeroom bot couldn\'t fix the checks.';
  await sayKind('followup_failed', FIX);
  const fixNote = (await messages()).at(-1);
  const under = (userId, content) => pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref)
     VALUES ($1, $2, $3, 'message', 'message', $4)`, [app.id, userId, content, fixNote.id]);
  await under(bot.id, 'I\'m looking at it again.');
  assert.equal((await sayKind('followup_failed', FIX)).repeated, true, 'the bot\'s answer under it is not a reply');
  await under(owner.id, 'Try again please.');
  const afterUnder = await sayKind('followup_failed', FIX);
  assert.equal(afterUnder.thread, true, 'a person replied under the note: a new note');
  assert.notEqual((await messages()).at(-1).id, fixNote.id);
  assert.equal(afterUnder.messageId, (await messages()).at(-1).id);

  // Said once by its key: the same run asking again says nothing, and its
  // GitHub stamp comes back for the run to mark as seen.
  const run = await one(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, verdict, mode) VALUES ($1, 42, 'ready', 'live') RETURNING id`,
    [app.id]);
  const keyed = await say('Homeroom bot couldn\'t push it.', { runId: run.id });
  const twice = await say('Homeroom bot couldn\'t push it.', { runId: run.id });
  assert.equal(keyed.thread, true);
  assert.equal(twice.again, true, 'the same key: said once');
  assert.equal(twice.messageId, keyed.messageId);

  // Words on screen never change: no bot message was ever edited.
  const edited = await pool.query('SELECT id FROM chat_messages WHERE user_id = $1 AND edited_at IS NOT NULL', [bot.id]);
  assert.equal(edited.rows.length, 0, 'no bot message was edited');
});

test('a note on a change\'s checks is a failure note there: the same words again say nothing', { timeout: 120000 }, async (t) => {
  const pool = await freshDatabase(t);
  if (!pool) return;
  const live = require('../src/services/homeroom-bot-live');
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const owner = await one(`INSERT INTO users (username, password) VALUES ('hr_owner2', 'x') RETURNING id`);
  const bot = await one(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`);
  const app = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Checks', 'hr-checks', 'running', $1, 'public', 'public') RETURNING id, slug, name`, [owner.id]);
  const ws = require('../src/services/ws');
  const note = (text) => live.postOnProposal({ pool, ws, app, issueNumber: 7, kind: 'checks_retry', text, bot, sessionId: 501 });
  const inThread = async () => (await pool.query(
    `SELECT id, content FROM chat_messages WHERE thread_type = 'session' AND thread_ref = 501 ORDER BY id`)).rows;

  assert.equal((await note('Homeroom bot is running the checks again.')).outcome, 'said');
  assert.equal((await note('Homeroom bot is running the checks again.')).outcome, 'repeat');
  assert.equal((await inThread()).length, 1, 'one note');
  assert.equal((await note('Homeroom bot is running the checks again: two still fail.')).outcome, 'said', 'different words: a new note');
  assert.equal((await inThread()).length, 2);
  // A wait on the change is not a failure note: each is its own post.
  const wait = await live.postOnProposal({ pool, ws, app, issueNumber: 7, kind: 'followup_wait', text: 'It waits for its checks.', bot, sessionId: 501, version: 'after-1' });
  assert.equal(wait.outcome, 'said');
  const waitAgain = await live.postOnProposal({ pool, ws, app, issueNumber: 7, kind: 'followup_wait', text: 'It waits for its checks.', bot, sessionId: 501, version: 'after-1' });
  assert.equal(waitAgain.outcome, 'again', 'the same key (the same message waited on) is said once');
});
