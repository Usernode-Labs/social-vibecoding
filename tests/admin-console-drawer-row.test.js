// Drawer admin/moderation entry point (#588, moved out of the header by
// the header slim-down).
//
// The row sits in the slide-out drawer just after Settings and is
// visible to platform admins AND view-only admins — never to regular
// users, and never gated on the environment. Those three properties are
// the whole contract, and all three are easy to break later by a
// well-meaning edit (swapping `isAdmin` for the stricter
// `canAdminWrite`, reordering the drawer, or "just showing it in
// staging"), so they're pinned here.
//
// Complements the dapp.json check that asserts the row actually renders
// at `/` for the view-only-admin capture identity — this test guards the
// source-level gate that the rendered check can't see (a check running
// as an admin can't prove a non-admin is excluded).
//
// Run with: node --test tests/admin-console-drawer-row.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

test('the admin row ships in the drawer, hidden by default', () => {
  const row = html.match(/<a id="drawer-row-admin"[^>]*>/);
  assert.ok(row, 'the drawer carries a #drawer-row-admin');
  assert.match(row[0], /class="hidden /,
    'ships `hidden` so a non-admin never sees it, not even for a frame before boot resolves');
  assert.match(row[0], /href="#admin"/,
    'a real anchor — navigation rides the hash, like Settings/Challenges/Profile');
});

test('the admin row sits immediately after Settings in the drawer', () => {
  const settings = html.indexOf('<a id="drawer-row-settings"');
  const admin = html.indexOf('<a id="drawer-row-admin"');
  assert.ok(settings > -1 && admin > -1, 'both drawer rows present');
  assert.ok(admin > settings, 'the admin row comes after Settings');
  // Nothing else may render between them — the account-ish rows end with
  // Settings, and admin is the last row in the menu.
  const between = html.slice(settings, admin);
  assert.equal(between.match(/id="drawer-row-/g)?.length, 1,
    'no other drawer row renders between Settings and the admin row');
});

test('the admin entry point has left the header entirely', () => {
  const header = html.slice(0, html.indexOf('</header>'));
  assert.ok(!/id="admin-dashboard-btn"/.test(header),
    'the old header shield button is gone from the header');
  assert.ok(!/<button id="admin-dashboard-btn"/.test(html),
    'and is not left orphaned anywhere else in the shell');
  assert.ok(!/getElementById\('admin-dashboard-btn'\)/.test(appJs),
    'no JS still reaches for the retired header button');
});

test('visibility is gated on isAdmin — which covers view-only admins too', () => {
  assert.match(appJs, /btn\.classList\.toggle\('hidden', !App\.user\?\.isAdmin\)/,
    'renderAdminButton gates on App.user.isAdmin');
  assert.match(appJs, /getElementById\('drawer-row-admin'\)/,
    'renderAdminButton targets the drawer row');
  // `canAdminWrite` is the FULL-admin mutation gate (is_admin &&
  // !admin_readonly, see middleware/auth.js). Gating a viewing surface
  // on it would lock out exactly the view-only admins this console is
  // for, so it must not appear in either admin-console function.
  const fns = appJs.slice(
    appJs.indexOf('  renderAdminButton()'),
    appJs.indexOf('  loadedPlatformSha:')
  );
  assert.ok(fns.length > 0, 'admin-console functions located in app.js');
  assert.ok(!/canAdminWrite/.test(fns),
    'the admin console must not gate on canAdminWrite — that excludes view-only admins');
});

test('the admin row is not gated on the environment', () => {
  // Comments in this region legitimately *mention* USERNODE_ENV (to say
  // the row is not gated on it), so assert against markup only.
  const row = html.match(/<a id="drawer-row-admin"[\s\S]*?<\/a>/);
  assert.ok(row, 'admin row markup located');
  assert.ok(!/USERNODE_ENV|IS_STAGING/.test(row[0]),
    'drawer markup carries no environment gate');
  const fns = appJs.slice(
    appJs.indexOf('  renderAdminButton()'),
    appJs.indexOf('  loadedPlatformSha:')
  );
  assert.ok(!/USERNODE_ENV|IS_STAGING|isStaging/.test(fns),
    'feature availability must be identical in staging and production');
});

test('clicking closes the drawer; the gate is re-checked on the route', () => {
  // The row is an anchor, so its href does the navigating and the click
  // handler only dismisses the menu — the same idiom as Settings.
  assert.match(appJs, /getElementById\('drawer-row-admin'\)\s*\r?\n?\s*\?\.addEventListener\('click', \(\) => App\.HeaderMenu\.close\(\)\)/,
    'the drawer row closes the menu on click');
  // openAdminConsole stays the programmatic entry point and keeps its
  // own gate, so a scripted call can't open the console either.
  const fn = appJs.slice(appJs.indexOf('  openAdminConsole()'));
  assert.match(fn.slice(0, 200), /if \(!App\.user\?\.isAdmin\) return;/,
    'openAdminConsole re-checks the gate so a programmatic call cannot open it');
});

test('dapp.json locks the rendered row in with a check', () => {
  const t = (manifest.tests || []).find(
    (x) => typeof x.expectSelector === 'string' && x.expectSelector.includes('#drawer-row-admin')
  );
  assert.ok(t, 'a dapp.json test asserts the admin drawer row renders');
  assert.equal(t.path, '/', 'checked on the shell route the drawer ships on');
});
