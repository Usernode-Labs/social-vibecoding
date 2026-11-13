// The boot's way back: a shell that opens blank asks for a fresh copy once.
//
// The structural judgement, the two loop guards, the skips, and the address
// cleanup are all pure or window-driven, so the whole module runs here with a
// stub window and document and no browser. The service worker's half of the
// contract (a `fresh-shell` navigation is bypassed) is pinned in
// tests/pwa-sw-classify.test.js.
//
// Run with: node --test tests/boot-recovery.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MODULE = 'frontend/src/lib/boot-recovery.ts';
const KEY = 'sv:boot-recovery';

/** A screen root as the snapshot's "screens shown" line sees it. */
function screen({ id = 'home-screen', text = '', hidden = false, content = false, classes = [] } = {}) {
  return {
    id,
    hidden,
    classList: { contains: (name) => classes.includes(name) },
    innerText: text,
    querySelector: () => (content ? {} : null),
  };
}

function memoryStorage(initial = {}) {
  const values = { ...initial };
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null),
    setItem: (key, value) => { values[key] = String(value); },
    values,
  };
}

function bootModule(stubs) {
  return loadTsx(MODULE, stubs ? { stubs } : {});
}

/**
 * One stub document/window pair. `install()` returns the captured timers,
 * listeners and window so a test can drive exactly one check.
 */
function fixture({
  doc = {},
  window: winOverrides = {},
  top,
  screens,
  storage = memoryStorage(),
} = {}) {
  const timers = [];
  const listeners = { window: {}, document: {} };
  const replaced = [];
  const replaceState = [];
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    body: { __reactContainer$abc123: {} },
    documentElement: { classList: { contains: () => false } },
    querySelectorAll: () => (screens === undefined ? [screen({ text: 'Welcome home' })] : screens),
    addEventListener: (type, listener) => { listeners.document[type] = listener; },
    ...doc,
  };
  const window = {
    navigator: { onLine: true },
    sessionStorage: storage,
    location: {
      href: 'https://homeroom.example/#home',
      replace: (url) => replaced.push(url),
    },
    history: { replaceState: (data, title, url) => replaceState.push(url) },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    addEventListener: (type, listener) => { listeners.window[type] = listener; },
    __unBoot: { errors: [], steps: [{ step: 'hydrate', at: 12 }] },
    App: {},
    document,
    ...winOverrides,
  };
  window.top = top === undefined ? window : top;
  return { window, document, timers, listeners, replaced, replaceState, storage };
}

// ── What "came up" means ───────────────────────────────────────────────

test('a hydrated shell with a shown screen of text came up', () => {
  const { shellCameUp } = bootModule();
  const { window, document } = fixture();
  assert.deepEqual(shellCameUp(document, window), { ok: true });
});

test('each structural failure has its own reason', () => {
  const { shellCameUp } = bootModule();

  const noHydrate = fixture();
  noHydrate.window.__unBoot.steps = [{ step: 'registerServiceWorker', at: 3 }];
  assert.deepEqual(shellCameUp(noHydrate.document, noHydrate.window),
    { ok: false, reason: 'not-hydrated' });

  const notAdopted = fixture();
  notAdopted.document.body = { someOtherKey: true };
  assert.deepEqual(shellCameUp(notAdopted.document, notAdopted.window),
    { ok: false, reason: 'not-hydrated' });

  const noApp = fixture({ window: { App: undefined } });
  assert.deepEqual(shellCameUp(noApp.document, noApp.window),
    { ok: false, reason: 'no-app' });

  const noScreen = fixture({ screens: [screen({ text: 'home', hidden: true })] });
  assert.deepEqual(shellCameUp(noScreen.document, noScreen.window),
    { ok: false, reason: 'no-screen' });

  const hiddenClass = fixture({ screens: [screen({ text: 'home', classes: ['hidden'] })] });
  assert.deepEqual(shellCameUp(hiddenClass.document, hiddenClass.window),
    { ok: false, reason: 'no-screen' });

  const empty = fixture({ screens: [screen({ text: '   ' })] });
  assert.deepEqual(shellCameUp(empty.document, empty.window),
    { ok: false, reason: 'empty-screen' });
});

test('a skeleton, an iframe or any drawn element counts as content', () => {
  const { shellCameUp } = bootModule();
  const skeleton = fixture({ screens: [screen({ text: '', content: true })] });
  assert.deepEqual(shellCameUp(skeleton.document, skeleton.window), { ok: true });

  // One empty screen beside a drawn one is still a shell that came up.
  const mixed = fixture({ screens: [screen({ text: '' }), screen({ id: 'messages-screen', text: 'hi' })] });
  assert.deepEqual(shellCameUp(mixed.document, mixed.window), { ok: true });
});

// ── The recovery itself ────────────────────────────────────────────────

test('a blank shell is remembered, recorded and replaced once with a fresh copy', () => {
  const { installBootRecovery } = bootModule();
  const f = fixture({ screens: [] });

  installBootRecovery(f.window);
  assert.equal(f.timers.length, 1, 'the start-up check is scheduled once');
  assert.equal(f.timers[0].ms, 4000, 'a few seconds after load');

  f.timers[0].fn();

  const marker = JSON.parse(f.storage.values[KEY]);
  assert.equal(marker.reason, 'no-screen');
  assert.equal(typeof marker.at, 'number');

  const recorded = f.window.__unBoot.errors.filter((e) => e.step === 'recovery');
  assert.equal(recorded.length, 1);
  assert.match(recorded[0].message, /shell did not come up \(no-screen\); loading a fresh copy/);

  assert.equal(f.replaced.length, 1);
  const target = new URL(f.replaced[0]);
  assert.ok(target.searchParams.has('fresh-shell'), 'asks for a copy the worker cannot answer');
  assert.equal(target.hash, '#home', 'the address keeps its place');
});

test('a stored marker, or a load that already carried fresh-shell, never replaces', () => {
  const { installBootRecovery } = bootModule();

  const marked = fixture({
    screens: [],
    storage: memoryStorage({ [KEY]: JSON.stringify({ at: 1, reason: 'no-screen' }) }),
  });
  installBootRecovery(marked.window);
  marked.timers[0].fn();
  assert.equal(marked.replaced.length, 0);

  const fresh = fixture({ screens: [] });
  fresh.window.location.href = 'https://homeroom.example/?fresh-shell=123#home';
  installBootRecovery(fresh.window);
  fresh.timers[0].fn();
  assert.equal(fresh.replaced.length, 0, 'the fresh copy is judged, never replaced again');
});

test('a page that cannot remember the attempt does not replace, and still records it', () => {
  const { installBootRecovery } = bootModule();

  const refuses = fixture({ screens: [] });
  refuses.storage.setItem = () => { throw new Error('quota'); };
  installBootRecovery(refuses.window);
  refuses.timers[0].fn();
  assert.equal(refuses.replaced.length, 0);
  assert.match(refuses.window.__unBoot.errors[0].message,
    /could not remember the attempt, so not reloading/);

  const unreadable = fixture({ screens: [] });
  Object.defineProperty(unreadable.window, 'sessionStorage', {
    get() { throw new Error('storage blocked'); },
  });
  installBootRecovery(unreadable.window);
  unreadable.timers[0].fn();
  assert.equal(unreadable.replaced.length, 0);
});

test('offline, hidden, framed or in the side panel: no check leaves a trace', () => {
  const { installBootRecovery } = bootModule();

  const offline = fixture({ screens: [], window: { navigator: { onLine: false } } });
  installBootRecovery(offline.window);
  offline.timers[0].fn();
  assert.equal(offline.replaced.length, 0);
  assert.equal(offline.window.__unBoot.errors.length, 0);

  const hidden = fixture({ screens: [], doc: { visibilityState: 'hidden' } });
  installBootRecovery(hidden.window);
  hidden.timers[0].fn();
  assert.equal(hidden.replaced.length, 0);

  const framed = fixture({ screens: [], top: {} });
  installBootRecovery(framed.window);
  framed.timers[0].fn();
  assert.equal(framed.replaced.length, 0);

  const panelModule = bootModule({
    './side-panel-mode': { isEmbeddedPanel: () => true, EMBEDDED_PANEL_CLASS: 'in-side-panel' },
  });
  const panel = fixture({ screens: [] });
  panelModule.installBootRecovery(panel.window);
  panel.timers[0].fn();
  assert.equal(panel.replaced.length, 0);
});

test('a healthy shell is checked and left alone', () => {
  const { installBootRecovery } = bootModule();
  const f = fixture();
  installBootRecovery(f.window);
  f.timers[0].fn();
  assert.equal(f.replaced.length, 0);
  assert.equal(f.window.__unBoot.errors.length, 0);
  assert.equal(f.storage.values[KEY], undefined, 'nothing is written');
});

// ── The fresh copy's own start ─────────────────────────────────────────

test('a load carrying fresh-shell cleans the address and says what it followed', () => {
  const { installBootRecovery } = bootModule();
  const f = fixture({
    screens: [],
    storage: memoryStorage({ [KEY]: JSON.stringify({ at: 1, reason: 'empty-screen' }) }),
  });
  f.window.location.href = 'https://homeroom.example/?a=1&fresh-shell=123#home';

  installBootRecovery(f.window);

  assert.equal(f.replaceState.length, 1);
  assert.equal(f.replaceState[0], '/?a=1#home', 'only fresh-shell is dropped; the rest stays');

  const recorded = f.window.__unBoot.errors.filter((e) => e.step === 'recovery');
  assert.equal(recorded.length, 1);
  assert.match(recorded[0].message, /fresh copy loaded after: empty-screen/);
});

// ── Back in the foreground ─────────────────────────────────────────────

test('several returns in a row collapse into one check', () => {
  const { installBootRecovery } = bootModule();
  const f = fixture({ screens: [], doc: { readyState: 'interactive' } });

  installBootRecovery(f.window);
  assert.equal(f.timers.length, 0, 'the load event has not fired yet');

  f.listeners.window.load();
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].ms, 4000);

  const timer = f.timers[0];
  f.listeners.document.visibilitychange({});
  f.listeners.document.visibilitychange({});
  f.listeners.window.pageshow({ persisted: true });
  assert.equal(f.timers.length, 1, 'the pending timer absorbs the burst');

  timer.fn();
  assert.equal(f.replaced.length, 1);
});

test('a return after the start-up check schedules a new check', () => {
  const { installBootRecovery } = bootModule();
  const f = fixture();

  installBootRecovery(f.window);
  f.timers[0].fn();
  assert.equal(f.replaced.length, 0);

  f.listeners.document.visibilitychange({});
  assert.equal(f.timers.length, 2);
  assert.equal(f.timers[1].ms, 2000, 'a couple of seconds after the return');
});

// ── Source guards ──────────────────────────────────────────────────────

test('main.tsx arms the recovery after hydration', () => {
  const main = read('frontend/src/main.tsx');
  const hydrate = main.indexOf("bootStep('hydrate'");
  const recovery = main.indexOf("bootStep('installBootRecovery'");
  assert.ok(hydrate > 0, 'hydration is still the step this follows');
  assert.ok(recovery > hydrate, 'installed after hydration');
  assert.match(main, /installBootRecovery\(\)/);
});

test('boot-recovery records and warns, never console.error', () => {
  // A console.error on any route fails the platform's proposal checks; the
  // header explains this, so strip comments before scanning.
  const source = read(MODULE)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(source, /console\.error\s*\(/);
  assert.match(source, /console\.warn\s*\(/);
});
