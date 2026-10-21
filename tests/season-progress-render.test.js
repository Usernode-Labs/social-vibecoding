'use strict';

// The summary over the Challenges tab's grid (the Semi design, 2026-10-16):
// one line, "3,500 pts · 4 of 11 done", over one bar of done out of all. No
// season, no event, no scope and no second points line.
//
// Run with: node --test tests/season-progress-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const { renderComponent } = require('./lib/render-tsx');

const FILE = 'frontend/src/features/leaderboard/season-progress.tsx';
const render = (view, extra = {}) => renderComponent(FILE, 'SeasonProgress', { view, ...extra });
const count = (html, re) => (html.match(re) || []).length;

test('one line: the points in bold, then how many are done', () => {
  const html = render({ done: 4, total: 11, points: 3500 }, { id: 'x' });
  assert.match(html, /<p id="x" class="[^"]*"><span class="[^"]*font-semibold[^"]*">3,500 pts<\/span> · 4 of 11 done<\/p>/);
  assert.equal(message('leaderboard:progress.summary', { points: '3,500 pts', done: 4, count: 11 }),
    '<0>3,500 pts</0> · 4 of 11 done', 'one message, the points its one tag');
  assert.match(html,
    /role="meter" aria-valuemin="0" aria-valuemax="11" aria-valuenow="4" aria-label="4 of 11 done"/);
  assert.equal(count(html, /role="meter"/g), 1, 'one bar');
  assert.equal(count(html, /h-\[5px\]/g), 1, 'one continuous track, never a segment per challenge');
  assert.match(html, /style="width:36%"/);
  assert.match(html, /bg-violet-700/, 'violet while challenges are left');
  assert.doesNotMatch(html, /<svg/, 'divs, not a glyph outside icons.tsx');
});

test('no season, no event, no scope, whatever the caller hands along', () => {
  const html = render({ done: 2, total: 3, points: 0, scope: 'season', name: 'Season 2' });
  assert.doesNotMatch(html, /Season|event|First challenges|earned/);
  assert.match(html, />0 pts<\/span> · 2 of 3 done</, 'a known zero is said');
});

test('points not known: the count alone', () => {
  for (const points of [null, undefined, { earned: 1, total: 2 }, 'many']) {
    const html = render({ done: 2, total: 3, points });
    assert.match(html, /<p class="[^"]*">2 of 3 done<\/p>/, `points ${JSON.stringify(points)}`);
    assert.doesNotMatch(html, /pts/);
  }
});

test('nothing at zero, and the figure never runs past the total', () => {
  assert.equal(render({ done: 0, total: 0, points: 10 }), '');
  const over = render({ done: 12, total: 9, points: 900 });
  assert.match(over, /9 of 9 done/);
  assert.match(over, /aria-valuenow="9"/);
  const none = render({ done: 0, total: 4, points: 0 });
  assert.match(none, /style="width:0%"/, 'nobody has started: no fill');
});

test('every challenge done, the bar is the cards\' green', () => {
  const html = render({ done: 9, total: 9, points: 2000 });
  assert.match(html, /style="width:100%"/);
  assert.match(html, /bg-emerald-500 dark:bg-emerald-400/);
  assert.doesNotMatch(html, /bg-violet-700/);
});
