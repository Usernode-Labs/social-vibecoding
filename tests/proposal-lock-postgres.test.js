'use strict';

// The proposal lock (services/proposal-update.js withProposalLock) against
// PostgreSQL, from two pools as two processes: a second writer on the same
// session waits for the first to finish, one on another session does not.
// Every revision writer of a proposal takes it (a hand-off commit upload or
// build, a fork update, a description edit, an agent's update), so an older
// request can never land after a newer one on any process.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/proposal-lock-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the proposal lock orders one session\'s writers across processes', { timeout: 30000 }, async (t) => {
  const one = new Pool({ connectionString: DSN, max: 2, connectionTimeoutMillis: 2000 });
  try { await one.query('SELECT 1'); } catch (err) {
    await one.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const two = new Pool({ connectionString: DSN, max: 2 });
  t.after(async () => { await one.end(); await two.end(); });
  const { withProposalLock } = require('../src/services/proposal-update');
  // A session id no other suite's lock would use.
  const session = 900000000 + Math.floor(Math.random() * 1000000);

  const order = [];
  let releaseFirst;
  const gate = new Promise((r) => { releaseFirst = r; });
  let firstIn;
  const entered = new Promise((r) => { firstIn = r; });
  const first = withProposalLock(one, session, async () => { order.push('first:start'); firstIn(); await gate; order.push('first:end'); });
  await entered;
  const second = withProposalLock(two, session, async () => { order.push('second:start'); });
  // Another session's writer is not held up.
  assert.equal(await withProposalLock(two, session + 1, async () => 'other'), 'other');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(order, ['first:start'], 'the second process waits');
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
});
