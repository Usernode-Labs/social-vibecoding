'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

// Exercise the real connectivity engine with controlled network responses and
// time. A connected browser can lose access to its Preview without ever firing
// an online/offline event, or leave a health request pending across recovery.
function setup(t, { onLine = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const window = new EventTarget();
  const document = new EventTarget();
  const bodyClasses = new Set();
  document.visibilityState = 'visible';
  document.body = { classList: { toggle(name, enabled) {
    if (enabled) bodyClasses.add(name);
    else bodyClasses.delete(name);
  } } };
  const requests = [];
  const visibility = new Map();
  const changes = [];
  window.addEventListener('usernode:offline-change', (event) => changes.push(event.detail.offline));
  const globals = {
    window, document, navigator: { onLine },
    fetch(url, options) {
      // Intentionally ignores abort: even a transport that never settles must
      // release the single-flight probe and allow a later request to recover.
      return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  const engine = loadTsx('frontend/src/lib/offline.ts', {
    stubs: { './visibility-store': {
      publishVisibility: (key, value) => visibility.set(key, value),
      readVisibility: (key) => visibility.get(key),
    } },
  });
  const api = engine.initOffline();
  return { api, window, document, requests, visibility, bodyClasses, changes };
}

async function flush() {
  // Flush nested promise continuations without advancing the fake clock.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

test('a stalled health check expires, releases the probe, and ignores its late response', async (t) => {
  const { api, requests, visibility, bodyClasses, changes } = setup(t);
  const first = api.probe();
  assert.equal(api.probe(), first, 'concurrent nudges share one check');
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/health');
  assert.equal(requests[0].options.cache, 'no-store');
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(api.isOffline(), false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(api.isOffline(), true, 'a stuck request cannot hide the outage indefinitely');
  await first;
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(visibility.get('offline-banner'), true);
  assert.equal(bodyClasses.has('is-offline'), true);

  const recovered = api.probe();
  await flush();
  assert.equal(requests.length, 2, 'a new request is allowed after the deadline');
  requests[1].resolve({ ok: true });
  await recovered;
  assert.equal(api.isOffline(), false);
  assert.equal(visibility.get('offline-banner'), false);
  assert.equal(bodyClasses.has('is-offline'), false);
  assert.deepEqual(changes, [true, false], 'consumers receive the recovery event');

  requests[0].resolve({ ok: false });
  await flush();
  assert.equal(api.isOffline(), false, 'the expired request cannot overwrite a newer result');
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(requests.length, 2, 'successful recovery stops the retry loop');
});

test('server failures retry and recover while navigator.onLine stays true', async (t) => {
  const { api, requests, changes } = setup(t);
  const first = api.probe();
  await flush();
  requests[0].resolve({ ok: false, status: 503 });
  await first;
  assert.equal(api.isOffline(), true);
  t.mock.timers.tick(15000);
  await flush();
  assert.equal(requests.length, 2);
  requests[1].reject(new TypeError('Connection reset'));
  await flush();
  assert.equal(api.isOffline(), true);
  t.mock.timers.tick(15000);
  await flush();
  assert.equal(requests.length, 3);
  requests[2].resolve({ ok: true });
  await flush();
  assert.equal(api.isOffline(), false);
  assert.deepEqual(changes, [true, false]);
});

test('returning to an offline tab probes immediately and overlapping focus events deduplicate', async (t) => {
  const { api, window, document, requests } = setup(t);
  const first = api.probe();
  await flush();
  requests[0].reject(new TypeError('Disconnected'));
  await first;
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
  await flush();
  assert.equal(requests.length, 1);
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
  await flush();
  assert.equal(requests.length, 2);
  requests[1].resolve({ ok: true });
  await flush();
  assert.equal(api.isOffline(), false);
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
  await flush();
  assert.equal(requests.length, 2, 'healthy tabs do not probe on every focus');
});

test('browser connectivity events still probe the server instead of trusting the flag', async (t) => {
  const { api, window, requests } = setup(t, { onLine: false });
  await flush();
  assert.equal(requests.length, 1, 'an offline boot triggers a real health check');
  requests[0].resolve({ ok: true });
  await flush();
  assert.equal(api.isOffline(), false, 'a working server outranks navigator.onLine');
  window.dispatchEvent(new Event('offline'));
  window.dispatchEvent(new Event('online'));
  await flush();
  assert.equal(requests.length, 2);
  requests[1].resolve({ ok: true });
  await flush();
  assert.equal(api.isOffline(), false);
});

test('forced screenshot state survives a pending success and disables all retries', async (t) => {
  const { api, window, document, requests, changes } = setup(t);
  const first = api.probe();
  await flush();
  api.forceOffline();
  requests[0].resolve({ ok: true });
  await first;
  assert.equal(api.isOffline(), true);
  window.dispatchEvent(new Event('online'));
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  api.nudge();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(requests.length, 1);
  assert.deepEqual(changes, [true]);
});
