// Behavioural tests for the two per-check page-load settings the runner
// acts on (#6003): a `persona: 'guest'` check gets a browser of its own so
// it is really signed out, and a `repeat: N` check loads its page N times,
// each on a fresh context, passing only if every load passes.
//
// The runner is driven through its fake-browser seam (runTestGroup and
// runTests take their pages from whatever they are handed), so no Chromium
// is needed and the loads a check actually makes are countable.
//
// Run with: node --test tests/capture-persona-repeat.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveTests, groupTests, groupCost, runTests, setFrameSink,
} = require('../capture/capture');

// Fake browser: one context per createBrowserContext, one page per context,
// every goto counted, and a selector that can be missing on one chosen load
// or on every load of one URL (which is what a retry would see again).
function makeBrowser({ failOnLoad = 0, failUrls = [] } = {}) {
  let loads = 0;
  let contexts = 0;
  const pageFor = () => {
    let url = '';
    return {
      on() {},
      async setViewport() {},
      async goto(u) {
        url = u;
        loads += 1;
        return { status: () => 200 };
      },
      async waitForNetworkIdle() {},
      async $(sel) {
        if (failOnLoad && loads === failOnLoad) return null;
        if (failUrls.some((u) => url.includes(u))) return null;
        return {};
      },
      async evaluate() { return true; },
      async close() {},
    };
  };
  const newPage = async () => pageFor();
  return {
    loads: () => loads,
    contexts: () => contexts,
    async createBrowserContext() { contexts += 1; return { newPage, async close() {} }; },
    newPage,
  };
}

function collect() {
  const chunks = [];
  setFrameSink((s) => chunks.push(s));
  return () => {
    // A header line is followed by its base64 payload and the end line.
    const lines = chunks.join('').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].startsWith('__USERNODE_TEST__ ')) continue;
      const header = Object.fromEntries([...lines[i].matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
      const payload = JSON.parse(Buffer.from(lines[i + 1], 'base64').toString('utf8'));
      out.push({ ...payload, index: Number(header.index), status: header.status, loadStatus: Number(header.loadStatus) });
    }
    return { frames: out };
  };
}

// No settle and no waiting out a missing selector: these tests are about
// how many loads happen and where their verdict goes, not about the window.
const FAST = { settleQuietMs: 0, settleMaxMs: 0, assertMaxMs: 5, assertPollMs: 1 };

test('resolveTests carries persona and repeat only when valid, like coldLoad', () => {
  const list = resolveTests({
    TESTS: JSON.stringify([
      { index: 0, name: 'plain', url: 'http://s/' },
      { index: 1, name: 'guest', url: 'http://s/i', persona: 'guest', repeat: 5 },
      { index: 2, name: 'bad', url: 'http://s/x', persona: 'admin', repeat: 11 },
      { index: 3, name: 'one', url: 'http://s/y', repeat: 1 },
    ]),
  }, () => '');
  assert.equal('persona' in list[0], false);
  assert.equal('repeat' in list[0], false);
  assert.equal(list[1].persona, 'guest');
  assert.equal(list[1].repeat, 5);
  assert.equal('persona' in list[2], false, 'an unknown persona is the signed-in default');
  assert.equal('repeat' in list[2], false, 'a repeat past the cap is one load');
  assert.equal('repeat' in list[3], false, '1 is one load');
});

test('a guest or repeated check is a group of its own, never shared or switched to', () => {
  const shared = { index: 0, name: 'a', path: '/#x', url: 'http://s/#x' };
  const mate = { index: 1, name: 'b', path: '/#y', url: 'http://s/#y' };
  const guest = { index: 2, name: 'g', path: '/', url: 'http://s/' , persona: 'guest' };
  const sameUrlGuest = { index: 3, name: 'g2', path: '/#x', url: 'http://s/#x', persona: 'guest' };
  const repeat = { index: 4, name: 'r', path: '/#x', url: 'http://s/#x', repeat: 5 };
  const groups = groupTests([shared, mate, guest, sameUrlGuest, repeat], {});
  for (const lonely of [guest, sameUrlGuest, repeat]) {
    const own = groups.filter((g) => g.includes(lonely));
    assert.equal(own.length, 1);
    assert.deepEqual(own[0], [lonely], `${lonely.name} gets a load of its own`);
  }
  assert.deepEqual(groups.find((g) => g.includes(shared)), [shared, mate],
    'ordinary checks still share their document');
});

test('groupCost scales with repeat, so sharding and heaviest-first see the cost', () => {
  const plain = [{ index: 0, name: 'p', path: '/', url: 'http://s/' }];
  assert.equal(groupCost([{ ...plain[0], repeat: 5 }]), groupCost(plain) * 5);
  assert.equal(groupCost([{ ...plain[0], repeat: 1 }]), groupCost(plain));
});

test('a repeated check loads its page N times in fresh contexts and passes when all pass', async () => {
  const read = collect();
  const browser = makeBrowser();
  await runTests(browser, [
    { index: 0, name: 'invite', path: '/i', url: 'http://s/i', expectSelector: '#card', repeat: 5 },
  ], { concurrency: 1, env: {}, ...FAST });
  const { frames } = read();
  assert.equal(frames.length, 1, 'one frame whatever the number of loads');
  assert.equal(frames[0].status, 'pass');
  assert.equal(frames[0].failureReason, '');
  assert.equal(browser.loads(), 5, 'five loads');
  assert.equal(browser.contexts(), 5, 'each load its own fresh browser context');
});

test('a failed load is named, stops the check, and is never retried', async () => {
  const read = collect();
  const browser = makeBrowser({ failOnLoad: 3 });
  await runTests(browser, [
    { index: 0, name: 'ok', path: '/a', url: 'http://s/a', expectSelector: '#a' },
    { index: 1, name: 'ok2', path: '/b', url: 'http://s/b', expectSelector: '#b' },
    { index: 2, name: 'ok3', path: '/c', url: 'http://s/c', expectSelector: '#c' },
    { index: 3, name: 'ok4', path: '/d', url: 'http://s/d', expectSelector: '#d' },
    { index: 4, name: 'invite', path: '/i', url: 'http://s/i', expectSelector: '#card', repeat: 5 },
  ], { concurrency: 1, env: {}, ...FAST });
  const { frames } = read();
  const invite = frames.filter((f) => f.index === 4);
  assert.equal(invite.length, 1, 'one frame, written once the failure is known');
  assert.equal(invite[0].status, 'fail');
  assert.match(invite[0].failureReason, /^Attempt 3 of 5: /);
  assert.match(invite[0].failureReason, /Expected element "#card" was not found/);
  assert.equal(browser.loads(), 4 + 3, 'no load after the failed one');
  assert.equal(frames.filter((f) => f.index >= 1000000).length, 0,
    'a repeated check is never asked again: a retry could only hide the flake');
});

test('a single-load guest check is retried like any other check', async () => {
  const read = collect();
  const browser = makeBrowser({ failUrls: ['/guest-fail'] });
  await runTests(browser, [
    { index: 0, name: 'guest', path: '/g', url: 'http://s/guest-fail', expectSelector: '#x', persona: 'guest' },
    { index: 1, name: 'a', path: '/a', url: 'http://s/a' },
    { index: 2, name: 'b', path: '/b', url: 'http://s/b' },
    { index: 3, name: 'c', path: '/c', url: 'http://s/c' },
    { index: 4, name: 'd', path: '/d', url: 'http://s/d' },
  ], { concurrency: 1, env: {}, ...FAST });
  const { frames } = read();
  const primary = frames.find((f) => f.index === 0);
  assert.equal(primary.status, 'fail');
  assert.doesNotMatch(primary.failureReason, /Attempt \d+ of \d+/, 'no repeat wording on a one-load check');
  const retries = frames.filter((f) => f.index >= 1000000);
  assert.equal(retries.length, 3, 'the usual RETRY_RUNS second opinions');
  assert.ok(retries.every((f) => f.retryOf === 0));
});
