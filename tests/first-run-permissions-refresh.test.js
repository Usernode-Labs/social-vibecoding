// The first-run "Set up your device" sheet must never ask for a permission
// the device already has. Its first snapshot can be stale: every Android
// grant happens on a system settings page or dialog. So while the sheet is open it re-reads
// getSettingsState when the page becomes visible again or the app reports
// `usernode:permissions-changed`, and closes itself once nothing is left.
//
// Run with: node --test tests/first-run-permissions-refresh.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const nativeChromeSource = fs.readFileSync(
  path.join(root, 'public', 'js', 'native-chrome.js'), 'utf8');

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

function allText(node) {
  return [node.textContent, ...node.children.map(allText)].join(' ');
}

function listenerTarget() {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((l) => l !== fn);
    },
    async fire(type) {
      await Promise.all((listeners[type] || []).slice().map((fn) => fn({ type })));
    },
  };
}

async function openAndroidSheet(initialPermissions) {
  let permissions = initialPermissions;
  let reads = 0;
  const sheets = [];
  const dismissed = [];
  const stored = {};
  const win = listenerTarget();
  const doc = listenerTarget();
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    App: { user: { id: 'u1' } },
    usernode: {
      isNative: true,
      async getBridgeInfo() {
        return { version: 4, capabilities: ['getSettingsState'] };
      },
      async getSettingsState() { reads++; return { permissions }; },
      async requestPermissions() { return { granted: false, permissions }; },
      async openBatterySettings() { return true; },
    },
    PlatformUI: {
      sheet(opts) {
        sheets.push(opts);
        return {
          dismiss() {
            dismissed.push(opts);
            if (opts.onDismiss) opts.onDismiss();
          },
        };
      },
    },
    localStorage: {
      getItem(key) { return key in stored ? stored[key] : null; },
      setItem(key, value) { stored[key] = String(value); },
    },
    document: {
      visibilityState: 'visible',
      getElementById() { return null; },
      createElement(tag) { return fakeNode(tag); },
      addEventListener: doc.addEventListener,
      removeEventListener: doc.removeEventListener,
    },
    addEventListener: win.addEventListener,
    removeEventListener: win.removeEventListener,
    dispatchEvent() {},
    setTimeout(fn, delay) {
      const t = setTimeout(fn, delay);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    },
    clearTimeout,
    setInterval() {},
    fetch(url) {
      // #2960: the Android sheet waits for block production; these
      // devices have asked for it.
      if (url === '/challenges-api/bp/state') {
        return Promise.resolve({ ok: true, async json() {
          return { success: true, data: { bp_requested: true, bp_released: false } };
        } });
      }
      return Promise.reject(new Error('unexpected fetch'));
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 1, 'the first-run sheet was shown once');
  return {
    sheet: sheets[0],
    dismissed,
    win,
    doc,
    get reads() { return reads; },
    setPermissions(next) { permissions = next; },
    firstRunDone: () => stored['sv:onboarding_permissions_done'] === '1',
  };
}

const staleBattery = {
  platform: 'android', exactAlarmGranted: true, batteryOptDisabled: false,
};
const allGranted = {
  platform: 'android', exactAlarmGranted: true, batteryOptDisabled: true,
};

test('the app reporting a permission change closes a sheet with nothing left to ask', async () => {
  const h = await openAndroidSheet(staleBattery);
  h.setPermissions(allGranted);

  await h.win.fire('usernode:permissions-changed');

  assert.equal(h.dismissed.length, 1, 'the sheet dismissed itself');
  assert.ok(h.firstRunDone(), 'first run is recorded as done');
});

test('returning from battery settings re-reads the state before asking again', async () => {
  const h = await openAndroidSheet({
    platform: 'android', exactAlarmGranted: false, batteryOptDisabled: false,
  });
  h.setPermissions({
    platform: 'android', exactAlarmGranted: false, batteryOptDisabled: true,
  });

  await h.doc.fire('visibilitychange');

  assert.equal(h.dismissed.length, 0, 'exact alarms are still missing');
  const text = allText(h.sheet.contentEl);
  assert.doesNotMatch(text, /Allow background use/,
    'a granted battery exemption is no longer asked for');
  assert.match(text, /Allow exact alarms/);
});

test('a dismissed sheet stops listening', async () => {
  const h = await openAndroidSheet(staleBattery);
  h.setPermissions(allGranted);
  await h.win.fire('usernode:permissions-changed');
  const readsAfterDismiss = h.reads;

  await h.win.fire('usernode:permissions-changed');
  await h.doc.fire('visibilitychange');

  assert.equal(h.reads, readsAfterDismiss, 'no reads after dismissal');
  assert.equal(h.dismissed.length, 1);
});
