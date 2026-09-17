'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { bech32m } = require('bech32');
const { createStakingContext } = require('../src/services/staking-context');
const { stakingRoutes } = require('../src/routes/staking');
const config = { stakingObservabilityUrl: 'https://observability.example', nativeSessionV2Network: { chainId: 'chain-a' } };

test('context publishes a public receiver origin without fetching epoch data or exposing URL credentials', async () => {
  const service = createStakingContext({ ...config, stakingObservabilityUrl: 'https://receiver.example/' }, {
    read: async () => assert.fail('configured context requires no outbound request'),
  });
  assert.deepEqual(await service.context(), { chainId: 'chain-a', observabilityUrl: 'https://receiver.example' });
  for (const url of [undefined, '', 'https://secret:password@receiver.example',
    'https://receiver.example/ui/nodes', 'https://receiver.example/?key=secret',
    'https://receiver.example/#secret', 'http://receiver.example', 'javascript:alert(1)']) {
    await assert.rejects(createStakingContext({ ...config, stakingObservabilityUrl: url }).context(),
      (e) => e.status === 503 && !e.message.includes('secret'));
  }
});

const chain = (byte) => bech32m.encode('utc', bech32m.toWords(Buffer.alloc(32, byte)), 1023);

test('a preview without injected native configuration resolves a canonical chain from its parent', async () => {
  const urls = [];
  const chainId = chain(1);
  const service = createStakingContext({ stakingObservabilityUrl: config.stakingObservabilityUrl }, {
    now: () => 1000000,
    previewPlatformUrl: 'https://parent.example/api/app-platform',
    read: async (url) => {
      urls.push(url);
      return { explorer: { status: 'ok', chainId, at: 999999 } };
    },
  });
  const [first, second] = await Promise.all([service.context(), service.context()]);
  assert.deepEqual(first, { chainId, observabilityUrl: config.stakingObservabilityUrl });
  assert.deepEqual(second, first);
  assert.deepEqual(await service.context(), first);
  assert.deepEqual(urls, ['https://parent.example/api/node-status/full']);
});

test('preview network refresh reports the new canonical chain without reading epochs', async () => {
  let time = 1000000;
  let currentChain = chain(1);
  const urls = [];
  const service = createStakingContext({ stakingObservabilityUrl: config.stakingObservabilityUrl }, {
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
  assert.deepEqual(await service.context(), { chainId: chain(2), observabilityUrl: config.stakingObservabilityUrl });
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
    const service = createStakingContext({ stakingObservabilityUrl: config.stakingObservabilityUrl }, {
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
  const service = createStakingContext({ stakingObservabilityUrl: config.stakingObservabilityUrl }, {
    read: async () => assert.fail('production must keep its explicit native chain binding'),
  });
  await assert.rejects(service.context(), (e) => e.status === 503);
});

test('routes require authentication and isolate fixtures to staging', async (t) => {
  const app = express();
  app.use((req, _res, next) => { if (req.headers['x-test-user']) req.user = { id: 1 }; next(); });
  app.use(stakingRoutes(config, { service: createStakingContext(config, { read: async () => assert.fail('server must not fetch epoch data') }) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + '/api/me/staking/context')).status, 401);
  const headers = { 'x-test-user': '1' };
  const context = await fetch(origin + '/api/me/staking/context', { headers });
  assert.deepEqual(await context.json(), { chainId: 'chain-a', observabilityUrl: config.stakingObservabilityUrl });
  assert.equal(context.headers.get('cache-control'), 'private, no-store');
  const old = process.env.USERNODE_ENV;
  t.after(() => { if (old === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = old; });
  process.env.USERNODE_ENV = 'production';
  const retired = await fetch(origin + '/api/me/staking/epochs?epoch=current', { headers });
  assert.equal(retired.status, 410);
  assert.match((await retired.json()).error, /Reload Homeroom/);
  assert.equal((await fetch(origin + '/api/me/staking/demo', { headers })).status, 404);
  process.env.USERNODE_ENV = 'staging';
  const preview = await fetch(origin + '/api/me/staking/demo?state=delegated', { headers });
  assert.equal((await preview.json()).staking.kind, 'delegated');
});
