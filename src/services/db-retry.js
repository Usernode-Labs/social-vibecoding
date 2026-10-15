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
  withDbRetry,
};
