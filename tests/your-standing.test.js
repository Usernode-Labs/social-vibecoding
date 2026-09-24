// The Challenges tab's "your standing" card (the prototype's first card on
// its Challenges page: "Season 3 · #3 · 9 pts · you"), which is where the
// Me screen's points, rank, per-event breakdown and token allocation went
// when Me became the prototype's compact page.
//
// Run with: node --test tests/your-standing.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const STANDING = 'frontend/src/features/leaderboard/my-standing.js';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const RANKING = {
  scope: 'season', season_name: 'Season 3', rank: 3, total_points: 1750,
  total_participants: 12, terms_accepted: true, total_tokens: 0,
};
const BREAKDOWN = { scope: 'season', events: [{ event: { name: 'Week 1' }, total_points: 900 }], offchain_points: 0 };

test('it says the season, the rank and the points — or nothing at all', () => {
  const { standingView } = loadTsx(STANDING);
  const view = standingView({ status: 'ready', ranking: RANKING, breakdown: BREAKDOWN, revealed: false });
  assert.equal(view.season, 'Season 3');
  assert.equal(view.sub, '12 taking part');
  assert.equal(view.rank, '#3');
  assert.equal(view.detail, '1,750 pts · you');
  assert.deepEqual(view.breakdown.map((r) => [r.label, r.points]), [['Week 1', '900 pts']]);
  assert.equal(view.token.empty, true, 'no allocation: the token line is not drawn');
  for (const state of [
    { status: 'idle', ranking: null },
    { status: 'none', ranking: null },
    { status: 'ready', ranking: { ...RANKING, rank: null, total_points: 0 } },
  ]) {
    assert.equal(standingView(state), null, `${state.status}: no card rather than "#– · 0 pts"`);
  }
});

test('the reads are the ones Me made, and the Reveal is remembered under the SAME key', () => {
  const src = read(STANDING);
  assert.match(src, /\/challenges-api\/me\/ranking\?season_id=active/);
  assert.match(src, /\/challenges-api\/me\/breakdown\?season_id=active&include_activity=0&include_progress=0/);
  const { REVEAL_KEY } = loadTsx(STANDING);
  assert.equal(REVEAL_KEY, 'sv:profile_tokens_revealed',
    'someone who revealed the figure on Me is not asked again because it moved');
});

test('the card renders inside the grid, with the breakdown behind a disclosure', () => {
  const real = loadTsx(STANDING);
  const state = { status: 'ready', ranking: { ...RANKING, total_tokens: 4200 }, breakdown: BREAKDOWN, revealed: false };
  const mod = loadTsx('frontend/src/features/leaderboard/your-standing.tsx', {
    stubs: { './my-standing.js': { ...real, myStandingStore: { get: () => state, subscribe: () => () => {} } } },
  });
  const html = renderToHtml(createElement(mod.YourStanding, {}));
  assert.match(html, /<section id="lb-your-standing" aria-label="Your standing"/);
  assert.match(html, />#3</);
  assert.match(html, /<details[^>]*><summary[^>]*>Points by event<\/summary>/);
  assert.match(html, /Token allocation/);
  assert.match(html, /blur-md select-none/, 'blurred until the one-time Reveal');
  const pane = read('frontend/src/features/leaderboard/challenges-pane.tsx');
  const grid = pane.slice(pane.indexOf('<div id="tc-se-grid"'), pane.indexOf('<Grid view={state.grid} />'));
  assert.match(grid, /<YourStanding \/>/, 'first in #tc-se-grid, so it steps aside with a challenge page');
});
