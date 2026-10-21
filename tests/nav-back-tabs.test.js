'use strict';

// Back goes to the page you were on, not out of the screen (#3620).
//
// A project page's tabs (Hub, Discussion, Needs you, Workshop, All items) and
// the Communities screen's two pages used to be state alone: a press changed
// no address, so it left no history entry and Back skipped straight off the
// page. The tab is `?ws=` in the address now. These tests drive the REAL
// router (public/js/app.js) in a vm with a history that remembers entries,
// and pin:
//
//   1. THE ADDRESS HELPERS — where `ws` may be written, and what else
//      survives it byte for byte.
//   2. THE SCOPE — `ws` is kept on a project page and Communities, and
//      dropped, in place, everywhere else.
//   3. A NAVIGATION TO ANOTHER PROJECT DOES NOT CARRY THE FIRST ONE'S TAB.
//   4. A TRAVERSAL ONTO A PROJECT PAGE'S ENTRY READS ITS TAB BACK and tells
//      the island, so Back and Forward move between the page's places.
//
// Run with: node --test tests/nav-back-tabs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const APP_JS = read('public/js/app.js');

const GARDEN = { slug: 'garden', name: 'Garden', icon_emoji: null, icon_url: null };
const NOTES = { slug: 'notes-ab12', name: 'Notes', icon_emoji: null, icon_url: null };
const TABS = ['status', 'discussion', 'workshop', 'needs', 'all'];

function fakeElement() {
  const classes = new Set();
  const attrs = new Map();
  return {
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (n, force) => {
        const on = force === undefined ? !classes.has(n) : !!force;
        if (on) classes.add(n); else classes.delete(n);
        return on;
      },
      contains: (n) => classes.has(n),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    style: {},
    innerHTML: '',
    textContent: '',
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    addEventListener() {},
  };
}

// app.js in a vm. History really moves (and remembers entries), so a
// traversal can be simulated by moving the index and running the router.
function router({ catalog = [GARDEN, NOTES], storage = new Map(), at = '/app/garden/workshop' } = {}) {
  const errors = [];
  const events = [];
  const noop = () => undefined;
  const elements = new Map();
  class FakeCustomEvent {
    constructor(type, init) { this.type = type; this.detail = init && init.detail; }
  }
  const context = vm.createContext({
    URL, URLSearchParams, setTimeout, clearTimeout, CustomEvent: FakeCustomEvent,
    console: { ...console, error: (...a) => errors.push(a) },
    document: {
      title: '',
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      dispatchEvent() {},
    },
    addEventListener() {},
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    PlatformUI: {
      transition(fn, opts) {
        fn();
        opts?.after?.();
      },
    },
  });
  // ── A history that remembers entries ────────────────────────────────
  let entries = [at];
  let index = 0;
  const sync = () => { context.location = new URL(entries[index], 'https://homeroom.test'); };
  const pushState = (_s, _t, url) => {
    entries = entries.slice(0, index + 1);
    entries.push(url);
    index += 1;
    sync();
  };
  const replaceState = (_s, _t, url) => { entries[index] = url; sync(); };
  sync();
  context.history = { pushState, replaceState, state: null, length: () => entries.length };
  context.window = context;
  vm.runInContext(APP_JS, context);

  // The React island's half, stubbed where the router calls it (what it is:
  // app-view.js's `?ws=` read is exercised by dev-workshop.test.js).
  const view = {
    WORKSHOP_TABS: TABS,
    _workshopTabUrlOverride: undefined,
    _workshopTabParam() {
      if (view._workshopTabUrlOverride !== undefined) return view._workshopTabUrlOverride;
      const v = new URLSearchParams(context.location.search).get('ws');
      view._workshopTabUrlOverride = TABS.includes(v) ? v : null;
      return view._workshopTabUrlOverride;
    },
    _resetWorkshopTabParam() { view._workshopTabUrlOverride = undefined; },
    _workshopTab() {
      const url = view._workshopTabParam();
      if (url) return url;
      const stored = storage.get('devWorkshopTab');
      return TABS.includes(stored) ? stored : 'status';
    },
    _getViewMode: () => 'workshop',
    _setViewMode: () => {},
    _saveFeedScroll: () => {},
    appData: null,
    close() { this.appData = null; },
    launchRecordFor: (slug) => catalog.find((r) => r.slug === slug) || null,
    open(slug) {
      const rec = catalog.find((r) => r.slug === slug) || null;
      this.appData = rec ? { ...rec } : null;
      return Promise.resolve(!!rec);
    },
  };
  context.AppView = new Proxy(view, { get: (t, k) => (k in t ? t[k] : noop) });
  context.Home = new Proxy({ _apps: catalog, _appsLoaded: true }, {
    get: (t, k) => (k in t ? t[k] : noop),
  });
  const workshopCalls = [];
  context.UsernodeReact = {
    nav: { setScreen() {}, setViewer() {}, park() {} },
    backButton: { set() {} },
    workshop: { syncTabFromUrl: () => workshopCalls.push('sync') },
  };
  context.addEventListener = () => {};
  context.dispatchEvent = (event) => { events.push(event); return true; };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const back = () => { index = Math.max(0, index - 1); sync(); };
  const forward = () => { index = Math.min(entries.length - 1, index + 1); sync(); };
  return { App: context.App, AppView: view, context, storage, errors, events, workshopCalls, entries: () => entries, back, forward, settle };
}

const here = (r) => `${r.context.location.pathname}${r.context.location.search}${r.context.location.hash}`;

// ── 1. The address helpers ─────────────────────────────────────────────

test('a tab press pushes the tab into the address and keeps every other parameter', () => {
  const r = router({ at: '/app/garden/workshop?demo=1&path=%2Fa%20b&keep=x%26y' });
  r.App._setWorkshopTabAddress('workshop', { push: true });
  assert.equal(here(r), '/app/garden/workshop?demo=1&path=%2Fa%20b&keep=x%26y&ws=workshop',
    'the other parameters are untouched, and ws is named');
  assert.equal(r.entries().length, 2, 'the press left one entry');
});

test('a door or a heal replaces in place, and a later press still pushes', () => {
  const r = router({ at: '/app/garden/workshop' });
  r.App._setWorkshopTabAddress('status', { replace: true });
  assert.equal(here(r), '/app/garden/workshop?ws=status');
  assert.equal(r.entries().length, 1, 'replacing adds no entry');
  r.App._setWorkshopTabAddress('needs', { push: true });
  assert.equal(here(r), '/app/garden/workshop?ws=needs');
  assert.equal(r.entries().length, 2);
  r.App._setWorkshopTabAddress('workshop', { push: false });
  assert.equal(here(r), '/app/garden/workshop?ws=workshop');
  assert.equal(r.entries().length, 2, 'and replacing never grows history');
});

test('ws is only a workshop route parameter', () => {
  const r = router();
  assert.equal(r.App._isWorkshopRoute('/app/garden/workshop'), true);
  assert.equal(r.App._isWorkshopRoute('/app/garden/board'), true);
  assert.equal(r.App._isWorkshopRoute('/#communities'), true);
  assert.equal(r.App._isWorkshopRoute('/#workshop'), true);
  for (const url of ['/', '/#messages', '/app/garden', '/app/garden/dev/proposals/7',
    '/app/garden/full?path=/t/1', '/#leaderboard', '/#settings']) {
    assert.equal(r.App._isWorkshopRoute(url), false, url);
  }
});

test('the heal removes ws outside a workshop route, in place, and leaves it inside one', () => {
  const away = router({ at: '/?ws=needs&demo=1#messages' });
  away.App._healWorkshopTabParam();
  assert.equal(here(away), '/?demo=1#messages');
  assert.equal(away.entries().length, 1, 'no entry was added');

  const onPage = router({ at: '/app/garden/workshop?ws=workshop' });
  onPage.App._healWorkshopTabParam();
  assert.equal(here(onPage), '/app/garden/workshop?ws=workshop', 'kept on the page that reads it');
});

// ── 2. The scope, through the real serializer ──────────────────────────

test('updateHash keeps the tab on a project page and drops it elsewhere', () => {
  const onPage = router({ at: '/app/garden/workshop?ws=discussion&demo=1' });
  onPage.App.currentApp = 'garden';
  onPage.App.currentTab = 'dev';
  onPage.App.currentSubTab = 'forum';
  onPage.App.updateHash({});
  assert.equal(here(onPage), '/app/garden/workshop?ws=discussion&demo=1');

  const home = router({ at: '/?ws=discussion&demo=1#messages' });
  home.App.currentApp = null;
  home.App.updateHash({});
  assert.equal(here(home), '/?demo=1', 'not carried onto a screen that does not read it');
});

// ── 3. Another project is another tab ──────────────────────────────────

test('a jump to another project does not carry the first project\'s tab', async () => {
  const r = router({ at: '/app/garden/workshop?ws=discussion' });
  r.storage.set('devWorkshopTab', 'needs');
  r.App.currentApp = GARDEN.slug;
  r.App.currentTab = 'dev';
  r.App.currentSubTab = 'forum';
  await r.App.navigateToApp(NOTES.slug, 'dev');
  await r.settle();
  assert.equal(r.context.location.pathname, `/app/${NOTES.slug}/workshop`);
  assert.equal(new URLSearchParams(r.context.location.search).get('ws'), 'needs',
    'the new page opens on the tab it remembers, never on Garden\'s Discussion');
  assert.deepEqual(r.errors, []);
});

test('a door\'s own tab survives the jump', async () => {
  const r = router({ at: '/app/garden/workshop?ws=discussion' });
  r.App.currentApp = GARDEN.slug;
  r.App.currentTab = 'dev';
  r.App.currentSubTab = 'forum';
  // What a Recents channel / a Communities row does: the door first. The
  // door hands its tab to the navigation (AppView._landOnTab, exercised
  // against the real app-view.js in dev-workshop.test.js).
  r.App._workshopDoorTab = { slug: NOTES.slug, tab: 'workshop' };
  assert.equal(here(r), '/app/garden/workshop?ws=discussion',
    'the departing page keeps its own address until the navigation writes the new one');
  await r.App.navigateToApp(NOTES.slug, 'dev');
  await r.settle();
  assert.equal(r.context.location.pathname, `/app/${NOTES.slug}/workshop`);
  assert.equal(new URLSearchParams(r.context.location.search).get('ws'), 'workshop',
    'the door\'s tab, not the one carried from the page before');
  assert.deepEqual(r.errors, []);
});

// ── 4. Back and Forward between a page's own entries ───────────────────

test('a traversal onto a project page entry reads its tab back and tells the page', () => {
  const r = router({ at: '/app/garden/workshop?ws=status' });
  r.App.currentApp = GARDEN.slug;
  r.App.currentTab = 'dev';
  r.App.currentSubTab = 'forum';
  // A tab press: one entry naming Workshop.
  r.App._setWorkshopTabAddress('workshop', { push: true });
  r.storage.set('devWorkshopTab', 'workshop');
  // Back onto the entry below it.
  r.back();
  assert.equal(here(r), '/app/garden/workshop?ws=status');
  // A stale cached read from the pass before must not survive the traversal.
  r.AppView._workshopTabUrlOverride = 'workshop';
  r.App.restoreFromHash();
  const restored = r.events.filter((e) => e.type === 'usernode:workshop-restore').pop();
  assert.ok(restored, 'the page was told history moved');
  assert.equal(restored.detail.tab, 'status');
  assert.equal(restored.detail.slug, GARDEN.slug);
  assert.equal(r.AppView._workshopTabParam(), 'status', 'and the cached read belongs to this address now');
  assert.equal(here(r), '/app/garden/workshop?ws=status', 'the address already named it: nothing rewritten');
  assert.equal(r.entries().length, 2, 'and no entry was added by the traversal');
});

test('Forward names the tab again, onto the same page', () => {
  const r = router({ at: '/app/garden/workshop?ws=status' });
  r.App.currentApp = GARDEN.slug;
  r.App.currentTab = 'dev';
  r.App.currentSubTab = 'forum';
  r.App._setWorkshopTabAddress('workshop', { push: true });
  r.back();
  r.App.restoreFromHash();
  r.events.length = 0;
  r.forward();
  r.App.restoreFromHash();
  const restored = r.events.filter((e) => e.type === 'usernode:workshop-restore').pop();
  assert.equal(restored.detail.tab, 'workshop');
  assert.equal(r.AppView._workshopTabParam(), 'workshop');
});

test('an arrival with no parameter opens the remembered tab and is corrected in place', () => {
  const r = router({ at: '/app/garden/workshop' });
  r.storage.set('devWorkshopTab', 'needs');
  r.App.currentApp = GARDEN.slug;
  r.App.currentTab = 'dev';
  r.App.currentSubTab = 'forum';
  r.App.restoreFromHash();
  assert.equal(here(r), '/app/garden/workshop?ws=needs', 'the entry below the first press knows its tab');
  assert.equal(r.entries().length, 1, 'and the correction added no entry');
  const restored = r.events.filter((e) => e.type === 'usernode:workshop-restore').pop();
  assert.equal(restored.detail.tab, 'needs');
});

test('a legacy board link names All items, which is the tab it opens on', () => {
  const r = router({ at: '/app/garden/board' });
  r.App.currentApp = GARDEN.slug;
  r.App.currentTab = 'dev';
  r.App.currentSubTab = 'forum';
  r.AppView._overrideWorkshopTab = (tab) => {
    r.AppView._workshopTabUrlOverride = TABS.includes(tab) ? tab : null;
  };
  r.App.restoreFromHash();
  assert.equal(here(r), '/app/garden/workshop?ws=all', 'the alias\'s tab, not the remembered one');
  const restored = r.events.filter((e) => e.type === 'usernode:workshop-restore').pop();
  assert.equal(restored.detail.tab, 'all');
});

// ── 5. Communities reads the tab back too ──────────────────────────────

test('landing on Communities asks the screen to read the address, before its own guard', () => {
  const r = router({ at: '/#communities?ws=needs' });
  r.App.navigateToWorkshop();
  assert.deepEqual(r.workshopCalls, ['sync'], 'the tab comes from this address');
  // Already open: the traversal still has to move the page.
  r.workshopCalls.length = 0;
  r.App.navigateToWorkshop();
  assert.deepEqual(r.workshopCalls, ['sync'], 'the guard does not swallow it');
  const src = APP_JS.slice(APP_JS.indexOf('  navigateToWorkshop() {'));
  assert.ok(src.indexOf('syncTabFromUrl') < src.indexOf('if (App._inWorkshop && !App.currentApp) return;'));
});

test('the Communities tab pressed from a project page opens the list, not that page\'s Needs you', () => {
  const r = router({ at: '/app/garden/workshop?ws=needs#communities' });
  r.App.currentApp = GARDEN.slug;
  r.App.currentTab = 'dev';
  r.App.currentSubTab = 'forum';
  r.App.restoreFromHash();
  assert.equal(r.context.location.pathname, '/');
  assert.equal(r.context.location.search, '?ws=status',
    'the project\'s tab does not name one of this screen\'s pages');
  assert.equal(r.context.location.hash, '#communities');
  assert.deepEqual(r.workshopCalls, ['sync'], 'and the screen reads the list');
});
