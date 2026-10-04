'use strict';

// WP-E against the full schema (src/services/invite-activity.js): what an
// invite link brings back to its maker. Opens are counted and never named,
// a join and a first hello name the person who came by the link, each kind
// rings once a day per project and folds the rest into a count, and none of
// it reaches anybody but the link's maker.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/invite-activity-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const activity = require('../src/services/invite-activity');

test('invite activity against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `invite_activity_${crypto.randomBytes(6).toString('hex')}`;
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

  async function user(username) {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
      [username]);
    return u;
  }
  const maya = await user('maya');
  const sam = await user('sam');
  const alex = await user('alex');
  const old = await user('old_member');

  let n = 0;
  async function project() {
    n += 1;
    const { rows: [community] } = await pool.query('INSERT INTO communities DEFAULT VALUES RETURNING id');
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, community_id) VALUES ($1, $2, 'running', $3, $4)
       RETURNING id, community_id, name, slug`,
      [`Run Club ${n}`, `run-club-${n}`, maya.id, community.id]);
    await pool.query(
      `INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [app.community_id, maya.id]);
    const token = crypto.randomBytes(16).toString('base64url').slice(0, 22);
    const { rows: [invite] } = await pool.query(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days') RETURNING id, token`,
      [token, app.community_id, app.id, maya.id]);
    return { app, invite };
  }
  async function joinBy(invite, app, who) {
    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, applied_at) VALUES ($1, $2, 'joined', NOW())`,
      [invite.id, who.id]);
    await pool.query(
      `INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [app.community_id, who.id]);
  }
  async function say(app, who, content = 'hi all') {
    const { rows: [m] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, $3) RETURNING id`,
      [app.id, who.id, content]);
    return m.id;
  }
  const rowsOf = async (userId, kind) => (await pool.query(
    `SELECT id, app_id, source_user_id, chat_message_id, detail, read_at FROM notifications
      WHERE user_id = $1 AND kind = $2 ORDER BY id`, [userId, kind])).rows;

  await t.test('schema: the two push categories and their kinds', async () => {
    const { rows } = await pool.query(
      `SELECT kind, category, default_enabled FROM mobile_push_kind_categories
        WHERE category IN ('builds', 'invite_activity') ORDER BY kind`);
    assert.deepEqual(rows.map((r) => `${r.kind}:${r.category}:${r.default_enabled}`), [
      'build_live:builds:true', 'build_needs_you:builds:true', 'build_ready:builds:true', 'build_stopped:builds:true',
      'first_message:invite_activity:true', 'invite_opened:invite_activity:true', 'member_joined:invite_activity:true',
    ]);
    // A person may switch either off.
    await pool.query(`INSERT INTO mobile_push_preferences (user_id, category, enabled) VALUES ($1, 'builds', FALSE), ($1, 'invite_activity', FALSE)`, [alex.id]);
    const { rows: cols } = await pool.query(
      `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'activity_email'`);
    assert.equal(cols[0].is_nullable, 'NO');
    assert.match(cols[0].column_default, /true/);
  });

  await t.test('a join names who came by the link, to its maker only, and the day folds into one row', async () => {
    const { app, invite } = await project();
    await joinBy(invite, app, sam);
    const first = await activity.noteJoined(pool, { inviteId: invite.id, user: { id: sam.id } });
    assert.equal(first.fresh, true);
    await joinBy(invite, app, alex);
    const second = await activity.noteJoined(pool, { inviteId: invite.id, user: { id: alex.id } });
    assert.equal(second.fresh, false, 'folded, not a second ring');
    const rows = (await rowsOf(maya.id, 'member_joined')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, '2');
    assert.equal(rows[0].source_user_id, alex.id, 'the newest person leads');
    assert.equal((await rowsOf(sam.id, 'member_joined')).length, 0);
    // The maker following their own link is not news.
    assert.equal(await activity.noteJoined(pool, { inviteId: invite.id, user: { id: maya.id } }), null);
  });

  await t.test('only the first of the day rings: one push delivery queued, then none', async () => {
    const { app, invite } = await project();
    await pool.query(
      `INSERT INTO mobile_push_deployment_state (environment, firebase_project_id, send_enabled, send_not_before)
       VALUES ('production', 'social-prod', TRUE, NOW() - INTERVAL '1 hour')
       ON CONFLICT (environment) DO UPDATE SET send_enabled = TRUE, send_not_before = EXCLUDED.send_not_before`);
    // A phone needs a native session behind it; that chain is not what this
    // checks, so the scratch database drops the link to it.
    await pool.query('ALTER TABLE mobile_push_registrations DROP CONSTRAINT IF EXISTS mobile_push_registrations_native_credential_user_fk');
    await pool.query(
      `INSERT INTO mobile_push_registrations
         (user_id, native_session_credential_reference, environment, installation_id,
          registration_hash, registration_enc, platform, permission_status, session_expires_at)
       VALUES ($1, $2, 'production', $3, $4, 'enc:opaque', 'ios', 'authorized', NOW() + INTERVAL '30 days')`,
      [maya.id, `nsc_${String(maya.id).padStart(43, '0')}`, crypto.randomUUID(), crypto.randomBytes(32).toString('hex')]);
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM mobile_push_deliveries')).rows[0].n;
    await activity.noteOpened(pool, { token: invite.token });
    await activity.noteOpened(pool, { token: invite.token });
    await activity.noteOpened(pool, { token: invite.token });
    const rows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, '3');
    assert.equal(rows[0].source_user_id, null, 'an open is never a name');
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM mobile_push_deliveries')).rows[0].n;
    assert.equal(after - before, 1, 'one push for three opens');
  });

  await t.test('an open by the maker, a member or a dead link counts nothing', async () => {
    const { app, invite } = await project();
    await joinBy(invite, app, old);
    assert.equal(await activity.noteOpened(pool, { token: invite.token, viewerId: maya.id }), null);
    assert.equal(await activity.noteOpened(pool, { token: invite.token, viewerId: old.id }), null);
    await pool.query('UPDATE community_invites SET revoked_at = NOW() WHERE id = $1', [invite.id]);
    assert.equal(await activity.noteOpened(pool, { token: invite.token }), null);
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0);
  });

  await t.test('a first message from somebody the link brought is a hello; the second is not', async () => {
    const { app, invite } = await project();
    await joinBy(invite, app, sam);
    const hi = await say(app, sam, 'hello from sam');
    const first = await activity.noteFirstMessage(pool, { appId: app.id, userId: sam.id, chatMessageId: hi });
    assert.equal(first.fresh, true);
    const again = await say(app, sam, 'and again');
    assert.equal(await activity.noteFirstMessage(pool, { appId: app.id, userId: sam.id, chatMessageId: again }), null);
    const rows = (await rowsOf(maya.id, 'first_message')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].chat_message_id, hi);
    assert.equal(rows[0].source_user_id, sam.id);
  });

  await t.test('no hello from somebody who did not come by a link, or long after joining', async () => {
    const { app, invite } = await project();
    // In the community, but not by this link.
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, alex.id]);
    const m1 = await say(app, alex);
    assert.equal(await activity.noteFirstMessage(pool, { appId: app.id, userId: alex.id, chatMessageId: m1 }), null);
    // By the link, but two months ago.
    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, applied_at, created_at)
       VALUES ($1, $2, 'joined', NOW() - INTERVAL '60 days', NOW() - INTERVAL '60 days')`,
      [invite.id, old.id]);
    const m2 = await say(app, old);
    assert.equal(await activity.noteFirstMessage(pool, { appId: app.id, userId: old.id, chatMessageId: m2 }), null);
    assert.equal((await rowsOf(maya.id, 'first_message')).filter((r) => r.app_id === app.id).length, 0);
  });

  await t.test('a row from yesterday is not folded into: today rings again', async () => {
    const { app, invite } = await project();
    await activity.noteOpened(pool, { token: invite.token });
    await pool.query(
      `UPDATE notifications SET created_at = NOW() - INTERVAL '25 hours' WHERE user_id = $1 AND app_id = $2 AND kind = 'invite_opened'`,
      [maya.id, app.id]);
    const today = await activity.noteOpened(pool, { token: invite.token });
    assert.equal(today.fresh, true);
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 2);
  });
});
