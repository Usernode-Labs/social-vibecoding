// Public Topochain screens (Task 14) — leaderboard + seasons/events, the
// two SPA screens the migration plan's Global Constraint #8 calls for:
// hash routes #topochain/leaderboard and #topochain/seasons, wired into
// public/js/app.js the same way the admin console (#818) is, minus any
// isAdmin gate (these are public reads, unlike the admin console).
//
// Contract pinned here, mirroring tests/admin-console-page.test.js:
//  - the hash router has a `topochain` branch dispatching to the two
//    navigate* functions;
//  - both screen containers ship hidden in the shell, like their siblings;
//  - both script tags are registered in index.html, before app.js;
//  - every sibling navigate/exit path also exits BOTH new screens (the
//    same _inX/_exitX discipline the leaderboard/challenges/profile/admin
//    screens already follow);
//  - the screen objects (TopochainLeaderboard / TopochainSeasons) define
//    the methods the brief calls for, and escape interpolated values with
//    the established esc() idiom;
//  - dapp.json carries a rendered-page check for both hash routes.
//
// Run with: node --test tests/topochain-screens.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const leaderboardJs = fs.readFileSync(path.join(root, 'public/js/topochain-leaderboard.js'), 'utf8');
const seasonsJs = fs.readFileSync(path.join(root, 'public/js/topochain-seasons.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

// ─── index.html: script registration + screen hosts ─────────────────────

test('both screen scripts are registered in index.html, before app.js', () => {
  const lbTag = '<script src="/js/topochain-leaderboard.js"></script>';
  const seTag = '<script src="/js/topochain-seasons.js"></script>';
  assert.ok(html.includes(lbTag), 'topochain-leaderboard.js is loaded by the shell');
  assert.ok(html.includes(seTag), 'topochain-seasons.js is loaded by the shell');
  const appTagIdx = html.indexOf('<script src="/js/app.js"></script>');
  assert.ok(appTagIdx > html.indexOf(lbTag), 'leaderboard script loads before app.js');
  assert.ok(appTagIdx > html.indexOf(seTag), 'seasons script loads before app.js');
});

test('both screens ship hidden in the shell like their siblings', () => {
  const lbMain = html.match(/<main id="topochain-leaderboard-screen"[^>]*>/);
  const seMain = html.match(/<main id="topochain-seasons-screen"[^>]*>/);
  assert.ok(lbMain, 'index.html carries #topochain-leaderboard-screen');
  assert.ok(seMain, 'index.html carries #topochain-seasons-screen');
  assert.match(lbMain[0], /class="hidden /, 'leaderboard screen ships hidden');
  assert.match(seMain[0], /class="hidden /, 'seasons screen ships hidden');
  assert.ok(html.includes('id="topochain-leaderboard-root"'), 'the leaderboard module renders into #topochain-leaderboard-root');
  assert.ok(html.includes('id="topochain-seasons-root"'), 'the seasons module renders into #topochain-seasons-root');
});

test('navigation entries reach both screens from the header drawer', () => {
  assert.match(html, /<a id="drawer-row-topochain-leaderboard" href="#topochain\/leaderboard"/,
    'a real anchor links to #topochain/leaderboard, like the Challenges/Profile drawer rows');
  assert.match(html, /<a id="drawer-row-topochain-seasons" href="#topochain\/seasons"/,
    'a real anchor links to #topochain/seasons');
});

// ─── app.js: router branch + state discipline ────────────────────────────

test('the hash router handles #topochain/leaderboard and #topochain/seasons', () => {
  assert.match(appJs, /parts\[0\] === 'topochain'/, 'restoreFromHash has a topochain branch');
  assert.match(appJs, /App\.navigateToTopochainSeasons\(\)/, 'the seasons sub-route dispatches to navigateToTopochainSeasons');
  assert.match(appJs, /App\.navigateToTopochainLeaderboard\(\)/, 'the default sub-route dispatches to navigateToTopochainLeaderboard');
});

test('navigateToTopochainLeaderboard and navigateToTopochainSeasons carry no isAdmin gate', () => {
  const lbFn = appJs.slice(
    appJs.indexOf('  navigateToTopochainLeaderboard()'),
    appJs.indexOf('  _exitTopochainLeaderboard()')
  );
  const seFn = appJs.slice(
    appJs.indexOf('  navigateToTopochainSeasons()'),
    appJs.indexOf('  _exitTopochainSeasons()')
  );
  assert.ok(lbFn.length > 0, 'navigateToTopochainLeaderboard exists in app.js');
  assert.ok(seFn.length > 0, 'navigateToTopochainSeasons exists in app.js');
  assert.ok(!/isAdmin/.test(lbFn), 'the leaderboard screen is a public read — no isAdmin check');
  assert.ok(!/isAdmin/.test(seFn), 'the seasons screen is a public read — no isAdmin check');
});

test('every full-screen exit path also exits both new screens', () => {
  const lbExits = appJs.match(/if \(App\._inTopochainLeaderboard\) App\._exitTopochainLeaderboard\(\);/g) || [];
  const seExits = appJs.match(/if \(App\._inTopochainSeasons\) App\._exitTopochainSeasons\(\);/g) || [];
  // Sibling sites: the app/else branches of restoreFromHash,
  // navigateToLeaderboard, navigateToChallenges, navigateToProfile,
  // navigateToAdminConsole, navigateToApp, navigateHome, plus each new
  // screen exiting the OTHER one — mirrors the >= 6 admin-console bar.
  assert.ok(lbExits.length >= 6,
    `_exitTopochainLeaderboard is called from the sibling navigate/exit sites (found ${lbExits.length}, expect >= 6)`);
  assert.ok(seExits.length >= 6,
    `_exitTopochainSeasons is called from the sibling navigate/exit sites (found ${seExits.length}, expect >= 6)`);
  assert.match(appJs, /else if \(App\._inTopochainLeaderboard\) App\.navigateHome\(\);/,
    'the empty-hash branch sends an open leaderboard screen home');
  assert.match(appJs, /else if \(App\._inTopochainSeasons\) App\.navigateHome\(\);/,
    'the empty-hash branch sends an open seasons screen home');
});

test('_inTopochainLeaderboard / _inTopochainSeasons state flags are declared', () => {
  assert.match(appJs, /_inTopochainLeaderboard: false,/, 'flag declared alongside its siblings');
  assert.match(appJs, /_inTopochainSeasons: false,/, 'flag declared alongside its siblings');
});

// ─── Screen objects: methods + esc() usage ───────────────────────────────

test('TopochainLeaderboard defines the expected surface', () => {
  assert.match(leaderboardJs, /const TopochainLeaderboard = \{/, 'the global object literal is defined');
  assert.match(leaderboardJs, /window\.TopochainLeaderboard = TopochainLeaderboard;/, 'mirrored onto window');
  for (const member of [
    'open()', 'close()', 'esc(', 'fetchJson(', 'loadEvents()', 'loadLeaderboard()',
    '_renderShell()', '_renderBody()', '_openDrill(', '_renderDrill()',
  ]) {
    assert.ok(leaderboardJs.includes(member), `TopochainLeaderboard defines ${member}`);
  }
});

test('TopochainSeasons defines the expected surface', () => {
  assert.match(seasonsJs, /const TopochainSeasons = \{/, 'the global object literal is defined');
  assert.match(seasonsJs, /window\.TopochainSeasons = TopochainSeasons;/, 'mirrored onto window');
  for (const member of [
    'open()', 'close()', 'esc(', 'fetchJson(', 'loadEvents()', 'loadEventAndChallenges()',
    '_renderHero()', '_renderGrid()', 'openChallengeDetail(', 'closeChallengeDetail()',
    'openUserProfile(', 'closeUserProfile()',
  ]) {
    assert.ok(seasonsJs.includes(member), `TopochainSeasons defines ${member}`);
  }
});

test('both modules fetch from the /api/v4 endpoints the brief specifies', () => {
  assert.match(leaderboardJs, /\/api\/v4\/season-events\?include_past=1/, 'leaderboard screen loads the event picker list');
  assert.match(leaderboardJs, /\/api\/v4\/leaderboard\?/, 'leaderboard screen loads the paginated table');
  assert.match(leaderboardJs, /\/api\/v4\/leaderboard\/user-activities\?/, 'drill-down loads activities');
  assert.match(leaderboardJs, /\/api\/v4\/leaderboard\/epoch-breakdown\?/, 'drill-down loads the epoch breakdown by wallet');
  assert.match(leaderboardJs, /\/api\/v4\/users\/.*\/profile/, 'drill-down can load a profile');

  assert.match(seasonsJs, /\/api\/v4\/season-events\?include_past=1/, 'seasons screen loads the event picker list');
  assert.match(seasonsJs, /\/api\/v4\/season-events\/\$\{encodeURIComponent\(eventId\)\}`/, 'hero loads the event detail');
  assert.match(seasonsJs, /\/api\/v4\/season-events\/.*\/challenges`/, 'grid loads challenges');
  assert.match(seasonsJs, /\/challenges\/\$\{encodeURIComponent\(challenge\.id\)\}\/breakdown/, 'detail overlay loads the challenge breakdown');
  assert.match(seasonsJs, /\/api\/v4\/users\/\$\{encodeURIComponent\(userId\)\}\/profile/, 'profile overlay loads /users/:id/profile');
});

test('display_leaderboard=false and API errors are handled without throwing', () => {
  assert.match(leaderboardJs, /display_leaderboard/, 'the leaderboard screen reads display_leaderboard off the event payload');
  assert.match(leaderboardJs, /_error/, 'a dedicated error state renders instead of a blank/broken screen');
  assert.match(seasonsJs, /_eventError|_challengesError/, 'the seasons screen carries dedicated error state for its fetches');
});

// ─── esc() discipline — every interpolated API value must pass through it ─

test('both screens escape interpolated values with the established esc() idiom', () => {
  for (const src of [leaderboardJs, seasonsJs]) {
    assert.match(src, /esc\(s\) \{\s*\n\s*return String\(s == null \? '' : s\)/,
      'esc() mirrors the admin-console.js helper shape');
  }
  // Spot-check: a sampling of API-sourced fields actually gets passed
  // through esc(...) rather than interpolated raw into template literals.
  for (const field of ['r.display_name', 'r.total_points', 'row.wallet_address']) {
    assert.ok(new RegExp(`esc\\(${field.replace('.', '\\.')}`).test(leaderboardJs),
      `${field} passes through esc() in topochain-leaderboard.js`);
  }
  for (const field of ['ev.name', 'cp.goal', 'p.display_name', 'e.display_name']) {
    assert.ok(new RegExp(`esc\\(${field.replace('.', '\\.')}`).test(seasonsJs),
      `${field} passes through esc() in topochain-seasons.js`);
  }
});

test('esc() escapes quotes too, not just & < >', () => {
  // Attribute-value breakout (`<option value="` / `data-*="`, ...) needs
  // both quote characters escaped, not just the text-node-unsafe three —
  // stopping-XSS review, task 14 fix.
  for (const src of [leaderboardJs, seasonsJs]) {
    const fn = src.slice(src.indexOf('esc(s) {'), src.indexOf('esc(s) {') + 300);
    assert.match(fn, /\.replace\(\/"\/g, '&quot;'\)/, 'esc() escapes double quotes');
    assert.match(fn, /\.replace\(\/'\/g, '&#39;'\)/, 'esc() escapes single quotes');
  }
});

test('the challenge CTA link is scheme-guarded before it ever reaches an href', () => {
  // stopping-XSS review, task 14 fix: a `javascript:` (or any non-http[s])
  // cta_link must never become a clickable anchor — only escaping the
  // string is not enough, the scheme itself must be validated.
  const safeHrefFn = seasonsJs.slice(seasonsJs.indexOf('safeHref(url) {'), seasonsJs.indexOf('async fetchJson(url) {'));
  assert.ok(safeHrefFn.length > 0, 'safeHref located');
  assert.ok(safeHrefFn.includes('/^https?:\\/\\//i.test(url)'),
    'safeHref validates the URL scheme with an http(s)-only regex');
  const ctaFn = seasonsJs.slice(seasonsJs.indexOf('_ctaHtml(dm) {'), seasonsJs.indexOf('_renderDetailOverlay() {'));
  assert.ok(ctaFn.length > 0, '_ctaHtml located');
  assert.match(ctaFn, /TopochainSeasons\.safeHref\(dm\.cta_link\)/,
    'the cta_link is run through safeHref before being used as an href');
  assert.match(ctaFn, /if \(!href\)/,
    'a link that fails the scheme check never reaches an <a href>');
  // The only href in either file is this one, scheme-guarded — assert
  // there is no OTHER raw href="${...}" interpolation anywhere that
  // bypasses safeHref.
  const hrefSites = (seasonsJs.match(/href="\$\{/g) || []).length
    + (leaderboardJs.match(/href="\$\{/g) || []).length;
  assert.equal(hrefSites, 1, 'exactly one interpolated href exists across both files — the safeHref-guarded cta_link');
});

// ─── dapp.json ────────────────────────────────────────────────────────────

test('dapp.json locks both rendered pages in with checks', () => {
  const tests = manifest.tests || [];
  const lb = tests.find((t) => t.path === '/#topochain/leaderboard');
  assert.ok(lb, 'a dapp.json test renders /#topochain/leaderboard');
  assert.match(lb.expectSelector, /#topochain-leaderboard-screen:not\(\.hidden\)/,
    'asserts the leaderboard screen is actually revealed, not just present');

  const se = tests.find((t) => t.path === '/#topochain/seasons');
  assert.ok(se, 'a dapp.json test renders /#topochain/seasons');
  assert.match(se.expectSelector, /#topochain-seasons-screen:not\(\.hidden\)/,
    'asserts the seasons screen is actually revealed, not just present');
});
