'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');
const { A, B, deferred, json, ORIGIN, SCOPE_HEADER } = require('./lib/private-cache-worker');
const { installApiCacheIdentity, readApiCacheScope } = loadTsx('frontend/src/lib/api-cache-identity.ts');

function page({ initial = A, fetcher = async () => json({ fake: 'A' }), href = ORIGIN + '/', native = false } = {}) {
  let cookie = initial ? `usernode_api_scope=${initial}` : '';
  const handlers = {}, calls = [], announcements = [];
  const renewal = { epoch: 0, settled: null };
  let reloads = 0;
  const win = {
    document: { get cookie() { return cookie; }, set cookie(value) { cookie = value.split(';')[0]; } },
    location: { href, origin: ORIGIN, reload() { reloads++; } },
    addEventListener(name, callback) { handlers[name] = callback; },
    localStorage: { setItem: (...args) => announcements.push(args) },
    fetch: async req => { calls.push(req); return fetcher(req); },
  };
  if (native) win.NativeChrome = { webSessionRenewal: () => ({ ...renewal }) };
  installApiCacheIdentity(win);
  return { win, calls, handlers, announcements, renewal,
    setCookie(value) { cookie = value ? `usernode_api_scope=${value}` : ''; },
    get reloads() { return reloads; } };
}

test('same-origin API reads carry a non-credential partition and revalidate the HTTP cache', async () => {
  const h = page();
  assert.deepEqual(await (await h.win.fetch('/api/private')).json(), { fake: 'A' });
  assert.equal(h.calls[0].headers.get(SCOPE_HEADER), A);
  assert.equal(h.calls[0].cache, 'reload');
  const controller = new AbortController();
  await h.win.fetch(new Request(ORIGIN + '/api/private', { signal: controller.signal, cache: 'no-store' }));
  assert.equal(h.calls[1].cache, 'no-store', 'explicit no-store is never weakened');
});

test('missing/blocked hints, auth, token and cross-origin requests cannot consume a session cache', async () => {
  const h = page({ initial: null });
  await h.win.fetch('/api/private');
  assert.equal(h.calls[0].cache, 'no-store');
  assert.equal(h.calls[0].headers.get(SCOPE_HEADER), null);
  h.setCookie(A);
  for (const [url, init] of [
    ['/api/auth/me'], ['/api/private?token=fake'],
    ['/api/private', { headers: { authorization: 'Bearer fake' } }],
    ['/api/private', { headers: { 'x-usernode-token': 'fake' } }],
    ['/api/private', { credentials: 'omit' }],
  ]) {
    await h.win.fetch(url, init);
    const req = h.calls.at(-1);
    assert.equal(req.cache, 'no-store');
    assert.equal(req.headers.get(SCOPE_HEADER), null);
  }
  const external = 'https://elsewhere.test/api/private';
  await h.win.fetch(external);
  assert.equal(h.calls.at(-1), external, 'external requests retain their original fetch arguments');
  assert.equal(readApiCacheScope({ get cookie() { throw Error('blocked'); } }), null);
});

test('cookie replacement fences a late response, while B can immediately read its own response', async () => {
  const held = deferred();
  let calls = 0;
  const h = page({ fetcher: () => ++calls === 1 ? held.promise : Promise.resolve(json({ fake: 'B' }, B)) });
  const old = h.win.fetch('/api/private');
  h.setCookie(B);
  const current = await h.win.fetch('/api/private');
  assert.deepEqual(await current.json(), { fake: 'B' });
  held.resolve(json({ private: 'FAKE_OLD_A' }));
  await assert.rejects(old, { name: 'AbortError' });
});

test('JSON, clones and streaming body consumption cannot finish for an old identity', async () => {
  const h = page();
  const res = await h.win.fetch('/api/private');
  const copy = res.clone();
  h.setCookie(B);
  await assert.rejects(res.json(), { name: 'AbortError' });
  await assert.rejects(copy.text(), { name: 'AbortError' });

  const body = deferred();
  const stream = new ReadableStream({ async start(controller) {
    await body.promise; controller.enqueue(new TextEncoder().encode('FAKE_LATE_STREAM')); controller.close();
  } });
  const s = page({ fetcher: async () => new Response(stream, { headers: { [SCOPE_HEADER]: A } }) });
  const response = await s.win.fetch('/api/stream');
  const reading = response.body.getReader().read();
  s.setCookie(B); body.resolve();
  await assert.rejects(reading, { name: 'AbortError' });
});

test('logout fences work even before its server response and preserves the logout request', async () => {
  const old = deferred(), logout = deferred();
  const h = page({ fetcher: req => new URL(req.url).pathname.endsWith('/logout') ? logout.promise : old.promise });
  const pending = h.win.fetch('/api/private');
  const leaving = h.win.fetch('/api/auth/logout', { method: 'POST', body: '{"fake":true}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(h.calls[1].method, 'POST');
  assert.equal(await h.calls[1].clone().text(), '{"fake":true}');
  old.resolve(json({ private: 'FAKE_A' }));
  await assert.rejects(pending, { name: 'AbortError' });
  h.setCookie(null); logout.resolve(json({ ok: true }, null));
  assert.deepEqual(await (await leaving).json(), { ok: true });
  assert.equal(h.announcements.length, 2, 'other tabs learn both boundary start and completion');
});

test('stream bodies cannot prefetch an old chunk and replay it after an account switch', async () => {
  const h = page({ fetcher: async () => new Response('FAKE_ALREADY_AVAILABLE', { headers: { [SCOPE_HEADER]: A } }) });
  const response = await h.win.fetch('/api/stream');
  const body = response.body;
  const copy = response.clone(); // merely accessing .body must not lock it
  const reader = body.getReader();
  await new Promise(resolve => setImmediate(resolve));
  h.setCookie(B);
  await assert.rejects(reader.read(), { name: 'AbortError' });
  await assert.rejects(copy.text(), { name: 'AbortError' });

  const current = page({ fetcher: async () => new Response('FAKE_CURRENT', { headers: { [SCOPE_HEADER]: A } }) });
  const stream = await current.win.fetch('/api/stream');
  const currentReader = stream.body.getReader();
  assert.throws(() => stream.clone(), TypeError, 'a locked body keeps native clone semantics');
  assert.equal(new TextDecoder().decode((await currentReader.read()).value), 'FAKE_CURRENT');
  assert.equal((await currentReader.read()).done, true);
});

test('a fresh /me bootstraps legacy hints, but an older /me cannot overwrite a newer login', async () => {
  const expiry = new Date(Date.now() + 86400_000).toISOString();
  const h = page({ initial: null, fetcher: async () => json({ user: { id: 101 } }, A,
    { policy: 'no-store', headers: { 'X-Usernode-Cache-Expires': expiry } }) });
  const me = await h.win.fetch('/api/auth/me');
  assert.equal(readApiCacheScope(h.win.document), A);
  assert.deepEqual(await me.json(), { user: { id: 101 } });

  const held = deferred();
  const late = page({ initial: null, fetcher: () => held.promise });
  const pending = late.win.fetch('/api/auth/me');
  late.setCookie(B);
  held.resolve(json({ user: { id: 101 } }, A, { headers: { 'X-Usernode-Cache-Expires': expiry } }));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(readApiCacheScope(late.win.document), B);
});

test('another tab changing identity clears the former viewer and reloads without rebroadcasting', () => {
  const h = page();
  const dropped = [];
  h.win.App = { user: { id: 101 }, _dropCachedSession: options => dropped.push(options) };
  h.handlers.storage({ key: 'unrelated' });
  assert.equal(h.reloads, 0);
  h.handlers.storage({ key: 'usernode.api-identity-boundary' });
  assert.deepEqual(dropped, [{ apiCache: false }]);
  assert.equal(h.reloads, 1);
  assert.equal(h.announcements.length, 0);
});

test('native restoration waits for cookie installation, then /me confirms the new partition', async () => {
  const restored = deferred();
  const expiry = new Date(Date.now() + 86400_000).toISOString();
  const h = page({ native: true, fetcher: async req => json({ fake: 'same user, renewed session' }, B,
    { headers: { 'X-Usernode-Cache-Expires': expiry } }) });
  h.renewal.settled = restored.promise;
  const me = h.win.fetch('/api/auth/me');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 0);
  h.renewal.epoch = 1; h.renewal.settled = null; restored.resolve(true);
  assert.equal((await me).status, 200);
  assert.equal(readApiCacheScope(h.win.document), B);
  await h.win.fetch('/api/private');
  assert.equal(h.calls.at(-1).headers.get(SCOPE_HEADER), B);
});

test('native 401 retry wraps the identity fence and gets a fresh request context', async () => {
  const { installSessionRenewalRetry } = loadTsx('frontend/src/lib/session-renewal-retry.ts');
  let calls = 0;
  const h = page({ native: true, fetcher: async () => {
    if (++calls === 1) { h.renewal.epoch = 1; return json({ error: 'expired' }, null, { status: 401 }); }
    return json({ fake: 'current' }, A);
  } });
  installSessionRenewalRetry(h.win);
  assert.deepEqual(await (await h.win.fetch('/api/private')).json(), { fake: 'current' });
  assert.equal(calls, 2);
  assert.equal(h.calls[1].cache, 'no-store', 'an unconfirmed native incarnation cannot consume a previous offline copy');
});
