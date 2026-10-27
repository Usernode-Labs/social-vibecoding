// The waitlist release email switch (#5971): services/release-mail-setting.js.
// Admin → Waitlist's Release email panel saves it; the admit routes read it
// (tests/topochain-admin-waitlist-batch.test.js runs that end).
//
// Run with: node --test tests/release-mail-setting.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const setting = require('../src/services/release-mail-setting');

function fakePool(rowsByCall) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const next = rowsByCall.shift();
      if (next instanceof Error) throw next;
      return { rows: next || [] };
    },
  };
}

test('the release email is on unless switched off, and on when the setting cannot be read', async () => {
  assert.equal(setting.RELEASE_MAIL_KEY, 'waitlist_release_email');
  assert.equal(await setting.releaseMailEnabled(fakePool([[]])), true, 'no row is the default: on');
  assert.equal(await setting.releaseMailEnabled(fakePool([[{ value: 'false' }]])), false);
  assert.equal(await setting.releaseMailEnabled(fakePool([[{ value: 'true' }]])), true);
  assert.equal(await setting.releaseMailEnabled(fakePool([new Error('relation does not exist')])), true);
});

test('a read is cached, and a save forgets the cache', async () => {
  const pool = fakePool([[{ value: 'true' }], [], [{ value: 'false' }]]);
  assert.equal(await setting.releaseMailEnabled(pool), true);
  assert.equal(await setting.releaseMailEnabled(pool), true);
  assert.equal(pool.calls.length, 1, 'the second read came from the cache');
  await setting.setReleaseMail(pool, { enabled: false, actorId: 9 });
  assert.deepEqual(pool.calls[1].params.slice(0, 2), ['waitlist_release_email', 'false']);
  assert.equal(pool.calls[1].params[3], 9);
  assert.equal(await setting.releaseMailEnabled(pool), false);
});
