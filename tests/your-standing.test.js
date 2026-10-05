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

test('challenge points the standings have not caught up with keep the card, with when they count (#3187)', () => {
  const { standingView, STANDINGS_UPDATE_NOTE } = loadTsx(STANDING);
  assert.equal(STANDINGS_UPDATE_NOTE(),
    'Standings update every few hours; points from challenges you just finished appear at the next update.');
  const empty = { ...RANKING, rank: null, total_points: 0 };
  const view = standingView({ status: 'ready', ranking: empty, breakdown: null, pending: 1500, revealed: false });
  assert.ok(view, 'someone with 1,500 challenge points still sees the card');
  assert.equal(view.rank, '–');
  assert.equal(view.pending, '1,500 pts earned, not in the standings yet');
  assert.equal(view.note, STANDINGS_UPDATE_NOTE());
  assert.equal(standingView({ status: 'ready', ranking: RANKING, breakdown: null, pending: 1500 }).pending, null,
    'a ranked viewer is not told about a pending figure the ranking already carries');
  assert.equal(standingView({ status: 'ready', ranking: RANKING, breakdown: null }).note, STANDINGS_UPDATE_NOTE(),
    'the card always says how often the standings move');

  const real = loadTsx(STANDING);
  const state = { status: 'ready', ranking: empty, breakdown: null, pending: 1500, revealed: false };
  const mod = loadTsx('frontend/src/features/leaderboard/your-standing.tsx', {
    stubs: { './my-standing.js': { ...real, myStandingStore: { get: () => state, subscribe: () => () => {} } } },
  });
  const html = renderToHtml(createElement(mod.YourStanding, {}));
  assert.match(html, /1,500 pts earned, not in the standings yet/);
  assert.match(html, /Standings update every few hours; points from challenges you just finished appear at the next update\./);
});

test('the ledger is read only when the standings have nothing for the viewer', async () => {
  const { MyStanding, myStandingStore, ledgerPoints } = loadTsx(STANDING);
  assert.equal(ledgerPoints([{ activities_total: 500 }, { activities_total: 1000 }, { activities_total: 0 }, {}]), 1500);
  assert.equal(ledgerPoints(null), 0);

  const realFetch = globalThis.fetch;
  const run = async (ranking) => {
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(url);
      let data = null;
      if (url.includes('/me/ranking')) data = ranking;
      else if (url.includes('/me/breakdown')) data = { scope: 'season', events: [] };
      else if (url.includes('/challenges-api/challenges?')) data = [{ activities_total: 500 }, { activities_total: 1000 }];
      return { ok: true, status: 200, json: async () => ({ success: true, data }) };
    };
    await MyStanding.load();
    return seen;
  };
  try {
    const seen = await run({ ...RANKING, season_id: 4, rank: null, total_points: 0 });
    assert.ok(seen.includes('/challenges-api/challenges?season_id=4'), 'the season the ranking resolved');
    assert.equal(myStandingStore.get().pending, 1500);
    const ranked = await run({ ...RANKING, season_id: 4 });
    assert.ok(!ranked.some((u) => u.startsWith('/challenges-api/challenges?')), 'no extra read for a ranked viewer');
    assert.equal(myStandingStore.get().pending, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
