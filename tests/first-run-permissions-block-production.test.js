// #2960: do not ask for unrestricted background usage until the user has
// enabled block production.
//
// On Android the first-run "Set up your device" sheet asks for exact alarms
// and freedom from battery optimization ("unrestricted" background usage).
// Both exist only so the node can produce blocks, so the sheet now waits
// until the account's block-producer queue state
// (GET /challenges-api/bp/state) says it has requested, or been released
// for, block production. Deferring must NOT write the one-shot marker, so
// the sheet can still be offered later, and Settings' "Ask to produce
// blocks" action re-runs the trigger at exactly that moment. iOS, whose
// sheet is the notification prompt, is unchanged.
//
// Run with: node --test tests/first-run-permissions-block-production.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const nativeChromeSource = fs.readFileSync(
  path.join(root, 'public', 'js', 'native-chrome.js'), 'utf8');
const settingsJs = fs.readFileSync(
  path.join(root, 'frontend', 'src', 'features', 'settings', 'settings.js'), 'utf8');

const MARKER = 'sv:onboarding_permissions_done';
const ANDROID_UNGRANTED = {
  platform: 'android', exactAlarmGranted: false, batteryOptDisabled: false,
};
const ANDROID_GRANTED = {
  platform: 'android', exactAlarmGranted: true, batteryOptDisabled: true,
};
const IOS_UNGRANTED = {
  platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null,
};

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

// opts: { permissions, kitPlatform, bp (payload | 'error' | 'http500'),
//         user, socialPushState }
function boot(opts) {
  const sheets = [];
  const stored = {};
  const fetches = [];
  let bp = opts.bp;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    App: { user: opts.user !== undefined ? opts.user : { id: 'u1' } },
    unNative: { toast() {}, platform: opts.kitPlatform || 'android' },
    usernode: {
      isNative: true,
      async getBridgeInfo() {
        return { version: 5, capabilities: ['getSettingsState', 'getSocialPushState'] };
      },
      async getSettingsState() { return { permissions: opts.permissions }; },
      async getSocialPushState() { return opts.socialPushState || null; },
      async requestPermissions() { return { granted: false, permissions: opts.permissions }; },
      async openBatterySettings() { return true; },
    },
    PlatformUI: {
      sheet(sheetOpts) {
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
      removeEventListener() {},
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    setTimeout, clearTimeout,
    setInterval() {},
    fetch(url, init) {
      fetches.push({ url, init });
      if (url !== '/challenges-api/bp/state') {
        return Promise.reject(new Error('unexpected fetch ' + url));
      }
      if (bp === 'error') return Promise.reject(new TypeError('Failed to fetch'));
      if (bp === 'http500') {
        return Promise.resolve({ ok: false, status: 500, async json() { return {}; } });
      }
      return Promise.resolve({
        ok: true,
        async json() { return { success: true, data: bp }; },
      });
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);
  return {
    NativeChrome: sandbox.NativeChrome,
    sheets,
    fetches,
    marked: () => stored[MARKER] === '1',
    setBp(next) { bp = next; },
  };
}

// ── The pure decision ──────────────────────────────────────────────────

test('decideFirstRunSheet: Android without block production defers', () => {
  const h = boot({ permissions: ANDROID_UNGRANTED });
  const decide = h.NativeChrome.decideFirstRunSheet;
  assert.equal(decide({ isAndroid: true, needsAlarm: true, needsBattery: true,
    blockProduction: false }), 'defer');
  assert.equal(decide({ isAndroid: true, needsAlarm: false, needsBattery: true,
    blockProduction: false }), 'defer',
  'the unrestricted-background ask alone also waits');
  assert.equal(decide({ isAndroid: true, needsAlarm: true, needsBattery: false }),
    'defer', 'an unknown block-production state is not a yes');
});

test('decideFirstRunSheet: Android with block production presents', () => {
  const h = boot({ permissions: ANDROID_UNGRANTED });
  assert.equal(h.NativeChrome.decideFirstRunSheet({ isAndroid: true,
    needsAlarm: true, needsBattery: true, blockProduction: true }), 'present');
});

test('decideFirstRunSheet: nothing to ask is done on both platforms', () => {
  const h = boot({ permissions: ANDROID_GRANTED });
  const decide = h.NativeChrome.decideFirstRunSheet;
  assert.equal(decide({ isAndroid: true, needsAlarm: false, needsBattery: false,
    blockProduction: false }), 'done');
  assert.equal(decide({ isAndroid: false, needsAlarm: false, needsBattery: false }),
    'done');
});

test('decideFirstRunSheet: iOS never waits for block production', () => {
  const h = boot({ permissions: IOS_UNGRANTED, kitPlatform: 'ios' });
  assert.equal(h.NativeChrome.decideFirstRunSheet({ isAndroid: false,
    needsAlarm: true, needsBattery: false, blockProduction: false }), 'present');
});

// ── The trigger ────────────────────────────────────────────────────────

test('Android, block production not requested: no sheet, marker NOT written', async () => {
  const h = boot({ permissions: ANDROID_UNGRANTED,
    bp: { has_platform_access: true, bp_requested: false, bp_released: false } });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.sheets.length, 0, 'no unrestricted-background ask yet');
  assert.equal(h.marked(), false, 'the one-shot marker stays unwritten');
  assert.equal(h.fetches.length, 1);
  assert.equal(h.fetches[0].url, '/challenges-api/bp/state');
  assert.equal(h.fetches[0].init.credentials, 'same-origin');
  assert.equal(h.NativeChrome.firstRunSheetPresented(), false,
    'the terms gate is not held behind a sheet that never opened');
});

test('Android, block production requested: the sheet is presented', async () => {
  const h = boot({ permissions: ANDROID_UNGRANTED,
    bp: { has_platform_access: true, bp_requested: true, bp_released: false } });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.sheets.length, 1);
});

test('Android, block production released: the sheet is presented', async () => {
  const h = boot({ permissions: ANDROID_UNGRANTED,
    bp: { has_platform_access: true, bp_requested: false, bp_released: true } });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.sheets.length, 1);
});

test('Android: an unreadable queue state defers instead of asking', async () => {
  for (const bp of ['error', 'http500']) {
    const h = boot({ permissions: ANDROID_UNGRANTED, bp });
    await h.NativeChrome.maybeShowFirstRunPermissions();
    assert.equal(h.sheets.length, 0, `${bp}: no sheet`);
    assert.equal(h.marked(), false, `${bp}: marker unwritten`);
  }
});

test('Android, anonymous entry: no queue read, no sheet, no marker', async () => {
  const h = boot({ permissions: ANDROID_UNGRANTED, user: null,
    bp: { bp_requested: true } });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.fetches.length, 0, 'an anonymous visitor has no queue state');
  assert.equal(h.sheets.length, 0);
  assert.equal(h.marked(), false);
});

test('Android, everything already granted: marker written, no queue read', async () => {
  const h = boot({ permissions: ANDROID_GRANTED, bp: { bp_requested: false } });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.sheets.length, 0);
  assert.equal(h.marked(), true);
  assert.equal(h.fetches.length, 0);
});

test('Android: a deferred sheet is offered once block production is requested', async () => {
  const h = boot({ permissions: ANDROID_UNGRANTED, bp: { bp_requested: false } });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.sheets.length, 0);
  // Settings' "Ask to produce blocks" succeeds, then re-runs the trigger.
  h.setBp({ bp_requested: true, bp_released: false });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.sheets.length, 1,
    'the deferral left the shared run and the marker free for a later offer');
});

test('iOS is unchanged: notification sheet with no block-production read', async () => {
  const h = boot({ permissions: IOS_UNGRANTED, kitPlatform: 'ios',
    bp: { bp_requested: false, bp_released: false },
    socialPushState: { permissionStatus: 'notDetermined' } });
  await h.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(h.sheets.length, 1, 'iOS still offers the notification prompt');
  assert.equal(h.fetches.length, 0, 'iOS never consults the producer queue');
});

// ── The re-offer hook ──────────────────────────────────────────────────

test('Settings re-runs the first-run trigger after a successful block-production request', () => {
  const start = settingsJs.indexOf('async _askForBlockProduction()');
  assert.ok(start !== -1, '_askForBlockProduction exists');
  const end = settingsJs.indexOf('\n    },', start);
  const body = settingsJs.slice(start, end);
  const requested = body.indexOf('bp_requested: true');
  const offer = body.indexOf('NativeChrome.maybeShowFirstRunPermissions()');
  assert.ok(requested !== -1 && offer > requested,
    'the offer follows the recorded request, inside the success path');
  const catchAt = body.indexOf('} catch (e)');
  assert.ok(catchAt === -1 || offer < catchAt,
    'a failed request does not offer the sheet');
});
