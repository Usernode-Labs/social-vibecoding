'use strict';

// #6019 follow-up: a ballot in Needs you. Changes that would close the same
// request (and a vote to close it) are one card across projects, as they
// are one vote on the request's page; the feed's SQL and counts are pinned
// against PostgreSQL in thread-ballot-postgres.test.js.
//
// What this pins:
//   1. The server shapes a change's row with competing choices as one
//      `ballot` item, its choices in the page's order; a row without them
//      stays a change.
//   2. The card names the request, lists the choices (A, B, or close it),
//      opens the request's page (where the vote is), and is keyed by its
//      oldest change, the row the counts key it on.
//   3. Its eyebrow says Pick one.
//
// Run with: node --test tests/needs-ballot.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const REEL = 'frontend/src/features/workshop/needs-reel.tsx';

const row = (extra) => ({
  kind: 'proposal', id: 20, title: 'Toggle', author: 'bob', number: 20, epoch: 1, at: '2026-10-29T10:00:00Z',
  status: 'promoted', slug: 'seeds', name: 'Seeds', ...extra,
});

test('a change\'s row with competing choices is one ballot item', () => {
  const { shapeNeedsFeed } = require('../src/routes/workshop-overview');
  const options = [
    { id: 20, number: 20, title: 'Toggle', author: 'bob', epoch: 1 },
    { id: 21, number: 21, title: 'Schedule', author: 'cat', epoch: 0 },
  ];
  const [ballot] = shapeNeedsFeed([row({ ballot_options: options, ballot_close: null, ballot_for: { number: 7, title: 'Night mode' } })]);
  assert.equal(ballot.kind, 'ballot');
  assert.deepEqual(ballot.ballot.options.map((o) => o.id), [20, 21]);
  assert.deepEqual([ballot.ballot.number, ballot.ballot.title, ballot.ballot.close], [7, 'Night mode', null]);
  const [alone] = shapeNeedsFeed([row({ ballot_options: options.slice(0, 1), ballot_close: null })]);
  assert.equal(alone.kind, 'proposal', 'one change and no close is no ballot');
  const [withClose] = shapeNeedsFeed([row({ ballot_options: options.slice(0, 1), ballot_close: { id: 5, title: 'Close #7', reason: 'Done', author: 'dan' } })]);
  assert.equal(withClose.kind, 'ballot', 'a change and a close compete');
  assert.equal(withClose.ballot.close.id, 5);
});

test('its card names the request, lists the choices and opens the request\'s page', () => {
  const { reelRows } = loadTsx(REEL);
  const [card] = reelRows([{
    kind: 'ballot', id: 20, title: 'Toggle', summary: null, author: 'bob', number: 20, epoch: 1, at: '2026-10-29T10:00:00Z',
    yes: null, no: null, app: { slug: 'seeds', name: 'Seeds', icon_url: null, icon_emoji: null },
    ballot: {
      number: 7, title: 'Night mode', close: { id: 5, title: 'Close #7', reason: null, author: 'dan' },
      options: [{ id: 20, number: 20, title: 'Toggle', author: 'bob', epoch: 1 }, { id: 21, number: 21, title: 'Schedule', author: 'cat', epoch: 0 }],
    },
  }]);
  assert.equal(card.card.title.text, 'Night mode');
  assert.equal(card.card.attrs['data-issue-row'], '7', 'opens the request, where the vote is');
  assert.equal(card.card.attrs['data-ballot'], '20');
  assert.equal(card.yes, null);
  assert.match(card.summary, /^Pick one: A: Toggle.*B: Schedule.*or close it$/);
  assert.deepEqual(JSON.parse(JSON.stringify(card.askAbout)), { kind: 'proposal', ref: 20 }, 'keyed by its oldest change, as its count is');
  assert.equal(message('project:needsYou.eyebrow.ballot'), 'Pick one · Changes for one request');
});
