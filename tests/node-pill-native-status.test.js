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

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

// ONE bundle per process: a second `loadTsx` entry would hand this file a
// different `nodePillStore` from the one the components subscribe to.
let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/node-pill-api.ts')));

/**
 * The row as the browser draws it, from the store the module just published.
 *
 * These were DOM stubs whose `className` and `textContent` the module wrote
 * directly. It publishes now and the component renders, so the same
 * assertions read REAL markup — which also means a component that dropped an
 * id, or emitted a computed class Tailwind never compiled, would fail them.
 */
function rowParts() {
  const html = renderToHtml(createElement(mod().NodePillRow, {}));
  const cls = (id) => (html.match(new RegExp(`id="${id}"[^>]*class="([^"]*)"`)) || [, ''])[1];
  const text = (id) => (html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`)) || [, ''])[1];
  const has = (id, name) => cls(id).split(/\s+/).includes(name);
  return {
    html,
    row: { className: cls('drawer-row-node'), classList: { contains: (n) => has('drawer-row-node', n) } },
    dot: { className: cls('drawer-node-dot'), classList: { contains: (n) => has('drawer-node-dot', n) } },
    status: { className: cls('drawer-node-status'), textContent: text('drawer-node-status') },
  };
}

/** The detail sheet's body, likewise — it reads the same store. */
function sheetHtml() {
  return renderToHtml(createElement(mod().NodeSheetBody, {}));
}

function loadNodePill({ hasNodeStatus, snapshot = null, isNative = true }) {
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
    addEventListener(type, listener) { windowListeners[type] = listener; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // The module is an ordinary bundle module and pulls its store and its two
  // portal helpers in by name. Bind the REAL store, stub the portal helpers
  // (the sheet's kit hand-off needs a browser), and drop the import lines so
  // the body evaluates as a script exactly as it did — same technique as
  // tests/challenge-template-prefill.test.js.
  mod().nodePillStore.set({ ...mod().NODE_PILL_EMPTY });
  sandbox.nodePillStore = mod().nodePillStore;
  sandbox.NODE_PILL_EMPTY = mod().NODE_PILL_EMPTY;
  sandbox.mountNodeSheet = () => {};
  sandbox.unmountNodeSheet = () => {};
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/^import[^\n]*\n/gm, ''), sandbox);
  // The module used to end with `NodePill.init()`. It is initialised from the
  // island's layout effect now (so the `hidden` it lifts off #drawer-row-node
  // lands after hydration), which makes the call this harness's job.
  sandbox.window.NodePill.init();
  return {
    get row() { return rowParts().row; },
    get dot() { return rowParts().dot; },
    get status() { return rowParts().status; },
    get sheetHtml() { return sheetHtml(); },
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
    // The row's click was an addEventListener on the element; it is the
    // component's onClick now, dispatching into a named module function.
    const rowSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src',
      'features', 'header', 'node-pill-row.tsx'), 'utf8');
    assert.match(rowSrc, /onClick=\{\(\) => controller\(\)\?\.openFromRow\?\.\(\)\}/);
    assert.match(source, /\n    openFromRow\(\) \{/);
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

// #1079: the detail sheet's body was six nodes built imperatively and blanked
// with `body.textContent = ''` on every status event. It reads the same store
// the row does now, which is the point — the two surfaces cannot disagree.
test('the detail sheet renders from the same status the row does', () => {
  const loaded = loadNodePill({
    hasNodeStatus: true,
    snapshot: {
      status: 'syncing',
      localBestHeight: 1234,
      networkBestHeight: 5678,
      connectedPeers: 8,
      totalPeers: 42,
    },
  });
  loaded.dispatchNodeStatus({
    status: 'syncing',
    localBestHeight: 1234,
    networkBestHeight: 5678,
    connectedPeers: 8,
    totalPeers: 42,
  });
  const html = loaded.sheetHtml;
  assert.match(html, /Syncing/);
  assert.match(html, /Your block height/);
  assert.match(html, /1,234/);
  assert.match(html, /Network block height/);
  assert.match(html, /5,678/);
  assert.match(html, /8 connected \/ 42 known/);
  // The row agrees, from the same publish.
  assert.equal(loaded.status.textContent, 'Syncing');
});

test('unknown numbers render an em dash, never a zero', () => {
  const loaded = loadNodePill({ hasNodeStatus: true, snapshot: null });
  loaded.dispatchNodeStatus({ status: 'offline' });
  const html = loaded.sheetHtml;
  // An unknown height and a height of zero are different facts.
  assert.doesNotMatch(html, />0</);
  assert.equal((html.match(/—/g) || []).length, 3, 'three unknown figures');
  assert.match(html, /Offline/);
});
