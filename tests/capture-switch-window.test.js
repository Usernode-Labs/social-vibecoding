// capture/capture.js: the window a hash switch gets before the cold-load
// fallback (#1146) takes over, and the fallback count in the checks-timing
// line. A switch whose cohort cannot render waited the full assertion window,
// rolling while the page fetched in the background, before it reloaded; in
// Homeroom's own runs that was 5-17s a cohort and about 160s of lane time a
// run. The cold load decides the verdict, so the switch now gets a short,
// fixed window, and the cold load keeps the full one.
//
// Run with: node --test tests/capture-switch-window.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runTestGroup, runTests, setFrameSink, assertSwitchMaxMs, ASSERT_SWITCH_MAX_MS,
} = require('../capture/capture');
const { parseDiagnostics } = require('../src/services/visuals');

function collect() {
  const chunks = [];
  setFrameSink((s) => chunks.push(s));
  return () => {
    const text = chunks.join('');
    const lines = text.split('\n');
    const frames = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].startsWith('__USERNODE_TEST__ ')) continue;
      const attrs = {};
      for (const m of lines[i].matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
      const payload = JSON.parse(Buffer.from(lines[i + 1], 'base64').toString('utf8'));
      frames.push({ index: Number(attrs.index), status: attrs.status, ...payload });
    }
    return { frames, text };
  };
}

// A page whose sub-route renders only when the document was LOADED at it
// (the shape of every non-equivalent switch: a boot-only deep link, a
// screen that keeps its mounted sub-route), optionally late, and which
// keeps fetching in the background the whole time (a version poll, a lazy
// chunk), which is what rolled the old window to its ceiling.
function makePage({ renderAfterMs = 0, renderOnHash = false, backgroundFetchMs = 0 } = {}) {
  const handlers = new Map();
  const timers = [];
  const page = {
    gotos: [], events: [], loaded: '', readyAt: 0,
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
    },
    async setViewport() {},
    async goto(u) {
      page.gotos.push(u);
      page.events.push({ kind: 'goto', url: u, at: performance.now() });
      const i = String(u).indexOf('#');
      page.loaded = i === -1 ? '' : String(u).slice(i);
      page.readyAt = performance.now() + renderAfterMs;
      if (backgroundFetchMs && !timers.length) {
        timers.push(setInterval(() => {
          for (const fn of handlers.get('response') || []) fn({});
        }, backgroundFetchMs));
      }
      return { status: () => 200 };
    },
    async waitForNetworkIdle() {},
    async $(sel) {
      return sel === `#at-${page.loaded}` && performance.now() >= page.readyAt ? {} : null;
    },
    async evaluate(fn, arg) {
      if (typeof fn === 'function' && /location\.hash/.test(String(fn))) {
        page.events.push({ kind: 'hash', hash: arg, at: performance.now() });
        if (renderOnHash) { page.loaded = arg; page.readyAt = performance.now() + renderAfterMs; }
        return undefined;
      }
      return true;
    },
    async close() {},
    stop() { for (const t of timers) clearInterval(t); },
  };
  return page;
}

const GROUP = [
  { index: 0, name: 'a', path: '/dev', url: 'http://s/dev#/a', expectSelector: '#at-#/a' },
  { index: 1, name: 'b', path: '/dev', url: 'http://s/dev#/b', expectSelector: '#at-#/b' },
];
const FAST = { settleQuietMs: 10, settleMaxMs: 30, assertPollMs: 10 };

function switchToReloadMs(page) {
  const hash = page.events.find((e) => e.kind === 'hash');
  const blank = page.events.find((e) => e.kind === 'goto' && e.url === 'about:blank');
  return blank.at - hash.at;
}

test('a switch that cannot render reloads after the short window, however much the page fetches', async () => {
  const read = collect();
  const page = makePage({ backgroundFetchMs: 20 });
  try {
    await runTestGroup({ newPage: async () => page }, GROUP,
      { ...FAST, assertMaxMs: 1500, assertSwitchMaxMs: 100 });
  } finally { page.stop(); }
  const { frames } = read();
  assert.deepEqual(frames.map((f) => f.status), ['pass', 'pass'], 'the cold load still decides, and passes');
  assert.deepEqual(page.gotos, ['http://s/dev#/a', 'about:blank', 'http://s/dev#/b']);
  const waited = switchToReloadMs(page);
  // The settle (at most 30ms here) plus the 100ms switch window. The full
  // window would be 1500ms, and rolling it with the background fetches 4500.
  assert.ok(waited < 700, `the switch waited ${Math.round(waited)}ms before reloading, not the full window`);
});

test('a screen slower than the switch window still passes, on the cold load', async () => {
  const read = collect();
  const page = makePage({ renderOnHash: true, renderAfterMs: 250 });
  await runTestGroup({ newPage: async () => page }, GROUP,
    { ...FAST, assertMaxMs: 2000, assertSwitchMaxMs: 50 });
  const { frames } = read();
  assert.deepEqual(frames.map((f) => f.status), ['pass', 'pass'],
    'the verdict is the same one; only the way to it changed');
  assert.ok(page.gotos.includes('about:blank'), 'it paid the cold load instead of the wait');
});

test('a screen that renders inside the switch window never pays for the fallback', async () => {
  const read = collect();
  const page = makePage({ renderOnHash: true, renderAfterMs: 30 });
  await runTestGroup({ newPage: async () => page }, GROUP,
    { ...FAST, assertMaxMs: 2000, assertSwitchMaxMs: 400 });
  const { frames } = read();
  assert.deepEqual(frames.map((f) => f.status), ['pass', 'pass']);
  assert.deepEqual(page.gotos, ['http://s/dev#/a'], 'one navigation for the document');
});

test('with the fallback off the switch keeps the full window, because its verdict stands', async () => {
  const read = collect();
  const page = makePage({ renderOnHash: true, renderAfterMs: 250 });
  await runTestGroup({ newPage: async () => page }, GROUP,
    { ...FAST, assertMaxMs: 2000, assertSwitchMaxMs: 50, env: { TEST_COHORT_RELOAD_FALLBACK: '0' } });
  const { frames } = read();
  assert.deepEqual(frames.map((f) => f.status), ['pass', 'pass'],
    'a late screen still passes where there is no cold load to catch it');
  assert.equal(page.gotos.length, 1);
});

test('the cold load the switch falls back to keeps the full window', async () => {
  const read = collect();
  // Renders only on a cold load at the fragment, and only 300ms after it:
  // longer than the switch window, inside the full one.
  const page = makePage({ renderAfterMs: 300 });
  await runTestGroup({ newPage: async () => page }, GROUP,
    { ...FAST, assertMaxMs: 2000, assertSwitchMaxMs: 50 });
  const { frames } = read();
  assert.deepEqual(frames.map((f) => f.status), ['pass', 'pass']);
});

test('the switch window comes from env with a sane default', () => {
  assert.equal(ASSERT_SWITCH_MAX_MS, 3000);
  assert.equal(assertSwitchMaxMs({}), 3000);
  assert.equal(assertSwitchMaxMs({ TEST_ASSERT_SWITCH_MAX_MS: '1200' }), 1200);
  assert.equal(assertSwitchMaxMs({ TEST_ASSERT_SWITCH_MAX_MS: 'soon' }), 3000, 'garbage falls back');
});

test('the checks-timing line counts the cohorts that fell back, and their time, with no URL', async () => {
  const read = collect();
  const ORIGIN = 'https://usernode-2d5619--s9001.onhomeroom.com';
  const pages = [];
  const browser = {
    async createBrowserContext() {
      return {
        async newPage() { const p = makePage(); pages.push(p); return p; },
        async close() {},
      };
    },
  };
  const tests = [
    // One document, three cohorts: two switches the page cannot render.
    { index: 0, name: 'a', path: '/d', url: `${ORIGIN}/d?token=secret#/a`, expectSelector: '#at-#/a' },
    { index: 1, name: 'b', path: '/d', url: `${ORIGIN}/d?token=secret#/b`, expectSelector: '#at-#/b' },
    { index: 2, name: 'c', path: '/d', url: `${ORIGIN}/d?token=secret#/c`, expectSelector: '#at-#/c' },
    // And a document of its own, which never switches.
    { index: 3, name: 'e', path: '/e', url: `${ORIGIN}/e?token=secret#/e`, expectSelector: '#at-#/e' },
  ];
  await runTests(browser, tests, { concurrency: 2, testTimeoutMs: 5000, ...FAST, assertMaxMs: 200, assertSwitchMaxMs: 20 });
  const { frames, text } = read();
  assert.ok(frames.every((f) => f.status === 'pass'));
  const d = parseDiagnostics(text).find((x) => x.kind === 'checks-timing').data;
  assert.equal(d.fallbacks.n, 2);
  assert.ok(Number.isInteger(d.fallbacks.ms) && d.fallbacks.ms > 0, JSON.stringify(d.fallbacks));
  assert.ok(d.fallbacks.ms <= d.groups.max * 2, 'a part of the groups\' own time');
  const raw = Buffer.from(text.match(/kind=checks-timing (\S+)/)[1], 'base64').toString();
  assert.ok(!/secret|onhomeroom|#\//.test(raw), 'no URL, token or fragment in the line');
});

test('a run that needed no fallback says zero', async () => {
  const read = collect();
  const browser = {
    async createBrowserContext() {
      return { async newPage() { return makePage({ renderOnHash: true }); }, async close() {} };
    },
  };
  const tests = [
    { index: 0, name: 'a', path: '/d', url: 'http://s/d#/a', expectSelector: '#at-#/a' },
    { index: 1, name: 'b', path: '/d', url: 'http://s/d#/b', expectSelector: '#at-#/b' },
  ];
  await runTests(browser, tests, { concurrency: 1, testTimeoutMs: 5000, ...FAST, assertMaxMs: 200 });
  const d = parseDiagnostics(read().text).find((x) => x.kind === 'checks-timing').data;
  assert.deepEqual(d.fallbacks, { n: 0, ms: 0 });
});
