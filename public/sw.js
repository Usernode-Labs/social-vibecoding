// Platform-shell service worker — read-only offline mode (#487).
//
// Design contract (see the offline-mode spec):
//   - A GOOD CONNECTION STILL GETS THE NEWEST BUILD ON THIS LOAD; a bad
//     one gets the cached one immediately. Every strategy is network-first
//     against a DEADLINE (#1021): a response that has not arrived in time
//     is answered from cache, and the network response — still in flight —
//     replaces the cached copy when it lands. This preserves the
//     platform's hard-learned freshness rule
//     (src/services/static-cache.js): the next page load is fresh, and
//     the drawer's stale-version pill (App.renderPlatformVersionPill)
//     remains the visible recovery for a tab that is behind a deploy.
//     Without the deadline a stalled-but-open connection held the
//     navigation (and every one of the shell's ~70 scripts) open forever
//     while a complete cached copy sat unused — the reported white screen.
//
//     The deadlines are DELIBERATELY SHORTER THAN A ROUND TRIP for the
//     shell (200ms), because being one deploy behind for one load is
//     cheap and a blank screen is not; see the constants below for the
//     full reasoning, and note the two mechanisms that keep it honest —
//     shellFromCacheThisLoad, so one load cannot mix two builds, and the
//     `api-updated` message, so a stale API answer corrects itself on
//     screen instead of waiting for a reload.
//   - Only GETs are ever intercepted. Writes, SSE streams, auth flows and
//     credentials are hard-bypassed (see classifyRequest below).
//   - Cached GET /api/* JSON lets previously-viewed screens (home feed,
//     per-app dev views, chats) re-render offline. Entries are stamped,
//     capped, and cleared on logout.
//
// classifyRequest(), isImmuneApiRequest() and raceNetworkAndCache() are
// pure functions on purpose: tests/pwa-sw-classify.test.js and
// tests/pwa-offline-cache.test.js load this file in Node (module.exports
// branch at the bottom) and pin their behaviour without a browser.

// v6: the shell has no cross-origin assets left (Tailwind is compiled into
// /css/tailwind.css and marked/DOMPurify/qrcodejs are vendored under
// /vendor/), so the CDN cache and its stale-while-revalidate strategy are
// gone. The activate handler prunes any `usernode-*` cache not listed in
// ALL_CACHES, which retires the old usernode-cdn-v5 entries automatically.
//
// The React + shadcn chassis swap added one local asset to the shell —
// /shell/assets/shell.js — and SHELL_ASSETS below precaches it like any
// other. It needed no version bump of its own: a byte change to this file
// re-runs install(), which re-runs the precache with the current list.
const SW_VERSION = 'v7';
const SHELL_CACHE = `usernode-shell-${SW_VERSION}`;
const IMMUTABLE_CACHE = `usernode-immutable-${SW_VERSION}`;

// The API cache is DELIBERATELY NOT VERSIONED WITH SW_VERSION (#1021).
// It used to be `usernode-api-${SW_VERSION}`, and the activate handler
// below deletes every `usernode-*` cache not listed in ALL_CACHES — so
// every routine service-worker bump silently wiped the offline session
// (the cached GET /api/auth/me the SPA's boot check depends on) along
// with the whole cached feed. That is exactly what shipping v7 did on the
// evening #1021 was reported. The shell and immutable caches stay
// versioned because they are network-first / content-addressed and cost
// nothing to refill; this one holds the only offline state we have.
//
// Bump API_CACHE_FORMAT only when the STORED SHAPE changes (e.g. a new
// stamp header), never as part of a shell bump.
const API_CACHE_FORMAT = '';
const API_CACHE = `usernode-api${API_CACHE_FORMAT}`;
const ALL_CACHES = [SHELL_CACHE, API_CACHE, IMMUTABLE_CACHE];

// Version-named API caches left behind by workers older than #1021.
// activate() migrates their entries into API_CACHE *before* the prune
// deletes them, so an existing install keeps its offline copy across the
// one-time rename instead of losing it exactly like a version bump would.
const LEGACY_API_CACHE_RE = /^usernode-api-v\d+$/;

// API-cache hygiene knobs.
const API_CACHE_MAX_ENTRIES = 300;
const API_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const CACHED_AT_HEADER = 'sw-cached-at';

// Entries that eviction must never touch. /api/auth/me is what decides
// whether an offline boot shows the signed-in shell or the sign-in
// screen, and it otherwise competes for the 300-entry budget with every
// paginated /api/apps/:slug/messages?... key — one busy chat session
// could evict the session itself.
const IMMUNE_API_PATHS = ['/api/auth/me'];

// Network deadlines. A deadline is how long a request may hold the page
// before the CACHED copy is shown instead. The request itself is never
// cancelled and its answer still refreshes the cache, so the deadline only
// ever unlocks the cache — it never shortens a fetch.
//
// #1021 introduced these at 3s/3s/4s, which fixed the reported hang but
// left the reported SLOWNESS, because the tiers run SERIALLY: nothing
// requests a shell asset until index.html has parsed, and nothing calls
// /api/auth/me until those scripts have run. Three patient tiers plus
// App.BOOT_SESSION_TIMEOUT_MS was ~11 seconds to a painted signed-in shell
// on a weak link — not a hang, just four individually-reasonable waits in
// a row.
//
// 200ms is BELOW a healthy same-origin round trip on purpose. Every shell
// asset is local and served with `no-cache, must-revalidate`
// (src/services/static-cache.js), so a good connection answers a
// conditional GET with a 304 well inside it and still gets the newest
// build on THIS load; anything slower falls straight through to the cached
// shell instead of holding a blank screen. Being one deploy behind for one
// load is the accepted cost, and it already has a designed recovery — the
// drawer's stale-version pill (App.renderPlatformVersionPill) and the
// reload upgrade in App._refreshOrReload.
//
// The API tier keeps a real deadline (1s) because a stale answer there is
// WRONG CONTENT, not merely an old build, and 200ms would sit under the
// round trip of most mobile networks — turning "network-first" into
// cache-first for everyone not on wifi while still claiming otherwise.
// What makes serving a stale API answer safe at all is the notify path in
// networkFirstApi: the page is told when the real answer lands and
// disagrees. Do not shorten this one without keeping that.
const NAVIGATE_TIMEOUT_MS = 200;
const SHELL_TIMEOUT_MS = 200;
const API_TIMEOUT_MS = 1000;

// ── The three reads that gate the first paint ────────────────────────
//
// The staging a returning visitor sees on home is NOT an asset problem. A
// warm second load requests all ~38 shell assets in one batch at ~35ms — the
// precache list below is complete and the sync test keeps it that way. What
// arrives in stages is DATA: /api/apps, /api/home-layout and /api/home-panels
// answer around 240ms on a warm local link, the widgets appear when they do,
// and every app icon and avatar starts loading only THEN, because its URL is
// a field inside those answers. So the launcher paints in three waves and the
// icons are last by construction, however well they are cached.
//
// These three get a zero deadline, which means: if there is a cached copy,
// serve it on this tick and let the network answer land behind it. The
// previous session's grid paints on the first frame, complete with its icons
// (cache-first '/app-icons' and '/avatars' already hold them), and a change
// is corrected in place by the api-updated path below.
//
// Why these three and not the API tier at large: they are the user's OWN
// launcher — the app list, its layout and the home panels. Being one load
// stale on your own grid self-corrects within the second and is the same
// trade the navigate and shell tiers already take. A stale ANSWER elsewhere
// (a vote count, a proposal's checks) is wrong content with no such excuse,
// which is what the 1s above is protecting and why this stays a short,
// explicit list rather than a lower global.
//
// The correction is not optional: it is what makes this safe. networkFirstApi
// posts `api-updated` when the copy it served disagrees with the answer that
// arrives, and App._onApiUpdated re-runs the visible screen's own loader. If
// that path is ever removed, remove this list with it.
const BOOT_READ_PATHS = ['/api/apps', '/api/home-layout', '/api/home-panels'];
const BOOT_API_TIMEOUT_MS = 0;

/**
 * The deadline for one API request: 0 for a boot read, API_TIMEOUT_MS
 * otherwise. Exact pathname match, so `/api/apps/:slug/...` — an app's
 * issues, its messages, its board order — keeps the ordinary deadline; only
 * the launcher's own list is in the fast lane.
 */
function apiTimeoutFor(url, selfOrigin) {
  let p;
  try { p = new URL(url, selfOrigin).pathname; } catch { return API_TIMEOUT_MS; }
  return BOOT_READ_PATHS.includes(p) ? BOOT_API_TIMEOUT_MS : API_TIMEOUT_MS;
}

// Same-origin shell assets precached on install so the very next offline
// load works even for screens the session never touched. Must list every
// local script/stylesheet index.html references — the precache-list sync
// test enforces that, and also enforces that index.html loads NOTHING
// cross-origin, so this list is now the complete set of assets the shell
// needs to render. (login.html etc. are redirect stubs into the SPA's
// hash routes now — fold-auth-pages-into-SPA — so index.html is the one
// document to precache.)
const SHELL_ASSETS = [
  '/index.html',
  '/css/tailwind.css',
  '/css/app.css',
  // The React chassis: the runtime plus the shell tree, hydrating the markup
  // index.html already ships (frontend/src/main.tsx). Deliberately UNHASHED —
  // this list is hand-maintained and content-hashed filenames would make it
  // churn on every build; freshness comes from `no-cache, must-revalidate`
  // (src/services/static-cache.js) plus this worker being network-first.
  '/shell/assets/shell.js',
  // Vendored third-party libs (public/vendor/README.md records provenance).
  '/vendor/qrcode-1.0.0.min.js',
  '/vendor/marked-15.0.12.min.js',
  '/vendor/purify-3.4.4.min.js',
  '/usernode-native/v1/native.css',
  '/usernode-native/v1/native.js',
  '/usernode-bridge.js',
  '/js/auth-screens.js',
  // The admin console's ten modules (admin-console.js, admin-topochain.js and
  // the eight folded-in #860 section modules) used to be listed here. #1082
  // chunk E moved them into the React bundle, so /shell/assets/shell.js above
  // is what precaches them now.
  // The app-secrets dialog's module used to be listed here. #1078 chunk I
  // moved it into the React bundle, so /shell/assets/shell.js above is what
  // precaches it now.
  // The browse-all-apps screen's module used to be listed here. #1083 chunk F
  // moved it into the React bundle, so /shell/assets/shell.js above is what
  // precaches it now.
  // #1036: the real-anchor / new-tab seam. Loads ahead of every other
  // module in index.html, so a cache miss here breaks the whole shell.
  '/js/nav-link.js',
  '/js/platform-ui.js',
  '/js/app-view.js',
  '/js/app.js',
  '/js/build-log.js',
  '/js/cc-progress-summary.js',
  '/js/topochain-events.js',
  '/js/confirm-modal.js',
  '/js/dev-alerts.js',
  // '/js/dev-chat.js' — #1084 chunk G moved it into the React bundle
  // (frontend/src/features/dev-chat/dev-chat.js), which /shell/assets/shell.js
  // already precaches. Precaching it here as well would 404 the install.
  '/js/dev-flow-select.js',
  '/js/dev-host.js',
  // #1054: the offline feedback outbox. It has to be precached like any other
  // shell module — the whole point is that it works on the load where the
  // network does not.
  '/js/feedback-queue.js',
  '/js/group-chat.js',
  // The home screen's three modules (the grid, its widget renderers and the
  // layout geometry they share) were listed here. #1083 chunk F moved all
  // three into the React bundle with the screen they render, so
  // /shell/assets/shell.js above is what precaches them now — which matters
  // more here than for the other chunks: home is the offline landing screen,
  // so a cache miss on it is the whole app.
  // The Kudos widget and the Leaderboard screen's own renderer were listed
  // here. #1083 chunk F moved both into the React bundle with the screen, so
  // /shell/assets/shell.js above is what precaches them now.
  '/js/merge-status.js',
  '/js/native-chrome.js',
  '/js/social-push.js',
  '/js/build-venues.js',
  '/js/credit-options.js',
  '/js/launchpad.js',
  // The profile screen's renderer used to be listed here. #1083 chunk F moved
  // it into the React bundle, so /shell/assets/shell.js above is what
  // precaches it now.
  // The feedback dialog's screenshot-capture module used to be listed here.
  // #1078 chunk I moved it into the React bundle, so /shell/assets/shell.js
  // above is what precaches it now.
  '/js/session-options.js',
  '/js/session-transcript.js',
  '/js/spec-sections.js',
  '/js/streaming-markdown.js',
  '/js/session-state.js',
  // The Leaderboard screen's three Topochain-domain panes were listed here
  // too, and moved in the same chunk. Only the shared event RULES they read
  // (topochain-events.js, above) are still a classic script.
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
  // The hosted-connector consent page. Same reasoning as /cli/authorize: a
  // standalone pre-auth server page with its own stylesheet, outside the
  // app shell. Serving the cached SPA shell for it offline would show a
  // page that looks signed in but cannot approve anything.
  '/connect/authorize',
];

// Prefix-matched counterpart of NO_FALLBACK_PAGES, for standalone pages
// whose path carries a variable segment.
//
// /reports/<token> is a PUBLIC report share link (routes/
// report-snapshots.js, mounted before authMiddleware): a sandboxed,
// self-contained server document meant to be pasted to people with no
// platform session. The recipient most likely to hit this worker is a
// platform user who is logged out on that device — and serving them the
// cached SPA shell (offline, or on the 3s navigate deadline of a slow
// connection) replaces the report with the LOGIN SCREEN, turning a
// deliberately unauthenticated link into an auth wall. The report is
// no-store by design (unshare must bite immediately), so there is no
// cached copy to fall back to either way: bypass, and let it load or
// fail like any plain document.
const NO_FALLBACK_PREFIXES = [
  '/reports/',
];

// Pure request classifier — the single source of truth for what the fetch
// handler does with a request. Returns one of:
//   'bypass'   — don't touch it; the browser talks to the network directly.
//   'navigate' — page navigation: network-first, offline falls back to the
//                cached SPA shell (index.html).
//   'shell'    — same-origin HTML/JS/CSS/manifest/icons: network-first.
//   'api'      — GET /api/* JSON: network-first, cache 200s for offline.
//   'immutable'— content-addressed images (/app-icons, /visuals, /avatars):
//                cache-first.
function classifyRequest(method, url, acceptHeader, mode, selfOrigin) {
  if (method !== 'GET') return 'bypass';

  let u;
  try { u = new URL(url, selfOrigin); } catch { return 'bypass'; }

  // Cross-origin is never intercepted. The shell loads no cross-origin
  // assets at all now, so anything off-origin is a child-app subdomain, an
  // outbound link or a user-supplied image — all of which the browser should
  // handle itself.
  if (u.origin !== selfOrigin) return 'bypass';

  const p = u.pathname;

  // SSE streams must never be intercepted or cached (they'd buffer forever).
  if (/text\/event-stream/i.test(acceptHeader || '')) return 'bypass';
  if (/^\/api\/sessions\/[^/]+\/events$/.test(p)) return 'bypass';

  if (mode === 'navigate') {
    if (NO_FALLBACK_PAGES.includes(p)) return 'bypass';
    if (NO_FALLBACK_PREFIXES.some((pre) => p.startsWith(pre))) return 'bypass';
    return 'navigate';
  }

  // Local-dev mock namespace and short-lived credentials.
  if (p.startsWith('/__mock/')) return 'bypass';
  if (p === '/api/iframe-token') return 'bypass';
  if (p.startsWith('/api/cli/')) return 'bypass';
  if (p === '/api/me/cli-tokens' || p.startsWith('/api/me/cli-tokens/')) {
    return 'bypass';
  }
  // Hosted MCP connector and social-account OAuth: endpoints, OAuth
  // surfaces and identity status. Same hard bypass as the CLI's, for the
  // same reason — none of this may ever be answered from a cache.
  if (p === '/mcp') return 'bypass';
  if (p.startsWith('/api/connect/')) return 'bypass';
  if (p === '/api/me/connectors' || p.startsWith('/api/me/connectors/')) {
    return 'bypass';
  }
  if (p === '/api/me/social-identities' || p.startsWith('/api/me/social-identities/')) {
    return 'bypass';
  }
  if (p === '/api/me/github' || p.startsWith('/api/me/github/')) return 'bypass';
  if (p === '/api/me/x' || p.startsWith('/api/me/x/')) return 'bypass';
  if (p.startsWith('/.well-known/oauth-')) return 'bypass';
  // Auth endpoints are online-only — EXCEPT /api/auth/me, which is cached
  // so the SPA's boot check succeeds offline for a logged-in user.
  if (p.startsWith('/api/auth/') && p !== '/api/auth/me') return 'bypass';

  // A native foreground push is an explicit freshness signal. Its feed read
  // must reach the network: returning the ordinary offline API-cache fallback
  // would consume the invalidation while still omitting the new activity.
  if (p === '/api/notifications' &&
      u.searchParams.get('native_invalidation') === '1') return 'bypass';

  if (p.startsWith('/api/')) return 'api';

  // Content-addressed, already served with a year-long immutable header.
  // /avatars/ joins them (#982): the id rotates whenever the bytes change
  // (POST /api/me/avatar upserts a fresh one), so a cached entry can never
  // be stale — a replaced id simply 404s.
  if (p.startsWith('/app-icons/') || p.startsWith('/visuals/')
      || p.startsWith('/avatars/')) return 'immutable';

  // The shell's own static assets (incl. /usernode-bridge/v1/... versions).
  if (/\.(?:html|js|css|webmanifest)$/i.test(p)) return 'shell';
  if (p.startsWith('/icons/')) return 'shell';

  // Everything else (e.g. the /health connectivity probe) goes straight
  // to the network so it always reflects real reachability.
  return 'bypass';
}

// The URLs at which the server serves the SPA shell ITSELF, as opposed to a
// document that merely falls back to it offline. `networkFirstNavigate`
// caches under the fixed '/index.html' key — one document answers every
// client route — so it may only write back a response that really IS that
// document. Clean app paths are first-class shell documents alongside `/`.
//
// The distinction matters because `classifyRequest` returns 'navigate' for
// far more than these two. /login.html, /dashboard.html, /gallery.html and
// the rest of #860's redirect stubs are a KB of `location.replace()` each:
// correct to *serve* the cached shell for when offline, catastrophic to
// *store* as the cached shell, which would leave every later cache-served
// navigation holding a stub instead of the app. Anything else navigable
// bounces to '/' at the server (middleware/auth.js), so its response is a
// redirect rather than the shell too.
//
// Pure, and exported, so tests/pwa-offline-cache.test.js can pin the stub
// list directly rather than inferring the guard from source text.
const SHELL_DOCUMENT_PATHS = ['/', '/index.html'];

function isShellDocumentUrl(url, selfOrigin) {
  try {
    const u = new URL(url, selfOrigin);
    if (u.origin !== selfOrigin) return false;
    return SHELL_DOCUMENT_PATHS.includes(u.pathname)
      || /^\/app\/[a-z0-9][a-z0-9-]{0,254}(?:\/.*)?$/.test(u.pathname);
  } catch { return false; }
}

// Is this cached API entry exempt from eviction? Pure so the trim and
// age-prune passes can be pinned in Node.
function isImmuneApiRequest(url, selfOrigin) {
  try {
    return IMMUNE_API_PATHS.includes(new URL(url, selfOrigin).pathname);
  } catch { return false; }
}

// Sentinel resolved by the deadline timer. A plain object identity check
// can never collide with a Response.
const TIMED_OUT = { timedOut: true };

// Network-first WITH a deadline (#1021). Pure: every effect is injected,
// so tests drive all three branches with fake fetch / cache / timer.
//
//   { startFetch, matchCache, timeoutMs, schedule } →
//   { response, fromCache, pending }
//
//   - network resolves first        → its response, `pending: null`.
//     Cache-write behaviour is the caller's, inside startFetch, so it is
//     unchanged from before.
//   - network rejects first         → cached copy if there is one, else
//     rethrow. Exactly today's behaviour.
//   - deadline first, cache HIT     → the cached copy immediately, and
//     the still-in-flight request handed back as `pending` so the caller
//     can event.waitUntil() it. The late response still refreshes the
//     cache, which is what keeps the freshness contract honest.
//   - deadline first, cache MISS    → keep waiting on the network. A
//     first-ever load (or a screen this device has never visited) must
//     never fail early just because it is slow.
//
// `schedule(fn, ms)` returns a cancel function.
async function raceNetworkAndCache({ startFetch, matchCache, timeoutMs, schedule }) {
  const network = startFetch();
  // We may hand this promise back to the caller, or abandon it entirely
  // on the cache-hit path — either way nothing here may surface as an
  // unhandled rejection.
  network.catch(() => {});

  let cancelTimer = null;
  const deadline = new Promise((resolve) => {
    cancelTimer = schedule(() => resolve(TIMED_OUT), timeoutMs);
  });

  let first;
  try {
    first = await Promise.race([network, deadline]);
  } catch (err) {
    if (cancelTimer) cancelTimer();
    const hit = await matchCache();
    if (hit) return { response: hit, fromCache: true, pending: null };
    throw err;
  }

  if (first !== TIMED_OUT) {
    if (cancelTimer) cancelTimer();
    return { response: first, fromCache: false, pending: null };
  }

  const hit = await matchCache();
  if (hit) return { response: hit, fromCache: true, pending: network };

  try {
    return { response: await network, fromCache: false, pending: null };
  } catch (err) {
    const late = await matchCache();
    if (late) return { response: late, fromCache: true, pending: null };
    throw err;
  }
}

// Whole-body compare, used to decide whether a late network answer
// actually disagrees with the cached copy the page was already shown. The
// bodies here are API JSON — a few KB — so a byte loop is cheaper than
// hashing and, unlike a hash, has no false positives. Pure and exported so
// tests/pwa-offline-cache.test.js can pin it directly.
function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Service-worker runtime (skipped when loaded in Node for tests).     */
/* ------------------------------------------------------------------ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    classifyRequest,
    apiTimeoutFor,
    BOOT_READ_PATHS,
    BOOT_API_TIMEOUT_MS,
    API_TIMEOUT_MS,
    isImmuneApiRequest,
    isShellDocumentUrl,
    SHELL_DOCUMENT_PATHS,
    raceNetworkAndCache,
    bytesEqual,
    SHELL_ASSETS,
    NO_FALLBACK_PAGES,
    NO_FALLBACK_PREFIXES,
    SW_VERSION,
    API_CACHE,
    ALL_CACHES,
    LEGACY_API_CACHE_RE,
    IMMUNE_API_PATHS,
    NAVIGATE_TIMEOUT_MS,
    SHELL_TIMEOUT_MS,
    API_TIMEOUT_MS,
  };
} else {
  const ORIGIN = self.location.origin;

  // ── Per-page-load shell consistency ─────────────────────────────────
  // The shell's assets are deliberately UNHASHED, so index.html does not
  // pin the build its scripts come from: 38 assets each racing their own
  // deadline independently can hand ONE load a mix of two deploys. The
  // navigation is the first request of a load and answers the only
  // question that matters — is this connection fast right now? — so it
  // records its own outcome here and every shell asset in the same load
  // follows it, instead of re-rolling the dice 38 more times.
  //
  // Heuristic, and deliberately so: a worker restart mid-load resets it,
  // and two tabs loading at once share it. Both degrade to the `false`
  // default, which is the pre-existing per-asset race — never to something
  // that fails.
  let shellFromCacheThisLoad = false;

  // Stamp a response copy with the cached-at time so activate() can prune
  // stale entries. Only used for the API cache. Takes an already-cloned
  // response (cloning must happen synchronously, before the page starts
  // consuming the original body).
  //
  // Returns true when the stored bytes DIFFER from the entry they replaced,
  // but only when asked (`detectChange`) — the comparison costs an extra
  // cache read and a full-body compare, and the only caller that needs the
  // answer is the stale-serve path, where the entry being replaced is the
  // very copy the page is currently rendering.
  async function stampAndPut(cache, request, response, { detectChange = false } = {}) {
    try {
      const headers = new Headers(response.headers);
      headers.set(CACHED_AT_HEADER, String(Date.now()));
      const body = await response.arrayBuffer();
      let changed = false;
      if (detectChange) {
        // Both fallbacks below resolve to "unchanged", i.e. stay quiet:
        //   - no previous entry (evicted between the serve and now) means
        //     there is nothing on screen this could be correcting;
        //   - an unreadable previous body leaves us genuinely unable to
        //     tell, and a re-render we cannot justify is worse than a
        //     stale row the next navigation will fix anyway.
        try {
          const prev = await cache.match(request);
          changed = !!prev && !bytesEqual(await prev.arrayBuffer(), body);
        } catch { changed = false; }
      }
      await cache.put(request, new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }));
      return changed;
    } catch { /* quota or clone failure — offline copy just isn't saved */ }
    return false;
  }

  // Tell every open tab that a cached answer we already served is now out
  // of date. The worker gets exactly ONE response per request, so without
  // this the corrected copy would sit in the cache until the next reload
  // and "instant" would mean "instant and wrong".
  //
  // Broadcast rather than event.clientId: a second tab on this origin was
  // served the same stale entry from the same cache and is just as wrong.
  // The noise that buys is bounded on the page side — App.refreshActiveScreen
  // bails on a hidden tab or an open sheet.
  async function notifyClients(message) {
    try {
      const windows = await self.clients.matchAll({ type: 'window' });
      for (const client of windows) client.postMessage(message);
    } catch { /* best-effort — a missed correction is just a stale screen */ }
  }

  // Oldest-first eviction keeps the API cache bounded. Cache keys iterate
  // in insertion order, so dropping from the front approximates LRU-by-write.
  // Immune entries (the session) are excluded from BOTH the budget and the
  // eviction list, so they can neither be dropped nor push a real entry out.
  async function trimApiCache(cache) {
    try {
      const keys = await cache.keys();
      const evictable = keys.filter((k) => !isImmuneApiRequest(k.url, ORIGIN));
      for (let i = 0; i < evictable.length - API_CACHE_MAX_ENTRIES; i++) {
        await cache.delete(evictable[i]);
      }
    } catch { /* best-effort */ }
  }

  async function pruneStaleApiEntries() {
    try {
      const cache = await caches.open(API_CACHE);
      const keys = await cache.keys();
      const now = Date.now();
      for (const key of keys) {
        if (isImmuneApiRequest(key.url, ORIGIN)) continue;
        const res = await cache.match(key);
        const at = Number(res && res.headers.get(CACHED_AT_HEADER));
        if (at && now - at > API_CACHE_MAX_AGE_MS) await cache.delete(key);
      }
    } catch { /* best-effort */ }
  }

  // Deadline timer for raceNetworkAndCache; returns its cancel function.
  function swSchedule(fn, ms) {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  }

  async function networkFirstShell(event) {
    const cache = await caches.open(SHELL_CACHE);
    const fetchAndCache = () => fetch(event.request).then((res) => {
      // Clone synchronously, before the page can start reading the body.
      if (res && res.ok) cache.put(event.request, res.clone()).catch(() => {});
      return res;
    });

    // This load's navigation already lost its race, so the connection is
    // known-slow AND the document being parsed is the cached one. Serve the
    // cached asset outright rather than making all 38 of them re-discover
    // the same fact one 200ms deadline at a time — that serial rediscovery
    // is most of the reported slowness, and mixing a cached document with
    // freshly-fetched scripts is the split-build hazard the flag exists to
    // avoid. The network copy still lands in the cache for the next load.
    if (shellFromCacheThisLoad) {
      const hit = await cache.match(event.request, { ignoreSearch: true });
      if (hit) {
        event.waitUntil(fetchAndCache().catch(() => {}));
        return hit;
      }
      // A miss here is a genuinely new asset (a deploy added one). Fall
      // through: there is nothing cached to prefer.
    }

    const { response, pending } = await raceNetworkAndCache({
      startFetch: fetchAndCache,
      matchCache: () => cache.match(event.request, { ignoreSearch: true }),
      timeoutMs: SHELL_TIMEOUT_MS,
      schedule: swSchedule,
    });
    // Served from cache on the deadline: keep the request alive so its
    // response still lands in the cache for the next load.
    if (pending) event.waitUntil(pending.catch(() => {}));
    return response;
  }

  async function networkFirstNavigate(event) {
    const cache = await caches.open(SHELL_CACHE);

    // The cached document MUST be refreshed from here, and this is the only
    // place that can do it. install() precaches /index.html once per worker
    // and nothing else ever writes that key, so without this the cached
    // shell is frozen at whatever shipped the last time sw.js itself changed
    // bytes — and every load that misses the 200ms deadline (i.e. most of
    // them: the deadline is deliberately BELOW a round trip) serves it.
    //
    // That is not a hypothetical. #1400 moved the page ground from
    // `bg-white` to `bg-zinc-100` in the <body> class and, correctly, did
    // not touch this file — so install() never re-ran, and every ordinary
    // load kept rendering the pre-reskin document with the white ground
    // while a hard refresh, which bypasses the worker entirely, showed the
    // new grey one. It could not self-heal, because the deploy that would
    // have fixed it is exactly the thing not being stored.
    //
    // Written under the FIXED '/index.html' key, not event.request: that is
    // the key matchCache reads for every route, and storing per-URL would
    // leave the one key that is actually read still stale. Guarded by
    // isShellDocumentUrl for the reason given there — 'navigate' also
    // covers the redirect stubs, and caching one of those AS the shell
    // would be far worse than the staleness this fixes.
    const fetchAndCache = () => fetch(event.request).then((res) => {
      // Clone synchronously, before the page can start reading the body.
      if (res && res.ok && !res.redirected
          && isShellDocumentUrl(event.request.url, ORIGIN)) {
        cache.put('/index.html', res.clone()).catch(() => {});
      }
      return res;
    });

    // Any SPA path serves index.html online (the server's catch-all), so
    // the cached shell is the correct fallback for every route —
    // including the old standalone auth pages, which are redirect stubs
    // into the SPA's hash routes now (fold-auth-pages-into-SPA).
    const { response, fromCache, pending } = await raceNetworkAndCache({
      startFetch: fetchAndCache,
      matchCache: () => cache.match('/index.html'),
      timeoutMs: NAVIGATE_TIMEOUT_MS,
      schedule: swSchedule,
    });
    // Publish the verdict for the ~38 shell assets this document is about
    // to request. See shellFromCacheThisLoad.
    shellFromCacheThisLoad = fromCache;
    if (pending) event.waitUntil(pending.catch(() => {}));
    return response;
  }

  async function networkFirstApi(event) {
    const cache = await caches.open(API_CACHE);
    // Did we answer this request from cache while the network was still in
    // flight? Only then is a late, DIFFERENT answer worth telling the page
    // about — on an ordinary fresh load the page already HAS that answer,
    // and posting anyway would re-render every screen on every load.
    //
    // Set inside matchCache rather than from the returned `fromCache`: the
    // cache read completes before raceNetworkAndCache resolves, so the flag
    // is already true by the time the late network response can run the
    // handler below. Reading it afterwards would leave a window in which a
    // just-missed response found it still false.
    const served = { fromCache: false };

    const { response, pending } = await raceNetworkAndCache({
      startFetch: () => fetch(event.request).then((res) => {
        // Only genuine successes are worth replaying offline; 401/403/500
        // must never mask a later real answer. Clone before returning —
        // once the page starts reading the body the response is locked.
        if (res && res.status === 200) {
          const copy = res.clone();
          event.waitUntil((async () => {
            const changed = await stampAndPut(cache, event.request, copy,
              { detectChange: served.fromCache });
            await trimApiCache(cache);
            if (served.fromCache && changed) {
              await notifyClients({ type: 'api-updated', url: event.request.url });
            }
          })());
        }
        return res;
      }),
      matchCache: async () => {
        const hit = await cache.match(event.request);
        if (hit) served.fromCache = true;
        return hit;
      },
      timeoutMs: apiTimeoutFor(event.request.url, ORIGIN),
      schedule: swSchedule,
    });
    if (pending) event.waitUntil(pending.catch(() => {}));
    return response;
  }

  async function cacheFirstImmutable(event) {
    const cache = await caches.open(IMMUTABLE_CACHE);
    const hit = await cache.match(event.request);
    if (hit) return hit;
    const res = await fetch(event.request);
    if (res && res.ok) cache.put(event.request, res.clone()).catch(() => {});
    return res;
  }

  self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      const shell = await caches.open(SHELL_CACHE);
      // Per-asset, best-effort: one 404 must not brick the whole install.
      // Every asset the shell needs is same-origin now, so a completed
      // install is enough to render offline — there is no second,
      // cross-origin precache pass that can partially fail any more.
      await Promise.allSettled(SHELL_ASSETS.map((path) => shell.add(path)));
      await self.skipWaiting();
    })());
  });

  // One-time rescue of the API entries a pre-#1021 worker parked under a
  // version-named cache. Runs on activate BEFORE the prune below deletes
  // those names — otherwise this very upgrade would sign the device out
  // offline, which is the bug #1021 reported.
  async function migrateLegacyApiCaches(names) {
    const legacy = names.filter((n) => LEGACY_API_CACHE_RE.test(n));
    if (!legacy.length) return;
    try {
      const target = await caches.open(API_CACHE);
      for (const name of legacy) {
        const src = await caches.open(name);
        for (const key of await src.keys()) {
          // Never overwrite a fresher entry the new worker already stored.
          if (await target.match(key)) continue;
          const res = await src.match(key);
          if (res) await target.put(key, res);
        }
      }
    } catch { /* best-effort — a failed migration must not block activate */ }
  }

  // Logout must not leave one user's API responses readable by the next.
  // Legacy names are included: they may still hold a pre-migration copy.
  async function clearApiCaches() {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n === API_CACHE || LEGACY_API_CACHE_RE.test(n))
      .map((n) => caches.delete(n)));
  }

  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      const names = await caches.keys();
      await migrateLegacyApiCaches(names);
      // Drop caches from older SW versions.
      await Promise.all(names
        .filter((n) => n.startsWith('usernode-') && !ALL_CACHES.includes(n))
        .map((n) => caches.delete(n)));
      await pruneStaleApiEntries();
      await self.clients.claim();
    })());
  });

  self.addEventListener('message', (event) => {
    const type = event.data && event.data.type;
    if (type === 'clear-api-cache') {
      event.waitUntil((async () => {
        await clearApiCaches();
        const port = event.ports && event.ports[0];
        if (port) port.postMessage({ done: true });
      })());
    }
  });

  self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Belt-and-braces logout isolation: a logout passing through (never
    // intercepted — it's a POST) still wipes the per-user API cache.
    if (req.method === 'POST' && new URL(req.url).pathname === '/api/auth/logout') {
      event.waitUntil(clearApiCaches());
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
      default: /* bypass — browser default network handling */ break;
    }
  });
}
