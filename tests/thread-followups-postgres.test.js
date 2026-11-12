'use strict';

// #6264: a promise the bot made to tell somebody when a change is updated,
// checked, ready to vote, merged or live, against a real PostgreSQL schema.
// What it stores, that it is told once, that a second ask replaces the
// first, that a later moment answers an earlier one, and that a change
// closing first calls it off.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/thread-followups-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const followups = require('../src/services/thread-followups');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);

test('the bot\'s follow-ups against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'tf_followups_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  let nextMessage = 9000;
  const { rows: [bot] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`);
  const { rows: [evan] } = await pool.query(`INSERT INTO users (username, password) VALUES ('evan', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, repo_url, status)
     VALUES ('Clubs', 'clubs', $1, 'https://github.com/acme/clubs', 'running') RETURNING *`, [evan.id]);
  const { rows: [otherApp] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, repo_url, status)
     VALUES ('Chores', 'chores', $1, 'https://git.usernode.dev/acme/chores', 'running') RETURNING *`, [evan.id]);
  const { rows: [change] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, reviewed_head_sha, linked_issues, pr_title, pr_number, approval_epoch)
     VALUES ($1, $2, 'promoted', $3, $4, 'Sort chores', 4249, 1) RETURNING *`,
    [app.id, bot.id, SHA('a'), [++seq]]);
  const issueNumber = seq;

  // What the service calls: the room that writes the line, and the bell.
  const sent = [];
  const deps = {
    bot: { id: bot.id, username: 'homeroom_bot' },
    dm: {
      sendDm: async (_pool, opts) => { const id = ++nextMessage; sent.push({ place: 'dm', ...opts, id }); return { id }; },
    },
    ws: {
      sendBotMessage: async (_pool, appId, { content, thread }) => {
        const id = ++nextMessage;
        sent.push({ place: thread.type, ref: Number(thread.ref), appId: Number(appId), content, id });
        return { id };
      },
    },
    notifications: { createMentionNotifications: async () => [], hydrateAndPush: async () => {} },
  };
  const rows = async () => (await pool.query('SELECT * FROM homeroom_bot_followups ORDER BY id')).rows;
  const clear = async () => { await pool.query('DELETE FROM homeroom_bot_followups'); sent.length = 0; };
  const ask = (over = {}) => followups.register(pool, {
    user: evan, app, sessionId: change.id, event: 'vote',
    place: { type: 'issue', ref: issueNumber }, deps, ...over,
  });
  t.after(async () => { await pool.end().catch(() => {}); });

  await t.test('an ask is stored with its promise', async () => {
    await clear();
    const out = await ask();
    assert.equal(out.ok, true);
    assert.equal(out.promise, "I'll tell you here when it's ready to vote.");
    const [row] = await rows();
    assert.equal(row.user_id, evan.id);
    assert.equal(row.session_id, change.id);
    assert.equal(row.event, 'vote');
    assert.equal(row.place_type, 'issue');
    assert.equal(Number(row.place_ref), issueNumber);
    assert.equal(row.state, 'waiting');
  });

  await t.test('a second ask about the same change replaces the first', async () => {
    await clear();
    await ask();
    await ask({ event: 'merged' });
    const all = await rows();
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((r) => [r.event, r.state]), [['vote', 'replaced'], ['merged', 'waiting']]);
  });

  await t.test('it fires once, writes its message, and a second fire says nothing', async () => {
    await clear();
    await ask();
    const told = await followups.fire(pool, { sessionId: change.id, event: 'vote', deps });
    assert.equal(told, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /^@evan, PR 4249 is ready to vote on\.$/);
    const [row] = await rows();
    assert.equal(row.state, 'fired');
    assert.equal(Number(row.message_id), sent[0].id);
    const again = await followups.fire(pool, { sessionId: change.id, event: 'vote', deps });
    assert.equal(again, 0);
    assert.equal(sent.length, 1, 'nothing is said twice');
  });

  await t.test('an ask made on the request binds to its change and is told there', async () => {
    await clear();
    await followups.register(pool, {
      user: evan, app, issueNumber, event: 'vote', place: { type: 'issue', ref: issueNumber }, deps,
    });
    const told = await followups.fire(pool, { sessionId: change.id, event: 'vote', deps });
    assert.equal(told, 1);
    const [row] = await rows();
    assert.equal(row.session_id, change.id, 'the change is written on the row');
    assert.equal(sent[0].place, 'issue');
    assert.equal(sent[0].ref, issueNumber, 'and it is said in the request');
  });

  await t.test('a later moment answers everyone still waiting on an earlier one', async () => {
    await clear();
    await ask({ event: 'vote' });
    await followups.fire(pool, { sessionId: change.id, event: 'merged', deps });
    const [row] = await rows();
    assert.equal(row.state, 'fired');
    assert.match(sent[0].content, /PR 4249 was approved and merged/);
    assert.equal(sent.length, 1);
  });

  await t.test('an update asked for does not fire on the head it was asked on', async () => {
    await clear();
    await ask({ event: 'update', head: SHA('a') });
    assert.equal(await followups.fire(pool, { sessionId: change.id, event: 'update', head: SHA('a'), deps }), 0);
    assert.equal(await followups.fire(pool, { sessionId: change.id, event: 'update', head: SHA('b'), deps }), 1);
    assert.match(sent[0].content, /the update to PR 4249 is in/);
  });

  await t.test('a change that closes first calls the promise off, and nothing fires after', async () => {
    await clear();
    await ask();
    const told = await followups.cancel(pool, { sessionId: change.id, deps });
    assert.equal(told, 1);
    assert.match(sent[0].content, /PR 4249 was closed, so there's nothing more to tell you about it\./);
    const [row] = await rows();
    assert.equal(row.state, 'cancelled');
    assert.equal(await followups.fire(pool, { sessionId: change.id, event: 'vote', deps }), 0);
    assert.equal(sent.length, 1);
  });

  // Step 4's review (11 Nov 2026): the line is one post (bot-post.js), and
  // a send that fails throws, so the work that fired it is retried: never a
  // promise marked kept with nobody told.
  await t.test('a line that could not be sent throws, and the retry tells it once', async () => {
    await clear();
    await ask();
    const send = deps.ws.sendBotMessage;
    deps.ws.sendBotMessage = async () => { throw new Error('room down'); };
    await assert.rejects(followups.fire(pool, { sessionId: change.id, event: 'vote', deps }), /room down/);
    deps.ws.sendBotMessage = send;
    const [owed] = await rows();
    assert.deepEqual([owed.state, owed.message_id], ['fired', null], 'claimed, and still owed');
    assert.equal(sent.length, 0);
    assert.equal(await followups.fire(pool, { sessionId: change.id, event: 'vote', deps }), 1);
    assert.equal(sent.length, 1, 'told on the retry');
    assert.equal(Number((await rows())[0].message_id), sent[0].id);
    assert.equal(await followups.fire(pool, { sessionId: change.id, event: 'vote', deps }), 0);
    assert.equal(sent.length, 1, 'and once');
  });

  await t.test('a message that already told them keeps the promise', async () => {
    await clear();
    await ask();
    const done = await followups.satisfiedBy(pool, { sessionId: change.id, userId: evan.id, place: { type: 'issue' }, event: 'vote', messageId: 77 });
    assert.equal(done, 1);
    assert.equal(await followups.fire(pool, { sessionId: change.id, event: 'vote', deps }), 0);
    const [row] = await rows();
    assert.equal(row.state, 'fired');
    assert.equal(Number(row.message_id), 77);
  });

  // #6255: asked in the bot's chat while the request's first version was
  // still being built, so the row names the request and no session. The
  // change that links the request keeps it, and the ready card is the only
  // line: a later fire(vote) says nothing.
  await t.test('a promise about a request still being built is kept by the ready card', async () => {
    await clear();
    const asked = await followups.register(pool, {
      user: evan, app, issueNumber, event: 'vote', place: { type: 'dm', ref: null }, deps,
    });
    assert.equal(asked.ok, true);
    assert.equal(asked.promise, "I'll tell you here when it's ready to vote.");
    const done = await followups.satisfiedBy(pool, {
      sessionId: change.id, userId: evan.id, place: { type: 'dm' }, event: 'vote', messageId: 77,
    });
    assert.equal(done, 1);
    assert.equal(await followups.fire(pool, { sessionId: change.id, event: 'vote', deps }), 0);
    const [row] = await rows();
    assert.equal(row.state, 'fired');
    assert.equal(Number(row.message_id), 77);
    assert.equal(Number(row.session_id), Number(change.id), 'the request\'s promise now names the change that kept it');
    assert.equal(sent.length, 0);
  });

  await t.test('without the card keeping it, a vote fires exactly one line in the chat', async () => {
    await clear();
    await followups.register(pool, {
      user: evan, app, issueNumber, event: 'vote', place: { type: 'dm', ref: null }, deps,
    });
    assert.equal(await followups.fire(pool, { sessionId: change.id, event: 'vote', deps }), 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].place, 'dm');
    assert.match(sent[0].content, /@evan, PR 4249 is ready to vote on\./);
    assert.equal(await followups.fire(pool, { sessionId: change.id, event: 'vote', deps }), 0);
    assert.equal(sent.length, 1, 'said once');
  });

  await t.test('a promise about a change that never came expires after 30 days, quietly', async () => {
    await clear();
    await ask();
    await pool.query(`UPDATE homeroom_bot_followups SET created_at = now() - interval '31 days'`);
    assert.equal(await followups.expireOld(pool), 1);
    const [row] = await rows();
    assert.equal(row.state, 'expired');
    assert.equal(sent.length, 0);
  });

  await t.test('a promise about a moment the change already passed is refused, saying where it stands', async () => {
    await clear();
    await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [change.id]);
    const out = await ask({ event: 'vote' });
    assert.equal(out.ok, false);
    assert.match(out.error, /merged already/);
    assert.equal((await rows()).length, 0);
    await pool.query(`UPDATE chat_sessions SET status = 'promoted' WHERE id = $1`, [change.id]);
  });

  await t.test('only the person asking can set a promise, and it names their project', async () => {
    await clear();
    const out = await followups.register(pool, {
      user: null, app, sessionId: change.id, event: 'vote', place: { type: 'issue', ref: issueNumber }, deps,
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /yourself/);
    // Another project's change is named as a change, not a PR.
    const { rows: [theirs] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, reviewed_head_sha, linked_issues, pr_title, pr_number, approval_epoch)
       VALUES ($1, $2, 'promoted', $3, $4, 'Sort chores', 4249, 1) RETURNING *`,
      [otherApp.id, bot.id, SHA('a'), [++seq]]);
    await followups.register(pool, { user: evan, app: otherApp, sessionId: theirs.id, event: 'live', place: { type: 'issue', ref: seq }, deps });
    await followups.fire(pool, { sessionId: theirs.id, event: 'live', deps });
    assert.match(sent[0].content, /^@evan, change 4249 is live\.$/);
  });
});
