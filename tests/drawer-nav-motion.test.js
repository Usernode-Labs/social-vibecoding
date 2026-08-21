// Single-motion navigation out of the slide-out drawer (#977).
//
// Tapping Leaderboard / Settings / Profile / Admin in the drawer used to
// start TWO animations at once: the drawer's own exit spring, and the
// kit's push View Transition — which snapshots the whole document root,
// so the open drawer parallaxed away inside the outgoing snapshot while
// the live panel sprang the other way. The fix keeps the drawer's exit
// as the only motion and cuts the screen swap to type:'none'.
//
// Every strand here fails SILENTLY if it drifts — the double animation
// simply comes back on one screen, or a chained sheet never presents —
// so each is pinned against the shipped source, in the static-assertion
// style of tests/header-menu-panel.test.js.
//
// Run with: node --test tests/drawer-nav-motion.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const appJs = read('public/js/app.js');
// #1079 chunk B moved both modules into the React bundle; same files.
const nodePillJs = read('frontend/src/features/header/node-pill.js');
const walletSheetJs = read('frontend/src/features/header/wallet-sheet.js');
// …and moved App.HeaderMenu itself, beside the markup it drives. app.js keeps
// a forwarder, so its own call sites below are unchanged; the drawer's
// behaviour is asserted against the module that owns it now.
const headerMenuJs = read('frontend/src/features/header/header-menu-controller.js');
const dapp = JSON.parse(read('dapp.json'));

// The App._entryTransition body.
function entryTransition() {
  const at = appJs.indexOf('  _entryTransition(preferred, screenEl) {');
  assert.ok(at !== -1, 'App._entryTransition went missing');
  return appJs.slice(at, appJs.indexOf('\n  },', at));
}

// The HeaderMenu object, up to the window publication after it.
function headerMenu() {
  const at = headerMenuJs.indexOf('const HeaderMenu = {');
  assert.ok(at !== -1, 'the HeaderMenu controller went missing');
  const end = headerMenuJs.indexOf("typeof window !== 'undefined'", at);
  assert.ok(end !== -1, 'could not find the end of HeaderMenu');
  return headerMenuJs.slice(at, end);
}

function headerMenuFn(signature) {
  const menu = headerMenu();
  const at = menu.indexOf(signature);
  assert.ok(at !== -1, `HeaderMenu.${signature} went missing`);
  return menu.slice(at, menu.indexOf('\n  },', at));
}

// ── The transition gate ────────────────────────────────────────────────

test('_entryTransition suppresses the screen animation for the drawer', () => {
  const fn = entryTransition();
  assert.match(fn, /consumeNavPending\(\)/,
    'a link inside the drawer arms the one-shot flag — it must be consulted');
  assert.match(fn, /isPresenting\(\)/,
    'a drawer still on screen (or still springing out) must suppress too');
  assert.match(fn, /\?\s*'none'\s*:\s*preferred/,
    "suppression means type:'none' — the kit's own rule for panels");
});

test('the one-shot nav flag is consumed unconditionally, not short-circuited', () => {
  const fn = entryTransition();
  const consume = fn.indexOf('consumeNavPending()');
  const presenting = fn.indexOf('isPresenting()');
  assert.ok(consume !== -1 && presenting !== -1);
  assert.ok(consume < presenting,
    'consumeNavPending() must be read FIRST: behind a || an already-presenting '
    + 'drawer would skip it and leave the flag armed for the NEXT navigation');
  assert.ok(!/isPresenting\(\)\s*\|\|[\s\S]{0,80}consumeNavPending\(\)/.test(fn),
    'the one-shot read must not sit on the right of a short-circuiting ||');
});

test('the resolved type is stamped on the screen element', () => {
  const fn = entryTransition();
  assert.match(fn, /setAttribute\('data-entered', type\)/,
    'the dapp checks assert data-entered — mid-animation state is otherwise untestable');
  assert.match(fn, /screenEl && screenEl\.setAttribute/,
    'a missing/odd screen element must not throw mid-navigation');
});

// ── Every screen entry routes through it ───────────────────────────────

test('all eight screen transitions go through App._entryTransition', () => {
  const calls = appJs.match(/PlatformUI\.transition\(/g) || [];
  assert.equal(calls.length, 8,
    `expected 8 PlatformUI.transition call sites in app.js, found ${calls.length} — `
    + 'a new one must route its type through App._entryTransition too');
  const routed = appJs.match(/type: App\._entryTransition\(/g) || [];
  assert.equal(routed.length, 8,
    'every call site must take its type from the gate, or that screen keeps '
    + 'animating over the closing drawer');
});

test('no screen entry still hard-codes its transition type', () => {
  assert.ok(!/type: fromIframe \? 'none' : 'push'/.test(appJs),
    "a bare `type: fromIframe ? 'none' : 'push'` bypasses the gate — that IS the bug");
  assert.ok(!/type: 'zoom-in'/.test(appJs),
    'navigateToApp is reachable from the drawer (the footer fork link), so its '
    + 'zoom must go through the gate as well');
  assert.ok(!/type: 'zoom-out'/.test(appJs),
    'navigateHome routes through the gate too, for one rule everywhere');
});

test('each named screen entry passes its own screen element to the gate', () => {
  for (const nav of ['navigateToLeaderboard', 'navigateToProfile',
    'navigateToBrowse', 'navigateToAdminConsole', 'navigateToSettings',
    'navigateToMessages']) {
    const at = appJs.indexOf(`  ${nav}(`);
    assert.ok(at !== -1, `${nav} went missing`);
    const body = appJs.slice(at, appJs.indexOf("getElementById('back-btn')", at));
    assert.match(body, /App\._entryTransition\(fromIframe \? 'none' : 'push', screen\)/,
      `${nav} must hand the gate the screen it is revealing, so data-entered lands on it`);
  }
});

test('the zoom sites keep their split mutation intact under the gate', () => {
  // type:'none' still runs fn() and then opts.after() as one mutation
  // (kit contract), so `after` must remain — dropping it would leave the
  // outgoing screen painted behind the new one. #979 widened the conceal
  // from "just `departing`" to "every screen root" (App._showOnlyScreen),
  // since the _exitX helpers no longer hide their own screens.
  const nav = appJs.slice(appJs.indexOf('async navigateToApp('));
  const zoom = nav.slice(0, nav.indexOf('await AppView.open(slug)'));
  assert.match(zoom, /App\._entryTransition\('zoom-in', appViewEl\)/);
  assert.match(zoom, /after: \(\) => \{ App\._showOnlyScreen\('app-view'\); \}/,
    'the conceal half of the mutation must survive');
  const home = appJs.slice(appJs.indexOf('navigateHome() {'));
  assert.match(home.slice(0, home.indexOf('App.updateHash()')),
    /App\._entryTransition\('zoom-out', av\)/);
});

// ── HeaderMenu presentation state ──────────────────────────────────────

test('isPresenting() covers the legacy closing window, not just [data-open]', () => {
  const fn = headerMenuFn('isPresenting() {');
  assert.match(fn, /HeaderMenu\._panel/,
    'the kit handle is the touch path\'s authority — it survives until the '
    + 'exit spring rests');
  assert.match(fn, /hasAttribute\('data-open'\)/, 'the legacy slide-over while open');
  assert.match(fn, /_closingAt/,
    'close() strips [data-open] synchronously while the 200ms CSS slide still '
    + 'runs — without the timestamp the drawer reads as gone while visible');
  assert.match(fn, /CLOSING_WINDOW_MS/);
});

test('consumeNavPending() is one-shot and expires', () => {
  const fn = headerMenuFn('consumeNavPending() {');
  assert.match(fn, /HeaderMenu\._navArmedAt = 0/,
    'clearing on read is what keeps it from applying to a second navigation');
  assert.match(fn, /NAV_ARM_TTL_MS/,
    'a link that produced no hashchange must not leave the flag armed forever');
});

test('a delegated handler owns every link inside the drawer', () => {
  const init = headerMenuFn('init() {');
  assert.match(init, /getElementById\('header-menu-panel'\)/);
  assert.match(init, /closest\('a\[href\]'\)/,
    'one rule for all drawer links — the Kudos meter and the footer fork line '
    + 'never had a close handler of their own');
  assert.match(init, /getAttribute\('href'\)/,
    '.href resolves to an absolute URL, which would make every hash link look external');
  assert.match(init, /href\.startsWith\('#'\)[\s\S]{0,200}?_navArmedAt = HeaderMenu\._now\(\)/,
    'only a same-document hash link animates a screen in this document, so only '
    + 'it arms the suppression');
  // The listener must be on the panel element itself so it rides along
  // when the panel is adopted into the kit drawer.
  assert.match(init, /drawerPanel\.addEventListener\('click'/);
});

test('close() still dismisses through the kit handle first', () => {
  const close = headerMenuFn('close() {');
  assert.match(close.slice(0, 400), /HeaderMenu\._panel[\s\S]{0,200}?\.dismiss\(\)/,
    'close() must dismiss through the kit so onDismiss (and the node restore) runs');
  assert.match(close, /_closingAt = HeaderMenu\._now\(\)/,
    'the closing window has to start when close() runs, not when it finishes');
  assert.match(close, /return Promise\.resolve\(\)/,
    'a close with nothing open must still resolve, or a chained sheet never presents');
});

test('the close-completion promise settles on every exit path', () => {
  const menu = headerMenu();
  const after = headerMenuFn('_afterDismiss() {');
  assert.match(after, /_dismissWaiters\.push\(resolve\)/);
  assert.match(after, /setTimeout\(resolve, HeaderMenu\.DISMISS_SAFETY_MS\)/,
    'a teardown that never fires must not hang the caller forever');
  // Kit path: resolved BEFORE the newer-open ownership guard, or a superseded
  // teardown strands the caller until the safety cap.
  //
  // #1120 slice 3 moved both halves into the shared adoptKitSurface seam, so
  // the ordering is now a property of two files rather than of one function
  // body: the controller supplies the resolve as `onDismissStart` and the
  // guard as `stillOwns`, and lib/kit-surface.ts is what runs them in that
  // order. Both halves are asserted — either one alone would pass while the
  // waiters were being stranded.
  const adoption = menu.slice(menu.indexOf('adoptKitSurface({'));
  const startAt = adoption.indexOf('onDismissStart:');
  const guardAt = adoption.indexOf('stillOwns:');
  assert.ok(startAt !== -1, 'the kit teardown must resolve the waiters');
  assert.ok(guardAt !== -1, 'the newer-open ownership guard went missing');
  assert.match(adoption.slice(startAt, guardAt), /_resolveDismissWaiters\(\)/,
    'onDismissStart is the hook that runs ahead of the guard — resolving anywhere '
    + 'else means a superseded teardown returns early with the caller still waiting');
  assert.match(adoption.slice(guardAt), /HeaderMenu\._panel === adoption/,
    'stillOwns must compare against the CURRENT adoption, or a deferred teardown '
    + 'yanks the drawer out of the panel a newer open just adopted it into');

  const kitSurface = read('frontend/src/lib/kit-surface.ts');
  assert.match(kitSurface,
    /onDismissStart\?\.\(\);\s*\n\s*if \(options\.stillOwns && !options\.stillOwns\(\)\) return;/,
    'kit-surface must call onDismissStart before consulting stillOwns — that ordering '
    + 'is the whole reason the resolve lives in the earlier hook');
  // Legacy path: resolved alongside hiding the overlay.
  const close = headerMenuFn('close() {');
  assert.match(close, /overlay\.classList\.add\('hidden'\);[\s\S]{0,120}?_resolveDismissWaiters\(\)/,
    'the legacy slide resolves when its transition finishes');
});

test('opening the drawer clears any pending closing window', () => {
  const open = headerMenuFn('open() {');
  assert.match(open, /_closingAt = 0/,
    'reopening mid-exit must not leave a stale "still closing" timestamp');
});

// ── Overlays that stack on the drawer are sequenced ────────────────────

test('the Node and Wallet sheets present after the drawer is gone', () => {
  for (const [name, src, sheet] of [
    ['node-pill.js', nodePillJs, 'NodePill._openSheet()'],
    ['wallet-sheet.js', walletSheetJs, 'WalletSheet._openSheet()'],
  ]) {
    assert.match(src, /Promise\.resolve\(closed\)\.then\(\(\) =>/,
      `${name} must chain its sheet behind the close promise`);
    assert.ok(src.includes(`.then(() => ${sheet})`),
      `${name} must present its own sheet in that continuation`);
    assert.ok(!new RegExp(`close\\(\\);\\s*\\n\\s*}\\s*\\n\\s*${sheet.replace(/[.()]/g, '\\$&')}`).test(src),
      `${name} must no longer present while the drawer is still sliding out`);
    assert.match(src, /App\.HeaderMenu && App\.HeaderMenu\.close/,
      `${name} must keep working with no HeaderMenu present`);
  }
});

// "Share app" is an IMPROVE PANEL row now, not a drawer row: THE UI OVERHAUL
// moved the drawer's whole reference footer there, because every line in it
// was about an app and that panel is the surface scoped to one. The rule it
// was pinned for travelled with it — a dialog of its own must not fade in
// across its host surface's exit — so the assertion moves to the new owner
// rather than being dropped.
test('the Share dialog opens after the Improve panel is gone', () => {
  const improve = read('frontend/src/features/improve/improve-controller.js');
  const at = improve.search(/^ {2}share\(\) \{/m);
  assert.ok(at !== -1, 'the Improve panel owns the share action');
  // `?.()` as well as `()`: the panel reaches AppView off the window, which
  // a vm-sandboxed test may not have published.
  assert.match(improve.slice(at, at + 500),
    /Promise\.resolve\(Improve\.close\(\)\)\.then\(\(\) => \{[\s\S]{0,200}?openShareModal\??\.?\(\)/,
    'the share modal must not fade in across the panel\'s exit');
  // …and close() has to actually REPORT when the panel is gone, or chaining
  // on it resolves a frame after the request rather than after the exit.
  assert.match(improve, /^ {2}close\(\) \{[\s\S]*?return done;/m,
    'close() returns a completion promise, like HeaderMenu.close()');
  // …and nothing in the drawer still binds the retired row. An unguarded
  // getElementById on it is what took the whole boot down once.
  const init = headerMenuFn('init() {');
  assert.doesNotMatch(init, /getElementById\('drawer-row-share'\)/);
  assert.doesNotMatch(init, /getElementById\('drawer-row-github'\)/);
});

// ── The screenshot-state deep link + its checks ────────────────────────

test('?shot=menu-nav opens the drawer and taps a navigation row', () => {
  const at = appJs.indexOf('_applyMenuNavShot() {');
  assert.ok(at !== -1, 'the ?shot=menu-nav hook went missing');
  const fn = appJs.slice(at, appJs.indexOf('\n  },', at));
  assert.match(fn, /shot !== 'menu-nav'\) return/);
  assert.match(fn, /App\.HeaderMenu\.open\(\)/);
  // It clicked #drawer-row-leaderboard until THE UI OVERHAUL moved that row
  // to the home screen's Challenges area. What this shot is about is the
  // DRAWER's teardown, not any one destination, so it takes the first row
  // that is always there: Profile is unconditional, where Settings and Admin
  // are gated.
  assert.match(fn, /getElementById\('drawer-row-profile'\)[\s\S]{0,120}?\.click\(\)/,
    'a real anchor click is what exercises the hash → navigate* path end to end');
  assert.ok(!/IS_STAGING|USERNODE_ENV/.test(fn),
    'pure UI state, ungated — an env-gated link starves the production "before" shot');
  assert.match(appJs, /App\._applyMenuNavShot\(\);/, 'the hook must be called at boot');
});

test('the load-bearing check is declared and the reader keeps it', () => {
  // Slots used to be zero-sum: the reader kept only the first MAX_TESTS
  // declared checks, so five of ten were pinned near the top by other
  // issues' tests and this one spent the sixth. #1019 removed the parse cap
  // — every declared check runs through the capture pool — so position no
  // longer buys anything and the pinning arithmetic is gone.
  //
  // What replaces it: the reader must still KEEP this check (a malformed
  // entry is silently dropped, which would be just as invisible as the old
  // cap), and the manifest as a whole must stay under MAX_DECLARED_TESTS so
  // no tail is being shed.
  const appManifest = require('../src/services/app-manifest');
  const meta = appManifest.readTestsWithMeta(dapp);
  assert.equal(meta.ceilingDropped, 0,
    `dapp.json declares more than ${appManifest.MAX_DECLARED_TESTS} valid checks — `
    + 'checks past the ceiling never run');
  const kept = meta.tests.filter((t) => /shot=menu-nav/.test(t.path));
  assert.ok(kept.length >= 1,
    'the #977 check must survive the reader — a dropped check gates nothing');
  assert.equal(kept[0].path, '/?shot=menu-nav&un-platform=ios',
    'the forced-touch route is the load-bearing one: the kit side panel is '
    + 'where the two competing motions were actually visible');
  assert.match(kept[0].expectSelector, /data-entered="none"/);
});

test('dapp checks pin the single-motion result on both presentations', () => {
  const checks = (dapp.tests || []).filter(
    (t) => typeof t.path === 'string' && t.path.includes('shot=menu-nav')
  );
  assert.ok(checks.length >= 2,
    'without checks the double animation could silently come back');
  const entered = checks.filter(
    (t) => typeof t.expectSelector === 'string'
      && t.expectSelector.includes('data-entered="none"')
  );
  assert.ok(entered.some((t) => t.path.includes('un-platform=ios')),
    'the touch path (kit side panel) needs a forced-touch check');
  assert.ok(entered.some((t) => !t.path.includes('un-platform=')),
    'the desktop slide-over suppresses its fade too — pin that as well');
  assert.ok(checks.some((t) => typeof t.expectSelector === 'string'
    && t.expectSelector.includes('.un-panel')),
    'one check must prove the drawer is actually torn down afterwards');
});
