// Admin & moderation entry point (#588 shipped it as a header shield; the
// header slim-down moved it into the hamburger drawer; the Streamlined
// Concept retired the drawer and put it in the app chip's menu; #2718 took
// the platform's destinations out of that menu and it went back to Profile;
// the prototype's Me moved it into SETTINGS; #5281 took it out of personal
// Settings again and back onto Me, because the console is a place an admin
// goes and not one of their settings).
//
// It is a row of its own on Me (features/profile/account-panel.tsx,
// AdminPanel, #profile-row-admin), on both layouts, and is visible to
// platform admins AND view-only admins — never to regular users, and never
// gated on the environment. Those three properties are the
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
// `/#profile` for the admin capture identity — this test guards the
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
const settingsRows = read('frontend/src/features/settings/account-rows.tsx');
const mePanel = read('frontend/src/features/profile/account-panel.tsx');
const meView = read('frontend/src/features/profile/profile-view.tsx');
// The AdminPanel component alone, so the assertions below are about it.
const panel = mePanel.slice(mePanel.indexOf('export function AdminPanel('));
const menu = read('frontend/src/features/app-context/app-context-sheet.tsx');
const appJs = read('public/js/app.js');
const dapp = JSON.parse(read('dapp.json'));

test('the row is on Me, not rendered at all without the flag', () => {
  assert.ok(mePanel.includes('export function AdminPanel('), 'AdminPanel is exported from Me\'s panels');
  assert.match(panel, /id="profile-row-admin"/, 'the row is rendered');
  assert.match(panel, /id="profile-row-admin"[\s\S]{0,200}?href="#admin"/,
    'navigation rides the anchor hash');
  // NOT RENDERED rather than rendered-and-hidden: ProfileRoot renders nothing
  // until its store has data, so a conditional render has no prerendered
  // document to disagree with — and a hidden row still leaks its words to a
  // find-in-page.
  assert.match(panel, /if \(!isAdmin\) return null;/,
    'the row is absent for an account without the capability');
  assert.match(meView, /<SettingsPanel \/>\s*<AdminPanel \/>/,
    'Me renders it, after the phone\'s Settings row, on both layouts');
});

test('it left Settings (#5281)', () => {
  const code = settingsRows.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /settings-row-admin|href="#admin"|switcher-row-admin/,
    'Settings\' account block holds the native rows only');
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
    .includes('#profile-row-admin'));
  assert.ok(hit, 'a declared check must assert the row actually renders');
  // NO `:not(.hidden)` on the row, and its absence is the assertion: this
  // row is not RENDERED at all without the capability, so selecting it IS
  // proving it was revealed.
  assert.doesNotMatch(String(hit.expectSelector), /#profile-row-admin:not\(\.hidden\)/,
    'a conditionally rendered row needs no hidden-class qualifier of its own');
  assert.match(String(hit.expectSelector), /#profile-screen:not\(\.hidden\)/,
    'on the surface that renders it');
  assert.match(String(hit.path), /#profile/, 'and at the address that reveals it');
  assert.ok(!dapp.tests.some((t) => String(t.expectSelector || '').includes('#settings-row-admin')),
    'and nothing still expects it in Settings');
});
