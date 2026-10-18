'use strict';

// The project page's band tabs are history steps (#3620).
//
// A tab press changed the page's React state only, so the browser's stack
// held the single entry opening the page pushed and the device Back button
// jumped over the tabs to the screen below — tap Workshop, press Back, land
// on Home. Now each entry carries, in its state (never in the address), the
// tab the page shows on it: a viewer's press stamps what the current entry
// showed and pushes a step at the same address, and a traversal applies the
// entry's stamp through the page's door event.
//
// Everything below drives the REAL router and the REAL AppView tab seam in a
// vm over a model of the window's history, the harness family of
// app-close-origin.test.js:
//
//   1. a press stamps the entry it was on and pushes the step, at the SAME
//      address — tabs are not URLs;
//   2. Back applies the entry's tab through the door event and leaves the
//      remembered-tab localStorage alone — back is not a door;
//   3. Forward re-applies;
//   4. a press on the tab already lit adds no entry;
//   5. an unknown stamp is ignored;
//   6. an unstamped entry changes nothing — the page opens as it always did;
//   7. a page applying during a traversal (a mount seed) stamps the entry it
//      lands on and pushes nothing;
//   8. a page not yet mounted (a sub-view on top) reads the stamp off the
//      transient, not off the remembered tab.
//
// Run with: node --test tests/workshop-tab-history.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const APP_JS = read('public/js/app.js');
const APP_VIEW_JS = read('public/js/app-view.js');
const ORIGIN = 'https://homeroom.test';
const STAMP = '__wsTab';

// A history whose entries carry state, whose back()/forward() traverse the
// way a browser's do: the address moves, then popstate routes.
function makeHistory(startUrl) {
  const location = new URL(startUrl, ORIGIN);
  const entries = [{ url: location.href, state: null }];
  let at = 0;
  let onTraverse = () => {};
  const moveTo = (i) => {
    at = i;
    location.href = entries[i].url;
    onTraverse();
  };
  const history = {
    get state() { return entries[at].state; },
    get length() { return entries.length; },
    pushState(state, _t, url) {
      entries.splice(at + 1);
      entries.push({ url: new URL(url, location.href).href, state: state ?? null });
      at = entries.length - 1;
      location.href = entries[at].url;
    },
    replaceState(state, _t, url) {
      const e = entries[at];
      e.state = state ?? null;
      if (url) {
        e.url = new URL(url, location.href).href;
        location.href = e.url;
      }
    },
    back() { if (at > 0) moveTo(at - 1); },
    forward() { if (at < entries.length - 1) moveTo(at + 1); },
  };
  return { history, location, entries, get at() { return at; }, set onTraverse(fn) { onTraverse = fn; } };
}

function fakeElement() {
  const classes = new Set();
  const attrs = new Map();
  const listeners = new Map();
  return {
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    listeners,
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    style: {}, innerHTML: '', textContent: '',
    querySelector: () => null, querySelectorAll: () => [],
    appendChild() {},
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
}

// app.js AND app-view.js in one context — the router and the page's tab seam,
// the way the two scripts share a window in the browser.
function harness(startUrl) {
  const h = makeHistory(startUrl);
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const listeners = new Map();
  const doors = [];
  const elements = new Map();
  const context = vm.createContext({
    location: h.location,
    history: h.history,
    URL, URLSearchParams, console, setTimeout, clearTimeout,
    CustomEvent: class CustomEvent {
      constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; }
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const l = listeners.get(type);
      if (l) { const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1); }
    },
    dispatchEvent: (event) => {
      if (event.type === 'usernode:workshop-tab') doors.push(event.detail);
      for (const fn of listeners.get(event.type) || []) fn(event);
    },
    localStorage: storage,
    document: {
      title: '',
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, dispatchEvent() {},
      documentElement: fakeElement(),
    },
    PlatformUI: new Proxy({
      transition(fn, o) { fn(); if (o && o.after) o.after(); },
    }, { get: () => () => {} }),
  });
  context.window = context;
  vm.runInContext(APP_JS, context);
  vm.runInContext(APP_VIEW_JS, context);
  const App = context.App;
  h.onTraverse = () => App._routeFromHash();
  App.ImproveStatus = { setAppOpen() {} };
  App._wirePullToRefresh = () => {};
  // The render layer is not the seam under test; the door and the transient
  // are. Counts the passes that would have re-rendered the page.
  let switches = 0;
  App.switchTab = () => { switches += 1; };
  context.UsernodeReact = { nav: { setScreen() {}, setViewer() {} } };
  App.bindEvents();
  // The page IS the seeded page: opened at its address, on its band.
  App.currentApp = 'pond';
  App.currentTab = 'dev';
  App.currentSubTab = 'forum';
  return { context, App, AppView: context.AppView, h, store, doors };
}

// The reported journey: the page was opened (entry 0, the hub showing), the
// viewer tapped Workshop (a step pushed over it).
function seeded() {
  const t = harness(`${ORIGIN}/app/pond/workshop`);
  t.App.noteWorkshopTabChange('workshop', { from: 'status' });
  return t;
}

test('a press stamps the entry it was on and pushes the step at the same address', () => {
  const t = harness(`${ORIGIN}/app/pond/workshop`);
  t.App.noteWorkshopTabChange('workshop', { from: 'status' });
  assert.equal(t.h.entries.length, 2, 'exactly one entry is pushed');
  assert.equal(t.h.entries[0].state[STAMP], 'status', 'the outgoing entry keeps what it showed');
  assert.equal(t.h.entries[1].state[STAMP], 'workshop');
  assert.equal(t.h.entries[1].url, `${ORIGIN}/app/pond/workshop`, 'tabs are not URLs');
  assert.equal(t.h.location.search, '', 'the address gains no query');
});

test('back applies the entry\'s tab through the door event and leaves the remembered tab alone', () => {
  const t = seeded();
  // The press was a tab press: the page WROTE the remembered tab...
  t.AppView._setWorkshopTab('workshop');
  assert.equal(t.store.get('devWorkshopTab'), 'workshop');
  t.h.history.back();
  assert.equal(t.doors.length, 1, 'the traversal applies the stamp');
  const door = t.doors[0];
  assert.equal(door.slug, 'pond');
  assert.equal(door.tab, 'status');
  assert.equal(door.fromHistory, true);
  // ...and BACK IS NOT A DOOR: the remembered tab is untouched, so a fresh
  // page still reopens on what the viewer last chose.
  assert.equal(t.store.get('devWorkshopTab'), 'workshop');
});

test('forward re-applies the step it returns to', () => {
  const t = seeded();
  t.h.history.back();
  t.h.history.forward();
  assert.equal(t.doors.length, 2);
  assert.equal(t.doors[1].tab, 'workshop');
  assert.equal(t.doors[1].fromHistory, true);
});

test('a press on the tab already lit adds no entry', () => {
  const t = seeded();
  t.App.noteWorkshopTabChange('workshop', { from: 'workshop' });
  assert.equal(t.h.entries.length, 2);
});

test('an unknown stamp is ignored', () => {
  const t = harness(`${ORIGIN}/app/pond/workshop`);
  t.h.entries[0].state = { [STAMP]: 'kitchen' };
  t.App.restoreFromHash();
  assert.deepEqual(t.doors, []);
  assert.equal(t.App.currentTab, 'dev', 'the route itself is untouched');
});

test('an unstamped entry changes nothing', () => {
  const t = harness(`${ORIGIN}/app/pond/workshop`);
  t.App.restoreFromHash();
  assert.deepEqual(t.doors, []);
  assert.equal(t.h.entries.length, 1, 'a traversal pushes nothing');
  assert.equal(t.h.entries[0].state, null, 'and stamps nothing');
});

test('a page applying during a traversal stamps the entry it lands on and pushes nothing', () => {
  // A mount seed (a cold deep link, the Communities tab's resume): the page
  // is being APPLIED, so the entry it lands on now shows the seeded tab.
  const t = harness(`${ORIGIN}/app/pond/workshop`);
  t.App._isRestoring = true;
  t.App.noteWorkshopTabChange('workshop');
  t.App._isRestoring = false;
  assert.equal(t.h.entries.length, 1, 'the traversal owns the step');
  assert.equal(t.h.entries[0].state[STAMP], 'workshop');
  // Back from the first band press now unwinds to the seeded tab, and the
  // press's own step sits on top of it.
  t.App.noteWorkshopTabChange('needs', { from: 'workshop' });
  assert.equal(t.h.entries.length, 2);
  t.h.history.back();
  assert.equal(t.doors[0].tab, 'workshop');
});

test('a page not yet mounted reads the stamp off the transient, not off the memory', () => {
  // The page is under a sub-view (a topic on top): the stamp reaches it the
  // way a retired /board link's landing does.
  const t = harness(`${ORIGIN}/app/pond/workshop`);
  t.App.currentSubTab = 'topic';
  t.h.entries[0].state = { [STAMP]: 'needs' };
  t.App.restoreFromHash();
  assert.deepEqual(t.doors, [], 'no door: the page is not on its band');
  assert.equal(t.AppView._workshopTab(), 'needs', 'the mount seed reads the stamp');
  assert.equal(t.store.has('devWorkshopTab'), false, 'the transient is not the memory');
});

test('a door reports as told, not made: it stamps, never pushes', () => {
  const t = harness(`${ORIGIN}/app/pond/workshop`);
  t.App.noteWorkshopTabChange('status', { fromHistory: true });
  assert.equal(t.h.entries.length, 1, 'no step of its own');
  assert.equal(t.h.entries[0].state[STAMP], 'status',
    'but the entry names the tab the page now shows, so Back from a later press unwinds here');
});

test('the reporter stays out of the way where there is no history to write', () => {
  const t = harness(`${ORIGIN}/app/pond/workshop`);
  const withoutPushState = { state: null };
  t.context.window.history = withoutPushState;
  assert.doesNotThrow(() => t.App.noteWorkshopTabChange('workshop', { from: 'status' }));
  t.context.window.history = t.h.history;
  assert.doesNotThrow(() => t.App.noteWorkshopTabChange('kitchen'), 'an unknown key says nothing');
  assert.doesNotThrow(() => t.App.noteWorkshopTabChange('workshop', { from: 42 }), 'a junk `from` is not a stamp');
});
