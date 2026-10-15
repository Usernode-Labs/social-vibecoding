// capture/capture.js: the checks-timing line each capture pod writes at the
// end of its run (group and cold-load wall times), and how the platform reads
// it (src/services/visuals.js parseDiagnostics). Exercised through runTests
// with a fake browser, as the other capture suites are.
//
// Run with: node --test tests/capture-checks-timing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { runTests, setFrameSink, timingSummary } = require('../capture/capture');
const { parseDiagnostics } = require('../src/services/visuals');

const ORIGIN = 'https://usernode-2d5619--s9001.onhomeroom.com';
const FAST = { settleQuietMs: 5, settleMaxMs: 50, assertMaxMs: 20, assertPollMs: 5 };

function collect() {
  const chunks = [];
  setFrameSink((s) => chunks.push(s));
  return () => chunks.join('');
}

function fakeBrowser() {
  let contexts = 0;
  const newPage = async () => ({
    on() {}, async setViewport() {}, async goto() { return { status: () => 200 }; },
    async waitForNetworkIdle() {}, async $() { return {}; }, async evaluate() { return true; }, async close() {},
  });
  return {
    contexts: () => contexts,
    async createBrowserContext() { contexts += 1; return { newPage, async close() {} }; },
    newPage,
  };
}

test('a run ends with one checks-timing line: its groups and their cold loads', async () => {
  const tests = Array.from({ length: 7 }, (_, i) => ({
    index: i, name: `c${i}`, path: `/p${i}`, url: `${ORIGIN}/p${i}?token=secret`,
  }));
  const read = collect();
  const browser = fakeBrowser();
  await runTests(browser, tests, { concurrency: 3, testTimeoutMs: 5000, ...FAST });
  const text = read();
  const timing = parseDiagnostics(text).filter((d) => d.kind === 'checks-timing');
  assert.equal(timing.length, 1);
  const d = timing[0].data;
  assert.deepEqual(Object.keys(d).sort(), ['groups', 'lanes', 'loads', 'retries', 'shard', 'wallMs']);
  assert.equal(d.groups.n, 7);
  assert.equal(d.loads.n, 7, 'every cold load timed');
  assert.equal(d.retries.n, 0);
  assert.equal(d.lanes, 3);
  assert.equal(d.shard, null);
  assert.ok(Number.isFinite(d.wallMs) && d.wallMs >= 0);
  assert.ok(d.loads.max <= d.groups.max, 'a cold load is part of its group');
  assert.equal(browser.contexts(), 7, 'still one fresh context per group');
  assert.ok(text.indexOf('__USERNODE_DIAG__ kind=checks-timing') < text.indexOf('__USERNODE_TESTS_DONE__'),
    'written before the sentinel');
  const raw = Buffer.from(text.match(/kind=checks-timing (\S+)/)[1], 'base64').toString();
  assert.ok(!/secret|onhomeroom/.test(raw), 'no URL, so no token, in the line');
});

test('a shard says which shard it was', async () => {
  const tests = Array.from({ length: 6 }, (_, i) => ({ index: i, name: `c${i}`, path: `/p${i}`, url: `${ORIGIN}/p${i}` }));
  const read = collect();
  await runTests(fakeBrowser(), tests, { concurrency: 2, testTimeoutMs: 5000, ...FAST, shard: { index: 1, count: 3 } });
  const d = parseDiagnostics(read()).find((x) => x.kind === 'checks-timing').data;
  assert.equal(d.shard, '1/3');
  assert.equal(d.groups.n, 2, 'its own share of the groups');
});

test('timing summaries', () => {
  assert.deepEqual(timingSummary([]), { n: 0, p50: 0, p90: 0, max: 0, mean: 0 });
  assert.deepEqual(timingSummary([100, 200, 300, 400, 1000]), { n: 5, p50: 300, p90: 1000, max: 1000, mean: 400 });
  assert.equal(timingSummary([1, NaN, 3]).n, 2);
});

test('the platform reads every shard\'s timing line without crowding out the other diagnostics', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
  const lines = [
    ...Array.from({ length: 9 }, (_, i) => `__USERNODE_DIAG__ kind=network-changed ${b64({ n: i })}`),
    ...Array.from({ length: 12 }, (_, i) => `__USERNODE_DIAG__ kind=checks-timing ${b64({ shard: `${i}/9` })}`),
  ];
  const out = parseDiagnostics(lines.join('\n'));
  assert.equal(out.filter((d) => d.kind === 'network-changed').length, 5, 'their cap is unchanged');
  assert.equal(out.filter((d) => d.kind === 'checks-timing').length, 9, 'eight shards and a sweep');
});

test('the platform logs the timing line as a reading, not a warning', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/visuals'), 'utf8');
  const settle = src.slice(src.indexOf('async function settleCaptureRun('));
  assert.match(settle, /if \(diag\.kind === 'checks-timing'\) \{\s*log\.info\('visuals', 'Checks timing', fields\);/);
});
