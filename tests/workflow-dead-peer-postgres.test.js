'use strict';

// A process lost with its node sends the server nothing: the sessions of its
// workflow runtime would keep a slot's row locks and a claim's advisory lock
// until the server's OS keepalive gave up (hours). The runtime's pool
// (src/workflow/platform.ts deadPeerOptions) makes every session reap a dead
// peer within a minute (services/db-locks.js), and end a transaction its client stopped
// talking in.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the workflow runtime\'s sessions reap a dead peer and an abandoned transaction', async (t) => {
  const { deadPeerOptions } = require('../src/workflow/platform.ts');
  const { SERVER_KEEPALIVE, KEEPALIVE_INITIAL_DELAY_MS, serverReapSeconds } = require('../src/services/db-locks');
  const options = deadPeerOptions();
  assert.equal(options.keepAlive, true);
  assert.equal(options.keepAliveInitialDelayMillis, KEEPALIVE_INITIAL_DELAY_MS);
  assert.ok(serverReapSeconds() <= 60, 'within a minute');

  const pool = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000, max: 1, ...options });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  try {
    const setting = async (name) => (await pool.query(
      'SELECT setting, unit, source FROM pg_settings WHERE name = $1', [name])).rows[0];
    const idle = await setting('idle_in_transaction_session_timeout');
    assert.deepEqual([idle.setting, idle.unit, idle.source], ['30000', 'ms', 'client']);
    // Asked for by the pool on every session. A server whose OS lacks a TCP
    // option (TCP_USER_TIMEOUT on macOS; keepalives on a Unix socket)
    // reports 0 for it, which is all it can do there.
    for (const [name, value] of Object.entries(SERVER_KEEPALIVE)) {
      const got = await setting(name);
      assert.equal(got.source, 'client', `${name} is the session's own`);
      assert.ok([String(value), '0'].includes(got.setting), `${name} = ${got.setting}`);
    }
  } finally {
    await pool.end();
  }
});
