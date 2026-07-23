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

test('kit absent: sheets/modals return null, actionSheet resolves null, gestures null', async () => {
  const { PlatformUI } = makeSandbox();
  assert.equal(PlatformUI.hasKit(), false);
  assert.equal(PlatformUI.isTouch(), false);
  assert.equal(PlatformUI.sheet({}), null);
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
  const seen = { toasts: [], alerts: [], sheets: [], modals: [], actionSheets: [], transitions: [] };
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

// ── 3. Include regressions ─────────────────────────────────────────────

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

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

test('header and tab bar carry safe-area classes', () => {
  assert.ok(/<header id="platform-header"[^>]*un-safe-top/.test(INDEX));
  assert.ok(/<nav id="app-tabs"[^>]*un-safe-bottom/.test(INDEX));
});
