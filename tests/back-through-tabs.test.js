'use strict';

// #3620: Back through a page's own tabs.
//
// The community page's four tabs (Hub, Discussion, Needs you, Workshop) and
// All items, and the Communities screen's Needs you page, are React state
// with no address of their own. Changing tab therefore left no history entry:
// Back skipped the tab you were on and left the community. Each tab press now
// writes a record at the SAME address naming the tab, and a capture-phase
// popstate listener on AppView reads that record before the router runs.
//
// What is pinned here:
//   * a tab press writes one push, at the same address, naming the tab and
//     carrying no dialog marker;
//   * the record the router made keeps the tab the page opened on;
//   * a popstate onto a tab record switches the screen once, without
//     stopping the event, and a record naming the tab already showing does
//     nothing;
//   * the in-page back arrow walks a pushed step and, on a base record,
//     rewrites it in place;
//   * a door pressed on the page is a step, a door from another screen is
//     left to the route its navigation writes.
//
// Run with: node --test tests/back-through-tabs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_VIEW_SRC = fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8');

const PANE = '__unPaneTab';

function makeHistory(url = 'http://localhost/app/garden/dev') {
  const entries = [{ state: null, url: url }];
  let at = 0;
  return {
    entries,
    backCalls: 0,
    get state() { return entries[at].state; },
    currentUrl() { return entries[at].url; },
    pushState(state, _title, nextUrl) {
      entries.splice(at + 1);
      entries.push({ state: state, url: nextUrl || entries[at].url });
      at += 1;
    },
    replaceState(state, _title, nextUrl) {
      entries[at] = { state: state, url: nextUrl || entries[at].url };
    },
    back() { this.backCalls += 1; },
    goTo(index) { at = index; return entries[at]; },
  };
}

function makeAppView(over) {
  const o = over || {};
  const listeners = [];
  const events = [];
  const history = o.history || makeHistory();
  const store = o.store || {};
  const app = o.App || { currentApp: 'garden', currentTab: 'dev' };
  const sandbox = {
    App: app,
    history: history,
    location: { search: '', hash: '', href: history.currentUrl(), pathname: '/app/garden/dev' },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    URLSearchParams,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    addEventListener(name, fn, capture) { if (name === 'popstate') listeners.push({ fn, capture }); },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    dispatchEvent(event) { events.push(event); return true; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return { AppView: sandbox.__AppView, history, listeners, events, store, sandbox };
}

const tabEvents = (events) => events.filter((event) => event.type === 'usernode:workshop-tab');
// vm-context objects come from another realm, so deepStrictEqual would
// compare their prototypes; compare their data.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('a tab press writes one record at the same address, naming the tab', () => {
  const h = makeAppView();
  const scope = { screen: 'project', slug: 'garden' };
  h.AppView._markPaneTab(scope, 'status');
  const before = h.history.currentUrl();

  h.AppView._pushPaneTab(scope, 'workshop', 'status');

  assert.equal(h.history.entries.length, 2, 'one press, one step');
  assert.equal(h.history.entries[1].url, before, 'the address does not change');
  assert.deepEqual(plain(h.history.entries[1].state), {
    [PANE]: { screen: 'project', slug: 'garden', tab: 'workshop', pushed: true },
  });
  assert.deepEqual(plain(h.history.entries[0].state), {
    [PANE]: { screen: 'project', slug: 'garden', tab: 'status', pushed: false },
  }, 'the tab you were on stays on the record below');
});

test('the pushed record carries no dialog marker', () => {
  const h = makeAppView();
  const scope = { screen: 'project', slug: 'garden' };
  h.AppView._markPaneTab(scope, 'status');
  h.AppView._pushPaneTab(scope, 'needs', 'status');
  const state = h.history.state;
  assert.deepEqual(Object.keys(state), [PANE]);
  assert.deepEqual(Object.keys(state[PANE]).sort(), ['pushed', 'screen', 'slug', 'tab']);
});

test('a press on the tab already showing pushes no record', () => {
  const h = makeAppView();
  const scope = { screen: 'project', slug: 'garden' };
  h.AppView._markPaneTab(scope, 'workshop');
  h.AppView._pushPaneTab(scope, 'workshop', 'workshop');
  assert.equal(h.history.entries.length, 1);
});

test('marking keeps an existing marker\'s pushed flag for the same project', () => {
  const h = makeAppView();
  const scope = { screen: 'project', slug: 'garden' };
  h.AppView._markPaneTab(scope, 'status');
  h.AppView._pushPaneTab(scope, 'workshop', 'status');
  // The page re-renders on the pushed record.
  h.AppView._markPaneTab(scope, 'workshop');
  assert.equal(h.history.state[PANE].pushed, true, 'a pushed record stays a step');
  // A different project (a route entry) is a base record.
  h.AppView._markPaneTab({ screen: 'project', slug: 'orchard' }, 'status');
  assert.equal(h.history.state[PANE].pushed, false);
});

test('a popstate onto a tab record switches the screen once and lets the event through', () => {
  const h = makeAppView();
  const scope = { screen: 'project', slug: 'garden' };
  h.AppView._markPaneTab(scope, 'status');
  h.AppView._pushPaneTab(scope, 'workshop', 'status');
  h.AppView._setWorkshopTab('status');

  let stopped = 0;
  const event = {
    state: h.history.state,
    stopImmediatePropagation() { stopped += 1; },
  };
  h.AppView._onPaneTabPop(event);

  assert.equal(h.store.devWorkshopTab, 'workshop', 'the remembered tab follows the record');
  assert.equal(tabEvents(h.events).length, 1, 'the page is told once');
  assert.deepEqual(plain(tabEvents(h.events)[0].detail), { slug: 'garden', tab: 'workshop' });
  assert.equal(stopped, 0, 'the router still runs');
});

test('a record naming the tab already showing does nothing', () => {
  const h = makeAppView();
  h.AppView._setWorkshopTab('workshop');
  h.AppView._onPaneTabPop({ state: { [PANE]: { screen: 'project', slug: 'garden', tab: 'workshop', pushed: true } } });
  assert.equal(h.events.length, 0, 'no event, no repaint');
  assert.equal(h.store.devWorkshopTab, 'workshop');
});

test('an unmarked record, or a dialog record, changes nothing', () => {
  const h = makeAppView();
  h.AppView._onPaneTabPop({ state: null });
  h.AppView._onPaneTabPop({ state: { __unDismissDepth: 1, __unDismissId: 'x' } });
  h.AppView._onPaneTabPop({});
  assert.equal(h.events.length, 0);
});

test('the in-page back arrow walks a pushed step', () => {
  const h = makeAppView();
  const scope = { screen: 'project', slug: 'garden' };
  h.AppView._markPaneTab(scope, 'workshop');
  h.AppView._pushPaneTab(scope, 'all', 'workshop');
  h.events.length = 0;

  const traversed = h.AppView._backPaneTab(scope, 'workshop');

  assert.equal(traversed, true);
  assert.equal(h.history.backCalls, 1);
  assert.equal(h.events.length, 0, 'the traversal switches, not the arrow');
});

test('on a base record the back arrow rewrites the record and switches, adding no step', () => {
  const h = makeAppView();
  const scope = { screen: 'project', slug: 'garden' };
  h.AppView._markPaneTab(scope, 'all');

  const traversed = h.AppView._backPaneTab(scope, 'workshop');

  assert.equal(traversed, false);
  assert.equal(h.history.backCalls, 0);
  assert.equal(h.history.entries.length, 1, 'no second step');
  assert.deepEqual(plain(h.history.state), {
    [PANE]: { screen: 'project', slug: 'garden', tab: 'workshop', pushed: false },
  });
  assert.equal(h.store.devWorkshopTab, 'workshop');
  assert.equal(tabEvents(h.events).length, 1);
});

test('a door pressed on the page is a step; a door from another screen is not', () => {
  const h = makeAppView();
  h.AppView._markPaneTab({ screen: 'project', slug: 'garden' }, 'workshop');
  h.AppView._landOnTab('garden', 'status');
  assert.equal(h.history.entries.length, 2, 'the menu row opening the hub is one step');
  assert.deepEqual(plain(h.history.state[PANE]), { screen: 'project', slug: 'garden', tab: 'status', pushed: true });

  const away = makeAppView({ App: { currentApp: null, currentTab: null } });
  away.AppView._landOnTab('garden', 'status');
  assert.equal(away.history.entries.length, 1, 'the route its navigation writes is the step');

  const other = makeAppView({ App: { currentApp: 'orchard', currentTab: 'dev' } });
  other.AppView._landOnTab('garden', 'status');
  assert.equal(other.history.entries.length, 1, 'another project is a route, not a tab step');
});

test('the Communities screen uses the same records, with its own marker', () => {
  const h = makeAppView();
  const scope = { screen: 'communities' };
  h.sandbox.UsernodeReact = { workshop: { restore: (tab) => { h.store.restored = tab; } } };
  h.AppView._markPaneTab(scope, 'status');
  assert.deepEqual(plain(h.history.state), {
    [PANE]: { screen: 'communities', tab: 'status', pushed: false },
  });
  h.AppView._pushPaneTab(scope, 'needs', 'status');
  assert.deepEqual(plain(h.history.state), { [PANE]: { screen: 'communities', tab: 'needs', pushed: true } });
  h.AppView._onPaneTabPop({ state: h.history.state });
  assert.equal(h.store.restored, 'needs', 'the controller is handed the tab');
});

test('the popstate listener is installed in the capture phase', () => {
  // The router's own listener is a bubble listener (public/js/app.js), and
  // the tab must be restored before it runs.
  const h = makeAppView();
  assert.equal(h.listeners.length, 1, 'one popstate listener');
  assert.equal(h.listeners[0].capture, true, 'capture phase, before the router');
  // It reaches the same handler the tests drive directly.
  h.AppView._setWorkshopTab('status');
  h.listeners[0].fn({ state: { [PANE]: { screen: 'project', slug: 'garden', tab: 'all', pushed: true } } });
  assert.equal(h.store.devWorkshopTab, 'all');
  assert.equal(tabEvents(h.events).length, 1);
});
