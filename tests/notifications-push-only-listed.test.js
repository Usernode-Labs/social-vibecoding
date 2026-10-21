'use strict';

// The live push carries only what the bell lists (21 Oct 2026). On a desktop
// a notification showed in the opened sheet for a moment and then vanished:
// the socket had pushed a row the feed never lists (news about a change that
// has merged, #4795/#5487, or a parked kind), and the next read of the feed
// dropped it. hydrateNotification now applies listForUser's own rules, so such
// a row reads as null and nothing is pushed or relayed.
//
// Run with: node --test tests/notifications-push-only-listed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const notifications = require('../src/services/notifications');

function stubPool(rows) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql: String(sql), params }); return { rows, rowCount: rows.length }; } };
}

test('the live read applies the feed\'s own rules: parked kinds and a merged change\'s rows are not listed', async () => {
  const pool = stubPool([]);
  assert.equal(await notifications.hydrateNotification(pool, 5), null, 'a row the bell does not list reads as null');
  const { sql, params } = pool.calls[0];
  assert.match(sql, /AND n\.kind NOT IN \('kudos'\)|AND TRUE/, 'the parked kinds');
  assert.match(sql, /AND NOT \(n\.kind = ANY\(\$2::text\[\]\) AND cs\.status IS NOT DISTINCT FROM 'merged'\)/);
  assert.equal(params[0], 5);
  // The same kinds listForUser hides (pinned there by its own suites).
  for (const kind of ['pr_merged', 'voted_change_merged', 'pr_proposed', 'change_ready', 'session_done']) {
    assert.ok(params[1].includes(kind), `${kind} leaves with its merged change`);
  }
});

test('nothing is pushed for a row the bell does not list', async (t) => {
  const wsPath = require.resolve('../src/services/ws');
  const saved = require.cache[wsPath];
  const pushes = [];
  require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: { pushNotificationToUser: (...a) => pushes.push(a) } };
  t.after(() => { if (saved) require.cache[wsPath] = saved; else delete require.cache[wsPath]; });
  await notifications.hydrateAndPush(stubPool([]), { id: 9 });
  assert.deepEqual(pushes, []);
});
