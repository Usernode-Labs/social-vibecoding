// Profile on the web: the drawer row is no longer gated on the native
// bridge, and a signed-out visitor gets a sign-in prompt instead of a
// generic failure.
//
// The bug this pins: #profile worked perfectly in an ordinary browser —
// /challenges-api/me/* scopes to the platform session server-side since
// the topochain merge — but the drawer entry was revealed only when the
// bridge reported the `getProfileInfo` capability. On the web the screen
// therefore existed and was unreachable. The capability probe was the ONLY
// thing hiding it.
//
// Second half: those routes require a session (requireSessionUser), so an
// anonymous visitor got an opaque `HTTP 401` funnelled into "Could not
// load your profile — check your connection", which blames the network for
// what is really "you aren't signed in".
//
// Run with: node --test tests/topochain-profile-web.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const indexHtml = read('public/index.html');
const nativeChrome = read('public/js/native-chrome.js');
const profileJs = read('public/js/profile.js');

// ─── The drawer row ships visible ───────────────────────────────────────

test('drawer-row-profile carries no `hidden` class', () => {
  const anchor = indexHtml.slice(
    indexHtml.indexOf('<a id="drawer-row-profile"'),
    indexHtml.indexOf('</a>', indexHtml.indexOf('<a id="drawer-row-profile"'))
  );
  assert.ok(anchor, 'the profile anchor must exist');
  const classAttr = (anchor.match(/class="([^"]*)"/) || [])[1] || '';
  assert.ok(!/\bhidden\b/.test(classAttr),
    'the row must ship visible — a `hidden` class puts it back behind the bridge');
});

test('native-chrome no longer gates the profile row on getProfileInfo', () => {
  const fn = nativeChrome.slice(
    nativeChrome.indexOf('_initDrawerRows()'),
    nativeChrome.indexOf('// ── Platform login handoff')
  );
  assert.ok(fn.length, '_initDrawerRows must still exist');
  assert.doesNotMatch(fn, /has\(['"]getProfileInfo['"]\)/,
    'the capability probe was the only thing keeping #profile off the web');
  // The drawer-close wiring is the reason the function still exists.
  assert.match(fn, /drawer-row-profile/);
  assert.match(fn, /HeaderMenu\.close\(\)/);
});

test('the stale "hidden unless the bridge reports getProfileInfo" comments are gone', () => {
  // Comments that describe behaviour the code no longer has are worse than
  // no comment: the next reader trusts them.
  const anchorComment = indexHtml.slice(
    Math.max(0, indexHtml.indexOf('<a id="drawer-row-profile"') - 700),
    indexHtml.indexOf('<a id="drawer-row-profile"')
  );
  assert.doesNotMatch(anchorComment, /Hidden unless/i);
  assert.doesNotMatch(
    nativeChrome.slice(0, nativeChrome.indexOf('const NativeChrome')),
    /shown\s*\n?\/\/\s*when the bridge reports getProfileInfo/,
    'the module header must not still claim the row is capability-gated');
});

test('the screen-host comments no longer describe an external leaderboard', () => {
  // The screen reads from this platform's own database now; the external
  // deployment it used to proxy is retired. Anchored on #profile-screen
  // alone since the leaderboard merge: the sibling #challenges-screen
  // <main> this used to start from is gone, folded into the Leaderboard
  // screen's Challenges tab.
  const hosts = indexHtml.slice(
    indexHtml.indexOf('<main id="profile-screen"') - 900,
    indexHtml.indexOf('<main id="profile-screen"') + 400
  );
  assert.doesNotMatch(hosts, /public leaderboard service/);
  assert.doesNotMatch(hosts, /using the bridge's\s*\n?\s*getProfileInfo participant id/);
  assert.match(hosts, /in-process/,
    'the comments should say where the data actually comes from');
});

// ─── Signed-out state ───────────────────────────────────────────────────

test('_fetchJson carries the HTTP status onto the thrown Error', () => {
  // Without this, _load() cannot tell 401 (not signed in) from 500.
  const fn = profileJs.slice(
    profileJs.indexOf('async _fetchJson('),
    profileJs.indexOf('async _load(')
  );
  assert.match(fn, /err\.status\s*=\s*res\.status/);
});

test('_load renders the signed-out state for an anonymous visitor', () => {
  const fn = profileJs.slice(
    profileJs.indexOf('async _load('),
    profileJs.indexOf('// ── rendering')
  );
  // Cheap pre-check: the SPA boots anonymously, so skip the round-trip.
  assert.match(fn, /App\.user/, 'checks for a session before fetching');
  assert.match(fn, /signedOut:\s*true/);
  // And the 401 branch, for a session that lapsed while the screen was open.
  assert.match(fn, /err\.status === 401/);
});

test('a 401 replaces stale data rather than leaving the last user on screen', () => {
  const fn = profileJs.slice(
    profileJs.indexOf('async _load('),
    profileJs.indexOf('// ── rendering')
  );
  const branch = fn.slice(fn.indexOf('err.status === 401'));
  // `_data = { signedOut: true }` unconditionally — NOT `if (!_data)`,
  // which would keep showing the previous user's rank after logout.
  assert.match(branch.slice(0, 300), /Profile\._data = \{ signedOut: true \}/);
});

test('the signed-out render offers a sign-in link, not the connection error', () => {
  const fn = profileJs.slice(profileJs.indexOf('_render() {'));
  const branch = fn.slice(fn.indexOf('d.signedOut'), fn.indexOf('if (d.error)'));
  assert.match(branch, /Sign in to see your profile/);
  assert.match(branch, /#login/, 'links to the in-SPA login route');
  // The generic copy must survive for REAL failures.
  assert.match(fn, /Could not load your profile/);
});

test('the signed-out branch is checked before the generic error branch', () => {
  const fn = profileJs.slice(profileJs.indexOf('_render() {'));
  assert.ok(fn.indexOf('d.signedOut') < fn.indexOf('if (d.error)'),
    'otherwise a signed-out visitor still sees the connection-error copy');
});
