// Apps that bring their own service worker, on the first open of their frame
// (frontend/src/features/app-frame/app-frame-bridge.js `prime`, the
// __USERNODE_OFFLINE_READY block of the bridge, AppView.handleOfflineReadyMessage).
//
// Measured by hand on 2 Nov 2026, iPhone 17 simulator, iOS 26.4, production
// Homeroom build, Todo List (todo-list-b91765):
//   * every NEW app frame loaded past the app's own worker: `controller` null,
//     `workerStart` 0, WebKit's log "startWithServiceWorker" straight to
//     "Going to the network", while `getRegistration()` had an activated
//     worker. Not only the first open after a launch: a frame unmounted and
//     mounted again in the same launch did it too, and a kept frame hid it.
//   * the cause is the pending sandbox. Probe frames: made with the app
//     sandbox, or none, were controlled; made with `sandbox=""` and switched
//     to the app sandbox before `src` (what the shell does), even 200 ms
//     before, were not. WebKit reads the sandbox of the document the frame
//     holds when it decides whether a worker may answer.
//   * loading an empty data: document under the app sandbox first (4-13 ms),
//     then `src`, was controlled; without waiting for that document, not.
//     Neither WebKit nor Chromium added a history entry for it, and with the
//     load stopped in the capture phase the frame's own onload and listeners
//     saw only the app's load.
//   * so offline, with today's code, Todo List could not open at all: every
//     online open said "not-ready" and dropped its flag, and had the flag
//     survived, the frame's first load would have gone to a network that is
//     not there.
//
// What runs here is Homeroom's half: the real frame bridge over the real
// store with a fake element, the bridge block in a vm, and the shell's
// AppView handler against stub storage.
//
// Run with: node --test tests/app-own-worker-first-open.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const moduleUrl = (p) => new URL(`../${p}`, `file://${__filename}`).href;

const SLUG = 'todo-list';
const APP_URL = 'https://todo-list.apps.example/?token=tok1&un-theme=light';
const PRIMER = 'data:text/html,';

// ── The frame ────────────────────────────────────────────────────────────

// A document that dispatches `load` the way a browser does for an iframe:
// capture listeners on the document first, then, unless one stopped it, the
// element's own `onload` and listeners.
function fakeDocument() {
  const capture = new Set();
  return {
    defaultView: { location: { origin: 'https://platform.example' } },
    capture,
    addEventListener(type, fn, useCapture) { if (type === 'load' && useCapture) capture.add(fn); },
    removeEventListener(type, fn, useCapture) { if (type === 'load' && useCapture) capture.delete(fn); },
  };
}

function fakeFrame(doc, { navigable = true } = {}) {
  const el = {
    ownerDocument: doc,
    isConnected: true,
    _src: '',
    _sandbox: '',
    navigations: [], // [url, the sandbox at that moment]
    listeners: [],
    onload: null,
    getAttribute(name) {
      if (name === 'src') return el._src || null;
      if (name === 'sandbox') return el._sandbox;
      return null;
    },
    setAttribute(name, value) { if (name === 'sandbox') el._sandbox = String(value); },
    addEventListener(type, fn) { if (type === 'load') el.listeners.push(fn); },
    // The document now in the frame has finished loading.
    load() {
      let stopped = false;
      const event = { type: 'load', target: el, stopPropagation() { stopped = true; } };
      for (const fn of [...doc.capture]) fn(event);
      if (stopped) return 'stopped';
      if (el.onload) el.onload(event);
      for (const fn of el.listeners) fn(event);
      return 'delivered';
    },
  };
  el.contentWindow = navigable
    ? { location: { replace(url) { el.navigations.push([url, el._sandbox]); } } }
    : {};
  Object.defineProperty(el, 'src', {
    get() { return el._src; },
    set(v) { el._src = v; el.navigations.push([v, el._sandbox]); },
  });
  return el;
}

async function frameHarness(t, { navigable = true } = {}) {
  const storeMod = await import(moduleUrl('frontend/src/features/app-frame/app-frame-store.js'));
  const { appFrameBridge } = await import(moduleUrl('frontend/src/features/app-frame/app-frame-bridge.js'));
  const policy = await import(moduleUrl('frontend/src/features/app-frame/app-frame-policy.js'));
  const { appFrameStore, appFrameRefs } = storeMod;
  appFrameStore.set({
    slug: '', active: false, faded: true, background: '', sandboxReady: false, cover: null,
    seq: 0, navigatedAt: 0, build: '', stale: false, kept: [],
  });
  appFrameRefs.iframe = null;
  appFrameRefs.kept = {};
  const doc = fakeDocument();
  // Stands in for <AppFrame/>: one element per mounted slug, made when the
  // slug arrives and let go when it leaves, its sandbox a rendered prop.
  let el = null;
  let slug = '';
  const render = () => {
    const s = appFrameStore.get();
    if (s.slug !== slug) {
      if (el) el.isConnected = false;
      el = s.slug ? fakeFrame(doc, { navigable }) : null;
      slug = s.slug;
    }
    if (el) el.setAttribute('sandbox', s.sandboxReady ? policy.APP_FRAME_SANDBOX : policy.PENDING_FRAME_SANDBOX);
    appFrameRefs.iframe = el;
  };
  const unsubscribe = appFrameStore.subscribe(render);
  render();
  t.after(() => {
    unsubscribe();
    appFrameBridge.evictAll();
  });
  return { bridge: appFrameBridge, policy, doc, frame: () => el };
}

test('a new frame reaches the app through an empty document under the app sandbox', async (t) => {
  const h = await frameHarness(t);
  h.bridge.mount({ slug: SLUG, faded: false });
  const el = h.frame();
  assert.equal(el.getAttribute('sandbox'), h.policy.PENDING_FRAME_SANDBOX, 'mounted restricted, as before');

  assert.equal(h.bridge.setSrc(APP_URL), true);
  assert.deepEqual(el.navigations, [[PRIMER, h.policy.APP_FRAME_SANDBOX]],
    'first an empty data: document, already under the app sandbox');
  assert.equal(el.getAttribute('src'), null, 'the app is not asked for until that document is in');
  assert.equal(h.bridge.keeps({ slug: SLUG, src: APP_URL }), true,
    'a render meanwhile sees the frame as going to this address, and leaves it alone');

  assert.equal(el.load(), 'stopped', 'the empty document\'s load goes no further than the capture phase');
  assert.deepEqual(el.navigations, [
    [PRIMER, h.policy.APP_FRAME_SANDBOX],
    [APP_URL, h.policy.APP_FRAME_SANDBOX],
  ], 'then the app, from a document WebKit lets the app\'s worker answer for');
  assert.equal(h.doc.capture.size, 0, 'and the capture listener is gone');
  assert.equal(h.bridge.keeps({ slug: SLUG, src: APP_URL }), true);
});

test('the frame\'s own load listeners hear the app\'s load and never the empty document\'s', async (t) => {
  const h = await frameHarness(t);
  h.bridge.mount({ slug: SLUG, faded: false });
  const el = h.frame();
  const heard = [];
  h.bridge.setOnLoad(() => heard.push(`onload:${el.getAttribute('src')}`));
  el.addEventListener('load', () => heard.push(`listener:${el.getAttribute('src')}`));

  h.bridge.setSrc(APP_URL);
  el.load(); // the empty document
  assert.deepEqual(heard, [], 'the reveal ladder, AppView\'s onload and appActivity hear nothing');
  assert.equal(el.load(), 'delivered'); // the app
  assert.deepEqual(heard, [`onload:${APP_URL}`, `listener:${APP_URL}`]);
});

test('a frame that already holds an app document navigates straight to the next one', async (t) => {
  const h = await frameHarness(t);
  h.bridge.mount({ slug: SLUG, faded: false });
  const el = h.frame();
  h.bridge.setSrc(APP_URL);
  el.load();
  el.load();

  // The token refresh's re-src, or a reload: the document it replaces was
  // loaded under the app sandbox already.
  const next = 'https://todo-list.apps.example/?token=tok2&un-theme=light';
  h.bridge.setSrc(next);
  assert.equal(el.getAttribute('src'), next, 'assigned on the spot, as it always was');
  assert.equal(el.navigations.filter(([url]) => url === PRIMER).length, 1, 'no second empty document');
});

test('asked again before the empty document is in, it goes to the newest address, once', async (t) => {
  const h = await frameHarness(t);
  h.bridge.mount({ slug: SLUG, faded: false });
  const el = h.frame();
  const next = 'https://todo-list.apps.example/?token=tok2&un-theme=light';
  h.bridge.setSrc(APP_URL);
  h.bridge.setSrc(next);
  assert.equal(el.navigations.length, 1, 'still the one empty document');
  assert.equal(h.bridge.keeps({ slug: SLUG, src: next }), true);
  el.load();
  assert.deepEqual(el.navigations.map(([url]) => url), [PRIMER, next]);
});

test('a frame let go meanwhile is never pointed anywhere; one whose empty document never loads goes on after a second', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await frameHarness(t);

  h.bridge.mount({ slug: SLUG, faded: false });
  const dropped = h.frame();
  h.bridge.setSrc(APP_URL);
  h.bridge.unmount();
  t.mock.timers.tick(1000);
  assert.deepEqual(dropped.navigations.map(([url]) => url), [PRIMER], 'the dropped frame stays where it was');
  assert.equal(h.doc.capture.size, 0, 'and nothing is left listening');

  h.bridge.mount({ slug: SLUG, faded: false });
  const stuck = h.frame();
  h.bridge.setSrc(APP_URL);
  t.mock.timers.tick(999);
  assert.equal(stuck.getAttribute('src'), null);
  t.mock.timers.tick(1);
  assert.equal(stuck.getAttribute('src'), APP_URL, 'past the cap it navigates anyway, as it did before');
  assert.equal(h.doc.capture.size, 0);
});

test('a frame whose window cannot be navigated from here gets its src directly', async (t) => {
  const h = await frameHarness(t, { navigable: false });
  h.bridge.mount({ slug: SLUG, faded: false });
  const el = h.frame();
  h.bridge.setSrc(APP_URL);
  assert.deepEqual(el.navigations, [[APP_URL, h.policy.APP_FRAME_SANDBOX]]);
});

test('the policy and the bridge say why the first navigation is primed', () => {
  const policy = read('frontend/src/features/app-frame/app-frame-policy.js');
  assert.match(policy, /`prime` in \.\/app-frame-bridge\.js/);
  const bridge = read('frontend/src/features/app-frame/app-frame-bridge.js');
  assert.match(bridge, /const PRIMER_SRC = 'data:text\/html,';/,
    'a data: document, opaque whatever the sandbox allows: never about:blank or srcdoc, which take the shell\'s origin');
  assert.match(bridge, /if \(pending && prime\(el, src\)\) return true;/,
    'only the pending blank is primed');
});

// ── The bridge ───────────────────────────────────────────────────────────

const BRIDGE = read('public/usernode-bridge/v1/bridge.js');
const BLOCK = BRIDGE.slice(
  BRIDGE.indexOf('/* __USERNODE_OFFLINE_READY_BEGIN__ */'),
  BRIDGE.indexOf('/* __USERNODE_OFFLINE_READY_END__ */'),
);

// `registration` is what getRegistration() resolves to; `lookup` replaces
// getRegistration outright (a pending promise, a rejection, or null for none).
function runBridge({ controller = null, registration = null, lookup } = {}) {
  const posted = [];
  const listeners = [];
  const sw = {
    controller,
    addEventListener(type, fn) { if (type === 'controllerchange') listeners.push(fn); },
  };
  if (lookup !== null) sw.getRegistration = lookup || (() => Promise.resolve(registration));
  const win = { navigator: { serviceWorker: sw }, Promise };
  win.window = win;
  win.parent = { postMessage(msg) { posted.push(msg.__usernode_offline_ready); } };
  vm.runInNewContext(BLOCK, win);
  return {
    posted,
    claim(next) {
      sw.controller = next;
      for (const fn of listeners) fn();
    },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const ACTIVE = { active: { state: 'activated' }, installing: null, waiting: null };

test('a load sent past an active worker says "registered", never "not-ready"', async () => {
  const b = runBridge({ registration: ACTIVE });
  await flush();
  assert.deepEqual(b.posted, ['registered']);
});

test('with no active worker it is still "not-ready", and the claim upgrades it', async () => {
  const none = runBridge({ registration: undefined });
  await flush();
  assert.deepEqual(none.posted, ['not-ready'], 'no registration');

  const first = runBridge({ registration: { active: null, installing: { state: 'installing' } } });
  await flush();
  assert.deepEqual(first.posted, ['not-ready'], 'a first-ever load, its worker still installing');
  first.claim({ scriptURL: '/sw.js' });
  assert.deepEqual(first.posted, ['not-ready', 'ready']);
});

test('a worker that claims the document while the bridge asks is announced once, as ready', async () => {
  let answer;
  const b = runBridge({ lookup: () => new Promise((r) => { answer = r; }) });
  b.claim({ scriptURL: '/sw.js' });
  answer(ACTIVE);
  await flush();
  assert.deepEqual(b.posted, ['ready'], 'no stale answer after it');
});

test('a controlled load says "ready" at once; a failed lookup, or none, says "not-ready"', async () => {
  assert.deepEqual(runBridge({ controller: { scriptURL: '/sw.js' } }).posted, ['ready']);
  const failed = runBridge({ lookup: () => Promise.reject(new Error('SecurityError')) });
  await flush();
  assert.deepEqual(failed.posted, ['not-ready']);
  assert.deepEqual(runBridge({ lookup: null }).posted, ['not-ready'], 'a browser without getRegistration');
});

test('both bridge copies carry the same block', () => {
  assert.equal(read('public/usernode-bridge.js'), BRIDGE, 'the unversioned mirror matches');
});

// ── The shell ────────────────────────────────────────────────────────────

const AppView = require('../public/js/app-view.js');

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function shell(t, { stored = {} } = {}) {
  const saved = { appData: AppView.appData };
  const prev = { document: global.document, localStorage: global.localStorage };
  const frame = { contentWindow: {} };
  global.localStorage = memoryStorage({ 'usernode:offline-ready': JSON.stringify(stored) });
  global.document = { getElementById: (id) => (id === 'app-iframe' ? frame : null) };
  AppView.appData = { slug: SLUG };
  t.after(() => {
    Object.assign(AppView, saved);
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete global[k]; else global[k] = v; }
  });
  const say = (kind, source = frame.contentWindow) =>
    AppView.handleOfflineReadyMessage({ source, data: { __usernode_offline_ready: kind } });
  return { say };
}

test('"registered" keeps the flag this device has, and makes none', (t) => {
  const s = shell(t, { stored: { [SLUG]: Date.now() - 1000 } });
  s.say('registered');
  assert.equal(AppView.offlineReadyFor(SLUG), true, 'a load past the worker does not withdraw it');
  s.say('not-ready');
  assert.equal(AppView.offlineReadyFor(SLUG), false, 'no active worker at all still does');
  s.say('registered');
  assert.equal(AppView.offlineReadyFor(SLUG), false, 'and it is no claim either');
  s.say('ready');
  assert.equal(AppView.offlineReadyFor(SLUG), true);
});

test('only the mounted app frame is heard, for "registered" as for the others', (t) => {
  const s = shell(t);
  s.say('ready', {});
  assert.equal(AppView.offlineReadyFor(SLUG), false);
  s.say('ready');
  s.say('not-ready', {});
  assert.equal(AppView.offlineReadyFor(SLUG), true, 'another window cannot withdraw it');
});
