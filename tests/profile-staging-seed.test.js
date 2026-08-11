// Profile-customization staging fixtures (issue #982) —
// `seedStagingProfileCustomization` in src/db/migrate.js.
//
// WHY THIS SEED EXISTS. `user_avatars` is a brand-new table, so the boot
// migration creates it EMPTY in every staging clone, and `users.bio` is
// new for the same reason. Without a seed, a reviewer opening the profile
// screen in a preview sees the initial-circle fallback and a bare @handle
// — indistinguishable from the feature not working.
//
// Two layers, mirroring tests/topochain-staging-seed.test.js:
//   1. Behavioural — invoke the real seeder against a mock pool that
//      records every query(sql, params). Catches what a source regex
//      can't: throws, wrong param flow, and the case where the staging
//      gate doesn't actually short-circuit before issuing any query.
//   2. Static — no-database assertions over the seeder's source text.
// No live Postgres is required or used in either layer.
//
// Run with: node --test tests/profile-staging-seed.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { seedStagingProfileCustomization } = require('../src/db/migrate');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src/db/migrate.js'), 'utf8'
);

// The seeder's own block, isolated so assertions can't accidentally match
// a neighbouring seed function.
const BLOCK = (() => {
  const start = src.indexOf('async function seedStagingProfileCustomization');
  assert.ok(start > 0, 'seedStagingProfileCustomization must exist');
  const next = src.indexOf('\nasync function ', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
})();

function mockPool(rows = []) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      // The one read the seeder does: resolve the viewer identities.
      if (/SELECT id, username FROM users WHERE username = ANY/.test(sql)) {
        return { rows };
      }
      return { rows: [] };
    },
  };
}

const CONFIG = { adminUsername: 'admin' };
const VIEWERS = [
  { id: 1, username: 'admin' },
  { id: 2, username: 'usernode-capture' },
  { id: 3, username: 'usernode-capture-admin' },
];

// Restored in test.after() so this file never leaks its override into any
// test run after it in the same process.
const ORIGINAL_USERNODE_ENV = process.env.USERNODE_ENV;
test.after(() => {
  if (ORIGINAL_USERNODE_ENV === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = ORIGINAL_USERNODE_ENV;
});

// ─── 1. Behavioural ───────────────────────────────────────────────────

test('outside staging: the seeder issues zero queries', async () => {
  process.env.USERNODE_ENV = 'production';
  const pool = mockPool(VIEWERS);
  await seedStagingProfileCustomization(pool, CONFIG);
  assert.equal(pool.calls.length, 0,
    'production data is never touched — the gate must short-circuit before any query');
});

test('in staging: one avatar insert and one user update per viewer', async () => {
  process.env.USERNODE_ENV = 'staging';
  const pool = mockPool(VIEWERS);
  await seedStagingProfileCustomization(pool, CONFIG);

  const avatarInserts = pool.calls.filter((c) => /INSERT INTO user_avatars/.test(c.sql));
  // Three viewers + the leaderboard fixture author.
  assert.equal(avatarInserts.length, 4);
  const viewerUpdates = pool.calls.filter(
    (c) => /UPDATE users/.test(c.sql) && /WHERE id = \$1/.test(c.sql)
  );
  assert.equal(viewerUpdates.length, VIEWERS.length,
    'seeded once per viewer, not once in total');
});

test('avatar ids are keyed off the NAME position, not the query order', async () => {
  process.env.USERNODE_ENV = 'staging';
  // Same three identities, returned in a different order — the ids each
  // one gets must not move, or a later boot re-inserts under fresh ids and
  // defeats ON CONFLICT.
  const forward = mockPool(VIEWERS);
  await seedStagingProfileCustomization(forward, CONFIG);
  const reversed = mockPool([...VIEWERS].reverse());
  await seedStagingProfileCustomization(reversed, CONFIG);

  const idFor = (pool, userId) => pool.calls
    .filter((c) => /INSERT INTO user_avatars \(id, user_id/.test(c.sql) && c.params)
    .find((c) => c.params[1] === userId)?.params[0];

  for (const v of VIEWERS) {
    assert.equal(idFor(forward, v.id), idFor(reversed, v.id),
      `${v.username}'s avatar id must not depend on result order`);
  }
});

test('an unset adminUsername shifts nobody else’s avatar id', async () => {
  process.env.USERNODE_ENV = 'staging';
  const withAdmin = mockPool(VIEWERS);
  await seedStagingProfileCustomization(withAdmin, CONFIG);
  const withoutAdmin = mockPool(VIEWERS.slice(1));
  await seedStagingProfileCustomization(withoutAdmin, {});

  const idFor = (pool, userId) => pool.calls
    .filter((c) => /INSERT INTO user_avatars \(id, user_id/.test(c.sql) && c.params)
    .find((c) => c.params[1] === userId)?.params[0];

  assert.equal(idFor(withAdmin, 2), idFor(withoutAdmin, 2));
  assert.equal(idFor(withAdmin, 3), idFor(withoutAdmin, 3));
});

test('the seeded avatar bytes are a real, decodable PNG with honest metadata', async () => {
  process.env.USERNODE_ENV = 'staging';
  const pool = mockPool(VIEWERS);
  await seedStagingProfileCustomization(pool, CONFIG);

  const insert = pool.calls.find(
    (c) => /INSERT INTO user_avatars \(id, user_id/.test(c.sql) && c.params?.[1] === 1
  );
  const [id, , b64, size, sha] = insert.params;
  assert.match(id, /^[a-f0-9]{32}$/,
    'the id must be the same 32-hex shape GET /avatars/:id accepts');
  const bytes = Buffer.from(b64, 'base64');
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'the fixture must be a real PNG — the sniff path is what it exists to prove'
  );
  // Size and digest are derived from the same bytes, so the row can never
  // describe an image it doesn't hold.
  assert.equal(size, bytes.length);
  assert.equal(
    sha,
    require('crypto').createHash('sha256').update(bytes).digest('hex')
  );
});

test('the seeder never throws, even when the pool does', async () => {
  process.env.USERNODE_ENV = 'staging';
  const exploding = { query: async () => { throw new Error('boom'); } };
  // A fixture failure must never abort the boot migration.
  await seedStagingProfileCustomization(exploding, CONFIG);
});

// ─── 2. Static ────────────────────────────────────────────────────────

test('every write is idempotent', () => {
  const inserts = BLOCK.match(/INSERT INTO [\s\S]*?(?=\);)/g) || [];
  assert.ok(inserts.length, 'the seeder must insert something');
  for (const stmt of inserts) {
    assert.match(stmt, /ON CONFLICT/,
      'staging containers rebuild on every push — seeds re-run each boot');
  }
});

test('existing values are never clobbered', () => {
  const updates = BLOCK.match(/UPDATE users[\s\S]*?WHERE id/g) || [];
  assert.ok(updates.length);
  for (const stmt of updates) {
    for (const col of stmt.match(/^\s+(\w+)\s+= /gm) || []) {
      const name = col.trim().split(/\s/)[0];
      if (name === 'updated_at') continue;
      assert.match(stmt, new RegExp(`${name}\\s+= COALESCE\\(${name},`),
        `${name} must be COALESCEd — a clone may already carry a real value`);
    }
  }
});

test('fixture content is obviously fake', () => {
  assert.match(BLOCK, /\[Staging demo\]/,
    'seeded rows must be unmistakable for real user content');
  assert.match(BLOCK, /staging-demo/);
});

test('one fixture leaderboard user is deliberately left with NO avatar', () => {
  // So the photo row and the initial-circle fallback are both on screen
  // once the leaderboard surfaces land.
  assert.match(BLOCK, /WHERE username = 'staging-demo-user'/,
    'the fixture author gets a picture');
  assert.match(BLOCK, /staging-demo-giver keeps NO avatar on purpose/i);
  const giverBlock = BLOCK.slice(BLOCK.indexOf("'staging-demo-giver'"));
  assert.doesNotMatch(giverBlock, /INSERT INTO user_avatars/);
});

test('the leaderboard fixtures are keyed by USERNAME, not by a fixed id', () => {
  // seedStagingLeaderboardProfile declares staging-demo-author as 900001,
  // but 900001 is already staging-demo-user (seedStagingDemoAppCard runs
  // first) so its ON CONFLICT DO NOTHING never renames it. Keying on the
  // id would silently decorate the wrong account.
  assert.doesNotMatch(BLOCK, /WHERE id = 90000\d/,
    'resolve these fixtures by name — the 9000xx ids collide across seeds');
});

test('the seeder is wired into the boot sequence and exported', () => {
  assert.match(src, /await seedStagingProfileCustomization\(pool, config\);/);
  assert.match(src, /module\.exports = \{[^}]*seedStagingProfileCustomization/);
  // Order matters: it decorates rows the two earlier seeds create.
  const topochainAt = src.indexOf('await seedStagingTopochain(pool, config);');
  const selfAt = src.indexOf('await seedStagingProfileCustomization(pool, config);');
  assert.ok(topochainAt > 0 && selfAt > topochainAt,
    'must run after seedStagingTopochain, which creates the viewer rows it decorates');
});

test('the completed-challenge fixtures it relies on are still seeded', () => {
  // This seed deliberately adds NO user_activities rows: seedStagingTopochain
  // already credits every viewer across a done/not-done mix, which is the
  // regression coverage the per-user done rule needs on screen. If those
  // ids ever move, this test is the tripwire.
  for (const id of [900500, 900501, 900511, 900512, 900513, 900514]) {
    assert.ok(src.includes(String(id)),
      `challenge ${id} backs the profile's completed list — it must stay seeded`);
  }
  assert.doesNotMatch(BLOCK, /INSERT INTO user_activities/,
    'the activity fixtures belong to seedStagingTopochain, not here');
});
