// The Challenges tab's "your standing" card: "#22 of 161 people". It is where
// the Me screen's rank and token allocation went when Me became the
// prototype's compact page. The Semi design (2026-10-16) took the season off
// it: no season name, no update note and no points by event. #5473 brought
// the update note back, shorter and with the right timing: a rank moves when
// others earn points, and the card now says so.
//
// Run with: node --test tests/your-standing.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const STANDING = 'frontend/src/features/leaderboard/my-standing.js';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const RANKING = {
  scope: 'season', season_name: 'Season 3', rank: 3, total_points: 1750,
  total_participants: 12, terms_accepted: true, total_tokens: 0,
};

test('it says the rank among how many people, or nothing at all', () => {
  const { standingView } = loadTsx(STANDING);
  const view = standingView({ status: 'ready', ranking: RANKING, revealed: false });
  assert.equal(view.rank, 3);
  assert.equal(view.people, 12);
  assert.equal(view.pending, null);
  assert.equal(view.token.empty, true, 'no allocation: the token line is not drawn');
  for (const gone of ['season', 'sub', 'detail', 'note', 'breakdown']) {
    assert.equal(gone in view, false, `no ${gone}: the card names no season and keeps no breakdown`);
  }
  assert.equal(standingView({ status: 'ready', ranking: { ...RANKING, total_participants: null } }).people, 0,
    'an unknown count is 0, which the card leaves out');
  for (const state of [
    { status: 'idle', ranking: null },
    { status: 'none', ranking: null },
    { status: 'ready', ranking: { ...RANKING, rank: null, total_points: 0 } },
  ]) {
    assert.equal(standingView(state), null, `${state.status}: no card rather than "#–"`);
  }
});

test('the read is the ranking Me made, and the Reveal is remembered under the SAME key', () => {
  const src = read(STANDING);
  assert.match(src, /\/challenges-api\/me\/ranking\?season_id=active/);
  assert.doesNotMatch(src, /\/challenges-api\/me\/breakdown/, 'no breakdown read: nothing draws points by event');
  const { REVEAL_KEY } = loadTsx(STANDING);
  assert.equal(REVEAL_KEY, 'sv:profile_tokens_revealed',
    'someone who revealed the figure on Me is not asked again because it moved');
});

const renderCard = (state) => {
  const real = loadTsx(STANDING);
  const mod = loadTsx('frontend/src/features/leaderboard/your-standing.tsx', {
    stubs: { './my-standing.js': { ...real, myStandingStore: { get: () => state, subscribe: () => () => {} } } },
  });
  return renderToHtml(createElement(mod.YourStanding, {}));
};

test('the card reads "#3 of 12 people", inside the grid', () => {
  const html = renderCard({ status: 'ready', ranking: { ...RANKING, total_tokens: 4200 }, revealed: false });
  assert.match(html, /<section id="lb-your-standing" aria-label="Your standing"/);
  assert.match(html, /<span class="[^"]*text-2xl[^"]*">#3<\/span> of 12 people<\/p>/,
    'the rank drawn large, among how many people, in one message');
  assert.equal(message('leaderboard:standing.rankOf', { rank: 3, count: 12, number: '12' }), '<0>#3</0> of 12 people');
  // #3226: one line on what points are for, under the rank, before the tokens.
  const pointsNote = message('leaderboard:standing.pointsNote');
  assert.equal(pointsNote, 'Your place comes from the points you earn in challenges.');
  assert.ok(html.indexOf(pointsNote) > html.indexOf('of 12 people'), 'after the rank');
  assert.ok(html.indexOf(pointsNote) < html.indexOf('Token allocation'), 'before the token block');
  // #5473: under the points note, why the place can move with no activity,
  // and how soon the standings catch up.
  const updateNote = message('leaderboard:standing.updateNote');
  assert.equal(updateNote,
    'Your place updates within about 10 minutes whenever anyone earns points, so it can move even when you did nothing.');
  assert.ok(html.indexOf(updateNote) > html.indexOf(pointsNote), 'after the points note');
  assert.ok(html.indexOf(updateNote) < html.indexOf('Token allocation'), 'before the token block');
  assert.doesNotMatch(html, /Season 3|taking part|pts · you|Standings update|Points by event|<details/,
    'no season, no update note, no points by event');
  assert.match(html, /Token allocation/);
  assert.match(html, /blur-md select-none/, 'blurred until the one-time Reveal');
  assert.match(renderCard({ status: 'ready', ranking: { ...RANKING, total_participants: 0 } }),
    /<span class="[^"]*text-2xl[^"]*">#3<\/span><\/p>/, 'no count known: the rank alone');
  const pane = read('frontend/src/features/leaderboard/challenges-pane.tsx');
  const grid = pane.slice(pane.indexOf('<div id="tc-se-grid"'), pane.indexOf('<Grid view={state.grid} />'));
  assert.match(grid, /<YourStanding \/>/, 'first in #tc-se-grid, so it steps aside with a challenge page');
});

test('challenge points the standings have not caught up with keep the card (#3187)', () => {
  const { standingView } = loadTsx(STANDING);
  const empty = { ...RANKING, rank: null, total_points: 0 };
  const view = standingView({ status: 'ready', ranking: empty, pending: 1500, revealed: false });
  assert.ok(view, 'someone with 1,500 challenge points still sees the card');
  assert.equal(view.rank, null);
  assert.equal(view.pending, '1,500 pts earned, not in the standings yet');
  assert.equal(standingView({ status: 'ready', ranking: RANKING, pending: 1500 }).pending, null,
    'a ranked viewer is not told about a pending figure the ranking already carries');

  const html = renderCard({ status: 'ready', ranking: empty, pending: 1500, revealed: false });
  assert.match(html, />Your standing<\/span>/, 'no rank yet: the card names itself');
  assert.match(html, /1,500 pts earned, not in the standings yet/);
  assert.match(html, /Your place comes from the points you earn in challenges\./,
    'the points note is there in the pending state too');
  assert.ok(html.indexOf(message('leaderboard:standing.updateNote')) > -1,
    'the update note (#5473) is there in the pending state too, under the points note');
  assert.doesNotMatch(html, /Standings update/, 'the old "every few hours" wording stays gone');
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
    assert.deepEqual(ranked, ['/challenges-api/me/ranking?season_id=active'], 'one read in all');
    assert.equal(myStandingStore.get().pending, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
