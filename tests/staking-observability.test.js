'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { bech32m } = require('bech32');
const { createStakingObservability } = require('../src/services/staking-observability');
const { stakingRoutes } = require('../src/routes/staking');
const wallet = 'ut1examplewallet00000000000000000000000';
const config = { stakingObservabilityUrl: 'https://observability.example', nativeSessionV2Network: { chainId: 'chain-a' } };

function mock({ partial = false, closed = true, noParticipant = false, unobserved = false, incompleteRange = false } = {}) {
  const urls = [];
  const read = async (raw) => {
    const u = new URL(raw); urls.push(u);
    const epoch = Number(u.searchParams.get('epoch') || 10);
    if (u.pathname.endsWith('producer-stats')) return { epoch, slots_per_epoch: 100, current_slot: 1005,
      generated_at_ms: 100550, closed_through_slot: closed ? 1004 : 998,
      from_slot: epoch * 100, to_slot: epoch * 100 + 99, covered_slot_count: incompleteRange ? 99 : 100,
      receiver_observation_complete: true, cache: { complete: true }, extra: ['keep'] };
    return { from_slot: epoch * 100, to_slot: epoch * 100 + 99, participant_count: noParticipant ? 0 : 1,
      cache: { complete: !partial }, summary: { total: 5, produced: epoch === 10 ? 1 : unobserved ? 3 : 4,
        missed: 1, unobserved: epoch === 10 || unobserved ? 1 : 0, pending: epoch === 10 ? 2 : 0, dropped: 0 },
      obligations: [0, 1, 2, 6, 7].map((n) => ({ epoch, status: epoch === 10 && n > 5 ? 'pending' : 'produced',
        slot_time_ms: (epoch * 100 + n) * 100, evidence: { keep: n } })) };
  };
  return { service: createStakingObservability(config, { read }), urls };
}

test('epoch reads use only wallet-scoped observability endpoints and preserve complete responses', async () => {
  const { service, urls } = mock();
  const data = await service.epochs({ wallet, chainId: 'chain-a', epoch: 'current' });
  assert.deepEqual(data.counts, { won: 5, upcoming: 2, produced: 1, missed: 1, unobserved: 1, dropped: 0 });
  assert.equal(data.complete, false);
  assert.deepEqual(data.observability.stats.extra, ['keep']);
  assert.equal(data.observability.slots.obligations[4].evidence.keep, 7);
  assert.equal(urls.length, 2);
  for (const url of urls) {
    assert.equal(url.origin, 'https://observability.example');
    assert.equal(url.searchParams.get('sender'), wallet);
  }
});

test('permanent history requires a closed complete epoch with no unresolved observations', async () => {
  const args = { wallet, chainId: 'chain-a', epoch: '9' };
  assert.equal((await mock().service.epochs(args)).complete, true);
  assert.equal((await mock({ closed: false }).service.epochs(args)).complete, false);
  assert.equal((await mock({ unobserved: true }).service.epochs(args)).complete, false);
  assert.equal((await mock({ incompleteRange: true }).service.epochs(args)).complete, false);
  const partial = await mock({ partial: true }).service.epochs(args);
  assert.equal(partial.complete, false); assert.equal(partial.counts, null);
  const unknown = await mock({ noParticipant: true }).service.epochs(args);
  assert.equal(unknown.complete, false); assert.equal(unknown.counts, null);
});

test('invalid wallet, epoch and mismatched chain never reach an upstream', async () => {
  const { service, urls } = mock();
  for (const fields of [{ wallet: 'https://attacker.invalid' }, { epoch: '-1' }, { chainId: 'other' }, { epoch: '9&sender=other' }]) {
    await assert.rejects(service.epochs({ wallet, chainId: 'chain-a', epoch: '9', ...fields }), (e) => [400, 409].includes(e.status));
  }
  assert.equal(urls.length, 0);
});

test('simultaneous reads coalesce without changing the returned full response', async () => {
  const { service, urls } = mock();
  const args = { wallet, chainId: 'chain-a', epoch: 'current' };
  const [a, b] = await Promise.all([service.epochs(args), service.epochs(args)]);
  assert.deepEqual(a, b); assert.equal(urls.length, 2);
});

const chain = (byte) => bech32m.encode('utc', bech32m.toWords(Buffer.alloc(32, byte)), 1023);

test('a preview without injected native configuration resolves a canonical chain from its parent', async () => {
  const urls = [];
  const chainId = chain(1);
  const service = createStakingObservability({ stakingObservabilityUrl: config.stakingObservabilityUrl }, {
    now: () => 1000000,
    previewPlatformUrl: 'https://parent.example/api/app-platform',
    read: async (url) => {
      urls.push(url);
      return { explorer: { status: 'ok', chainId, at: 999999 } };
    },
  });
  const [first, second] = await Promise.all([service.context(), service.context()]);
  assert.deepEqual(first, { chainId });
  assert.deepEqual(second, first);
  assert.deepEqual(await service.context(), first);
  assert.deepEqual(urls, ['https://parent.example/api/node-status/full']);
});

test('preview network refresh rejects a former chain before reading or caching epoch data', async () => {
  let time = 1000000;
  let currentChain = chain(1);
  const urls = [];
  const service = createStakingObservability({ stakingObservabilityUrl: config.stakingObservabilityUrl }, {
    now: () => time,
    previewPlatformUrl: 'https://parent.example/api/app-platform',
    read: async (url) => {
      urls.push(url);
      return { explorer: { status: 'ok', chainId: currentChain, at: time } };
    },
  });
  await service.context();
  time += 30001;
  currentChain = chain(2);
  await assert.rejects(service.epochs({ wallet, chainId: chain(1), epoch: 'current' }), (e) => e.status === 409);
  assert.deepEqual(await service.context(), { chainId: chain(2) });
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url === 'https://parent.example/api/node-status/full'));
});

test('missing, stale, unhealthy and noncanonical parent identities are never cache keys', async () => {
  for (const explorer of [undefined,
    { status: 'ok', chainId: 'testnet', at: 1000000 },
    { status: 'unreachable', chainId: chain(1), at: 1000000 },
    { status: 'ok', chainId: chain(1), at: 1 },
    { status: 'ok', chainId: chain(1) },
  ]) {
    let calls = 0;
    const service = createStakingObservability({ stakingObservabilityUrl: config.stakingObservabilityUrl }, {
      now: () => 1000000, previewPlatformUrl: 'https://parent.example/api/app-platform',
      read: async () => { calls++; return { explorer }; },
    });
    await assert.rejects(service.context(), (e) => e.status === 503);
    await assert.rejects(service.context(), (e) => e.status === 503);
    assert.equal(calls, 2, 'failed discovery stays retryable');
  }
});

test('production never discovers a chain from a preview locator', async (t) => {
  const prior = { USERNODE_ENV: process.env.USERNODE_ENV, USERNODE_PLATFORM_API_URL: process.env.USERNODE_PLATFORM_API_URL };
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.USERNODE_ENV = 'production';
  process.env.USERNODE_PLATFORM_API_URL = 'https://parent.example/api/app-platform';
  const service = createStakingObservability({ stakingObservabilityUrl: config.stakingObservabilityUrl }, {
    read: async () => assert.fail('production must keep its explicit native chain binding'),
  });
  await assert.rejects(service.context(), (e) => e.status === 503);
});

test('routes require authentication and isolate fixtures to staging', async (t) => {
  const app = express();
  app.use((req, _res, next) => { if (req.headers['x-test-user']) req.user = { id: 1 }; next(); });
  app.use(stakingRoutes(config, { service: mock().service }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + '/api/me/staking/context')).status, 401);
  const headers = { 'x-test-user': '1' };
  const context = await fetch(origin + '/api/me/staking/context', { headers });
  assert.deepEqual(await context.json(), { chainId: 'chain-a' });
  assert.equal(context.headers.get('cache-control'), 'private, no-store');
  const old = process.env.USERNODE_ENV;
  t.after(() => { if (old === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = old; });
  process.env.USERNODE_ENV = 'production';
  assert.equal((await fetch(origin + '/api/me/staking/demo', { headers })).status, 404);
  process.env.USERNODE_ENV = 'staging';
  const preview = await fetch(origin + '/api/me/staking/demo?state=delegated', { headers });
  assert.equal((await preview.json()).staking.kind, 'delegated');
});
