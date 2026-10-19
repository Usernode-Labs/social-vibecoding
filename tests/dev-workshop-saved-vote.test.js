'use strict';

// #5466, the project page's half: a vote the server SAVED somewhere else (the
// Communities feed, a notification's "Still yes", a card in Messages) leaves
// the project's own kept queue at once, so its Hub's "For you" row, its
// "to vote" count beside Needs you and its Needs you deck agree with the vote
// without waiting for a page to read again. `refreshDevData` no-ops off the
// dev tab, and `_publishWorkshop` only publishes while the board is up, so
// nothing else was stripping the row.
//
// The match is EXECUTED (tests/lib/render-tsx.js `loadTsx`) against ONE shared
// cards-store, as the browser shares one module instance: `withoutSavedVotes`
// is the pure rule, and the module-level listener's republish is driven
// through the real `publishVoteSaved`.
//
// Run with: node --test tests/dev-workshop-saved-vote.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const CARDS = 'frontend/src/features/dev-board/card/cards-store.ts';
const WORKSHOP = 'frontend/src/features/dev-board/workshop/workshop.tsx';

/** A Needs you vote row: `args[2]` is the epoch castVote's third argument. */
const row = (id, epoch = 2) => ({
  t: 'card',
  key: `vote:proposal:${id}`,
  kind: 'vote',
  askAbout: { kind: 'proposal', ref: id },
  yes: { act: { fn: 'castVote', args: [id, 'yes', epoch] } },
  no: { act: { fn: 'castVote', args: [id, 'no', epoch] } },
});

/** A group decision: the same shape, but never a change vote. */
const govRow = (id) => ({
  t: 'card',
  key: `vote:governance:${id}`,
  kind: 'vote',
  askAbout: { kind: 'governance', ref: id },
  yes: { act: { fn: 'castGovVote', args: [id, 'yes', 2] } },
  no: { act: { fn: 'castGovVote', args: [id, 'no', 2] } },
});

/** The Workshop against one shared cards-store, as in the app. */
function load() {
  const cards = loadTsx(CARDS);
  const workshop = loadTsx(WORKSHOP, { stubs: { '../card/cards-store': cards } });
  return { cards, workshop };
}

// ── The rule ───────────────────────────────────────────────────────────

test('withoutSavedVotes drops the row a saved vote answers and keeps the rest', () => {
  const { workshop } = load();
  const queue = [row(7), row(8)];
  assert.deepEqual(
    workshop.withoutSavedVotes(queue, { 7: { vote: 'yes', epoch: 2, seq: 1 } }).map((r) => r.key),
    ['vote:proposal:8'],
  );
});

test('withoutSavedVotes keeps a row at a newer epoch, and every group decision', () => {
  const { workshop } = load();
  const queue = [row(7, 3), govRow(4)];
  assert.deepEqual(
    workshop.withoutSavedVotes(queue, {
      7: { vote: 'yes', epoch: 2, seq: 1 },
      4: { vote: 'yes', epoch: 2, seq: 2 },
    }).map((r) => r.key),
    ['vote:proposal:7', 'vote:governance:4'],
    'the change moved under the vote and asks again; a group decision is never answered by a change vote',
  );
});

test('withoutSavedVotes returns the same array when nothing matches', () => {
  const { workshop } = load();
  const queue = [row(7), row(8)];
  assert.equal(workshop.withoutSavedVotes(queue, {}), queue, 'nothing saved, nothing republished');
  assert.equal(workshop.withoutSavedVotes(queue, { 9: { vote: 'no', epoch: 2, seq: 1 } }), queue);
});

// ── The republish ──────────────────────────────────────────────────────

test('a saved vote strips the project queue wherever it was cast', () => {
  const { cards } = load();
  const queue = [row(7), row(8), govRow(4)];
  cards.devWorkshopStore.set({ queue });
  cards.publishVoteSaved(7, 'yes', 2);
  assert.deepEqual(
    cards.devWorkshopStore.get().queue.map((r) => r.key),
    ['vote:proposal:8', 'vote:governance:4'],
    'the voted proposal leaves the kept queue, the others stay',
  );
  assert.equal(cards.devWorkshopStore.get().loading, true, 'a patch: every other key of the publish is kept');
});

test('a saved vote at a newer epoch leaves the queue alone', () => {
  const { cards } = load();
  const queue = [row(7, 3)];
  cards.devWorkshopStore.set({ queue });
  cards.publishVoteSaved(7, 'yes', 2);
  assert.equal(cards.devWorkshopStore.get().queue, queue, 'the change moved under the vote, so it still asks');
});

test('publishing a vote that answers nothing does not republish', () => {
  const { cards } = load();
  const queue = [row(8)];
  cards.devWorkshopStore.set({ queue });
  const before = cards.devWorkshopStore.get();
  cards.publishVoteSaved(7, 'yes', 2);
  assert.equal(cards.devWorkshopStore.get(), before, 'no matching row, no store write at all');
});
