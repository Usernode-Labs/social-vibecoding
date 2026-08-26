// Anonymous-shell screens (fold-auth-pages-into-SPA).
//
// Landing / login / register / waiting used to be standalone documents
// (landing.html, login.html, register.html, waiting.html). They are now
// in-SPA screens over the same document as the authed shell, which buys:
//   - kit push/pop transitions between them (PlatformUI.transition) —
//     no full page loads while navigating the anonymous side;
//   - a RELOAD-FREE login: on success we refetch /api/auth/me and call
//     App.enterAuthed(user) in place (see app.js staged boot), which also
//     runs the native login handoff (completeLogin → startNode) without
//     the old navigate-to-'/' round trip;
//   - one document for the service worker's offline fallback.
//
// Hash routes: #landing, #login, #signup (login screen with the
// email-code sub-view open — otp/verify is the account-creation path),
// #register[/<code>], #waiting, #waitlist (stage-1 survey). app.js's
// restoreFromHash owns the routing and calls AuthScreens.show(); this
// module owns the screens.
//
// The old documents remain as thin redirect stubs so bookmarks, old
// share links, and SW-cached copies keep working.
(function () {
  'use strict';

  const SCREEN_IDS = {
    landing: 'auth-landing-screen',
    login: 'auth-login-screen',
    signup: 'auth-login-screen', // sub-view of the login screen
    register: 'auth-register-screen',
    waiting: 'auth-waiting-screen',
    // Stage-1 waitlist survey, #waitlist — its own screen rather than a
    // block on the landing page (the four-question form flat on the
    // homepage buried the app directory under it).
    waitlist: 'auth-waitlist-screen',
    // Stage-2 waitlist survey ("Want in sooner?"), #more/<token> — the
    // token is the signup's capability from the join response / email.
    more: 'auth-more-screen',
    // Emailed password-reset magic link, #reset-password/<token> — a
    // sub-view of the login screen, like signup. The view itself is
    // mounted on demand rather than prerendered (frozen-markup contract;
    // see features/auth/login.tsx).
    'reset-password': 'auth-login-screen',
  };

  // Drives push (deeper) vs pop (back toward landing) transition types.
  // landing → waitlist → more is a real chain now, so `more` sits a level
  // below the stage-1 screen it is offered from.
  const DEPTH = {
    landing: 0, login: 1, signup: 1, register: 1, waiting: 1, waitlist: 1,
    more: 2, 'reset-password': 1,
  };

  const ROUTES = Object.keys(SCREEN_IDS);

  // Screen transitions come from the platform's native kit via the
  // PlatformUI seam; when the kit failed to load the mutation just runs
  // without animation.
  function fx(fn, type) {
    if (window.PlatformUI) window.PlatformUI.transition(fn, { type });
    else fn();
  }

  // Same seam, but forwarding the full zoom opts (el / fromEl / outEl /
  // fallback / after). Zoom callers split their mutation into fn (reveal
  // the incoming screen) + after (conceal the outgoing one), so the
  // no-kit path has to run BOTH halves.
  function zoomFx(fn, opts) {
    if (window.PlatformUI) window.PlatformUI.transition(fn, opts);
    else {
      fn();
      if (opts && typeof opts.after === 'function') opts.after();
    }
  }

  function byId(id) { return document.getElementById(id); }

  // The React seam (#1078). Screen roots convert one chunk at a time, and
  // once React owns one, a classList write from out here is reconciled
  // away on its next render — so hand the decision to App, which knows
  // which ids have crossed over. `App` is a script-global (not on
  // window), and this file loads before app.js, so the guard is a typeof
  // check and the fallback is the pre-seam behaviour.
  function setScreenVisible(id, visible) {
    if (typeof App !== 'undefined' && App._setScreenVisible) {
      App._setScreenVisible(id, visible);
      return;
    }
    const el = byId(id);
    if (el) el.classList.toggle('hidden', !visible);
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function hideError(el) { el.classList.add('hidden'); }

  // Every credential exchange on these screens is a server round trip, so
  // offline they can only fail. app.js's boot comment claimed for a long
  // time that "the login screen refuses submits while offline" — it did
  // not, and the user got a bare "Network error" that read like a wrong
  // password (#1021). Guard first, and say what's actually wrong.
  //
  // The check is Offline's probe result, not navigator.onLine: the flag
  // false-positives behind captive portals, which is exactly where a
  // submit would hang. When it says nothing is wrong we let the request
  // go — an unguarded real failure still falls back to its own catch.
  function blockedOffline(errorEl) {
    let offline = false;
    try { offline = !!(window.Offline && Offline.isOffline()); } catch (_) { offline = false; }
    if (!offline) return false;
    if (errorEl) {
      showError(errorEl, "You're offline. Signing in needs a connection.");
    }
    try { window.Offline.nudge(); } catch (_) { /* ignore */ }
    return true;
  }

  const AuthScreens = {
    _current: null,       // route name currently shown, or null
    // Deep-link fragment (e.g. '#app/<slug>/full' from a shared link) an
    // anonymous visitor arrived with; restored via history.replaceState
    // right before the authed boot so restoreFromHash lands on it.
    _pendingHash: '',
    _wired: {},           // per-screen one-shot wiring markers
    _waitingTimer: null,

    // ── Routing helpers (consumed by App.restoreFromHash) ────────────

    // First path segment → route name, or null when the hash isn't an
    // auth route.
    routeFromHash(hash) {
      const seg = String(hash || '').split('/')[0];
      return ROUTES.includes(seg) ? seg : null;
    },

    rememberDeepLink(fullHash) {
      if (!fullHash) return;
      if (AuthScreens.routeFromHash(fullHash.replace('#', ''))) return;
      AuthScreens._pendingHash = fullHash;
    },

    // Anonymous boot entry (App.enterAnonymous). Routing lives in
    // restoreFromHash — its anonymous branch calls back into show().
    enter() {
      // A pre-SPA link form: /?signup=1 (old landing CTA target). Honor
      // it once, then let the hash own everything.
      try {
        if (!location.hash &&
            new URLSearchParams(location.search).has('signup')) {
          history.replaceState(null, '', '/#signup');
        }
      } catch (_) {}
      if (window.App) App.restoreFromHash();
    },

    // Waiting-room entry (App.enterAuthed with hasPlatformAccess=false).
    showWaiting() {
      if (AuthScreens.routeFromHash(location.hash.replace('#', '')) !== 'waiting') {
        history.replaceState(null, '', '#waiting');
      }
      AuthScreens.show('waiting');
    },

    // ── Screen switching ─────────────────────────────────────────────

    show(route, seg) {
      const id = SCREEN_IDS[route];
      if (!id) return;
      AuthScreens._wireScreen(route);

      const prev = AuthScreens._current;
      const sameScreen = prev && SCREEN_IDS[prev] === id;

      // Per-route side effects run even when the screen element is
      // already up (e.g. login ↔ signup share one screen).
      if (route === 'landing') AuthScreens._landingOnShow();
      if (route === 'login') AuthScreens._loginOnShow(false);
      if (route === 'signup') AuthScreens._loginOnShow(true);
      if (route === 'reset-password') AuthScreens._resetOnShow(seg);
      if (route === 'register') AuthScreens._registerOnShow(seg);
      if (route === 'waiting') AuthScreens._waitingOnShow();
      if (route === 'waitlist') AuthScreens._waitlistOnShow();
      if (route === 'more') AuthScreens._moreOnShow(seg);
      if (prev === 'waiting' && route !== 'waiting') AuthScreens._stopWaitingPoll();
      // Leaving the landing screen with an app still open: stop the
      // iframe and put the directory back, un-animated.
      if (prev === 'landing' && route !== 'landing') AuthScreens._resetLandingViewer();

      if (sameScreen || prev === route) {
        AuthScreens._current = route;
        return;
      }

      const type = prev == null
        ? 'none'
        : (DEPTH[route] > DEPTH[prev] ? 'push'
          : DEPTH[route] < DEPTH[prev] ? 'pop' : 'none');

      fx(() => {
        for (const r of Object.keys(SCREEN_IDS)) {
          setScreenVisible(SCREEN_IDS[r], SCREEN_IDS[r] === id);
        }
      }, type);
      AuthScreens._current = route;
    },

    hideAll() {
      AuthScreens._stopWaitingPoll();
      AuthScreens._resetLandingViewer();
      for (const r of Object.keys(SCREEN_IDS)) setScreenVisible(SCREEN_IDS[r], false);
      AuthScreens._current = null;
    },

    _wireScreen(route) {
      const id = SCREEN_IDS[route];
      if (AuthScreens._wired[id]) return;
      AuthScreens._wired[id] = true;
      if (id === 'auth-landing-screen') AuthScreens._wireLanding();
      if (id === 'auth-login-screen') AuthScreens._wireLogin();
      if (id === 'auth-register-screen') AuthScreens._wireRegister();
      if (id === 'auth-waiting-screen') AuthScreens._wireWaiting();
      if (id === 'auth-waitlist-screen') AuthScreens._wireWaitlist();
      if (id === 'auth-more-screen') AuthScreens._wireMore();
    },

    // ── Reload-free login completion ─────────────────────────────────
    //
    // Called after ANY successful credential exchange (password form,
    // OTP set-password, wallet verify, activation-code register). The
    // session cookie is set; boot the authed shell in place.
    async finishLogin() {
      // The only login-return target accepted by the platform. Keeping
      // this exact and relative prevents open redirects. CLI authorize is
      // a separate document by design — real navigation stays.
      try {
        const params = new URLSearchParams(location.search);
        const values = params.getAll('return_to');
        if (values.length === 1 &&
            [...params.keys()].every((k) => k === 'return_to') &&
            values[0] === '/cli/authorize') {
          window.location.href = '/cli/authorize';
          return;
        }
      } catch (_) {}

      // Drop any offline session snapshot left by whoever used this
      // device last (#1021). enterAuthed writes a fresh one below; until
      // it does, a stale snapshot for a DIFFERENT account must not be
      // sitting there ready for the next offline boot to paint.
      try { window.App?.clearSessionSnapshot?.(); } catch (_) {}

      try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) throw new Error('me ' + res.status);
        const data = await res.json();
        const user = data && data.user;
        if (!user) throw new Error('no user');

        if (user.hasPlatformAccess === false) {
          // Gated account: the waiting room takes over (enterAuthed
          // routes there); keep the deep link pending for the release.
          fx(() => App.enterAuthed(user), 'push');
          return;
        }

        const target = AuthScreens._pendingHash || '';
        AuthScreens._pendingHash = '';
        history.replaceState(null, '', '/' + target);
        fx(() => {
          AuthScreens.hideAll();
          App.enterAuthed(user);
        }, 'pop');
      } catch (e) {
        // Cookie is set but the in-place boot failed (transient /me
        // hiccup) — a plain reload recovers via the normal boot path.
        console.warn('[auth-screens] in-place boot failed, reloading:', e);
        window.location.href = '/' + (AuthScreens._pendingHash || '');
      }
    },

    // ── Landing ──────────────────────────────────────────────────────
    //
    // #1080 chunk C: the landing screen is a React component now
    // (frontend/src/features/auth/landing.tsx). It patches the entry points
    // below onto this object at hydration — before DOMContentLoaded, i.e.
    // before show() can call any of them — so the router above needs no
    // knowledge of which half is live. The no-ops are what the prerender
    // pass and a kit-less boot see.
    _wireLanding() {},
    _landingOnShow() {},
    _renderLandingHeader() {},
    _resetLandingViewer() {},
    _openLandingApp() {},
    _closeLandingApp() {},
    _loadLandingApps() {},
    _landingTileFor() { return null; },
    _swapViewerFrame() { return null; },


    // ── Waitlist survey (two-stage, ported from topochain) ───────────
    //
    // #1080 chunk C: both stages are React now — stage 1 is
    // frontend/src/features/auth/waitlist.tsx and stage 2 ("Want in sooner?",
    // #more/<token>) is frontend/src/features/auth/more.tsx. They share the
    // memoised GET /api/public/waitlist/options fetch and the chip / select
    // helpers, which moved with them into
    // frontend/src/features/auth/waitlist-shared.tsx.
    _wireWaitlist() {},
    _waitlistOnShow() {},
    _wireMore() {},
    _moreOnShow() {},

    // ── Login (+ signup / OTP + recovery + wallet fast path) ─────────
    //
    // #1080 chunk C: the login screen is a React component now
    // (frontend/src/features/auth/login.tsx), and it owns all four views on
    // that screen element — the password form, the #signup email-code
    // sub-view, the forgot-password recovery sub-view and the
    // #reset-password/<token> redeem view — plus the wallet fast path and
    // the two runtime-built blocks _ensureResetUi used to inject. It patches
    // the entry points below onto this object at hydration, before
    // DOMContentLoaded and therefore before show() can call any of them.
    _wireLogin() {},
    _loginOnShow() {},
    _showLoginBaseView() {},
    _showOtpView() {},
    _resetOnShow() {},
    _walletDetect() {},

    // ── Register (activation-code flow) ──────────────────────────────
    //
    // #1080 chunk C: React (frontend/src/features/auth/register.tsx). It
    // patches the entry points below at hydration, before DOMContentLoaded.
    _wireRegister() {},
    _registerOnShow() {},

    // ── Waiting room (platform-access gate) ──────────────────────────
    //
    // #1080 chunk C: React (frontend/src/features/auth/waiting.tsx). The
    // release poll is the screen's, but its lifecycle is the router's —
    // show() stops it when navigating away from `waiting` and hideAll()
    // stops it on the way into the authed shell — so _startWaitingPoll and
    // _stopWaitingPoll stay part of the patched surface.
    _wireWaiting() {},
    _waitingOnShow() {},
    _startWaitingPoll() {},
    _stopWaitingPoll() {},
  };

  // Corner back links on the login/register screens → landing.
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-auth-back]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        location.hash = '#landing';
      });
    });
  });

  // Coming back online used to be handled here: a `usernode:offline-change`
  // listener cleared the stale "you're offline" message from every
  // credential screen's error slot, since the CSS re-enables the controls
  // and nothing else would say the message no longer applied. Every one of
  // those slots — login, otp, wallet, register — now belongs to a React
  // screen that owns its own listener (#1080 chunk C), so there is nothing
  // left out here to clear.

  window.AuthScreens = AuthScreens;
})();
