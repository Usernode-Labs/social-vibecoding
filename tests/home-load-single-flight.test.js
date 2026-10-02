// Home.load() runs one catalog load at a time.
//
// load() is called from a dozen live paths (every app status, redeploy,
// version and session event, the late-arrival correction, pull-to-refresh,
// the card menu), and every call was a full GET /api/apps — the platform's
// largest read. A burst of them downloaded the catalog several times at once
// on the same link. A call that lands while a load is running now queues ONE
// more load behind it, shared by every caller in that window; nothing is
// dropped, and the queued load starts after the last trigger.
//
// Same vm harness as tests/home-search-reveal.test.js.
//
// Run with: node --test tests/home-load-single-flight.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { HOME_SRC } = require('./helpers/home-modules');

function makeHome() {
  const screen = { scrollTop: 0, addEventListener() {} };
  const els = { 'home-screen': screen };
  const requests = [];
  const sandbox = {
    console,
    App: { user: { id: 1 } },
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      createElement: () => ({ classList: { add() {} }, dataset: {} }),
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    // Each catalog request waits until the test answers it.
    fetch: (url) => new Promise((resolve) => { requests.push({ url, resolve }); }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams,
    requestAnimationFrame: (fn) => fn(),
    location: { search: '' },
    // The error card's store (an import the harness strips).
    gridStore: { set: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  const Home = sandbox.__Home;
  Home._searchReveal.sync = () => {};
  Home._probeShortcutSupport = () => {};
  Home.publishImproveTarget = () => {};
  Home._ensureLayoutLoaded = () => {};
  Home._healWidgetIcons = () => {};
  const renders = [];
  Home.render = () => renders.push(Home._apps.map((a) => a.slug).join(','));
  return { Home, requests, renders };
}

const answer = (req, apps) => req.resolve({ ok: true, json: async () => ({ apps }) });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a burst of loads costs the running request and ONE more', async () => {
  const { Home, requests, renders } = makeHome();
  const first = Home.load();
  await tick();
  assert.equal(requests.length, 1);

  const burst = [Home.load(), Home.load(), Home.load(), Home.load()];
  await tick();
  assert.equal(requests.length, 1, 'nothing new starts while a load is running');
  assert.ok(burst.every((p) => p === burst[0]), 'every caller in the window shares the queued load');

  answer(requests[0], [{ slug: 'old' }]);
  await first;
  await tick();
  assert.equal(requests.length, 2, 'the queued load starts once the running one settles');
  assert.equal(requests[1].url, '/api/apps');

  answer(requests[1], [{ slug: 'new' }]);
  await Promise.all(burst);
  assert.equal(requests.length, 2);
  assert.deepEqual(renders, ['old', 'new'], 'the grid ends on the answer requested after the burst');
});

test('loads that do not overlap are not merged', async () => {
  const { Home, requests } = makeHome();
  const a = Home.load();
  await tick();
  answer(requests[0], [{ slug: 'a' }]);
  await a;
  const b = Home.load();
  await tick();
  assert.equal(requests.length, 2);
  answer(requests[1], [{ slug: 'b' }]);
  await b;
  assert.equal(Home._apps[0].slug, 'b');
});

test('a caller that awaits load() after its write sees a load that started after it', async () => {
  const { Home, requests } = makeHome();
  Home.load();
  await tick();
  // The write lands here, then its caller reloads while the older load runs.
  const afterWrite = Home.load();
  answer(requests[0], [{ slug: 'before-write' }]);
  await tick();
  answer(requests[1], [{ slug: 'after-write' }]);
  await afterWrite;
  assert.equal(Home._apps[0].slug, 'after-write');
});

test('a failed load still runs the one queued behind it', async () => {
  const { Home, requests } = makeHome();
  const first = Home.load();
  await tick();
  const queued = Home.load();
  requests[0].resolve({ ok: false, json: async () => ({}) });
  await first;
  await tick();
  assert.equal(requests.length, 2);
  answer(requests[1], [{ slug: 'recovered' }]);
  await queued;
  assert.equal(Home._apps[0].slug, 'recovered');
});
