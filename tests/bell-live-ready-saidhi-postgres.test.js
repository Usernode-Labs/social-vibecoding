'use strict';

// The bell after a change is decided, against the full schema (5 October,
// Page Turners). In that run-through Mo opened his bell 36 minutes after the
// first version went live and it still said "Ready to try" about it, unread,
// beside "Waiting for your approval · 1 change"; and Alex's bell called
// Priya's first message, a request Homeroom bot filed, "Said hi".
//
//   - settleDecidedChange: live, the newest "ready to try" each person was
//     sent is the news (unread again unless they said yes), older versions'
//     and the vote nudges are read; closed, all of it is read; digests it was
//     the last one waiting in are read; everyone touched hears it.
//   - The bell reads the change's status, a digest's live count and the
//     request a first message became, with the row (listForUser, getForUser).
//   - homeroom-bot-chat record() pushes the maker's row again once the first
//     message is filed, and the rest of a small group's discussion rows
//     about a message once it is filed (Mo's, the same day).
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/bell-live-ready-saidhi-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const notifications = require('../src/services/notifications');
const ws = require('../src/services/ws');

test('the bell after a change is decided, against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bell_live_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  // Who heard `notifications_changed`, and what was pushed live.
  const pushed = [];
  const realPush = ws.pushNotificationToUser;
  ws.pushNotificationToUser = (userId, payload) => { pushed.push({ userId: Number(userId), payload }); };
  t.after(() => { ws.pushNotificationToUser = realPush; });
  const changedFor = () => pushed.filter((p) => p.payload.type === 'notifications_changed').map((p) => p.userId).sort();

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  const bot = await user('homeroom_bot', true);
  const alex = await user('alex');
  const priya = await user('priya');
  const mo = await user('mo');

  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Page Turners', 'page-turners', 'running', $1, 'private', 'private') RETURNING id`,
    [alex.id],
  );
  const app = (await pool.query('SELECT id, slug, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  for (const person of [alex, priya, mo]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, person.id]);
    await pool.query('INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.id, person.id]);
  }

  const change = async (title, promotedAgo = '1 hour') => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, pr_title, promoted_at)
     VALUES ($1, $2, $3, 'promoted', $4, $4, NOW() - $5::interval) RETURNING id`,
    [app.id, bot.id, `bot-${crypto.randomBytes(4).toString('hex')}`, title, promotedAgo],
  )).rows[0].id;
  const notify = async (userId, kind, { sessionId = null, detail = null, read = false, ago = '30 minutes', source = alex.id, message = null } = {}) => (
    await pool.query(
      `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail, chat_message_id, read_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN NOW() ELSE NULL END, NOW() - $9::interval)
       RETURNING id`,
      [userId, app.id, sessionId, source, kind, detail, message, read, ago],
    )).rows[0].id;
  const row = async (id) => (await pool.query('SELECT id, user_id, kind, read_at FROM notifications WHERE id = $1', [id])).rows[0];
  const listed = async (userId, id) => {
    const rows = await notifications.listForUser(pool, userId);
    const found = rows.find((r) => r.id === id);
    return found ? notifications.serialize(found) : null;
  };

  await t.test('the first version goes live: Mo\'s "ready to try" says Live, his nudges and his digest of one are read', async () => {
    pushed.length = 0;
    const first = await change('Build the Page Turners club screen');
    // Mo: two versions asked about (the newest is the news), the vote nudge,
    // a re-confirm ask and the digest that named this change alone.
    const moOlder = await notify(mo.id, 'change_ready', { sessionId: first, detail: 'epoch:0', ago: '50 minutes' });
    const moReady = await notify(mo.id, 'change_ready', { sessionId: first, detail: 'epoch:1', ago: '43 minutes' });
    const moNudge = await notify(mo.id, 'pr_proposed', { sessionId: first });
    const moRecheck = await notify(mo.id, 'revision_recheck', { sessionId: first, detail: '1' });
    const moDigest = await notify(mo.id, 'vote_digest', { sessionId: first, detail: '1', ago: '20 minutes', source: null });
    // Priya said yes: her ask was read by the vote and stays read.
    const priyaReady = await notify(priya.id, 'change_ready', { sessionId: first, detail: 'epoch:1', read: true });
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [first, priya.id]);

    const before = await listed(mo.id, moReady);
    assert.equal(before.sessionStatus, 'promoted', 'up for approval, it asks');
    assert.equal((await listed(mo.id, moDigest)).digestWaiting, 1);

    // Still up for approval: nothing is settled.
    assert.deepEqual(await notifications.settleDecidedChange(pool, first), []);
    assert.equal((await row(moNudge)).read_at, null);

    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [first]);
    const told = await notifications.settleDecidedChange(pool, first);
    assert.deepEqual(told, [mo.id], 'only Mo\'s bell changed');
    assert.deepEqual(changedFor(), [mo.id], 'and he hears it, which re-badges his phone');

    assert.equal((await row(moReady)).read_at, null, 'the newest ask is the news, still unread');
    assert.notEqual((await row(moOlder)).read_at, null, 'an older version\'s ask is put away');
    for (const id of [moNudge, moRecheck, moDigest]) {
      assert.notEqual((await row(id)).read_at, null, `${(await row(id)).kind} is answered by the decision`);
    }
    assert.notEqual((await row(priyaReady)).read_at, null, 'whoever said yes saw it go: not raised again');

    const live = await listed(mo.id, moReady);
    assert.equal(live.sessionStatus, 'merged', 'the bell words it Live off the change itself');
    assert.equal(live.readAt, null);
    assert.equal((await listed(mo.id, moDigest)).digestWaiting, 0, 'the digest counts nothing now');
    const exact = notifications.serialize(await notifications.getForUser(pool, mo.id, moReady));
    assert.equal(exact.sessionStatus, 'merged', 'the exact lookup (a push opened) reads the same');

    // Settling again changes nothing and tells nobody.
    pushed.length = 0;
    assert.deepEqual(await notifications.settleDecidedChange(pool, first), []);
    assert.deepEqual(changedFor(), []);
  });

  await t.test('a read "ready to try" comes back unread as the news, once, for whoever had not said yes', async () => {
    const next = await change('Show whose place we meet at');
    const seen = await notify(mo.id, 'change_ready', { sessionId: next, detail: 'epoch:0', read: true });
    const noVote = await notify(priya.id, 'change_ready', { sessionId: next, detail: 'epoch:0', read: true });
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'no')`, [next, priya.id]);
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [next]);
    const told = await notifications.settleDecidedChange(pool, next);
    assert.deepEqual(told.sort(), [priya.id, mo.id].sort());
    assert.equal((await row(seen)).read_at, null, 'Mo looked but never voted: it went live without him');
    assert.equal((await row(noVote)).read_at, null, 'a No is not a Yes: Priya hears it went live anyway');
    // No second row, so nothing rang twice.
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE session_id = $1`, [next]);
    assert.equal(rows[0].n, 2);
  });

  await t.test('a closed change asks nobody anything: its "ready to try" is read and says Closed', async () => {
    const closed = await change('Dark mode');
    const ask = await notify(mo.id, 'change_ready', { sessionId: closed, detail: 'epoch:0' });
    const nudge = await notify(mo.id, 'pr_proposed', { sessionId: closed });
    await pool.query(`UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1`, [closed]);
    assert.deepEqual(await notifications.settleDecidedChange(pool, closed), [mo.id]);
    assert.notEqual((await row(ask)).read_at, null);
    assert.notEqual((await row(nudge)).read_at, null);
    const shown = notifications.serialize(await notifications.getForUser(pool, mo.id, ask));
    assert.equal(shown.sessionStatus, 'archived');
  });

  await t.test('a digest of several counts only what still waits, and is read when nothing does', async () => {
    const a = await change('Books read list', '3 hours');
    const b = await change('Star ratings', '2 hours');
    const later = await change('Sent after the digest', '1 minute');
    const digest = await notify(mo.id, 'vote_digest', { detail: '2', ago: '90 minutes', source: null });
    assert.equal((await listed(mo.id, digest)).digestWaiting, 2,
      'two up for approval when it was sent; one put up since is not what it counted');

    // Mo votes on one: that one stops waiting on him, the other still does.
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [a, mo.id]);
    assert.equal((await listed(mo.id, digest)).digestWaiting, 1);
    assert.deepEqual(await notifications.settleVoteDigests(pool, { userIds: [mo.id] }), [], 'one still waits: kept');
    assert.equal((await row(digest)).read_at, null);

    // The other goes live: nothing waits, and its decision settles the digest.
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [b]);
    assert.equal((await listed(mo.id, digest)).digestWaiting, 0);
    assert.ok((await notifications.settleDecidedChange(pool, b)).includes(mo.id));
    assert.notEqual((await row(digest)).read_at, null);

    // Never more than it said, and never every digest on the platform.
    assert.deepEqual(await notifications.settleVoteDigests(pool, {}), []);
    await pool.query(`UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1`, [later]);
  });

  await t.test('a first message Homeroom bot filed as a request is "Asked for a change", pushed again when it is filed', async () => {
    const { rows: [message] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content)
       VALUES ($1, $2, 'Could it also keep a list of the books we''ve already read?') RETURNING id`,
      [app.id, priya.id],
    );
    const hello = await notify(alex.id, 'first_message', { message: message.id, source: priya.id, ago: '1 minute' });
    assert.equal((await listed(alex.id, hello)).requestNumber, null, 'just sent: what they said');

    const chat = require('../src/services/homeroom-bot-chat');
    // The newcomer's offer is not a request yet ("Suggest it" / "Not now").
    pushed.length = 0;
    await chat.record(pool, { messageId: message.id, appId: app.id, userId: priya.id, kind: 'offer', title: 'Books read list' });
    assert.equal((await listed(alex.id, hello)).requestNumber, null);
    assert.equal(pushed.length, 0, 'nothing to say again');

    // "Suggest it": filed as request #2. Alex's row is pushed again as it reads now.
    await chat.record(pool, {
      messageId: message.id, appId: app.id, userId: priya.id, kind: 'filed', issueNumber: 2, title: 'Books read list', replace: true,
    });
    const now = await listed(alex.id, hello);
    assert.equal(now.requestNumber, 2);
    const live = pushed.filter((p) => p.payload.type === 'notification_new');
    assert.equal(live.length, 1);
    assert.equal(live[0].userId, alex.id, 'to the maker, the one person told she said hi');
    assert.equal(live[0].payload.notification.id, hello);
    assert.equal(live[0].payload.notification.requestNumber, 2);

    // Other kinds' shape is unchanged: none of the three new fields.
    const mention = await notify(alex.id, 'mention', { message: message.id, source: priya.id });
    const plain = await listed(alex.id, mention);
    for (const field of ['sessionStatus', 'digestWaiting', 'requestNumber']) {
      assert.equal(Object.prototype.hasOwnProperty.call(plain, field), false, field);
    }
  });

  await t.test('a group discussion message the bot filed: the rest of the group\'s rows say it is a request, pushed again', async () => {
    // The real discussion path (services/group-channel-notify.js): a private
    // project of three, each a member collaborator, so Mo's message rings
    // Alex and Priya.
    const group = require('../src/services/group-channel-notify');
    for (const person of [alex, priya, mo]) {
      await pool.query(
        `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW())
         ON CONFLICT (app_id, user_id) DO UPDATE SET status = 'member'`,
        [app.id, person.id],
      );
    }
    const post = async (who, content) => (await pool.query(
      'INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, $3) RETURNING id', [app.id, who.id, content],
    )).rows[0].id;
    const asked = await post(mo, 'Could it also show whose place we meet at next time?');
    pushed.length = 0;
    const rang = await group.notifyChannelMessage(pool, { appId: app.id, messageId: asked, senderId: mo.id });
    assert.deepEqual(rang.map((r) => Number(r.user_id)).sort(), [alex.id, priya.id].sort(), 'the rest of the group');
    const rowOf = (who) => rang.find((r) => Number(r.user_id) === who.id).id;
    assert.equal((await listed(alex.id, rowOf(alex))).requestNumber, null, 'just sent: what Mo said');

    // A read that is not a request (a question for the bot) changes nothing.
    pushed.length = 0;
    const chat = require('../src/services/homeroom-bot-chat');
    const question = await post(mo, 'What can the bot do?');
    await chat.record(pool, { messageId: question, appId: app.id, userId: mo.id, kind: 'question' });
    assert.equal(pushed.length, 0);

    // Filed as request #4 (the group files it; the bot does not build here).
    await chat.record(pool, {
      messageId: asked, appId: app.id, userId: mo.id, kind: 'group', issueNumber: 4, title: 'Show the host', replace: true,
    });
    for (const who of [alex, priya]) {
      assert.equal((await listed(who.id, rowOf(who))).requestNumber, 4, who.username);
      const exact = notifications.serialize(await notifications.getForUser(pool, who.id, rowOf(who)));
      assert.equal(exact.requestNumber, 4, 'the exact lookup (a push opened) reads the same');
    }
    const again = pushed.filter((p) => p.payload.type === 'notification_new');
    assert.deepEqual(again.map((p) => p.userId).sort(), [alex.id, priya.id].sort(), 'each row pushed again, to its reader');
    assert.ok(again.every((p) => p.payload.notification.requestNumber === 4 && p.payload.notification.kind === 'channel_message'));
    assert.ok(again.every((p) => p.payload.notification.readAt === null), 'unread as it was');

    // Priya answers before Alex reads: his row folds her message in, and is
    // about two messages now, not Mo's request.
    await group.notifyChannelMessage(pool, { appId: app.id, messageId: await post(priya, 'Good idea'), senderId: priya.id });
    const folded = await listed(alex.id, rowOf(alex));
    assert.equal(folded.detail, '2');
    assert.equal(folded.requestNumber, null, 'its newest message is not the request');
  });
});
