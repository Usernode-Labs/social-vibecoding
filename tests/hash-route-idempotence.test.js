// Hash-driven navigation is IDEMPOTENT: switching `location.hash` to a
// sibling fragment must render the same screen state a cold load at that
// fragment renders (#1146).
//
// Why this became a contract rather than a nicety. The grouped capture
// runner (#1144/#1147) groups a run's declared checks by
// `origin + pathname + search` and visits a group's cohorts by WRITING
// location.hash on one already-loaded page instead of reloading it. Every
// place the shell treated "the document was loaded at this fragment" as the
// moment to read the address therefore stopped being reached, and the check
// saw the PREVIOUS cohort's screen. Three such places existed:
//
//   a. Leaderboard remembered its last section, so a bare #leaderboard
//      arriving from another tab kept that tab.
//   b. AdminConsole.route() bails out when level+section are unchanged, but
//      #admin/seasons' tail lives BELOW the section segment, so every
//      #admin/seasons/<tail> switch returned without repainting.
//   c. The `?shot=` / `?flow=` deep-link handlers latched on a
//      once-per-document boolean, so they applied only for the fragment the
//      document was cold-loaded at.
//
// capture/capture.js also carries a cold-reload fallback for a cohort that
// fails after a hash switch, and that stays — but the fallback lives in the
// capture image, which is built from main, so it can never green the PR that
// introduces it. The shell fix is the one that has to hold on its own.
//
// Static-assertion style (cf. tests/standings-screen.test.js): these are
// source-shape assertions about seams that a later refactor could silently
// undo, not behavioural tests — the behaviour is covered by the declared
// dapp.json checks named at the bottom of each section.
//
// Run with: node --test tests/hash-route-idempotence.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const appJs = read('public/js/app.js');
const appView = read('public/js/app-view.js');
const consoleJs = read('frontend/src/features/admin/admin-console.js');
const captureJs = read('capture/capture.js');
const manifest = JSON.parse(read('dapp.json'));

const body = (src, start) => {
  const from = src.indexOf(start);
  assert.ok(from > -1, `${start} exists`);
  // A window over the function, wide enough for the whole of _routeFromHash.
  return src.slice(from, from + 1800);
};

// ─── (a) The leaderboard's bare hash resets to Challenges ────────────────

test('_routeLeaderboard treats the ABSENCE of a sub-segment as an instruction', () => {
  const fn = body(appJs, '_routeLeaderboard(sub, profileUser, challengeTarget) {');
  assert.match(fn, /!sub && window\.Leaderboard\?\._setSection/,
    'a falsy sub selects a section rather than falling through');
  assert.match(fn, /_setSection\('challenges'\)/,
    'and the section it selects is Challenges, the default tab (#2374)');
  // Ordering matters: a profile deep link (#leaderboard/users/<name>) is
  // still a sub-segment arrival and must not be swallowed by the reset.
  assert.ok(
    fn.indexOf('openProfile') < fn.indexOf("_setSection('challenges')"),
    'the profile deep link is still resolved first'
  );
});

test('the bare-#leaderboard reset is the declared contract, not an opinion', () => {
  const t = (manifest.tests || []).find((x) => x.path === '/#leaderboard'
    && /opens on Challenges/.test(x.name || ''));
  assert.ok(t, 'a declared check pins bare #leaderboard to Challenges');
  assert.match(t.expectSelector, /#challenges-root:not\(\.hidden\)/,
    'and asserts the challenges pane is the visible one');
});

// ─── (b) Admin sections re-read a tail the router cannot see ─────────────

test('AdminConsole.route() re-applies the section hash instead of bailing silently', () => {
  const fn = body(consoleJs, '  route(section, opts) {');
  assert.match(fn, /targetLevel === AdminConsole\._level && targetSection === AdminConsole\._section\)\s*\{\s*\n\s*AdminConsole\._reapplySectionHash\(\);/,
    'the level+section early return re-applies before returning');
});

test('_reapplySectionHash re-runs the cold-load render, gated on the address moving', () => {
  const fn = body(consoleJs, '  _reapplySectionHash() {');
  assert.match(fn, /if \(AdminConsole\._routedHash === location\.hash\) return;/,
    'an unchanged address is a no-op — which keeps the #1102 double-dispatch guard');
  assert.match(fn, /AdminConsole\._renderSection\(\);/,
    'a changed address re-runs _renderSection, the same path a cold load takes');
  assert.match(fn, /_isMobile\(\) && AdminConsole\._level === 1\) return;/,
    'mobile level 1 is the menu, so nothing below #admin addresses anything there');
});

test('every path that paints a section records the address it painted', () => {
  // Recording only in _reapplySectionHash would make the FIRST switch after
  // a cold load a no-op, because _routedHash would still be null-vs-hash…
  // and recording only before the render would miss the address the section
  // module heals itself to with replaceState.
  assert.match(consoleJs, /_routedHash: null,/, 'the recorded address starts empty');
  const marks = consoleJs.match(/AdminConsole\._markRouted\(\);/g) || [];
  assert.ok(marks.length >= 5,
    `every render path marks the address it rendered (found ${marks.length})`);
  const render = body(consoleJs, '  _renderContent() {');
  assert.match(render, /AdminConsole\._markRouted\(\);/,
    '_renderContent marks, so a cold load does not leave the address unrecorded');
});

test('the #admin/season-events deep links that share one level+section are all declared', () => {
  const paths = (manifest.tests || []).map((t) => t.path);
  for (const p of [
    '/#admin/season-events',
    '/#admin/season-events/900504',
    '/#admin/season-events/900504/new-challenge/900501',
  ]) {
    assert.ok(paths.includes(p), `a check exercises ${p}`);
  }
  // Since #1179 the programme screens are sections of their own, so most
  // hash switches between them change the SECTION and repaint anyway. The
  // Season-events tails above are the survivors that share one level 2 /
  // section 'season-events' target — without _reapplySectionHash the
  // second and third render the first's screen whenever the runner
  // reaches them by hash switch.
  const tails = paths.filter((p) => p.startsWith('/#admin/season-events/'));
  assert.ok(tails.length >= 2,
    `the season-events section is addressed by several tails (${tails.length})`);
});

// ─── (c) `?shot=` deep links are a property of the ADDRESS ───────────────

test('the state-painting shot appliers re-run on every fragment change', () => {
  const fn = body(appJs, '  _applyRouteShots() {');
  assert.match(fn, /if \(App\._shotHash === location\.hash\) return;/,
    'deduped on the hash, so a traversal\'s popstate+hashchange pair applies once');
  // `_applyMenuShot` was here and went with the hamburger drawer it opened.
  for (const applier of ['_applyLaunchShot', '_applyFeedbackShot']) {
    assert.match(fn, new RegExp(`App\\.${applier}\\(\\)`), `${applier} is re-applied`);
  }
  assert.match(appJs, /_shotHash: null,/, 'the recorded address starts empty');
});

test('both history listeners route AND re-apply, through one entry point', () => {
  assert.match(appJs, /window\.addEventListener\('popstate', \(\) => App\._routeFromHash\(\)\);/,
    'popstate goes through _routeFromHash');
  assert.match(appJs, /window\.addEventListener\('hashchange', \(\) => App\._routeFromHash\(\)\);/,
    'hashchange goes through _routeFromHash');
  const fn = body(appJs, '  _routeFromHash() {');
  assert.match(fn, /App\.restoreFromHash\(\);[\s\S]*App\._applyRouteShots\(\);/,
    'it routes first, then applies the shots for the address it landed on');
});

test('the NAVIGATION-driving shot stays once per document', () => {
  // `_applySettingsBackShot` assigns a hash then traverses back out of it, so
  // it CAUSES a hashchange — re-running it from the handler for that
  // hashchange would loop. `_applyMenuNavShot` was the other one: it clicked
  // a drawer row, and went with the drawer.
  const boot = body(appJs, '    App.restoreFromHash();\n    // The fragment-scoped');
  assert.match(boot, /App\._applyRouteShots\(\);/, 'boot applies the painting shots');
  assert.match(boot, /App\._applySettingsBackShot\(\);/, 'and the navigation one');
  const routed = body(appJs, '  _routeFromHash() {');
  assert.doesNotMatch(routed, /_applyMenuNavShot|_applySettingsBackShot/,
    'but the routed path does not repeat it');
});

// The dev board's ⋯ shot is held the same way: the surface has to be UP WHEN
// THE PAGE IS JUDGED, which one open cannot promise (the dev chat's shot
// surfaces, which this file pinned too, went with the dev chat).
// `.dev-card-menu` is position:fixed and dismisses on any scroll by
// design (initCardMenus), and a column that finishes loading late scrolls the
// board — so stopping at the first success leaves the check judging a bare
// board. It is re-asserted for its window too.
test('the dev board card-menu shot is re-asserted, not stopped at the first open', () => {
  const from = appView.indexOf("      if (shot === 'card-menu') {");
  assert.ok(from > -1, "the card-menu shot exists");
  const fn = appView.slice(from, appView.indexOf('}, 300);', from));
  assert.ok(fn.includes('data-card-menu="detail:${asked[0]}"'), 'direct links also find full-card menus');
  assert.match(fn, /if \(arrived\) return;/,
    'an open menu is left alone for this tick rather than ending the window');
  assert.match(fn, /if \(App\.currentApp !== slug \|\| \(tries \+= 1\) > \d+\) \{\s*done\(\);/,
    'only a route change or the try cap ends it');
  assert.match(fn, /const onUserInput = \(e\) => \{ if \(!e \|\| e\.isTrusted\) done\(\); \};/,
    'a real gesture ends it too — a human never gets a menu put back under them');
  assert.match(fn, /addEventListener\('pointerdown', onUserInput, true\)/);
  assert.match(fn, /removeEventListener\('keydown', onUserInput, true\)/,
    'and done() takes the listeners back off');
});

// ─── The capture-side belt and braces stays ──────────────────────────────

test('capture.js keeps the cold-reload fallback for a failed hash cohort', () => {
  assert.match(captureJs, /TEST_COHORT_RELOAD_FALLBACK/,
    'the fallback is still present and still has its off switch');
});
