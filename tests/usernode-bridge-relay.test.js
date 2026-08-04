const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const versionedBridgePath = path.join(
  root,
  'public',
  'usernode-bridge',
  'v1',
  'bridge.js'
);

function relaySource() {
  const source = fs.readFileSync(versionedBridgePath, 'utf8');
  const begin = source.indexOf('/* __USERNODE_NATIVE_RELAY_SERVER_BEGIN__ */');
  const end = source.indexOf('/* __USERNODE_NATIVE_RELAY_SERVER_END__ */');
  assert.ok(
    begin !== -1 && end !== -1 && end > begin,
    'native relay server block markers are present'
  );
  return source.slice(begin, end);
}

function makeChild() {
  const posts = [];
  return {
    posts,
    postMessage(message, targetOrigin) {
      posts.push({ message, targetOrigin });
    },
  };
}

function makeRelaySandbox() {
  const listeners = {};
  const nativeMessages = [];
  const timers = new Map();
  let nextTimerId = 1;
  let sessionWalletRelayAdmitted = true;
  const child = makeChild();
  const outsider = makeChild();
  const fakeWindow = {
    frames: [child],
    __usernodeBridge: { pending: {} },
    Usernode: {
      postMessage(message) {
        nativeMessages.push(JSON.parse(message));
      },
    },
    addEventListener(type, listener) {
      (listeners[type] = listeners[type] || []).push(listener);
    },
  };
  const sandbox = {
    window: fakeWindow,
    _hasNativeChannel: true,
    _BRIDGE_TAG: '[bridge relay test]',
    _RELAY_TIMEOUT_MS: 15000,
    _sessionWalletRelayAdmitted: true,
    _PRIVILEGED_CAPABILITY_METHOD: 'getPrivilegedBridgeCapability',
    isPrivilegedNativeMethod(method) {
      return [
        'addHomeScreenShortcut',
        'getHomeScreenShortcuts',
        'removeHomeScreenShortcut',
        'reorderHomeScreenShortcuts',
        'openNativeScreen',
        'getProfileInfo',
        'getSettingsState',
        'setNodeSleepEnabled',
        'setDebugMode',
        'setFacematchStrict',
        'resetZkChallenge',
        'requestPermissions',
        'openBatterySettings',
        'setIosKeepAlive',
        'logout',
        'beginSessionHandoff',
        'enterAnonymousSession',
        'completeLogin',
        'startNode',
        'stopNode',
        'getAuthStatus',
      ].includes(method);
    },
    isSessionWalletMethod(method) {
      return [
        'getNodeAddress',
        'getWalletState',
        'sendTransaction',
        'signMessage',
        'txObserved',
        'getTransactionRecords',
      ].includes(method);
    },
    console: {
      log() {},
      warn() {},
    },
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(relaySource(), sandbox);
  return {
    child,
    fakeWindow,
    listeners,
    nativeMessages,
    outsider,
    setSessionAdmission(admitted) {
      sessionWalletRelayAdmitted = admitted === true;
      sandbox._sessionWalletRelayAdmitted = sessionWalletRelayAdmitted;
    },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
  };
}

function dispatch(ctx, source, origin, data) {
  for (const listener of ctx.listeners.message || []) {
    listener({ source, origin, data });
  }
}

function discover(ctx, origin = 'https://recipe.example') {
  dispatch(ctx, ctx.child, origin, { __usernode_relay: 'discover' });
}

function request(ctx, method, id = `request-${method}`, args = {}) {
  dispatch(ctx, ctx.child, 'https://recipe.example', {
    __usernode_relay: 'request',
    id,
    method,
    args,
  });
}

test('relay discovery binds a direct child and publishes only child-safe methods', () => {
  const ctx = makeRelaySandbox();
  discover(ctx);

  assert.equal(ctx.child.posts.length, 1);
  const { message, targetOrigin } = ctx.child.posts[0];
  assert.equal(message.__usernode_relay, 'discover-ack');
  assert.equal(message.policyVersion, 1);
  assert.deepEqual(
    Array.from(message.allowedMethods),
    [
      'getBridgeInfo',
      'getNodeAddress',
      'getNodeStatus',
      'getWalletState',
      'sendTransaction',
      'signMessage',
    ]
  );
  assert.equal(targetOrigin, 'https://recipe.example');
  assert.equal(ctx.nativeMessages.length, 0);
});

test('relay dispatches every explicitly permitted child method', async (t) => {
  const permitted = [
    ['getNodeAddress', {}],
    ['getNodeStatus', {}],
    ['getWalletState', {}],
    ['sendTransaction', {
      destination_pubkey: 'ut1destination',
      amount: '5',
      memo: 'test',
    }],
    ['signMessage', { message: 'sign me' }],
  ];

  for (const [method, args] of permitted) {
    await t.test(method, () => {
      const ctx = makeRelaySandbox();
      discover(ctx);
      ctx.child.posts.length = 0;

      request(ctx, method, `permitted-${method}`, args);

      assert.equal(ctx.nativeMessages.length, 1);
      assert.equal(ctx.nativeMessages[0].method, method);
      assert.match(ctx.nativeMessages[0].id, /^relay-/);
    });
  }
});

test('closed session handoff blocks child wallet methods but preserves safe reads', () => {
  const ctx = makeRelaySandbox();
  discover(ctx);
  ctx.child.posts.length = 0;
  ctx.setSessionAdmission(false);

  for (const method of [
    'getNodeAddress',
    'getWalletState',
    'sendTransaction',
    'signMessage',
  ]) {
    request(ctx, method, `blocked-${method}`);
  }
  request(ctx, 'getBridgeInfo', 'safe-bridge-info');
  request(ctx, 'getNodeStatus', 'safe-node-status');

  assert.deepEqual(
    ctx.nativeMessages.map(({ method }) => method),
    ['getBridgeInfo', 'getNodeStatus']
  );
  assert.deepEqual(
    ctx.child.posts.map(({ message }) => message.error),
    [
      'Native wallet handoff is in progress',
      'Native wallet handoff is in progress',
      'Native wallet handoff is in progress',
      'Native wallet handoff is in progress',
    ]
  );
});

test('relay ignores discovery from a window that is not a direct child frame', () => {
  const ctx = makeRelaySandbox();
  dispatch(ctx, ctx.outsider, 'https://attacker.example', {
    __usernode_relay: 'discover',
  });

  assert.equal(ctx.outsider.posts.length, 0);
  assert.equal(ctx.nativeMessages.length, 0);
});

test('relay requires a matching discovery source and origin before native dispatch', () => {
  const ctx = makeRelaySandbox();

  request(ctx, 'getNodeAddress', 'before-discovery');
  assert.equal(ctx.nativeMessages.length, 0);
  assert.equal(
    ctx.child.posts.at(-1).message.error,
    'Child native relay handshake required'
  );

  discover(ctx);
  dispatch(ctx, ctx.child, 'https://navigated.example', {
    __usernode_relay: 'request',
    id: 'after-navigation',
    method: 'getNodeAddress',
    args: {},
  });
  assert.equal(ctx.nativeMessages.length, 0);
  assert.equal(
    ctx.child.posts.at(-1).message.error,
    'Child native relay handshake required'
  );
});

test('relay rejects privileged and unknown child methods before native dispatch', async (t) => {
  const forbidden = [
    'getPrivilegedBridgeCapability',
    'getProfileInfo',
    'getSettingsState',
    'getTransactionRecords',
    'openNativeScreen',
    'setNodeSleepEnabled',
    'setDebugMode',
    'setFacematchStrict',
    'setIosKeepAlive',
    'requestPermissions',
    'resetZkChallenge',
    'openBatterySettings',
    'logout',
    'getHomeScreenShortcutSupport',
    'addHomeScreenShortcut',
    'getHomeScreenShortcuts',
    'removeHomeScreenShortcut',
    'reorderHomeScreenShortcuts',
    'beginSessionHandoff',
    'enterAnonymousSession',
    'completeLogin',
    'startNode',
    'stopNode',
    'getAuthStatus',
    'futurePrivilegedMethod',
  ];
  const explicitlyPrivileged = new Set([
    'getPrivilegedBridgeCapability',
    'getProfileInfo',
    'getSettingsState',
    'openNativeScreen',
    'setNodeSleepEnabled',
    'setDebugMode',
    'setFacematchStrict',
    'setIosKeepAlive',
    'requestPermissions',
    'resetZkChallenge',
    'openBatterySettings',
    'logout',
    'addHomeScreenShortcut',
    'getHomeScreenShortcuts',
    'removeHomeScreenShortcut',
    'reorderHomeScreenShortcuts',
    'beginSessionHandoff',
    'enterAnonymousSession',
    'completeLogin',
    'startNode',
    'stopNode',
    'getAuthStatus',
  ]);

  for (const method of forbidden) {
    await t.test(method, () => {
      const ctx = makeRelaySandbox();
      discover(ctx);
      ctx.child.posts.length = 0;

      request(ctx, method);

      assert.equal(ctx.nativeMessages.length, 0);
      assert.equal(ctx.child.posts.length, 1);
      assert.equal(
        ctx.child.posts[0].message.error,
        explicitlyPrivileged.has(method)
          ? 'Privileged Usernode methods are only available to the top-level page'
          : 'Native capability is not available to embedded child apps'
      );
    });
  }
});

test('relay preserves the Flutter wire format for permitted child calls', () => {
  const ctx = makeRelaySandbox();
  discover(ctx);
  ctx.child.posts.length = 0;

  request(ctx, 'sendTransaction', 'send-1', {
    destination_pubkey: 'ut1destination',
    amount: '5',
    memo: 'test',
  });

  assert.equal(ctx.nativeMessages.length, 1);
  const nativeRequest = ctx.nativeMessages[0];
  assert.equal(nativeRequest.method, 'sendTransaction');
  assert.match(nativeRequest.id, /^relay-/);
  assert.equal(nativeRequest.args.destination_pubkey, 'ut1destination');
  assert.equal(nativeRequest.args.amount, '5');
  assert.equal(nativeRequest.args.memo, 'test');

  ctx.fakeWindow.__usernodeBridge.pending[nativeRequest.id].resolve({
    queued: true,
  });
  assert.equal(ctx.child.posts.length, 1);
  assert.equal(ctx.child.posts[0].message.id, 'send-1');
  assert.equal(ctx.child.posts[0].message.error, null);
  assert.equal(ctx.child.posts[0].message.value.queued, true);
});

test('relay permits only one interactive native request per child at a time', () => {
  const ctx = makeRelaySandbox();
  discover(ctx);
  ctx.child.posts.length = 0;

  request(ctx, 'sendTransaction', 'send-first', { amount: '1' });
  request(ctx, 'signMessage', 'sign-flood', { message: 'sign me' });

  assert.equal(ctx.nativeMessages.length, 1);
  assert.equal(ctx.child.posts.length, 1);
  assert.equal(
    ctx.child.posts[0].message.error,
    'Another interactive native request is already pending'
  );

  const firstNativeId = ctx.nativeMessages[0].id;
  ctx.fakeWindow.__usernodeBridge.pending[firstNativeId].resolve({
    queued: true,
  });
  request(ctx, 'signMessage', 'sign-after-settle', { message: 'sign me' });
  assert.equal(ctx.nativeMessages.length, 2);
  assert.equal(ctx.nativeMessages[1].method, 'signMessage');
});

test('relay bounds total outstanding native work per child', () => {
  const ctx = makeRelaySandbox();
  discover(ctx);
  ctx.child.posts.length = 0;

  for (let index = 0; index < 8; index++) {
    request(ctx, 'getNodeStatus', `status-${index}`);
  }
  request(ctx, 'getWalletState', 'request-over-limit');

  assert.equal(ctx.nativeMessages.length, 8);
  assert.equal(ctx.child.posts.length, 1);
  assert.equal(
    ctx.child.posts[0].message.error,
    'Too many pending native requests from this child app'
  );
});

test('relay timeout removes pending native work and releases the child limit', () => {
  const ctx = makeRelaySandbox();
  discover(ctx);
  ctx.child.posts.length = 0;

  request(ctx, 'sendTransaction', 'send-timeout', { amount: '1' });
  const timedOutNativeId = ctx.nativeMessages[0].id;
  assert.ok(ctx.fakeWindow.__usernodeBridge.pending[timedOutNativeId]);

  ctx.runTimers();

  assert.equal(ctx.fakeWindow.__usernodeBridge.pending[timedOutNativeId], undefined);
  assert.equal(ctx.child.posts.length, 1);
  assert.equal(ctx.child.posts[0].message.error, 'Native relay request timed out');

  request(ctx, 'signMessage', 'sign-after-timeout', { message: 'sign me' });
  assert.equal(ctx.nativeMessages.length, 2);
  assert.equal(ctx.nativeMessages[1].method, 'signMessage');
});

test('relay filters getBridgeInfo to supported child-safe capabilities', () => {
  const ctx = makeRelaySandbox();
  discover(ctx);
  ctx.child.posts.length = 0;

  request(ctx, 'getBridgeInfo', 'bridge-info');
  const nativeRequest = ctx.nativeMessages[0];
  ctx.fakeWindow.__usernodeBridge.pending[nativeRequest.id].resolve({
    version: 3,
    capabilities: [
      'getBridgeInfo',
      'getNodeAddress',
      'getNodeStatus',
      'getWalletState',
      'sendTransaction',
      'signMessage',
      'getSettingsState',
      'logout',
      'addHomeScreenShortcut',
    ],
  });

  const response = ctx.child.posts[0].message;
  assert.equal(response.error, null);
  assert.equal(response.value.version, 3);
  assert.deepEqual(
    Array.from(response.value.capabilities),
    [
      'getBridgeInfo',
      'getNodeAddress',
      'getNodeStatus',
      'getWalletState',
      'sendTransaction',
      'signMessage',
    ]
  );
});

test('relay rejects malformed child requests before native dispatch', () => {
  const ctx = makeRelaySandbox();
  discover(ctx);
  ctx.child.posts.length = 0;

  dispatch(ctx, ctx.child, 'https://recipe.example', {
    __usernode_relay: 'request',
    id: '',
    method: 'getNodeAddress',
    args: {},
  });

  assert.equal(ctx.nativeMessages.length, 0);
  assert.equal(
    ctx.child.posts[0].message.error,
    'Malformed child native relay request'
  );
});
