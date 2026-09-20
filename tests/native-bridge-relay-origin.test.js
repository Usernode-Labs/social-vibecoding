'use strict';

// #2503 (HIGH): the native bridge relay accepted messages from ANY window
// and ANY origin.
//
// `public/usernode-bridge.js` installs a top-frame relay when the Flutter JS
// channel is present. Its only guard was:
//
//     var data = e.data;
//     if (!data || !e.source) return;
//
// No check that `e.source` is a frame this document owns, and no check of
// `e.origin`. So a THIRD-PARTY IFRAME NESTED INSIDE AN APP could skip its own
// parent entirely —
//
//     window.top.postMessage({ __usernode_relay: 'discover' }, '*')
//     window.top.postMessage({ __usernode_relay: 'request', id: 1,
//                              method: 'getWalletState' }, '*')
//
// — and the top frame would relay it over the native channel carrying the
// HOST PAGE's authority. Privileged methods were already refused, but the
// session-bound reads were not: `getWalletState` answered a frame that had no
// business asking. A confused deputy.
//
// Every web bridge handler in public/js/app-view.js already gates on
// `e.source === iframe.contentWindow`. This relay was the single place that
// pattern was absent.
//
// The fix: the sender must be a DIRECT CHILD IFRAME of this document. A
// grandchild is not, which is exactly the attacking frame.
//
// The audit's "related weakness" — a WindowProxy survives navigation, so a
// document navigated INTO an app frame inherits the previous occupant's
// access — is NOT closed here, and the last test in this file says so out
// loud. An origin pin was built for it, reviewed, and reproduced as
// ineffective: the client half of the bridge auto-sends `discover` on load,
// so a navigated document re-pins by simply following the protocol. It was
// removed rather than shipped as a control that reads like a boundary and
// is not. Closing it needs a parent-driven registration lifecycle, which is
// a protocol change to a script shipped to every app.
//
// Run with: node --test tests/native-bridge-relay-origin.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const bridgeSource = fs.readFileSync(
  path.join(root, 'public', 'usernode-bridge.js'), 'utf8'
);

const ESTABLISH_ATTEMPT = `nsa_${'A'.repeat(43)}`;

// A minimal top-frame bridge realm with the native channel present, so the
// relay listener installs. Deliberately smaller than
// tests/native-bridge-boundary.test.js's harness: this file is about WHO the
// relay will speak to, not about what the methods do.
function loadRelay() {
  const messageListeners = [];
  const childFrames = [];
  const nativePosts = [];
  const warnings = [];

  const sandbox = {
    console: {
      log() {},
      warn(...args) { warnings.push(args.map(String).join(' ')); },
      error() {},
    },
    location: {
      origin: 'https://social.example',
      href: 'https://social.example/',
      host: 'social.example',
      protocol: 'https:',
      search: '',
    },
    navigator: { userAgent: 'test' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      currentScript: { src: 'https://social.example/usernode-bridge.js' },
      readyState: 'complete',
      head: { appendChild() {} },
      body: { appendChild() {} },
      getElementById: () => null,
      addEventListener() {},
      createElement: () => ({
        appendChild() {}, setAttribute() {}, addEventListener() {}, style: {},
      }),
      getElementsByTagName(tag) {
        return tag === 'iframe' ? childFrames.map((f) => f) : [];
      },
    },
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.push(listener);
    },
    removeEventListener() {},
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Promise,
    URL,
    URLSearchParams,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    fetch: async () => ({ ok: false }),
  };
  sandbox.window = sandbox;
  sandbox.parent = sandbox;
  sandbox.top = sandbox;
  sandbox.globalThis = sandbox;
  // The native channel. Its presence is what installs the relay listener.
  // The responses are the minimum the bridge needs to consider the channel
  // conclusive and a realm established — `getBridgeInfo` must advertise the
  // capabilities, or the probe reports "inconclusive" and nothing relays.
  const responses = {
    getBridgeInfo: {
      version: 5,
      capabilities: ['privilegedBridgeCapability', 'establishNativeSession', 'getWalletState'],
      sessionLifecycleProtocol: 2,
      appVersion: '0.4.0',
      buildNumber: '1223',
    },
    getPrivilegedBridgeCapability: 'navigation-capability',
    markPrivilegedBridgeReady: { ready: true },
    getWalletState: { address: 'ut1-wallet' },
    establishNativeSession: {
      protocol: 2,
      attemptId: ESTABLISH_ATTEMPT,
      nativeRevision: '7',
      identity: { participantId: '41', accountId: 'a1', address: 'ut1-wallet' },
      runtimeStatus: { state: 'running' },
      receiptStatus: 'committedReady',
      realmSessionClaim: 'realm-41',
    },
  };
  sandbox.Usernode = {
    postMessage(raw) {
      const request = JSON.parse(raw);
      nativePosts.push(request);
      const value = Object.prototype.hasOwnProperty.call(responses, request.method)
        ? responses[request.method] : null;
      sandbox.__usernodeResolve(request.id, value, null);
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(bridgeSource, sandbox, { filename: 'usernode-bridge.js' });

  return {
    sandbox,
    nativePosts,
    warnings,
    // Make `win` a direct child iframe of this document.
    asChildFrame(win) { childFrames.push({ contentWindow: win }); return win; },
    send(event) { for (const l of messageListeners) l(event); },
  };
}

// A stand-in for another window. Records what the relay sends back so a test
// can assert it received nothing at all.
function windowStub() {
  const received = [];
  return { received, postMessage(value, origin) { received.push({ value, origin }); } };
}

async function establish(relay) {
  return relay.sandbox.usernode.establishNativeSession({
    attemptId: ESTABLISH_ATTEMPT,
    desiredRuntime: 'running',
  });
}

// ── The vulnerability ──────────────────────────────────────────────────

test('a window that is not a child frame gets no discover-ack', () => {
  const relay = loadRelay();
  const attacker = windowStub();       // deliberately NOT registered

  relay.send({
    source: attacker,
    origin: 'https://evil.example',
    data: { __usernode_relay: 'discover' },
  });

  assert.equal(attacker.received.length, 0,
    'acking tells a nested third-party frame the relay is here and usable');
});

test('a window that is not a child frame cannot relay a request to native', async () => {
  const relay = loadRelay();
  await establish(relay);
  const before = relay.nativePosts.length;
  const attacker = windowStub();

  relay.send({
    source: attacker,
    origin: 'https://evil.example',
    data: {
      __usernode_relay: 'request', id: 'x', method: 'getWalletState', args: {},
    },
  });

  assert.equal(relay.nativePosts.length, before,
    'the request must never reach the native channel');
  assert.equal(attacker.received.length, 0, 'and it gets no answer either');
});

test('the refusal is logged, so it is diagnosable rather than silent', () => {
  const relay = loadRelay();
  relay.send({
    source: windowStub(),
    origin: 'https://evil.example',
    data: { __usernode_relay: 'discover' },
  });
  assert.ok(relay.warnings.some((w) => /child iframe/.test(w)),
    `expected a refusal warning, got ${JSON.stringify(relay.warnings)}`);
});

// ── The frames that SHOULD work still do ───────────────────────────────

test('a real child iframe still discovers and still relays', async () => {
  const relay = loadRelay();
  await establish(relay);
  const child = relay.asChildFrame(windowStub());

  relay.send({
    source: child,
    origin: 'https://child.example',
    data: { __usernode_relay: 'discover' },
  });
  assert.equal(child.received.length, 1, 'the ack is the handshake apps rely on');
  assert.equal(child.received[0].value.__usernode_relay, 'discover-ack');
  assert.equal(child.received[0].origin, 'https://child.example',
    'and it is addressed to that frame, not broadcast');

  const before = relay.nativePosts.length;
  relay.send({
    source: child,
    origin: 'https://child.example',
    data: {
      __usernode_relay: 'request', id: 'w1', method: 'getWalletState', args: {},
    },
  });
  assert.ok(relay.nativePosts.length > before, 'the request reaches native');
  assert.equal(relay.nativePosts[relay.nativePosts.length - 1].method, 'getWalletState');
});

// ── The limit, pinned so it is not mistaken for a boundary ─────────────

// This is the control that was BUILT, reviewed, and removed. Codex caught
// that the client half of the bridge auto-sends `discover` the moment it
// loads, so a document navigated into the frame does not have to defeat an
// origin pin — it re-pins by following the protocol. The test records the
// behaviour as it actually is, so the pin is not reintroduced on the belief
// that it closes the navigation case.
test('KNOWN LIMIT: a navigated document can still re-establish relay access', async () => {
  const relay = loadRelay();
  await establish(relay);
  const frame = relay.asChildFrame(windowStub());

  relay.send({
    source: frame, origin: 'https://app.example',
    data: { __usernode_relay: 'discover' },
  });
  // What the navigated document's own bridge does automatically on load.
  relay.send({
    source: frame, origin: 'https://attacker.example',
    data: { __usernode_relay: 'discover' },
  });

  const before = relay.nativePosts.length;
  relay.send({
    source: frame, origin: 'https://attacker.example',
    data: { __usernode_relay: 'request', id: 'z', method: 'getWalletState', args: {} },
  });

  assert.equal(relay.nativePosts.length, before + 1,
    'documented limit: closing this needs a parent-driven registration '
    + 'lifecycle, not an origin pin the child can reset');
});

// The direct-child gate is unaffected by any of that — a frame that was
// never a child of this document gets nothing, navigated or not.
test('the gate still holds for a window that is not a child frame', async () => {
  const relay = loadRelay();
  await establish(relay);
  const attacker = windowStub();
  const before = relay.nativePosts.length;

  relay.send({
    source: attacker, origin: 'https://app.example',
    data: { __usernode_relay: 'discover' },
  });
  relay.send({
    source: attacker, origin: 'https://app.example',
    data: { __usernode_relay: 'request', id: 'q', method: 'getWalletState', args: {} },
  });

  assert.equal(attacker.received.length, 0);
  assert.equal(relay.nativePosts.length, before);
});

// ── The shape, pinned in both copies ───────────────────────────────────

test('the relay gates on an owned child frame, in both bridge copies', () => {
  for (const file of ['public/usernode-bridge.js', 'public/usernode-bridge/v1/bridge.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(src, /function isOwnedChildFrame\(source\)/, `${file} missing the gate`);
    assert.match(src, /if \(!isOwnedChildFrame\(source\)\)/, `${file} does not call it`);
  }
});

test('isOwnedChildFrame fails closed without a usable document', () => {
  // A relay that cannot enumerate frames must refuse, never relay. Asserted
  // on the source because the branch is unreachable in a real browser.
  const src = fs.readFileSync(path.join(root, 'public', 'usernode-bridge.js'), 'utf8');
  const body = src.slice(
    src.indexOf('function isOwnedChildFrame(source)'),
    src.indexOf('function relayOriginFor(source)')
  );
  assert.match(body, /return false;/, 'the no-document path returns false');
  assert.doesNotMatch(body, /return true;\s*\n\s*}\s*$/,
    'it must not fall through to allowing');
});

test('the two bridge copies stay byte-identical', () => {
  // They are separately tracked files with the same blob today; a fix
  // applied to one and not the other is a fix that only half ships.
  assert.equal(
    fs.readFileSync(path.join(root, 'public', 'usernode-bridge.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'public', 'usernode-bridge', 'v1', 'bridge.js'), 'utf8'),
    'public/usernode-bridge.js and public/usernode-bridge/v1/bridge.js must match'
  );
});
