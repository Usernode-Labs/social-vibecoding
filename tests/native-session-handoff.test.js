const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
const waitingTsx = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'auth', 'waiting.tsx'),
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
  return { ok, status, async json() { return data; } };
}

function ticket(attemptId) {
  return {
    protocol: 2,
    attemptId,
    desiredRuntime: 'running',
    ticket: `nst_${'B'.repeat(43)}`,
    requestDigest: 'a'.repeat(64),
    exchangeChallenge: 'C'.repeat(43),
    network: { id: 'testnet', chainId: 'utc1testnet' },
    issuedAt: '2026-08-26T12:00:00.000+00:00',
    expiresAt: '2026-08-26T12:05:00.000+00:00',
  };
}

function establishResult(payload, participantId) {
  return {
    protocol: 2,
    attemptId: payload.attemptId,
    nativeRevision: '9',
    identity: {
      participantId,
      accountId: `account-${participantId}`,
      address: `ut1-${participantId}`,
    },
    runtimeStatus: { state: 'running' },
    receiptStatus: 'committedReady',
  };
}

function loadNativeChrome({
  isNative = true,
  info = {
    version: 5,
    sessionLifecycleProtocol: 2,
    capabilities: ['establishNativeSession', 'logout'],
  },
  fetchImpl,
  establishImpl,
  sharedAttemptStorage,
} = {}) {
  const calls = {
    info: 0,
    fetch: [],
    establish: [],
    logout: 0,
    admission: [],
    events: [],
  };
  const windowListeners = {};
  const documentListeners = {};
  const storage = sharedAttemptStorage || new Map();
  const add = (target, type, listener) => {
    if (!target[type]) target[type] = [];
    target[type].push(listener);
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    crypto: crypto.webcrypto,
    btoa(value) { return Buffer.from(value, 'binary').toString('base64'); },
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    App: { user: null },
    localStorage: {
      getItem(key) {
        if (storage.has(key)) return storage.get(key);
        return key === 'sv:onboarding_permissions_done' ? '1' : null;
      },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    sessionStorage: {
      getItem() { throw new Error('native attempt must not use sessionStorage'); },
      setItem() { throw new Error('native attempt must not use sessionStorage'); },
      removeItem() { throw new Error('native attempt must not use sessionStorage'); },
    },
    WalletSheet: {
      _setSessionWalletAdmission(value) { calls.admission.push(value); },
    },
    document: {
      visibilityState: 'visible',
      getElementById() { return null; },
      createElement() { return {}; },
      addEventListener(type, listener) {
        add(documentListeners, type, listener);
      },
    },
    addEventListener(type, listener) { add(windowListeners, type, listener); },
    dispatchEvent(event) {
      calls.events.push(event.type);
      for (const listener of windowListeners[event.type] || []) listener(event);
    },
    setTimeout(fn, delay) {
      const handle = setTimeout(fn, delay);
      if (handle && typeof handle.unref === 'function') handle.unref();
      return handle;
    },
    clearTimeout,
  };
  sandbox.usernode = {
    isNative,
    async getBridgeInfo() {
      calls.info += 1;
      return info;
    },
    async establishNativeSession(payload) {
      calls.establish.push(payload);
      if (establishImpl) {
        return establishImpl(payload, calls.establish.length);
      }
      return establishResult(payload, sandbox.App.user.id.toString());
    },
    async logout() {
      calls.logout += 1;
      return true;
    },
  };
  sandbox.fetch = async (url, options) => {
    calls.fetch.push({ url, options });
    if (fetchImpl) return fetchImpl(url, options, calls.fetch.length);
    const request = JSON.parse(options.body);
    return response({ success: true, data: ticket(request.attemptId) });
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);

  return {
    sandbox,
    calls,
    storage,
    NativeChrome: sandbox.NativeChrome,
    dispatchWindow(type) {
      for (const listener of windowListeners[type] || []) listener({ type });
    },
    dispatchDocument(type) {
      for (const listener of documentListeners[type] || []) listener({ type });
    },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('protocol 2 sends one exact ticket-backed establishment transaction',
  async () => {
    const loaded = loadNativeChrome();
    loaded.NativeChrome.prepareIdentityPublication({ id: 41 });
    loaded.sandbox.App.user = { id: 41 };

    const result = await loaded.NativeChrome.establishCurrentSession();

    assert.equal(result.identity.participantId, '41');
    assert.equal(loaded.NativeChrome.isSessionAdmitted(), true);
    assert.equal(loaded.calls.fetch.length, 1);
    const request = JSON.parse(loaded.calls.fetch[0].options.body);
    assert.deepEqual(request, {
      protocol: 2,
      attemptId: request.attemptId,
      desiredRuntime: 'running',
    });
    assert.match(request.attemptId, /^nsa_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(JSON.parse(JSON.stringify(loaded.calls.establish[0])), {
      attemptId: request.attemptId,
      nativeEstablishTicket: ticket(request.attemptId),
      desiredRuntime: 'running',
    });
    assert.deepEqual(
      JSON.parse(loaded.storage.get(loaded.NativeChrome._ATTEMPT_STORAGE_KEY)),
      {
        protocol: 2,
        userId: '41',
        attemptId: request.attemptId,
        desiredRuntime: 'running',
      },
      'browser storage retains only the durable attempt, never ticket authority'
    );
  });

test('concurrent calls share one lease and a recreated WebView replays its attempt',
  async () => {
    const shared = new Map();
    const native = deferred();
    const loaded = loadNativeChrome({
      sharedAttemptStorage: shared,
      establishImpl: (payload, count) => count === 1
        ? native.promise
        : establishResult(payload, '41'),
    });
    loaded.NativeChrome.prepareIdentityPublication({ id: 41 });
    loaded.sandbox.App.user = { id: 41 };
    const first = loaded.NativeChrome.establishCurrentSession();
    const duplicate = loaded.NativeChrome.establishCurrentSession();
    await settle();
    assert.equal(loaded.calls.fetch.length, 1);
    assert.equal(loaded.calls.establish.length, 1);

    native.resolve(establishResult(loaded.calls.establish[0], '41'));
    assert.equal(await first, await duplicate);
    const attemptId = loaded.calls.establish[0].attemptId;

    const replacement = loadNativeChrome({ sharedAttemptStorage: shared });
    replacement.NativeChrome.prepareIdentityPublication({ id: 41 });
    replacement.sandbox.App.user = { id: 41 };
    await replacement.NativeChrome.recoverSessionAdmission();
    assert.equal(replacement.calls.fetch.length, 1,
      'the server, not web storage, replays the exact ticket');
    assert.equal(replacement.calls.establish[0].attemptId, attemptId);
    assert.equal(replacement.NativeChrome.isSessionAdmitted(), true);
  });

test('a terminal ticket drops only attempt metadata for a later fresh recovery',
  async () => {
    let expiredAttemptId = null;
    const loaded = loadNativeChrome({
      fetchImpl: (_url, options, count) => {
        const request = JSON.parse(options.body);
        if (count === 1) {
          expiredAttemptId = request.attemptId;
          return response({
            success: false,
            error: 'The native session ticket has expired.',
            code: 'native_session_ticket_expired',
          }, { ok: false, status: 410 });
        }
        return response({ success: true, data: ticket(request.attemptId) });
      },
    });
    loaded.NativeChrome.prepareIdentityPublication({ id: 41 });
    loaded.sandbox.App.user = { id: 41 };

    assert.equal(await loaded.NativeChrome.establishCurrentSession(), null);
    assert.equal(loaded.calls.fetch.length, 1,
      'the terminal failure does not create an internal retry loop');
    assert.equal(loaded.calls.establish.length, 0);
    assert.equal(loaded.storage.has(
      loaded.NativeChrome._ATTEMPT_STORAGE_KEY), false);

    const recovered = await loaded.NativeChrome.recoverSessionAdmission();
    assert.equal(recovered.identity.participantId, '41');
    assert.notEqual(loaded.calls.establish[0].attemptId, expiredAttemptId);
  });

test('logout is terminal despite a throwing UI sink and late publication',
  async () => {
    const loaded = loadNativeChrome();
    loaded.sandbox.WalletSheet._setSessionWalletAdmission = () => {
      throw new Error('broken UI sink');
    };
    loaded.NativeChrome.prepareIdentityPublication({ id: 41 });
    loaded.sandbox.App.user = { id: 41 };
    assert.ok(await loaded.NativeChrome.establishCurrentSession(),
      'a UI sink cannot abort successful core admission');
    assert.equal(loaded.NativeChrome.isSessionAdmitted(), true);

    const fetches = loaded.calls.fetch.length;
    const establishments = loaded.calls.establish.length;
    const preflight = loaded.NativeChrome.prepareWebLogout();
    assert.equal(loaded.NativeChrome.isSessionAdmitted(), false);
    assert.equal(loaded.storage.has(
      loaded.NativeChrome._ATTEMPT_STORAGE_KEY), false);
    assert.ok(loaded.calls.events.includes('sv:native-realm-close'),
      'the private bridge closes before the throwing UI notification');
    await preflight;

    loaded.NativeChrome.prepareIdentityPublication({ id: 42 });
    loaded.sandbox.App.user = { id: 42 };
    loaded.dispatchDocument('sv:session');
    await settle();
    assert.equal(await loaded.NativeChrome.recoverSessionAdmission(), null);
    assert.equal(loaded.calls.fetch.length, fetches);
    assert.equal(loaded.calls.establish.length, establishments);
    assert.equal(loaded.NativeChrome.isSessionAdmitted(), false);
  });

test('a late A result cannot admit or overwrite successor B', async () => {
  const a = deferred();
  const b = deferred();
  const loaded = loadNativeChrome({
    establishImpl: (_payload, count) => count === 1 ? a.promise : b.promise,
  });

  loaded.NativeChrome.prepareIdentityPublication({ id: 41 });
  loaded.sandbox.App.user = { id: 41 };
  const pendingA = loaded.NativeChrome.establishCurrentSession();
  await settle();

  loaded.NativeChrome.prepareIdentityPublication({ id: 42 });
  loaded.sandbox.App.user = { id: 42 };
  const pendingB = loaded.NativeChrome.establishCurrentSession();
  await settle();
  assert.notEqual(
    loaded.calls.establish[0].attemptId,
    loaded.calls.establish[1].attemptId
  );

  a.resolve(establishResult(loaded.calls.establish[0], '41'));
  assert.equal(await pendingA, null);
  assert.equal(loaded.NativeChrome.isSessionAdmitted(), false);

  b.resolve(establishResult(loaded.calls.establish[1], '42'));
  assert.equal((await pendingB).identity.participantId, '42');
  assert.equal(loaded.NativeChrome.isSessionAdmitted(), true);
});

test('semantic protocol absence is update-required with no legacy fallback',
  async () => {
    const loaded = loadNativeChrome({
      info: {
        version: 5,
        capabilities: ['legacyLifecycleCapability'],
      },
    });
    loaded.NativeChrome.prepareIdentityPublication({ id: 41 });
    loaded.sandbox.App.user = { id: 41 };

    assert.equal(await loaded.NativeChrome.establishCurrentSession(), null);
    assert.equal(loaded.NativeChrome.isSessionAdmitted(), false);
    assert.equal(loaded.NativeChrome.lastSessionFailure().stage,
      'update-required');
    assert.equal(loaded.calls.fetch.length, 0);
  });

test('App closes the realm synchronously before publishing either identity',
  async () => {
    const order = [];
    const anonymous = deferred();
    const sandbox = {
      console: { log() {}, warn() {}, error() {} },
      App: undefined,
      NativeChrome: {
        enterAnonymous() {
          order.push(`close-anonymous:${sandbox.App.user.id}`);
          return anonymous.promise;
        },
        prepareIdentityPublication(user) {
          order.push(`close-authed:${user.id}:${sandbox.App.user}`);
        },
      },
      AuthScreens: {
        enter() { order.push('show-anonymous'); },
        showWaiting() { order.push('show-waiting'); },
      },
      CustomEvent: class CustomEvent {
        constructor(type, init) { this.type = type; this.detail = init.detail; }
      },
      document: {
        visibilityState: 'visible',
        body: { classList: { add() {}, remove() {} } },
        getElementById() { return null; },
        addEventListener() {},
        dispatchEvent(event) {
          order.push(`publish:${event.type}:${sandbox.App.user.id}`);
        },
      },
      addEventListener() {},
      localStorage: {
        getItem() { return null; }, setItem() {}, removeItem() {},
      },
      navigator: {},
      location: { search: '', hash: '' },
      URLSearchParams,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(appSource, sandbox);
    sandbox.App.loadVersion = () => order.push('load-version');

    sandbox.App.user = { id: 40 };
    const entering = sandbox.App.enterAnonymous();
    assert.equal(sandbox.App.user, null,
      'null publication does not wait on native work');
    assert.deepEqual(order, ['close-anonymous:40']);
    anonymous.resolve(false);
    await entering;

    order.length = 0;
    sandbox.App.enterAuthed({ id: 41, hasPlatformAccess: false });
    assert.deepEqual(order.slice(0, 2), [
      'close-authed:41:null',
      'publish:sv:session:41',
    ]);
  });

test('waiting-session expiry delegates null publication to App.enterAnonymous',
  () => {
    const body = waitingTsx.slice(
      waitingTsx.indexOf('if (res.status === 401)'),
      waitingTsx.indexOf('const data = await res.json()')
    );
    assert.match(body, /await w\.App\.enterAnonymous\(\)/);
    assert.doesNotMatch(body, /w\.App\.user\s*=\s*null/);
    assert.ok(
      body.indexOf('await w.App.enterAnonymous()') <
      body.indexOf("location.hash = '#login'")
    );
  });
