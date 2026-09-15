'use strict';

// #1823: the app menu (the app chip's sheet) gains a Challenges row in its
// Platform group, directly under Discover, linking to the Leaderboard
// screen's Challenges tab.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('public/index.html');
const dapp = JSON.parse(read('dapp.json'));

test('the prerendered menu has Challenges right after Discover', () => {
  const nav = html.slice(html.indexOf('id="switcher-nav"'));
  const discover = nav.indexOf('id="switcher-row-discover"');
  const challenges = nav.indexOf('id="switcher-row-challenges"');
  const messages = nav.indexOf('id="switcher-row-messages"');
  assert.ok(discover > 0 && challenges > discover && messages > challenges,
    'Home, Discover, Challenges, Messages in that order');
  assert.match(nav, /id="switcher-row-challenges" href="#leaderboard\/challenges"/);
  const row = nav.slice(challenges, nav.indexOf('</a>', challenges));
  assert.match(row, />Challenges</);
  assert.match(row, /<svg/, 'with an icon like its siblings');
});

test('a declared check pins the row under Discover', () => {
  const t = dapp.tests.find((x) => /switcher-row-challenges/.test(x.expectSelector || ''));
  assert.ok(t, 'a dapp.json check selects the row');
  assert.match(t.expectSelector, /#switcher-row-discover \+ #switcher-row-challenges/);
});
