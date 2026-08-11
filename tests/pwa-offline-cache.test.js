// Service-worker cache-durability + network-deadline contract (#1021).
//
// The reported bug had two independent causes and this file pins both:
//
//  1. The API cache name was derived from SW_VERSION, and activate()
//     deletes every `usernode-*` cache that isn't in ALL_CACHES. So every
//     routine service-worker bump silently wiped the cached
//     GET /api/auth/me — the one response an offline boot needs to know
//     the device is signed in. A user who had been offline-capable all
//     week was signed out by a deploy that had nothing to do with them.
//     Fix: a stable un-versioned name, plus a one-time migration of the
//     legacy `usernode-api-v*` names, plus eviction immunity for the
//     session entry (it is the smallest and most valuable thing in there,
//     and oldest-first trimming would eventually drop it).
//
//  2. Every strategy was network-first with NO deadline, so a socket that
//     opened and then stalled — the normal failure mode of a bad mobile
//     link, and the one where `navigator.onLine` still says true — held
//     the navigation and all ~70 shell scripts open indefinitely while a
//     complete cached copy sat unused. That is the reported white screen.
//     Fix: raceNetworkAndCache, a pure function so it can be tested here.
//
// sw.js detects Node via module.exports and skips all self.* wiring, so
// requiring it is safe.
//
// Run with: node --test tests/pwa-offline-cache.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  isImmuneApiRequest,
  raceNetworkAndCache,
  API_CACHE,
  ALL_CACHES,
  LEGACY_API_CACHE_RE,
  IMMUNE_API_PATHS,
  NAVIGATE_TIMEOUT_MS,
  SHELL_TIMEOUT_MS,
  API_TIMEOUT_MS,
} = require('../public/sw.js');

const SW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'sw.js'), 'utf8'
);
const ORIGIN = 'https://social-vibecoding.example';

// A schedule() that fires deadlines on demand instead of on a clock, so
// these tests are instant and can't flake on a loaded machine.
function manualScheduler() {
  const pending = [];
  const schedule = (fn, ms) => {
    const entry = { fn, ms, cancelled: false };
    pending.push(entry);
    return () => { entry.cancelled = true; };
  };
  schedule.fireAll = () => {
    for (const e of pending) if (!e.cancelled) e.fn();
  };
  schedule.pending = pending;
  return schedule;
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// ── 1. Cache naming and durability ───────────────────────────────────

test('the API cache name carries no SW version, so a bump cannot wipe it', () => {
  assert.equal(API_CACHE, 'usernode-api');
  assert.ok(!/v\d/.test(API_CACHE), `${API_CACHE} still looks versioned`);
  // The regression in full: activate() prunes by this list, so the API
  // cache must be a member of it under its stable name.
  assert.ok(ALL_CACHES.includes(API_CACHE));
});

test('the activate prune still deletes caches this worker does not own', () => {
  // The un-versioned name must not have turned the prune into a no-op —
  // stale SHELL caches from older versions still have to go.
  assert.ok(!ALL_CACHES.includes('usernode-shell-v1'));
  assert.ok(!ALL_CACHES.includes('usernode-immutable-v1'));
});

test('legacy version-named API caches are recognised for migration', () => {
  assert.ok(LEGACY_API_CACHE_RE.test('usernode-api-v6'));
  assert.ok(LEGACY_API_CACHE_RE.test('usernode-api-v7'));
  assert.ok(LEGACY_API_CACHE_RE.test('usernode-api-v12'));
  // Must not swallow the stable name itself, or the migration would try
  // to copy the cache onto itself and the logout wipe would be fine but
  // the prune list would get confused.
  assert.ok(!LEGACY_API_CACHE_RE.test('usernode-api'));
  assert.ok(!LEGACY_API_CACHE_RE.test('usernode-shell-v7'));
  assert.ok(!LEGACY_API_CACHE_RE.test('usernode-immutable-v7'));
});

test('migration runs on activate BEFORE the prune deletes the legacy names', () => {
  // Ordering is the whole point: prune-then-migrate would migrate nothing
  // and sign every upgrading device out offline.
  const activate = SW_SRC.slice(SW_SRC.indexOf("addEventListener('activate'"));
  const migrateAt = activate.indexOf('migrateLegacyApiCaches(');
  const pruneAt = activate.indexOf('caches.delete(n)');
  assert.ok(migrateAt > -1, 'activate does not call migrateLegacyApiCaches');
  assert.ok(pruneAt > -1, 'activate no longer prunes');
  assert.ok(migrateAt < pruneAt, 'migration must run before the prune');
});

test('the session entry is immune to eviction; ordinary API entries are not', () => {
  assert.deepEqual(IMMUNE_API_PATHS, ['/api/auth/me']);
  assert.equal(isImmuneApiRequest(ORIGIN + '/api/auth/me', ORIGIN), true);
  // Query strings and cache-busters must not defeat the immunity.
  assert.equal(isImmuneApiRequest(ORIGIN + '/api/auth/me?t=1', ORIGIN), true);
  assert.equal(isImmuneApiRequest(ORIGIN + '/api/apps', ORIGIN), false);
  assert.equal(isImmuneApiRequest(ORIGIN + '/api/auth/me/extra', ORIGIN), false);
  assert.equal(isImmuneApiRequest('not a url', ORIGIN), false);
});

test('both eviction passes skip immune entries', () => {
  const trim = SW_SRC.slice(SW_SRC.indexOf('async function trimApiCache'));
  assert.match(trim.slice(0, 600), /isImmuneApiRequest/);
  const prune = SW_SRC.slice(SW_SRC.indexOf('async function pruneStaleApiEntries'));
  assert.match(prune.slice(0, 600), /isImmuneApiRequest/);
});

test('logout clears the legacy API caches too, not just the stable one', () => {
  // A device that logs out before the migration lands would otherwise
  // leave one user's cached responses readable by the next.
  const clear = SW_SRC.slice(SW_SRC.indexOf('async function clearApiCaches'));
  assert.match(clear.slice(0, 500), /LEGACY_API_CACHE_RE/);
  assert.ok(!/caches\.delete\(API_CACHE\)/.test(SW_SRC),
    'a bare caches.delete(API_CACHE) would miss the legacy names');
});

// ── 2. Network deadline with cache fallback ──────────────────────────

test('a fast network response wins and nothing is served from cache', async () => {
  const schedule = manualScheduler();
  const res = await raceNetworkAndCache({
    startFetch: async () => 'network',
    matchCache: async () => { throw new Error('cache must not be consulted'); },
    timeoutMs: 1000,
    schedule,
  });
  assert.deepEqual(res, { response: 'network', fromCache: false, pending: null });
  // The deadline timer is cancelled, so a served response never leaves a
  // timer running for the life of the worker.
  assert.equal(schedule.pending[0].cancelled, true);
});

test('a stalled network is answered from cache at the deadline', async () => {
  const schedule = manualScheduler();
  const net = deferred();
  const promise = raceNetworkAndCache({
    startFetch: () => net.promise,
    matchCache: async () => 'cached',
    timeoutMs: 1000,
    schedule,
  });
  schedule.fireAll();
  const res = await promise;
  assert.equal(res.response, 'cached');
  assert.equal(res.fromCache, true);
  // The request is STILL IN FLIGHT and handed back so the caller can
  // event.waitUntil() it — the fresh copy still lands in the cache.
  assert.ok(res.pending, 'the in-flight request must be returned');
  net.resolve('network');
  assert.equal(await res.pending, 'network');
});

test('a stalled network with no cached copy still waits it out', async () => {
  // Cutting the request off at the deadline with nothing to show would
  // turn a slow load into a hard failure. The deadline only unlocks the
  // cache; it never shortens the request.
  const schedule = manualScheduler();
  const net = deferred();
  const promise = raceNetworkAndCache({
    startFetch: () => net.promise,
    matchCache: async () => undefined,
    timeoutMs: 1000,
    schedule,
  });
  schedule.fireAll();
  net.resolve('late network');
  const res = await promise;
  assert.deepEqual(res, { response: 'late network', fromCache: false, pending: null });
});

test('an outright network failure falls back to cache', async () => {
  const schedule = manualScheduler();
  const res = await raceNetworkAndCache({
    startFetch: async () => { throw new Error('offline'); },
    matchCache: async () => 'cached',
    timeoutMs: 1000,
    schedule,
  });
  assert.equal(res.response, 'cached');
  assert.equal(res.fromCache, true);
  assert.equal(res.pending, null);
  assert.equal(schedule.pending[0].cancelled, true);
});

test('a network failure with no cached copy rethrows', async () => {
  const schedule = manualScheduler();
  await assert.rejects(raceNetworkAndCache({
    startFetch: async () => { throw new Error('offline'); },
    matchCache: async () => undefined,
    timeoutMs: 1000,
    schedule,
  }), /offline/);
});

test('a failure AFTER the deadline still gets one last look at the cache', async () => {
  // Entry written by a concurrent request while we were waiting.
  const schedule = manualScheduler();
  const net = deferred();
  let calls = 0;
  const promise = raceNetworkAndCache({
    startFetch: () => net.promise,
    matchCache: async () => (++calls > 1 ? 'arrived late' : undefined),
    timeoutMs: 1000,
    schedule,
  });
  schedule.fireAll();
  net.reject(new Error('connection reset'));
  const res = await promise;
  assert.equal(res.response, 'arrived late');
  assert.equal(res.fromCache, true);
});

test('all three network-first strategies carry a deadline', () => {
  for (const ms of [NAVIGATE_TIMEOUT_MS, SHELL_TIMEOUT_MS, API_TIMEOUT_MS]) {
    assert.equal(typeof ms, 'number');
    // Long enough not to punish an ordinary slow connection, short
    // enough that a stall doesn't read as a broken app.
    assert.ok(ms >= 1000 && ms <= 10000, `implausible deadline: ${ms}`);
  }
  for (const fn of ['networkFirstShell', 'networkFirstNavigate', 'networkFirstApi']) {
    const body = SW_SRC.slice(SW_SRC.indexOf(`async function ${fn}(`));
    assert.match(body.slice(0, 1400), /raceNetworkAndCache/,
      `${fn} does not use the deadline helper`);
    assert.match(body.slice(0, 1400), /event\.waitUntil\(pending/,
      `${fn} drops the in-flight request instead of letting it refresh the cache`);
  }
});
