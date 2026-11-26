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

// ── A connection the database would not give (23 Nov 2026) ─────────────

// pg-pool and pg's Client throw plain Errors with no code for these.
const poolTimeout = () => new Error('timeout exceeded when trying to connect');
const clientTimeout = () => new Error('Connection terminated due to connection timeout');
const errno = (code) => Object.assign(new Error(`connect ${code} 10.0.0.5:5432`), { code, errno: -1, syscall: 'connect' });

test('a connection the database would not give is recognised by its shape', () => {
  const shapes = [
    ['pg-pool checkout timeout', poolTimeout()],
    ['pg Client connect timeout', clientTimeout()],
    ['refused', errno('ECONNREFUSED')],
    ['reset', errno('ECONNRESET')],
    ['timed out', errno('ETIMEDOUT')],
    ['no route', errno('EHOSTUNREACH')],
    ['admin shutdown', pgError('57P01', 'terminating connection due to administrator command')],
    ['crash shutdown', pgError('57P02', 'terminating connection because of crash of another server process')],
    ['cannot connect now', pgError('57P03', 'the database system is starting up')],
    ['too many connections', pgError('53300', 'sorry, too many clients already')],
    ...['08000', '08001', '08003', '08004', '08006'].map((code) => [`connection exception ${code}`, pgError(code, 'connection failure')]),
    // psql and pg_dump say the same in their stderr (db-manager.execInTarget).
    ['psql too many clients', Object.assign(new Error('Command failed: psql -X -c SELECT 1'),
      { code: 2, stderr: 'psql: error: connection to server at "pg" (10.0.0.5), port 5432 failed: FATAL:  sorry, too many clients already\n' })],
    ['psql refused', Object.assign(new Error('Command failed: pg_dump app_x'),
      { code: 1, stderr: 'pg_dump: error: connection to server at "pg" (10.0.0.5), port 5432 failed: Connection refused\n\tIs the server running on that host and accepting TCP/IP connections?\n' })],
    ['psql shutting down', Object.assign(new Error('Command failed: psql'), { code: 2, stderr: 'psql: error: FATAL:  the database system is shutting down\n' })],
    // Wrapped, the way a caller keeps the error it met.
    ['as a cause', new Error('Could not prepare the copies', { cause: poolTimeout() })],
    ['inside an AggregateError', Object.assign(new AggregateError([errno('ECONNREFUSED'), errno('ECONNREFUSED')], ''), { code: undefined })],
    // Trimmed, as a message is sometimes stored.
    ['with whitespace', new Error('timeout exceeded when trying to connect\n')],
  ];
  for (const [name, error] of shapes) assert.equal(dbRetry.isConnectionError(error), true, name);
});

test('an ordinary query error, a syntax error and words in a sentence are not a connection error', () => {
  for (const [name, error] of [
    ['duplicate key', pgError('23505', 'duplicate key value violates unique constraint "users_pkey"')],
    ['syntax error', pgError('42601', 'syntax error at or near "SELEC"')],
    ['missing relation', pgError('42P01', 'relation "nope" does not exist')],
    ['statement timeout', pgError('57014', 'canceling statement due to statement timeout')],
    ['deadlock', pgError('40P01', 'deadlock detected')],
    ['in use', pgError('55006', 'database "x" is being accessed by other users')],
    ['query read timeout', new Error('Query read timeout')],
    ['a sentence that quotes the words', new Error('The agent said: timeout exceeded when trying to connect')],
    ['psql query error', psqlError('SELECT 1', 'relation "nope" does not exist')],
    ['a bad password is not transient', Object.assign(new Error('Command failed: psql'),
      { code: 2, stderr: 'psql: error: connection to server at "pg" (10.0.0.5), port 5432 failed: FATAL:  password authentication failed for user "x"\n' })],
    ['an exit status that looks like nothing', Object.assign(new Error('Command failed'), { code: 1 })],
    ['nothing', null],
    ['not an object', 'timeout exceeded when trying to connect'],
  ]) {
    assert.equal(dbRetry.isConnectionError(error), false, name);
  }
});

test('a cycle of causes ends', () => {
  const a = new Error('outer');
  const b = new Error('inner', { cause: a });
  a.cause = b;
  assert.equal(dbRetry.isConnectionError(a), false);
});
