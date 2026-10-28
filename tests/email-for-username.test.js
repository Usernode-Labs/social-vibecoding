// The address a username's code goes to (services/email-signup.js
// emailForUsername): the sign-in sheet's one field takes a username, and an
// account with no password signs in with an emailed code. The route end of it
// runs against Postgres in tests/email-signup-postgres.test.js.
//
// Run with: node --test tests/email-for-username.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { emailForUsername } = require('../src/services/email-signup');

function fakePool(rowsByCall) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: rowsByCall.shift() || [] };
    },
  };
}

test('a live username gives its account\'s address, matched as sign-in matches it', async () => {
  const pool = fakePool([[{ email: 'Ada@Example.com' }]]);
  assert.equal(await emailForUsername(pool, '  @ada '), 'ada@example.com');
  assert.equal(pool.calls.length, 1);
  assert.deepEqual(pool.calls[0].params, ['ada']);
  assert.match(pool.calls[0].sql, /WHERE LOWER\(username\) = LOWER\(\$1\) AND NOT is_synthetic\s+ORDER BY \(username = \$1\) DESC, id ASC/);
});

test('a retired handle is looked up when no live account wears it', async () => {
  const pool = fakePool([[], [{ email: 'old@example.com' }]]);
  assert.equal(await emailForUsername(pool, 'oldname'), 'old@example.com');
  assert.match(pool.calls[1].sql, /FROM username_history h\s+JOIN users u ON u\.id = h\.user_id/);
});

test('no account, or one with no address, gives null', async () => {
  assert.equal(await emailForUsername(fakePool([[], []]), 'nobody'), null);
  assert.equal(await emailForUsername(fakePool([[{ email: null }]]), 'phoney'), null);
});

test('nothing that is not a username is looked up', async () => {
  for (const raw of [undefined, null, '', '   ', '@', 'ada@example.com', 'x'.repeat(65), 42]) {
    const pool = fakePool([]);
    assert.equal(await emailForUsername(pool, raw), null, String(raw));
    assert.equal(pool.calls.length, 0, String(raw));
  }
});
