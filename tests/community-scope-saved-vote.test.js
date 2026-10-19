'use strict';

// #5468, the scope's half: a vote the server SAVED anywhere (the change's
// own page, a notification's "Still yes", a chat's proposal card, a Needs
// you feed) leaves the Communities tab's count, the switcher's "N to vote"
// and the sidebar's count the moment it lands — the card says "Voted yes"
// at once, and these numbers agree with it instead of waiting for the next
// read, which is throttled to thirty seconds and can be served from the
// service worker's cache with the pre-vote counts.
//
// The match is EXECUTED (tests/lib/render-tsx.js `loadTsx`): `owedLessSaved`
// is the pure rule `derive` strips with, and which key it answers is exactly
// the kind of thing a source scan gets wrong. The counts themselves are run
// through the real store, with cards-store shared into the scope the way the
// browser shares one module instance (the `stubs` pattern of
// tests/needs-seen.test.js).
//
// Run with: node --test tests/community-scope-saved-vote.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const CARDS = 'frontend/src/features/dev-board/card/cards-store.ts';
const SCOPE = 'frontend/src/features/workshop/community-scope.ts';
const SEEN = 'frontend/src/features/workshop/needs-seen.ts';

/** A browser's worth of window: an account and a storage. */
function fakeWindow(userId) {
  const store = new Map();
  globalThis.window = {
    App: { user: { id: userId } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    location: { search: '' },
  };
}

test.afterEach(() => { delete globalThis.window; delete globalThis.fetch; });

/** The scope against one shared cards-store (and seen record), as in the app. */
function loadScope({ withSeen = false } = {}) {
  const cards = loadTsx(CARDS);
  const stubs = { '../dev-board/card/cards-store': cards };
  if (withSeen) stubs['./needs-seen'] = loadTsx(SEEN);
  const scope = loadTsx(SCOPE, { stubs });
  return { cards, scope, seen: stubs['./needs-seen'] };
}

// ── The match ──────────────────────────────────────────────────────────

test('owedLessSaved matches the way savedVoteFor matches a card', () => {
  const { scope } = loadScope();
  const saved = { 7: { vote: 'yes', epoch: 2, seq: 1 } };
  assert.deepEqual(
    scope.owedLessSaved(['proposal:7@2', 'proposal:8@1'], saved),
    ['proposal:8@1'],
    'the same vote, at the same epoch, is answered',
  );
  assert.deepEqual(
    scope.owedLessSaved(['proposal:7', 'proposal:7@3'], saved),
    ['proposal:7@3'],
    'either side without an epoch is decided by the id; a newer epoch is the change moved under the vote, asking again',
  );
  assert.deepEqual(
    scope.owedLessSaved(['proposal:7@2'], { 7: { vote: 'yes', epoch: null, seq: 1 } }),
    [],
    'a vote saved without an epoch answers the id',
  );
  assert.deepEqual(
    scope.owedLessSaved(['governance:4', 'proposal:9@2'], { 4: { vote: 'yes', epoch: 2, seq: 1 }, 9: { vote: 'no', epoch: 2, seq: 2 } }),
    ['governance:4'],
    'a group decision is never answered here',
  );
  assert.deepEqual(scope.owedLessSaved(['proposal:7@2'], {}), ['proposal:7@2'], 'nothing saved, nothing answered');
});

// ── The counts ─────────────────────────────────────────────────────────

test('a saved vote lowers the tab, switcher and sidebar counts the moment it lands', () => {
  fakeWindow(7);
  const { cards, scope } = loadScope();
  scope.communityScopeStore.set({ list: ['a'], totalNeeds: 0, badgeNeeds: 0 });
  scope.describe('a', { owedCount: 2, owed: ['proposal:7@2', 'proposal:8@1'] });
  const st = () => scope.communityScopeStore.get();
  assert.equal(st().info.a.needs, 2);
  assert.equal(st().totalNeeds, 2);
  assert.equal(st().badgeNeeds, 2);

  cards.publishVoteSaved(7, 'yes', 2);
  assert.equal(st().info.a.needs, 1, 'the count drops by one, at once');
  assert.equal(st().totalNeeds, 1, 'the All communities line drops with it');
  assert.equal(st().badgeNeeds, 1, 'the tab\'s badge drops with it');

  // A re-publish of the same vote, and a second one for a vote already
  // saved: the stored count is what the describer handed in, so deriving
  // again cannot lower it twice.
  cards.publishVoteSaved(7, 'yes', 2);
  assert.equal(st().info.a.needs, 1);
  cards.publishVoteSaved(8, 'no', 1);
  assert.equal(st().info.a.needs, 0);
  assert.equal(st().totalNeeds, 0);
});

test('a vote cast on a mounted project page is not lowered twice', () => {
  fakeWindow(7);
  const { cards, scope } = loadScope();
  cards.publishVoteSaved(7, 'yes', 2);
  scope.communityScopeStore.set({ list: ['a'], totalNeeds: 0, badgeNeeds: 0 });
  // The page's describe hands in the queue it already dropped the row from.
  scope.describe('a', { owedCount: 1, owed: ['proposal:8@1'] });
  assert.equal(scope.communityScopeStore.get().info.a.needs, 1, 'stripping finds nothing more to remove');
});

test('a vote also passed over is never subtracted twice', () => {
  fakeWindow(7);
  const { cards, scope, seen } = loadScope({ withSeen: true });
  seen.hydrateNeedsSeen();
  seen.markNeedsSeen('a', 'proposal:8@1');
  scope.communityScopeStore.set({ list: ['a'], totalNeeds: 0, badgeNeeds: 0 });
  scope.describe('a', { owedCount: 2, owed: ['proposal:7@2', 'proposal:8@1'] });
  assert.equal(scope.communityScopeStore.get().info.a.needs, 1, 'the passed-over one is already out');
  cards.publishVoteSaved(7, 'yes', 2);
  assert.equal(scope.communityScopeStore.get().info.a.needs, 0, 'the saved one is stripped first, the seen one is not counted again');
});

test('an entry with a count but no list keeps its number, and a newer epoch counts again', () => {
  fakeWindow(7);
  const { cards, scope } = loadScope();
  cards.publishVoteSaved(7, 'yes', 2);
  scope.communityScopeStore.set({ list: ['b'], totalNeeds: 0, badgeNeeds: 0 });
  scope.describe('b', { owedCount: 3 });
  assert.equal(scope.communityScopeStore.get().info.b.needs, 3,
    'a count this cannot check is never lowered on a guess');
  scope.describe('c', { owedCount: 1, owed: ['proposal:7@3'] });
  assert.equal(scope.communityScopeStore.get().info.c.needs, 1,
    'the change moved to a newer epoch after the vote: it asks again');
});

test('a stale read that lands after the vote stays stripped', async () => {
  fakeWindow(7);
  const { cards, scope } = loadScope();
  cards.publishVoteSaved(7, 'yes', 2);
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/api/workshop/counts')) {
      // The service worker's cached copy: it still counts the vote cast.
      return { ok: true, json: async () => ({ counts: { a: { needs: 2, owed: ['proposal:7@2', 'proposal:8@1'] } } }) };
    }
    return { ok: true, json: async () => ([{ slug: 'a', name: 'A', is_member: true }]) };
  };
  await scope.loadCommunities(true);
  const st = scope.communityScopeStore.get();
  assert.deepEqual(st.info.a.owed, ['proposal:7@2', 'proposal:8@1'], 'the stored list stays what the read handed in');
  assert.equal(st.info.a.owedCount, 2);
  assert.equal(st.info.a.needs, 1, 'the count is worked out through the saved votes, so the stale read cannot bring it back');
  assert.equal(st.totalNeeds, 1);
  assert.equal(st.badgeNeeds, 1);
});