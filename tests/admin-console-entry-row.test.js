// Admin & moderation entry point (#588 shipped it as a header shield; the
// header slim-down moved it into the hamburger drawer; the Streamlined
// Concept retired the drawer and it landed here).
//
// It is a row in the PROFILE screen's account group now, beside Settings, and
// is visible to platform admins AND view-only admins — never to regular
// users, and never gated on the environment. Those three properties are the
// whole contract, and all three are easy to break later by a well-meaning
// edit (swapping `isAdmin` for the stricter `canAdminWrite`, or "just showing
// it in staging"), so they are pinned here.
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
const panel = read('frontend/src/features/app-context/app-context-sheet.tsx');
const appJs = read('public/js/app.js');
const dapp = JSON.parse(read('dapp.json'));

test("the row ships in the chip's menu, hidden by default", () => {
  assert.match(panel, /id="switcher-row-admin"/, 'the row is rendered');
  assert.match(panel, /id="switcher-row-admin"[\s\S]{0,200}?href="#admin"/,
    'navigation rides the anchor hash');
  // Ships hidden through MenuRow's `shipsHidden` prop, which prefixes the
  // shared ROW constant. The className stays a constant either way — that is
  // what keeps the outside `hidden` toggle a sanctioned seam and not a
  // second owner of the node.
  assert.match(panel, /shipsHidden/,
    'it ships hidden — the gate reveals it, never the other way round');
  assert.match(panel, /className=\{shipsHidden \? `hidden \$\{ROW\}` : ROW\}/,
    'and the hidden state is a prefix on the constant, not a computed class');
});

test("it sits below Settings, in the menu's You group", () => {
  const settings = panel.indexOf('id="switcher-row-settings"');
  const admin = panel.indexOf('id="switcher-row-admin"');
  assert.ok(settings !== -1 && admin !== -1, 'both rows are present');
  assert.ok(settings < admin, 'Settings leads, Admin follows');
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
  assert.match(panel, /useVisibilityHiddenClass\(adminRef, 'switcher-row-admin', false\)/,
    'and the component subscribes to exactly that key');
});

test('the row is not gated on the environment', () => {
  const at = appJs.indexOf('  renderAdminButton() {');
  const body = appJs.slice(at, appJs.indexOf('\n  },', at));
  assert.doesNotMatch(body, /IS_STAGING|USERNODE_ENV/,
    'the row must exist identically in staging and production');
  // Comments stripped first: account-panel.tsx SAYS "never gated on
  // USERNODE_ENV", and a prose match for the thing being forbidden would
  // fail on the note explaining that it is forbidden.
  const panelCode = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(panelCode, /IS_STAGING|USERNODE_ENV/);
});

test('dapp.json locks the rendered row in with a check', () => {
  const hit = dapp.tests.find((t) => String(t.expectSelector || '')
    .includes('#switcher-row-admin'));
  assert.ok(hit, 'a declared check must assert the row actually renders');
  assert.match(String(hit.expectSelector), /:not\(\.hidden\)/,
    'and that it is REVEALED for the admin identity, not merely present');
  // The menu, not a screen: `?shot=app-context` is the capture path that
  // presents it, the same one the other menu checks use.
  assert.match(String(hit.path), /shot=app-context/,
    'on the surface that renders it');
});
