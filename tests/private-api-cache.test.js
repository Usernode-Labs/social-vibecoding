'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { worker, json, deferred, A, B, ORIGIN, SCOPE_HEADER } = require('./lib/private-cache-worker');
const { API_CACHE, apiCacheKey, apiEntryCanReplay } = require('../public/sw');
const offline = async () => { throw new TypeError('synthetic offline network'); };

test('response no-store/no-cache and non-JSON data never enter the API cache', async t => {
  for (const policy of ['private, no-store', 'no-cache', 'private, no-cache="Set-Cookie"']) await t.test(policy, async () => {
    const h = worker({ fetcher: async () => json({ private: 'FAKE_ONLY' }, A, { policy }) });
    assert.equal((await (await h.get()).json()).private, 'FAKE_ONLY');
    await h.drain();
    const cache = await h.caches.open(API_CACHE);
    assert.equal((await cache.keys()).length, 0);
    h.setNetwork(offline);
    await assert.rejects(h.get(), /offline/);
  });
  const h = worker({ fetcher: async () => new Response('FAKE_FILE', { headers: { [SCOPE_HEADER]: A } }) });
  await h.get(); await h.drain();
  assert.equal((await (await h.caches.open(API_CACHE)).keys()).length, 0);
});

test('permitted same-session JSON survives offline while a different identity gets no previous body', async () => {
  const h = worker();
  assert.deepEqual(await (await h.get(A)).json(), { fake: 'A' });
  await h.drain();
  h.setNetwork(offline);
  assert.deepEqual(await (await h.get(A)).json(), { fake: 'A' }, 'same-session offline behavior is preserved');
  await assert.rejects(h.get(B), /offline/, 'the same URL cannot cross a session switch without logout');
  await h.drain();
  assert.equal((await (await h.caches.open(API_CACHE)).keys()).length, 0, 'the retired partition is removed');
});

test('missing, malformed or unconfirmed scopes cannot read or populate offline data', async () => {
  const h = worker();
  await h.get(A); await h.drain();
  h.setNetwork(offline);
  await assert.rejects(h.get(null), /offline/);
  await assert.rejects(h.get('bad'), /offline/);
  h.setNetwork(async () => json({ private: 'FAKE_OTHER_USER' }, B));
  await h.get(A); await h.drain();
  h.setNetwork(offline);
  await assert.rejects(h.get(A), /offline/, 'server scope mismatch removes the prior representation');
});

test('an explicit no-store bypass invalidates a previous copy and an older pending success', async () => {
  const h = worker();
  await h.get(A); await h.drain();
  const held = deferred();
  h.setNetwork(() => held.promise);
  const pending = h.get(A);
  await new Promise(resolve => setImmediate(resolve));
  h.setNetwork(async () => json({ fake: 'fresh network only' }, A, { policy: 'no-store' }));
  assert.equal((await h.get(A, '/api/private-fixture', { cache: 'no-store' })).status, 200);
  held.resolve(json({ private: 'FAKE_PREVIOUS_COPY' }));
  await pending; await h.drain();
  h.setNetwork(offline);
  await assert.rejects(h.get(A), /offline/);
});

test('a response queued before logout cannot return or repopulate private data after the wipe', async () => {
  const held = deferred();
  const h = worker({ fetcher: () => held.promise });
  const pending = h.get(A);
  await new Promise(resolve => setImmediate(resolve));
  await h.message({ type: 'clear-api-cache' });
  held.resolve(json({ private: 'FAKE_LATE_A' }));
  const res = await pending;
  assert.equal(res.status, 409);
  assert.equal((await res.text()).includes('FAKE_LATE_A'), false);
  await h.drain();
  assert.equal((await (await h.caches.open(API_CACHE)).keys()).length, 0);
});

test('logout clears promptly and a still-downloading old body cannot repopulate its cache', async () => {
  const body = deferred();
  let reading = false;
  const stream = new ReadableStream({ async start(controller) {
    reading = true; await body.promise;
    controller.enqueue(new TextEncoder().encode('{"private":"FAKE_SLOW_BODY"}')); controller.close();
  } });
  const h = worker({ fetcher: async () => new Response(stream, { headers: {
    'Content-Type': 'application/json', [SCOPE_HEADER]: A,
  } }) });
  await h.get(A);
  assert.equal(reading, true);
  await new Promise(resolve => setImmediate(resolve));
  const clearing = [];
  h.handlers.message({ data: { type: 'clear-api-cache' }, waitUntil: promise => clearing.push(promise) });
  await Promise.all(clearing);
  assert.equal((await (await h.caches.open(API_CACHE)).keys()).length, 0, 'wipe does not wait for the old download');
  h.setNetwork(async () => json({ fake: 'B' }, B));
  assert.deepEqual(await (await h.get(B)).json(), { fake: 'B' }, 'the next session is not held behind that download');
  body.resolve();
  await h.drain();
  const cache = await h.caches.open(API_CACHE);
  const keys = await cache.keys();
  assert.equal(keys.length, 1);
  assert.deepEqual(await (await cache.match(keys[0])).json(), { fake: 'B' });
});

test('a refused auth mutation invalidates old reads while the same session can refill its cache', async () => {
  const h = worker();
  await h.get(A); await h.drain();
  h.setNetwork(async () => json({ error: 'synthetic refusal' }, A, { status: 403, policy: 'no-store' }));
  assert.equal((await h.get(A, '/api/auth/password', { method: 'POST' })).status, 403);
  await h.drain();
  h.setNetwork(async () => json({ fake: 'A after refusal' }));
  await h.get(A); await h.drain();
  h.setNetwork(offline);
  assert.deepEqual(await (await h.get(A)).json(), { fake: 'A after refusal' });
});

test('expired or explicitly revalidated entries cannot mask a network failure', async t => {
  for (const policy of ['private, max-age=0', 'private, must-revalidate']) {
    assert.equal(apiEntryCanReplay(json({ fake: true }, A,
      { policy, headers: { 'sw-cached-at': '1000' } }), A, 1000), false,
    'zero freshness never permits an offline serve, including the storage millisecond');
  }
  for (const [policy, age] of [['private', 15 * 86400_000], ['private, max-age=60', 61_000], ['private, must-revalidate', 1_000]]) {
    await t.test(policy, async () => {
      const h = worker({ fetcher: offline });
      const cache = await h.caches.open(API_CACHE);
      const key = apiCacheKey(new Request(ORIGIN + '/api/private-fixture', { headers: { [SCOPE_HEADER]: A } }), A);
      await cache.put(key, json({ private: 'FAKE_EXPIRED' }, A,
        { policy, headers: { 'sw-cached-at': String(Date.now() - age) } }));
      await assert.rejects(h.get(A), /offline/);
      assert.equal((await cache.keys()).length, 0);
    });
  }
});

test('identical URLs across identities never share an in-flight response', async () => {
  const old = deferred();
  let authority = A;
  const h = worker({ fetcher: req => authority === A ? old.promise : Promise.resolve(json({ private: 'FAKE_B' }, B)) });
  const first = h.get(A);
  await new Promise(resolve => setImmediate(resolve));
  authority = B;
  assert.deepEqual(await (await h.get(B)).json(), { private: 'FAKE_B' });
  old.resolve(json({ private: 'FAKE_OLD_A' }, A));
  assert.equal((await first).status, 409);
  await h.drain();
  assert.equal(h.requests.length, 2);
  h.setNetwork(offline);
  assert.deepEqual(await (await h.get(B)).json(), { private: 'FAKE_B' });
});

test('sharing preserves significant request headers and only identical reads join', async () => {
  const held = deferred();
  const h = worker({ fetcher: () => held.promise });
  const first = h.get(A, '/api/variant', { headers: { accept: 'application/json; variant=one' } });
  const joined = h.get(A, '/api/variant', { headers: { accept: 'application/json; variant=one' } });
  const different = h.get(A, '/api/variant', { headers: { accept: 'application/json; variant=two' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 2);
  held.resolve(json({ fake: true }));
  await Promise.all([first, joined, different]); await h.drain();
});

test('a newer denial or no-store response wins over an older success and any 304', async t => {
  for (const status of [200, 304, 401, 403, 404, 410]) await t.test(String(status), async () => {
    const old = deferred();
    let calls = 0;
    const h = worker({ fetcher: () => {
      if (++calls === 1) return old.promise;
      if (status === 304) return Promise.resolve(new Response(null, { status: 304, headers: { [SCOPE_HEADER]: A } }));
      return Promise.resolve(json({ fake: 'new policy' }, A, { status, policy: 'private, no-store' }));
    } });
    const first = h.get(A, '/api/permission', { headers: { 'x-fixture-read': 'older' } });
    await new Promise(resolve => setImmediate(resolve));
    await h.get(A, '/api/permission', { headers: { 'x-fixture-read': 'newer' } });
    old.resolve(json({ private: 'FAKE_PREVIOUS_PERMISSION' }));
    await first; await h.drain();
    h.setNetwork(offline);
    await assert.rejects(h.get(A, '/api/permission'), /offline/);
  });
});

test('upgrade drops unscoped legacy copies, retains certified partitions, and leaves shell assets intact', async () => {
  const h = worker();
  const api = await h.caches.open(API_CACHE);
  await api.put('/api/private-fixture', json({ private: 'FAKE_UNOWNED' }));
  const legacy = await h.caches.open('usernode-api-v6');
  await legacy.put('/api/auth/me', json({ user: { id: 101 } }));
  const shell = await h.caches.open('usernode-shell-v37');
  await shell.put('/index.html', new Response('FAKE_PUBLIC_SHELL'));
  const scoped = apiCacheKey(new Request(ORIGIN + '/api/private-fixture', { headers: { [SCOPE_HEADER]: A } }), A);
  await api.put(scoped, json({ fake: 'certified' }, A, { headers: { 'sw-cached-at': String(Date.now()) } }));
  await h.activate();
  assert.equal(await api.match('/api/private-fixture'), undefined);
  assert.equal(h.stores.has('usernode-api-v6'), false);
  assert.deepEqual(await (await api.match(scoped)).json(), { fake: 'certified' });
  assert.equal(await (await shell.match('/index.html')).text(), 'FAKE_PUBLIC_SHELL');
});
