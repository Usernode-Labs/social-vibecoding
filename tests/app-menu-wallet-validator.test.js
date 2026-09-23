'use strict';

// The native Wallet and Validator rows, and where they live.
//
// #2382 put them in the app chip's menu, in its You group between Profile and
// Settings — extra entrances beside the ones Profile already had, because an
// admin asked to reach them from inside an app.
//
// #2718 took the platform's destinations out of that menu: it holds the APP's
// options now, and the host's own places are the tab bar and the Me tab. So
// these two went back to ONE entrance, the Profile screen's account group,
// where #1443 left them and where their readouts had always been.
//
// The prototype's Me then moved that entrance one level in, to Settings — the
// spec's retired-chip table reads "Me, with Admin and Validator inside
// Settings", and the prototype's Settings carries the wallet — so they are
// rows of Settings' account block now (features/settings/account-rows.tsx),
// still ONE entrance: Me → Settings, both on every platform screen's bar.
//
// No dapp.json check declares them: the rows ship hidden on every surface a
// declared check can capture (a desktop browser).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
const panel = read('frontend/src/features/settings/account-rows.tsx');
const mePanel = read('frontend/src/features/profile/account-panel.tsx');

test('the app menu carries neither row any more', () => {
  for (const id of ['switcher-row-wallet', 'switcher-row-validator']) {
    assert.doesNotMatch(sheet, new RegExp(`id="${id}"`), `#${id} left the menu`);
  }
  // …and with them went the two native stores this file was written to pin.
  // A component reading walletSheetStore to hide a row it does not render is
  // a subscription with nothing behind it.
  assert.doesNotMatch(sheet, /walletSheetStore|nodePillStore/,
    'the menu subscribes to no native capability store');
});

test('Settings is the one entrance, readouts and all', () => {
  // These are not destinations — "your node is producing", "this is your
  // balance" — so they sit on the screen that configures the account, and
  // the components are unchanged: only their host moved.
  assert.match(panel, /<WalletRow \/>/, 'the wallet row');
  assert.match(panel, /<NodePillRow \/>/, 'and the node row');
  assert.match(panel, /<StakingRow \/>/, 'and staking beside them');
  for (const row of ['WalletRow', 'NodePillRow', 'StakingRow']) {
    assert.doesNotMatch(mePanel, new RegExp(`<${row} \\/>`), `Me no longer renders a second ${row}`);
  }
});

test('and the Me tab is what makes one entrance enough', () => {
  // #2382's complaint was the distance from inside an app, not the number of
  // doors. The bar answers it: Me is a tab on every platform screen, and its
  // Settings row is the way in.
  const html = read('public/index.html');
  assert.match(html, /id="platform-tab-me"[^>]*href="#profile"/);
  assert.match(mePanel, /id="profile-row-settings"[\s\S]{0,120}href="#settings"/);
});
