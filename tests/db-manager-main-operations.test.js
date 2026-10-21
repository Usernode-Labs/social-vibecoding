'use strict';

// The connections db-manager opens outside the pools to the main server, at
// most DB_ADMIN_CONNECTIONS_MAX operations at a time per process (item 4, the
// connection budget): the rest wait their turn; an operation's nested
// connections (a clone's psql, pg_restore beside pg_dump) run in its turn
// and never wait on it; the preview server's are not counted.
//
// Run with: node --test tests/db-manager-main-operations.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

test('at most the cap at once on the main server; nesting never waits on itself; the preview server is apart', async () => {
  const db = require('../src/services/db-manager');
  const cap = db.MAIN_SERVER_OPERATIONS;
  assert.equal(cap, 4);
  let now = 0;
  let most = 0;
  const op = (server) => db._onMainServer(server, async () => {
    now += 1; most = Math.max(most, now);
    // A nested connection in the same turn.
    const nested = await db._onMainServer(server, async () => 'nested');
    await new Promise((r) => setTimeout(r, 20));
    now -= 1;
    return nested;
  });
  const out = await Promise.all(Array.from({ length: 10 }, () => op('primary')));
  assert.deepEqual(out, Array(10).fill('nested'));
  assert.equal(most, cap, `at most ${cap} at once (saw ${most})`);
  assert.equal(db._mainOperations.running, 0, 'every turn given back');

  // The preview server's are another server's budget.
  most = 0;
  await Promise.all(Array.from({ length: 6 }, () => op('preview')));
  assert.equal(most, 6);

  // A failed operation gives its turn back.
  await assert.rejects(db._onMainServer('primary', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(db._mainOperations.running, 0);
});
