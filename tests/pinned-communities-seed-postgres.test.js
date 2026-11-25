'use strict';

// #7147's shots: the desktop sidebar keeps ten pinned communities now, not
// four (src/db/migrate.js seedStagingPinnedCommunities, against the full
// schema). The shots' member fixture is in eleven obviously fake projects,
// ten of them pinned in pin order and the eleventh left unpinned so pinning
// it is refused; a second boot adds nothing, and outside staging it writes
// nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the pinned communities seed, against the full schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'pinned_communities_seed_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  const env = process.env.USERNODE_ENV;
  t.after(async () => {
    process.env.USERNODE_ENV = env;
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { seedStagingPinnedCommunities } = require('../src/db/migrate');
  const pins = require('../src/services/community-pins');

  const member = (await pool.query(
    "INSERT INTO users (username, password) VALUES ('usernode-capture', 'x') RETURNING id, username")).rows[0];

  process.env.USERNODE_ENV = 'production';
  await seedStagingPinnedCommunities(pool);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM community_pins')).rows[0].n, 0,
    'nothing outside staging');

  process.env.USERNODE_ENV = 'staging';
  await seedStagingPinnedCommunities(pool);
  await seedStagingPinnedCommunities(pool);

  const apps = (await pool.query(
    "SELECT id, community_id, view_visibility FROM apps WHERE slug LIKE 'staging-demo-pin-%' ORDER BY slug")).rows;
  assert.equal(apps.length, 11, 'eleven obviously fake communities, one row each');
  assert.ok(apps.every((a) => a.community_id), 'each has its community');
  assert.ok(apps.every((a) => a.view_visibility === 'private'), 'private, so the public directory is untouched');

  const memberships = (await pool.query(
    'SELECT COUNT(*)::int AS n FROM community_members WHERE user_id = $1', [member.id])).rows[0].n;
  assert.equal(memberships, 11, 'the fixture is in all eleven');

  const pinned = (await pool.query(
    'SELECT community_id, position FROM community_pins WHERE user_id = $1 ORDER BY position', [member.id])).rows;
  assert.equal(pinned.length, 10, 'ten pinned, the eleventh waiting to be pinned');
  assert.deepEqual(pinned.map((p) => p.position), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'in the order they were pinned');

  // What the sidebar reads: the ten in pin order, and a pin of another one
  // refused with the new number.
  const listed = await pins.list(pool, member.id);
  assert.deepEqual(listed.map((p) => p.slug),
    ['staging-demo-pin-1', 'staging-demo-pin-2', 'staging-demo-pin-3', 'staging-demo-pin-4', 'staging-demo-pin-5',
      'staging-demo-pin-6', 'staging-demo-pin-7', 'staging-demo-pin-8', 'staging-demo-pin-9', 'staging-demo-pin-10']);
  await assert.rejects(pins.pin(pool, member, 'staging-demo-pin-11'), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.body.code, 'pins_full');
    return true;
  });
});
