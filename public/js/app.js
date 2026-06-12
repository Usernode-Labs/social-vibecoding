// Top-level `const` doesn't auto-write to `window` in non-module
// scripts, so other modules that read `window.App.…` instead of the
// bare `App.…` identifier silently see `undefined`. Mirror onto
// `window` explicitly so both styles work — the rest of this file
// uses bare `App` because it's already in scope here.
const App = {
  user: null,
  currentApp: null,
  // Top-level mode: 'app' (the running iframe) or 'dev' (#194). The
  // legacy tab names 'group-chat' / 'individual-chat' are normalized to
  // dev sub-tabs by _normalizeTab so old links, notification hrefs, and
  // call sites keep working.
  currentTab: 'app',
  // Active Dev view: 'forum' (the card list, default), 'chat'
  // (full-screen general chat), 'topic' (an issue/proposal discussion
  // open full-screen), 'sessions' (a dev session open full-screen), or
  // 'settings' (the app-settings page). Only meaningful while
  // currentTab === 'dev'.
  currentSubTab: 'forum',
  // Tracks whether the dedicated #leaderboard-screen is visible.
  // Sibling state to `currentApp`: home / app / leaderboard are the
  // three top-level screens, and they're mutually exclusive. Flipped
  // by navigateToLeaderboard() / _exitLeaderboard() / navigateHome().
  _inLeaderboard: false,

  // Set to true while restoreFromHash() is applying a URL (e.g. on
  // popstate/hashchange) so that the navigation helpers it calls
  // (navigateToApp, switchTab, navigateHome) don't push a NEW history
  // entry on top of the one the browser just popped to. Without this
  // guard, "back" would push a forward entry and the user could never
  // actually leave the page.
  _isRestoring: false,

  async init() {
    // Install fetch wrap and (if we were mid-restart on a previous load)
    // restore the platform-updating banner state BEFORE any other init
    // step that might fire a write. See PlatformUpdating below.
    App.PlatformUpdating.installFetchWrap();
    App.PlatformUpdating.restoreFromSessionStorage();

    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) {
        window.location.href = '/login.html';
        return;
      }
      const data = await res.json();
      App.user = data.user;
      // "View as non-admin" admin tool. We mask `App.user.isAdmin`
      // for client-side UI gating (admin buttons, retry, delete, lock,
      // app-secrets edit, etc. — see grep for App.user?.isAdmin) so
      // an admin can preview the experience a regular user gets.
      // Server-side `req.user.isAdmin` is unaffected — this is purely
      // visual, not a privilege drop. We stash the real value on
      // App._realIsAdmin so settings.js knows whether to render the
      // toggle, and the body class lets a thin header banner reveal
      // the masked state at all times so the admin doesn't forget
      // they're in preview mode.
      App._realIsAdmin = !!App.user?.isAdmin;
      App._viewAsNonAdmin = App._realIsAdmin
        && localStorage.getItem('viewAsNonAdmin') === '1';
      if (App._viewAsNonAdmin && App.user) {
        App.user.isAdmin = false;
        document.body.classList.add('is-view-as-non-admin');
      }
    } catch {
      window.location.href = '/login.html';
      return;
    }

    App.bindEvents();
    App.connectEvents();
    App.loadVersion();
    // Header kudos budget badge polls /api/me/kudos-budget once at
    // load and then on a long interval (hourly safety-net for the
    // Monday-UTC rollover). Refreshes opportunistically on every
    // successful give + on the leaderboard screen mount.
    if (window.Kudos?.Budget?.init) Kudos.Budget.init();
    App.restoreFromHash();

    // Re-poll the platform version every 10s so the header pill flips to
    // its "deploying" state within seconds of the deploy workflow signaling
    // start, and back to "current" (or "stale") when it finishes. Cheap
    // endpoint — just reads one tiny file off disk on the server.
    //
    // While the Phase 3 platform-updating banner is active we kick the
    // cadence up to 2s (see PlatformUpdating.startFastPolling) so the
    // banner clears within ~2s of the new container coming up. The slow
    // interval is the steady-state baseline and remains scheduled
    // unconditionally.
    setInterval(App.loadVersion, 10_000);
  },

  // The SHA the currently-loaded client JS was shipped with. Captured on
  // first poll so we can compare against later polls and surface a
  // "platform updated, reload to use new features" hint when the running
  // platform has moved on but this tab hasn't.
  loadedPlatformSha: null,

  async loadVersion() {
    try {
      const res = await fetch('/api/version');
      if (!res.ok) return;
      const info = await res.json();
      if (!App.loadedPlatformSha && info.sha && info.sha !== 'dev') {
        App.loadedPlatformSha = info.sha;
      }
      // Phase 3: if we're in the platform-updating window, dismiss the
      // banner the moment /api/version reports a SHA different from the
      // one we recorded at trigger time. Independent of WebSocket health
      // — this is exactly the path that recovers the tab after the WS
      // dropped during the GHA rolling restart.
      App.PlatformUpdating.observeVersion(info);
      App.renderPlatformVersionPill(info);
    } catch {}
  },

  // Four rendering states. Reuses .app-version-pill base styles + a
  // couple of modifier classes (see public/css/app.css) for the deploying
  // and stale variants. Always leads with the project name (e.g.
  // "usernode") so it reads symmetrically with the per-app pill that
  // sits next to it ("myapp · 1a2b3c4 · #42").
  renderPlatformVersionPill(info) {
    const slot = document.getElementById('platform-version-pill-slot');
    if (!slot) return;

    const runningSha = info.sha;
    const repoUrl = info.repoUrl || '#';
    const deploy = info.deployProgress;
    const isDeploying = !!(deploy && deploy.deploying);
    const isStale = !isDeploying
      && App.loadedPlatformSha
      && runningSha
      && runningSha !== App.loadedPlatformSha
      && runningSha !== 'dev';

    // Project label — sourced from the server (env-overridable, defaults
    // to "usernode"). Run through a tiny escaper since it's user-config.
    const safeName = App._escapeHtml(info.name || 'usernode');
    const namePart = `<span class="app-version-pill-name">${safeName}</span><span class="app-version-pill-sep">·</span>`;

    if (!runningSha || runningSha === 'dev') {
      // Local dev / no GIT_SHA — render a low-key "dev" chip so the slot
      // isn't empty (which can look like a layout bug).
      slot.innerHTML = `
        <span class="app-version-pill" title="Running outside of a deploy (no GIT_SHA set)">
          <span class="app-version-pill-dot" style="background:#71717a;box-shadow:none"></span>
          <span class="app-version-pill-label">${namePart}dev</span>
        </span>`;
      return;
    }

    if (isDeploying) {
      const newShort = (deploy.sha || '').slice(0, 7);
      const oldShort = runningSha.slice(0, 7);
      const elapsed = deploy.startedAt
        ? Math.max(0, Math.floor((Date.now() - new Date(deploy.startedAt).getTime()) / 1000))
        : null;
      const tipParts = [`Deploying ${newShort || 'new build'}`];
      if (oldShort) tipParts.push(`from ${oldShort}`);
      if (elapsed != null) tipParts.push(`${elapsed}s elapsed`);
      const shaLabel = newShort ? `→ ${newShort}` : 'deploying';
      slot.innerHTML = `
        <span class="app-version-pill app-version-pill--deploying" title="${tipParts.join(' · ')}">
          <span class="app-version-pill-spinner" aria-hidden="true"></span>
          <span class="app-version-pill-label">${namePart}${shaLabel}</span>
        </span>`;
      return;
    }

    if (isStale) {
      const oldShort = App.loadedPlatformSha.slice(0, 7);
      const newShort = runningSha.slice(0, 7);
      slot.innerHTML = `
        <button type="button"
                class="app-version-pill app-version-pill--stale"
                title="Platform updated from ${oldShort} to ${newShort}. Click to reload."
                onclick="location.reload()">
          <span class="app-version-pill-dot"></span>
          <span class="app-version-pill-label">${namePart}${newShort} · reload</span>
        </button>`;
      return;
    }

    const shortSha = runningSha.slice(0, 7);
    const href = `${repoUrl.replace(/\/$/, '')}/commit/${runningSha}`;
    slot.innerHTML = `
      <a href="${href}" target="_blank" rel="noopener" class="app-version-pill" title="Platform commit ${shortSha}">
        <span class="app-version-pill-dot"></span>
        <span class="app-version-pill-label">${namePart}${shortSha}</span>
      </a>`;
  },

  // Tiny local HTML-escaper so the project name (sourced from an env
  // var on the server) can't break out of the attribute/text context.
  // Kept on App rather than reaching into app-view.js's helpers since
  // those load conditionally / aren't guaranteed to be in scope here.
  _escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  },

  // ─────────────────────────────────────────────────────────────────
  // SELF-HOSTING.md Phase 3: "Platform updating…" banner.
  //
  // Lifecycle:
  //   1. server broadcasts vote_update { merging:true, selfHosted:true }
  //      when a self-app PR transitions promoted → merging.
  //   2. handleVoteUpdate calls PlatformUpdating.begin(...).
  //   3. begin() persists { fromSha, since } to sessionStorage, shows
  //      the banner, kicks the version poll up to 2s, and arms a 5min
  //      "stuck" timer that swaps the banner to its red+Reload variant.
  //   4. App.loadVersion calls observeVersion(info) on every poll. As
  //      soon as info.sha differs from fromSha (and isn't 'dev'),
  //      end() clears state, hides the banner, and reloads the page —
  //      the new server may ship new client code, so a hard reload
  //      avoids version-skew bugs.
  //   5. The wrapped fetch (installFetchWrap) rejects all non-GET
  //      requests while the banner is up — this is the actual write
  //      block; the banner is just the signal. GETs flow through so
  //      the version poll, auth check, etc. still work.
  //
  // Page-load recovery: restoreFromSessionStorage() runs early in
  // init() so a tab that loaded mid-restart (or was reloaded by the
  // user) re-renders the banner immediately and re-arms the poll.
  //
  // #239 second mode — "resolving merge conflicts". When a self-app
  // merge fails on a conflict and the auto-resolver kicks in
  // (vote_update { resolving:true } / { mergeFailed:true,
  // resolving:true }), the banner switches to a non-blocking amber
  // state instead of silently dismissing. Crucially isActive() stays
  // false in this mode, so the fetch wrap never blocks writes — the
  // platform isn't actually restarting. The state persists in
  // sessionStorage (verified against /api/sessions/:id/status on
  // restore), polls that endpoint every ~5s as the missed-WS-event
  // safety net, and ends on the resolver's terminal broadcast:
  // merged → begin() has already upgraded us to full updating mode;
  // synced/noop → quiet dismiss; failed → red variant + Dismiss
  // button, auto-hiding after ~20s.
  // ─────────────────────────────────────────────────────────────────
  PlatformUpdating: {
    SS_KEY: 'usernode:platform_updating',
    POLL_FAST_MS: 2000,
    STUCK_AFTER_MS: 5 * 60 * 1000,
    RESOLVE_POLL_MS: 5000,
    RESOLVE_FAILED_HIDE_MS: 20 * 1000,

    // Mutable runtime state. Persisted shape (in sessionStorage) is
    // just { fromSha, since } — or { mode:'resolving', sessionId,
    // appSlug, since } for the resolving mode — the timer ids and DOM
    // refs are ephemeral and must be re-derived on page load.
    fromSha: null,
    since: null,
    fastPollTimer: null,
    stuckTimer: null,
    fetchWrapInstalled: false,
    // #239 resolving-mode state: { sessionId, appSlug, since } | null.
    resolvingSession: null,
    resolvePollTimer: null,
    resolveStuckTimer: null,
    resolveFailedTimer: null,

    isActive() {
      return !!this.fromSha;
    },

    begin({ appSlug, sessionId } = {}) {
      // Idempotent: a second begin() (e.g. server resends the merging
      // event) is a no-op. The fromSha must be captured at first entry
      // — re-capturing on a duplicate call would defeat the SHA-flip
      // dismissal if the new container had already booted in between.
      if (this.isActive()) return;
      // #239 upgrade path: the resolver fixed the conflicts and the
      // retried merge is now in flight (merging:true arrives before the
      // resolver's terminal event). Clear the resolving state quietly —
      // no hide, the banner transitions in place to full updating mode
      // — so the late endResolving('merged') is a guaranteed no-op.
      if (this.resolvingSession) this._clearResolvingState();
      const fromSha = App.loadedPlatformSha || null;
      this.fromSha = fromSha;
      this.since = Date.now();
      try {
        sessionStorage.setItem(this.SS_KEY, JSON.stringify({
          fromSha, since: this.since, appSlug: appSlug || null, sessionId: sessionId || null,
        }));
      } catch {}
      this.show(/* stuck */ false);
      this.startFastPolling();
      this.armStuckTimer();
      console.log('[platform-updating] banner armed', { fromSha, appSlug });
    },

    restoreFromSessionStorage() {
      let raw = null;
      try { raw = sessionStorage.getItem(this.SS_KEY); } catch {}
      if (!raw) return;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch {}
      if (!parsed || typeof parsed !== 'object') {
        try { sessionStorage.removeItem(this.SS_KEY); } catch {}
        return;
      }
      // #239: resolving-mode payload. Verify against the server before
      // re-showing — the resolve may have finished while this tab was
      // reloading, and a stale banner with no terminal event coming
      // would sit until the stuck timer. Drop the state on anything
      // but a confirmed in-flight resolve.
      if (parsed.mode === 'resolving') {
        const since = parsed.since || Date.now();
        if (!parsed.sessionId || Date.now() - since >= this.STUCK_AFTER_MS) {
          try { sessionStorage.removeItem(this.SS_KEY); } catch {}
          return;
        }
        fetch(`/api/sessions/${parsed.sessionId}/status`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            // A WS event may have armed either mode while we awaited.
            if (this.isActive() || this.resolvingSession) return;
            if (data && data.resolving) {
              this.resolvingSession = {
                sessionId: parsed.sessionId, appSlug: parsed.appSlug || null, since,
              };
              this.showResolving();
              this.startResolvePolling();
              this.armResolveStuckTimer();
              console.log('[platform-updating] resolving banner restored from session');
            } else {
              try { sessionStorage.removeItem(this.SS_KEY); } catch {}
            }
          })
          .catch(() => {});
        return;
      }
      this.fromSha = parsed.fromSha || null;
      this.since = parsed.since || Date.now();
      const elapsed = Date.now() - this.since;
      this.show(elapsed >= this.STUCK_AFTER_MS);
      this.startFastPolling();
      this.armStuckTimer();
      console.log('[platform-updating] banner restored from session', { elapsedMs: elapsed });
    },

    observeVersion(info) {
      if (!this.isActive()) return;
      const sha = info && info.sha;
      // Wait for a real, deploy-pinned SHA different from the one we
      // captured. 'dev' means GIT_SHA wasn't set on the responding
      // container — almost certainly a misconfigured rebuild rather
      // than the legitimate post-restart steady state, so don't
      // dismiss off it.
      if (!sha || sha === 'dev' || sha === this.fromSha) return;
      this.end({ newSha: sha });
    },

    // The merge behind this banner failed before any deploy started
    // (vote_update { mergeFailed:true }). No new code is coming, so
    // there's no SHA flip to wait for and no reason to reload — just
    // clear the latch and lift the write block. Safe when the banner
    // isn't armed (no-op).
    cancel() {
      if (!this.isActive()) return;
      console.log('[platform-updating] cancelled (merge failed, no deploy)');
      try { sessionStorage.removeItem(this.SS_KEY); } catch {}
      this.fromSha = null;
      this.since = null;
      this.stopFastPolling();
      this.disarmStuckTimer();
      this.hide();
    },

    // ── #239 resolving mode ──────────────────────────────────────────
    // Non-blocking sibling of begin(): the merge hit conflicts and the
    // auto-resolver is fixing the branch (1–2 min worker turn). The
    // platform is NOT restarting, so isActive() stays false and writes
    // keep flowing — the banner is purely informational.
    beginResolving({ sessionId, appSlug } = {}) {
      // Idempotent + first-wins: a no-op while updating mode is active
      // (that banner outranks this one) or while already tracking a
      // resolve (a second concurrent resolve on a different session is
      // covered by the vote-panel badges instead).
      if (this.isActive() || this.resolvingSession) return;
      if (sessionId == null) return;
      const since = Date.now();
      this.resolvingSession = { sessionId, appSlug: appSlug || null, since };
      try {
        sessionStorage.setItem(this.SS_KEY, JSON.stringify({
          mode: 'resolving', sessionId, appSlug: appSlug || null, since,
        }));
      } catch {}
      this.showResolving();
      this.startResolvePolling();
      this.armResolveStuckTimer();
      console.log('[platform-updating] resolving banner armed', { sessionId, appSlug });
    },

    // Terminal handler for the resolver lifecycle. `sessionId` (when
    // provided — the WS event carries it; the status poll doesn't)
    // must match the tracked resolve.
    endResolving(outcome, sessionId) {
      // Ordering guard: on the success path the retried merge's
      // merging:true broadcast precedes the resolver's terminal event,
      // and begin() has already upgraded the banner to full updating
      // mode (clearing resolvingSession on the way). A late
      // endResolving('merged') must not touch that banner.
      if (!this.resolvingSession) return;
      if (sessionId != null && this.resolvingSession.sessionId !== sessionId) return;
      console.log('[platform-updating] resolving ended', { outcome });
      this._clearResolvingState();
      if (outcome === 'failed') {
        this.showResolveFailed();
      } else {
        // merged (when begin() somehow hasn't fired yet) / synced /
        // noop → quiet dismiss; group chat carries the details.
        this.hide();
      }
    },

    // Clears the resolving runtime state without touching the banner
    // DOM — callers decide whether to hide, swap variants, or (on the
    // begin() upgrade path) leave it for show() to repaint in place.
    _clearResolvingState() {
      this.resolvingSession = null;
      this.stopResolvePolling();
      this.disarmResolveStuckTimer();
      // Only drop the persisted payload when it's ours: on the upgrade
      // path begin() overwrites SS_KEY right after this anyway, and
      // updating mode is never active while resolving mode is.
      if (!this.isActive()) {
        try { sessionStorage.removeItem(this.SS_KEY); } catch {}
      }
    },

    showResolving() {
      const el = document.getElementById('platform-updating-banner');
      if (!el) return;
      this._clearResolveFailedTimer();
      el.classList.remove('hidden');
      this._setBannerTone('amber');
      const text = document.getElementById('platform-updating-text');
      const spinner = document.getElementById('platform-updating-spinner');
      const reload = document.getElementById('platform-updating-reload');
      const dismiss = document.getElementById('platform-updating-dismiss');
      if (text) text.textContent = 'Merge hit conflicts with main — resolving them automatically, then retrying the merge. This usually takes a minute or two.';
      if (spinner) spinner.classList.remove('hidden');
      if (reload) reload.classList.add('hidden');
      if (dismiss) dismiss.classList.add('hidden');
    },

    // Red terminal variant: Claude couldn't resolve the conflicts (or
    // the sync errored / owner over budget). No deploy is coming, so
    // there's nothing to wait for — Dismiss button + ~20s auto-hide.
    showResolveFailed() {
      const el = document.getElementById('platform-updating-banner');
      if (!el) return;
      this._clearResolveFailedTimer();
      el.classList.remove('hidden');
      this._setBannerTone('red');
      const text = document.getElementById('platform-updating-text');
      const spinner = document.getElementById('platform-updating-spinner');
      const reload = document.getElementById('platform-updating-reload');
      const dismiss = document.getElementById('platform-updating-dismiss');
      if (text) text.textContent = "Automatic conflict resolution failed — check the app's group chat for details";
      if (spinner) spinner.classList.add('hidden');
      if (reload) reload.classList.add('hidden');
      if (dismiss) dismiss.classList.remove('hidden');
      this.resolveFailedTimer = setTimeout(() => this.dismissResolveFailure(), this.RESOLVE_FAILED_HIDE_MS);
    },

    // Wired to #platform-updating-dismiss (and the auto-hide timer).
    // Guarded so a stale timer can't hide a banner that a later
    // begin()/beginResolving() has since re-armed.
    dismissResolveFailure() {
      this._clearResolveFailedTimer();
      if (this.isActive() || this.resolvingSession) return;
      this.hide();
    },

    _clearResolveFailedTimer() {
      if (this.resolveFailedTimer != null) {
        clearTimeout(this.resolveFailedTimer);
        this.resolveFailedTimer = null;
      }
    },

    // ~5s safety-net poll of /api/sessions/:id/status — WS is
    // fire-and-forget, so a dropped connection could eat the terminal
    // event and strand the banner until the stuck timer.
    startResolvePolling() {
      if (this.resolvePollTimer != null) return;
      this.resolvePollTimer = setInterval(() => {
        const rs = this.resolvingSession;
        if (!rs) return;
        fetch(`/api/sessions/${rs.sessionId}/status`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data && data.resolving === false && this.resolvingSession === rs) {
              this.endResolving('noop');
            }
          })
          .catch(() => {});
      }, this.RESOLVE_POLL_MS);
    },

    stopResolvePolling() {
      if (this.resolvePollTimer != null) {
        clearInterval(this.resolvePollTimer);
        this.resolvePollTimer = null;
      }
    },

    // 5-minute hard ceiling, mirroring the updating banner's stuck
    // timer — but the failure mode here is benign (no write block), so
    // on fire we just dismiss quietly instead of going red.
    armResolveStuckTimer() {
      this.disarmResolveStuckTimer();
      const since = this.resolvingSession?.since || Date.now();
      const remaining = Math.max(0, this.STUCK_AFTER_MS - (Date.now() - since));
      this.resolveStuckTimer = setTimeout(() => {
        if (this.resolvingSession) this.endResolving('noop');
      }, remaining);
    },

    disarmResolveStuckTimer() {
      if (this.resolveStuckTimer != null) {
        clearTimeout(this.resolveStuckTimer);
        this.resolveStuckTimer = null;
      }
    },

    // Shared amber/red class swap for all banner variants. Swapping
    // classes rather than re-rendering keeps the spinner animation
    // uninterrupted when a variant flips mid-flight.
    _setBannerTone(tone) {
      const el = document.getElementById('platform-updating-banner');
      if (!el) return;
      const amber = ['bg-amber-100', 'text-amber-900', 'border-amber-300',
        'dark:bg-amber-900/40', 'dark:text-amber-100', 'dark:border-amber-800/60'];
      const red = ['bg-red-100', 'text-red-900', 'border-red-300',
        'dark:bg-red-900/40', 'dark:text-red-100', 'dark:border-red-800/60'];
      el.classList.remove(...(tone === 'red' ? amber : red));
      el.classList.add(...(tone === 'red' ? red : amber));
    },

    end({ newSha } = {}) {
      console.log('[platform-updating] dismissing', { fromSha: this.fromSha, newSha });
      try { sessionStorage.removeItem(this.SS_KEY); } catch {}
      this.fromSha = null;
      this.since = null;
      this.stopFastPolling();
      this.disarmStuckTimer();
      this.hide();
      // Hard reload: the new server may ship new client code, so
      // reusing the in-memory App / AppView / Home from the pre-restart
      // SHA against a freshly-deployed backend is exactly the version-
      // skew minefield the rest of this codebase tries to avoid (see
      // the 'stale' pill in renderPlatformVersionPill — same design,
      // different trigger). loadedPlatformSha is updated by the next
      // load anyway, so a soft refresh + version-pill flip would also
      // work, but reload is simpler and unambiguous.
      try { location.reload(); } catch {}
    },

    show(stuck) {
      const el = document.getElementById('platform-updating-banner');
      if (!el) return;
      this._clearResolveFailedTimer();
      el.classList.remove('hidden');
      const reload = document.getElementById('platform-updating-reload');
      const text = document.getElementById('platform-updating-text');
      const spinner = document.getElementById('platform-updating-spinner');
      const dismiss = document.getElementById('platform-updating-dismiss');
      if (dismiss) dismiss.classList.add('hidden');
      if (stuck) {
        // Swap to the red "stuck" variant (class swap keeps the
        // animation uninterrupted if we flip mid-flight, e.g. on
        // session-storage restore for a tab backgrounded >5 min).
        this._setBannerTone('red');
        if (text) text.textContent = 'Platform update is taking longer than expected. You can reload manually.';
        if (spinner) spinner.classList.add('hidden');
        if (reload) reload.classList.remove('hidden');
      } else {
        this._setBannerTone('amber');
        if (text) text.textContent = 'Platform updating… sit tight, write actions are paused.';
        if (spinner) spinner.classList.remove('hidden');
        if (reload) reload.classList.add('hidden');
      }
    },

    hide() {
      const el = document.getElementById('platform-updating-banner');
      if (el) el.classList.add('hidden');
    },

    startFastPolling() {
      if (this.fastPollTimer != null) return;
      this.fastPollTimer = setInterval(() => App.loadVersion(), this.POLL_FAST_MS);
    },

    stopFastPolling() {
      if (this.fastPollTimer != null) {
        clearInterval(this.fastPollTimer);
        this.fastPollTimer = null;
      }
    },

    armStuckTimer() {
      this.disarmStuckTimer();
      const remaining = Math.max(0, this.STUCK_AFTER_MS - (Date.now() - this.since));
      this.stuckTimer = setTimeout(() => {
        if (this.isActive()) this.show(/* stuck */ true);
      }, remaining);
    },

    disarmStuckTimer() {
      if (this.stuckTimer != null) {
        clearTimeout(this.stuckTimer);
        this.stuckTimer = null;
      }
    },

    // Wraps window.fetch to reject any non-GET (write) request while
    // the banner is up. This is the actual block — the banner itself
    // is purely a signal. GETs flow through unchanged so /api/version
    // polling, the global events WS reconnect path, and any other
    // read-only chrome can keep running.
    //
    // Idempotent: only installs once even if init() runs twice
    // (defensive — DOMContentLoaded should fire exactly once but we
    // don't want to double-wrap if a future flow triggers re-init).
    installFetchWrap() {
      if (this.fetchWrapInstalled) return;
      this.fetchWrapInstalled = true;
      const orig = window.fetch.bind(window);
      const self = this;
      window.fetch = function (resource, init) {
        const method = (init && init.method ? String(init.method) : 'GET').toUpperCase();
        if (self.isActive() && method !== 'GET' && method !== 'HEAD') {
          return Promise.reject(new Error('Platform is updating — write actions paused. Try again in a few seconds.'));
        }
        return orig(resource, init);
      };
    },
  },

  // Per-app redeploy WS handler. Flips affected pills into / out of
  // the yellow + spinner state. Reacts to BOTH the start broadcast
  // (deploying:true → render the deploying pill) and the end
  // broadcast (deploying:false → re-fetch the version so the new
  // SHA shows up). The server emits these from staging.js around
  // every rebuildProduction call, so all entry paths (dev-chat
  // merge, drift poller, manual check-updates) are covered.
  handleAppRedeployStatus(data) {
    if (!data || !data.appSlug) return;
    const slug = data.appSlug;
    const deployProgress = data.deploying
      ? { deploying: true, startedAt: data.startedAt, fromSha: data.fromSha || null }
      : null;

    // NOTE: `AppView` / `Home` are top-level `const` from classic
    // <script>s — they live in the shared script-global lexical env
    // but are NOT properties of `window`, so `window.AppView` would
    // silently short-circuit to false. Use `typeof` instead.
    if (typeof AppView !== 'undefined' && AppView.appData?.slug === slug) {
      if (data.deploying) {
        AppView.applyHeaderDeployProgress(deployProgress);
      } else {
        // Deploy ended — re-pull /api/apps/:slug/version to pick up
        // the new SHA. The trailing `app_version_changed` broadcast
        // (if a SHA actually changed) would also trigger this, but
        // refetching here covers the failure case where the deploy
        // ended without changing the SHA.
        AppView.refreshVersionPill();
      }
    }

    // Home-screen card pill (only if the home screen is visible).
    const homeVisible = document.getElementById('home-screen')
      && !document.getElementById('home-screen').classList.contains('hidden');
    if (homeVisible && typeof Home !== 'undefined') {
      if (data.deploying) {
        // We don't have the row's `version` data on hand here, but
        // the deploying pill hides the SHA anyway, so passing null
        // is correct.
        Home.updateAppCardPill(slug, { deployProgress, version: null });
      } else {
        // Deploy ended — full reload picks up the new version row
        // from /api/apps. Cheap (one query) and avoids manually
        // splicing the new SHA into a single card.
        Home.load();
      }
    }
  },

  eventsWs: null,
  // Shell-injected staging iframe token, captured at script load so SPA
  // history rewrites can't lose it before a (re)connect needs it.
  _bootToken: new URLSearchParams(location.search).get('token'),
  // Set on the very first connect; on every subsequent (re)connect we
  // resync state because the server's broadcast model is fire-and-forget
  // — anything pushed during the disconnect window (a `vote_update
  // merged:true` from a long-running merge, an `app_status` flip, etc.)
  // would otherwise be silently lost. Resync = re-pull whatever the
  // current view depends on; cheap, and it self-bounds to "exactly when
  // we know we might have missed something" rather than a periodic poll.
  _eventsWsHasConnected: false,

  connectEvents() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Same staging-iframe token fallback as GroupChat._openSocket — the
    // session cookie can be orphaned by a staging redeploy, and the WS
    // handshake can't re-mint it the way HTTP requests do. Prefer the
    // live URL, fall back to the boot-time capture (SPA history rewrites
    // may have stripped the query by now).
    const token = new URLSearchParams(location.search).get('token') || App._bootToken;
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    App.eventsWs = new WebSocket(`${proto}//${location.host}/ws/events${qs}`);

    App.eventsWs.onopen = () => {
      const isReconnect = App._eventsWsHasConnected;
      App._eventsWsHasConnected = true;
      console.log(`[ws] Global events ${isReconnect ? 'reconnected' : 'connected'}`);
      if (isReconnect) App.resyncCurrentView();
    };

    App.eventsWs.onerror = (err) => {
      console.warn('[ws] Global events error', err);
    };

    App.eventsWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'app_status':
            App.handleAppStatusUpdate(data);
            break;
          case 'session_update':
            App.handleSessionUpdate(data);
            break;
          case 'vote_update':
            App.handleVoteUpdate(data);
            break;
          case 'kudos_update':
            // Kudos count changed for some PR — bump cached state +
            // any visible buttons + the leaderboard if open. Delegated
            // to Kudos so app.js stays thin.
            if (window.Kudos) Kudos.applyLiveUpdate(data);
            break;
          case 'session_event':
            App.handleSessionEvent(data);
            break;
          case 'app_update':
            App.handleAppUpdate(data);
            break;
          case 'issue_update':
            App.handleIssueUpdate(data);
            break;
          case 'notification_new':
            if (window.Notifications) Notifications.handleIncoming(data.notification);
            // A mention/reply/reaction may have arrived for a message in
            // the currently-open chat — reconcile its unread dot.
            window.GroupChat?.reconcileDotsFromNotifications?.();
            break;
          case 'notifications_changed':
            // Server cleared/changed this user's notifications elsewhere
            // (e.g. another tab cast a vote and the PR nudge was dismissed,
            // or this user sent a chat message and reply-clears-all fired).
            // Re-pull so this tab's badge + list stay in sync, then
            // reconcile the in-chat unread dots from the fresh list.
            if (window.Notifications) {
              const r = Notifications.refresh?.();
              if (r && typeof r.then === 'function') {
                r.then(() => window.GroupChat?.reconcileDotsFromNotifications?.());
              } else {
                window.GroupChat?.reconcileDotsFromNotifications?.();
              }
            }
            break;
          case 'app_version_changed':
            // #21: a PR just merged and prod was rebuilt. If the user
            // is currently on this app's App tab, refresh the commit
            // pill in place so they see the new SHA without reloading.
            if (typeof AppView !== 'undefined' && AppView.appData?.slug === data.appSlug) {
              AppView.refreshVersionPill();
            }
            // Home screen: re-pull the apps list so the home-screen
            // pill picks up the new SHA. Cheap; only fires on a real
            // version change.
            if (typeof Home !== 'undefined' && document.getElementById('home-screen')
                && !document.getElementById('home-screen').classList.contains('hidden')) {
              Home.load();
            }
            break;
          case 'app_redeploy_status':
            // Per-app rebuild started/ended. Flip both the header
            // pill (if this app is open) and the home-screen card
            // pill (if visible) into / out of the yellow + spinner
            // state immediately, no extra server round-trip.
            App.handleAppRedeployStatus(data);
            break;
        }
      } catch {}
    };

    App.eventsWs.onclose = () => {
      setTimeout(() => App.connectEvents(), 3000);
    };
  },

  // Pull fresh state for whatever the user is currently looking at.
  // Called on WS reconnect (and could also be wired to visibilitychange
  // for tabs that come back from being backgrounded). Each branch maps
  // to a corresponding `case` in onmessage — the rule is simply "if a
  // WS event would have driven this view, refetch the same data here."
  resyncCurrentView() {
    // `Home` and `AppView` are classic-script top-level `const` — they
    // live in the script-global lexical env but are NOT on `window`,
    // so `window.Home` / `window.AppView` would silently be undefined.
    // `Notifications` is explicitly assigned to `window` in
    // notifications.js, so that one is fine.
    if (typeof Home !== 'undefined' && document.getElementById('home-screen') && !document.getElementById('home-screen').classList.contains('hidden')) {
      Home.load();
    }
    if (window.Notifications) Notifications.refresh?.();
    App.loadVersion();
    if (App.currentApp && typeof AppView !== 'undefined' && AppView.appData) {
      AppView.refreshVersionPill();
      // Re-fetch tab-specific state. We don't blow away the DOM —
      // these helpers update in place — so scroll positions, drafts,
      // etc. survive the resync.
      if (App.currentTab === 'dev') {
        AppView.refreshDevData('all');
      } else if (App.currentTab === 'app') {
        AppView.refreshToken?.();
      }
    }
  },

  handleAppStatusUpdate(data) {
    // Update home screen card if visible
    const card = document.querySelector(`.app-card[data-slug="${data.slug}"]`);
    if (card) {
      const dot = card.querySelector('.status-dot');
      if (dot) {
        dot.className = `status-dot ${data.status}`;
      }
      if (data.status === 'running') {
        Home.load();
      }
    }

    // Update app view if we're looking at this app
    if (App.currentApp === data.slug && App.currentTab === 'app') {
      if (data.status === 'running' && AppView.appData) {
        AppView.appData.status = 'running';
        AppView.appData.url = data.url;
        // The Share drawer row was hidden in openApp() because the app
        // wasn't running yet. Now that we have a URL, surface it.
        const drawerShareRow = document.getElementById('drawer-row-share');
        if (drawerShareRow) drawerShareRow.classList.remove('hidden');
        AppView.refreshToken().then(() => {
          // Re-check the tab — the user may have switched to group/dev
          // chat while refreshToken() was in flight. Without this guard
          // the button gets re-shown on tabs that have no iframe.
          if (App.currentApp !== data.slug || App.currentTab !== 'app') return;
          AppView.renderAppTab();
          if (window.DevConsole) DevConsole.setButtonVisible(true);
        });
      }
    }
  },

  handleSessionUpdate(data) {
    // #8: behind_main updates patch the dev-chat banner in place
    // without disturbing the surrounding chat view. We dispatch
    // before the broader re-render branches because behind_main
    // events are scoped per-session and don't need a session-list
    // refetch.
    if (data.action === 'behind_main' && typeof data.behindMain === 'number') {
      if (typeof DevChat !== 'undefined' && DevChat.applyBehindMainUpdate) {
        DevChat.applyBehindMainUpdate(data.sessionId, data.behindMain);
      }
      return;
    }
    // Refresh session list if we're on the Sessions sub-tab for this app
    if (App.currentApp === data.appSlug && App.currentTab === 'dev'
        && App.currentSubTab === 'sessions') {
      if (AppView.appData) {
        DevChat.loadSessions(AppView.appData.slug).then(() => {
          if (!DevChat.currentSession) DevChat.renderSessionList();
        });
      }
    }
    // Refresh proposals / inline chat vote state on the other dev sub-tabs
    if (App.currentApp === data.appSlug && App.currentTab === 'dev'
        && App.currentSubTab !== 'sessions') {
      AppView.refreshDevData('session');
    }
    // Home screen's "Your proposals" strip tracks session status changes.
    App.refreshHomeProposals();
  },

  handleSessionEvent(data) {
    console.log('[ws] session_event', data.event, data.sessionId, data._seq);
    if (!DevChat.currentSession || DevChat.currentSession.id !== data.sessionId) return;
    // Dedup by sequence number
    if (data._seq && DevChat._seenSeqs?.has(data._seq)) return;
    if (data._seq) {
      if (!DevChat._seenSeqs) DevChat._seenSeqs = new Set();
      DevChat._seenSeqs.add(data._seq);
      DevChat._lastSeenSeq = data._seq;
    }

    switch (data.event) {
      case 'status':
        DevChat._deactivateLastStatus();
        DevChat.messages.push({ role: 'system', content: data.text, ccOutput: data.ccOutput, ccSummary: data.ccSummary, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2,8), _active: true });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
      case 'staging_ready':
        DevChat._deactivateLastStatus();
        DevChat.messages.push({ role: 'system', content: 'Staging deployed!', stagingUrl: data.url, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2,8) });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        if (data.url) {
          DevChat.currentSession.staging_url = data.url;
          // #127: testing guidance rides along with the rebuild broadcast.
          if ('testingMd' in data) DevChat.currentSession.testing_md = data.testingMd;
          if ('testingPath' in data) DevChat.currentSession.testing_path = data.testingPath;
        }
        break;
      case 'staging_failed':
        DevChat._deactivateLastStatus();
        DevChat.messages.push({
          role: 'system',
          content: `Staging build failed: ${data.error || 'unknown error'}`,
          stagingFailed: true,
          stagingErrorName: data.errorName || 'Error',
          stagingMissingKeys: data.missingKeys || [],
          created_at: new Date().toISOString(),
          _slug: Math.random().toString(36).slice(2,8),
        });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
      case 'pr_created':
      case 'pr_updated':
        if (DevChat.currentSession) {
          if (data.prNumber) DevChat.currentSession.pr_number = data.prNumber;
          if (data.prUrl) DevChat.currentSession.pr_url = data.prUrl;
          if (data.prTitle) {
            DevChat.currentSession.pr_title = data.prTitle;
            // #249: server mirrors pr_title into session_title.
            DevChat.currentSession.session_title = data.prTitle;
          }
          if (typeof DevChat.renderChatView === 'function') DevChat.renderChatView();
        }
        break;
      case 'session_titled':
        // #249: pre-PR display name landed — refresh header/session UI.
        if (DevChat.currentSession && data.sessionTitle) {
          DevChat.currentSession.session_title = data.sessionTitle;
          if (typeof DevChat.renderChatView === 'function') DevChat.renderChatView();
        }
        break;
      case 'visuals_ready':
        // #195: before/after capture finished (it lands after
        // staging_ready, often after the turn's POST SSE is gone) —
        // stash the artifact ids and re-render so the staging card
        // upgrades in place with the media tiles.
        if (DevChat.currentSession && data.visuals) {
          DevChat.currentSession.visuals = data.visuals;
          DevChat.renderMessages();
        }
        break;
      case 'cc_progress':
        DevChat._appendProgressLine(data.text);
        DevChat.scrollToBottom();
        // Also arm the /status polling fallback when cc_progress arrives via
        // WS (e.g. the SSE POST itself died before getting here). Without
        // this, a WS reconnect in the middle of the run could lose every
        // subsequent event and leave the UI stuck with a spinning send
        // button and stale progress.
        if (!DevChat._progressPollTimer && DevChat.isStreaming) {
          DevChat._startProgressPolling(data.sessionId, []);
        }
        break;
      case 'done':
        DevChat._deactivateLastStatus();
        DevChat._finishStreaming();
        DevChat.renderMessages();
        break;
      case 'spec_updated':
        // Mayor's dispatch_scout updated the live draft.
        // The accompanying status event already pushed an inline preview
        // card into the chat timeline; we just keep an open spec viewer
        // in sync if the user happens to be looking at the live draft.
        if (typeof DevChat._handleSpecUpdated === 'function') {
          DevChat._handleSpecUpdated(data);
        }
        break;
    }
  },

  handleAppUpdate(data) {
    if (data.action === 'renamed') {
      // Update home card (if visible) and header (if we're on this app).
      const card = document.querySelector(`.app-card[data-slug="${data.slug}"]`);
      if (card) {
        const nameEl = card.querySelector('.font-medium');
        if (nameEl) nameEl.textContent = data.newName;
        const avatar = card.querySelector('div.rounded-xl');
        if (avatar) avatar.textContent = (data.newName || '?').charAt(0).toUpperCase();
      }
      if (App.currentApp === data.slug) {
        App.setHeaderTitle(data.newName);
        if (typeof AppView !== 'undefined' && AppView.applyRename) {
          AppView.applyRename(data.newName);
        }
      }
    } else if (data.action === 'lock_changed') {
      // The admin-gated change lock flipped on this app (see
      // POST /api/apps/:slug/lock in routes/apps.js). Refresh the
      // home-card icon and, if the user is currently looking at this
      // app's group chat, refresh the vote panel so the "(locked —
      // also needs an admin yes)" hint appears or disappears in step.
      if (typeof Home !== 'undefined' && Home.updateAppCardLock) {
        Home.updateAppCardLock(data.appSlug, data.locked);
      }
      if (App.currentApp === data.appSlug
          && App.currentTab === 'dev'
          && typeof AppView !== 'undefined' && AppView.refreshDevData) {
        AppView.refreshDevData('lock');
      }
    } else if (data.action === 'visibility_changed') {
      // Visibility flipped (a merged visibility PR's deploy-time
      // reconcile — see services/app-manifest.js). Reload the home grid
      // so badges update and newly-private apps drop out for outsiders;
      // patch the open app's in-memory row so the Members modal and tab
      // gating see the fresh values, and re-render the modal's pills if
      // it's open right now.
      const homeScreen = document.getElementById('home-screen');
      if (typeof Home !== 'undefined' && homeScreen && !homeScreen.classList.contains('hidden')) {
        Home.load();
      }
      if (App.currentApp === data.appSlug
          && typeof AppView !== 'undefined' && AppView.appData) {
        AppView.appData.collab_visibility = data.collabVisibility;
        AppView.appData.view_visibility = data.viewVisibility;
        const membersModal = document.getElementById('members-modal');
        if (membersModal && !membersModal.classList.contains('hidden')
            && AppView._renderMembersVisPills) {
          AppView._membersVis = { collab: data.collabVisibility, view: data.viewVisibility };
          AppView._renderMembersVisPills();
        }
      }
    }
  },

  // Refresh the relevant dev sub-tab when another user creates, votes on,
  // or closes an issue / governance proposal so everyone sees it live.
  handleIssueUpdate(data) {
    if (App.currentApp === data.appSlug && App.currentTab === 'dev') {
      AppView.refreshDevData('issue');
    }
  },

  // Re-render the home screen's "Your proposals" strip (and the rest of
  // the grid — Home.load is cheap and already the live-update pattern)
  // when a vote/session event lands while the home screen is visible.
  refreshHomeProposals() {
    const homeScreen = document.getElementById('home-screen');
    if (typeof Home !== 'undefined' && homeScreen && !homeScreen.classList.contains('hidden')) {
      Home.load();
    }
  },

  handleVoteUpdate(data) {
    // Phase 3 trigger: when a self-hosted PR transitions promoted →
    // merging, latch the "Platform updating…" banner. The dismissal
    // (SHA flip on /api/version) happens via App.loadVersion's poll
    // loop. Fires before the panel refresh so all open tabs (including
    // ones not currently looking at this app) latch into the state.
    if (data.merging && data.selfHosted) {
      App.PlatformUpdating.begin({
        appSlug: data.appSlug,
        sessionId: data.sessionId,
      });
    }
    // Counter-event: the self-app merge failed before any deploy, so no
    // SHA flip is coming — unlatch instead of holding the platform
    // read-only until the stuck timer. #239: when the auto-resolver is
    // kicking in (resolving:true rides on the mergeFailed event for
    // conflict-class failures), immediately re-arm in the non-blocking
    // resolving state so the banner transitions in place instead of
    // silently vanishing while the resolver spends 1–2 min on the fix.
    if (data.mergeFailed && data.selfHosted) {
      App.PlatformUpdating.cancel();
      if (data.resolving) {
        App.PlatformUpdating.beginResolving({
          sessionId: data.sessionId,
          appSlug: data.appSlug,
        });
      }
    }
    // #239 resolver start broadcast — covers resolutions that never
    // armed a banner (behind-main pre-gate, drift poller, post-merge
    // sweep) and doubles as a late confirm for the mergeFailed path
    // above (beginResolving is idempotent). No cancel() here: a bare
    // start event must not kill an updating banner that's legitimately
    // active for a different, already-merged PR's deploy.
    if (data.resolving === true && data.selfHosted && !data.mergeFailed) {
      App.PlatformUpdating.beginResolving({
        sessionId: data.sessionId,
        appSlug: data.appSlug,
      });
    }
    // Terminal event: the resolver finished (merged / synced / failed /
    // noop). endResolving ignores it unless the sessionId matches the
    // tracked resolve — and is a no-op once begin() has upgraded the
    // banner to full updating mode on the merged path.
    if (data.resolving === false) {
      App.PlatformUpdating.endResolving(data.resolutionOutcome, data.sessionId);
    }
    // Refresh the proposals tab / inline chat vote state if we're in
    // this app's Dev view.
    if (App.currentApp === data.appSlug && App.currentTab === 'dev') {
      AppView.refreshDevData('vote');
    }
    // Home screen's "Your proposals" strip tracks tallies live.
    App.refreshHomeProposals();
    // If merged, refresh the app view
    if (data.merged && App.currentApp === data.appSlug) {
      if (App.currentTab === 'app') {
        AppView.renderAppTab();
      }
      Home.load();
    }
  },

  // Slide-out navigation drawer — available at every viewport width
  // (#122). Holds the secondary header actions: GitHub, Share,
  // Members & visibility, Settings.
  HeaderMenu: {
    open() {
      const panel = document.getElementById('header-menu-panel');
      const overlay = document.getElementById('header-menu-overlay');
      const btn = document.getElementById('header-menu-btn');
      if (!panel) return;
      overlay.classList.remove('hidden');
      // Force a reflow so the transition fires (element was display:none).
      overlay.getBoundingClientRect();
      overlay.setAttribute('data-open', '');
      panel.setAttribute('data-open', '');
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-label', 'Close menu');
      const closeBtn = document.getElementById('header-menu-close');
      if (closeBtn) closeBtn.focus();
    },
    close() {
      const panel = document.getElementById('header-menu-panel');
      const overlay = document.getElementById('header-menu-overlay');
      const btn = document.getElementById('header-menu-btn');
      if (!panel) return;
      panel.removeAttribute('data-open');
      overlay.removeAttribute('data-open');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', 'Open menu');
      // Hide overlay after the slide-out transition finishes.
      setTimeout(() => overlay.classList.add('hidden'), 200);
    },
    init() {
      const btn = document.getElementById('header-menu-btn');
      if (!btn) return;
      btn.addEventListener('click', () => App.HeaderMenu.open());
      document.getElementById('header-menu-close')
        .addEventListener('click', () => App.HeaderMenu.close());
      document.getElementById('header-menu-overlay')
        .addEventListener('click', () => App.HeaderMenu.close());
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          const panel = document.getElementById('header-menu-panel');
          if (panel && panel.hasAttribute('data-open')) App.HeaderMenu.close();
        }
      });
      // Drawer row actions — each closes the menu after triggering its action.
      document.getElementById('drawer-row-github')
        .addEventListener('click', () => App.HeaderMenu.close());
      document.getElementById('drawer-row-share')
        .addEventListener('click', () => {
          App.HeaderMenu.close();
          if (window.AppView) AppView.openShareModal();
        });
      document.getElementById('drawer-row-members')
        .addEventListener('click', () => {
          App.HeaderMenu.close();
          if (window.AppView) AppView.openMembersModal();
        });
      document.getElementById('drawer-row-settings')
        .addEventListener('click', () => {
          App.HeaderMenu.close();
          if (window.Settings) Settings.open();
        });
    },
  },

  bindEvents() {
    // Note: the "Create new app" entry point lives in the home feed
    // now (see Home.wireCreateButtons) — no static header button to
    // bind here anymore.
    App.HeaderMenu.init();
    document.getElementById('create-cancel').addEventListener('click', App.hideCreateModal);
    document.getElementById('create-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget || e.target.dataset.modalBackdrop !== undefined) App.hideCreateModal();
    });
    document.getElementById('create-form').addEventListener('submit', App.handleCreateApp);

    // Create / Import mode pills. The active mode lives on
    // #create-modal[data-mode="..."] (CSS keys off it for styling); these
    // handlers also flip the submit-button label and the URL block.
    document.querySelectorAll('.create-mode-pill').forEach((pill) => {
      pill.addEventListener('click', () => App.setCreateMode(pill.dataset.modePill));
    });

    // Visibility pills (Who can build / Who can see & use). Two
    // independent segmented controls; collab=public forces view=public
    // (invariant: a publicly-buildable app can't be privately viewed).
    document.querySelectorAll('#create-visibility-block [data-collab-vis]').forEach((pill) => {
      pill.addEventListener('click', () => App.setCreateVisibility('collab', pill.dataset.collabVis));
    });
    document.querySelectorAll('#create-visibility-block [data-view-vis]').forEach((pill) => {
      pill.addEventListener('click', () => App.setCreateVisibility('view', pill.dataset.viewVis));
    });
    App.setCreateVisibility('collab', 'public');

    // Members & visibility modal (close/backdrop; the open entry point
    // is the drawer's Members row, wired in HeaderMenu.init).
    const membersClose = document.getElementById('members-close');
    if (membersClose) membersClose.addEventListener('click', () => AppView.hideMembersModal());
    const membersModal = document.getElementById('members-modal');
    if (membersModal) membersModal.addEventListener('click', (e) => {
      if (e.target === e.currentTarget || e.target.dataset.modalBackdrop !== undefined) {
        AppView.hideMembersModal();
      }
    });

    // Import flow: explicit "Check" button.
    //
    //   idle ─┬─ Check click ─→ checking ─┬─ ok    (name field reveals,
    //         │                           │        prefilled, Import enables)
    //         │                           └─ error (inline message, retry)
    //         └─ user edits URL after a successful check → back to idle
    //
    // Why explicit Check and not debounced auto-check? Two reasons:
    // (1) "I just invited the bot, click here" is a clear action that
    //     pairs with the inline error text from the server, vs. a
    //     debounced surprise; (2) verifyBotAccess can mutate state by
    //     accepting a pending invitation, and we don't want that firing
    //     on every keystroke.
    const checkBtn = document.getElementById('import-check');
    const importInput = document.getElementById('import-url');
    if (checkBtn) checkBtn.addEventListener('click', App.handleImportCheck);
    if (importInput) {
      importInput.addEventListener('input', () => {
        // Any edit invalidates the previous check; the user must click
        // again. Without this, the user could verify repo A, edit the
        // URL to point at repo B, then submit — the route's own
        // pre-flight catches it, but the UI shouldn't claim "verified"
        // for a URL that hasn't been verified.
        if (App._setImportState) App._setImportState('idle');
      });
    }
    // The header button shows a HOUSE icon and that's what users read
    // it as: "go to home", not "go back one step". So clicking it
    // navigates straight to the home screen, skipping any
    // intermediate tabs/sessions in the history stack.
    //
    // Step-by-step back is still available — it lives on the
    // device/system back button (Flutter delegates to
    // `WebViewController.canGoBack()`, which reads the same browser
    // history this app pushes via updateHash()) and on the browser
    // back arrow on desktop. Both route through the popstate handler
    // installed in init(), which calls restoreFromHash() to rebuild
    // state from the previous URL.
    document.getElementById('back-btn').addEventListener('click', () => App.navigateHome());

    // Rename modal
    const renameModal = document.getElementById('rename-modal');
    if (renameModal) {
      document.getElementById('rename-cancel').addEventListener('click', AppView.closeRenameModal);
      renameModal.addEventListener('click', (e) => {
        if (e.target === e.currentTarget || e.target.dataset.modalBackdrop !== undefined) AppView.closeRenameModal();
      });
      document.getElementById('rename-form').addEventListener('submit', AppView.submitRename);
    }

    // Feedback
    const feedbackText = document.getElementById('feedback-text');
    const feedbackBtn = document.getElementById('feedback-submit');
    const feedbackStatus = document.getElementById('feedback-status');
    const feedbackTargetApp = document.getElementById('feedback-target-app');
    const feedbackTargetPlatform = document.getElementById('feedback-target-platform');
    const feedbackCaretApp = document.getElementById('feedback-caret-app');
    const feedbackCaretPlatform = document.getElementById('feedback-caret-platform');

    // Currently selected feedback target ('app' or 'platform'). The
    // "This app" button is only enabled when an app with a repo is open,
    // so this stays 'platform' on home/leaderboard. Reset on each open.
    let feedbackTarget = 'platform';
    // The selected option uses a darker violet on hover so it keeps its
    // active look; the unselected option uses the neutral zinc hover.
    const activeTargetClasses = ['bg-violet-600', 'text-white', 'border-violet-600', 'hover:bg-violet-500'];
    const inactiveHoverClasses = ['hover:bg-zinc-100', 'dark:hover:bg-zinc-800'];
    const disabledTargetClasses = ['opacity-40', 'cursor-not-allowed'];
    // Toggle the active styling between the two buttons. Enabled/disabled
    // state of the "This app" button is owned by the open handler.
    const setFeedbackTarget = (target) => {
      feedbackTarget = target;
      const onApp = target === 'app';
      feedbackTargetApp.setAttribute('aria-checked', onApp ? 'true' : 'false');
      feedbackTargetPlatform.setAttribute('aria-checked', onApp ? 'false' : 'true');
      activeTargetClasses.forEach((c) => {
        feedbackTargetApp.classList.toggle(c, onApp);
        feedbackTargetPlatform.classList.toggle(c, !onApp);
      });
      // The neutral hover only applies to the unselected option, so the
      // selected one doesn't get its violet overridden on hover.
      inactiveHoverClasses.forEach((c) => {
        feedbackTargetApp.classList.toggle(c, !onApp);
        feedbackTargetPlatform.classList.toggle(c, onApp);
      });
      // Move the caret under the selected option.
      feedbackCaretApp.classList.toggle('hidden', !onApp);
      feedbackCaretPlatform.classList.toggle('hidden', onApp);
    };
    // Enable or gray-out the "This app" option. When disabled it stays
    // visible (so users see both choices) but isn't clickable/selectable.
    const setAppTargetEnabled = (enabled) => {
      feedbackTargetApp.disabled = !enabled;
      feedbackTargetApp.setAttribute('aria-disabled', enabled ? 'false' : 'true');
      disabledTargetClasses.forEach((c) => feedbackTargetApp.classList.toggle(c, !enabled));
    };
    feedbackTargetApp.addEventListener('click', () => {
      if (!feedbackTargetApp.disabled) setFeedbackTarget('app');
    });
    feedbackTargetPlatform.addEventListener('click', () => setFeedbackTarget('platform'));

    const submitFeedback = async () => {
      const text = feedbackText.value.trim();
      if (!text) return;
      // Guard against double-submit while the request is in flight, and
      // also against submits after success (the textarea is disabled
      // then, but a stale cmd+enter on a focused button could still
      // land here).
      if (feedbackBtn.disabled) return;
      feedbackBtn.disabled = true; feedbackBtn.textContent = 'Submitting...';
      try {
        // Capture the target + slug at submit time so navigating away
        // while the modal is open can't retarget an in-flight request.
        const target = feedbackTarget;
        const body = { description: text, target };
        if (target === 'app') body.appSlug = App.currentApp;
        const res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (res.ok) {
          feedbackStatus.textContent = target === 'app'
            ? `Thanks! Filed against ${AppView?.appData?.name || 'this app'}.`
            : 'Thanks! Filed against Social Vibecoding.';
          feedbackStatus.className = 'text-sm mt-2 text-emerald-400';
          feedbackStatus.classList.remove('hidden');
          feedbackText.value = '';
          // Lock the textarea and keep the submit button disabled for
          // the 1500ms "Thanks!" grace window so a user can't keep
          // typing (or re-fire cmd+enter) after their feedback has
          // already been filed — fixes #32. Both controls are
          // re-enabled when the modal is reopened below.
          feedbackText.disabled = true;
          feedbackBtn.textContent = 'Submitted';
          // #125: make the new issue show up in this app's "Open Issues"
          // panel without a reload. The server seeds its issues cache and
          // broadcasts an issue_update (handled in connectEvents) for
          // other clients; this direct refresh covers the submitting tab
          // even if its events socket is momentarily down. Platform-
          // targeted feedback lands in the self-hosted platform app's
          // issue list, so refresh that panel too when it's the one open.
          if (typeof AppView !== 'undefined' && App.currentTab === 'dev'
              && ((target === 'app' && body.appSlug && App.currentApp === body.appSlug)
                || (target === 'platform' && AppView?.appData?.self_hosted))) {
            AppView.refreshDevData('issue');
          }
          setTimeout(() => document.getElementById('feedback-cancel').click(), 1500);
          return;
        }
        feedbackStatus.textContent = data.error || 'Failed to submit';
        feedbackStatus.className = 'text-sm mt-2 text-red-400';
        feedbackStatus.classList.remove('hidden');
      } catch {
        feedbackStatus.textContent = 'Network error';
        feedbackStatus.className = 'text-sm mt-2 text-red-400';
        feedbackStatus.classList.remove('hidden');
      }
      feedbackBtn.disabled = false; feedbackBtn.textContent = 'Submit';
    };

    // Open the Send Feedback modal. Shared by the header feedback button
    // (no opts) and the dev view's plus-menu "New issue" item, which
    // passes { fromDev: true } — see issue #226.
    App.openFeedbackModal = (opts = {}) => {
      document.getElementById('feedback-modal').classList.remove('hidden');
      // Reset any "Submitted" lock from a prior session so a returning
      // user can file another piece of feedback without reloading.
      feedbackText.disabled = false;
      feedbackBtn.disabled = false; feedbackBtn.textContent = 'Submit';
      feedbackStatus.classList.add('hidden');

      // "This app" is only selectable when an app with a real repo is
      // open. Otherwise the button stays visible but grayed-out/disabled
      // so users can still see both choices, and we default to platform.
      const appData = (typeof AppView !== 'undefined' && AppView.appData) || null;
      const repoUrl = appData?.repo_url || '';
      const hasRepo = /github\.com\/[^/]+\/[^/]+/.test(repoUrl);
      // fromDev callers are by construction inside an open app's dev
      // view, so the header button's currentTab === 'app' gate doesn't
      // apply. The self-hosted platform app is excluded: targeting "this
      // app" would file into the same platform repo via a different
      // credential path and skip the usernode label, so we force the
      // Platform target instead.
      const canTargetApp = opts.fromDev
        ? !!appData && hasRepo && !appData.self_hosted
        : !!App.currentApp && App.currentTab === 'app' && hasRepo;
      if (canTargetApp) {
        feedbackTargetApp.textContent = appData?.name ? `This app (${appData.name})` : 'This app';
        setAppTargetEnabled(true);
        // Default to the app the user is looking at — most likely intent.
        setFeedbackTarget('app');
      } else {
        // With an app actually open (dev-view caller) keep its name on
        // the grayed label — "No app open" would be wrong there.
        feedbackTargetApp.textContent = (opts.fromDev && appData)
          ? (appData.name ? `This app (${appData.name})` : 'This app')
          : 'No app open';
        setAppTargetEnabled(false);
        setFeedbackTarget('platform');
      }

      feedbackText.focus();
    };
    document.getElementById('feedback-btn').addEventListener('click', () => App.openFeedbackModal());
    document.getElementById('feedback-cancel').addEventListener('click', () => {
      document.getElementById('feedback-modal').classList.add('hidden');
      feedbackText.value = '';
      feedbackText.disabled = false;
      feedbackBtn.disabled = false; feedbackBtn.textContent = 'Submit';
      feedbackStatus.classList.add('hidden');
    });
    document.getElementById('feedback-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget || e.target.dataset.modalBackdrop !== undefined) document.getElementById('feedback-cancel').click();
    });
    feedbackBtn.addEventListener('click', submitFeedback);
    // cmd+enter / ctrl+enter inside the textarea submits — fixes #34.
    // Textareas swallow Enter by default (it inserts a newline), so we
    // only intercept when the modifier key is held.
    feedbackText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitFeedback();
      }
    });

    // Share modal — opened from the drawer's Share row (wired in
    // HeaderMenu.init). The row's hidden state is managed in openApp /
    // navigateHome (and in handleAppStatus for the creating→running
    // flip), so we only wire the dismiss handlers here.
    const shareClose = document.getElementById('share-close');
    if (shareClose) shareClose.addEventListener('click', () => AppView.closeShareModal());
    const shareModal = document.getElementById('share-modal');
    if (shareModal) shareModal.addEventListener('click', (e) => {
      if (e.target === e.currentTarget || e.target.dataset.modalBackdrop !== undefined) AppView.closeShareModal();
    });
    const shareCopy = document.getElementById('share-copy-btn');
    if (shareCopy) shareCopy.addEventListener('click', () => AppView.copyShareUrl());

    document.querySelectorAll('.app-tab').forEach((btn) => {
      btn.addEventListener('click', () => App.switchTab(btn.dataset.tab));
    });

    // popstate fires on browser/device back when the new history
    // entry was created with pushState; hashchange fires when only the
    // fragment changes (initial load with a deep link, manual edits to
    // the URL bar). Both routes converge on restoreFromHash, which is
    // idempotent — re-applying the same hash is a no-op via the
    // currentApp/currentTab guards inside it.
    window.addEventListener('popstate', () => App.restoreFromHash());
    window.addEventListener('hashchange', () => App.restoreFromHash());
  },

  restoreFromHash() {
    App._isRestoring = true;
    try {
      const hash = location.hash.replace('#', '');
      if (!hash) {
        if (App.currentApp) App.navigateHome();
        else if (App._inLeaderboard) App.navigateHome();
        else {
          // Already on home (no app, no leaderboard). Don't call
          // navigateHome() — that would pushState, AppView.close(),
          // etc., none of which are appropriate when we're already
          // here. But we still want to ensure the page title is
          // correct, since this branch is reached on initial page
          // load and on any popstate/hashchange that resolves to "/".
          // Without this the title can be stuck on a previous app's
          // name if document.title was set elsewhere (e.g. a stale
          // value persisted across a Flutter WebView session).
          App.setHeaderTitle('dApps');
          Home.load();
        }
        return;
      }

      const parts = hash.split('/');
      if (parts[0] === 'leaderboard') {
        // Optional sub-view segment (#leaderboard/history etc.) — pass
        // it through so deep links land on the right tab. Bare
        // #leaderboard keeps whatever tab was last active (Top PRs on
        // first visit). A third segment on the users tab
        // (#leaderboard/users/<username>) deep-links a user profile
        // (#60).
        const profileUser = parts[1] === 'users' && parts[2]
          ? decodeURIComponent(parts[2])
          : null;
        App.navigateToLeaderboard(parts[1], profileUser);
        return;
      }
      if (parts[0] === 'app' && parts[1]) {
        const slug = parts[1];
        // Card-list hashes (#194 revision): app/{slug}/app,
        // app/{slug}/dev (the card list), app/{slug}/dev/chat (general
        // chat), app/{slug}/dev/issues/{n} / dev/proposals/{id} /
        // dev/governance/{id} (full-screen topic views),
        // app/{slug}/dev/sessions/{id} (session view), dev/settings.
        // Legacy hashes — group-chat, individual-chat[/{sessionId}], and
        // the old dev/chat|issues|proposals sub-tab forms — all map onto
        // the forum so old links and notification hrefs keep working.
        let tab = parts[2] || 'app';
        let subTab = null;
        let ref = null;
        if (tab === 'dev') {
          const sec = parts[3] || null;
          if (sec === 'sessions' && parts[4]) {
            subTab = 'sessions';
            ref = parseInt(parts[4]) || null;
          } else if (sec === 'chat') {
            // Full-screen general chat (also where legacy group-chat
            // links land — the old Chat sub-tab's original meaning).
            subTab = 'chat';
          } else if (sec === 'settings') {
            subTab = 'settings';
          } else if (sec === 'issues' && parts[4]) {
            subTab = 'topic';
            ref = { kind: 'issue', id: parseInt(parts[4]) || null };
          } else if (sec === 'proposals' && parts[4]) {
            subTab = 'topic';
            ref = { kind: 'proposal', id: parseInt(parts[4]) || null };
          } else if (sec === 'governance' && parts[4]) {
            subTab = 'topic';
            ref = { kind: 'gov', id: parseInt(parts[4]) || null };
          } else {
            // dev, dev/issues, dev/proposals, dev/sessions (no id) —
            // all land on the plain card list.
            subTab = 'forum';
          }
        } else if (tab === 'group-chat') {
          tab = 'dev'; subTab = 'chat';
        } else if (tab === 'individual-chat') {
          tab = 'dev';
          subTab = parts[3] ? 'sessions' : 'forum';
          ref = parts[3] ? parseInt(parts[3]) : null;
        } else {
          tab = 'app';
        }
        if (App._inLeaderboard) App._exitLeaderboard();
        if (App.currentApp !== slug) {
          App.navigateToApp(slug, tab, ref, subTab);
        } else if (App.currentTab !== tab
            || (tab === 'dev' && App.currentSubTab !== subTab)
            // Same tab + sub-tab but a (possibly different) deep-link
            // target — re-dispatch so the accordion / session moves.
            // switchTab is idempotent, so a same-target re-render is fine.
            || (tab === 'dev' && ref != null)) {
          App.switchTab(tab, ref, subTab);
        }
      } else {
        if (App._inLeaderboard) App._exitLeaderboard();
        App.setHeaderTitle('dApps');
        Home.load();
      }
    } finally {
      App._isRestoring = false;
    }
  },

  // Show the leaderboard screen. Sibling to navigateToApp/navigateHome —
  // hides home + app, reveals the dedicated #leaderboard-screen, lets
  // the Leaderboard module render itself into #leaderboard-root.
  // `profileUser` (#60) opens the per-user PR profile drill-in instead
  // of a plain tab.
  navigateToLeaderboard(sub, profileUser) {
    if (App.currentApp) {
      AppView.close();
      App.currentApp = null;
      document.getElementById('app-view').classList.add('hidden');
    }
    document.getElementById('home-screen').classList.add('hidden');
    const screen = document.getElementById('leaderboard-screen');
    if (screen) screen.classList.remove('hidden');
    document.getElementById('back-btn').classList.remove('hidden');
    const _drg = document.getElementById('drawer-row-github');
    const _drs = document.getElementById('drawer-row-share');
    const _drm = document.getElementById('drawer-row-members');
    if (_drg) _drg.classList.add('hidden');
    if (_drs) _drs.classList.add('hidden');
    if (_drm) _drm.classList.add('hidden');
    App.setHeaderTitle('Kudos leaderboard');
    App._inLeaderboard = true;
    // Apply the deep-linked sub-view (prs|users|history) or user
    // profile before open() renders — _setSub validates the value and
    // no-ops on garbage. openProfile must run INSTEAD of _setSub (not
    // after): _setSub clears profile state and would replaceState the
    // profile hash away. When the screen is already open they
    // re-render in place; open() below dedupes the in-flight load.
    if (profileUser && window.Leaderboard?.openProfile) {
      Leaderboard.openProfile(profileUser);
    } else if (sub && window.Leaderboard?._setSub) {
      Leaderboard._setSub(sub);
    }
    if (window.Leaderboard?.open) Leaderboard.open();
  },

  _exitLeaderboard() {
    App._inLeaderboard = false;
    const screen = document.getElementById('leaderboard-screen');
    if (screen) screen.classList.add('hidden');
    if (window.Leaderboard?.close) Leaderboard.close();
  },

  // Push a new history entry on real screen transitions (entering an
  // app, switching tabs, going home) so the WebView builds a real
  // back stack; replace in-place when only secondary state changes
  // within the same screen (e.g. selecting a different dev-chat
  // session inside the individual-chat tab) — otherwise every session
  // click would add an entry the user has to back through.
  //
  // "Screen" here = `#app/<slug>/<tab>` prefix; the optional 4th
  // segment (session id) is intentionally NOT part of the screen id.
  updateHash() {
    if (App._isRestoring) return;

    let newHash;
    if (App.currentApp) {
      if (App.currentTab === 'dev') {
        if (App.currentSubTab === 'sessions' && DevChat.currentSession) {
          newHash = `#app/${App.currentApp}/dev/sessions/${DevChat.currentSession.id}`;
        } else if (App.currentSubTab === 'chat') {
          newHash = `#app/${App.currentApp}/dev/chat`;
        } else if (App.currentSubTab === 'settings') {
          newHash = `#app/${App.currentApp}/dev/settings`;
        } else if (App.currentSubTab === 'topic'
            && typeof AppView !== 'undefined' && AppView._devTopic) {
          const t = AppView._devTopic;
          const seg = t.kind === 'issue' ? 'issues'
            : t.kind === 'proposal' ? 'proposals' : 'governance';
          newHash = `#app/${App.currentApp}/dev/${seg}/${t.id}`;
        } else {
          newHash = `#app/${App.currentApp}/dev`;
        }
      } else {
        newHash = `#app/${App.currentApp}/app`;
      }
    } else {
      // Home: drop the fragment entirely — but keep the query string. In
      // staging previews the shell-injected ?token= lives there, and the
      // WS connects re-read it as an auth fallback (see connectEvents /
      // GroupChat._openSocket).
      newHash = location.pathname + location.search;
    }

    const currentFull = location.hash || '';
    const targetFull = newHash.startsWith('#') ? newHash : '';
    if (currentFull === targetFull) return;

    // Screen ids: every full-screen sub-view (chat, settings, topics,
    // sessions) is its own screen — list ↔ sub-view pushes a history
    // entry, so device/browser back mirrors the in-page back buttons —
    // but which session/topic isn't part of the id (moving between two
    // topics of the same kind replaces in place).
    const SUB_SCREENS = new Set(['sessions', 'chat', 'settings', 'issues', 'proposals', 'governance']);
    const screenIdOf = (h) => {
      const segs = String(h || '').replace(/^#/, '').split('/');
      if (segs[0] === 'app' && segs[2] === 'dev') {
        return SUB_SCREENS.has(segs[3])
          ? segs.slice(0, 4).join('/')
          : segs.slice(0, 3).join('/');
      }
      return segs.slice(0, 3).join('/');
    };
    const sameScreen = screenIdOf(currentFull) === screenIdOf(targetFull);

    if (sameScreen) {
      history.replaceState(null, '', newHash);
    } else {
      history.pushState(null, '', newHash);
    }
  },

  showCreateModal() {
    App.setCreateMode('new');
    document.getElementById('create-modal').classList.remove('hidden');
    document.getElementById('app-name').focus();
  },

  hideCreateModal() {
    document.getElementById('create-modal').classList.add('hidden');
    document.getElementById('create-form').reset();
    document.getElementById('create-error').classList.add('hidden');
    App.setCreateMode('new');
    App._setImportState('idle');
    App.setCreateVisibility('collab', 'public');
  },

  // Visibility state for the create modal. setCreateVisibility('collab',
  // 'public') also forces view='public' and disables the view pills —
  // the one invalid combination (collab public + view private) can never
  // be selected. Defaults match today's behavior (everything public).
  _createVis: { collab: 'public', view: 'public' },

  setCreateVisibility(kind, value) {
    const v = value === 'private' ? 'private' : 'public';
    if (kind === 'collab') {
      App._createVis.collab = v;
      if (v === 'public') App._createVis.view = 'public';
    } else {
      // View can only go private when collab is private.
      App._createVis.view = (App._createVis.collab === 'private') ? v : 'public';
    }
    const block = document.getElementById('create-visibility-block');
    if (!block) return;
    block.querySelectorAll('[data-collab-vis]').forEach((p) => {
      p.classList.toggle('active', p.dataset.collabVis === App._createVis.collab);
    });
    const collabPublic = App._createVis.collab === 'public';
    block.querySelectorAll('[data-view-vis]').forEach((p) => {
      p.classList.toggle('active', p.dataset.viewVis === App._createVis.view);
      p.disabled = collabPublic;
    });
    const hint = document.getElementById('create-vis-hint');
    if (hint) hint.classList.toggle('hidden', !collabPublic);
  },

  // Single source of truth for "which mode is the create modal in". CSS
  // shows/hides the URL block + name field via the data-mode attribute;
  // this helper also flips the title and submit-button label so every
  // entry point (open, cancel, pill click) stays in sync.
  setCreateMode(mode) {
    const m = mode === 'import' ? 'import' : 'new';
    const modal = document.getElementById('create-modal');
    if (!modal) return;
    modal.dataset.mode = m;
    document.getElementById('create-title').textContent =
      m === 'import' ? 'Import existing app' : 'Create a new app';
    document.getElementById('create-submit').textContent =
      m === 'import' ? 'Import' : 'Create';
    document.getElementById('create-error').classList.add('hidden');
    // Switching back to "new" shouldn't leave a stale check banner
    // around; switching into "import" lands on idle either way.
    App._setImportState('idle');
    // Make the name field required only in "new" mode. In "import" the
    // server-side pre-flight is what gates submission — the name field
    // doesn't even exist in the DOM tree until the check passes.
    const nameEl = document.getElementById('app-name');
    if (nameEl) nameEl.required = (m === 'new');
  },

  // Drive the import sub-state. CSS reveals the name field and submit
  // button only at state="ok"; everything else hides them. Called from
  // every transition so the DOM never gets stuck in a halfway state.
  _setImportState(state) {
    const modal = document.getElementById('create-modal');
    if (!modal) return;
    const s = ['idle', 'checking', 'ok', 'error'].includes(state) ? state : 'idle';
    modal.dataset.importState = s;
    const checkBtn = document.getElementById('import-check');
    const status = document.getElementById('import-status');
    if (checkBtn) {
      checkBtn.disabled = (s === 'checking');
      checkBtn.textContent = s === 'ok' ? 'Re-check' : 'Check';
    }
    if (status) {
      if (s === 'idle') {
        status.textContent = '';
        status.className = 'text-sm mt-2';
      } else if (s === 'checking') {
        status.innerHTML = '<span class="import-spinner"></span>Checking bot access…';
        status.className = 'text-sm mt-2';
      }
      // 'ok' and 'error' branches set their own text in handleImportCheck
      // so the message can include repo name / server error text.
    }
  },

  async handleImportCheck() {
    const url = (document.getElementById('import-url')?.value || '').trim();
    const status = document.getElementById('import-status');
    if (!url) {
      App._setImportState('error');
      if (status) {
        status.textContent = 'Paste a GitHub repo URL first.';
        status.className = 'text-sm mt-2 import-status--err';
      }
      return;
    }

    App._setImportState('checking');
    let res;
    try {
      res = await fetch(`/api/github/verify-access?url=${encodeURIComponent(url)}`);
    } catch {
      App._setImportState('error');
      if (status) {
        status.textContent = 'Network error — try again.';
        status.className = 'text-sm mt-2 import-status--err';
      }
      return;
    }

    let data = {};
    try { data = await res.json(); } catch (_) {}

    if (!res.ok) {
      App._setImportState('error');
      if (status) {
        status.textContent = data.error || `Check failed (HTTP ${res.status}).`;
        status.className = 'text-sm mt-2 import-status--err';
      }
      return;
    }

    App._setImportState('ok');
    if (status) {
      const fullName = data.fullName || `${data.owner}/${data.repo}`;
      status.textContent = `✓ usernode-bot has Write access to ${fullName}.`;
      status.className = 'text-sm mt-2 import-status--ok';
    }
    // Prefill name field — repo name + optional description, capped so
    // we don't blow past the input's visible width. Only fill if the
    // user hasn't already typed something (so re-checks don't clobber
    // a manual edit).
    const nameEl = document.getElementById('app-name');
    if (nameEl && !nameEl.value.trim() && data.name) {
      nameEl.value = data.description
        ? `${data.name} — ${data.description}`.slice(0, 80)
        : data.name;
    }
    if (nameEl) nameEl.focus();
  },

  async handleCreateApp(e) {
    e.preventDefault();
    const modal = document.getElementById('create-modal');
    const mode = modal?.dataset.mode === 'import' ? 'import' : 'new';
    const name = document.getElementById('app-name').value.trim();
    const repoUrl = document.getElementById('import-url')?.value.trim() || '';
    const errorEl = document.getElementById('create-error');
    errorEl.classList.add('hidden');

    if (!name) return;

    // Guard: in import mode, submit is gated behind a successful check.
    // CSS hides the submit button when state !== 'ok', but a determined
    // user could still submit by hitting Enter, so belt-and-braces here.
    // The server runs the pre-flight again on POST anyway.
    if (mode === 'import') {
      if (!repoUrl) return;
      if (modal.dataset.importState !== 'ok') {
        errorEl.textContent = 'Click "Check" to verify bot access first.';
        errorEl.classList.remove('hidden');
        return;
      }
    }

    const body = mode === 'import' ? { name, repoUrl } : { name };
    body.collabVisibility = App._createVis.collab;
    body.viewVisibility = App._createVis.view;

    try {
      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        errorEl.textContent = data.error || 'Failed to create app';
        errorEl.classList.remove('hidden');
        return;
      }

      App.hideCreateModal();
      Home.load();
    } catch {
      errorEl.textContent = 'Network error';
      errorEl.classList.remove('hidden');
    }
  },

  async navigateToApp(slug, tab, ref, subTab) {
    // Clean up whatever app we had mounted. This is a no-op on the first
    // navigation into any app, but without it a direct app-A → app-B
    // jump (e.g. via hash) would carry the previous app's dev-chat
    // session state into the new view.
    if (App.currentApp && App.currentApp !== slug) {
      AppView.close();
    }
    App.currentApp = slug;
    if (App._inLeaderboard) App._exitLeaderboard();
    document.getElementById('home-screen').classList.add('hidden');
    document.getElementById('app-view').classList.remove('hidden');
    document.getElementById('back-btn').classList.remove('hidden');
    // Intentionally NOT setting the header to `slug` here. Slugs are
    // generated as `${name}-${randomHex}` (see routes/apps.js), so a
    // slug-as-placeholder shows up to users as something like
    // "whiteboard-abc123" — which the Flutter WebView's AppBar then
    // mirrors via document.title. Leaving the previous header title
    // in place during the brief /api/apps/:slug round-trip is much
    // better UX: from home you see "dApps" briefly, then "Whiteboard";
    // from app A to app B you see "App A" briefly, then "App B". The
    // user never sees the raw slug.
    //
    // The display name lands once the await below resolves (see the
    // `AppView.appData?.name` block).

    await AppView.open(slug);

    // The user can navigate away (back to home, into a different app,
    // to the leaderboard) while `AppView.open(slug)` is still resolving
    // its /api/apps/:slug fetch. Without this guard the rest of the
    // setup below would clobber the header title, re-show the
    // GitHub/Share icons, and force-switch the tab on the screen the
    // user has since moved to. `App.currentApp` is updated synchronously
    // at the top of every navigate* method, so it's the canonical
    // "what's actually on screen right now" signal.
    if (App.currentApp !== slug) return;

    // After app data is loaded, swap header to the display name.
    if (AppView.appData?.name) {
      App.setHeaderTitle(AppView.appData.name);
    }

    // Show the GitHub drawer row if app has a repo
    const drg = document.getElementById('drawer-row-github');
    if (drg && AppView.appData?.repo_url) {
      drg.href = AppView.appData.repo_url;
      drg.classList.remove('hidden');
    }
    // Show the Share drawer row only for apps that have a real running
    // URL. Apps in `creating`/`error`/`awaiting_secrets` have no URL to
    // share; the SSE handler re-shows the row when they flip to `running`.
    const drs = document.getElementById('drawer-row-share');
    if (drs && AppView.appData?.status === 'running' && AppView.appData?.url) {
      drs.classList.remove('hidden');
    }
    // Members & visibility drawer row: creator/admin always (visibility
    // control), collaborators of an invite-only app too (member list +
    // invites). Hidden for the self-app (no invites there) and for
    // everyone else.
    const drm = document.getElementById('drawer-row-members');
    if (drm) {
      const a = AppView.appData;
      const showMembers = !!a && !a.self_hosted && (
        a.can_manage || (a.collab_visibility === 'private' && a.can_collaborate)
      );
      drm.classList.toggle('hidden', !showMembers);
    }
    // The App tab iframes appData.url, which doesn't resolve for the self-
    // hosted platform row (no per-slug subdomain). Land on the Dev forum
    // instead — that's where votes/discussion happen and what users
    // actually want when they open the self-app.
    const defaultTab = AppView.appData?.self_hosted ? 'dev' : 'app';
    App.switchTab(tab || defaultTab, ref, subTab);
  },

  navigateHome() {
    AppView.close();
    App.currentApp = null;
    document.getElementById('app-view').classList.add('hidden');
    if (App._inLeaderboard) App._exitLeaderboard();
    document.getElementById('home-screen').classList.remove('hidden');
    document.getElementById('back-btn').classList.add('hidden');
    const _drgH = document.getElementById('drawer-row-github');
    const _drsH = document.getElementById('drawer-row-share');
    const _drmH = document.getElementById('drawer-row-members');
    if (_drgH) _drgH.classList.add('hidden');
    if (_drsH) _drsH.classList.add('hidden');
    if (_drmH) _drmH.classList.add('hidden');
    App.setHeaderTitle('dApps');
    document.getElementById('app-content').innerHTML = '';
    App.updateHash();
    Home.load();
  },

  // Mirror the visible header text into both the on-screen <h1> and
  // the browser tab title so the OS/window surface reflects the
  // current screen (home → "dApps", app open → app display name,
  // leaderboard → "Kudos leaderboard"). The browser tab title is
  // also used by Notifications._updateTitle() to prepend an unread
  // count "(N) "; we re-invoke it here so a navigation that happens
  // while there are pending notifications keeps the badge.
  //
  // Inside the Flutter WebView, the native AppBar mirrors
  // `document.title`. Flutter's `_refreshPageTitle` only re-reads the
  // title at navigation moments (onPageFinished + onUrlChange). Most
  // of our title sets are *after* a `pushState` (in navigateHome) or
  // *before* one (in navigateToApp, since setHeaderTitle runs before
  // `switchTab → updateHash → pushState`), but the AppBar still ends
  // up one navigation behind in practice — the getTitle() round-trip
  // races with the next JS task, and the result is that the AppBar
  // shows the title that was current at the *previous* pushState.
  // To pin the AppBar to whatever we just set, we also fire-and-forget
  // a `titleChanged` message over the existing Usernode JS channel.
  // The native side handles it by setting `_pageTitle` directly
  // (see lib/features/dapps/dapp_webview_screen.dart). Older app
  // builds that don't know `titleChanged` ignore the message
  // (Flutter logs and drops unknown methods), so this is safe to ship
  // ahead of the Flutter rebuild.
  setHeaderTitle(text) {
    const headerEl = document.getElementById('header-title');
    if (headerEl) headerEl.textContent = text;
    document.title = text;
    // Re-apply the dev-chat status marker ("⏳ thinking / ✅ done",
    // #108) that the plain title assignment above just wiped, then let
    // Notifications re-apply its "(N) " unread prefix outermost.
    if (window.DevChat && typeof DevChat.applyTitleStatus === 'function') {
      DevChat.applyTitleStatus();
    }
    if (window.Notifications && typeof Notifications._updateTitle === 'function') {
      Notifications._updateTitle();
    }
    try {
      if (window.Usernode && typeof window.Usernode.postMessage === 'function') {
        window.Usernode.postMessage(JSON.stringify({
          method: 'titleChanged',
          // Use the final title (with the optional "(N) " unread prefix
          // that Notifications._updateTitle just applied) so the AppBar
          // matches what a desktop browser tab would show.
          value: document.title,
        }));
      }
    } catch (_) {
      // Non-critical — title sync via JS channel is just a fast path
      // for the native shell. Falling back to webview_flutter's
      // onUrlChange path is fine for desktop browsers.
    }
  },

  // Normalize every tab vocabulary onto the forum-era model (#194
  // revision). Returns { tab, subTab, ref } where tab ∈ 'app'|'dev' and
  // subTab ∈ 'forum'|'sessions'. Legacy names (group-chat,
  // individual-chat, and the old dev sub-tabs chat/issues/proposals)
  // keep working at every entry point — old sub-tab refs are converted
  // into typed forum deep links ({ kind: 'issue'|'proposal', id }).
  _normalizeTab(tab, ref, subTab) {
    if (tab === 'group-chat') { tab = 'dev'; subTab = 'chat'; }
    else if (tab === 'individual-chat') { tab = 'dev'; subTab = subTab || 'sessions'; }
    if (tab !== 'dev') return { tab: 'app', subTab: null, ref: null };

    if (subTab === 'sessions') {
      const id = (ref && typeof ref === 'object') ? ref.id : parseInt(ref, 10);
      // No session id → the card list (there is no session-list screen).
      return Number.isInteger(id) && id > 0
        ? { tab: 'dev', subTab: 'sessions', ref: id }
        : { tab: 'dev', subTab: 'forum', ref: null };
    }

    // Full-screen sub-views with no deep-link payload.
    if (subTab === 'chat') return { tab: 'dev', subTab: 'chat', ref: null };
    if (subTab === 'settings') return { tab: 'dev', subTab: 'settings', ref: null };

    // A typed topic ref — from the 'topic' sub-view itself or the
    // legacy issues/proposals sub-tab vocabulary — opens that topic
    // full-screen; everything else lands on the card list.
    let fref = null;
    if (ref && typeof ref === 'object' && ref.kind && ref.id) {
      fref = { kind: ref.kind, id: ref.id };
    } else if (ref != null && subTab === 'issues') {
      const id = parseInt(ref, 10);
      if (Number.isInteger(id) && id > 0) fref = { kind: 'issue', id };
    } else if (ref != null && subTab === 'proposals') {
      const id = parseInt(ref, 10);
      if (Number.isInteger(id) && id > 0) fref = { kind: 'proposal', id };
    }
    return fref
      ? { tab: 'dev', subTab: 'topic', ref: fref }
      : { tab: 'dev', subTab: 'forum', ref: null };
  },

  // `ref` is the view's deep-link target: a dev-session id for the
  // session view, or { kind: 'issue'|'proposal', id } for a forum card
  // to expand. Ignored on the App tab.
  async switchTab(tab, ref, subTab) {
    const norm = App._normalizeTab(tab, ref, subTab);
    tab = norm.tab;
    subTab = norm.subTab;
    ref = norm.ref;
    // The App tab is hidden for self-hosted apps (its iframe target doesn't
    // resolve — see app-view.js renderAppTab). Coerce any incoming request
    // for it (URL hash, browser back/forward, programmatic) to the Dev
    // forum so we never render an unreachable iframe.
    if (tab === 'app' && AppView.appData?.self_hosted) {
      tab = 'dev';
      subTab = 'forum';
      ref = null;
    }
    // The Dev mode is gated for non-collaborators of an invite-only app
    // (the button is hidden by AppView.open; this catches hash/back-
    // forward/programmatic requests). The server enforces the same gate
    // on every API behind it.
    if (tab === 'dev' && AppView.appData && AppView.appData.can_collaborate === false) {
      tab = 'app';
      subTab = null;
      ref = null;
    }
    App.currentTab = tab;
    App.currentSubTab = tab === 'dev' ? (subTab || 'forum') : null;
    document.querySelectorAll('.app-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Tear down the cross-app active-sessions poll when leaving the
    // Sessions sub-tab. renderDevChatTab will spin it back up on
    // re-entry. Without this the poll keeps firing on the other
    // surfaces even though there's no UI to update.
    const onSessions = tab === 'dev' && App.currentSubTab === 'sessions';
    if (!onSessions && typeof DevChat !== 'undefined' && DevChat.stopActiveSessionsPoll) {
      DevChat.stopActiveSessionsPoll();
      // The title status indicator (#108) is scoped to "user is on the
      // dev-chat tab" — leaving the tab clears it. Re-entering while a
      // run is live re-applies it via openSession's busy check.
      if (DevChat.setTitleStatus) DevChat.setTitleStatus(null);
      // #161: switching away from a still-streaming dev session counts
      // as leaving it — arm its completion notification.
      if (DevChat.isStreaming && DevChat.currentSession && DevChat._setNotifyOnDone) {
        DevChat._setNotifyOnDone(DevChat.currentSession.id, true);
      }
    }

    if (tab === 'app') {
      AppView.renderAppTab();
    } else {
      await AppView.renderDevView(App.currentSubTab, ref);
    }

    // Dev console icon: only meaningful when an iframe is on screen. The
    // App tab mounts the production iframe (when status==='running'); the
    // chat tabs do not. Staging overlay manages its own toggle.
    if (window.DevConsole) {
      const showForApp = tab === 'app' && AppView.appData?.status === 'running';
      DevConsole.setButtonVisible(showForApp);
    }

    App.updateHash();
  },

  // Explicit navigation entry point for in-app deep links (e.g. clicking
  // a notification) that must render even when the target route equals
  // the current one. Unlike assigning `location.hash`, this never relies
  // on a `hashchange` event firing — a same-value hash assignment fires
  // nothing, which is why notification clicks to the app/tab you're
  // already viewing used to do nothing. Mirrors restoreFromHash's
  // app/tab dispatch, plus a force-rerender branch for same app+tab.
  openAppTab(slug, tab, opts) {
    if (!slug) return;
    const ref = opts && opts.sessionId != null ? opts.sessionId
      : (opts && opts.ref != null ? opts.ref : null);
    const subTab = (opts && opts.subTab) || null;
    if (App.currentApp !== slug) {
      App.navigateToApp(slug, tab, ref, subTab);
    } else {
      // Same app: switchTab normalizes legacy names, re-renders, and
      // syncs the hash — idempotent when nothing changed, a forced
      // refresh when the target equals the current view.
      App.switchTab(tab, ref, subTab);
    }
  },
};

window.App = App;
document.addEventListener('DOMContentLoaded', () => App.init());
