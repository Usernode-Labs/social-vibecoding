'use strict';

// #5466, the project page's half: a vote the server SAVED anywhere (the
// Communities feed, the change's own page, a notification's "Still yes")
// leaves the project's kept queue the moment it lands — the hub's "For you"
// card and its "1 to vote", the places list's Needs you count and the Needs
// you deck itself all agree with the vote at once, instead of waiting for
// the next read (which `refreshDevData` never starts off the dev tab) or a
// page reload.
//
// The strip is EXECUTED (tests/lib/render-tsx.js `loadTsx`):
// `withoutSavedVotes` is the pure rule both the module-level listener over
// `devWorkshopStore` and mount.ts `publishWorkshop` run the queue through,
// and which row it drops is exactly the kind of thing a source scan gets
// wrong. The listener itself is run through the REAL publish path, with
// cards-store shared into the screen the way the browser shares one module
// instance (the `stubs` pattern of tests/community-scope-saved-vote.test.js).
//
// Run with: node --test tests/dev-workshop-saved-vote.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const CARDS = 'frontend/src/features/dev-board/card/cards-store.ts';
const WORKSHOP = 'frontend/src/features/dev-board/workshop/workshop.tsx';

/** The workshop screen against one shared cards-store, as in the app. */
function loadWorkshop() {
  const cards = loadTsx(CARDS);
  const ws = loadTsx(WORKSHOP, { stubs: { '../card/cards-store': cards } });
  return { cards, ws };
}

// A queue row, in the shape `_workshopView` builds: `args[2]` is the epoch
// castVote's third argument carries (savedVoteFor's rule). Null when the row
// was built without one.
const row = (id, epoch, over = {}) => ({
  t: 'card', key: `vote:proposal:${id}${epoch == null ? '' : '@' + epoch}`,
  kind: 'vote', ask: 'Should this change go in?',
  askAbout: { kind: 'proposal', ref: id },
  yes: { label: 'Yes', act: { fn: 'castVote', args: [id, 'yes', epoch] } },
  no: { label: 'No', act: { fn: 'castVote', args: [id, 'no', epoch] } },
  ...over,
});

// A group decision: a governance row, never a change vote.
const governanceRow = () => ({
  t: 'card', key: 'vote:governance:4', kind: 'vote', ask: 'Change the rule?',
  askAbout: { kind: 'governance', ref: 4 },
  yes: { label: 'Yes', act: { fn: 'castGovernanceVote', args: [4, 'yes'] } },
  no: { label: 'No', act: { fn: 'castGovernanceVote', args: [4, 'no'] } },
});

// ── The strip ──────────────────────────────────────────────────────────

test('withoutSavedVotes drops exactly the rows a saved vote answers', () => {
  const { ws } = loadWorkshop();
  const saved = { 7: { vote: 'yes', epoch: 2 } };
  const voted = row(7, 2);
  const newer = row(7, 3);
  const gov = governanceRow();
  const other = row(8, 1);
  const queue = [voted, newer, gov, other];
  assert.deepEqual(
    ws.withoutSavedVotes(queue, saved),
    [newer, gov, other],
    'the same vote at the same epoch leaves; a newer epoch is the change moved under the vote and asks again, and a group decision stays',
  );
  assert.deepEqual(ws.withoutSavedVotes([voted, other], saved), [other]);
  assert.deepEqual(
    ws.withoutSavedVotes(queue, { 7: { vote: 'yes', epoch: null } }),
    [gov, other],
    'a vote saved without an epoch answers the id, whatever epoch the row shows',
  );
});

test('withoutSavedVotes strips nothing when nothing matches, and returns the same array', () => {
  const { ws } = loadWorkshop();
  const queue = [row(7, 2), governanceRow()];
  assert.equal(ws.withoutSavedVotes(queue, {}), queue, 'nothing saved, nothing to strip');
  assert.equal(ws.withoutSavedVotes(queue, null), queue, 'no store copy, nothing to strip');
  assert.equal(ws.withoutSavedVotes(queue, { 9: { vote: 'yes', epoch: 2 } }), queue,
    'a saved vote for a change the queue does not hold answers no row here');
  assert.deepEqual(ws.withoutSavedVotes(null, { 7: { vote: 'yes', epoch: 2 } }), []);
});

// ── The listener ───────────────────────────────────────────────────────

test('a saved vote drops its row from the kept queue the moment it lands', () => {
  const { cards, ws } = loadWorkshop();
  cards.devWorkshopStore.set({ queue: [row(7, 2), row(8, 1), row(7, 3)] });
  const keys = () => cards.devWorkshopStore.get().queue.map((r) => r.key);
  cards.publishVoteSaved(7, 'yes', 2);
  assert.deepEqual(keys(), ['vote:proposal:8@1', 'vote:proposal:7@3'],
    'the same-epoch row leaves at once; the newer epoch stays and asks again');
  // A re-publish of the same vote strips nothing more, and a second saved
  // vote strips its own row.
  cards.publishVoteSaved(7, 'yes', 2);
  assert.deepEqual(keys(), ['vote:proposal:8@1', 'vote:proposal:7@3']);
  cards.publishVoteSaved(8, 'no', 1);
  assert.deepEqual(keys(), ['vote:proposal:7@3']);
});

test('a group decision in the kept queue is never stripped', () => {
  const { cards, ws } = loadWorkshop();
  cards.devWorkshopStore.set({ queue: [governanceRow(), row(9, 2)] });
  cards.publishVoteSaved(4, 'yes', 2);
  cards.publishVoteSaved(9, 'yes', 2);
  assert.deepEqual(
    cards.devWorkshopStore.get().queue.map((r) => r.key),
    ['vote:governance:4'],
    'only the change vote leaves',
  );
});

test('a saved vote before any publish paints no queue into the store', () => {
  const { cards, ws } = loadWorkshop();
  cards.publishVoteSaved(7, 'yes', 2);
  assert.ok(!('queue' in cards.devWorkshopStore.get()),
    'nothing was published yet, so there was nothing kept to strip — the listener leaves the store alone');
});
