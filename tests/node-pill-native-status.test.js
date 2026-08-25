const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  // #1079 chunk B: same module, now inside the React bundle.
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'header', 'node-pill.js'),
  'utf8'
);

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function element({ hidden = false } = {}) {
  const classes = new Set(hidden ? ['hidden'] : []);
  const listeners = {};
  const children = [];
  let text = '';
  const attributes = {};
  const target = {
    className: '',
    classList: {
      contains(name) { return classes.has(name); },
      remove(name) { classes.delete(name); },
    },
    addEventListener(type, listener) { listeners[type] = listener; },
    appendChild(child) { children.push(child); },
    setAttribute(name, value) { attributes[name] = value; },
    children,
    attributes,
    listeners,
  };
  Object.defineProperty(target, 'textContent', {
    get() { return text; },
    set(value) {
      text = value;
      if (value === '') children.length = 0;
    },
  });
  return target;
}

function loadNodePill({
  hasNodeStatus,
  snapshot = null,
  isNative = true,
  withSheetBody = false,
}) {
  const row = element({ hidden: true });
  const dot = element();
  const status = element();
  const sheetBody = withSheetBody ? element() : null;
  const windowListeners = {};
  let statusReads = 0;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    NativeChrome: {
      has() { return hasNodeStatus; },
    },
    usernode: {
      isNative,
      async getNodeStatus() {
        statusReads += 1;
        return snapshot;
      },
    },
    document: {
      createElement() { return element(); },
      getElementById(id) {
        return {
          'drawer-row-node': row,
          'drawer-node-dot': dot,
          'drawer-node-status': status,
          'node-pill-sheet-body': sheetBody,
        }[id] || null;
      },
    },
    addEventListener(type, listener) { windowListeners[type] = listener; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  // The module used to end with `NodePill.init()`. It is initialised from the
  // island's layout effect now (so the `hidden` it lifts off #drawer-row-node
  // lands after hydration), which makes the call this harness's job.
  sandbox.window.NodePill.init();
  return {
    row,
    dot,
    status,
    sheetBody,
    get statusReads() { return statusReads; },
    networkHeightFor(detail) {
      return sandbox.window.NodePill._networkHeightFor(detail);
    },
    readyPeersFor(detail) {
      return sandbox.window.NodePill._readyPeersFor(detail);
    },
    tipAgeFor(detail, nowMs) {
      return sandbox.window.NodePill._tipAgeFor(detail, nowMs);
    },
    warningMessagesFor(detail) {
      return Array.from(sandbox.window.NodePill._warningMessagesFor(detail));
    },
    dispatchNodeStatus(detail) {
      if (windowListeners['usernode:node-status']) {
        windowListeners['usernode:node-status']({ detail });
      }
    },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('successful capability probe reveals and populates the Node row',
  async () => {
    const loaded = loadNodePill({
      hasNodeStatus: Promise.resolve(true),
      snapshot: { status: 'synced' },
    });

    await settle();

    assert.equal(loaded.row.classList.contains('hidden'), false);
    assert.equal(loaded.status.textContent, 'Synced');
    assert.equal(loaded.statusReads, 1);
    assert.equal(typeof loaded.row.listeners.click, 'function');
  });

test('native status event reveals the row while the first probe is inconclusive',
  async () => {
    const probe = deferred();
    const loaded = loadNodePill({ hasNodeStatus: probe.promise });

    loaded.dispatchNodeStatus({ status: 'syncing' });

    assert.equal(loaded.row.classList.contains('hidden'), false);
    assert.equal(loaded.status.textContent, 'Syncing');
    assert.equal(loaded.statusReads, 0);

    probe.resolve(false);
    await settle();
    assert.equal(loaded.row.classList.contains('hidden'), false,
      'a degraded probe must not undo native event evidence');
  });

test('unsupported native builds keep the Node row present',
  async () => {
    const loaded = loadNodePill({
      hasNodeStatus: Promise.resolve(false),
    });

    await settle();

    assert.equal(loaded.row.classList.contains('hidden'), false);
    assert.equal(loaded.statusReads, 0);
    assert.equal(loaded.status.textContent, 'Unavailable');

    loaded.dispatchNodeStatus(null);
    loaded.dispatchNodeStatus({});
    assert.equal(loaded.row.classList.contains('hidden'), false,
      'temporary or malformed state must not rewrite native navigation');
  });

test('desktop keeps the native-only Node row hidden', async () => {
  const loaded = loadNodePill({
    hasNodeStatus: Promise.resolve(false),
    isNative: false,
  });

  await settle();

  assert.equal(loaded.row.classList.contains('hidden'), true);
  assert.equal(loaded.statusReads, 0);
  });

test('Network block height follows the node sync state', async () => {
  const loaded = loadNodePill({ hasNodeStatus: Promise.resolve(false) });
  await settle();

  assert.equal(loaded.networkHeightFor({
    status: 'synced',
    localBestHeight: 120,
    networkBestHeight: 130,
  }), 120, 'a synced node uses its own best tip');
  assert.equal(loaded.networkHeightFor({
    status: 'syncing',
    localBestHeight: 120,
    networkBestHeight: 130,
  }), 130, 'a syncing node uses its target best tip');
});

test('ready peers use the explicit field with legacy fallback', async () => {
  const loaded = loadNodePill({ hasNodeStatus: Promise.resolve(false) });
  await settle();

  assert.equal(loaded.readyPeersFor({
    readyPeers: 4,
    connectedPeers: 3,
  }), 4);
  assert.equal(loaded.readyPeersFor({ connectedPeers: 3 }), 3);
});

test('best-tip age is corrected for node clock drift', async () => {
  const loaded = loadNodePill({ hasNodeStatus: Promise.resolve(false) });
  await settle();

  assert.equal(loaded.tipAgeFor({
    localBestTimestampMs: 100000,
    clockDriftMs: 2000,
  }, 120000), '18 seconds ago');
  assert.equal(loaded.tipAgeFor({
    localBestTimestampMs: 100000,
  }, 220000), '2 minutes ago');
});

test('node warnings are conditional and ordered', async () => {
  const loaded = loadNodePill({ hasNodeStatus: Promise.resolve(false) });
  await settle();

  assert.deepEqual(loaded.warningMessagesFor({
    readyPeers: 0,
    syncStalled: true,
    clockDriftMs: -6000,
    walletDataHydrating: true,
  }), [
    'No connected peers.',
    'Sync appears stalled.',
    'Node clock is out of sync.',
    'Wallet-data hydration is still running.',
  ]);
  assert.deepEqual(loaded.warningMessagesFor({
    readyPeers: 2,
    syncStalled: false,
    clockDriftMs: 5000,
    walletDataHydrating: false,
  }), []);
});

test('Node sheet puts chain first and labels ready peers', async () => {
  const loaded = loadNodePill({
    hasNodeStatus: Promise.resolve(false),
    withSheetBody: true,
  });
  await settle();

  loaded.dispatchNodeStatus({
    status: 'syncing',
    chain: 'testnet',
    localBestHeight: 120,
    networkBestHeight: 130,
    readyPeers: 4,
    totalPeers: 7,
    syncStalled: true,
  });

  const rows = loaded.sheetBody.children;
  assert.equal(rows[1].children[0].textContent, 'Chain');
  assert.equal(rows[1].children[1].textContent, 'testnet');
  assert.equal(rows[2].children[0].textContent, 'Your block height');
  assert.equal(rows[2].children[1].textContent, '120');
  assert.equal(rows[3].children[1].textContent, '130');
  assert.equal(rows[4].children[1].textContent, '4 ready / 7 known');
  assert.equal(rows[5].attributes.role, 'status');
  assert.equal(
    rows[5].children[0].children[0].children[1].textContent,
    'Sync appears stalled.'
  );
});
