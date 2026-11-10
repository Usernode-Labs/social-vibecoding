'use strict';

// The Email & recovery row in Settings cannot change a linked address
// (request #6561). The row still reads the address and whether it is verified,
// but an account that has one is offered no action there: the editor's only
// way in is the Add link, which shows while the account has no email at all.
// A failed read keeps its Try again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const english = () => JSON.parse(read('frontend/locales/en/settings.json'));

test('Settings › Account: a linked email has no Change action; Add stays for an account without one', () => {
  const src = read('frontend/src/features/settings/sections/email.tsx');
  // #6561: the row never opens the editor for an address that is already
  // linked, so the Change label is gone from this surface.
  assert.doesNotMatch(src, /settings:account\.change/);
  // The one action left opens the editor for an account with no address.
  assert.match(src, /!open && !account\.email \?\s*\(/);
  assert.match(src, /t\('settings:account\.add'\)/);
  // A read that failed still says so and offers its retry.
  assert.match(src, /t\('core:common\.tryAgain'\)/);
  assert.equal(english()['account.add'].text, 'Add');
});

test('the shared Change label no longer describes the Email & recovery row', () => {
  const catalog = english();
  assert.equal(catalog['account.change'].text, 'Change');
  assert.doesNotMatch(catalog['account.change'].description, /Email & recovery/);
  assert.match(catalog['account.change'].description, /Username and Password rows/);
});
