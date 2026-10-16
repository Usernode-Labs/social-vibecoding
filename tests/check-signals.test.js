'use strict';

// What a checks run says about itself beside its verdict
// (src/services/check-signals.js): why each retried check was retried
// (the run's fault, a flaky check, a real failure), and which checks held
// only on a fresh load after their address change (the cohort fallback).
// Both are advisory: nothing here may move a verdict.
//
// Run with: node --test tests/check-signals.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { runTestGroup, runTests, setFrameSink } = require('../capture/capture');
const visuals = require('../src/services/visuals');
const signals = require('../src/services/check-signals');
const appManifest = require('../src/services/app-manifest');
const { message, englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function collect() {
  const chunks = [];
  setFrameSink((s) => chunks.push(s));
  return () => {
    const text = chunks.join('');
    return { text, frames: visuals.parseTests(text) };
  };
}

/** One __USERNODE_TEST__ frame, as the container writes it. */
function frame(index, status, payload = {}) {
  const json = Buffer.from(JSON.stringify({ name: `check ${index}`, path: '/', ...payload }), 'utf8')
    .toString('base64');
  return `__USERNODE_TEST__ index=${index} status=${status} loadStatus=200\n${json}\n__USERNODE_TEST_END__`;
}

// A page whose screens are drawn only by a load of their address: a hash
// switch draws nothing, so every cohort after the first falls back.
function coldOnlyPage() {
  const page = {
    gotos: [], loaded: '',
    on() {}, async setViewport() {}, async waitForNetworkIdle() {}, async close() {},
    async goto(u) {
      page.gotos.push(u);
      const i = String(u).indexOf('#');
      page.loaded = i === -1 ? '' : String(u).slice(i);
      return { status: () => 200 };
    },
    async $(sel) { return sel === `#at-${page.loaded}` ? {} : null; },
    async evaluate() { return true; },
  };
  return page;
}
const FAST = { settleQuietMs: 5, settleMaxMs: 20, assertMaxMs: 40, assertPollMs: 5 };

// ── The runner ─────────────────────────────────────────────────────────

test('a check that held only on a fresh load says so in its own frame, and only that check', async () => {
  const done = collect();
  const page = coldOnlyPage();
  const group = [
    { index: 0, name: 'a', path: '/d#/a', url: 'http://s/d?token=t#/a', expectSelector: '#at-#/a' },
    // Same cohort: one check that held after the switch, one that did not.
    { index: 1, name: 'b1', path: '/d#/b', url: 'http://s/d?token=t#/b', expectSelector: '' },
    { index: 2, name: 'b2', path: '/d#/b', url: 'http://s/d?token=t#/b', expectSelector: '#at-#/b' },
    // A check that fails on the reload too is a failure, not a navigation gap.
    { index: 3, name: 'c', path: '/d#/c', url: 'http://s/d?token=t#/c', expectSelector: '#never' },
  ];
  await runTestGroup({ newPage: async () => page }, group, FAST);
  const by = new Map(done().frames.map((f) => [f.index, f]));
  assert.deepEqual([0, 1, 2, 3].map((i) => by.get(i).status), ['pass', 'pass', 'pass', 'fail']);
  assert.equal(by.get(0).cohortFallback, undefined, 'the cold-loaded first cohort never falls back');
  assert.equal(by.get(1).cohortFallback, undefined, 'it held on the switch');
  assert.equal(by.get(3).cohortFallback, undefined, 'it failed either way');
  const fb = by.get(2).cohortFallback;
  assert.ok(fb, 'the check the reload changed is marked');
  assert.ok(fb.waitMs >= 40, `it waited out the assertion window first (${JSON.stringify(fb)})`);
  assert.ok(fb.ms >= fb.waitMs);
});

test('a primary frame carries when its group started and which pod ran it; a retry names its primary instead', async () => {
  const done = collect();
  let loadsOfOne = 0;
  const browser = {
    async createBrowserContext() {
      return {
        async newPage() {
          let load = 0;
          return {
            on() {}, async setViewport() {}, async waitForNetworkIdle() {}, async close() {},
            async goto(u) {
              if (String(u).endsWith('/o')) { loadsOfOne += 1; load = loadsOfOne; }
              return { status: () => 200 };
            },
            // Check 1 fails on its first load and passes on every later one.
            async $(sel) { return sel === '#one' && load === 1 ? null : {}; },
            async evaluate() { return true; },
          };
        },
        async close() {},
      };
    },
  };
  // Five passing checks beside it, so one failure is not a quarter of the
  // suite (which skips the retries).
  const tests = [0, 1, 2, 3, 4, 5].map((i) => (i === 1
    ? { index: 1, name: 'one', path: '/o', url: 'http://s/o', expectSelector: '#one' }
    : { index: i, name: `c${i}`, path: `/p${i}`, url: `http://s/p${i}`, expectSelector: `#p${i}` }));
  await runTests(browser, tests, { concurrency: 2, testTimeoutMs: 5000, ...FAST, shard: { index: 0, count: 1 }, env: {} });
  const { frames, text } = done();
  const primaries = frames.filter((f) => f.retryOf == null);
  const retries = frames.filter((f) => f.retryOf != null);
  assert.equal(primaries.length, 6);
  for (const f of primaries) {
    assert.ok(Number.isFinite(f.startedMs) && f.startedMs >= 0 && f.startedMs < 1000, JSON.stringify(f));
    assert.equal(f.pod, '0/1');
  }
  assert.ok(Math.max(...primaries.map((f) => f.startedMs)) > 0, 'a later group starts later on its lane');
  assert.equal(retries.length, 3);
  for (const f of retries) {
    assert.equal(f.retryOf, 1);
    assert.equal(f.startedMs, undefined);
    assert.equal(f.pod, undefined);
  }
  const timing = visuals.parseDiagnostics(text).find((d) => d.kind === 'checks-timing').data;
  assert.deepEqual(Object.keys(timing).sort(), ['fallbacks', 'groups', 'lanes', 'loads', 'retries', 'shard', 'wallMs'],
    'the per-pod timing line is unchanged: no check, no URL');
});

// ── The rule ───────────────────────────────────────────────────────────

function primary(index, status, startedMs, pod = '0/3') {
  return { index, status, startedMs, pod, retryOf: null };
}
function retries(of, statuses, base = 1000000 + of * 10) {
  return statuses.map((s, i) => ({ index: base + i, status: s, retryOf: of }));
}

test('a burst of early failures whose retries all pass is the run\'s fault', () => {
  const frames = [
    primary(1, 'fail', 0), primary(2, 'fail', 0), primary(3, 'fail', 4200), primary(4, 'pass', 0),
    ...retries(1, ['pass', 'pass', 'pass']), ...retries(2, ['pass', 'pass', 'pass']), ...retries(3, ['pass', 'pass', 'pass']),
  ];
  const { byIndex, bursts } = signals.classifyRetries(frames);
  assert.deepEqual([...byIndex].sort(), [[1, 'run_fault'], [2, 'run_fault'], [3, 'run_fault']]);
  assert.deepEqual(bursts, [{ pod: '0/3', checks: 3, lastStartedMs: 4200 }]);
});

test('the run-fault rule\'s edges: too few, too late, a failing retry, another pod', () => {
  const allPass = ['pass', 'pass', 'pass'];
  // Two early failures are two flaky checks: a burst needs three.
  let out = signals.classifyRetries([
    primary(1, 'fail', 0), primary(2, 'fail', 0), ...retries(1, allPass), ...retries(2, allPass),
  ]);
  assert.deepEqual([...out.byIndex.values()], ['flaky', 'flaky']);
  assert.equal(out.bursts.length, 0);
  // Started after the window: flaky, however many.
  out = signals.classifyRetries([1, 2, 3].flatMap((i) => [primary(i, 'fail', signals.RUN_FAULT_WINDOW_MS + 1), ...retries(i, allPass)]));
  assert.deepEqual([...out.byIndex.values()], ['flaky', 'flaky', 'flaky']);
  // One retry failed: that check is flaky, and without it there is no burst.
  out = signals.classifyRetries([
    primary(1, 'fail', 0), primary(2, 'fail', 0), primary(3, 'fail', 0),
    ...retries(1, allPass), ...retries(2, allPass), ...retries(3, ['fail', 'pass', 'pass']),
  ]);
  assert.deepEqual([...out.byIndex].sort(), [[1, 'flaky'], [2, 'flaky'], [3, 'flaky']]);
  // Split across pods: each pod's clock is its own.
  out = signals.classifyRetries([
    primary(1, 'fail', 0, '0/3'), primary(2, 'fail', 0, '1/3'), primary(3, 'fail', 0, '2/3'),
    ...retries(1, allPass), ...retries(2, allPass), ...retries(3, allPass),
  ]);
  assert.equal(out.bursts.length, 0);
  // Every retry failing is a real failure, early or not.
  out = signals.classifyRetries([1, 2, 3].flatMap((i) => [primary(i, 'fail', 0), ...retries(i, ['fail', 'fail', 'fail'])]));
  assert.deepEqual([...out.byIndex.values()], ['failed', 'failed', 'failed']);
  // A frame from an image without the stamp is never a run fault.
  out = signals.classifyRetries([1, 2, 3].flatMap((i) => [{ index: i, status: 'fail', retryOf: null }, ...retries(i, allPass)]));
  assert.deepEqual([...out.byIndex.values()], ['flaky', 'flaky', 'flaky']);
});

// The capture runs of 16 Oct 2026, replayed through the platform's parser
// and the rule (tests/fixtures/check-retries-2026-10-16.json).
test('16 Oct 2026: the runs\' retried checks classify as they happened', () => {
  const fixture = JSON.parse(read('tests/fixtures/check-retries-2026-10-16.json'));
  const got = {};
  for (const [run, rows] of Object.entries(fixture)) {
    if (run.startsWith('_')) continue;
    const stdout = rows.map(([index, status, retryOf, startedMs, pod]) => frame(index, status,
      retryOf != null ? { retryOf } : { startedMs, pod })).join('\n');
    const { byIndex, bursts } = signals.classifyRetries(visuals.parseTests(stdout));
    got[run] = { ...signals.retryCounts(byIndex), bursts: bursts.length };
  }
  const want = (run_fault, flaky, failed, bursts) => ({ run_fault, flaky, failed, bursts });
  assert.deepEqual(got, {
    '6706 b4cf1a25': want(0, 0, 1, 0), // #222 fails every retry: a real failure
    '6706 a5d27922': want(13, 0, 1, 1), // the same #222, beside a burst of 13
    '8695 425c83d0': want(8, 0, 0, 1),
    '8703 10ad8a98': want(17, 0, 0, 1),
    '8710 6ed8d7f8': want(10, 0, 0, 1),
    '8717 222950f7': want(17, 0, 0, 1),
    '8717 959939b7': want(17, 0, 0, 1),
    '8732 1ba93080': want(0, 2, 0, 0), // the recurring flaky pair, 29 and 30
    '8678 d8cc4f2c': want(19, 0, 0, 1), // commit 21f4cbf3, 12:28
    '8678 b719d3c2': want(0, 0, 2, 0), // commit 21f4cbf3, 13:01: new checks that really fail
    '8678 3576b6a1': want(0, 2, 0, 0), // retries whose primaries the log extract lost
    '8747 1795b0b3': want(14, 0, 0, 1),
    '8748 0e16ab96': want(0, 0, 6, 0),
    '8753 05b28946': want(0, 2, 0, 0),
  });
});

// ── The platform: rows, the advisory boundary, the log ────────────────────

const dispatch = (n) => Array.from({ length: n }, (_, i) => ({
  index: i, checkKey: `k${i}`, name: `check ${i}`, path: '/', graduated: true,
}));

test('the rows carry the class and the fallback, and the verdict is the one it was without them', () => {
  const burst = [0, 1, 2].flatMap((i) => [
    frame(i, 'fail', { startedMs: 10, pod: '2/3', failureReason: 'not found' }),
    ...[0, 1, 2].map((k) => frame(1000000 + i * 3 + k, 'pass', { retryOf: i })),
  ]);
  const stdout = [
    ...burst,
    frame(3, 'pass', { startedMs: 9000, pod: '2/3', cohortFallback: { waitMs: 12345.6, ms: 17000 } }),
    frame(4, 'fail', { startedMs: 9000, pod: '2/3', failureReason: 'gone' }),
    ...[0, 1, 2].map((k) => frame(1000100 + k, 'fail', { retryOf: 4 })),
  ].join('\n');
  const out = visuals.classifyTests(visuals.parseTests(stdout), 5, { dispatched: dispatch(5) });
  const row = (i) => out.results.find((r) => r.index === i);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => row(i).retryClass || null), ['run_fault', 'run_fault', 'run_fault', null, 'failed']);
  assert.deepEqual(row(3).cohortFallback, { waitMs: 12346, ms: 17000 });
  assert.equal(out.state, 'failing');
  // The same frames with neither signal in them: the same verdict, row by row.
  const strip = stdout.split('\n').map((l) => {
    if (l.startsWith('__') || !l) return l;
    const p = JSON.parse(Buffer.from(l, 'base64').toString('utf8'));
    delete p.startedMs; delete p.pod; delete p.cohortFallback;
    return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
  }).join('\n');
  const plain = visuals.classifyTests(visuals.parseTests(strip), 5, { dispatched: dispatch(5) });
  assert.equal(plain.state, out.state);
  assert.deepEqual(plain.results.map((r) => [r.status, r.advisory, r.passedOnRetry]),
    out.results.map((r) => [r.status, r.advisory, r.passedOnRetry]));
});

test('a check this proposal adds or changes is the one the fallback note is for', () => {
  const head = { ok: true, tests: [
    { name: 'same', path: '/a', expectSelector: '#a' },
    { name: 'changed', path: '/b', expectSelector: '#b2' },
    { name: 'new', path: '/c', expectText: 'C' },
    { name: 'knob', path: '/d', expectSelector: '#d', coldLoad: true },
  ] };
  const base = { ok: true, tests: [
    { name: 'same', path: '/a', expectSelector: '#a' },
    { name: 'changed', path: '/b', expectSelector: '#b' },
    { name: 'knob', path: '/d', expectSelector: '#d' },
  ] };
  const authored = signals.authoredChecks(head, base);
  const key = (n, p) => appManifest.checkKey(n, p);
  assert.deepEqual([...authored].sort(), [key('changed', '/b'), key('new', '/c')].sort(),
    'a readiness knob is not a change to what the check asserts');
  assert.equal(signals.authoredChecks(head, { ok: false }), null, 'an unread base claims nothing');
  const rows = [
    { name: 'same', path: '/a', cohortFallback: { waitMs: 1, ms: 2 } },
    { name: 'new', path: '/c', cohortFallback: { waitMs: 1, ms: 2 } },
    { name: 'changed', path: '/b' },
  ];
  assert.equal(signals.markAuthored(rows, authored), 1);
  assert.deepEqual(rows.map((r) => r.authored === true), [false, true, false]);
});

test('a run-fault burst is logged as a warning of its own, with no names or URLs', async () => {
  const log = require('../src/services/logger');
  const calls = [];
  const orig = { info: log.info, warn: log.warn };
  log.info = (...a) => calls.push(['info', ...a]);
  log.warn = (...a) => calls.push(['warn', ...a]);
  try {
    const frames = visuals.parseTests([0, 1, 2].flatMap((i) => [
      frame(i, 'fail', { startedMs: 5, pod: '1/3', path: '/secret?token=x' }),
      frame(1000000 + i, 'pass', { retryOf: i }),
    ]).join('\n'));
    await visuals.noteCheckSignals({ results: [] }, frames, { sessionId: 7, commitHash: 'abc' });
  } finally { Object.assign(log, orig); }
  const warn = calls.find((c) => c[0] === 'warn' && c[2] === 'Checks run fault');
  assert.ok(warn, JSON.stringify(calls));
  assert.deepEqual(warn[3], { sessionId: 7, commitHash: 'abc', pod: '1/3', checks: 3, lastStartedMs: 5, windowMs: 5000 });
  const counts = calls.find((c) => c[2] === 'Checks retries');
  assert.deepEqual(counts[3], { sessionId: 7, commitHash: 'abc', run_fault: 3, flaky: 0, failed: 0 });
  assert.ok(!/secret|token/.test(JSON.stringify(calls)));
});

// ── Where it shows ─────────────────────────────────────────────────────

function loadAppView() {
  const sandbox = {
    console, relTime: () => 'just now', App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' }, DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null, querySelector: () => ({ innerHTML: '' }),
      querySelectorAll: () => ({ forEach() {} }), addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} }, hidden: false,
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    location: { search: '', hash: '' }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(
    `${read('public/js/merge-status.js')}\n${read('public/js/session-transcript.js')}\n`
    + `${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox.__AppView;
}

test('the card: a run fault is not called flaky, and the fallback note shows on an authored check only', () => {
  const AppView = loadAppView();
  const v = AppView._checksVerdictView({
    check_state: 'passing',
    test_results: [
      { name: 'Run fault', path: '/a', status: 'pass', runs: 4, passes: 3, fails: 1, passedOnRetry: true, retryClass: 'run_fault' },
      { name: 'Flaky', path: '/b', status: 'pass', runs: 4, passes: 2, fails: 2, passedOnRetry: true, retryClass: 'flaky' },
      { name: 'Fresh', path: '/c', status: 'pass', cohortFallback: { waitMs: 1, ms: 2 }, authored: true },
      { name: 'Not theirs', path: '/d', status: 'pass', cohortFallback: { waitMs: 1, ms: 2 } },
    ],
  });
  const by = new Map(v.passes.map((r) => [r.name, r]));
  assert.equal(by.get('Run fault').reason, message('changes:checks.reason.runFault'));
  assert.equal(by.get('Run fault').retryClass, 'run_fault');
  assert.match(by.get('Flaky').reason, /then passed when re-run/);
  assert.equal(by.get('Flaky').retryClass, null);
  assert.equal(by.get('Fresh').note, message('changes:checks.note.freshLoad'));
  assert.equal(by.get('Fresh').keepReason, true, 'a green row opens for its note');
  assert.equal(by.get('Not theirs').note, null);
  assert.equal(by.get('Not theirs').keepReason, false);
  assert.match(message('changes:checks.note.freshLoad'), /fix the navigation/);
  assert.match(message('changes:checks.reason.runFault'), /the run was at fault/);
  const tsx = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.match(tsx, /r\.retryClass === 'run_fault'\) return t\('project:topic\.check\.runFault'\)/);
  assert.match(tsx, /\{r\.note \? <div className="dev-ledger-why-note mt-1">\{r\.note\}<\/div> : null\}/);
  assert.deepEqual([message('project:topic.check.runFault'), message('project:topic.check.freshLoad')],
    ['Run fault', 'Needed a fresh load']);
});

test('agents read the same advisories: get_proposal, get_check_output and proposal_status', () => {
  const rows = [
    { name: 'a', path: '/a', status: 'pass', retryClass: 'run_fault' },
    { name: 'b', path: '/b', status: 'fail', retryClass: 'failed' },
    { name: 'c', path: '/c', status: 'pass', cohortFallback: { waitMs: 900, ms: 1200 }, authored: true },
    { name: 'd', path: '/d', status: 'pass', cohortFallback: { waitMs: 900, ms: 1200 } },
    { name: 'e', path: '/e', status: 'pass' },
  ];
  const out = signals.advisoriesOf(rows);
  assert.deepEqual(out.map((a) => [a.row.name, a.kind, a.waitMs ?? null]),
    [['a', 'run_fault', null], ['b', 'failed', null], ['c', 'cohort_fallback', 900]]);
  assert.equal(out[2].note, signals.COHORT_FALLBACK_NOTE);
  assert.match(signals.RETRY_CLASS_NOTES.run_fault, /the run was at fault, not this check or this change/);
  const mcp = read('src/services/mcp-tools.js');
  assert.match(mcp, /advisories: shapeCheckAdvisories\(results\),/);
  assert.match(mcp, /advisories: shapeCheckAdvisories\(\[row\]\),/);
  assert.match(read('src/routes/proposal-handoff.js'), /advisories: require\('\.\.\/services\/check-signals'\)\.advisoriesOf\(session\.test_results\)/);
});

test('the Checks step names the passes with something to say, from a full row or a list row', () => {
  const AppView = loadAppView();
  const lists = require('../src/services/list-test-results');
  const full = {
    id: 5, check_state: 'failing',
    test_results: [
      { name: 'Broken', path: '/x', status: 'fail', failureReason: 'gone' },
      { name: 'Run fault', path: '/a', status: 'pass', runs: 4, passes: 3, fails: 1, passedOnRetry: true, retryClass: 'run_fault' },
      { name: 'Fresh', path: '/c', status: 'pass', cohortFallback: { waitMs: 1, ms: 2 }, authored: true },
      { name: 'Plain', path: '/d', status: 'pass' },
      { name: 'Not theirs', path: '/e', status: 'pass', cohortFallback: { waitMs: 1, ms: 2 } },
    ],
  };
  const trimmed = lists.failingResultsOnly(full);
  assert.equal(trimmed.test_results_omitted, 4, 'the count of passes is still the whole count');
  assert.deepEqual(trimmed.test_results.map((r) => r.name), ['Broken']);
  assert.deepEqual(trimmed.test_results_noted.map((r) => r.name), ['Run fault', 'Fresh']);
  assert.equal('test_results_noted' in lists.failingResultsOnly({ test_results: [{ status: 'pass' }, { status: 'fail' }] }), false);
  for (const pr of [full, trimmed]) {
    const v = AppView._checksVerdictView(pr);
    assert.deepEqual(v.noted.map((r) => r.name), ['Run fault', 'Fresh']);
    assert.equal(v.passCount, 4);
    const run = AppView._checksRunView(pr, { state: 'blocked' });
    assert.deepEqual(run.noted.map((r) => r.name), ['Run fault', 'Fresh']);
  }
  const tsx = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.match(tsx, /<ul className="dev-ledger-fails dev-ledger-noted">\s*\{run\.noted\.map\(\(f\) => <CheckRowView key=\{f\.key\} r=\{f\} \/>\)\}/);
});
