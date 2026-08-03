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
  };

  // Drives push (deeper) vs pop (back toward landing) transition types.
  // landing → waitlist → more is a real chain now, so `more` sits a level
  // below the stage-1 screen it is offered from.
  const DEPTH = {
    landing: 0, login: 1, signup: 1, register: 1, waiting: 1, waitlist: 1,
    more: 2,
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

  function showError(el, msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function hideError(el) { el.classList.add('hidden'); }

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
          const el = byId(SCREEN_IDS[r]);
          if (el) el.classList.toggle('hidden', SCREEN_IDS[r] !== id);
        }
      }, type);
      AuthScreens._current = route;
    },

    hideAll() {
      AuthScreens._stopWaitingPoll();
      AuthScreens._resetLandingViewer();
      for (const r of Object.keys(SCREEN_IDS)) {
        const el = byId(SCREEN_IDS[r]);
        if (el) el.classList.add('hidden');
      }
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

    _landingAppsLoaded: false,

    // Slug/name of the app currently open in the in-page viewer, or null.
    // The slug resolves the tile the zoom-out shrinks back into; the name
    // is what the persistent header shows while the app is up.
    _openAppSlug: null,
    _openAppName: null,

    // Assigned real implementations by _wireLanding (they close over the
    // viewer elements). No-ops until then, so header CTAs wired on other
    // screens can call them unconditionally.
    _openLandingApp() {},
    _closeLandingApp() {},

    // Instant, un-animated teardown of the in-page viewer. Used on the
    // paths that LEAVE the landing screen (Sign in, hash routing, the
    // authed boot): animating a zoom-out into a tile on a screen that's
    // being replaced in the same frame just fights the screen transition,
    // and the live iframe must stop either way — #app-viewer sits inside
    // the z-40 landing overlay now, so a later screen doesn't cover it.
    _resetLandingViewer() {
      const viewer = byId('app-viewer');
      if (!viewer || viewer.classList.contains('hidden')) return;
      AuthScreens._openAppSlug = null;
      AuthScreens._openAppName = null;
      viewer.classList.add('hidden');
      const frame = byId('app-viewer-frame');
      if (frame) frame.src = 'about:blank';
      const scroller = byId('auth-landing-scroll');
      if (scroller) scroller.classList.remove('hidden');
      AuthScreens._renderLandingHeader();
    },

    _landingOnShow() {
      AuthScreens._renderLandingHeader();
      if (!AuthScreens._landingAppsLoaded) {
        AuthScreens._landingAppsLoaded = true;
        AuthScreens._loadLandingApps();
      }
      // Warm the survey options (memoised) while the visitor is reading the
      // pitch, so the #waitlist chips and country list are already filled
      // by the time they tap through.
      AuthScreens._waitlistOptions();
    },

    // Single writer for the persistent landing header + the CTA block's
    // link-vs-queued line. Three states:
    //   anonymous, directory  → no back button, platform title, both CTAs
    //   anonymous, app open   → back button, app name, both CTAs (a
    //                           visitor can sign up without backing out)
    //   waiting-room session  → "Your queue status" instead of the CTAs,
    //                           and the CTA block says they're on the list
    _renderLandingHeader() {
      const hasSession = !!(window.App && App.user);
      const ctas = byId('landing-header-ctas');
      const back = byId('landing-back-to-waiting');
      if (ctas) ctas.classList.toggle('hidden', hasSession);
      if (back) back.classList.toggle('hidden', !hasSession);

      // The CTA block is a pitch + one link into #waitlist now; a queued
      // visitor gets the "already on the list" line in its place.
      const link = byId('landing-waitlist-link');
      const queued = byId('landing-cta-queued');
      if (link) link.classList.toggle('hidden', hasSession);
      if (queued) queued.classList.toggle('hidden', !hasSession);

      const open = !!AuthScreens._openAppSlug;
      const backBtn = byId('landing-back-btn');
      if (backBtn) backBtn.classList.toggle('hidden', !open);
      const title = byId('landing-header-title');
      if (title) {
        const text = open
          ? (AuthScreens._openAppName || AuthScreens._openAppSlug)
          : 'Usernode Social Vibecoding';
        title.textContent = text;
        // Mirror into the tab title so the Flutter WebView's AppBar
        // follows the screen, same as App.setHeaderTitle does authed.
        try { document.title = text; } catch (_) {}
      }
    },

    // The landing tile for `slug`, or null. Scoped to #landing-apps: the
    // authed home grid renders `.app-card[data-slug]` too, and both live
    // in this one document after a reload-free login.
    _landingTileFor(slug) {
      try {
        return document.querySelector(
          `#landing-apps .app-card[data-slug="${CSS.escape(String(slug || ''))}"]`);
      } catch (_) { return null; }
    },

    _wireLanding() {
      // Kit pull-to-refresh on the landing scroller, same element-mode
      // wiring as the authed screens (app.js _wirePullToRefresh). The
      // kit no-ops this on desktop; the refresh re-pulls the app
      // directory (probe results, active-user counts, new deploys) —
      // and, via App._refreshOrReload, hard-reloads when the platform
      // itself redeployed since this document loaded (the anonymous
      // shell has no WS platform-updating banner, so this pull is its
      // only recovery path to new client code).
      // Attached to the INNER scroller, never the fixed overlay: the
      // rubber-band translate on the overlay itself would expose the
      // authed shell's header behind it during the pull.
      if (window.PlatformUI) {
        PlatformUI.pullToRefresh(byId('auth-landing-scroll'),
          () => App._refreshOrReload(() => AuthScreens._loadLandingApps()));
      }

      // "Join waitlist" and "Sign in" are both plain anchors to another
      // route, so they leave the landing screen entirely; close the viewer
      // first so the next screen never paints over a still-running iframe
      // (the viewer lives INSIDE this z-40 overlay now, not above it).
      // show() also resets it on the route change — this keeps the teardown
      // ahead of the transition, same as it has always been for Sign in.
      for (const id of ['landing-waitlist-cta', 'landing-signin-cta']) {
        const cta = byId(id);
        if (cta) cta.addEventListener('click', () => {
          AuthScreens._resetLandingViewer();
        });
      }

      // In-page app viewer: public apps open in an iframe here instead of
      // target=_blank (which strands mobile webview users on the app
      // subdomain with no way back). Uses a history state marker (not a
      // hash) so the browser/OS back gesture closes the viewer without
      // disturbing the hash router.
      //
      // Open/close mirror App.navigateToApp / App.navigateHome exactly:
      // the app expands out of the tapped tile (kit 'zoom-in') and shrinks
      // back into it on Back ('zoom-out'), with the persistent header
      // above it throughout.
      //
      // The flex-sibling pitfall applies here too (#764): #app-viewer and
      // #auth-landing-scroll are flex:1 siblings, so while BOTH are
      // visible (fn reveals the viewer, the scroller stays beneath the
      // zoom) they split the height 50/50 and the kit would measure the
      // viewer's destination as the bottom half — the zoom would land
      // there and snap to full size when `after` hides the scroller.
      // `outEl` lets the kit hide the scroller for its synchronous
      // pre-paint measurement, so the zoom targets the true settled rect.
      const viewer = byId('app-viewer');
      const viewerFrame = byId('app-viewer-frame');
      const scroller = byId('auth-landing-scroll');

      AuthScreens._openLandingApp = (app) => {
        const slug = app.slug || '';
        AuthScreens._openAppSlug = slug;
        AuthScreens._openAppName = app.name || slug;
        viewerFrame.src = app.url;
        history.pushState({ svAnonAppViewer: true }, '', location.href);
        zoomFx(() => {
          viewer.classList.remove('hidden');
        }, {
          type: 'zoom-in',
          el: viewer,
          fromEl: () => AuthScreens._landingTileFor(slug),
          outEl: scroller,
          fallback: 'push',
          after: () => scroller.classList.add('hidden'),
        });
        AuthScreens._renderLandingHeader();
      };

      const closeViewer = () => {
        if (viewer.classList.contains('hidden')) return;
        const slug = AuthScreens._openAppSlug;
        AuthScreens._openAppSlug = null;
        AuthScreens._openAppName = null;
        // fallback 'none': a View Transition snapshot of a LIVE app
        // iframe can flash on iOS Safari, so the non-kit path cuts
        // instantly — same choice App.navigateHome makes leaving the App
        // tab. `after` runs exactly once on every path, so the shrinking
        // overlay keeps showing the app's content until it lands.
        zoomFx(() => {
          scroller.classList.remove('hidden');
        }, {
          type: 'zoom-out',
          el: viewer,
          fromEl: () => (slug ? AuthScreens._landingTileFor(slug) : null),
          fallback: 'none',
          after: () => {
            viewer.classList.add('hidden');
            viewerFrame.src = 'about:blank';
          },
        });
        AuthScreens._renderLandingHeader();
      };
      AuthScreens._closeLandingApp = closeViewer;

      byId('landing-back-btn').addEventListener('click', () => {
        if (history.state && history.state.svAnonAppViewer) history.back();
        else closeViewer();
      });
      window.addEventListener('popstate', closeViewer);
    },

    // ── Waitlist survey (two-stage, ported from topochain) ───────────

    // Stage 1 lives on its own screen (#waitlist). The landing page only
    // links here — see the CTA block in index.html.
    _wireWaitlist() {
      AuthScreens._wireStage1Form();
    },

    // Form vs "you're already on the list", plus the screen title. A
    // waiting-room session already HAS an account in the queue, so the join
    // form is wrong for them — same predicate _renderLandingHeader uses.
    _waitlistOnShow() {
      // `?shot=waitlist-joined` paints the success state instead of the
      // form (screenshot-state deep link — see App.init / _anonShot).
      let shot = null;
      try { shot = new URLSearchParams(location.search).get('shot'); } catch (_) {}
      if (shot === 'waitlist-joined') AuthScreens._showWaitlistJoinedShot();

      const hasSession = !!(window.App && App.user);
      const form = byId('waitlist-form');
      const queued = byId('waitlist-queued');
      // Never resurrect the form over the success state (a re-show after a
      // join, e.g. back-then-forward).
      const joined = byId('waitlist-joined');
      const isJoined = !!(joined && !joined.classList.contains('hidden'));
      if (form) form.classList.toggle('hidden', hasSession || isJoined);
      if (queued) queued.classList.toggle('hidden', !hasSession);

      if (!hasSession && !isJoined) {
        const email = byId('waitlist-email');
        if (email) email.focus({ preventScroll: true });
      }
      // Mirror into the tab title so the Flutter WebView's AppBar follows
      // the screen, same as _renderLandingHeader does for the landing page.
      try { document.title = 'Join the waitlist'; } catch (_) {}
    },

    // Screenshot-state deep link (`?shot=waitlist-joined`): paints the
    // post-submit success state with the stage-2 offer so the captures and
    // the dapp.json check have a URL for it. Pure UI state — it never POSTs,
    // never writes, and the stage-2 link keeps its inert default href.
    _showWaitlistJoinedShot() {
      const form = byId('waitlist-form');
      const msg = byId('waitlist-msg');
      const joined = byId('waitlist-joined');
      const offer = byId('waitlist-more-offer');
      if (form) form.classList.add('hidden');
      if (msg) msg.classList.add('hidden');
      if (joined) joined.classList.remove('hidden');
      if (offer) offer.classList.remove('hidden');
    },

    // The survey option definitions (chips, selects, countries) come
    // from the server so the form and its validation share one source.
    _optionsPromise: null,
    _waitlistOptions() {
      if (!AuthScreens._optionsPromise) {
        AuthScreens._optionsPromise = fetch('/api/public/waitlist/options')
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
      }
      return AuthScreens._optionsPromise;
    },

    // Renders a row of selectable chips into `host`. Returns { get, set }
    // for the current selection (a string for single-select, an array
    // for multi). Chip markup is built with createElement — labels come
    // from our own options endpoint but stay out of innerHTML anyway.
    _chipRow(host, options, { multi = false, onChange = null } = {}) {
      const ON = 'border-violet-500 bg-violet-50 dark:bg-violet-500/10 text-zinc-900 dark:text-white';
      const OFF = 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-zinc-400 dark:hover:border-zinc-500';
      const BASE = 'rounded-full border px-3 py-1.5 text-xs cursor-pointer transition-colors ';
      let selected = multi ? [] : null;
      const buttons = new Map();
      const paint = () => {
        for (const [key, btn] of buttons) {
          const on = multi ? selected.includes(key) : selected === key;
          btn.className = BASE + (on ? ON : OFF);
        }
      };
      host.textContent = '';
      for (const [key, label] of Object.entries(options)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.addEventListener('click', () => {
          if (multi) {
            selected = selected.includes(key)
              ? selected.filter((k) => k !== key)
              : [...selected, key];
          } else {
            selected = key;
          }
          paint();
          if (onChange) onChange(selected);
        });
        buttons.set(key, btn);
        host.appendChild(btn);
      }
      paint();
      return {
        get: () => selected,
        set: (value) => {
          selected = multi ? (Array.isArray(value) ? value : []) : (value || null);
          paint();
          if (onChange) onChange(selected);
        },
      };
    },

    _fillSelect(select, options) {
      for (const [key, label] of Object.entries(options)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = label;
        select.appendChild(opt);
      }
    },

    // Stage 1: the #waitlist screen's four questions. Submits to the join
    // endpoint; on a first join the response carries the stage-2
    // capability token, which turns into the "Want in sooner?" offer.
    _stage1Discovery: null,
    async _wireStage1Form() {
      const form = byId('waitlist-form');
      if (!form) return;
      const btn = byId('waitlist-submit');
      const msg = byId('waitlist-msg');

      const showMsg = (text, isError) => {
        msg.textContent = text;
        msg.className = 'text-sm mt-3 ' + (isError
          ? 'text-red-500 dark:text-red-400'
          : 'text-emerald-600 dark:text-emerald-400');
      };

      // Registered BEFORE the options await: the visitor lands on this
      // screen with the email field already focused, so a fast submit
      // inside the fetch window would otherwise fall through to a native
      // GET navigation off the SPA.
      AuthScreens._wireStage1Submit(form, btn, showMsg);

      const opts = await AuthScreens._waitlistOptions();
      if (opts) {
        // Country select, grouped by region.
        const country = byId('waitlist-country');
        for (const [region, codes] of Object.entries(opts.countries || {})) {
          const group = document.createElement('optgroup');
          group.label = region;
          for (const [code, name] of Object.entries(codes)) {
            const opt = document.createElement('option');
            opt.value = code;
            opt.textContent = name;
            group.appendChild(opt);
          }
          country.appendChild(group);
        }
        // Discovery chips + the source-specific detail placeholder.
        const detail = byId('waitlist-discovery-detail');
        AuthScreens._stage1Discovery = AuthScreens._chipRow(
          byId('waitlist-discovery-chips'), opts.discovery_sources || {}, {
            onChange: (source) => {
              const labels = opts.discovery_detail_labels || {};
              detail.placeholder =
                (labels[source] || 'Which one?') + ' — optional';
            },
          });
      }
    },

    _wireStage1Submit(form, btn, showMsg) {
      const msg = byId('waitlist-msg');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const emailVal = byId('waitlist-email').value.trim();
        const madeUrl = byId('waitlist-made-url').value.trim();
        const source = AuthScreens._stage1Discovery
          ? AuthScreens._stage1Discovery.get() : null;
        // Client preflight mirroring the server's stage-1 rules, so the
        // common misses get a message without a round trip.
        if (!emailVal) return showMsg('Please enter your email.', true);
        if (!madeUrl) return showMsg('Please link something you have made.', true);
        if (!source) return showMsg('Please tell us how you found us.', true);

        btn.disabled = true;
        try {
          const res = await fetch('/api/public/waitlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: emailVal,
              made_url: madeUrl,
              made_note: byId('waitlist-made-note').value.trim() || undefined,
              country: byId('waitlist-country').value || undefined,
              city: byId('waitlist-city').value.trim() || undefined,
              discovery_source: source,
              discovery_detail: byId('waitlist-discovery-detail').value.trim() || undefined,
              referrer_handle: byId('waitlist-referrer').value.trim() || undefined,
            }),
          });
          const data = await res.json().catch(() => null);
          if (res.ok) {
            // Joined: swap the form for the success state, and offer
            // stage 2 right away when this was a first join (the email
            // carries the same link for anyone who stops here).
            msg.classList.add('hidden');
            form.classList.add('hidden');
            const joined = byId('waitlist-joined');
            if (joined) joined.classList.remove('hidden');
            const token = data && data.more_token;
            if (token) {
              const link = byId('waitlist-more-link');
              if (link) link.href = '#more/' + token;
              const offer = byId('waitlist-more-offer');
              if (offer) offer.classList.remove('hidden');
            }
          } else {
            showMsg((data && data.error) || 'Something went wrong — try again.', true);
          }
        } catch (_) {
          showMsg('Connection issue — try again.', true);
        }
        btn.disabled = false;
      });
    },

    // ── Stage 2: "Want in sooner?" (#more/<token>) ────────────────────

    _moreToken: null,
    _moreChips: null,   // { tools, lossHad, lossKinds } chip controllers
    _moreWiredForm: false,

    _wireMore() { /* one-shot marker only; real wiring is per-show */ },

    _moreOnShow(token) {
      AuthScreens._moreToken = token || null;
      AuthScreens._loadMore();
    },

    async _loadMore() {
      const token = AuthScreens._moreToken;
      const form = byId('more-form');
      const invalid = byId('more-invalid');
      if (!form || !invalid) return;

      const fail = () => {
        form.classList.add('hidden');
        invalid.classList.remove('hidden');
      };
      if (!token) return fail();

      const [opts, res] = await Promise.all([
        AuthScreens._waitlistOptions(),
        fetch('/api/public/waitlist/more/' + encodeURIComponent(token))
          .catch(() => null),
      ]);
      if (!opts || !res || !res.ok) return fail();
      const data = await res.json().catch(() => null);
      if (!data || !data.ok) return fail();

      invalid.classList.add('hidden');
      form.classList.remove('hidden');
      AuthScreens._renderMore(opts, data);
    },

    _renderMore(opts, data) {
      const a = data.answers || {};
      const group = a.group || {};
      const loss = a.loss || {};
      const handles = a.handles || {};
      const verified = a.verified || {};

      // One-shot structural wiring (selects, chip rows, invites list,
      // submit). Values are (re)applied on every show below it.
      if (!AuthScreens._moreWiredForm) {
        AuthScreens._moreWiredForm = true;
        AuthScreens._fillSelect(byId('more-group-size'), opts.group_sizes || {});
        AuthScreens._fillSelect(byId('more-group-role'), opts.group_roles || {});
        AuthScreens._moreChips = {
          tools: AuthScreens._chipRow(byId('more-group-tools'),
            opts.group_tools || {}, { multi: true }),
          lossHad: AuthScreens._chipRow(byId('more-loss-had'),
            opts.loss_answers || {}, {
              onChange: (had) => {
                byId('more-loss-detail').classList
                  .toggle('hidden', !had || had === 'no');
              },
            }),
          lossKinds: AuthScreens._chipRow(byId('more-loss-kinds'),
            opts.loss_kinds || {}, { multi: true }),
        };
        byId('more-invite-add').addEventListener('click', () =>
          AuthScreens._addInviteRow(''));
        byId('more-form').addEventListener('submit', (e) => {
          e.preventDefault();
          AuthScreens._saveMore();
        });
      }

      byId('more-group-name').value = group.name || '';
      byId('more-group-size').value = group.size || '';
      byId('more-group-role').value = group.role || '';
      AuthScreens._moreChips.tools.set(group.tools || []);
      byId('more-group-need').value = group.need || '';

      AuthScreens._moreChips.lossHad.set(loss.had || null);
      byId('more-loss-product').value = loss.product || '';
      AuthScreens._moreChips.lossKinds.set(loss.kind || []);
      byId('more-loss-story').value = loss.story || '';

      byId('more-handle-farcaster').value = handles.farcaster || '';
      byId('more-handle-discord').value = handles.discord || '';
      byId('more-handle-telegram').value = handles.telegram || '';
      byId('more-handle-other').value = handles.other || '';

      // GitHub / X: a verified pill when connected, a connect link when
      // the platform has OAuth creds for the provider, nothing otherwise
      // (the text handles above still work).
      const row = byId('more-connect-row');
      row.textContent = '';
      for (const [provider, label] of [['github', 'GitHub'], ['x', 'X']]) {
        if (verified[provider]) {
          const pill = document.createElement('span');
          pill.className = 'inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300';
          pill.textContent = '✓ ' + label + ' · ' + verified[provider];
          row.appendChild(pill);
        } else if (data.oauth && data.oauth[provider]) {
          const link = document.createElement('a');
          link.className = 'inline-flex items-center rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:border-zinc-400 dark:hover:border-zinc-500';
          link.href = '/waitlist/connect/' + provider + '?token=' +
            encodeURIComponent(AuthScreens._moreToken);
          link.textContent = 'Connect ' + label;
          row.appendChild(link);
        }
      }

      // Invites: at least two empty rows, capped at max_invites.
      const invites = Array.isArray(a.invites) ? a.invites.slice() : [];
      while (invites.length < 2) invites.push('');
      const host = byId('more-invites');
      host.textContent = '';
      for (const value of invites.slice(0, opts.max_invites || 5)) {
        AuthScreens._addInviteRow(value);
      }
      byId('more-admit-together').checked = !!a.admit_together;
      byId('more-referrer').value = a.referrer_handle || '';

      // Surface the OAuth round-trip's outcome (?connect=… inside the
      // hash, so it never reaches a server log).
      const msg = byId('more-msg');
      msg.classList.add('hidden');
      const q = (location.hash.split('?')[1] || '');
      const connect = new URLSearchParams(q).get('connect');
      if (connect === 'ok') {
        msg.textContent = 'Account verified — thanks.';
        msg.className = 'text-sm mt-3 text-emerald-600 dark:text-emerald-400';
      } else if (connect === 'failed' || connect === 'denied' || connect === 'unavailable') {
        msg.textContent = connect === 'unavailable'
          ? 'That sign-in is not available yet.'
          : 'Could not verify that account. Please try again.';
        msg.className = 'text-sm mt-3 text-amber-600 dark:text-amber-400';
      }
    },

    _addInviteRow(value) {
      const host = byId('more-invites');
      const maxRows = 5;
      if (host.children.length >= maxRows) return;
      const wrap = document.createElement('div');
      wrap.className = 'flex items-center gap-2';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 255;
      input.placeholder = '@handle or email';
      input.value = value || '';
      input.className = 'flex-1 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent';
      input.dataset.invite = '1';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Remove');
      remove.className = 'shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-white';
      remove.addEventListener('click', () => {
        if (host.children.length > 1) wrap.remove();
        else input.value = '';
      });
      wrap.appendChild(input);
      wrap.appendChild(remove);
      host.appendChild(wrap);
    },

    async _saveMore() {
      const btn = byId('more-save');
      const msg = byId('more-msg');
      const showMsg = (text, isError) => {
        msg.textContent = text;
        msg.className = 'text-sm mt-3 ' + (isError
          ? 'text-red-500 dark:text-red-400'
          : 'text-emerald-600 dark:text-emerald-400');
      };
      const chips = AuthScreens._moreChips || {};
      const invites = [...document.querySelectorAll('#more-invites [data-invite]')]
        .map((el) => el.value.trim()).filter(Boolean);
      btn.disabled = true;
      try {
        const res = await fetch(
          '/api/public/waitlist/more/' + encodeURIComponent(AuthScreens._moreToken), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              group_name: byId('more-group-name').value.trim() || undefined,
              group_size: byId('more-group-size').value || undefined,
              group_role: byId('more-group-role').value || undefined,
              group_tools: chips.tools ? chips.tools.get() : [],
              group_need: byId('more-group-need').value.trim() || undefined,
              had_loss: chips.lossHad ? chips.lossHad.get() || undefined : undefined,
              loss_product: byId('more-loss-product').value.trim() || undefined,
              loss_kind: chips.lossKinds ? chips.lossKinds.get() : [],
              loss_story: byId('more-loss-story').value.trim() || undefined,
              farcaster: byId('more-handle-farcaster').value.trim() || undefined,
              discord: byId('more-handle-discord').value.trim() || undefined,
              telegram: byId('more-handle-telegram').value.trim() || undefined,
              other_handle: byId('more-handle-other').value.trim() || undefined,
              invites,
              admit_together: byId('more-admit-together').checked,
              referrer_handle: byId('more-referrer').value.trim() || undefined,
            }),
          });
        const data = await res.json().catch(() => null);
        if (res.ok) {
          showMsg((data && data.message) || 'Saved — thanks.', false);
        } else {
          showMsg((data && data.error) || 'Something went wrong — try again.', true);
        }
      } catch (_) {
        showMsg('Connection issue — try again.', true);
      }
      btn.disabled = false;
    },

    async _loadLandingApps() {
      const appsEl = byId('landing-apps');
      const el = (tag, cls, text) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
      };
      try {
        const res = await fetch('/api/public/apps?include_wallets=0');
        if (!res.ok) throw new Error('http ' + res.status);
        const data = await res.json();
        const apps = (data && data.apps) || [];
        appsEl.textContent = '';
        if (!apps.length) {
          appsEl.appendChild(el('p', 'text-sm text-zinc-500 col-span-full', 'No public apps yet.'));
          return;
        }
        for (const app of apps) {
          appsEl.appendChild(AuthScreens._buildLandingAppTile(app, el));
        }
      } catch (_) {
        appsEl.textContent = '';
        appsEl.appendChild(el('p', 'text-sm text-zinc-500 col-span-full', 'Could not load apps right now.'));
      }
    },

    // One launcher tile, mirroring the authed homescreen's renderAppCard
    // shape (home.js): centered 14x14 icon tile (image > emoji > first
    // letter), then the name row with the active-users badge. Built with
    // DOM APIs (not innerHTML) because name/emoji are user-authored.
    //
    // Gated apps (requires_login — anything the shell probe didn't
    // positively classify as public) render dimmed with a lock badge and
    // an "Account required" caption; tapping one remembers the app deep
    // link and routes to #signup, so the account flow lands the user in
    // the app they wanted.
    _buildLandingAppTile(app, el) {
      const gated = !!app.requires_login;
      const tile = el('div',
        'app-card relative rounded-xl transition-colors p-3 flex flex-col items-center text-center gap-2 cursor-pointer'
        + (gated ? ' opacity-50 grayscale' : ''));
      tile.setAttribute('data-slug', app.slug || '');
      tile.setAttribute('data-gated', gated ? 'true' : 'false');

      // Icon tile: same priority order as home.js iconTileFor.
      const iconWrap = el('div', 'relative w-14 h-14 shrink-0');
      const iconBox = el('div',
        'app-icon-tile w-14 h-14 rounded-xl overflow-hidden flex items-center justify-center font-bold text-xl');
      if (app.icon_url) {
        const img = document.createElement('img');
        img.src = app.icon_url;
        img.alt = '';
        img.loading = 'lazy';
        img.draggable = false;
        img.className = 'w-full h-full rounded-xl object-cover';
        iconBox.setAttribute('data-icon', 'image');
        iconBox.appendChild(img);
      } else if (app.icon_emoji) {
        const span = el('span', 'text-3xl leading-none', app.icon_emoji);
        span.setAttribute('aria-hidden', 'true');
        iconBox.setAttribute('data-icon', 'emoji');
        iconBox.appendChild(span);
      } else {
        iconBox.setAttribute('data-icon', 'letter');
        iconBox.textContent = (app.name || '?').charAt(0).toUpperCase();
      }
      iconWrap.appendChild(iconBox);
      if (gated) {
        const lock = el('span',
          'absolute -top-1.5 -right-1.5 w-6 h-6 flex items-center justify-center rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 shadow-sm text-zinc-500 dark:text-zinc-300');
        lock.title = 'Account required';
        lock.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>';
        iconWrap.appendChild(lock);
      }
      tile.appendChild(iconWrap);

      // Name row + active-users badge (same sticky-10-day count as the
      // authed home cards; always rendered, 0 included).
      const body = el('div', 'w-full min-w-0');
      const nameRow = el('div', 'flex items-center justify-center gap-1.5 min-w-0 max-w-full');
      nameRow.appendChild(el('span', 'font-medium text-sm truncate min-w-0', app.name || app.slug));
      const activeUsers = parseInt(app.active_users, 10) || 0;
      const usersBadge = el('span',
        'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[0.65rem] font-medium bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 shrink-0');
      usersBadge.title = `${activeUsers} active user${activeUsers === 1 ? '' : 's'}`;
      usersBadge.innerHTML = '<svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>';
      usersBadge.appendChild(document.createTextNode(String(activeUsers)));
      nameRow.appendChild(usersBadge);
      body.appendChild(nameRow);
      if (gated) {
        body.appendChild(el('p', 'text-xs mt-0.5 text-zinc-400 dark:text-zinc-500', 'Account required'));
      }
      tile.appendChild(body);

      tile.addEventListener('click', () => {
        if (gated) {
          AuthScreens.rememberDeepLink('#app/' + (app.slug || ''));
          location.hash = '#signup';
          return;
        }
        if (app.url) AuthScreens._openLandingApp(app);
      });
      return tile;
    },

    // ── Login (+ signup / OTP + recovery + wallet fast path) ─────────

    // Wallet state, mirrored from the old login.html inline script.
    _walletPubkey: null,
    _cachedChallenge: null,
    _walletLinked: false,
    _walletUiActive: false,
    _walletDetectRan: false,

    _loginOnShow(openSignup) {
      // Reset to the requested base view every time the route changes —
      // login ↔ signup share the screen element.
      if (openSignup) AuthScreens._showOtpView();
      else AuthScreens._showLoginBaseView();
      // Wallet detection runs once, the first time the screen appears
      // (needs the native bridge; quietly does nothing on desktop web).
      if (!AuthScreens._walletDetectRan) {
        AuthScreens._walletDetectRan = true;
        AuthScreens._walletDetect();
      }
    },

    _showLoginBaseView() {
      byId('otp-view').classList.add('hidden');
      byId('recovery-view').classList.add('hidden');
      byId('login-form').classList.remove('hidden');
      byId('register-link').classList.remove('hidden');
      byId('forgot-link-wrap').classList.remove('hidden');
      byId('otp-link-wrap').classList.remove('hidden');
      if (AuthScreens._walletUiActive) {
        byId('wallet-auth').classList.remove('hidden');
      }
    },

    _showOtpView() {
      byId('login-form').classList.add('hidden');
      byId('register-link').classList.add('hidden');
      byId('forgot-link-wrap').classList.add('hidden');
      byId('otp-link-wrap').classList.add('hidden');
      byId('wallet-auth').classList.add('hidden');
      byId('recovery-view').classList.add('hidden');
      AuthScreens._otpSetStatus(null);
      AuthScreens._otpShowStep(byId('otp-step-email'));
      byId('otp-view').classList.remove('hidden');
    },

    _otpShowStep(step) {
      byId('otp-step-email').classList.add('hidden');
      byId('otp-step-code').classList.add('hidden');
      byId('otp-step-password').classList.add('hidden');
      hideError(byId('otp-error'));
      step.classList.remove('hidden');
    },

    _otpSetStatus(msg) {
      const otpStatus = byId('otp-status');
      if (msg) {
        otpStatus.textContent = msg;
        otpStatus.classList.remove('hidden');
      } else {
        otpStatus.classList.add('hidden');
      }
    },

    _wireLogin() {
      const loginForm = byId('login-form');
      const errorEl = byId('login-error');
      const otpError = byId('otp-error');
      const recoveryError = byId('recovery-error');
      const recoveryStatus = byId('recovery-status');
      const walletError = byId('wallet-error');
      const walletStatus = byId('wallet-status');
      const walletSignIn = byId('wallet-sign-in');

      const showOnly = (section) => {
        walletSignIn.classList.add('hidden');
        hideError(walletError);
        if (section) section.classList.remove('hidden');
      };

      // Normal login form handler
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideError(errorEl);
        const username = byId('login-username').value.trim();
        const password = byId('login-password').value;
        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
          });
          const data = await res.json();
          if (!res.ok) { showError(errorEl, data.error || 'Login failed'); return; }
          AuthScreens.finishLogin();
        } catch { showError(errorEl, 'Network error'); }
      });

      // ── Password recovery ("Forgot password?") ───────────────────
      const isNative = () => !!(window.usernode && window.usernode.isNative);

      const showRecovery = () => {
        hideError(recoveryError);
        recoveryStatus.classList.add('hidden');
        loginForm.classList.add('hidden');
        byId('register-link').classList.add('hidden');
        byId('forgot-link-wrap').classList.add('hidden');
        byId('otp-link-wrap').classList.add('hidden');
        byId('otp-view').classList.add('hidden');
        byId('wallet-auth').classList.add('hidden');
        byId('recovery-view').classList.remove('hidden');

        // Wallet self-reset only when in the native app with a linked
        // wallet; everyone else gets the admin-temporary-password
        // instructions.
        if (isNative() && AuthScreens._walletPubkey && AuthScreens._walletLinked) {
          byId('recovery-wallet').classList.remove('hidden');
          byId('recovery-admin').classList.add('hidden');
        } else {
          byId('recovery-wallet').classList.add('hidden');
          byId('recovery-admin').classList.remove('hidden');
        }
      };

      byId('forgot-password-link').addEventListener('click', (e) => {
        e.preventDefault();
        showRecovery();
      });
      byId('btn-recovery-back').addEventListener('click', () => {
        byId('recovery-wallet').classList.add('hidden');
        byId('recovery-admin').classList.add('hidden');
        AuthScreens._showLoginBaseView();
      });

      byId('btn-wallet-reset').addEventListener('click', async () => {
        hideError(recoveryError);
        const newPassword = byId('recovery-new-password').value;
        const confirm = byId('recovery-confirm-password').value;
        if (newPassword.length < 8) {
          showError(recoveryError, 'Password must be at least 8 characters');
          return;
        }
        if (newPassword !== confirm) {
          showError(recoveryError, 'Passwords do not match');
          return;
        }
        recoveryStatus.textContent = 'Verifying identity...';
        recoveryStatus.classList.remove('hidden');
        try {
          // Get a fresh challenge — the sign-in cached one may be
          // consumed or absent. wallet-check returns one for any linked
          // wallet.
          const checkRes = await fetch('/api/auth/wallet-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pubkey: AuthScreens._walletPubkey }),
          });
          const checkData = await checkRes.json();
          const challenge = checkData.challenge;
          if (!challenge) {
            recoveryStatus.classList.add('hidden');
            showError(recoveryError, 'Could not get a challenge from the server');
            return;
          }

          const sigResult = await window.signMessage(challenge);
          const res = await fetch('/api/auth/wallet-reset-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pubkey: AuthScreens._walletPubkey,
              publicKey: sigResult.publicKey,
              challenge,
              signature: sigResult.signature,
              newPassword,
            }),
          });
          const data = await res.json();
          if (!res.ok) {
            recoveryStatus.classList.add('hidden');
            showError(recoveryError, data.error || 'Reset failed');
            return;
          }
          recoveryStatus.textContent = 'Password reset! Signing you in...';
          AuthScreens.finishLogin();
        } catch (e) {
          recoveryStatus.classList.add('hidden');
          if (e.message && e.message.includes('denied')) {
            showError(recoveryError, 'Signature request was denied.');
          } else {
            showError(recoveryError, 'Reset failed: ' + (e.message || e));
          }
        }
      });

      // ── Email-code sign-in (thin-shell migration; the #signup route) ─
      // Steps: request a code (public v4 endpoint, also creates the
      // account at verify time) → verify → choose a password →
      // immediately log in with it for the web session.
      let otpEmail = null;
      let otpSetPasswordToken = null;

      byId('btn-otp-back').addEventListener('click', () => {
        // Route change so browser back stays coherent (#signup → #login).
        location.hash = '#login';
      });

      const otpRequestCode = async () => {
        hideError(otpError);
        const email = byId('otp-email').value.trim().toLowerCase();
        if (!email || !email.includes('@')) {
          showError(otpError, 'Enter a valid email address');
          return;
        }
        AuthScreens._otpSetStatus('Sending code...');
        try {
          const res = await fetch('/api/v4/mobile/auth/otp/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          });
          const data = await res.json();
          AuthScreens._otpSetStatus(null);
          if (!res.ok || !data.success) {
            showError(otpError, data.error || 'Could not send a code');
            return;
          }
          otpEmail = email;
          byId('otp-email-echo').textContent = email;
          byId('otp-code').value = '';
          AuthScreens._otpShowStep(byId('otp-step-code'));
        } catch {
          AuthScreens._otpSetStatus(null);
          showError(otpError, 'Network error');
        }
      };

      byId('btn-otp-request').addEventListener('click', otpRequestCode);
      byId('btn-otp-resend').addEventListener('click', async () => {
        // Same request, from the code step — jump back visually so the
        // user sees the send happen, then land back on the code entry.
        byId('otp-email').value = otpEmail || '';
        await otpRequestCode();
      });

      byId('btn-otp-verify').addEventListener('click', async () => {
        hideError(otpError);
        const code = byId('otp-code').value.trim();
        if (!code) { showError(otpError, 'Enter the code from the email'); return; }
        AuthScreens._otpSetStatus('Verifying...');
        try {
          const res = await fetch('/api/v4/mobile/auth/otp/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: otpEmail, code }),
          });
          const data = await res.json();
          AuthScreens._otpSetStatus(null);
          if (!res.ok || !data.success || !data.set_password_token) {
            // The server's one generic message covers wrong/expired codes
            // — and also accounts that already have a password (they must
            // use the password form instead). Say both.
            showError(otpError, (data.error || 'Invalid or expired code.') +
              ' If your account already has a password, sign in with it instead.');
            return;
          }
          otpSetPasswordToken = data.set_password_token;
          AuthScreens._otpShowStep(byId('otp-step-password'));
        } catch {
          AuthScreens._otpSetStatus(null);
          showError(otpError, 'Network error');
        }
      });

      byId('btn-otp-set-password').addEventListener('click', async () => {
        hideError(otpError);
        const password = byId('otp-new-password').value;
        const confirm = byId('otp-confirm-password').value;
        if (password.length < 8) { showError(otpError, 'Password must be at least 8 characters'); return; }
        if (password !== confirm) { showError(otpError, 'Passwords do not match'); return; }
        AuthScreens._otpSetStatus('Setting password...');
        try {
          const res = await fetch('/api/v4/mobile/auth/set-password', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + otpSetPasswordToken,
            },
            body: JSON.stringify({ password, password_confirmation: confirm }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            AuthScreens._otpSetStatus(null);
            showError(otpError, data.error || 'Could not set the password');
            return;
          }
          otpSetPasswordToken = null;
          // Password is set — now open the WEB session with it (the v4
          // token in `data.token` is a mobile bearer, not a cookie; the
          // shell mints its own via /from-session after this login).
          AuthScreens._otpSetStatus('Signing you in...');
          const loginRes = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: otpEmail, password }),
          });
          const loginData = await loginRes.json();
          if (!loginRes.ok) {
            AuthScreens._otpSetStatus(null);
            showError(otpError, loginData.error || 'Sign-in failed — try the password form');
            return;
          }
          AuthScreens._otpSetStatus('Signed in!');
          AuthScreens.finishLogin();
        } catch {
          AuthScreens._otpSetStatus(null);
          showError(otpError, 'Network error');
        }
      });

      // "Sign in with Wallet" button handler
      byId('btn-wallet-sign-in').addEventListener('click', async () => {
        hideError(walletError);
        walletStatus.textContent = 'Verifying identity...';
        showOnly(null);

        try {
          if (!AuthScreens._cachedChallenge) {
            const checkRes = await fetch('/api/auth/wallet-check', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pubkey: AuthScreens._walletPubkey }),
            });
            const checkData = await checkRes.json();
            AuthScreens._cachedChallenge = checkData.challenge;
          }

          if (!AuthScreens._cachedChallenge) {
            walletStatus.textContent = '';
            showOnly(walletSignIn);
            showError(walletError, 'Could not get challenge from server');
            return;
          }

          const sigResult = await window.signMessage(AuthScreens._cachedChallenge);
          const verifyRes = await fetch('/api/auth/wallet-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pubkey: AuthScreens._walletPubkey,
              publicKey: sigResult.publicKey,
              challenge: AuthScreens._cachedChallenge,
              signature: sigResult.signature,
            }),
          });
          const verifyData = await verifyRes.json();
          AuthScreens._cachedChallenge = null;

          if (verifyRes.ok) {
            walletStatus.textContent = 'Logged in!';
            AuthScreens.finishLogin();
            return;
          }
          walletStatus.textContent = '';
          showOnly(walletSignIn);
          showError(walletError, verifyData.error || 'Verification failed');
        } catch (e) {
          AuthScreens._cachedChallenge = null;
          walletStatus.textContent = '';
          showOnly(walletSignIn);
          if (e.message && e.message.includes('denied')) {
            showError(walletError, 'Signature request was denied.');
          } else {
            showError(walletError, 'Signature failed: ' + (e.message || e));
          }
        }
      });
    },

    // ── Wallet fast-path probe (thin-shell migration rework) ─────────
    // The wallet sign-in is strictly OPTIONAL and additive: the standard
    // login form stays visible throughout, and every failure mode (no
    // wallet in a fresh shell, transport error, non-genesis, unlinked)
    // quietly leaves the standard form as the only option. Wallet custody
    // follows platform login (custodial provisioning over the bridge), so
    // a wallet-less shell at login time is the NORMAL state, not an error.
    async _walletDetect() {
      if (!(window.usernode && window.usernode.isNative)) return;
      try {
        AuthScreens._walletPubkey = await window.getNodeAddress();
      } catch (e) {
        console.warn('[auth-screens] no native wallet available:',
          e && e.message ? e.message : e);
        return;
      }
      if (!AuthScreens._walletPubkey) return;

      try {
        const checkRes = await fetch('/api/auth/wallet-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pubkey: AuthScreens._walletPubkey }),
        });
        const checkData = await checkRes.json();
        if (!checkRes.ok) {
          console.warn('[auth-screens] wallet-check failed (HTTP ' + checkRes.status + ')');
          return;
        }

        // Track link status independent of the genesis gate: password
        // RESET is allowed for any linked wallet (no genesis requirement,
        // issue #282). This lets a linked non-genesis wallet still reach
        // the wallet-reset path from "Forgot password?".
        AuthScreens._walletLinked = checkData.status === 'linked';

        // Only a linked, genesis wallet gets the sign-in fast path.
        if (checkData.isGenesis === false) return;
        if (checkData.status !== 'linked' || !checkData.challenge) return;

        AuthScreens._cachedChallenge = checkData.challenge;
        AuthScreens._walletUiActive = true;
        // Don't fight the email-code / recovery sub-views if one is open
        // (e.g. arrived on #signup) — the base view restores the wallet
        // UI from _walletUiActive when the user navigates back.
        if (byId('otp-view').classList.contains('hidden') &&
            byId('recovery-view').classList.contains('hidden')) {
          byId('wallet-auth').classList.remove('hidden');
          byId('wallet-divider').classList.remove('hidden');
          byId('wallet-sign-in').classList.remove('hidden');
        }
      } catch (e) {
        console.warn('[auth-screens] wallet probe failed:',
          e && e.message ? e.message : e);
      }
    },

    // ── Register (activation-code flow) ──────────────────────────────

    _registerOnShow(seg) {
      // #register/<code> deep link (old /register.html?code=<code>).
      const codeEl = byId('reg-code');
      if (seg && codeEl && !codeEl.value) {
        codeEl.value = decodeURIComponent(seg);
        const userEl = byId('reg-username');
        if (userEl) userEl.focus();
      }
    },

    _wireRegister() {
      const form = byId('register-form');
      const errorEl = byId('reg-error');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.classList.add('hidden');
        const code = byId('reg-code').value.trim();
        const username = byId('reg-username').value.trim();
        const password = byId('reg-password').value;
        try {
          const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, username, password }),
          });
          const data = await res.json();
          if (!res.ok) {
            showError(errorEl, data.error || 'Registration failed');
            return;
          }
          AuthScreens.finishLogin();
        } catch {
          showError(errorEl, 'Network error');
        }
      });
    },

    // ── Waiting room (platform-access gate) ──────────────────────────

    _waitingOnShow() {
      const who = byId('waiting-who');
      if (who && window.App && App.user) who.textContent = App.user.username || '';
      AuthScreens._startWaitingPoll();
    },

    _startWaitingPoll() {
      if (AuthScreens._waitingTimer) return;
      const state = byId('waiting-check-state');

      const check = async () => {
        try {
          const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
          if (res.status === 401) {
            // Session died while waiting — back to the login screen.
            AuthScreens._stopWaitingPoll();
            if (window.App) App.user = null;
            location.hash = '#login';
            return;
          }
          const data = await res.json();
          const user = data && data.user;
          if (!user) return;
          const who = byId('waiting-who');
          if (who) who.textContent = user.username || '';
          if (user.hasPlatformAccess) {
            // Released! Boot the full shell in place — same reload-free
            // path as login.
            AuthScreens._stopWaitingPoll();
            const target = AuthScreens._pendingHash || '';
            AuthScreens._pendingHash = '';
            history.replaceState(null, '', '/' + target);
            fx(() => {
              AuthScreens.hideAll();
              App.enterAuthed(user);
            }, 'pop');
            return;
          }
          if (state) state.textContent = 'Last checked ' + new Date().toLocaleTimeString();
        } catch (_) {
          if (state) state.textContent = 'Connection issue — will retry';
        }
      };

      check();
      AuthScreens._waitingTimer = setInterval(check, 30000);
    },

    _stopWaitingPoll() {
      if (AuthScreens._waitingTimer) {
        clearInterval(AuthScreens._waitingTimer);
        AuthScreens._waitingTimer = null;
      }
    },

    _wireWaiting() {
      byId('waiting-logout').addEventListener('click', async () => {
        AuthScreens._stopWaitingPoll();
        // Settings.logout does the full teardown (hard native logout, SW
        // cache clear) and hard-navigates — the reload is the correct
        // teardown for a session switch (enterAuthed is one-shot).
        if (window.Settings && typeof Settings.logout === 'function') {
          Settings.logout();
          return;
        }
        try {
          await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        } catch (_) {}
        window.location.href = '/';
      });
    },
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

  window.AuthScreens = AuthScreens;
})();
