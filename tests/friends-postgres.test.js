'use strict';

// Mutual friends (#2386), executed against the FULL PostgreSQL schema.
//
// src/services/friends.js is consent logic, and consent logic is only as good
// as the SQL it runs: the pair normalisation, the silent decline, the 30-day
// quiet period across a cancel, the two caps, the block hook inside
// conversations.setBlock, the DM invitation a friendship accepts, and the
// notification fragment services/notifications.js reads live (which is in the
// dynamic-SQL baseline, so `npm run lint:sql` never parses it — this does).
// Every one of those runs here through the real planner, in a throwaway
// database built from src/db/schema.sql exactly as a boot applies it.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');

const friends = require('../src/services/friends');
const conversations = require('../src/services/conversations');
const notifications = require('../src/services/notifications');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('mutual friends against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `friends_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const config = { databaseUrl: String(url), jwtSecret: 'synthetic-test-only' };
  const routePool = require('../src/db/pool').getPool(config);
  t.after(async () => {
    await routePool.end();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, friendships included

  let seq = 0;
  async function user(prefix = 'friend') {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access)
       VALUES ($1, 'x', TRUE) RETURNING id, username`,
      [`${prefix}_${++seq}`]
    );
    return { ...rows[0], hasPlatformAccess: true };
  }
  const count = async (sql, params) => Number((await pool.query(sql, params)).rows[0].n);
  const notificationsFor = (userId, kind) => count(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND kind = $2', [userId, kind]
  );
  const stateOf = async (viewer, other) => (await friends.relationshipFor(pool, viewer.id, other.id)).state;

  await t.test('schema: one normalised row per pair, private, and boot-idempotent', async () => {
    const comments = (await pool.query(
      `SELECT c.relname, obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c
        WHERE c.relname IN ('friendships', 'friend_request_sends', 'friend_request_declines')
        ORDER BY c.relname`
    )).rows;
    assert.deepEqual(comments.map((r) => [r.relname, r.comment]), [
      ['friend_request_declines', 'staging:private'],
      ['friend_request_sends', 'staging:private'],
      ['friendships', 'staging:private'],
    ]);
    const a = await user(); const b = await user();
    const [high, low] = a.id > b.id ? [a.id, b.id] : [b.id, a.id];
    await assert.rejects(pool.query(
      `INSERT INTO friendships (user_low_id, user_high_id, requester_id) VALUES ($1, $2, $1)`, [high, low]
    ), { code: '23514' }, 'the pair must be normalised low < high');
    await assert.rejects(pool.query(
      `INSERT INTO friendships (user_low_id, user_high_id, requester_id, status) VALUES ($1, $2, $1, 'maybe')`,
      [low, high]
    ), { code: '23514' }, 'status is one of the three');
    const third = await user();
    await assert.rejects(pool.query(
      `INSERT INTO friendships (user_low_id, user_high_id, requester_id) VALUES ($1, $2, $3)`,
      [low, high, third.id]
    ), { code: '23514' }, 'the requester is one of the pair');
    const policy = (await pool.query(
      `SELECT kind, category, default_enabled FROM mobile_push_kind_categories
        WHERE kind IN ('friend_request', 'friend_accept') ORDER BY kind`
    )).rows;
    assert.deepEqual(policy, [
      { kind: 'friend_accept', category: 'direct_interactions', default_enabled: true },
      { kind: 'friend_request', category: 'direct_interactions', default_enabled: true },
    ], 'both kinds survive the seed AND its reaper');
  });

  await t.test('a request notifies once and reads four ways, to its two people only', async () => {
    const a = await user(); const b = await user();
    const sent = await friends.sendRequest(pool, a, b.id);
    assert.equal(sent.state, 'outgoing');
    assert.equal(sent.notifications.length, 1);
    assert.equal(sent.notifications[0].kind, 'friend_request');
    assert.equal(sent.notifications[0].user_id, b.id);
    assert.equal(await stateOf(a, b), 'outgoing');
    assert.equal(await stateOf(b, a), 'incoming');
    assert.deepEqual((await friends.listFor(pool, a.id)).outgoing.map((p) => p.id), [b.id]);
    assert.deepEqual((await friends.listFor(pool, b.id)).incoming.map((p) => p.id), [a.id]);
    assert.deepEqual((await friends.listFor(pool, b.id)).friends, []);
    // Asking again changes nothing and costs nothing.
    const again = await friends.sendRequest(pool, a, b.id);
    assert.deepEqual([again.state, again.notifications.length], ['outgoing', 0]);
    assert.equal(await notificationsFor(b.id, 'friend_request'), 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM friend_request_sends WHERE requester_id = $1', [a.id]), 1);

    // The bell's three reads carry who to answer and whether it still asks.
    const listed = (await notifications.listForUser(pool, b.id)).map(notifications.serialize)
      .find((n) => n.kind === 'friend_request');
    assert.equal(listed.sourceUserId, a.id);
    assert.equal(listed.sourceUsername, a.username);
    assert.equal(listed.friendRequestPending, true);
    assert.equal(listed.appId, null);
    const exact = notifications.serialize(await notifications.getForUser(pool, b.id, listed.id));
    assert.equal(exact.friendRequestPending, true);
    assert.equal(await notifications.countUnread(pool, b.id), 1);
    // A third person reads nothing of it.
    const c = await user();
    assert.equal(await stateOf(c, a), 'none');
    assert.equal(await stateOf(c, b), 'none');
  });

  await t.test('accepting makes friends, tells the requester, and opens a pending DM', async () => {
    const a = await user(); const b = await user();
    const dm = await conversations.createDirect(pool, a, b.id);
    assert.equal(dm.notifications[0].kind, 'conversation_invite', 'not friends yet: an invitation');
    await friends.sendRequest(pool, a, b.id);
    const accepted = await friends.accept(pool, b, a.id);
    assert.equal(accepted.state, 'friends');
    assert.deepEqual(accepted.notifications.map((n) => [n.kind, n.user_id, n.source_user_id]),
      [['friend_accept', a.id, b.id]]);
    assert.deepEqual(accepted.conversationIds, [dm.conversationId]);
    assert.deepEqual((await pool.query(
      'SELECT status FROM conversation_members WHERE conversation_id = $1 ORDER BY user_id', [dm.conversationId]
    )).rows.map((r) => r.status), ['member', 'member'], 'the still-pending invitation is accepted');
    assert.equal(await count(
      `SELECT COUNT(*) AS n FROM notifications WHERE conversation_id = $1
          AND kind = 'conversation_invite' AND read_at IS NULL`, [dm.conversationId]
    ), 0);
    assert.equal(await stateOf(a, b), 'friends');
    assert.equal(await stateOf(b, a), 'friends');
    assert.deepEqual((await friends.listFor(pool, a.id)).friends.map((p) => p.id), [b.id]);
    const request = (await notifications.listForUser(pool, b.id)).map(notifications.serialize)
      .find((n) => n.kind === 'friend_request');
    assert.equal(request.friendRequestPending, false, 'answered: the buttons go');
    assert.ok(request.readAt);
    // A second accept, or one for a request that is not there, says what IS.
    assert.equal((await friends.accept(pool, b, a.id)).state, 'friends');
    const c = await user();
    assert.equal((await friends.accept(pool, c, a.id)).state, 'none');
  });

  await t.test('a request back is the answer; so is the decliner changing their mind', async () => {
    const a = await user(); const b = await user();
    await friends.sendRequest(pool, a, b.id);
    const reciprocal = await friends.sendRequest(pool, b, a.id);
    assert.equal(reciprocal.state, 'friends');
    assert.equal(reciprocal.notifications[0].kind, 'friend_accept');

    const c = await user(); const d = await user();
    await friends.sendRequest(pool, c, d.id);
    await friends.decline(pool, d, c.id);
    assert.equal((await friends.sendRequest(pool, d, c.id)).state, 'friends',
      'the person who declined may reverse it by asking');
    assert.equal(await count('SELECT COUNT(*) AS n FROM friend_request_declines WHERE recipient_id = $1', [d.id]), 0,
      'and the quiet period protects nobody once they are friends');
  });

  await t.test('friends skip the DM invitation, even into a conversation once declined', async () => {
    const a = await user(); const b = await user();
    await friends.sendRequest(pool, a, b.id);
    await friends.accept(pool, b, a.id);
    const direct = await conversations.createDirect(pool, a, b.id);
    assert.deepEqual(direct.notifications, [], 'no invitation to answer');
    assert.deepEqual((await pool.query(
      'SELECT status FROM conversation_members WHERE conversation_id = $1 ORDER BY user_id', [direct.conversationId]
    )).rows.map((r) => r.status), ['member', 'member']);
    assert.ok(await conversations.sendMessage(pool, b, direct.conversationId, { content: 'straight in' }),
      'the recipient can write at once');

    const c = await user(); const d = await user();
    const declined = await conversations.createDirect(pool, c, d.id);
    await conversations.respond(pool, d, declined.conversationId, 'decline');
    assert.equal(await conversations.createDirect(pool, c, d.id), null,
      'strangers: the requester cannot reopen a declined request');
    await friends.sendRequest(pool, c, d.id);
    await friends.accept(pool, d, c.id);
    const reopened = await conversations.createDirect(pool, c, d.id);
    assert.equal(reopened.conversationId, declined.conversationId, 'friends: the same pair, reopened');
    assert.equal((await pool.query('SELECT status FROM conversations WHERE id = $1',
      [declined.conversationId])).rows[0].status, 'active');
  });

  await t.test('a decline is silent, and stays quiet for thirty days across cancel and resend', async () => {
    const a = await user(); const b = await user();
    await friends.sendRequest(pool, a, b.id);
    const declined = await friends.decline(pool, b, a.id);
    assert.equal(declined.state, 'none');
    assert.equal(await stateOf(a, b), 'outgoing', 'the sender is not told');
    assert.equal(await stateOf(b, a), 'none');
    assert.equal(await count('SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1', [a.id]), 0,
      'nothing at all reaches the sender');
    assert.equal(await count(
      `SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND kind = 'friend_request' AND read_at IS NULL`,
      [b.id]
    ), 0, 'the recipient\'s question is answered');

    // Cancel and resend inside the quiet period: "Requested" again for the
    // sender, and not a whisper for the person who declined.
    assert.equal((await friends.cancel(pool, a, b.id)).state, 'none');
    assert.equal(await notificationsFor(b.id, 'friend_request'), 0, 'the withdrawn request leaves the bell');
    const resent = await friends.sendRequest(pool, a, b.id);
    assert.deepEqual([resent.state, resent.notifications.length], ['outgoing', 0]);
    assert.equal(await stateOf(a, b), 'outgoing');
    assert.equal(await stateOf(b, a), 'none');
    assert.deepEqual((await friends.listFor(pool, b.id)).incoming, []);
    assert.equal(await notificationsFor(b.id, 'friend_request'), 0);

    // Thirty days on, the same resend is an ordinary request.
    await pool.query(
      `UPDATE friend_request_declines SET declined_at = NOW() - INTERVAL '31 days'
        WHERE recipient_id = $1 AND requester_id = $2`, [b.id, a.id]
    );
    await friends.cancel(pool, a, b.id);
    const later = await friends.sendRequest(pool, a, b.id);
    assert.equal(later.notifications.length, 1);
    assert.equal(await stateOf(b, a), 'incoming');
  });

  await t.test('caps: twenty waiting (declined ones included), fifty a rolling day', async () => {
    const sender = await user('capped');
    const targets = [];
    for (let i = 0; i < 21; i += 1) targets.push(await user('target'));
    for (const target of targets.slice(0, 20)) {
      assert.equal((await friends.sendRequest(pool, sender, target.id)).state, 'outgoing');
    }
    await friends.decline(pool, targets[0], sender.id);
    await assert.rejects(friends.sendRequest(pool, sender, targets[20].id), (err) => {
      assert.ok(err instanceof friends.FriendsError);
      assert.equal(err.status, 429);
      assert.equal(err.code, 'friend_request_pending_limit');
      assert.match(err.message, /20 friend requests waiting/);
      return true;
    }, 'a declined request still counts, or the cap would announce the decline');
    // Withdrawing one frees a slot.
    await friends.cancel(pool, sender, targets[1].id);
    assert.equal((await friends.sendRequest(pool, sender, targets[20].id)).state, 'outgoing');

    const busy = await user('busy');
    await pool.query(
      `INSERT INTO friend_request_sends (requester_id, created_at)
       SELECT $1, NOW() - INTERVAL '1 hour' FROM generate_series(1, 50)`, [busy.id]
    );
    const fresh = await user();
    await assert.rejects(friends.sendRequest(pool, busy, fresh.id),
      { status: 429, code: 'friend_request_daily_limit' });
    assert.equal(await stateOf(fresh, busy), 'none', 'a refused request leaves no row');
    await pool.query(
      `UPDATE friend_request_sends SET created_at = NOW() - INTERVAL '25 hours' WHERE requester_id = $1`, [busy.id]
    );
    assert.equal((await friends.sendRequest(pool, busy, fresh.id)).state, 'outgoing', 'the day rolls');
    assert.equal(await count('SELECT COUNT(*) AS n FROM friend_request_sends WHERE requester_id = $1', [busy.id]), 1,
      'and the ledger prunes what the day no longer counts');
  });

  await t.test('unfriending is silent; a block ends everything between the two, silently', async () => {
    const a = await user(); const b = await user();
    await friends.sendRequest(pool, a, b.id);
    await friends.accept(pool, b, a.id);
    const before = await count('SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1', [a.id]);
    assert.equal((await friends.unfriend(pool, b, a.id)).state, 'none');
    assert.equal(await stateOf(a, b), 'none');
    assert.equal(await count('SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1', [a.id]), before,
      'no notification tells them');

    const c = await user(); const d = await user(); const e = await user();
    await friends.sendRequest(pool, c, d.id);
    await friends.accept(pool, d, c.id);
    await friends.sendRequest(pool, e, c.id); // e asks c
    await friends.sendRequest(pool, c, b.id); // c asks b
    assert.ok(await conversations.setBlock(pool, c.id, d.id, true));
    assert.equal(await stateOf(d, c), 'none', 'the friendship is gone, as after an unfriend');
    assert.equal(await count(
      `SELECT COUNT(*) AS n FROM friendships WHERE user_low_id = LEAST($1::int, $2::int)
          AND user_high_id = GREATEST($1::int, $2::int)`, [c.id, d.id]
    ), 0);
    await assert.rejects(friends.sendRequest(pool, d, c.id), { status: 404, code: 'not_found' },
      'blocked either way: the same refusal a missing account gets');
    await assert.rejects(friends.sendRequest(pool, c, d.id), { status: 404, code: 'not_found' });
    await assert.rejects(friends.sendRequest(pool, c, 2147480000), { status: 404, code: 'not_found' });
    await assert.rejects(friends.sendRequest(pool, c, c.id), { status: 404, code: 'not_found' });

    // Blocking a pending requester removes their request from your bell;
    // blocking someone you asked withdraws your request from theirs.
    await conversations.setBlock(pool, c.id, e.id, true);
    assert.equal(await notificationsFor(c.id, 'friend_request'), 0);
    assert.equal(await stateOf(e, c), 'none');
    await conversations.setBlock(pool, c.id, b.id, true);
    assert.equal(await count(
      `SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND source_user_id = $2`, [b.id, c.id]
    ), 0, 'exactly what a cancel would have left behind');
    // Unblocking restores nothing.
    await conversations.setBlock(pool, c.id, d.id, false);
    assert.equal(await stateOf(c, d), 'none');
  });

  await t.test('the routes: states, one generic 404, capped 429s, private caching', async () => {
    const a = await user(); const b = await user(); const blocker = await user();
    await conversations.setBlock(pool, blocker.id, a.id, true);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = a; next(); });
    app.use(require('../src/routes/friends').friendRoutes(config));
    const { server, base } = await listen(app);
    const call = async (method, path) => {
      const res = await fetch(base + path, {
        method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}',
      });
      return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
    };
    try {
      let res = await call('POST', `/api/friends/${b.id}/request`);
      assert.deepEqual([res.status, res.body], [200, { userId: b.id, state: 'outgoing' }]);
      assert.match(res.cache, /private, no-store/);
      res = await call('GET', `/api/friends/${b.id}`);
      assert.deepEqual(res.body, { userId: b.id, state: 'outgoing' });
      res = await call('GET', '/api/friends');
      assert.deepEqual(Object.keys(res.body).sort(), ['friends', 'incoming', 'outgoing']);
      assert.deepEqual(res.body.outgoing.map((p) => p.username), [b.username]);
      assert.equal('count' in res.body, false, 'no counts, anywhere');
      const refused = await call('POST', `/api/friends/${blocker.id}/request`);
      const missing = await call('POST', '/api/friends/2147480001/request');
      const self = await call('POST', `/api/friends/${a.id}/request`);
      const junk = await call('POST', '/api/friends/abc/request');
      for (const r of [refused, missing, self, junk]) {
        assert.deepEqual([r.status, r.body], [404, { error: 'User not found' }],
          'a block reads exactly like a missing account');
      }
      res = await call('DELETE', `/api/friends/${b.id}/request`);
      assert.deepEqual(res.body, { userId: b.id, state: 'none' });
      res = await call('DELETE', `/api/friends/${b.id}`);
      assert.deepEqual([res.status, res.body.state], [200, 'none'], 'nothing to undo is not an error');
      await pool.query(
        `INSERT INTO friend_request_sends (requester_id) SELECT $1 FROM generate_series(1, 50)`, [a.id]
      );
      res = await call('POST', `/api/friends/${b.id}/request`);
      assert.equal(res.status, 429);
      assert.equal(res.body.code, 'friend_request_daily_limit');
      assert.match(res.body.error, /50 friend requests a day/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('pickers: friends first and flagged, strangers exactly as before', async () => {
    const viewer = await user('viewer');
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access)
       VALUES ('pick_alpha', 'x', TRUE), ('pick_zulu', 'x', TRUE) RETURNING id, username`
    );
    const [alpha, zulu] = rows;
    await friends.sendRequest(pool, viewer, zulu.id);
    await friends.accept(pool, { id: zulu.id }, viewer.id);
    const appRow = (await pool.query(
      `INSERT INTO apps (name, slug, created_by) VALUES ('Picker app', 'picker-app', $1) RETURNING id`,
      [viewer.id]
    )).rows[0];
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, 'hi'), ($1, $3, 'hey')`,
      [appRow.id, alpha.id, zulu.id]
    );
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { ...viewer, isAdmin: false }; next(); });
    app.use(require('../src/routes/collaborators').collaboratorRoutes(config));
    app.use(require('../src/routes/chat').chatRoutes(config));
    const { server, base } = await listen(app);
    try {
      const search = await (await fetch(`${base}/api/users/search?q=pick_&scope=messages`)).json();
      assert.deepEqual(search.users, [
        { id: zulu.id, username: 'pick_zulu', friend: true },
        { id: alpha.id, username: 'pick_alpha' },
      ]);
      const plain = await (await fetch(`${base}/api/users/search?q=pick_`)).json();
      assert.deepEqual(plain.users.map((u) => Object.keys(u).sort()), [['id', 'username'], ['id', 'username']],
        'the invite typeahead keeps its projection');
      const mentions = await (await fetch(`${base}/api/apps/picker-app/mention-suggestions`)).json();
      const picks = mentions.users.filter((u) => u.username.startsWith('pick_'));
      assert.deepEqual(picks, [{ username: 'pick_zulu', friend: true }, { username: 'pick_alpha' }]);
      assert.equal(mentions.users[0].username, 'pick_zulu', 'friends lead the whole list');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('a profile carries the signed-in viewer\'s own relationship, and nobody else\'s', async () => {
    const viewer = await user('viewer');
    const target = await user('target');
    await pool.query('UPDATE users SET profile_published = TRUE WHERE id = $1', [target.id]);
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
      [token, viewer.id]
    );
    const targetToken = crypto.randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
      [targetToken, target.id]
    );
    await friends.sendRequest(pool, target, viewer.id);
    const app = express();
    app.use(cookieParser());
    app.use(require('../src/routes/profiles').publicProfileRoutes(config));
    const { server, base } = await listen(app);
    const read = async (cookie) => (await fetch(`${base}/api/public/profiles/${target.username}`, {
      headers: cookie ? { Cookie: `session=${cookie}` } : {},
    })).json();
    try {
      const anonymous = await read(null);
      assert.equal(anonymous.profile.username, target.username);
      assert.equal('friendship' in anonymous, false, 'an anonymous read is what it always was');
      assert.deepEqual((await read(token)).friendship, { userId: target.id, state: 'incoming' });
      assert.equal('friendship' in (await read(targetToken)), false, 'not on your own page');
      await pool.query('UPDATE users SET has_platform_access = FALSE WHERE id = $1', [viewer.id]);
      assert.equal('friendship' in (await read(token)), false, 'no platform access, no button');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('concurrent requests across the pair become one friendship', async () => {
    const a = await user(); const b = await user();
    const [one, two] = await Promise.all([
      friends.sendRequest(pool, a, b.id),
      friends.sendRequest(pool, b, a.id),
    ]);
    assert.deepEqual([one.state, two.state].sort(), ['friends', 'outgoing']);
    assert.equal(await stateOf(a, b), 'friends');
    assert.equal(await count(
      `SELECT COUNT(*) AS n FROM friendships WHERE user_low_id = LEAST($1::int, $2::int)
          AND user_high_id = GREATEST($1::int, $2::int)`, [a.id, b.id]
    ), 1);
  });
});
