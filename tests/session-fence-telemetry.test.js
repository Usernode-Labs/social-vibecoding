'use strict';

// #6002: the session guard reports the reads it cuts off, one report per
// window of a page load, with no query, link code or id in it; the collector
// keeps only the route template; a signed-out page's reports travel on the
// anonymous route; invite pages report where they settled; and the
// platform signal files the fences that should never happen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');
const { A, B, deferred, json, ORIGIN } = require('./lib/private-cache-worker');
const {
  installApiCacheIdentity, fencePath, createFenceLog,
  FENCE_WINDOW_MS, FENCE_BUDGET_MS, MAX_FENCE_WINDOWS, MAX_FENCE_PATHS, MAX_FENCE_ENTRIES,
} = loadTsx('frontend/src/lib/api-cache-identity.ts');
const telemetry = require('../src/services/ui-telemetry');
const { createUITelemetry, sessionFence } = require('../public/js/ui-telemetry');
const fences = require('../src/services/signal-observers/session-fences');
const signals = require('../src/services/platform-signals');
const observers = require('../src/services/platform-signal-observers');
const journey = require('../src/services/journey');

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 URL-safe characters, an invite code's shape

let n = 0;
const ev = (over) => ({
  id: `event-test-${String(++n).padStart(12, '0')}`, visitId: 'visit-test-000000000001', screen: 'shell_boot',
  occurredAt: new Date().toISOString(), sequence: n, ...over,
});
const body = (events) => ({ schemaVersion: 2, batchId: `batch-test-${String(++n).padStart(12, '0')}`, events,
  delivery: { failedBatches: 0, droppedEvents: 0 } });

function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    get pending() { return timers.size; },
    now: () => now,
  };
}

// ── The report's shape ────────────────────────────────────────────────────

test('fencePath keeps no query, hash, link code, id or unusual value', () => {
  assert.equal(fencePath(`/api/public/invites/${TOKEN}`), '/api/public/invites/<token>');
  assert.equal(fencePath(`/api/public/invites/${TOKEN}/picture?v=3&email=a@b.c#x`), '/api/public/invites/<token>/picture');
  assert.equal(fencePath('/api/apps/12345/discussion'), '/api/apps/<id>/discussion');
  assert.equal(fencePath('/api/sessions/0f8c2a1e-1b2c-4d5e-8f90-1234567890ab'), '/api/sessions/<id>');
  assert.equal(fencePath('/api/users/deadbeefcafe'), '/api/users/<id>');
  assert.equal(fencePath('/api/search/hello%20world'), '/api/search/<value>');
  assert.equal(fencePath('/api/x/' + 'a'.repeat(300)).length <= 160, true);
  for (const path of ['/api/a?token=SECRET', `/api/b/${TOKEN}?q=1`]) {
    const out = fencePath(path);
    assert.doesNotMatch(out, /[?#]|SECRET|q=1/);
    assert.doesNotMatch(out, /[A-Za-z0-9_-]{22,}/);
  }
});

test('the client and the collector refuse a path that still holds a code or a query', () => {
  const ok = sessionFence.entries([{ path: '/api/public/invites/<token>', reason: 'epoch', count: 2 }]);
  assert.deepEqual(ok, [{ path: '/api/public/invites/<token>', reason: 'epoch', public: true, count: 2 }]);
  for (const bad of [
    [{ path: `/api/public/invites/${TOKEN}`, reason: 'epoch', count: 1 }],
    [{ path: '/api/public/invites/<token>?x=1', reason: 'epoch', count: 1 }],
    [{ path: '/api/a', reason: 'other', count: 1 }],
    [{ path: '/api/a', reason: 'scope', count: 0 }],
    [],
  ]) assert.equal(sessionFence.entries(bad), null, JSON.stringify(bad));
});

// ── Per-load aggregation ──────────────────────────────────────────────────

test('a burst of fences on one page load is one report per signed-in group, counted', () => {
  const c = clock();
  const reports = [];
  const log = createFenceLog({ setTimer: c.setTimer, clearTimer: c.clearTimer, deliver: (r) => reports.push(r) });
  for (let i = 0; i < 5; i += 1) log.note(`/api/public/invites/${TOKEN}`, 'epoch', false);
  log.note('/api/me/home?x=1', 'epoch', true);
  log.note('/api/me/home', 'epoch', true);
  assert.equal(reports.length, 0, 'nothing is sent while the window is open');
  c.advance(FENCE_WINDOW_MS);
  assert.deepEqual(reports, [
    { signedIn: false, fences: [{ path: '/api/public/invites/<token>', reason: 'epoch', public: true, count: 5 }] },
    { signedIn: true, fences: [{ path: '/api/me/home', reason: 'epoch', public: false, count: 2 }] },
  ]);
});

test('a hidden page closes the window at once; three windows in ten minutes, then the budget rolls', () => {
  const c = clock();
  const reports = [];
  const log = createFenceLog({ setTimer: c.setTimer, clearTimer: c.clearTimer, deliver: (r) => reports.push(r), now: c.now });
  for (let w = 0; w < MAX_FENCE_WINDOWS + 2; w += 1) {
    log.note('/api/a', 'scope', true);
    log.close();
  }
  assert.equal(reports.length, MAX_FENCE_WINDOWS);
  assert.equal(c.pending, 0);
  // A page kept open: once the oldest window is ten minutes old, a later
  // burst is reported again.
  c.advance(FENCE_BUDGET_MS);
  log.note('/api/a', 'scope', true);
  log.close();
  assert.equal(reports.length, MAX_FENCE_WINDOWS + 1);
});

test('past the named paths a read counts in its own reason\'s and kind\'s overflow, never under another entry', () => {
  const c = clock();
  const reports = [];
  const log = createFenceLog({ setTimer: c.setTimer, clearTimer: c.clearTimer, deliver: (r) => reports.push(r) });
  for (let i = 0; i < MAX_FENCE_PATHS; i += 1) log.note(`/api/p${i}`, 'epoch', true);
  log.note('/api/q1', 'epoch', true);
  log.note('/api/q2', 'epoch', true);
  log.note('/api/public/apps', 'scope', true); // a public read past the cap stays public
  log.note('/api/public/x', 'native', true);
  log.close();
  const fences = reports[0].fences;
  assert.ok(fences.length <= MAX_FENCE_ENTRIES);
  const named = fences.filter((f) => !f.path.endsWith('/<other>'));
  assert.equal(named.length, MAX_FENCE_PATHS);
  assert.ok(named.every((f) => f.count === 1 && f.reason === 'epoch' && f.public === false), 'no named entry took another read');
  assert.deepEqual(fences.filter((f) => f.path.endsWith('/<other>')), [
    { path: '/api/<other>', reason: 'epoch', public: false, count: 2 },
    { path: '/api/public/<other>', reason: 'scope', public: true, count: 1 },
    { path: '/api/public/<other>', reason: 'native', public: true, count: 1 },
  ]);
  // The client accepts the report, and the collector keeps the overflow as
  // public: /api/public/<other> is /api/public/…
  assert.ok(sessionFence.entries(fences));
  const parsed = telemetry.parseBatch(body([ev({ kind: 'session_fence', signedIn: true, fences })]),
    { routes: ['/api/public/apps'] });
  assert.ok(parsed.events[0].fences.some((f) => f.path === '/api/public/\u2026' && f.public === true));
});

// ── Through the real guard ────────────────────────────────────────────────

function page({ initial = A, fetcher, viewer } = {}) {
  let cookie = initial ? `usernode_api_scope=${initial}` : '';
  const c = clock();
  const reports = [];
  const handlers = {};
  const win = {
    document: { get cookie() { return cookie; }, set cookie(value) { cookie = value.split(';')[0]; } },
    location: { href: ORIGIN + '/', origin: ORIGIN, reload() {} },
    addEventListener(name, callback) { handlers[name] = callback; },
    localStorage: { setItem() {} },
    setTimeout: c.setTimer,
    clearTimeout: c.clearTimer,
    UITelemetry: { reportFence: (r) => reports.push(r) },
    fetch: async (req) => fetcher(req),
  };
  if (viewer !== undefined) win.App = { user: viewer == null ? null : { id: viewer } };
  installApiCacheIdentity(win);
  return { win, c, reports, handlers, setCookie(v) { cookie = v ? `usernode_api_scope=${v}` : ''; } };
}

test('#5931 replayed: a reset during a signed-out public read reports epoch, signed out, public', async () => {
  const held = deferred();
  // A public route that is not on the for-anyone list stays fenced.
  const h = page({ initial: null, fetcher: () => held.promise, viewer: null });
  const read = h.win.fetch(`/api/public/profiles/${TOKEN}?tab=apps`);
  // An unconditional reset on a page nobody signed in to: what #5931 took
  // away from the signed-out boot. Another tab's boundary still does it.
  h.handlers.storage({ key: 'usernode.api-identity-boundary' });
  held.resolve(json({ fake: true }, null));
  await assert.rejects(read, { name: 'AbortError', message: 'Session changed' });
  h.handlers.pagehide();
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].fences[0].path, '/api/public/profiles/<token>');
  assert.equal(h.reports[0].fences[0].reason, 'epoch');
  assert.equal(h.reports[0].fences[0].public, true);
  assert.equal(h.reports[0].signedIn, false);
  assert.equal(JSON.stringify(h.reports).includes(TOKEN), false);
  assert.equal(JSON.stringify(h.reports).includes('tab='), false);
});

test('a replaced cookie is reported as scope, on the body read it cut off, signed in', async () => {
  const h = page({ fetcher: () => Promise.resolve(json({ fake: 'A' })) });
  const res = await h.win.fetch('/api/private/42');
  h.setCookie(B);
  await assert.rejects(res.json(), { name: 'AbortError' });
  h.c.advance(FENCE_WINDOW_MS);
  assert.deepEqual(h.reports, [{ signedIn: true, fences: [{ path: '/api/private/<id>', reason: 'scope', public: false, count: 1 }] }]);
});

test('a caller\'s own abort and an ordinary failure are not fences', async () => {
  const h = page({ fetcher: (req) => new Promise((_, reject) => {
    req.signal.addEventListener('abort', () => reject(req.signal.reason));
  }) });
  const controller = new AbortController();
  const read = h.win.fetch('/api/private', { signal: controller.signal });
  controller.abort();
  await assert.rejects(read);
  const failing = page({ fetcher: () => Promise.reject(new TypeError('network')) });
  await assert.rejects(failing.win.fetch('/api/private'), TypeError);
  h.c.advance(FENCE_WINDOW_MS);
  failing.c.advance(FENCE_WINDOW_MS);
  assert.deepEqual(h.reports, []);
  assert.deepEqual(failing.reports, []);
});

test('a fence still rejects with the same AbortError when reporting throws', async () => {
  const held = deferred();
  const h = page({ fetcher: () => held.promise });
  h.win.UITelemetry = { reportFence() { throw new Error('boom'); } };
  const read = h.win.fetch('/api/private');
  h.setCookie(B);
  held.resolve(json({ fake: 'A' }));
  await assert.rejects(read, { name: 'AbortError' });
  assert.doesNotThrow(() => h.handlers.pagehide());
});

// ── Client telemetry: routing ─────────────────────────────────────────────

function telemetryEnv() {
  const c = clock();
  const sent = [];
  const env = {
    setTimeout: c.setTimer,
    clearTimeout: c.clearTimer,
    fetch: (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return Promise.resolve({ ok: true, status: 202 }); },
    crypto: { randomUUID: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })() },
  };
  return { env, c, sent };
}

test('a signed-out page sends its fence report and invite landing once, anonymously, with no cookie', () => {
  const { env, c, sent } = telemetryEnv();
  const t = createUITelemetry(env);
  t.reportFence({ signedIn: false, fences: [{ path: '/api/public/invites/<token>', reason: 'epoch', public: true, count: 3 }] });
  t.inviteSettled('failed');
  t.inviteSettled('card'); // the first landing wins
  t.reportFence({ signedIn: true, fences: [{ path: '/api/me', reason: 'scope', public: false, count: 1 }] }); // nobody to send it as
  t.reportFence({ signedIn: false, fences: [{ path: `/api/public/invites/${TOKEN}`, reason: 'epoch', count: 1 }] }); // refused
  c.advance(2000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/ui-telemetry/anonymous');
  assert.equal(sent[0].init.credentials, 'omit');
  assert.deepEqual(sent[0].body.events.map((e) => [e.kind, e.settled || null, e.signedIn ?? null]),
    [['session_fence', null, false], ['invite_settlement', 'failed', null]]);
  // What the collector receives parses as an anonymous batch.
  const parsed = telemetry.parseAnonymousBatch(sent[0].body, { routes: ['/api/public/invites/:token'] });
  assert.equal(parsed.events[0].fences[0].path, '/api/public/invites/:token');
  c.advance(10_000);
  assert.equal(sent.length, 1, 'never retried or repeated');
});

test('a held anonymous report is not sent once the person opts out or signs in before it goes', () => {
  for (const user of [{ id: 8, uiTelemetryEligible: false }, { id: 9, uiTelemetryEligible: true }]) {
    const { env, c, sent } = telemetryEnv();
    const t = createUITelemetry(env);
    t.inviteSettled('failed');
    t.reportFence({ signedIn: false, fences: [{ path: '/api/public/apps', reason: 'epoch', public: true, count: 1 }] });
    t.setUser(user, true); // before the 2-second hold ends
    c.advance(10_000);
    assert.equal(sent.filter((s) => s.url === '/api/ui-telemetry/anonymous').length, 0, JSON.stringify(user));
  }
});

test('a signed-in person\'s fence report rides their own queue, and an opted-out one is dropped', () => {
  const { env, sent } = telemetryEnv();
  const t = createUITelemetry(env);
  t.setUser({ id: 5, uiTelemetryEligible: true }, true);
  t.reportFence({ signedIn: true, fences: [{ path: '/api/me', reason: 'native', public: false, count: 1 }] });
  assert.equal(t.diagnostics().queued, 1);
  assert.equal(sent.some((s) => s.url === '/api/ui-telemetry/anonymous'), false);

  const off = telemetryEnv();
  const quiet = createUITelemetry(off.env);
  quiet.setUser({ id: 6, uiTelemetryEligible: false }, true);
  quiet.reportFence({ signedIn: false, fences: [{ path: '/api/a', reason: 'epoch', public: false, count: 1 }] });
  quiet.inviteSettled('card');
  off.c.advance(10_000);
  assert.equal(quiet.diagnostics().queued, 0);
  assert.equal(off.sent.length, 0);
});

// ── Collector ─────────────────────────────────────────────────────────────

const ROUTES = ['/api/public/invites/:token', '/api/public/invites/:token/picture', '/api/public/profiles/:username',
  '/api/apps/:slug', '/api/apps/:slug/discussion'];

test('the collector stores route templates, never a name in an address, and recomputes public', () => {
  const parsed = telemetry.parseBatch(body([ev({ kind: 'session_fence', signedIn: false, fences: [
    { path: '/api/public/profiles/somebody', reason: 'epoch', public: false, count: 2 },
    { path: '/api/public/profiles/someone-else', reason: 'epoch', public: false, count: 3 },
    { path: '/api/apps/my-app/discussion', reason: 'scope', public: true, count: 1 },
    { path: '/api/unknown/thing', reason: 'native', public: false, count: 1 },
    { path: '/api/apps/x/y/z', reason: 'native', public: false, count: 1 },
  ] })]), { routes: ROUTES });
  assert.deepEqual(parsed.events[0].fences, [
    { path: '/api/public/profiles/:username', reason: 'epoch', public: true, count: 5 },
    { path: '/api/apps/:slug/discussion', reason: 'scope', public: false, count: 1 },
    { path: '/api/…', reason: 'native', public: false, count: 1 },
    { path: '/api/apps/…', reason: 'native', public: false, count: 1 },
  ]);
  const stored = JSON.stringify(parsed);
  for (const name of ['somebody', 'someone-else', 'my-app', 'thing']) assert.equal(stored.includes(name), false, name);
});

test('the collector refuses tokens, queries, stray keys, and these keys on other kinds', () => {
  const fence = (f, over = {}) => body([ev({ kind: 'session_fence', signedIn: false, fences: [f], ...over })]);
  for (const bad of [
    fence({ path: `/api/public/invites/${TOKEN}`, reason: 'epoch', public: true, count: 1 }),
    fence({ path: '/api/public/invites/<token>?a=1', reason: 'epoch', public: true, count: 1 }),
    fence({ path: '/api/a', reason: 'epoch', public: false, count: 1, extra: 1 }),
    fence({ path: '/api/a', reason: 'epoch', public: false, count: 1 }, { appSlug: 'a' }),
    body([ev({ kind: 'invite_settlement', settled: 'maybe' })]),
    body([ev({ kind: 'invite_settlement', settled: 'card', screen: 'home' })]),
    body([ev({ kind: 'screen_visit', screen: 'home', settled: 'card' })]),
  ]) assert.throws(() => telemetry.parseBatch(bad, { routes: ROUTES }), telemetry.TelemetryValidationError);
});

test('an anonymous batch holds only invite landings and signed-out fences, at most four', () => {
  assert.equal(telemetry.parseAnonymousBatch(body([ev({ kind: 'invite_settlement', settled: 'timeout' })])).events.length, 1);
  for (const bad of [
    body([ev({ kind: 'session_fence', signedIn: true, fences: [{ path: '/api/a', reason: 'epoch', public: false, count: 1 }] })]),
    body([ev({ kind: 'screen_visit', screen: 'home' })]),
    body(Array.from({ length: 5 }, () => ev({ kind: 'invite_settlement', settled: 'card' }))),
  ]) assert.throws(() => telemetry.parseAnonymousBatch(bad), telemetry.TelemetryValidationError);
});

test('the route list is read from the Express app itself', () => {
  const express = require('express');
  const app = express();
  const router = express.Router();
  router.get('/api/public/invites/:token', (_req, res) => res.end());
  router.post('/api/apps/:slug', (_req, res) => res.end());
  app.use(router);
  app.get('/not-api', (_req, res) => res.end());
  app.lazyrouter?.();
  const routes = telemetry.apiRouteTemplates(app);
  assert.deepEqual(routes.sort(), ['/api/apps/:slug', '/api/public/invites/:token']);
  assert.deepEqual(telemetry.apiRouteTemplates(null), []);
});

// ── The platform signal ───────────────────────────────────────────────────

const row = (over) => ({ visit_id: 'v1', source: 's:aaaa', build: 'abcdef1234', signed_in: false, path: '/api/public/invites/:token',
  reason: 'epoch', public: true, count: 2, created_at: new Date().toISOString(), in_hour: true, ...over });

test('one source sending many reports files nothing, however many visit ids it makes up', () => {
  // A forger at one address: fifty made-up visits, all one source.
  const forged = Array.from({ length: 50 }, (_, i) => row({ visit_id: `v${i}`, source: 's:aaaa' }));
  assert.deepEqual(fences.fenceItemsFrom(forged), []);
  // Two sources are not enough either; rows with no source never count.
  assert.deepEqual(fences.fenceItemsFrom([...forged, row({ visit_id: 'w', source: 's:bbbb' }),
    row({ visit_id: 'x', source: null })]), []);
  assert.deepEqual(fences.landingItemsFrom([{ settled: 'failed', n: 500, sources: 1, builds: [] }]), [],
    'five hundred failed landings from one source');
});

test('with no signed-in source, five anonymous networks are needed, not three', () => {
  const anon = (n) => Array.from({ length: n }, (_, i) => row({ visit_id: `a${i}`, source: `s:n${i}` }));
  assert.deepEqual(fences.fenceItemsFrom(anon(4)), []);
  assert.equal(fences.fenceItemsFrom(anon(5)).length, 1);
  assert.equal(fences.fenceItemsFrom([...anon(2), row({ visit_id: 'u', source: 'u:9' })]).length, 1,
    'three sources, one an account');
  assert.deepEqual(fences.landingItemsFrom([{ settled: 'failed', n: 40, sources: 4, signed_in_sources: 0 }]), []);
  assert.equal(fences.landingItemsFrom([{ settled: 'failed', n: 40, sources: 5, signed_in_sources: 0 }]).length, 1);
  assert.equal(fences.landingItemsFrom([{ settled: 'failed', n: 40, sources: 3, signed_in_sources: 1 }]).length, 1);
});

test('session_fence_public files from three distinct sources within the hour, naming the route and the first build', () => {
  const items = fences.fenceItemsFrom([
    row({ visit_id: 'v0', source: 'u:3', build: '1111111aaaa', in_hour: false, created_at: new Date(Date.now() - 3 * 86400000).toISOString() }),
    row({ visit_id: 'v1', source: 's:aaaa' }),
    row({ visit_id: 'v2', source: 'u:7', path: '/api/public/apps' }),
    row({ visit_id: 'v2', source: 'u:7' }),
    row({ visit_id: 'v3', source: 's:cccc' }),
  ]);
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.kind, 'session_fence_public');
  assert.equal(item.key, '/api/public/invites/:token');
  assert.equal(item.occurrences, 3);
  const text = item.evidence.lines.join('\n');
  assert.match(text, /Started with build 1111111/);
  assert.match(text, /Also cut off on the same visits: \/api\/public\/apps/);
  assert.ok(observers.OBSERVERS.some((o) => o.kinds.includes('session_fence_public')));
});

test('both kinds are a person\'s to triage, never the bot\'s', () => {
  assert.equal(signals.KINDS.session_fence_public.fixer, 'person');
  assert.equal(signals.KINDS.invite_pitch_failed.fixer, 'person');
});

test('invite_pitch_failed files at three failed landings from three sources that are at least 2% of the day', () => {
  const rows = (failed, card, sources = 3) => [{ settled: 'failed', n: failed, sources, signed_in_sources: 1, builds: ['abcdef1'] },
    { settled: 'card', n: card, sources: 9, builds: [] }];
  assert.deepEqual(fences.landingItemsFrom(rows(2, 10)), []);
  assert.deepEqual(fences.landingItemsFrom(rows(3, 1000)), [], 'under 2%');
  assert.deepEqual(fences.landingItemsFrom(rows(30, 50, 2)), [], 'two sources');
  const [item] = fences.landingItemsFrom(rows(3, 50));
  assert.equal(item.kind, 'invite_pitch_failed');
  assert.match(item.evidence.lines[0], /the pitch after the read failed 3/);
});

test('an anonymous source is the collector\'s keyed hash of the address and the day, not an address', () => {
  const key = 'k'.repeat(32);
  const now = Date.parse('2026-10-29T12:00:00Z');
  const a = telemetry.anonymousSource('203.0.113.9', { key, now });
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, telemetry.anonymousSource('203.0.113.9', { key, now: now + 3600000 }), 'stable within a day');
  assert.notEqual(a, telemetry.anonymousSource('203.0.113.10', { key, now }));
  assert.notEqual(a, telemetry.anonymousSource('203.0.113.9', { key, now: now + 86400000 }), 'a new one each day');
  // An IPv6 allocation is one source: five addresses in five different /56s
  // of one /48 are one, five different /48s are five.
  const in48 = ['2001:db8:1:0::1', '2001:db8:1:100::2', '2001:db8:1:200::3', '2001:db8:1:ff00::4', '2001:db8:1:ab00:1:2:3:4'];
  const { ipKeyGenerator } = require('express-rate-limit');
  assert.equal(new Set(in48.map((ip) => ipKeyGenerator(ip))).size, 5, 'five different /56s');
  assert.equal(new Set(in48.map((ip) => telemetry.anonymousSource(ip, { key, now }))).size, 1);
  const across = ['2001:db8:1::1', '2001:db8:2::1', '2001:db8:3::1', '2001:db8:4::1', '2001:db8:5::1'];
  assert.equal(new Set(across.map((ip) => telemetry.anonymousSource(ip, { key, now }))).size, 5);
  // IPv4 is unchanged: one address, one source.
  assert.notEqual(telemetry.anonymousSource('203.0.113.9', { key, now }), telemetry.anonymousSource('203.0.113.10', { key, now }));
  // So one /48 never files an anonymous-only signal; five /48s do.
  const rowsFrom = (ips) => ips.map((ip, i) => row({ visit_id: `six${i}`, source: `s:${telemetry.anonymousSource(ip, { key, now })}` }));
  assert.deepEqual(fences.fenceItemsFrom(rowsFrom(in48)), []);
  assert.equal(fences.fenceItemsFrom(rowsFrom(across)).length, 1);
  // A client cannot name its own source.
  assert.throws(() => telemetry.parseAnonymousBatch(body([ev({ kind: 'invite_settlement', settled: 'card', source: 'x' })])),
    telemetry.TelemetryValidationError);
});

// ── The Journey ───────────────────────────────────────────────────────────

test('the invite funnel reads the landings beside unchanged opens', () => {
  const week = { start: '2026-10-26T00:00:00Z', end: '2026-11-02T00:00:00Z' };
  const base = { since: '2026-10-01T00:00:00Z', opened: 40, signed_in: 3, signed_in_by_invite: 2, signed_in_already: 1, joined: 1 };
  const before = journey.inviteFunnelReading(base, { week });
  assert.equal(before.opened, 40);
  assert.equal(before.landed.recorded, false);
  const after = journey.inviteFunnelReading({ ...base, landed_since: '2026-10-29T00:00:00Z',
    landed_card: 30, landed_dead: 2, landed_failed: 1, landed_timeout: 3 }, { week });
  assert.equal(after.opened, 40);
  assert.deepEqual(after.landed, { card: 30, dead: 2, failed: 1, timeout: 3 });
});
