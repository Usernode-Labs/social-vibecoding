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
  // The bottom inset moved off the deleted #app-tabs bar onto #app-view
  // itself — that bar was the only thing keeping app content clear of the
  // iOS home indicator.
  assert.ok(/<div id="app-view"[^>]*un-safe-bottom/.test(INDEX));
});

test('the bottom App/Dev tab bar is gone, replaced by the header switch', () => {
  assert.ok(!INDEX.includes('id="app-tabs"'), 'the #app-tabs nav still ships');
  assert.ok(!INDEX.includes('class="app-tab'), 'an .app-tab button still ships');
  assert.ok(INDEX.includes('id="app-mode-switch"'), 'the header switch is missing');
});

test('#app-mode-switch lives inside the header, before the icon group', () => {
  const header = INDEX.slice(
    INDEX.indexOf('id="platform-header"'),
    INDEX.indexOf('</header>')
  );
  // header-layout.js resolves the title's side groups as
  // previousElementSibling / nextElementSibling, so the switch has to be
  // INSIDE the existing right-group div — a sibling wedged between the
  // <h1> and that div silently breaks the centering measurement.
  assert.ok(header.includes('id="app-mode-switch"'), 'switch is outside the header');
  assert.ok(
    header.indexOf('id="app-mode-switch"') > header.indexOf('id="header-title"'),
    'switch must sit after the title, in the right group'
  );
  assert.ok(
    header.indexOf('id="app-mode-switch"') < header.indexOf('id="feedback-btn"'),
    'switch must lead the icon group'
  );
});

test('the App/Dev switch is a two-option radiogroup', () => {
  const m = INDEX.match(/<div id="app-mode-switch"[\s\S]*?<\/div>/);
  assert.ok(m, 'missing #app-mode-switch');
  const el = m[0];
  assert.ok(el.includes('role="radiogroup"'), el);
  assert.ok(el.includes('hidden'), 'ships hidden — setAppOpen reveals it');
  for (const tab of ['app', 'dev']) {
    assert.ok(
      new RegExp(`<button[^>]*role="radio"[^>]*data-tab="${tab}"[^>]*class="[^"]*app-mode-seg`).test(el)
        || new RegExp(`<button[^>]*data-tab="${tab}"[^>]*app-mode-seg`).test(el),
      `missing the ${tab} segment`
    );
  }
});

test('app.js wires the switch and guards the same-segment App tap', () => {
  const src = read('public/js/app.js');
  assert.ok(src.includes(".querySelectorAll('.app-mode-seg')"), 'not bound to .app-mode-seg');
  assert.ok(src.includes("setAttribute('aria-checked'"), 'active state never reaches the a11y tree');
  assert.ok(src.includes("app-mode-seg-active"), 'no active class applied');
  // Re-tapping App would re-run renderAppTab() and reload the iframe.
  assert.ok(
    src.includes("if (btn.dataset.tab === 'app' && App.currentTab === 'app') return;"),
    'missing the App-segment no-op guard'
  );
});

test('setAppOpen owns the switch and hides it for self-hosted apps', () => {
  const src = read('public/js/app.js');
  const fn = src.slice(src.indexOf('setAppOpen(open) {'), src.indexOf('setForkVisible(visible)'));
  assert.ok(fn.includes("getElementById('app-mode-switch')"), fn);
  assert.ok(fn.includes('self_hosted'), 'self-hosted apps must not get a dead App segment');
  assert.ok(fn.includes('HeaderLayout'), 'title should be remeasured when the group resizes');
});

test('app.css drops the tab-bar rules and keeps the press opt-out', () => {
  const css = read('public/css/app.css');
  assert.ok(!/^\.app-tab\b/m.test(css), '.app-tab rules still present');
  assert.ok(css.includes('.app-mode-seg:active'), 'press-state opt-out lost the switch');
  assert.ok(css.includes('.app-mode-seg.app-mode-seg-active'), 'no active-segment styling');
});
