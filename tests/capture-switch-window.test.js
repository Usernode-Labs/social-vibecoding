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
//   * How a check's page is loaded is the APP's rule, never the check's.
//     dapp.json declares its `bootParams` (query parameters read only at
//     boot, a one-time deep link) and its `routingBoundaries` (routes whose
//     screen sends the next address change elsewhere). The platform turns
//     them into two bits per check (app-manifest.js checkLoadFlags): a
//     `coldLoad` check gets a load of its own (shared with its own URL's
//     checks only), which is exactly what the fallback would have re-run;
//     an `endsGroup` check is still reached by a switch, but nothing is
//     switched to after it. Nothing exempts a plain address from a switch.
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

// ── The runner: the two wire bits ──────────────────────────────────────

const T = (index, url, extra = {}) => ({ index, name: `c${index}`, path: url.replace('http://s', ''), url, ...extra });
const ids = (groups) => groups.map((g) => g.map((t) => t.index));

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
  assert.deepEqual(ids(groups), [[0, 3], [1, 2], [4], [5]],
    'the rest of the document is grouped as before; the coldLoad checks are a group per URL; solo stays alone');
  for (const g of groups.slice(1, 3)) assert.equal(cohortsOf(g).length, 1, 'one cohort: its first is its load, never a switch');
  // A list that declares none is grouped exactly as before.
  const plain = tests.map(({ coldLoad, solo, ...t }) => t);
  assert.deepEqual(ids(groupTests(plain, {})), [[0, 5, 1, 2, 3, 4]]);
  // The kill-switch's per-URL grouping keeps them apart the same way.
  assert.deepEqual(ids(groupTests(tests, { TEST_GROUP_BY_DOCUMENT: '0' })), [[0], [3], [1, 2], [4], [5]]);
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

test('an endsGroup cohort stays in its document\'s group, reached by a switch, and nothing is switched to after it', () => {
  const E = { endsGroup: true };
  // The bare cohort leads, the boundary goes last, the rest keep their order.
  const one = [T(0, 'http://s/'), T(1, 'http://s/#/app', E), T(2, 'http://s/#/m'), T(3, 'http://s/#/n')];
  assert.deepEqual(ids(groupTests(one, {})), [[0, 2, 3, 1]]);
  // Each joins the first chunk that has not ended (one past the cap if it
  // must), and only when every chunk has ended does one start a chunk.
  const many = [
    T(0, 'http://s/#/a'), T(1, 'http://s/#/b'), T(2, 'http://s/#/c'),
    T(3, 'http://s/#/e1', E), T(4, 'http://s/#/e2', E), T(5, 'http://s/#/e3', E), T(6, 'http://s/#/e3', E),
  ];
  // Two chunks can each end on one; the third boundary stays an ordinary
  // cohort rather than leading a chunk of its own (Codex, review of 8764).
  assert.deepEqual(ids(groupTests(many, { TEST_HASH_GROUP_CAP: '2' })), [[0, 1, 3], [2, 5, 6, 4]]);
  for (const g of groupTests(many, { TEST_HASH_GROUP_CAP: '2' })) {
    assert.ok(!cohortsOf(g)[0].tests.some((t) => t.endsGroup), 'no boundary is a group\'s load');
  }
  // A list that sets none is grouped exactly as before.
  const plain = many.map(({ endsGroup, ...t }) => t);
  assert.deepEqual(ids(groupTests(plain, { TEST_HASH_GROUP_CAP: '2' })), [[0, 1], [2, 3], [4, 5, 6]]);
  // A document of boundaries only is grouped exactly as plain grouping would.
  const all = [T(0, 'http://s/#/p/a', E), T(1, 'http://s/#/p/b', E), T(2, 'http://s/#/p/c', E)];
  assert.deepEqual(ids(groupTests(all, {})), [[0, 1, 2]]);
  assert.deepEqual(ids(groupTests(all, { TEST_HASH_GROUP_CAP: '2' })), [[0, 1], [2]]);
  // A bare address is never moved, whatever it carries: it is the group's load.
  assert.deepEqual(ids(groupTests([T(0, 'http://s/#/a'), T(1, 'http://s/', E)], {})), [[1, 0]]);
  // Per-URL grouping has no switches to order.
  assert.deepEqual(ids(groupTests(one, { TEST_GROUP_BY_DOCUMENT: '0' })), [[0], [1], [2], [3]]);
});

// A page that hands every address change after `#/app` to something else
// (as a running app's side panel does): the switched-to screen never draws.
function makeHandoffPage() {
  const p = makePage({ renderOnHash: true });
  const evaluate = p.evaluate;
  let handedOff = false;
  p.evaluate = async (fn, arg) => {
    const isHash = typeof fn === 'function' && /location\.hash/.test(String(fn));
    if (isHash && handedOff) { p.hashes.push(arg); return undefined; }
    const r = await evaluate(fn, arg);
    if (isHash && arg === '#/app') handedOff = true;
    return r;
  };
  const goto = p.goto;
  p.goto = async (u) => { handedOff = String(u).endsWith('#/app'); return goto(u); };
  return p;
}

for (const marked of [true, false]) {
  test(`a routing boundary ${marked ? 'ends its group: no fallback' : 'left unmarked: the cohort after it falls back'}`, async () => {
    const read = collect();
    const pages = [];
    const browser = {
      async createBrowserContext() {
        return { async newPage() { const p = makeHandoffPage(); pages.push(p); return p; }, async close() {} };
      },
    };
    const tests = [
      T(0, 'http://s/#/x', { expectSelector: '#at-#/x' }),
      T(1, 'http://s/#/app', { expectSelector: '#at-#/app', ...(marked ? { endsGroup: true } : {}) }),
      T(2, 'http://s/#/m', { expectSelector: '#at-#/m' }),
    ];
    try {
      await runTests(browser, tests, { concurrency: 1, testTimeoutMs: 5000, ...FAST, assertMaxMs: 200 });
    } finally { for (const p of pages) p.stop(); }
    const { frames, text } = read();
    assert.deepEqual(frames.map((f) => f.status), ['pass', 'pass', 'pass'], 'the verdicts never depend on it');
    const d = parseDiagnostics(text).find((x) => x.kind === 'checks-timing').data;
    assert.equal(d.fallbacks.n, marked ? 0 : 1);
    if (marked) {
      assert.equal(pages.length, 1, 'one load');
      assert.deepEqual(pages[0].hashes, ['#/m', '#/app'], 'the boundary itself is reached by a switch, last');
    }
  });
}

// Codex's reproduction (review of 8764): `#home`, then two routes under a
// declared boundary `#page/*` whose screen hands the next switch elsewhere,
// and `#page/broken`, which an incoming switch never draws (a navigation
// bug; a load of it does draw it). The rule must not make it fast.
function makeRoutesPage({ handsOff, brokenOnSwitch }) {
  const p = makePage({ renderOnHash: true });
  const evaluate = p.evaluate;
  let handedOff = false;
  p.evaluate = async (fn, arg) => {
    const isHash = typeof fn === 'function' && /location\.hash/.test(String(fn));
    if (isHash && (handedOff || brokenOnSwitch.includes(arg))) {
      p.hashes.push(arg);
      handedOff = handedOff || handsOff.some((h) => String(arg).startsWith(h));
      return undefined;
    }
    const r = await evaluate(fn, arg);
    if (isHash && handsOff.some((h) => String(arg).startsWith(h))) handedOff = true;
    return r;
  };
  const goto = p.goto;
  p.goto = async (u) => {
    const at = String(u).slice(String(u).indexOf('#'));
    handedOff = handsOff.some((h) => at.startsWith(h));
    return goto(u);
  };
  return p;
}

async function runRoutes(tests) {
  const read = collect();
  const pages = [];
  const browser = {
    async createBrowserContext() {
      return {
        async newPage() {
          const p = makeRoutesPage({ handsOff: ['#page/'], brokenOnSwitch: ['#page/broken'] });
          pages.push(p);
          return p;
        },
        async close() {},
      };
    },
  };
  try {
    await runTests(browser, tests, { concurrency: 1, testTimeoutMs: 5000, ...FAST, assertMaxMs: 200 });
  } finally { for (const p of pages) p.stop(); }
  const { frames, text } = read();
  const d = parseDiagnostics(text).find((x) => x.kind === 'checks-timing').data;
  return { frames, fallbacks: d.fallbacks.n, switched: pages.flatMap((p) => p.hashes), loads: pages.flatMap((p) => p.gotos).filter((u) => u !== 'about:blank') };
}

for (const marked of [false, true]) {
  test(`a broken route under a routing boundary is still reached by a switch and still falls back (${marked ? 'boundary declared' : 'no rule'})`, async () => {
    const E = marked ? { endsGroup: true } : {};
    const tests = [
      T(0, 'http://s/#home', { expectSelector: '#at-#home' }),
      T(1, 'http://s/#page/first', { expectSelector: '#at-#page/first', ...E }),
      T(2, 'http://s/#page/broken', { expectSelector: '#at-#page/broken', ...E }),
    ];
    const groups = groupTests(tests, {});
    assert.equal(groups.length, 1, 'no load of its own');
    const r = await runRoutes(tests);
    assert.deepEqual(r.frames.map((f) => f.status), ['pass', 'pass', 'pass']);
    assert.ok(r.switched.includes('#page/broken'), 'its incoming switch is tested');
    assert.ok(r.fallbacks >= 1, 'the navigation bug still costs its fallback');
    assert.deepEqual(r.loads.filter((u) => u.endsWith('#page/broken')).length, 1, 'loaded only by the fallback');
  });
}

test('a document of boundaries only: every one after the first is still reached by a switch', async () => {
  const E = { endsGroup: true };
  const tests = [
    T(0, 'http://s/#page/first', { expectSelector: '#at-#page/first', ...E }),
    T(1, 'http://s/#page/broken', { expectSelector: '#at-#page/broken', ...E }),
  ];
  assert.deepEqual(ids(groupTests(tests, {})), [[0, 1]]);
  const r = await runRoutes(tests);
  assert.ok(r.switched.includes('#page/broken'));
  assert.equal(r.fallbacks, 1);
});

test('a routing boundary never adds a load and never turns a switch into one (random documents)', () => {
  // The invariant, behaviourally: compared with grouping the same document
  // with no boundary declared, the rule makes no more groups, and a check
  // that is its group's load under the rule is its group's load without it
  // too, or is not a boundary at all.
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let run = 0; run < 400; run += 1) {
    const n = 1 + rnd(14);
    const cap = String(1 + rnd(7));
    const tests = [];
    for (let i = 0; i < n; i += 1) {
      const hash = rnd(9) === 0 ? '' : `#r${rnd(12)}`;
      tests.push(T(i, `http://s/${hash}`, rnd(3) === 0 ? { endsGroup: true } : {}));
    }
    const env = { TEST_HASH_GROUP_CAP: cap };
    const ruled = groupTests(tests, env);
    const plain = groupTests(tests.map(({ endsGroup, ...t }) => t), env);
    assert.ok(ruled.length <= plain.length, `more loads: ${JSON.stringify(ids(ruled))}`);
    const leads = (groups) => new Set(groups.flatMap((g) => cohortsOf(g)[0].tests.map((t) => t.index)));
    const plainLeads = leads(plain);
    for (const g of ruled) {
      for (const t of cohortsOf(g)[0].tests) {
        if (tests[t.index].endsGroup) assert.ok(plainLeads.has(t.index), `boundary ${t.url} became a load (cap ${cap}): ${JSON.stringify(ids(ruled))} vs ${JSON.stringify(ids(plain))}`);
      }
    }
    assert.equal(ruled.flat().length, n);
  }
});

test('resolveTests carries coldLoad and endsGroup when they are true, and only then', () => {
  const out = resolveTests({
    TESTS: JSON.stringify([
      { index: 0, url: 'http://s/a', coldLoad: true, endsGroup: true },
      { index: 1, url: 'http://s/b', coldLoad: 'yes', endsGroup: 1 },
      { index: 2, url: 'http://s/c' },
    ]),
  });
  assert.equal(out[0].coldLoad, true);
  assert.equal(out[0].endsGroup, true);
  for (const t of out.slice(1)) {
    assert.equal('coldLoad' in t, false);
    assert.equal('endsGroup' in t, false);
  }
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

// ── The manifest: the app's rules ──────────────────────────────────────

const manifest = require('../src/services/app-manifest');

test('bootParams is a short list of plain parameter names; anything else is dropped', () => {
  const r = (bootParams) => manifest.readLoadRules({ bootParams }).bootParams;
  assert.deepEqual(r(undefined), []);
  assert.deepEqual(r('shot'), [], 'not a list');
  assert.deepEqual(r(['shot', 'details', 'shot']), ['shot', 'details']);
  assert.deepEqual(r(['shot=x', 'a&b', ' shot', '', 7, null, '1x', '*', 'x'.repeat(33), 'flow']), ['flow']);
  assert.equal(r(Array.from({ length: 12 }, (_, i) => `p${i}`)).length, manifest.MAX_BOOT_PARAMS);
});

test('routingBoundaries are whole fragment routes with a literal first segment and a reason', () => {
  const r = (routingBoundaries) => manifest.readLoadRules({ routingBoundaries }).routingBoundaries.map((b) => b.route);
  const why = 'hands the next address change to a side panel';
  assert.deepEqual(r(undefined), []);
  assert.deepEqual(r({ route: '#app/*', reason: why }), [], 'not a list');
  assert.deepEqual(r([{ route: '#app/*', reason: why }, { route: '#app/*', reason: why }, { route: '#/legacy/x', reason: why }]), ['#app/*', '#/legacy/x']);
  for (const route of ['#', '#*', '#*/x', 'app/*', '/app/*', '#app/', '#app//x', '#app/*?x=1', '#app/a b', '#' + 'a'.repeat(200)]) {
    assert.deepEqual(r([{ route, reason: why }]), [], route);
  }
  assert.deepEqual(r([{ route: '#app/*' }, { route: '#app/*', reason: '  ' }, '#app/*']), [], 'a reason is required');
  assert.equal(r(Array.from({ length: 12 }, (_, i) => ({ route: `#r${i}`, reason: why }))).length, manifest.MAX_ROUTING_BOUNDARIES);
});

test('checkLoadFlags reads the address the platform visits, against the app\'s rules', () => {
  const rules = manifest.readLoadRules({
    bootParams: ['shot', 'details'],
    routingBoundaries: [{ route: '#app/*', reason: 'x' }, { route: '#app/*/app', reason: 'x' }],
  });
  const f = (a) => manifest.checkLoadFlags(a, rules);
  assert.deepEqual(f('/?shot=a#x'), { coldLoad: true });
  assert.deepEqual(f('/?demo=1&details=1#app/me/dev/proposals/1'), { coldLoad: true });
  assert.deepEqual(f('/#messages/1?shot=a'), { coldLoad: true }, 'in the fragment\'s own query too');
  assert.deepEqual(f('/?shots=1&xshot=2&detail=1#y'), {}, 'a name, not a prefix');
  assert.deepEqual(f('/?demo=1#settings'), {});
  assert.deepEqual(f('/#app/forkable'), { endsGroup: true });
  assert.deepEqual(f('/#app/forkable?path=/x'), { endsGroup: true }, 'the fragment\'s query is not part of its route');
  assert.deepEqual(f('/#app/forkable/app'), { endsGroup: true });
  assert.deepEqual(f('/?shot=s#app/forkable'), { coldLoad: true, endsGroup: true });
  assert.deepEqual(f('/#app/forkable/dev'), {}, 'a whole route, never a prefix');
  assert.deepEqual(f('/#app'), {});
  assert.deepEqual(f('/app/forkable'), {}, 'a path is a document of its own, not a route in one');
  assert.deepEqual(manifest.checkLoadFlags('/?shot=a#app/x', undefined), {}, 'an app that declares neither is untouched');
  assert.deepEqual(manifest.checkLoadFlags(null, rules), {});
});

test('the manifest gives no way to exempt a plain address from grouping', () => {
  // Whatever a check says about itself, the reader keeps none of it...
  const keys = ['coldLoad', 'endsGroup', 'solo', 'ownLoad', 'coldload', 'cold', 'noGroup', 'bootParams', 'routingBoundaries'];
  const entry = { name: 'p', path: '/#plain', expectSelector: '#p' };
  for (const k of keys) entry[k] = k === 'bootParams' ? ['p'] : (k === 'routingBoundaries' ? [{ route: '#plain', reason: 'x' }] : true);
  const meta = manifest.readTestsWithMeta({ tests: [entry] });
  assert.deepEqual(Object.keys(meta.tests[0]).sort(), ['allowConsoleErrors', 'expectSelector', 'expectText', 'name', 'path']);
  // ...and the app's rules only ever give a load of its own to an address
  // carrying a declared boot parameter. A routing boundary never does: its
  // check is still reached by a switch (see the runner tests above).
  const rules = manifest.readLoadRules({
    bootParams: ['shot'],
    routingBoundaries: [{ route: '#plain', reason: 'x' }, { route: '#a/*', reason: 'x' }],
  });
  for (const a of ['/#plain', '/?demo=1#plain', '/#a/b', '/#a/b?flow=1', '/?x=shot#plain', '/', '/#']) {
    assert.ok(!manifest.checkLoadFlags(a, rules).coldLoad, a);
  }
  // A leftover per-check coldLoad is ignored, not a reason to drop the check.
  const left = manifest.readTestsWithMeta({ tests: [{ name: 'l', path: '/?shot=x#y', coldLoad: true }] });
  assert.equal(left.tests.length, 1);
  assert.equal('coldLoad' in left.tests[0], false);
  assert.deepEqual(left.loadRules, { bootParams: [], routingBoundaries: [] });
});

test('the platform hands the app\'s rules to the runner as each check\'s bits, from the address it visits', () => {
  const visuals = require('node:fs').readFileSync(require.resolve('../src/services/visuals'), 'utf8');
  assert.match(visuals, /const visitPath = isSelfApp \? selfAppHashPath\(t\.path\) : t\.path;/);
  assert.match(visuals, /allowConsoleErrors: !!t\.allowConsoleErrors,\n(\s+\/\/[^\n]*\n)*\s+\.\.\.appManifest\.checkLoadFlags\(visitPath, declared\.loadRules\),\n\s+\};/);
  assert.match(visuals, /loadRules: meta\.loadRules,/);
  assert.doesNotMatch(visuals, /t\.coldLoad/, 'a check\'s own key is never read');
});

// ── Homeroom's own rules ───────────────────────────────────────────────

const { selfAppHashPath } = require('../src/services/visuals');
const dapp = require('../dapp.json');
// Homeroom's checks as the platform dispatches them: selfAppHashPath, then
// the app's rules against that address.
function homeroomTests(extra = []) {
  const meta = manifest.readTestsWithMeta({ ...dapp, tests: dapp.tests.concat(extra) });
  return meta.tests.map((t, index) => {
    const visit = selfAppHashPath(t.path);
    return { index, name: t.name, path: t.path, url: `https://s${visit}`, ...manifest.checkLoadFlags(visit, meta.loadRules) };
  });
}

test('Homeroom declares its boot parameters and its routing boundary, and no check marks itself', () => {
  assert.deepEqual(dapp.bootParams, ['shot', 'details'],
    '`?flow=` is not one: #5280 made it work on a conversation already open');
  assert.deepEqual(dapp.routingBoundaries.map((b) => b.route), ['#app/*', '#app/*/app']);
  const marked = dapp.tests.filter((t) => Object.prototype.hasOwnProperty.call(t, 'coldLoad'));
  assert.deepEqual(marked.map((t) => t.name), [],
    'per-check "coldLoad" is retired and ignored: declare the app\'s "bootParams" or "routingBoundaries" (src/prompts/app-conventions.md)');
});

test('every check #5280 and #5317 marked still gets what its mark gave it', () => {
  const tests = homeroomTests();
  const groups = groupTests(tests, {});
  const groupOf = (t) => groups.find((g) => g.includes(t));
  // #5280's 22: a one-time boot link, each now a load of its own.
  const boot = [
    '/?demo=1&details=1#app/usernode-2d5619/dev/proposals/9000022',
    '/?demo=1&details=1#app/usernode-2d5619/dev/proposals/9000026',
    '/?demo=1&details=1#app/usernode-2d5619/dev/proposals/9000028',
    '/?demo=1&details=1#app/usernode-2d5619/dev/proposals/9000033',
    '/?demo=1&details=1#app/usernode-2d5619/dev/proposals/9000034',
    '/?demo=1&details=1#app/usernode-2d5619/dev/proposals/9000093',
    '/?shot=app-context&demo=1#app/usernode-2d5619/dev',
    '/?shot=notifications-messages&demo=1#app/usernode-2d5619/dev',
  ];
  const at = tests.filter((t) => boot.includes(t.path));
  assert.equal(at.length, 22);
  for (const t of at) {
    assert.equal(t.coldLoad, true, t.path);
    assert.equal(cohortsOf(groupOf(t)).length, 1, `${t.path} is its group's load`);
  }
  // #5317's one: the running app's desktop check, now last in its group.
  const app = tests.find((t) => t.path === '/#app/staging-demo-forkable');
  assert.equal(app.endsGroup, true);
  const cs = cohortsOf(groupOf(app));
  assert.equal(cs[cs.length - 1].hash, '#app/staging-demo-forkable');
});

test('a running app never hands its page to the next check: the side panel takes it, by design', () => {
  // With an app on screen on a desktop, `location.hash = '#messages/…'` is
  // caught by the side panel's Navigation API chokepoint and opened beside
  // the app: the screen the next check asserts on is never drawn in the
  // page itself (#5317: `#app/staging-demo-forkable` then
  // `#messages/agent/990801`, a fallback on every run).
  const { loadTsx } = require('./lib/render-tsx');
  const R = loadTsx('frontend/src/features/side-panel/routes.ts');
  assert.equal(R.isPanelRoute('app/staging-demo-forkable'), false, 'the App tab: the app itself');
  assert.equal(R.isPanelRoute('messages/agent/990801'), true, 'a conversation opens beside a running app');
  const controller = require('node:fs').readFileSync(require.resolve('../frontend/src/features/side-panel/controller.ts'), 'utf8');
  assert.match(controller, /export function onNavigate\(e: NavigateEventLike\): void \{[\s\S]*?if \(!isPanelRoute\(route\) \|\| !canTake\(\)\) return;\s+e\.preventDefault\(\);\s+open\(route, null\);/);
  assert.match(controller, /if \(!A\.currentApp \|\| A\.currentTab !== 'app'\) return false;/, 'only on the App tab');

  // The App tab is what the route table makes of `app/<slug>` and
  // `app/<slug>/app`: not a panel page. Homeroom's own App tab is not a
  // running app (the platform does not run itself in a frame).
  const SELF = 'usernode-2d5619';
  const appTab = (url) => {
    const route = R.routeFromUrl(url);
    const parts = route.split('/');
    return parts[0] === 'app' && !!parts[1] && parts[1] !== SELF
      && (parts.length === 2 || (parts.length === 3 && parts[2] === 'app'))
      && R.panelPage(route) === null;
  };
  // A future App-tab check, with a query in its fragment, is held by the same rule.
  const future = { name: 'future running app', path: '/#app/future-running?path=/x', expectSelector: '#app-view' };
  assert.ok(appTab('https://s/#app/future-running?path=/x'));
  assert.ok(!appTab(`https://s/#app/${SELF}`), 'Homeroom\'s own App tab');
  assert.ok(appTab(`https://s/#app/${SELF}-fork`), 'the own slug, by exact match only');
  for (const tests of [homeroomTests(), homeroomTests([future])]) {
    // In a fragment it ends its group. A clean `/app/<slug>` path is a
    // document of its own, and the loop below still holds it to the rule.
    for (const t of tests) if (appTab(t.url) && t.url.includes('#')) assert.equal(t.endsGroup, true, `${t.path} ends its group`);
    for (const g of groupTests(tests, {})) {
      const cohorts = cohortsOf(g);
      for (let i = 0; i + 1 < cohorts.length; i += 1) {
        const url = cohorts[i].tests[0].url;
        assert.ok(!appTab(url), `${cohorts[i].hash} hands its page to ${cohorts[i + 1].hash}`);
      }
    }
  }
});
