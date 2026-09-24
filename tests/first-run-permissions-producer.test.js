// The first-run "Set up your device" sheet is the ONLY place the app asks
// for device permissions: the Android app no longer covers SV with a native
// permission screen. So the sheet has to decide, from the user's status and
// the phone, what to ask:
//
//  - Android asks for exact alarms and battery only when the phone
//    produces blocks. A delegated account, or a device with no wallet, has
//    no slots to wake for and is not asked at all.
//  - It asks one step at a time, and says what the next system screen will
//    show before it shows it.
//  - "Delegate instead" opens the native staking screen, which owns the
//    target and the confirmation.
//
// Run with: node --test tests/first-run-permissions-producer.test.js

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

function findButton(node, label) {
  if (node.tag === 'button' && node.textContent === label) return node;
  for (const child of node.children) {
    const hit = findButton(child, label);
    if (hit) return hit;
  }
  return null;
}

function load({ permissions, wallet, staking }) {
  const sheets = [];
  const dismissed = [];
  const calls = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    App: { user: { id: 'u1' } },
    usernode: {
      isNative: true,
      async getBridgeInfo() {
        return {
          version: 5,
          capabilities: ['getSettingsState', 'getWalletState',
            'requestAlarmPermissions', 'manageStaking'],
        };
      },
      async getSettingsState() { return { permissions }; },
      async getWalletState() { calls.push('getWalletState'); return wallet; },
      async requestAlarmPermissions() {
        calls.push('requestAlarmPermissions');
        return { granted: false, permissions };
      },
      async requestPermissions() {
        calls.push('requestPermissions');
        return { granted: false, permissions };
      },
      async openBatterySettings() { calls.push('openBatterySettings'); return true; },
      async manageStaking() { calls.push('manageStaking'); return staking; },
    },
    PlatformUI: {
      sheet(opts) {
        sheets.push(opts);
        return {
          dismiss() {
            dismissed.push(opts);
            if (opts.onDismiss) opts.onDismiss({ interacted: true, elapsedMs: 1000 });
          },
        };
      },
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    document: {
      visibilityState: 'visible',
      getElementById() { return null; },
      createElement(tag) { return fakeNode(tag); },
      addEventListener() {},
      removeEventListener() {},
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    setTimeout(fn) { return setTimeout(fn, 0); },
    clearTimeout,
    setInterval() {},
    fetch() { return Promise.reject(new Error('unexpected fetch')); },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);
  return { NativeChrome: sandbox.NativeChrome, sheets, dismissed, calls };
}

const nothingGranted = {
  platform: 'android', exactAlarmGranted: false, batteryOptDisabled: false,
};
const producing = { address: 'ut1abc', staking: { delegate: null } };

test('who needs the block-production permissions', () => {
  const { NativeChrome } = load({ permissions: nothingGranted, wallet: producing });
  assert.equal(NativeChrome.producerNeedsDevicePermissions('producing'), true);
  assert.equal(NativeChrome.producerNeedsDevicePermissions('unknown'), true);
  assert.equal(NativeChrome.producerNeedsDevicePermissions('delegated'), false);
  assert.equal(NativeChrome.producerNeedsDevicePermissions('none'), false);
});

test('a delegated account is never asked about alarms or battery', async () => {
  const h = load({
    permissions: nothingGranted,
    wallet: { address: 'ut1abc', staking: { delegate: 'ut1server' } },
  });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.sheets.length, 0);
});

test('a device with no wallet is never asked about alarms or battery', async () => {
  const h = load({ permissions: nothingGranted, wallet: { address: null } });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.sheets.length, 0);
});

test('a producing phone is asked one step at a time, exact alarms first', async () => {
  const h = load({ permissions: nothingGranted, wallet: producing });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.sheets.length, 1);
  const content = h.sheets[0].contentEl;
  const text = allText(content);
  assert.match(text, /no access to your data/);
  assert.match(text, /Alarms & reminders/,
    'the copy names the settings page before opening it');
  assert.ok(!findButton(content, 'Allow background use'),
    'the battery step waits until exact alarms are granted');

  await findButton(content, 'Allow exact alarms').listeners.click();
  assert.ok(h.calls.includes('requestAlarmPermissions'),
    'the granular method is used, so no notification prompt rides along');
  assert.ok(!h.calls.includes('requestPermissions'));
});

test('the battery step prepares the user for the system dialog', async () => {
  const h = load({
    permissions: { platform: 'android', exactAlarmGranted: true, batteryOptDisabled: false },
    wallet: producing,
  });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  const content = h.sheets[0].contentEl;
  const text = allText(content);
  assert.match(text, /always run in the background/);
  assert.match(text, /Tap Allow/);
  assert.match(text, /change it any time/);

  await findButton(content, 'Allow background use').listeners.click();
  assert.ok(h.calls.includes('openBatterySettings'));
});

test('Delegate instead opens the native staking screen and closes on delegation', async () => {
  const h = load({
    permissions: nothingGranted,
    wallet: producing,
    staking: { delegate: 'ut1server', delegated_since: null },
  });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  await findButton(h.sheets[0].contentEl, 'Delegate instead').listeners.click();
  assert.ok(h.calls.includes('manageStaking'));
  assert.equal(h.dismissed.length, 1, 'nothing is left to ask once delegated');
});

test('Delegate instead keeps the sheet when the user backs out', async () => {
  const h = load({
    permissions: nothingGranted,
    wallet: producing,
    staking: { delegate: null, delegated_since: null },
  });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  await findButton(h.sheets[0].contentEl, 'Delegate instead').listeners.click();
  assert.equal(h.dismissed.length, 0);
});
