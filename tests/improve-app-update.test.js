// The Improve button follows the open app's own redeploy (task 446).
//
// Merging a change to an app rebuilt its production quietly: the only sign
// was the pill on the home tile, and on the app tab, where the person who
// just approved it is standing, nothing. The button's `deploying` spinner was
// wired to apps.status === 'deploying', a status app redeploys never set
// (services/app-deploy-status.js keeps that in memory on purpose), and the
// frame is kept alive across Home and back, so the change stayed invisible
// until a fresh session.
//
// Now the app_redeploy_status broadcast drives the same lifecycle the
// platform's own update already has: spinner while the build rolls out, the
// arrow glyph and a reload row once it has landed. What is pinned here:
//
//   1. The broadcast reaches the button for the app IN VIEW only, and a
//      failed build withdraws the spinner without offering a reload. A build
//      that lands lets the app's kept frame go (WP2), the app in view's
//      included, and a frame let go is not offered a reload as well.
//   2. The offer is withdrawn as it is taken up, and does not survive a
//      change of target.
//   3. The reload loads the frame TWICE, releasing its load handler between,
//      because an app following the offline convention answers the first
//      load from its shell cache (docs/app-slow-network-loading.md).
//
// Run with: node --test tests/improve-app-update.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { runModules, makeStoreStub } = require('./helpers/bundle-module');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_JS = read('public/js/app.js');
const SHEET = read('frontend/src/features/app-context/app-context-sheet.tsx');
const PANEL = read('frontend/src/features/improve/actions.tsx');
const STORE = read('frontend/src/features/improve/improve-store.js');
const CONTROLLER = read('frontend/src/features/improve/improve-controller.js');
const MANIFEST = JSON.parse(read('dapp.json'));

// ── 1. The broadcast, run for real ────────────────────────────────────

/** A method of App, lifted out of app.js by its text. */
function liftAppMethod(name) {
  const start = APP_JS.indexOf(`  ${name}(data) {`);
  assert.ok(start > 0, `the handler ${name} exists`);
  const end = APP_JS.indexOf('\n  },\n', start);
  return APP_JS.slice(start, end + 4);
}

/**
 * App.handleAppRedeployStatus and App.handleAppVersionChanged, lifted out of
 * app.js and run against fakes. `evicts` adds an AppView whose evictKeptApp
 * answers it: true when a frame was let go, false when there was none or the
 * app is on screen (WP2). `showing` is its frameShowing's answer: the build
 * before this one is on screen (sign-up test, 19 Oct 2026). Without either
 * there is no AppView at all.
 */
function redeployHarness({ currentApp = 'demo', homeVisible = false, evicts, showing } = {}) {
  const methods = ['handleAppRedeployStatus', 'handleAppVersionChanged'].map(liftAppMethod);
  const calls = [];
  const sandbox = {
    console,
    Home: { updateAppCardPill: (...a) => calls.push(['pill', ...a]), load: () => calls.push(['home-load']) },
    // Patches are made in the vm's realm; JSON strips the foreign prototype
    // so a strict deepEqual compares values.
    Improve: { update: (patch) => calls.push(['improve', JSON.parse(JSON.stringify(patch))]) },
  };
  if (evicts !== undefined || showing !== undefined) {
    sandbox.AppView = {
      ...(evicts !== undefined ? { evictKeptApp: (slug) => { calls.push(['evict', slug]); return evicts; } } : {}),
      noteBuild: (slug, sha) => { calls.push(['note-build', slug, sha]); return true; },
      frameShowing: (slug) => slug === currentApp && !!showing,
    };
  }
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`App = { currentApp: ${JSON.stringify(currentApp)}, _isScreenVisible: () => ${homeVisible},\n${methods.join(',\n')} };`, sandbox);
  return { calls, App: sandbox.App };
}

test('a build starting for the app in view spins the button and withdraws any older offer', () => {
  const { calls, App } = redeployHarness();
  App.handleAppRedeployStatus({ appSlug: 'demo', deploying: true, startedAt: 't' });
  assert.deepEqual(calls, [['improve', { deploying: true, appUpdateReady: false }]]);
});

test('a build landing offers the reload; a build failing only stops the spinner', () => {
  const { calls, App } = redeployHarness({ showing: true });
  App.handleAppRedeployStatus({ appSlug: 'demo', deploying: false, toSha: 'abc' });
  App.handleAppRedeployStatus({ appSlug: 'demo', deploying: false, failed: true });
  assert.deepEqual(calls, [
    ['improve', { deploying: false, appUpdateReady: true }],
    ['improve', { deploying: false, appUpdateReady: false }],
  ]);
});

test("another app's build is that app's news: the button is left alone", () => {
  const { calls, App } = redeployHarness({ currentApp: 'demo' });
  App.handleAppRedeployStatus({ appSlug: 'other', deploying: true });
  App.handleAppRedeployStatus({ appSlug: 'other', deploying: false });
  assert.deepEqual(calls, [], 'nothing published');
  // …and with no app open at all, likewise.
  const none = redeployHarness({ currentApp: null });
  none.App.handleAppRedeployStatus({ appSlug: 'demo', deploying: false });
  assert.deepEqual(none.calls, []);
});

// ── WP2: the frame that is running the build before this one ──────────

test('a build landing lets the app in view\'s kept frame go, and offers no reload on top', () => {
  // The app's Workshop is where "✓ Live" is watched. Its frame is parked
  // or kept behind it, and "Open app" used to bring that old build back,
  // because eviction skipped the app in view. Now it is let go, and the next
  // open loads the new build, so a reload offer would load it twice more.
  const { calls, App } = redeployHarness({ currentApp: 'demo', evicts: true });
  App.handleAppRedeployStatus({ appSlug: 'demo', deploying: false, toSha: 'abc' });
  assert.deepEqual(calls, [
    ['evict', 'demo'],
    ['improve', { deploying: false, appUpdateReady: false }],
  ]);
});

test('a build landing under the app on screen keeps the offer (the frame is not let go)', () => {
  // AppView.evictKeptApp refuses a frame that is on screen (and marks it
  // stale): the viewer keeps their document, and reloads it when they choose.
  const { calls, App } = redeployHarness({ currentApp: 'demo', evicts: false, showing: true });
  App.handleAppRedeployStatus({ appSlug: 'demo', deploying: false, toSha: 'abc' });
  assert.deepEqual(calls, [
    ['evict', 'demo'],
    ['improve', { deploying: false, appUpdateReady: true }],
  ]);
});

test('no build on screen, no reload offered: the first version going live is the one they are about to see', () => {
  // Sign-up test, 19 Oct 2026: Homeroom bot's first version of a project
  // went live while its build's screen was up, and the menu said "This app
  // has a new version". No frame was ever shown, so none was let go either
  // (evictKeptApp answers false for both), and the offer rested on that.
  const { calls, App } = redeployHarness({ currentApp: 'demo', evicts: false, showing: false });
  App.handleAppRedeployStatus({ appSlug: 'demo', deploying: false, toSha: 'abc' });
  assert.deepEqual(calls, [
    ['evict', 'demo'],
    ['improve', { deploying: false, appUpdateReady: false }],
  ]);
  // And with no AppView to ask, nothing is offered.
  const none = redeployHarness({ currentApp: 'demo' });
  none.App.handleAppRedeployStatus({ appSlug: 'demo', deploying: false, toSha: 'abc' });
  assert.deepEqual(none.calls, [['improve', { deploying: false, appUpdateReady: false }]]);
  // Asked only of a build that landed, after the frames were let go.
  const handler = liftAppMethod('handleAppRedeployStatus');
  assert.match(handler, /const showing = !data\.failed && !evicted\n\s+&& typeof AppView !== 'undefined' && !!AppView\.frameShowing\?\.\(slug\);\n\s+window\.Improve\.update\(\{ deploying: false, appUpdateReady: showing \}\);/);
});

test('the build on screen: the app\'s frame shown and loaded, never while its first version is on its way', () => {
  const VIEW = read('public/js/app-view.js');
  const at = VIEW.indexOf('  frameShowing(slug) {');
  assert.ok(at > 0, 'AppView.frameShowing exists');
  const body = VIEW.slice(at, VIEW.indexOf('\n  },\n', at));
  assert.match(body, /if \(appData && appData\.slug === slug && AppView\._firstVersionPending\(appData\)\) return false;/);
  assert.match(body, /return !!\(frame\.showing && frame\.showing\(slug\)\);/);
  // The bridge: mounted for this app, shown, and navigated at least once.
  const BRIDGE = read('frontend/src/features/app-frame/app-frame-bridge.js');
  assert.match(BRIDGE, /showing\(slug\) \{\n\s+const current = appFrameStore\.get\(\);\n\s+return !!slug && current\.slug === slug && !!current\.active && current\.navigatedAt > 0 && !!appFrameRefs\.iframe;/);
  // A fresh load of the app is of the build that is live: the offer is spent.
  const render = VIEW.slice(VIEW.indexOf('  renderAppTab() {'), VIEW.indexOf('  renderAppVersionPillHTML(opts) {'));
  assert.match(render, /frame\.setSrc\(iframeSrc, \{ granted: AppView\._grantedNow\(\), build: AppView\.buildFor\(appData\.slug\) \}\);\n(?:\s+\/\/.*\n)+\s+if \(!App\._appUpdateShot\) window\.Improve\?\.update\?\.\(\{ appUpdateReady: false \}\);\n  \},/);
  // …except under the screenshot state, which pins its offer.
  assert.match(APP_JS, /const ready = shot === 'app-update-ready';\n(?:\s+\/\/.*\n)+\s+App\._appUpdateShot = true;/);
});

test('no frame is let go while a build is still rolling out, or when it failed', () => {
  const { calls, App } = redeployHarness({ currentApp: 'demo', evicts: true });
  App.handleAppRedeployStatus({ appSlug: 'demo', deploying: true, startedAt: 't' });
  App.handleAppRedeployStatus({ appSlug: 'demo', deploying: false, failed: true });
  App.handleAppRedeployStatus({ appSlug: 'other', deploying: true, startedAt: 't' });
  App.handleAppRedeployStatus({ appSlug: 'other', deploying: false, failed: true });
  assert.ok(!calls.some(([kind]) => kind === 'evict'), 'the old build is still the live one');
  assert.deepEqual(calls, [
    ['improve', { deploying: true, appUpdateReady: false }],
    ['improve', { deploying: false, appUpdateReady: false }],
  ]);
});

test("another app's landed build lets its kept frame go, and leaves the button alone", () => {
  const { calls, App } = redeployHarness({ currentApp: 'demo', evicts: true });
  App.handleAppRedeployStatus({ appSlug: 'other', deploying: false, toSha: 'abc' });
  assert.deepEqual(calls, [['evict', 'other']]);
});

test('the version event names the build, lets the old one go again, and withdraws a spent offer', () => {
  // Sent after the end event, once apps.main_sha is written. Its sha is what
  // a frame is stamped with and resumed against (AppView.buildFor).
  const kept = redeployHarness({ currentApp: 'demo', evicts: true });
  kept.App.handleAppVersionChanged({ appSlug: 'demo', sha: 'abc123', prNumber: 7 });
  assert.deepEqual(kept.calls, [
    ['note-build', 'demo', 'abc123'],
    ['evict', 'demo'],
    ['improve', { appUpdateReady: false }],
  ]);
  // On screen: nothing let go, and the end event's offer stands.
  const onScreen = redeployHarness({ currentApp: 'demo', evicts: false });
  onScreen.App.handleAppVersionChanged({ appSlug: 'demo', sha: 'abc123' });
  assert.deepEqual(onScreen.calls, [['note-build', 'demo', 'abc123'], ['evict', 'demo']]);
  // Another app's: its frame goes, this app's button is not touched.
  const other = redeployHarness({ currentApp: 'demo', evicts: true });
  other.App.handleAppVersionChanged({ appSlug: 'other', sha: 'abc123' });
  assert.deepEqual(other.calls, [['note-build', 'other', 'abc123'], ['evict', 'other']]);
  // And the home list still re-reads, while Home is showing.
  const home = redeployHarness({ currentApp: null, homeVisible: true, evicts: false });
  home.App.handleAppVersionChanged({ appSlug: 'demo', sha: 'abc123' });
  assert.deepEqual(home.calls.at(-1), ['home-load']);
  // The socket case is the handler, not a copy of it.
  assert.match(APP_JS, /case 'app_version_changed':[\s\S]{0,200}App\.handleAppVersionChanged\(data\);\n\s*break;/);
});

test('the home tile still gets its pill, on its own visibility', () => {
  const { calls, App } = redeployHarness({ currentApp: 'demo', homeVisible: true });
  App.handleAppRedeployStatus({ appSlug: 'demo', deploying: true, startedAt: 't' });
  assert.equal(calls[0][0], 'pill');
  assert.deepEqual(calls[1], ['improve', { deploying: true, appUpdateReady: false }]);
});

// Two microtask turns: the close, then the navigation the reload waits on.
const settle = () => new Promise((r) => setTimeout(r, 0));

// ── 2. The offer's lifetime, in the controller ────────────────────────

function controllerHarness(opts) {
  const calls = [];
  let released = null;
  const store = makeStoreStub({ slug: 'demo', target: 'app', open: false, deploying: false, appUpdateReady: false, showTerminal: false });
  const sandbox = {
    console, Promise, setTimeout,
    App: {
      currentApp: 'demo',
      currentTab: (opts && opts.tab) || 'app',
      switchTab: (opts && opts.noSwitchTab) ? undefined : function switchTab(tab) {
        calls.push(['switch-tab', tab]);
        // Async, as the real one is: it awaits the destination's render.
        // `opts.hold` hands the test the resolver, so it can keep the
        // destination un-rendered and watch what the reload does meanwhile.
        const done = Promise.resolve().then(() => { sandbox.App.currentTab = tab; });
        if (!(opts && opts.hold)) return done;
        return new Promise((resolve) => { released = () => resolve(done); });
      },
    },
    AppView: { reloadAppFrame: () => { calls.push(['reload-frame']); return true; } },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // The one surface still listing these sessions. Flip `sheet.open` in a
  // test that needs the reload gate open; it is the notifications sheet's
  // flag, not the Improve panel's — that panel retired (#2718 review).
  const sheet = { open: false };
  runModules(sandbox, [['improve-controller.js', CONTROLLER]], {
    imports: {
      // The module reads its words through the language runtime: the real one, in English.
      '../../lib/i18n/runtime': englishPlatformI18n(),
      '../apps/app-card.js': { iconViewFor() {} },
      // THE CONTROLLER PRESENTS NOTHING NOW (#2718 review). It adopted the
      // Improve panel's root through lib/kit-surface and swept the other
      // sheets through lib/sheet-controller; the panel retired, `open()`
      // forwards to the app-context sheet, and both stubs went with it. What
      // it does import is the notifications sheet's own open flag — the one
      // surface still listing these sessions, and the gate on reloading them.
      '../notifications/notifications-sheet-store.js': {
        notificationsSheetStore: { get: () => sheet, subscribe: () => () => {} },
      },
      './improve-store.js': { improveStore: store },
      '../../lib/shell-snapshot': { saveShellSnapshot() {} },
    },
    tail: 'window.Improve = Improve;',
  });
  sandbox.Improve.close = () => { calls.push(['close']); };
  return { calls, store, Improve: sandbox.Improve, release: () => released && released() };
}

test('update() carries the offer, and reloadApp() withdraws it before it reloads the frame', async () => {
  const { calls, store, Improve } = controllerHarness();
  Improve.update({ deploying: true, appUpdateReady: false });
  assert.equal(store.get().deploying, true);
  Improve.update({ deploying: false, appUpdateReady: true });
  assert.equal(store.get().appUpdateReady, true, 'the offer is store state');

  Improve.reloadApp();
  assert.equal(store.get().appUpdateReady, false, 'withdrawn synchronously, as it is taken up');
  await settle();
  assert.deepEqual(calls, [['close'], ['reload-frame']],
    'on the app already: the panel closes, then the frame reloads, and no navigation');
});

test('taken from a Dev screen, it shows the app before it reloads it', async () => {
  // The offer is made wherever the panel opens, the Workshop included. There
  // the frame is behind another surface or not mounted at all, so reloading
  // it reloads nothing the viewer can see — the click looked like it did
  // nothing. Taking the offer means "show me the new version".
  const { calls, Improve } = controllerHarness({ tab: 'dev' });
  Improve.update({ appUpdateReady: true });
  Improve.reloadApp();
  await settle();
  assert.deepEqual(calls, [['close'], ['switch-tab', 'app'], ['reload-frame']],
    'the panel closes, the app comes to the front, and THEN it reloads');
});

test('the reload waits for the destination, rather than racing it', async () => {
  // renderAppTab mounts the frame and sets its src synchronously, so the
  // reload has a frame to work on only once switchTab has run. Reloading
  // before that would find no frame and quietly do nothing — the same bug
  // one level down. Held open here, so "waits" is observable rather than
  // inferred from the order two settled calls happen to land in.
  const { calls, Improve, release } = controllerHarness({ tab: 'dev', hold: true });
  Improve.reloadApp();
  await settle();
  assert.deepEqual(calls, [['close'], ['switch-tab', 'app']],
    'the navigation is under way and the reload has not fired');
  release();
  await settle();
  assert.deepEqual(calls, [['close'], ['switch-tab', 'app'], ['reload-frame']]);
});

test('a shell with no tabs to switch reloads anyway', async () => {
  // The panel is mounted in harnesses and embeddings whose App has no
  // switchTab. Losing the reload there would be a worse bug than the one
  // this fixes, so a shell that cannot navigate still reloads.
  const { calls, Improve } = controllerHarness({ tab: 'dev', noSwitchTab: true });
  Improve.reloadApp();
  await settle();
  assert.deepEqual(calls, [['close'], ['reload-frame']], 'no navigation, but still a reload');
});

test('the offer does not survive a change of target, and is kept across a same-app republish', () => {
  const { store, Improve } = controllerHarness();
  Improve.update({ appUpdateReady: true });
  Improve.setTarget({ kind: 'app', slug: 'demo', name: 'Demo' });
  assert.equal(store.get().appUpdateReady, true, 'the same app, republished: still its news');
  Improve.setTarget({ kind: 'app', slug: 'other', name: 'Other' });
  assert.equal(store.get().appUpdateReady, false, "another app: the previous app's build is not its news");
  Improve.update({ appUpdateReady: true });
  Improve.setTarget(null);
  assert.equal(store.get().appUpdateReady, false, 'no target, no offer');
});

// ── 3. The double load ────────────────────────────────────────────────

test('reloadAppFrame loads the frame twice through the seam, and releases the handler between', async () => {
  const AppView = require('../public/js/app-view.js');
  const calls = [];
  let onload = null;
  const frame = {
    hasFrame: () => true,
    frame: () => ({ src: 'https://demo-app.example/?token=t1' }),
    setOnLoad(fn) { onload = fn; calls.push(['onload', fn ? 'set' : 'cleared']); return true; },
    setSrc(src, opts) { calls.push(['setSrc', src, opts.granted]); return true; },
  };
  const prevWindow = global.window;
  global.window = { UsernodeReact: { appFrame: frame } };
  const prevGranted = AppView._grantedNow;
  const prevSettle = AppView.APP_RELOAD_SETTLE_MS;
  AppView._grantedNow = () => ['camera'];
  AppView.APP_RELOAD_SETTLE_MS = 0;
  try {
    assert.equal(AppView.reloadAppFrame(), true);
    assert.deepEqual(calls, [
      ['onload', 'set'],
      ['setSrc', 'https://demo-app.example/?token=t1', ['camera']],
    ], 'the first load, with the handler armed for the second');
    onload();
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(calls.slice(2), [
      ['onload', 'cleared'],
      ['setSrc', 'https://demo-app.example/?token=t1', ['camera']],
    ], 'the second load, same src, after the first settled');
    // The second load's own onload must not schedule a third.
    const before = calls.length;
    if (onload) onload();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls.length, before, 'no third load');
  } finally {
    global.window = prevWindow;
    AppView._grantedNow = prevGranted;
    AppView.APP_RELOAD_SETTLE_MS = prevSettle;
  }
});

test('with no frame on screen there is nothing to reload', () => {
  const AppView = require('../public/js/app-view.js');
  const prevWindow = global.window;
  global.window = { UsernodeReact: { appFrame: { hasFrame: () => false, frame: () => null, setOnLoad() {}, setSrc() { throw new Error('must not navigate'); } } } };
  try {
    assert.equal(AppView.reloadAppFrame(), false);
  } finally {
    global.window = prevWindow;
  }
});

// ── The rendered halves, pinned by source ─────────────────────────────

test('a landed app build offers a reload of the frame, not of the tab', () => {
  // THE GLYPH RETIRED WITH THE ROW IT LED (#2718 review). It was the leading
  // icon of #app-menu-row-improve, which opened the Improve panel; the panel
  // is gone and so is the row. What survives is the OFFER, which is the half
  // that ever did anything: the frame is still showing the build before this
  // one, so the row reloads the frame rather than the tab.
  assert.match(PANEL, /const \{ versionState, deploying, appUpdateReady \} = useStoreState\(improveStore\);/);
  assert.match(PANEL, /id="improve-app-update-ready"/);
  assert.match(PANEL, /Improve\.reloadApp/);
  // …and the menu is what renders it, now that the panel does not exist.
  assert.match(SHEET, /<UpdateStatus \/>/);
});

test('the panel offers the reload of the app on its own row, through Improve.reloadApp', () => {
  assert.match(PANEL, /const \{ versionState, deploying, appUpdateReady \} = useStoreState\(improveStore\);/);
  const rowAt = PANEL.indexOf('id="improve-app-update-ready"');
  assert.ok(rowAt > 0, 'the row exists');
  const row = PANEL.slice(rowAt, PANEL.indexOf('</UpdateReadyRow>', rowAt));
  assert.match(row, /onUpdate=\{\(\) => Improve\.reloadApp\(\)\}/, 'it reloads the frame, not the tab');
  assert.doesNotMatch(row, /location\.reload/);
  // Ordered after the platform's own reload (which reloads the whole tab and
  // so subsumes this) and before the building note.
  assert.ok(PANEL.indexOf('id="improve-update-ready"') < rowAt);
  assert.ok(rowAt < PANEL.indexOf('if (platformBusy || deploying)'));
  assert.match(STORE, /appUpdateReady: false,/, 'the store ships the flag off');
});

test('the landed state has a declared check on the staging fork fixture', () => {
  const landed = MANIFEST.tests.find((t) => t.expectSelector && t.expectSelector.includes('button#improve-app-update-ready'));
  assert.ok(landed && /shot=app-update-ready#app\/staging-demo-forkable/.test(landed.path));
  // IT SELECTED THE GLYPH'S READY STATE TOO — `body:has(#improve-btn-glyph
  // [data-state=ready])`, so one check photographed the row and the cue that
  // sends you to it. Both retired with the Improve panel (#2718 review): the
  // glyph was the drawer row's, the drawer row opened a drawer that no longer
  // exists, and the two dots the glyph's states became are the mark's
  // (#feedback-queue-dot, #improve-working-dot) — neither of which has a
  // "ready" state, because the offer itself is now one tap away rather than
  // two. What is left to assert is the row, on the surface that carries it.
  assert.match(landed.expectSelector, /^#apps-switcher-sheet\[data-open\] /);
  // One check, not two: the building state is the note and spinner the
  // platform-updating check already photographs, and the manifest keeps 20
  // of its 710 slots clear (tests/improve-session-spinner.test.js). The shot
  // for it stays, for a person taking the picture by hand.
  assert.ok(!MANIFEST.tests.some((t) => /shot=app-updating/.test(t.path)));
  // The shot is store writes only.
  const shotAt = APP_JS.indexOf('_applyAppUpdateShot() {');
  const shot = APP_JS.slice(shotAt, APP_JS.indexOf('\n  },\n', shotAt));
  assert.match(shot, /window\.Improve\.update\(\{ deploying: !ready, appUpdateReady: ready \}\)/);
  assert.doesNotMatch(shot, /fetch\(|reloadAppFrame/);
  assert.match(APP_JS, /App\._applyPlatformUpdateShot\(\);\n    App\._applyAppUpdateShot\(\);/, 'applied with the other state-painting shots');
});

// ── What the rows say, and to whom (sign-up test, 19 Oct 2026) ─────────
//
// "There is a new version available. Click here to get the new version.",
// right under the new app's name a minute after signing up, read as the app
// having changed: it was Homeroom's own release. Each line now names what has
// the update, and somebody who has not reached Homeroom yet hears nothing of
// Homeroom's: their next launch lands on the new build anyway.

test('the rows name what has the update, Homeroom or the app, and a newcomer hears nothing of Homeroom\'s', (t) => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { message } = require('./lib/platform-i18n');
  const store = loadTsx('frontend/src/features/improve/improve-store.js');
  const wired = loadTsx('frontend/src/features/improve/actions.tsx', { stubs: { './improve-store.js': store } });
  const initial = { ...store.improveStore.get() };
  const draw = (patch) => {
    store.improveStore.set({ ...initial, ...patch });
    return renderToHtml(createElement(wired.UpdateStatus));
  };
  t.after(() => store.improveStore.set(initial));

  // The line names what has the update; the row's "Reload" button is the
  // action (polish N4 merged with #5577).
  assert.equal(message('agent:menu.update.platformReady'), 'Homeroom has an update');
  assert.equal(message('agent:menu.update.action'), 'Reload');
  assert.equal(message('agent:menu.update.platformDownloading'), 'Homeroom is downloading an update. You can reload once it’s ready.');
  assert.equal(message('agent:menu.update.platformBuilding'), 'Homeroom is being updated.');
  for (const id of ['platformReady', 'appReady', 'appReadyUnnamed', 'platformDownloading', 'platformBuilding', 'appBuilding', 'appBuildingUnnamed']) {
    assert.doesNotMatch(message(`agent:menu.update.${id}`, { app: 'X' }), /\b(?:Click|Tap|new version)\b|—/, id);
  }

  // Homeroom's own: ready (or a prefetch that failed, which a reload still
  // beats), downloading, being deployed.
  assert.match(draw({ versionState: 'ready' }), /<button id="improve-update-ready"[^>]*>.*Homeroom has an update<\/span><span[^>]*>Reload<\/span><\/button>/);
  assert.match(draw({ versionState: 'failed' }), /id="improve-update-ready"[^]*Homeroom has an update<\/span><span[^>]*>Reload</);
  assert.match(draw({ versionState: 'deploying' }), /id="improve-update-note"[^]*Homeroom is being updated\./);
  // The app's, by its name; "this app" before the name is known.
  assert.match(draw({ name: 'City Tier List', appUpdateReady: true }), /id="improve-app-update-ready"[^]*City Tier List has an update<\/span><span[^>]*>Reload</);
  assert.match(draw({ name: '', appUpdateReady: true }), /This app has an update<\/span><span[^>]*>Reload</);
  assert.match(draw({ name: 'City Tier List', deploying: true }), /An update to City Tier List is on its way\./);
  assert.match(draw({ name: '  ', deploying: true }), /An update to this app is on its way\./);

  // A NEWCOMER: the first session's walk on Home still owed to them on this
  // device (../first-session/first-visit.ts), so they have not reached
  // Homeroom yet. Nothing of Homeroom's update; their app's lines stay.
  const data = new Map([['usernode:first-session:walk:42', JSON.stringify({ slug: 'city-tier-list', name: 'City Tier List', maker: true, armed: true })]]);
  const memory = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); } };
  const had = { window: Object.getOwnPropertyDescriptor(globalThis, 'window'), localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage') };
  Object.defineProperty(globalThis, 'window', { value: { App: { user: { id: 42 } } }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: memory, configurable: true, writable: true });
  try {
    for (const versionState of ['ready', 'failed', 'downloading', 'deploying']) {
      assert.equal(draw({ versionState }), '', versionState);
    }
    assert.match(draw({ versionState: 'ready', name: 'City Tier List', appUpdateReady: true }), /^<button id="improve-app-update-ready"/, 'their app\'s reload, not Homeroom\'s');
    assert.match(draw({ versionState: 'downloading', name: 'City Tier List', deploying: true }), /An update to City Tier List is on its way\./);
    // Somebody else on this device is owed nothing.
    globalThis.window.App.user.id = 7;
    assert.match(draw({ versionState: 'ready' }), /Homeroom has an update/);
    // Once the walk has run, they have reached Homeroom: the row is back.
    globalThis.window.App.user.id = 42;
    data.set('usernode:first-session:walk:42', 'done');
    assert.match(draw({ versionState: 'ready' }), /Homeroom has an update/);
  } finally {
    for (const [k, d] of Object.entries(had)) {
      if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
    }
  }
  // And while a first-session visit is under way (a flag the tab keeps),
  // as the source says: the prerender has no such visit.
  assert.match(PANEL, /const firstVisit = useFirstSessionVisit\(\);\n\s+const newcomer = firstVisit \|\| owedHomeWalk\(\);\n\s+const platformBusy = !newcomer && \(versionState === 'deploying' \|\| versionState === 'downloading'\);\n\s+const ready = !newcomer && \(versionState === 'ready' \|\| versionState === 'failed'\);/);
  // The new build is still fetched for them: nothing here touches the
  // version poll or the worker, only what the menu says.
  assert.doesNotMatch(PANEL, /setVersionState|serviceWorker|skipWaiting/);
});
