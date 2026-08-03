const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const nativeChromeSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'native-chrome.js'),
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
  capabilities = [
    'completeLogin',
    'startNode',
    'logout',
    'sessionBoundAuthStatus',
  ],
  fetchImpl,
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
  };
  const windowListeners = {};
  const documentListeners = {};
  const usernode = {
    isNative: true,
    async getBridgeInfo() { return { version: 4, capabilities }; },
    async completeLogin(payload) {
      calls.completeLogin.push(payload);
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
    App: { user: initialUser },
    usernode,
    localStorage: { getItem() { return '1'; }, setItem() {} },
    document: {
      getElementById() { return null; },
      createElement() { return {}; },
      addEventListener(type, listener) { documentListeners[type] = listener; },
    },
    addEventListener(type, listener) { windowListeners[type] = listener; },
    setTimeout(fn, delay) {
      const timer = setTimeout(fn, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return timer;
    },
    clearTimeout,
    async fetch(url, options) {
      calls.fetch.push({ url, options });
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

test('every handoff exchanges the web session and starts the bound identity', async () => {
  const loaded = loadNativeChrome();
  loaded.sandbox.App.user = { id: 7 };

  const result = await loaded.NativeChrome.runLoginHandoff();

  assert.equal(result.participantId, 7);
  assert.equal(loaded.calls.fetch.length, 1);
  assert.equal(loaded.calls.fetch[0].url, '/api/v4/mobile/auth/from-session');
  assert.equal(loaded.calls.fetch[0].options.credentials, 'same-origin');
  assert.deepEqual(plain(loaded.calls.completeLogin), [
    { token: 'token-7', user: { id: 7 } },
  ]);
  assert.deepEqual(plain(loaded.calls.startNode), [
    { address: 'ut1-7', participantId: 7, epoch: 1 },
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

  const exchange = deferred();
  const loggingOut = loadNativeChrome({
    fetchImpl: async () => exchange.promise,
  });
  loggingOut.sandbox.App.user = { id: 5 };
  const active = loggingOut.NativeChrome.runLoginHandoff();
  await settle();
  await loggingOut.NativeChrome.handleWebLogout();
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

test('auth-status events and concurrent starts stay participant/epoch bound', async () => {
  const start = deferred();
  const loaded = loadNativeChrome({
    startNodeImpl: () => start.promise,
  });
  loaded.sandbox.App.user = { id: 6 };
  loaded.NativeChrome._handoffGeneration = 1;

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
