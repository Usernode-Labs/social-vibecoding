'use strict';

// The native Wallet and Validator rows, and where they live.
//
// #2382 put them in the app chip's menu, in its You group between Profile and
// Settings — extra entrances beside the ones Profile already had, because an
// admin asked to reach them from inside an app.
//
// #2718 took the platform's destinations out of that menu: it holds the APP's
// options now, and the host's own places are the tab bar and the Me tab. So
// these two are back to ONE entrance, the Profile screen's account group,
// where #1443 left them and where their readouts have always been. The Me tab
// is what makes that cheap again — it is on the bar, so Profile is one tap
// from inside an app rather than a trip through Home.
//
// No dapp.json check declares them: the rows ship hidden on every surface a
// declared check can capture (a desktop browser).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
const panel = read('frontend/src/features/profile/account-panel.tsx');

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

test('Profile is the one entrance, readouts and all', () => {
  // These are not destinations — "your node is producing", "this is your
  // balance" — which is why every arrangement of this screen has left them
  // on it. The components are unchanged; only the second copy is gone.
  assert.match(panel, /<WalletRow \/>/, 'the wallet row');
  assert.match(panel, /<NodePillRow \/>/, 'and the node row');
  assert.match(panel, /<StakingRow \/>/, 'and staking beside them');
});

test('and the Me tab is what makes one entrance enough', () => {
  // #2382's complaint was the distance from inside an app, not the number of
  // doors. The bar answers it: Profile is a tab, on every platform screen.
  const html = read('public/index.html');
  assert.match(html, /id="platform-tab-me"[^>]*href="#profile"/);
});
