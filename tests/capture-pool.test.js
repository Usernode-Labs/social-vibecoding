// Behavioural tests for capture/capture.js runTests — the bounded parallel
// page pool that replaced the sequential per-check loop (#1019).
//
// Why the loop had to go: the manifest reader used to keep only the first 12
// declared checks, so a 241-check manifest ran 12 checks and dropped 229.
// Removing the cap makes the RUNTIME the binding constraint instead —
// production measures ~3.9s marginal per check, so 241 sequential checks is
// ~16 minutes of a merge gate nobody would wait for. The pool is what makes
// "run everything" affordable.
//
// Four properties matter and none are visible from the frame format alone,
// so they are tested against a fake browser (runTests takes its pages from
// whatever it is handed, so no Chromium is needed):
//
//   1. ISOLATED CONTEXTS — every group gets its own browser context: its own
//      WINDOW (a same-context tab is `visibilityState: 'hidden'`, where view
//      transitions abort with a pageerror and rAF-driven UI never presents)
//      and its own cookie jar (each group's navigation exchanges its own
//      ?token= deterministically — the shared-jar design raced concurrent
//      exchanges and the losers rendered the "Admins only" gate).
//   2. BOUNDED — at most `concurrency` pages are open at once, whatever the
//      suite size. Unbounded fan-out is an OOM-kill, which loses the whole
//      run rather than one check.
//   3. PER-CHECK DEADLINE — a check that hangs is recorded as a failure and
//      its slot is released, so one bad route can't hold a worker forever.
//   4. SENTINEL — the run states how far it got, so the platform can tell a
//      budget-truncated suite from a crashed container.
//
// Most cases use `mode: 'fast'`, where the fake navigation rejects: runTest
// then emits its frame immediately instead of paying SETTLE_MS +
// CONSOLE_ONLY_SETTLE_MS (2s) per check. The verdict is beside the point for
// dispatch mechanics, and a suite that took 2s × waves would be minutes long.
// One case runs the settling path so the happy shape is covered too.
//
// Run with: node --test tests/capture-pool.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runTests, groupTestsByUrl, poolSize, testTimeoutMs, testsDeadlineMs, setFrameSink,
} = require('../capture/capture');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake browser. Mirrors the production shape (createBrowserContext →
// newPage), records page open/close so concurrency is observable, counts
// contexts so isolation is observable, and lets each test control how long
// a given check takes.
function makeBrowser({ delays = {}, log = [], mode = 'fast', missingSelectors = [] } = {}) {
  let open = 0;
  let peak = 0;
  let contexts = 0;
  let openContexts = 0;
  const newPage = async () => {
    open += 1;
    if (open > peak) peak = open;
    let closed = false;
    let url = '';
    return {
      on() {},
      async setViewport() {},
      async goto(u) {
        url = u;
        log.push({ call: 'goto', url: u, concurrent: open });
        const ms = delays[u];
        if (ms) await sleep(ms);
        if (mode === 'fast') throw new Error('fake: navigation refused');
        return { status: () => 200 };
      },
      async $(sel) { return missingSelectors.includes(sel) ? null : {}; },
      async evaluate() { return true; },
      async close() {
        if (!closed) { closed = true; open -= 1; }
        log.push({ call: 'close', url });
      },
    };
  };
  return {
    peak: () => peak,
    contexts: () => contexts,
    openContexts: () => openContexts,
    log,
    async createBrowserContext() {
      contexts += 1;
      openContexts += 1;
      let ctxClosed = false;
      return {
        newPage,
        async close() {
          if (!ctxClosed) { ctxClosed = true; openContexts -= 1; }
        },
      };
    },
    newPage,
  };
}

function suite(n) {
  return Array.from({ length: n }, (_, i) => ({
    index: i, name: `check ${i}`, path: `/p${i}`, url: `http://staging/p${i}`,
  }));
}

// Redirect the frame sink into an array; the returned reader parses it.
function collect() {
  const chunks = [];
  setFrameSink((s) => chunks.push(s));
  return () => {
    const lines = chunks.join('').split('\n');
    const frames = [];
    let done = null;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith('__USERNODE_TESTS_DONE__ ')) {
        done = {};
        for (const m of lines[i].matchAll(/(\w+)=(\S+)/g)) done[m[1]] = m[2];
        continue;
      }
      if (!lines[i].startsWith('__USERNODE_TEST__ ')) continue;
      const attrs = {};
      for (const m of lines[i].matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
      const payload = JSON.parse(Buffer.from(lines[i + 1], 'base64').toString('utf8'));
      frames.push({ index: Number(attrs.index), status: attrs.status, ...payload });
    }
    return { frames, done };
  };
}

test('every declared check gets exactly one frame', async () => {
  const read = collect();
  const result = await runTests(makeBrowser(), suite(25), { concurrency: 6, testTimeoutMs: 5000 });
  const { frames, done } = read();
  assert.equal(frames.length, 25, 'one frame per check, no more and no fewer');
  assert.deepEqual(
    frames.map((f) => f.index).sort((a, b) => a - b),
    Array.from({ length: 25 }, (_, i) => i),
    'and the frames cover every dispatched index'
  );
  assert.equal(result.ran, 25);
  assert.equal(done.ran, '25');
  assert.equal(done.expected, '25');
  assert.equal(done.deadline, '0');
});

test('every group runs in its own browser context, and all of them close', async () => {
  // Isolation is the load-bearing property (see the header): a same-context
  // tab is a HIDDEN document — view transitions abort with a pageerror and
  // rAF-driven UI never presents — and a shared cookie jar races concurrent
  // ?token= exchanges. One context per group means one window and one jar
  // per group. Contexts must also all be closed, or a long suite leaks
  // renderer memory the pool's page bound was supposed to cap.
  const read = collect();
  const browser = makeBrowser();
  await runTests(browser, suite(12), { concurrency: 8, testTimeoutMs: 5000 });
  read();
  assert.equal(browser.contexts(), 12, 'one context per URL group');
  assert.equal(browser.openContexts(), 0, 'and every context was closed');
});

test('concurrency is bounded by the pool size', async () => {
  const read = collect();
  const delays = {};
  for (let i = 0; i < 20; i += 1) delays[`http://staging/p${i}`] = 25;
  const browser = makeBrowser({ delays });
  await runTests(browser, suite(20), { concurrency: 4, testTimeoutMs: 5000 });
  read();
  assert.ok(browser.peak() <= 4,
    `at most 4 pages should be open at once, saw ${browser.peak()}`);
  assert.ok(browser.peak() > 1, 'and it really did run in parallel, not sequentially');
});

test('a hung check fails on the per-check deadline instead of wedging a worker', async () => {
  const read = collect();
  const browser = makeBrowser({ delays: { 'http://staging/p1': 600 } });
  const started = Date.now();
  const result = await runTests(browser, suite(4), { concurrency: 2, testTimeoutMs: 120 });
  const elapsed = Date.now() - started;
  // Let the abandoned navigation land before reading, so its late frame is
  // attributed to this test instead of leaking into the next one — and so
  // the dedupe below is actually exercised.
  await sleep(700);
  const { frames } = read();
  assert.ok(elapsed < 500, `the suite must not wait out the hung check, took ${elapsed}ms`);
  const hung = frames.find((f) => f.index === 1);
  assert.equal(hung.status, 'fail');
  assert.match(hung.failureReason, /did not finish within/,
    'and the reason says so plainly rather than blaming the assertion');
  assert.equal(frames.length, 4, 'the other checks still report');
  assert.equal(result.ran, 4);
});

test('a straggler cannot overwrite the verdict already recorded for it', async () => {
  // The timeout frame is written while runTest is still in flight. When it
  // finally finishes it emits its own frame for the same index — first writer
  // must win, or the platform sees two contradictory verdicts for one check
  // and keeps whichever landed last.
  const read = collect();
  const browser = makeBrowser({ delays: { 'http://staging/p0': 250 } });
  await runTests(browser, suite(1), { concurrency: 1, testTimeoutMs: 40 });
  await sleep(400);
  const { frames } = read();
  assert.equal(frames.length, 1, 'exactly one frame for the timed-out check');
  assert.equal(frames[0].status, 'fail');
  assert.match(frames[0].failureReason, /did not finish within/);
});

test('the global deadline stops dispatch and says so in the sentinel', async () => {
  const read = collect();
  const delays = {};
  for (let i = 0; i < 40; i += 1) delays[`http://staging/p${i}`] = 40;
  const browser = makeBrowser({ delays });
  const result = await runTests(browser, suite(40), {
    concurrency: 2, testTimeoutMs: 5000, deadlineMs: 300,
  });
  const { frames, done } = read();
  assert.ok(result.deadline, 'the run reports that it ran out of budget');
  assert.equal(done.deadline, '1');
  assert.ok(frames.length < 40, 'not every check got dispatched');
  assert.equal(done.ran, String(frames.length),
    'and the sentinel reports the count it actually produced');
  assert.equal(done.expected, '40', 'against the count it was asked for');
});

test('an empty suite still emits the sentinel', async () => {
  const read = collect();
  const result = await runTests(makeBrowser(), [], {});
  const { done } = read();
  assert.equal(result.ran, 0);
  assert.equal(done.ran, '0');
  assert.equal(done.expected, '0');
  assert.equal(done.deadline, '0');
});

test('checks that load cleanly pass, through the pool', async () => {
  // The one case on the settling path, so the happy shape is covered and not
  // just the dispatch mechanics.
  const read = collect();
  const browser = makeBrowser({ mode: 'ok' });
  await runTests(browser, suite(2), { concurrency: 2, testTimeoutMs: 20000 });
  const { frames, done } = read();
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((f) => f.status), ['pass', 'pass']);
  assert.equal(done.ran, '2');
  assert.equal(done.deadline, '0');
});

// ── URL grouping: one navigation per route, one frame per check ─────────

test('checks on the same URL share one navigation but keep their own verdicts', async () => {
  // The manifest clusters heavily (this repo: 234 checks over ~106 routes,
  // 46 on the dev screen alone) and navigation + settle is where the wall
  // clock goes. Grouping must not blur what each check means: same page,
  // independent assertions, independent frames.
  const read = collect();
  const log = [];
  const browser = makeBrowser({ log, mode: 'ok', missingSelectors: ['#gone'] });
  const tests = [
    { index: 0, name: 'a', path: '/shared', url: 'http://staging/shared', expectSelector: '#here' },
    { index: 1, name: 'b', path: '/shared', url: 'http://staging/shared', expectSelector: '#gone' },
    { index: 2, name: 'c', path: '/shared', url: 'http://staging/shared', expectText: 'welcome' },
    { index: 3, name: 'd', path: '/other', url: 'http://staging/other' },
  ];
  const result = await runTests(browser, tests, { concurrency: 4, testTimeoutMs: 20000 });
  const { frames, done } = read();
  const gotos = log.filter((e) => e.call === 'goto');
  assert.equal(gotos.length, 2, 'two distinct URLs, two navigations — not four');
  assert.equal(frames.length, 4, 'but still one frame per check');
  const byIndex = new Map(frames.map((f) => [f.index, f]));
  assert.equal(byIndex.get(0).status, 'pass');
  assert.equal(byIndex.get(1).status, 'fail', 'the missing selector fails only its own check');
  assert.match(byIndex.get(1).failureReason, /#gone/);
  assert.equal(byIndex.get(2).status, 'pass');
  assert.equal(byIndex.get(3).status, 'pass');
  assert.equal(result.ran, 4, 'the sentinel counts checks, not navigations');
  assert.equal(done.ran, '4');
  assert.equal(done.expected, '4');
});

test('a failed navigation fails every check that shared the URL', async () => {
  const read = collect();
  const browser = makeBrowser({ mode: 'fast' }); // every goto rejects
  const tests = [
    { index: 0, name: 'a', path: '/p', url: 'http://staging/p' },
    { index: 1, name: 'b', path: '/p', url: 'http://staging/p', expectSelector: '#x' },
  ];
  await runTests(browser, tests, { concurrency: 2, testTimeoutMs: 5000 });
  const { frames } = read();
  assert.equal(frames.length, 2, 'both checks report');
  for (const f of frames) {
    assert.equal(f.status, 'fail');
    assert.match(f.failureReason, /Page failed to load/,
      'and the reason is the load, not a misattributed assertion');
  }
});

test('a hung group fails all its unreported checks on the scaled deadline', async () => {
  // The group deadline is testTimeoutMs + 1s per extra check (assertions
  // are cheap but not free). Two checks share the slow URL, so the budget
  // here is 120 + 1000 = 1120ms — the 2s hang must be cut off at that
  // deadline, and BOTH slow-URL checks must get a "did not finish" frame.
  const read = collect();
  const browser = makeBrowser({ delays: { 'http://staging/slow': 2000 } });
  const tests = [
    { index: 0, name: 'a', path: '/fast', url: 'http://staging/fast' },
    { index: 1, name: 'b', path: '/slow', url: 'http://staging/slow' },
    { index: 2, name: 'c', path: '/slow', url: 'http://staging/slow' },
  ];
  const started = Date.now();
  const result = await runTests(browser, tests, { concurrency: 2, testTimeoutMs: 120 });
  const elapsed = Date.now() - started;
  await sleep(2100); // let the abandoned navigation land before reading
  const { frames } = read();
  assert.ok(elapsed < 1600, `the suite must not wait out the hung group, took ${elapsed}ms`);
  assert.equal(frames.length, 3, 'every check still gets exactly one frame');
  for (const i of [1, 2]) {
    const f = frames.find((x) => x.index === i);
    assert.equal(f.status, 'fail');
    assert.match(f.failureReason, /did not finish within/);
  }
  assert.equal(result.ran, 3);
});

test('groupTestsByUrl preserves declaration order within and across groups', () => {
  const tests = [
    { index: 0, url: 'u1' }, { index: 1, url: 'u2' },
    { index: 2, url: 'u1' }, { index: 3, url: 'u3' },
  ];
  const groups = groupTestsByUrl(tests);
  assert.deepEqual(groups.map((g) => g.map((t) => t.index)), [[0, 2], [1], [3]],
    'first-appearance order across groups, declaration order within');
});

test('pool bounds come from env with sane defaults and a hard ceiling', () => {
  assert.equal(poolSize({}), 8, 'the default pool');
  assert.equal(poolSize({ TEST_CONCURRENCY: '3' }), 3);
  assert.equal(poolSize({ TEST_CONCURRENCY: '0' }), 8, 'zero is not a pool');
  assert.equal(poolSize({ TEST_CONCURRENCY: 'lots' }), 8, 'garbage falls back');
  assert.equal(poolSize({ TEST_CONCURRENCY: '500' }), 16,
    'a ceiling, because each page is ~50-80 MiB of renderer and an OOM-kill '
    + 'loses the whole run rather than one check');
  assert.equal(testTimeoutMs({}), 25000);
  assert.equal(testTimeoutMs({ TEST_TIMEOUT_MS: '900' }), 900);
  assert.equal(testTimeoutMs({ TEST_TIMEOUT_MS: '-1' }), 25000);
  assert.equal(testsDeadlineMs({}), 420000);
  assert.equal(testsDeadlineMs({ TESTS_DEADLINE_MS: '1000' }), 1000);
});

test('the suite deadline leaves headroom inside the container run timeout', () => {
  // The container is killed at RUN_TIMEOUT_MS. If the suite budget reached
  // that far the run would be killed mid-sentinel, and a budget-truncated
  // suite would be indistinguishable from a crash.
  const fs = require('node:fs');
  const path = require('node:path');
  const visualsSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8');
  const runTimeout = Number(/const RUN_TIMEOUT_MS = (\d+) \* 1000/.exec(visualsSrc)[1]) * 1000;
  assert.ok(testsDeadlineMs({}) < runTimeout,
    'the suite budget must expire before the container is killed');
  assert.ok(runTimeout - testsDeadlineMs({}) >= 120000,
    'and with enough room left for the media pass that runs before it');
});
