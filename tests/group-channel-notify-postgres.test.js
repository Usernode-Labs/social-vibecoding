'use strict';

// A small private group's discussion reaches the rest of the group, against
// the FULL PostgreSQL schema in a throwaway database, through the real code:
// the canonical chat handler (services/ws.js handleMessage), the read-cursor
// route (routes/chat.js) and services/group-channel-notify.js.
//
// The production case it is built from: a private project of two people.
// One asked the other a direct question in its discussion, and the other got
// no bell row and no push; the answer went back the same way.
//
// Pinned here:
//   * a person's message reaches the other people, never its author, as ONE
//     row per discussion that folds the next messages in (and does not ring
//     again), until the reader reads the discussion or writes in it;
//   * the INSERT is what rings: a fresh row queues a push under the Messages
//     category, a fold queues none, and Messages off on the phone means none;
//   * a mention, a thread, a connector's post, the bot and a blocked person
//     never ring it, and nobody already reading is told;
//   * "Every message in the discussion" off (per project, or account-wide)
//     is silence, and a project's own choice beats the account's;
//   * public communities and groups past 8 people keep mention-only;
//   * the invite maker's "said hi" is not doubled.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/group-channel-notify-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('small-group discussions against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `group_channel_${crypto.randomBytes(6).toString('hex')}`;
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
  await pool.query(schema); // boot-idempotent

  // The routes resolve their pool at construction. The cross-instance bus is
  // where every frame passes (a no-op until start()), so recording it is how
  // the test hears what a person's sockets would.
  require('../src/db/pool').getPool = () => pool;
  const frames = [];
  const wsBus = require('../src/services/ws-bus');
  wsBus.publish = (kind, routing, data) => frames.push({ kind, routing, data });
  const ws = require('../src/services/ws');
  const appChat = require('../src/services/app-chat');
  const group = require('../src/services/group-channel-notify');
  const { chatRoutes } = require('../src/routes/chat');

  // A phone for whoever needs one: a registration the outbox trigger can
  // reach. The native-credential chain behind a real one is not what is
  // under test here, so its foreign key goes in this throwaway database.
  await pool.query('ALTER TABLE mobile_push_registrations DROP CONSTRAINT IF EXISTS mobile_push_registrations_native_credential_user_fk');
  await pool.query(
    `INSERT INTO mobile_push_deployment_state (environment, firebase_project_id, send_enabled, send_not_before)
     VALUES ('production', 'test-project', TRUE, NOW() - INTERVAL '1 hour')
     ON CONFLICT (environment) DO UPDATE SET send_enabled = TRUE, send_not_before = NOW() - INTERVAL '1 hour'`
  );
  async function phone(who) {
    await pool.query(
      `INSERT INTO mobile_push_registrations
         (user_id, native_session_credential_reference, environment, installation_id,
          registration_hash, registration_enc, platform, permission_status, session_expires_at)
       VALUES ($1, $2, 'production', $3, $4, 'enc:opaque', 'ios', 'authorized', NOW() + INTERVAL '1 day')`,
      [who.id, `nsc_${String(who.id).padStart(43, '0')}`, crypto.randomUUID(),
        crypto.randomBytes(32).toString('hex')]
    );
  }
  const deliveries = async (notificationId) => Number((await pool.query(
    'SELECT COUNT(*)::int AS n FROM mobile_push_deliveries WHERE notification_id = $1', [notificationId]
  )).rows[0].n);

  const users = {};
  async function user(username, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id, username`,
      [username, synthetic]
    );
    users[rows[0].id] = { id: rows[0].id, username, isAdmin: false };
    return users[rows[0].id];
  }
  async function project(slug, appName, owner, { view = 'private' } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, $4, $4) RETURNING id, slug, name`,
      [appName, slug, owner.id, view]
    );
    await member(rows[0], owner);
    return rows[0];
  }
  // A collaborator who is in: the community membership follows by trigger.
  async function member(app, who) {
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
       VALUES ($1, $2, 'member', NOW()) ON CONFLICT (app_id, user_id) DO UPDATE SET status = 'member'`,
      [app.id, who.id]
    );
  }
  const client = (who, app, extra = {}) => ({
    user: { id: who.id, username: who.username }, appId: app.id, appSlug: app.slug, ...extra,
  });
  async function say(who, app, content, extra = {}, clientExtra = {}) {
    const result = await ws.handleMessage(pool, client(who, app, clientExtra), { type: 'chat', content, ...extra });
    assert.equal(result?.ok, true, `posted: ${JSON.stringify(result)}`);
    return result.message.id;
  }
  const rowsFor = async (who, app, kind = 'channel_message') => (await pool.query(
    `SELECT * FROM notifications WHERE user_id = $1 AND app_id = $2 AND kind = $3 ORDER BY id`,
    [who.id, app.id, kind]
  )).rows;
  const unreadFor = async (who, app) => (await rowsFor(who, app)).filter((r) => !r.read_at);
  const userFrames = (who, type) => frames.filter((f) => f.kind === 'user'
    && Number(f.routing?.userId) === Number(who.id) && f.data?.type === type);

  const httpApp = express();
  httpApp.use(express.json());
  httpApp.use((req, _res, next) => {
    req.user = users[Number(req.get('x-test-user'))];
    next();
  });
  httpApp.use(chatRoutes({}));
  server = await new Promise((resolve) => {
    const listening = httpApp.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function readTo(who, app, messageId) {
    const res = await fetch(`${base}/api/apps/${app.slug}/messages/read`, {
      method: 'POST',
      headers: { 'x-test-user': String(who.id), 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: messageId }),
    });
    assert.equal(res.status, 200, await res.text());
  }

  const jordan = await user('gc_jordan');
  const sam = await user('gc_sam');
  const flat = await project('flat-4b', 'Flat 4B Chores', jordan);
  await member(flat, sam);
  await phone(sam);
  await phone(jordan);

  await t.test('the two-person group is a small group; its switch is offered', async () => {
    assert.equal(await group.isSmallGroup(pool, flat.id), true);
  });

  let firstRowId;
  await t.test('Jordan\'s question reaches Sam: one row, and it rings', async () => {
    const id = await say(jordan, flat, 'Thanks for spotting the tick bug Sam! Which one do we go with?');
    const rows = await rowsFor(sam, flat);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].chat_message_id, id);
    assert.equal(rows[0].source_user_id, jordan.id);
    assert.equal(rows[0].detail, null, 'one message: no count');
    assert.equal(rows[0].read_at, null);
    assert.equal((await rowsFor(jordan, flat)).length, 0, 'never the author');
    assert.equal(await deliveries(rows[0].id), 1, 'a fresh row queues one push to Sam\'s phone');
    const live = userFrames(sam, 'notification_new').map((f) => f.data.notification);
    const mine = live.find((n) => n.id === rows[0].id);
    assert.ok(mine, 'Sam\'s bell hears it at once');
    assert.equal(mine.kind, 'channel_message');
    assert.equal(mine.appName, 'Flat 4B Chores');
    assert.equal(mine.sourceUsername, 'gc_jordan');
    assert.equal(mine.messageContent, 'Thanks for spotting the tick bug Sam! Which one do we go with?');
    assert.equal(mine.href, `#messages/app/flat-4b/m/${id}`, 'it opens the discussion, on the message');
    firstRowId = rows[0].id;
  });

  await t.test('the next message folds into it and does not ring again', async () => {
    const before = (await rowsFor(sam, flat))[0];
    const id = await say(jordan, flat, 'The blue one or the green one?');
    const rows = await rowsFor(sam, flat);
    assert.equal(rows.length, 1, 'one row per discussion');
    assert.equal(rows[0].id, firstRowId);
    assert.equal(rows[0].detail, '2');
    assert.equal(rows[0].chat_message_id, id, 'it points at the newest message');
    assert.ok(new Date(rows[0].created_at) >= new Date(before.created_at), 'and moves to the top');
    assert.equal(await deliveries(firstRowId), 1, 'no second push: a fold is not an insert');
    await say(jordan, flat, 'No rush.');
    assert.equal((await rowsFor(sam, flat))[0].detail, '3');
  });

  await t.test('reading the discussion clears it, and the next message is news again', async () => {
    const newest = (await rowsFor(sam, flat))[0].chat_message_id;
    const changedBefore = userFrames(sam, 'notifications_changed').length;
    await readTo(sam, flat, newest);
    assert.ok((await rowsFor(sam, flat))[0].read_at, 'read in the discussion is read in the bell');
    assert.equal(userFrames(sam, 'notifications_changed').length, changedBefore + 1, 'Sam\'s other screens re-sync');
    const id = await say(jordan, flat, 'Also the bins.');
    const unread = await unreadFor(sam, flat);
    assert.equal(unread.length, 1);
    assert.notEqual(unread[0].id, firstRowId, 'a new row, which rings');
    assert.equal(unread[0].chat_message_id, id);
    assert.equal(await deliveries(unread[0].id), 1);
  });

  await t.test('Sam\'s answer reaches Jordan, and writing in it clears Sam\'s own row', async () => {
    const id = await say(sam, flat, 'Blue. And yes to the bins.');
    assert.equal((await unreadFor(sam, flat)).length, 0, 'posting in the main stream is reading it');
    const jordans = await unreadFor(jordan, flat);
    assert.equal(jordans.length, 1);
    assert.equal(jordans[0].chat_message_id, id);
    assert.equal(jordans[0].source_user_id, sam.id);
    assert.equal(await deliveries(jordans[0].id), 1);
    await readTo(jordan, flat, id);
  });

  await t.test('a mention already rings, so it is not doubled', async () => {
    const id = await say(jordan, flat, '@gc_sam can you do Tuesday?');
    const mentions = (await rowsFor(sam, flat, 'mention')).filter((r) => r.chat_message_id === id);
    assert.equal(mentions.length, 1);
    assert.equal((await unreadFor(sam, flat)).length, 0, 'the mention is the one row for that message');
    await say(sam, flat, 'Yes.');
    await readTo(jordan, flat, (await unreadFor(jordan, flat))[0].chat_message_id);
  });

  await t.test('a reply thread is not the discussion, and never rings it', async () => {
    const root = await say(jordan, flat, 'Thread about the rota');
    await readTo(sam, flat, root);
    await say(jordan, flat, 'first reply', { thread: { type: 'message', ref: root } });
    assert.equal((await unreadFor(sam, flat)).length, 0);
  });

  await t.test('a connector\'s post is not a person typing', async () => {
    await say(jordan, flat, 'posted by my agent', {}, { postedVia: 'agent' });
    assert.equal((await unreadFor(sam, flat)).length, 0);
  });

  await t.test('nobody already reading past it is told', async () => {
    const { rows: [m] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type) VALUES ($1, $2, 'seen it', 'message') RETURNING id`,
      [flat.id, jordan.id]
    );
    await appChat.markRead(pool, { appId: flat.id, userId: sam.id, messageId: m.id });
    assert.deepEqual(await group.notifyChannelMessage(pool, { appId: flat.id, messageId: m.id, senderId: jordan.id }), []);
    assert.equal((await unreadFor(sam, flat)).length, 0);
  });

  await t.test('the bot never rings it, and is never counted or told', async () => {
    const bot = await user('gc_homeroom_bot', { synthetic: true });
    await member(flat, bot);
    assert.equal(await group.isSmallGroup(pool, flat.id), true);
    const { rows: [m] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type) VALUES ($1, $2, 'beep', 'message') RETURNING id`,
      [flat.id, bot.id]
    );
    assert.deepEqual(await group.notifyChannelMessage(pool, { appId: flat.id, messageId: m.id, senderId: bot.id }), []);
    // A system line has no author at all.
    const { rows: [sys] } = await pool.query(
      `INSERT INTO chat_messages (app_id, content, msg_type) VALUES ($1, 'Something happened', 'system') RETURNING id`,
      [flat.id]
    );
    assert.deepEqual(await group.notifyChannelMessage(pool, { appId: flat.id, messageId: sys.id, senderId: jordan.id }), []);
    const id = await say(jordan, flat, 'Hello both');
    assert.equal((await rowsFor(bot, flat)).length, 0, 'the bot reads no notifications');
    assert.equal((await unreadFor(sam, flat))[0].chat_message_id, id);
    await readTo(sam, flat, id);
  });

  await t.test('blocking either way is silence', async () => {
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [sam.id, jordan.id]);
    await say(jordan, flat, 'are you there');
    assert.equal((await unreadFor(sam, flat)).length, 0);
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1', [sam.id]);
    const id = await say(jordan, flat, 'ok now');
    assert.equal((await unreadFor(sam, flat)).length, 1);
    await readTo(sam, flat, id);
  });

  await t.test('the switch: off is silence, and a project\'s own choice wins', async () => {
    await pool.query(
      `INSERT INTO notification_preferences (user_id, app_id, category, enabled) VALUES ($1, $2, 'channel_messages', FALSE)`,
      [sam.id, flat.id]
    );
    await say(jordan, flat, 'quiet please');
    assert.equal((await unreadFor(sam, flat)).length, 0, 'off for this project');
    await pool.query('DELETE FROM notification_preferences WHERE user_id = $1', [sam.id]);
    await pool.query(
      `INSERT INTO notification_preferences (user_id, app_id, category, enabled)
       VALUES ($1, NULL, 'channel_messages', FALSE), ($1, $2, 'channel_messages', TRUE)`,
      [sam.id, flat.id]
    );
    const id = await say(jordan, flat, 'but this one');
    assert.equal((await unreadFor(sam, flat)).length, 1, 'quiet in every group, except this one');
    await readTo(sam, flat, id);
    await pool.query('DELETE FROM notification_preferences WHERE user_id = $1', [sam.id]);
    await pool.query(
      `INSERT INTO notification_preferences (user_id, app_id, category, enabled) VALUES ($1, NULL, 'channel_messages', FALSE)`,
      [sam.id]
    );
    await say(jordan, flat, 'and now?');
    assert.equal((await unreadFor(sam, flat)).length, 0, 'account-wide off, no project override');
    await pool.query('DELETE FROM notification_preferences WHERE user_id = $1', [sam.id]);
  });

  await t.test('Messages off on the phone keeps the row and drops the push', async () => {
    await pool.query(
      `INSERT INTO mobile_push_preferences (user_id, category, enabled) VALUES ($1, 'messages', FALSE)`,
      [sam.id]
    );
    const id = await say(jordan, flat, 'phone quiet');
    const unread = await unreadFor(sam, flat);
    assert.equal(unread.length, 1, 'the bell still has it');
    assert.equal(await deliveries(unread[0].id), 0, 'the existing push policy decides the phone');
    await pool.query('DELETE FROM mobile_push_preferences WHERE user_id = $1', [sam.id]);
    await readTo(sam, flat, id);
  });

  await t.test('a public community keeps mention-only', async () => {
    const open = await project('open-club', 'Open Club', jordan, { view: 'public' });
    await member(open, sam);
    assert.equal(await group.isSmallGroup(pool, open.id), false);
    await say(jordan, open, 'hi everyone');
    assert.equal((await rowsFor(sam, open)).length, 0);
  });

  await t.test('8 people is a small group; 9 keeps mention-only; an invite is not a person yet', async () => {
    const owner = await user('gc_owner');
    const eight = await project('eight', 'Eight', owner);
    const others = [];
    for (let i = 0; i < 7; i += 1) {
      const u = await user(`gc_eight_${i}`);
      await member(eight, u);
      others.push(u);
    }
    const pending = await user('gc_pending');
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by) VALUES ($1, $2, 'invited', $3)`,
      [eight.id, pending.id, owner.id]
    );
    assert.equal(await group.isSmallGroup(pool, eight.id), true);
    await say(owner, eight, 'all here?');
    for (const u of others) assert.equal((await unreadFor(u, eight)).length, 1, u.username);
    assert.equal((await rowsFor(pending, eight)).length, 0, 'a pending invite cannot read it yet');
    assert.equal((await rowsFor(owner, eight)).length, 0);

    const ninth = await user('gc_ninth');
    await member(eight, ninth);
    assert.equal(await group.isSmallGroup(pool, eight.id), false);
    await say(owner, eight, 'now nine of us');
    assert.equal((await rowsFor(ninth, eight)).length, 0);
    assert.equal((await rowsFor(others[0], eight))[0].detail, null, 'nothing folded in past the bound');
  });

  await t.test('the invite maker hears "said hi" once, not twice', async () => {
    const maya = await user('gc_maya');
    const lee = await user('gc_lee');
    const garden = await project('garden', 'Garden', maya);
    const { rows: [app] } = await pool.query('SELECT community_id FROM apps WHERE id = $1', [garden.id]);
    const { rows: [invite] } = await pool.query(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days') RETURNING id`,
      [crypto.randomBytes(16).toString('base64url').slice(0, 22), app.community_id, garden.id, maya.id]
    );
    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, applied_at) VALUES ($1, $2, 'joined', NOW())`,
      [invite.id, lee.id]
    );
    await member(garden, lee);
    const id = await say(lee, garden, 'hi Maya!');
    const hello = await rowsFor(maya, garden, 'first_message');
    assert.equal(hello.length, 1);
    assert.equal(hello[0].chat_message_id, id);
    assert.equal((await rowsFor(maya, garden)).length, 0, 'no second row for the same message');
    // The next message is an ordinary one, and rings as one.
    const next = await say(lee, garden, 'what shall we plant?');
    assert.equal((await unreadFor(maya, garden))[0].chat_message_id, next);
  });
});
