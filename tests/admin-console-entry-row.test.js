// Admin & moderation entry point (#588 shipped it as a header shield; the
// header slim-down moved it into the hamburger drawer; the Streamlined
// Concept retired the drawer and put it in the app chip's menu; #2718 took
// the platform's destinations out of that menu and it went back to Profile;
// the prototype's Me moved it into SETTINGS — the spec's retired-chip table,
// "Me, with Admin and Validator inside Settings").
//
// It is a row of Settings' account block (features/settings/account-rows.tsx,
// inside #settings-footer above Log out), and is visible to platform admins
// AND view-only admins — never to regular users, and never gated on the
// environment. Those three properties are the
// whole contract, and all three are easy to break later by a well-meaning
// edit (swapping `isAdmin` for the stricter `canAdminWrite`, or "just showing
// it in staging"), so they are pinned here.
//
// ── What the menu's removal did NOT change ───────────────────────────
//
// The gate is the same published flag it has been since the drawer went. Its
// key is still `switcher-row-admin` — a row id from the surface that no
// longer has the row — because the flag is a CAPABILITY and outlives any one
// row; renaming it would churn the publisher, both readers and this file to
// no end.
//
// ── What the drawer's removal changed about the gate ──────────────────
//
// The row used to be in the document at all times, because the drawer was, so
// `renderAdminButton` could reveal it with a classList write at boot. It
// renders from profile data now — inside a subtree React owns — where an id
// lookup at boot finds nothing and React would re-render the class back. The
// gate is unchanged; the DELIVERY is the visibility store, which is the one
// sanctioned way to drive a converted region's visibility from outside React.
//
// Complements the dapp.json check that asserts the row actually renders at
// `/#settings` for the admin capture identity — this test guards the
// source-level gate that the rendered check cannot see (a check running as an
// admin cannot prove a non-admin is excluded).
//
// Run with: node --test tests/admin-console-entry-row.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const panel = read('frontend/src/features/settings/account-rows.tsx');
const settingsChassis = read('frontend/src/features/settings/index.tsx');
const mePanel = read('frontend/src/features/profile/account-panel.tsx');
const menu = read('frontend/src/features/app-context/app-context-sheet.tsx');
const appJs = read('public/js/app.js');
const dapp = JSON.parse(read('dapp.json'));

test('the row is in Settings, not rendered at all without the flag', () => {
  assert.match(panel, /id="settings-row-admin"/, 'the row is rendered');
  assert.match(panel, /id="settings-row-admin"[\s\S]{0,200}?href="#admin"/,
    'navigation rides the anchor hash');
  // NOT RENDERED rather than rendered-and-hidden. The block renders nothing
  // until mounted, so none of it is in public/index.html and a conditional
  // render has no document to disagree with — and a hidden row still leaks
  // its words to a find-in-page.
  assert.match(panel, /\{isAdmin \? \(/,
    'the row is absent for an account without the capability');
  assert.match(panel, /if \(!mounted\) return null;/,
    'and the whole block waits for its mount, so hydration sees nothing');
});

test('it sits in the Settings footer, above Log out, and left the Me screen', () => {
  const footer = settingsChassis.indexOf('id="settings-footer"');
  const block = settingsChassis.indexOf('<SettingsAccountRows />');
  const logout = settingsChassis.indexOf('id="settings-logout"');
  assert.ok(footer !== -1 && block !== -1 && logout !== -1, 'all three are present');
  assert.ok(footer < block && block < logout,
    'inside the footer Settings._syncFooter moves, above the Log out it already had');
  const meCode = mePanel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(meCode, /profile-row-admin|href="#admin"/,
    'Me\'s "More" list is Challenges & standings, Kudos and Settings only');
});

test('and it is NOT in the app chip menu any more (#2718)', () => {
  // The menu holds the app's options now; the platform's destinations are
  // tabs and Me/Settings rows. A second entrance here would be the
  // duplication the split exists to remove.
  assert.doesNotMatch(menu, /id="switcher-row-admin"/,
    'the menu carries no platform destination');
  assert.doesNotMatch(menu, /Admin &amp; moderation|Admin & moderation/,
    'nor its label');
});

test('the admin entry point is not in the header, and not in a drawer', () => {
  const header = read('frontend/src/features/header/platform-header.tsx');
  assert.doesNotMatch(header, /id="admin-dashboard-btn"/,
    'the original header shield stays retired');
  assert.ok(!fs.existsSync(path.join(root, 'frontend/src/features/header/header-menu.tsx')),
    'and the drawer it lived in between is gone outright');
});

test('visibility is gated on isAdmin — which covers view-only admins too', () => {
  const at = appJs.indexOf('  renderAdminButton() {');
  assert.ok(at !== -1, 'renderAdminButton went missing');
  const body = appJs.slice(at, appJs.indexOf('\n  },', at));
  assert.match(body, /App\.user\?\.isAdmin/,
    'the gate is isAdmin — BOTH admin roles carry it');
  assert.doesNotMatch(body, /canAdminWrite/,
    'canAdminWrite is the full-admin mutation gate; using it here would hide '
    + 'the console from exactly the moderation audience');
});

test('the gate is published, not written by id', () => {
  const at = appJs.indexOf('  renderAdminButton() {');
  const body = appJs.slice(at, appJs.indexOf('\n  },', at));
  assert.match(body, /Visibility\.publish\('switcher-row-admin'/,
    'the row renders inside a React-owned subtree — publish, do not classList');
  assert.doesNotMatch(body, /getElementById/,
    'an id lookup at boot finds nothing, and React would undo it if it did');
  assert.match(panel, /useVisibility\('switcher-row-admin', false\)/,
    'and the component subscribes to exactly that key');
});

test('the row is not gated on the environment', () => {
  const at = appJs.indexOf('  renderAdminButton() {');
  const body = appJs.slice(at, appJs.indexOf('\n  },', at));
  assert.doesNotMatch(body, /IS_STAGING|USERNODE_ENV/,
    'the row must exist identically in staging and production');
  // Comments stripped first: a component that SAYS "never gated on
  // USERNODE_ENV" would otherwise fail on the note explaining that it is
  // forbidden.
  const panelCode = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(panelCode, /IS_STAGING|USERNODE_ENV/);
});

test('dapp.json locks the rendered row in with a check', () => {
  const hit = dapp.tests.find((t) => String(t.expectSelector || '')
    .includes('#settings-row-admin'));
  assert.ok(hit, 'a declared check must assert the row actually renders');
  // NO `:not(.hidden)` on the row, and its absence is the assertion: this
  // row is not RENDERED at all without the capability, so selecting it IS
  // proving it was revealed.
  assert.doesNotMatch(String(hit.expectSelector), /#settings-row-admin:not\(\.hidden\)/,
    'a conditionally rendered row needs no hidden-class qualifier of its own');
  // The Settings screen, where the row lives now.
  assert.match(String(hit.expectSelector), /#settings-screen:not\(\.hidden\)/,
    'on the surface that renders it');
  assert.match(String(hit.path), /#settings/, 'and at the address that reveals it');
  assert.ok(!dapp.tests.some((t) => String(t.expectSelector || '').includes('#profile-row-admin')),
    'and nothing still expects it on Me');
});
