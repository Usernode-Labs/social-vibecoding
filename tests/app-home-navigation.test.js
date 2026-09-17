'use strict';

// Exercise the actual router, directory lifecycle, and header click handler
// together. Testing Browse.handleBack alone misses a hidden directory claiming
// the Home button after its detail page has launched an app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function harness() {
  const nodes = new Map();
  function element(id) {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set(id === 'home-screen' ? [] : ['hidden']);
    const attrs = new Map();
    const listeners = new Map();
    const el = {
      id, innerHTML: '', listeners,
      classList: {
        add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle(value, on) { if (on) classes.add(value); else classes.delete(value); },
      },
      setAttribute: (name, value) => attrs.set(name, value),
      getAttribute: name => attrs.get(name),
      addEventListener: (name, fn) => listeners.set(name, fn),
    };
    nodes.set(id, el);
    return el;
  }
  const location = new URL('https://homeroom.test/');
  const history = {
    pushState(_state, _title, url) { location.href = new URL(url, location).href; },
    replaceState(_state, _title, url) { location.href = new URL(url, location).href; },
  };
  let releaseOpen;
  let frameMounted = false;
  let closes = 0;
  let tabRenders = 0;
  const AppView = {
    appData: null,
    beginLaunch() { frameMounted = true; },
    open() { return new Promise(resolve => { releaseOpen = resolve; }); },
    close() { closes++; AppView.appData = null; },
    _teardownDevRoots() {},
    _unmountAppFrame() { frameMounted = false; },
  };
  const context = vm.createContext({
    location, history, URL, URLSearchParams, console,
    document: { title: '', getElementById: element, querySelector: () => null, addEventListener() {} },
    addEventListener() {}, localStorage: { getItem: () => null },
    PlatformUI: { transition(fn, opts) { fn(); opts?.after?.(); } },
    Home: { load() {}, publishImproveTarget() {}, _apps: [] },
    AppView,
  });
  context.window = context;
  vm.runInContext(read('public/js/app.js'), context);
  vm.runInContext(read('frontend/src/features/apps/browse.js'), context);
  const { App, Browse } = context;
  // Only rendering/network infrastructure is replaced. Visibility publications
  // are applied synchronously, as the React screen hook does in the browser.
  App.Visibility._store().listeners.add(() => {
    for (const [id, visible] of Object.entries(App.Visibility._store().visible)) {
      element(id).classList.toggle('hidden', !visible);
    }
  });
  App.ImproveStatus = { setAppOpen() {} };
  App._wirePullToRefresh = () => {};
  App.switchTab = () => { tabRenders++; };
  Browse.render = () => Browse._syncChrome();
  Browse._load = () => {};
  App.bindEvents();
  return {
    App, Browse, location,
    visible: id => !element(id).classList.contains('hidden'),
    get frameMounted() { return frameMounted; },
    get closes() { return closes; },
    get tabRenders() { return tabRenders; },
    clickBack() {
      const el = element('back-btn');
      el.listeners.get('click')({ currentTarget: el, preventDefault() {} });
    },
    enterDirectory(slug) {
      location.hash = slug ? `#apps/${slug}` : '#apps';
      App.navigateToBrowse(slug);
    },
    finishOpen() {
      AppView.appData = { slug: 'coffee', name: 'Pourover Coffee' };
      releaseOpen();
    },
  };
}

for (const origin of ['detail', 'list', 'home']) {
  test(`Home exits an app opened from ${origin}`, async () => {
    const h = harness();
    if (origin !== 'home') h.enterDirectory(origin === 'detail' ? 'coffee' : null);
    const opening = h.App.navigateToApp('coffee');
    h.finishOpen();
    await opening;
    assert.equal(h.visible('app-view'), true);
    h.clickBack();
    assert.equal(h.location.pathname + h.location.hash, '/', 'Home does not route into the hidden directory');
    assert.equal(h.visible('home-screen'), true);
    assert.equal(h.visible('app-view'), false);
    assert.equal(h.frameMounted, false);
    assert.equal(h.App.currentApp, null);
    assert.equal(h.Browse.isOpen(), false);
  });
}

for (const slug of [null, 'coffee']) {
  test(`returning to the directory ${slug ? 'detail' : 'list'} reveals it again`, async () => {
    const h = harness();
    h.enterDirectory(slug);
    const opening = h.App.navigateToApp('coffee');
    h.finishOpen();
    await opening;
    // Both browser Back and a directory link dispatch this same entry point.
    h.enterDirectory(slug);
    assert.equal(h.visible('browse-screen'), true);
    assert.equal(h.visible('app-view'), false);
    assert.equal(h.App.currentApp, null);
    assert.equal(h.closes, 1, 'returning is a screen entry, including app teardown');
    assert.equal(h.Browse._slug, slug);
    if (slug) {
      h.clickBack();
      assert.equal(h.location.hash, '#apps', 'the visible detail still goes up to the list');
    }
  });
}

test('Home during a pending app load cannot be intercepted or undone by its completion', async () => {
  const h = harness();
  h.enterDirectory('coffee');
  const opening = h.App.navigateToApp('coffee');
  h.clickBack();
  h.finishOpen();
  await opening;
  assert.equal(h.location.pathname + h.location.hash, '/');
  assert.equal(h.visible('home-screen'), true);
  assert.equal(h.visible('app-view'), false);
  assert.equal(h.frameMounted, false);
  assert.equal(h.tabRenders, 0, 'the old async router tail must not reopen the app');
});
