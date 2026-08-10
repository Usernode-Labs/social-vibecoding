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
  path.join(__dirname, '..', 'public', 'js', 'settings.js'),
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
    setTimeout,
    clearTimeout,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    App: { user: { id: 7 } },
    NativeChrome: {
      async getInfo() { return { version: 4, capabilities: caps }; },
      isSessionAdmitted() {
        return isSessionAdmittedImpl ? isSessionAdmittedImpl() : true;
      },
    },
    Notifications: {
      async openById(id) {
        calls.push(['open', id]);
        return openImpl ? openImpl(id) : openResult;
      },
      async refreshAfterInvalidation() { calls.push(['refresh']); return true; },
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
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

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
