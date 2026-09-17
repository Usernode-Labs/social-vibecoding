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
const BUTTON = read('frontend/src/features/improve/improve-button.tsx');
const PANEL = read('frontend/src/features/improve/improve-panel.tsx');
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

// ── 2. The offer's lifetime, in the controller ────────────────────────

function controllerHarness() {
  const calls = [];
  const store = makeStoreStub({ slug: 'demo', target: 'app', open: false, deploying: false, appUpdateReady: false, showTerminal: false });
  const sandbox = {
    console, Promise, setTimeout,
    App: { currentApp: 'demo' },
    AppView: { reloadAppFrame: () => { calls.push(['reload-frame']); return true; } },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  runModules(sandbox, [['improve-controller.js', CONTROLLER]], {
    imports: {
      '../apps/app-card.js': { iconViewFor() {} },
      '../../lib/kit-surface': { adoptKitSurface: () => null },
      '../../lib/sheet-controller.js': { dismissRegisteredSheets() {} },
      './improve-store.js': { improveStore: store },
      '../../lib/shell-snapshot': { saveShellSnapshot() {} },
    },
    tail: 'window.Improve = Improve;',
  });
  sandbox.Improve.close = () => { calls.push(['close']); };
  return { calls, store, Improve: sandbox.Improve };
}

test('update() carries the offer, and reloadApp() withdraws it before it reloads the frame', async () => {
  const { calls, store, Improve } = controllerHarness();
  Improve.update({ deploying: true, appUpdateReady: false });
  assert.equal(store.get().deploying, true);
  Improve.update({ deploying: false, appUpdateReady: true });
  assert.equal(store.get().appUpdateReady, true, 'the offer is store state');

  Improve.reloadApp();
  assert.equal(store.get().appUpdateReady, false, 'withdrawn synchronously, as it is taken up');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, [['close'], ['reload-frame']], 'the panel closes, then the frame reloads');
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

test('the button shows the arrow for a landed app build, and the spinner still wins while one is building', () => {
  assert.match(BUTTON, /const \{ target, open, versionState, deploying, appUpdateReady \} = useStoreState\(improveStore\);/);
  assert.match(BUTTON, /appUpdateReady=\{appUpdateReady\}/);
  const busyAt = BUTTON.indexOf('if (appDeploying || BUSY_STATES.includes(versionState))');
  const readyAt = BUTTON.indexOf('if (appUpdateReady || READY_STATES.includes(versionState))');
  assert.ok(busyAt > 0 && readyAt > busyAt, 'busy is decided first, so a new build starting takes the arrow back');
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
  assert.ok(landed && /shot=app-update-ready#app\/staging-demo-fork/.test(landed.path));
  assert.match(landed.expectSelector, /#improve-btn-glyph\[data-state=ready\]/);
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
