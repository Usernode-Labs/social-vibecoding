// First-run notification consent goes straight to the operating system on
// iOS and Android. The web sheet remains only for Android block production.
// Run with: node --test tests/first-run-permissions-ios-prompt.test.js

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
    tag, children: [], listeners: {}, _text: '',
    appendChild(child) { node.children.push(child); return child; },
    addEventListener(type, fn) { node.listeners[type] = fn; },
  };
  Object.defineProperty(node, 'textContent', {
    get() { return node._text; },
    set(value) { node._text = String(value ?? ''); node.children = []; },
  });
  return node;
}

function allText(node) {
  return [node.textContent, ...node.children.map(allText)].join(' ');
}

function boot(opts = {}) {
  const sheets = [];
  const calls = [];
  const stored = { ...(opts.stored || {}) };
  let status = opts.status ?? 'notDetermined';
  let failures = opts.failures || 0;
  const permissions = opts.permissions || {
    platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null,
  };
  const capabilities = opts.capabilities || [
    'getSettingsState', 'getSocialPushState', 'requestNotificationPermission',
    'getWalletState', 'requestAlarmPermissions', 'webOwnedNotificationPrompt',
  ];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    },
    App: { user: opts.user === undefined ? { id: 'u1' } : opts.user },
    unNative: { toast() {}, platform: permissions.platform },
    usernode: {
      isNative: true,
      async getBridgeInfo() { return { version: 5, capabilities }; },
      async getSettingsState() { calls.push('getSettingsState'); return { permissions }; },
      async getSocialPushState() {
        calls.push('getSocialPushState');
        return { permissionStatus: status };
      },
      async requestNotificationPermission() {
        calls.push('requestNotificationPermission');
        if (failures-- > 0) throw new Error('temporary bridge failure');
        if (opts.statusAfterRequest) status = opts.statusAfterRequest;
        return { granted: opts.granted === true, permissions };
      },
      async getWalletState() {
        return opts.wallet || { address: null };
      },
      async requestAlarmPermissions() {
        calls.push('requestAlarmPermissions');
        return { granted: false, permissions };
      },
    },
    SocialPush: { getState() { calls.push('socialPushRefresh'); } },
    PlatformUI: opts.kitUnavailable ? null : {
      sheet(sheetOpts) {
        sheets.push(sheetOpts);
        return { dismiss() { sheetOpts.onDismiss?.(); } };
      },
    },
    localStorage: {
      getItem(key) { return stored[key] ?? null; },
      setItem(key, value) { stored[key] = String(value); },
    },
    document: {
      visibilityState: 'visible',
      createElement: fakeNode,
      getElementById() { return null; },
      addEventListener() {}, removeEventListener() {},
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    setTimeout, clearTimeout, setInterval() {},
    async fetch(url) {
      assert.equal(url, '/challenges-api/bp/state');
      calls.push('blockProductionRead');
      return { ok: true, async json() {
        return { success: true, data: { bp_requested: opts.bpRequested === true } };
      } };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);
  return { NativeChrome: sandbox.NativeChrome, sandbox, calls, sheets, stored };
}

const IOS = { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null };
const ANDROID = {
  platform: 'android', notificationsGranted: false,
  exactAlarmGranted: true, batteryOptDisabled: true,
};
const askedKey = 'sv:notification_permission_requested';

test('iOS asks through the native bridge without opening a web sheet', async () => {
  const h = boot({ permissions: IOS, granted: true, statusAfterRequest: 'authorized' });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.deepEqual(h.calls.filter((call) => call === 'requestNotificationPermission'),
    ['requestNotificationPermission']);
  assert.equal(h.calls.includes('socialPushRefresh'), true);
  assert.equal(h.sheets.length, 0);
  assert.equal(h.stored[askedKey], '1');
});

test('an old sheet marker cannot suppress an unanswered iOS OS prompt', async () => {
  const h = boot({ permissions: IOS,
    stored: { 'sv:onboarding_permissions_done': '1' },
    statusAfterRequest: 'denied' });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.calls.includes('requestNotificationPermission'), true);
  assert.equal(h.sheets.length, 0);
});

test('determined iOS permission never requests again', async () => {
  for (const status of ['authorized', 'denied']) {
    const h = boot({ permissions: IOS, status });
    await h.NativeChrome.maybeShowFirstRunPermissions();
    assert.equal(h.calls.includes('requestNotificationPermission'), false, status);
    assert.equal(h.sheets.length, 0);
  }
});

test('Flutter startup flow retains the first prompt until it advertises web ownership', async () => {
  const capabilities = [
    'getSettingsState', 'getSocialPushState', 'requestNotificationPermission',
    'getWalletState', 'requestAlarmPermissions',
  ];
  for (const permissions of [IOS, ANDROID]) {
    const h = boot({ permissions, capabilities, kitUnavailable: true });
    await h.NativeChrome.maybeShowFirstRunPermissions();
    assert.equal(h.calls.includes('requestNotificationPermission'), false);
    assert.equal(h.stored[askedKey], undefined);
  }
});

test('iOS status wins over the unrelated exact-alarm snapshot', async () => {
  const h = boot({ permissions: { ...IOS, exactAlarmGranted: true },
    statusAfterRequest: 'authorized', granted: true });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.calls.includes('requestNotificationPermission'), true);
});

test('unsupported and failed bridge requests leave the prompt eligible', async () => {
  const unsupported = boot({ permissions: IOS,
    capabilities: ['getSettingsState', 'getSocialPushState'] });
  await unsupported.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(unsupported.stored[askedKey], undefined);
  const failed = boot({ permissions: IOS, failures: 1,
    statusAfterRequest: 'authorized', granted: true });
  await failed.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(failed.stored[askedKey], undefined);
  await failed.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(failed.calls.filter((call) => call === 'requestNotificationPermission').length, 2);
});

test('concurrent first-run signals request only once', async () => {
  const h = boot({ permissions: IOS, statusAfterRequest: 'denied' });
  await Promise.all([
    h.NativeChrome.maybeShowFirstRunPermissions(),
    h.NativeChrome.maybeShowFirstRunPermissions(),
  ]);
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.calls.filter((call) => call === 'requestNotificationPermission').length, 1);
});

test('anonymous native entry still requests device-level notification consent', async () => {
  const h = boot({ permissions: IOS, user: null,
    statusAfterRequest: 'authorized', granted: true });
  assert.equal(await h.NativeChrome.enterAnonymous(), false);
  if (h.NativeChrome._firstRunPromise) await h.NativeChrome._firstRunPromise;
  assert.equal(h.calls.includes('requestNotificationPermission'), true);
  assert.equal(h.sheets.length, 0);
});

test('Android requests notifications directly before block production', async () => {
  const h = boot({ permissions: ANDROID, kitUnavailable: true, granted: true });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.calls.includes('requestNotificationPermission'), true);
  assert.equal(h.calls.includes('socialPushRefresh'), true);
  assert.equal(h.calls.includes('blockProductionRead'), false);
  assert.equal(h.sheets.length, 0);
});

test('Android does not repeat a declined OS request on later launches', async () => {
  const h = boot({ permissions: ANDROID, granted: false });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.stored[askedKey], '1');
  const again = boot({ permissions: ANDROID, stored: h.stored });
  await again.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(again.calls.includes('requestNotificationPermission'), false);
});

test('Android with notification permission already granted does not request', async () => {
  const h = boot({ permissions: { ...ANDROID, notificationsGranted: true } });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.calls.includes('requestNotificationPermission'), false);
});

test('Android producer sheet contains only alarm and battery permissions', async () => {
  const h = boot({ permissions: { ...ANDROID, exactAlarmGranted: false,
    batteryOptDisabled: false }, wallet: {
    address: 'ut1abc', staking: { delegate: null },
  }, bpRequested: true });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.calls.includes('requestNotificationPermission'), true);
  assert.equal(h.sheets.length, 1);
  const content = allText(h.sheets[0].contentEl);
  assert.match(content, /Exact alarms/);
  assert.match(content, /Battery optimization/);
  assert.doesNotMatch(content, /Allow notifications|Notifications are off/);
});

test('the remaining sheet shot presents Android setup and dispatches its ghost click', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const shot = app.slice(app.indexOf('  _applyNotifPermissionsShot() {'));
  const body = shot.slice(0, shot.indexOf('\n  },'));
  assert.match(body, /notif-permissions/);
  assert.match(body, /platform: 'android'/);
  const presentAt = body.indexOf('const sheet = NativeChrome.presentPermissionsSheet');
  const clickAt = body.indexOf('backdrop.click()');
  assert.ok(presentAt >= 0 && clickAt > presentAt);
});
