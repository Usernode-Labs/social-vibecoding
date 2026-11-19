'use strict';

// The native-offline proposal (18 Nov 2026): the header's connection status
// (lib/offline.ts connectionStatusStore), its hysteresis, the "no internet"
// word from the phone, a stuck read as the probe's second witness, and the
// screen's freshness (lib/freshness.ts). Measured first on production: on a
// quiet network the old strip took 20-26 s to come, and on a patchy one a
// bar that follows every probe flickers (Superhuman's lesson).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

function setup(t, { onLine = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  const window = new EventTarget();
  window.location = { href: 'https://app.test/', origin: 'https://app.test', pathname: '/', hash: '' };
  const document = new EventTarget();
  document.visibilityState = 'visible';
  document.body = { classList: { toggle() {} } };
  const requests = [];
  const globals = {
    window, document, navigator: { onLine },
    requestAnimationFrame: (run) => setTimeout(run, 16),
    fetch(url, options) {
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
  const visibility = new Map();
  const engine = loadTsx('frontend/src/lib/offline.ts', {
    stubs: { './visibility-store': {
      publishVisibility: (key, value) => visibility.set(key, value),
      readVisibility: (key) => visibility.get(key),
    } },
  });
  const api = engine.initOffline();
  const status = () => engine.connectionStatusStore.get().status;
  return { api, engine, window, requests, status };
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function goOffline(t, api, requests) {
  const first = api.probe();
  await flush();
  requests[requests.length - 1].reject(new TypeError('Load failed'));
  await first;
  t.mock.timers.tick(2000);
  await flush();
  requests[requests.length - 1].reject(new TypeError('Load failed'));
  await flush();
}

async function goOnline(api, requests) {
  const back = api.probe();
  await flush();
  requests[requests.length - 1].resolve({ ok: true });
  await back;
  await flush();
}

test('the header says "Connecting…" while Homeroom does not answer, and holds it 10 s once shown', async (t) => {
  const { api, requests, status } = setup(t);
  assert.equal(status(), 'online');
  await goOffline(t, api, requests);
  assert.equal(api.isOffline(), true);
  assert.equal(status(), 'connecting');

  t.mock.timers.tick(3000);
  await goOnline(api, requests);
  assert.equal(api.isOffline(), false, 'the offline state itself moves at once, so queued writes go');
  assert.equal(status(), 'connecting', 'what is shown lingers');
  t.mock.timers.tick(6999);
  assert.equal(status(), 'connecting');
  t.mock.timers.tick(1);
  assert.equal(status(), 'online', 'gone 10 s after it was shown');
});

test('a link that flaps keeps the status up for a minute the second time', async (t) => {
  const { api, requests, status } = setup(t);
  await goOffline(t, api, requests);
  t.mock.timers.tick(10_000);
  await goOnline(api, requests);
  assert.equal(status(), 'online', 'shown long enough already: it goes at once');

  t.mock.timers.tick(20_000);
  await goOffline(t, api, requests);
  assert.equal(status(), 'connecting');
  await goOnline(api, requests);
  t.mock.timers.tick(30_000);
  assert.equal(status(), 'connecting', 'back within two minutes: held longer');
  t.mock.timers.tick(30_000);
  assert.equal(status(), 'online');
});

test('going offline again during the hold cancels the hide', async (t) => {
  const { api, requests, status } = setup(t);
  await goOffline(t, api, requests);
  await goOnline(api, requests);
  t.mock.timers.tick(5000);
  await goOffline(t, api, requests);
  t.mock.timers.tick(20_000);
  assert.equal(status(), 'connecting', 'the pending hide was cancelled');
});

test('the phone saying it has no network reads "No internet", and a network back reads "Connecting…"', async (t) => {
  const { api, window, requests, status } = setup(t);
  window.dispatchEvent(Object.assign(new Event('usernode:native-connectivity'), { detail: { online: false, via: ['none'] } }));
  await flush();
  assert.equal(api.isOffline(), true);
  assert.equal(status(), 'no-internet');
  window.dispatchEvent(Object.assign(new Event('usernode:native-connectivity'), { detail: { online: true, via: ['wifi'] } }));
  await flush();
  assert.equal(status(), 'connecting', 'a network, but Homeroom has not answered yet');
  requests[requests.length - 1].resolve({ ok: true });
  await flush();
  assert.equal(api.isOffline(), false);
  t.mock.timers.tick(10_000);
  assert.equal(status(), 'online', 'and gone once it answers, after the hold');
});

test('a stuck read is the second witness: one failed probe after it is believed at once', async (t) => {
  const { api, requests, status } = setup(t);
  api.slowRead();
  await flush();
  assert.equal(requests.length, 1, 'a stuck read asks the probe now');
  requests[0].reject(new TypeError('Load failed'));
  await flush();
  assert.equal(api.isOffline(), true, 'no confirming check two seconds later');
  assert.equal(status(), 'connecting');
});

test('a planned restart says "Updating" and goes the moment the socket is back', async (t) => {
  const { api, status } = setup(t);
  api.restartNotice();
  assert.equal(status(), 'updating');
  api.restartDone();
  assert.equal(status(), 'online', 'no hold: the server said it is back');
});

test('the screen\'s freshness: the oldest saved copy on show, forgotten on a current answer or a new screen', () => {
  const fresh = loadTsx('frontend/src/lib/freshness.ts');
  const now = Date.UTC(2026, 10, 18, 12, 41);
  assert.equal(fresh.freshnessStore.get().savedAt, null);
  fresh.noteSaved('/api/a', now - 10 * 60_000);
  fresh.noteSaved('kept:b', now - 30 * 60_000);
  assert.equal(fresh.freshnessStore.get().savedAt, now - 30 * 60_000, 'the oldest is the screen\'s');
  fresh.noteFresh('kept:b');
  assert.equal(fresh.freshnessStore.get().savedAt, now - 10 * 60_000);
  fresh.resetFreshness();
  assert.equal(fresh.freshnessStore.get().savedAt, null);
  assert.equal(fresh.showsAge(now - 60_000, now), false, 'a minute old reads as current');
  assert.equal(fresh.showsAge(now - 3 * 60_000, now), true);
  assert.equal(fresh.showsAge(null, now), false);
  assert.match(fresh.savedAtLabel(now - 60_000, now, 'en-US'), /\d{1,2}:\d{2}/, 'today: a time of day');
  assert.match(fresh.savedAtLabel(now - 2 * 86_400_000, now, 'en-US'), /Nov 16/, 'an earlier day: its date');
});
