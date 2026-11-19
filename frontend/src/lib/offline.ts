/**
 * Connectivity state for the shell — the engine half of /js/offline.js
 * (#487), moved into the React bundle by #1078 chunk A.
 *
 * Connectivity truth is a *probe*, not `navigator.onLine` — the flag
 * false-positives behind captive portals and some WebViews. online/offline
 * events (and WS drops via `Offline.nudge()`) only trigger a re-probe of the
 * real /health endpoint; the banner follows the probe result. /health is
 * deliberately on the service worker's bypass list so the probe always
 * reflects real reachability, never a cached copy. The one word taken
 * without a probe is the native shell's that the phone has no network at
 * all (NATIVE_CONNECTIVITY_EVENT, nativeConnectivity below).
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

import { initFreshness, resetFreshness } from './freshness';
import { createStore } from './plain-store.js';
import { publishVisibility, readVisibility } from './visibility-store';

/**
 * The visibility-store key the offline state is published under. The amber
 * strip that read it is gone (the native-offline proposal, 18 Nov 2026): the
 * header says it now (connectionStatusStore below), and this key stays for
 * the code that asks whether the shell is showing its offline state.
 */
export const OFFLINE_BANNER_ID = 'offline-banner';

/**
 * What the header's connection status says (features/header/
 * connection-status.tsx), as native apps put it in their title bar:
 *
 *   - `online`: nothing;
 *   - `connecting`: Homeroom does not answer, though the phone may have a
 *     network (the /health probe failed, or a read hung);
 *   - `no-internet`: the phone itself says it has no network (the native
 *     shell's word, or the browser's `offline`);
 *   - `updating`: a planned restart for a release (#6403).
 *
 * It follows the offline state with a short HYSTERESIS, so a patchy link
 * does not make it flicker: once shown it stays MIN_SHOWN_MS, and
 * FLAP_SHOWN_MS when it went away less than FLAP_WINDOW_MS ago. Only what is
 * SHOWN lingers: `isOffline()` and `body.is-offline` move at once, so queued
 * writes go the moment the server answers. The holds are short on purpose
 * (the follow-up after the 19 Nov retest): they were 10 s and 60 s, and
 * "Connecting…" stayed up a full minute over a connection that was back.
 */
export type ConnectionStatus = 'online' | 'connecting' | 'no-internet' | 'updating';

export const connectionStatusStore = createStore<{ status: ConnectionStatus }>({ status: 'online' });

export const MIN_SHOWN_MS = 3_000;
export const FLAP_SHOWN_MS = 10_000;
export const FLAP_WINDOW_MS = 2 * 60 * 1000;

/**
 * A same-origin read unanswered this long (./read-timeout.ts SLOW_READ_MS
 * says so through `slowRead`) is a sign the network carries nothing (offline test, 18 Nov 2026: on a quiet network the socket gave up
 * after 35 s and the strip came 20-26 s in). It asks the probe at once, and a
 * failed probe after a hung read is believed without the confirming check.
 */
export const HUNG_READ_MS = 5000;
/** How long a hung read counts as the probe's second witness. */
const HUNG_READ_COUNTS_MS = 15_000;

/**
 * A SLOW LINK IS NOT A DEAD ONE (the native-offline follow-up, 19 Nov 2026).
 * On a 600 ms / 500 kbps link the probe's /health read waited behind the
 * bandwidth every other read was using, timed out, and with a stuck read as
 * its second witness the shell went offline: "Connecting…", controls greyed,
 * writes queued, on a network that was answering. So a probe that TIMED OUT
 * is not believed while the network answered within this long. Four things
 * tell `answered`: an API read the network answered (./read-timeout.ts, never
 * for the service worker's saved copy), the worker's own network read landing
 * behind a saved copy it served (public/sw.js `network-answered`, through
 * ./service-worker.ts: on the 19 Nov retest the worker served saved copies
 * after its 4 s deadline and the page saw no answer at all), a network body
 * the worker hands the page still arriving (the same message, from sw.js
 * `reportArriving`: a change page's shots queued 17 s of bytes, every read
 * waited behind them, and the page, which never sees an image's bytes, went
 * 10 s without an answer), and a frame on the events socket
 * (public/js/app.js). A probe that failed outright still is believed, and so
 * is the phone saying it has no network.
 */
export const ANSWERED_RECENTLY_MS = 10_000;

/**
 * The banner's planned-restart notice (issue #6403): while Homeroom restarts
 * for a release, the amber strip says "Updating Homeroom..." instead of the
 * offline words, and `body.is-offline` is never turned on. Separate store key,
 * no DOM id: the banner element is still `#offline-banner`.
 */
export const RESTART_NOTICE_ID = 'offline-banner:restart';

/**
 * The native shell's word on the phone's network (flutter-mobile-app, from
 * connectivity_plus): `detail` is `{ online, via }`, `via` the kinds of
 * network the phone has (`wifi`, `mobile`, …, or `none`). Sent on every
 * change and once after each page load; the last one also stays on
 * `window.__usernodeNativeConnectivity`.
 */
export const NATIVE_CONNECTIVITY_EVENT = 'usernode:native-connectivity';

/**
 * Fired on `window` when the phone moved to another network while this
 * page was online (Wi-Fi handing over to cellular): connections made on the
 * old one can be dead with nothing to say so. App (public/js/app.js
 * _networkHandedOver) asks its events socket and reads the screen again.
 */
export const NETWORK_CHANGED_EVENT = 'usernode:network-changed';

interface NativeConnectivity {
  online?: unknown;
  via?: unknown;
}

export interface OfflineApi {
  isOffline(): boolean;
  nudge(): void;
  forceOffline(): void;
  probe(): Promise<void>;
  slowRead(): void;
  answered(): void;
  restartNotice(): void;
  restartDone(): void;
  restartNoticeVisible(): boolean;
}

let offline = false;
let probing: Promise<void> | null = null;
let recheckTimer: ReturnType<typeof setInterval> | null = null;
// Consecutive failed /health checks. One slow or failed answer is not an
// outage: a release or a busy moment can miss one, so the banner waits for a
// second check (CONFIRM_DELAY_MS later) and a good answer resets the count
// (issue #6403: a single failed probe showed this banner for a minute).
let failures = 0;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restarting = false;
const PROBE_TIMEOUT_MS = 5000;
// How long after a first failed check the confirming one runs.
const CONFIRM_DELAY_MS = 2000;
// How long the update notice stands before the normal offline path takes over.
const RESTART_NOTICE_MS = 60000;
// Set by forceOffline() for the ?shot= deep links: the state is pinned and
// probing is disabled, so a screenshot of the offline UI can be taken on a
// perfectly good connection.
let forced = false;
// The phone said it has no network (native shell or the browser's flag).
let noNetwork = false;
// When the last same-origin read hung (HUNG_READ_MS), or 0.
let hungAt = 0;
// When the network last answered an API read (status under 500), or 0.
let answeredAt = 0;
// The header status's hysteresis: when it was last shown and hidden, whether
// this showing came soon after the last one, and the pending hide.
let shownAt = 0;
let hiddenAt = 0;
let flapping = false;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function wantedStatus(): ConnectionStatus {
  if (offline) return noNetwork ? 'no-internet' : 'connecting';
  if (restarting) return 'updating';
  return 'online';
}

/** Move the header status toward the current state, holding it up as the hysteresis says. */
function publishStatus(now: number = Date.now()): void {
  const want = wantedStatus();
  const current = connectionStatusStore.get().status;
  if (want !== 'online') {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (current === 'online') {
      flapping = hiddenAt > 0 && now - hiddenAt < FLAP_WINDOW_MS;
      shownAt = now;
    }
    if (current !== want) connectionStatusStore.set({ status: want });
    return;
  }
  if (current === 'online') return;
  // A restart notice is the server's own word that it is back: no hold. So
  // too a pinned screenshot state, which never clears anyway.
  const hold = current === 'updating' ? 0 : (flapping ? FLAP_SHOWN_MS : MIN_SHOWN_MS) - (now - shownAt);
  if (hold > 0) {
    if (!hideTimer) hideTimer = setTimeout(() => { hideTimer = null; publishStatus(); }, hold);
    return;
  }
  // A restart notice going is no flap: only an offline spell counts.
  if (current !== 'updating') hiddenAt = now;
  connectionStatusStore.set({ status: 'online' });
  // Back online, every screen reads again: nothing saved is on show.
  resetFreshness();
}

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
  if (!next) noNetwork = false;
  if (next === offline) {
    publishStatus();
    syncRecheck();
    return;
  }
  offline = next;
  publishVisibility(OFFLINE_BANNER_ID, offline);
  publishStatus();
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
  // What the check found: an answer, no answer in time, or a failure.
  type Outcome = 'ok' | 'timeout' | 'failed';
  const deadline = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
      controller.abort();
    }, PROBE_TIMEOUT_MS);
  });
  const health = Promise.resolve()
    .then(() => fetch('/health', { cache: 'no-store', signal: controller.signal }))
    .then((res): Outcome => (res.ok ? 'ok' : 'failed'), (): Outcome => 'failed');
  probing = Promise.race([health, deadline])
    .then((outcome) => {
      if (outcome === 'ok') {
        failures = 0;
        hungAt = 0;
        if (confirmTimer) {
          clearTimeout(confirmTimer);
          confirmTimer = null;
        }
        set(false);
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) noNetwork = true;
      // Slow, not gone: the check ran out of time while other reads were
      // being answered (ANSWERED_RECENTLY_MS). Nothing is counted, the stuck
      // read is explained, and the next sign of trouble asks again.
      if (outcome === 'timeout' && !offline && !noNetwork
          && answeredAt > 0 && Date.now() - answeredAt < ANSWERED_RECENTLY_MS) {
        hungAt = 0;
        return;
      }
      failures += 1;
      // Two failures in a row (or a tab already showing the banner): a real
      // outage. One is not enough — ask again in two seconds first — unless
      // a read hung just before it: two witnesses, the same as two checks.
      const hungRecently = hungAt > 0 && Date.now() - hungAt < HUNG_READ_COUNTS_MS;
      if (failures >= 2 || offline || hungRecently) {
        if (confirmTimer) {
          clearTimeout(confirmTimer);
          confirmTimer = null;
        }
        set(true);
        return;
      }
      if (!forced && !confirmTimer) {
        confirmTimer = setTimeout(() => {
          confirmTimer = null;
          void probe();
        }, CONFIRM_DELAY_MS);
      }
    })
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
 * The planned-restart notice (issue #6403): the server closed the socket with
 * 1012, "Service restart", because a release is replacing this Pod. That is
 * routine, not an outage, so the strip says "Updating Homeroom..." and the
 * offline look stays off. It clears on the next connection (restartDone), or
 * after a minute, when a probe decides whether the tab really is offline.
 * A second call while the notice is up keeps the first timer.
 */
export function restartNotice(): void {
  if (forced) return;
  if (restarting) return;
  restarting = true;
  publishVisibility(RESTART_NOTICE_ID, true);
  publishStatus();
  restartTimer = setTimeout(() => {
    restartTimer = null;
    restarting = false;
    publishVisibility(RESTART_NOTICE_ID, false);
    publishStatus();
    void probe();
  }, RESTART_NOTICE_MS);
}

/** The socket opened again: the restart is over and the strip goes at once. */
export function restartDone(): void {
  if (forced) return;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (!restarting) return;
  restarting = false;
  publishVisibility(RESTART_NOTICE_ID, false);
  publishStatus();
}

/** Whether the update notice should be showing now (for a first render). */
export function restartNoticeVisible(): boolean {
  return readVisibility(RESTART_NOTICE_ID) === true;
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

// The kinds of network in the native shell's last word, or null before one.
let nativeVia: string | null = null;

/**
 * The phone's own word on its network (NATIVE_CONNECTIVITY_EVENT), which a
 * probe cannot give: the browser's `online` flag stays true on a phone with
 * no network at all in some web views, and says nothing when one network
 * hands over to another (offline test, 2 Nov 2026). No network is believed
 * at once, with nothing to probe over; the probe's own loop watches for the
 * way back. A network while offline, or another network while online, is a
 * reason to probe now rather than on the next failed read, and the second is
 * announced (NETWORK_CHANGED_EVENT). The same network again, online, says
 * nothing new.
 */
export function nativeConnectivity(detail: NativeConnectivity | null | undefined): void {
  if (!detail || typeof detail.online !== 'boolean') return;
  const via = Array.isArray(detail.via) ? detail.via.filter((kind) => typeof kind === 'string').join(',') : '';
  const moved = nativeVia !== null && via !== nativeVia;
  nativeVia = via;
  if (!detail.online) {
    noNetwork = true;
    set(true);
    return;
  }
  // A network again: until Homeroom answers, the header says "Connecting".
  if (noNetwork) {
    noNetwork = false;
    publishStatus();
  }
  // Online and still on the same network (the word every page load gets):
  // nothing to ask.
  if (!offline && !moved) return;
  const wasOffline = offline;
  void probe();
  if (wasOffline) return;
  try {
    window.dispatchEvent(new CustomEvent(NETWORK_CHANGED_EVENT, { detail: { via: via ? via.split(',') : [] } }));
  } catch {
    /* CustomEvent unavailable: the probe alone still runs */
  }
}

/**
 * A read has gone HUNG_READ_MS unanswered (./read-timeout.ts tells this):
 * probe now, and let a failed probe count it as the second witness.
 */
export function slowRead(): void {
  if (forced) return;
  hungAt = Date.now();
  void probe();
}

/** The network answered an API read (./read-timeout.ts): the link is carrying something. */
export function answered(): void {
  answeredAt = Date.now();
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
    slowRead,
    answered,
    restartNotice,
    restartDone,
    restartNoticeVisible,
  };
  (window as unknown as { Offline: OfflineApi }).Offline = api;
  if (started) return api;
  started = true;

  initFreshness();
  window.addEventListener('online', () => { void probe(); });
  window.addEventListener('offline', () => {
    noNetwork = true;
    void probe();
  });
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
  window.addEventListener(NATIVE_CONNECTIVITY_EVENT, (e) => {
    nativeConnectivity((e as CustomEvent<NativeConnectivity>).detail);
  });
  // Trust the flag when it says offline at boot; otherwise stay quiet until
  // something (an event, a WS drop) suggests trouble. So too the native
  // shell's last word, when one came before this ran.
  const last = (window as unknown as { __usernodeNativeConnectivity?: NativeConnectivity }).__usernodeNativeConnectivity;
  if (last) nativeConnectivity(last);
  else if (navigator.onLine === false) void probe();
  return api;
}
