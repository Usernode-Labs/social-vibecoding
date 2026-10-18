// capture/capture.js: the checks browser's first loads wait for the pod's
// IPv6 address to settle.
//
// From 16 to 18 Oct 2026, 56 of 90 Homeroom runs started groups over (142
// times) because Chromium cancelled their cold loads with
// net::ERR_NETWORK_CHANGED a second or so into the pod. The cause is eth0's
// IPv6 link-local address: it is added tentative (flag 0x40 in
// /proc/net/if_inet6) when the pod's link comes up and the flag clears when
// duplicate address detection ends, 1.2 to 2.1 s later, which Chromium reads
// as an address change. The run now reads the addresses while Chromium
// launches and waits, bounded, for none to be tentative before its first
// load. Tested here with fake /proc text, sleeps and clocks: no real waits.
//
// Run with: node --test tests/capture-network-settle.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  tentativeInterfaces, waitForNetworkSettled, launchWhenSettled, NETWORK_SETTLE_MAX_MS,
  runTests, setFrameSink,
} = require('../capture/capture');
const { parseDiagnostics } = require('../src/services/visuals');

// Lines as a capture pod's /proc/net/if_inet6 has them (the permanent pair is
// from a production network-changed diag line, 17 Oct 2026).
const LO = '00000000000000000000000000000001 01 80 10 80       lo';
const ETH0_PERMANENT = 'fe8000000000000014de74fffe875896 2123 40 20 80     eth0';
const ETH0_TENTATIVE = 'fe8000000000000014de74fffe875896 2123 40 20 c0     eth0';
const ETH0_OPTIMISTIC = 'fe8000000000000014de74fffe875896 2123 40 20 44     eth0';
const ETH0_DAD_FAILED = 'fe8000000000000014de74fffe875896 2123 40 20 c8     eth0';
const procText = (...lines) => `${lines.join('\n')}\n`;

// A clock that only moves when the code under test sleeps.
function fakeTime() {
  let t = 1000;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

test('only an address still in detection counts as unsettled', () => {
  assert.deepEqual(tentativeInterfaces(procText(LO, ETH0_PERMANENT)), [], 'permanent (0x80) is settled');
  assert.deepEqual(tentativeInterfaces(procText(LO, ETH0_TENTATIVE)), ['eth0'], 'tentative (0xc0) is not');
  assert.deepEqual(tentativeInterfaces(procText(ETH0_OPTIMISTIC)), ['eth0'], 'optimistic is still tentative');
  assert.deepEqual(tentativeInterfaces(procText(ETH0_DAD_FAILED)), [],
    'a failed detection stays tentative for good, so it is never waited on');
  assert.deepEqual(tentativeInterfaces(procText(ETH0_TENTATIVE, ETH0_TENTATIVE.replace('fe80', 'fd00'))), ['eth0'],
    'one name per interface');
  assert.deepEqual(tentativeInterfaces(''), []);
  assert.deepEqual(tentativeInterfaces(null), [], 'no IPv6 at all: nothing to wait for');
  assert.deepEqual(tentativeInterfaces('garbage\n1 2 3\n'), []);
});

test('a settled pod waits for nothing: one read, no sleep', async () => {
  const time = fakeTime();
  let reads = 0;
  const out = await waitForNetworkSettled({
    read: () => { reads += 1; return procText(LO, ETH0_PERMANENT); }, sleep: time.sleep, now: time.now,
  });
  assert.deepEqual(out, { waitedMs: 0, tentative: [], timedOut: false });
  assert.equal(reads, 1);
  assert.deepEqual(time.sleeps, [], 'no time added to a run that does not need it');
});

test('a tentative address is waited out, then a short grace for the browser to hear it', async () => {
  const time = fakeTime();
  let reads = 0;
  const out = await waitForNetworkSettled({
    read: () => { reads += 1; return procText(LO, reads <= 4 ? ETH0_TENTATIVE : ETH0_PERMANENT); },
    sleep: time.sleep, now: time.now, pollMs: 50, graceMs: 150, maxMs: 3000,
  });
  assert.equal(reads, 5, 'polled until the flag cleared, and no further');
  assert.deepEqual(time.sleeps, [50, 50, 50, 50, 150]);
  assert.deepEqual(out, { waitedMs: 350, tentative: ['eth0'], timedOut: false });
});

test('the wait is bounded: an address that never settles gives up at the cap', async () => {
  const time = fakeTime();
  const out = await waitForNetworkSettled({
    read: () => procText(ETH0_TENTATIVE), sleep: time.sleep, now: time.now,
  });
  assert.equal(out.timedOut, true);
  assert.equal(out.waitedMs, NETWORK_SETTLE_MAX_MS);
  assert.ok(NETWORK_SETTLE_MAX_MS <= 3000, 'a few seconds at most');
  assert.ok(!time.sleeps.includes(150), 'no grace after giving up');
});

test('an unreadable /proc never holds the run up or throws', async () => {
  const time = fakeTime();
  const out = await waitForNetworkSettled({
    read: () => { throw new Error('EACCES'); }, sleep: time.sleep, now: time.now,
  });
  assert.deepEqual(out, { waitedMs: 0, tentative: [], timedOut: false });
  assert.deepEqual(time.sleeps, []);
});

test('the wait runs alongside the launch, and the browser is handed over only after both', async () => {
  const order = [];
  let releaseSettle;
  const settle = () => {
    order.push('settle started');
    return new Promise((resolve) => { releaseSettle = () => { order.push('settled'); resolve({ waitedMs: 900 }); }; });
  };
  const launch = async () => { order.push('launch started'); return { fake: 'browser' }; };
  const pending = launchWhenSettled(launch, settle);
  let handedOver = false;
  pending.then(() => { handedOver = true; });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['settle started', 'launch started'],
    'the launch does not wait for the network: the two overlap');
  assert.equal(handedOver, false, 'no browser, so no page load, while the address is still tentative');
  releaseSettle();
  const out = await pending;
  assert.deepEqual(out, { browser: { fake: 'browser' }, networkSettle: { waitedMs: 900 } });
});

test('main() launches through the wait and loads nothing before it', () => {
  // main() is Chromium-bound, so its shape is pinned at the source.
  const src = fs.readFileSync(path.join(__dirname, '..', 'capture/capture.js'), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  const launchAt = main.indexOf('await launchWhenSettled(() => puppeteer.launch(');
  assert.ok(launchAt > 0, 'the browser comes from launchWhenSettled');
  assert.equal((main.match(/puppeteer\.launch\(/g) || []).length, 1, 'and from nowhere else');
  assert.ok(main.indexOf('captureTarget(') > launchAt && main.indexOf('runTests(') > launchAt,
    'the shots and the suite start after it');
  assert.match(main, /env: process\.env,\s*networkSettle,/, 'and the suite reports what it cost');
});

test('the checks-timing line says what the wait cost each pod', async () => {
  const chunks = [];
  setFrameSink((s) => chunks.push(s));
  const page = {
    on() {}, async setViewport() {}, async goto() { return { status: () => 200 }; },
    async waitForNetworkIdle() {}, async $() { return {}; }, async evaluate() { return true; }, async close() {},
  };
  const browser = { async createBrowserContext() { return { newPage: async () => page, async close() {} }; } };
  const tests = [{ index: 0, name: 'c0', path: '/', url: 'https://x.example/' }];
  const fast = { settleQuietMs: 5, settleMaxMs: 50, assertMaxMs: 20, assertPollMs: 5 };
  const reading = { waitedMs: 640, tentative: ['eth0'], timedOut: false };
  await runTests(browser, tests, { concurrency: 1, testTimeoutMs: 5000, ...fast, networkSettle: reading });
  const timing = parseDiagnostics(chunks.join('')).find((d) => d.kind === 'checks-timing');
  assert.deepEqual(timing.data.networkSettle, reading);
  chunks.length = 0;
  await runTests(browser, tests, { concurrency: 1, testTimeoutMs: 5000, ...fast });
  assert.equal(parseDiagnostics(chunks.join('')).find((d) => d.kind === 'checks-timing').data.networkSettle, null);
});
