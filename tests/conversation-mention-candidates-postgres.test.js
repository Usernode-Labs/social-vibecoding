'use strict';

// #3361 -- @mention candidates for one conversation. A channel has no loaded
// roster (serializeConversation counts it, because a channel is every user),
// so the composer fetched nobody from active.members and typing `@` in
// #general offered no names. The endpoint returns the conversation's
// distinct recent message authors instead: block-filtered, system and
// deleted messages excluded, capped at 500, most recent author first.
//
// Executed against the REAL migration, like
// tests/conversation-threads-postgres.test.js beside it, and it drives the
// HTTP route over that database so the status codes and shape the client is
// written against are the ones asserted here. Skips when no PostgreSQL is
// reachable, like the repository's other postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

// Realtime and push are process-wide singletons. Capture what the routes
// hand them instead of opening sockets or scheduling badge syncs.
const events = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds, payload, options) {
      events.push({ memberIds: [...memberIds], payload, options });
      return memberIds.length;
    },
    pushToUser(userId, payload) { events.push({ userId, payload }); return 1; },
    pushNotificationToUser(userId, payload) { events.push({ userId, payload }); return 1; },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

let routePool = null;
const poolMod = require('../src/db/pool');
poolMod.getPool = () => routePool;

const conversations = require('../src/services/conversations');
const { conversationRoutes } = require('../src/routes/conversations');

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `conversation_mentions_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent
  return pool;
}

test('channel @mention candidates on the real schema', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  routePool = pool;

  let seq = 0;
  async function user(name) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`,
      [`${name}_${++seq}`]
    );
    return rows[0];
  }
  const alice = await user('alice');
  const bob = await user('bob');
  const carol = await user('carol');
  const dave = await user('dave');
  const erin = await user('erin');

  // Every signed-in user implicitly joins the channel on first read; sending
  // requires that membership row (lockInteractionMembership), so the test
  // mirrors the join the app does when each of them opens Messages.
  for (const u of [alice, bob, carol, dave, erin]) {
    await conversations.ensureChannelMemberships(pool, u);
  }
  const { rows: channelRows } = await pool.query(
    `SELECT id FROM conversations WHERE channel_key = 'general'`
  );
  const channel = channelRows[0].id;

  // Before anyone speaks: no candidates at all, exactly as today.
  assert.deepEqual(await conversations.mentionCandidates(pool, alice, channel), []);

  async function send(sender, conversationId, content) {
    const result = await conversations.sendMessage(pool, sender, conversationId, { content });
    assert.ok(result && !result.error, `send failed: ${JSON.stringify(result)}`);
    return result;
  }

  await send(bob, channel, 'hello from bob');
  await send(alice, channel, 'hello from alice');
  await send(bob, channel, 'bob again'); // distinct authors, bob is most recent
  await send(carol, channel, 'carol says hi');
  await send(alice, channel, 'alice again, and a system line comes next');
  await pool.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, msg_type)
      VALUES ($1, $2, 'system line', 'system')`,
    [channel, dave.id]
  );
  const deleted = await send(dave, channel, 'dave deletes this');
  await conversations.deleteMessage(pool, dave, channel, deleted.messageId);
  await pool.query(
    `INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)`,
    [alice.id, erin.id]
  );
  await send(erin, channel, 'erin is blocked by the viewer');

  await t.test('distinct recent authors, filtered, capped', async () => {
    const users = await conversations.mentionCandidates(pool, alice, channel);
    assert.deepEqual(users, [
      { id: alice.id, username: alice.username },
      { id: carol.id, username: carol.username },
      { id: bob.id, username: bob.username },
    ], 'most recent author first, each author once, no system/deleted/blocked sender');
    const forBob = await conversations.mentionCandidates(pool, bob, channel);
    assert.deepEqual(forBob.map((u) => u.id),
      [erin.id, alice.id, carol.id, bob.id],
      'the block filter is the viewer\'s, so bob still sees erin, newest message first');
  });

  await t.test('the HTTP contract: shape, 404s, and the cap', async () => {
    const app = express();
    app.use(express.json());
    let actor = alice;
    app.use((req, _res, next) => { req.user = { id: actor.id, username: actor.username }; next(); });
    app.use(conversationRoutes({}));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    t.after(() => server.close());
    const call = async (as, url) => {
      actor = as;
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    const ok = await call(alice, `/api/conversations/${channel}/mention-candidates`);
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.body), ['users']);
    assert.deepEqual(ok.body.users[0], { id: alice.id, username: alice.username });
    assert.ok(ok.body.users.length >= 3 && ok.body.users.length <= 500);

    // A non-member of a non-channel conversation gets the route's 404, and
    // so does an unknown id.
    const group = await conversations.createGroup(pool, alice, 'Crew', [bob.id, carol.id]);
    const outsiders = await call(dave, `/api/conversations/${group.conversationId}/mention-candidates`);
    assert.equal(outsiders.status, 404);
    const unknown = await call(alice, '/api/conversations/424242/mention-candidates');
    assert.equal(unknown.status, 404);

    // The cap: 501 authors, exactly 500 back, still recent-first.
    const many = [];
    for (let i = 0; i < 501; i += 1) many.push(await user('bulk'));
    // Production joins a user to the channel when they first open Messages;
    // the bulk authors joined the moment they first read it, which the test
    // states in one statement before any of them sends.
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, status)
        SELECT $1, x, 'member' FROM unnest($2::int[]) AS x
        ON CONFLICT DO NOTHING`,
      [channel, many.map((u) => u.id)]
    );
    for (const u of many) await send(u, channel, `bulk ${u.username}`);
    const capped = await call(alice, `/api/conversations/${channel}/mention-candidates`);
    assert.equal(capped.status, 200);
    assert.equal(capped.body.users.length, 500);
    assert.deepEqual(capped.body.users[0], { id: many[500].id, username: many[500].username },
      'the newest of the bulk authors leads');
  });

});
