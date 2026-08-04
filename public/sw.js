// Platform-shell service worker — read-only offline mode (#487).
//
// Design contract (see the offline-mode spec):
//   - ONLINE BEHAVIOUR IS BYTE-IDENTICAL TO NO-SW. Every strategy here is
//     network-first: the cache is consulted only when the network fails.
//     This preserves the platform's hard-learned freshness rule
//     (src/services/static-cache.js) — a redeploy still reaches every
//     client on the next page load.
//   - Only GETs are ever intercepted. Writes, SSE streams, auth flows and
//     credentials are hard-bypassed (see classifyRequest below).
//   - Cached GET /api/* JSON lets previously-viewed screens (home feed,
//     per-app dev views, chats) re-render offline. Entries are stamped,
//     capped, and cleared on logout.
//
// classifyRequest() is a pure function on purpose: tests/pwa-sw-classify
// .test.js loads this file in Node (module.exports branch at the bottom)
// and pins the bypass list without a browser.

const SW_VERSION = 'v5';
const SHELL_CACHE = `usernode-shell-${SW_VERSION}`;
const API_CACHE = `usernode-api-${SW_VERSION}`;
const IMMUTABLE_CACHE = `usernode-immutable-${SW_VERSION}`;
const CDN_CACHE = `usernode-cdn-${SW_VERSION}`;
const ALL_CACHES = [SHELL_CACHE, API_CACHE, IMMUTABLE_CACHE, CDN_CACHE];
const LEGACY_CACHE_PREFIXES = [
  'usernode-shell-',
  'usernode-api-',
  'usernode-immutable-',
  'usernode-cdn-',
];

// Cache ownership is explicit: the root worker may retire only its own cache
// families. The separately-scoped React worker owns usernode-react-shell-*.
function isStaleLegacyCache(name) {
  return LEGACY_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix))
    && !ALL_CACHES.includes(name);
}

// API-cache hygiene knobs.
const API_CACHE_MAX_ENTRIES = 300;
const API_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const CACHED_AT_HEADER = 'sw-cached-at';
const SESSION_EPOCH_HEADER = 'x-usernode-session-epoch';
const SESSION_BOUNDARY_CACHE = 'usernode-session-boundary-v1';
const SESSION_BOUNDARY_PATH = '/__usernode/session-boundary';

// Cross-origin script URLs the shell's <script> tags load. Kept in sync
// with index.html by tests/pwa-shell-wiring.test.js.
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/gh/davidshimjs/qrcodejs/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.4.4/dist/purify.min.js',
];

// Same-origin shell assets precached on install so the very next offline
// load works even for screens the session never touched. Must list every
// local script/stylesheet index.html references — the precache-list sync
// test enforces that. (login.html etc. are redirect stubs into the SPA's
// hash routes now — fold-auth-pages-into-SPA — so index.html is the one
// document to precache.)
const SHELL_ASSETS = [
  '/index.html',
  '/css/app.css',
  '/usernode-native/v1/native.css',
  '/usernode-native/v1/native.js',
  '/usernode-bridge.js',
  '/js/admin-console.js',
  '/js/auth-screens.js',
  '/js/admin-topochain.js',
  // Folded-in console sections (#860) — one module per section that used to
  // be a standalone page. The retired page scripts (/js/dashboard.js,
  // /js/debug.js, /js/gallery.js, /js/admin-features.js) are gone.
  '/js/admin-status.js',
  '/js/admin-node.js',
  '/js/admin-analytics.js',
  '/js/admin-estimator.js',
  '/js/admin-merges.js',
  '/js/admin-gallery.js',
  '/js/admin-campaigns.js',
  '/js/app-secrets.js',
  '/js/browse.js',
  '/js/platform-ui.js',
  '/js/app-view.js',
  '/js/app.js',
  '/js/build-log.js',
  '/js/cc-progress-summary.js',
  '/js/topochain-events.js',
  '/js/confirm-modal.js',
  '/js/dev-alerts.js',
  '/js/dev-chat.js',
  '/js/dev-console.js',
  '/js/dev-host.js',
  '/js/group-chat.js',
  '/js/header-layout.js',
  '/js/home.js',
  '/js/kudos.js',
  '/js/ai-credit.js',
  '/js/leaderboard.js',
  '/js/merge-status.js',
  '/js/native-chrome.js',
  '/js/node-pill.js',
  '/js/notifications.js',
  '/js/offline.js',
  '/js/profile.js',
  '/js/screenshot-select.js',
  '/js/session-transcript.js',
  '/js/settings.js',
  '/js/spec-sections.js',
  '/js/streaming-markdown.js',
  '/js/theme.js',
  '/js/topochain-event-context.js',
  '/js/topochain-leaderboard.js',
  '/js/topochain-challenges.js',
  '/js/wallet-sheet.js',
  '/js/work-drawer.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

// Server-rendered standalone pages that stay online-only: never serve the
// SPA shell as an offline fallback for them (it would render the wrong
// app entirely). They just fail offline, like today.
//
// #860 emptied most of this list: /admin, /admin-features, /dashboard,
// /debug, /gallery, /node-status and /status are redirect stubs into the
// SPA's #admin console now, so falling back to the cached shell is exactly
// right for them (the same change the auth pages got in
// fold-auth-pages-into-SPA). /cli/authorize is the last genuine standalone
// server page — a pre-auth device-authorisation flow with its own
// stylesheet, deliberately outside the app shell.
const NO_FALLBACK_PAGES = [
  '/cli/authorize',
];

// Pure request classifier — the single source of truth for what the fetch
// handler does with a request. Returns one of:
//   'bypass'   — don't touch it; the browser talks to the network directly.
//   'navigate' — page navigation: network-first, offline falls back to the
//                cached SPA shell (index.html).
//   'shell'    — same-origin HTML/JS/CSS/manifest/icons: network-first.
//   'api'      — GET /api/* JSON: network-first, cache 200s for offline.
//   'immutable'— content-addressed images (/app-icons, /visuals): cache-first.
//   'cdn'      — known cross-origin shell scripts: stale-while-revalidate.
function classifyRequest(method, url, acceptHeader, mode, selfOrigin) {
  if (method !== 'GET') return 'bypass';

  let u;
  try { u = new URL(url, selfOrigin); } catch { return 'bypass'; }

  // Cross-origin: only the known CDN scripts are handled.
  if (u.origin !== selfOrigin) {
    const bare = u.origin + u.pathname;
    return CDN_ASSETS.some((a) => a === bare || a === u.href || a + '/' === bare)
      ? 'cdn' : 'bypass';
  }

  const p = u.pathname;

  // SSE streams must never be intercepted or cached (they'd buffer forever).
  if (/text\/event-stream/i.test(acceptHeader || '')) return 'bypass';
  if (/^\/api\/sessions\/[^/]+\/events$/.test(p)) return 'bypass';

  if (mode === 'navigate') {
    return NO_FALLBACK_PAGES.includes(p) ? 'bypass' : 'navigate';
  }

  // Local-dev mock namespace and short-lived credentials.
  if (p.startsWith('/__mock/')) return 'bypass';
  if (p === '/api/iframe-token') return 'bypass';
  if (p.startsWith('/api/cli/')) return 'bypass';
  if (p === '/api/me/cli-tokens' || p.startsWith('/api/me/cli-tokens/')) {
    return 'bypass';
  }
  // Auth endpoints are online-only — EXCEPT /api/auth/me, which is cached
  // so the SPA's boot check succeeds offline for a logged-in user.
  if (p.startsWith('/api/auth/') && p !== '/api/auth/me') return 'bypass';

  if (p.startsWith('/api/')) return 'api';

  // Content-addressed, already served with a year-long immutable header.
  if (p.startsWith('/app-icons/') || p.startsWith('/visuals/')) return 'immutable';

  // The shell's own static assets (incl. /usernode-bridge/v1/... versions).
  if (/\.(?:html|js|css|webmanifest)$/i.test(p)) return 'shell';
  if (p.startsWith('/icons/')) return 'shell';

  // Everything else (e.g. the /health connectivity probe) goes straight
  // to the network so it always reflects real reachability.
  return 'bypass';
}

/* ------------------------------------------------------------------ */
/* Service-worker runtime (skipped when loaded in Node for tests).     */
/* ------------------------------------------------------------------ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    classifyRequest,
    SHELL_ASSETS,
    CDN_ASSETS,
    isStaleLegacyCache,
    NO_FALLBACK_PAGES,
    SESSION_BOUNDARY_CACHE,
    SESSION_BOUNDARY_PATH,
    SESSION_EPOCH_HEADER,
    SW_VERSION,
  };
} else {
  const ORIGIN = self.location.origin;
  const SESSION_BOUNDARY_URL = new URL(SESSION_BOUNDARY_PATH, ORIGIN).href;

  async function readSessionEpoch() {
    try {
      const boundary = await caches.open(SESSION_BOUNDARY_CACHE);
      const response = await boundary.match(SESSION_BOUNDARY_URL);
      const value = Number(response && await response.text());
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch {
      // Failing closed here means the response will not be cached: callers
      // compare this sentinel with a second read before and after writing.
      return -1;
    }
  }

  async function advanceSessionEpoch() {
    const boundary = await caches.open(SESSION_BOUNDARY_CACHE);
    const current = await readSessionEpoch();
    const next = Math.max(
      Number.isSafeInteger(current) ? current + 1 : 1,
      Date.now()
    );
    await boundary.put(
      SESSION_BOUNDARY_URL,
      new Response(String(next), {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain',
        },
      })
    );
    return next;
  }

  // Stamp a response copy with the cached-at time so activate() can prune
  // stale entries. Only used for the API cache. Takes an already-cloned
  // response (cloning must happen synchronously, before the page starts
  // consuming the original body).
  async function stampAndPut(cache, request, response, expectedEpoch) {
    try {
      if (await readSessionEpoch() !== expectedEpoch) return false;
      const headers = new Headers(response.headers);
      headers.set(CACHED_AT_HEADER, String(Date.now()));
      headers.set(SESSION_EPOCH_HEADER, String(expectedEpoch));
      const body = await response.arrayBuffer();
      if (await readSessionEpoch() !== expectedEpoch) return false;
      await cache.put(request, new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }));
      if (await readSessionEpoch() !== expectedEpoch) {
        const stored = await cache.match(request);
        if (stored && stored.headers.get(SESSION_EPOCH_HEADER) === String(expectedEpoch)) {
          await cache.delete(request);
        }
        return false;
      }
      return true;
    } catch {
      // Quota, body, or boundary failure: offline copy just is not saved.
      return false;
    }
  }

  // Oldest-first eviction keeps the API cache bounded. Cache keys iterate
  // in insertion order, so dropping from the front approximates LRU-by-write.
  async function trimApiCache(cache) {
    try {
      const keys = await cache.keys();
      for (let i = 0; i < keys.length - API_CACHE_MAX_ENTRIES; i++) {
        await cache.delete(keys[i]);
      }
    } catch { /* best-effort */ }
  }

  async function pruneStaleApiEntries() {
    try {
      const cache = await caches.open(API_CACHE);
      const keys = await cache.keys();
      const now = Date.now();
      for (const key of keys) {
        const res = await cache.match(key);
        const at = Number(res && res.headers.get(CACHED_AT_HEADER));
        if (at && now - at > API_CACHE_MAX_AGE_MS) await cache.delete(key);
      }
    } catch { /* best-effort */ }
  }

  async function networkFirstShell(event) {
    const cache = await caches.open(SHELL_CACHE);
    try {
      const res = await fetch(event.request);
      if (res && res.ok) cache.put(event.request, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(event.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  }

  async function networkFirstNavigate(event) {
    const cache = await caches.open(SHELL_CACHE);
    try {
      return await fetch(event.request);
    } catch (err) {
      // Any SPA path serves index.html online (the server's catch-all), so
      // the cached shell is the correct offline fallback for every route —
      // including the old standalone auth pages, which are redirect stubs
      // into the SPA's hash routes now (fold-auth-pages-into-SPA).
      const hit = await cache.match('/index.html');
      if (hit) return hit;
      throw err;
    }
  }

  async function networkFirstApi(event) {
    const cache = await caches.open(API_CACHE);
    const requestEpoch = await readSessionEpoch();
    try {
      const res = await fetch(event.request);
      // Only genuine successes are worth replaying offline; 401/403/500
      // must never mask a later real answer. Clone before returning —
      // once the page starts reading the body the response is locked.
      if (res && res.status === 200) {
        const copy = res.clone();
        event.waitUntil((async () => {
          if (await stampAndPut(cache, event.request, copy, requestEpoch)) {
            await trimApiCache(cache);
          }
        })());
      }
      return res;
    } catch (err) {
      const hit = await cache.match(event.request);
      const currentEpoch = await readSessionEpoch();
      if (
        hit &&
        currentEpoch >= 0 &&
        hit.headers.get(SESSION_EPOCH_HEADER) === String(currentEpoch)
      ) return hit;
      if (hit) await cache.delete(event.request);
      throw err;
    }
  }

  async function cacheFirstImmutable(event) {
    const cache = await caches.open(IMMUTABLE_CACHE);
    const hit = await cache.match(event.request);
    if (hit) return hit;
    const res = await fetch(event.request);
    if (res && res.ok) cache.put(event.request, res.clone()).catch(() => {});
    return res;
  }

  async function staleWhileRevalidateCdn(event) {
    const cache = await caches.open(CDN_CACHE);
    const hit = await cache.match(event.request);
    const refresh = fetch(event.request).then((res) => {
      // Opaque (no-cors) responses have status 0 — still cacheable and
      // still valid for a plain <script src> load.
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(event.request, res.clone()).catch(() => {});
      }
      return res;
    });
    if (hit) {
      event.waitUntil(refresh.catch(() => {}));
      return hit;
    }
    return refresh;
  }

  self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      const shell = await caches.open(SHELL_CACHE);
      // Per-asset, best-effort: one 404 must not brick the whole install.
      await Promise.allSettled(SHELL_ASSETS.map((path) => shell.add(path)));
      const cdn = await caches.open(CDN_CACHE);
      await Promise.allSettled(CDN_ASSETS.map(async (url) => {
        // Try a CORS fetch first (jsdelivr sends ACAO:*; needed so the
        // integrity-checked <script crossorigin> tags can verify the
        // cached bytes); fall back to an opaque no-cors copy.
        try {
          const res = await fetch(url, { mode: 'cors' });
          if (res.ok) return cdn.put(url, res);
        } catch { /* fall through to no-cors */ }
        const res = await fetch(url, { mode: 'no-cors' });
        return cdn.put(url, res);
      }));
      await self.skipWaiting();
    })());
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      // Drop caches from older SW versions.
      const names = await caches.keys();
      await Promise.all(names
        .filter(isStaleLegacyCache)
        .map((n) => caches.delete(n)));
      await pruneStaleApiEntries();
      await self.clients.claim();
    })());
  });

  self.addEventListener('message', (event) => {
    const type = event.data && event.data.type;
    if (type === 'clear-api-cache') {
      event.waitUntil((async () => {
        const epoch = await advanceSessionEpoch();
        await caches.delete(API_CACHE);
        const port = event.ports && event.ports[0];
        if (port) port.postMessage({ done: true, epoch });
      })());
    }
  });

  self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Belt-and-braces logout isolation: a logout passing through (never
    // intercepted — it's a POST) still wipes the per-user API cache.
    if (req.method === 'POST' && new URL(req.url).pathname === '/api/auth/logout') {
      event.waitUntil((async () => {
        await advanceSessionEpoch();
        await caches.delete(API_CACHE);
      })());
      return;
    }

    const kind = classifyRequest(
      req.method, req.url, req.headers.get('accept'), req.mode, ORIGIN
    );
    switch (kind) {
      case 'navigate': event.respondWith(networkFirstNavigate(event)); break;
      case 'shell': event.respondWith(networkFirstShell(event)); break;
      case 'api': event.respondWith(networkFirstApi(event)); break;
      case 'immutable': event.respondWith(cacheFirstImmutable(event)); break;
      case 'cdn': event.respondWith(staleWhileRevalidateCdn(event)); break;
      default: /* bypass — browser default network handling */ break;
    }
  });
}
