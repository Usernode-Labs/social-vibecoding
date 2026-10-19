'use strict';

// #5297: EVERY PLACE OF A PROJECT'S PAGE HAS AN ADDRESS OF ITS OWN.
//
// The Hub, Needs you, the Workshop and #general shared one address
// (`/app/<slug>/workshop`), so a link copied from the Hub opened whatever
// place the reader last had up. Each place now has its own:
//
//   /app/<slug>/dev/hub · dev/needs · dev/workshop · dev/all · dev/bot
//   /app/<slug>/dev/discussion (#general; dev/general reads as it)
//   /app/<slug>/dev/c/<handle> (a topic's channel, as before)
//
// The React side builds them (places.ts placePath / placeHref), the router
// reads and writes them (AppView._placeSegment / _placeFromSegs, App._appUrl
// `place`, App._placeAddress), and a press pushes them (_pushWorkshopTab).
// `/app/<slug>/workshop` and bare `/app/<slug>/dev` keep opening the page on
// the place last shown, and the router then names that place.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx } = require('./lib/render-tsx');
const AppView = require('../public/js/app-view.js');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const PLACES = 'frontend/src/features/dev-board/workshop/places.ts';
const KEY = AppView.WORKSHOP_TAB_STATE_KEY;
const ORIGIN = 'https://homeroom.test';

const segs = (p) => p.replace(/^\/+/, '').split('/');

test('placePath: each place its own address, the plan the Hub\'s', () => {
  const p = loadTsx(PLACES);
  const want = {
    status: 'dev/hub', plan: 'dev/hub', needs: 'dev/needs', workshop: 'dev/workshop',
    all: 'dev/all', bot: 'dev/bot', discussion: 'dev/discussion', 'c:onboarding': 'dev/c/onboarding',
  };
  for (const [key, address] of Object.entries(want)) {
    assert.equal(p.placePath(key), address, key);
    assert.equal(p.placeHref('notes', key), `/app/notes/${address}`, key);
  }
});

test('the React side and the router agree: every address placeHref builds reads back as its place', () => {
  const p = loadTsx(PLACES);
  for (const key of ['status', 'needs', 'workshop', 'all', 'bot', 'discussion', 'c:onboarding', 'c:homeroom-bot']) {
    const href = p.placeHref('notes', key);
    assert.equal(AppView._placeFromSegs(segs(href)), key, href);
    assert.equal(`/app/notes/${AppView._placeSegment(key)}`, href, `${key}: the same address both ways`);
  }
  assert.equal(AppView._placeSegment('plan'), 'dev/hub', 'the plan is never reopened on');
  assert.equal(AppView._placeSegment('nowhere'), null);
});

test('_placeFromSegs reads the places and leaves every other address alone', () => {
  const at = (p) => AppView._placeFromSegs(segs(p));
  assert.equal(at('app/notes/dev/hub'), 'status');
  assert.equal(at('app/notes/dev/needs'), 'needs');
  assert.equal(at('app/notes/dev/workshop'), 'workshop');
  assert.equal(at('app/notes/dev/general'), 'discussion', '#general by its handle');
  assert.equal(at('app/notes/dev/c/general'), 'discussion');
  assert.equal(at('app/notes/dev/c/Onboarding'), 'c:onboarding', 'a handle is lower case');
  assert.equal(at('app/notes/dev/Needs'), 'needs');
  for (const other of [
    'app/notes/workshop', 'app/notes/dev', 'app/notes/dev/chat', 'app/notes/dev/issues/4',
    'app/notes/dev/sessions/9', 'app/notes/dev/changes/12', 'app/notes/dev/c', 'app/notes/dev/c/9bad',
    'app/notes/dev/hub/extra', 'app/notes/dev/plan', 'app/notes/dev/status', 'app/notes', 'messages/app/notes',
  ]) {
    assert.equal(at(other), null, other);
  }
});

// A window with real-enough history, as tests/back-navigation-pages.test.js has.
function fakeWindow(start) {
  const entries = [{ url: new URL(start, ORIGIN), state: null }];
  let i = 0;
  const here = () => entries[i].url;
  return {
    entries,
    location: {
      get pathname() { return here().pathname; },
      get search() { return here().search; },
      get hash() { return here().hash; },
    },
    history: {
      get state() { return entries[i].state; },
      pushState(state, _t, url) {
        entries.splice(i + 1);
        entries.push({ url: url == null ? new URL(here().href) : new URL(url, here()), state: structuredClone(state) });
        i = entries.length - 1;
      },
      replaceState(state, _t, url) {
        entries[i] = { url: url == null ? entries[i].url : new URL(url, here()), state: structuredClone(state) };
      },
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    dispatchEvent: () => true,
  };
}

function withWindow(win, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const was = globalThis.window;
  globalThis.window = win;
  AppView._workshopTabUrlOverride = undefined;
  try { return fn(); } finally {
    if (had) globalThis.window = was; else delete globalThis.window;
    AppView._workshopTabUrlOverride = undefined;
  }
}

test('a place\'s address is the project page, for its own project only', () => {
  const on = (start, slug = 'garden') => withWindow(fakeWindow(start), () => AppView._onProjectPage(slug));
  assert.equal(on('/app/garden/dev/hub'), true);
  assert.equal(on('/app/garden/dev/needs?demo=1'), true);
  assert.equal(on('/app/garden/dev/c/onboarding'), true);
  assert.equal(on('/#app/garden/dev/workshop'), true);
  assert.equal(on('/app/garden/workshop'), true, 'the page\'s own address still is');
  assert.equal(on('/app/garden/dev/hub', 'other'), false);
  assert.equal(on('/app/garden/dev/issues/4'), false, 'an item is a page of its own');
});

test('_placeUrl keeps the query but `ws`, which the path now says', () => {
  withWindow(fakeWindow('/app/garden/dev/hub?demo=1&ws=needs&token=t'), () => {
    assert.equal(AppView._placeUrl('garden', 'needs'), '/app/garden/dev/needs?demo=1&token=t');
    assert.equal(AppView._placeUrl('garden', 'c:infra'), '/app/garden/dev/c/infra?demo=1&token=t');
    assert.equal(AppView._placeUrl('garden', 'nowhere'), null);
  });
});

test('presses walk the places\' own addresses, and Back reads each entry\'s place', () => {
  const win = fakeWindow('/app/garden/dev/hub');
  withWindow(win, () => {
    AppView._pushWorkshopTab('garden', 'status', 'needs');
    AppView._pushWorkshopTab('garden', 'needs', 'discussion');
    assert.deepEqual(win.entries.map((e) => e.url.pathname),
      ['/app/garden/dev/hub', '/app/garden/dev/needs', '/app/garden/dev/discussion']);
    assert.deepEqual(win.entries.map((e) => e.state[KEY].tab), ['status', 'needs', 'discussion']);
  });
});

test('a door that turns the page in place renames the address; the page\'s own address is the router\'s', () => {
  // The logo menu's "Go to community hub", pressed on Needs you.
  const win = fakeWindow('/app/garden/dev/needs?demo=1');
  win.entries[0].state = { [KEY]: { slug: 'garden', tab: 'needs', from: 'status' }, keep: 1 };
  withWindow(win, () => {
    assert.equal(AppView._syncPlaceAddress('garden', 'status'), true);
    assert.equal(win.entries.length, 1, 'the same entry, not a new one');
    assert.equal(win.entries[0].url.href, `${ORIGIN}/app/garden/dev/hub?demo=1`);
    assert.deepEqual(win.entries[0].state, { [KEY]: { slug: 'garden', tab: 'status', from: 'status' }, keep: 1 });
    assert.equal(AppView._syncPlaceAddress('garden', 'status'), false, 'already its address');
    assert.equal(AppView._syncPlaceAddress('garden', 'plan'), false, 'the plan is the Hub\'s address');
  });
  for (const start of ['/app/garden/workshop', '/app/garden/dev/needs#app/garden/workshop', '/app/other/dev/needs', '/app/garden/dev/issues/4']) {
    const w = fakeWindow(start);
    withWindow(w, () => assert.equal(AppView._syncPlaceAddress('garden', 'status'), false, start));
    assert.equal(w.entries[0].url.href, new URL(start, ORIGIN).href, `${start} is left as it is`);
  }
  // The page calls it whenever the place on show changes.
  assert.match(read('frontend/src/features/dev-board/workshop/workshop.tsx'),
    /useEffect\(\(\) => \{\s*if \(v\.slug\) callAppView\('_syncPlaceAddress', v\.slug, tab\);\s*\}, \[v\.slug, tab\]\);/);
});

// app.js, in a vm with the real AppView's address helpers.
function loadApp({ pathname = '/', search = '', hash = '', shown = 'status' } = {}) {
  const location = { origin: ORIGIN, pathname, search, hash };
  Object.defineProperty(location, 'href', { get() { return `${ORIGIN}${location.pathname}${location.search}${location.hash}`; } });
  const calls = [];
  const history = {
    state: null,
    pushState(_s, _t, value) { calls.push(['push', value]); Object.assign(location, pick(value)); },
    replaceState(_s, _t, value) { calls.push(['replace', value]); Object.assign(location, pick(value)); },
  };
  function pick(value) {
    const u = new URL(value, location.href);
    return { pathname: u.pathname, search: u.search, hash: u.hash };
  }
  const element = {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, appendChild() {},
  };
  const landed = [];
  const View = {
    appData: null,
    pendingInnerPath: null,
    _getViewMode: () => 'workshop',
    _setViewMode() {},
    _placeSegment: AppView._placeSegment,
    _placeFromSegs: AppView._placeFromSegs,
    _historyWorkshopTab: () => null,
    _setWorkshopTab(t) { shown = t; },
    _landOnTab(slug, t) { landed.push([slug, t]); shown = t; },
    _placeOnShow: () => shown,
  };
  const window = { location, history, addEventListener() {}, AppView: View };
  const context = vm.createContext({
    window, location, history, AppView: View,
    document: {
      visibilityState: 'visible', title: '', addEventListener() {},
      getElementById() { return element; }, querySelector() { return null; },
      createElement() { return { ...element }; }, head: element,
    },
    PlatformUI: { transition(fn) { fn(); }, pullToRefresh() {} },
    URL, URLSearchParams, AbortController,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: {}, console, setTimeout, clearTimeout, fetch: async () => ({ ok: false }),
  });
  vm.runInContext(read('public/js/app.js'), context);
  return { App: window.App, calls, landed, location };
}

test('the serializer names the place when it is told one, and only for the page', () => {
  const { App } = loadApp({ search: '?demo=1' });
  assert.equal(App._appUrl('notes', 'dev', null, 'forum', { boardView: 'workshop', place: 'needs' }), '/app/notes/dev/needs?demo=1');
  assert.equal(App._appUrl('notes', 'dev', null, 'forum', { boardView: 'workshop', place: 'c:infra' }), '/app/notes/dev/c/infra?demo=1');
  assert.equal(App._appUrl('notes', 'dev', null, 'forum', { boardView: 'workshop' }), '/app/notes/workshop?demo=1',
    'no place: the page\'s own address, as before');
  assert.equal(App._appUrl('notes', 'dev', { kind: 'issue', id: 4 }, 'topic', { place: 'needs' }), '/app/notes/dev/issues/4?demo=1',
    'an item\'s address is its own');
  assert.equal(App._pagePlace('dev', 'forum', false), 'status');
  assert.equal(App._pagePlace('dev', 'topic', false), null);
  assert.equal(App._pagePlace('app', null, false), null);
  // A place's address is remembered as the page's, which reopens where it was.
  assert.equal(App._workshopViewPath('/app/notes/dev/needs?demo=1'), '/app/notes/workshop');
  assert.equal(App._workshopViewPath('/app/notes/dev/issues/4'), '/app/notes/dev/issues/4');
});

test('opening a place\'s address lands on it; the page\'s old address is renamed to the place it opens on', () => {
  const routeTo = (opts) => {
    const app = loadApp(opts);
    app.App.navigateToApp = () => {};
    app.App.ImproveStatus = { setAppOpen() {} };
    app.App.restoreFromHash();
    return app;
  };
  const needs = routeTo({ hash: '#app/notes/dev/needs', search: '?demo=1' });
  assert.deepEqual(needs.landed, [['notes', 'needs']]);
  assert.deepEqual(needs.calls.filter(([k]) => k === 'replace').at(-1), ['replace', '/app/notes/dev/needs?demo=1']);

  const hub = routeTo({ pathname: '/app/notes/dev/hub', shown: 'needs' });
  assert.deepEqual(hub.landed, [['notes', 'status']], 'a copied Hub link opens the Hub, whatever was last up');
  assert.equal(hub.location.pathname, '/app/notes/dev/hub');

  const old = routeTo({ hash: '#app/notes/workshop', shown: 'workshop' });
  assert.deepEqual(old.landed, [], '…/workshop is no door: the place last shown');
  assert.equal(old.location.pathname, '/app/notes/dev/workshop');

  const bare = routeTo({ hash: '#app/notes/dev', shown: 'status' });
  assert.equal(bare.location.pathname, '/app/notes/dev/hub');
});
