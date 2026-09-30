'use strict';

// #3361 — `@` in a channel offered nobody: serializeConversation counts a
// channel's roster instead of loading it, so the composer's list, read off
// `active.members`, was always empty there. The composer now asks
// GET /api/conversations/:id/mention-candidates, and the project channel's
// own list (GET /api/apps/:slug/mention-suggestions) gains the community's
// members. Both list PEOPLE, so what this file pins first is who may ask and
// what they are told, on the real schema and through the real routes:
//
//   - the conversation route answers exactly when the messages route does
//     (same 404 for a group you are not in, an invitation you have not
//     accepted, somebody else's DM, a DM across a block, and a room that does
//     not exist);
//   - it offers accepted members only, never the viewer, never a block in
//     either direction, prefix-matched with LIKE metacharacters inert, capped;
//   - its projection is id, username, avatarUrl and the viewer's own friend
//     flag, nothing else off the users row;
//   - the project list adds community members but stays collab-gated, and
//     does not list the platform's own (everybody) community.
//
// Skips when no PostgreSQL is reachable, like the repository's other
// postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
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
const { chatRoutes } = require('../src/routes/chat');

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
  const name = `mention_candidates_${crypto.randomBytes(6).toString('hex')}`;
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
  return pool;
}

test('mention candidates: read-gated, bounded, public fields only', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  routePool = pool;

  async function user(name, { email = null } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, email, has_platform_access)
       VALUES ($1, 'x', $2, TRUE) RETURNING id, username`,
      [name, email]
    );
    return rows[0];
  }
  const alice = await user('alice', { email: 'alice@example.test' });
  const bob = await user('bob', { email: 'bob@example.test' });
  const bea = await user('bea');
  const carol = await user('carol');
  const dave = await user('dave');
  const eve = await user('eve');
  const mallory = await user('mallory');
  const b_x = await user('b_x');
  const bzz = await user('bzz');
  // Legacy/imported handles carry punctuation; mentionsUsername matches them.
  const annMarie = await user('ann-marie');
  const ann = await user('ann');

  const general = (await pool.query(
    `SELECT id FROM conversations WHERE kind = 'channel' AND channel_key = 'general'`
  )).rows[0].id;
  for (const person of [alice, bob, bea, carol, dave, eve, mallory, b_x, bzz, annMarie, ann]) {
    await conversations.ensureChannelMemberships(pool, person);
  }
  const say = async (who, conversationId, content) => {
    const result = await conversations.sendMessage(pool, who, conversationId, { content });
    assert.ok(result && !result.error, `send failed: ${JSON.stringify(result)}`);
  };
  await say(bea, general, 'first');
  await say(bob, general, 'second');

  // A private group alice is not in, one she is only invited to, and a DM
  // between two other people.
  const secret = await conversations.createGroup(pool, carol, 'secret', [dave.id]);
  assert.ok(await conversations.respond(pool, dave, secret.conversationId, 'accept'));
  const invite = await conversations.createGroup(pool, carol, 'invite', [alice.id, dave.id]);
  assert.ok(await conversations.respond(pool, dave, invite.conversationId, 'accept'));
  const dm = await conversations.createDirect(pool, carol, dave.id);
  assert.ok(await conversations.respond(pool, dave, dm.conversationId, 'accept'));

  const app = express();
  app.use(express.json());
  let actor = alice;
  app.use((req, _res, next) => { req.user = { id: actor.id, username: actor.username, isAdmin: false }; next(); });
  app.use(conversationRoutes({}));
  app.use(chatRoutes({}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const call = async (as, url) => {
    actor = as;
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  const candidates = (as, id, query = '') => call(as, `/api/conversations/${id}/mention-candidates${query}`);
  const names = (res) => res.body.users.map((u) => u.username);

  await t.test('a room you cannot read answers exactly as its messages do', async () => {
    const missing = await candidates(alice, 999999);
    assert.equal(missing.status, 404);
    for (const id of [secret.conversationId, invite.conversationId, dm.conversationId]) {
      const messages = await call(alice, `/api/conversations/${id}/messages`);
      const people = await candidates(alice, id, '?q=d');
      assert.equal(messages.status, 404, `messages of ${id} are closed to alice`);
      assert.equal(people.status, 404, `and so are its people (${id})`);
      assert.deepEqual(people.body, missing.body, 'indistinguishable from a room that does not exist');
    }
    assert.equal((await candidates(alice, 'abc')).status, 404, 'a malformed id is a 404 too');
    // The members themselves are answered, with each other.
    const inside = await candidates(carol, secret.conversationId);
    assert.equal(inside.status, 200);
    assert.deepEqual(names(inside), ['dave']);
    // The invitee alice is not offered in a room she has not accepted.
    assert.deepEqual(names(await candidates(carol, invite.conversationId)), ['dave']);
  });

  await t.test('a DM across a block is closed to both sides', async () => {
    await conversations.setBlock(pool, dave.id, carol.id, true);
    assert.equal((await call(carol, `/api/conversations/${dm.conversationId}/messages`)).status, 404);
    assert.equal((await candidates(carol, dm.conversationId)).status, 404);
    assert.equal((await candidates(dave, dm.conversationId)).status, 404);
    await conversations.setBlock(pool, dave.id, carol.id, false);
  });

  await t.test('#general: members by prefix, recent speakers first, never you', async () => {
    const res = await candidates(alice, general, '?q=b');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    // bob spoke last, bea before him, then the silent ones A to Z.
    assert.deepEqual(names(res), ['bob', 'bea', 'b_x', 'bzz']);
    assert.ok(!names(await candidates(alice, general, '?q=a')).includes('alice'), 'not the viewer');
    assert.deepEqual(names(await candidates(alice, general, '?q=%40BO')), ['bob'], 'case-insensitive, @ tolerated');
    // An empty prefix is the room's recent speakers, still capped.
    const empty = await candidates(alice, general);
    assert.deepEqual(names(empty).slice(0, 2), ['bob', 'bea']);
    assert.ok(empty.body.users.length <= 8, 'default cap');
  });

  await t.test('LIKE metacharacters are literal and the limit is bounded', async () => {
    assert.deepEqual(names(await candidates(alice, general, '?q=b_')), ['b_x'], '_ is not a wildcard');
    assert.deepEqual(names(await candidates(alice, general, '?q=%25')), [], '% matches nobody');
    assert.deepEqual(names(await candidates(alice, general, '?q=b%25x')), []);
    assert.equal((await candidates(alice, general, '?limit=1')).body.users.length, 1);
    for (let i = 0; i < 30; i += 1) {
      const extra = await user(`zz_${i}`);
      await conversations.ensureChannelMemberships(pool, extra);
    }
    assert.equal((await candidates(alice, general, '?q=zz&limit=1000')).body.users.length, 25, 'hard cap');
  });

  await t.test('a legacy handle with a hyphen is found past the hyphen', async () => {
    assert.deepEqual(names(await candidates(alice, general, '?q=ann')), ['ann', 'ann-marie']);
    assert.deepEqual(names(await candidates(alice, general, '?q=ann-')), ['ann-marie'], 'the hyphen narrows, not empties');
    assert.deepEqual(names(await candidates(alice, general, '?q=%40Ann-M')), ['ann-marie']);
    // Text no @token can hold matches nobody; a long prefix is clipped, not refused.
    assert.deepEqual(names(await candidates(alice, general, '?q=ann%20marie')), []);
    assert.deepEqual(names(await candidates(alice, general, '?q=a%40b')), []);
    assert.deepEqual(names(await candidates(alice, general, '?q=a&q=b')), [], 'a repeated q is not a string');
    assert.equal((await candidates(alice, general, `?q=${'x'.repeat(300)}`)).status, 200);
  });

  await t.test('blocks hide people in both directions', async () => {
    await conversations.setBlock(pool, alice.id, bob.id, true);
    await conversations.setBlock(pool, bea.id, alice.id, true);
    const res = names(await candidates(alice, general, '?q=b'));
    assert.ok(!res.includes('bob'), 'someone alice blocked');
    assert.ok(!res.includes('bea'), 'someone who blocked alice');
    await conversations.setBlock(pool, alice.id, bob.id, false);
    await conversations.setBlock(pool, bea.id, alice.id, false);
  });

  await t.test('the projection is public identity only', async () => {
    const res = await candidates(alice, general, '?q=bo');
    for (const person of res.body.users) {
      for (const key of Object.keys(person)) {
        assert.ok(['id', 'username', 'avatarUrl', 'friend'].includes(key), `unexpected field ${key}`);
      }
    }
    assert.ok(!JSON.stringify(res.body).includes('@example.test'), 'no email');
  });

  await t.test('the project channel adds its community, still collab-gated', async () => {
    const insertApp = async (slug, { selfHosted = false, view = 'public', collab = 'public' } = {}) => {
      await pool.query(
        `INSERT INTO apps (name, slug, created_by, self_hosted, view_visibility, collab_visibility)
         VALUES ($1, $1, $2, $3, $4, $5)`,
        [slug, carol.id, selfHosted, view, collab]
      );
      // The community is minted by an AFTER INSERT trigger, so read it back.
      return (await pool.query('SELECT id, community_id FROM apps WHERE slug = $1', [slug])).rows[0];
    };
    const join = (a, who) => pool.query(
      'INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [a.community_id, who.id]
    );
    const open = await insertApp('open-project');
    await join(open, eve);
    const listed = await call(alice, '/api/apps/open-project/mention-suggestions');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.users.some((u) => u.username === 'eve'), 'a member who has not spoken yet');
    for (const person of listed.body.users) {
      assert.deepEqual(Object.keys(person).filter((k) => k !== 'friend'), ['username']);
    }

    const closed = await insertApp('closed-project', { view: 'private', collab: 'private' });
    await join(closed, mallory);
    const refused = await call(alice, '/api/apps/closed-project/mention-suggestions');
    assert.equal(refused.status, 404, 'a private community is not listed to an outsider');
    assert.ok(!JSON.stringify(refused.body).includes('mallory'));
    const probed = await call(alice, '/api/apps/closed-project/mention-suggestions?q=mal');
    assert.equal(probed.status, 404, 'a prefix does not get past the gate either');
    assert.deepEqual(probed.body, refused.body);
    assert.equal((await call(alice, '/api/apps/closed-project/mention-suggestions?q=a%20b')).status, 404,
      'an invalid prefix is refused only after the gate, so it says nothing either');

    // ?q= narrows on the server, with the same prefix rules and a 25 cap, so a
    // silent member of a community past the 500-row cap is still found.
    const crowd = await insertApp('crowd-project');
    await pool.query(
      `WITH made AS (
         INSERT INTO users (username, password, has_platform_access)
         SELECT 'crowd_' || lpad(g::text, 4, '0'), 'x', TRUE FROM generate_series(1, 520) g
         RETURNING id
       )
       INSERT INTO community_members (community_id, user_id) SELECT $1, id FROM made`,
      [crowd.community_id]
    );
    // Sorts after every crowd_ name, and has spoken nowhere: last in line.
    const zoe = await user('zoe-new');
    await join(crowd, zoe);
    const whole = await call(alice, '/api/apps/crowd-project/mention-suggestions');
    assert.equal(whole.body.users.length, 500);
    assert.ok(!whole.body.users.some((u) => u.username === 'zoe-new'), 'lost to the cap without a prefix');
    const found = await call(alice, '/api/apps/crowd-project/mention-suggestions?q=zoe-');
    assert.deepEqual(found.body.users.map((u) => u.username), ['zoe-new']);
    assert.equal((await call(alice, '/api/apps/crowd-project/mention-suggestions?q=crowd_')).body.users.length, 25);
    assert.deepEqual((await call(alice, '/api/apps/crowd-project/mention-suggestions?q=%25')).body.users, []);
    assert.deepEqual((await call(alice, '/api/apps/crowd-project/mention-suggestions?q=a%20b')).body.users, []);

    const platform = await insertApp('platform-self', { selfHosted: true });
    await join(platform, mallory);
    const self = await call(alice, '/api/apps/platform-self/mention-suggestions');
    assert.equal(self.status, 200);
    assert.ok(!self.body.users.some((u) => u.username === 'mallory'),
      'the platform community is everybody, so it is not listed here');
  });
});
