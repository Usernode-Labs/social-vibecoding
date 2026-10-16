// capture/capture.js: what a check reached by a hash switch is given, and the
// checks a load of their own is declared for.
//
// Grouping moves between a document's checks by writing `location.hash`, and
// a check whose screen does not appear is re-run on a cold load (#1146). Two
// things are pinned here:
//
//   * The window after a switch stays the full, rolling one. A shorter one
//     was tried (a fixed 3s, from Homeroom's own timings) and changed
//     verdicts both ways: a route that renders 4.2s after the switch passed
//     before and failed after it (its cold start was slower still), and a
//     route that renders and then logs an error at 4.2s failed before and
//     passed after it (the document holding the error was thrown away).
//     Homeroom's sample says nothing about slower apps, so the runner does
//     not guess.
//   * A check can say its screen is drawn only by a load of its address
//     (dapp.json `"coldLoad": true`): a one-time deep link scripted at boot.
//     It then gets a load of its own (shared with its own URL's checks only),
//     which is exactly what the fallback would have re-run, without first
//     waiting out the window on a screen that was not coming.
//
// And the checks-timing line counts the cohorts that needed the fallback.
//
// Run with: node --test tests/capture-switch-window.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runTestGroup, runTests, setFrameSink, groupTests, resolveTests, cohortsOf,
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

// A page whose sub-route renders `renderAfterMs` after a hash switch reaches
// it (`renderOnHash`), or only when the document is loaded at it, `coldRenderMs`
// into that load. `errorAfterMs` logs a console error that long after a switch.
function makePage({ renderOnHash = false, renderAfterMs = 0, coldRenderMs = 0, errorAfterMs = null } = {}) {
  const handlers = new Map();
  const timers = [];
  const page = {
    gotos: [], hashes: [], loaded: '', readyAt: 0,
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
    },
    emitError(text) {
      for (const fn of handlers.get('console') || []) {
        fn({ type: () => 'error', text: () => text, location: () => ({ url: 'app.js', lineNumber: 1 }) });
      }
    },
    later(fn, ms) { timers.push(setTimeout(fn, ms)); },
    async setViewport() {},
    async goto(u) {
      page.gotos.push(u);
      const i = String(u).indexOf('#');
      page.loaded = i === -1 ? '' : String(u).slice(i);
      page.readyAt = performance.now() + coldRenderMs;
      return { status: () => 200 };
    },
    async waitForNetworkIdle() {},
    async $(sel) {
      return sel === `#at-${page.loaded}` && performance.now() >= page.readyAt ? {} : null;
    },
    async evaluate(fn, arg) {
      if (typeof fn === 'function' && /location\.hash/.test(String(fn))) {
        page.hashes.push(arg);
        if (renderOnHash) { page.loaded = arg; page.readyAt = performance.now() + renderAfterMs; }
        if (errorAfterMs != null) page.later(() => page.emitError(`late error on ${arg}`), errorAfterMs);
        return undefined;
      }
      return true;
    },
    async close() {},
    stop() { for (const t of timers) clearTimeout(t); },
  };
  return page;
}

const GROUP = [
  { index: 0, name: 'a', path: '/dev', url: 'http://s/dev#/a', expectSelector: '#at-#/a' },
  { index: 1, name: 'b', path: '/dev', url: 'http://s/dev#/b', expectSelector: '#at-#/b' },
];
const FAST = { settleQuietMs: 10, settleMaxMs: 30, assertPollMs: 10 };

// The two counterexamples a fixed 3s window failed (review of #5280), at a
// tenth of the scale: the window is 1s here, the screen arrives at 0.42s.
test('a route that renders late after a switch still passes on that switch, with no reload', async () => {
  const read = collect();
  // Its cold start is slower than the whole window: a reload would fail it.
  const page = makePage({ renderOnHash: true, renderAfterMs: 420, coldRenderMs: 5000 });
  const group = [{ ...GROUP[0], expectSelector: '' }, GROUP[1]];
  try {
    await runTestGroup({ newPage: async () => page }, group, { ...FAST, assertMaxMs: 1000 });
  } finally { page.stop(); }
  const { frames } = read();
  assert.deepEqual(frames.map((f) => f.status), ['pass', 'pass']);
  assert.deepEqual(page.gotos, ['http://s/dev#/a'], 'judged on the switch it was reached by');
});

test('a route that renders and then logs an error late after a switch still fails on that error', async () => {
  const read = collect();
  // Rendered at 0.42s and the error at 0.45s: the presence poll sees the
  // screen, and the console is frozen only after it, so the switch is judged
  // with the error in it. A window cut short before 0.42s threw the
  // document away and passed the check clean on a cold load.
  const page = makePage({ renderOnHash: true, renderAfterMs: 420, errorAfterMs: 400 });
  try {
    await runTestGroup({ newPage: async () => page }, GROUP, { ...FAST, assertMaxMs: 1000 });
  } finally { page.stop(); }
  const b = read().frames.find((f) => f.index === 1);
  assert.equal(page.gotos.length, 1, 'not thrown away for a cold load');
  assert.equal(b.status, 'fail');
  assert.match(JSON.stringify(b.consoleErrors), /late error on #\/b/);
});

test('a switch that cannot render still falls back to a cold load, and is counted', async () => {
  const read = collect();
  const page = makePage();
  const timing = {};
  await runTestGroup({ newPage: async () => page }, GROUP, { ...FAST, assertMaxMs: 60, timing });
  const { frames } = read();
  assert.deepEqual(frames.map((f) => f.status), ['pass', 'pass']);
  assert.deepEqual(page.gotos, ['http://s/dev#/a', 'about:blank', 'http://s/dev#/b']);
  assert.equal(timing.fallbacks, 1);
  assert.ok(timing.fallbackMs > 0);
});

// ── coldLoad ────────────────────────────────────────────────────────────

const T = (index, url, extra = {}) => ({ index, name: `c${index}`, path: url.replace('http://s', ''), url, ...extra });

test('a coldLoad check gets a load of its own, shared only with its own URL\'s checks', () => {
  const tests = [
    T(0, 'http://s/?d=1#/x'),
    T(1, 'http://s/?d=1#/y', { coldLoad: true }),
    T(2, 'http://s/?d=1#/y', { coldLoad: true }),
    T(3, 'http://s/?d=1#/z'),
    T(4, 'http://s/?d=1#/w', { coldLoad: true }),
    T(5, 'http://s/?d=1#/x', { solo: true }),
  ];
  const groups = groupTests(tests, {});
  assert.deepEqual(groups.map((g) => g.map((t) => t.index)), [[0, 3], [1, 2], [4], [5]],
    'the rest of the document is grouped as before; the coldLoad checks are a group per URL; solo stays alone');
  for (const g of groups.slice(1, 3)) assert.equal(cohortsOf(g).length, 1, 'one cohort: its first is its load, never a switch');
  // A list that declares none is grouped exactly as before.
  const plain = tests.map(({ coldLoad, solo, ...t }) => t);
  assert.deepEqual(groupTests(plain, {}).map((g) => g.map((t) => t.index)), [[0, 5, 1, 2, 3, 4]]);
  // The kill-switch's per-URL grouping keeps them apart the same way.
  assert.deepEqual(groupTests(tests, { TEST_GROUP_BY_DOCUMENT: '0' }).map((g) => g.map((t) => t.index)),
    [[0], [3], [1, 2], [4], [5]]);
});

test('a coldLoad check is judged on a load of its address: no switch, the full window, its own late errors heard', async () => {
  const read = collect();
  const pages = [];
  const browser = {
    async createBrowserContext() {
      return {
        async newPage() {
          // A screen drawn only by a load at it, 0.3s in; a load at #/y also
          // logs an error at 0.25s, while its screen is still coming.
          const p = makePage({ coldRenderMs: 300 });
          const goto = p.goto;
          p.goto = async (u) => {
            const r = await goto(u);
            if (String(u).endsWith('#/y')) p.later(() => p.emitError('boot script error'), 250);
            return r;
          };
          pages.push(p);
          return p;
        },
        async close() {},
      };
    },
  };
  const tests = [
    T(0, 'http://s/?d=1#/x', { expectSelector: '#at-#/x' }),
    T(1, 'http://s/?d=1#/y', { expectSelector: '#at-#/y', coldLoad: true }),
    T(2, 'http://s/?d=1#/w', { expectSelector: '#at-#/w', coldLoad: true }),
  ];
  try {
    await runTests(browser, tests, { concurrency: 3, testTimeoutMs: 5000, ...FAST, assertMaxMs: 1000 });
  } finally { for (const p of pages) p.stop(); }
  const { frames, text } = read();
  const by = new Map(frames.map((f) => [f.index, f]));
  assert.equal(by.get(0).status, 'pass');
  assert.equal(by.get(2).status, 'pass');
  assert.equal(by.get(1).status, 'fail', 'the error its own load logs fails it, as the ungrouped runner did');
  assert.match(JSON.stringify(by.get(1).consoleErrors), /boot script error/);
  assert.ok(pages.every((p) => p.hashes.length === 0), 'nothing was reached by a hash switch');
  assert.deepEqual(pages.map((p) => p.gotos.length), [1, 1, 1], 'three loads, no fallback');
  const d = parseDiagnostics(text).find((x) => x.kind === 'checks-timing').data;
  assert.deepEqual(d.fallbacks, { n: 0, ms: 0 });
});

test('resolveTests carries coldLoad when it is true, and only then', () => {
  const out = resolveTests({
    TESTS: JSON.stringify([
      { index: 0, url: 'http://s/a', coldLoad: true },
      { index: 1, url: 'http://s/b', coldLoad: 'yes' },
      { index: 2, url: 'http://s/c' },
    ]),
  });
  assert.equal(out[0].coldLoad, true);
  assert.equal('coldLoad' in out[1], false);
  assert.equal('coldLoad' in out[2], false);
});

test('the checks-timing line counts the cohorts that fell back, and their time, with no URL', async () => {
  const read = collect();
  const ORIGIN = 'https://usernode-2d5619--s9001.onhomeroom.com';
  const browser = {
    async createBrowserContext() {
      return { async newPage() { return makePage(); }, async close() {} };
    },
  };
  const tests = [
    { index: 0, name: 'a', path: '/d', url: `${ORIGIN}/d?token=secret#/a`, expectSelector: '#at-#/a' },
    { index: 1, name: 'b', path: '/d', url: `${ORIGIN}/d?token=secret#/b`, expectSelector: '#at-#/b' },
    { index: 2, name: 'c', path: '/d', url: `${ORIGIN}/d?token=secret#/c`, expectSelector: '#at-#/c' },
    { index: 3, name: 'e', path: '/e', url: `${ORIGIN}/e?token=secret#/e`, expectSelector: '#at-#/e' },
  ];
  await runTests(browser, tests, { concurrency: 2, testTimeoutMs: 5000, ...FAST, assertMaxMs: 40 });
  const { frames, text } = read();
  assert.ok(frames.every((f) => f.status === 'pass'));
  const d = parseDiagnostics(text).find((x) => x.kind === 'checks-timing').data;
  assert.equal(d.fallbacks.n, 2);
  assert.ok(Number.isInteger(d.fallbacks.ms) && d.fallbacks.ms > 0, JSON.stringify(d.fallbacks));
  const raw = Buffer.from(text.match(/kind=checks-timing (\S+)/)[1], 'base64').toString();
  assert.ok(!/secret|onhomeroom|#\//.test(raw), 'no URL, token or fragment in the line');
});

test('the manifest keeps coldLoad on a check that sets it, and adds nothing to one that does not', () => {
  const { readTests } = require('../src/services/app-manifest');
  const out = readTests({ tests: [
    { name: 'a', path: '/?shot=x#/a', expectSelector: '#a', coldLoad: true },
    { name: 'b', path: '/b', expectSelector: '#b', coldLoad: 1 },
    { name: 'c', path: '/c', expectSelector: '#c' },
  ] });
  assert.equal(out[0].coldLoad, true);
  assert.equal('coldLoad' in out[1], false);
  assert.equal('coldLoad' in out[2], false);
  // And the platform hands it on to the runner with the check.
  const visuals = require('node:fs').readFileSync(require.resolve('../src/services/visuals'), 'utf8');
  assert.match(visuals, /allowConsoleErrors: !!t\.allowConsoleErrors,\n(\s+\/\/[^\n]*\n)*\s+\.\.\.\(t\.coldLoad === true \? \{ coldLoad: true \} : \{\}\),\n\s+\};/);
});

test('Homeroom declares coldLoad on exactly the checks whose page a hash switch cannot share', () => {
  // `?details=1` opens Details on the first change page only, and `?shot=`
  // opens its sheet once at boot (both by design). Every cohort after a
  // document's first that carries one needed the cold-load fallback on every
  // run. Nothing else is declared: a check that renders on a switch keeps
  // its shared load.
  const dapp = require('../dapp.json');
  const cold = dapp.tests.filter((t) => t.coldLoad === true);
  assert.equal(cold.length, 23);
  const boot = cold.filter((t) => /[?&](details=1|shot=[a-z-]+)(&|#)/.test(t.path));
  assert.equal(boot.length, 22);
  const paths = [...new Set(cold.map((t) => t.path))].sort();
  assert.deepEqual(paths, [
    '/#app/staging-demo-forkable',
    '/?demo=1&details=1#app/usernode-2d5619/dev/proposals/9000022',
    '/?demo=1&details=1#app/usernode-2d5619/dev/proposals/9000026',
    '/?demo=1&details=1#app/usernode-2d5619/dev/proposals/9000028',
    '/?demo=1&details=1#app/usernode-2d5619/dev/proposals/9000033',
    '/?demo=1&details=1#app/usernode-2d5619/dev/proposals/9000034',
    '/?demo=1&details=1#app/usernode-2d5619/dev/proposals/9000093',
    '/?shot=app-context&demo=1#app/usernode-2d5619/dev',
    '/?shot=notifications-messages&demo=1#app/usernode-2d5619/dev',
  ]);
  // Every check at those addresses, so none is left to a switch on its own.
  for (const p of paths) {
    assert.ok(dapp.tests.filter((t) => t.path === p).every((t) => t.coldLoad === true), p);
  }
});

test('a running app\'s check has a load of its own, because the pages after it open in its side panel', () => {
  // The one fallback left on every run after #5280 (shard 0, 16-19s): the
  // desktop check of a running app (`/#app/staging-demo-forkable`) was the
  // first cohort of the shared `/` document, and the next was the agent
  // session at `#messages/agent/990801`. With an app on screen on a
  // desktop, `location.hash = '#messages/agent/990801'` is caught by the
  // side panel's Navigation API chokepoint and opened beside the app
  // (`?side=messages/agent/990801`), by design: the Messages screen the
  // checks assert on is never drawn in the page itself.
  const { loadTsx } = require('./lib/render-tsx');
  const R = loadTsx('frontend/src/features/side-panel/routes.ts');
  assert.equal(R.isPanelRoute('app/staging-demo-forkable'), false, 'the App tab: the app itself');
  assert.equal(R.isPanelRoute('messages/agent/990801'), true, 'a conversation opens beside a running app');
  const controller = require('node:fs').readFileSync(require.resolve('../frontend/src/features/side-panel/controller.ts'), 'utf8');
  assert.match(controller, /export function onNavigate\(e: NavigateEventLike\): void \{[\s\S]*?if \(!isPanelRoute\(route\) \|\| !canTake\(\)\) return;\s+e\.preventDefault\(\);\s+open\(route, null\);/);

  // So that check is grouped alone, and the rest of the `/` document no
  // longer starts on a running app.
  const { selfAppHashPath } = require('../src/services/visuals');
  const dapp = require('../dapp.json');
  const tests = dapp.tests.map((t, index) => ({
    index, name: t.name, path: t.path, url: `https://s${selfAppHashPath(t.path)}`, ...(t.coldLoad ? { coldLoad: true } : {}),
  }));
  const groups = groupTests(tests, {});
  const app = tests.find((t) => t.path === '/#app/staging-demo-forkable');
  const own = groups.find((g) => g.includes(app));
  assert.deepEqual(own.map((t) => t.index), [app.index]);
  // Nowhere else does a running app (an App tab address) hand its page to
  // a switch the side panel would take. Homeroom's own App tab is not one:
  // the platform does not run itself in a frame, and a switch from it to a
  // Workshop page draws that page in place (checked in Chromium).
  const appTab = (hash) => /^#app\/[^/?]+(\/(app|full))?$/.test(hash) && !hash.startsWith('#app/usernode-2d5619');
  for (const g of groups) {
    const cohorts = cohortsOf(g);
    for (let i = 0; i + 1 < cohorts.length; i += 1) {
      assert.ok(!(appTab(cohorts[i].hash) && R.isPanelRoute(cohorts[i + 1].hash.slice(1))),
        `${cohorts[i].hash} hands its page to ${cohorts[i + 1].hash}`);
    }
  }
});
