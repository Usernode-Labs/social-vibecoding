// The first-run "Set up your device" sheet is STRICTLY one-shot (#1068).
//
// Before this fix its only suppressor was the localStorage marker, read
// before two awaits (the capability probe and getSettingsState) and
// written only on dismiss. So every one of the three independent triggers
// that reach it in one document — init()'s boot handoff, every
// `sv:session` (enterAuthed fires more than once), and the
// `usernode:auth-status` recovery chain during wallet provisioning —
// crossed those awaits and presented its own stacked copy, and abandoning
// the sheet without dismissing re-showed it on the next launch.
//
// What is asserted here: concurrent and later triggers never produce a
// second sheet, the marker is written when the sheet is PRESENTED rather
// than dismissed, and the retryable outcomes (degraded probe / empty read
// / missing UI kit) do NOT record the device as done — so a user whose
// sheet could not actually be shown still gets it next launch.
//
// Run with: node --test tests/first-run-permissions-once.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const nativeChromeSource = fs.readFileSync(
  path.join(root, 'public', 'js', 'native-chrome.js'), 'utf8');

const ANDROID_UNGRANTED = {
  platform: 'android', exactAlarmGranted: false, batteryOptDisabled: false,
};

function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => {
    d.resolve = resolve;
    d.reject = reject;
  });
  return d;
}

// Minimal DOM node — enough for the el()/appendChild/textContent usage in
// the sheet builder (same shape as tests/first-run-permissions-copy.test.js).
function fakeNode(tag) {
  const node = {
    tag,
    id: '',
    className: '',
    disabled: false,
    attrs: {},
    children: [],
    listeners: {},
    _text: '',
    appendChild(child) { node.children.push(child); return child; },
    addEventListener(type, fn) { node.listeners[type] = fn; },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attrs, name)
        ? node.attrs[name]
        : null;
    },
  };
  Object.defineProperty(node, 'textContent', {
    get() { return node._text; },
    set(value) { node._text = value == null ? '' : String(value); node.children = []; },
  });
  return node;
}

// One document's worth of native-chrome.js, with the pieces this step
// touches stubbed: a recording localStorage, a recording PlatformUI.sheet,
// and a settings-state read the test drives.
function load(opts) {
  const options = opts || {};
  const sheets = [];
  const storage = { marker: options.marker || null, writes: [], removes: [] };
  const calls = { settingsState: 0, dismissedBefore: null };
  const documentListeners = {};
  const windowListeners = {};
  const body = fakeNode('body');

  const usernode = {
    isNative: true,
    async getBridgeInfo() {
      return options.bridgeInfo || {
        version: 4,
        capabilities: ['getSettingsState', 'completeLogin'],
      };
    },
    async getSettingsState() {
      calls.settingsState += 1;
      if (options.settingsState) return options.settingsState(calls.settingsState);
      return { permissions: options.permissions || ANDROID_UNGRANTED };
    },
    async requestPermissions() {
      return { granted: false, permissions: options.permissions || ANDROID_UNGRANTED };
    },
    async openBatterySettings() { return true; },
    async completeLogin(payload) {
      return {
        phase: 'ready',
        address: `ut1-${payload.user.id}`,
        participantId: payload.user.id,
        epoch: 1,
      };
    },
    async startNode() { return { started: true }; },
    getLastNativeReadError() { return null; },
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    App: { user: options.user === undefined ? { id: 'u1' } : options.user },
    usernode,
    PlatformUI: {
      sheet(sheetOpts) {
        if (options.kitMissing) return null;
        sheets.push(sheetOpts);
        return {
          dismiss() {
            if (calls.dismissedBefore == null) {
              calls.dismissedBefore = storage.writes.length;
            }
            if (sheetOpts.onDismiss) sheetOpts.onDismiss();
          },
        };
      },
    },
    localStorage: {
      getItem(key) {
        return key === 'sv:onboarding_permissions_done' ? storage.marker : null;
      },
      setItem(key, value) {
        storage.writes.push({ key, value });
        if (key === 'sv:onboarding_permissions_done') storage.marker = value;
      },
      removeItem(key) {
        storage.removes.push(key);
        if (key === 'sv:onboarding_permissions_done') storage.marker = null;
      },
    },
    document: {
      body,
      getElementById() { return null; },
      createElement(tag) { return fakeNode(tag); },
      addEventListener(type, listener) {
        (documentListeners[type] = documentListeners[type] || []).push(listener);
      },
    },
    addEventListener(type, listener) {
      (windowListeners[type] = windowListeners[type] || []).push(listener);
    },
    dispatchEvent(event) {
      (windowListeners[event.type] || []).forEach((fn) => fn(event));
    },
    setTimeout(fn, delay) {
      const t = setTimeout(fn, delay);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    },
    clearTimeout,
    async fetch() {
      const id = sandbox.App.user ? sandbox.App.user.id : null;
      return {
        ok: true,
        status: 200,
        async json() {
          return { success: true, token: `token-${id}`, user: { id } };
        },
      };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);

  return {
    sandbox,
    sheets,
    storage,
    calls,
    body,
    NativeChrome: sandbox.NativeChrome,
    show() { return sandbox.NativeChrome.maybeShowFirstRunPermissions(); },
    dispatchDocument(type) {
      (documentListeners[type] || []).forEach((fn) => fn({ type }));
    },
    dispatchWindow(type, detail) {
      (windowListeners[type] || []).forEach((fn) => fn({ type, detail }));
    },
  };
}

async function settle(times) {
  for (let i = 0; i < (times || 4); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('concurrent triggers present exactly one sheet', async () => {
  const state = deferred();
  const ctx = load({ settingsState: () => state.promise });
  const a = ctx.show();
  const b = ctx.show();
  await settle();
  assert.equal(ctx.sheets.length, 0, 'nothing presented while the read is pending');
  state.resolve({ permissions: ANDROID_UNGRANTED });
  await Promise.all([a, b]);
  assert.equal(ctx.sheets.length, 1, 'two concurrent triggers → one sheet');
  assert.equal(ctx.calls.settingsState, 1,
    'the second trigger shares the in-flight run instead of reading again');
});

test('a trigger while the sheet is open adds no second copy', async () => {
  const ctx = load({});
  await ctx.show();
  assert.equal(ctx.sheets.length, 1);
  await ctx.show();
  await ctx.show();
  assert.equal(ctx.sheets.length, 1, 'the sheet handle is still live — no stacking');
});

test('the device marker is written at presentation, not on dismiss', async () => {
  const ctx = load({});
  await ctx.show();
  assert.deepEqual(ctx.storage.writes.map((w) => w.value), ['1'],
    'the marker is recorded as soon as the sheet is presented');
  assert.equal(ctx.calls.dismissedBefore, null, 'nothing was dismissed yet');
  assert.equal(ctx.storage.marker, '1');

  // Abandoning the sheet (leaving the app, a native restart) must not
  // re-show it: the marker is already set before any dismiss runs.
  ctx.sheets[0].onDismiss();
  assert.equal(ctx.storage.marker, '1');
  await ctx.show();
  assert.equal(ctx.sheets.length, 1, 'no sheet after the marker is set');
});

test('the reporter scenario yields one sheet across every trigger', async () => {
  // init() already ran the boot handoff (App.user was present). Add the
  // sv:session storm (enterAuthed on boot + on the waiting-room release)
  // and the usernode:auth-status recovery chain that fires while the
  // wallet is still being provisioned.
  const ctx = load({});
  await settle(6);
  ctx.dispatchDocument('sv:session');
  ctx.dispatchDocument('sv:session');
  ctx.NativeChrome._sessionWalletRelayAdmitted = false;
  ctx.dispatchWindow('usernode:auth-status', { phase: 'ready', address: 'ut1-u1' });
  await settle(10);
  assert.equal(ctx.sheets.length, 1, 'four trigger paths → exactly one sheet');
  assert.equal(ctx.body.getAttribute('data-first-run-sheets'), '1',
    'the presentation counter is stamped on the body for browser-level checks');
});

test('a device already marked done reads nothing and shows nothing', async () => {
  const ctx = load({ marker: '1' });
  await ctx.show();
  await ctx.show();
  assert.equal(ctx.sheets.length, 0);
  assert.equal(ctx.calls.settingsState, 0, 'no bridge read once the marker is set');
});

test('an empty settings read is retryable and records nothing', async () => {
  const ctx = load({
    settingsState: (n) => (n === 1 ? null : { permissions: ANDROID_UNGRANTED }),
  });
  await ctx.show();
  assert.equal(ctx.sheets.length, 0, 'nothing to show without a snapshot');
  assert.deepEqual(ctx.storage.writes, [],
    'an inconclusive read must not mark the device done');
  await ctx.show();
  assert.equal(ctx.sheets.length, 1, 'a later trigger retries and presents once');
});

test('inconclusive reads stop after the attempt cap', async () => {
  const ctx = load({ settingsState: () => null });
  for (let i = 0; i < 6; i++) await ctx.show();
  assert.equal(ctx.calls.settingsState, 3,
    'an auth-status storm cannot drive unbounded 12s bridge reads');
  assert.equal(ctx.sheets.length, 0);
  assert.deepEqual(ctx.storage.writes, [], 'and still nothing is recorded');
});

test('a missing UI kit does not suppress the sheet on the next launch', async () => {
  const ctx = load({ kitMissing: true });
  await ctx.show();
  await ctx.show();
  assert.equal(ctx.sheets.length, 0);
  assert.equal(ctx.storage.marker, null,
    'nothing was shown, so the device must not be recorded as done');
  assert.equal(ctx.calls.settingsState, 1,
    'and the document stops retrying (no read storm)');
});

test('already-granted permissions still mark the device done silently', async () => {
  const ctx = load({
    permissions: {
      platform: 'android', exactAlarmGranted: true, batteryOptDisabled: true,
    },
  });
  await ctx.show();
  assert.equal(ctx.sheets.length, 0);
  assert.equal(ctx.storage.marker, '1');
});

test('the one-shot behaviour is locked in by a declared dapp.json test', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));
  const entry = (manifest.tests || []).find(
    (t) => t.path === '/?shot=first-run-permissions');
  assert.ok(entry, 'dapp.json declares the first-run sheet shot route');
  assert.match(entry.expectSelector, /data-first-run-sheets="1"/,
    'the check asserts exactly one presentation');
  assert.match(entry.expectSelector, /#first-run-permissions-sheet/);
  assert.equal(entry.allowConsoleErrors, undefined,
    'the no-console-errors baseline must hold on the shot route');
});

test('the shot route neither reads nor writes the device marker', () => {
  // The screenshot-state deep link must be side-effect free: visiting it
  // may not suppress a real user's sheet, which also means the "one copy"
  // it demonstrates comes purely from the in-memory latch.
  assert.match(nativeChromeSource,
    /_firstRunShotMode\(\)\s*\{[\s\S]*?'first-run-permissions'/,
    'the shot is recognised from the query string');
  assert.match(nativeChromeSource,
    /_markFirstRunDone\(\)\s*\{[\s\S]*?if \(NativeChrome\._firstRunShotMode\(\)\) return;/,
    'the marker write no-ops under the shot');
});
