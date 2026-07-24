// #771: staging preview docks as a resizable side panel in dev chat.
//
// Two halves, two harnesses (mirroring the repo's existing patterns):
//
//  A. app-view.js in a vm context (per ensure-staging-preview.test.js) —
//     ensureStaging with {dock:true} applies the docked class + slot
//     geometry to #staging-overlay, the rebuild path preserves the mode,
//     the Full screen / Exit full screen toggle flips classes WITHOUT
//     touching iframe.src (the no-reload guarantee), and a docked
//     closeStagingOverlay collapses the dev-chat slot + clears the iframe.
//
//  B. dev-chat.js in a vm context (per openSession-streaming-reset.test.js) —
//     renderChatView mounts #dc-staging-resizer / #dc-staging-panel when
//     stagingPanel.open, and the two right-hand panels are mutually
//     exclusive (openStagingPanel closes the spec viewer and vice versa).
//
// Run with: node --test --test-force-exit tests/staging-dock-panel.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_VIEW_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
const DEV_CHAT_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'), 'utf8');

// ── Shared fake element: real Set-backed classList (the docked mode adds
// a second class to #staging-overlay, so the ensure-staging test's
// single-flag classList stub isn't enough here). ──────────────────────
function makeElement(id) {
  const classes = new Set();
  return {
    id,
    style: {},
    dataset: {},
    _attrs: {},
    _src: '',
    _rect: { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 },
    disabled: false,
    title: '',
    innerHTML: '',
    textContent: '',
    value: '',
    onclick: null,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle(c, v) {
        const want = v === undefined ? !classes.has(c) : !!v;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
    },
    get src() { return this._src; },
    set src(v) { this._src = v; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] ?? null; },
    removeAttribute(k) { delete this._attrs[k]; },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    focus() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    getBoundingClientRect() { return this._rect; },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
}

// ── Harness A: app-view.js ────────────────────────────────────────────
function makeAppViewHarness({ fetchImpl, wideViewport = true, withSlot = true } = {}) {
  const registry = new Map();
  const getEl = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };
  // The dev-chat placeholder slot the docked overlay pins to. Its rect is
  // what the geometry sync copies onto the overlay.
  if (withSlot) {
    getEl('dc-staging-panel')._rect = { top: 50, left: 600, width: 480, height: 700, bottom: 750, right: 1080 };
  }

  const media = { wide: wideViewport };
  const sandbox = {
    console,
    relTime: () => 'now',
    App: { user: { id: 1 }, currentTab: 'dev' },
    Kudos: { renderButton: () => '' },
    document: {
      getElementById: (id) => {
        if (id === 'dc-staging-panel' && !withSlot) return null;
        return getEl(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: (tag) => makeElement(`__created_${tag}`),
      body: makeElement('body'),
    },
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({}) })),
    alert: () => {},
    escapeHtml: (s) => String(s == null ? '' : s),
    resolveDevHost: (u) => u,
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: media.wide, addEventListener() {}, addListener() {} }),
    localStorage: { getItem: () => null, setItem() {} },
    // dev-chat stub: dockStagingPanel / expandStagingFullscreen and
    // closeStagingOverlay reach DevChat as a bare global.
    DevChat: {
      currentSession: { id: 7 },
      stagingPanel: { open: withSlot },
      renderCalls: 0,
      renderChatView() { this.renderCalls += 1; },
      openStagingPanel() { this.stagingPanel.open = true; },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return { AppView: sandbox.__AppView, getEl, sandbox, media };
}

const okJson = (body) => async () => ({ ok: true, json: async () => body });

test('ensureStaging {dock:true} enters docked mode with slot geometry; plain open stays fullscreen', async () => {
  const { AppView, getEl } = makeAppViewHarness({ fetchImpl: okJson({ status: 'ready', url: 'https://live.example' }) });
  const overlay = getEl('staging-overlay');
  const swaps = [];
  AppView.swapToStaging = (url, testing, opts) => swaps.push({ url, testing, opts });

  await AppView.ensureStaging(7, 'https://fallback.example', null, { dock: true });
  assert.equal(AppView._stagingMode, 'docked', 'docked mode entered');
  assert.equal(AppView._stagingDockable, true, 'preview marked dockable');
  assert.ok(overlay.classList.contains('staging-overlay-docked'), 'overlay carries the docked class');
  assert.equal(overlay.style.top, '50px', 'pinned to the slot rect (top)');
  assert.equal(overlay.style.left, '600px', 'pinned to the slot rect (left)');
  assert.equal(overlay.style.width, '480px', 'pinned to the slot rect (width)');
  assert.equal(overlay.style.height, '700px', 'pinned to the slot rect (height)');
  assert.equal(swaps.length, 1, 'ready path still opens the preview');

  // A later plain (vote-panel style) open resets to fullscreen — no
  // stale docked class leaks across previews.
  await AppView.ensureStaging(7, 'https://fallback.example', null, {});
  assert.equal(AppView._stagingMode, 'fullscreen', 'plain open is fullscreen');
  assert.equal(AppView._stagingDockable, false, 'not dockable');
  assert.ok(!overlay.classList.contains('staging-overlay-docked'), 'docked class stripped');
  assert.equal(overlay.style.top, '', 'pinned geometry cleared');
});

test('a rebuild resolved by onStagingRebuildResult preserves the docked mode', async () => {
  const { AppView, getEl } = makeAppViewHarness({ fetchImpl: okJson({ status: 'rebuilding' }) });
  const overlay = getEl('staging-overlay');
  const swaps = [];
  const realSwap = AppView.swapToStaging.bind(AppView);
  AppView.swapToStaging = (url, testing, opts) => {
    swaps.push({ url, testing, opts });
    realSwap(url, testing, opts);
  };
  // Skip the real TLS cert poll — resolve readiness instantly.
  AppView._waitForStagingReady = async () => true;

  await AppView.ensureStaging(7, 'https://stale.example', null, { dock: true });
  assert.equal(AppView._stagingMode, 'docked', 'docked while the rebuild runs');
  assert.ok(AppView._pendingStagingPreview, 'pending marker parked');
  assert.equal(AppView._pendingStagingPreview.dock, true, 'marker records the dock request');

  AppView.onStagingRebuildResult(7, { url: 'https://rebuilt.example' });
  assert.equal(swaps.length, 1, 'preview opened after the rebuild');
  assert.equal(swaps[0].opts.dock, undefined, 'resolution passes no dock — current mode wins');
  assert.equal(AppView._stagingMode, 'docked', 'still docked after the real swapToStaging ran');
  assert.ok(overlay.classList.contains('staging-overlay-docked'), 'docked class survived the swap');
});

test('Full screen / Exit full screen toggle flips classes without touching iframe.src', async () => {
  const { AppView, getEl, sandbox } = makeAppViewHarness({ fetchImpl: okJson({ status: 'ready', url: 'https://live.example' }) });
  const overlay = getEl('staging-overlay');
  const iframe = getEl('staging-iframe');
  AppView.swapToStaging = () => {};
  await AppView.ensureStaging(7, 'https://x.example', null, { dock: true });

  // Simulate the loaded preview.
  iframe.src = 'https://live.example/?token=abc';

  AppView.expandStagingFullscreen();
  assert.equal(AppView._stagingMode, 'fullscreen', 'expanded');
  assert.ok(!overlay.classList.contains('staging-overlay-docked'), 'docked class removed');
  assert.equal(iframe.src, 'https://live.example/?token=abc', 'iframe src untouched on expand (no reload)');
  assert.equal(sandbox.DevChat.stagingPanel.open, false, 'dev-chat slot collapsed');
  const fsBtn = getEl('staging-fullscreen-btn');
  assert.ok(!fsBtn.classList.contains('hidden'), 'Exit full screen affordance stays visible');
  assert.equal(fsBtn.textContent, 'Exit full screen');

  AppView.dockStagingPanel();
  assert.equal(AppView._stagingMode, 'docked', 're-docked');
  assert.ok(overlay.classList.contains('staging-overlay-docked'), 'docked class back');
  assert.equal(iframe.src, 'https://live.example/?token=abc', 'iframe src untouched on re-dock (no reload)');
  assert.equal(sandbox.DevChat.stagingPanel.open, true, 'dev-chat slot remounted');
  assert.equal(fsBtn.textContent, 'Full screen');
});

test('closeStagingOverlay in docked mode collapses the slot and clears the iframe', async () => {
  const { AppView, getEl, sandbox } = makeAppViewHarness({ fetchImpl: okJson({ status: 'ready', url: 'https://live.example' }) });
  const overlay = getEl('staging-overlay');
  const iframe = getEl('staging-iframe');
  AppView.swapToStaging = () => {};
  await AppView.ensureStaging(7, 'https://x.example', null, { dock: true });
  iframe.src = 'https://live.example/';
  const rendersBefore = sandbox.DevChat.renderCalls;

  AppView.closeStagingOverlay();
  assert.equal(AppView._stagingMode, 'fullscreen', 'mode reset');
  assert.equal(AppView._stagingDockable, false, 'dockable cleared');
  assert.ok(!overlay.classList.contains('staging-overlay-docked'), 'docked class stripped');
  assert.ok(overlay.classList.contains('hidden'), 'overlay hidden');
  assert.equal(iframe.src, '', 'iframe src cleared');
  assert.equal(sandbox.DevChat.stagingPanel.open, false, 'dev-chat slot collapsed');
  assert.ok(sandbox.DevChat.renderCalls > rendersBefore, 'chat re-rendered so the slot unmounts');
});

test('narrow viewport: dock request falls back to fullscreen', async () => {
  const { AppView, getEl } = makeAppViewHarness({
    fetchImpl: okJson({ status: 'ready', url: 'https://live.example' }),
    withSlot: false, // narrow viewports never mount the slot
    wideViewport: false,
  });
  AppView.swapToStaging = () => {};
  await AppView.ensureStaging(7, 'https://x.example', null, { dock: true });
  assert.equal(AppView._stagingMode, 'fullscreen', 'no slot → fullscreen fallback');
  assert.ok(!getEl('staging-overlay').classList.contains('staging-overlay-docked'));
});

// ── Harness B: dev-chat.js ────────────────────────────────────────────
function makeDevChatHarness() {
  const registry = new Map();
  const getEl = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };

  const storage = new Map();
  const sandbox = {
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    document: {
      _title: 'MyApp',
      get title() { return this._title; },
      set title(v) { this._title = v; },
      getElementById: (id) => getEl(id),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => makeElement(`__created_${tag}`),
      addEventListener() {},
      removeEventListener() {},
      body: makeElement('body'),
      documentElement: makeElement('html'),
      hidden: false,
      visibilityState: 'visible',
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    navigator: { sendBeacon: () => true },
    EventSource: class { constructor() { this.readyState = 1; } close() {} },
    URL,
    Blob: class { constructor() {} },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { currentTab: 'dev', currentSubTab: 'sessions' },
    Notifications: {},
    PlatformUI: {
      isTouch: () => false,
      hasKit: () => false,
      toast: () => {},
      transition: (fn) => fn(),
      attachScreenFx: () => {},
      detachScreenFx: () => {},
    },
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${DEV_CHAT_SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;

  // Neutralize DOM-heavy helpers irrelevant to the panel-layout contract.
  DevChat.renderMessages = () => {};
  DevChat.refreshBudget = () => {};
  DevChat.initScrollTracking = () => {};
  DevChat.restoreSessionScroll = () => {};
  DevChat._setupTextareaResize = () => {};
  DevChat._setupKeyboardShortcuts = () => {};
  DevChat._setupAttachments = () => {};
  DevChat._restoreDraft = () => {};
  DevChat.renderSessionList = () => {};
  DevChat._loadSpecViewer = () => {};
  DevChat._renderSpecViewer = () => {};
  DevChat._startHeartbeat = () => {};
  DevChat._setNotifyOnDone = () => {};

  return { DevChat, sandbox, getEl };
}

test('renderChatView mounts the staging resizer + panel slot when stagingPanel.open', () => {
  const { DevChat, getEl } = makeDevChatHarness();
  DevChat.currentSession = { id: 7, status: 'active', branch_name: 'dev/x', session_title: 'Test' };

  DevChat.renderChatView();
  let html = getEl('dc-view').innerHTML;
  assert.ok(html.includes('id="dc-staging-panel"'), 'slot always rendered');
  assert.ok(!html.includes('dc-staging-panel-open'), 'closed by default');

  DevChat.stagingPanel.open = true;
  DevChat.renderChatView();
  html = getEl('dc-view').innerHTML;
  assert.ok(html.includes('dc-staging-panel-open'), 'open class applied to the slot');
  assert.ok(html.includes('dc-staging-resizer-open'), 'resizer shown alongside');
});

test('openStagingPanel closes the spec viewer (one right-hand panel at a time)', () => {
  const { DevChat } = makeDevChatHarness();
  DevChat.currentSession = { id: 7, status: 'active' };
  DevChat.specViewer.open = true;

  DevChat.openStagingPanel();
  assert.equal(DevChat.stagingPanel.open, true, 'staging panel opened');
  assert.equal(DevChat.specViewer.open, false, 'spec viewer yielded');
});

test('openSpecViewer closes a docked staging preview (and its overlay)', () => {
  const { DevChat, sandbox } = makeDevChatHarness();
  DevChat.currentSession = { id: 7, status: 'active' };
  DevChat.stagingPanel.open = true;
  let closed = 0;
  sandbox.AppView = {
    _stagingMode: 'docked',
    closeStagingOverlay: () => { closed += 1; },
  };

  DevChat.openSpecViewer('latest');
  assert.equal(DevChat.specViewer.open, true, 'spec viewer opened');
  assert.equal(DevChat.stagingPanel.open, false, 'staging panel yielded');
  assert.equal(closed, 1, 'docked overlay closed');
});

test('previewStaging on a wide viewport mounts the slot and requests a docked open', () => {
  const { DevChat, sandbox } = makeDevChatHarness();
  DevChat.currentSession = { id: 7, status: 'active', staging_url: 'https://live.example' };
  const calls = [];
  sandbox.AppView = {
    _stagingDockViewport: () => true,
    ensureStaging: (sessionId, url, testing, opts) => calls.push({ sessionId, url, testing, opts }),
    rebindStagingDock: () => {},
  };

  DevChat.previewStaging('https://msg-url.example', false);
  assert.equal(DevChat.stagingPanel.open, true, 'slot mounted before the open');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.dock, true, 'dock requested');
  assert.equal(calls[0].url, 'https://live.example', 'session staging_url preferred');

  // Narrow viewport: fullscreen as before, slot untouched.
  DevChat.stagingPanel.open = false;
  sandbox.AppView._stagingDockViewport = () => false;
  DevChat.previewStaging('https://msg-url.example', true);
  assert.equal(DevChat.stagingPanel.open, false, 'no slot on narrow viewports');
  assert.equal(calls[1].opts.dock, false, 'fullscreen open requested');
  assert.equal(calls[1].opts.jump, true, 'jump intent carried');
});

test('leaving the session view tears the docked panel down', () => {
  const { DevChat, sandbox } = makeDevChatHarness();
  DevChat.currentSession = { id: 7, status: 'active' };
  DevChat.stagingPanel.open = true;
  let closed = 0;
  sandbox.AppView = {
    _stagingMode: 'docked',
    closeStagingOverlay: () => { closed += 1; sandbox.AppView._stagingMode = 'fullscreen'; },
  };

  // Back to the session list (renderChatView with no current session).
  DevChat.currentSession = null;
  DevChat.renderChatView();
  assert.equal(DevChat.stagingPanel.open, false, 'slot state dropped');
  assert.equal(closed, 1, 'docked overlay closed with it');

  // reset() (leaving the app) is equally safe when nothing is docked.
  DevChat.reset();
  assert.equal(DevChat.stagingPanel.open, false);
  assert.equal(closed, 1, 'no spurious second close');
});
