// Clean, immediately-shareable app routes.
//
// Run with: node --test tests/clean-app-paths.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const appViewSource = fs.readFileSync(path.join(root, 'public/js/app-view.js'), 'utf8');
const authSource = fs.readFileSync(path.join(root, 'src/middleware/auth.js'), 'utf8');
const { isShellDocumentUrl } = require('../public/sw.js');

function loadApp(initial = {}) {
  const origin = 'https://social-vibecoding.test';
  const location = {
    origin,
    pathname: initial.pathname || '/',
    search: initial.search || '',
    hash: initial.hash || '',
  };
  Object.defineProperty(location, 'href', {
    get() { return `${origin}${location.pathname}${location.search}${location.hash}`; },
    set(value) { applyUrl(value); },
  });
  const calls = [];
  function applyUrl(value) {
    const next = new URL(value, location.href);
    location.pathname = next.pathname;
    location.search = next.search;
    location.hash = next.hash;
  }
  const history = {
    state: null,
    pushState(_state, _title, value) {
      calls.push(['push', value]);
      applyUrl(value);
    },
    replaceState(_state, _title, value) {
      calls.push(['replace', value]);
      applyUrl(value);
    },
  };
  const element = {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, appendChild() {},
  };
  const document = {
    visibilityState: 'visible',
    title: '',
    addEventListener() {},
    getElementById() { return element; },
    querySelector() { return null; },
    createElement() { return { ...element }; },
    head: element,
  };
  let releaseOpen;
  const openPromise = new Promise((resolve) => { releaseOpen = resolve; });
  const AppView = {
    appData: null,
    pendingInnerPath: null,
    launchRecordFor() { return null; },
    beginLaunch() { calls.push(['begin']); return true; },
    open() { calls.push(['open']); return openPromise; },
    close() {},
    _getViewMode() { return 'kanban'; },
  };
  const window = {
    location,
    history,
    addEventListener() {},
    AppView,
  };
  const context = vm.createContext({
    window, document, location, history, AppView,
    PlatformUI: {
      transition(fn) { calls.push(['transition']); fn(); },
      pullToRefresh() {},
    },
    URL, URLSearchParams, AbortController,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: {}, console, setTimeout, clearTimeout, fetch: async () => ({ ok: false }),
  });
  vm.runInContext(appSource, context);
  const App = window.App;
  App._departingScreen = () => element;
  App._setScreenVisible = () => {};
  App._showOnlyScreen = () => {};
  return { App, AppView, calls, location, history, releaseOpen };
}

test('opening an app writes its clean path before asynchronous loading', () => {
  const { App, calls, location } = loadApp({ search: '?demo=1&path=stale' });
  void App.navigateToApp('notes-9206f8');

  assert.equal(location.pathname, '/app/notes-9206f8');
  assert.equal(location.search, '?demo=1');
  assert.equal(location.hash, '');
  assert.deepEqual(calls[0], ['push', '/app/notes-9206f8?demo=1']);
  assert.ok(calls.findIndex(([kind]) => kind === 'push')
    < calls.findIndex(([kind]) => kind === 'open'),
  'the address changes before AppView.open starts');
});

test('a notification arriving during app startup waits and keeps its target', async () => {
  const { App, AppView, releaseOpen } = loadApp();
  const rendered = [];
  App.ImproveStatus = { setAppOpen() {} };
  App.switchTab = async (tab, ref, subTab) => {
    assert.ok(AppView.appData, 'routing waits for the app metadata');
    rendered.push({ tab, ref, subTab });
  };
  const boot = App.navigateToApp('notes', 'dev', null, 'forum');
  const tap = App.openAppTab('notes', 'dev', {
    subTab: 'topic', ref: { kind: 'issue', id: 1804 },
  });
  assert.equal(rendered.length, 0);
  AppView.appData = { slug: 'notes' };
  releaseOpen();
  await Promise.all([boot, tap]);
  assert.deepEqual(JSON.parse(JSON.stringify(rendered.at(-1))), {
    tab: 'dev', ref: { kind: 'issue', id: 1804 }, subTab: 'topic',
  });
});

test('opening a notification waits for its destination render', async () => {
  const { App, AppView, releaseOpen } = loadApp();
  App.ImproveStatus = { setAppOpen() {} };
  let finishRender;
  const render = new Promise(resolve => { finishRender = resolve; });
  App.switchTab = () => render;
  let completed = false;
  const tap = Promise.resolve(App.openAppTab('notes', 'dev', {
    subTab: 'sessions', sessionId: 42,
  })).then(() => { completed = true; });
  AppView.appData = { slug: 'notes' };
  releaseOpen();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, 'a pending render must not acknowledge a tap');
  finishRender();
  await tap;
  assert.equal(completed, true);
});

test('the serializer covers clean app, board, topic, and chromeless URLs', () => {
  const { App } = loadApp({ search: '?token=abc&shot=one' });
  assert.equal(App._appUrl('notes-9206f8', 'app'),
    '/app/notes-9206f8?token=abc&shot=one');
  assert.equal(App._appUrl('notes-9206f8', 'dev', null, 'forum', { boardView: 'workshop' }),
    '/app/notes-9206f8/workshop?token=abc&shot=one');
  assert.equal(App._appUrl('notes-9206f8', 'dev', { kind: 'proposal', id: 42 }, 'topic'),
    '/app/notes-9206f8/dev/proposals/42?token=abc&shot=one');
  assert.equal(App._appUrl('notes-9206f8', 'app', null, null, {
    chromeless: true, innerPath: '/thread/1?x=1&y=2',
  }), '/app/notes-9206f8/full?token=abc&shot=one&path=%2Fthread%2F1%3Fx%3D1%26y%3D2');
});

test('history gets one entry per app and home returns to the root', () => {
  const { App, calls, location } = loadApp({ search: '?demo=1' });
  App.currentApp = 'first-app';
  App.currentTab = 'app';
  App.updateHash();
  App.currentApp = 'second-app';
  App.updateHash();
  App.updateHash();
  App.currentApp = null;
  App.updateHash();

  assert.deepEqual(calls, [
    ['push', '/app/first-app?demo=1'],
    ['push', '/app/second-app?demo=1'],
    ['push', '/?demo=1'],
  ]);
  assert.equal(location.pathname, '/');
});

test('clean pathname parsing is narrow and legacy hashes remain router inputs', () => {
  const { App } = loadApp();
  assert.equal(App._appRouteFromPath('/app/notes-9206f8'), 'app/notes-9206f8');
  assert.equal(App._appRouteFromPath('/app/notes-9206f8/dev/issues/7'),
    'app/notes-9206f8/dev/issues/7');
  assert.equal(App._appRouteFromPath('/api/apps/notes-9206f8'), '');
  assert.match(appSource, /let hash = rawHash[\s\S]{0,100}: pathRoute;/,
    'restoreFromHash falls back to a clean pathname when there is no fragment');
  assert.match(appSource, /history\.replaceState\(null, '', canonicalAppUrl\)/,
    'legacy app hashes normalize without a new history entry');
});

test('interaction-gated app shots survive legacy-hash normalization', () => {
  assert.doesNotMatch(appViewSource, /location\.hash[^\n]*includes\(`app\/\$\{slug\}`\)/,
    'shot hooks must not depend on the legacy app fragment after it self-heals');
  // The plus-menu hook RETRIES now — its button moved into the Workshop's
  // pane and no longer exists at a fixed 300ms — so the app-state guard is
  // folded into the tick's bail-out rather than standing alone. What this
  // asserts is the thing that matters: the hook keys off the ROUTED app
  // state, not the legacy hash, whatever statement shape it wears.
  const plusHook = appViewSource.slice(
    appViewSource.indexOf("if (shot === 'plus-menu')"),
    appViewSource.indexOf("if (shot === 'card-menu')"));
  assert.ok(plusHook.length > 0, 'the plus-menu hook exists');
  assert.match(plusHook, /App\.currentApp !== slug/,
    'the plus-menu shot follows the routed app state');
  assert.match(plusHook, /dev-plus-btn/);
  assert.ok(!/location\.hash/.test(plusHook), 'and never the legacy fragment');
  assert.match(appViewSource, /if \(App\.currentApp === slug\) \{\s*AppView\.showPreviewLoaderShot/,
    'preview shots follow the routed app state');
});

test('authentication and the service worker admit clean app documents', () => {
  const uses = authSource.match(/isSpaDocumentPath\(req\.path\)/g) || [];
  assert.equal(uses.length, 2,
    'both the waiting-room gate and anonymous redirect gate preserve app paths');
  assert.equal(isShellDocumentUrl(
    'https://social-vibecoding.test/app/notes-9206f8/dev',
    'https://social-vibecoding.test'
  ), true);
  assert.equal(isShellDocumentUrl(
    'https://social-vibecoding.test/dashboard',
    'https://social-vibecoding.test'
  ), false);
});
