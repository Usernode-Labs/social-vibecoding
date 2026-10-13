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

test('the event scope says it is an event\'s, and does not name it (#4528)', () => {
  const html = render({ done: 2, total: 3, scope: 'event' });
  assert.match(html, /<span[^>]*>2\/3<\/span><span[^>]*>done in this event<\/span><\/p>/);
  assert.match(html, /aria-label="2 of 3 done in this event"/);
  const named = render({ done: 2, total: 3, scope: 'event', name: 'Season 2' });
  assert.doesNotMatch(named, /Season 2/, 'a name handed along is still left out');
});

test('past the segment limit the bar is one continuous track', () => {
  const html = render({ done: 10, total: 40, scope: 'season', name: 'Season 2' });
  assert.equal(count(html, /h-\[5px\]/g), 1, 'one track, not forty slivers');
  assert.match(html, /style="width:25%"/);
});

test('no points in the view, the output is exactly what it was', () => {
  const before = render({ done: 3, total: 9, scope: 'season', name: 'Season 2' }, { id: 'x' });
  const after = render({ done: 3, total: 9, scope: 'season', name: 'Season 2', points: null }, { id: 'x' });
  assert.equal(after, before, 'a null points field draws nothing new');
  assert.doesNotMatch(before, /pts/);
  const zero = render({ done: 3, total: 9, points: { earned: 0, total: 0 } });
  assert.doesNotMatch(zero, /pts/, 'nothing on offer is no line either');
});

test('the points line and its own continuous bar', () => {
  const html = render({ done: 3, total: 9, scope: 'season', name: 'Season 2',
    points: { earned: 1000, total: 2000 } });
  assert.match(html, /<span[^>]*>1,000 of 2,000 pts<\/span><span[^>]*>earned<\/span><\/p>/);
  assert.equal(message('leaderboard:progress.points', { earned: '1,000', total: '2,000', count: 2000 }),
    '<0>1,000 of 2,000 pts</0><1>earned</1>', 'one message, the figures and the word as its two tags');
  assert.match(html,
    /role="meter" aria-valuemin="0" aria-valuemax="2000" aria-valuenow="1000" aria-label="1,000 of 2,000 pts earned"/);
  assert.equal(count(html, /h-\[5px\]/g), 10, 'nine segments plus the points track');
  assert.match(html, /style="width:50%"/, 'half the points, half the fill');
  assert.match(html, /bg-violet-700/, 'still violet while points are to earn');
  assert.doesNotMatch(html, /bg-emerald-500/);
});

test('every point earned, the track is the cards\' green', () => {
  const html = render({ done: 9, total: 9, scope: 'season', name: 'Season 2',
    points: { earned: 2000, total: 2000 } });
  assert.match(html, /style="width:100%"/);
  assert.match(html, /bg-emerald-500 dark:bg-emerald-400/);
});

test('earned never draws past what is on offer', () => {
  const html = render({ done: 9, total: 9, points: { earned: 2500, total: 2000 } });
  assert.match(html, />2,000 of 2,000 pts</);
  assert.match(html, /aria-valuenow="2000"/);
  assert.match(html, /bg-emerald-500/, 'a clamped total IS the whole thing, so green');
});
