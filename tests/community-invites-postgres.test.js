'use strict';

// Invite links against a real PostgreSQL (services/community-invites.js and
// the "Communities, stage 6: invite links" block of src/db/schema.sql).
//
// The block is lifted out of schema.sql and run as written, in a scratch
// schema beside the few tables it reads, so what is tested is the SQL that
// ships: apply_community_invite() and the trigger that applies a queued
// invite when an account is let in, however that happens.
//
// Set TEST_DATABASE_URL to run it; without a reachable server it skips (the
// unit-suite container has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCHEMA_NAME = `invites_test_${process.pid}`;
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

/** The invite-links block of schema.sql, as it ships. */
function stageSixBlock() {
  const start = SCHEMA_SQL.indexOf('-- ── Communities, stage 6: invite links');
  assert.ok(start > 0, 'the invite-links block must be findable in schema.sql');
  const end = SCHEMA_SQL.indexOf('\n-- ── ', start + 10);
  assert.ok(end > start, 'and it must end at the next block');
  return SCHEMA_SQL.slice(start, end);
}

async function connectPool() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return { skip: 'the pg driver is not installed' }; }
  const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500, max: 1 });
  try {
    await probe.query('SELECT 1');
  } catch (err) {
    await probe.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error(`TEST_DATABASE_URL is not reachable: ${err.message || err.code}`);
    return { skip: 'No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.' };
  }
  await probe.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
  await probe.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
  await probe.end();
  const pool = new Pool({ connectionString: DSN, max: 4, options: `-c search_path=${SCHEMA_NAME}` });
  await pool.query(`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY, username TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      has_platform_access BOOLEAN NOT NULL DEFAULT FALSE,
      platform_access_granted_at TIMESTAMPTZ);
    CREATE TABLE communities (id SERIAL PRIMARY KEY);
    CREATE TABLE apps (
      id SERIAL PRIMARY KEY, slug TEXT NOT NULL, name TEXT,
      created_by INTEGER, self_hosted BOOLEAN NOT NULL DEFAULT FALSE,
      collab_visibility TEXT NOT NULL DEFAULT 'public',
      view_visibility TEXT NOT NULL DEFAULT 'public',
      icon_emoji TEXT, icon_image_id TEXT,
      community_id INTEGER REFERENCES communities(id));
    CREATE TABLE community_members (
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source VARCHAR(16) NOT NULL DEFAULT 'joined',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (community_id, user_id));
    CREATE TABLE app_collaborators (
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(16) NOT NULL DEFAULT 'member',
      invited_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), accepted_at TIMESTAMPTZ,
      PRIMARY KEY (app_id, user_id));
    CREATE TABLE app_favorites (
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (app_id, user_id));
    CREATE TABLE app_admins (app_id INTEGER NOT NULL, user_id INTEGER NOT NULL);
    CREATE TABLE events (
      id SERIAL PRIMARY KEY, user_id INTEGER, app_id INTEGER, session_id INTEGER,
      event_type TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
  `);
  await pool.query(stageSixBlock());
  // The fixture: ada (let in by us), an open community and a group.
  await pool.query(`
    INSERT INTO users (id, username, has_platform_access, is_admin) VALUES
      (1, 'ada', TRUE, FALSE), (2, 'bo', TRUE, FALSE), (3, 'cy', FALSE, FALSE),
      (4, 'dee', TRUE, FALSE), (5, 'eve', FALSE, FALSE), (6, 'fay', FALSE, FALSE),
      (7, 'gus', FALSE, FALSE), (9, 'root', TRUE, TRUE);
    SELECT setval(pg_get_serial_sequence('users', 'id'), 20);
    INSERT INTO communities (id) VALUES (1), (2);
    INSERT INTO apps (id, slug, name, created_by, collab_visibility, view_visibility, community_id) VALUES
      (1, 'arena', 'Arena', 1, 'public', 'public', 1),
      (2, 'book-club', 'Book Club', 1, 'private', 'private', 2);
    INSERT INTO community_members (community_id, user_id, source) VALUES (1, 1, 'creator'), (2, 1, 'creator');
    INSERT INTO app_collaborators (app_id, user_id, status) VALUES (2, 1, 'member');
  `);
  return { pool };
}

async function dropSchema(pool) {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`).catch(() => {});
  await pool.end().catch(() => {});
}

const ADA = { id: 1, username: 'ada', isAdmin: false, hasPlatformAccess: true };
const as = (id, username, hasPlatformAccess) => ({ id, username, isAdmin: false, hasPlatformAccess });
const APP_COLUMNS = 'id, slug, name, created_by, self_hosted, collab_visibility, view_visibility, community_id';

test('invite links against a real PostgreSQL', async (t) => {
  const setup = await connectPool();
  if (setup.skip) { t.skip(setup.skip); return; }
  const { pool } = setup;
  const invites = require('../src/services/community-invites');
  const waitlist = require('../src/services/waitlist');
  const app = async (slug) => (await pool.query(`SELECT ${APP_COLUMNS} FROM apps WHERE slug = $1`, [slug])).rows[0];
  const member = async (communityId, userId) => (await pool.query(
    'SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2', [communityId, userId])).rows.length === 1;
  const saved = { enabled: process.env.INVITE_TREE_ENABLED, budgets: process.env.INVITE_TREE_BUDGETS };
  try {
    let token;
    await t.test('a member makes a link; somebody outside the project cannot', async () => {
      const arena = await app('arena');
      const refused = await invites.createInvite(pool, { app: arena, user: as(2, 'bo', true) });
      assert.equal(refused.status, 403);
      const made = await invites.createInvite(pool, { app: arena, user: ADA, days: 2, maxUses: 2 });
      assert.ok(made.ok);
      assert.match(made.link.token, invites.TOKEN_RE);
      assert.equal(made.link.path, `/invite/${made.link.token}`);
      assert.equal((await invites.createInvite(pool, { app: arena, user: ADA, days: 31 })).status, 400, 'days past the limit');
      assert.equal((await invites.createInvite(pool, { app: arena, user: ADA, maxUses: 0 })).status, 400, 'uses below it');
      token = made.link.token;
      const preview = await invites.preview(pool, token);
      assert.deepEqual(
        { live: preview.live, name: preview.project.name, inviter: preview.inviter, memberCount: preview.memberCount },
        { live: true, name: 'Arena', inviter: 'ada', memberCount: 1 },
      );
      assert.equal(preview.project.slug, undefined, 'the address comes after joining');
    });

    await t.test('somebody with access joins on the spot, pinned like Join; following again spends nothing', async () => {
      const bo = as(2, 'bo', true);
      const joined = await invites.redeem(pool, { token, user: bo });
      assert.deepEqual([joined.status, joined.slug, joined.name], ['joined', 'arena', 'Arena']);
      assert.equal(await member(1, 2), true);
      const pin = await pool.query('SELECT hidden FROM app_favorites WHERE app_id = 1 AND user_id = 2');
      assert.deepEqual(pin.rows, [{ hidden: false }]);
      assert.equal((await invites.redeem(pool, { token, user: bo })).status, 'member');
      const { rows } = await pool.query('SELECT uses FROM community_invites WHERE token = $1', [token]);
      assert.equal(rows[0].uses, 1);
    });

    await t.test('somebody still waiting is queued, and letting them in joins them (the trigger)', async () => {
      const cy = as(3, 'cy', false);
      const queued = await invites.redeem(pool, { token, user: cy });
      assert.deepEqual([queued.status, queued.slug, queued.skippedWaitlist], ['queued', null, false]);
      assert.equal(await member(1, 3), false, 'not before they are let in');
      assert.deepEqual(await invites.queuedFor(pool, 3), [{ name: 'Arena', inviter: 'ada' }]);
      assert.equal((await invites.redeem(pool, { token, user: cy })).status, 'queued', 'a second follow is the same row');
      await waitlist.grantPlatformAccess(pool, 3);
      assert.equal(await member(1, 3), true, 'joined the moment access was granted');
      const { rows } = await pool.query('SELECT status, applied_at IS NOT NULL AS applied FROM community_invite_redemptions WHERE user_id = 3');
      assert.deepEqual(rows, [{ status: 'joined', applied: true }]);
      const gen = await pool.query('SELECT invite_generation FROM users WHERE id = 3');
      assert.equal(gen.rows[0].invite_generation, 0, 'let in by us is generation 0');
    });

    await t.test('a link used as often as it allows is dead, and says only why', async () => {
      const refused = await invites.redeem(pool, { token, user: as(4, 'dee', true) });
      assert.deepEqual([refused.ok, refused.status, refused.reason], [false, 410, 'used_up']);
      assert.deepEqual(await invites.preview(pool, token), { live: false, reason: 'used_up' });
    });

    await t.test('a group\'s link makes a collaborator; turning it off cancels who it queued', async () => {
      const group = await app('book-club');
      const made = await invites.createInvite(pool, { app: group, user: ADA });
      const joined = await invites.redeem(pool, { token: made.link.token, user: as(4, 'dee', true) });
      assert.equal(joined.status, 'joined');
      const collab = await pool.query('SELECT status, invited_by FROM app_collaborators WHERE app_id = 2 AND user_id = 4');
      assert.deepEqual(collab.rows, [{ status: 'member', invited_by: 1 }]);
      assert.equal(await member(2, 4), true);
      assert.equal((await invites.redeem(pool, { token: made.link.token, user: as(5, 'eve', false) })).status, 'queued');
      assert.equal((await invites.revokeInvite(pool, { inviteId: made.link.id, user: as(2, 'bo', true) })).status, 404,
        'a stranger cannot, and is not told it exists');
      assert.deepEqual(await invites.revokeInvite(pool, { inviteId: made.link.id, user: ADA }), { ok: true, cancelled: 1 });
      await waitlist.grantPlatformAccess(pool, 5);
      const none = await pool.query('SELECT 1 FROM app_collaborators WHERE app_id = 2 AND user_id = 5');
      assert.equal(none.rows.length, 0, 'a cancelled invite is not applied on release');
      assert.equal((await invites.preview(pool, made.link.token)).reason, 'revoked');
    });

    await t.test('a link dies with its maker\'s standing, and so does a queued invite from it', async () => {
      const group = await app('book-club');
      await pool.query("INSERT INTO app_collaborators (app_id, user_id, status) VALUES (2, 2, 'member')");
      await pool.query("INSERT INTO community_members (community_id, user_id) VALUES (2, 2) ON CONFLICT DO NOTHING");
      const made = await invites.createInvite(pool, { app: group, user: as(2, 'bo', true) });
      assert.ok(made.ok);
      assert.equal((await invites.redeem(pool, { token: made.link.token, user: as(7, 'gus', false) })).status, 'queued');
      // bo is removed from the group.
      await pool.query('DELETE FROM app_collaborators WHERE app_id = 2 AND user_id = 2');
      assert.deepEqual(await invites.preview(pool, made.link.token), { live: false, reason: 'revoked' });
      const refused = await invites.redeem(pool, { token: made.link.token, user: as(4, 'dee', true) });
      assert.equal(refused.status, 'member', 'dee is already in it from ada\'s link, so nothing to refuse');
      const stranger = await pool.query("INSERT INTO users (username, has_platform_access) VALUES ('hal', TRUE) RETURNING id");
      const hal = await invites.redeem(pool, { token: made.link.token, user: as(stranger.rows[0].id, 'hal', true) });
      assert.deepEqual([hal.ok, hal.reason], [false, 'revoked']);
      await waitlist.grantPlatformAccess(pool, 7);
      const none = await pool.query('SELECT 1 FROM app_collaborators WHERE app_id = 2 AND user_id = 7');
      assert.equal(none.rows.length, 0, 'gus, queued on it, is not added on release');
      // Put gus back on the waitlist for the tree case below.
      await pool.query('UPDATE users SET has_platform_access = FALSE, invite_generation = NULL WHERE id = 7');
      await pool.query('DELETE FROM community_invite_redemptions WHERE user_id = 7');
    });

    await t.test('THE TREE, switched on: a skip lets somebody in, at the next generation, until the budget is spent', async () => {
      process.env.INVITE_TREE_ENABLED = 'true';
      process.env.INVITE_TREE_BUDGETS = '1,1';
      const made = await invites.createInvite(pool, { app: await app('arena'), user: ADA });
      const fay = await invites.redeem(pool, { token: made.link.token, user: as(6, 'fay', false) });
      assert.deepEqual([fay.status, fay.skippedWaitlist, fay.slug], ['joined', true, 'arena']);
      const row = await pool.query('SELECT has_platform_access, admitted_by, invite_generation FROM users WHERE id = 6');
      assert.deepEqual(row.rows[0], { has_platform_access: true, admitted_by: 1, invite_generation: 1 });
      const gus = await invites.redeem(pool, { token: made.link.token, user: as(7, 'gus', false) });
      assert.deepEqual([gus.status, gus.skippedWaitlist], ['queued', false], 'ada\'s one skip is spent');
      assert.equal(await invites.skipsLeft(pool, ADA), 0);
      // Released by us later, the tree's person moves to generation 0.
      await waitlist.grantPlatformAccess(pool, 6);
      const moved = await pool.query('SELECT invite_generation FROM users WHERE id = 6');
      assert.equal(moved.rows[0].invite_generation, 0);
      process.env.INVITE_TREE_ENABLED = '';
      assert.equal(await invites.skipsLeft(pool, ADA), null, 'off: nothing to show');
    });
  } finally {
    process.env.INVITE_TREE_ENABLED = saved.enabled || '';
    process.env.INVITE_TREE_BUDGETS = saved.budgets || '';
    await dropSchema(pool);
  }
});
