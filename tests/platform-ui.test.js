// PlatformUI (public/js/platform-ui.js) — the platform frontend's single
// seam over the hosted usernode-native kit. These tests pin two contracts:
//
//  1. Degraded fallback: with NO kit loaded (window.unNative absent) the
//     wrapper must fall back to console + native dialogs and inert
//     handles — never throw. This is what keeps the platform usable if
//     the kit script fails to load.
//  2. Kit delegation: with a stubbed kit present, calls route through
//     unNative and confirm/prompt map the kit's { button, value } shape
//     onto boolean / string-or-null.
//
// Plus the include-regression tests: index.html must keep referencing
// /usernode-native/v1/ and the settings toggles must keep un-switch.
//
// Run with: node --test tests/platform-ui.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'platform-ui.js'), 'utf8'
);

function makeSandbox({ kit } = {}) {
  const calls = { alerts: [], confirms: [], prompts: [], logs: [] };
  const sandbox = {
    console: { ...console, log: (...a) => calls.logs.push(a.map(String).join(' ')) },
    document: {
      readyState: 'complete',
      getElementById: () => null,
      addEventListener: () => {},
      createComment: () => ({}),
    },
    MutationObserver: class { observe() {} disconnect() {} },
    MouseEvent: class {},
    alert: (msg) => calls.alerts.push(msg),
    confirm: (msg) => { calls.confirms.push(msg); return true; },
    prompt: (msg, val) => { calls.prompts.push([msg, val]); return 'typed'; },
  };
  if (kit) sandbox.unNative = kit;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { PlatformUI: sandbox.PlatformUI, calls, sandbox };
}

// ── 1. Kit-absent fallback ─────────────────────────────────────────────

test('kit absent: toast logs to console and returns null', () => {
  const { PlatformUI, calls } = makeSandbox();
  const handle = PlatformUI.toast('Saved');
  assert.equal(handle, null);
  assert.ok(calls.logs.some((l) => l.includes('Saved')));
});

test('kit absent: alert falls back to window.alert', async () => {
  const { PlatformUI, calls } = makeSandbox();
  await PlatformUI.alert({ title: 'Heads up', message: 'Something happened' });
  assert.equal(calls.alerts.length, 1);
  assert.ok(calls.alerts[0].includes('Heads up'));
  assert.ok(calls.alerts[0].includes('Something happened'));
});

test('kit absent: confirm falls back to window.confirm and resolves its boolean', async () => {
  const { PlatformUI, calls } = makeSandbox();
  const ok = await PlatformUI.confirm({ title: 'Delete this app?', danger: true });
  assert.equal(ok, true);
  assert.equal(calls.confirms.length, 1);
});

test('kit absent: prompt falls back to window.prompt', async () => {
  const { PlatformUI, calls } = makeSandbox();
  const v = await PlatformUI.prompt({ title: 'Set KEY', value: 'x' });
  assert.equal(v, 'typed');
  assert.equal(calls.prompts.length, 1);
});

test('kit absent: sheets/panels/modals return null, actionSheet resolves null, gestures null', async () => {
  const { PlatformUI } = makeSandbox();
  assert.equal(PlatformUI.hasKit(), false);
  assert.equal(PlatformUI.isTouch(), false);
  assert.equal(PlatformUI.sheet({}), null);
  // Null is what makes App.HeaderMenu fall back to the legacy CSS
  // slide-over instead of opening nothing.
  assert.equal(PlatformUI.panel({}), null);
  assert.equal(PlatformUI.modal({}), null);
  assert.equal(await PlatformUI.actionSheet({ actions: [] }), null);
  assert.equal(PlatformUI.gestures(), null);
});

test('kit absent: transition still runs the mutation synchronously', () => {
  const { PlatformUI } = makeSandbox();
  let ran = false;
  PlatformUI.transition(() => { ran = true; }, { type: 'push' });
  assert.equal(ran, true);
});

test('kit absent: a zoom transition runs BOTH mutation halves (fn + after), never throws', () => {
  const { PlatformUI } = makeSandbox();
  const order = [];
  PlatformUI.transition(() => order.push('fn'), {
    type: 'zoom-in',
    el: {},
    fromEl: () => null,
    after: () => order.push('after'),
  });
  assert.deepEqual(order, ['fn', 'after']);
  // No `after` is fine too.
  let ran = false;
  assert.doesNotThrow(() => {
    PlatformUI.transition(() => { ran = true; }, { type: 'zoom-out', el: {} });
  });
  assert.equal(ran, true);
});

test('kit absent: swipeActions / pullToRefresh / attachScreenFx are inert, never throw', () => {
  const { PlatformUI } = makeSandbox();
  const s = PlatformUI.swipeActions({}, {});
  const p = PlatformUI.pullToRefresh({}, () => {});
  assert.doesNotThrow(() => { s.detach(); s.close(); p.detach(); });
  assert.doesNotThrow(() => {
    PlatformUI.attachScreenFx('k', {}, {});
    PlatformUI.detachScreenFx('k');
  });
});

// ── 2. Kit delegation ──────────────────────────────────────────────────

function stubKit() {
  const seen = {
    toasts: [], alerts: [], sheets: [], panels: [], modals: [],
    actionSheets: [], transitions: [],
  };
  const kit = {
    platform: 'ios',
    toast: (msg, opts) => { seen.toasts.push([msg, opts]); return { dismiss() {}, el: {} }; },
    alert: (opts) => {
      seen.alerts.push(opts);
      // Simulate the user tapping the LAST (non-cancel) button, typing 'v'.
      const b = (opts.buttons || [{ label: 'OK', style: 'default' }]).slice(-1)[0];
      return Promise.resolve({ button: b, value: opts.field ? 'v' : undefined });
    },
    actionSheet: (opts) => { seen.actionSheets.push(opts); return Promise.resolve(null); },
    presentSheet: (opts) => { seen.sheets.push(opts); return { dismiss() {}, el: {} }; },
    presentPanel: (opts) => { seen.panels.push(opts); return { dismiss() {}, el: {} }; },
    presentModal: (opts) => { seen.modals.push(opts); return { dismiss() {}, el: {} }; },
    transition: (fn, opts) => { seen.transitions.push(opts); fn(); },
    gestures: { claim: () => true, owner: () => null, release: () => {} },
  };
  return { kit, seen };
}

test('kit present: toast delegates to unNative.toast', () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  const h = PlatformUI.toast('Copied');
  assert.ok(h && typeof h.dismiss === 'function');
  assert.equal(seen.toasts.length, 1);
  assert.equal(seen.toasts[0][0], 'Copied');
});

test('kit present: isTouch reflects the kit platform', () => {
  const { kit } = stubKit();
  const touch = makeSandbox({ kit });
  assert.equal(touch.PlatformUI.isTouch(), true);
  kit.platform = 'desktop';
  const desk = makeSandbox({ kit });
  assert.equal(desk.PlatformUI.isTouch(), false);
});

test('kit present: panel delegates to unNative.presentPanel, options untouched', () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  const contentEl = { adopted: true };
  const onDismiss = () => {};
  const h = PlatformUI.panel({ contentEl, side: 'right', onDismiss });
  assert.ok(h && typeof h.dismiss === 'function');
  assert.equal(seen.panels.length, 1);
  // The side is what the hamburger drawer's whole change hinges on, and
  // contentEl is the adoption seam — neither may be rewritten in transit.
  assert.equal(seen.panels[0].side, 'right');
  assert.equal(seen.panels[0].contentEl, contentEl);
  assert.equal(seen.panels[0].onDismiss, onDismiss);
  // A kit that predates presentPanel degrades to the legacy path.
  delete kit.presentPanel;
  const { PlatformUI: P2 } = makeSandbox({ kit });
  assert.equal(P2.panel({ contentEl }), null);
});

test('kit present: confirm maps the tapped button onto a boolean', async () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  const ok = await PlatformUI.confirm({ title: 'Withdraw?', confirmLabel: 'Withdraw', danger: true });
  assert.equal(ok, true); // stub taps the last (destructive) button
  const buttons = seen.alerts[0].buttons;
  assert.equal(buttons[0].style, 'cancel');
  assert.equal(buttons[1].style, 'destructive');
  assert.equal(buttons[1].label, 'Withdraw');
});

test('kit present: confirm resolves false when the cancel button is tapped', async () => {
  const { kit } = stubKit();
  kit.alert = (opts) => Promise.resolve({ button: opts.buttons[0] }); // cancel
  const { PlatformUI } = makeSandbox({ kit });
  assert.equal(await PlatformUI.confirm({ title: 'Sure?' }), false);
});

test('kit present: prompt returns the field value on OK, null on cancel', async () => {
  const { kit } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  assert.equal(await PlatformUI.prompt({ title: 'Set KEY' }), 'v');
  kit.alert = (opts) => Promise.resolve({ button: opts.buttons[0], value: 'v' });
  const { PlatformUI: P2 } = makeSandbox({ kit });
  assert.equal(await P2.prompt({ title: 'Set KEY' }), null);
});

test('kit present: transition forwards the type and runs the mutation', () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  let ran = false;
  PlatformUI.transition(() => { ran = true; }, { type: 'pop' });
  assert.equal(ran, true);
  assert.deepEqual(seen.transitions[0], { type: 'pop' });
});

test('kit present: zoom opts (el, fromEl, fallback, after, outEl) forward to unNative untouched', () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  const el = { screen: true };
  const fromEl = () => null;
  const after = () => {};
  const outEl = { outgoingScreen: true };
  const opts = { type: 'zoom-in', el, fromEl, fallback: 'push', after, outEl };
  PlatformUI.transition(() => {}, opts);
  assert.equal(seen.transitions[0], opts, 'the opts object passes through by reference');
  assert.equal(seen.transitions[0].el, el);
  assert.equal(seen.transitions[0].fromEl, fromEl);
  assert.equal(seen.transitions[0].after, after);
  assert.equal(seen.transitions[0].fallback, 'push');
  assert.equal(seen.transitions[0].outEl, outEl,
    'outEl (#764: destination measured with the outgoing screen hidden) forwards untouched');
});

// ── 3. Include regressions ─────────────────────────────────────────────

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('index.html loads the hosted kit (css + js) and platform-ui.js', () => {
  assert.ok(INDEX.includes('/usernode-native/v1/native.css'), 'kit stylesheet include dropped');
  assert.ok(INDEX.includes('/usernode-native/v1/native.js'), 'kit script include dropped');
  assert.ok(INDEX.includes('/js/platform-ui.js'), 'PlatformUI wrapper include dropped');
});

test('index.html viewport meta carries viewport-fit=cover (kit safe-area contract)', () => {
  const meta = INDEX.match(/<meta name="viewport"[^>]*>/)[0];
  assert.ok(meta.includes('viewport-fit=cover'), meta);
});

test('settings toggles are kit switches (un-switch)', () => {
  for (const id of ['view-as-non-admin', 'dev-console-always-show', 'devchat-alerts-toggle', 'ai-progress-estimate']) {
    const m = INDEX.match(new RegExp(`<input id="${id}"[^>]*>`));
    assert.ok(m, `missing settings checkbox #${id}`);
    assert.ok(m[0].includes('un-switch'), `#${id} lost its un-switch class`);
  }
});

test('header and app view carry safe-area classes', () => {
  assert.ok(/<header id="platform-header"[^>]*un-safe-top/.test(INDEX));
  // #970: the bottom inset is SURFACE-DEPENDENT now, so #app-view must NOT
  // carry a blanket `un-safe-bottom`. That class reserved the
  // home-indicator strip for every surface inside #app-content — the
  // running app's iframe included — which is what left apps cut off short
  // of a phone's rounded bottom edge. The `data-app-surface` attribute
  // (AppView._setSurface) plus the app.css rules replace it; the default
  // is `platform` so a first paint before any render is well-defined.
  //
  // The follow-up moved the inset off #app-view entirely: the surface
  // rules publish the `--platform-safe-bottom` TOKEN (real value on a
  // platform surface, 0px on an app one) and the padding itself lives on
  // each inner scroller / composer bar, so Dev mode paints edge to edge
  // like the app surface. tests/app-safe-area.test.js and
  // tests/platform-safe-bottom.test.js pin that contract; here we only
  // check the surface hook still exists for app.css to key on.
  assert.ok(!/<div id="app-view"[^>]*un-safe-bottom/.test(INDEX),
    '#app-view must not reserve the bottom inset for the app frame (#970)');
  assert.ok(/<div id="app-view"[^>]*data-app-surface="platform"/.test(INDEX),
    '#app-view needs the surface flag, defaulting to platform');
  assert.ok(
    read('public/css/app.css').includes('#app-view[data-app-surface="platform"]'),
    'app.css must carry the platform-surface rule'
  );
});

test('neither the bottom tab bar nor the header switch ships', () => {
  // Two retirements, one test. The full-width bottom #app-tabs bar went first
  // (replaced by the header's App/Dev switch); THE UI OVERHAUL then retired
  // the switch too. An app is just an app now — Dev is a destination the
  // Improve panel links to, not a mode the header toggles between.
  assert.ok(!INDEX.includes('id="app-tabs"'), 'the #app-tabs nav still ships');
  assert.ok(!INDEX.includes('class="app-tab'), 'an .app-tab button still ships');
  assert.ok(!INDEX.includes('id="app-mode-switch"'), 'the header switch still ships');
  assert.ok(!/class="[^"]*app-mode-seg/.test(INDEX), 'an orphan segment still ships');
});

test('#improve-btn lives inside the header, leading the icon group', () => {
  const header = INDEX.slice(
    INDEX.indexOf('id="platform-header"'),
    INDEX.indexOf('</header>')
  );
  // Same requirement the switch had, and for the same reason: the header
  // layout code measures the title's right side group through a ref on that
  // div, so a control moved out of it stops counting towards the clearance
  // the centering measurement needs.
  assert.ok(header.includes('id="improve-btn"'), 'Improve is outside the header');
  assert.ok(
    header.indexOf('id="improve-btn"') > header.indexOf('id="header-title"'),
    'Improve must sit after the title, in the right group'
  );
  assert.ok(
    header.indexOf('id="improve-btn"') < header.indexOf('id="notifications-btn"'),
    'Improve must lead the icon group'
  );
});

test('the Improve button ships hidden and opens the panel', () => {
  const m = INDEX.match(/<button id="improve-btn"[\s\S]*?<\/button>/);
  assert.ok(m, 'missing #improve-btn');
  const el = m[0];
  // Ships hidden for the same reason the switch did: there is nothing to
  // improve until a target is published. The publisher is the same call —
  // App.DrawerStatus.setAppOpen — plus App._improveHome() on the home screen.
  assert.ok(el.includes('hidden'), 'ships hidden — a published target reveals it');
  assert.ok(el.includes('aria-haspopup="dialog"'), 'it opens a dialog surface');
  assert.ok(el.includes('aria-expanded="false"'), 'closed state reaches the a11y tree');
});

test('setAppOpen publishes the Improve target instead of toggling a switch', () => {
  // #1079 chunk B moved App.DrawerStatus into the React bundle alongside the
  // drawer markup it drives; app.js keeps a forwarder. THE UI OVERHAUL kept
  // that lifecycle and changed only what it publishes — one call already
  // covers openApp, navigateHome, AppView.close() and every other-screen
  // navigation, which is why the header control still rides it.
  const src = read('frontend/src/features/header/header-menu-controller.js');
  const fn = src.slice(src.indexOf('setAppOpen(open) {'), src.indexOf('setForkVisible(visible)'));
  assert.ok(!fn.includes("getElementById('app-mode-switch')"),
    'the retired switch must not still be toggled here');
  assert.ok(fn.includes('Improve?.setTarget'), fn);
  assert.ok(fn.includes('setTarget(null)'),
    'closing an app must clear the target, or the button outlives its subject');
  // Unlike the switch it replaced, the self-hosted platform row is NOT
  // excluded: everything Improve offers works on it, and that row is exactly
  // what the home screen's Improve button points at.
  assert.ok(fn.includes('self_hosted'), 'the platform row is still classified');
  assert.ok(!/self_hosted[\s\S]{0,120}classList\.toggle\('hidden'/.test(fn),
    'the platform row must no longer be hidden out of the header');
});

test('the home screen points Improve at the platform\'s own app row', () => {
  const src = read('public/js/app.js');
  assert.ok(src.includes('_improveHome()'), 'the helper went missing');
  const fn = src.slice(src.indexOf('_improveHome() {'), src.indexOf('DrawerStatus: {'));
  assert.ok(fn.includes('App.user?.platformApp'),
    'the slug comes from /api/auth/me — GET /api/apps hides self-hosted rows');
  assert.ok(fn.includes("kind: 'platform'"), 'the target is classified as the platform');
  // Both entry points: a cold boot landing on home, and every later return.
  assert.ok(src.indexOf('App._improveHome();') !== src.lastIndexOf('App._improveHome();'),
    'both navigateHome and the restoreFromHash home fallback must publish it');
});

test('app.css drops the tab-bar rules and draws the Improve panel', () => {
  const css = read('public/css/app.css');
  assert.ok(!/^\.app-tab\b/m.test(css), '.app-tab rules still present');
  // The .app-mode-seg rules went with the switch itself.
  assert.ok(!css.includes('.app-mode-seg'), 'orphan App/Dev segment rules survive');
  // Desktop side panel, mobile bottom sheet — one element, two idioms, and
  // the requirement holds in a mobile browser with no native kit loaded.
  assert.ok(css.includes('#improve-panel'), 'the Improve panel has no chrome');
  assert.ok(css.includes('#improve-panel[data-open]'), 'nothing slides the panel in');
  assert.ok(/@media \(max-width: 639px\)[\s\S]{0,900}#improve-panel[\s\S]{0,400}translateY/
    .test(css), 'below sm the panel must come up from the bottom, not in from the side');
  assert.ok(/#improve-panel \{[\s\S]{0,300}translateX/.test(css),
    'at sm and up the panel must slide in from the side');
});
