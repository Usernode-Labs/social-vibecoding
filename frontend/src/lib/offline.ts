/**
 * Connectivity state for the shell — the engine half of /js/offline.js
 * (#487), moved into the React bundle by #1078 chunk A.
 *
 * Connectivity truth is a *probe*, not `navigator.onLine` — the flag
 * false-positives behind captive portals and some WebViews. online/offline
 * events (and WS drops via `Offline.nudge()`) only trigger a re-probe of the
 * real /health endpoint; the banner follows the probe result. /health is
 * deliberately on the service worker's bypass list so the probe always
 * reflects real reachability, never a cached copy.
 *
 * ── What moved, and what deliberately did not ──────────────────────────
 *
 * The banner element is now a React island (features/shell/banners.tsx), so
 * the one line that used to do `banner.classList.toggle('hidden', !offline)`
 * publishes into the visibility store instead and the island renders the
 * class. The legacy integration points remain:
 *
 *   - `window.Offline` keeps its exact API. Six call sites across app.js,
 *     app-view.js, home.js and auth-screens.js use `Offline.isOffline()` /
 *     `.nudge()` / `.forceOffline()`, and app.js's `?shot=offline` deep link
 *     depends on the last one. They are classic scripts; rewriting them is not
 *     this chunk's scope.
 *   - `document.body.classList.toggle('is-offline', …)` stays a direct DOM
 *     write. `<body>` is React's hydration root but its className is owned by
 *     the build (BODY_ATTRS in frontend/scripts/build-shell.mjs) and never
 *     re-rendered, and public/css/app.css hangs every offline affordance off
 *     that one class — the auth strip, `.offline-only` blocks,
 *     `[data-offline-disabled]` controls.
 *   - The `usernode:offline-change` CustomEvent still fires. Other modules
 *     re-render on it.
 *   - The delegated `[data-offline-retry]` click handler stays on `document`,
 *     so it keeps working for markup that was hidden when its own module ran.
 *
 * ── Why this registers at module scope, not in an effect ───────────────
 *
 * Load order. `App.init()` runs on DOMContentLoaded; deferred modules execute
 * before that event fires, but React effects for the hydrating tree may not
 * have flushed. `App._applyOfflineShot()` calls `Offline.forceOffline()`
 * during init, and home.js/auth-screens.js read `Offline.isOffline()` while
 * painting their first frame. So `window.Offline` has to exist the moment this
 * module evaluates — not one microtask later.
 */

import { publishVisibility, readVisibility } from './visibility-store';

/** The visibility-store key the banner island subscribes to. */
export const OFFLINE_BANNER_ID = 'offline-banner';

export interface OfflineApi {
  isOffline(): boolean;
  nudge(): void;
  forceOffline(): void;
  probe(): Promise<void>;
}

let offline = false;
let probing: Promise<void> | null = null;
let recheckTimer: ReturnType<typeof setInterval> | null = null;
const PROBE_TIMEOUT_MS = 5000;
// Set by forceOffline() for the ?shot= deep links: the state is pinned and
// probing is disabled, so a screenshot of the offline UI can be taken on a
// perfectly good connection.
let forced = false;

function syncRecheck(): void {
  // While offline, re-probe on a slow loop so the banner clears even when the
  // browser never fires an `online` event (common in WebViews).
  if (forced) {
    if (recheckTimer) {
      clearInterval(recheckTimer);
      recheckTimer = null;
    }
    return;
  }
  if (offline && !recheckTimer) {
    recheckTimer = setInterval(() => { void probe(); }, 15000);
  } else if (!offline && recheckTimer) {
    clearInterval(recheckTimer);
    recheckTimer = null;
  }
}

function set(next: boolean): void {
  // A pinned state outranks a probe that was ALREADY in flight when
  // forceOffline() ran — probe() checks `forced` on entry, so its late
  // resolution would otherwise un-pin the state mid-capture. That race is why
  // ?shot=feedback-queued intermittently photographed an online shell (#1054):
  // the global-events socket opening calls Offline.nudge() a few ms earlier.
  if (forced && !next) return;
  if (next === offline) {
    syncRecheck();
    return;
  }
  offline = next;
  // The banner is React-owned now: publish, don't touch its class.
  publishVisibility(OFFLINE_BANNER_ID, offline);
  try {
    document.body.classList.toggle('is-offline', offline);
  } catch {
    /* pre-body */
  }
  try {
    window.dispatchEvent(new CustomEvent('usernode:offline-change', { detail: { offline } }));
  } catch {
    /* CustomEvent unavailable — the banner alone still works */
  }
  syncRecheck();
}

export function probe(): Promise<void> {
  if (forced) return Promise.resolve();
  if (probing) return probing;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  // A network request can remain pending across a reconnect. Bound the probe
  // itself as well as aborting the fetch, so every retry cannot get stuck
  // joining the same request. Only the race winner may publish a result.
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
      controller.abort();
    }, PROBE_TIMEOUT_MS);
  });
  const health = Promise.resolve()
    .then(() => fetch('/health', { cache: 'no-store', signal: controller.signal }))
    .then((res) => res.ok, () => false);
  probing = Promise.race([health, deadline])
    .then((reachable) => set(!reachable))
    .finally(() => {
      clearTimeout(timer);
      probing = null;
    });
  return probing;
}

export function isOffline(): boolean {
  return offline;
}

/** Whether the banner should be showing right now (for a first render). */
export function offlineBannerVisible(): boolean {
  return readVisibility(OFFLINE_BANNER_ID) === true;
}

/**
 * Pin the offline state on (screenshot deep links — see
 * App._applyOfflineShot). Every later probe is a no-op, so nothing can quietly
 * flip the UI back to online mid-capture.
 */
export function forceOffline(): void {
  set(true);
  forced = true;
  syncRecheck();
}

// ── Recovery off the app's own traffic (#3191) ─────────────────────────
//
// The probe answers one question only: can THIS browser reach /health?
// Some browsers answer no for reasons that have nothing to do with the
// network — a stale service worker still intercepting the endpoint, an
// extension, a WebView with its own DNS — while the app's own requests
// keep succeeding around them. The 15s re-probe loop then re-confirms
// the same broken /health forever, and the banner sticks over a session
// that is demonstrably live.
//
// So recovery also listens to the app's own fetches: one wrapper around
// `window.fetch`, installed here where the flag lives, so it covers every
// caller in both bundles (the same shape installJoinRequired uses). A
// successful same-origin response is the strongest proof of reachability
// there is — it is exactly the thing the banner says is impossible — and
// it clears the state the moment it lands instead of waiting for the
// next probe tick.
//
// It clears DIRECTLY, not through nudge(): a nudge would re-ask /health,
// which is precisely the endpoint that is lying. The one way a
// successful-looking response can still arrive while the device truly is
// offline is the service worker's network-first cache fallback; the next
// failed fetch re-raises the strip through the existing nudge paths
// (home.js's failed load, the WS drop), so the worst a dead network
// costs is one banner flicker instead of a stuck one.

function isSameOrigin(input: RequestInfo | URL): boolean {
  try {
    const raw = typeof input === 'object' && input !== null && 'url' in input
      ? (input as Request).url
      : String(input);
    return new URL(raw, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** Clear a stuck offline state on proof the origin answered. Internal. */
function noteSuccess(): void {
  // set() refuses to un-pin a forced state anyway, but skip the work too:
  // a ?shot= capture must never see the flag move.
  if (!offline || forced) return;
  set(false);
}

/**
 * Wrap `window.fetch` once. Successes pass through untouched; the only
 * added behaviour is the clearing above. Idempotent.
 */
function installSuccessProbe(win: any = typeof window !== 'undefined' ? window : null): void {
  if (!win || typeof win.fetch !== 'function' || win.__offlineSuccessProbeInstalled) return;
  const send: typeof fetch = win.fetch.bind(win);
  win.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await send(input, init);
    try {
      if (res && res.ok && offline && isSameOrigin(input)) noteSuccess();
    } catch {
      /* the answer passes through untouched either way */
    }
    return res;
  };
  win.__offlineSuccessProbeInstalled = true;
}

let started = false;

/** Install `window.Offline` and start listening. Idempotent. */
export function initOffline(): OfflineApi {
  const api: OfflineApi = {
    isOffline,
    // Debounced entry point for "something looks disconnected" signals (the
    // global-events WS closing, a failed fetch, etc.).
    nudge: () => { void probe(); },
    forceOffline,
    probe,
  };
  (window as unknown as { Offline: OfflineApi }).Offline = api;
  if (started) return api;
  started = true;
  installSuccessProbe(window);

  window.addEventListener('online', () => { void probe(); });
  window.addEventListener('offline', () => { void probe(); });
  // Background tabs can have their retry timers throttled. Check immediately
  // when the user returns, without adding probes to healthy tab switches.
  const recheckVisible = () => {
    if (offline && document.visibilityState === 'visible') void probe();
  };
  document.addEventListener('visibilitychange', recheckVisible);
  window.addEventListener('focus', recheckVisible);
  // "Try again" inside any .offline-only block. Delegated from the document so
  // screens don't each need wiring, and so it works on markup that was hidden
  // when its own module ran.
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    const btn = target && target.closest && target.closest('[data-offline-retry]');
    if (!btn) return;
    e.preventDefault();
    void probe();
  });
  // Trust the flag when it says offline at boot; otherwise stay quiet until
  // something (an event, a WS drop) suggests trouble.
  if (navigator.onLine === false) void probe();
  return api;
}
