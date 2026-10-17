'use strict';

// #3620: Back walks a project's tabs.
//
// A project page's tabs (Hub, Discussion, Needs you, Workshop, and All items
// under the Workshop) were local state: pressing one changed the screen and
// the address stayed where it was. So a Back press skipped the tab the reader
// had been on a moment before and left the project entirely — open a
// community, press Workshop, press Back, and Home came up. Each press now
// records the address it is already on with only `?ws=` moved, the deep link
// the tabs have always understood, and a traversal reopens the tab its
// address names.
//
// Run with: node --test tests/project-tab-back.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const APP_VIEW_SRC = fs.readFileSync(path.join(ROOT, 'public/js/app-view.js'), 'utf8');
const WORKSHOP = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/dev-board/workshop/workshop.tsx'), 'utf8');

const ORIGIN = 'https://homeroom.test';

/** app-view.js in a vm, with the browser facts its tab methods read. */
function loadAppView({
  pathname = '/app/demo/workshop',
  search = '?ws=status',
  stored = null,
  currentApp = 'demo',
  currentTab = 'dev',
  currentSubTab = 'forum',
} = {}) {
  const events = [];
  const writes = [];
  const location = new URL(`${ORIGIN}${pathname}${search}`);
  const store = new Map(stored == null ? [] : [['devWorkshopTab', stored]]);
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { writes.push(['store', key, value]); store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  const history = {
    pushState(_state, _title, url) {
      writes.push(['push', url]);
      location.href = new URL(url, location.href).href;
    },
  };
  const window = {
    location,
    localStorage,
    history,
    addEventListener() {},
    dispatchEvent(event) { events.push(event); },
  };
  const sandbox = {
    console, URL, URLSearchParams, setTimeout, clearTimeout, Promise,
    window, location, localStorage, history,
    App: { currentApp, currentTab, currentSubTab },
    CustomEvent: class {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    navigator: {},
    document: {
      addEventListener() {}, getElementById() { return null; }, querySelector() { return null; },
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.AppView = AppView;`, context);
  return { AppView: context.AppView, App: sandbox.App, location, writes, events };
}

/** app.js's router, with just enough of the shell around it. */
function loadApp({
  pathname = '/app/demo/workshop',
  search = '',
  AppView: viewOverrides = {},
} = {}) {
  const calls = [];
  const location = new URL(`${ORIGIN}${pathname}${search}`);
  const history = {
    state: null,
    pushState(_state, _title, url) { calls.push(['push', url]); location.href = new URL(url, location.href).href; },
    replaceState(_state, _title, url) { calls.push(['replace', url]); location.href = new URL(url, location.href).href; },
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
  const AppView = {
    appData: null,
    pendingInnerPath: null,
    _getViewMode() { return 'workshop'; },
    _workshopTab() { return 'workshop'; },
    _applyWorkshopTabRoute() { calls.push(['apply-tab']); },
    ...viewOverrides,
  };
  const window = { location, history, addEventListener() {}, AppView };
  const context = vm.createContext({
    window, document, location, history, AppView,
    PlatformUI: { transition(fn) { fn(); }, pullToRefresh() {} },
    URL, URLSearchParams, AbortController,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: {}, console, setTimeout, clearTimeout,
    fetch: async () => ({ ok: false }),
  });
  vm.runInContext(APP_JS, context);
  const App = window.App;
  App._departingScreen = () => element;
  App._setScreenVisible = () => {};
  App._showOnlyScreen = () => {};
  return { App, AppView, calls, location, history };
}

// ── A press records where it was ───────────────────────────────────────

test('a tab press records the same page with only `?ws=` moved', () => {
  const { AppView, location, writes } = loadAppView({ search: '?ws=status' });
  assert.equal(AppView._pushWorkshopTab('workshop'), true);
  assert.deepEqual(writes.filter((w) => w[0] === 'push'),
    [['push', '/app/demo/workshop?ws=workshop']], 'one history record, naming the tab');
  assert.equal(location.search, '?ws=workshop');
});

test('a press on the tab already up records nothing', () => {
  const { AppView, writes } = loadAppView({ search: '?ws=workshop' });
  assert.equal(AppView._pushWorkshopTab('workshop'), false);
  assert.deepEqual(writes.filter((w) => w[0] === 'push'), [], 'a Back that would go nowhere');
});

test('a press outside the project page records nothing', () => {
  const { AppView, writes } = loadAppView({ currentTab: 'app', currentSubTab: null });
  assert.equal(AppView._pushWorkshopTab('workshop'), false);
  assert.deepEqual(writes.filter((w) => w[0] === 'push'), []);
});

test('every tab of the page is recorded, All items included', () => {
  for (const tab of ['status', 'discussion', 'needs', 'workshop', 'all']) {
    const { AppView, writes } = loadAppView({ search: '?ws=other' });
    assert.equal(AppView._pushWorkshopTab(tab), true, tab);
    assert.deepEqual(writes.filter((w) => w[0] === 'push'),
      [['push', `/app/demo/workshop?ws=${tab}`]], tab);
  }
});

// ── A traversal reopens the tab its address names ──────────────────────

test('Back to a tab entry reopens that tab, not the one just left', () => {
  // The address Back landed on says Workshop; the remembered tab is Needs
  // you, because that is the tab the reader pressed just before Back.
  const { AppView, events, writes } = loadAppView({ search: '?ws=workshop', stored: 'needs' });
  AppView._applyWorkshopTabRoute();
  assert.equal(AppView._workshopTab(), 'workshop', 'the address wins over the remembered tab');
  assert.deepEqual(writes.filter((w) => w[0] === 'store'),
    [['store', 'devWorkshopTab', 'workshop']], 'and is what the page reopens on');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'usernode:workshop-tab');
  assert.deepEqual(JSON.parse(JSON.stringify(events[0].detail)),
    { slug: 'demo', tab: 'workshop' });
});

test('the traversal re-reads the address even after a press retired it', () => {
  // _setWorkshopTab deliberately retires `?ws=` so a later press is not
  // overridden by the deep link the page opened on. A traversal is not a
  // press: it must read the address it landed on again.
  const { AppView } = loadAppView({ search: '?ws=all', stored: 'needs' });
  AppView._setWorkshopTab('needs');
  assert.equal(AppView._workshopTab(), 'needs', 'the press wins while it is the last word');
  AppView._applyWorkshopTabRoute();
  assert.equal(AppView._workshopTab(), 'all', 'Back re-reads the address it landed on');
});

test('a traversal that lands off the project page tells nobody', () => {
  const { AppView, events } = loadAppView({ currentTab: 'app', currentSubTab: null });
  AppView._applyWorkshopTabRoute();
  assert.deepEqual(events, []);
});

// ── The address is the project page's alone ────────────────────────────

test('the project page carries its tab in the address', () => {
  const { App, calls, location } = loadApp({ pathname: '/app/demo/workshop', search: '' });
  App.currentApp = 'demo';
  App.currentTab = 'dev';
  App.currentSubTab = 'forum';
  App.updateHash();
  assert.equal(location.search, '?ws=workshop');
  assert.deepEqual(calls.at(-1), ['replace', '/app/demo/workshop?ws=workshop'],
    'the entry it is already on names the tab; no new entry is manufactured');
});

test('a dev session and Home do not inherit the project tab', () => {
  const { App, calls, location } = loadApp({ pathname: '/app/demo/workshop', search: '?ws=workshop' });
  App.currentApp = 'demo';
  App.currentTab = 'dev';
  App.currentSubTab = 'sessions';
  App.currentSession = null;
  App.updateHash();
  assert.equal(location.search, '', 'the session has no tab');
  assert.deepEqual(calls.at(-1), ['replace', '/app/demo/workshop'],
    'a sessions request with no id is the card list, and carries no ws');

  App.currentApp = null;
  App.currentTab = 'app';
  App.currentSubTab = null;
  App.updateHash();
  assert.equal(location.pathname, '/');
  assert.equal(location.search, '', 'Home drops the query the project owned');
});

// ── The router's two halves ────────────────────────────────────────────

test('a history traversal resets the resolved deep link and re-applies it', () => {
  const { App, AppView, calls } = loadApp({ search: '?ws=workshop' });
  AppView._workshopTabUrlOverride = 'status';
  App.restoreFromHash = () => { calls.push(['restore', AppView._workshopTabUrlOverride]); };
  App._applyRouteShots = () => {};

  App._routeFromHash(true);

  assert.deepEqual(calls[0], ['restore', undefined],
    'restoreFromHash must read the address it landed on');
  assert.deepEqual(calls.at(-1), ['apply-tab']);
});

test('a door hashchange keeps the tab the door chose', () => {
  // A door writes the remembered tab and then moves the hash. It is not a
  // traversal, so the deep-link cache it just retired must stay retired.
  const { App, AppView, calls } = loadApp();
  AppView._workshopTabUrlOverride = null;
  App.restoreFromHash = () => { calls.push(['restore', AppView._workshopTabUrlOverride]); };
  App._applyRouteShots = () => {};

  App._routeFromHash();

  assert.deepEqual(calls[0], ['restore', null]);
});

test('the tab press is wired to the record', () => {
  assert.match(WORKSHOP,
    /callAppView\('_setWorkshopTab', next\);\s*\/\/[\s\S]*?callAppView\('_pushWorkshopTab', next\);/);
});
