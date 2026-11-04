'use strict';
// test:changed: when src/services/db-manager.js (bulk catalog inventory)
// test:changed: when src/db/migrate.js (fleet adoption and repair)
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/services/db-manager');
const { migrateAppDbsToPerRole } = require('../src/db/migrate');

test('existing roles use one bounded catalog request and reject failed or malformed inventory', async () => {
  const names = Array.from({ length: 202 }, (_, i) => `app_fixture_${i}_owner`);
  const calls = [];
  const execute = async (sql, opts) => { calls.push({ sql, opts }); return names.slice(1).join('\n'); };
  const found = await db.existingRoles(names, { execute });
  assert.equal(calls.length, 1);
  assert.equal(found.size, 201);
  assert.equal(found.has(names[0]), false);
  assert.equal(found.has(names[1]), true);
  assert.deepEqual(calls[0].opts, { tuplesOnly: true });
  assert.match(calls[0].sql, /pg_catalog\.pg_roles/);
  await assert.rejects(db.existingRoles(['bad\'name'], { execute }), /Invalid role name/);
  await assert.rejects(db.existingRoles(names, { execute: async () => { throw new Error('catalog unavailable'); } }), /catalog unavailable/);
  await assert.rejects(db.existingRoles(names, { execute: async () => 'not-requested-role' }), /Invalid role inventory/);
  assert.deepEqual(await db.existingRoles([], { execute }), new Set());
  assert.equal(calls.length, 1, 'empty and invalid input make no catalog request');
});

test('fleet reconciliation keeps adoption and missing-role repair with one inventory', async t => {
  const savedEnv = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'production';
  const methods = ['existingRoles','roleExists','ensureRoleExists','databaseExists','adoptExistingDatabase'];
  const saved = Object.fromEntries(methods.map(k => [k, db[k]]));
  t.after(() => {
    Object.assign(db, saved);
    if (savedEnv === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = savedEnv;
  });
  const apps = [
    { id: 1, slug: 'fixture-one', db_password: 'synthetic-one', status: 'paused' },
    { id: 2, slug: 'fixture-two', db_password: 'synthetic-two', status: 'paused' },
    { id: 3, slug: 'fixture-three', db_password: null, status: 'paused' },
  ];
  const repaired = [], updates = [];
  let inventories = 0;
  db.existingRoles = async names => { inventories++; assert.equal(names.length, 2); return new Set([names[0]]); };
  db.roleExists = async () => { throw new Error('single-role inventory must not run'); };
  db.ensureRoleExists = async (name, password) => repaired.push({ name, password });
  db.databaseExists = async () => true;
  db.adoptExistingDatabase = async () => ({ password: 'synthetic-adopted' });
  const pool = { query: async (sql, values) => {
    if (sql.includes('SELECT id, slug')) return { rows: apps };
    updates.push(values); return { rows: [] };
  } };
  await migrateAppDbsToPerRole(pool, {});
  assert.equal(inventories, 1);
  assert.deepEqual(repaired, [{ name: db.appDbName('fixture-two'), password: 'synthetic-two' }]);
  assert.deepEqual(updates, [['synthetic-adopted', 3]]);
  db.existingRoles = async () => { throw new Error('inventory failed'); };
  repaired.length = 0;
  await assert.rejects(migrateAppDbsToPerRole(pool, {}), /inventory failed/);
  assert.deepEqual(repaired, [], 'an unknown catalog cannot trigger mass role/password repair');
  process.env.USERNODE_ENV = 'staging';
  await migrateAppDbsToPerRole({ query: async () => { throw new Error('preview read the fleet'); } }, {});
});
