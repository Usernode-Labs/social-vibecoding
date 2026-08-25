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
  isShellDocumentUrl,
  raceNetworkAndCache,
  bytesEqual,
  API_CACHE,
  ALL_CACHES,
  LEGACY_API_CACHE_RE,
  IMMUNE_API_PATHS,
  NAVIGATE_TIMEOUT_MS,
  SHELL_TIMEOUT_MS,
  API_TIMEOUT_MS,
  apiTimeoutFor,
  BOOT_READ_PATHS,
  BOOT_API_TIMEOUT_MS,
} = require('../public/sw.js');

const SW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'sw.js'), 'utf8'
);
const ORIGIN = 'https://social-vibecoding.example';

// One strategy's source, bounded by the NEXT strategy rather than by a
// character count. A fixed-length slice silently runs past the end of a
// short function into its neighbour, which is how the assertion below that
// every tier writes to its cache passed while networkFirstNavigate — the
// one that did not — sat right in front of the one that did.
const STRATEGIES = ['networkFirstShell', 'networkFirstNavigate', 'networkFirstApi'];
const strategyBody = (fn) => {
  const start = SW_SRC.indexOf(`async function ${fn}(`);
  assert.ok(start !== -1, `${fn} not found in sw.js`);
  const ends = STRATEGIES
    .filter((other) => other !== fn)
    .map((other) => SW_SRC.indexOf(`async function ${other}(`, start))
    .filter((at) => at !== -1);
  return SW_SRC.slice(start, ends.length ? Math.min(...ends) : undefined);
};

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
    // The lower bound used to be 1000ms for all three. It was a guard
    // against a deadline so short that the worker became cache-first by
    // accident — but for the SHELL that is now the deliberate design (see
    // the constants in sw.js): being one deploy behind for one load is
    // cheap, a blank screen is not, and a 200ms deadline still lets a
    // healthy conditional GET win and deliver the newest build on this
    // load. The guard stays, one floor lower, so a zero or a negative —
    // which would disable the network path outright — is still caught.
    assert.ok(ms >= 100 && ms <= 10000, `implausible deadline: ${ms}`);
  }
  // The API tier is the one where a stale answer is WRONG CONTENT rather
  // than an old build, so it must stay meaningfully more patient than the
  // shell AND above a typical mobile round trip. Below ~500ms it would be
  // cache-first for everyone not on wifi while still claiming to be
  // network-first.
  assert.ok(API_TIMEOUT_MS >= 500,
    'the API deadline must stay above a typical mobile round trip');
  assert.ok(API_TIMEOUT_MS > SHELL_TIMEOUT_MS,
    'the API tier must be more patient than the shell tier');

  for (const fn of ['networkFirstShell', 'networkFirstNavigate', 'networkFirstApi']) {
    const body = strategyBody(fn);
    assert.match(body, /raceNetworkAndCache/,
      `${fn} does not use the deadline helper`);
    assert.match(body, /event\.waitUntil\(pending/,
      `${fn} drops the in-flight request instead of keeping it alive`);
    // Keeping the request ALIVE is only half of it, and the half that is
    // easy to have without the other. raceNetworkAndCache deliberately
    // leaves the cache write to the caller's startFetch, so a strategy that
    // waits on `pending` and never stores the result serves a stale copy
    // for the life of the worker while still calling itself network-first.
    // That is exactly what networkFirstNavigate did. The write is spelled
    // differently in each tier — the API one goes through stampAndPut so
    // the entry carries its cached-at header — so accept either.
    assert.match(body, /cache\.put\(|stampAndPut\(cache/,
      `${fn}'s startFetch never writes the response to the cache`);
  }
});

// ── 2b. The cached document has to track the deploy ──────────────────
//
// install() writes /index.html into the shell cache exactly once per
// worker, and the navigation strategy reads that key on every load that
// misses the deadline — which, with the deadline deliberately set below a
// round trip, is most of them. So if the navigation never writes the key
// back, the cached shell freezes at whatever shipped the last time sw.js
// changed bytes, and no later deploy can dislodge it.
//
// The symptom that surfaced it: #1400 moved the body ground from bg-white
// to bg-zinc-100 without touching sw.js, so an ordinary load rendered the
// old white page while a hard refresh — which bypasses the worker — showed
// the new grey one, indefinitely.

test('the navigation writes the fresh document back under the read key', () => {
  const nav = SW_SRC.slice(
    SW_SRC.indexOf('async function networkFirstNavigate('),
    SW_SRC.indexOf('async function networkFirstApi(')
  );
  // The key is what matters, not merely that a put happens: matchCache
  // reads the fixed '/index.html', so storing under event.request would
  // fill the cache with per-route copies and leave the one key that is
  // actually read as stale as before.
  assert.match(nav, /cache\.put\('\/index\.html'/,
    'the refreshed document must land on the key matchCache reads');
  assert.match(nav, /matchCache: \(\) => cache\.match\('\/index\.html'\)/,
    'and that key must still be the one read back');
  assert.doesNotMatch(nav, /startFetch: \(\) => fetch\(event\.request\),/,
    'a bare startFetch is the bug: nothing refreshes the cached shell');
});

test('only the real shell document may be stored as the shell', () => {
  // classifyRequest returns 'navigate' for far more than the shell's own
  // two URLs. #860's redirect stubs are ~1KB of location.replace(): the
  // right thing to SERVE the cached shell for offline, and a disaster to
  // STORE as it — every later cache-served navigation would get a stub
  // instead of the app, which is strictly worse than the staleness this
  // whole section fixes.
  for (const p of ['/', '/index.html']) {
    assert.equal(isShellDocumentUrl(`${ORIGIN}${p}`, ORIGIN), true, p);
  }
  for (const p of [
    '/login.html', '/register.html', '/dashboard.html', '/gallery.html',
    '/admin.html', '/status.html', '/debug.html', '/node-status.html',
    '/landing.html', '/waiting.html', '/admin-features.html',
    '/cli-authorize.html', '/connect-authorize.html', '/reports/tok',
  ]) {
    assert.equal(isShellDocumentUrl(`${ORIGIN}${p}`, ORIGIN), false, p);
  }
  // A query string or hash is still the shell — every SPA route is a hash
  // route, and /?return_to=… is the CLI authorize hand-off.
  assert.equal(isShellDocumentUrl(`${ORIGIN}/#app/x/dev`, ORIGIN), true);
  assert.equal(isShellDocumentUrl(`${ORIGIN}/?return_to=abc`, ORIGIN), true);
  // Cross-origin and unparseable inputs are refused rather than thrown on.
  assert.equal(isShellDocumentUrl('https://elsewhere.example/', ORIGIN), false);
  assert.equal(isShellDocumentUrl('::not a url::', ORIGIN), false);
});

test('a redirect or an error response is never stored as the shell', () => {
  const nav = SW_SRC.slice(
    SW_SRC.indexOf('async function networkFirstNavigate('),
    SW_SRC.indexOf('async function networkFirstApi(')
  );
  // Everything navigable that is not the shell bounces to '/' at the
  // server (middleware/auth.js), so the response reaching here for those
  // is a redirect — and a redirected 200 for /login.html carries the
  // stub's URL, not the shell's.
  assert.match(nav, /!res\.redirected/,
    'a followed redirect must not be mistaken for the shell document');
  assert.match(nav, /res\.ok/,
    'a 4xx/5xx error page must never replace the cached shell');
  assert.match(nav, /isShellDocumentUrl\(event\.request\.url, ORIGIN\)/,
    'the path guard must be applied to the request that was actually made');
});

// ── 3. One build per page load ───────────────────────────────────────
//
// The shell's assets are unhashed, so index.html does not pin the build its
// scripts come from. With every asset racing its own deadline, a connection
// hovering around the threshold could serve a cached document alongside
// freshly-fetched scripts — one load, two deploys. The navigation records
// its own outcome and the assets follow it.

test('the navigation publishes its cache/network verdict for the load', () => {
  const nav = SW_SRC.slice(SW_SRC.indexOf('async function networkFirstNavigate('));
  assert.match(nav.slice(0, 3600), /shellFromCacheThisLoad = fromCache/,
    'the navigation must record whether it was answered from cache');
});

test('shell assets follow the navigation instead of re-racing', () => {
  const shell = SW_SRC.slice(SW_SRC.indexOf('async function networkFirstShell('));
  const body = shell.slice(0, 2600);
  assert.match(body, /if \(shellFromCacheThisLoad\)/,
    'shell assets must consult the load-wide verdict');
  // On that path the asset is returned straight from cache, and the network
  // copy is still fetched so the NEXT load is fresh.
  assert.match(body, /event\.waitUntil\(fetchAndCache\(\)/,
    'the cached-shell path must still refresh the cache in the background');
  // A brand-new asset (a deploy added one) has nothing cached to prefer, so
  // the flag must not be allowed to strand it.
  assert.match(body, /raceNetworkAndCache/,
    'a cache miss must still fall through to the network path');
});

test('the load-wide verdict defaults to the per-asset race', () => {
  // A worker restart mid-load resets module state. The default has to be
  // the OLD behaviour (race, fall back to cache), never "serve cache
  // blindly" — that would be a build the navigation never agreed to.
  assert.match(SW_SRC, /let shellFromCacheThisLoad = false;/,
    'the verdict must default to false (race), not true');
});

// ── 4. Late-arrival correction ───────────────────────────────────────
//
// A worker returns exactly ONE response per request. Serving a stale API
// answer is only safe because the page is told when the real answer lands
// and disagrees with what it was shown.

test('bytesEqual compares whole bodies', () => {
  const buf = (bytes) => new Uint8Array(bytes).buffer;
  assert.equal(bytesEqual(buf([1, 2, 3]), buf([1, 2, 3])), true);
  assert.equal(bytesEqual(buf([1, 2, 3]), buf([1, 2, 4])), false,
    'a changed byte must read as changed');
  assert.equal(bytesEqual(buf([1, 2]), buf([1, 2, 3])), false,
    'a length change must read as changed');
  assert.equal(bytesEqual(buf([]), buf([])), true);
});

test('a stale API answer that turns out to be wrong notifies the page', () => {
  const api = SW_SRC.slice(SW_SRC.indexOf('async function networkFirstApi('));
  const body = api.slice(0, 2600);
  // The "did we serve stale?" flag is set inside matchCache, which resolves
  // before raceNetworkAndCache returns. Reading the returned `fromCache`
  // instead would leave a window in which a just-missed network response
  // found the flag still false and skipped a correction that was due.
  assert.match(body, /matchCache: async \(\) => \{[\s\S]*?served\.fromCache = true/,
    'the stale-serve flag must be set inside matchCache, not after the race');
  assert.match(body, /detectChange: served\.fromCache/,
    'the change comparison must only run on the stale-serve path');
  assert.match(body, /served\.fromCache && changed/,
    'a correction must require BOTH a stale serve and a real difference');
  assert.match(body, /notifyClients\(\{ type: 'api-updated'/,
    'the page must be told about the correction');
});

test('an ordinary fresh API load never posts a correction', () => {
  // detectChange is false unless we served stale, and stampAndPut returns
  // false when it is not asked — so the notify branch cannot fire on a
  // healthy connection, where every screen already has the live answer.
  const stamp = SW_SRC.slice(SW_SRC.indexOf('async function stampAndPut('));
  assert.match(stamp.slice(0, 1200), /\{ detectChange = false \} = \{\}/,
    'change detection must be opt-in');
  assert.match(stamp.slice(0, 1200), /if \(detectChange\)/,
    'stampAndPut must skip the extra cache read when not asked');
});

test('the boot session wait stays just past the API deadline', () => {
  // App.BOOT_SESSION_TIMEOUT_MS is the last link in the serial chain a cold
  // load walks (navigation → shell scripts → session), so it has to move
  // whenever API_TIMEOUT_MS moves or it becomes the sole remaining
  // multi-second wait on a weak connection.
  const appJs = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8'
  );
  const boot = Number(/BOOT_SESSION_TIMEOUT_MS:\s*(\d+)/.exec(appJs)[1]);
  assert.ok(boot > API_TIMEOUT_MS,
    'boot must give the worker first refusal at answering from cache');
  assert.ok(boot <= API_TIMEOUT_MS * 3,
    `BOOT_SESSION_TIMEOUT_MS (${boot}ms) has drifted away from ` +
    `API_TIMEOUT_MS (${API_TIMEOUT_MS}ms) — it is the last serial wait ` +
    'on a cold load');
});

// ── The three reads that gate the first paint ────────────────────────────

test('the boot reads answer from cache immediately; everything else waits', () => {
  const O = 'https://example.test';
  // These three ARE the launcher: the app list, its layout, the home panels.
  // Every app icon and avatar on the screen is a URL inside one of their
  // answers, so nothing below the header can paint until they land — which is
  // why a warm second load still arrived in three waves with the icons last.
  assert.deepEqual(BOOT_READ_PATHS, ['/api/apps', '/api/home-layout', '/api/home-panels']);
  assert.equal(BOOT_API_TIMEOUT_MS, 0, 'a cached copy is served on this tick');
  for (const p of BOOT_READ_PATHS) {
    assert.equal(apiTimeoutFor(`${O}${p}`, O), BOOT_API_TIMEOUT_MS, p);
    assert.equal(apiTimeoutFor(`${O}${p}?demo=1`, O), BOOT_API_TIMEOUT_MS,
      `${p} with a query string is the same read`);
  }
  // EXACT pathname match. An app's issues, its messages, its board order all
  // live under /api/apps/… and a stale answer there is wrong content, not an
  // old launcher — they keep the patient deadline.
  for (const p of [
    '/api/apps/demo/issues',
    '/api/apps/demo/promoted',
    '/api/notifications',
    '/api/auth/me',
    '/api/home-layouts',
  ]) {
    assert.equal(apiTimeoutFor(`${O}${p}`, O), API_TIMEOUT_MS, p);
  }
  // A URL the parser cannot make sense of must not fall into the fast lane.
  assert.equal(apiTimeoutFor('::::', undefined), API_TIMEOUT_MS);
});

test('serving a stale boot read is only safe because the page is told', () => {
  // The whole trade — paint the previous session's grid now, correct it when
  // the network answers — rests on this notify path and on App._onApiUpdated
  // re-running the visible screen's loader. If either goes, BOOT_READ_PATHS
  // must go with it.
  const body = strategyBody('networkFirstApi');
  assert.match(body, /timeoutMs: apiTimeoutFor\(event\.request\.url, ORIGIN\)/,
    'the deadline is chosen per request');
  assert.match(body, /notifyClients\(\{ type: 'api-updated'/,
    'a late answer that disagrees is announced');
  assert.match(body, /served\.fromCache && changed/,
    'and only when the page was actually shown the stale bytes');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /_onApiUpdated\(\)/, 'the page listens for it');
  assert.match(app, /App\.refreshActiveScreen/, 'and re-runs the visible screen\'s loader');
});
