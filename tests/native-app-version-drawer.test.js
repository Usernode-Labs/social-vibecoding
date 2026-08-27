// #1101: the hamburger footer requests the installed Flutter app's
// version/build (for example 0.4.0/1223), distinguishes the platform version, and
// never substitutes the currently-open dApp SHA.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'frontend/src/features/header/native-app-version.js'), 'utf8');
// The bundle's boot seam. It rode on the hamburger island for as long as
// there was one; ./platform-header.tsx is earlier and never unmounts, so the
// imports and inits live there.
const menuSource = fs.readFileSync(
  path.join(root, 'frontend/src/features/header/platform-header.tsx'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

// ONE bundle per process, deliberately: each `loadTsx` entry is its own
// bundle, so a second would hand this file a different `nativeAppVersionStore`
// from the one the component subscribes to.
let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/native-app-version-api.ts')));

/**
 * The row as the browser would draw it, from the store the module just wrote.
 *
 * This used to be a DOM stub whose `textContent` and `classList` the module
 * assigned directly. The module publishes now and the component renders, so
 * the same two assertions read the REAL markup instead of a fake node — which
 * is strictly more than they checked before: a component that forgot the id,
 * or escaped nothing, would now fail them.
 */
function rendered() {
  const html = renderToHtml(createElement(mod().NativeAppVersionRow, {}));
  const raw = (html.match(/id="native-app-version-slot"[^>]*>([^<]*)</) || [, ''])[1];
  // Decode, so `slot.textContent` below keeps meaning textContent. The RAW
  // form is asserted separately — that is where the escaping shows.
  const slotText = raw
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  const rowClass = (html.match(/id="drawer-row-native-app-version"[^>]*class="([^"]*)"/) || [, ''])[1];
  return {
    html,
    rawSlot: raw,
    slot: { textContent: slotText },
    row: { classList: { contains: (name) => rowClass.split(/\s+/).includes(name) } },
  };
}

function loadRenderer({
  isNative = true,
  settingsSupported = true,
  bridgeInfos = [],
  snapshots = [],
} = {}) {
  const listeners = {};
  let infoReads = 0;
  let settingsReads = 0;
  let infoIndex = 0;
  let snapshotIndex = 0;

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    NativeChrome: {
      async getInfo() {
        infoReads += 1;
        if (bridgeInfos.length) {
          const at = Math.min(infoIndex, bridgeInfos.length - 1);
          infoIndex += 1;
          return bridgeInfos[at];
        }
        return {
          version: 4,
          capabilities: settingsSupported ? ['getSettingsState'] : [],
        };
      },
    },
    usernode: {
      isNative,
      async getSettingsState() {
        settingsReads += 1;
        const at = Math.min(snapshotIndex, Math.max(0, snapshots.length - 1));
        snapshotIndex += 1;
        return snapshots.length ? snapshots[at] : null;
      },
    },
    addEventListener(type, listener) {
      (listeners[type] ||= []).push(listener);
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // The module is an ordinary bundle module now (./platform-header.tsx imports it)
  // and pulls its store in by name. Bind the REAL store into the sandbox and
  // drop the import line, so the module body evaluates as a script exactly as
  // it did — same technique as tests/challenge-template-prefill.test.js.
  mod().nativeAppVersionStore.set({ value: '' });
  sandbox.nativeAppVersionStore = mod().nativeAppVersionStore;
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/^import[^\n]*\n/m, ''), sandbox);
  sandbox.NativeAppVersion.init();

  return {
    get row() { return rendered().row; },
    get slot() { return rendered().slot; },
    get rawSlot() { return rendered().rawSlot; },
    get html() { return rendered().html; },
    get infoReads() { return infoReads; },
    get settingsReads() { return settingsReads; },
    dispatch(type, detail) {
      for (const listener of listeners[type] || []) listener({ detail });
    },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('the drawer island imports and initializes the native version renderer after hydration', () => {
  // THE UI OVERHAUL moved the ROW into the Improve panel's footer — it is
  // reference information about the platform — but the import and the init
  // stay on the HEADER BAR's island. It is the first island in the shell and
  // it never unmounts, and the renderer is a side-effect module that has to
  // install window.NativeAppVersion before app.js's own init looks for it;
  // hanging it off a surface that may never be opened would be a boot-order
  // regression dressed up as tidiness.
  assert.match(menuSource, /import '\.\/native-app-version\.js'/);
  assert.match(menuSource, /window\.NativeAppVersion\?\.init\(\)/,
    'layout-effect init prevents a pre-hydration class/text mutation');
});

test("the Improve panel's footer separates the mobile app version from the platform version", () => {
  // Settings' About block, not a drawer footer: the two rows that describe the
  // PLATFORM outlived the app-scoped block they were passing through, and the
  // fork line that used to follow them went to the app's own page instead.
  const aboutAt = html.indexOf('id="improve-footer"');
  assert.ok(aboutAt > -1, 'the Improve panel has its reference footer');
  const revisionAt = html.indexOf('id="drawer-row-platform-version"');
  assert.ok(revisionAt > aboutAt, 'the version rows live inside it');
  const versionAt = html.indexOf('id="drawer-row-native-app-version"');
  assert.ok(versionAt > revisionAt,
    'About order is platform version → mobile app version');
  assert.match(html.slice(revisionAt, versionAt), /Platform version/);
  assert.match(html.slice(versionAt), /Mobile app version/);
  assert.doesNotMatch(html, /drawer-row-app-version|app-version-pill-slot|dApp version/,
    'no particular dApp SHA appears in platform information');
});

test('public bridge info renders the installed Flutter version/build', async () => {
  const loaded = loadRenderer({
    bridgeInfos: [{
      version: 4,
      capabilities: ['getSettingsState'],
      appVersion: '0.4.0',
      buildNumber: '1223',
    }],
  });
  await settle();

  assert.equal(loaded.slot.textContent, '0.4.0/1223');
  assert.equal(loaded.row.classList.contains('hidden'), false);
  assert.equal(loaded.infoReads, 1);
  assert.equal(loaded.settingsReads, 0,
    'the public probe avoids a privileged settings read');
});

test('a missing build number falls back to the semantic version alone', async () => {
  const loaded = loadRenderer({
    bridgeInfos: [{
      version: 4,
      capabilities: [],
      appVersion: '0.4.0',
      buildNumber: '',
    }],
  });
  await settle();
  assert.equal(loaded.slot.textContent, '0.4.0');
  assert.equal(loaded.row.classList.contains('hidden'), false);
});

test('existing app builds fall back to their settings snapshot', async () => {
  const loaded = loadRenderer({
    snapshots: [{ buildInfo: { appVersion: '0.4.0', buildNumber: '1223' } }],
  });
  await settle();

  assert.equal(loaded.slot.textContent, '0.4.0/1223');
  assert.equal(loaded.row.classList.contains('hidden'), false);
  assert.equal(loaded.infoReads, 1);
  assert.equal(loaded.settingsReads, 1);
});

test('browser and unsupported native builds keep the device-only row hidden', async () => {
  const desktop = loadRenderer({ isNative: false });
  const oldNative = loadRenderer({ settingsSupported: false });
  await settle();

  assert.equal(desktop.row.classList.contains('hidden'), true);
  assert.equal(desktop.infoReads, 0);
  assert.equal(desktop.settingsReads, 0);
  assert.equal(oldNative.row.classList.contains('hidden'), true);
  assert.equal(oldNative.settingsReads, 0);
});

test('an inconclusive bridge probe retries on drawer open and caches success', async () => {
  const loaded = loadRenderer({
    bridgeInfos: [
      { version: 0, capabilities: [], degraded: true },
      {
        version: 4,
        capabilities: ['getSettingsState'],
        appVersion: '0.4.0',
        buildNumber: 1223,
      },
    ],
  });
  await settle();
  assert.equal(loaded.row.classList.contains('hidden'), true);

  loaded.dispatch('usernode:settings-section');
  await settle();
  assert.equal(loaded.slot.textContent, '0.4.0/1223');
  assert.equal(loaded.row.classList.contains('hidden'), false);
  assert.equal(loaded.infoReads, 2);
  assert.equal(loaded.settingsReads, 0);

  loaded.dispatch('usernode:settings-section');
  await settle();
  assert.equal(loaded.infoReads, 2, 'a successful device-local read is reused');
});

test('native values are assigned as text and bounded before rendering', async () => {
  const longBuild = '1'.repeat(80);
  const loaded = loadRenderer({
    bridgeInfos: [{
      version: 4,
      capabilities: [],
      appVersion: '<img src=x onerror=alert(1)>',
      buildNumber: longBuild,
    }],
  });
  await settle();

  assert.equal(loaded.slot.textContent,
    '<img src=x onerror=alert(1)>/' + '1'.repeat(50));

  // The property this test is really about, now proven on RENDERED OUTPUT
  // rather than by grepping the writer for `.innerHTML`. The module used
  // `textContent`; the component renders a text CHILD, and React escapes those
  // — so a malformed native producer reaches the document inert either way.
  assert.equal(loaded.rawSlot,
    '&lt;img src=x onerror=alert(1)&gt;/' + '1'.repeat(50));
  assert.doesNotMatch(loaded.html, /<img/);
  const rowSrc = fs.readFileSync(
    path.join(root, 'frontend/src/features/header/native-app-version-row.tsx'), 'utf8');
  // The CODE form, not the word: the component's own comment explains why it
  // does not use this sink, and prose about a sink is not a sink. Same
  // convention as tests/admin-ui-registry.test.js's `code()`.
  assert.doesNotMatch(rowSrc, /dangerouslySetInnerHTML=/);
  // And the module no longer writes the node at all — it publishes.
  assert.doesNotMatch(source, /slot\.textContent|row\.classList/);
  assert.match(source, /nativeAppVersionStore\.set\(/);
});
