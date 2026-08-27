const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bridgeSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'usernode-bridge.js'),
  'utf8'
);
const CALL_NATIVE_HOOK_MARKER =
  '  // ── Iframe-relay client: discover parent + receive responses';

const SETTINGS_SNAPSHOT = {
  buildInfo: { appVersion: '1.4.2', buildNumber: '87' },
  nodeSleepEnabled: true,
  debugMode: false,
  authStatus: 'authenticated',
  permissions: { platform: 'android', exactAlarmGranted: true },
};

// `silentMethods` / `errorMethods` are returned to the caller so a test can
// change how native behaves PART WAY THROUGH a run — the only way to
// exercise "the probe timed out once, then started answering", which is the
// difference between a degraded probe and a build that genuinely lacks a
// capability.
function loadBridge({
  capabilities = [],
  silentMethods = [],
  errorMethods = {},
  // Per-method 4th argument for __usernodeResolve — the machine-readable
  // refusal envelope newer app builds send alongside the English message.
  errorInfoMethods = {},
  timeoutScale = 1,
  exposeCallNative = false,
  delayedMethods = {},
} = {}) {
  const nativePosts = [];
  const messageListeners = [];
  const windowListeners = {};
  const responses = {
    getBridgeInfo: {
      version: 4,
      capabilities,
      appVersion: '0.4.0',
      buildNumber: '1223',
    },
    getPrivilegedBridgeCapability: 'navigation-capability',
    beginSessionHandoff: { blocked: true },
    enterAnonymousSession: { admitted: true },
    getWalletState: { address: 'ut1-wallet' },
    manageStaking: {
      delegate: 'B62qdelegate',
      delegated_since: '2026-08-11T10:30:00Z',
    },
    getSettingsState: SETTINGS_SNAPSHOT,
    getSocialPushState: {
      enabled: true,
      permissionStatus: 'authorized',
      registrationStatus: 'registered',
      deliveryActive: true,
    },
    claimPendingSocialNotification: { notificationId: 42 },
    captureScreenshot: {
      contentType: 'image/jpeg',
      base64: '/9j/2Q==',
    },
    markPrivilegedBridgeReady: { ready: true },
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date,
    Math,
    Promise,
    URL,
    URLSearchParams,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init.detail; }
    },
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    setTimeout(fn, delay) { return setTimeout(fn, delay * timeoutScale); },
    clearTimeout,
    location: {
      href: 'https://social.example/',
      host: 'social.example',
      protocol: 'https:',
      search: '',
    },
    localStorage: {
      getItem() { return null; },
      setItem() {},
    },
    document: {
      currentScript: { src: 'https://social.example/usernode-bridge.js' },
      readyState: 'complete',
      head: { appendChild() {} },
      body: { appendChild() {} },
      getElementById() { return null; },
      addEventListener() {},
      createElement() {
        return {
          appendChild() {},
          setAttribute() {},
          addEventListener() {},
          style: {},
        };
      },
    },
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.push(listener);
      if (!windowListeners[type]) windowListeners[type] = [];
      windowListeners[type].push(listener);
    },
    dispatchEvent() {},
    fetch: async () => ({ ok: false }),
  };
  sandbox.window = sandbox;
  sandbox.parent = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.Usernode = {
    postMessage(raw) {
      const request = JSON.parse(raw);
      nativePosts.push(request);
      if (silentMethods.includes(request.method)) return;
      if (Object.prototype.hasOwnProperty.call(errorMethods, request.method)) {
        if (Object.prototype.hasOwnProperty.call(
          errorInfoMethods, request.method
        )) {
          sandbox.__usernodeResolve(
            request.id, null, errorMethods[request.method],
            errorInfoMethods[request.method]
          );
          return;
        }
        // Deliberately three arguments: every installed app build calls it
        // this way and must keep behaving exactly as it does today.
        sandbox.__usernodeResolve(
          request.id, null, errorMethods[request.method]
        );
        return;
      }
      const value = Object.prototype.hasOwnProperty.call(
        responses, request.method
      ) ? responses[request.method] : true;
      if (Object.prototype.hasOwnProperty.call(delayedMethods, request.method)) {
        setTimeout(() => {
          sandbox.__usernodeResolve(request.id, value, null);
        }, delayedMethods[request.method] * timeoutScale);
        return;
      }
      sandbox.__usernodeResolve(request.id, value, null);
    },
  };
  vm.createContext(sandbox);
  const source = exposeCallNative
    ? bridgeSource.replace(
      CALL_NATIVE_HOOK_MARKER,
      '  window.__callNativeForBoundaryTest = callNative;\n\n' +
      CALL_NATIVE_HOOK_MARKER
    )
    : bridgeSource;
  if (exposeCallNative) {
    assert.notEqual(source, bridgeSource,
      'the test-only callNative hook marker must match the production bridge');
  }
  vm.runInContext(source, sandbox);

  return {
    sandbox,
    nativePosts,
    silentMethods,
    errorMethods,
    // Let a method that was dropped start answering (a native side that was
    // merely busy, not a build that lacks the method).
    unsilence(method) {
      const at = silentMethods.indexOf(method);
      if (at !== -1) silentMethods.splice(at, 1);
    },
    dispatchMessage(event) {
      for (const listener of messageListeners) listener(event);
    },
    dispatchWindow(type, event = {}) {
      for (const listener of windowListeners[type] || []) listener(event);
    },
  };
}

test('top-frame privileged calls carry one closure-only realm capability', async () => {
  const loaded = loadBridge({
    capabilities: [
      'privilegedBridgeCapability',
      'beginSessionHandoff',
      'enterAnonymousSession',
      'logout',
      'getWalletState',
    ],
  });

  assert.deepEqual(
    await loaded.sandbox.usernode.beginSessionHandoff(),
    { blocked: true }
  );
  assert.deepEqual(
    await loaded.sandbox.usernode.enterAnonymousSession(),
    { admitted: true }
  );
  await loaded.sandbox.usernode.logout();
  await loaded.sandbox.usernode.getWalletState();

  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    [
      'getBridgeInfo',
      'getPrivilegedBridgeCapability',
      'beginSessionHandoff',
      'enterAnonymousSession',
      'logout',
      'getWalletState',
    ]
  );
  assert.equal(
    loaded.nativePosts[2].privilegedCapability,
    'navigation-capability'
  );
  assert.equal(
    loaded.nativePosts[3].privilegedCapability,
    'navigation-capability'
  );
  assert.equal(
    loaded.nativePosts[4].privilegedCapability,
    'navigation-capability'
  );
  assert.equal('privilegedCapability' in loaded.nativePosts[0], false);
  assert.equal('privilegedCapability' in loaded.nativePosts[1], false);
  assert.equal('privilegedCapability' in loaded.nativePosts[5], false,
    'wallet reads remain available to embedded dapps');
  assert.equal(loaded.sandbox.usernode.privilegedCapability, undefined,
    'the capability is not exposed on the public bridge object');
});

test('page readiness is an explicit top-frame privileged handshake', async () => {
  const loaded = loadBridge({
    capabilities: [
      'privilegedBridgeCapability',
      'privilegedBridgeReady',
      'markPrivilegedBridgeReady',
    ],
  });

  assert.deepEqual(
    await loaded.sandbox.usernode.markPrivilegedBridgeReady(),
    { ready: true }
  );
  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    [
      'getBridgeInfo',
      'getBridgeInfo',
      'getPrivilegedBridgeCapability',
      'markPrivilegedBridgeReady',
    ]
  );
  assert.equal(
    loaded.nativePosts[3].privilegedCapability,
    'navigation-capability'
  );
});

test('delayed valid readiness does not time out at the short probe budget',
  async () => {
    const loaded = loadBridge({
      capabilities: [
        'privilegedBridgeCapability',
        'privilegedBridgeReady',
        'markPrivilegedBridgeReady',
      ],
      timeoutScale: 0.001,
      delayedMethods: { markPrivilegedBridgeReady: 6000 },
    });

    assert.deepEqual(
      await loaded.sandbox.usernode.markPrivilegedBridgeReady(),
      { ready: true }
    );
    assert.equal(
      loaded.nativePosts.filter(
        (post) => post.method === 'markPrivilegedBridgeReady'
      ).length,
      1
    );
  });

test('inconclusive readiness probes retry but old builds remain conclusive',
  async () => {
    const transient = loadBridge({
      capabilities: [
        'privilegedBridgeCapability',
        'privilegedBridgeReady',
        'markPrivilegedBridgeReady',
      ],
      silentMethods: ['getBridgeInfo'],
      timeoutScale: 0.01,
    });

    await assert.rejects(
      transient.sandbox.usernode.markPrivilegedBridgeReady(),
      (error) => error && error.usernodeKind === 'probe-inconclusive'
    );
    transient.unsilence('getBridgeInfo');
    assert.deepEqual(
      await transient.sandbox.usernode.markPrivilegedBridgeReady(),
      { ready: true }
    );
    assert.deepEqual(
      transient.nativePosts.map((post) => post.method),
      [
        'getBridgeInfo',
        'getBridgeInfo',
        'getBridgeInfo',
        'getPrivilegedBridgeCapability',
        'markPrivilegedBridgeReady',
      ]
    );

    const oldBuild = loadBridge({ capabilities: [] });
    assert.equal(
      (await oldBuild.sandbox.usernode.markPrivilegedBridgeReady()).ready,
      false
    );
    assert.deepEqual(
      oldBuild.nativePosts.map((post) => post.method),
      ['getBridgeInfo']
    );
  });

test('pagehide rejects a dropped direct-native response before BFCache restore',
  async () => {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'logout'],
      silentMethods: ['logout'],
    });

    const request = loaded.sandbox.usernode.logout();
    await new Promise((resolve) => setImmediate(resolve));
    loaded.dispatchWindow('pagehide');
    await assert.rejects(request, /page changed/);
    assert.equal(
      Object.keys(loaded.sandbox.__usernodeBridge.pending).length,
      0,
      'the bridge must retire the abandoned native request'
    );
  });

test('pagehide also rejects an in-flight privileged capability bootstrap',
  async () => {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'logout'],
      silentMethods: ['getPrivilegedBridgeCapability'],
    });

    const request = loaded.sandbox.usernode.logout();
    await new Promise((resolve) => setImmediate(resolve));
    loaded.dispatchWindow('pagehide');
    await assert.rejects(request, /page changed/);
    assert.equal(
      Object.keys(loaded.sandbox.__usernodeBridge.pending).length,
      0
    );
  });

test('pagehide leaves ordinary embedded-dapp requests on their prior contract',
  async () => {
    const loaded = loadBridge({
      silentMethods: ['getWalletState'],
    });

    const request = loaded.sandbox.usernode.getWalletState();
    await new Promise((resolve) => setImmediate(resolve));
    loaded.dispatchWindow('pagehide');

    const pendingIds = Object.keys(loaded.sandbox.__usernodeBridge.pending);
    assert.equal(pendingIds.length, 1);
    loaded.sandbox.__usernodeResolve(
      pendingIds[0],
      { address: 'ut1-wallet' },
      null
    );
    assert.deepEqual(await request, { address: 'ut1-wallet' });
  });

test('old native builds retain the legacy privileged request shape', async () => {
  const loaded = loadBridge({ capabilities: ['logout'] });

  await loaded.sandbox.usernode.logout();
  // A build that ANSWERS the probe without advertising the handshake is a
  // conclusive negative: keep latching it, so these builds pay for exactly
  // one probe and keep the original wire shape for the whole document.
  await loaded.sandbox.usernode.logout();

  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    ['getBridgeInfo', 'logout', 'logout']
  );
  assert.equal('privilegedCapability' in loaded.nativePosts[1], false);
  assert.equal('privilegedCapability' in loaded.nativePosts[2], false);
});

test('manageStaking is a no-argument top-frame privileged action', async () => {
  const loaded = loadBridge({
    capabilities: [
      'privilegedBridgeCapability',
      'manageStaking',
    ],
  });

  const staking = await loaded.sandbox.usernode.manageStaking();

  assert.equal(staking.delegate, 'B62qdelegate');
  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    [
      'getBridgeInfo',
      'getPrivilegedBridgeCapability',
      'manageStaking',
    ]
  );
  assert.equal(
    loaded.nativePosts[2].privilegedCapability,
    'navigation-capability'
  );
  assert.deepEqual(loaded.nativePosts[2].args, {},
    'Social Vibecoding must not send a target or desired state');
});

test('Social push state and tap methods stay behind the top-frame capability',
  async () => {
    const loaded = loadBridge({
      capabilities: [
        'privilegedBridgeCapability',
        'getSocialPushState',
        'setSocialPushEnabled',
        'claimPendingSocialNotification',
        'ackPendingSocialNotification',
      ],
    });

    const state = await loaded.sandbox.usernode.getSocialPushState();
    await loaded.sandbox.usernode.setSocialPushEnabled(true);
    const claim = await loaded.sandbox.usernode.claimPendingSocialNotification();
    await loaded.sandbox.usernode.ackPendingSocialNotification(42);

    assert.equal(state.deliveryActive, true);
    assert.equal(claim.notificationId, 42);
    assert.deepEqual(
      loaded.nativePosts.map((post) => post.method),
      [
        'getBridgeInfo',
        'getPrivilegedBridgeCapability',
        'getSocialPushState',
        'setSocialPushEnabled',
        'claimPendingSocialNotification',
        'ackPendingSocialNotification',
      ]
    );
    for (const post of loaded.nativePosts.slice(2)) {
      assert.equal(post.privilegedCapability, 'navigation-capability');
    }
    assert.deepEqual(loaded.nativePosts[3].args, { enabled: true });
    assert.deepEqual(loaded.nativePosts[5].args, { notificationId: 42 });
  });

test('the homescreen badge count is a privileged top-frame action', async () => {
  // #1445: setSocialBadgeCount carries the unread total the OS icon badge
  // shows. Same per-realm capability as the other social-push methods.
  const loaded = loadBridge({
    capabilities: [
      'privilegedBridgeCapability',
      'setSocialBadgeCount',
    ],
  });

  await loaded.sandbox.usernode.setSocialBadgeCount(7);

  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    [
      'getBridgeInfo',
      'getPrivilegedBridgeCapability',
      'setSocialBadgeCount',
    ]
  );
  assert.equal(
    loaded.nativePosts[2].privilegedCapability,
    'navigation-capability'
  );
  assert.deepEqual(loaded.nativePosts[2].args, { count: 7 });
});

test('notification permission actions require the top-frame capability',
  async () => {
    const methods = [
      'requestNotificationPermission',
      'requestAlarmPermissions',
      'openNotificationSettings',
    ];
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', ...methods],
      exposeCallNative: true,
    });

    for (const method of methods) {
      await loaded.sandbox.__callNativeForBoundaryTest(method, {});
    }

    assert.deepEqual(
      loaded.nativePosts.map((post) => post.method),
      [
        'getBridgeInfo',
        'getPrivilegedBridgeCapability',
        ...methods,
      ]
    );
    for (const post of loaded.nativePosts.slice(2)) {
      assert.equal(post.privilegedCapability, 'navigation-capability');
    }

    const relayed = loadBridge();
    const childReplies = [];
    const child = {
      postMessage(value, origin) { childReplies.push({ value, origin }); },
    };
    for (const method of methods) {
      relayed.dispatchMessage({
        source: child,
        origin: 'https://child.example',
        data: {
          __usernode_relay: 'request',
          id: method,
          method,
          args: {},
        },
      });
    }

    assert.equal(relayed.nativePosts.length, 0,
      'an iframe cannot forward notification permission actions to native');
    assert.equal(childReplies.length, methods.length);
    for (const reply of childReplies) {
      assert.match(reply.value.error, /top-level page/);
    }
  });

test('native screenshot capture is a top-frame privileged action', async () => {
  const loaded = loadBridge({
    capabilities: ['privilegedBridgeCapability', 'captureScreenshot'],
  });

  const payload = await loaded.sandbox.usernode.captureScreenshot();
  assert.equal(payload.contentType, 'image/jpeg');
  assert.equal(payload.base64, '/9j/2Q==');
  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    ['getBridgeInfo', 'getPrivilegedBridgeCapability', 'captureScreenshot']
  );
  assert.equal(
    loaded.nativePosts[2].privilegedCapability,
    'navigation-capability'
  );
});

test('legacy shortcut management gets a full request budget after probing',
  async () => {
    // A probe that never answers is INCONCLUSIVE, not "this build has no
    // capabilities" — so this first attempt fails closed rather than
    // guessing the unsigned wire shape (issue #978). Nothing is latched, so
    // the retry re-probes; once the probe answers, the shortcut call gets
    // its own full budget on top of the probe's.
    const loaded = loadBridge({
      silentMethods: ['getBridgeInfo'],
      timeoutScale: 0.01,
    });

    assert.equal(await loaded.sandbox.usernode.getHomeScreenShortcuts(), null,
      'the inconclusive attempt falls back rather than sending unsigned');
    assert.deepEqual(
      loaded.nativePosts.map((post) => post.method),
      ['getBridgeInfo']
    );

    loaded.unsilence('getBridgeInfo');
    const result = await loaded.sandbox.usernode.getHomeScreenShortcuts();

    assert.equal(result, true);
    assert.deepEqual(
      loaded.nativePosts.map((post) => post.method),
      ['getBridgeInfo', 'getBridgeInfo', 'getHomeScreenShortcuts']
    );
  });

test('a degraded capability probe fails closed and never latches a negative',
  async () => {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'getSettingsState'],
      silentMethods: ['getBridgeInfo'],
      timeoutScale: 0.01,
    });

    assert.equal(await loaded.sandbox.usernode.getSettingsState(), null,
      'a read whose handshake could not be negotiated resolves its fallback');
    assert.deepEqual(
      loaded.nativePosts.map((post) => post.method),
      ['getBridgeInfo'],
      'the privileged call is never sent unsigned on an inconclusive probe'
    );
    assert.equal(
      loaded.sandbox.usernode.getLastNativeReadError('getSettingsState').kind,
      'probe-inconclusive',
      'the reason is recorded so the Settings screen can name it'
    );

    // THE REGRESSION THIS PINS: the old bridge remembered "not supported"
    // from that one timeout and sent every later privileged call unsigned
    // for the life of the document, which a hardened build refuses — the
    // sticky "Could not load Usernode app settings" of issue #978.
    loaded.unsilence('getBridgeInfo');
    assert.deepEqual(
      await loaded.sandbox.usernode.getSettingsState(),
      SETTINGS_SNAPSHOT
    );
    assert.deepEqual(
      loaded.nativePosts.map((post) => post.method),
      [
        'getBridgeInfo',
        'getBridgeInfo',
        'getPrivilegedBridgeCapability',
        'getSettingsState',
      ]
    );
    assert.equal(
      loaded.nativePosts[3].privilegedCapability, 'navigation-capability'
    );
    assert.equal(
      loaded.sandbox.usernode.getLastNativeReadError('getSettingsState'), null,
      'a successful read clears the record'
    );
  });

test('chrome reads record WHY they came back empty', async () => {
  // Reads must keep resolving a fallback (every caller awaits and renders
  // "unavailable"), so the reason has to travel out of band or the UI can
  // only ever say "something went wrong".
  const timedOut = loadBridge({
    capabilities: ['privilegedBridgeCapability', 'getSettingsState'],
    silentMethods: ['getSettingsState'],
    timeoutScale: 0.01,
  });

  assert.equal(await timedOut.sandbox.usernode.getSettingsState(), null);
  const timeout = timedOut.sandbox.usernode
    .getLastNativeReadError('getSettingsState');
  assert.equal(timeout.kind, 'timeout');
  assert.equal(timeout.method, 'getSettingsState');
  assert.match(timeout.message, /did not respond within/);
  assert.equal(typeof timeout.at, 'number');
  assert.equal(
    timedOut.sandbox.usernode.getLastNativeReadError('getWalletState'), null,
    'only the method that actually failed carries a record'
  );

  const rejected = loadBridge({
    capabilities: ['privilegedBridgeCapability', 'getSettingsState'],
    errorMethods: { getSettingsState: 'terms provider unavailable' },
    timeoutScale: 0.01,
  });

  assert.equal(await rejected.sandbox.usernode.getSettingsState(), null);
  const nativeError = rejected.sandbox.usernode
    .getLastNativeReadError('getSettingsState');
  assert.equal(nativeError.kind, 'rejected');
  assert.equal(nativeError.message, 'terms provider unavailable',
    'the app’s own message reaches the screen verbatim');

  // The record never carries the privileged capability, which is the one
  // string in this closure that must not leak into a rendered message.
  for (const record of [timeout, nativeError]) {
    assert.doesNotMatch(String(record.message), /navigation-capability/);
  }
});

test('outside the app, getSettingsState reports that it cannot reach it',
  async () => {
    const loaded = loadBridge({ capabilities: ['getSettingsState'] });
    loaded.sandbox.usernode.isNative = false;

    assert.equal(await loaded.sandbox.usernode.getSettingsState(), null);
    assert.equal(
      loaded.sandbox.usernode.getLastNativeReadError('getSettingsState').kind,
      'not-native'
    );
    assert.equal(loaded.nativePosts.length, 0);
  });

test('a failed bridge probe is marked degraded, a real one is not', async () => {
  // Field-wise rather than deepEqual: these objects are built inside the
  // sandbox realm, so their prototypes differ from the test realm's.
  const answered = loadBridge({ capabilities: ['getSettingsState'] });
  const info = await answered.sandbox.usernode.getBridgeInfo();
  assert.equal(info.version, 4);
  assert.equal(info.appVersion, '0.4.0');
  assert.equal(info.buildNumber, '1223');
  assert.equal(info.degraded, undefined,
    'a conclusive probe must not look degraded, or callers would re-probe forever');

  const silent = loadBridge({
    silentMethods: ['getBridgeInfo'],
    timeoutScale: 0.01,
  });
  const degraded = await silent.sandbox.usernode.getBridgeInfo();
  assert.equal(degraded.version, 0);
  assert.equal(degraded.capabilities.length, 0);
  assert.equal(degraded.degraded, true);

  // Outside the app there is nothing to be inconclusive about.
  const web = loadBridge();
  web.sandbox.usernode.isNative = false;
  const empty = await web.sandbox.usernode.getBridgeInfo();
  assert.equal(empty.version, 0);
  assert.equal(empty.capabilities.length, 0);
  assert.equal(empty.degraded, undefined);
});

test('parent relay denies bootstrap and privileged methods but keeps reads', () => {
  const loaded = loadBridge({ capabilities: ['privilegedBridgeCapability'] });
  const childReplies = [];
  const child = {
    postMessage(value, origin) { childReplies.push({ value, origin }); },
  };
  const dispatch = (method, id) => loaded.dispatchMessage({
    source: child,
    origin: 'https://child.example',
    data: {
      __usernode_relay: 'request',
      id,
      method,
      args: {},
    },
  });

  dispatch('getPrivilegedBridgeCapability', 'bootstrap');
  dispatch('logout', 'logout');
  dispatch('enterAnonymousSession', 'anonymous');
  dispatch('setIosKeepAlive', 'legacy-ios-setting');
  dispatch('manageStaking', 'manage-staking');
  dispatch('getWalletState', 'wallet');

  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    ['getWalletState']
  );
  assert.equal(childReplies.length, 6);
  assert.match(childReplies[0].value.error, /top-level page/);
  assert.match(childReplies[1].value.error, /top-level page/);
  assert.match(childReplies[2].value.error, /top-level page/,
    'only the trusted shell can admit an anonymous native session');
  assert.match(childReplies[3].value.error, /top-level page/,
    'removed v3 actions stay fenced for installed old app builds');
  assert.match(childReplies[4].value.error, /top-level page/,
    'embedded apps cannot open native delegation management');
  assert.equal(childReplies[5].value.error, null);
  assert.deepEqual(childReplies[5].value.value, { address: 'ut1-wallet' });
});

test('session handoff gate rejects top-frame and iframe wallet calls', async () => {
  const loaded = loadBridge();
  const childReplies = [];
  const child = {
    postMessage(value, origin) { childReplies.push({ value, origin }); },
  };
  const relayWalletRead = (id) => loaded.dispatchMessage({
    source: child,
    origin: 'https://child.example',
    data: {
      __usernode_relay: 'request',
      id,
      method: 'getWalletState',
      args: {},
    },
  });

  loaded.sandbox.usernode._setSessionWalletRelayAdmission(false);
  assert.equal(await loaded.sandbox.usernode.getWalletState(), null,
    'top-frame reads fail closed through their existing null fallback');
  loaded.sandbox.usernode.acknowledgeTransaction('tx-during-handoff');
  await assert.rejects(
    loaded.sandbox.signMessage('session-scoped message'),
    /wallet handoff is in progress/i
  );
  relayWalletRead('blocked-wallet');

  assert.equal(loaded.nativePosts.length, 0);
  assert.match(childReplies[0].value.error, /wallet handoff is in progress/i);

  loaded.sandbox.usernode._setSessionWalletRelayAdmission(true);
  relayWalletRead('admitted-wallet');
  loaded.sandbox.usernode.acknowledgeTransaction('tx-during-handoff');
  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    ['getWalletState', 'txObserved']
  );
  assert.equal(childReplies[1].value.error, null);
});

// ── Refusal codes (bridge contract v4) ──────────────────────────────────
//
// Native may now send a 4th argument to __usernodeResolve carrying a
// machine-readable { code }. The transport has to be additive in BOTH
// directions: an old app calling it with three arguments must behave
// byte-for-byte as it does today, and a new app's extra argument must
// never turn the human message into "[object Object]".

test('a three-argument resolve keeps exactly today’s behaviour', async () => {
  const loaded = loadBridge({
    capabilities: ['privilegedBridgeCapability', 'beginSessionHandoff'],
    errorMethods: { beginSessionHandoff: 'latch is busy' },
  });

  const err = await loaded.sandbox.usernode.beginSessionHandoff()
    .then(() => null, (e) => e);

  assert.equal(err.message, 'latch is busy');
  assert.equal('usernodeCode' in err, false,
    'no code is invented when native did not send one');
});

test('a refusal code rides alongside the human message, never replacing it',
  async () => {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'beginSessionHandoff'],
      errorMethods: {
        beginSessionHandoff:
          'Privileged bridge is unavailable for this main frame',
      },
      errorInfoMethods: {
        beginSessionHandoff: { code: 'privileged_frame_unauthorized' },
      },
    });

    const err = await loaded.sandbox.usernode.beginSessionHandoff()
      .then(() => null, (e) => e);

    assert.equal(err.message,
      'Privileged bridge is unavailable for this main frame');
    assert.equal(err.usernodeCode, 'privileged_frame_unauthorized');
    assert.equal(err.usernodeKind, 'privileged-unavailable');
    assert.equal(err.usernodePrivileged, true);
  });

test('a junk or empty errorInfo is ignored rather than trusted', async () => {
  for (const info of [null, {}, { code: '' }, { code: '  ' }, { code: 7 }, 'x']) {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'beginSessionHandoff'],
      errorMethods: { beginSessionHandoff: 'nope' },
      errorInfoMethods: { beginSessionHandoff: info },
    });
    const err = await loaded.sandbox.usernode.beginSessionHandoff()
      .then(() => null, (e) => e);
    assert.equal(err.message, 'nope');
    assert.equal(err.usernodeCode, undefined,
      `errorInfo ${JSON.stringify(info)} must not produce a code`);
  }
});

test('each refusal code classifies to its own diagnosable state', async () => {
  const cases = [
    ['privileged_frame_unauthorized', 'blocked-frame'],
    ['privileged_unsupported_version', 'unsupported'],
    ['privileged_bootstrap_timeout', 'unattached'],
  ];
  for (const [code, state] of cases) {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'beginSessionHandoff'],
      errorMethods: { beginSessionHandoff: 'refused' },
      errorInfoMethods: { beginSessionHandoff: { code } },
    });
    await loaded.sandbox.usernode.beginSessionHandoff().catch(() => {});
    const diag = loaded.sandbox.usernode.getBridgeDiagnostics();
    assert.equal(diag.privileged.state, state, `${code} → ${state}`);
    assert.equal(diag.privileged.code, code);
  }
});

test('an unknown code still classifies rather than falling through',
  async () => {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'beginSessionHandoff'],
      errorMethods: { beginSessionHandoff: 'refused for reasons' },
      errorInfoMethods: {
        beginSessionHandoff: { code: 'privileged_something_new' },
      },
    });

    await loaded.sandbox.usernode.beginSessionHandoff().catch(() => {});
    const diag = loaded.sandbox.usernode.getBridgeDiagnostics();
    assert.equal(diag.privileged.state, 'blocked-frame');
    assert.equal(diag.privileged.code, 'privileged_something_new');
  });

test('with no code at all the English prose still classifies', async () => {
  const loaded = loadBridge({
    capabilities: ['privilegedBridgeCapability', 'beginSessionHandoff'],
    errorMethods: {
      beginSessionHandoff:
        'Privileged bridge is unavailable for this main frame',
    },
  });

  await loaded.sandbox.usernode.beginSessionHandoff().catch(() => {});
  const diag = loaded.sandbox.usernode.getBridgeDiagnostics();
  assert.equal(diag.privileged.state, 'blocked-frame');
  assert.equal(diag.privileged.code, null);
});

test('an ordinary method rejection is not mistaken for a refused bridge',
  async () => {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'beginSessionHandoff'],
      errorMethods: { beginSessionHandoff: 'the wallet is already unlocked' },
    });

    const err = await loaded.sandbox.usernode.beginSessionHandoff()
      .then(() => null, (e) => e);
    assert.equal(err.usernodePrivileged, undefined);

    const diag = loaded.sandbox.usernode.getBridgeDiagnostics();
    assert.equal(diag.privileged.state, 'ready',
      'the handshake itself succeeded; only the method failed');
  });

test('a build without the privileged bootstrap classifies as unsupported',
  async () => {
    const loaded = loadBridge({ capabilities: ['beginSessionHandoff'] });

    await loaded.sandbox.usernode.beginSessionHandoff().catch(() => {});
    const diag = loaded.sandbox.usernode.getBridgeDiagnostics();
    assert.equal(diag.privileged.state, 'unsupported');
    assert.equal(diag.privileged.code, null);
  });
