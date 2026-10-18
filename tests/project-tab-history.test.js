// A project page's tabs — and the Communities screen's Needs you page — are
// PAGES: each one names itself in the address and takes a history entry, so
// Back steps one page at a time instead of leaving the screen (#3620).
//
// What is pinned here, and why each would fail silently if it drifted:
//
//   * The serializer names the page (`ptab`) on the project's card list and
//     nowhere else, and drops the page parameters from addresses whose route
//     does not read them — otherwise a project tab reopens the Communities
//     screen on its Needs you page.
//   * The page parameter is READ from `ptab` first and from the older `ws`
//     second, so links made before this change still open what they name,
//     and a changed address is re-read (Back and Forward move it unseen).
//   * A tab press PUSHES one entry, and only when the address differs, so
//     pressing the tab already on screen adds nothing.
//   * The mounted screens read the address on popstate, because the router
//     treats every tab of a project as one screen and does not re-dispatch.
//
// Run with: node --test tests/project-tab-history.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const APP_SRC = read('public/js/app.js');
const APP_VIEW_SRC = read('public/js/app-view.js');
const WORKSHOP_TSX = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const WORKSHOP_SCREEN = read('frontend/src/features/workshop/index.tsx');

const TABS = ['status', 'discussion', 'workshop', 'needs', 'all'];

// A browser-shaped sandbox: location and history actually move, the way the
// router sees them, so the serializers and the cache are exercised for real.
function harness(initial = {}) {
  const origin = 'https://social-vibecoding.test';
  const location = {
    origin,
    pathname: initial.pathname || '/',
    search: initial.search || '',
    hash: initial.hash || '',
  };
  Object.defineProperty(location, 'href', {
    get() { return `${origin}${location.pathname}${location.search}${location.hash}`; },
  });
  const calls = [];
  const history = {
    state: null,
    pushState(state, _title, value) { calls.push(['push', value]); applyUrl(value); },
    replaceState(state, _title, value) { calls.push(['replace', value]); applyUrl(value); },
  };
  function applyUrl(value) {
    const next = new URL(value, `${origin}${location.pathname}${location.search}${location.hash}`);
    location.pathname = next.pathname;
    location.search = next.search;
    location.hash = next.hash;
  }
  return { origin, location, history, calls, applyUrl };
}

function loadApp(initial = {}) {
  const h = harness(initial);
  const AppView = {
    WORKSHOP_TABS: TABS,
    _workshopTab() { return initial.tab || 'status'; },
    _getViewMode() { return 'workshop'; },
  };
  const window = {
    location: h.location,
    history: h.history,
    addEventListener() {},
    AppView,
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
  const context = vm.createContext({
    window, document, location: h.location, history: h.history, AppView,
    URL, URLSearchParams,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    console,
  });
  vm.runInContext(APP_SRC, context);
  const App = window.App;
  App._isMessagesThread = () => false;
  return { ...h, App, AppView };
}

function loadAppView(initial = {}) {
  const h = harness(initial);
  const sandbox = {
    console,
    URL, URLSearchParams,
    location: h.location,
    history: h.history,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    addEventListener() {},
    App: initial.App || {
      _isRestoring: false,
      currentApp: 'notes',
      currentTab: 'dev',
      currentSubTab: 'forum',
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return { ...h, AppView: sandbox.__AppView, App: sandbox.App };
}

test('a project address names its page, and only a card list has one', () => {
  const { App } = loadApp({ search: '?demo=1' });
  assert.equal(
    App._appUrl('notes', 'dev', null, 'forum', { boardView: 'workshop', workshopTab: 'workshop' }),
    '/app/notes/workshop?demo=1&ptab=workshop',
  );
  assert.equal(
    App._appUrl('notes', 'dev', null, 'forum', { boardView: 'workshop', workshopTab: 'needs' }),
    '/app/notes/workshop?demo=1&ptab=needs',
  );
  // A topic, the App tab and the chromeless route are not pages of it.
  assert.equal(
    App._appUrl('notes', 'dev', { kind: 'proposal', id: 42 }, 'topic', { workshopTab: 'needs' }),
    '/app/notes/dev/proposals/42?demo=1',
  );
  assert.equal(App._appUrl('notes', 'app', null, null, { workshopTab: 'needs' }),
    '/app/notes?demo=1');
  assert.equal(App._appUrl('notes', 'app', null, null, {
    chromeless: true, innerPath: '/t/1', workshopTab: 'needs',
  }), '/app/notes/full?demo=1&path=%2Ft%2F1');
  // An unknown page is not written at all.
  assert.equal(
    App._appUrl('notes', 'dev', null, 'forum', { boardView: 'workshop', workshopTab: 'nope' }),
    '/app/notes/workshop?demo=1',
  );
});

test('a stale page parameter is dropped from an address, and by the root serializer', () => {
  const { App, location, calls } = loadApp({ search: '?demo=1&ws=all&ptab=needs' });
  // A project page keeps both: the router reads the tab and rewrites `ws`.
  App._dropWorkshopTabParams('app');
  assert.equal(location.search, '?demo=1&ws=all&ptab=needs');
  assert.deepEqual(calls, [], 'nothing to rewrite, no history write');

  // Communities reads `ws`, never `ptab`.
  location.pathname = '/';
  location.hash = '#communities';
  App._dropWorkshopTabParams('communities');
  assert.equal(location.search, '?demo=1&ws=all');
  assert.deepEqual(calls, [['replace', '/?demo=1&ws=all#communities']],
    'dropped in place, never as a new entry');

  // Everywhere else neither parameter means anything.
  location.hash = '#messages';
  App._dropWorkshopTabParams('messages');
  assert.equal(location.search, '?demo=1');

  location.search = '?demo=1&ws=needs&ptab=all';
  assert.equal(App._rootUrl(), '/?demo=1',
    'Home never carries a page of the screen just left');
  assert.equal(App._rootUrl('#communities'), '/?demo=1#communities');
});

test('updateHash names the page the project is on', () => {
  const { App, AppView, calls } = loadApp({ search: '?demo=1', tab: 'workshop' });
  App.currentApp = 'notes';
  App.currentTab = 'dev';
  App.currentSubTab = 'forum';
  App.updateHash();
  assert.deepEqual(calls, [['push', '/app/notes/workshop?demo=1&ptab=workshop']]);
  // The same screen again replaces: a tab press is the only thing that
  // pushes a page entry (AppView.navigateWorkshopTab).
  AppView._workshopTab = () => 'needs';
  App._isRestoring = false;
  App.updateHash();
  assert.deepEqual(calls[1], ['replace', '/app/notes/workshop?demo=1&ptab=needs']);
});

test('the page parameter prefers ptab, still reads ws, and re-reads a moved address', () => {
  const { AppView, location } = loadAppView({ search: '?ptab=needs' });
  assert.equal(AppView._workshopTabParam(), 'needs');
  location.search = '?ws=all';
  assert.equal(AppView._workshopTabParam(), 'all', 'a link from before this change still works');
  location.search = '?ptab=workshop&ws=all';
  assert.equal(AppView._workshopTabParam(), 'workshop', 'the project page spelling wins');
  location.search = '?ptab=nope';
  assert.equal(AppView._workshopTabParam(), null, 'garbage names no page');
  // An explicit choice retires the address for the address it was made on.
  location.search = '?ws=needs';
  AppView._setWorkshopTab('status');
  assert.equal(AppView._workshopTabParam(), null);
  // ...until a history traversal returns to that very address, which is the
  // page the press came FROM: it must be read again, not stay retired.
  AppView._reloadWorkshopTabParam();
  assert.equal(AppView._workshopTabParam(), 'needs',
    'Back to the page a press came from reads that page');
  location.search = '?ptab=discussion';
  assert.equal(AppView._workshopTabParam(), 'discussion',
    'Back and Forward move the address without telling the cache');
});

test('a tab press pushes one entry, and the lit page adds none', () => {
  const App = {
    _isRestoring: false,
    currentApp: 'notes',
    currentTab: 'dev',
    currentSubTab: 'forum',
    _appUrl(slug, tab, ref, subTab, options) {
      return `/app/${slug}/workshop?ptab=${options.workshopTab}`;
    },
  };
  const { AppView, calls } = loadAppView({ pathname: '/app/notes/workshop', App });
  AppView.navigateWorkshopTab('needs');
  assert.deepEqual(calls, [['push', '/app/notes/workshop?ptab=needs']]);
  // The address now names it: pressing the lit page changes nothing.
  AppView.navigateWorkshopTab('needs');
  assert.equal(calls.length, 1);
  // An unknown page is refused, and a restore is not a press.
  AppView.navigateWorkshopTab('nope');
  App._isRestoring = true;
  AppView.navigateWorkshopTab('all');
  assert.equal(calls.length, 1);
});

test('tabFromAddress and tabSearch name the same pages on both sides', () => {
  const { tabFromAddress } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.equal(tabFromAddress('?ptab=needs'), 'needs');
  assert.equal(tabFromAddress('?ws=all'), 'all');
  assert.equal(tabFromAddress('?ptab=discussion'), 'discussion');
  assert.equal(tabFromAddress('?ptab=workshop'), 'workshop');
  assert.equal(tabFromAddress(''), 'status', 'an address that names no page is the hub');
  assert.equal(tabFromAddress('?ptab=nope'), 'status');

  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  assert.equal(mod.tabSearch('?demo=1&ws=status&ptab=all', 'needs'), '?demo=1&ws=needs');
  assert.equal(mod.tabSearch('?ptab=all', 'status'), '?ws=status');
  assert.equal(mod.tabSearch('', 'needs'), '?ws=needs');
});

test('the screens read the address on Back, and every page change writes it', () => {
  // The project page: a tab press and a door both push the page they went
  // to, and a popstate listener applies the page the address names.
  assert.match(WORKSHOP_TSX,
    /callAppView\('navigateWorkshopTab', next\)/,
    'a tab press is a page change');
  assert.match(WORKSHOP_TSX,
    /callAppView\('navigateWorkshopTab', door\.tab\)/,
    'a door to another page is one too');
  assert.match(WORKSHOP_TSX,
    /tabFromAddress\(window\.location\.search\)[\s\S]{0,400}addEventListener\('popstate', onPop\)/,
    'Back and Forward are read by the mounted page');

  // Communities: the Needs you page and its way back are page changes, and
  // Back applies the page the address names without writing it again.
  const setTab = /setTab\(tab: TabKey\) \{([\s\S]*?)\n  \},/.exec(WORKSHOP_SCREEN);
  assert.ok(setTab, 'setTab is the page change');
  assert.match(setTab[1], /workshopStore\.set\(\{ tab: next \}\)/);
  assert.match(setTab[1], /history\.pushState\(null, '', url\)/);
  assert.match(setTab[1], /tabSearch\(location\.search, next\)/);
  const restoreTab = /restoreTab\(tab: TabKey\) \{([\s\S]*?)\n  \},/.exec(WORKSHOP_SCREEN);
  assert.ok(restoreTab, 'restoreTab is Back');
  assert.doesNotMatch(restoreTab[1], /pushState|replaceState/,
    'a popstate already moved the address');
  assert.match(WORKSHOP_SCREEN,
    /workshopController\.restoreTab\(tabFromQuery\(location\.search\) \|\| 'status'\)[\s\S]{0,300}addEventListener\('popstate', onPop\)/);

  // The router drops the parameters where they are stale, and the canonical
  // project address is built with the page it names.
  assert.match(APP_SRC,
    /App\._dropWorkshopTabParams\(hash\.split\('\/'\)\[0\]\)/,
    'restoreFromHash cleans the address it is about to route');
  assert.match(APP_SRC,
    /restoreFromHash\(\) \{\s*App\._isRestoring = true;[\s\S]{0,500}AppView\._reloadWorkshopTabParam\(\)/,
    'and every routing pass rereads the page parameter, Back included');
  assert.match(APP_SRC,
    /const canonicalAppUrl = App\._appUrl\(slug, tab, ref, subTab,\s*\{ chromeless, innerPath, boardView, workshopTab: App\._pageTab\(tab, subTab\) \}\);/,
    'and keeps the page in the canonical spelling');
});
