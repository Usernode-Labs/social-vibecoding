'use strict';

// The main server's side of the connection budget (item 4, Q3), against
// PostgreSQL: the platform's user is granted the reserved connections, each
// app's database is capped (an app made from now on when it is made, those
// made before by the migration Job), the platform's own database never is,
// a limit set by hand stays, and a second run changes nothing.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/server-budget-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const dbManager = require('../src/services/db-manager');
const { ensureServerBudget } = require('../src/services/server-budget');

test('an app\'s database is capped at APP_DB_CONNECTION_LIMIT, never the platform\'s own, and a failure does not fail the caller', async () => {
  const saved = { url: process.env.DATABASE_URL, limit: process.env.APP_DB_CONNECTION_LIMIT };
  process.env.DATABASE_URL = 'postgres://usernode:x@db:5432/app_usernode_2d5619';
  try {
    const sql = [];
    const execute = async (s) => { sql.push(s); };
    assert.equal(await dbManager.applyAppConnectionLimit('app_m2', { execute }), 20);
    assert.deepEqual(sql, ['ALTER DATABASE app_m2 CONNECTION LIMIT 20']);
    assert.equal(await dbManager.applyAppConnectionLimit('app_usernode_2d5619', { execute }), null, 'the platform\'s own');
    assert.equal(await dbManager.applyAppConnectionLimit('app_m2', { execute: async () => { throw new Error('denied'); } }), null);
    process.env.APP_DB_CONNECTION_LIMIT = '0';
    assert.equal(await dbManager.applyAppConnectionLimit('app_m2', { execute }), null, 'off');
    assert.equal(sql.length, 1);
  } finally {
    for (const [k, v] of [['DATABASE_URL', saved.url], ['APP_DB_CONNECTION_LIMIT', saved.limit]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('a new app\'s database is capped as it is made', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/db-manager.js'), 'utf8');
  const body = src.slice(src.indexOf('async function createDatabase('), src.indexOf('// Drop a database AND its dedicated role.'));
  const granted = body.indexOf('GRANT ALL PRIVILEGES ON DATABASE');
  const capped = body.indexOf('await applyAppConnectionLimit(dbName, { execute: execInDb });');
  assert.ok(granted > 0 && capped > granted, 'once it is the app\'s');
});

test('the migration Job ensures it on every release, after the roles, never failing the release over it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts/migrate-kubernetes.js'), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  assert.ok(main.indexOf('await ensureServerBudget(config, pool);') > main.indexOf('ensureRoles(config);'));
  const ensure = src.slice(src.indexOf('async function ensureServerBudget('), src.indexOf('async function main()'));
  assert.match(ensure, /catch \(error\) \{\n\s+console\.error\('\[migration\] connection budget not ensured'/);
});

test('the migration Job grants the reserve and caps the apps made before', { timeout: 60000 }, async (t) => {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.connect(); } catch (err) {
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const { rows: [has] } = await admin.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pg_use_reserved_connections') AS ok");
  if (!has.ok) { await admin.end(); t.skip('PostgreSQL before 16 has no reserved connections'); return; }
  const tag = `${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const user = `sb_platform_${tag}`;
  const [own, a, b] = ['own', 'a', 'b'].map((n) => `app_sb_${n}_${tag}`);
  t.after(async () => {
    for (const db of [own, a, b]) await admin.query(`DROP DATABASE IF EXISTS ${db}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${user}`).catch(() => {});
    await admin.end();
  });
  await admin.query(`CREATE ROLE ${user} LOGIN`);
  for (const db of [own, a, b]) await admin.query(`CREATE DATABASE ${db}`);
  await admin.query(`ALTER DATABASE ${b} CONNECTION LIMIT 5`);
  const config = { databaseUrl: DSN.replace(/\/\/[^@]*@/, `//${user}:x@`).replace(/\/[^/]*$/, `/${own}`) };
  // The apps table as the platform's pool answers it: a self-hosted row
  // (the platform's own) is left out by the query, one whose database is
  // gone is skipped.
  const pool = {
    async query(sql) {
      assert.match(sql, /NOT self_hosted/);
      return { rows: [own, a, b, `app_sb_gone_${tag}`].map((db) => ({ slug: db.replace(/^app_/, '') })) };
    },
  };
  const limits = async () => Object.fromEntries((await admin.query(
    'SELECT datname, datconnlimit FROM pg_database WHERE datname = ANY($1::text[])', [[own, a, b]])).rows.map((r) => [r.datname, r.datconnlimit]));

  const first = await ensureServerBudget(config, { admin, pool });
  assert.deepEqual(first, { granted: true, capped: [a] });
  assert.deepEqual(await limits(), { [own]: -1, [a]: 20, [b]: 5 }, 'the platform\'s own never, a limit set by hand kept');
  const { rows: [m] } = await admin.query("SELECT pg_has_role($1, 'pg_use_reserved_connections', 'MEMBER') AS member", [user]);
  assert.equal(m.member, true);

  assert.deepEqual(await ensureServerBudget(config, { admin, pool }), { granted: false, capped: [] }, 'a second release changes nothing');
});
