'use strict';

// #2253: the two Postgres-touching halves of the per-app database storage
// cap, in services/db-manager.js. The policy (when to freeze, when to thaw,
// whom to tell) is tests/app-storage-cap.test.js's subject; this file pins
// what actually reaches Postgres:
//
//   - the measurement query and how its `-At` output is read, because a
//     misread row is a freeze decision made on garbage;
//   - the exact statements a freeze/thaw runs, and that they address the
//     app's owner role, since that is the role every app connection uses;
//   - the identifier guard, which refuses anything it cannot quote exactly.
//
// Run with: node --test tests/db-manager-sizes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const dbManager = require('../src/services/db-manager');

test('parseDatabaseSizes reads -At rows and drops anything that is not one', () => {
  const out = dbManager.parseDatabaseSizes([
    'app_notes|1048576',
    'app_big_one_staging_s12_abcdef|2048',
    '',
    'NOTICE:  something psql said',
    'app_bad|12x',
    'app_three|1|2',
    'not an ident!|5',
    'app_neg|-5',
    '  app_padded|7  ',
    'app_huge|99999999999999999999',
  ].join('\n'));
  assert.deepEqual(out, [
    { dbName: 'app_notes', bytes: 1048576 },
    { dbName: 'app_big_one_staging_s12_abcdef', bytes: 2048 },
    { dbName: 'app_padded', bytes: 7 },
  ]);
  assert.deepEqual(dbManager.parseDatabaseSizes(''), []);
  assert.deepEqual(dbManager.parseDatabaseSizes(undefined), []);
});

test('listAppDatabaseSizes asks the catalog for app_ databases, tuples only', async () => {
  const calls = [];
  const execute = async (sql, opts) => {
    calls.push({ sql, opts });
    return 'app_a|10\napp_b|20\n';
  };
  const out = await dbManager.listAppDatabaseSizes({ execute });
  assert.deepEqual(out, [{ dbName: 'app_a', bytes: 10 }, { dbName: 'app_b', bytes: 20 }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { tuplesOnly: true }, 'parsed as unaligned tuples, no header');
  assert.match(calls[0].sql, /pg_database_size\(datname\)/);
  // The underscore is escaped: `app_%` would also match `apple`.
  assert.match(calls[0].sql, /datname LIKE 'app\\_%'/);
  assert.match(calls[0].sql, /NOT datistemplate/);
});

test('setAppDatabaseWritable flips the owner role default and drops its open sessions', async () => {
  const calls = [];
  const execute = async (sql) => { calls.push(sql); return ''; };

  const frozen = await dbManager.setAppDatabaseWritable('app_notes', false, { execute });
  assert.deepEqual(frozen, { dbName: 'app_notes', role: 'app_notes_owner', writable: false });
  assert.deepEqual(calls, [
    'ALTER ROLE "app_notes_owner" SET default_transaction_read_only = on',
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'app_notes_owner' AND pid <> pg_backend_pid()",
  ], 'the role default is set first, then every session already holding it is dropped');

  calls.length = 0;
  const thawed = await dbManager.setAppDatabaseWritable('app_notes', true, { execute });
  assert.equal(thawed.writable, true);
  assert.equal(calls[0], 'ALTER ROLE "app_notes_owner" RESET default_transaction_read_only');
  assert.match(calls[1], /pg_terminate_backend/, 'a thaw also reconnects the pool, so writes resume now');
});

test('setAppDatabaseWritable propagates a failed statement rather than half-applying', async () => {
  const calls = [];
  const execute = async (sql) => {
    calls.push(sql);
    if (/pg_terminate_backend/.test(sql)) throw new Error('permission denied');
  };
  await assert.rejects(
    () => dbManager.setAppDatabaseWritable('app_notes', false, { execute }),
    /permission denied/
  );
  assert.equal(calls.length, 2, 'the caller learns the sessions were not dropped and retries next sweep');
});

test('setAppDatabaseWritable refuses a name it cannot quote exactly', async () => {
  for (const bad of ['app_x; DROP ROLE postgres', 'app-x', 'App_Notes', '', 'app_x"', 'app x']) {
    let ran = false;
    await assert.rejects(
      () => dbManager.setAppDatabaseWritable(bad, false, { execute: async () => { ran = true; } }),
      /unsafe dbName/
    );
    assert.equal(ran, false, `no statement reaches Postgres for ${JSON.stringify(bad)}`);
  }
});

test('isStagingTemplateDb recognises the template suffix and nothing else', () => {
  assert.equal(dbManager.isStagingTemplateDb(dbManager.stagingTemplateDbName('app_notes')), true);
  assert.equal(dbManager.isStagingTemplateDb('app_notes'), false);
  assert.equal(dbManager.isStagingTemplateDb('_stgtmpl'), false, 'the bare suffix names nothing');
  assert.equal(dbManager.isStagingTemplateDb(null), false);
  // And the two exclusions the sweep relies on do not overlap with a real
  // app database name.
  assert.equal(dbManager.isStagingCloneDb(dbManager.appDbName('notes')), false);
  assert.equal(dbManager.isStagingCloneDb('app_notes_staging_s12_abcdef'), true);
});
