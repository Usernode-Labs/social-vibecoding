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

test('the saved-vote effect records the answer and moves nothing, tells nobody', () => {
  const feed = body(WORKSHOP, 'function NeedsFeed(', '\nfunction GroupStrip(');
  const block = body(feed, '// #5463: a saved vote that reaches this feed from the store', 'The vote sheet\'s send')
    // Comments name what the effect deliberately does not touch; the code
    // below them is what the assertion reads.
    .replace(/\/\/.*$/mg, '');
  assert.match(block, /useLayoutEffect\(\(\) => \{/, 'the effect is wired');
  assert.match(block, /savedVoteFor\(r, savedAll\)/, 'the match is the pure helper');
  assert.ok(!block.includes('advanceRef'), 'the feed does not move on a vote it did not cast');
  assert.ok(!block.includes('onAnswered'), 'the controller already heard it from the store');
  // The row holds the slot it had, so the confirmation does not shift the
  // list under the viewer (the same rule a row answered here follows).
  assert.match(feed, /if \(!savedVoteFor\(prior, savedAll\)\) continue;/,
    'a row voted elsewhere is pinned at its old index');
});