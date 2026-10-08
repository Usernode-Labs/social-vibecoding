// capture/capture.js and a network change under the checks browser.
//
// On 7 Oct 2026 six check runs in 22 minutes lost their first page loads to
// net::ERR_NETWORK_CHANGED within seconds of their pod starting: 19 to 86
// checks each, all cold loads failing at once. The retry pass covered ten;
// the rest stood as the change's failures. Two things follow, tested here
// against fake browsers (runTests and runTestGroup take their pages from
// whatever they are handed):
//
//   1. A group whose cold load meets a network change starts over once on a
//      fresh context, before it reports anything, and writes down what the
//      pod looked like (a __USERNODE_DIAG__ frame the platform logs).
//   2. The retry pass asks failed checks in batches of ten, and goes on to
//      the next batch while every check it asked passed on a retry.
//
// Run with: node --test tests/capture-network-changed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runTests, runTestGroup, setFrameSink, networkSnapshot, documentOf,
} = require('../capture/capture');
const { parseDiagnostics } = require('../src/services/visuals');

const NETWORK_CHANGED = 'net::ERR_NETWORK_CHANGED at https://usernode-2d5619--s6923.onhomeroom.com/?token=secret';

// Collect frames: test verdicts by index, and diagnostics.
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
    return { frames, diags: parseDiagnostics(text), text };
  };
}

// A page that fires the listeners the runner registers, and whose goto does
// whatever the test's `onGoto(attempt, page)` says: throw, or fire events and
// load. `attempt` counts gotos across every page this browser opened.
function makeBrowser(onGoto, { missing = () => false } = {}) {
  let attempts = 0;
  let contexts = 0;
  const newPage = async () => {
    const handlers = new Map();
    const page = {
      on(ev, fn) {
        if (!handlers.has(ev)) handlers.set(ev, []);
        handlers.get(ev).push(fn);
      },
      fire(ev, arg) { for (const fn of handlers.get(ev) || []) fn(arg); },
      async setViewport() {},
      async goto(url) {
        attempts += 1;
        page.url = url;
        page.attempt = attempts;
        await onGoto(attempts, page, url);
        return { status: () => 200 };
      },
      async waitForNetworkIdle() {},
      async $(sel) { return missing(sel, page) ? null : {}; },
      async evaluate() { return true; },
      async close() {},
    };
    return page;
  };
  return {
    attempts: () => attempts,
    contexts: () => contexts,
    async createBrowserContext() {
      contexts += 1;
      return { newPage, async close() {} };
    },
    newPage,
  };
}

const FAST = { settleQuietMs: 20, settleMaxMs: 200, assertMaxMs: 50, assertPollMs: 10, networkChangedRetryDelayMs: 0 };

const group = [
  { index: 0, name: 'Settings offers Log out', path: '/#settings', url: 'https://s.example/?token=t#settings' },
  { index: 1, name: 'Theme selector', path: '/#settings', url: 'https://s.example/?token=t#settings' },
];

test('a cold load cancelled by a network change starts over once, on a fresh context', async () => {
  const read = collect();
  const browser = makeBrowser(async (attempt) => {
    if (attempt === 1) throw new Error(NETWORK_CHANGED);
  });
  await runTestGroup(browser, group, FAST);
  const { frames, diags } = read();
  assert.equal(browser.attempts(), 2, 'one more navigation');
  assert.equal(browser.contexts(), 2, 'on a context of its own');
  assert.deepEqual(frames.map((f) => [f.index, f.status]), [[0, 'pass'], [1, 'pass']],
    'and the checks report once, on the second load');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, 'network-changed');
  assert.equal(diags[0].data.stage, 'navigation');
  assert.equal(diags[0].data.document, 'https://s.example/', 'the document, never its token');
  assert.ok(Number.isFinite(diags[0].data.uptimeMs), 'with how long the container had been up');
});

test('the second attempt\'s verdict stands, whatever it is', async () => {
  const read = collect();
  const browser = makeBrowser(async () => { throw new Error(NETWORK_CHANGED); });
  await runTestGroup(browser, group, FAST);
  const { frames, diags } = read();
  assert.equal(browser.attempts(), 2, 'one restart, not a loop');
  assert.equal(frames.length, 2);
  for (const f of frames) {
    assert.equal(f.status, 'fail');
    assert.match(f.failureReason, /^Page failed to load: net::ERR_NETWORK_CHANGED/);
  }
  assert.equal(diags.length, 1, 'the restart is what is written down');
});

test('a document whose own scripts were cancelled starts over too', async () => {
  const read = collect();
  const browser = makeBrowser(async (attempt, page) => {
    if (attempt !== 1) return;
    page.fire('requestfailed', {
      url: () => 'https://s.example/b/abc/usernode-native/v1/native.js',
      failure: () => ({ errorText: 'net::ERR_NETWORK_CHANGED' }),
    });
  });
  await runTestGroup(browser, group, FAST);
  const { frames, diags } = read();
  assert.equal(browser.attempts(), 2);
  assert.ok(frames.every((f) => f.status === 'pass'), 'judged on the clean second load');
  assert.ok(frames.every((f) => f.consoleErrors.length === 0), 'with none of the first load\'s errors');
  assert.equal(diags[0].data.stage, 'subresource');
});

test('the console line alone is enough to start over', async () => {
  const read = collect();
  const browser = makeBrowser(async (attempt, page) => {
    if (attempt !== 1) return;
    page.fire('console', {
      type: () => 'error',
      text: () => 'Failed to load resource: net::ERR_NETWORK_CHANGED',
      location: () => ({ url: 'https://s.example/vendor/purify-3.4.4.min.js' }),
    });
  });
  await runTestGroup(browser, group, FAST);
  const { frames } = read();
  assert.equal(browser.attempts(), 2);
  assert.ok(frames.every((f) => f.status === 'pass'));
});

test('any other failed load is reported as it always was', async () => {
  const read = collect();
  const browser = makeBrowser(async () => { throw new Error('net::ERR_CONNECTION_REFUSED at https://s.example/'); });
  await runTestGroup(browser, group, FAST);
  const { frames, diags } = read();
  assert.equal(browser.attempts(), 1, 'no restart');
  assert.ok(frames.every((f) => /ERR_CONNECTION_REFUSED/.test(f.failureReason)));
  assert.equal(diags.length, 0);

  const read2 = collect();
  const errorPage = makeBrowser(async (attempt, page) => {
    page.fire('console', { type: () => 'error', text: () => 'boot exploded', location: () => ({ url: 'app.js' }) });
  });
  await runTestGroup(errorPage, group, FAST);
  assert.equal(errorPage.attempts(), 1, 'an app\'s own console error is its verdict');
  assert.ok(read2().frames.every((f) => /1 console error/.test(f.failureReason)));
});

test('a run writes at most three diagnostics, however many groups start over', async () => {
  const read = collect();
  const seen = new Set();
  const browser = makeBrowser(async (attempt, page, url) => {
    if (!seen.has(url)) { seen.add(url); throw new Error(NETWORK_CHANGED); }
  });
  const tests = Array.from({ length: 6 }, (_, i) => ({
    index: i, name: `check ${i}`, path: `/p${i}`, url: `https://s.example/p${i}`,
  }));
  await runTests(browser, tests, { concurrency: 3, testTimeoutMs: 5000, ...FAST });
  const { frames, diags } = read();
  assert.equal(frames.filter((f) => f.retryOf == null).length, 6);
  assert.ok(frames.every((f) => f.status === 'pass'), 'every group started over and passed');
  assert.equal(diags.length, 3);
});

// ── The retry pass ───────────────────────────────────────────────────────

// A check is "flaky" for its first load and passes after; `broken` checks
// never pass. Each check is its own document, as the 7 Oct burst was.
function retryBrowser({ flaky, broken = new Set() }) {
  const loads = new Map();
  return makeBrowser(async (attempt, page, url) => {
    loads.set(url, (loads.get(url) || 0) + 1);
    page.loads = loads.get(url);
  }, {
    missing: (sel, page) => {
      const n = Number(sel.slice('#c'.length));
      if (broken.has(n)) return true;
      return flaky.has(n) && page.loads === 1;
    },
  });
}

function retrySuite(n) {
  return Array.from({ length: n }, (_, i) => ({
    index: i, name: `check ${i}`, path: `/p${i}`, url: `https://s.example/p${i}`, expectSelector: `#c${i}`,
  }));
}

test('#4186: a burst of 19 flaky checks is all asked again, ten at a time', async () => {
  const read = collect();
  const flaky = new Set(Array.from({ length: 19 }, (_, i) => i * 4));
  await runTests(retryBrowser({ flaky }), retrySuite(100), {
    concurrency: 8, testTimeoutMs: 5000, env: { ...process.env, TEST_RETRY_RUNS: '3' }, ...FAST,
  });
  const { frames } = read();
  const retried = new Set(frames.filter((f) => f.retryOf != null).map((f) => f.retryOf));
  assert.equal(retried.size, 19, 'not just the first ten');
  for (const n of flaky) {
    assert.ok(frames.some((f) => f.retryOf === n && f.status === 'pass'), `check ${n} recovered`);
  }
  const indices = frames.filter((f) => f.retryOf != null).map((f) => f.index);
  assert.equal(new Set(indices).size, indices.length, 'every retry frame has an index of its own');
});

test('a batch with a check that never passes stops the pass', async () => {
  const read = collect();
  const flaky = new Set(Array.from({ length: 18 }, (_, i) => (i + 1) * 4));
  await runTests(retryBrowser({ flaky, broken: new Set([0]) }), retrySuite(100), {
    concurrency: 8, testTimeoutMs: 5000, env: { ...process.env, TEST_RETRY_RUNS: '3' }, ...FAST,
  });
  const { frames } = read();
  const retried = new Set(frames.filter((f) => f.retryOf != null).map((f) => f.retryOf));
  assert.equal(retried.size, 10, 'the first ten only: that run is red whatever the rest would say');
  assert.ok(retried.has(0));
  assert.ok(frames.filter((f) => f.retryOf === 0).every((f) => f.status === 'fail'));
});

test('a mostly red suite is still the change, and nothing is asked again', async () => {
  const read = collect();
  const flaky = new Set(Array.from({ length: 30 }, (_, i) => i));
  await runTests(retryBrowser({ flaky }), retrySuite(100), {
    concurrency: 8, testTimeoutMs: 5000, env: { ...process.env, TEST_RETRY_RUNS: '3' }, ...FAST,
  });
  assert.equal(read().frames.filter((f) => f.retryOf != null).length, 0);
});

// ── What is written down, and how the platform reads it ─────────────────

test('the snapshot names the pod\'s network state, and never a token', () => {
  const snap = networkSnapshot();
  assert.deepEqual(Object.keys(snap).sort(),
    ['hostsChangedAt', 'ipv6Addresses', 'ipv6Disabled', 'operstate', 'resolvConfChangedAt', 'uptimeMs']);
  assert.ok(Array.isArray(snap.ipv6Addresses));
  assert.equal(documentOf('https://a.example/x/y?token=abc#settings'), 'https://a.example/x/y');
  assert.equal(documentOf('not a url'), '');
});

test('the platform reads diagnostics and skips anything malformed', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
  const out = parseDiagnostics([
    '__USERNODE_TEST__ index=0 status=pass loadStatus=200',
    `__USERNODE_DIAG__ kind=network-changed ${b64({ stage: 'navigation', uptimeMs: 2100 })}`,
    '__USERNODE_DIAG__ kind=network-changed !!!notbase64json',
    '__USERNODE_DIAG__ no kind here',
    ...Array.from({ length: 8 }, () => `__USERNODE_DIAG__ kind=network-changed ${b64({ stage: 'subresource' })}`),
  ].join('\n'));
  assert.deepEqual(out[0], { kind: 'network-changed', data: { stage: 'navigation', uptimeMs: 2100 } });
  assert.deepEqual(out[1], { kind: 'network-changed', data: {} }, 'a payload it cannot read still counts');
  assert.equal(out.length, 5, 'capped');
});

test('settlement logs each diagnostic for the session it ran for', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/visuals'), 'utf8');
  const settle = src.slice(src.indexOf('async function settleCaptureRun('));
  assert.match(settle, /for \(const diag of parseDiagnostics\(stdout\)\) \{\s*log\.warn\('visuals'/);
  assert.match(settle, /sessionId: session\.id, commitHash: commitHash \|\| null, kind: diag\.kind/);
});
