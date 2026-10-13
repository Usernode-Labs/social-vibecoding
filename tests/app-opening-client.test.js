'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');

const { createAppOpeningRecorder, MAX_PENDING_OPENINGS } = loadTsx(
  'frontend/src/features/app-context/app-openings.ts'
);
const NOW = '2026-10-01T10:00:00.000Z';

function harness(fetchImpl = async () => ({ ok: true, status: 201 })) {
  const values = new Map();
  const requests = [];
  const timers = [];
  let uuid = 0;
  const host = {
    App: { user: { id: 7 } },
    AbortController,
    crypto: {
      randomUUID() {
        uuid += 1;
        return `00000000-0000-4000-8000-${String(uuid).padStart(12, '0')}`;
      },
    },
    localStorage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, value); },
    },
    async fetch(url, options) {
      requests.push({ url, options });
      return fetchImpl(url, options, requests.length);
    },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
  };
  const recorder = createAppOpeningRecorder(host, {
    now: () => Date.parse(NOW),
    retryDelays: [1],
    deliveryTimeoutMs: 10,
  });
  return { host, recorder, requests, timers, values };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the client retries one opening with the same id and timestamp', async () => {
  const h = harness(async (_url, _options, attempt) => {
    if (attempt === 1) throw new Error('offline');
    return { ok: true, status: 201 };
  });
  h.recorder.setUser(7, true);
  const opening = h.recorder.begin(7);
  h.recorder.commit('coffee app', opening);
  await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.recorder.pending()[0].attempts, 1);
  await h.recorder.flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].url, '/api/apps/coffee%20app/openings');
  assert.deepEqual(JSON.parse(h.requests[0].options.body), JSON.parse(h.requests[1].options.body));
  assert.deepEqual(Object.keys(JSON.parse(h.requests[0].options.body)).sort(), ['occurredAt', 'openingId']);
  assert.equal(h.requests[0].options.keepalive, true);
  assert.deepEqual(h.recorder.pending(), []);
});

test('pending openings are bounded and another account cancels them', async () => {
  let aborted = false;
  const h = harness((_url, options) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('aborted'));
    });
  }));
  h.recorder.setUser(7, false);
  for (let i = 0; i < MAX_PENDING_OPENINGS + 5; i++) {
    h.recorder.commit(`app-${i}`, h.recorder.begin(7));
  }
  assert.equal(h.recorder.pending().length, MAX_PENDING_OPENINGS);
  assert.equal(h.recorder.pending()[0].slug, 'app-5', 'the newest bounded history survives');

  h.recorder.setUser(7, true);
  await tick();
  h.host.App.user = { id: 8 };
  h.recorder.setUser(8, true);
  await tick();
  assert.equal(aborted, true);
  assert.deepEqual(h.recorder.pending(), []);
});

test('storage access can fail and a never-settling delivery times out', async () => {
  const h = harness(() => new Promise(() => {}));
  Object.defineProperty(h.host, 'localStorage', {
    configurable: true,
    get() { throw new Error('storage disabled'); },
  });
  const recorder = createAppOpeningRecorder(h.host, {
    now: () => Date.parse(NOW),
    retryDelays: [1],
    deliveryTimeoutMs: 10,
  });
  recorder.setUser(7, true);
  recorder.commit('coffee', recorder.begin(7));
  await tick();
  assert.equal(h.timers.length, 1, 'one delivery deadline is armed');
  h.timers[0]();
  await tick();
  assert.equal(recorder.pending()[0].attempts, 1);
  assert.equal(h.timers.length, 2, 'the timed-out request moves onto the retry schedule');
});

test('an opening expires while an offline page remains open', async () => {
  let current = Date.parse(NOW);
  const h = harness(async () => { throw new Error('offline'); });
  const recorder = createAppOpeningRecorder(h.host, {
    now: () => current,
    retryDelays: [1],
    deliveryTimeoutMs: 10,
  });
  recorder.setUser(7, true);
  recorder.commit('coffee', recorder.begin(7));
  await tick();
  assert.equal(recorder.pending().length, 1);
  current += 7 * 24 * 60 * 60 * 1000 + 1;
  await recorder.flush();
  assert.deepEqual(recorder.pending(), []);
  assert.equal(h.requests.length, 1, 'an expired occurrence is dropped instead of recast at receipt time');
});

test('a late-loaded bridge resumes only a verified account queue', async () => {
  const retained = [{
    openingId: '00000000-0000-4000-8000-000000000099',
    occurredAt: NOW,
    slug: 'coffee',
    userId: '7',
    attempts: 1,
  }];
  const verified = harness();
  verified.values.set('usernode_app_openings_v1', JSON.stringify(retained));
  verified.host.App._sessionFromSnapshot = false;
  const resumed = createAppOpeningRecorder(verified.host, {
    now: () => Date.parse(NOW), retryDelays: [1], deliveryTimeoutMs: 10,
  });
  await tick();
  assert.equal(verified.requests.length, 1);
  assert.deepEqual(resumed.pending(), []);

  const snapshot = harness();
  snapshot.values.set('usernode_app_openings_v1', JSON.stringify(retained));
  snapshot.host.App._sessionFromSnapshot = true;
  const held = createAppOpeningRecorder(snapshot.host, {
    now: () => Date.parse(NOW), retryDelays: [1], deliveryTimeoutMs: 10,
  });
  await tick();
  assert.equal(snapshot.requests.length, 0, 'display-only identity cannot send analytics');
  held.setUser(7, true);
  await tick();
  assert.equal(snapshot.requests.length, 1, 'server reconciliation releases retained work');
});

test('App-tab transitions emit once while Dev, self-hosted and rerenders stay quiet', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
  const commits = [];
  let begins = 0;
  const visible = new Set(['app-view']);
  const element = (id) => ({
    id,
    classList: { contains: (name) => name === 'hidden' ? !visible.has(id) : false },
    setAttribute() {}, removeAttribute() {},
  });
  const AppView = new Proxy({
    appData: { slug: 'coffee', self_hosted: false, status: 'running' },
    renderAppTab() {},
    async renderDevView() {},
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  const context = vm.createContext({
    console,
    location: new URL('https://homeroom.test/app/coffee'),
    history: { pushState() {}, replaceState() {} },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    document: { title: '', getElementById: element, querySelector: () => null, addEventListener() {} },
    AppView,
    UsernodeReact: {
      appOpenings: {
        begin(userId) {
          begins += 1;
          return { openingId: `open-${begins}`, occurredAt: NOW, userId };
        },
        commit(slug, opening) { commits.push({ slug, opening }); },
      },
    },
    Improve: { setTab() {} },
  });
  context.window = context;
  vm.runInContext(source, context);
  const App = context.App;
  App.user = { id: 7 };
  App.currentApp = 'coffee';
  App.currentTab = 'dev';
  App._isScreenVisible = () => true;
  App._syncPlatformTabs = () => {};
  App._noteAppReturn = () => {};
  App._pinAppReturn = () => {};
  App.setBackIcon = () => {};
  App.updateHash = () => {};

  await App.switchTab('app');
  assert.equal(begins, 1);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].slug, 'coffee');

  await App.switchTab('app');
  assert.equal(commits.length, 1, 'rerendering an already-mounted App tab is not another opening');

  await App.switchTab('dev');
  assert.equal(commits.length, 1, 'Workshop/Dev navigation does not emit');

  AppView.appData.self_hosted = true;
  await App.switchTab('app');
  assert.equal(commits.length, 1, 'the self-hosted app coerces to Dev before opening begins');
});

test('navigation commits only after successful current app loading', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
  const guard = source.indexOf('if (App.currentApp !== slug) return false;', source.indexOf('async navigateToApp'));
  const currentGuard = source.indexOf('if (generation !== App._appNavigationGeneration) return false;', guard);
  const handoff = source.indexOf('opening,', currentGuard);
  const commit = source.indexOf('appOpenings?.commit', source.indexOf('async switchTab'));
  assert.ok(guard > 0 && currentGuard > guard && handoff > currentGuard,
    'failed/stale navigation exits before it can hand an opening to the rendered tab');
  assert.ok(commit > source.indexOf('AppView.renderAppTab()', source.indexOf('async switchTab')),
    'the durable signal is queued only after the App tab renders');
});
