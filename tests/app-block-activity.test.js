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
  const context = vm.createContext({
    addEventListener(name, handler) { listeners.set(name, handler); },
    clearInterval(timer) { cleared.push(timer); },
    document: { removeEventListener(name) { removed.push(name); } },
    async fetch(url, options) { requests.push({ url, body: JSON.parse(options.body) }); },
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8'), context);
  const view = context.AppView;
  view.appData = { slug: 'example' };
  view.activeSeconds = 17;
  view.activityInterval = 42;
  return { view, requests, cleared, removed,
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
});

test('unblocking or blocking another app preserves the open app activity', () => {
  for (const detail of [{ slug: 'other', blocked: true }, { slug: 'example', blocked: false }]) {
    const f = harness();
    f.announce(detail);
    assert.equal(f.view.activeSeconds, 17);
    assert.equal(f.view.activityInterval, 42);
    assert.deepEqual(f.cleared, []);
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
});
