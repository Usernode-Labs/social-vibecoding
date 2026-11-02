'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

// Exercise the real connectivity engine with controlled network responses and
// time. A connected browser can lose access to its Preview without ever firing
// an online/offline event, or leave a health request pending across recovery.
function setup(t, { onLine = true, native = null } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const window = new EventTarget();
  if (native) window.__usernodeNativeConnectivity = native;
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

test('the native shell\'s word: no network is believed at once; a network back, or another one, is probed now', async (t) => {
  // Offline follow-up, 2 Nov 2026: the phone knows when it has no network,
  // and when Wi-Fi hands over to cellular; a probe cannot tell either.
  const { api, window, requests, changes } = setup(t);
  const handed = [];
  window.addEventListener('usernode:network-changed', (event) => handed.push(event.detail.via));
  const say = (detail) => window.dispatchEvent(new CustomEvent('usernode:native-connectivity', { detail }));
  say({ online: true, via: ['wifi'] });
  await flush();
  assert.equal(requests.length, 0, 'online and on a network, as every page load is told: nothing to ask');
  assert.deepEqual(handed, [], 'and the first word is no change of network');

  say({ online: false, via: ['none'] });
  await flush();
  assert.equal(api.isOffline(), true, 'no network: offline at once');
  assert.equal(requests.length, 0, 'with nothing to probe over');

  say({ online: true, via: ['mobile'] });
  await flush();
  assert.equal(requests.length, 1, 'a network back is probed now, not on the 15 s loop');
  requests[0].resolve({ ok: true });
  await flush();
  assert.equal(api.isOffline(), false);
  assert.deepEqual(handed, [], 'coming back is the probe\'s news (usernode:offline-change), not a handover');

  say({ online: true, via: ['wifi', 'vpn'] });
  await flush();
  assert.deepEqual(handed, [['wifi', 'vpn']], 'online, onto another network: announced');
  assert.equal(requests.length, 2, 'and probed');
  requests[1].resolve({ ok: true });
  await flush();
  say({ online: true, via: ['wifi', 'vpn'] });
  await flush();
  assert.equal(handed.length, 1, 'the same word again is nothing new');
  assert.equal(requests.length, 2);
  say({ online: 'yes' });
  say(null);
  await flush();
  assert.deepEqual(changes, [true, false]);
});

test('a native word that came before the engine started is read as it starts', (t) => {
  const { api } = setup(t, { native: { online: false, via: ['none'] } });
  assert.equal(api.isOffline(), true);
});

test('App hears a handover: the events socket is asked now and the screen read again', () => {
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public/js/app.js'), 'utf8');
  assert.match(app, /window\.addEventListener\('usernode:network-changed', \(\) => App\._networkHandedOver\(\)\);/);
  const body = app.slice(app.indexOf('  _networkHandedOver() {'), app.indexOf('  _eventsNetworkChanged(offline) {'));
  assert.match(body, /if \(App\._sessionFromSnapshot\) \{\s+App\._reconcileSession\(\)\.catch\(\(\) => \{\}\);\s+return;\s+\}/);
  assert.match(body, /if \(socket\.readyState === 1 && !App\._eventsAwaiting\) App\._pingEvents\(socket\);/);
  assert.match(body, /if \(Date\.now\(\) - App\._lastResyncAt < App\.RESYNC_SETTLE_MS\) return;\s+App\.resyncCurrentView\(\);/);
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
