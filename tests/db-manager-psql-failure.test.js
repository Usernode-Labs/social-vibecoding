'use strict';

// What a failed psql run says (services/db-manager.js psqlFailure), as the
// before & after shots failure people read it (shots-orchestrator.js
// failCurrentRun). On 2026-10-09 two shots runs failed with a reason that
// ended at the psql command: a CREATE DATABASE … TEMPLATE and a DROP
// DATABASE … WITH (FORCE) had run past their time limits, and nothing said
// so. Pinned here, with the errors Node really raises: a run cut off at its
// limit says that it was, and that the statement may still be running;
// Postgres's own refusal stays in the message, where db-retry reads it; and a
// password in the statement is masked wherever the error carries it.
//
// The psql cases run a real psql against a real server, skipped when neither
// is there, and required when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client } = require('pg');
const dbManager = require('../src/services/db-manager');
const dbRetry = require('../src/services/db-retry');
const orchestrator = require('../src/services/shots-orchestrator');

const execFileAsync = promisify(execFile);
const psqlFailure = dbManager._psqlFailureForTest;
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// How Node rejects: run `script` in a child Node, with execFile's options.
async function nodeFailure(script, args = [], options = {}) {
  try {
    await execFileAsync(process.execPath, ['-e', script, ...args], options);
  } catch (err) {
    return err;
  }
  throw new Error('the child was expected to fail');
}

// The reason and code a shots run records for `error`.
async function recorded(error) {
  const patches = [];
  const stateService = {
    async getRun() { return { id: 1, current_run_id: 1, state: 'provisioning' }; },
    async transitionRun(_pool, _runId, _state, patch) { patches.push(patch); },
  };
  assert.equal(await orchestrator.failCurrentRun({}, 1, error, stateService), true);
  return { reason: patches[0].failureReason, code: patches[0].failureCode };
}

test('a run cut off at its time limit says so, and that the statement may still be running', async () => {
  const sql = 'CREATE DATABASE app_x_evsrc_0123456789ab TEMPLATE app_x_stgtmpl OWNER app_x_evsrc_0123456789ab_owner';
  const err = await nodeFailure('setTimeout(() => {}, 10000)', [], { timeout: 200 });
  assert.equal(err.killed, true, 'Node stopped it at its time limit');
  assert.equal(err.stderr, '');
  const said = psqlFailure(err, { sql, timeoutMs: 90_000 });
  assert.equal(said, err, 'the same error, its fields kept');
  assert.equal(said.message, 'No answer from Postgres within 90 seconds, psql\'s time limit, so psql was stopped '
    + `and the statement may still be running on the server: ${sql}`);
  assert.equal(said.signal, 'SIGTERM');
  assert.equal(dbRetry.isDbConflict(said), false, 'a timeout is not retried as a brief conflict');
  assert.deepEqual(await recorded(said), { reason: said.message, code: 'shots_failed' });
});

test('Postgres\'s own refusal stays in the message, where db-retry reads it', async () => {
  const stderr = 'ERROR:  source database "app_x_stgtmpl" is being accessed by other users\n'
    + 'DETAIL:  There is 1 other session using the database.\n';
  const err = await nodeFailure('process.stderr.write(process.argv[1]); process.exit(1)', [stderr]);
  const before = err.message;
  const said = psqlFailure(err, { sql: 'CREATE DATABASE a TEMPLATE app_x_stgtmpl OWNER b', timeoutMs: 90_000 });
  assert.equal(said.message, before, 'Node\'s message, with psql\'s stderr after the command');
  assert.match(said.message, /\nERROR: {2}source database "app_x_stgtmpl" is being accessed by other users\n/);
  assert.equal(dbRetry.isObjectInUse(said), true);
  assert.match((await recorded(said)).reason, /ERROR: {2}source database "app_x_stgtmpl" is being accessed by other users/);
});

test('a password in the statement is masked in the message, the command and stderr', async () => {
  const sql = "CREATE ROLE app_x_owner LOGIN PASSWORD 's3cr''et-Value'";
  const refused = await nodeFailure('process.stderr.write(process.argv[1]); process.exit(1)', [
    `ERROR:  role "app_x_owner" already exists\nLINE 1: ${sql}\n`, sql,
  ]);
  assert.match(refused.message, /s3cr''et-Value/, 'Node puts the whole command in its message');
  const said = psqlFailure(refused, { sql, timeoutMs: 30_000 });
  for (const text of [said.message, said.cmd, said.stderr, said.stack, (await recorded(said)).reason]) {
    assert.doesNotMatch(text, /s3cr|et-Value/);
    assert.match(text, /PASSWORD '\[redacted\]'/);
  }
  assert.match(said.message, /ERROR: {2}role "app_x_owner" already exists/);

  const slow = psqlFailure(await nodeFailure('setTimeout(() => {}, 10000)', [], { timeout: 200 }), { sql, timeoutMs: 30_000 });
  assert.match(slow.message, /^No answer from Postgres within 30 seconds/);
  assert.doesNotMatch(slow.message, /s3cr/);
});

test('output over the buffer and a kill from outside are not called a time limit', async () => {
  const sql = 'SELECT 1';
  const big = await nodeFailure('process.stdout.write("x".repeat(4096)); setTimeout(() => {}, 10000)', [], { maxBuffer: 64 });
  assert.equal(big.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  const before = big.message;
  assert.equal(psqlFailure(big, { sql, timeoutMs: 30_000 }).message, before);

  const killed = await nodeFailure('process.kill(process.pid, "SIGKILL")');
  assert.equal(killed.killed, false);
  assert.equal(psqlFailure(killed, { sql, timeoutMs: 30_000 }).message,
    'psql was stopped by SIGKILL before Postgres answered: SELECT 1');
});

// psql as execInTarget runs it, against `DSN`, with its own time limit.
async function realPsql(t) {
  try { await execFileAsync('psql', ['--version']); } catch {
    t.skip('psql is not on PATH');
    return null;
  }
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.connect(); } catch (err) {
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return null;
  }
  t.after(() => admin.end());
  const url = new URL(DSN);
  const env = {
    ...process.env,
    PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: url.pathname.slice(1) || 'postgres',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
  };
  const run = async (sql, timeoutMs) => {
    try {
      await execFileAsync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env, timeout: timeoutMs });
    } catch (err) {
      return psqlFailure(err, { sql, timeoutMs });
    }
    return null;
  };
  return { admin, run };
}

test('real psql: a refused template copy keeps Postgres\'s words; a slow statement says it ran out of time', { timeout: 60_000 }, async (t) => {
  const pg = await realPsql(t);
  if (!pg) return;
  const template = `psqlfail_tmpl_${crypto.randomBytes(4).toString('hex')}`;
  await pg.admin.query(`CREATE DATABASE ${template}`);
  const holder = new Client({ connectionString: Object.assign(new URL(DSN), { pathname: `/${template}` }).toString() });
  holder.on('error', () => {});
  await holder.connect();
  t.after(async () => {
    await holder.end().catch(() => {});
    await pg.admin.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`).catch(() => {});
  });

  const refused = await pg.run(`CREATE DATABASE ${template}_copy TEMPLATE ${template}`, 30_000);
  assert.ok(refused, 'the copy was refused');
  assert.equal(dbRetry.isObjectInUse(refused), true);
  assert.match((await recorded(refused)).reason, new RegExp(`ERROR: {2}source database "${template}" is being accessed by other users`));

  const slow = await pg.run('SELECT pg_sleep(5)', 2000);
  assert.ok(slow, 'the statement outlived its limit');
  assert.equal((await recorded(slow)).reason, 'No answer from Postgres within 2 seconds, psql\'s time limit, so psql '
    + 'was stopped and the statement may still be running on the server: SELECT pg_sleep(5)');
});
