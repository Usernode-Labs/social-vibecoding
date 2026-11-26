'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');
const { A, B, deferred, json, ORIGIN, SCOPE_HEADER } = require('./lib/private-cache-worker');
const { installApiCacheIdentity, readApiCacheScope, SHARED_READS, SHARED_READ_KEEP_MS, sharedReadKeep } = loadTsx('frontend/src/lib/api-cache-identity.ts');

function page({ initial = A, fetcher = async () => json({ fake: 'A' }), href = ORIGIN + '/', native = false } = {}) {
  const cookieName = new URL(href).protocol === 'http:' ? 'usernode_api_scope' : '__Host-usernode_api_scope';
  let cookie = initial ? `${cookieName}=${initial}` : '';
  const handlers = {}, calls = [], announcements = [];
  const renewal = { epoch: 0, settled: null };
  let reloads = 0;
  const win = {
    document: { get cookie() { return cookie; }, set cookie(value) { cookie = value.split(';')[0]; } },
    location: { href, origin: new URL(href).origin, reload() { reloads++; } },
    addEventListener(name, callback) { handlers[name] = callback; },
    localStorage: { setItem: (...args) => announcements.push(args) },
    fetch: async req => { calls.push(req); return fetcher(req); },
  };
  if (native) win.NativeChrome = { webSessionRenewal: () => ({ ...renewal }) };
  installApiCacheIdentity(win);
  return { win, calls, handlers, announcements, renewal,
    setCookie(value) { cookie = value ? `${cookieName}=${value}` : ''; },
    get reloads() { return reloads; } };
}

test('same-origin API reads carry a non-credential partition and revalidate the HTTP cache', async () => {
  const h = page();
  assert.deepEqual(await (await h.win.fetch('/api/private')).json(), { fake: 'A' });
  assert.equal(h.calls[0].headers.get(SCOPE_HEADER), A);
  assert.equal(h.calls[0].cache, 'no-cache', 'a permitted read revalidates: a 304 when nothing changed (#6790)');
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

// An invite link opened signed out (28 Oct 2026): /me answered "signed out"
// while the invite preview was on its way, App._dropCachedSession reset the
// guard, and the preview's reply was fenced, so the landing drew the waitlist
// pitch instead of the invite card. A document that never had a session has
// nothing to fence.
test('dropping a session this document never had leaves the reads on their way', async () => {
  const held = deferred();
  const h = page({ initial: null, fetcher: () => held.promise });
  const preview = h.win.fetch('/api/public/invites/fake');
  h.win.UsernodeReact.apiCache.reset({ broadcast: true });
  assert.equal(h.announcements.length, 1, 'the boundary is still announced to other tabs');
  held.resolve(json({ live: true }, null));
  assert.deepEqual(await (await preview).json(), { live: true });
});

test('the same reset still fences a document that had a partition or a viewer', async () => {
  for (const [label, initial, before] of [
    ['partition', A, () => {}],
    ['viewer', null, (h) => h.win.UsernodeReact.apiCache.setViewer(101, true)],
  ]) {
    const held = deferred();
    const h = page({ initial, fetcher: () => held.promise });
    before(h);
    const old = h.win.fetch('/api/private');
    h.win.UsernodeReact.apiCache.reset({ broadcast: true });
    held.resolve(json({ private: 'FAKE_OLD' }, initial));
    await assert.rejects(old, { name: 'AbortError' }, label);
  }
});

// Adding a phone in Settings (28 Oct 2026) went through this guard as if it
// were a sign-in: the reads on their way were cut off and every other tab
// reloaded. An auth write that keeps the session fences nothing.
test('an auth write that keeps the session leaves the reads on their way and tells no other tab', async () => {
  for (const url of ['/api/auth/phone-link/request', '/api/auth/oauth/google/native/start']) {
    const held = deferred();
    const h = page({ fetcher: (req) => new URL(req.url).pathname === '/api/private' ? held.promise : json({ ok: true }, A) });
    const pending = h.win.fetch('/api/private');
    await h.win.fetch(url, { method: 'POST' });
    held.resolve(json({ fake: 'A' }));
    assert.deepEqual(await (await pending).json(), { fake: 'A' }, url);
    assert.equal(h.announcements.length, 0, url);
  }
});

test('a login or logout from a signed-out document still fences the reads on their way', async () => {
  const held = deferred();
  const h = page({ initial: null, fetcher: (req) => new URL(req.url).pathname === '/api/private' ? held.promise : json({ ok: true }, null) });
  const old = h.win.fetch('/api/private');
  await h.win.fetch('/api/auth/login', { method: 'POST' });
  held.resolve(json({ fake: 'anonymous' }, null));
  await assert.rejects(old, { name: 'AbortError' });
});

test('native restoration waits for cookie installation, then /me confirms the new partition', async () => {
  const restored = deferred();
  const expiry = new Date(Date.now() + 86400_000).toISOString();
  const h = page({ native: true, fetcher: async req => json({ user: { id: 101 } }, B,
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
  const h = page({ native: true, fetcher: async req => {
    if (++calls === 1) { h.renewal.epoch = 1; return json({ error: 'expired' }, null, { status: 401 }); }
    if (new URL(req.url).pathname === '/api/auth/me') return json({ user: { id: 101 } }, A,
      { headers: { 'X-Usernode-Cache-Expires': new Date(Date.now() + 86400_000).toISOString() } });
    return json({ fake: 'current' }, A);
  } });
  installSessionRenewalRetry(h.win);
  assert.deepEqual(await (await h.win.fetch('/api/private')).json(), { fake: 'current' });
  assert.equal(calls, 3);
  assert.equal(new URL(h.calls[1].url).pathname, '/api/auth/me');
  assert.equal(h.calls[1].cache, 'no-store', 'the new native incarnation is verified without any offline copy');
  assert.equal(h.calls[1].headers.get(SCOPE_HEADER), null);
  assert.equal(h.calls[2].cache, 'no-cache');
  assert.equal(h.calls[2].headers.get(SCOPE_HEADER), A);
});


test('normal native renewal coalesces fresh verification before concurrent ordinary reads', async () => {
  const verified = deferred();
  const h = page({ native: true, fetcher: async req => {
    if (new URL(req.url).pathname === '/api/auth/me') {
      await verified.promise;
      h.setCookie(B); // Real middleware can renew the hint before fetch resolves.
      return json({ user: { id: 101 } }, B,
        { headers: { 'X-Usernode-Cache-Expires': new Date(Date.now() + 86400_000).toISOString() } });
    }
    return json({ fake: 'same viewer, rotated session' }, B);
  } });
  h.win.UsernodeReact.apiCache.setViewer(101);
  h.renewal.epoch++;
  const first = h.win.fetch('/api/private'), second = h.win.fetch('/api/private');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1, 'both callers wait for one identity verification');
  assert.equal(new URL(h.calls[0].url).pathname, '/api/auth/me');
  assert.equal(h.calls[0].cache, 'no-store');
  assert.equal(h.calls[0].headers.get(SCOPE_HEADER), null);
  verified.resolve();
  for (const res of await Promise.all([first, second])) {
    assert.deepEqual(await res.json(), { fake: 'same viewer, rotated session' });
  }
  for (const req of h.calls.slice(1)) {
    assert.equal(req.headers.get(SCOPE_HEADER), B);
    assert.equal(req.cache, 'no-cache');
  }
  await h.win.fetch('/api/private');
  assert.equal(h.calls.length, 4, 'later reads reuse the verified epoch without another /me');
});

test('native verification cannot admit another viewer or overwrite a later identity boundary', async t => {
  for (const superseded of ['viewer', 'logout', 'renewal', 'cookie']) await t.test(superseded, async () => {
    const held = deferred();
    const h = page({ native: true, fetcher: () => held.promise });
    h.win.UsernodeReact.apiCache.setViewer(101);
    h.renewal.epoch++;
    const pending = h.win.fetch('/api/private');
    await new Promise(resolve => setImmediate(resolve));
    if (superseded === 'logout') h.win.UsernodeReact.apiCache.reset();
    if (superseded === 'renewal') h.renewal.epoch++;
    if (superseded === 'cookie') h.setCookie('c'.repeat(64));
    held.resolve(json({ user: { id: superseded === 'viewer' ? 202 : 101 } }, B,
      { headers: { 'X-Usernode-Cache-Expires': new Date(Date.now() + 86400_000).toISOString() } }));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(h.calls.length, 1, 'no private request follows failed verification');
    assert.equal(readApiCacheScope(h.win.document), superseded === 'cookie' ? 'c'.repeat(64) : A);
  });
});

test('a failed native verification permits a later retry without reopening the former partition', async () => {
  let working = false;
  const h = page({ native: true, fetcher: async req => {
    if (!working) throw new TypeError('synthetic verification offline');
    return json(new URL(req.url).pathname === '/api/auth/me' ? { user: { id: 101 } } : { fake: 'current' }, B,
      { headers: { 'X-Usernode-Cache-Expires': new Date(Date.now() + 86400_000).toISOString() } });
  } });
  h.win.UsernodeReact.apiCache.setViewer(101);
  h.renewal.epoch++;
  await assert.rejects(h.win.fetch('/api/private'), /verification offline/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].cache, 'no-store');
  working = true;
  assert.deepEqual(await (await h.win.fetch('/api/private')).json(), { fake: 'current' });
  assert.equal(h.calls.at(-1).headers.get(SCOPE_HEADER), B);
});


test('an explicit native /me tolerates its own middleware cookie renewal without a duplicate check', async () => {
  const h = page({ native: true, fetcher: async () => {
    h.setCookie(B);
    return json({ user: { id: 101 } }, B,
      { headers: { 'X-Usernode-Cache-Expires': new Date(Date.now() + 86400_000).toISOString() } });
  } });
  h.win.UsernodeReact.apiCache.setViewer(101);
  h.renewal.epoch++;
  assert.deepEqual(await (await h.win.fetch('/api/auth/me')).json(), { user: { id: 101 } });
  assert.equal(h.calls.length, 1);
  assert.equal(readApiCacheScope(h.win.document), B);
});


test('an explicit /me can finish after concurrent automatic verification of the same native session', async () => {
  const explicit = deferred();
  let checks = 0;
  const confirmed = () => json({ user: { id: 101 } }, B,
    { headers: { 'X-Usernode-Cache-Expires': new Date(Date.now() + 86400_000).toISOString() } });
  const h = page({ native: true, fetcher: async req => {
    if (new URL(req.url).pathname !== '/api/auth/me') return json({ fake: 'current' }, B);
    if (++checks === 1) return explicit.promise;
    h.setCookie(B);
    return confirmed();
  } });
  h.win.UsernodeReact.apiCache.setViewer(101);
  h.renewal.epoch++;
  const me = h.win.fetch('/api/auth/me');
  assert.deepEqual(await (await h.win.fetch('/api/private')).json(), { fake: 'current' });
  explicit.resolve(confirmed());
  assert.deepEqual(await (await me).json(), { user: { id: 101 } });
});

test('aborting one native verification waiter settles it without cancelling another reader', async () => {
  const held = deferred();
  const h = page({ native: true, fetcher: req => new URL(req.url).pathname === '/api/auth/me'
    ? held.promise : Promise.resolve(json({ fake: 'current' }, B)) });
  h.win.UsernodeReact.apiCache.setViewer(101);
  h.renewal.epoch++;
  const controller = new AbortController();
  const cancelled = h.win.fetch('/api/private', { signal: controller.signal });
  const other = h.win.fetch('/api/private');
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort();
  await rejected; // Verification is still held: cancellation cannot wait on its body.
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, false, 'shared verification remains available');
  held.resolve(json({ user: { id: 101 } }, B,
    { headers: { 'X-Usernode-Cache-Expires': new Date(Date.now() + 86400_000).toISOString() } }));
  assert.deepEqual(await (await other).json(), { fake: 'current' });
  assert.equal(h.calls.length, 2, 'only the uncancelled private request is sent');
});


test('HTTPS cache identity ignores legacy hints and refuses ambiguous protected hints', async () => {
  const legacy = { cookie: `usernode_api_scope=${A}` };
  assert.equal(readApiCacheScope(legacy), null);
  assert.equal(readApiCacheScope(legacy, false), A, 'HTTP development retains its own cookie');
  assert.equal(readApiCacheScope({ cookie: `usernode_api_scope=${B}; __Host-usernode_api_scope=${A}` }), A);
  assert.equal(readApiCacheScope({ cookie: `__Host-usernode_api_scope=${A}; __Host-usernode_api_scope=${B}` }), null);
  const h = page();
  h.win.document.cookie = `usernode_api_scope=${A}`;
  await h.win.fetch('/api/private');
  assert.equal(h.calls[0].headers.has(SCOPE_HEADER), false, 'legacy hints never opt HTTPS into offline replay');
});


// A Homeroom preview's hint is a partitioned cookie (browser-session-cookies.js).
// A document.cookie write of the same name is a second, unpartitioned cookie,
// kept beside it rather than replacing it, so the jar below keeps both. The
// failing check this pins: the staking sheet's epoch read, in flight while
// /me answered, was fenced and the sheet never drew epoch 128.
test("a /me naming the hint already in the jar writes no second copy beside a preview's partitioned one", async () => {
  const partitioned = `__Host-usernode_api_scope=${A}`;
  const written = [];
  const held = deferred();
  const win = {
    document: {
      get cookie() { return [partitioned, ...written.map(value => value.split(';')[0])].join('; '); },
      set cookie(value) { written.push(value); },
    },
    location: { href: ORIGIN + '/', origin: ORIGIN, reload() {} },
    addEventListener() {},
    localStorage: { setItem() {} },
    fetch: async req => new URL(req.url).pathname === '/api/auth/me'
      ? json({ user: { id: 101 } }, A,
        { headers: { 'X-Usernode-Cache-Expires': new Date(Date.now() + 86400_000).toISOString() } })
      : held.promise,
  };
  installApiCacheIdentity(win);
  const read = win.fetch('/api/private');
  assert.deepEqual(await (await win.fetch('/api/auth/me')).json(), { user: { id: 101 } });
  assert.deepEqual(written, [], 'the server already set this label: nothing to bootstrap');
  assert.equal(readApiCacheScope(win.document), A);
  held.resolve(json({ fake: 'epoch 128' }, A));
  assert.deepEqual(await (await read).json(), { fake: 'epoch 128' }, 'the read in flight is not fenced');
});

test('plain HTTP development keeps its unprefixed cache partition', async () => {
  const h = page({ href: 'http://127.0.0.1:3000/' });
  assert.deepEqual(await (await h.win.fetch('/api/private')).json(), { fake: 'A' });
  assert.equal(h.calls[0].headers.get(SCOPE_HEADER), A);
  assert.equal(readApiCacheScope(h.win.document, false), A);
  assert.equal(readApiCacheScope(h.win.document, true), null);
});


// ─── Shared reads (request 7165) ────────────────────────────────────
// One load of Home read the project list eleven times. Readers of the same
// address now share one request, and for a few seconds one answer. Each
// test counts what reached the network (`h.calls`).

const paths = h => h.calls.map(req => new URL(req.url).pathname + new URL(req.url).search);
const fresh = () => json({ apps: [{ slug: 'plant-pal' }] });

test('the shared reads are the startup reads Home repeated, and nothing else', () => {
  assert.deepEqual(SHARED_READS.map(entry => entry.route), [
    '/api/apps', '/api/me/home-pins', '/api/workshop/counts', '/api/me/app-allowance',
    '/api/ai/tracks', '/api/auth/me', '/api/version',
  ]);
  assert.equal(sharedReadKeep('/api/apps'), SHARED_READ_KEEP_MS);
  assert.equal(sharedReadKeep('/api/auth/me'), 0, 'the account check is shared in flight only');
  assert.equal(sharedReadKeep('/api/version'), 0, 'the version check is shared in flight only');
  assert.equal(sharedReadKeep('/api/ai/tracks'), 0);
  assert.equal(sharedReadKeep('/api/apps/plant-pal'), null, 'one project is not the list');
  assert.equal(sharedReadKeep('/api/me/home-pins/activity'), null);
  assert.equal(sharedReadKeep('/api/private'), null);
  assert.ok(SHARED_READ_KEEP_MS <= 3000, 'a kept answer is seconds old at most');
});

test('readers of one address at the same moment make one request, and each gets its own copy', async () => {
  const held = deferred();
  const h = page({ fetcher: () => held.promise });
  const readers = Array.from({ length: 11 }, () => h.win.fetch('/api/apps'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1, 'eleven readers, one request');
  held.resolve(fresh());
  const bodies = await Promise.all(readers.map(async read => (await read).json()));
  for (const body of bodies) assert.deepEqual(body, { apps: [{ slug: 'plant-pal' }] });
  assert.notEqual(bodies[0], bodies[1], 'no parsed object is shared');
  bodies[0].apps.push('mine');
  assert.equal(bodies[1].apps.length, 1, 'a reader that changes its answer changes nobody else\'s');
  assert.equal(h.calls.length, 1);
});

test('one load of Home reads each repeated address once', async () => {
  const h = page({ fetcher: async () => fresh() });
  const home = ['/api/apps', '/api/me/home-pins', '/api/workshop/counts', '/api/me/app-allowance'];
  // Each reader's own options, as the stores send them: the allowance
  // store refuses a saved copy, the pins store revalidates the counts.
  const init = path => path === '/api/me/app-allowance' ? { credentials: 'same-origin', cache: 'no-store' }
    : path === '/api/workshop/counts' ? { credentials: 'same-origin', cache: 'no-cache' } : undefined;
  // A burst, then the readers that come a moment after the first answer.
  await Promise.all(home.flatMap(path => [h.win.fetch(path, init(path)), h.win.fetch(path, init(path)), h.win.fetch(path)])
    .map(async read => (await read).json()));
  for (let i = 0; i < 3; i++) {
    for (const path of home) await (await h.win.fetch(path, init(path))).json();
  }
  assert.deepEqual(paths(h).sort(), [...home].sort());
});

test('a kept answer is a few seconds old at most, by the clock', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const h = page({ fetcher: async () => fresh() });
  await (await h.win.fetch('/api/apps')).json();
  t.mock.timers.tick(SHARED_READ_KEEP_MS - 1);
  await (await h.win.fetch('/api/apps')).json();
  assert.equal(h.calls.length, 1, 'still the kept answer');
  t.mock.timers.tick(1);
  await (await h.win.fetch('/api/apps')).json();
  assert.equal(h.calls.length, 2, 'past its time the server is asked again');
  // A frozen page runs no timer: the clock alone still ends the answer.
  t.mock.timers.setTime(Date.now() + 60_000);
  await (await h.win.fetch('/api/apps')).json();
  assert.equal(h.calls.length, 3);
});

test('a different query, a single project and an unlisted read are never shared', async () => {
  const h = page({ fetcher: async () => fresh() });
  for (const path of ['/api/apps', '/api/apps?scope=joined', '/api/apps?demo=1', '/api/apps/plant-pal',
    '/api/apps/plant-pal', '/api/private', '/api/private']) {
    await (await h.win.fetch(path)).json();
  }
  assert.equal(h.calls.length, 7);
});

test('the app\'s own write drops every kept answer, when it starts and when it answers', async () => {
  let n = 0;
  const write = deferred();
  const h = page({ fetcher: req => req.method === 'POST' ? write.promise : Promise.resolve(json({ n: ++n })) });
  assert.deepEqual(await (await h.win.fetch('/api/me/home-pins')).json(), { n: 1 });
  const pin = h.win.fetch('/api/me/home-pins/plant-pal', { method: 'POST' });
  assert.deepEqual(await (await h.win.fetch('/api/me/home-pins')).json(), { n: 2 },
    'a read after the write began is not answered from before it');
  write.resolve(json({ ok: true }));
  await pin;
  assert.deepEqual(await (await h.win.fetch('/api/me/home-pins')).json(), { n: 3 },
    'nor is one after it answered, from a read that raced it');
  assert.deepEqual(await (await h.win.fetch('/api/me/home-pins')).json(), { n: 3 });
});

test('a read still on its way when a write lands is finished for its readers and not kept', async () => {
  const slow = deferred();
  let n = 0;
  const h = page({ fetcher: req => req.method !== 'GET' ? Promise.resolve(json({ ok: true }))
    : ++n === 1 ? slow.promise : Promise.resolve(json({ n })) });
  const early = h.win.fetch('/api/workshop/counts');
  await (await h.win.fetch('/api/apps/plant-pal/vote', { method: 'POST' })).json();
  const late = h.win.fetch('/api/workshop/counts');
  slow.resolve(json({ n: 'before the vote' }));
  assert.deepEqual(await (await early).json(), { n: 'before the vote' });
  assert.deepEqual(await (await late).json(), { n: 2 }, 'the reader after the vote asked the server');
  assert.deepEqual(await (await h.win.fetch('/api/workshop/counts')).json(), { n: 2 });
});

test('the interface\'s own measurements are not a write that drops shared answers', async () => {
  const h = page({ fetcher: async () => fresh() });
  await (await h.win.fetch('/api/apps')).json();
  await h.win.fetch('/api/ui-telemetry/batch', { method: 'POST', body: '{}' });
  await (await h.win.fetch('/api/apps')).json();
  assert.deepEqual(paths(h), ['/api/apps', '/api/ui-telemetry/batch']);
});

test('nothing is shared across accounts: a reset, a viewer change and a new partition each ask again', async () => {
  let n = 0;
  const h = page({ fetcher: async req => json({ n: ++n }, readApiCacheScope(h.win.document) || A) });
  h.win.UsernodeReact.apiCache.setViewer(101);
  assert.deepEqual(await (await h.win.fetch('/api/apps')).json(), { n: 1 });
  h.win.UsernodeReact.apiCache.reset();
  assert.deepEqual(await (await h.win.fetch('/api/apps')).json(), { n: 2 }, 'a session reset');
  h.win.UsernodeReact.apiCache.setViewer(202);
  assert.deepEqual(await (await h.win.fetch('/api/apps')).json(), { n: 3 }, 'another viewer');
  h.setCookie(B);
  assert.deepEqual(await (await h.win.fetch('/api/apps')).json(), { n: 4 }, 'another partition');
  await h.win.fetch('/api/auth/logout', { method: 'POST' });
  assert.deepEqual(await (await h.win.fetch('/api/apps')).json(), { n: 6 }, 'a sign-out');
});

test('a sign-out while a shared read is on its way fences every reader of it', async () => {
  const held = deferred();
  const h = page({ fetcher: () => held.promise });
  const readers = [h.win.fetch('/api/apps'), h.win.fetch('/api/apps')];
  h.setCookie(B);
  held.resolve(json({ private: 'FAKE_OLD_A' }));
  for (const read of readers) await assert.rejects(read, { name: 'AbortError' });
});

test('a failed answer reaches the readers waiting on it and is never kept', async () => {
  let n = 0;
  const first = deferred();
  const h = page({ fetcher: () => ++n === 1 ? first.promise
    : n === 2 ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(json({ n })) });
  const readers = [h.win.fetch('/api/apps'), h.win.fetch('/api/apps')];
  first.resolve(json({ error: 'down' }, A, { status: 503 }));
  for (const read of readers) assert.equal((await read).status, 503);
  await assert.rejects(h.win.fetch('/api/apps'), TypeError, 'a retry asks again, and a network failure is not kept either');
  assert.deepEqual(await (await h.win.fetch('/api/apps')).json(), { n: 3 });
  assert.equal(h.calls.length, 3);
});

test('the account check and the version check are shared in flight and never kept', async () => {
  for (const path of ['/api/auth/me', '/api/version', '/api/ai/tracks']) {
    const held = deferred();
    let n = 0;
    const h = page({ fetcher: () => ++n === 1 ? held.promise : Promise.resolve(json({ n })) });
    const readers = [h.win.fetch(path), h.win.fetch(path)];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, 1, `${path}: one request for two readers`);
    held.resolve(json({ n: 1 }));
    for (const read of readers) assert.deepEqual(await (await read).json(), { n: 1 });
    assert.deepEqual(await (await h.win.fetch(path)).json(), { n: 2 }, `${path}: the next reader asks the server`);
  }
});

test('a token request and a request without credentials never share', async () => {
  const h = page({ fetcher: async () => fresh() });
  await (await h.win.fetch('/api/apps')).json();
  await (await h.win.fetch('/api/apps', { headers: { authorization: 'Bearer fake' } })).json();
  await (await h.win.fetch('/api/apps', { headers: { authorization: 'Bearer fake' } })).json();
  await (await h.win.fetch('/api/apps', { credentials: 'omit' })).json();
  await (await h.win.fetch('/api/apps', { credentials: 'omit' })).json();
  await (await h.win.fetch('/api/apps')).json();
  assert.equal(h.calls.length, 5, 'only the plain signed-in read was answered from the kept one');
});

test('a reload read sends its own request, and its answer is the one kept', async () => {
  let n = 0;
  const h = page({ fetcher: async () => json({ n: ++n }) });
  assert.deepEqual(await (await h.win.fetch('/api/apps')).json(), { n: 1 });
  assert.deepEqual(await (await h.win.fetch('/api/apps', { cache: 'reload' })).json(), { n: 2 });
  assert.deepEqual(await (await h.win.fetch('/api/apps')).json(), { n: 2 });
});

test('a reader that refuses a saved copy never joins a request that may be answered from one', async () => {
  const first = deferred(), second = deferred();
  let n = 0;
  const h = page({ fetcher: () => ++n === 1 ? first.promise : second.promise });
  const lenient = h.win.fetch('/api/workshop/counts');
  const strict = h.win.fetch('/api/workshop/counts', { cache: 'no-store' });
  const after = h.win.fetch('/api/workshop/counts');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.map(req => req.cache), ['no-cache', 'no-store']);
  first.resolve(json({ from: 'maybe saved' }));
  second.resolve(json({ from: 'the server' }));
  assert.deepEqual(await (await lenient).json(), { from: 'maybe saved' });
  assert.deepEqual(await (await strict).json(), { from: 'the server' });
  assert.deepEqual(await (await after).json(), { from: 'the server' }, 'a lenient reader may join the strict one');
});

test('one reader giving up rejects that reader alone, and the request stops only when all have', async () => {
  const held = deferred();
  const h = page({ fetcher: () => held.promise });
  const a = new AbortController(), b = new AbortController();
  const first = h.win.fetch('/api/apps', { signal: a.signal });
  const second = h.win.fetch('/api/apps', { signal: b.signal });
  await new Promise(resolve => setImmediate(resolve));
  a.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(h.calls[0].signal.aborted, false, 'the other reader still waits on it');
  held.resolve(fresh());
  assert.deepEqual(await (await second).json(), { apps: [{ slug: 'plant-pal' }] });

  const stuck = deferred();
  const g = page({ fetcher: () => stuck.promise });
  const c = new AbortController(), d = new AbortController();
  const readers = [g.win.fetch('/api/apps', { signal: c.signal }), g.win.fetch('/api/apps', { signal: d.signal })];
  await new Promise(resolve => setImmediate(resolve));
  c.abort(); d.abort();
  for (const read of readers) await assert.rejects(read, { name: 'AbortError' });
  assert.equal(g.calls[0].signal.aborted, true, 'nobody is waiting: the request is stopped');
  stuck.resolve(fresh());
  const next = g.win.fetch('/api/apps');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(g.calls.length, 2, 'and the next reader starts a new one');
  void next.catch(() => {});
});

test('forget() drops every shared answer: a pull to refresh and news from the server ask again', async () => {
  let n = 0;
  const h = page({ fetcher: async () => json({ n: ++n }) });
  assert.deepEqual(await (await h.win.fetch('/api/apps')).json(), { n: 1 });
  h.win.UsernodeReact.apiCache.forget();
  assert.deepEqual(await (await h.win.fetch('/api/apps')).json(), { n: 2 });
  assert.deepEqual(await (await h.win.fetch('/api/apps')).json(), { n: 2 });
});

test('app.js forgets the shared answers on a pull, on news from the events socket and on a reconnect', () => {
  const appJs = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public/js/app.js'), 'utf8');
  const pull = appJs.slice(appJs.indexOf('  _refreshOrReload(refresh) {'), appJs.indexOf('  _announceRefreshIntent() {'));
  assert.match(pull, /App\._announceRefreshIntent\(\);\s*return Promise\.all\(\[\s*Promise\.resolve\(\)\.then\(refresh\)/,
    'the announcement goes before the screen\'s own reads start');
  const announce = appJs.slice(appJs.indexOf('  _announceRefreshIntent() {'), appJs.indexOf('  _apiUpdateTimer: null,'));
  assert.match(announce, /try \{ window\.UsernodeReact\?\.apiCache\?\.forget\?\.\(\); \} catch/,
    'and it drops the shared answers, so a pull always asks the server');
  const socket = appJs.slice(appJs.indexOf('App.eventsWs.onmessage = (event) => {'), appJs.indexOf("case 'resync_hint':"));
  assert.match(socket, /if \(data\.type !== 'pong'\) window\.UsernodeReact\?\.apiCache\?\.forget\?\.\(\);[\s\S]*switch \(data\.type\)/,
    'before any handler re-reads because of the frame');
  assert.match(appJs, /if \(isReconnect\) window\.UsernodeReact\?\.apiCache\?\.forget\?\.\(\);\s*if \(isReconnect\) App\.resyncCurrentView\(\);/);
});
