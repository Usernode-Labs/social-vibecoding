// Platform-accurate permission copy — the Android block-production sheet
// and Settings → Homeroom app rows describe what each OS prompts for:
//
//  - Android: the exact-alarm permission (plus battery optimization) so
//    the node can produce blocks at exact slot times. Copy unchanged.
//  - iOS: notification consent uses the OS prompt directly, with no web
//    first-run sheet. Settings still labels its row Notifications.
//
// Run with: node --test tests/first-run-permissions-copy.test.js

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

// Minimal DOM node: enough for the el()/appendChild/textContent usage in
// maybeShowFirstRunPermissions. Setting textContent clears children,
// mirroring the real DOM (render() relies on that to re-render).
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

async function showFirstRunSheet(permissions) {
  const sheets = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    App: { user: { id: 'u1' } },
    usernode: {
      isNative: true,
      async getBridgeInfo() {
        return { version: 4, capabilities: ['getSettingsState'] };
      },
      async getSettingsState() { return { permissions }; },
      async requestPermissions() { return { granted: false, permissions }; },
      async openBatterySettings() { return true; },
    },
    PlatformUI: {
      sheet(opts) {
        sheets.push(opts);
        return { dismiss() { if (opts.onDismiss) opts.onDismiss(); } };
      },
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    document: {
      getElementById() { return null; },
      createElement(tag) { return fakeNode(tag); },
      addEventListener() {},
      removeEventListener() {},
    },
    addEventListener() {},
    removeEventListener() {},
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
  return allText(sheets[0].contentEl);
}

test('Android first-run sheet keeps the exact-alarm + battery copy', async () => {
  const text = await showFirstRunSheet({
    platform: 'android', exactAlarmGranted: false, batteryOptDisabled: false,
  });
  assert.match(text, /Exact alarms/);
  assert.match(text, /Battery optimization/);
  assert.match(text, /produce blocks/,
    'Android copy still explains block production');
  assert.match(text, /exact slot times/);
  assert.doesNotMatch(text, /Allow notifications/,
    'notification consent is no longer part of this sheet');
});

test('settings device-permissions section is platform-accurate', () => {
  assert.ok(!settingsJs.includes('Alarm permissions'),
    'settings.js must not label the iOS row "Alarm permissions"');
  assert.match(settingsJs, /isAndroid \? 'Exact alarms' : 'Notifications'/,
    'the row label switches to Notifications on iOS');
  // The section description must be platform-gated too: the
  // block-production pitch is Android-only, iOS explains notifications.
  const desc = /isAndroid\s*\n?\s*\? 'Block production needs the app to wake your device at exact slot times\.'\s*\n?\s*: '[^']*[Nn]otif[^']*'/;
  assert.match(settingsJs, desc,
    'the section description is gated on isAndroid');
});

test('native-chrome.js carries no "Alarm permissions" wording anywhere', () => {
  assert.ok(!nativeChromeSource.includes('Alarm permissions'));
});
