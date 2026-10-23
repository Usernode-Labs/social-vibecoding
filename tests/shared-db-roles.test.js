'use strict';

// The read-only database roles the leader sets up, as a process that never
// leads uses them (platform_db_roles, docs/plans/web-and-conductor.md): the
// prod-debug role's password reaches a web process encrypted, and a newer
// leader's rotation is picked up on the refusal; the SQL console's role is
// available once the leader says it was set up. Against an in-memory stand-in
// for Postgres that checks a LOGIN role's password the way a new connection
// would.
//
// Run with: node --test tests/shared-db-roles.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const config = { dataEncryptionKey: 'test-data-key', databaseUrl: 'postgres://u:p@db.invalid:5432/usernode' };

// One database, shared by every process (module copy) a test loads.
function database({ failBootstrap = false } = {}) {
  const db = { rolePassword: null, rows: new Map(), queries: [], connections: 0 };
  db.pool = {
    query: async (sql, params = []) => {
      db.queries.push(sql);
      if (sql.includes('DO $$')) {
        if (failBootstrap) throw new Error('tuple concurrently updated');
        db.rolePassword = /PASSWORD '([0-9a-f]+)'/.exec(sql)?.[1] || db.rolePassword;
        return { rows: [] };
      }
      if (sql.includes('current_database')) return { rows: [{ db: 'usernode', usr: 'usernode' }] };
      if (sql.includes('FROM pg_catalog.pg_class') || sql.includes('information_schema')) {
        return { rows: [{ table: 'issues', kind: 'r', columns: ['id', 'title'] }] };
      }
      if (sql.startsWith('INSERT INTO platform_db_roles')) {
        const [role, ok, reason, secretEnc] = /NULL, \$4/.test(sql)
          ? [params[0], params[1], params[2], null]
          : [params[0], params[1], params[2], params[3]];
        db.rows.set(role, { ok, reason, secret_enc: secretEnc });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT ok, reason')) {
        const row = db.rows.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
  };
  // The RO role's own pool: every query checks the password, as a new
  // connection would after a rotation.
  db.Pool = class {
    constructor(opts) { this.password = opts.password; db.connections += 1; }
    on() {}
    async end() {}
    async query() {
      if (this.password !== db.rolePassword) {
        throw Object.assign(new Error('password authentication failed for user "usernode_debug_ro"'), { code: '28P01' });
      }
      return { rows: [{ ok: 1 }], rowCount: 1 };
    }
  };
  return db;
}

// A fresh process: its own copy of the module, on the shared database.
function processWith(db, modulePath) {
  const origLoad = Module._load;
  Module._load = function (req) {
    if (req === '../db/pool' || req === '../../db/pool') return { getPool: () => db.pool };
    if (req === 'pg') return { Pool: db.Pool };
    if (req === './logger' || req === '../logger') return new Proxy({}, { get: () => () => {} });
    return origLoad.apply(this, arguments);
  };
  const p = require.resolve(modulePath);
  delete require.cache[p];
  try {
    return require(p);
  } finally {
    Module._load = origLoad;
    delete require.cache[p];
  }
}

test('a web process runs prod-debug queries with the password the leader made, read encrypted', async () => {
  const db = database();
  const leader = processWith(db, '../src/services/debug-access');
  const web = processWith(db, '../src/services/debug-access');
  await leader.ensureRole(config);
  assert.equal(leader.isAvailable(), true);
  const row = db.rows.get('usernode_debug_ro');
  assert.equal(row.ok, true);
  assert.match(row.secret_enc, /^v1:/, 'encrypted with the data key, as app secrets are');
  assert.ok(!row.secret_enc.includes(db.rolePassword), 'never the password in the clear');

  assert.equal(web.isAvailable(), false, 'a process that never led has no password of its own');
  const out = await web.runQuery('SELECT 1', { config });
  assert.equal(out.rowCount, 1);
  assert.equal(web.isAvailable(), true);
});

test('a newer leader rotates the password; a web process reads it again when Postgres refuses the old one', async () => {
  const db = database();
  const leader = processWith(db, '../src/services/debug-access');
  const web = processWith(db, '../src/services/debug-access');
  await leader.ensureRole(config);
  await web.runQuery('SELECT 1', { config });
  const before = db.rolePassword;

  const newer = processWith(db, '../src/services/debug-access');
  await newer.ensureRole(config);
  assert.notEqual(db.rolePassword, before, 'every election makes a new password');

  const out = await web.runQuery('SELECT 1', { config });
  assert.equal(out.rowCount, 1, 'the refusal sends it back to the record, once');
  // The replaced leader is in the same position as the web process.
  assert.equal((await leader.runQuery('SELECT 1', { config })).rowCount, 1);
});

test('a refusal the record cannot answer is the query\'s error, not a loop', async () => {
  const db = database();
  const leader = processWith(db, '../src/services/debug-access');
  const web = processWith(db, '../src/services/debug-access');
  await leader.ensureRole(config);
  await web.runQuery('SELECT 1', { config });
  db.rolePassword = 'changed-by-hand';
  await assert.rejects(web.runQuery('SELECT 1', { config }), (err) => err.code === '28P01');
});

test('a leader whose setup failed says so, and a web process answers unavailable with its reason', async () => {
  const db = database({ failBootstrap: true });
  const leader = processWith(db, '../src/services/debug-access');
  await leader.ensureRole(config);
  assert.equal(leader.isAvailable(), false);
  assert.equal(db.rows.get('usernode_debug_ro').ok, false);
  assert.equal(db.rows.get('usernode_debug_ro').secret_enc, null);
  const web = processWith(db, '../src/services/debug-access');
  await assert.rejects(web.runQuery('SELECT 1', { config }),
    (err) => err.code === 'unavailable' && /tuple concurrently updated/.test(err.message));
});

test('before any leader set it up, a web process answers unavailable and asks again only after a while', async () => {
  const db = database();
  const web = processWith(db, '../src/services/debug-access');
  await assert.rejects(web.runQuery('SELECT 1', { config }), (err) => err.code === 'unavailable');
  const reads = db.queries.filter((q) => q.startsWith('SELECT ok, reason')).length;
  await assert.rejects(web.runQuery('SELECT 1', { config }), (err) => err.code === 'unavailable');
  assert.equal(db.queries.filter((q) => q.startsWith('SELECT ok, reason')).length, reads, 'the record is not read on every call');
});

test('the SQL console\'s role is available on a web process once the leader set it up', async () => {
  const db = database();
  const web = processWith(db, '../src/services/topochain/db-console-role');
  await web.loadShared(db.pool);
  assert.equal(web.isAvailable(), false);
  assert.match(web.unavailableReason(), /not set up yet/);

  const leader = processWith(db, '../src/services/topochain/db-console-role');
  await leader.ensureConsoleRole(config);
  assert.equal(leader.isAvailable(), true);
  assert.deepEqual(db.rows.get('topochain_console_ro'), { ok: true, reason: null, secret_enc: null }, 'no password: a NOLOGIN role');

  const later = processWith(db, '../src/services/topochain/db-console-role');
  await later.loadShared(db.pool);
  assert.equal(later.isAvailable(), true);
});

test('neither role can read the record, and the console masks the password', () => {
  const debugAccess = require('../src/services/debug-access');
  assert.ok(debugAccess.DENIED_TABLES.has('platform_db_roles'));
  const scope = require('../src/services/topochain/db-console-scope');
  assert.ok(scope.DENIED_CONSOLE_COLUMNS.platform_db_roles.includes('secret_enc'));
});
