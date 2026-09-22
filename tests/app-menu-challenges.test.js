'use strict';

// Challenges, and where its entrance lives.
//
// #1823 put a Challenges row in the app chip's menu, under Discover: it was a
// platform place reachable only from Home's Challenges area, so from inside
// an app there was no way to it short of going Home first.
//
// #2718 answers the same complaint with a different shape. The menu was
// carrying two unlike lists — the app's options and the platform's places —
// and every mini-app host it was modelled on keeps those apart: the host's
// sections on a permanent bar, the mini-app's options behind one button. So
// the platform's destinations left the menu, and Challenges is a row of the
// Profile screen the Me tab lands on.
//
// The GUARANTEE #1823 asked for is unchanged and is what this file still
// pins: Challenges is reachable from inside an app without going Home first.
// Two taps, by a different route — the Me tab, then the row.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('public/index.html');
const panel = read('frontend/src/features/profile/account-panel.tsx');

test('Challenges is a row of the Me tab, leading the platform group', () => {
  assert.match(panel, /id="profile-row-challenges"[\s\S]{0,200}?href="#leaderboard\/challenges"/,
    'the destination is unchanged — the Leaderboard screen\'s Challenges tab');
  const challenges = panel.indexOf('id="profile-row-challenges"');
  const settings = panel.indexOf('id="profile-row-settings"');
  assert.ok(challenges > 0 && challenges < settings,
    'it leads: the group\'s shared goals before your own configuration');
});

test('and the Me tab is on the bar, from inside an app or anywhere else', () => {
  // This is the whole of what #1823 was asking for. The row used to be two
  // taps from an app because the menu was; it is two taps now because the bar
  // is, and the bar is on every platform screen.
  assert.match(html, /id="platform-tab-me"[^>]*href="#profile"/);
});

test('the app menu carries no platform destination at all', () => {
  const nav = html.slice(html.indexOf('id="switcher-nav"'), html.indexOf('</nav>', html.indexOf('id="switcher-nav"')));
  for (const gone of [
    'switcher-row-home', 'switcher-row-discover', 'switcher-row-challenges',
    'switcher-row-messages', 'switcher-row-workshop', 'switcher-row-profile',
    'switcher-row-settings', 'switcher-row-admin',
    'switcher-row-wallet', 'switcher-row-validator',
  ]) {
    assert.ok(!nav.includes(gone), `#${gone} left the menu`);
  }
  // …and what IS there is the app's, which is the other half of the split.
  //
  // `improve-row-feedback` LEFT THIS LIST (#2718 review), and not to a
  // platform destination — it is a filled button in the Improve panel's own
  // well again, beside "New change", which is where it was before this issue
  // made it a row. A control that says what it DOES had become the first of
  // eight rows in a place you go to navigate. The split this test is about is
  // untouched: nothing here is the platform's.
  for (const row of [
    'app-menu-row-workshop', 'app-menu-row-discussion', 'app-menu-row-about',
  ]) {
    assert.ok(nav.includes(`id="${row}"`), `#${row} is the app's own`);
  }
  assert.ok(!nav.includes('id="improve-row-feedback"'),
    'and feedback is a button in the Improve panel, not a row here');
});
