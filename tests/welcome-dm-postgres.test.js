'use strict';

// Welcome messages (services/welcome-dm.js), executed against the FULL
// PostgreSQL schema.
//
// The feature is a trigger, a queue and a sweep, and all three are SQL the
// planner has to accept: the has_platform_access edge the trigger fires on,
// the row lock the sweep takes, the group every member is in from the
// start, and the message a new person can actually read. So they run here
// in a throwaway database built from src/db/schema.sql exactly as a boot
// applies it (twice, to prove the block is boot-idempotent).
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Realtime and push are process-wide singletons. Capture what the sweep
// hands them instead of opening sockets or scheduling badge syncs.
const events = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds, payload) {
      events.push({ memberIds: [...memberIds], payload });
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

const conversations = require('../src/services/conversations');
const welcomeDm = require('../src/services/welcome-dm');

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('welcome messages against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `welcome_dm_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, the welcome block included

  let seq = 0;
  async function user(prefix = 'person', { access = true, synthetic = false, placeholder = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic, needs_username_choice)
       VALUES ($1, 'x', $2, $3, $4) RETURNING id, username`,
      [`${prefix}_${++seq}`, access, synthetic, placeholder]
    );
    return rows[0];
  }
  const grant = (u) => pool.query('UPDATE users SET has_platform_access = TRUE WHERE id = $1', [u.id]);
  const revoke = (u) => pool.query('UPDATE users SET has_platform_access = FALSE WHERE id = $1', [u.id]);
  const queued = async (u) => (await pool.query(
    'SELECT * FROM welcome_dm_queue WHERE user_id = $1', [u.id]
  )).rows[0] || null;
  const setOn = (on) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('welcome_dm_enabled', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [on ? 'on' : 'off']
  );
  const groupsWith = async (u) => (await pool.query(
    `SELECT c.id, c.title, c.created_by FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
      WHERE cm.user_id = $1 AND c.kind = 'group'`,
    [u.id]
  )).rows;

  const evan = await user('evan');
  const lukas = await user('lukas');

  await t.test('schema: the queue is private and the trigger is installed once', async () => {
    const { rows: [table] } = await pool.query(
      `SELECT obj_description('welcome_dm_queue'::regclass, 'pg_class') AS comment`
    );
    assert.equal(table.comment, 'staging:private');
    const { rows: triggers } = await pool.query(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'users'::regclass AND tgname = 'users_enqueue_welcome_dm'`
    );
    assert.equal(triggers.length, 1, 'applying the schema twice left one trigger');
  });

  await t.test('while the switch is off, nobody is queued, and switching on does not reach back', async () => {
    const early = await user('early');
    const later = await user('later', { access: false });
    await grant(later);
    assert.equal(await queued(early), null);
    assert.equal(await queued(later), null);
    await setOn(true);
    assert.equal(await queued(early), null, 'people let in while it was off stay unqueued');
    await setOn(false);
  });

  await t.test('the trigger fires on the false → true edge only, once per person, never for a bot', async () => {
    await setOn(true);
    try {
      const signup = await user('signup'); // INSERT with access, like an activation code
      assert.equal((await queued(signup)).status, 'pending');

      const waitlisted = await user('waitlisted', { access: false });
      assert.equal(await queued(waitlisted), null, 'no access yet, no row');
      await grant(waitlisted); // an admin release
      assert.equal((await queued(waitlisted)).status, 'pending');

      await pool.query(`UPDATE welcome_dm_queue SET status = 'sent' WHERE user_id = $1`, [waitlisted.id]);
      await revoke(waitlisted);
      await grant(waitlisted);
      assert.equal((await queued(waitlisted)).status, 'sent', 'let in again is not welcomed again');

      const bot = await user('bot', { synthetic: true });
      assert.equal(await queued(bot), null);
    } finally {
      await setOn(false);
      await pool.query('DELETE FROM welcome_dm_queue');
    }
  });

  await t.test('settings: handles resolve to ids in order, and a typo is refused', async () => {
    const refused = await welcomeDm.writeSettings(pool, { members: ['@evan_1', 'nobody_here'] }, evan.id);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /@nobody_here/);

    const empty = await welcomeDm.writeSettings(pool, { enabled: true, members: [] }, evan.id);
    assert.equal(empty.ok, false, 'switching on with nobody to send it is refused');
    assert.match(empty.error, /at least one person/);

    const saved = await welcomeDm.writeSettings(pool, {
      members: ['@EVAN_1', 'lukas_2'], title: 'Welcome, {username}', message: 'Hey @{username}!', enabled: true,
    }, evan.id);
    assert.deepEqual(saved, { ok: true });
    const settings = await welcomeDm.readSettings(pool);
    assert.deepEqual(settings.memberIds, [evan.id, lukas.id], 'first listed sends');
    assert.equal(settings.enabled, true);
    assert.equal(settings.updatedBy, 'evan_1');

    const payload = await welcomeDm.adminPayload(pool);
    assert.deepEqual(payload.members.map((m) => m.username), ['evan_1', 'lukas_2']);
    assert.equal(payload.title, 'Welcome, {username}');
    await setOn(false);
  });

  await t.test('a new person gets one group with the staff, all members, and a message they can read', async () => {
    await setOn(true);
    const alice = await user('alice');
    events.length = 0;
    const result = await welcomeDm.sweep(pool);
    assert.equal(result.sent, 1);

    const row = await queued(alice);
    assert.equal(row.status, 'sent');
    assert.ok(row.conversation_id);
    const groups = await groupsWith(alice);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].title, `Welcome, ${alice.username}`);
    assert.equal(groups[0].created_by, evan.id);

    const { rows: members } = await pool.query(
      `SELECT user_id, role, status FROM conversation_members
        WHERE conversation_id = $1 ORDER BY user_id`,
      [row.conversation_id]
    );
    assert.deepEqual(members, [
      { user_id: evan.id, role: 'owner', status: 'member' },
      { user_id: lukas.id, role: 'member', status: 'member' },
      { user_id: alice.id, role: 'member', status: 'member' },
    ], 'nobody has an invitation to accept');

    const thread = await conversations.listMessages(pool, { id: alice.id }, row.conversation_id, {});
    const messages = thread.messages || thread;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, `Hey @${alice.username}!`);

    const { rows: bells } = await pool.query(
      `SELECT user_id, kind FROM notifications WHERE conversation_id = $1 ORDER BY user_id`,
      [row.conversation_id]
    );
    assert.deepEqual(bells, [
      { user_id: lukas.id, kind: 'conversation_message' },
      { user_id: alice.id, kind: 'conversation_mention' },
    ], 'the sender is not notified of their own message');

    const types = events.filter((e) => e.payload?.conversationId === row.conversation_id).map((e) => e.payload.type);
    assert.deepEqual(types, ['conversation_membership_changed', 'conversation_message_created']);

    const again = await welcomeDm.sweep(pool);
    assert.equal(again.sent, 0, 'a second sweep has nothing to do');
    assert.equal((await groupsWith(alice)).length, 1);
    await setOn(false);
  });

  await t.test('somebody still choosing a username waits until they have one', async () => {
    await setOn(true);
    const fresh = await user('member', { placeholder: true });
    await welcomeDm.sweep(pool);
    assert.equal((await queued(fresh)).status, 'pending');
    assert.equal((await groupsWith(fresh)).length, 0);
    await pool.query(
      `UPDATE users SET username = 'chosen_name', needs_username_choice = FALSE WHERE id = $1`, [fresh.id]
    );
    await welcomeDm.sweep(pool);
    assert.equal((await queued(fresh)).status, 'sent');
    assert.equal((await groupsWith(fresh))[0].title, 'Welcome, chosen_name');
    await setOn(false);
  });

  await t.test('staff who cannot take part are left out, and with nobody left the row is skipped', async () => {
    await setOn(true);
    try {
      await revoke(evan);
      const bob = await user('bob');
      await welcomeDm.sweep(pool);
      const row = await queued(bob);
      assert.equal(row.status, 'sent');
      const { rows: [group] } = await pool.query(
        'SELECT created_by FROM conversations WHERE id = $1', [row.conversation_id]
      );
      assert.equal(group.created_by, lukas.id, 'the next person in the list sends instead');

      const carol = await user('carol');
      await pool.query(
        'INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [lukas.id, carol.id]
      );
      await welcomeDm.sweep(pool);
      const skipped = await queued(carol);
      assert.equal(skipped.status, 'skipped');
      assert.equal(skipped.detail, 'no_one_to_send');
      assert.equal((await groupsWith(carol)).length, 0);
    } finally {
      // Off first: letting evan back in while it is on would welcome evan.
      await setOn(false);
      await pool.query('UPDATE users SET has_platform_access = TRUE WHERE id = $1', [evan.id]);
    }
  });

  await t.test('a send that fails after the group opened retries into the same group', async () => {
    await setOn(true);
    const dave = await user('dave');
    const original = conversations.sendMessage;
    conversations.sendMessage = async () => { throw new Error('connection reset'); };
    try {
      const first = await welcomeDm.sweep(pool);
      assert.equal(first.retry, 1);
    } finally {
      conversations.sendMessage = original;
    }
    const pending = await queued(dave);
    assert.equal(pending.status, 'pending');
    assert.ok(pending.conversation_id, 'the group is recorded before the message');
    assert.equal(pending.detail, 'connection reset');

    await welcomeDm.sweep(pool);
    const sent = await queued(dave);
    assert.equal(sent.status, 'sent');
    assert.equal(sent.conversation_id, pending.conversation_id);
    assert.equal((await groupsWith(dave)).length, 1, 'no second group');
    const { rows: [{ n }] } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1', [sent.conversation_id]
    );
    assert.equal(n, 1);
    await setOn(false);
  });

  await t.test('a row that waited too long is let go instead of greeting somebody weeks late', async () => {
    await setOn(true);
    const erin = await user('erin');
    await pool.query(
      `UPDATE welcome_dm_queue SET enqueued_at = NOW() - make_interval(days => $2) WHERE user_id = $1`,
      [erin.id, welcomeDm.MAX_AGE_DAYS + 1]
    );
    await welcomeDm.sweep(pool);
    const row = await queued(erin);
    assert.equal(row.status, 'skipped');
    assert.equal(row.detail, 'expired');
    await setOn(false);
  });

  await t.test('the admin routes read for any admin and write for full admins only', async () => {
    const poolMod = require('../src/db/pool');
    const prior = poolMod.getPool;
    poolMod.getPool = () => pool;
    const { adminRoutes } = require('../src/routes/admin');
    let viewer = { id: evan.id, username: 'evan_1', isAdmin: true, canAdminWrite: true };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = viewer; next(); });
    app.use(adminRoutes({ jwtSecret: 'test' }));
    poolMod.getPool = prior;
    const { server, base } = await listen(app);
    const call = async (method, body) => {
      const res = await fetch(`${base}/api/admin/welcome-dm`, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    try {
      let res = await call('GET');
      assert.equal(res.status, 200);
      assert.equal(res.body.enabled, false);
      assert.ok(res.body.recent.some((r) => r.username.startsWith('alice_') && r.status === 'sent'));

      res = await call('PUT', { enabled: true, members: ['lukas_2'] });
      assert.equal(res.status, 200);
      assert.equal(res.body.enabled, true);
      assert.deepEqual(res.body.members.map((m) => m.username), ['lukas_2']);

      res = await call('PUT', { title: '' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /title/);

      viewer = { ...viewer, canAdminWrite: false, adminReadonly: true };
      assert.equal((await call('GET')).status, 200);
      res = await call('PUT', { enabled: false });
      assert.equal(res.status, 403);
      assert.equal((await welcomeDm.readSettings(pool)).enabled, true, 'nothing was written');
    } finally {
      server.close();
      await setOn(false);
    }
  });
});
