const App = {
  user: null,
  currentApp: null,
  currentTab: 'app',

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
    } catch {
      window.location.href = '/login.html';
      return;
    }

    App.bindEvents();
    App.connectEvents();
    App.loadVersion();
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
  // ─────────────────────────────────────────────────────────────────
  PlatformUpdating: {
    SS_KEY: 'usernode:platform_updating',
    POLL_FAST_MS: 2000,
    STUCK_AFTER_MS: 5 * 60 * 1000,

    // Mutable runtime state. Persisted shape (in sessionStorage) is
    // just { fromSha, since } — the timer ids and DOM refs are
    // ephemeral and must be re-derived on page load.
    fromSha: null,
    since: null,
    fastPollTimer: null,
    stuckTimer: null,
    fetchWrapInstalled: false,

    isActive() {
      return !!this.fromSha;
    },

    begin({ appSlug, sessionId } = {}) {
      // Idempotent: a second begin() (e.g. server resends the merging
      // event) is a no-op. The fromSha must be captured at first entry
      // — re-capturing on a duplicate call would defeat the SHA-flip
      // dismissal if the new container had already booted in between.
      if (this.isActive()) return;
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
      el.classList.remove('hidden');
      const reload = document.getElementById('platform-updating-reload');
      const text = document.getElementById('platform-updating-text');
      const spinner = document.getElementById('platform-updating-spinner');
      if (stuck) {
        // Swap to the red "stuck" variant. We swap classes rather than
        // re-rendering so the animation is uninterrupted if we flip
        // mid-flight (e.g. on session-storage restore for a tab that's
        // been backgrounded for >5 min).
        el.classList.remove('bg-amber-100', 'text-amber-900', 'border-amber-300',
          'dark:bg-amber-900/40', 'dark:text-amber-100', 'dark:border-amber-800/60');
        el.classList.add('bg-red-100', 'text-red-900', 'border-red-300',
          'dark:bg-red-900/40', 'dark:text-red-100', 'dark:border-red-800/60');
        if (text) text.textContent = 'Platform update is taking longer than expected. You can reload manually.';
        if (spinner) spinner.classList.add('hidden');
        if (reload) reload.classList.remove('hidden');
      } else {
        el.classList.add('bg-amber-100', 'text-amber-900', 'border-amber-300',
          'dark:bg-amber-900/40', 'dark:text-amber-100', 'dark:border-amber-800/60');
        el.classList.remove('bg-red-100', 'text-red-900', 'border-red-300',
          'dark:bg-red-900/40', 'dark:text-red-100', 'dark:border-red-800/60');
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
    App.eventsWs = new WebSocket(`${proto}//${location.host}/ws/events`);

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
      if (App.currentTab === 'group-chat') {
        AppView.loadVotePanel(AppView.appData.slug);
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
        // The Share button was hidden in openApp() because the app wasn't
        // running yet. Now that we have a URL, surface it.
        const shareBtn = document.getElementById('app-share-btn');
        if (shareBtn) shareBtn.classList.remove('hidden');
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
    // Refresh session list if we're on the dev chat tab for this app
    if (App.currentApp === data.appSlug && App.currentTab === 'individual-chat') {
      if (AppView.appData) {
        DevChat.loadSessions(AppView.appData.slug).then(() => {
          if (!DevChat.currentSession) DevChat.renderSessionList();
        });
      }
    }
    // Refresh vote panel if we're on group chat
    if (App.currentApp === data.appSlug && App.currentTab === 'group-chat') {
      AppView.loadVotePanel(data.appSlug);
    }
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
        if (data.url) DevChat.currentSession.staging_url = data.url;
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
          if (data.prTitle) DevChat.currentSession.pr_title = data.prTitle;
          if (typeof DevChat.renderChatView === 'function') DevChat.renderChatView();
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
        // Mayor's write_spec / dispatch_scout updated the live draft.
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
        document.getElementById('header-title').textContent = data.newName;
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
          && App.currentTab === 'group-chat'
          && typeof AppView !== 'undefined' && AppView.loadVotePanel) {
        AppView.loadVotePanel(data.appSlug);
      }
    }
  },

  // Refresh the vote panel when another user creates, votes on, or closes
  // an issue / rename proposal so everyone sees it without reloading.
  handleIssueUpdate(data) {
    if (App.currentApp === data.appSlug && App.currentTab === 'group-chat') {
      AppView.loadVotePanel(data.appSlug);
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
    // Refresh vote panel if we're on group chat for this app
    if (App.currentApp === data.appSlug && App.currentTab === 'group-chat') {
      AppView.loadVotePanel(data.appSlug);
    }
    // If merged, refresh the app view
    if (data.merged && App.currentApp === data.appSlug) {
      if (App.currentTab === 'app') {
        AppView.renderAppTab();
      }
      Home.load();
    }
  },

  bindEvents() {
    // Note: the "Create new app" entry point lives in the home feed
    // now (see Home.wireCreateButtons) — no static header button to
    // bind here anymore.
    document.getElementById('create-cancel').addEventListener('click', App.hideCreateModal);
    document.getElementById('create-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) App.hideCreateModal();
    });
    document.getElementById('create-form').addEventListener('submit', App.handleCreateApp);

    // Create / Import mode pills. The active mode lives on
    // #create-modal[data-mode="..."] (CSS keys off it for styling); these
    // handlers also flip the submit-button label and the URL block.
    document.querySelectorAll('.create-mode-pill').forEach((pill) => {
      pill.addEventListener('click', () => App.setCreateMode(pill.dataset.modePill));
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
        if (e.target === e.currentTarget) AppView.closeRenameModal();
      });
      document.getElementById('rename-form').addEventListener('submit', AppView.submitRename);
    }

    // Feedback
    const feedbackText = document.getElementById('feedback-text');
    const feedbackBtn = document.getElementById('feedback-submit');
    const feedbackStatus = document.getElementById('feedback-status');

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
        const res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: text }),
        });
        const data = await res.json();
        if (res.ok) {
          feedbackStatus.textContent = 'Thanks! Issue filed.';
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

    document.getElementById('feedback-btn').addEventListener('click', () => {
      document.getElementById('feedback-modal').classList.remove('hidden');
      // Reset any "Submitted" lock from a prior session so a returning
      // user can file another piece of feedback without reloading.
      feedbackText.disabled = false;
      feedbackBtn.disabled = false; feedbackBtn.textContent = 'Submit';
      feedbackStatus.classList.add('hidden');
      feedbackText.focus();
    });
    document.getElementById('feedback-cancel').addEventListener('click', () => {
      document.getElementById('feedback-modal').classList.add('hidden');
      feedbackText.value = '';
      feedbackText.disabled = false;
      feedbackBtn.disabled = false; feedbackBtn.textContent = 'Submit';
      feedbackStatus.classList.add('hidden');
    });
    document.getElementById('feedback-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) document.getElementById('feedback-cancel').click();
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

    // Share modal — opens AppView's share dialog with the bare subdomain
    // URL. The button's hidden state is managed in openApp / navigateHome
    // (and in handleAppStatus for the creating→running flip), so we only
    // wire the click-to-open + dismiss handlers here.
    const shareBtn = document.getElementById('app-share-btn');
    if (shareBtn) shareBtn.addEventListener('click', () => AppView.openShareModal());
    const shareClose = document.getElementById('share-close');
    if (shareClose) shareClose.addEventListener('click', () => AppView.closeShareModal());
    const shareModal = document.getElementById('share-modal');
    if (shareModal) shareModal.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) AppView.closeShareModal();
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
        else Home.load();
        return;
      }

      const parts = hash.split('/');
      if (parts[0] === 'app' && parts[1]) {
        const slug = parts[1];
        const tab = parts[2] || 'app';
        const sessionId = parts[3] ? parseInt(parts[3]) : null;
        if (App.currentApp !== slug) {
          App.navigateToApp(slug, tab, sessionId);
        } else if (App.currentTab !== tab) {
          App.switchTab(tab, sessionId);
        }
      } else {
        Home.load();
      }
    } finally {
      App._isRestoring = false;
    }
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
      newHash = `#app/${App.currentApp}/${App.currentTab}`;
      if (App.currentTab === 'individual-chat' && DevChat.currentSession) {
        newHash += `/${DevChat.currentSession.id}`;
      }
    } else {
      newHash = location.pathname; // home: drop the fragment entirely
    }

    const currentFull = location.hash || '';
    const targetFull = newHash.startsWith('#') ? newHash : '';
    if (currentFull === targetFull) return;

    const screenIdOf = (h) =>
      String(h || '').replace(/^#/, '').split('/').slice(0, 3).join('/');
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

  async navigateToApp(slug, tab, sessionId) {
    // Clean up whatever app we had mounted. This is a no-op on the first
    // navigation into any app, but without it a direct app-A → app-B
    // jump (e.g. via hash) would carry the previous app's dev-chat
    // session state into the new view.
    if (App.currentApp && App.currentApp !== slug) {
      AppView.close();
    }
    App.currentApp = slug;
    document.getElementById('home-screen').classList.add('hidden');
    document.getElementById('app-view').classList.remove('hidden');
    document.getElementById('back-btn').classList.remove('hidden');
    document.getElementById('header-title').textContent = slug;

    await AppView.open(slug);

    // After app data is loaded, swap header to the display name.
    if (AppView.appData?.name) {
      document.getElementById('header-title').textContent = AppView.appData.name;
    }

    // Show GitHub link if app has a repo
    const ghLink = document.getElementById('app-github-link');
    if (ghLink && AppView.appData?.repo_url) {
      ghLink.href = AppView.appData.repo_url;
      ghLink.classList.remove('hidden');
    }
    // Show Share button only for apps that have a real running URL.
    // Apps in `creating`/`error`/`awaiting_secrets` have no URL to share;
    // the SSE handler below re-shows the button when they flip to `running`.
    const shareBtn = document.getElementById('app-share-btn');
    if (shareBtn && AppView.appData?.status === 'running' && AppView.appData?.url) {
      shareBtn.classList.remove('hidden');
    }
    // The App tab iframes appData.url, which doesn't resolve for the self-
    // hosted platform row (no per-slug subdomain). Land on Group Chat
    // instead — that's where votes/discussion happen and what users
    // actually want when they open the self-app.
    const defaultTab = AppView.appData?.self_hosted ? 'group-chat' : 'app';
    App.switchTab(tab || defaultTab, sessionId);
  },

  navigateHome() {
    AppView.close();
    App.currentApp = null;
    document.getElementById('app-view').classList.add('hidden');
    document.getElementById('home-screen').classList.remove('hidden');
    document.getElementById('back-btn').classList.add('hidden');
    document.getElementById('app-github-link').classList.add('hidden');
    document.getElementById('app-share-btn').classList.add('hidden');
    document.getElementById('header-title').textContent = 'Usernode Social Vibecoding';
    document.getElementById('app-content').innerHTML = '';
    App.updateHash();
    Home.load();
  },

  async switchTab(tab, sessionId) {
    // The App tab is hidden for self-hosted apps (its iframe target doesn't
    // resolve — see app-view.js renderAppTab). Coerce any incoming request
    // for it (URL hash, browser back/forward, programmatic) to Group Chat
    // so we never render an unreachable iframe.
    if (tab === 'app' && AppView.appData?.self_hosted) {
      tab = 'group-chat';
    }
    App.currentTab = tab;
    document.querySelectorAll('.app-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Tear down the cross-app active-sessions poll when leaving the
    // dev-chat tab. renderDevChatTab will spin it back up on re-entry.
    // Without this the poll keeps firing on the group-chat / app tabs
    // even though there's no UI to update.
    if (tab !== 'individual-chat' && typeof DevChat !== 'undefined' && DevChat.stopActiveSessionsPoll) {
      DevChat.stopActiveSessionsPoll();
    }

    switch (tab) {
      case 'app':
        AppView.renderAppTab();
        break;
      case 'group-chat':
        AppView.renderGroupChatTab();
        break;
      case 'individual-chat':
        await AppView.renderDevChatTab(sessionId);
        break;
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
};

document.addEventListener('DOMContentLoaded', () => App.init());
