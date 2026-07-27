// Header admin/moderation entry point (#588, first slice).
//
// The icon sits immediately after the notifications bell and is visible
// to platform admins AND view-only admins — never to regular users, and
// never gated on the environment. Those three properties are the whole
// contract of this slice, and all three are easy to break later by a
// well-meaning edit (swapping `isAdmin` for the stricter
// `canAdminWrite`, reordering the header, or "just showing it in
// staging"), so they're pinned here.
//
// Complements the dapp.json check that asserts the button actually
// renders at `/` for the view-only-admin capture identity — this test
// guards the source-level gate that the rendered check can't see
// (a check running as an admin can't prove a non-admin is excluded).
//
// Run with: node --test tests/admin-console-header-button.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

test('the admin button ships in the shell, hidden by default', () => {
  const btn = html.match(/<button id="admin-dashboard-btn"[^>]*>/);
  assert.ok(btn, 'header carries an #admin-dashboard-btn');
  assert.match(btn[0], /class="hidden /,
    'ships `hidden` so a non-admin never sees it, not even for a frame before boot resolves');
  assert.match(btn[0], /aria-label="Admin and moderation"/, 'icon-only button carries an aria-label');
});

test('the admin button sits immediately after the notifications bell', () => {
  const bell = html.indexOf('<button id="notifications-btn"');
  const admin = html.indexOf('<button id="admin-dashboard-btn"');
  assert.ok(bell > -1 && admin > -1, 'both header buttons present');
  assert.ok(admin > bell, 'admin button comes after the bell');
  // Nothing else may render between them — the dapp.json check asserts
  // this with an adjacent-sibling selector, so a header element spliced
  // in between would fail the merge gate; catch it here first.
  const between = html.slice(bell, admin);
  assert.equal(between.match(/<button|<a /g)?.length, 1,
    'no other header control renders between the bell and the admin button');
});

test('visibility is gated on isAdmin — which covers view-only admins too', () => {
  assert.match(appJs, /btn\.classList\.toggle\('hidden', !App\.user\?\.isAdmin\)/,
    'renderAdminButton gates on App.user.isAdmin');
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

test('the admin button is not gated on the environment', () => {
  // Comments in this region legitimately *mention* USERNODE_ENV (to say
  // the button is not gated on it), so assert against markup only.
  const btn = html.match(/<button id="admin-dashboard-btn"[\s\S]*?<\/button>/);
  assert.ok(btn, 'admin button markup located');
  assert.ok(!/USERNODE_ENV|IS_STAGING/.test(btn[0]),
    'header markup carries no environment gate');
  const fns = appJs.slice(
    appJs.indexOf('  renderAdminButton()'),
    appJs.indexOf('  loadedPlatformSha:')
  );
  assert.ok(!/USERNODE_ENV|IS_STAGING|isStaging/.test(fns),
    'feature availability must be identical in staging and production');
});

test('clicking is wired and re-checks the gate', () => {
  assert.match(appJs, /getElementById\('admin-dashboard-btn'\)\s*\r?\n?\s*\?\.addEventListener\('click', \(\) => App\.openAdminConsole\(\)\)/,
    'click handler wired in bindEvents');
  const fn = appJs.slice(appJs.indexOf('  openAdminConsole()'));
  assert.match(fn.slice(0, 200), /if \(!App\.user\?\.isAdmin\) return;/,
    'openAdminConsole re-checks the gate so a programmatic click cannot open it');
});

test('dapp.json locks the rendered button in with a check', () => {
  const t = (manifest.tests || []).find(
    (x) => typeof x.expectSelector === 'string' && x.expectSelector.includes('#admin-dashboard-btn')
  );
  assert.ok(t, 'a dapp.json test asserts the admin button renders');
  assert.equal(t.path, '/', 'checked on the header route the icon renders on');
});
