'use strict';

// Brief database conflicts in the before & after shots path
// (src/services/db-retry.js). Pinned here:
//   - a deadlock or serialization failure is recognised from a pg error's
//     SQLSTATE and from psql's own text, and so is a database Postgres would
//     not copy or drop because a session is on it;
//   - a step that fails N times and then succeeds is run N + 1 times, with
//     the pause between attempts and the hook before each retry;
//   - a failure that outlasts the retries, or one that is not a conflict,
//     is thrown unchanged, with its own message.
//
// Run with: node --test tests/db-retry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const dbRetry = require('../src/services/db-retry');

const pgError = (code, message) => Object.assign(new Error(message), { code });
// What execFile rejects with when psql exits 1 (db-manager.execInTarget).
const psqlError = (sql, serverMessage) => Object.assign(
  new Error(`Command failed: psql -X -v ON_ERROR_STOP=1 -c ${sql}\nERROR:  ${serverMessage}\n`),
  { code: 1, stderr: `ERROR:  ${serverMessage}\n` }
);

test('deadlocks and serialization failures are recognised from pg codes and psql text', () => {
  assert.equal(dbRetry.isTransientLockError(pgError('40P01', 'deadlock detected')), true);
  assert.equal(dbRetry.isTransientLockError(pgError('40001', 'could not serialize access due to concurrent update')), true);
  assert.equal(dbRetry.isTransientLockError(psqlError('UPDATE x SET y = 1', 'deadlock detected')), true);
  assert.equal(dbRetry.isTransientLockError(psqlError('UPDATE x SET y = 1',
    'could not serialize access due to read/write dependencies among transactions')), true);
  for (const other of [
    pgError('23505', 'duplicate key value violates unique constraint "users_pkey"'),
    pgError('42P01', 'relation "nope" does not exist'),
    psqlError('SELECT 1', 'relation "nope" does not exist'),
    new Error('Query read timeout'),
    // Words in a message are not a server error: only psql's ERROR line counts.
    new Error('the shots agent reported: deadlock detected in its own notes'),
    null,
  ]) {
    assert.equal(dbRetry.isTransientLockError(other), false, String(other?.message));
    assert.equal(dbRetry.isDbConflict(other), false, String(other?.message));
  }
});

test('a database in use is recognised for CREATE … TEMPLATE, DROP and RENAME, as psql and pg report it', () => {
  // The two shots failures, as their runs recorded them.
  const copy = psqlError(
    'CREATE DATABASE app_usernode_2d5619_evsrc_3507b567ed7f TEMPLATE app_usernode_2d5619_stgtmpl OWNER app_usernode_2d5619_evsrc_3507b567ed7f_owner',
    'source database "app_usernode_2d5619_stgtmpl" is being accessed by other users'
  );
  const drop = psqlError(
    'DROP DATABASE IF EXISTS app_plant_pal_1ad9b5_stgtmpl_next',
    'database "app_plant_pal_1ad9b5_stgtmpl_next" is being accessed by other users'
  );
  for (const error of [copy, drop, pgError('55006', 'database "x" is being accessed by other users')]) {
    assert.equal(dbRetry.isObjectInUse(error), true);
    assert.equal(dbRetry.isDbConflict(error), true);
    assert.equal(dbRetry.isTransientLockError(error), false, 'in use is its own kind, retried only where asked');
  }
});

test('a step that fails twice and then succeeds runs three times, pausing between attempts', async () => {
  const waits = [];
  const hooks = [];
  let calls = 0;
  const result = await dbRetry.withDbRetry(async (attempt) => {
    calls += 1;
    assert.equal(attempt, calls, 'each attempt is told its number');
    if (calls < 3) throw pgError('40P01', 'deadlock detected');
    return 'written';
  }, {
    wait: async (ms) => { waits.push(ms); },
    beforeRetry: async (error, attempt) => { hooks.push([error.code, attempt]); },
  });
  assert.equal(result, 'written');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [...dbRetry.DB_RETRY_BACKOFF_MS], 'a short pause, longer the second time');
  assert.deepEqual(hooks, [['40P01', 1], ['40P01', 2]]);
  assert.equal(dbRetry.DB_RETRY_ATTEMPTS, 3);
});

test('a conflict that outlasts the retries fails with its own message', async () => {
  let calls = 0;
  const original = psqlError('DROP DATABASE IF EXISTS app_demo_stgtmpl_next',
    'database "app_demo_stgtmpl_next" is being accessed by other users');
  await assert.rejects(dbRetry.withDbRetry(async () => {
    calls += 1;
    throw original;
  }, { retryable: dbRetry.isDbConflict, wait: async () => {} }), (error) => {
    assert.equal(error, original, 'the very error, not a wrapper');
    assert.match(error.message, /^Command failed: psql .*DROP DATABASE IF EXISTS app_demo_stgtmpl_next/);
    return true;
  });
  assert.equal(calls, dbRetry.DB_RETRY_ATTEMPTS);
});

test('anything that is not a conflict fails at once', async () => {
  let calls = 0;
  let paused = false;
  await assert.rejects(dbRetry.withDbRetry(async () => {
    calls += 1;
    throw pgError('23505', 'duplicate key value violates unique constraint "users_pkey"');
  }, { wait: async () => { paused = true; } }), /duplicate key/);
  assert.equal(calls, 1);
  assert.equal(paused, false);

  // In use is not retried where only lock conflicts are asked for.
  calls = 0;
  await assert.rejects(dbRetry.withDbRetry(async () => {
    calls += 1;
    throw pgError('55006', 'database "x" is being accessed by other users');
  }, { wait: async () => {} }), /being accessed/);
  assert.equal(calls, 1);
});

test('one attempt means no retry at all', async () => {
  let calls = 0;
  await assert.rejects(dbRetry.withDbRetry(async () => {
    calls += 1;
    throw pgError('40P01', 'deadlock detected');
  }, { attempts: 1, wait: async () => { throw new Error('must not pause'); } }), /deadlock detected/);
  assert.equal(calls, 1);
});
