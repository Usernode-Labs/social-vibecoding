'use strict';

// #5463, the Needs you feed's half: a vote the server saved somewhere else
// (the change's own page, a notification's "Still yes") reads on the card it
// belongs to the same way a vote cast in the feed does — "Voted yes" or
// "Voted no", with the card holding its place.
//
// The match is EXECUTED (tests/lib/render-tsx.js `loadTsx`): `savedVoteFor`
// is the pure rule the feed's pin and its answered-mark both read, and which
// row it answers is exactly the kind of thing a source scan gets wrong. The
// wiring is pinned from source: the saved-vote effect records the answer and
// nothing more — it sets neither the advance (the feed does not move on a
// vote it did not cast) nor `onAnswered` (the screen that owns the store copy
// already heard it from the store).
//
// Run with: node --test tests/needs-feed-saved-vote.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');

const { savedVoteFor } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');

// A Needs you vote row: `args[2]` is the epoch castVote's third argument
// carries (needsRowKey's rule). Null when the row was built without one.
const row = (over = {}) => ({
  key: 'proposal:7@2',
  kind: 'vote',
  askAbout: { kind: 'proposal', ref: 7 },
  yes: { act: { fn: 'castVote', args: [7, 'yes', 2] } },
  no: { act: { fn: 'castVote', args: [7, 'no', 2] } },
  ...over,
});

test('a saved vote matches the change it was cast on, at the same epoch', () => {
  const saved = { 7: { vote: 'yes', epoch: 2, seq: 1 } };
  assert.equal(savedVoteFor(row(), saved), 'yes');
  assert.equal(savedVoteFor(row({ yes: { act: { args: [7, 'no', 2] } } }), { 7: { vote: 'no', epoch: 2, seq: 2 } }), 'no');
});

test('a newer epoch than the vote is a different vote and asks again', () => {
  const saved = { 7: { vote: 'yes', epoch: 2, seq: 1 } };
  assert.equal(savedVoteFor(row({ yes: { act: { args: [7, 'yes', 3] } } }), saved), null,
    'the card moved under the vote');
  assert.equal(savedVoteFor(row({ yes: { act: { args: [7, 'yes', 1] } } }), { 7: { vote: 'yes', epoch: 3, seq: 1 } }), null,
    'and so does a vote saved on a version the row does not show');
});

test('where either side has no epoch, the id alone decides', () => {
  assert.equal(savedVoteFor(row({ yes: { act: { args: [7, 'yes', null] } } }), { 7: { vote: 'yes', epoch: 2, seq: 1 } }), 'yes');
  assert.equal(savedVoteFor(row(), { 7: { vote: 'no', epoch: null, seq: 1 } }), 'no');
});

test('a group decision, a non-vote row and a missing vote match nothing', () => {
  const saved = { 4: { vote: 'yes', epoch: 2, seq: 1 }, 7: { vote: 'yes', epoch: 2, seq: 1 } };
  assert.equal(savedVoteFor(row({ askAbout: { kind: 'governance', ref: 4 } }), saved), null,
    'a governance row is a group decision, not a change vote');
  assert.equal(savedVoteFor(row({ kind: 'approve' }), saved), null,
    'an approval row is not voted on');
  assert.equal(savedVoteFor(row(), {}), null, 'nothing saved, nothing matches');
  assert.equal(savedVoteFor(row({ askAbout: null }), saved), null, 'a row addressed nowhere');
  assert.equal(savedVoteFor(null, saved), null, 'the end card is no row at all');
});

// ── The wiring ─────────────────────────────────────────────────────────

/** The source from `start` up to the first `end` after it. */
function body(src, start, end) {
  const at = src.indexOf(start);
  assert.ok(at >= 0, `${start} is still there`);
  return src.slice(at, src.indexOf(end, at));
}


// ── #6101: a change that merged under the card ─────────────────────────


// ── #6990: a group decision's saved vote leaves the Communities feed ──
//
// The sidebar's badge is dropped by Notifications.refresh(), but the
// Communities Needs you list kept the decision until a reload, so the two
// disagreed. The feed now hears the same saved vote (cards-store.ts
// govVoteSavedStore) and takes the item out with its counts.

test('a saved group decision leaves the Communities Needs you feed at once', async () => {
  const cards = loadTsx('frontend/src/features/dev-board/card/cards-store.ts');
  const screen = loadTsx('frontend/src/features/workshop/index.tsx', {
    stubs: { '../dev-board/card/cards-store': cards },
  });
  const feed = [
    { kind: 'governance', id: 9, title: 'Close it', number: null },
    { kind: 'proposal', id: 41, title: 'A change', number: 12, epoch: 2 },
  ];
  globalThis.fetch = async (url) => (String(url).includes('needs-feed')
    ? { ok: true, json: async () => ({ items: feed, max: 0 }) }
    : { ok: true, json: async () => ({ counts: {} }) });
  try {
    screen.workshopStore.set({ open: true, feed });
    cards.publishGovVoteSaved(9, 'yes');
    assert.deepEqual(
      screen.workshopStore.get().feed.map((i) => i.id),
      [41],
      'the decision leaves; the change still waiting stays',
    );
    // A read issued before the vote and landing after it cannot bring it back.
    await screen.workshopController.refreshNeeds();
    assert.deepEqual(screen.workshopStore.get().feed.map((i) => i.id), [41],
      'the answered key strips it from every later read too');
  } finally {
    delete globalThis.fetch;
  }
});
