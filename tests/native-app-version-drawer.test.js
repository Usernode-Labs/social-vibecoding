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
const menuSource = fs.readFileSync(
  path.join(root, 'frontend/src/features/header/header-menu.tsx'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

function element({ hidden = false } = {}) {
  const classes = new Set(hidden ? ['hidden'] : []);
  return {
    textContent: '',
    classList: {
      contains(name) { return classes.has(name); },
      remove(name) { classes.delete(name); },
    },
  };
}

function loadRenderer({
  isNative = true,
  settingsSupported = true,
  bridgeInfos = [],
  snapshots = [],
} = {}) {
  const row = element({ hidden: true });
  const slot = element();
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
    document: {
      getElementById(id) {
        return {
          'drawer-row-native-app-version': row,
          'native-app-version-slot': slot,
        }[id] || null;
      },
    },
    addEventListener(type, listener) {
      (listeners[type] ||= []).push(listener);
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  sandbox.NativeAppVersion.init();

  return {
    row,
    slot,
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
  assert.match(menuSource, /import '\.\/native-app-version\.js'/);
  assert.match(menuSource, /window\.NativeAppVersion\?\.init\(\)/,
    'layout-effect init prevents a pre-hydration class/text mutation');
});

test('the footer separates the mobile app version from the platform version', () => {
  const revisionAt = html.indexOf('id="drawer-row-platform-version"');
  const versionAt = html.indexOf('id="drawer-row-native-app-version"');
  const forkAt = html.indexOf('id="drawer-row-app-fork"');
  assert.ok(revisionAt > -1 && versionAt > revisionAt && forkAt > versionAt,
    'footer order is platform version → mobile app version → optional fork lineage');
  assert.match(html.slice(revisionAt, versionAt), /Platform version/);
  assert.match(html.slice(versionAt, forkAt), /Mobile app version/);
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

  loaded.dispatch('usernode:header-menu-open');
  await settle();
  assert.equal(loaded.slot.textContent, '0.4.0/1223');
  assert.equal(loaded.row.classList.contains('hidden'), false);
  assert.equal(loaded.infoReads, 2);
  assert.equal(loaded.settingsReads, 0);

  loaded.dispatch('usernode:header-menu-open');
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
  assert.match(source, /slot\.textContent = value/);
  assert.doesNotMatch(source, /slot\.innerHTML/);
});
