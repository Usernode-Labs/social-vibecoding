'use strict';

// #2382: the app chip's menu carries the native Wallet and Validator rows in
// its You group, between Profile and Settings. Profile keeps its own account
// rows; these are extra entrances, native only.
//
// No dapp.json check declares them: the rows ship hidden on every surface a
// declared check can capture (a desktop browser), and the manifest sits
// exactly at its 20-slot headroom floor under MAX_DECLARED_TESTS.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('public/index.html');
const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');

const nav = html.slice(html.indexOf('id="switcher-nav"'));
const anchor = (id) => {
  const at = nav.indexOf(`id="${id}"`);
  assert.ok(at > 0, `#${id} is in the prerendered menu`);
  return nav.slice(nav.lastIndexOf('<a ', at), nav.indexOf('</a>', at));
};

test('the prerendered menu has Wallet and Validator between Profile and Settings', () => {
  const order = ['profile', 'wallet', 'validator', 'settings', 'admin']
    .map((row) => nav.indexOf(`id="switcher-row-${row}"`));
  assert.ok(order.every((at) => at > 0), 'every row is in #switcher-nav');
  assert.deepEqual([...order].sort((a, b) => a - b), order,
    'Profile, Wallet, Validator, Settings, Admin in that order');
});

test('both rows ship hidden, with an icon and a real href', () => {
  const wallet = anchor('switcher-row-wallet');
  const validator = anchor('switcher-row-validator');
  for (const row of [wallet, validator]) {
    assert.match(row, /class="hidden /, 'hidden until the native bridge reveals it');
    assert.match(row, /<svg/, 'with an icon like its siblings');
  }
  assert.match(wallet, /href="#profile"/, 'a modified click opens the screen whose row opens the sheet');
  assert.match(wallet, />Wallet</);
  assert.match(validator, /href="#settings\/usernode"/, 'block production lives in Settings › Homeroom app');
  assert.match(validator, />Validator</);
});

test('visibility comes from the native stores, through the hidden-class seam', () => {
  assert.match(sheet, /useStoreState\(walletSheetStore\)/);
  assert.match(sheet, /useStoreState\(nodePillStore\)/);
  assert.match(sheet, /useHiddenClass\(walletRef, !walletVisible\)/);
  assert.match(sheet, /useHiddenClass\(validatorRef, !nodeVisible\)/);
  for (const [ref, id] of [['walletRef', 'switcher-row-wallet'], ['validatorRef', 'switcher-row-validator']]) {
    const row = new RegExp(`elRef=\\{${ref}\\}\\s+shipsHidden\\s+id="${id}"`);
    assert.match(sheet, row, `#${id} ships hidden through MenuRow's constant className`);
  }
  const code = sheet.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /IS_STAGING|USERNODE_ENV/,
    'the rows exist identically in staging and production');
});

test('a Wallet tap presents the sheet only after the menu has dismissed', () => {
  const at = sheet.indexOf('id="switcher-row-wallet"');
  const row = sheet.slice(at, sheet.indexOf('/>', sheet.indexOf('openFromRow', at)));
  assert.match(row, /NavLink\?\.isNativeClick\?\.\(e\)\) return;/,
    'a modified click falls through to the anchor');
  assert.match(row, /e\.preventDefault\(\);/);
  assert.match(row,
    /AppContext\.dismissForNav\(\)\.then\(\(\) => \{\s*win\.WalletSheet\?\.openFromRow\?\.\(\);/,
    'a kit sheet cannot present while this one is still dismissing');
});
