// The first-run "Set up your device" sheet must be one-shot — for real.
//
// The sheet is reachable from several independent triggers (the boot
// login handoff in init(), every `sv:session` dispatch, and the
// `usernode:auth-status` recovery path). The one-shot localStorage
// marker used to be written only on dismiss, so every trigger that
// fired before the user dismissed the sheet stacked another identical
// copy on top — dismiss one, find another underneath (reported from
// iOS TestFlight). And a user who backgrounded/killed the app with the
// sheet still up never wrote the marker at all, so every later launch
// showed it again.
//
// Contract asserted here:
//  - overlapping triggers present exactly one sheet (guard is set
//    synchronously, before the first await);
//  - later triggers in the same document present nothing more;
//  - the marker is written when the sheet is PRESENTED, not on dismiss,
//    so the next boot stays quiet even after a hard app kill;
//  - a failed getSettingsState read stays retryable (silent skip must
//    not burn the one-shot).
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

const MARKER = 'sv:onboarding_permissions_done';

// Minimal DOM node, same shape as first-run-permissions-copy.test.js.
function fakeNode(tag) {
  const node = {
    tag,
    className: '',
    disabled: false,
    children: [],
    listeners: {},
    _text: '',
    appendChild(child) { node.children.push(child); return child; },
    addEventListener(type, fn) { node.listeners[type] = fn; },
  };
  Object.defineProperty(node, 'textContent', {
    get() { return node._text; },
    set(value) { node._text = value == null ? '' : String(value); node.children = []; },
  });
  return node;
}

// Boots a fresh document (vm context) around a shared localStorage map,
// so tests can model "next app launch" by booting a second document
// over the same store.
function bootDocument(store, opts) {
  const sheets = [];
  let settingsFails = !!(opts && opts.settingsFails);
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    // No boot user: keeps init() from starting its own background
    // handoff → maybeShowFirstRunPermissions chain, which would
    // interleave with the calls each test issues deliberately.
    App: { user: null },
    usernode: {
      isNative: true,
      async getBridgeInfo() {
        return { version: 4, capabilities: ['getSettingsState'] };
      },
      async getSettingsState() {
        // Yield once, like the real async bridge round-trip — this is
        // the gap concurrent triggers used to fall through.
        await Promise.resolve();
        if (settingsFails) throw new Error('bridge read failed');
        return { permissions: { platform: 'ios', exactAlarmGranted: false } };
      },
      async requestPermissions() { return { granted: false }; },
      async openBatterySettings() { return true; },
    },
    PlatformUI: {
      sheet(opts2) {
        sheets.push(opts2);
        return { dismiss() { if (opts2.onDismiss) opts2.onDismiss(); } };
      },
    },
    localStorage: {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { store.set(key, String(value)); },
    },
    document: {
      getElementById() { return null; },
      createElement(tag) { return fakeNode(tag); },
      addEventListener() {},
      dispatchEvent() {},
    },
    addEventListener() {},
    dispatchEvent() {},
    setTimeout(fn, delay) {
      const t = setTimeout(fn, delay);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    },
    clearTimeout,
    fetch() { return Promise.reject(new Error('unexpected fetch')); },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);
  return {
    NativeChrome: sandbox.NativeChrome,
    sheets,
    setSettingsFails(value) { settingsFails = value; },
  };
}

test('overlapping triggers present exactly one sheet', async () => {
  const doc = bootDocument(new Map());
  await Promise.all([
    doc.NativeChrome.maybeShowFirstRunPermissions(),
    doc.NativeChrome.maybeShowFirstRunPermissions(),
  ]);
  assert.equal(doc.sheets.length, 1,
    'concurrent sv:session / auth-status triggers must not stack sheets');
});

test('a later trigger while the sheet is open presents nothing more', async () => {
  const doc = bootDocument(new Map());
  await doc.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(doc.sheets.length, 1);
  // The user has not dismissed anything yet; another session signal fires.
  await doc.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(doc.sheets.length, 1,
    'a second trigger before dismiss must not present a second sheet');
});

test('marker is written at presentation, so the next boot stays quiet', async () => {
  const store = new Map();
  const doc = bootDocument(store);
  await doc.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(doc.sheets.length, 1);
  assert.equal(store.get(MARKER), '1',
    'the one-shot marker must not wait for dismiss — an app kill with ' +
    'the sheet still up must count as done');
  // "Next launch": fresh document, same device storage, sheet never
  // dismissed in the previous one.
  const next = bootDocument(store);
  await next.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(next.sheets.length, 0,
    'the sheet must not come back on the next boot');
});

test('a failed settings read stays retryable and shows the sheet once later', async () => {
  const doc = bootDocument(new Map(), { settingsFails: true });
  await doc.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(doc.sheets.length, 0, 'silent skip on a failed bridge read');
  doc.setSettingsFails(false);
  await doc.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(doc.sheets.length, 1,
    'the silent skip must not burn the one-shot for this document');
});
