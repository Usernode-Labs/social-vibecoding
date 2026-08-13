const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'social-push.js'),
  'utf8'
);
const notificationsSource = fs.readFileSync(
  // #1079 chunk B: same module, now inside the React bundle.
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications.js'),
  'utf8'
);
const settingsSource = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'settings', 'settings.js'),
  'utf8'
);

const capabilities = [
  'getSocialPushState',
  'setSocialPushEnabled',
  'claimPendingSocialNotification',
  'ackPendingSocialNotification',
];

function loadCoordinator({
  claims = [],
  openResult = true,
  openImpl,
  ackImpl,
  getStateImpl,
  isSessionAdmittedImpl,
  caps = capabilities,
  bridgeReadyImpl,
  getInfoImpl,
  refreshImpl,
  invalidationRefreshVersion = 1,
  foregroundStorage = new Map(),
  foregroundStorageImpl,
  includeBridgeReadyMethod = true,
  timeoutScale = 1,
} = {}) {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const calls = [];
  const state = {
    enabled: true,
    permissionStatus: 'authorized',
    registrationStatus: 'registered',
    deliveryActive: true,
  };
  const sandbox = {
    console: { warn() {} },
    Promise,
    localStorage: foregroundStorageImpl || {
      getItem(key) {
        return foregroundStorage.has(key) ? foregroundStorage.get(key) : null;
      },
      setItem(key, value) { foregroundStorage.set(key, String(value)); },
      removeItem(key) { foregroundStorage.delete(key); },
    },
    setTimeout(fn, delay) { return setTimeout(fn, delay * timeoutScale); },
    clearTimeout,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    App: { user: { id: 7 } },
    NativeChrome: {
      async getInfo() {
        return getInfoImpl
          ? getInfoImpl()
          : { version: 4, capabilities: caps };
      },
      isSessionAdmitted() {
        return isSessionAdmittedImpl ? isSessionAdmittedImpl() : true;
      },
    },
    Notifications: {
      ...(invalidationRefreshVersion == null
        ? {}
        : { nativeInvalidationRefreshVersion: invalidationRefreshVersion }),
      async openById(id) {
        calls.push(['open', id]);
        return openImpl ? openImpl(id) : openResult;
      },
      async refreshAfterInvalidation() {
        calls.push(['refresh']);
        return refreshImpl ? refreshImpl() : true;
      },
    },
    DevAlerts: {
      setRemoteDeliveryActive(active) { calls.push(['remote', active]); },
    },
    usernode: {
      isNative: true,
      async getSocialPushState() {
        calls.push(['state']);
        return getStateImpl ? getStateImpl() : state;
      },
      async setSocialPushEnabled(enabled) {
        calls.push(['enable', enabled]);
        return { ...state, enabled };
      },
      async claimPendingSocialNotification() {
        calls.push(['claim']);
        return claims.length ? claims.shift() : null;
      },
      async ackPendingSocialNotification(id) {
        calls.push(['ack', id]);
        return ackImpl ? ackImpl(id) : true;
      },
    },
    addEventListener(type, listener) {
      const list = windowListeners.get(type) || [];
      list.push(listener);
      windowListeners.set(type, list);
    },
    dispatchEvent(event) {
      for (const listener of windowListeners.get(event.type) || []) listener(event);
    },
    document: {
      addEventListener(type, listener) {
        const list = documentListeners.get(type) || [];
        list.push(listener);
        documentListeners.set(type, list);
      },
    },
  };
  if (includeBridgeReadyMethod) {
    sandbox.usernode.markPrivilegedBridgeReady = async () => {
      calls.push(['bridge-ready']);
      return bridgeReadyImpl ? bridgeReadyImpl() : { ready: true };
    };
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    sandbox,
    calls,
    fire(type, detail) {
      for (const listener of windowListeners.get(type) || []) {
        listener({ type, detail });
      }
    },
    fireDocument(type) {
      for (const listener of documentListeners.get(type) || []) {
        listener({ type });
      }
    },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('realm readiness waits for deferred shell listeners', async () => {
  const loaded = loadCoordinator();

  assert.equal(loaded.sandbox.__usernodeExplicitReadinessClient, true);

  await settle();
  assert.equal(
    loaded.calls.some(([name]) => name === 'bridge-ready'),
    false,
    'the parser-time script must not request replay before React hydrates'
  );

  loaded.fireDocument('DOMContentLoaded');
  await settle();
  assert.equal(
    loaded.calls.filter(([name]) => name === 'bridge-ready').length,
    1
  );
});

test('current coordinator does not claim readiness with an older bridge',
  async () => {
    const loaded = loadCoordinator({ includeBridgeReadyMethod: false });

    assert.equal(loaded.sandbox.__usernodeExplicitReadinessClient, false);
    loaded.fireDocument('DOMContentLoaded');
    await settle();
    assert.equal(
      loaded.calls.some(([name]) => name === 'bridge-ready'),
      false
    );
  });

test('transient support probes retry instead of disabling Social push',
  async () => {
    let probes = 0;
    const loaded = loadCoordinator({
      getInfoImpl() {
        probes += 1;
        return probes === 1
          ? { version: 0, capabilities: [], degraded: true }
          : { version: 4, capabilities };
      },
    });

    assert.equal(await loaded.sandbox.SocialPush.isSupported(), false);
    await settle();
    assert.equal(await loaded.sandbox.SocialPush.isSupported(), true);
    assert.equal(probes, 2);
  });

test('BFCache restore rebinds readiness without duplicate in-flight calls',
  async () => {
    let resolveFirst;
    const firstReady = new Promise((resolve) => { resolveFirst = resolve; });
    let attempts = 0;
    const loaded = loadCoordinator({
      bridgeReadyImpl() {
        attempts += 1;
        return attempts === 1 ? firstReady : { ready: true };
      },
    });

    loaded.fireDocument('DOMContentLoaded');
    loaded.fire('pageshow');
    await settle();
    assert.equal(attempts, 1, 'pageshow must share the active handshake');
    resolveFirst({ ready: true });
    await settle();

    loaded.fire('pagehide');
    loaded.fire('pageshow');
    await settle();
    assert.equal(attempts, 2, 'the restored realm must rebind native readiness');
  });

test('pending id is opened through Notifications before native acknowledgement', async () => {
  const loaded = loadCoordinator({ claims: [{ notificationId: 42 }] });

  await loaded.sandbox.SocialPush.init();

  assert.deepEqual(
    loaded.calls.filter(([name]) => ['claim', 'open', 'ack'].includes(name)),
    [['claim'], ['open', 42], ['ack', 42]]
  );
  assert.ok(loaded.calls.some(([name, active]) =>
    name === 'remote' && active === true));
});

test('failed or malformed notification opens are never acknowledged', async () => {
  const failed = loadCoordinator({
    claims: [{ notificationId: 43 }],
    openResult: false,
  });
  await failed.sandbox.SocialPush.init();
  assert.equal(failed.calls.some(([name]) => name === 'ack'), false);

  const malformed = loadCoordinator({ claims: [{ notificationId: '43' }] });
  await malformed.sandbox.SocialPush.init();
  assert.equal(malformed.calls.some(([name]) => name === 'open'), false);
  assert.equal(malformed.calls.some(([name]) => name === 'ack'), false);
});

test('a retained tap retries when connectivity returns', async () => {
  let openAttempts = 0;
  const loaded = loadCoordinator({
    claims: [{ notificationId: 43 }, { notificationId: 43 }],
    openImpl() {
      openAttempts += 1;
      return openAttempts > 1;
    },
  });

  await loaded.sandbox.SocialPush.init();
  loaded.fire('online');
  await settle();

  assert.deepEqual(
    loaded.calls.filter(([name]) => ['claim', 'open', 'ack'].includes(name)),
    [
      ['claim'], ['open', 43],
      ['claim'], ['open', 43], ['ack', 43],
    ]
  );
});

test('foreground event refreshes authenticated notifications without content', async () => {
  const loaded = loadCoordinator();
  await loaded.sandbox.SocialPush.init();
  loaded.calls.length = 0;

  loaded.fire('usernode:social-push-foreground');
  await settle();

  assert.deepEqual(loaded.calls, [['refresh']]);
});

test('failed foreground refresh remains dirty and retries online', async () => {
  let attempts = 0;
  const loaded = loadCoordinator({
    refreshImpl() {
      attempts += 1;
      return attempts > 1;
    },
  });
  await loaded.sandbox.SocialPush.init();
  loaded.calls.length = 0;

  loaded.fire('usernode:social-push-foreground');
  await settle();
  assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, true);

  loaded.fire('online');
  await settle();
  assert.equal(attempts, 2);
  assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, false);
  assert.equal(
    loaded.calls.filter(([name]) => name === 'refresh').length,
    2
  );
});

test('a foreground invalidation arriving during refresh gets a trailing fetch',
  async () => {
    let releaseFirst;
    const first = new Promise((resolve) => { releaseFirst = resolve; });
    let attempts = 0;
    const loaded = loadCoordinator({
      refreshImpl() {
        attempts += 1;
        return attempts === 1 ? first : true;
      },
    });
    await loaded.sandbox.SocialPush.init();
    loaded.calls.length = 0;

    loaded.fire('usernode:social-push-foreground');
    await settle();
    loaded.fire('usernode:social-push-foreground');
    releaseFirst(true);
    await settle();

    assert.ok(attempts >= 2);
    assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, false);
  });

test('failed foreground refresh retries while the page stays active',
  async () => {
    let attempts = 0;
    const loaded = loadCoordinator({
      timeoutScale: 0.001,
      refreshImpl() {
        attempts += 1;
        return attempts > 1;
      },
    });
    await loaded.sandbox.SocialPush.init();

    loaded.fire('usernode:social-push-foreground');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();

    assert.equal(attempts, 2);
    assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, false);
  });

test('foreground invalidation does not depend on a native capability probe',
  async () => {
    let probes = 0;
    const loaded = loadCoordinator({
      getInfoImpl() {
        probes += 1;
        return { version: 0, capabilities: [], degraded: true };
      },
    });

    loaded.fire('usernode:social-push-foreground');
    await settle();

    assert.equal(probes, 0);
    assert.equal(
      loaded.calls.filter(([name]) => name === 'refresh').length,
      1
    );
    assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, false);
  });

test('an older cached Notifications bundle cannot consume an invalidation',
  async () => {
    const storage = new Map();
    const loaded = loadCoordinator({
      invalidationRefreshVersion: null,
      foregroundStorage: storage,
    });

    loaded.fire('usernode:social-push-foreground');
    await settle();

    assert.equal(
      loaded.calls.some(([name]) => name === 'refresh'),
      false,
      'the previous unconditional-success method must not be called'
    );
    assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, true);
    const retainedToken = storage.get(
      'social_push_foreground_invalidation_v1'
    );
    assert.ok(retainedToken);
    assert.equal(
      loaded.sandbox.SocialPush._foregroundRetryTimer,
      null,
      'an already-evaluated old bundle cannot recover through timer polling'
    );
    loaded.fire('pagehide');

    const recovered = loadCoordinator({ foregroundStorage: storage });
    recovered.fireDocument('DOMContentLoaded');
    await settle();

    assert.equal(
      recovered.calls.filter(([name]) => name === 'refresh').length,
      1,
      'the current bundle must replay the retained invalidation at startup'
    );
    assert.equal(recovered.sandbox.SocialPush._foregroundInvalidationDirty, false);
    assert.equal(storage.has('social_push_foreground_invalidation_v1'), false);
  });

test('a pagehidden refresh cannot clear replacement-realm recovery',
  async () => {
    const storage = new Map();
    let releaseRefresh;
    const pendingRefresh = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    const oldRealm = loadCoordinator({
      foregroundStorage: storage,
      refreshImpl: () => pendingRefresh,
    });

    oldRealm.fire('usernode:social-push-foreground');
    await settle();
    oldRealm.fire('pagehide');
    releaseRefresh(true);
    await settle();

    assert.equal(oldRealm.sandbox.SocialPush._foregroundInvalidationDirty, true);
    assert.equal(
      storage.get('social_push_foreground_invalidation_v1'),
      oldRealm.sandbox.SocialPush._foregroundInvalidationToken,
      'an inactive realm must leave recovery ownership for its replacement'
    );

    const replacement = loadCoordinator({ foregroundStorage: storage });
    replacement.fireDocument('DOMContentLoaded');
    await settle();

    assert.equal(
      replacement.calls.filter(([name]) => name === 'refresh').length,
      1
    );
    assert.equal(storage.has('social_push_foreground_invalidation_v1'), false);
  });

test('an older restored realm cannot clear a newer realm invalidation',
  async () => {
    const storage = new Map();
    let releaseOldRefresh;
    const oldRefresh = new Promise((resolve) => {
      releaseOldRefresh = resolve;
    });
    let realmAAttempts = 0;
    const realmA = loadCoordinator({
      foregroundStorage: storage,
      refreshImpl() {
        realmAAttempts += 1;
        return realmAAttempts === 1 ? oldRefresh : true;
      },
    });

    realmA.fire('usernode:social-push-foreground');
    await settle();
    const tokenA = storage.get('social_push_foreground_invalidation_v1');
    realmA.fire('pagehide');

    const realmB = loadCoordinator({
      foregroundStorage: storage,
      invalidationRefreshVersion: null,
    });
    realmB.fire('usernode:social-push-foreground');
    await settle();
    const tokenB = storage.get('social_push_foreground_invalidation_v1');
    assert.ok(tokenA);
    assert.ok(tokenB);
    assert.notEqual(tokenA, tokenB);

    realmA.fire('pageshow');
    releaseOldRefresh(true);
    await settle();

    assert.equal(realmAAttempts, 2,
      'realm A must refresh in its current lifecycle before consuming token B');
    assert.equal(
      storage.has('social_push_foreground_invalidation_v1'),
      false,
      'the current-epoch refresh may consume the adopted token'
    );
    assert.equal(realmA.sandbox.SocialPush._foregroundInvalidationDirty, false);
    realmA.fire('pagehide');
    realmB.fire('pagehide');
  });

test('a pre-hide refresh cannot settle after another realm consumed its token',
  async () => {
    const storage = new Map();
    let releaseOldRefresh;
    const oldRefresh = new Promise((resolve) => {
      releaseOldRefresh = resolve;
    });
    let realmAAttempts = 0;
    const realmA = loadCoordinator({
      foregroundStorage: storage,
      refreshImpl() {
        realmAAttempts += 1;
        return realmAAttempts === 1 ? oldRefresh : true;
      },
    });

    realmA.fire('usernode:social-push-foreground');
    await settle();
    realmA.fire('pagehide');

    const realmB = loadCoordinator({ foregroundStorage: storage });
    realmB.fire('usernode:social-push-foreground');
    await settle();
    assert.equal(
      storage.has('social_push_foreground_invalidation_v1'),
      false,
      'realm B consumes its own newer token after a fresh read'
    );

    realmA.fire('pageshow');
    const recoveryToken = storage.get(
      'social_push_foreground_invalidation_v1'
    );
    assert.ok(recoveryToken, 'restored realm A reacquires recovery ownership');
    releaseOldRefresh(true);
    await settle();

    assert.equal(realmAAttempts, 2,
      'the pre-hide result must be followed by a current-epoch refresh');
    assert.equal(realmA.sandbox.SocialPush._foregroundInvalidationDirty, false);
    assert.equal(storage.has('social_push_foreground_invalidation_v1'), false);
  });

test('a clean BFCache realm adopts a pending invalidation on restore',
  async () => {
    const storage = new Map();
    const realmA = loadCoordinator({ foregroundStorage: storage });
    realmA.fire('pagehide');

    const realmB = loadCoordinator({
      foregroundStorage: storage,
      invalidationRefreshVersion: null,
    });
    realmB.fire('usernode:social-push-foreground');
    await settle();
    assert.ok(storage.get('social_push_foreground_invalidation_v1'));

    realmA.fire('pageshow');
    await settle();

    assert.equal(
      realmA.calls.filter(([name]) => name === 'refresh').length,
      1,
      'restored realm A must reconcile the pending realm B invalidation'
    );
    assert.equal(realmA.sandbox.SocialPush._foregroundInvalidationDirty, false);
    assert.equal(storage.has('social_push_foreground_invalidation_v1'), false);
    realmA.fire('pagehide');
    realmB.fire('pagehide');
  });

test('a clean BFCache realm refreshes after another realm consumed the token',
  async () => {
    const storage = new Map();
    const realmA = loadCoordinator({ foregroundStorage: storage });
    realmA.fire('pagehide');

    const realmB = loadCoordinator({ foregroundStorage: storage });
    realmB.fire('usernode:social-push-foreground');
    await settle();
    assert.equal(
      storage.has('social_push_foreground_invalidation_v1'),
      false,
      'realm B already consumed the shared invalidation token'
    );

    realmA.fire('pageshow');
    await settle();

    assert.equal(
      realmA.calls.filter(([name]) => name === 'refresh').length,
      1,
      'restored realm A still needs its own current-realm network refresh'
    );
    assert.equal(realmA.sandbox.SocialPush._foregroundInvalidationDirty, false);
    assert.equal(storage.has('social_push_foreground_invalidation_v1'), false);
    realmA.fire('pagehide');
    realmB.fire('pagehide');
  });

test('blocked invalidation storage settles through the in-memory path',
  async () => {
    const loaded = loadCoordinator({
      foregroundStorageImpl: {
        getItem() { throw new Error('storage blocked'); },
        setItem() { throw new Error('storage blocked'); },
        removeItem() { throw new Error('storage blocked'); },
      },
    });

    loaded.fire('usernode:social-push-foreground');
    await settle();

    assert.equal(
      loaded.calls.filter(([name]) => name === 'refresh').length,
      1,
      'a successful refresh must not spin when storage throws'
    );
    assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, false);
    assert.equal(loaded.sandbox.SocialPush._foregroundRefreshPromise, null);
    assert.equal(loaded.sandbox.SocialPush._foregroundRetryTimer, null);
  });

test('non-persisting invalidation storage also settles in memory', async () => {
  const loaded = loadCoordinator({
    foregroundStorageImpl: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
  });

  loaded.fire('usernode:social-push-foreground');
  await settle();

  assert.equal(
    loaded.calls.filter(([name]) => name === 'refresh').length,
    1,
    'a no-op storage shim must not trigger immediate trailing fetches'
  );
  assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, false);
  assert.equal(loaded.sandbox.SocialPush._foregroundRefreshPromise, null);
  assert.equal(loaded.sandbox.SocialPush._foregroundRetryTimer, null);
});

test('native state change refreshes delivery status through the admitted bridge', async () => {
  let deliveryActive = true;
  const loaded = loadCoordinator({
    getStateImpl() {
      return {
        enabled: true,
        permissionStatus: 'authorized',
        registrationStatus: 'registered',
        deliveryActive,
      };
    },
  });
  await loaded.sandbox.SocialPush.init();
  loaded.calls.length = 0;

  deliveryActive = false;
  loaded.fire('usernode:social-push-native-state-changed');
  await settle();

  assert.deepEqual(loaded.calls, [['state'], ['remote', false]]);
  assert.equal(loaded.sandbox.SocialPush._state.deliveryActive, false);
});

test('native state invalidation queues a trailing read after an old in-flight snapshot', async () => {
  let releaseState;
  const pendingState = new Promise((resolve) => { releaseState = resolve; });
  let reads = 0;
  const loaded = loadCoordinator({
    getStateImpl() {
      reads += 1;
      if (reads === 1) return pendingState;
      return {
        enabled: true,
        permissionStatus: 'authorized',
        registrationStatus: 'registered',
        deliveryActive: false,
      };
    },
  });

  const reading = loaded.sandbox.SocialPush.getState();
  await settle();
  loaded.fire('usernode:social-push-native-state-changed');
  await settle();

  releaseState({
    enabled: true,
    permissionStatus: 'authorized',
    registrationStatus: 'registered',
    deliveryActive: true,
  });
  await reading;
  await settle();

  assert.equal(
    loaded.calls.filter(([name]) => name === 'state').length,
    2
  );
  assert.equal(loaded.sandbox.SocialPush._state.deliveryActive, false);
});

test('state and pending work retry only after native session admission', async () => {
  let admitted = false;
  const loaded = loadCoordinator({
    claims: [{ notificationId: 44 }],
    isSessionAdmittedImpl: () => admitted,
    getStateImpl() {
      if (!admitted) throw new Error('session handoff is in progress');
      return {
        enabled: true,
        permissionStatus: 'authorized',
        registrationStatus: 'registered',
        deliveryActive: true,
      };
    },
  });

  await loaded.sandbox.SocialPush.init();
  assert.deepEqual(loaded.calls, [['remote', false]],
    'a closed session clears stale delivery state without calling native');

  admitted = true;
  loaded.fire('usernode:native-session-admission', { admitted: true });
  await settle();

  assert.ok(loaded.calls.some(([name, active]) =>
    name === 'remote' && active === true));
  assert.deepEqual(
    loaded.calls.filter(([name]) => ['open', 'ack'].includes(name)),
    [['open', 44], ['ack', 44]]
  );
});

test('closing native session admission clears prior delivery state', async () => {
  const loaded = loadCoordinator();
  await loaded.sandbox.SocialPush.init();
  loaded.calls.length = 0;

  loaded.fire('usernode:native-session-admission', { admitted: false });

  assert.deepEqual(loaded.calls, [['remote', false]]);
  assert.equal(loaded.sandbox.SocialPush._state, null);
});

test('closed admission never exposes cached state or calls the setter',
  async () => {
    let admitted = true;
    const loaded = loadCoordinator({
      isSessionAdmittedImpl: () => admitted,
    });
    await loaded.sandbox.SocialPush.init();
    assert.ok(loaded.sandbox.SocialPush._state);
    loaded.calls.length = 0;

    admitted = false;
    assert.equal(await loaded.sandbox.SocialPush.getState(), null);
    await assert.rejects(
      loaded.sandbox.SocialPush.setEnabled(true),
      /secure app sign-in is still finishing/i
    );

    assert.equal(loaded.sandbox.SocialPush._state, null);
    assert.equal(loaded.calls.some(([name]) => name === 'enable'), false);
  });

test('a state read resolving after admission closes cannot restore old state', async () => {
  let releaseState;
  const pendingState = new Promise((resolve) => { releaseState = resolve; });
  const loaded = loadCoordinator({ getStateImpl: () => pendingState });

  const reading = loaded.sandbox.SocialPush.getState();
  await settle();
  loaded.fire('usernode:native-session-admission', { admitted: false });
  releaseState({
    enabled: true,
    permissionStatus: 'authorized',
    registrationStatus: 'registered',
    deliveryActive: true,
  });
  await reading;

  assert.equal(loaded.sandbox.SocialPush._state, null);
  assert.deepEqual(
    loaded.calls.filter(([name]) => name === 'remote'),
    [['remote', false]]
  );
});

test('a second tap received during a drain is claimed after the first', async () => {
  let releaseFirstOpen;
  const firstOpen = new Promise((resolve) => { releaseFirstOpen = resolve; });
  const loaded = loadCoordinator({
    claims: [{ notificationId: 45 }, { notificationId: 46 }],
    openImpl(id) { return id === 45 ? firstOpen : true; },
    ackImpl(id) { return id !== 45; },
  });

  const draining = loaded.sandbox.SocialPush.drainPending();
  await settle();
  loaded.fire('usernode:social-push-pending');
  releaseFirstOpen(true);
  await draining;

  assert.deepEqual(
    loaded.calls.filter(([name]) => ['claim', 'open', 'ack'].includes(name)),
    [
      ['claim'], ['open', 45], ['ack', 45],
      ['claim'], ['open', 46], ['ack', 46],
    ]
  );
});

test('a failed first tap still drains a second tap requested in flight', async () => {
  let rejectFirstOpen;
  const firstOpen = new Promise((_, reject) => { rejectFirstOpen = reject; });
  const loaded = loadCoordinator({
    claims: [{ notificationId: 47 }, { notificationId: 48 }],
    openImpl(id) { return id === 47 ? firstOpen : true; },
  });

  const draining = loaded.sandbox.SocialPush.drainPending();
  await settle();
  loaded.fire('usernode:social-push-pending');
  rejectFirstOpen(new Error('lookup failed'));
  await draining;

  assert.deepEqual(
    loaded.calls.filter(([name]) => ['claim', 'open', 'ack'].includes(name)),
    [
      ['claim'], ['open', 47],
      ['claim'], ['open', 48], ['ack', 48],
    ]
  );
});

test('missing native capabilities make the coordinator a no-op', async () => {
  const loaded = loadCoordinator({ caps: [] });

  await loaded.sandbox.SocialPush.init();

  assert.deepEqual(loaded.calls, []);
});

test('settings consumes live native push state', () => {
  assert.match(
    settingsSource,
    /addEventListener\('usernode:social-push-state', onState\)/
  );
  assert.match(settingsSource, /render\(event && event\.detail\)/);
});

test('opaque id lookup reuses the existing notification click router', async () => {
  const requests = [];
  const routes = [];
  const sandbox = {
    console: { warn() {} },
    Date,
    Promise,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    location: { search: '', hash: '' },
    localStorage: { getItem() { return null; }, setItem() {} },
    document: {
      title: 'Social',
      addEventListener() {},
      getElementById() { return null; },
    },
    App: {
      user: { id: 7 },
      openAppTab(slug, tab, options) { routes.push({ slug, tab, options }); },
    },
    async fetch(url, options) {
      requests.push({ url, options: options || {} });
      if (url === '/api/notifications/42') {
        return {
          ok: true,
          async json() {
            return {
              notification: {
                id: 42,
                kind: 'session_done',
                readAt: null,
                appSlug: 'example',
                sessionId: 9,
              },
            };
          },
        };
      }
      return { ok: true, async json() { return { unread: 0 }; } };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(notificationsSource, sandbox);
  sandbox.Notifications.unread = 1;

  const opened = await sandbox.Notifications.openById(42);
  await settle();

  assert.equal(opened, true);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].slug, 'example');
  assert.equal(routes[0].tab, 'dev');
  assert.equal(routes[0].options.subTab, 'sessions');
  assert.equal(routes[0].options.sessionId, 9);
  assert.equal(requests[0].url, '/api/notifications/42');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(requests[1].url, '/api/notifications/read');
});

test('native invalidation refresh bypasses the service-worker API cache',
  async () => {
    const requests = [];
    const sandbox = {
      console: { warn() {} },
      Date,
      Promise,
      URLSearchParams,
      setTimeout,
      clearTimeout,
      location: { search: '', hash: '' },
      localStorage: { getItem() { return null; }, setItem() {} },
      document: {
        title: 'Social',
        addEventListener() {},
        getElementById() { return null; },
      },
      App: { user: { id: 7 } },
      async fetch(url, options) {
        requests.push({ url, options });
        return {
          ok: true,
          async json() {
            return { notifications: [], pendingInvites: [], unread: 0 };
          },
        };
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(notificationsSource, sandbox);

    assert.equal(sandbox.Notifications.nativeInvalidationRefreshVersion, 1);
    assert.equal(await sandbox.Notifications.refreshAfterInvalidation(), true);
    assert.equal(await sandbox.Notifications.refreshAfterInvalidation(), true);
    assert.equal(requests.length, 2);
    const first = new URL(requests[0].url, 'https://social.example');
    const second = new URL(requests[1].url, 'https://social.example');
    assert.equal(first.pathname, '/api/notifications');
    assert.equal(first.searchParams.get('limit'), '100');
    assert.equal(first.searchParams.get('native_invalidation'), '1');
    assert.ok(first.searchParams.get('native_invalidation_nonce'));
    assert.equal(second.searchParams.get('native_invalidation'), '1');
    assert.ok(second.searchParams.get('native_invalidation_nonce'));
    assert.notEqual(
      first.searchParams.get('native_invalidation_nonce'),
      second.searchParams.get('native_invalidation_nonce'),
      'an older service worker must not match a previous cached response'
    );
    assert.equal(requests[0].options.cache, 'no-store');
    assert.equal(requests[0].options.credentials, 'same-origin');
  });

test('an older ordinary refresh cannot overwrite a newer invalidation result',
  async () => {
    const responses = [];
    const sandbox = {
      console: { warn() {} },
      Date,
      Promise,
      URLSearchParams,
      setTimeout,
      clearTimeout,
      location: { search: '', hash: '' },
      localStorage: { getItem() { return null; }, setItem() {} },
      document: {
        title: 'Social',
        addEventListener() {},
        getElementById() { return null; },
      },
      App: { user: { id: 7 } },
      fetch() {
        return new Promise((resolve) => responses.push(resolve));
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(notificationsSource, sandbox);

    const ordinary = sandbox.Notifications.refresh();
    const invalidation = sandbox.Notifications.refreshAfterInvalidation();
    responses[1]({
      ok: true,
      async json() {
        return { notifications: [{ id: 2 }], unread: 1 };
      },
    });
    assert.equal(await invalidation, true);
    responses[0]({
      ok: true,
      async json() {
        return { notifications: [{ id: 1 }], unread: 0 };
      },
    });
    assert.equal(await ordinary, false);
    assert.equal(sandbox.Notifications.items[0].id, 2);
    assert.equal(sandbox.Notifications.unread, 1);
  });

test('later ordinary refreshes cannot fall below a native freshness floor',
  async () => {
    const requests = [];
    const sandbox = {
      console: { warn() {} },
      Date,
      Promise,
      URLSearchParams,
      setTimeout,
      clearTimeout,
      location: { search: '', hash: '' },
      localStorage: { getItem() { return null; }, setItem() {} },
      document: {
        title: 'Social',
        addEventListener() {},
        getElementById() { return null; },
      },
      App: { user: { id: 7 } },
      async fetch(url, options) {
        requests.push({ url, options });
        const id = requests.length + 1;
        return {
          ok: true,
          async json() {
            return { notifications: [{ id }], unread: 1 };
          },
        };
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(notificationsSource, sandbox);

    assert.equal(await sandbox.Notifications.refreshAfterInvalidation(), true);
    assert.equal(sandbox.Notifications.items[0].id, 2);
    assert.equal(await sandbox.Notifications.refresh(), true);

    assert.equal(requests.length, 2);
    for (const request of requests) {
      const url = new URL(request.url, 'https://social.example');
      assert.equal(url.searchParams.get('native_invalidation'), '1');
      assert.ok(url.searchParams.get('native_invalidation_nonce'));
      assert.equal(request.options.cache, 'no-store');
      assert.equal(request.options.credentials, 'same-origin');
    }
    assert.notEqual(requests[0].url, requests[1].url,
      'the later refresh must also bypass an older worker cache entry');
    assert.equal(sandbox.Notifications.items[0].id, 3);
  });

test('an overlapping ordinary refresh inherits the native freshness floor',
  async () => {
    const requests = [];
    const responses = [];
    const sandbox = {
      console: { warn() {} },
      Date,
      Promise,
      URLSearchParams,
      setTimeout,
      clearTimeout,
      location: { search: '', hash: '' },
      localStorage: { getItem() { return null; }, setItem() {} },
      document: {
        title: 'Social',
        addEventListener() {},
        getElementById() { return null; },
      },
      App: { user: { id: 7 } },
      fetch(url, options) {
        requests.push({ url, options });
        return new Promise((resolve) => responses.push(resolve));
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(notificationsSource, sandbox);

    const invalidation = sandbox.Notifications.refreshAfterInvalidation();
    const ordinary = sandbox.Notifications.refresh();
    assert.equal(requests.length, 2);
    for (const request of requests) {
      const url = new URL(request.url, 'https://social.example');
      assert.equal(url.searchParams.get('native_invalidation'), '1');
      assert.ok(url.searchParams.get('native_invalidation_nonce'));
      assert.equal(request.options.cache, 'no-store');
      assert.equal(request.options.credentials, 'same-origin');
    }
    assert.notEqual(requests[0].url, requests[1].url);

    responses[0]({
      ok: true,
      async json() {
        return { notifications: [{ id: 2 }], unread: 1 };
      },
    });
    assert.equal(await invalidation, false,
      'the newer overlapping request owns the authoritative generation');
    responses[1]({
      ok: true,
      async json() {
        return { notifications: [{ id: 3 }], unread: 1 };
      },
    });
    assert.equal(await ordinary, true);
    assert.equal(sandbox.Notifications.items[0].id, 3);
    assert.equal(sandbox.Notifications._networkFreshnessFloor, true);
  });

test('a hung native invalidation fetch aborts so a later retry can run',
  async () => {
    const timers = [];
    const requests = [];
    class FakeAbortController {
      constructor() {
        this.signal = {
          aborted: false,
          listeners: [],
          addEventListener(_type, listener) { this.listeners.push(listener); },
        };
      }
      abort() {
        this.signal.aborted = true;
        for (const listener of this.signal.listeners) listener();
      }
    }
    const sandbox = {
      console: { warn() {} },
      Date,
      Promise,
      URLSearchParams,
      AbortController: FakeAbortController,
      setTimeout(fn) { timers.push(fn); return timers.length; },
      clearTimeout() {},
      location: { search: '', hash: '' },
      localStorage: { getItem() { return null; }, setItem() {} },
      document: {
        title: 'Social',
        addEventListener() {},
        getElementById() { return null; },
      },
      App: { user: { id: 7 } },
      fetch(_url, options) {
        requests.push(options);
        if (requests.length > 1) {
          return Promise.resolve({
            ok: true,
            async json() {
              return { notifications: [{ id: 2 }], unread: 1 };
            },
          });
        }
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(notificationsSource, sandbox);

    const first = sandbox.Notifications.refreshAfterInvalidation();
    timers.shift()();
    assert.equal(await first, false);
    assert.equal(await sandbox.Notifications.refreshAfterInvalidation(), true);
    assert.equal(requests.length, 2);
    assert.equal(sandbox.Notifications.items[0].id, 2);
  });

test('a stalled invalidation response body is covered by the same deadline',
  async () => {
    const timers = [];
    let calls = 0;
    class FakeAbortController {
      constructor() {
        this.signal = {
          aborted: false,
          listeners: [],
          addEventListener(_type, listener) {
            if (this.aborted) listener();
            else this.listeners.push(listener);
          },
        };
      }
      abort() {
        this.signal.aborted = true;
        for (const listener of this.signal.listeners) listener();
      }
    }
    const sandbox = {
      console: { warn() {} },
      Date,
      Promise,
      URLSearchParams,
      AbortController: FakeAbortController,
      setTimeout(fn) { timers.push(fn); return timers.length; },
      clearTimeout() {},
      location: { search: '', hash: '' },
      localStorage: { getItem() { return null; }, setItem() {} },
      document: {
        title: 'Social',
        addEventListener() {},
        getElementById() { return null; },
      },
      App: { user: { id: 7 } },
      async fetch(_url, options) {
        calls += 1;
        if (calls > 1) {
          return {
            ok: true,
            async json() { return { notifications: [{ id: 3 }], unread: 1 }; },
          };
        }
        return {
          ok: true,
          json() {
            return new Promise((resolve, reject) => {
              options.signal.addEventListener('abort', () => {
                const error = new Error('aborted body');
                error.name = 'AbortError';
                reject(error);
              });
            });
          },
        };
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(notificationsSource, sandbox);

    const first = sandbox.Notifications.refreshAfterInvalidation();
    await Promise.resolve();
    timers.shift()();
    assert.equal(await first, false);
    assert.equal(await sandbox.Notifications.refreshAfterInvalidation(), true);
    assert.equal(sandbox.Notifications.items[0].id, 3);
  });
