const App = {
  user: null,
  currentApp: null,
  currentTab: 'app',

  async init() {
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

  eventsWs: null,

  connectEvents() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    App.eventsWs = new WebSocket(`${proto}//${location.host}/ws/events`);

    App.eventsWs.onopen = () => {
      console.log('[ws] Global events connected');
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
            if (window.AppView && AppView.appData?.slug === data.appSlug) {
              AppView.refreshVersionPill();
            }
            break;
        }
      } catch {}
    };

    App.eventsWs.onclose = () => {
      setTimeout(() => App.connectEvents(), 3000);
    };
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
    document.getElementById('create-app-btn').addEventListener('click', App.showCreateModal);
    document.getElementById('create-cancel').addEventListener('click', App.hideCreateModal);
    document.getElementById('create-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) App.hideCreateModal();
    });
    document.getElementById('create-form').addEventListener('submit', App.handleCreateApp);
    document.getElementById('back-btn').addEventListener('click', App.navigateHome);

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

    document.querySelectorAll('.app-tab').forEach((btn) => {
      btn.addEventListener('click', () => App.switchTab(btn.dataset.tab));
    });

    window.addEventListener('hashchange', () => App.restoreFromHash());
  },

  restoreFromHash() {
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
  },

  updateHash() {
    if (App.currentApp) {
      let newHash = `#app/${App.currentApp}/${App.currentTab}`;
      if (App.currentTab === 'individual-chat' && DevChat.currentSession) {
        newHash += `/${DevChat.currentSession.id}`;
      }
      if (location.hash !== newHash) {
        history.replaceState(null, '', newHash);
      }
    } else {
      if (location.hash) {
        history.replaceState(null, '', location.pathname);
      }
    }
  },

  showCreateModal() {
    document.getElementById('create-modal').classList.remove('hidden');
    document.getElementById('app-name').focus();
  },

  hideCreateModal() {
    document.getElementById('create-modal').classList.add('hidden');
    document.getElementById('create-form').reset();
    document.getElementById('create-error').classList.add('hidden');
  },

  async handleCreateApp(e) {
    e.preventDefault();
    const name = document.getElementById('app-name').value.trim();
    const errorEl = document.getElementById('create-error');
    errorEl.classList.add('hidden');

    if (!name) return;

    try {
      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
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
    document.getElementById('create-app-btn').classList.add('hidden');
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
    App.switchTab(tab || 'app', sessionId);
  },

  navigateHome() {
    AppView.close();
    App.currentApp = null;
    document.getElementById('app-view').classList.add('hidden');
    document.getElementById('home-screen').classList.remove('hidden');
    document.getElementById('back-btn').classList.add('hidden');
    document.getElementById('create-app-btn').classList.remove('hidden');
    document.getElementById('app-github-link').classList.add('hidden');
    document.getElementById('header-title').textContent = 'Usernode Social Vibecoding';
    document.getElementById('app-content').innerHTML = '';
    App.updateHash();
    Home.load();
  },

  async switchTab(tab, sessionId) {
    App.currentTab = tab;
    document.querySelectorAll('.app-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

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
