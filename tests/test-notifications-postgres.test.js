'use strict';

// send_test_notifications (services/test-notifications.js) against the full
// PostgreSQL schema: one notification of every kind to a test account, each
// visible in its bell (the same visibility read the list and the live frame
// use), each push kind queued for its phone by the real trigger, the live
// frame sent for each, and the refusals. The catalogue itself is checked
// without a database: every kind the push registry knows is in it, and the
// bell has words for every kind in it.
//
// Run with: node --test tests/test-notifications-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The live frame, captured: hydrateAndPush sends one per row.
const frames = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true, paths: [],
  exports: { pushNotificationToUser: (userId, frame) => { frames.push({ userId, frame }); } },
};

const testNotifications = require('../src/services/test-notifications');

test('the catalogue: every kind the push registry knows, and words in the bell for each', () => {
  const schema = read('src/db/schema.sql');
  // Every (kind, category, default) the registry is seeded with, wherever
  // in the schema a later change added one.
  const categories = 'direct_interactions|invitations|shared_work|developer_sessions|proposal_alerts|lightweight_activity|messages|app_alerts|builds|invite_activity';
  const seeded = new Set([...schema.matchAll(new RegExp(`\\('([a-z_]+)',\\s*'(?:${categories})',\\s*(?:TRUE|FALSE)\\)`, 'g'))].map((m) => m[1]));
  assert.ok(seeded.size >= 40, `read the registry (${seeded.size})`);
  for (const kind of seeded) assert.ok(testNotifications.KIND_NAMES.includes(kind), `${kind} is sent`);
  // Each kind once, and the bell's renderer has a branch for it (a kind it
  // does not know would draw as a bare "posted" row).
  assert.equal(new Set(testNotifications.KIND_NAMES).size, testNotifications.KIND_NAMES.length);
  const bell = read('frontend/src/features/notifications/notifications.js');
  for (const kind of testNotifications.KIND_NAMES) {
    assert.ok(bell.includes(`'${kind}'`), `the bell knows ${kind}`);
  }
  assert.deepEqual(testNotifications.parseKinds(['mention', 'mention']), ['mention']);
});

test('test notifications against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'test_notifications_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = read('src/db/schema.sql');
  await pool.query(schema);
  await pool.query(schema);

  const user = async (username, extra = '') => (await pool.query(
    `INSERT INTO users (username, password${extra ? ', ' + extra.split('=')[0] : ''})
     VALUES ($1, 'x'${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id, username`,
    [username]
  )).rows[0];
  const owner = await user('notif_admin', 'is_admin=TRUE');
  const tester = await user('notif_tester', 'test_account_created_at=NOW()');
  const bare = await user('notif_bare', 'test_account_created_at=NOW()');
  const person = await user('notif_person');
  await user('homeroom_bot');
  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, created_by, status) VALUES ('Plant shelf', 'plant-shelf-a1b2c3', $1, 'running') RETURNING id, slug",
    [tester.id]
  );
  // What its discussion already holds: the tester's own message, then a
  // newer one of somebody else's.
  const said = async (userId, content) => (await pool.query(
    'INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, $3) RETURNING id', [app.id, userId, content]
  )).rows[0].id;
  const own = await said(tester.id, 'Water the basil on Friday');
  const newest = await said(person.id, 'Can we add the fern too?');
  // A phone signed in as the tester, and sending on. Its native sign-in
  // credential is a chain of rows of its own that this test is not about, so
  // the throwaway database lets the registration stand without one.
  await pool.query('ALTER TABLE mobile_push_registrations DROP CONSTRAINT IF EXISTS mobile_push_registrations_native_credential_user_fk');
  await pool.query(
    `INSERT INTO mobile_push_deployment_state (environment, firebase_project_id, send_enabled, send_not_before)
     VALUES ('production', 'social-prod', TRUE, NOW() - INTERVAL '1 hour')
     ON CONFLICT (environment) DO UPDATE SET send_enabled = TRUE, send_not_before = EXCLUDED.send_not_before`
  );
  await pool.query(
    `INSERT INTO mobile_push_registrations
       (user_id, native_session_credential_reference, environment, installation_id,
        registration_hash, registration_enc, platform, permission_status, session_expires_at)
     VALUES ($1, $2, 'production', '123e4567-e89b-12d3-a456-426614174000', $3, 'enc:opaque', 'ios', 'authorized', NOW() + INTERVAL '1 hour')`,
    [tester.id, `nsc_${String(tester.id).padStart(43, '0')}`, crypto.randomBytes(32).toString('hex')]
  );
  const send = (body) => testNotifications.send(pool, body, { actorId: owner.id });

  await t.test('every kind, in the bell and live, and every push kind queued for the phone', async () => {
    const out = await send({ userId: tester.id });
    const parked = testNotifications.KIND_NAMES.filter((k) => k === 'kudos');
    assert.deepEqual(out.skipped, parked.map((kind) => ({ kind, reason: 'parked' })));
    assert.deepEqual(out.sent.map((s) => s.kind), testNotifications.KIND_NAMES.filter((k) => !parked.includes(k)));
    assert.equal(out.project, app.slug);
    assert.equal(out.registrations, 1);
    for (const s of out.sent) assert.equal(s.listed, true, `${s.kind} is in the bell`);
    // The trigger queued one push for each kind with a push category, and
    // none for the bell-only kinds (every category was turned on first).
    const { rows: policy } = await pool.query('SELECT kind FROM mobile_push_kind_categories');
    const pushes = new Set(policy.map((r) => r.kind));
    for (const s of out.sent) assert.equal(s.pushes, pushes.has(s.kind) ? 1 : 0, `${s.kind} pushes`);
    assert.ok(out.sent.find((s) => s.kind === 'reaction').pushes === 1, 'reactions too, their category turned on');
    const { rows: prefs } = await pool.query('SELECT category FROM mobile_push_preferences WHERE user_id = $1 AND enabled', [tester.id]);
    assert.equal(prefs.length, testNotifications.PUSH_CATEGORIES.length);
    // One live frame per row, to the tester.
    const live = frames.filter((f) => f.userId === tester.id && f.frame.type === 'notification_new');
    assert.deepEqual(live.map((f) => f.frame.notification.id).sort(), out.sent.map((s) => s.notificationId).sort());
    // What the rows point at: the tester's project and the newest message in
    // its discussion (a reaction the tester's own), written by nobody: a
    // channel is what people said. The admin is who did each thing.
    const row = async (kind) => (await pool.query(
      'SELECT app_id, source_user_id, chat_message_id FROM notifications WHERE id = $1',
      [out.sent.find((s) => s.kind === kind).notificationId]
    )).rows[0];
    assert.deepEqual(await row('mention'), { app_id: app.id, source_user_id: owner.id, chat_message_id: newest });
    assert.equal((await row('reaction')).chat_message_id, own, 'a reaction is to a message of the tester\'s');
    assert.equal(out.projectMessage, true);
    const { rows: [{ n: channel }] } = await pool.query('SELECT COUNT(*)::int AS n FROM chat_messages WHERE app_id = $1', [app.id]);
    assert.equal(channel, 2, 'nothing was written into the project\'s discussion');
    const { rows: [conversation] } = await pool.query(
      `SELECT c.title, c.created_by, m.role, m.status FROM conversations c
         JOIN conversation_members m ON m.conversation_id = c.id WHERE c.id = $1`, [out.conversationId]
    );
    assert.deepEqual(conversation, { title: 'Notification test', created_by: tester.id, role: 'owner', status: 'member' });
    const { rows: [{ n: members }] } = await pool.query('SELECT COUNT(*)::int AS n FROM conversation_members WHERE conversation_id = $1', [out.conversationId]);
    assert.equal(members, 1, 'nobody else\'s Messages list it');
    const { rows: [build] } = await pool.query(
      "SELECT u.username FROM notifications n JOIN users u ON u.id = n.source_user_id WHERE n.id = $1",
      [out.sent.find((s) => s.kind === 'build_live').notificationId]
    );
    assert.equal(build.username, 'homeroom_bot');
  });

  await t.test('the kinds named, the conversation reused, and settings left alone when asked', async () => {
    const first = await pool.query("SELECT id FROM conversations WHERE title = 'Notification test'");
    await pool.query('UPDATE mobile_push_preferences SET enabled = FALSE WHERE user_id = $1 AND category = $2', [tester.id, 'messages']);
    const out = await send({ userId: tester.id, kinds: ['conversation_message', 'test_alert'], allPushCategories: false });
    assert.deepEqual(out.sent.map((s) => s.kind), ['conversation_message', 'test_alert']);
    assert.equal(out.conversationId, first.rows[0].id);
    assert.equal(out.sent[0].pushes, 0, 'its category stayed off');
    assert.equal(out.pushCategoriesEnabled, false);
  });

  await t.test('an account with no project gets everything that needs none', async () => {
    const out = await send({ userId: bare.id, kinds: ['mention', 'friend_request', 'conversation_invite'] });
    assert.deepEqual(out.sent.map((s) => s.kind), ['friend_request', 'conversation_invite']);
    assert.deepEqual(out.skipped, [{ kind: 'mention', reason: 'needs_project' }]);
    assert.equal(out.project, null);
    assert.equal(out.registrations, 0);
  });

  await t.test('only a test account, only known kinds, and only an admin', async () => {
    await assert.rejects(send({ userId: person.id }), { status: 404, code: 'not_test_account' });
    await assert.rejects(send({ userId: 999999 }), { status: 404, code: 'not_test_account' });
    await assert.rejects(send({ userId: tester.id, kinds: ['mention', 'nope'] }), { status: 400, code: 'unknown_kind' });
    await assert.rejects(send({ userId: tester.id, kinds: [] }), { status: 400, code: 'invalid_request' });
    await assert.rejects(send({ userId: tester.id, allPushCategories: 'yes' }), { status: 400, code: 'invalid_request' });
    await assert.rejects(testNotifications.send(pool, { userId: tester.id }, {}), { status: 403 });
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1', [person.id]);
    assert.equal(n, 0, 'nothing reached a real account');
  });
});
