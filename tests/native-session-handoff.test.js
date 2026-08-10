const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const nativeChromeSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'native-chrome.js'),
  'utf8'
);
const appSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app.js'),
  'utf8'
);
const authScreensSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'auth-screens.js'),
  'utf8'
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() { return data; },
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadNativeChrome({
  initialUser = null,
  bridgeVersion = 4,
  capabilities = [
    'completeLogin',
    'startNode',
    'logout',
    'beginSessionHandoff',
    'enterAnonymousSession',
    'sessionBoundAuthStatus',
  ],
  getBridgeInfoImpl,
  fetchImpl,
  beginSessionHandoffImpl,
  enterAnonymousSessionImpl,
  completeLoginImpl,
  startNodeImpl,
  logoutImpl,
} = {}) {
  const calls = {
    fetch: [],
    completeLogin: [],
    startNode: [],
    logout: 0,
    stopNode: 0,
    beginSessionHandoff: 0,
    enterAnonymousSession: 0,
    walletRelayAdmission: [],
    events: [],
    order: [],
  };
  const windowListeners = {};
  const documentListeners = {};
  const usernode = {
    isNative: true,
    _setSessionWalletRelayAdmission(admitted) {
      calls.walletRelayAdmission.push(admitted === true);
      return admitted === true;
    },
    async getBridgeInfo() {
      return getBridgeInfoImpl
        ? getBridgeInfoImpl()
        : { version: bridgeVersion, capabilities };
    },
    async beginSessionHandoff() {
      calls.beginSessionHandoff += 1;
      calls.order.push('begin-session-handoff');
      return beginSessionHandoffImpl
        ? beginSessionHandoffImpl()
        : { blocked: true };
    },
    async enterAnonymousSession() {
      calls.enterAnonymousSession += 1;
      calls.order.push('enter-anonymous-session');
      return enterAnonymousSessionImpl
        ? enterAnonymousSessionImpl()
        : { admitted: true };
    },
    async completeLogin(payload) {
      calls.completeLogin.push(payload);
      calls.order.push('complete-login');
      if (completeLoginImpl) return completeLoginImpl(payload);
      return {
        phase: 'ready',
        address: `ut1-${payload.user.id}`,
        participantId: payload.user.id,
        epoch: 1,
      };
    },
    async startNode(payload) {
      calls.startNode.push(payload);
      return startNodeImpl ? startNodeImpl(payload) : { started: true };
    },
    async logout() {
      calls.logout += 1;
      return logoutImpl ? logoutImpl() : true;
    },
    async stopNode() {
      calls.stopNode += 1;
      return { stopped: true };
    },
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    App: { user: initialUser },
    usernode,
    localStorage: { getItem() { return '1'; }, setItem() {} },
    document: {
      visibilityState: 'visible',
      getElementById() { return null; },
      createElement() { return {}; },
      addEventListener(type, listener) { documentListeners[type] = listener; },
    },
    addEventListener(type, listener) { windowListeners[type] = listener; },
    dispatchEvent(event) {
      calls.events.push(event.type);
      if (windowListeners[event.type]) windowListeners[event.type](event);
    },
    setTimeout(fn, delay) {
      const timer = setTimeout(fn, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return timer;
    },
    clearTimeout,
    async fetch(url, options) {
      calls.fetch.push({ url, options });
      calls.order.push('from-session');
      if (fetchImpl) return fetchImpl(url, options, calls.fetch.length);
      const id = sandbox.App.user.id;
      return response({ success: true, token: `token-${id}`, user: { id } });
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);
  return {
    sandbox,
    calls,
    NativeChrome: sandbox.NativeChrome,
    dispatchWindow(type, detail) {
      if (windowListeners[type]) windowListeners[type]({ detail });
    },
    dispatchDocument(type) {
      if (documentListeners[type]) documentListeners[type]();
    },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('anonymous auth screens wait for native wallet admission', async () => {
  const admission = deferred();
  const order = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    NativeChrome: {
      enterAnonymous() {
        order.push('native-admission');
        return admission.promise;
      },
    },
    AuthScreens: {
      enter() {
        order.push('auth-screens');
        // Login routing synchronously starts the one-shot wallet probe.
        order.push('wallet-detect');
      },
    },
    document: { addEventListener() {} },
    location: { search: '', hash: '' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appSource, sandbox);
  sandbox.App.loadVersion = () => order.push('load-version');

  const entering = sandbox.App.enterAnonymous();
  await settle();
  assert.deepEqual(order, ['native-admission']);

  admission.resolve(true);
  await entering;
  assert.deepEqual(order, [
    'native-admission',
    'load-version',
    'auth-screens',
    'wallet-detect',
  ]);
});

test('waiting-session expiry admits anonymous native state before login',
  async () => {
    const order = [];
    let intervalActive = false;
    const location = {};
    Object.defineProperty(location, 'hash', {
      get() { return '#waiting'; },
      set(value) {
        order.push(`navigate:${value}`);
      },
    });
    const sandbox = {
      console: { log() {}, warn() {}, error() {} },
      App: {
        user: { id: 7 },
        async enterAnonymous() {
          assert.equal(this.user, null);
          order.push('anonymous-admission');
        },
      },
      document: {
        addEventListener() {},
        getElementById() { return { textContent: '' }; },
      },
      location,
      async fetch() {
        order.push('waiting-session-check');
        return { status: 401 };
      },
      setInterval() {
        intervalActive = true;
        return 1;
      },
      clearInterval() { intervalActive = false; },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(authScreensSource, sandbox);

    sandbox.AuthScreens._startWaitingPoll();
    await settle();

    assert.deepEqual(order, [
      'waiting-session-check',
      'anonymous-admission',
      'navigate:#login',
    ]);
    assert.equal(intervalActive, false);
  });

test('anonymous entry opens local admission only after native acknowledgement',
  async () => {
    const admission = deferred();
    const loaded = loadNativeChrome({
      enterAnonymousSessionImpl: () => admission.promise,
    });

    assert.deepEqual(loaded.calls.walletRelayAdmission, [false]);
    const entering = loaded.NativeChrome.enterAnonymous();
    await settle();
    assert.equal(loaded.calls.enterAnonymousSession, 1);
    assert.equal(loaded.calls.walletRelayAdmission.at(-1), false);

    admission.resolve({ admitted: true });
    assert.equal(await entering, true);
    assert.equal(loaded.calls.walletRelayAdmission.at(-1), true);
  });

test('failed anonymous native admission stays closed', async () => {
  const loaded = loadNativeChrome({
    enterAnonymousSessionImpl: async () => { throw new Error('not admitted'); },
  });

  assert.equal(await loaded.NativeChrome.enterAnonymous(), false);
  assert.equal(loaded.calls.walletRelayAdmission.at(-1), false);
});

test('page-finished auth status retries closed anonymous admission', async () => {
  const loaded = loadNativeChrome();

  loaded.dispatchWindow('usernode:auth-status', {
    phase: 'unauthenticated', address: null, participantId: null, epoch: 0,
  });
  await settle();

  assert.equal(loaded.calls.enterAnonymousSession, 1);
  assert.equal(loaded.NativeChrome._sessionWalletRelayAdmitted, true);
});

test('a newer login handoff prevents stale anonymous native admission',
  async () => {
    const info = deferred();
    const loaded = loadNativeChrome({
      getBridgeInfoImpl: () => info.promise,
    });

    const enteringAnonymous = loaded.NativeChrome.enterAnonymous();
    loaded.sandbox.App.user = { id: 12 };
    const loggingIn = loaded.NativeChrome.runLoginHandoff();
    info.resolve({
      version: 4,
      capabilities: [
        'completeLogin',
        'startNode',
        'beginSessionHandoff',
        'enterAnonymousSession',
        'sessionBoundAuthStatus',
      ],
    });

    assert.equal(await enteringAnonymous, false);
    await loggingIn;
    assert.equal(loaded.calls.enterAnonymousSession, 0,
      'stale anonymous work must not reopen native after login begins');
    assert.equal(loaded.calls.beginSessionHandoff, 1);
    assert.equal(loaded.calls.walletRelayAdmission.at(-1), true,
      'only the verified participant handoff reopens local admission');
  });

test('pre-v4 anonymous entry preserves local wallet compatibility', async () => {
  const loaded = loadNativeChrome({
    bridgeVersion: 3,
    capabilities: ['getWalletState'],
  });

  assert.equal(await loaded.NativeChrome.enterAnonymous(), true);
  assert.equal(loaded.calls.enterAnonymousSession, 0);
  assert.equal(loaded.calls.walletRelayAdmission.at(-1), true);
});

test('every handoff exchanges the web session and starts the bound identity', async () => {
  const loaded = loadNativeChrome();
  loaded.sandbox.App.user = { id: 7 };

  const result = await loaded.NativeChrome.runLoginHandoff();

  assert.equal(result.participantId, 7);
  assert.equal(loaded.calls.fetch.length, 1);
  assert.equal(loaded.calls.beginSessionHandoff, 1);
  assert.deepEqual(loaded.calls.order.slice(0, 3), [
    'begin-session-handoff', 'from-session', 'complete-login',
  ]);
  assert.equal(loaded.calls.fetch[0].url, '/api/v4/mobile/auth/from-session');
  assert.equal(loaded.calls.fetch[0].options.credentials, 'same-origin');
  assert.deepEqual(plain(loaded.calls.completeLogin), [
    { token: 'token-7', user: { id: 7 } },
  ]);
  assert.deepEqual(plain(loaded.calls.startNode), [
    { address: 'ut1-7', participantId: 7, epoch: 1 },
  ]);
  assert.deepEqual(loaded.calls.events, [
    'usernode:native-session-admission',
    'usernode:native-session-admission',
  ]);

  await loaded.NativeChrome.runLoginHandoff();
  assert.equal(loaded.calls.fetch.length, 2,
    'native ready state must not bypass a same-user token refresh');
  assert.equal(loaded.calls.completeLogin.length, 2);
  assert.equal(loaded.calls.startNode.length, 1,
    'the already-started participant/epoch remains coalesced');
});

test('a mismatched from-session participant is never handed to native', async () => {
  const loaded = loadNativeChrome({
    fetchImpl: async () => response({
      success: true,
      token: 'token-8',
      user: { id: 8 },
    }),
  });
  loaded.sandbox.App.user = { id: 7 };

  await loaded.NativeChrome.runLoginHandoff();

  assert.equal(loaded.calls.completeLogin.length, 0);
  assert.equal(loaded.calls.startNode.length, 0);
});

test('native handoff-latch failure stops before the session exchange',
  async () => {
    const loaded = loadNativeChrome({
      beginSessionHandoffImpl: async () => { throw new Error('latch failed'); },
    });
    loaded.sandbox.App.user = { id: 7 };

    await loaded.NativeChrome.runLoginHandoff();

    assert.equal(loaded.calls.beginSessionHandoff, 1);
    assert.equal(loaded.calls.fetch.length, 0);
    assert.equal(loaded.calls.walletRelayAdmission.at(-1), false);
  });

test('online recovery retries a closed authenticated handoff', async () => {
  let attempts = 0;
  const loaded = loadNativeChrome({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return response({ success: false, error: 'temporarily unavailable' }, {
          ok: false,
          status: 503,
        });
      }
      return response({ success: true, token: 'token-7', user: { id: 7 } });
    },
  });
  loaded.sandbox.App.user = { id: 7 };

  await loaded.NativeChrome.runLoginHandoff();
  assert.equal(loaded.NativeChrome.isSessionAdmitted(), false);

  loaded.dispatchWindow('online');
  await loaded.NativeChrome._handoffPromise;

  assert.equal(loaded.calls.fetch.length, 2);
  assert.equal(loaded.NativeChrome.isSessionAdmitted(), true);
});

test('foreground recovery ignores hidden and already-admitted pages',
  async () => {
    const loaded = loadNativeChrome();
    loaded.sandbox.App.user = { id: 8 };
    loaded.sandbox.document.visibilityState = 'hidden';

    loaded.dispatchDocument('visibilitychange');
    await settle();
    assert.equal(loaded.calls.fetch.length, 0);

    loaded.sandbox.document.visibilityState = 'visible';
    loaded.dispatchDocument('visibilitychange');
    await loaded.NativeChrome._handoffPromise;
    assert.equal(loaded.calls.fetch.length, 1);
    assert.equal(loaded.NativeChrome.isSessionAdmitted(), true);

    loaded.dispatchDocument('visibilitychange');
    await settle();
    assert.equal(loaded.calls.fetch.length, 1,
      'an admitted page does not exchange its session again');
  });

test('an overlapping A to B login reruns once for the latest web session', async () => {
  const firstFetch = deferred();
  const loaded = loadNativeChrome({
    fetchImpl: async (_url, _options, callNumber) => {
      if (callNumber === 1) return firstFetch.promise;
      return response({ success: true, token: 'token-B', user: { id: 2 } });
    },
  });
  loaded.sandbox.App.user = { id: 1 };
  const active = loaded.NativeChrome.runLoginHandoff();

  loaded.sandbox.App.user = { id: 2 };
  const overlapping = loaded.NativeChrome.runLoginHandoff();
  assert.equal(active, overlapping, 'overlapping signals share one run');
  firstFetch.resolve(response({
    success: true,
    token: 'token-A',
    user: { id: 1 },
  }));

  const result = await active;

  assert.equal(result.participantId, 2);
  assert.equal(loaded.calls.fetch.length, 2);
  assert.deepEqual(
    loaded.calls.completeLogin.map((call) => call.token),
    ['token-B']
  );
  assert.deepEqual(plain(loaded.calls.startNode), [
    { address: 'ut1-2', participantId: 2, epoch: 1 },
  ]);
});

test('a boot session still observes later SPA account changes', async () => {
  const loaded = loadNativeChrome({ initialUser: { id: 1 } });
  await loaded.NativeChrome._handoffPromise;

  loaded.sandbox.App.user = { id: 2 };
  loaded.dispatchDocument('sv:session');
  await loaded.NativeChrome._handoffPromise;

  assert.deepEqual(
    loaded.calls.completeLogin.map((call) => call.token),
    ['token-1', 'token-2']
  );
});

test('A to B closes wallet admission synchronously and keeps old document closed',
  async () => {
    const replacement = deferred();
    const loaded = loadNativeChrome({
      initialUser: { id: 1 },
      completeLoginImpl: async (payload) => {
        if (payload.user.id === 2) return replacement.promise;
        return {
          phase: 'ready', address: 'ut1-1', participantId: 1, epoch: 1,
        };
      },
    });
    await loaded.NativeChrome._handoffPromise;
    assert.equal(loaded.calls.walletRelayAdmission.at(-1), true,
      'verified A handoff admits its wallet');

    loaded.sandbox.App.user = { id: 2 };
    loaded.dispatchDocument('sv:session');
    assert.equal(loaded.calls.walletRelayAdmission.at(-1), false,
      'the session event closes admission before any async exchange step');

    await settle();
    assert.equal(loaded.calls.beginSessionHandoff, 2,
      'the paired native latch closes before B reaches completeLogin');
    replacement.resolve({ restarting: true });
    await loaded.NativeChrome._handoffPromise;
    assert.equal(loaded.calls.walletRelayAdmission.at(-1), false,
      'a replacement makes the old document terminal; it never re-admits A');
  });

test('stale native completion and restart responses cannot start a node', async () => {
  const completion = deferred();
  const loaded = loadNativeChrome({
    completeLoginImpl: () => completion.promise,
  });
  loaded.sandbox.App.user = { id: 1 };
  const active = loaded.NativeChrome.runLoginHandoff();
  await settle();

  loaded.sandbox.App.user = { id: 2 };
  completion.resolve({
    phase: 'ready', address: 'ut1-1', participantId: 1, epoch: 1,
  });
  await active;
  assert.equal(loaded.calls.startNode.length, 0);

  const restartCompletion = deferred();
  const restarting = loadNativeChrome({
    completeLoginImpl: () => restartCompletion.promise,
  });
  restarting.sandbox.App.user = { id: 3 };
  const activeRestart = restarting.NativeChrome.runLoginHandoff();
  await settle();
  restarting.sandbox.App.user = { id: 4 };
  const pendingSession = restarting.NativeChrome.runLoginHandoff();
  assert.equal(activeRestart, pendingSession);
  restartCompletion.resolve({ restarting: true });
  const result = await activeRestart;
  assert.equal(result.restarting, true);
  assert.equal(restarting.calls.fetch.length, 1,
    'restart is terminal even when a newer session signal is queued');
  assert.equal(restarting.calls.completeLogin.length, 1);
  assert.equal(restarting.calls.startNode.length, 0);
});

test('native failures do not start and logout invalidates an active handoff', async () => {
  const rejected = loadNativeChrome({
    completeLoginImpl: async () => { throw new Error('native 401'); },
  });
  rejected.sandbox.App.user = { id: 4 };
  await rejected.NativeChrome.runLoginHandoff();
  assert.equal(rejected.calls.startNode.length, 0);
  assert.equal(rejected.calls.walletRelayAdmission.at(-1), false,
    'failed handoffs remain fail-closed');

  const exchange = deferred();
  const loggingOut = loadNativeChrome({
    fetchImpl: async () => exchange.promise,
  });
  loggingOut.sandbox.App.user = { id: 5 };
  const active = loggingOut.NativeChrome.runLoginHandoff();
  await settle();
  assert.equal(await loggingOut.NativeChrome.prepareWebLogout(), true);
  assert.equal(loggingOut.calls.logout, 0,
    'preflight closes admission without tearing down the WebView');
  assert.equal(await loggingOut.NativeChrome.commitNativeLogout(), true);
  exchange.resolve(response({
    success: true, token: 'stale-token', user: { id: 5 },
  }));
  await active;

  assert.equal(loggingOut.calls.logout, 1);
  assert.equal(loggingOut.calls.stopNode, 0,
    'hard native logout owns node drain and cleanup');
  assert.equal(loggingOut.calls.completeLogin.length, 0);
  assert.equal(loggingOut.calls.startNode.length, 0);
});

test('inconclusive native logout probe is discarded so retry re-probes',
  async () => {
    let probes = 0;
    const loaded = loadNativeChrome({
      getBridgeInfoImpl: async () => {
        probes += 1;
        return probes === 1
          ? { version: 0, capabilities: [] }
          : { version: 4, capabilities: ['logout'] };
      },
    });

    await assert.rejects(
      loaded.NativeChrome.prepareWebLogout(),
      /bridge probe was inconclusive/i
    );
    assert.equal(loaded.NativeChrome._infoPromise, null);

    assert.equal(await loaded.NativeChrome.prepareWebLogout(), true);
    assert.equal(probes, 2);
  });

test('non-ready auth event recovers closed admission through login handoff',
  async () => {
    const exchange = deferred();
    const loaded = loadNativeChrome({
      fetchImpl: () => exchange.promise,
    });
    loaded.sandbox.App.user = { id: 6 };
    assert.equal(loaded.NativeChrome._sessionWalletRelayAdmitted, false);

    loaded.dispatchWindow('usernode:auth-status', {
      phase: 'transitioning', address: null, participantId: 5, epoch: 9,
    });
    await settle();

    assert.equal(loaded.calls.fetch.length, 1);
    assert.equal(loaded.calls.startNode.length, 0,
      'the event alone cannot start/admit while the local gate is closed');
    exchange.resolve(response({
      success: true, token: 'token-6', user: { id: 6 },
    }));
    await loaded.NativeChrome._handoffPromise;

    assert.deepEqual(plain(loaded.calls.startNode), [{
      address: 'ut1-6', participantId: 6, epoch: 1,
    }]);
    assert.equal(loaded.NativeChrome._sessionWalletRelayAdmitted, true);
  });

test('auth-status events and concurrent starts stay participant/epoch bound', async () => {
  const start = deferred();
  const loaded = loadNativeChrome({
    startNodeImpl: () => start.promise,
  });
  loaded.sandbox.App.user = { id: 6 };
  loaded.NativeChrome._handoffGeneration = 1;
  loaded.NativeChrome._setSessionWalletRelayAdmission(true);

  loaded.dispatchWindow('usernode:auth-status', {
    phase: 'ready', address: 'ut1-wrong', participantId: 7, epoch: 1,
  });
  await settle();
  assert.equal(loaded.calls.startNode.length, 0);

  const status = {
    address: 'ut1-6', participantId: 6, epoch: 3,
  };
  const first = loaded.NativeChrome._ensureNodeStarted(status, 1);
  const second = loaded.NativeChrome._ensureNodeStarted(status, 1);
  await settle();
  assert.equal(loaded.calls.startNode.length, 1);
  start.resolve({ started: true });
  assert.equal(await first, true);
  assert.equal(await second, true);
});

test('old app builds retain the address-only node-start fallback', async () => {
  const loaded = loadNativeChrome({
    capabilities: ['completeLogin', 'startNode', 'logout'],
    completeLoginImpl: async () => ({ phase: 'ready', address: 'ut1-legacy' }),
  });
  loaded.sandbox.App.user = { id: 9 };

  await loaded.NativeChrome.runLoginHandoff();

  assert.deepEqual(plain(loaded.calls.startNode), [{ address: 'ut1-legacy' }]);
});

test('pre-v4 app builds reopen wallet admission after capability probing',
  async () => {
    const loaded = loadNativeChrome({
      bridgeVersion: 3,
      capabilities: ['getWalletState'],
    });
    loaded.sandbox.App.user = { id: 10 };

    await loaded.NativeChrome.runLoginHandoff();

    assert.equal(loaded.calls.fetch.length, 0);
    assert.deepEqual(loaded.calls.walletRelayAdmission, [false, false, true]);
  });

test('an inconclusive bridge probe keeps wallet admission fail-closed',
  async () => {
    const loaded = loadNativeChrome({ bridgeVersion: 0, capabilities: [] });
    loaded.sandbox.App.user = { id: 11 };

    await loaded.NativeChrome.runLoginHandoff();

    assert.equal(loaded.calls.fetch.length, 0);
    assert.equal(loaded.calls.walletRelayAdmission.at(-1), false);
  });
