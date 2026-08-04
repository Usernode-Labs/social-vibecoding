const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settingsSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'settings.js'),
  'utf8'
);

function loadSettings({
  nativeTerminal = true,
  prepare = 'ok',
  webLogout = 'ok',
  commitImpl,
} = {}) {
  const events = [];
  const logoutButton = { disabled: false };
  let href = 'https://social.example/#settings';
  const location = {};
  Object.defineProperty(location, 'href', {
    get() { return href; },
    set(value) {
      events.push('navigate');
      href = value;
    },
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
      async prepareWebLogout() {
        events.push('prepare-native-latch');
        if (prepare === 'throw') throw new Error('native latch failed');
        return nativeTerminal;
      },
      commitNativeLogout() {
        assert.deepEqual(events, [
          'prepare-native-latch',
          'web-session',
          'sw-cache',
        ],
          'all web-owned cleanup must precede native teardown');
        events.push('native-hard-logout');
        return commitImpl ? commitImpl() : true;
      },
    },
    PlatformUI: {
      toast(message, options) {
        events.push('logout-error');
        assert.match(message, /could not sign out/i);
        assert.equal(options.error, true);
      },
    },
    async fetch(url, options) {
      assert.equal(url, '/api/auth/logout');
      assert.equal(options.method, 'POST');
      events.push('web-session');
      if (webLogout === 'throw') throw new Error('offline');
      return { ok: webLogout === 'ok', status: 503 };
    },
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(settingsSource, sandbox);
  sandbox.Settings._clearSwApiCache = async () => {
    events.push('sw-cache');
  };
  return { sandbox, events, logoutButton, get href() { return href; } };
}

test('web logout and cache cleanup commit before terminal native logout', async () => {
  const loaded = loadSettings();

  await loaded.sandbox.Settings.logout();

  assert.deepEqual(loaded.events, [
    'prepare-native-latch',
    'web-session',
    'sw-cache',
    'native-hard-logout',
  ]);
  assert.equal(loaded.href, 'https://social.example/#settings',
    'successful native logout owns runtime replacement; old JS does not navigate');
  assert.equal(loaded.logoutButton.disabled, true);
});

test('browser navigation remains the fallback when native logout is not admitted',
  async () => {
    const loaded = loadSettings({ nativeTerminal: false });

    await loaded.sandbox.Settings.logout();

    assert.deepEqual(loaded.events, [
      'prepare-native-latch',
      'web-session',
      'sw-cache',
      'navigate',
    ]);
    assert.equal(loaded.href, '/#login');
  });

test('failed web logout keeps native identity and the current document alive',
  async () => {
    const loaded = loadSettings({ webLogout: 'non-ok' });

    const result = await loaded.sandbox.Settings.logout();

    assert.equal(result, false);
    assert.deepEqual(loaded.events, [
      'prepare-native-latch',
      'web-session',
      'logout-error',
    ]);
    assert.equal(loaded.logoutButton.disabled, false);
    assert.equal(loaded.href, 'https://social.example/#settings');
  });

test('offline web logout also stops before cache and native teardown', async () => {
  const loaded = loadSettings({ webLogout: 'throw' });

  const result = await loaded.sandbox.Settings.logout();

  assert.equal(result, false);
  assert.deepEqual(loaded.events, [
    'prepare-native-latch',
    'web-session',
    'logout-error',
  ]);
  assert.equal(loaded.logoutButton.disabled, false);
});

test('failed native preflight aborts before web logout and cache cleanup',
  async () => {
    const loaded = loadSettings({ prepare: 'throw' });

    const result = await loaded.sandbox.Settings.logout();

    assert.equal(result, false);
    assert.deepEqual(loaded.events, [
      'prepare-native-latch',
      'logout-error',
    ]);
    assert.equal(loaded.logoutButton.disabled, false);
    assert.equal(loaded.href, 'https://social.example/#settings');
  });

test('terminal native logout has no timeout or old-document continuation',
  async () => {
    const never = new Promise(() => {});
    const loaded = loadSettings({ commitImpl: () => never });

    const pending = loaded.sandbox.Settings.logout();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(loaded.events, [
      'prepare-native-latch',
      'web-session',
      'sw-cache',
      'native-hard-logout',
    ]);
    assert.equal(loaded.href, 'https://social.example/#settings');
    assert.equal(loaded.logoutButton.disabled, true);
    void pending;
  });
