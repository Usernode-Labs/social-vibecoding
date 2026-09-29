'use strict';

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
  const context = vm.createContext({
    App: { _runningApp: { slug: 'example' } },
    UsernodeReact: { nav: { forget(slug) { forgotten.push(slug); } } },
    addEventListener(name, handler) { listeners.set(name, handler); },
    clearInterval(timer) { cleared.push(timer); },
    document: { removeEventListener(name) { removed.push(name); } },
    async fetch(url, options) { requests.push({ url, body: JSON.parse(options.body) }); },
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8'), context);
  const view = context.AppView;
  view._appFrame = () => ({ evict(slug) { evicted.push(slug); } });
  view.appData = { slug: 'example' };
  view.activeSeconds = 17;
  view.activityInterval = 42;
  return { view, app: context.App, requests, cleared, removed, evicted, forgotten,
    announce: detail => listeners.get('app-blocks-changed')({ detail }) };
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
  assert.deepEqual(f.requests, []);
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
    // Ordinary navigation still records the time spent in an allowed app.
    f.view.stopActivityTracking();
    assert.deepEqual(f.requests, [{ url: '/api/apps/example/activity', body: { seconds: 17 } }]);
  }
});

test('a block event after the app closed is harmless', () => {
  const f = harness();
  f.view.appData = null;
  assert.doesNotThrow(() => f.announce({ slug: 'example', blocked: true }));
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.evicted, ['example'], 'a kept app is discarded even after leaving it');
});
