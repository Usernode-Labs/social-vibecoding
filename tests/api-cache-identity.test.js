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
  assert.equal(h.calls[2].cache, 'reload');
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
    assert.equal(req.cache, 'reload');
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

// ── The guard reports each fence ───────────────────────────────────────
const { fencePath, createFenceLog } = loadTsx('frontend/src/lib/api-cache-identity.ts');

test('fencePath drops the query, replaces tokens and ids, and never reports telemetry', () => {
  assert.equal(fencePath(`/api/public/invites/${'A'.repeat(22)}?utm=x#frag`), '/api/public/invites/<token>');
  assert.equal(fencePath('/api/apps/42/issues?page=2'), '/api/apps/<id>/issues');
  assert.equal(fencePath('/api/apps/run-club/issue/deadbeef1234'), '/api/apps/run-club/issue/<id>');
  assert.equal(fencePath('/api/public/profiles/ada%20lovelace'), '/api/public/profiles/<value>');
  assert.equal(fencePath('/api/ui-telemetry/batch'), null);
  assert.equal(fencePath('/brand/people.png'), null);
  assert.equal(fencePath(`/api/${'a.b'.repeat(100)}`).length, 160);
  assert.equal(fencePath('/api/public/profiles/ada?token=secret'), '/api/public/profiles/ada');
});

function fenceLog() {
  const timers = [];
  const reports = [];
  const log = createFenceLog({
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    deliver: (report) => reports.push(report),
  });
  return { log, reports, timers };
}

test('one page load folds a burst into one report per signed-in group, with counts', () => {
  const { log, reports } = fenceLog();
  for (let i = 0; i < 3; i += 1) log.note('/api/private?page=1', 'epoch', true);
  log.note('/api/public/invites/abcdefghijklmnopqrstuv', 'scope', false);
  log.note('/api/private', 'scope', true);
  log.close();
  assert.equal(reports.length, 2);
  const signedIn = reports.find((r) => r.signedIn === true);
  const signedOut = reports.find((r) => r.signedIn === false);
  assert.deepEqual(signedIn.fences.find((f) => f.path === '/api/private'),
    { path: '/api/private', reason: 'epoch', public: false, count: 3 }, 'the query never reaches the report');
  assert.equal(signedIn.fences.find((f) => f.path === '/api/private').count, 3);
  assert.deepEqual(signedOut.fences[0], {
    path: '/api/public/invites/<token>', reason: 'scope', public: true, count: 1,
  }, 'a link code is replaced and the public flag is set');
});

test('at most eight paths a group and three windows a page load', () => {
  const { log, reports } = fenceLog();
  for (let i = 0; i < 9; i += 1) log.note(`/api/path${i}`, 'scope', false);
  log.close();
  assert.equal(reports[0].fences.length, 8);
  for (let w = 0; w < 3; w += 1) { log.note('/api/late', 'native', false); log.close(); }
  log.note('/api/late/again', 'native', false);
  log.close();
  assert.equal(reports.length, 3, 'three windows a page load, then nothing more');
});

test('a replaced cookie, a reset and a moved native session are told apart', async () => {
  const scope = page({ fetcher: async () => json({ fake: 'B' }, B) });
  const scopeReports = [];
  scope.win.UITelemetry = { reportFence: (r) => scopeReports.push(r) };
  const cookieHeld = deferred();
  const viaCookie = page({ fetcher: () => cookieHeld.promise });
  viaCookie.win.UITelemetry = { reportFence: (r) => scopeReports.push(r) };
  const reading = viaCookie.win.fetch('/api/private');
  viaCookie.setCookie(B);
  cookieHeld.resolve(json({ fake: 'B' }));
  await assert.rejects(reading, { name: 'AbortError' });
  viaCookie.handlers.pagehide();
  assert.equal(scopeReports[0].fences[0].reason, 'scope');

  const epochReports = [];
  const held = deferred();
  const h = page({ fetcher: () => held.promise });
  h.win.UITelemetry = { reportFence: (r) => epochReports.push(r) };
  const pending = h.win.fetch('/api/private');
  h.win.UsernodeReact.apiCache.reset();
  held.resolve(json({ fake: 'A' }));
  await assert.rejects(pending, { name: 'AbortError' });
  h.handlers.pagehide();
  assert.equal(epochReports[0].fences[0].reason, 'epoch');

  const nativeReports = [];
  const nativeHeld = deferred();
  const n = page({ native: true, fetcher: () => nativeHeld.promise });
  n.win.UITelemetry = { reportFence: (r) => nativeReports.push(r) };
  const nativeRead = n.win.fetch('/api/private');
  n.renewal.epoch += 1;
  nativeHeld.resolve(json({ fake: 'A' }));
  await assert.rejects(nativeRead, { name: 'AbortError' });
  n.handlers.pagehide();
  assert.equal(nativeReports[0].fences[0].reason, 'native');
  assert.equal(nativeReports[0].signedIn, true);
});

test('a fenced public read is reported signed out and public', async () => {
  const reports = [];
  const held = deferred();
  const p = page({ initial: null, native: true, fetcher: () => held.promise });
  p.win.UITelemetry = { reportFence: (r) => reports.push(r) };
  const read = p.win.fetch('/api/public/profiles/ada');
  p.renewal.epoch += 1;
  held.resolve(json({ fake: 'A' }, ''));
  await assert.rejects(read, { name: 'AbortError' });
  p.handlers.pagehide();
  const entry = reports[0].fences[0];
  assert.deepEqual([entry.path, entry.public, reports[0].signedIn], ['/api/public/profiles/ada', true, false]);
});
