'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const api = loadTsx('tests/fixtures/staking-api.ts');

function response(chainId, wallet, epoch, complete = epoch < 10) {
  return { chainId, wallet, epoch, currentEpoch: 10, complete,
    counts: { won: 5, upcoming: complete ? 0 : 2, produced: 2, missed: 1 },
    observability: { nested: { futureField: ['keep', 'all', 'of', 'this'] } } };
}
function memoryCache() {
  const records = new Map();
  return { records, get: async (...key) => records.get(api.epochCacheKey(...key)) || null,
    put: async (data) => { if (data.complete) records.set(api.epochCacheKey(data.chainId, data.wallet, data.epoch), structuredClone(data)); } };
}
function backend({ chain = () => 'chain-a', failEpoch } = {}) {
  const calls = [];
  return { calls,
    async read(path) {
      assert.equal(path, '/api/me/staking/context', 'only configuration comes from Homeroom');
      return { chainId: chain(), observabilityUrl: 'https://receiver.example' };
    },
    async readEpoch({ epoch: requested, chainId, wallet }) {
      const epoch = requested === 'current' ? 10 : Number(requested);
      calls.push(requested);
      if (epoch === failEpoch) throw Error('Temporary failure');
      return response(chainId, wallet, epoch);
    },
  };
}

test('delegated sheet content is exactly one Undelegate action with no epoch/status content', () => {
  const html = renderToHtml(createElement(api.StakingContent, { wallet: {
    ...api.WALLET_EMPTY, address: 'wallet-a', staking: { kind: 'delegated', delegate: 'target', since: '' },
  } }));
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.equal(html.replace(/<[^>]*>/g, ''), 'Undelegate');
  assert.doesNotMatch(html, /Epoch|Delegated|Active|data-staking-epochs/);
});

test('unknown staking state does not assert Active or offer delegation', () => {
  const html = renderToHtml(createElement(api.StakingContent, { wallet: api.WALLET_EMPTY }));
  assert.match(html, /not available yet/);
  assert.doesNotMatch(html, /Undelegate|>Delegate<|>Active</);
});

test('epoch card exposes distinct counters and their requested colors', () => {
  const html = renderToHtml(createElement(api.EpochCard, { epoch: 10, current: true,
    record: response('a', 'w', 10) }));
  assert.match(html, /Epoch 10/);
  for (const [label, color] of [['Upcoming', 'amber'], ['Produced', 'emerald'], ['Missed', 'red']]) {
    assert.match(html, new RegExp(`text-${color}-700[^]*?${label}`));
  }
  assert.match(html, /Won slots/);
});

test('current paints before previous prefetch; full completed response survives reopening with no expiry', async () => {
  const cache = memoryCache();
  const server = backend();
  const history = api.createStakingHistory('wallet-a', { cache, read: server.read, readEpoch: server.readEpoch });
  const seen = [];
  history.store.subscribe(() => { const s = history.store.get(); if (s.currentEpoch !== null) seen.push(!!s.records[9]); });
  await history.refresh();
  assert.deepEqual(server.calls, ['current', '9']);
  assert.equal(seen[0], false, 'current is visible before the prefetch finishes');
  assert.deepEqual(cache.records.get(api.epochCacheKey('chain-a', 'wallet-a', 9)), response('chain-a', 'wallet-a', 9));
  assert.equal(cache.records.has(api.epochCacheKey('chain-a', 'wallet-a', 10)), false);
  history.dispose();
  const server2 = backend();
  const reopened = api.createStakingHistory('wallet-a', { cache, read: server2.read, readEpoch: server2.readEpoch });
  await reopened.refresh();
  assert.deepEqual(server2.calls, ['current'], 'previous epoch restored from device cache');
  await reopened.select(9);
  assert.deepEqual(server2.calls, ['current', '8'], 'sliding reuses 9 and prefetches 8');
  reopened.dispose();
});

test('cache partitions identical epoch numbers by wallet and chain', async () => {
  const cache = memoryCache();
  for (const [chain, wallet] of [['a', 'one'], ['b', 'one'], ['a', 'two']]) {
    const server = backend({ chain: () => chain });
    const history = api.createStakingHistory(wallet, { cache, read: server.read, readEpoch: server.readEpoch });
    await history.refresh();
    assert.deepEqual(server.calls, ['current', '9']);
    history.dispose();
  }
  assert.equal(cache.records.size, 3);
});

test('disposing on delegation cancels requests and fences late epoch data and prefetch', async () => {
  let resolve;
  let calls = 0;
  const history = api.createStakingHistory('wallet-a', { cache: memoryCache(), read: backend().read, readEpoch: async (_args, signal) => {
    calls += 1;
    return new Promise((r) => { resolve = () => { assert.equal(signal.aborted, true); r(response('chain-a', 'wallet-a', 10)); }; });
  } });
  const pending = history.refresh();
  await new Promise((r) => setImmediate(r));
  history.dispose(); resolve(); await pending;
  assert.equal(calls, 1);
  assert.deepEqual(history.store.get().records, {});
});

test('network changes replace visible records while keeping each chain cache separate', async () => {
  let chain = 'a';
  const cache = memoryCache();
  const server = backend({ chain: () => chain });
  const history = api.createStakingHistory('wallet', { cache, read: server.read, readEpoch: server.readEpoch });
  await history.refresh(); chain = 'b'; await history.refresh();
  assert.equal(history.store.get().chainId, 'b');
  assert.equal(history.store.get().records[9].chainId, 'b');
  assert.equal(cache.records.size, 2);
  history.dispose();
});

test('prefetch failure keeps current data and becomes retryable on the older card', async () => {
  const server = backend({ failEpoch: 9 });
  const history = api.createStakingHistory('wallet', { cache: memoryCache(), read: server.read, readEpoch: server.readEpoch });
  await history.refresh();
  assert.equal(history.store.get().currentEpoch, 10);
  assert.equal(history.store.get().error, null);
  await history.select(9);
  assert.match(history.store.get().errors[9], /Temporary/);
  await history.select(-1); assert.equal(history.store.get().selectedEpoch, 9);
  await history.select(11); assert.equal(history.store.get().selectedEpoch, 9);
  history.dispose();
});

test('a partial response is never persisted and is fetched again', async () => {
  const cache = memoryCache(), server = backend();
  const history = api.createStakingHistory('wallet', { cache, read: server.read, readEpoch: async (args) => {
    const data = await server.readEpoch(args);
    return data.epoch === 9 ? { ...data, complete: false, counts: null } : data;
  } });
  await history.refresh(); await history.select(9);
  assert.equal(server.calls.filter((x) => x === '9').length, 2);
  assert.equal(cache.records.has(api.epochCacheKey('chain-a', 'wallet', 9)), false);
  history.dispose();
});

test('IndexedDB absence leaves live reads usable', async () => {
  const cache = api.createEpochCache(null);
  assert.equal(await cache.get('a', 'b', 1), null);
  assert.equal(await cache.put(response('a', 'b', 1)), false);
});

test('concurrent refreshes coalesce and receiver changes keep completed data partitioned by chain and wallet', async () => {
  const server = backend(), cache = memoryCache();
  let observabilityUrl = 'https://first.example';
  const origins = [];
  const history = api.createStakingHistory('wallet', { cache,
    read: async () => ({ chainId: 'chain-a', observabilityUrl }),
    readEpoch: async (args) => { origins.push(args.observabilityUrl); return server.readEpoch(args); },
  });
  await Promise.all([history.refresh(), history.refresh()]);
  assert.deepEqual(server.calls, ['current', '9']);
  observabilityUrl = 'https://second.example';
  await history.refresh();
  assert.deepEqual(origins, ['https://first.example', 'https://first.example', 'https://second.example']);
  assert.equal(history.store.get().observabilityUrl, observabilityUrl);
  assert.equal(history.store.get().records[9].complete, true);
  history.dispose();
});
