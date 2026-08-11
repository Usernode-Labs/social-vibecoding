// #1101: the hamburger footer displays the installed Usernode application
// version/build (for example 0.4.0/1223) without confusing it with either the
// deployed web platform SHA or the currently-open dApp SHA.

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
  supported = true,
  snapshots = [],
} = {}) {
  const row = element({ hidden: true });
  const slot = element();
  const listeners = {};
  let capabilityReads = 0;
  let settingsReads = 0;
  let snapshotIndex = 0;

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    NativeChrome: {
      async has(capability) {
        capabilityReads += 1;
        assert.equal(capability, 'getSettingsState');
        return supported;
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
    get capabilityReads() { return capabilityReads; },
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

test('the footer reserves distinct platform, native app, and dApp rows', () => {
  const platformAt = html.indexOf('id="drawer-row-platform-version"');
  const nativeAt = html.indexOf('id="drawer-row-native-app-version"');
  const dappAt = html.indexOf('id="drawer-row-app-version"');
  assert.ok(platformAt > -1 && nativeAt > platformAt && dappAt > nativeAt,
    'footer order is platform → installed app → opened dApp');
  assert.match(html.slice(nativeAt, dappAt), /App version/);
  assert.match(html.slice(dappAt, html.indexOf('id="drawer-row-app-fork"')), /dApp version/);
});

test('a native settings snapshot renders the requested version/build format', async () => {
  const loaded = loadRenderer({
    snapshots: [{ buildInfo: { appVersion: '0.4.0', buildNumber: '1223' } }],
  });
  await settle();

  assert.equal(loaded.slot.textContent, '0.4.0/1223');
  assert.equal(loaded.row.classList.contains('hidden'), false);
  assert.equal(loaded.capabilityReads, 1);
  assert.equal(loaded.settingsReads, 1);
});

test('a missing build number falls back to the semantic version alone', async () => {
  const loaded = loadRenderer({
    snapshots: [{ buildInfo: { appVersion: '0.4.0', buildNumber: '' } }],
  });
  await settle();
  assert.equal(loaded.slot.textContent, '0.4.0');
  assert.equal(loaded.row.classList.contains('hidden'), false);
});

test('desktop and unsupported native builds keep the device-only row hidden', async () => {
  const desktop = loadRenderer({ isNative: false });
  const oldNative = loadRenderer({ supported: false });
  await settle();

  assert.equal(desktop.row.classList.contains('hidden'), true);
  assert.equal(desktop.capabilityReads, 0);
  assert.equal(desktop.settingsReads, 0);
  assert.equal(oldNative.row.classList.contains('hidden'), true);
  assert.equal(oldNative.settingsReads, 0);
});

test('an inconclusive cold read retries on drawer open and caches success', async () => {
  const loaded = loadRenderer({
    snapshots: [
      null,
      { buildInfo: { appVersion: '0.4.0', buildNumber: 1223 } },
    ],
  });
  await settle();
  assert.equal(loaded.row.classList.contains('hidden'), true);

  loaded.dispatch('usernode:header-menu-open');
  await settle();
  assert.equal(loaded.slot.textContent, '0.4.0/1223');
  assert.equal(loaded.row.classList.contains('hidden'), false);
  assert.equal(loaded.settingsReads, 2);

  loaded.dispatch('usernode:header-menu-open');
  await settle();
  assert.equal(loaded.settingsReads, 2, 'a successful device-local read is reused');
});

test('native values are assigned as text and bounded before rendering', async () => {
  const longBuild = '1'.repeat(80);
  const loaded = loadRenderer({
    snapshots: [{
      buildInfo: {
        appVersion: '<img src=x onerror=alert(1)>',
        buildNumber: longBuild,
      },
    }],
  });
  await settle();

  assert.equal(loaded.slot.textContent,
    '<img src=x onerror=alert(1)>/' + '1'.repeat(50));
  assert.match(source, /slot\.textContent = value/);
  assert.doesNotMatch(source, /slot\.innerHTML/);
});
