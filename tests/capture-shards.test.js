'use strict';

// capture/capture.js — one run's checks split across several browser pods.
//
// On 10 Oct 2026 a 733-check run took 126s in one browser pod that sat at
// 7.9 of its 8 CPUs, throttled most of the time, while the preview it was
// testing idled under one CPU. The platform now starts several pods for a
// run (services/visuals.js runCaptureShards); each gets the whole list and
// TEST_SHARD_INDEX / TEST_SHARD_COUNT and runs only its share. Pinned here:
//
//   * the shares are a partition: every page group in exactly one shard,
//     the same in every pod, and about equal in cost;
//   * a pool takes its heaviest groups first;
//   * each shard counts and names its own checks in its done line, and its
//     retries come from a base of its own;
//   * the checks render at TEST_DEVICE_SCALE_FACTOR, the shots at theirs.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runTests, groupTests, setFrameSink, testShard, groupCost, heaviestFirst, shardGroups,
  resolveTestViewport, RETRY_INDEX_BASE, RETRY_SHARD_STRIDE,
} = require('../capture/capture');

// The fake browser of tests/capture-pool.test.js, reduced: every navigation
// answers, and a check whose selector is listed in `missing` fails.
function makeBrowser({ missing = [], log = [] } = {}) {
  const newPage = async () => ({
    on() {},
    async setViewport(v) { log.push({ call: 'viewport', v }); },
    async goto(url) { log.push({ call: 'goto', url }); return { status: () => 200 }; },
    async waitForNetworkIdle() {},
    async $(sel) { return missing.includes(sel) ? null : {}; },
    async evaluate() { return true; },
    async close() {},
  });
  return { async createBrowserContext() { return { newPage, async close() {} }; }, newPage };
}

function collect() {
  const chunks = [];
  setFrameSink((s) => chunks.push(s));
  return () => {
    const lines = chunks.join('').split('\n');
    const frames = [];
    const done = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith('__USERNODE_TESTS_DONE__ ')) {
        const d = {};
        for (const m of lines[i].matchAll(/(\w+)=(\S+)/g)) d[m[1]] = m[2];
        done.push(d);
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

// A suite shaped like the platform's: a few documents carrying many hash
// routes (the shell's own screens), and many documents with one check each.
function platformLikeSuite() {
  const tests = [];
  const add = (url, extra = {}) => tests.push({ index: tests.length, name: `check ${tests.length}`, path: url, url, ...extra });
  for (let i = 0; i < 40; i += 1) add(`http://staging/?demo=1#screen${i % 13}`);
  for (let i = 0; i < 25; i += 1) add(`http://staging/#tab${i % 9}`);
  for (let i = 0; i < 30; i += 1) add(`http://staging/route${i}`);
  add('http://staging/route3', { solo: true });
  return tests;
}

test('testShard: only a whole, in-range shard of two or more', () => {
  assert.deepEqual(testShard({ TEST_SHARD_INDEX: '1', TEST_SHARD_COUNT: '3' }), { index: 1, count: 3 });
  assert.equal(testShard({}), null);
  assert.equal(testShard({ TEST_SHARD_INDEX: '0', TEST_SHARD_COUNT: '1' }), null, 'one shard is no sharding');
  assert.equal(testShard({ TEST_SHARD_INDEX: '3', TEST_SHARD_COUNT: '3' }), null);
  assert.equal(testShard({ TEST_SHARD_INDEX: '-1', TEST_SHARD_COUNT: '3' }), null);
  assert.equal(testShard({ TEST_SHARD_INDEX: 'x', TEST_SHARD_COUNT: '3' }), null);
  assert.equal(testShard({ TEST_SHARD_INDEX: '0', TEST_SHARD_COUNT: '99' }), null);
});

test('shardGroups: every group in exactly one shard, the same way every time, about equal in cost', () => {
  const groups = groupTests(platformLikeSuite(), {});
  for (const count of [2, 3, 4]) {
    const shards = shardGroups(groups, count);
    assert.equal(shards.length, count);
    const placed = shards.flat();
    assert.equal(placed.length, groups.length, 'no group lost or doubled');
    assert.deepEqual(new Set(placed), new Set(groups));
    assert.deepEqual(shardGroups(groups, count), shards, 'deterministic: every pod computes the same split');
    const loads = shards.map((s) => s.reduce((n, g) => n + groupCost(g), 0));
    const heaviest = Math.max(...groups.map(groupCost));
    assert.ok(Math.max(...loads) - Math.min(...loads) <= heaviest,
      `loads within one group of each other: ${loads.map((l) => l.toFixed(1)).join(', ')}`);
    for (const shard of shards) {
      const costs = shard.map(groupCost);
      assert.deepEqual(costs, [...costs].sort((a, b) => b - a), 'each shard heaviest first');
    }
  }
});

test('heaviestFirst: by cost, ties kept in their order', () => {
  const light = [{ url: 'http://s/a' }];
  const heavy = [{ url: 'http://s/#a' }, { url: 'http://s/#b' }, { url: 'http://s/#c' }];
  const lightToo = [{ url: 'http://s/b' }];
  assert.deepEqual(heaviestFirst([light, heavy, lightToo]), [heavy, light, lightToo]);
  assert.ok(groupCost(heavy) > groupCost(light));
});

test('three shards together report every check exactly once, and each counts its own', async () => {
  const tests = platformLikeSuite();
  const read = collect();
  for (let index = 0; index < 3; index += 1) {
    await runTests(makeBrowser(), tests, {
      concurrency: 4, testTimeoutMs: 20000, assertMaxMs: 50, assertPollMs: 10,
      settleQuietMs: 0, settleMaxMs: 0,
      env: { TEST_SHARD_INDEX: String(index), TEST_SHARD_COUNT: '3', TEST_RETRY_RUNS: '0' },
    });
  }
  const { frames, done } = read();
  const indexes = frames.map((f) => f.index).sort((a, b) => a - b);
  assert.deepEqual(indexes, tests.map((t) => t.index), 'each check once, across the shards');
  assert.equal(done.length, 3);
  assert.deepEqual(done.map((d) => d.shard), ['0/3', '1/3', '2/3']);
  assert.equal(done.reduce((n, d) => n + Number(d.expected), 0), tests.length, 'the shares add up to the run');
  assert.ok(done.every((d) => Number(d.expected) > 0), 'every shard got work');
});

test('a shard\'s retries come from a base of its own', async () => {
  const tests = Array.from({ length: 8 }, (_, i) => ({ index: i, name: `c${i}`, path: `/p${i}`, url: `http://staging/p${i}` }));
  for (const [env, base] of [
    [{ TEST_SHARD_INDEX: '0', TEST_SHARD_COUNT: '2' }, RETRY_INDEX_BASE],
    [{ TEST_SHARD_INDEX: '1', TEST_SHARD_COUNT: '2' }, RETRY_INDEX_BASE + RETRY_SHARD_STRIDE],
    [{ TEST_RETRY_SLOT: '2' }, RETRY_INDEX_BASE + 2 * RETRY_SHARD_STRIDE],
  ]) {
    // One failing check, chosen from the checks this run will actually ask.
    const shard = testShard(env);
    const mine = shard ? shardGroups(groupTests(tests, {}), shard.count)[shard.index].flat() : tests;
    const failing = mine[0].index;
    const read = collect();
    await runTests(makeBrowser({ missing: ['#gone'] }),
      tests.map((t) => ({ ...t, expectSelector: t.index === failing ? '#gone' : '#here' })), {
        concurrency: 2, testTimeoutMs: 20000, assertMaxMs: 50, assertPollMs: 10, settleQuietMs: 0, settleMaxMs: 0,
        env: { ...env, TEST_RETRY_RUNS: '2' },
      });
    const retries = read().frames.filter((f) => f.retryOf != null);
    assert.equal(retries.length, 2, `the failing check asked twice more (${JSON.stringify(env)})`);
    assert.ok(retries.every((f) => f.retryOf === failing));
    assert.ok(retries.every((f) => f.index >= base && f.index < base + RETRY_SHARD_STRIDE),
      `retries between ${base} and the next base: ${retries.map((f) => f.index)}`);
  }
});

test('an unsharded run keeps its old shape, heaviest groups first', async () => {
  const log = [];
  const read = collect();
  const tests = [
    { index: 0, name: 'a', path: '/one', url: 'http://staging/one' },
    { index: 1, name: 'b', path: '/', url: 'http://staging/#x' },
    { index: 2, name: 'c', path: '/', url: 'http://staging/#y' },
    { index: 3, name: 'd', path: '/', url: 'http://staging/#z' },
  ];
  await runTests(makeBrowser({ log }), tests, {
    concurrency: 1, testTimeoutMs: 20000, assertMaxMs: 50, assertPollMs: 10, settleQuietMs: 0, settleMaxMs: 0,
    env: { TEST_RETRY_RUNS: '0' },
  });
  const { frames, done } = read();
  assert.equal(frames.length, 4);
  assert.equal(done.length, 1);
  assert.equal(done[0].shard, undefined, 'no shard named');
  assert.equal(done[0].expected, '4');
  const firstGoto = log.find((e) => e.call === 'goto');
  assert.match(firstGoto.url, /^http:\/\/staging\/#/, 'the three-cohort document first, the lone route after');
});

test('the checks render at TEST_DEVICE_SCALE_FACTOR; unset, at the run\'s density', () => {
  assert.equal(resolveTestViewport({ TEST_DEVICE_SCALE_FACTOR: '1' }).deviceScaleFactor, 1);
  assert.equal(resolveTestViewport({ TEST_DEVICE_SCALE_FACTOR: '2' }).deviceScaleFactor, 2);
  const unset = resolveTestViewport({});
  assert.equal(unset.width, 1280);
  assert.equal(unset.height, 800);
  assert.ok([1, 2].includes(unset.deviceScaleFactor));
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../capture/capture'), 'utf8');
  assert.match(src, /page = await \(context \|\| browser\)\.newPage\(\);\s+await page\.setViewport\(TEST_VIEWPORT\);/,
    'a check page takes the checks\' viewport');
});
