'use strict';

// #5483: a Yes the server saved clears the inbox rows that asked for it, and
// the read after it asks past the service worker's copy from before the vote.
//
//   1. voteSaved marks read the four kinds the server clears on a vote
//      (services/notifications.js, `vote_cast`) for that change only, lowers
//      unread by what it flipped, and re-renders;
//   2. it then reads the feed with `cache: 'no-cache'`, so a slow connection
//      cannot be answered with the saved pre-vote copy;
//   3. a plain refresh still sends no init at all, and networkOnly still sends
//      `no-store` with its invalidation params.
//
// Run with: node --test tests/notifications-vote-saved.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');

let N = null;
function controller() {
  if (N) return N;
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.PlatformI18n = englishPlatformI18n();
  if (!globalThis.location) globalThis.location = { search: '' };
  loadTsx('frontend/src/features/notifications/notifications.js');
  N = globalThis.window.Notifications;
  assert.equal(typeof N.voteSaved, 'function');
  // Other tests in this file stub the controller's own methods; keep the
  // real refresh for the one test that reads the request it sends.
  N.__realRefresh = N.refresh;
  return N;
}

const AT = new Date(Date.now() - 4 * 60 * 1000).toISOString();

test('a saved Yes clears the four vote-ask rows for its change, and only those', async () => {
  const Notifications = controller();
  Notifications.items = [
    { id: 1, kind: 'pr_proposed', sessionId: 41, readAt: null },
    { id: 2, kind: 'stale_pr', sessionId: 41, readAt: null },
    { id: 3, kind: 'revision_recheck', sessionId: 41, readAt: null },
    { id: 4, kind: 'change_ready', sessionId: '41', readAt: null },
    // Not the server's vote_cast set: the digest is settled by its fresh
    // copy, a vote row is somebody else's vote, and the other change's ask
    // is not this vote's to answer.
    { id: 5, kind: 'vote_digest', sessionId: 41, readAt: null },
    { id: 6, kind: 'proposal_vote', sessionId: 41, readAt: null },
    { id: 7, kind: 'revision_recheck', sessionId: 42, readAt: null },
    // Already read: nothing to flip, nothing to count.
    { id: 8, kind: 'revision_recheck', sessionId: 41, readAt: AT },
  ];
  Notifications.unread = 7;
  let rendered = 0;
  Notifications._renderBadge = () => { rendered += 1; };
  Notifications._renderList = () => { rendered += 1; };
  Notifications._reconcileCompletionTitle = () => { rendered += 1; };
  const reads = [];
  Notifications.refresh = (options) => { reads.push(options); return Promise.resolve(true); };

  assert.equal(await Notifications.voteSaved(41), true);

  const byId = new Map(Notifications.items.map((n) => [n.id, n]));
  for (const id of [1, 2, 3, 4]) assert.ok(byId.get(id).readAt, `row ${id} is answered`);
  for (const id of [5, 6, 7]) assert.equal(byId.get(id).readAt, null, `row ${id} is left as it was`);
  assert.equal(byId.get(8).readAt, AT, 'a read row keeps its own stamp');
  assert.equal(Notifications.unread, 3, 'unread drops by the four rows actually flipped');
  assert.equal(rendered, 3, 'the badge and the list are repainted');
  assert.deepEqual(reads, [{ fresh: true }], 'and the feed is read past the saved copy');
});

test('a bad id does nothing at all', async () => {
  const Notifications = controller();
  Notifications.items = [{ id: 1, kind: 'revision_recheck', sessionId: 41, readAt: null }];
  Notifications.unread = 1;
  let rendered = 0;
  Notifications._renderBadge = () => { rendered += 1; };
  Notifications._renderList = () => { rendered += 1; };
  Notifications._reconcileCompletionTitle = () => { rendered += 1; };
  let reads = 0;
  Notifications.refresh = () => { reads += 1; return Promise.resolve(true); };

  for (const bad of [0, -1, 1.5, 'nope', null, undefined, Infinity]) {
    assert.equal(await Notifications.voteSaved(bad), false, `${bad} is not a change id`);
  }
  assert.equal(Notifications.items[0].readAt, null);
  assert.equal(Notifications.unread, 1);
  assert.equal(rendered, 0);
  assert.equal(reads, 0);
});

test('refresh({ fresh: true }) asks past the saved copy; a plain refresh sends no init', async () => {
  const Notifications = controller();
  Notifications.refresh = Notifications.__realRefresh;
  Notifications._networkFreshnessFloor = false;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({ notifications: [] }) };
  };

  await Notifications.refresh({ fresh: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].init, { credentials: 'same-origin', cache: 'no-cache' },
    'a fresh read is answered by the network, and a cached copy only if the network fails');

  await Notifications.refresh();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init, undefined, 'a plain call passes no init, as before');

  await Notifications.refresh({ networkOnly: true });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].init.cache, 'no-store');
  assert.match(calls[2].url, /native_invalidation=1&native_invalidation_nonce=/,
    'the network-only path keeps its invalidation params');
});
