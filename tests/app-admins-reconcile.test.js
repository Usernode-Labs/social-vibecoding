// Tests for the deploy-time per-app admins reconcile (issue #788) —
// reconcileAppAdmins / applyAdminsChange in
// src/services/app-manifest.js. Mirrors the reconcile half of
// tests/app-manifest-governance.test.js.
//
// Run with: node --test tests/app-admins-reconcile.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const appManifest = require('../src/services/app-manifest');

// Scripted mock pool: answers the fresh app-row SELECT from `appRow`,
// resolves declared usernames from `users`, reports the existing roster
// from `existing`, and returns empty rows for everything else (chat
// insert, event insert, ws) so the best-effort side effects no-op.
function mockPool(appRow, { users = [], existing = [] } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT id, slug, self_hosted, created_by, admin_usernames FROM apps/.test(sql)) {
        return { rows: appRow ? [appRow] : [] };
      }
      if (/SELECT id, username FROM users WHERE LOWER\(username\) = ANY/.test(sql)) {
        const wanted = new Set(params[0]);
        return { rows: users.filter((u) => wanted.has(u.username.toLowerCase())) };
      }
      if (/SELECT user_id FROM app_admins WHERE app_id/.test(sql)) {
        return { rows: existing.map((id) => ({ user_id: id })) };
      }
      return { rows: [] };
    },
  };
}

const find = (pool, re) => pool.calls.filter((c) => re.test(c.sql));
const inserts = (pool) => find(pool, /INSERT INTO app_admins/);
const deletes = (pool) => find(pool, /DELETE FROM app_admins/);
const nameWrites = (pool) => find(pool, /UPDATE apps SET admin_usernames/);
const collabSeeds = (pool) => find(pool, /INSERT INTO app_collaborators/);

const APP = { id: 5, slug: 'chess', self_hosted: false, created_by: 1, admin_usernames: [] };
const USERS = [
  { id: 11, username: 'alice' },
  { id: 12, username: 'Bob' },
  { id: 13, username: 'carol' },
];

// ── No-op paths ───────────────────────────────────────────────────────

test('absent block is a no-op — the roster is never touched', async () => {
  for (const manifest of [{}, { admins: null }, { admins: 'alice' }, null, undefined]) {
    const pool = mockPool(APP, { users: USERS });
    const changed = await appManifest.reconcileAppAdmins(pool, { id: 5 }, manifest);
    assert.equal(changed, false);
    assert.equal(pool.calls.length, 0,
      'an absent block must not even read the app row');
  }
});

test('no-op when the resolved set AND the declared list already match', async () => {
  const pool = mockPool(
    { ...APP, admin_usernames: ['alice', 'Bob'] },
    { users: USERS, existing: [11, 12] }
  );
  const changed = await appManifest.reconcileAppAdmins(pool, { id: 5 }, { admins: ['alice', 'Bob'] });
  assert.equal(changed, false);
  assert.equal(inserts(pool).length, 0);
  assert.equal(deletes(pool).length, 0);
});

test('a display-casing change alone still reconciles (declared list is persisted verbatim)', async () => {
  // Same resolved ids, different declared spelling — the settings panel
  // renders admin_usernames, so it must follow the manifest.
  const pool = mockPool(
    { ...APP, admin_usernames: ['alice'] },
    { users: USERS, existing: [11] }
  );
  const changed = await appManifest.reconcileAppAdmins(pool, { id: 5 }, { admins: ['Alice'] });
  assert.equal(changed, true);
  assert.deepEqual(nameWrites(pool)[0].params[0], ['Alice']);
});

test('self-hosted apps are skipped — the platform repo cannot mint app admins', async () => {
  const pool = mockPool({ ...APP, self_hosted: true }, { users: USERS });
  const changed = await appManifest.reconcileAppAdmins(pool, { id: 5 }, { admins: ['alice'] });
  assert.equal(changed, false);
  assert.equal(inserts(pool).length, 0);
  assert.equal(nameWrites(pool).length, 0);
});

test('a deleted app row resolves to false rather than throwing', async () => {
  const pool = mockPool(null, { users: USERS });
  assert.equal(await appManifest.reconcileAppAdmins(pool, { id: 5 }, { admins: ['alice'] }), false);
});

// ── Grant / revoke ────────────────────────────────────────────────────

test('granting inserts the resolved ids and persists the declared list', async () => {
  const pool = mockPool(APP, { users: USERS, existing: [] });
  const changed = await appManifest.reconcileAppAdmins(pool, { id: 5 }, { admins: ['alice', 'Bob'] });
  assert.equal(changed, true);
  assert.deepEqual(inserts(pool)[0].params, [5, [11, 12]]);
  assert.deepEqual(nameWrites(pool)[0].params[0], ['alice', 'Bob']);
});

test('usernames resolve case-insensitively', async () => {
  const pool = mockPool(APP, { users: USERS, existing: [] });
  await appManifest.reconcileAppAdmins(pool, { id: 5 }, { admins: ['ALICE', 'bob'] });
  assert.deepEqual(inserts(pool)[0].params[1], [11, 12],
    '"bob" must match the stored "Bob"');
});

test('revoking deletes rows outside the new set', async () => {
  const pool = mockPool(
    { ...APP, admin_usernames: ['alice', 'Bob'] },
    { users: USERS, existing: [11, 12] }
  );
  const changed = await appManifest.reconcileAppAdmins(pool, { id: 5 }, { admins: ['alice'] });
  assert.equal(changed, true);
  assert.deepEqual(deletes(pool)[0].params, [5, [11]],
    'the DELETE keeps only the new set');
});

test('an explicit [] clears the whole roster', async () => {
  const pool = mockPool(
    { ...APP, admin_usernames: ['alice'] },
    { users: USERS, existing: [11] }
  );
  const changed = await appManifest.reconcileAppAdmins(pool, { id: 5 }, { admins: [] });
  assert.equal(changed, true);
  // `NOT (user_id = ANY('{}'))` is true for every row, so this clears.
  assert.deepEqual(deletes(pool)[0].params, [5, []]);
  assert.equal(inserts(pool).length, 0, 'nothing to insert');
  assert.deepEqual(nameWrites(pool)[0].params[0], []);
});

// ── Unresolved names ──────────────────────────────────────────────────

test('an unknown username is skipped but RETAINED in admin_usernames', async () => {
  const pool = mockPool(APP, { users: USERS, existing: [] });
  const changed = await appManifest.reconcileAppAdmins(
    pool, { id: 5 }, { admins: ['alice', 'nobody-here'] }
  );
  assert.equal(changed, true);
  assert.deepEqual(inserts(pool)[0].params[1], [11],
    'only the resolvable name becomes a grant');
  assert.deepEqual(nameWrites(pool)[0].params[0], ['alice', 'nobody-here'],
    'the unresolved name is kept so the panel can flag it');
});

test('an all-unresolved list still writes the declared names and grants nothing', async () => {
  const pool = mockPool(APP, { users: USERS, existing: [] });
  const changed = await appManifest.reconcileAppAdmins(pool, { id: 5 }, { admins: ['ghost'] });
  assert.equal(changed, true);
  assert.equal(inserts(pool).length, 0);
  assert.deepEqual(nameWrites(pool)[0].params[0], ['ghost']);
});

// ── Collaborator seeding ──────────────────────────────────────────────

test('resolved admins are seeded as collaborators so they can reach a private app', async () => {
  const pool = mockPool(APP, { users: USERS, existing: [] });
  await appManifest.reconcileAppAdmins(pool, { id: 5 }, { admins: ['alice', 'Bob'] });
  const seeds = collabSeeds(pool);
  assert.equal(seeds.length, 1);
  assert.deepEqual(seeds[0].params, [5, [11, 12]]);
  assert.match(seeds[0].sql, /DO UPDATE/, 'an existing invited row is upgraded to member');
});

test('demotion does NOT remove collaborator rows', async () => {
  const pool = mockPool(
    { ...APP, admin_usernames: ['alice', 'Bob'] },
    { users: USERS, existing: [11, 12] }
  );
  await appManifest.reconcileAppAdmins(pool, { id: 5 }, { admins: ['alice'] });
  assert.equal(find(pool, /DELETE FROM app_collaborators/).length, 0,
    'revoking admin must not silently revoke collaboration');
});

test('clearing the roster seeds nobody', async () => {
  const pool = mockPool({ ...APP, admin_usernames: ['alice'] }, { users: USERS, existing: [11] });
  await appManifest.reconcileAppAdmins(pool, { id: 5 }, { admins: [] });
  assert.equal(collabSeeds(pool).length, 0);
});

// ── Side effects are best-effort ──────────────────────────────────────

test('a failing side effect does not fail the reconcile', async () => {
  // ws / events / notifications are required lazily inside try/catch;
  // simulate the DB half failing by throwing on the collaborator seed.
  const base = mockPool(APP, { users: USERS, existing: [] });
  const pool = {
    calls: base.calls,
    query: async (sql, params) => {
      if (/INSERT INTO app_collaborators/.test(sql)) throw new Error('boom');
      return base.query(sql, params);
    },
  };
  const changed = await appManifest.reconcileAppAdmins(pool, { id: 5 }, { admins: ['alice'] });
  assert.equal(changed, true, 'the roster write still counts as applied');
  assert.equal(inserts(pool).length, 1);
});

test('applyAdminsChange is callable directly with an explicit roster', async () => {
  const pool = mockPool(APP, { users: USERS });
  await appManifest.applyAdminsChange(
    pool, { id: 5, slug: 'chess', admin_usernames: [] },
    { usernames: ['alice'], userIds: [11] },
    { actorLabel: 'test', userId: 99 }
  );
  assert.deepEqual(inserts(pool)[0].params, [5, [11]]);
  assert.deepEqual(nameWrites(pool)[0].params[0], ['alice']);
});
