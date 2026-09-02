const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settingsSource = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'settings', 'settings.js'),
  'utf8'
);

function loadSettings({ nativeTerminal = true, nativeFailure, webOk = true } = {}) {
  const order = [];
  const logoutButton = { disabled: false };
  let href = 'https://social.example/#settings';
  const location = {};
  Object.defineProperty(location, 'href', {
    get() { return href; },
    set(value) { order.push('navigate'); href = value; },
  });
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      addEventListener() {},
      getElementById(id) {
        return id === 'settings-logout' ? logoutButton : null;
      },
    },
    navigator: {},
    location,
    NativeChrome: {
      prepareWebLogout() {
        order.push('close-native-realm');
        return { nativeTerminal };
      },
      commitNativeLogout() {
        order.push('native-terminal');
        return nativeFailure ? Promise.reject(nativeFailure) : Promise.resolve(true);
      },
    },
    PlatformUI: {
      toast(message, options) {
        order.push(/signed out/i.test(message)
          ? 'local-shutdown-error' : 'logout-error');
        assert.equal(options.error, true);
      },
    },
    async fetch(url, options) {
      assert.equal(url, '/api/auth/logout');
      assert.equal(options.method, 'POST');
      order.push('web-session');
      return { ok: webOk, status: webOk ? 200 : 503 };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(settingsSource, sandbox);
  sandbox.Settings._clearSwApiCache = async () => { order.push('sw-cache'); };
  return {
    sandbox, order, logoutButton,
    get href() { return href; },
  };
}

test('realm closes synchronously before the first logout await', async () => {
  const loaded = loadSettings({ nativeTerminal: false });

  const logout = loaded.sandbox.Settings.logout();
  assert.deepEqual(loaded.order, ['close-native-realm', 'web-session']);
  await logout;
  assert.deepEqual(loaded.order, [
    'close-native-realm', 'web-session', 'sw-cache', 'navigate',
  ]);
});

test('web logout and cache cleanup precede terminal protocol-2 logout',
  async () => {
    const loaded = loadSettings({ nativeTerminal: true });

    await loaded.sandbox.Settings.logout();

    assert.deepEqual(loaded.order, [
      'close-native-realm', 'web-session', 'sw-cache', 'native-terminal',
    ]);
    assert.equal(loaded.href, 'https://social.example/#settings',
      'native success owns runtime replacement; old JS does not continue');
  });

test('web-only logout hard-navigates after clearing the web session',
  async () => {
    const loaded = loadSettings({ nativeTerminal: false });

    await loaded.sandbox.Settings.logout();

    assert.deepEqual(loaded.order, [
      'close-native-realm', 'web-session', 'sw-cache', 'navigate',
    ]);
    assert.equal(loaded.href, '/');
  });

test('native terminal failure leaves server logout complete and the realm closed', async () => {
  const loaded = loadSettings({
    nativeFailure: new Error('app update required'),
  });

  assert.equal(await loaded.sandbox.Settings.logout(), false);
  assert.deepEqual(loaded.order, [
    'close-native-realm', 'web-session', 'sw-cache', 'native-terminal',
    'local-shutdown-error',
  ]);
  assert.equal(loaded.logoutButton.disabled, true);
  assert.equal(loaded.href, 'https://social.example/#settings');
});

test('failed web logout leaves native terminal untouched and the page closed',
  async () => {
    const loaded = loadSettings({ webOk: false });

    assert.equal(await loaded.sandbox.Settings.logout(), false);
    assert.deepEqual(loaded.order, [
      'close-native-realm', 'web-session', 'logout-error',
    ]);
    assert.equal(loaded.logoutButton.disabled, false);
    assert.equal(loaded.href, 'https://social.example/#settings');
  });
