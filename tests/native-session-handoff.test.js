const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

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
const authSharedSource = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'auth', 'shared.ts'),
  'utf8'
);

function loadAuthShared(window, fetchImpl) {
  const compiled = ts.transpileModule(authSharedSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    window,
    fetch: fetchImpl,
    console: { warn() {} },
    require(specifier) {
      if (specifier === '../../lib/legacy-dom') {
        return { useIsomorphicLayoutEffect() {} };
      }
      throw new Error(`unexpected auth shared import: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(compiled, sandbox);
  return module.exports;
}

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
    capabilities: ['establishNativeSession', 'prepareForLogin', 'logout'],
  },
  fetchImpl,
  establishImpl,
  prepareForLoginImpl,
  sharedAttemptStorage,
} = {}) {
  const calls = {
    info: 0,
    fetch: [],
    establish: [],
    prepareForLogin: 0,
    logout: 0,
    admission: [],
    events: [],
    eventDetails: [],
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
      calls.eventDetails.push({ type: event.type, detail: event.detail });
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
    async prepareForLogin() {
      calls.prepareForLogin += 1;
      if (prepareForLoginImpl) return prepareForLoginImpl();
      return true;
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
    return response({
      success: true,
      data: {
        protocol: 2,
        attemptId: request.attemptId,
        desiredRuntime: 'running',
      },
    });
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

test('protocol 2 sends one exact native-only handoff transaction',
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
      'the server prepares a fresh native-only handoff for the exact attempt');
    assert.equal(replacement.calls.establish[0].attemptId, attemptId);
    assert.equal(replacement.NativeChrome.isSessionAdmitted(), true);
  });

test('a terminal native redemption drops only attempt metadata for a later fresh recovery',
  async () => {
    let expiredAttemptId = null;
    const loaded = loadNativeChrome({
      establishImpl: (payload, count) => {
        if (count === 1) {
          expiredAttemptId = payload.attemptId;
          const error = new Error('The native session ticket has expired.');
          error.usernodeCode = 'native_session_ticket_expired';
          return Promise.reject(error);
        }
        return establishResult(payload, '41');
      },
    });
    loaded.NativeChrome.prepareIdentityPublication({ id: 41 });
    loaded.sandbox.App.user = { id: 41 };

    assert.equal(await loaded.NativeChrome.establishCurrentSession(), null);
    assert.equal(loaded.calls.fetch.length, 1,
      'the terminal failure does not create an internal retry loop');
    assert.equal(loaded.calls.establish.length, 1);
    assert.equal(loaded.storage.has(
      loaded.NativeChrome._ATTEMPT_STORAGE_KEY), false);

    const recovered = await loaded.NativeChrome.recoverSessionAdmission();
    assert.equal(recovered.identity.participantId, '41');
    assert.notEqual(loaded.calls.establish[1].attemptId, expiredAttemptId);
  });

test('pool exhaustion offers legacy recovery and preserves the exact attempt for replay',
  async () => {
    let exhaustedAttemptId = null;
    const loaded = loadNativeChrome({
      establishImpl: (payload, count) => {
        if (count === 1) {
          exhaustedAttemptId = payload.attemptId;
          const error = new Error('No seeded wallet is available.');
          error.usernodeCode = 'native_session_wallet_pool_exhausted';
          return Promise.reject(error);
        }
        return establishResult(payload, '41');
      },
    });
    loaded.NativeChrome.prepareIdentityPublication({ id: 41 });
    loaded.sandbox.App.user = { id: 41 };

    assert.equal(await loaded.NativeChrome.establishCurrentSession(), null);
    assert.equal(loaded.NativeChrome.isSessionAdmitted(), false);
    assert.equal(loaded.NativeChrome.lastSessionFailure().code,
      'native_session_wallet_pool_exhausted');
    assert.equal(JSON.parse(loaded.storage.get(
      loaded.NativeChrome._ATTEMPT_STORAGE_KEY)).attemptId, exhaustedAttemptId,
    'pool exhaustion is recoverable, so the exact attempt must survive');

    const offers = loaded.calls.eventDetails.filter(
      (event) => event.type === 'usernode:wallet-recovery-required');
    assert.deepEqual(JSON.parse(JSON.stringify(offers)), [{
      type: 'usernode:wallet-recovery-required',
      detail: { userId: '41' },
    }]);

    const recovered = await loaded.NativeChrome.recoverSessionAdmission();
    assert.equal(recovered.identity.participantId, '41');
    assert.equal(loaded.calls.establish[1].attemptId, exhaustedAttemptId);
    assert.equal(loaded.NativeChrome.isSessionAdmitted(), true);
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

test('anonymous login preflight closes retained A before allowing B',
  async () => {
    const native = deferred();
    const loaded = loadNativeChrome({
      prepareForLoginImpl: () => native.promise,
    });
    loaded.NativeChrome.prepareIdentityPublication({ id: 41 });
    loaded.sandbox.App.user = { id: 41 };
    assert.ok(await loaded.NativeChrome.establishCurrentSession());

    loaded.sandbox.App.user = null;
    const first = loaded.NativeChrome.prepareForLogin();
    const duplicate = loaded.NativeChrome.prepareForLogin();
    assert.equal(loaded.NativeChrome.isSessionAdmitted(), false,
      'page admission closes before awaiting native drain');
    assert.equal(loaded.storage.has(
      loaded.NativeChrome._ATTEMPT_STORAGE_KEY), false);
    await settle();
    assert.equal(loaded.calls.prepareForLogin, 1,
      'concurrent credential submits share one terminal preflight');

    native.resolve(true);
    assert.equal(await first, true);
    assert.equal(await duplicate, true);

    loaded.NativeChrome.prepareIdentityPublication({ id: 42 });
    loaded.sandbox.App.user = { id: 42 };
    assert.equal(
      (await loaded.NativeChrome.establishCurrentSession()).identity.participantId,
      '42',
      'preflight does not permanently retire the web realm',
    );
  });

test('login preflight never preempts a live web session', async () => {
  const loaded = loadNativeChrome();
  loaded.sandbox.App.user = { id: 41 };

  await assert.rejects(
    loaded.NativeChrome.prepareForLogin(),
    /Sign out before signing in again/,
  );
  assert.equal(loaded.calls.prepareForLogin, 0);
});

test('session mint reports native preparation separately from network failure',
  async () => {
    let fetches = 0;
    const nativeFailure = new Error('The native credential could not be validated yet.');
    nativeFailure.usernodeCode = 'native_session_recovery_uncertain';
    const native = loadAuthShared({
      usernode: { isNative: true },
      NativeChrome: {
        async prepareForLogin() { throw nativeFailure; },
        lastSessionFailure() {
          return {
            stage: 'prepare-login',
            code: nativeFailure.usernodeCode,
            kind: null,
          };
        },
      },
    }, async () => {
      fetches += 1;
      throw new Error('fetch must not run');
    });

    const preparationError = await native.fetchSessionMint('/api/auth/login')
      .then(() => null, (error) => error);
    assert.equal(fetches, 0, 'native preparation still gates the session mint');
    assert.equal(
      native.sessionMintFailureMessage(preparationError),
      'Secure app session could not be prepared. Force-quit and reopen Usernode, ' +
        'then try again. Diagnostic: native_session_recovery_uncertain'
    );

    const web = loadAuthShared({ usernode: { isNative: false } }, async () => {
      throw new TypeError('Failed to fetch');
    });
    const networkError = await web.fetchSessionMint('/api/auth/login')
      .then(() => null, (error) => error);
    assert.equal(web.sessionMintFailureMessage(networkError), 'Network error');
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
    assert.equal(
      loaded.NativeChrome.prepareWebLogout().nativeTerminal,
      true,
    );
    await assert.rejects(
      loaded.NativeChrome.commitNativeLogout(),
      /must be updated for secure sign-out/,
    );
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
