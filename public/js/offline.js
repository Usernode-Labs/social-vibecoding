// Offline mode (#487): service-worker registration, connectivity state,
// and the "You're offline" banner.
//
// Connectivity truth is a *probe*, not navigator.onLine — the flag
// false-positives behind captive portals and some WebViews. online/offline
// events (and WS drops via Offline.nudge()) only trigger a re-probe of the
// real /health endpoint; the banner follows the probe result. /health is
// deliberately on the service worker's bypass list so the probe always
// reflects real reachability, never a cached copy.
window.Offline = {
  _offline: false,
  _probing: null,
  _recheckTimer: null,
  // Set by forceOffline() for the ?shot= deep links: the state is pinned
  // and probing is disabled, so a screenshot of the offline UI can be
  // taken on a perfectly good connection.
  _forced: false,

  init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Unsupported / blocked contexts (e.g. some WebViews) just keep
        // today's online-only behaviour.
      });
    }
    window.addEventListener('online', () => Offline.probe());
    window.addEventListener('offline', () => Offline.probe());
    // "Try again" inside any .offline-only block. Delegated from the
    // document so screens don't each need wiring, and so it works on
    // markup that was hidden when its own module ran.
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-offline-retry]');
      if (!btn) return;
      e.preventDefault();
      Offline.probe();
    });
    // Trust the flag when it says offline at boot; otherwise stay quiet
    // until something (an event, a WS drop) suggests trouble.
    if (navigator.onLine === false) Offline.probe();
  },

  isOffline() {
    return Offline._offline;
  },

  // Debounced entry point for "something looks disconnected" signals
  // (the global-events WS closing, a failed fetch, etc.).
  nudge() {
    Offline.probe();
  },

  // Pin the offline state on (screenshot deep links — see
  // App._applyOfflineShot). Every later probe is a no-op, so nothing can
  // quietly flip the UI back to online mid-capture.
  forceOffline() {
    Offline._set(true);
    Offline._forced = true;
    Offline._syncRecheck();
  },

  probe() {
    if (Offline._forced) return Promise.resolve();
    if (Offline._probing) return Offline._probing;
    Offline._probing = fetch('/health', { cache: 'no-store' })
      .then((res) => Offline._set(!res.ok))
      .catch(() => Offline._set(true))
      .finally(() => { Offline._probing = null; });
    return Offline._probing;
  },

  _set(offline) {
    if (offline === Offline._offline) {
      Offline._syncRecheck();
      return;
    }
    Offline._offline = offline;
    const banner = document.getElementById('offline-banner');
    if (banner) banner.classList.toggle('hidden', !offline);
    // One body-level flag drives every offline affordance in CSS: the
    // strip lifting above the auth overlays, the .offline-only blocks
    // appearing, and [data-offline-disabled] controls greying out. Doing
    // it here means no screen has to subscribe just to look right.
    try { document.body.classList.toggle('is-offline', offline); } catch { /* pre-body */ }
    // Other modules (App-tab iframe placeholder, etc.) re-render on this.
    try {
      window.dispatchEvent(new CustomEvent('usernode:offline-change', {
        detail: { offline },
      }));
    } catch { /* CustomEvent unavailable — banner alone still works */ }
    Offline._syncRecheck();
  },

  // While offline, re-probe on a slow loop so the banner clears even when
  // the browser never fires an `online` event (common in WebViews).
  _syncRecheck() {
    if (Offline._forced) {
      if (Offline._recheckTimer) {
        clearInterval(Offline._recheckTimer);
        Offline._recheckTimer = null;
      }
      return;
    }
    if (Offline._offline && !Offline._recheckTimer) {
      Offline._recheckTimer = setInterval(() => Offline.probe(), 15000);
    } else if (!Offline._offline && Offline._recheckTimer) {
      clearInterval(Offline._recheckTimer);
      Offline._recheckTimer = null;
    }
  },
};

Offline.init();
