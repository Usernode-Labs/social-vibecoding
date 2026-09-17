'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');
const api = loadTsx('tests/fixtures/staking-api.ts');
const wallet = 'ut1examplewallet00000000000000000000000';
const config = { stakingObservabilityUrl: 'https://observability.example' };

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
  return { service: { epochs: (args) => api.fetchStakingEpoch({ observabilityUrl: config.stakingObservabilityUrl, ...args }, undefined, { read }) }, urls };
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

test('invalid wallet, epoch and receiver configuration never reach the receiver', async () => {
  const { service, urls } = mock();
  for (const fields of [{ wallet: 'https://attacker.invalid' }, { epoch: '-1' }, { observabilityUrl: 'https://user:secret@receiver.example' }, { chainId: '' }, { epoch: '9&sender=other' }]) {
    await assert.rejects(service.epochs({ wallet, chainId: 'chain-a', epoch: '9', ...fields }), (e) => ['wallet', 'epoch', 'configuration'].includes(e.code));
  }
  assert.equal(urls.length, 0);
});

test('device transport omits credentials and referrer, bounds decoded bytes, and preserves split UTF-8', async () => {
  let options;
  const bytes = new TextEncoder().encode('{"note":"☀"}');
  const data = await api.readObservabilityJson('https://receiver.example/data', undefined, {
    fetchImpl: async (_url, init) => {
      options = init;
      return new Response(new ReadableStream({ start(c) {
        for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
        c.close();
      } }));
    },
  });
  assert.deepEqual(data, { note: '☀' });
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.mode, 'cors');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(options.headers, { accept: 'application/json' });
  let cancelled = false;
  await assert.rejects(api.readObservabilityJson('https://receiver.example/data', undefined, {
    maxBytes: 4,
    fetchImpl: async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; },
    })),
  }), (e) => e.code === 'response_too_large');
  assert.equal(cancelled, true);
});

test('HTTP, CORS/network and invalid JSON errors remain retryable without exposing upstream bodies', async () => {
  for (const [fetchImpl, code] of [
    [async () => new Response('private details', { status: 503 }), 'http'],
    [async () => { throw Error('private network details'); }, 'connection'],
    [async () => new Response('private invalid json'), 'invalid_response'],
  ]) {
    await assert.rejects(api.readObservabilityJson('https://receiver.example/data', undefined, { fetchImpl }),
      (e) => e.code === code && !e.message.includes('private'));
  }
  assert.deepEqual(await api.readObservabilityJson('https://receiver.example/data', undefined, {
    fetchImpl: async () => new Response('{"recovered":true}'),
  }), { recovered: true });
});

test('device reads time out and sheet disposal aborts the active receiver request', async () => {
  const waitForAbort = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(api.readObservabilityJson('https://receiver.example/data', undefined, {
    fetchImpl: waitForAbort, timeoutMs: 5,
  }), (e) => e.code === 'timeout');
  const parent = new AbortController();
  const pending = api.readObservabilityJson('https://receiver.example/data', parent.signal, { fetchImpl: waitForAbort });
  parent.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
});

test('inconsistent epochs and malformed receiver records cannot enter the permanent cache', async () => {
  const args = { observabilityUrl: 'https://receiver.example', wallet, chainId: 'chain-a', epoch: '9' };
  for (const stats of [null, {}, { epoch: 10, slots_per_epoch: 100, current_slot: 1005, generated_at_ms: 100550 }]) {
    await assert.rejects(api.fetchStakingEpoch(args, undefined, { read: async () => stats }),
      (e) => e.code === 'invalid_response');
  }
  const data = await api.fetchStakingEpoch(args, undefined, { read: async (url) => url.includes('producer-stats')
    ? { epoch: 9, slots_per_epoch: 100, current_slot: 1005, generated_at_ms: 100550 }
    : null });
  assert.equal(data.complete, false);
  assert.equal(data.counts, null);
});
