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

  // Coming back online used to be handled here: a `usernode:offline-change`
  // listener cleared the stale "you're offline" message from every
  // credential screen's error slot, since the CSS re-enables the controls
  // and nothing else would say the message no longer applied. Every one of
  // those slots — login, otp, wallet, register — now belongs to a React
  // screen that owns its own listener (#1080 chunk C), so there is nothing
  // left out here to clear.

  window.AuthScreens = AuthScreens;
})();
