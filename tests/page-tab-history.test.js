'use strict';

// #3620: the project page's tab presses, as steps the back button can walk.
//
// A tab press used to be invisible to back: the press jumped straight out of
// the project to whatever screen was open before it, usually Home, while the
// page's own back disc on All items went to the Workshop — the back button
// and the disc disagreed. frontend/src/lib/page-tab-history.ts records every
// tab press as a same-address history record, and consumes a traversal that
// lands on one.
//
// Run with: node --test tests/page-tab-history.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const PAGE = 'https://homeroom.test/app/homeroom/dev';
const HOME = 'https://homeroom.test/';
const TOPIC = 'https://homeroom.test/app/homeroom/dev/issues/12';

/**
 * A history whose entries remember their state, at the page's one address —
 * a tab record never moves it — with the Navigation API wired the way a
 * browser fires it: `currententrychange` before popstate, telling which way
 * a traversal went and where it came from.
 */
function fixture() {
  const entries = [{ url: HOME, state: null }, { url: PAGE, state: null }];
  let at = 1;
  const navListeners = [];
  const nav = {
    currentEntry: null,
    canGoBack: true,
    canGoForward: true,
    addEventListener(type, fn) {
      if (type === 'currententrychange') navListeners.push(fn);
    },
  };
  const fireNav = (type, fromIndex) => {
    nav.currentEntry = { index: at, key: `k${at}` };
    navListeners.forEach((fn) => fn({
      navigationType: type,
      from: { index: fromIndex, url: entries[fromIndex].url },
    }));
  };
  const win = {
    location: { get href() { return entries[at].url; } },
    navigation: nav,
    history: {
      get state() { return entries[at].state; },
      pushState(state, _t, url) {
        entries.splice(at + 1);
        entries.push({ url: url ? new URL(url, entries[at].url).href : entries[at].url, state });
        at = entries.length - 1;
        fireNav('push', at - 1);
      },
      replaceState(state, _t, url) {
        if (url) entries[at].url = new URL(url, entries[at].url).href;
        entries[at].state = state;
        fireNav('replace', at);
      },
      back() {
        if (at === 0) return false;
        at -= 1;
        fireNav('traverse', at + 1);
        return true;
      },
      forward() {
        if (at >= entries.length - 1) return false;
        at += 1;
        fireNav('traverse', at - 1);
        return true;
      },
    },
  };
  // What a popstate for the landing now carries.
  const popstate = () => ({ state: entries[at].state });
  return { win, entries, popstate, at: () => at };
}

function hostDouble() {
  const landed = [];
  let open = true;
  return {
    landed,
    open,
    setOpen(v) { open = v; },
    isPageOnView: () => open,
    landOnTab: (tab) => landed.push(tab),
  };
}

function load() {
  return loadTsx('frontend/src/lib/page-tab-history.ts');
}

test('a tab press marks the entry it left and pushes the record', () => {
  const { createPageTabHistory, PAGE_TAB_STATE_KEY } = load();
  const f = fixture();
  const tabs = createPageTabHistory(f.win, hostDouble());

  tabs.push('status', 'workshop');

  assert.equal(f.entries.length, 3, 'one record pushed');
  assert.deepEqual(f.entries[1].state, { [PAGE_TAB_STATE_KEY]: 'status' },
    'the arrival entry remembers the tab the page opened on');
  assert.deepEqual(f.entries[2].state, { [PAGE_TAB_STATE_KEY]: 'workshop' },
    'the record carries the tab it shows, and nothing else');
});

test('back from the Workshop tab lands on the Hub', () => {
  const { createPageTabHistory, PAGE_TAB_STATE_KEY } = load();
  const f = fixture();
  const host = hostDouble();
  const tabs = createPageTabHistory(f.win, host);

  tabs.push('status', 'workshop');
  f.win.history.back();

  assert.equal(tabs.consumePopstate(f.popstate()), true, 'the step is consumed');
  assert.deepEqual(host.landed, ['status'], 'the tab the page was opened on');
  assert.equal(f.at(), 1, 'standing on the arrival entry');
  assert.equal(f.win.history.state[PAGE_TAB_STATE_KEY], 'status');
});

test('Forward walks the steps the other way', () => {
  const { createPageTabHistory } = load();
  const f = fixture();
  const host = hostDouble();
  const tabs = createPageTabHistory(f.win, host);

  tabs.push('status', 'workshop');
  f.win.history.back();
  tabs.consumePopstate(f.popstate());

  f.win.history.forward();
  assert.equal(tabs.consumePopstate(f.popstate()), true);
  assert.deepEqual(host.landed, ['status', 'workshop']);
});

test('back at the tab the page was opened on leaves the project', () => {
  const { createPageTabHistory } = load();
  const f = fixture();
  const host = hostDouble();
  const tabs = createPageTabHistory(f.win, host);

  // The page opened on the Hub, the Workshop was pressed, back walked the
  // step: the page stands on its arrival entry. The next press is the
  // project's exit.
  tabs.push('status', 'workshop');
  f.win.history.back();
  tabs.consumePopstate(f.popstate());

  f.win.history.back();
  assert.equal(tabs.consumePopstate(f.popstate()), false,
    'the arrival entry is not a record to consume');
  assert.deepEqual(host.landed, ['status'], 'nothing more was applied');
  assert.equal(f.at(), 0, 'the traversal reaches Home — the router gets it');
});

test('a traversal that moved the address is not consumed', () => {
  const { createPageTabHistory } = load();
  const f = fixture();
  const host = hostDouble();
  const tabs = createPageTabHistory(f.win, host);

  // A topic pushed over the Workshop tab, then back to the page: the router
  // must rebuild the page (the app route reads the landing entry's marker).
  tabs.push('status', 'workshop');
  f.win.history.pushState(null, '', TOPIC);
  f.win.history.back();

  assert.equal(tabs.consumePopstate(f.popstate()), false);
  assert.deepEqual(host.landed, [], 'nothing was applied');
});

test('a step is consumed only with the page open', () => {
  const { createPageTabHistory } = load();
  const f = fixture();
  const host = hostDouble();
  const tabs = createPageTabHistory(f.win, host);

  tabs.push('status', 'workshop');
  host.setOpen(false);
  f.win.history.back();

  assert.equal(tabs.consumePopstate(f.popstate()), false);
  assert.deepEqual(host.landed, []);
});

test('pressing the tab already up records nothing', () => {
  const { createPageTabHistory } = load();
  const f = fixture();
  const tabs = createPageTabHistory(f.win, hostDouble());

  tabs.push('workshop', 'workshop');

  assert.equal(f.entries.length, 2, 'no record, no step');
});

test('the marker never spreads a dismiss record into the pushed one', () => {
  const { createPageTabHistory, PAGE_TAB_STATE_KEY } = load();
  const f = fixture();
  const tabs = createPageTabHistory(f.win, hostDouble());

  // A dialog record under the page's state — whatever it left there, the
  // record a tab press pushes carries only the tab.
  f.win.history.replaceState({ __unDismissDepth: 0, __unDismissId: 'x:1' });
  tabs.push('__unDismissDepth', 'workshop');

  assert.deepEqual(f.entries[2].state, { [PAGE_TAB_STATE_KEY]: 'workshop' });
});

// ── The shell wiring ────────────────────────────────────────────────────
//
// back-stack.ts's capture listener consults the tab consume after its own
// dismissible check, so these two are driven over ONE history, in the order
// the shell reads them.

function shellFixture() {
  const { createPageTabHistory } = load();
  const { createBackStack } = loadTsx('frontend/src/lib/back-stack.ts');
  const f = fixture();
  const host = hostDouble();
  // The shell's order: a dismissible first, then a tab step, then the router.
  const stack = createBackStack(f.win);
  const tabs = createPageTabHistory(f.win, host);
  const press = () => {
    f.win.history.back();
    if (stack.handlePopstate()) return 'dismiss';
    return tabs.consumePopstate(f.popstate()) ? 'tab' : 'router';
  };
  return { f, stack, tabs, host, press };
}

test('a dialog over the page eats the back press before a tab step', () => {
  const sf = shellFixture();

  sf.tabs.push('status', 'workshop');
  let closed = 0;
  sf.stack.push(() => { closed += 1; });

  assert.equal(sf.press(), 'dismiss', 'the dialog consumes the press');
  assert.equal(closed, 1);
  assert.deepEqual(sf.host.landed, [], 'and the tab step is still standing');

  assert.equal(sf.press(), 'tab', 'the next press walks the tab step');
  assert.deepEqual(sf.host.landed, ['status']);
});

test('the shell wiring is built on the shared instance, panel and prerender aside', () => {
  // The shared instance is created where there is a window and the document
  // is not the side panel's. In Node there is no window, so the exported
  // helpers no-op — the prerender evaluates this graph.
  const mod = load();
  assert.equal(mod.pageTabHistory(), null);
  assert.doesNotThrow(() => mod.pushPageTab('status', 'workshop'));
  assert.equal(mod.consumePopstate({ state: null }), false);

  // The side panel's document stands down too: a frame's history entries are
  // the top window's, so a record pushed there is a Back press the top
  // window inherits.
  globalThis.window = { history: { pushState() {}, replaceState() {} } };
  try {
    const panel = loadTsx('frontend/src/lib/page-tab-history.ts', {
      stubs: { './side-panel-mode': { isEmbeddedPanel: () => true } },
    });
    assert.equal(panel.pageTabHistory(), null, 'the panel records nothing');
    assert.doesNotThrow(() => panel.pushPageTab('status', 'workshop'));
    assert.equal(panel.consumePopstate({ state: { __unPageTab: 'workshop' } }), false);
  } finally {
    delete globalThis.window;
  }
});
