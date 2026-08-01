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
// #register[/<code>], #waiting. app.js's restoreFromHash owns the
// routing and calls AuthScreens.show(); this module owns the screens.
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
  };

  // Drives push (deeper) vs pop (back toward landing) transition types.
  const DEPTH = { landing: 0, login: 1, signup: 1, register: 1, waiting: 1 };

  const ROUTES = Object.keys(SCREEN_IDS);

  // Screen transitions come from the platform's native kit via the
  // PlatformUI seam; when the kit failed to load the mutation just runs
  // without animation.
  function fx(fn, type) {
    if (window.PlatformUI) window.PlatformUI.transition(fn, { type });
    else fn();
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
      if (prev === 'waiting' && route !== 'waiting') AuthScreens._stopWaitingPoll();

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

    _landingOnShow() {
      // CTA row flips when a (waiting-room) session exists — signing in
      // again makes no sense there.
      const hasSession = !!(window.App && App.user);
      const ctas = byId('landing-ctas');
      const back = byId('landing-back-to-waiting');
      if (ctas) ctas.classList.toggle('hidden', hasSession);
      if (back) back.classList.toggle('hidden', !hasSession);
      if (!AuthScreens._landingAppsLoaded) {
        AuthScreens._landingAppsLoaded = true;
        AuthScreens._loadLandingApps();
      }
    },

    _wireLanding() {
      // Waitlist join form → POST /api/public/waitlist.
      const form = byId('waitlist-form');
      const emailEl = byId('waitlist-email');
      const btn = byId('waitlist-submit');
      const msg = byId('waitlist-msg');

      const showMsg = (text, isError) => {
        msg.textContent = text;
        msg.className = 'text-sm mt-3 ' + (isError
          ? 'text-red-500 dark:text-red-400'
          : 'text-emerald-600 dark:text-emerald-400');
      };

      if (form) form.addEventListener('submit', async (e) => {
        e.preventDefault();
        btn.disabled = true;
        try {
          const res = await fetch('/api/public/waitlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: emailEl.value.trim() }),
          });
          const data = await res.json().catch(() => null);
          if (res.ok) {
            showMsg((data && data.message) || "You're on the waitlist.", false);
            form.reset();
          } else {
            showMsg((data && data.error) || 'Something went wrong — try again.', true);
          }
        } catch (_) {
          showMsg('Connection issue — try again.', true);
        }
        btn.disabled = false;
      });

      // In-page app viewer: public apps open in an iframe overlay with a
      // corner Back instead of target=_blank (which strands mobile
      // webview users on the app subdomain with no way back). Uses a
      // history state marker (not a hash) so the browser/OS back gesture
      // closes the viewer without disturbing the hash router.
      const viewer = byId('app-viewer');
      const viewerFrame = byId('app-viewer-frame');
      const viewerTitle = byId('app-viewer-title');

      AuthScreens._openLandingApp = (app) => {
        viewerTitle.textContent = app.name || app.slug || '';
        viewerFrame.src = app.url;
        history.pushState({ svAnonAppViewer: true }, '', location.href);
        fx(() => viewer.classList.remove('hidden'), 'push');
      };

      const closeViewer = () => {
        if (viewer.classList.contains('hidden')) return;
        fx(() => {
          viewer.classList.add('hidden');
          viewerFrame.src = 'about:blank';
        }, 'pop');
      };

      byId('app-viewer-back').addEventListener('click', () => {
        if (history.state && history.state.svAnonAppViewer) history.back();
        else closeViewer();
      });
      window.addEventListener('popstate', closeViewer);
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
          appsEl.appendChild(el('p', 'text-sm text-zinc-500', 'No public apps yet.'));
          return;
        }
        for (const app of apps) {
          const card = el('a',
            'block rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 p-4 hover:border-violet-400 dark:hover:border-violet-500 transition-colors');
          // Real href kept for open-in-new-tab affordances; a plain
          // click opens the in-page viewer so there's always a Back.
          card.href = app.url || '#';
          card.rel = 'noopener';
          card.addEventListener('click', (e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || !app.url) return;
            e.preventDefault();
            AuthScreens._openLandingApp(app);
          });
          card.appendChild(el('div', 'font-medium text-sm mb-1', app.name || app.slug));
          const contributors = (app.contributors || []).map((c) => c.username).filter(Boolean);
          card.appendChild(el('div', 'text-xs text-zinc-500 dark:text-zinc-400',
            contributors.length
              ? 'By ' + contributors.slice(0, 3).join(', ') + (contributors.length > 3 ? ` +${contributors.length - 3}` : '')
              : 'Community app'));
          appsEl.appendChild(card);
        }
      } catch (_) {
        appsEl.textContent = '';
        appsEl.appendChild(el('p', 'text-sm text-zinc-500', 'Could not load apps right now.'));
      }
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
        // Settings.logout does the full teardown (native stopNode/logout,
        // SW cache clear) and hard-navigates — the reload is the correct
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
