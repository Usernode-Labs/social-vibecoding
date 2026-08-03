const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bridgeSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'usernode-bridge.js'),
  'utf8'
);

function loadBridge({
  capabilities = [],
  silentMethods = [],
  timeoutScale = 1,
} = {}) {
  const nativePosts = [];
  const messageListeners = [];
  const responses = {
    getBridgeInfo: { version: 4, capabilities },
    getPrivilegedBridgeCapability: 'navigation-capability',
    getWalletState: { address: 'ut1-wallet' },
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
      const value = Object.prototype.hasOwnProperty.call(
        responses, request.method
      ) ? responses[request.method] : true;
      sandbox.__usernodeResolve(request.id, value, null);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(bridgeSource, sandbox);

  return {
    sandbox,
    nativePosts,
    dispatchMessage(event) {
      for (const listener of messageListeners) listener(event);
    },
  };
}

test('top-frame privileged calls carry one closure-only navigation capability', async () => {
  const loaded = loadBridge({
    capabilities: ['privilegedBridgeCapability', 'logout', 'getWalletState'],
  });

  await loaded.sandbox.usernode.logout();
  await loaded.sandbox.usernode.getWalletState();

  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    [
      'getBridgeInfo',
      'getPrivilegedBridgeCapability',
      'logout',
      'getWalletState',
    ]
  );
  assert.equal(
    loaded.nativePosts[2].privilegedCapability,
    'navigation-capability'
  );
  assert.equal('privilegedCapability' in loaded.nativePosts[0], false);
  assert.equal('privilegedCapability' in loaded.nativePosts[1], false);
  assert.equal('privilegedCapability' in loaded.nativePosts[3], false,
    'wallet reads remain available to embedded dapps');
  assert.equal(loaded.sandbox.usernode.privilegedCapability, undefined,
    'the capability is not exposed on the public bridge object');
});

test('old native builds retain the legacy privileged request shape', async () => {
  const loaded = loadBridge({ capabilities: ['logout'] });

  await loaded.sandbox.usernode.logout();

  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    ['getBridgeInfo', 'logout']
  );
  assert.equal('privilegedCapability' in loaded.nativePosts[1], false);
});

test('legacy shortcut management gets a full request budget after probing',
  async () => {
    const loaded = loadBridge({
      silentMethods: ['getBridgeInfo'],
      timeoutScale: 0.01,
    });

    const result = await loaded.sandbox.usernode.getHomeScreenShortcuts();

    assert.equal(result, true);
    assert.deepEqual(
      loaded.nativePosts.map((post) => post.method),
      ['getBridgeInfo', 'getHomeScreenShortcuts']
    );
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
  dispatch('getWalletState', 'wallet');

  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    ['getWalletState']
  );
  assert.equal(childReplies.length, 3);
  assert.match(childReplies[0].value.error, /top-level page/);
  assert.match(childReplies[1].value.error, /top-level page/);
  assert.equal(childReplies[2].value.error, null);
  assert.deepEqual(childReplies[2].value.value, { address: 'ut1-wallet' });
});
