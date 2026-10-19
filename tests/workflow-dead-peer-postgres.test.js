'use strict';

// A process lost with its node sends the server nothing: the sessions of its
// workflow runtime would keep a slot's row locks and a claim's advisory lock
// until the server's OS keepalive gave up (hours). The runtime's pool
// (src/workflow/platform.ts deadPeerOptions) makes every session reap a dead
// peer as the leader lock's does, and end a transaction its client stopped
// talking in.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the workflow runtime\'s sessions reap a dead peer and an abandoned transaction', async (t) => {
  const { deadPeerOptions } = require('../src/workflow/platform.ts');
  const { SERVER_KEEPALIVE, KEEPALIVE_INITIAL_DELAY_MS, serverReapSeconds } = require('../src/services/leadership');
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
    const show = async (name) => (await pool.query(`SELECT current_setting($1) AS v`, [name])).rows[0].v;
    assert.equal(await show('idle_in_transaction_session_timeout'), '30s');
    assert.equal(await show('tcp_keepalives_idle'), `${SERVER_KEEPALIVE.tcp_keepalives_idle}`);
    assert.equal(await show('tcp_keepalives_interval'), `${SERVER_KEEPALIVE.tcp_keepalives_interval}`);
    assert.equal(await show('tcp_keepalives_count'), `${SERVER_KEEPALIVE.tcp_keepalives_count}`);
    assert.match(await show('tcp_user_timeout'), new RegExp(`^${SERVER_KEEPALIVE.tcp_user_timeout}(ms)?$`));
  } finally {
    await pool.end();
  }
});
