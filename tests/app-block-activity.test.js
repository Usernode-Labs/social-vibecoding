'use strict';
const { withLanguage } = require("./lib/platform-language");


const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const listeners = new Map();
  const requests = [];
  const cleared = [];
  const removed = [];
  const evicted = [];
  const forgotten = [];
  const windowRemoved = [];
  const activityCalls = [];
  const appActivity = {
    start(options) { activityCalls.push({ method: 'start', options }); return true; },
    stop(options) { activityCalls.push({ method: 'stop', options }); },
    flush() { activityCalls.push({ method: 'flush' }); return Promise.resolve(true); },
    visibilityChanged() { activityCalls.push({ method: 'visibilityChanged' }); },
    handleFrameMessage() { return false; },
    discardSlug(slug) { activityCalls.push({ method: 'discardSlug', slug }); },
    clearAccount() { activityCalls.push({ method: 'clearAccount' }); },
  };
  const context = vm.createContext(withLanguage({
    App: {
      _runningApp: { slug: 'example' }, currentApp: 'example', currentTab: 'app',
      user: { id: 7 }, _sessionFromSnapshot: false,
    },
    UsernodeReact: { appActivity, nav: { forget(slug) { forgotten.push(slug); } } },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { windowRemoved.push(name); },
    clearInterval(timer) { cleared.push(timer); },
    document: {
      visibilityState: 'visible', hasFocus() { return true; },
      addEventListener() {}, removeEventListener(name) { removed.push(name); },
    },
    async fetch(url, options) { requests.push({ url, body: JSON.parse(options.body) }); },
  }));
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8'), context);
  const view = context.AppView;
  view._appFrame = () => ({ evict(slug) { evicted.push(slug); } });
  view.appData = { slug: 'example' };
  view.activeSeconds = 17;
  view.activityInterval = 42;
  return {
    view, app: context.App, requests, cleared, removed, windowRemoved, evicted, forgotten,
    activityCalls,
    announce: detail => listeners.get('app-blocks-changed')({ detail }),
    emit: name => listeners.get(name)?.(),
  };
}

test('blocking the open app stops activity without flushing a now-forbidden request', () => {
  const f = harness();
  f.announce({ slug: 'example', blocked: true });
  // navigateHome calls close(), which stops tracking a second time.
  f.view.stopActivityTracking();
  assert.equal(f.view.activeSeconds, 0);
  assert.equal(f.view.activityInterval, null);
  assert.deepEqual(f.cleared, [42]);
  assert.ok(f.removed.includes('visibilitychange'));
  assert.deepEqual(f.windowRemoved, ['blur', 'focus', 'blur', 'focus']);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(JSON.parse(JSON.stringify(f.activityCalls)), [
    { method: 'discardSlug', slug: 'example' },
    { method: 'stop', options: { discard: true } },
    { method: 'stop', options: { discard: false } },
  ]);
  assert.equal(f.app._runningApp, null, 'Home cannot park the blocked app again');
  assert.deepEqual(f.evicted, ['example']);
  assert.deepEqual(f.forgotten, ['example']);
});

test('unblocking or blocking another app preserves the open app activity', () => {
  for (const detail of [{ slug: 'other', blocked: true }, { slug: 'example', blocked: false }]) {
    const f = harness();
    f.announce(detail);
    assert.equal(f.view.activeSeconds, 17);
    assert.equal(f.view.activityInterval, 42);
    assert.deepEqual(f.cleared, []);
    assert.equal(f.app._runningApp.slug, 'example');
    assert.deepEqual(f.evicted, detail.blocked ? ['other'] : []);
    assert.deepEqual(f.forgotten, detail.blocked ? ['other'] : []);
    // Ordinary navigation still asks the durable collector to settle the app.
    f.view.stopActivityTracking();
    assert.deepEqual(JSON.parse(JSON.stringify(f.activityCalls)), [
      { method: 'stop', options: { discard: false } },
    ]);
  }
});

test('a block event after the app closed is harmless', () => {
  const f = harness();
  f.view.appData = null;
  assert.doesNotThrow(() => f.announce({ slug: 'example', blocked: true }));
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.evicted, ['example'], 'a kept app is discarded even after leaving it');
});

test('activity starts only for a server-verified session and checks window focus', () => {
  const f = harness();
  f.view._appFrame = () => ({ isActive: () => true, slug: () => 'example' });
  f.app._sessionFromSnapshot = true;
  f.view.startActivityTracking('example');
  let call = f.activityCalls.at(-1);
  assert.equal(call.options.userId, null);
  assert.equal(call.options.isVisible(), true);

  f.app._sessionFromSnapshot = false;
  f.view.startActivityTracking('example');
  call = f.activityCalls.at(-1);
  assert.equal(call.options.userId, 7);
  assert.equal(call.options.isVisible(), true);
  f.view._appFrame = () => ({ isActive: () => true, slug: () => 'other' });
  assert.equal(call.options.isVisible(), false);
  f.emit('blur');
  f.emit('focus');
  assert.deepEqual(f.activityCalls.slice(-2), [
    { method: 'visibilityChanged' }, { method: 'visibilityChanged' },
  ]);
});
