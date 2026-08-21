// The bridge's offline-capability announcement (#487 follow-up).
//
// The shell cannot see into an app's origin, so while offline it used to
// refuse to mount ANY app frame — an app that had precached its own shell
// on its own subdomain got "This app needs a connection — reconnect to open
// it." exactly like one that had never registered a worker. This block is
// the one fact that makes the difference sayable: a service worker is
// CONTROLLING this document, so reloading it with no network will be served
// from that worker's cache.
//
// The shell half (remembering it per slug, and mounting the frame offline
// for those apps) is pinned in tests/app-frame-identity.test.js. This file
// covers the announcement itself, by extracting the self-contained IIFE
// between the __USERNODE_OFFLINE_READY_BEGIN__ / _END__ markers and running
// it in a fake-window sandbox — the same regex-extraction style as
// tests/usernode-issue-state.test.js.
//
// Run with: node --test tests/app-offline-capable.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const versioned = path.join(root, 'public', 'usernode-bridge', 'v1', 'bridge.js');
const unversioned = path.join(root, 'public', 'usernode-bridge.js');

function extractBlock(src) {
  const begin = src.indexOf('/* __USERNODE_OFFLINE_READY_BEGIN__ */');
  const end = src.indexOf('/* __USERNODE_OFFLINE_READY_END__ */');
  assert.ok(begin !== -1 && end !== -1 && end > begin, 'offline-ready block markers present');
  return src.slice(begin, end);
}

// `topLevel` drops the parent (a bare app subdomain, or the shell itself);
// `noSw` removes navigator.serviceWorker (an insecure or restricted context).
function run({ controller = null, topLevel = false, noSw = false } = {}) {
  const posted = [];
  const swListeners = {};
  const parent = { postMessage: (msg) => posted.push(msg) };
  const sandbox = {
    navigator: noSw ? {} : {
      serviceWorker: {
        controller,
        addEventListener(type, fn) { (swListeners[type] ||= []).push(fn); },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.parent = topLevel ? sandbox : parent;
  vm.createContext(sandbox);
  vm.runInContext(extractBlock(fs.readFileSync(versioned, 'utf8')), sandbox);
  return {
    // The message objects are built inside the vm and carry that realm's
    // prototype, so assertions compare the announced KINDS, not the objects.
    kinds: () => posted.map((m) => m.__usernode_offline_ready),
    // Simulate the worker taking control after this document loaded.
    controllerChange(next) {
      if (!noSw) sandbox.navigator.serviceWorker.controller = next;
      for (const fn of swListeners.controllerchange || []) fn();
    },
  };
}

test('a controlled app document announces itself as offline-ready', () => {
  const h = run({ controller: { scriptURL: '/sw.js' } });
  assert.deepEqual(h.kinds(), ['ready']);
});

test('an uncontrolled document says so, and corrects itself when the worker claims it', () => {
  // The realistic first-ever visit: the app calls register() on load, so the
  // worker only activates and claims AFTER this script has already run.
  const h = run({ controller: null });
  assert.deepEqual(h.kinds(), ['not-ready'], 'honest before the worker is in charge');

  h.controllerChange({ scriptURL: '/sw.js' });
  assert.deepEqual(h.kinds(), ['not-ready', 'ready'], 'and upgraded the moment it is');
});

test('an app that loses its worker withdraws the claim', () => {
  const h = run({ controller: { scriptURL: '/sw.js' } });
  h.controllerChange(null);
  assert.deepEqual(h.kinds(), ['ready', 'not-ready'],
    'both directions are announced, so the shell stops opening it offline');
});

test('a top-level page announces nothing — there is no shell to tell', () => {
  const h = run({ controller: { scriptURL: '/sw.js' }, topLevel: true });
  assert.deepEqual(h.kinds(), [], 'the platform shell and bare app subdomains stay silent');
});

test('a context with no service-worker API is silent rather than throwing', () => {
  const h = run({ noSw: true });
  assert.deepEqual(h.kinds(), [], 'nothing announced, and no exception escaped the bridge');
});

test('both hosted bridge copies carry the block', () => {
  for (const p of [versioned, unversioned]) {
    const src = fs.readFileSync(p, 'utf8');
    assert.match(src, /__USERNODE_OFFLINE_READY_BEGIN__/, `${path.basename(p)} has the block`);
    assert.match(src, /__USERNODE_OFFLINE_READY_END__/, `${path.basename(p)} closes the block`);
  }
});

// ── The checks that shipped broken with #1356 ────────────────────────────
//
// Both named a real app slug and asserted on the App tab. The checks
// environment has no guarantee of a running app with a live origin behind
// the preview, so renderAppTab reached neither branch and BOTH failed —
// blocking every later proposal, since checks gate merge. They are served
// by self-contained ?shot= states now; this keeps them that way.
test('the offline-app checks do not depend on a real running app', () => {
  const dapp = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));
  const offlineAppChecks = (dapp.tests || []).filter(
    (t) => typeof t.path === 'string' && /shot=offline-app/.test(t.path),
  );
  assert.equal(offlineAppChecks.length, 2, 'both offline-app checks are present');
  for (const t of offlineAppChecks) {
    assert.doesNotMatch(t.path, /#app\//,
      `"${t.name}" must not route to a real app's tab — it cannot render in checks`);
  }
  // And the states they rely on are actually wired up.
  const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const view = fs.readFileSync(path.join(root, 'public', 'js', 'app-view.js'), 'utf8');
  assert.match(app, /_applyOfflineAppShot\(\)/, 'the shot handler is called from init');
  assert.match(view, /showOfflineAppShot\(ready\)/, 'and paints through app-view');
});

// ── The contract generated apps are told about ──────────────────────────
//
// The shell half of this is invisible from inside an app: an author has no
// way to discover that loading the bridge plus registering a worker is what
// buys an offline launch, or that an offline load arrives with no token.
// Todo List shipped a complete offline layer AND no bridge tag, which is
// precisely the gap an undocumented capability produces. Same guard shape as
// tests/app-conventions-shutdown.test.js.
const CONVENTIONS = fs.readFileSync(
  path.join(root, 'src', 'prompts', 'app-conventions.md'), 'utf8',
);

function conventionsSection(heading) {
  const start = CONVENTIONS.indexOf(`\n## ${heading}\n`);
  assert.notStrictEqual(start, -1, `missing "## ${heading}" section`);
  const next = CONVENTIONS.indexOf('\n## ', start + heading.length + 5);
  return CONVENTIONS.slice(start, next === -1 ? CONVENTIONS.length : next);
}

test('the conventions document the offline-launch contract', () => {
  const s = conventionsSection('Offline — apps that open with no connection');
  assert.match(s, /navigator\.serviceWorker\.controller/,
    'names the signal the shell actually reads');
  assert.match(s, /bridge/i, 'and that the bridge tag is required to announce it');
  assert.match(s, /token/i, 'an offline load carries no token — apps must expect that');
});

test('the essentials say the bridge tag is unconditional', () => {
  // This one is extracted into every work order, so it is the copy an agent
  // building a new app is most likely to be reading.
  const essentials = conventionsSection('Essentials — the offline excerpt');
  assert.match(essentials, /bridge tag is not conditional/i,
    'an app that calls no bridge API still has to load it');
});
