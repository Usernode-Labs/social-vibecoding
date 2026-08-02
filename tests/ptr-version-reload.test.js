// Source pins for version-aware pull-to-refresh:
//
//   Pull-to-refresh on the landing and home screens is a data refresh
//   PLUS a platform-version check — when /api/version reports a SHA
//   different from the one the document booted with, the pull upgrades
//   to a full location.reload() so the tab picks up new client code.
//   This matters most on the anonymous landing screen, which has no
//   WS "platform updating" banner: before this, a deployed landing
//   change was unreachable without killing and restarting the app.
//
// Contracts pinned here:
//   1. App.platformMovedOn compares against the boot-time
//      loadedPlatformSha, fails closed, and ignores the dev sentinel.
//   2. App._refreshOrReload runs the data refresh, reloads only when
//      the platform moved on, and parks the spinner (never-resolving
//      promise) through the reload.
//   3. enterAnonymous captures the boot SHA (the anonymous shell has
//      no authed loadVersion poll to do it).
//   4. The landing + home PTR callbacks route through _refreshOrReload.
//
// Run with: node --test tests/ptr-version-reload.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const appJs = read('public/js/app.js');
const authJs = read('public/js/auth-screens.js');

// ─── 1. platformMovedOn semantics ───────────────────────────────────

test('platformMovedOn compares /api/version against the boot baseline', () => {
  const fn = appJs.slice(
    appJs.indexOf('async platformMovedOn()'),
    appJs.indexOf('_refreshOrReload(')
  );
  assert.ok(fn.length > 0, 'platformMovedOn is defined before _refreshOrReload');
  assert.match(fn, /fetch\('\/api\/version'\)/);
  assert.match(fn, /info\.sha !== App\.loadedPlatformSha/,
    'stale = served sha differs from the boot sha');
  // dev servers report sha "dev" — never treat that as a deploy.
  assert.match(fn, /info\.sha === 'dev'/);
  // Fail closed: network errors must not become reload loops.
  assert.match(fn, /catch\s*\{\s*return false;\s*\}/);
  // Missing baseline records what it sees and reports current.
  assert.match(fn, /App\.loadedPlatformSha = info\.sha;\s*\n\s*return false;/);
});

// ─── 2. _refreshOrReload semantics ──────────────────────────────────

test('_refreshOrReload reloads only on a moved-on platform and parks the spinner', () => {
  const fn = appJs.slice(
    appJs.indexOf('_refreshOrReload('),
    appJs.indexOf('renderPlatformVersionPill(info) {')
  );
  assert.ok(fn.length > 0, '_refreshOrReload is defined');
  assert.match(fn, /App\.platformMovedOn\(\)/);
  assert.match(fn, /location\.reload\(\)/);
  // The never-resolving promise keeps the PTR puck spinning until the
  // reload tears the document down (no false "done" settle).
  assert.match(fn, /new Promise\(\(\) => \{\}\)/);
  // A refresh failure still lets the version check settle the gesture.
  assert.match(fn, /\.catch\(\(\) => \{\}\)/);
});

// ─── 3. Anonymous boot baseline ─────────────────────────────────────

test('enterAnonymous captures the boot SHA via loadVersion', () => {
  const fn = appJs.slice(
    appJs.indexOf('enterAnonymous() {'),
    appJs.indexOf('_anonShot() {')
  );
  assert.match(fn, /App\.loadVersion\(\);/,
    'anonymous boot records the platform SHA for later comparison');
});

// ─── 4. PTR call sites route through _refreshOrReload ───────────────

test('home PTR routes through _refreshOrReload', () => {
  const fn = appJs.slice(
    appJs.indexOf('_wirePullToRefresh() {'),
    appJs.indexOf('bindEvents() {')
  );
  assert.match(fn, /pullToRefresh\(home,\s*\n?\s*\(\) => App\._refreshOrReload\(\(\) => Home\.load\(\)\)\)/);
});

test('landing PTR routes through _refreshOrReload', () => {
  assert.match(authJs,
    /pullToRefresh\(byId\('auth-landing-scroll'\),\s*\n?\s*\(\) => App\._refreshOrReload\(\(\) => AuthScreens\._loadLandingApps\(\)\)\)/);
});
