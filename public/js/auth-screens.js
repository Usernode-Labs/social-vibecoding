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
    // runtime-built (frozen-markup contract; see _ensureResetUi).
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
      showError(errorEl, "You're offline — signing in needs a connection.");
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
      AuthScreens._hideResetView();
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
      AuthScreens._hideResetView();
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

    // ── Email password reset (magic link) ────────────────────────────
    //
    // The shell's markup is id-pinned (tests/shell-id-inventory.test.js), so
    // the email-request form and the #reset-password/<token> redeem view
    // are runtime-built here, the way every post-fixture feature adds UI.
    // Class strings are copied verbatim from the neighbouring frozen
    // markup, so the compiled Tailwind already covers all of them.
    _resetToken: null,
    _resetUiBuilt: false,

    _hideResetView() {
      const view = byId('reset-password-view');
      if (view) view.classList.add('hidden');
    },

    _ensureResetUi() {
      if (AuthScreens._resetUiBuilt) return;
      AuthScreens._resetUiBuilt = true;

      const P = 'text-sm text-zinc-500 dark:text-zinc-400';
      const LABEL = 'block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1';
      const INPUT = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500';
      const BUTTON = 'w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 font-medium transition-colors text-white';
      const EXPIRED_MSG = 'This reset link is invalid or has expired. Go back to login and request a new one from "Forgot password?".';

      // The email-request form, shown above the admin fallback in the
      // recovery view. Static strings only — nothing user-authored ever
      // goes through this innerHTML.
      const emailSec = document.createElement('div');
      emailSec.id = 'recovery-email';
      emailSec.className = 'hidden space-y-3';
      emailSec.innerHTML =
        '<p class="' + P + '">Enter the email address on your account and we\'ll send you a link to choose a new password.</p>' +
        '<div>' +
          '<label class="' + LABEL + '" for="recovery-email-input">Email</label>' +
          '<input id="recovery-email-input" type="email" autocomplete="email" class="' + INPUT + '" placeholder="you@example.com">' +
        '</div>' +
        '<div id="recovery-email-error" class="text-red-400 text-sm hidden"></div>' +
        '<div id="recovery-email-status" class="text-sm text-zinc-400 hidden"></div>' +
        '<button id="btn-email-reset" type="button" class="' + BUTTON + '">Email me a reset link</button>';
      const adminSec = byId('recovery-admin');
      adminSec.parentNode.insertBefore(emailSec, adminSec);

      // Reposition the admin path as the fallback: the frozen markup's
      // lead paragraph still claims accounts have no email on file, which
      // stopped being true when email became a login identifier.
      const adminLead = adminSec.querySelector('p');
      if (adminLead) {
        adminLead.textContent = 'No confirmed email on your account? The link above can only go to a confirmed address — but an admin can still get you back in.';
      }

      // The redeem view the emailed link lands on — a sibling sub-view of
      // #recovery-view on the same login card.
      const recoveryView = byId('recovery-view');
      const view = document.createElement('div');
      view.id = 'reset-password-view';
      view.className = 'hidden space-y-4';
      view.innerHTML =
        '<h2 class="text-lg font-bold text-center">Choose a new password</h2>' +
        '<div>' +
          '<label class="' + LABEL + '" for="reset-new-password">New password</label>' +
          '<input id="reset-new-password" type="password" autocomplete="new-password" class="' + INPUT + '" placeholder="at least 8 characters">' +
        '</div>' +
        '<div>' +
          '<label class="' + LABEL + '" for="reset-confirm-password">Confirm new password</label>' +
          '<input id="reset-confirm-password" type="password" autocomplete="new-password" class="' + INPUT + '" placeholder="re-enter new password">' +
        '</div>' +
        '<div id="reset-error" class="text-red-400 text-sm hidden"></div>' +
        '<div id="reset-status" class="text-sm text-zinc-400 hidden"></div>' +
        '<button id="btn-reset-confirm" type="button" class="' + BUTTON + '">Set new password</button>' +
        '<button id="btn-reset-back" type="button" class="w-full text-sm text-zinc-500 hover:text-zinc-300">Back to login</button>';
      recoveryView.parentNode.insertBefore(view, recoveryView.nextSibling);

      byId('btn-email-reset').addEventListener('click', async () => {
        const errorEl = byId('recovery-email-error');
        const statusEl = byId('recovery-email-status');
        hideError(errorEl);
        statusEl.classList.add('hidden');
        if (blockedOffline(errorEl)) return;
        const email = byId('recovery-email-input').value.trim();
        if (!email || email.indexOf('@') === -1) {
          showError(errorEl, 'Enter the email address on your account');
          return;
        }
        const btn = byId('btn-email-reset');
        btn.disabled = true;
        try {
          const res = await fetch('/api/auth/password-reset/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            showError(errorEl, data.error || 'Could not send the link — try again in a minute');
            return;
          }
          // Anti-enumeration: the server answers the same whether or not
          // the address matched, and so does this copy.
          statusEl.textContent = 'If that address matches an account, a reset link is on its way. It expires in 30 minutes.';
          statusEl.classList.remove('hidden');
        } catch {
          showError(errorEl, 'Network error');
        } finally {
          btn.disabled = false;
        }
      });

      byId('btn-reset-confirm').addEventListener('click', async () => {
        const errorEl = byId('reset-error');
        const statusEl = byId('reset-status');
        hideError(errorEl);
        statusEl.classList.add('hidden');
        if (blockedOffline(errorEl)) return;
        const newPassword = byId('reset-new-password').value;
        const confirm = byId('reset-confirm-password').value;
        if (newPassword.length < 8) {
          showError(errorEl, 'Password must be at least 8 characters');
          return;
        }
        if (newPassword !== confirm) {
          showError(errorEl, 'Passwords do not match');
          return;
        }
        const btn = byId('btn-reset-confirm');
        btn.disabled = true;
        try {
          const res = await fetch('/api/auth/password-reset/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: AuthScreens._resetToken, newPassword }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            showError(errorEl, res.status === 401
              ? EXPIRED_MSG
              : (data.error || 'Reset failed — try again'));
            return;
          }
          // The reset revoked every session on purpose; signing in with
          // the new password is the one remaining step.
          statusEl.textContent = 'Your password has been reset. Head back to login and sign in with it.';
          statusEl.classList.remove('hidden');
        } catch {
          showError(errorEl, 'Network error');
        } finally {
          btn.disabled = false;
        }
      });

      byId('btn-reset-back').addEventListener('click', () => {
        // Route change so browser back stays coherent; the direct call
        // covers the no-hashchange case (already on #login).
        location.hash = '#login';
        AuthScreens._showLoginBaseView();
      });
    },

    // Per-route side effect for #reset-password/<token>: hide every other
    // sub-view of the shared login screen and show the redeem form.
    _resetOnShow(token) {
      AuthScreens._ensureResetUi();
      AuthScreens._resetToken = token || null;
      byId('login-form').classList.add('hidden');
      byId('register-link').classList.add('hidden');
      byId('forgot-link-wrap').classList.add('hidden');
      byId('otp-link-wrap').classList.add('hidden');
      byId('otp-view').classList.add('hidden');
      byId('wallet-auth').classList.add('hidden');
      byId('recovery-view').classList.add('hidden');
      hideError(byId('reset-error'));
      byId('reset-status').classList.add('hidden');
      byId('reset-new-password').value = '';
      byId('reset-confirm-password').value = '';
      byId('reset-password-view').classList.remove('hidden');
      // A mangled link can be refused without a round trip — same message
      // the server would return.
      if (!AuthScreens._resetToken || !/^[0-9a-f]{64}$/.test(AuthScreens._resetToken)) {
        showError(byId('reset-error'), 'This reset link is invalid or has expired. Go back to login and request a new one from "Forgot password?".');
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
        if (blockedOffline(errorEl)) return;
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
        AuthScreens._hideResetView();
        byId('recovery-view').classList.remove('hidden');

        // Wallet self-reset only when in the native app with a linked
        // wallet; everyone else gets the emailed magic link, with the
        // admin-temporary-password instructions as the fallback below it.
        AuthScreens._ensureResetUi();
        if (isNative() && AuthScreens._walletPubkey && AuthScreens._walletLinked) {
          byId('recovery-wallet').classList.remove('hidden');
          byId('recovery-email').classList.add('hidden');
          byId('recovery-admin').classList.add('hidden');
        } else {
          byId('recovery-wallet').classList.add('hidden');
          byId('recovery-email').classList.remove('hidden');
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
        const emailSec = byId('recovery-email');
        if (emailSec) emailSec.classList.add('hidden');
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
        if (blockedOffline(otpError)) return;
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
        if (blockedOffline(otpError)) return;
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
        if (blockedOffline(otpError)) return;
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
        if (blockedOffline(walletError)) return;
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
        if (blockedOffline(errorEl)) return;
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
            if (window.App) {
              App.user = null;
              if (typeof App.enterAnonymous === 'function') {
                await App.enterAnonymous();
              }
            }
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
        // Settings.logout commits web logout/cache cleanup before its final
        // hard-native boundary (or hard-navigates in a regular browser).
        // Keep polling alive if that preflight or web logout fails.
        if (window.Settings && typeof Settings.logout === 'function') {
          Settings.logout();
          return;
        }
        AuthScreens._stopWaitingPoll();
        try { window.App?.clearSessionSnapshot?.(); } catch (_) {}
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

  // Coming back online re-enables the controls via CSS (body.is-offline
  // drops off), so the "you're offline" error left on screen would be the
  // only thing still saying otherwise. Clear it.
  // (Guarded: the anonymous-shell tests eval this file in a bare sandbox
  // whose `window` is not an event target.)
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('usernode:offline-change', (e) => {
      if (!e.detail || e.detail.offline !== false) return;
      ['login-error', 'otp-error', 'wallet-error', 'reg-error'].forEach((id) => {
        const el = byId(id);
        if (el && /offline/i.test(el.textContent || '')) hideError(el);
      });
    });
  }

  window.AuthScreens = AuthScreens;
})();
