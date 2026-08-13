const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settingsSource = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'settings', 'settings.js'),
  'utf8'
);

function loadSettings({
  nativeTerminal = true,
  prepare = 'ok',
  webLogout = 'ok',
  commitImpl,
  confirmResult = true,
  withConfirm = true,
  nativeLogout = null,
} = {}) {
  const events = [];
  const logoutButton = { disabled: false };
  const store = new Map();
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
    sessionStorage: {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) {
        events.push('note-incomplete');
        store.set(key, String(value));
      },
      removeItem(key) { store.delete(key); },
    },
    NativeChrome: {
      async prepareWebLogout() {
        events.push('prepare-native-latch');
        if (prepare === 'throw') throw new Error('native latch failed');
        // A pre-#1161 build resolved a bare boolean; still supported.
        if (prepare === 'legacy') return nativeTerminal;
        if (prepare === 'unavailable') {
          return {
            nativeTerminal: false,
            latch: 'unavailable',
            reason: 'Privileged bridge is unavailable for this main frame',
            code: 'privileged_frame_unauthorized',
          };
        }
        if (prepare === 'inconclusive') {
          return {
            nativeTerminal: false,
            latch: 'inconclusive',
            reason: 'Native bridge probe was inconclusive',
            code: null,
          };
        }
        return {
          nativeTerminal,
          latch: 'acknowledged',
          reason: null,
          code: null,
        };
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
    usernode: nativeLogout ? {
      isNative: true,
      logout() {
        events.push('native-best-effort-logout');
        if (nativeLogout === 'throw') {
          return Promise.reject(new Error('refused'));
        }
        if (nativeLogout === 'hang') return new Promise(() => {});
        return Promise.resolve(true);
      },
    } : undefined,
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
  if (withConfirm) {
    sandbox.PlatformUI.confirm = async (opts) => {
      events.push('confirm');
      assert.match(opts.title, /sign out without the app/i);
      assert.equal(opts.danger, true);
      return confirmResult;
    };
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(settingsSource, sandbox);
  sandbox.Settings._clearSwApiCache = async () => {
    events.push('sw-cache');
  };
  sandbox.Settings.NATIVE_SIGNOUT_BUDGET_MS = 20;
  return {
    sandbox, events, logoutButton, store,
    get href() { return href; },
  };
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
    assert.equal(loaded.href, '/');
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

// The dead end this replaced: a refused privileged bridge used to abort the
// whole sign-out before POST /api/auth/logout, so the web session survived
// and the user had no way out of the app at all.
test('a refused native latch confirms, then still clears the web session',
  async () => {
    const loaded = loadSettings({ prepare: 'unavailable' });

    await loaded.sandbox.Settings.logout();

    assert.deepEqual(loaded.events, [
      'prepare-native-latch',
      'confirm',
      'web-session',
      'sw-cache',
      'note-incomplete',
      'navigate',
    ]);
    assert.equal(loaded.href, '/');
  });

test('an inconclusive native probe takes the same confirmed fallback',
  async () => {
    const loaded = loadSettings({ prepare: 'inconclusive' });

    await loaded.sandbox.Settings.logout();

    assert.deepEqual(loaded.events, [
      'prepare-native-latch',
      'confirm',
      'web-session',
      'sw-cache',
      'note-incomplete',
      'navigate',
    ]);
  });

test('a rejecting preflight is treated as a refused latch, not a dead end',
  async () => {
    const loaded = loadSettings({ prepare: 'throw' });

    await loaded.sandbox.Settings.logout();

    assert.deepEqual(loaded.events, [
      'prepare-native-latch',
      'confirm',
      'web-session',
      'sw-cache',
      'note-incomplete',
      'navigate',
    ]);
  });

test('declining the confirm leaves the session and the button alone',
  async () => {
    const loaded = loadSettings({
      prepare: 'unavailable', confirmResult: false,
    });

    const result = await loaded.sandbox.Settings.logout();

    assert.equal(result, false);
    assert.deepEqual(loaded.events, ['prepare-native-latch', 'confirm']);
    assert.equal(loaded.logoutButton.disabled, false);
    assert.equal(loaded.href, 'https://social.example/#settings');
  });

test('no confirm dialog available still signs out rather than trapping the user',
  async () => {
    const loaded = loadSettings({ prepare: 'unavailable', withConfirm: false });

    await loaded.sandbox.Settings.logout();

    assert.deepEqual(loaded.events, [
      'prepare-native-latch',
      'web-session',
      'sw-cache',
      'note-incomplete',
      'navigate',
    ]);
  });

test('a best-effort native logout that succeeds suppresses the login notice',
  async () => {
    const loaded = loadSettings({
      prepare: 'unavailable', nativeLogout: 'ok',
    });

    await loaded.sandbox.Settings.logout();

    assert.deepEqual(loaded.events, [
      'prepare-native-latch',
      'confirm',
      'web-session',
      'sw-cache',
      'native-best-effort-logout',
      'navigate',
    ]);
    assert.equal(loaded.store.size, 0, 'nothing to warn about on login');
  });

test('a hung best-effort native logout cannot block leaving the app',
  async () => {
    const loaded = loadSettings({
      prepare: 'unavailable', nativeLogout: 'hang',
    });

    await loaded.sandbox.Settings.logout();

    assert.equal(loaded.href, '/');
    assert.equal(loaded.store.get('sv:native_signout_incomplete'), '1');
  });

test('a rejecting best-effort native logout is swallowed and noted',
  async () => {
    const loaded = loadSettings({
      prepare: 'unavailable', nativeLogout: 'throw',
    });

    await loaded.sandbox.Settings.logout();

    assert.equal(loaded.href, '/');
    assert.equal(loaded.store.get('sv:native_signout_incomplete'), '1');
  });

test('an acknowledged latch never asks and never notes anything', async () => {
  const loaded = loadSettings({ nativeTerminal: false, nativeLogout: 'ok' });

  await loaded.sandbox.Settings.logout();

  assert.deepEqual(loaded.events, [
    'prepare-native-latch',
    'web-session',
    'sw-cache',
    'navigate',
  ]);
  assert.equal(loaded.store.size, 0);
});

test('a legacy boolean preflight still drives the terminal native path',
  async () => {
    const loaded = loadSettings({ prepare: 'legacy', nativeTerminal: true });

    await loaded.sandbox.Settings.logout();

    assert.deepEqual(loaded.events, [
      'prepare-native-latch',
      'web-session',
      'sw-cache',
      'native-hard-logout',
    ]);
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
