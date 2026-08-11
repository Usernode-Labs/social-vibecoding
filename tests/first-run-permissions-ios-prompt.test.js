// iOS notification-permission trigger reliability (first-run sheet).
//
// On iOS the ONLY automatic trigger for the OS notification prompt is the
// first-run "Set up your device" sheet (its "Allow notifications" button
// calls usernode.requestPermissions()). The sheet used to be guarded by a
// single unconditional one-shot localStorage marker, and several paths set
// that marker WITHOUT the OS prompt ever having been presented:
//
//   - a degraded UI kit (PlatformUI.sheet() → null) still marked done;
//   - earlier app/shell versions that reported "nothing to ask" on iOS
//     marked done, and the marker survives app updates in the WebView;
//   - a dismissed (possibly stacked, #1068) sheet marked done even though
//     the user never tapped "Allow notifications".
//
// iOS can distinguish "never asked" from "denied" through the social-push
// state (permissionStatus: notDetermined vs denied). While the permission
// is still un-prompted, suppressing the ask forever is wrong — the sheet
// must be offered again (once per launch). A determined status (granted
// or denied) keeps the marker authoritative, and Android is unchanged.
//
// Run with: node --test tests/first-run-permissions-ios-prompt.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const nativeChromeSource = fs.readFileSync(
  path.join(root, 'public', 'js', 'native-chrome.js'), 'utf8');

// The sheet must reach signed-out users too: the OS notification prompt
// (and the Android alarm/battery asks) are device-level, not
// account-level, so the anonymous-session admission is also a trigger.

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

// Boot native-chrome.js in a sandbox and return handles for driving
// maybeShowFirstRunPermissions under different device states.
function boot(opts) {
  const sheets = [];
  const stored = { ...(opts.stored || {}) };
  const capabilities = opts.capabilities ||
    ['getSettingsState', 'getSocialPushState'];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    App: { user: opts.user !== undefined ? opts.user : { id: 'u1' } },
    unNative: opts.unNative !== undefined ? opts.unNative
      : { toast() {}, platform: opts.kitPlatform || 'ios' },
    usernode: {
      isNative: true,
      async getBridgeInfo() { return { version: 4, capabilities }; },
      async enterAnonymousSession() { return { admitted: true }; },
      async getSettingsState() { return { permissions: opts.permissions }; },
      async getSocialPushState() {
        if (opts.socialPushState === undefined) return null;
        return opts.socialPushState;
      },
      async requestPermissions() {
        return { granted: false, permissions: opts.permissions };
      },
      async openBatterySettings() { return true; },
    },
    PlatformUI: {
      sheet(sheetOpts) {
        if (opts.kitSheetUnavailable) return null;
        sheets.push(sheetOpts);
        return { dismiss() { if (sheetOpts.onDismiss) sheetOpts.onDismiss(); } };
      },
    },
    localStorage: {
      getItem(key) { return Object.hasOwn(stored, key) ? stored[key] : null; },
      setItem(key, value) { stored[key] = String(value); },
    },
    document: {
      getElementById() { return null; },
      createElement(tag) { return fakeNode(tag); },
      addEventListener() {},
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
  return { sandbox, sheets, stored };
}

const MARKER = 'sv:onboarding_permissions_done';
const IOS_UNPROMPTED = {
  enabled: false,
  permissionStatus: 'notDetermined',
  registrationStatus: 'unregistered',
  deliveryActive: false,
};

test('iOS: a stale done-marker does not suppress the sheet while the OS ' +
     'prompt has never been shown', async () => {
  const { sandbox, sheets } = boot({
    stored: { [MARKER]: '1' },
    permissions: { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null },
    socialPushState: IOS_UNPROMPTED,
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 1,
    'an un-prompted iOS device gets the sheet despite the marker');
});

test('iOS: marker plus a DENIED permission stays suppressed (the user ' +
     'already answered the OS prompt)', async () => {
  const { sandbox, sheets } = boot({
    stored: { [MARKER]: '1' },
    permissions: { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null },
    socialPushState: { ...IOS_UNPROMPTED, permissionStatus: 'denied' },
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 0);
});

test('iOS: marker plus an authorized permission stays suppressed', async () => {
  const { sandbox, sheets } = boot({
    stored: { [MARKER]: '1' },
    permissions: { platform: 'ios', exactAlarmGranted: true, batteryOptDisabled: null },
    socialPushState: { ...IOS_UNPROMPTED, permissionStatus: 'authorized' },
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 0);
});

test('iOS: the sheet shows even when the settings snapshot claims ' +
     'exactAlarmGranted while the push permission is un-prompted', async () => {
  // Defends against native builds where the alarm boolean does not map to
  // the notification permission (there are no exact alarms on iOS).
  const { sandbox, sheets } = boot({
    permissions: { platform: 'ios', exactAlarmGranted: true, batteryOptDisabled: null },
    socialPushState: IOS_UNPROMPTED,
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 1);
});

test('iOS: without the social-push capability the boolean fallback still ' +
     'shows the sheet on a fresh device', async () => {
  const { sandbox, sheets } = boot({
    capabilities: ['getSettingsState'],
    permissions: { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null },
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 1);
});

test('a degraded kit (sheet unavailable) must NOT burn the one-shot ' +
     'marker — nothing was shown', async () => {
  const { sandbox, sheets, stored } = boot({
    kitSheetUnavailable: true,
    permissions: { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null },
    socialPushState: IOS_UNPROMPTED,
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 0);
  assert.notEqual(stored[MARKER], '1',
    'a launch that presented nothing must leave the next launch its chance');
});

test('concurrent and repeat triggers in one document present exactly one ' +
     'sheet', async () => {
  const { sandbox, sheets } = boot({
    permissions: { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null },
    socialPushState: IOS_UNPROMPTED,
  });
  await Promise.all([
    sandbox.NativeChrome.maybeShowFirstRunPermissions(),
    sandbox.NativeChrome.maybeShowFirstRunPermissions(),
  ]);
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 1,
    'the sv:session/auth-status trigger storm must not stack sheets');
});

test('Android: the marker still suppresses the sheet with no bridge ' +
     'reads', async () => {
  let settingsReads = 0;
  const { sandbox, sheets } = boot({
    stored: { [MARKER]: '1' },
    kitPlatform: 'android',
    permissions: { platform: 'android', exactAlarmGranted: false, batteryOptDisabled: false },
  });
  const inner = sandbox.usernode.getSettingsState;
  sandbox.usernode.getSettingsState = async () => { settingsReads += 1; return inner(); };
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 0);
  assert.equal(settingsReads, 0,
    'a marked Android device keeps the instant-return fast path');
});

test('anonymous: a signed-out iOS device still gets the sheet once the ' +
     'anonymous session is admitted', async () => {
  const { sandbox, sheets } = boot({
    user: null,
    capabilities: ['getSettingsState', 'getSocialPushState',
      'enterAnonymousSession'],
    permissions: { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null },
    socialPushState: IOS_UNPROMPTED,
  });
  const admitted = await sandbox.NativeChrome.enterAnonymous();
  assert.equal(admitted, true, 'the anonymous session was admitted');
  // The admission fires the sheet itself — wait for that run, without
  // calling maybeShowFirstRunPermissions() here (that would mask a
  // missing trigger).
  if (sandbox.NativeChrome._firstRunPromise) {
    await sandbox.NativeChrome._firstRunPromise;
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sheets.length, 1,
    'the anonymous admission itself must trigger the sheet');
});

test('anonymous: a refused admission does not trigger the sheet', async () => {
  const { sandbox, sheets } = boot({
    user: null,
    capabilities: ['getSettingsState', 'getSocialPushState',
      'enterAnonymousSession'],
    permissions: { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null },
    socialPushState: IOS_UNPROMPTED,
  });
  sandbox.usernode.enterAnonymousSession = async () => ({ admitted: false });
  const admitted = await sandbox.NativeChrome.enterAnonymous();
  assert.equal(admitted, false);
  // Let any stray microtask chain settle before counting.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sheets.length, 0,
    'a fail-closed admission keeps the boot quiet');
});

test('Android: an unmarked device still gets the sheet', async () => {
  const { sandbox, sheets } = boot({
    kitPlatform: 'android',
    permissions: { platform: 'android', exactAlarmGranted: false, batteryOptDisabled: false },
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 1);
});
