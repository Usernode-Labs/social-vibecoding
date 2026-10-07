'use strict';

// The app member list and the directory's hidden accounts
// (src/services/user-directory.js listAppMembers, lookupExact, searchPrefix)
// against the REAL schema in a throwaway PostgreSQL database, so the
// community triggers decide who is a member, not a fixture. Skipped when no
// server is reachable, and required when TEST_DATABASE_URL is set: the same
// contract as tests/communities-postgres.test.js.
//
// The case is a 4 October 2026 first-session run: a group's chore rota in a
// preview listed the check runner (usernode-capture-admin) as one of the
// group. tests/app-platform-members.test.js covers the route.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const userDirectory = require('../src/services/user-directory');
const { createSchemaDatabase } = require('./lib/schema-database');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('app members and hidden accounts against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'app_members_' + crypto.randomBytes(6).toString('hex');
  await createSchemaDatabase(admin, name);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  const user = async (username, { synthetic = false } = {}) => (await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id`,
    [username, synthetic]
  )).rows[0].id;
  const jordan = await user('jordan_t1004');
  const sam = await user('sam_t1004');
  const pending = await user('pat_t1004');
  const captureAdmin = await user('usernode-capture-admin');
  const bot = await user('homeroom_bot', { synthetic: true });
  const legacy = await user('usernode_fan');
  const blocker = await user('left_the_flat');

  const appId = (await pool.query(
    `INSERT INTO apps (name, slug, created_by, view_visibility, collab_visibility)
     VALUES ('Flat 4B Chores', 'flat-4b-chores-e98ecd', $1, 'private', 'private') RETURNING id`,
    [jordan]
  )).rows[0].id;
  const collaborate = (userId, status = 'member') => pool.query(
    `INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, $3)`,
    [appId, userId, status]
  );
  // The creator, the invited member who accepted, one invite still pending,
  // and the platform's accounts made members by the same triggers.
  await collaborate(jordan);
  await collaborate(sam);
  await collaborate(pending, 'invited');
  await collaborate(captureAdmin);
  await collaborate(bot);
  await collaborate(blocker);
  await pool.query('INSERT INTO user_app_blocks (user_id, app_id) VALUES ($1, $2)', [blocker, appId]);

  await t.test('the member list is the group: creator first, no platform accounts, no pending invite', async () => {
    const { members, hasMore } = await userDirectory.listAppMembers(pool, appId);
    assert.deepEqual(members, [
      { id: jordan, username: 'jordan_t1004' },
      { id: sam, username: 'sam_t1004' },
    ]);
    assert.equal(hasMore, false);
  });

  await t.test('limit cuts the list and says so', async () => {
    const { members, hasMore } = await userDirectory.listAppMembers(pool, appId, 1);
    assert.deepEqual(members.map((m) => m.username), ['jordan_t1004']);
    assert.equal(hasMore, true);
  });

  await t.test('lookup and search leave the platform accounts out and keep people', async () => {
    assert.equal((await userDirectory.lookupExact(pool, 'usernode-capture-admin')).found, false);
    assert.equal((await userDirectory.lookupExact(pool, 'homeroom_bot')).found, false);
    assert.equal((await userDirectory.lookupExact(pool, 'sam_t1004')).user.id, sam);
    const { users } = await userDirectory.searchPrefix(pool, 'user', 10);
    assert.deepEqual(users, [{ id: legacy, username: 'usernode_fan' }]);
  });
});
