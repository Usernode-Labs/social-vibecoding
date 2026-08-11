// Screen-transition mutation ORDER (issue #979).
//
// The bug this file exists to prevent: `PlatformUI.transition(fn, {type})`
// wraps `fn` in a View Transition, and a View Transition captures the
// OUTGOING page at the next rendering opportunity — NOT at the
// startViewTransition() call. So every DOM mutation a navigation makes
// synchronously AFTER calling transition(), but before `fn` runs, is baked
// into the ::view-transition-old(root) snapshot that the animation slides
// away. The Settings animation therefore showed the INCOMING page behind
// itself: the sibling screens had already been hidden and the header
// already retitled by the time the snapshot was taken.
//
// The invariant, pinned here for every screen navigation in app.js:
//
//   nothing visible is mutated before the PlatformUI.transition() call —
//   the screen swap (App._showOnlyScreen), the header title, the back
//   button, the drawer's app-scoped rows and the incoming module's own
//   chrome sync ALL happen inside the callback;
//
//   the _exitX helpers are state-only, so the outgoing screen is still
//   painted when the snapshot is taken.
//
// Source-structure assertions, like the rest of the app.js coverage —
// app.js is a browser-global script with no module seam to import.
//
// Run with: node --test tests/screen-transition-order.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const platformUiJs = fs.readFileSync(path.join(root, 'public/js/platform-ui.js'), 'utf8');
const nativeJs = fs.readFileSync(
  path.join(root, 'public/usernode-native/v1/native.js'), 'utf8');

// Every screen root the shell can show, and the screens that swap between
// them. Kept as literals so a new screen that forgets the discipline shows
// up as a missing entry rather than passing vacuously.
const SCREEN_ROOTS = ['app-view', 'home-screen', 'browse-screen',
  'leaderboard-screen', 'profile-screen', 'admin-screen', 'settings-screen'];

const NAVIGATIONS = [
  { fn: 'navigateToLeaderboard', reveal: 'leaderboard-screen' },
  { fn: 'navigateToProfile', reveal: 'profile-screen' },
  { fn: 'navigateToBrowse', reveal: 'browse-screen' },
  { fn: 'navigateToAdminConsole', reveal: 'admin-screen' },
  { fn: 'navigateToSettings', reveal: 'settings-screen' },
];

const EXITS = ['_exitLeaderboard', '_exitProfile', '_exitBrowse',
  '_exitAdminConsole', '_exitSettings'];

// The body of a top-level App method, from its two-space-indented
// definition to the closing `},` at the same indent.
function methodBody(name) {
  const start = appJs.indexOf(`\n  ${name}(`);
  assert.ok(start > 0, `${name} is defined in app.js`);
  const end = appJs.indexOf('\n  },', start);
  assert.ok(end > start, `${name} has a closing brace`);
  return appJs.slice(start, end);
}

// ── The shared primitive ───────────────────────────────────────────────

test('SCREEN_IDS lists every mutually exclusive screen root', () => {
  const m = appJs.match(/SCREEN_IDS: \[([\s\S]*?)\]/);
  assert.ok(m, 'App.SCREEN_IDS is declared');
  const ids = [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
  assert.deepEqual(ids.slice().sort(), SCREEN_ROOTS.slice().sort(),
    'SCREEN_IDS is exactly the set of screen roots');
});

test('_showOnlyScreen hides every other root, reveals one, resets the chevron', () => {
  const body = methodBody('_showOnlyScreen');
  assert.match(body, /for \(const id of App\.SCREEN_IDS\)/,
    'it iterates the one list');
  assert.match(body, /if \(id === revealId \|\| keep\.includes\(id\)\) continue;/,
    'the revealed screen (and any explicitly kept one) is skipped');
  // Both sides go through the visibility seam (#1078) rather than writing
  // `.hidden` themselves — see App._setScreenVisible, which forwards to the
  // React store for a React-owned root and falls back to the class otherwise.
  assert.match(body, /App\._setScreenVisible\(id, false\)/, 'the rest are hidden');
  assert.match(body, /App\._setScreenVisible\(revealId, true\)/, 'the target is revealed');
  assert.match(body, /App\.setBackIcon\('home'\)/,
    "the back chevron goes back to meaning 'home' on every swap");
  // The comment is load-bearing: the ordering rule is invisible from the
  // call sites, so it must be stated where the primitive lives.
  const doc = appJs.slice(appJs.indexOf('  SCREEN_IDS:') - 1400,
    appJs.indexOf('  _showOnlyScreen(revealId, keepAlso) {'));
  assert.match(doc, /captures the OUTGOING page at the\s*\n\s*\/\/ next rendering opportunity/,
    'the capture-timing rule is documented at the primitive');
});

// ── The invariant, per navigation ──────────────────────────────────────

for (const { fn, reveal } of NAVIGATIONS) {
  test(`${fn} mutates nothing visible before its transition`, () => {
    const body = methodBody(fn);
    const at = body.indexOf('PlatformUI.transition(');
    assert.ok(at > 0, `${fn} runs a screen transition`);
    const before = body.slice(0, at);
    // '_setScreenVisible(' is the #1078 visibility seam — the same mutation
    // as the classList write it replaced, so it is forbidden here for the
    // same reason.
    for (const forbidden of ['classList', '_setScreenVisible(', 'setHeaderTitle(',
      'setBackIcon(', 'syncChrome(', 'AppView.close(']) {
      assert.ok(!before.includes(forbidden),
        `${fn}: ${forbidden} runs before the transition — it would be captured `
        + 'into the snapshot of the page being left (#979)');
    }
    const callback = body.slice(at);
    assert.ok(callback.includes(`App._showOnlyScreen('${reveal}')`),
      `${fn}: the swap to #${reveal} happens inside the callback`);
    assert.ok(callback.includes('App._enterScreenChrome()'),
      `${fn}: the back button / drawer rows are set inside the callback`);
    assert.match(callback, /App\.setHeaderTitle\(/,
      `${fn}: the header title is set inside the callback`);
  });
}

test('navigateHome swaps and retitles inside its transition', () => {
  const body = methodBody('navigateHome');
  const at = body.indexOf('PlatformUI.transition(');
  assert.ok(at > 0, 'navigateHome runs a transition');
  const before = body.slice(0, at);
  for (const forbidden of ['classList', 'setHeaderTitle(', 'setBackIcon(',
    'AppView.close(']) {
    assert.ok(!before.includes(forbidden),
      `navigateHome: ${forbidden} runs before the transition (#979)`);
  }
  const callback = body.slice(at);
  // #app-view is the ONE root kept alive past the callback: on the real
  // zoom-out it is the pinned card that shrinks into the tile, so the kit's
  // `after` hook is what conceals it.
  assert.ok(callback.includes("App._showOnlyScreen('home-screen', ['app-view'])"),
    'home is revealed and every root but the shrinking app card is hidden');
  assert.match(callback, /App\.setHeaderTitle\('dApps'\)/);
  assert.match(callback, /after: \(\) => \{[\s\S]*av\.classList\.add\('hidden'\)/,
    'the app view itself is concealed in the kit `after` hook');
});

test('navigateToApp reveals in fn and conceals every other root in after', () => {
  const body = appJs.slice(appJs.indexOf('  async navigateToApp('));
  const zoom = body.slice(0, body.indexOf('await AppView.open('));
  const at = zoom.indexOf('PlatformUI.transition(');
  assert.ok(at > 0, 'navigateToApp runs a transition');
  const before = zoom.slice(0, at);
  for (const forbidden of ['classList', '_setScreenVisible(', 'setHeaderTitle(',
    'setBackIcon(']) {
    assert.ok(!before.includes(forbidden),
      `navigateToApp: ${forbidden} runs before the transition (#979)`);
  }
  const callback = zoom.slice(at);
  assert.match(callback, /App\._setScreenVisible\('app-view', true\)/,
    'fn reveals the app view (the departing screen stays visible beneath it)');
  assert.match(callback, /getElementById\('back-btn'\)\.classList\.remove\('hidden'\)/,
    'the back button is revealed inside the callback too');
  assert.match(callback, /after: \(\) => \{ App\._showOnlyScreen\('app-view'\); \}/,
    'the conceal hook hides EVERY other root — the _exitX helpers no longer do');
  // The one deliberate exception, documented at the call site: the
  // app-to-app AppView.close() stays synchronous because restoreFromHash
  // re-stashes AppView.pendingInnerPath right after this call (#743).
  assert.match(before, /AppView\.close\(\);/,
    'the app-to-app teardown stays synchronous on purpose');
  assert.match(before, /pendingInnerPath/,
    'and says why, so it is not "fixed" into the callback later');
});

// ── One entry per navigation ───────────────────────────────────────────

test('every screen entry is guarded against a duplicate dispatch', () => {
  // A fragment navigation fires BOTH popstate and hashchange, so
  // restoreFromHash runs TWICE in one tick. Without an already-mounted
  // guard the second run replays the whole entry — and because the first
  // run's View Transition is still pending, the kit applies that replay
  // INSTANTLY, i.e. before the outgoing page is captured. The screen then
  // appears behind its own entry animation, which is the #979 symptom
  // even with every mutation correctly inside the callback. Verified in a
  // real browser: without these guards the leaderboard/profile entries
  // snapshot themselves as the "previous page".
  assert.match(appJs, /window\.addEventListener\('popstate', \(\) => App\.restoreFromHash\(\)\);/);
  assert.match(appJs, /window\.addEventListener\('hashchange', \(\) => App\.restoreFromHash\(\)\);/);
  const guards = {
    navigateToLeaderboard: /if \(App\._inLeaderboard && window\.Leaderboard\?\.isOpen\?\.\(\)\)/,
    navigateToProfile: /if \(App\._inProfile && window\.Profile\?\.isOpen\?\.\(\)\)/,
    navigateToBrowse: /if \(App\._inBrowse && window\.Browse\?\.isOpen\?\.\(\)\)/,
    navigateToAdminConsole: /if \(App\._inAdmin && window\.AdminConsole\?\.isOpen\?\.\(\)\)/,
    navigateToSettings: /if \(App\._inSettings && window\.Settings\?\.isOpen\?\.\(\)\)/,
  };
  for (const [fn, guard] of Object.entries(guards)) {
    const body = methodBody(fn);
    assert.match(body, guard, `${fn} bails out when its screen is already mounted`);
    const at = body.search(guard);
    assert.ok(at < body.indexOf('PlatformUI.transition('),
      `${fn}: the guard runs before the transition, so a replay never starts one`);
  }
});

// ── The exits are state-only ───────────────────────────────────────────

for (const name of EXITS) {
  test(`${name} is state-only — no screen hide, no chevron reset`, () => {
    const body = methodBody(name);
    assert.ok(!body.includes('classList'),
      `${name} must not hide its screen: that deletes the outgoing page `
      + 'before the View Transition captures it (#979)');
    assert.ok(!body.includes('setBackIcon'),
      `${name} must not reset the back icon — _showOnlyScreen does, inside `
      + 'the transition callback');
    assert.match(body, /App\._in[A-Za-z]+ = false;/,
      `${name} still clears its flag`);
  });
}

// ── The modules cooperate ──────────────────────────────────────────────

test('the three chrome-writing screen modules accept chrome: false', () => {
  const files = {
    'frontend/src/features/settings/settings.js': 'Settings',
    'frontend/src/features/admin/admin-console.js': 'AdminConsole',
    'public/js/browse.js': 'Browse',
  };
  for (const [file, name] of Object.entries(files)) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(src, /_chromeSuspended:\s*false,/,
      `${name} tracks the suspension`);
    assert.match(src, /_chromeSuspended = !!\(opts && opts\.chrome === false\);/,
      `${name}.open() honours { chrome: false }`);
    assert.match(src, new RegExp(`syncChrome\\(\\) \\{\\s*\\n\\s*${name}\\._chromeSuspended = false;`),
      `${name}.syncChrome() clears the suspension and applies the chrome`);
    assert.match(src, new RegExp(`${name}\\._chromeSuspended\\) return;`),
      `${name}._syncChrome() is inert while suspended`);
  }
});

// ── The rule is written down where the next caller will look ───────────

test('the capture-timing rule is documented in the kit and its wrapper', () => {
  const kitDoc = nativeJs.slice(nativeJs.indexOf('   * Page transitions.'),
    nativeJs.indexOf('  var vtActive = false;'));
  assert.match(kitDoc, /captures the OLD\s*\n\s+\* state at the next rendering opportunity/,
    'the kit documents when the old snapshot is taken');
  const wrapperDoc = platformUiJs.slice(
    platformUiJs.indexOf('/** Screen transition wrapper.'),
    platformUiJs.indexOf('transition(fn, opts) {'));
  assert.match(wrapperDoc, /EVERY VISIBLE MUTATION OF THE NAVIGATION GOES INSIDE `fn`/,
    'PlatformUI.transition states the rule for platform call sites');
});
