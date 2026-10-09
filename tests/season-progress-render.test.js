'use strict';

// The shared season progress (ITERATION 03): one component, drawn by Home's
// Challenges block and the Leaderboard screen's Challenges tab, so the season
// reads the same figure, words and bar on both.
//
// Run with: node --test tests/season-progress-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const { renderComponent } = require('./lib/render-tsx');

const FILE = 'frontend/src/features/leaderboard/season-progress.tsx';
const render = (view, extra = {}) => renderComponent(FILE, 'SeasonProgress', { view, ...extra });
const count = (html, re) => (html.match(re) || []).length;

test('the figure, the scope and one segment per challenge', () => {
  const html = render({ done: 3, total: 9, scope: 'season', name: 'Season 2' }, { id: 'x' });
  assert.match(html, /<p id="x"[^>]*><span[^>]*>3\/9<\/span><span[^>]*>done in Season 2<\/span><\/p>/);
  assert.match(html,
    /role="meter" aria-valuemin="0" aria-valuemax="9" aria-valuenow="3" aria-label="3 of 9 done in Season 2"/);
  assert.equal(count(html, /h-\[5px\]/g), 9, 'nine segments');
  assert.equal(count(html, /bg-violet-700/g), 3, 'three of them filled');
  assert.doesNotMatch(html, /<svg/, 'divs, not a glyph outside icons.tsx');
});

test('nothing at zero, and the figure never runs past the scope', () => {
  assert.equal(render({ done: 0, total: 0 }), '');
  const over = render({ done: 12, total: 9 });
  assert.match(over, /<span[^>]*>9\/9<\/span><span[^>]*>done<\/span>/, 'no scope: the bare word');
  assert.match(over, /aria-label="9 of 9 done"/);
  assert.match(over, />9\/9</);
  assert.equal(count(over, /bg-violet-700/g), 9);
  const none = render({ done: 0, total: 4 });
  assert.equal(count(none, /bg-violet-700/g), 0, 'a scope nobody has started draws no fill');
});

test('past the segment limit the bar is one continuous track', () => {
  const html = render({ done: 10, total: 40, scope: 'season', name: 'Season 2' });
  assert.equal(count(html, /h-\[5px\]/g), 1, 'one track, not forty slivers');
  assert.match(html, /style="width:25%"/);
});
