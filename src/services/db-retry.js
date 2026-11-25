'use strict';

// Brief database conflicts that say nothing about the work being done.
//
// Before & after shots ended at once on three of them in the same stretch
// of proposals: a deadlock while the shots databases were being written
// (40P01), and twice a database that Postgres would not copy or drop because
// a session was still connected to it (55006, "is being accessed by other
// users"). Each was gone a moment later. The steps that meet them retry a
// bounded number of times with a short pause, the way cloning the git
// repository already does (cloneWithRetry in shots-environment.js), and a
// failure that outlasts the retries is thrown unchanged, with its own
// message.
//
// Errors come two ways: a pg client error carries its SQLSTATE in `code`,
// while a psql command (db-manager's execInTarget) fails with the exit
// status in `code` and the server's message in its text. Both are read.

const log = require('./logger');

const DB_RETRY_ATTEMPTS = 3;
const DB_RETRY_BACKOFF_MS = Object.freeze([1_000, 3_000]);

// 40P01 deadlock_detected, 40001 serialization_failure: the transaction was
// rolled back whole, so running it again is safe.
const TRANSIENT_LOCK_CODES = new Set(['40P01', '40001']);
const TRANSIENT_LOCK_TEXT = /\bERROR:\s+(?:deadlock detected|could not serialize access)/;
// 55006 object_in_use: CREATE DATABASE … TEMPLATE, DROP DATABASE and RENAME
// refuse before they change anything while another session is connected.
const OBJECT_IN_USE_CODE = '55006';
const OBJECT_IN_USE_TEXT = /\bERROR:\s+(?:source )?database "[^"]+" is being accessed by other users/;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function errorText(error) {
  return [error?.message, error?.stderr].filter((part) => typeof part === 'string').join('\n');
}

function sqlState(error) {
  const code = String(error?.code || '');
  return /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function isTransientLockError(error) {
  if (!error) return false;
  if (TRANSIENT_LOCK_CODES.has(sqlState(error))) return true;
  return TRANSIENT_LOCK_TEXT.test(errorText(error));
}

function isObjectInUse(error) {
  if (!error) return false;
  if (sqlState(error) === OBJECT_IN_USE_CODE) return true;
  return OBJECT_IN_USE_TEXT.test(errorText(error));
}

function isDbConflict(error) {
  return isTransientLockError(error) || isObjectInUse(error);
}

// A database the step could not reach, or that would not take another
// connection: nothing about the work it was for was decided, so a failure on
// it is the platform's, never the proposal's. On 23 Nov 2026 three runs
// failed in the same half minute on pg-pool's "timeout exceeded when trying
// to connect" while a release's replaced processes finished their work on
// their drain-sized pools (server.js shrinkPoolsForDrain), and Postgres
// itself had room to spare.
//
// Known by its shape, never by a word in a sentence somebody wrote:
//   - pg-pool's checkout timeout and pg Client's connect timeout, which carry
//     no code, by their whole message;
//   - the socket's own errno;
//   - the server's SQLSTATE: 57P01 admin_shutdown, 57P02 crash_shutdown,
//     57P03 cannot_connect_now, 53300 too_many_connections, and the class 08
//     connection exceptions 08000 to 08006;
//   - psql's FATAL line for the same server refusals, and libpq's own words
//     for a connection that was refused or timed out (db-manager's psql and
//     pg_dump report in their stderr).
// A wrapper that keeps the error as its `cause` (or an AggregateError's
// `errors`, as Node's connect reports trying several addresses) is read
// through, a few levels deep.
const CONNECTION_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300']);
const CONNECTION_EXCEPTION = /^0800[0-6]$/;
const CONNECTION_ERRNOS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH']);
const CONNECTION_MESSAGE = /^(?:timeout exceeded when trying to connect|Connection terminated due to connection timeout)$/;
const CONNECTION_FATAL_TEXT = /\bFATAL:\s+(?:sorry, too many clients already|remaining connection slots are reserved|the database system is (?:starting up|shutting down|in recovery mode)|terminating connection due to administrator command)/;
const CONNECTION_LIBPQ_TEXT = /\bconnection to server (?:at|on) [^\n]{1,300}? failed: (?:Connection refused|timeout expired|No route to host|Connection reset by peer)/;

function isConnectionError(error, depth = 0) {
  if (!error || typeof error !== 'object' || depth > 3) return false;
  const code = String(error.code || '');
  if (CONNECTION_ERRNOS.has(code) || CONNECTION_SQLSTATES.has(code) || CONNECTION_EXCEPTION.test(code)) return true;
  if (typeof error.message === 'string' && CONNECTION_MESSAGE.test(error.message.trim())) return true;
  const text = errorText(error);
  if (CONNECTION_FATAL_TEXT.test(text) || CONNECTION_LIBPQ_TEXT.test(text)) return true;
  if (Array.isArray(error.errors) && error.errors.some((inner) => isConnectionError(inner, depth + 1))) return true;
  return error.cause !== error && isConnectionError(error.cause, depth + 1);
}

// A release's replaced process finishes its work on small pools (server.js
// shrinkPoolsForDrain: the main pool at DRAIN_DB_POOL_MAX, the workflow's at
// DRAIN_WF_POOL_MAX, db-manager one operation at a time), so a step it still
// runs can wait past DB_POOL_WAIT_MS for a connection. That is the drain,
// not the work: such a step is handed to the process that replaced this one
// (the workflow kernel's HandedBack), which carries it on as it carries on
// any step a stopping process left, rather than recorded as a failure.
// `draining` is lifecycle.isShuttingDown(): set from SIGTERM on.
function handBackOnDrain(error, draining = require('./lifecycle').isShuttingDown()) {
  return !!draining && isConnectionError(error);
}

// Run `fn(attempt)` until it settles, at most `attempts` times. Only an error
// `retryable` accepts is tried again; `beforeRetry(error, attempt)` runs
// before the pause (a step that clears what the conflict was about). The
// last error is rethrown as it was.
async function withDbRetry(fn, {
  attempts = DB_RETRY_ATTEMPTS,
  backoffMs = DB_RETRY_BACKOFF_MS,
  retryable = isTransientLockError,
  beforeRetry = null,
  wait = sleep,
  label = 'Database step',
} = {}) {
  const total = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= total || !retryable(error)) throw error;
      log.warn('db-retry', `${label} met a brief database conflict; retrying`, {
        attempt, attempts: total, code: sqlState(error),
        conflict: isObjectInUse(error) ? 'in_use' : 'lock',
      });
      if (beforeRetry) await beforeRetry(error, attempt);
      await wait(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] || 0);
    }
  }
}

module.exports = {
  DB_RETRY_ATTEMPTS,
  DB_RETRY_BACKOFF_MS,
  isTransientLockError,
  isObjectInUse,
  isDbConflict,
  isConnectionError,
  handBackOnDrain,
  withDbRetry,
};
