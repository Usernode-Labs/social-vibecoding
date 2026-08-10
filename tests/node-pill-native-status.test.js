const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'node-pill.js'),
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
  return {
    className: '',
    textContent: '',
    classList: {
      contains(name) { return classes.has(name); },
      remove(name) { classes.delete(name); },
    },
    addEventListener(type, listener) { listeners[type] = listener; },
    listeners,
  };
}

function loadNodePill({ hasNodeStatus, snapshot = null }) {
  const row = element({ hidden: true });
  const dot = element();
  const status = element();
  const windowListeners = {};
  let statusReads = 0;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    NativeChrome: {
      has() { return hasNodeStatus; },
    },
    usernode: {
      async getNodeStatus() {
        statusReads += 1;
        return snapshot;
      },
    },
    document: {
      getElementById(id) {
        return {
          'drawer-row-node': row,
          'drawer-node-dot': dot,
          'drawer-node-status': status,
        }[id] || null;
      },
    },
    addEventListener(type, listener) { windowListeners[type] = listener; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    row,
    dot,
    status,
    get statusReads() { return statusReads; },
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

test('unsupported builds and desktop stay hidden without a native event',
  async () => {
    const loaded = loadNodePill({
      hasNodeStatus: Promise.resolve(false),
    });

    await settle();

    assert.equal(loaded.row.classList.contains('hidden'), true);
    assert.equal(loaded.statusReads, 0);

    loaded.dispatchNodeStatus(null);
    loaded.dispatchNodeStatus({});
    assert.equal(loaded.row.classList.contains('hidden'), true,
      'malformed page events are not evidence of native node support');
  });
