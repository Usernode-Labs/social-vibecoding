'use strict';

// The platform's pool turns Postgres JIT off for its connections (21 Oct
// 2026). With JIT on, the notifications feed did ~43 ms of work and spent
// 2.9 s compiling it, on every read: the planner's cost ESTIMATE crossed the
// inline/optimize thresholds. See the note in src/db/pool.js.
//
// Run with: node --test tests/db-pool-no-jit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const ConnectionParameters = require('pg/lib/connection-parameters');

test('every platform connection starts with jit=off', () => {
  const { getPool } = require('../src/db/pool');
  // Building the pool opens no connection; the first query would.
  const pool = getPool({ databaseUrl: 'postgres://user:secret@127.0.0.1:1/none' });
  assert.equal(pool.options.options, '-c jit=off');
  // …and pg sends it as the startup `options` parameter, which Postgres
  // applies to the session before the first statement.
  const params = new ConnectionParameters(pool.options);
  assert.equal(params.options, '-c jit=off');
  // The connection string the WebSocket bus reuses is untouched.
  assert.equal(pool.options.connectionString, 'postgres://user:secret@127.0.0.1:1/none');
});
