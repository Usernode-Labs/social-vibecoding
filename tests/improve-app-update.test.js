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
//      failed build withdraws the spinner without offering a reload.
//   2. The offer is withdrawn as it is taken up, and does not survive a
//      change of target.
//   3. The reload loads the frame TWICE, releasing its load handler between,
//      because an app following the offline convention answers the first
//      load from its shell cache (docs/app-slow-network-loading.md).
//
// Run with: node --test tests/improve-app-update.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
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

/** App.handleAppRedeployStatus, lifted out of app.js and run against fakes. */
function redeployHarness({ currentApp = 'demo', homeVisible = false } = {}) {
  const start = APP_JS.indexOf('  handleAppRedeployStatus(data) {');
  assert.ok(start > 0, 'the handler exists');
  const end = APP_JS.indexOf('\n  },\n', start);
  const method = APP_JS.slice(start, end + 4);
  const calls = [];
  const sandbox = {
    console,
    Home: { updateAppCardPill: (...a) => calls.push(['pill', ...a]), load: () => calls.push(['home-load']) },
    // Patches are made in the vm's realm; JSON strips the foreign prototype
    // so a strict deepEqual compares values.
    Improve: { update: (patch) => calls.push(['improve', JSON.parse(JSON.stringify(patch))]) },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`App = { currentApp: ${JSON.stringify(currentApp)}, _isScreenVisible: () => ${homeVisible},\n${method} };`, sandbox);
  return { calls, App: sandbox.App };
}

test('a build starting for the app in view spins the button and withdraws any older offer', () => {
  const { calls, App } = redeployHarness();
  App.handleAppRedeployStatus({ appSlug: 'demo', deploying: true, startedAt: 't' });
  assert.deepEqual(calls, [['improve', { deploying: true, appUpdateReady: false }]]);
});

test('a build landing offers the reload; a build failing only stops the spinner', () => {
  const { calls, App } = redeployHarness();
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
  const row = PANEL.slice(rowAt, PANEL.indexOf('</button>', rowAt));
  assert.match(row, /onClick=\{\(\) => Improve\.reloadApp\(\)\}/, 'it reloads the frame, not the tab');
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
