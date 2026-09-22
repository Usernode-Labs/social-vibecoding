'use strict';

// The Me tab's end: Challenges, Settings and the Admin console as rows on the
// Profile screen (#2718).
//
// They were rows of the app chip's menu, on #1443's rule that the menu lists
// every destination with its own page. The tab bar took the platform's places
// out of that menu, so these three needed a SCREEN, and the tab that owns them
// is Me. This pins the three things that can go wrong on the way:
//
//   1. a destination that is reachable from nowhere, because the row was
//      removed from the menu before it existed here;
//   2. a button where an anchor belongs, which silently costs cmd-click,
//      middle-click, the context menu and drag-to-bookmark;
//   3. the Admin row rendered for an account without the capability.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const PANEL = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/profile/account-panel.tsx'), 'utf8');

test('the three platform destinations are rows on Profile', () => {
  for (const [id, href] of [
    ['profile-row-challenges', '#leaderboard/challenges'],
    ['profile-row-settings', '#settings'],
    ['profile-row-admin', '#admin'],
  ]) {
    const at = PANEL.indexOf(`id="${id}"`);
    assert.ok(at > 0, `#${id} must be a row on the Profile screen`);
    const row = PANEL.slice(PANEL.lastIndexOf('<ListRow', at), PANEL.indexOf('/>', at));
    assert.match(row, /as="a"/,
      `#${id} must be an anchor — cmd-click, middle-click, the context menu `
      + 'and drag-to-bookmark are the browser\'s to give, and only an anchor '
      + 'with an href gets them');
    assert.ok(row.includes(`href="${href}"`), `#${id} points at ${href}`);
  }
});

test('Challenges leads, and the console comes last', () => {
  // The order is how often you go: the group's shared goals, then your own
  // configuration, then the console almost nobody sees.
  const order = ['profile-row-challenges', 'profile-row-settings', 'profile-row-admin']
    .map((id) => PANEL.indexOf(`id="${id}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'rows in frequency order');
});

test('Admin is a capability, read from the published flag', () => {
  // App.renderAdminButton publishes it after the session resolves. The id is
  // a row's, from when the app menu was where that row lived — what matters
  // is that this screen reads the SAME flag rather than deciding for itself.
  assert.match(PANEL, /useVisibility\('switcher-row-admin', false\)/,
    'the flag is read, and defaults to "no" before anything publishes');
  const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  assert.match(appJs, /Visibility\.publish\('switcher-row-admin', isAdmin\)/,
    'and one publisher still owns it');
});

test('a non-admin renders no Admin row at all', () => {
  // Not rendered rather than rendered-and-hidden, which is safe here and
  // would not be in the shell's prerendered markup: ProfileRoot returns null
  // until its store has data, so none of this is in public/index.html.
  const mod = loadTsx('frontend/src/features/profile/account-panel.tsx');
  const html = renderToHtml(createElement(mod.AccountPanel, {}));
  assert.match(html, /id="profile-row-challenges"/, 'Challenges is unconditional');
  assert.match(html, /id="profile-row-settings"/, 'and so is Settings');
  assert.doesNotMatch(html, /id="profile-row-admin"/,
    'the console is absent with nothing published');
  assert.doesNotMatch(html, /Admin &amp; moderation|Admin & moderation/,
    'and so is its label — a hidden row still leaks its words to a find-in-page');
});

test('the native readouts stay, and logout stays last', () => {
  // They are not destinations: "your node is producing" and "this is your
  // balance" have no page behind them, which is why every arrangement of this
  // screen has left them on it.
  for (const tag of ['<NodePillRow />', '<WalletRow />', '<StakingRow />']) {
    assert.ok(PANEL.includes(tag), `${tag} is still here`);
  }
  assert.ok(PANEL.indexOf('Log out') > PANEL.indexOf('<StakingRow />'),
    'logout closes the screen');
});
