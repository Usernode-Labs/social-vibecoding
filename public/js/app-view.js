const AppView = {
  appData: null,
  iframeToken: null,
  activityInterval: null,
  tokenRefreshInterval: null,
  activeSeconds: 0,
  iframeFocused: false,

  // Open-issues state. `_ghIssues` caches the last-fetched GitHub issue
  // list (with bounty_count/my_bounty) so feed paging and the
  // give-bounty optimistic update can re-render without a refetch.
  _ghIssues: [],
  _ghIssuesMeta: { truncatedList: false, note: null, repoUrl: null, myRemaining: null },
  _bountyInFlight: new Set(),

  // Shared list-item shell for every card on the Dev page — the General
  // chat card, issue/proposal/governance cards, Your-sessions rows, and
  // Recently-merged rows — so the whole page reads as one uniform list
  // (same row structure, padding, border, radius). Tappable cards add
  // DEV_CARD_HOVER_CLS on top.
  DEV_CARD_CLS: 'w-full flex items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 px-3.5 py-3 text-left transition-colors',
  // Trailing chevron marking a card as tappable (same affordance as the
  // General chat card).
  DEV_CARD_CHEVRON: '<svg class="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>',
  DEV_CARD_HOVER_CLS: 'hover:border-violet-300 dark:hover:border-violet-700 cursor-pointer',

  // Per-type tinted icon chips — the Dev list's identity system, a mini
  // version of the home tiles' avatar square. [tint classes, SVG path].
  DEV_CARD_ICONS: {
    chat: ['bg-violet-600/15 text-violet-500', 'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z'],
    session: ['bg-emerald-500/15 text-emerald-500', 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z'],
    issue: ['bg-amber-500/15 text-amber-500', 'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'],
    proposal: ['bg-sky-500/15 text-sky-500', 'M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-11h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5'],
    gov: ['bg-slate-500/15 text-slate-400', 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z'],
    done: ['bg-emerald-500/10 text-emerald-500', 'M5 13l4 4L19 7'],
  },

  _devCardIcon(type, opts) {
    const [tint, d] = AppView.DEV_CARD_ICONS[type] || AppView.DEV_CARD_ICONS.issue;
    const small = !!(opts && opts.small);
    return `<span class="${small ? 'w-7 h-7' : 'w-9 h-9'} rounded-lg ${tint} flex items-center justify-center shrink-0">`
      + `<svg class="${small ? 'w-4 h-4' : 'w-5 h-5'}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg></span>`;
  },

  // ── Dev view state (#194, card-list revision) ─────────────────────
  // The Dev mode is one card list plus full-screen sub-views (general
  // chat, topics, sessions, settings). _devTopic (declared with the
  // topic sub-view below) tracks the open topic for hash deep links.
  // How many feed items are visible (the rest sit behind "Show more").
  _feedShown: 20,
  // Refresh timer for the Your-sessions strip's busy indicators;
  // self-clears when the strip leaves the DOM.
  _stripTimer: null,
  // Cached Proposals-tab data for in-place re-renders.
  _proposals: [],
  _govProposals: [],
  _proposalsCtx: { majority: 1, activeUsers: 1, locked: false, lockedHint: '' },
  // One-shot flag set by the "Create proposal" button so the freshly
  // opened dev session renders a "promoting this PR creates the
  // proposal" hint.
  _proposalHint: false,

  // Iframe tokens are signed for 1h. Refresh at 45min so the child app never
  // sees an expired JWT during a long reading/editing session.
  TOKEN_REFRESH_MS: 45 * 60 * 1000,

  async open(slug) {
    const res = await fetch(`/api/apps/${slug}`);
    if (!res.ok) return;
    const { app: appData } = await res.json();
    AppView.appData = appData;

    // The App tab is an iframe of `appData.url` (the per-slug subdomain).
    // The self-app row maps to a slug-derived hostname that doesn't exist —
    // the platform itself lives at the root domain, not a subdomain — so
    // the tab would render a TLS error. Hide it for self-hosted apps; the
    // default-tab logic in App.navigateToApp/switchTab routes to Dev → Chat
    // instead. Show it again for non-self-hosted (mounting AppView is per-
    // app, so a previous self-app open could have left the button hidden).
    const appTabBtn = document.querySelector('.app-tab[data-tab="app"]');
    if (appTabBtn) {
      appTabBtn.classList.toggle('hidden', !!appData.self_hosted);
    }

    // The Dev mode (Chat / Issues / Proposals / Sessions) is hidden for
    // non-collaborators of an invite-only app — they can use the app
    // (when view-public) but not build it. App.switchTab coerces any
    // direct request for the gated mode back to the App tab, and every
    // API behind it enforces the same gate server-side.
    const canCollab = appData.can_collaborate !== false;
    const devTabBtn = document.querySelector('.app-tab[data-tab="dev"]');
    if (devTabBtn) devTabBtn.classList.toggle('hidden', !canCollab);

    await AppView.refreshToken();
    AppView.startActivityTracking(slug);
    AppView.startTokenRefresh();
    if (window.DevConsole) DevConsole.setCurrentApp(slug);
    // Populate the deployed-version pill in the header. It lives in the
    // shared header so it's visible across tabs (App / group-chat /
    // dev-chat) for the duration this app is open; close() clears it.
    AppView.refreshVersionPill();
    // Missing-secrets badge lives inside the dev-chat tab now and is
    // re-applied by renderDevChatTab() on every mount, so the call here
    // is just a primer for the case where the tab is already rendered.
    if (window.Secrets) {
      Secrets.applyMissingBadge(appData.missingSecrets || null);
    }
  },

  close() {
    AppView.stopActivityTracking();
    AppView.stopTokenRefresh();
    GroupChat.disconnect();
    // Drop any in-memory dev-chat session state belonging to the app
    // we're leaving. Without this, opening a different app and clicking
    // the dev-chat tab would render the prior app's session instead of
    // the new app's session list (fixes #20).
    if (window.DevChat) DevChat.reset();
    AppView.appData = null;
    AppView.iframeToken = null;
    if (window.DevConsole) {
      DevConsole.hide();
      DevConsole.setCurrentApp(null);
    }
    if (window.Secrets) Secrets.hide();
    const slot = document.getElementById('app-version-pill-slot');
    if (slot) slot.innerHTML = '';
  },

  async refreshToken() {
    try {
      const res = await fetch('/api/iframe-token');
      if (res.ok) {
        const { token } = await res.json();
        AppView.iframeToken = token;
      }
    } catch {}
  },

  startTokenRefresh() {
    AppView.stopTokenRefresh();
    AppView.tokenRefreshInterval = setInterval(async () => {
      await AppView.refreshToken();
      // Rewrite the iframe src so the child app picks up the fresh token.
      // Only when the App tab is the visible one; other tabs re-fetch on
      // next render anyway.
      const iframe = document.getElementById('app-iframe');
      if (iframe && AppView.appData?.url && AppView.iframeToken) {
        iframe.src = `${resolveDevHost(AppView.appData.url)}?token=${AppView.iframeToken}`;
      }
    }, AppView.TOKEN_REFRESH_MS);
  },

  stopTokenRefresh() {
    if (AppView.tokenRefreshInterval) {
      clearInterval(AppView.tokenRefreshInterval);
      AppView.tokenRefreshInterval = null;
    }
  },

  renderAppTab() {
    const content = document.getElementById('app-content');
    const appData = AppView.appData;

    if (!appData || appData.status !== 'running' || !appData.url) {
      let inner;
      if (appData?.status === 'creating') {
        inner = '<div class="status-dot creating"></div><p class="text-sm">App is spinning up...</p>';
      } else if (appData?.status === 'awaiting_secrets') {
        const missing = Array.isArray(appData.missingSecrets) && appData.missingSecrets.length
          ? appData.missingSecrets : (appData.missingSecrets || []);
        const missingList = missing.length
          ? `<p class="text-xs font-mono text-red-500">${missing.map(escapeHtml).join(', ')}</p>` : '';
        inner = `
          <div class="status-dot creating"></div>
          <p class="text-sm">Awaiting required secrets — deploy is blocked.</p>
          ${missingList}
          <button id="awaiting-open-secrets"
            class="mt-3 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white">
            Configure secrets
          </button>
        `;
      } else if (appData?.status === 'error') {
        inner = '<div class="status-dot error"></div><p class="text-sm">App failed to start</p>';
      } else {
        inner = '<p class="text-sm">App not available</p>';
      }
      content.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full text-zinc-500 dark:text-zinc-400 gap-2 p-4 text-center">
          ${inner}
        </div>`;
      // The "Configure secrets" button is wired here rather than via a
      // delegated handler because this branch re-renders on every
      // status change and the listener would otherwise re-attach.
      const openBtn = document.getElementById('awaiting-open-secrets');
      if (openBtn && window.Secrets && appData?.slug) {
        openBtn.addEventListener('click', () => Secrets.open(appData.slug));
      }
      // Status updates pushed via WebSocket — no polling needed
      return;
    }

    const appUrl = resolveDevHost(appData.url);
    const iframeSrc = AppView.iframeToken
      ? `${appUrl}?token=${AppView.iframeToken}`
      : appUrl;

    content.innerHTML = `
      <iframe
        id="app-iframe"
        src="${iframeSrc}"
        class="w-full h-full border-0"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
        allow="clipboard-write"
      ></iframe>`;

    const iframe = document.getElementById('app-iframe');
    iframe.addEventListener('load', () => {
      AppView.iframeFocused = true;
    });
  },

  // #21: fetch + render the "live on <sha> · PR #N" pill. Called on App
  // tab render and again whenever an `app_version_changed` or
  // `app_redeploy_status` WS event fires for this app (so the pill
  // updates live when a PR merges in another tab/session, and turns
  // yellow + spinning while the rebuild is in flight).
  async refreshVersionPill() {
    const slot = document.getElementById('app-version-pill-slot');
    if (!slot || !AppView.appData) return;
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/version`);
      if (!res.ok) return;
      const info = await res.json();
      slot.innerHTML = AppView.renderAppVersionPillHTML({
        slug: AppView.appData.slug,
        version: info.sha ? info : null,
        deployProgress: info.deployProgress || null,
        // Header pill gets the richer PR-context tooltip (title +
        // author + merge time). The home-screen card uses the same
        // helper without this and gets the plain commit-hash tip.
        includePrContext: true,
      });
    } catch {
      // Non-critical; if the fetch fails the pill just doesn't render.
    }
  },

  // Apply a deploy-progress update to the header pill without going
  // back to the server. Called from the `app_redeploy_status` WS
  // handler so the pill flips into its yellow/spinner state the
  // instant the broadcast arrives, even before refreshVersionPill
  // would re-fetch on the trailing `app_version_changed` event.
  applyHeaderDeployProgress(deployProgress) {
    const slot = document.getElementById('app-version-pill-slot');
    if (!slot || !AppView.appData) return;
    // Preserve whatever version data the previous render captured by
    // re-querying the DOM — the slot stores all the fields we'd need
    // via dataset. We don't need them, though: while deploying we
    // render a stripped-down pill that doesn't show the prior SHA.
    slot.innerHTML = AppView.renderAppVersionPillHTML({
      slug: AppView.appData.slug,
      version: null, // hidden during deploy; the next refresh fills it in
      deployProgress,
      includePrContext: true,
    });
  },

  // Single source of truth for the per-app version pill. Used by both
  // the header (AppView) and the home-screen cards (Home), so the two
  // surfaces stay visually identical and stay in lockstep when new
  // states (e.g. a future "rollback available" variant) are added.
  //
  // `version` shape: { sha, shortSha, prNumber, prUrl?, commitUrl?,
  // prTitle?, mergedBy?, mergedAt? } — null means "no SHA yet".
  // `deployProgress` shape: { deploying:true, startedAt, fromSha,
  // toSha?, failed?, stale? } — null means "no in-flight deploy".
  renderAppVersionPillHTML(opts) {
    const slug = opts && opts.slug ? String(opts.slug) : '';
    const version = opts && opts.version;
    const deployProgress = opts && opts.deployProgress;
    const includePrContext = !!(opts && opts.includePrContext);
    // `quiet` callers want a border-only chip with no state modifiers
    // even when a deploy is in flight — the home-tile pills use it so
    // the tile's status dot is the single visual signal for "this app
    // is redeploying" (yellow pulse). Without quiet the pill would
    // double-signal the same event next to the status dot.
    const quiet = !!(opts && opts.quiet);
    if (!slug) return '';

    // Slug prefix (`<slug> ·`) is shown only in quiet mode (home tiles),
    // where it's the *only* identifier — there's no other affordance on
    // the card telling you which commit pill belongs to which app. In
    // the AppView header (non-quiet), the page title already names the
    // app, so repeating the slug inside the pill just widens the right
    // group and pushes the title into truncation territory. Dropping it
    // there is the second half of the title-overlap fix (the first half
    // is the grid header layout in index.html — see the comment there).
    const slugPart = quiet
      ? `<span class="app-version-pill-name">${escapeHtml(slug)}</span><span class="app-version-pill-sep">·</span>`
      : '';

    const isDeploying = !quiet && !!(deployProgress && deployProgress.deploying);
    if (isDeploying) {
      const elapsed = deployProgress.startedAt
        ? Math.max(0, Math.floor((Date.now() - new Date(deployProgress.startedAt).getTime()) / 1000))
        : null;
      const tipParts = ['Redeploying'];
      if (deployProgress.fromSha) tipParts.push(`from ${String(deployProgress.fromSha).slice(0, 7)}`);
      if (elapsed != null) tipParts.push(`${elapsed}s elapsed`);
      const tip = tipParts.join(' · ');
      return `
        <span class="app-version-pill app-version-pill--deploying" title="${escapeAttr(tip)}">
          <span class="app-version-pill-spinner" aria-hidden="true"></span>
          <span class="app-version-pill-label">
            ${slugPart}
            deploying
          </span>
        </span>`;
    }

    if (!version || !version.sha) {
      // Mirror the platform-version pill's "dev" state: render a
      // low-key chip so the slot is never empty (which can look like
      // a layout bug or a JS failure to render). Reachable for apps
      // still in `creating`, apps without a repo, or pre-#21 rows
      // that haven't been backfilled yet. The leading status dot is
      // dropped in quiet mode (home tiles) — the tile already has its
      // own status dot at the top.
      return `
        <span class="app-version-pill" title="No deployed version recorded yet">
          ${quiet ? '' : '<span class="app-version-pill-dot" style="background:#71717a;box-shadow:none"></span>'}
          <span class="app-version-pill-label">
            ${slugPart}
            dev
          </span>
        </span>`;
    }

    const href = version.prUrl || version.commitUrl || '#';
    const parts = [];
    if (includePrContext && version.prTitle) parts.push(version.prTitle);
    if (includePrContext && version.mergedBy) parts.push(`by @${version.mergedBy}`);
    if (includePrContext && version.mergedAt) parts.push(relTime(version.mergedAt));
    const tip = parts.length ? parts.join(' · ') : `Commit ${version.shortSha}`;
    const sha = version.prNumber
      ? `${version.shortSha} · #${version.prNumber}`
      : version.shortSha;
    // Drop the green status dot inside the pill in quiet mode for the
    // same reason as the dev branch above — the home tile's outer
    // status dot already covers "this app's lifecycle state", and the
    // user doesn't need a second tiny dot duplicating it inside the
    // commit chip.
    return `
      <a href="${href}" target="_blank" rel="noopener" class="app-version-pill" title="${escapeAttr(tip)}">
        ${quiet ? '' : '<span class="app-version-pill-dot"></span>'}
        <span class="app-version-pill-label">
          ${slugPart}
          ${escapeHtml(sha)}
        </span>
      </a>`;
  },

  // Returns the mount point for dev-view section renderers: the
  // #dev-section slot inside the Dev mode's sub-tab layout when present,
  // falling back to #app-content (defensive — every call site should be
  // inside renderDevView these days).
  _devContainer() {
    return document.getElementById('dev-section') || document.getElementById('app-content');
  },

  // ── Dev mode (#194, forum revision): one page ──────────────────────
  // subTab ∈ 'forum' | 'sessions'. For 'sessions', `ref` is the dev
  // session id (no id → forum). For 'forum', `ref` is an optional
  // { kind: 'issue'|'proposal', id } deep link naming the card to
  // expand.
  async renderDevView(subTab, ref) {
    const content = document.getElementById('app-content');
    if (!content) return;

    // Leaving whatever thread surface was open: drop the live render
    // target so incoming thread messages turn into badge bumps.
    if (typeof GroupChat !== 'undefined' && GroupChat.unmountThread) GroupChat.unmountThread();
    if (subTab !== 'topic') AppView._devTopic = null;

    // Session view — a single DevChat session, full-screen, reached
    // from the Your-sessions strip, proposal cards, or the "+" flow.
    if (subTab === 'sessions' && ref) {
      content.innerHTML = `
        <div class="flex flex-col h-full min-h-0">
          <div id="dev-section" class="flex-1 min-h-0 flex flex-col" style="overflow:hidden"></div>
        </div>`;
      await AppView.renderDevChatTab(ref);
      return;
    }

    // Full-screen general chat (card-list revision: chat is a card you
    // tap into, not a pinned pane).
    if (subTab === 'chat') {
      AppView._renderChatSubView(content);
      return;
    }

    // App settings sub-page (reached from the "+" menu).
    if (subTab === 'settings') {
      AppView._renderSettingsView(content);
      return;
    }

    // Full-screen topic (issue / proposal / governance) discussion.
    if (subTab === 'topic' && ref && ref.kind && ref.id) {
      await AppView._renderTopicSubView(content, ref);
      return;
    }

    // The card list.
    AppView._feedShown = 20;

    content.innerHTML = `
      <div class="flex flex-col h-full min-h-0">
        <!-- Header bar: title + the "+" menu (top right). -->
        <div class="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <span class="text-xs uppercase font-semibold text-zinc-500 dark:text-zinc-400 tracking-wider flex-1">Dev</span>
          <div class="relative">
            <button id="dev-plus-btn" aria-haspopup="true" aria-expanded="false"
              class="rounded-lg bg-violet-600 hover:bg-violet-500 w-7 h-7 flex items-center justify-center text-base font-bold leading-none text-white transition-colors"
              title="Propose a change, file an issue, or open app settings">+</button>
            <div id="dev-plus-menu" class="hidden absolute right-0 top-9 z-30 w-64 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden">
              <button data-plus="proposal" class="w-full text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Propose a change</span>
                <span class="block text-xs text-zinc-500 dark:text-zinc-400">Start an AI dev session — promoting its PR creates the proposal</span>
              </button>
              <button data-plus="issue" class="w-full text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors border-t border-zinc-200 dark:border-zinc-800">
                <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">New issue</span>
                <span class="block text-xs text-zinc-500 dark:text-zinc-400">Report a problem or idea without building it yourself</span>
              </button>
              <button data-plus="settings" class="w-full text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors border-t border-zinc-200 dark:border-zinc-800">
                <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">App settings</span>
                <span class="block text-xs text-zinc-500 dark:text-zinc-400">App secrets and display name</span>
              </button>
            </div>
          </div>
        </div>

        <!-- The card list: locked notice, general-chat card, session
             rows, the intermixed feed, and the Completed section. -->
        <div id="dev-forum-scroll" class="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <div id="dev-locked-notice" class="px-3 pt-2 hidden"></div>
          <div class="px-3 pt-2">
            <button id="dev-chat-card" class="${AppView.DEV_CARD_CLS} ${AppView.DEV_CARD_HOVER_CLS}"
              title="Open the general chat">
              ${AppView._devCardIcon('chat')}
              <span class="flex-1 min-w-0">
                <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">General chat</span>
                <span id="dev-chat-card-preview" class="block text-xs text-zinc-500 dark:text-zinc-400 truncate">Talk with everyone building this app</span>
              </span>
              <svg class="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            </button>
          </div>
          <div id="dev-sessions-strip" class="px-3 pt-2"></div>
          <div class="px-3 py-2">
            <div id="dev-feed"><div class="text-xs text-zinc-500 dark:text-zinc-400">Loading…</div></div>
            <div id="gc-merged" class="mt-4"></div>
          </div>
        </div>
      </div>`;

    AppView._wirePlusMenu(content);
    document.getElementById('dev-chat-card').addEventListener('click', () => {
      App.switchTab('dev', null, 'chat');
    });
    AppView._loadChatCardPreview();

    // Delegated card-open handler: tapping a topic card anywhere except
    // its links/pills opens that topic full-screen. Bound on the stable
    // #dev-feed container (its innerHTML re-renders, the node itself
    // survives until the next renderDevView).
    const feedEl = document.getElementById('dev-feed');
    feedEl.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input, form')) return;
      const issueRow = e.target.closest('[data-issue-row]');
      if (issueRow) {
        AppView.openTopic('issue', parseInt(issueRow.dataset.issueRow, 10));
        return;
      }
      const prRow = e.target.closest('[data-proposal-row]');
      if (prRow) {
        AppView.openTopic('proposal', parseInt(prRow.dataset.proposalRow, 10));
        return;
      }
      const govRow = e.target.closest('[data-gov-row]');
      if (govRow) AppView.openTopic('gov', parseInt(govRow.dataset.govRow, 10));
    });

    AppView._renderSessionsStrip();
    AppView._syncStripPolling();
    await AppView._loadDevFeed();
  },

  // ── Full-screen topic sub-view ──────────────────────────────────────
  // One issue / PR proposal / governance proposal opened from its card
  // (or a deep link): back header, the card itself (vote/preview/kudos
  // pills still live, minus the open-discussion affordance), the body
  // (issue text / vote details), and the discussion thread filling the
  // remaining height with the composer pinned to the bottom.
  _devTopic: null, // { kind: 'issue'|'proposal'|'gov', id } while open

  async _renderTopicSubView(content, ref) {
    AppView._devTopic = { kind: ref.kind, id: ref.id };
    content.innerHTML = `
      <div class="flex flex-col h-full min-h-0">
        <div class="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <button id="dev-topic-back" class="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-sm shrink-0" title="Back to the dev page">&larr;</button>
          <div id="dev-topic-title" class="flex items-center gap-2 flex-1 min-w-0">
            <span class="text-xs text-zinc-500 dark:text-zinc-400">Loading…</span>
          </div>
        </div>
        <div class="flex-1 min-h-0 flex flex-col px-3 py-2">
          <div id="dev-topic-head" class="shrink-0 overflow-y-auto overscroll-contain" style="max-height:45%"></div>
          <div id="dev-topic-thread" class="flex-1 min-h-0 mt-2"></div>
        </div>
      </div>`;

    document.getElementById('dev-topic-back').addEventListener('click', () => {
      App.switchTab('dev');
    });

    const ok = await AppView._loadDevData();
    // The view may have been replaced (or retargeted) while the fetch
    // was in flight.
    const t = AppView._devTopic;
    if (!document.getElementById('dev-topic-head') || !t
        || t.kind !== ref.kind || t.id !== ref.id) return;
    if (!ok || !AppView._findTopicItem()) {
      // Missing ref (closed issue, archived session, bad link) — fall
      // back to the card list.
      App.switchTab('dev');
      return;
    }
    AppView._renderTopicHead();
    AppView._mountTopicThread();
  },

  _findTopicItem() {
    const t = AppView._devTopic;
    if (!t) return null;
    if (t.kind === 'issue') {
      return (AppView._ghIssues || []).find((i) => i.number === t.id) || null;
    }
    if (t.kind === 'proposal') {
      // Open proposals first; merged ones stay viewable (read-only thread).
      return (AppView._proposals || []).find((p) => p.id === t.id)
        || (AppView._merged || []).find((p) => p.id === t.id) || null;
    }
    return (AppView._govProposals || []).find((i) => i.id === t.id) || null;
  },

  // Paint (or live-refresh) the topic title + header card + body.
  // Leaves #dev-topic-thread untouched so the mounted thread survives
  // WS-driven refreshes.
  _renderTopicHead() {
    const t = AppView._devTopic;
    const head = document.getElementById('dev-topic-head');
    const titleEl = document.getElementById('dev-topic-title');
    if (!t || !head) return;
    const item = AppView._findTopicItem();
    // Closed / merged away mid-view: keep the last render readable.
    if (!item) return;

    let icon;
    let label;
    let cardHtml;
    let bodyHtml;
    if (t.kind === 'issue') {
      icon = 'issue';
      label = `#${item.number} · ${item.title}`;
      cardHtml = AppView._renderIssueRow(item, { noNav: true });
      bodyHtml = AppView._issueBodyHtml(item);
    } else if (t.kind === 'proposal') {
      icon = item.status === 'merged' ? 'done' : 'proposal';
      label = `PR#${item.pr_number || item.id} · ${item.pr_title || `by ${item.username || ''}`}`;
      cardHtml = AppView._renderProposalCard(item, { noNav: true });
      bodyHtml = AppView._proposalDetailsHtml(item);
    } else {
      icon = 'gov';
      label = item.kind === 'rename'
        ? `Rename to "${(item.payload && item.payload.newName) || item.title}"`
        : item.title;
      cardHtml = AppView._renderGovCard(item, { noNav: true });
      bodyHtml = item.description
        ? `<div class="text-xs text-zinc-500 dark:text-zinc-400 mt-2 px-1">${escapeHtml(item.description)}</div>`
        : '';
    }

    if (titleEl) {
      titleEl.innerHTML = `${AppView._devCardIcon(icon, { small: true })}`
        + `<span class="text-xs font-semibold text-zinc-700 dark:text-zinc-300 truncate">${escapeHtml(label)}</span>`;
    }
    head.innerHTML = cardHtml + bodyHtml;
    if (window.Kudos) Kudos.attach(head);
    if (t.kind === 'proposal' && item.status !== 'merged') AppView._loadVoteRoster(item.id);
  },

  _mountTopicThread() {
    const t = AppView._devTopic;
    const slot = document.getElementById('dev-topic-thread');
    if (!t || !slot || typeof GroupChat === 'undefined' || !GroupChat.mountThread) return;
    const typeMap = { issue: 'issue', proposal: 'session', gov: 'governance' };
    // A proposal that has left voting gets a read-only thread.
    let readOnly = false;
    let notice = '';
    if (t.kind === 'proposal') {
      const item = AppView._findTopicItem();
      if (item && item.status === 'merged') {
        readOnly = true;
        notice = 'Voting closed — this proposal was merged. The discussion is read-only.';
      }
    }
    GroupChat.mountThread({
      type: typeMap[t.kind],
      ref: t.id,
      container: slot,
      fullHeight: true,
      readOnly,
      notice,
    });
  },

  // Open a topic full-screen. Called by the cards' tap handler, the
  // Discussion buttons, and chat reference chips (revealInDrawer).
  openTopic(kind, id) {
    if (!kind || !id) return;
    if (typeof App !== 'undefined' && App.switchTab) {
      App.switchTab('dev', { kind, id }, 'topic');
    }
  },

  // ── Full-screen general chat sub-view ───────────────────────────────
  // A slim back-button header above the existing chat pane.
  // renderGroupChatTab mounts into #dev-chat-body exactly as it used to
  // mount into the pinned pane — spec side-panel, autocomplete, drafts,
  // and scroll restore all unchanged.
  _renderChatSubView(content) {
    content.innerHTML = `
      <div class="flex flex-col h-full min-h-0">
        <div class="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <button id="dev-chat-back" class="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-sm" title="Back to the dev page">&larr;</button>
          <span class="text-xs uppercase font-semibold text-zinc-500 dark:text-zinc-400 tracking-wider">General chat</span>
        </div>
        <div id="dev-chat-body" class="flex-1 min-h-0"></div>
      </div>`;

    document.getElementById('dev-chat-back').addEventListener('click', () => {
      App.switchTab('dev');
    });

    AppView.renderGroupChatTab();
    // Vote snapshot for the inline buttons on activity rows — needed
    // here explicitly since the card list's feed load (which also
    // builds it) doesn't run for a cold dev/chat deep link.
    if (AppView.appData) AppView.loadVoteState(AppView.appData.slug);
  },

  // ── App settings sub-page ───────────────────────────────────────────
  // The App secrets / display-name flows as a dedicated page (reached
  // from the "+" menu). Element ids are kept (#dc-edit-secrets /
  // #dc-secrets-state / #dc-edit-rename) so refreshDevChatSecretsState
  // and Secrets' post-save sync keep working unmodified. Secret-change
  // proposals start from the App secrets row — the Secrets modal
  // already routes non-admins into the vote-based proposal flow.
  _renderSettingsView(content) {
    const currentName = escapeHtml(AppView.appData?.name || '');
    content.innerHTML = `
      <div class="flex flex-col h-full min-h-0">
        <div class="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <button id="dev-settings-back" class="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-sm" title="Back to the dev page">&larr;</button>
          <span class="text-xs uppercase font-semibold text-zinc-500 dark:text-zinc-400 tracking-wider">App settings</span>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <div class="px-3 py-3 space-y-2">
            <button id="dc-edit-secrets"
              class="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 border border-zinc-200 dark:border-zinc-700 transition-colors text-left">
              <svg class="w-4 h-4 text-zinc-500 dark:text-zinc-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 7a4 4 0 014 4m-4-4a4 4 0 00-4 4 4 4 0 004 4 4 4 0 004-4 4 4 0 00-4-4zm-9.5 12.5L11 13"/></svg>
              <span class="flex-1 text-zinc-800 dark:text-zinc-200">App secrets</span>
              <span id="dc-secrets-state" class="text-xs text-zinc-400 dark:text-zinc-500">Loading…</span>
              <svg class="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            </button>
            <button id="dc-edit-rename"
              class="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 border border-zinc-200 dark:border-zinc-700 transition-colors text-left">
              <svg class="w-4 h-4 text-zinc-500 dark:text-zinc-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
              <span class="flex-1 text-zinc-800 dark:text-zinc-200">App display name</span>
              <span class="text-xs text-zinc-400 dark:text-zinc-500 truncate max-w-[40%]" title="${currentName}">${currentName}</span>
              <svg class="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            </button>
            <p class="text-xs text-zinc-500 dark:text-zinc-400 pt-1">
              Secret changes and renames are proposals — they apply once the app's
              users vote them in (admins can apply secrets directly).
            </p>
          </div>
        </div>
      </div>`;

    document.getElementById('dev-settings-back').addEventListener('click', () => {
      App.switchTab('dev');
    });
    document.getElementById('dc-edit-secrets').addEventListener('click', () => {
      if (window.Secrets) Secrets.openForCurrentApp();
    });
    document.getElementById('dc-edit-rename').addEventListener('click', () => {
      AppView.promptRename();
    });
    AppView.refreshDevChatSecretsState();
  },

  // ── "+" menu ────────────────────────────────────────────────────────
  _wirePlusMenu(content) {
    const btn = document.getElementById('dev-plus-btn');
    const menu = document.getElementById('dev-plus-menu');
    if (!btn || !menu) return;
    const close = () => {
      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.classList.toggle('hidden') === false;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // Outside-click dismiss, scoped to the dev view's lifetime (the
    // listener dies with the content innerHTML on the next render).
    content.addEventListener('click', (e) => {
      if (!e.target.closest('#dev-plus-menu, #dev-plus-btn')) close();
    });
    menu.querySelector('[data-plus="proposal"]').addEventListener('click', () => {
      close();
      AppView.createProposal();
    });
    menu.querySelector('[data-plus="issue"]').addEventListener('click', () => {
      close();
      AppView.openNewIssueModal();
    });
    menu.querySelector('[data-plus="settings"]').addEventListener('click', () => {
      close();
      App.switchTab('dev', null, 'settings');
    });
  },

  // Best-effort one-line preview of the latest general-chat message for
  // the chat card. A failed fetch leaves the static fallback line.
  async _loadChatCardPreview() {
    const el = document.getElementById('dev-chat-card-preview');
    if (!el || !AppView.appData) return;
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/messages?limit=1`);
      if (!res.ok) return;
      const { messages } = await res.json();
      const m = messages && messages[messages.length - 1];
      if (!m || !m.content) return;
      const live = document.getElementById('dev-chat-card-preview');
      if (!live) return;
      const who = m.username || 'System';
      live.textContent = `${who}: ${String(m.content).slice(0, 140)}`;
    } catch { /* keep the fallback line */ }
  },

  // Re-pull live data for the dev card list. Called from the WS event
  // handlers in app.js (vote_update / issue_update / session_update /
  // lock_changed). The feed re-render preserves the open accordion
  // card. The chat view only needs the vote snapshot refreshed; the
  // session and settings views have their own refresh paths.
  refreshDevData(kind) {
    if (!AppView.appData || typeof App === 'undefined' || App.currentTab !== 'dev') return;
    if (App.currentSubTab === 'chat') {
      AppView.loadVoteState(AppView.appData.slug);
      return;
    }
    if (App.currentSubTab === 'topic') {
      // Refresh the header card / roster in place; the mounted thread
      // is left alone (it receives live messages directly).
      AppView._loadDevData().then(() => AppView._renderTopicHead());
      return;
    }
    if (App.currentSubTab !== 'forum') return;
    AppView._loadDevFeed();
    if (kind === 'session' || kind === 'all') AppView._renderSessionsStrip();
  },

  // Fetch the vote snapshot (promoted + merged) that powers the inline
  // vote buttons on group-chat activity rows (AppView.voteState — see
  // group-chat.js refreshVoteControls). The chat sub-tab calls this in
  // place of the old full vote-panel load.
  async loadVoteState(slug) {
    try {
      const [promotedRes, mergedRes] = await Promise.all([
        fetch(`/api/apps/${slug}/promoted`),
        fetch(`/api/apps/${slug}/merged`),
      ]);
      const promotedData = promotedRes.ok ? await promotedRes.json() : { promoted: [] };
      const merged = mergedRes.ok ? (await mergedRes.json()).merged : [];
      const promoted = promotedData.promoted || [];
      // Promoted/merging fill in last so an open PR's live row always
      // wins over its merged snapshot.
      const voteRows = [...(merged || []), ...promoted];
      AppView.voteState = {
        bySession: Object.fromEntries(voteRows.map((pr) => [String(pr.id), pr])),
        byPrNumber: Object.fromEntries(
          voteRows.filter((pr) => pr.pr_number != null).map((pr) => [String(pr.pr_number), pr])
        ),
        majority: promotedData.majority || 1,
        activeUsers: promotedData.activeUsers || 1,
      };
      if (typeof GroupChat !== 'undefined' && GroupChat.refreshVoteControls) {
        GroupChat.refreshVoteControls();
      }
      return { promoted, merged, promotedData };
    } catch {
      return null;
    }
  },

  renderGroupChatTab() {
    // Card-list revision: general chat mounts into the full-screen chat
    // sub-view's body (falling back to the generic container for any
    // legacy caller).
    const content = document.getElementById('dev-chat-body') || AppView._devContainer();
    if (!content) return;

    // (#3) First-arrival framing: name what Group Chat is for. Group chat
    // is rarely empty (system messages), so a permanent banner would be
    // clutter — show it once per browser, then it disappears.
    const gcAppName = (AppView.appData && AppView.appData.name) ? AppView.appData.name : 'this app';
    let gcIntroHtml = '';
    try {
      if (!localStorage.getItem('usernode_seen_gc_intro')) {
        gcIntroHtml = `<div class="mx-3 mt-2 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-xs text-zinc-600 dark:text-zinc-300">This is where everyone using <span class="font-medium">${escapeHtml(gcAppName)}</span> talks and votes on proposed changes to it.</div>`;
        localStorage.setItem('usernode_seen_gc_intro', '1');
      }
    } catch { /* private-mode / disabled storage: just skip the intro */ }
    // Layout mirrors dev-chat's session view: a flex-row body that
    // holds the chat pane on the left and a slot for the spec
    // side-panel on the right. The slot is empty + display:none until
    // "View full spec" is clicked, so the chat occupies 100% width by
    // default. CSS toggles the side-panel layout vs. fullscreen-modal
    // layout based on viewport width. (#194: the old vote/issue panel
    // that sat above the chat is decomposed into the Issues and
    // Proposals sub-tabs — this tab is the message stream only.)
    content.innerHTML = `
      <div class="flex flex-col h-full">
        <div class="gc-tab-body flex-1 flex min-h-0">
          <div class="gc-chat-pane flex-1 flex flex-col min-h-0">
            ${gcIntroHtml}
            <!-- Messages -->
            <div id="gc-messages" class="flex-1 overflow-y-auto py-2 space-y-0.5"></div>

            <!-- Typing indicator -->
            <div id="gc-typing" class="px-3 text-xs text-zinc-500 h-5 shrink-0"></div>

            <!-- Input -->
            <div class="shrink-0 border-t border-zinc-200 dark:border-zinc-800 p-2">
              <!-- #15: "Replying to …" preview chip; populated by
                   GroupChat._renderQuotePreview when a quote is staged. -->
              <div id="gc-reply-preview" class="hidden"></div>
              <form id="gc-form" class="flex gap-2">
                <input
                  id="gc-input"
                  type="text"
                  maxlength="2000"
                  placeholder="Type a message..."
                  autocomplete="off"
                  class="flex-1 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                >
                <button type="submit" class="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors shrink-0">Send</button>
              </form>
            </div>
          </div>

          <!-- Draggable divider between chat pane and spec panel.
               CSS keeps it display:none until both
                 (a) .gc-spec-resizer-open is added (panel is open), and
                 (b) viewport >= 1024px (side-panel layout, not modal).
               GroupChat._initSpecPanelResizer wires a pointer-event
               drag handler that updates the panel inline width and
               persists the final value to localStorage. -->
          <div id="gc-spec-resizer" class="gc-spec-resizer" role="separator" aria-orientation="vertical" aria-label="Resize spec panel"></div>

          <!-- Spec side-panel slot. Lives empty in the DOM so a
               re-render of this tab doesn't tear down a panel the
               user has open. _showSpecPanel populates + toggles
               .gc-spec-side-panel-open; CSS handles the responsive
               side-panel-vs-fullscreen-modal switch at 1024px. -->
          <div id="gc-spec-side-panel" class="gc-spec-side-panel"></div>
        </div>
      </div>`;

    const gcInput = document.getElementById('gc-input');
    // Restore any in-progress draft. The input element is a new DOM node
    // on every tab switch, so we rehydrate from the persisted draft
    // (localStorage-backed, keyed by app slug) — this also survives full
    // page refreshes.
    const slugForDraft = AppView.appData?.slug;
    if (slugForDraft) {
      const saved = GroupChat.getDraft(slugForDraft);
      if (saved) gcInput.value = saved;
    }

    document.getElementById('gc-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const content = gcInput.value.trim();
      if (!content) return;
      GroupChat.send(content);
      gcInput.value = '';
      if (slugForDraft) GroupChat.setDraft(slugForDraft, '');
    });

    gcInput.addEventListener('input', () => {
      if (slugForDraft) GroupChat.setDraft(slugForDraft, gcInput.value);
      GroupChat.sendTyping();
    });

    // #87: @mention autocomplete. Re-attaches on every tab mount (the
    // input is a fresh DOM node each time). Its capture-phase keydown
    // handler intercepts Enter/Tab/Arrows/Escape while the dropdown is
    // open, so the form submit + the Escape-clears-reply handler below
    // only see those keys once the dropdown is closed.
    if (typeof MentionAutocomplete !== 'undefined') {
      MentionAutocomplete.attach(gcInput, slugForDraft);
    }

    // #130: PR# / # reference autocomplete (open PRs + open issues). Same
    // attach lifecycle as mentions; its capture-phase keydown only consumes
    // keys while its own menu is open, and the `@` vs `#` triggers are
    // mutually exclusive so the two menus never fight.
    if (typeof RefAutocomplete !== 'undefined') {
      RefAutocomplete.attach(gcInput, slugForDraft);
    }

    // #15: Escape clears a staged reply quote (when the input is empty so
    // we don't fight other Escape semantics mid-typing).
    gcInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && GroupChat.replyDraft && !gcInput.value) {
        e.preventDefault();
        GroupChat.clearQuote();
      }
    });

    if (AppView.appData) {
      // `mount` re-uses the existing WS + message cache when the user
      // comes back to this tab, preserving their scroll position; it only
      // opens a fresh connection on the first visit to an app.
      GroupChat.mount(AppView.appData.slug);
      // The inline vote buttons on activity rows read AppView.voteState,
      // which the forum's feed load (running right after this mount)
      // populates from the same /promoted + /merged data — no separate
      // fetch needed here.
    }
    // Re-render any staged reply preview (the composer DOM was just
    // recreated on this tab (re-)entry, but replyDraft persists).
    GroupChat._renderQuotePreview();
  },

  // ── Forum feed (#194 revision) ──────────────────────────────────────
  // One intermixed list — GitHub issues + PR proposals + governance
  // proposals — sorted by most recent activity (the item's own
  // timestamp vs. the latest message in its thread). Data comes from
  // the same four endpoints the old Issues/Proposals tabs used.

  // Fetch + cache everything the dev surfaces render from (the same
  // four endpoints the old tabs used): GitHub issues, governance
  // proposals, open PR proposals, merged PRs, plus voteState for the
  // chat's inline vote rows. Shared by the card list and the topic
  // sub-view. Returns false on a failed load.
  async _loadDevData() {
    if (!AppView.appData) return false;
    const slug = AppView.appData.slug;
    try {
      const [ghRes, issuesRes, promotedRes, mergedRes] = await Promise.all([
        fetch(`/api/apps/${slug}/github-issues`),
        fetch(`/api/apps/${slug}/issues`),
        fetch(`/api/apps/${slug}/promoted`),
        fetch(`/api/apps/${slug}/merged`),
      ]);
      const ghData = ghRes.ok ? await ghRes.json() : { issues: [] };
      const issuesData = issuesRes.ok ? await issuesRes.json() : { issues: [] };
      const promotedData = promotedRes.ok ? await promotedRes.json() : { promoted: [] };
      const merged = mergedRes.ok ? (await mergedRes.json()).merged : [];

      AppView._ghIssues = Array.isArray(ghData.issues) ? ghData.issues : [];
      AppView._ghIssuesMeta = {
        truncatedList: !!ghData.truncatedList,
        note: ghData.note || null,
        repoUrl: (AppView.appData && AppView.appData.repo_url) || null,
        myRemaining: typeof ghData.myRemaining === 'number' ? ghData.myRemaining : null,
      };
      // GitHub twins of open env-var proposals render as governance
      // cards only — keep their issue rows out of the feed (#131).
      AppView._envIssueNumbers = new Set(
        (issuesData.issues || [])
          .filter((i) => i.kind === 'secret_change')
          .map((i) => i.github_issue_number)
          .filter(Boolean)
      );

      const promoted = promotedData.promoted || [];
      const majority = promotedData.majority || 1;
      const activeUsers = promotedData.activeUsers || 1;
      const locked = !!promotedData.locked;

      // Shared inline-vote snapshot (same shape loadVoteState builds) so
      // the chat view's activity rows stay in sync without a refetch.
      const voteRows = [...(merged || []), ...promoted];
      AppView.voteState = {
        bySession: Object.fromEntries(voteRows.map((pr) => [String(pr.id), pr])),
        byPrNumber: Object.fromEntries(
          voteRows.filter((pr) => pr.pr_number != null).map((pr) => [String(pr.pr_number), pr])
        ),
        majority,
        activeUsers,
      };
      if (typeof GroupChat !== 'undefined' && GroupChat.refreshVoteControls) {
        GroupChat.refreshVoteControls();
      }

      AppView._proposals = promoted;
      AppView._govProposals = (issuesData.issues || [])
        .filter((i) => i.kind === 'secret_change' || i.kind === 'rename');
      AppView._proposalsCtx = {
        majority,
        activeUsers,
        locked,
        lockedHint: locked
          ? ' <span class="text-amber-500 font-normal">· locked: also needs an admin yes</span>'
          : '',
      };
      AppView._merged = merged;
      AppView._mergedCtx = { majority, activeUsers };
      return true;
    } catch {
      return false;
    }
  },

  async _loadDevFeed() {
    const ok = await AppView._loadDevData();
    const feedEl = document.getElementById('dev-feed');
    if (!feedEl) return;
    if (!ok) {
      feedEl.innerHTML = '<div class="text-xs text-zinc-500 dark:text-zinc-400">Couldn&#39;t load the feed right now.</div>';
      return;
    }
    AppView._renderLockedNotice();
    AppView._rerenderFeed();
    const mergedEl = document.getElementById('gc-merged');
    if (mergedEl) {
      mergedEl.innerHTML = (AppView._merged || []).length ? AppView._renderMergedInner() : '';
      if (window.Kudos) Kudos.attach(mergedEl);
    }
  },

  // Locked-app banner at the very top of the card list (above the
  // General chat card), per the card-list polish revision.
  _renderLockedNotice() {
    const el = document.getElementById('dev-locked-notice');
    if (!el) return;
    const locked = !!(AppView._proposalsCtx && AppView._proposalsCtx.locked);
    el.classList.toggle('hidden', !locked);
    el.innerHTML = locked
      ? '<div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-600 dark:text-amber-400">App is locked — an admin must approve any proposal before it applies.</div>'
      : '';
  },

  // The feed's display order: fixed groups — proposals being voted on
  // (PR promotions and governance proposals alike) above open issues —
  // and most-recent-activity-first within each group. Every item
  // carries a lastActivity sort key = max(its own timestamp, the
  // latest message in its thread). Ties keep the per-source order
  // (which preserves the #177 auto-solve-first ranking among quiet
  // issues). The general-chat card and the viewer's session rows sit
  // above this feed in the card list, so the full order the user sees
  // is: chat → sessions → proposals → issues.
  _feedItems() {
    const ts = (v) => {
      const t = Date.parse(v || '');
      return Number.isFinite(t) ? t : 0;
    };
    // Lower group renders first. Proposals (both kinds) share a group.
    const GROUP = { proposal: 0, gov: 0, issue: 1 };
    const items = [];
    for (const issue of AppView._visibleGhIssues()) {
      items.push({
        kind: 'issue', id: issue.number, item: issue,
        t: Math.max(ts(issue.updatedAt), ts(issue.lastMessageAt)),
      });
    }
    for (const pr of AppView._proposals || []) {
      items.push({
        kind: 'proposal', id: pr.id, item: pr,
        t: Math.max(ts(pr.promoted_at || pr.created_at), ts(pr.last_message_at)),
      });
    }
    for (const g of AppView._govProposals || []) {
      items.push({
        kind: 'gov', id: g.id, item: g,
        t: Math.max(ts(g.created_at), ts(g.last_message_at)),
      });
    }
    // Array.prototype.sort is stable, so equal keys keep source order.
    return items.sort((a, b) => (GROUP[a.kind] - GROUP[b.kind]) || (b.t - a.t));
  },

  _renderFeedInner() {
    const ctx = AppView._proposalsCtx || {};
    const meta = AppView._ghIssuesMeta || {};
    const items = AppView._feedItems();

    let html = '';
    if (!items.length) {
      const note = meta.note
        ? 'Couldn&#39;t load open issues right now. '
        : '';
      html += `<div class="text-xs text-zinc-500 dark:text-zinc-400 mb-2">${note}Nothing is open right now. Press <span class="font-medium text-violet-500">+</span> to propose a change or file an issue.</div>`;
      return html;
    }

    const shown = Math.min(AppView._feedShown || 20, items.length);
    html += '<div class="space-y-2">';
    for (let i = 0; i < shown; i++) {
      const it = items[i];
      if (it.kind === 'issue') html += AppView._renderIssueRow(it.item);
      else if (it.kind === 'proposal') html += AppView._renderProposalCard(it.item);
      else html += AppView._renderGovCard(it.item);
    }
    html += '</div>';

    // Keep the generating-state poller in sync with what we just
    // rendered (idempotent set/clear of one timer).
    AppView._syncHeadlessPolling();

    // Paging footer: more local items, or a GitHub link when the repo
    // has more open issues than the fetch ceiling.
    if (shown < items.length) {
      html += `<div class="mt-1"><button class="gc-vote-btn" onclick="AppView.showMoreFeed()">Show ${Math.min(10, items.length - shown)} more</button></div>`;
    } else if (meta.truncatedList && meta.repoUrl) {
      const issuesUrl = `${meta.repoUrl.replace(/\.git$/, '').replace(/\/$/, '')}/issues`;
      html += `<div class="mt-1"><a href="${issuesUrl}" target="_blank" rel="noopener" class="text-xs text-violet-400 hover:underline">More open issues on GitHub &rarr;</a></div>`;
    }
    return html;
  },

  // Re-render the feed in place from the cached data, then re-mount the
  // expanded card's thread + roster (innerHTML replacement wipes any
  // previous mount).
  _rerenderFeed() {
    const el = document.getElementById('dev-feed');
    if (!el) return;
    el.innerHTML = AppView._renderFeedInner();
    if (window.Kudos) Kudos.attach(el);
  },

  showMoreFeed() {
    AppView._feedShown = (AppView._feedShown || 20) + 10;
    AppView._rerenderFeed();
  },

  // ── Your-sessions strip ─────────────────────────────────────────────
  // The viewer's in-progress (active/paused, not-yet-promoted) sessions
  // on this app, as a compact chip row between the pinned chat and the
  // feed. Promoted sessions are absent here — they render as proposal
  // cards. Hidden when empty.
  async _renderSessionsStrip() {
    const el = document.getElementById('dev-sessions-strip');
    if (!el || !AppView.appData) return;
    const slug = AppView.appData.slug;
    try {
      const res = await fetch('/api/me/active-sessions');
      if (!res.ok) { el.innerHTML = ''; return; }
      const data = await res.json();
      // Most-recent-activity-first, matching the feed's within-group
      // order. last_activity_at folds in the latest session message;
      // older servers without it fall back to created_at.
      const actTs = (s) => {
        const t = Date.parse(s.last_activity_at || s.created_at || '');
        return Number.isFinite(t) ? t : 0;
      };
      const mine = (data.sessions || [])
        .filter((s) => s.app_slug === slug && (s.status === 'active' || s.status === 'paused'))
        .sort((a, b) => actTs(b) - actTs(a));
      // The container may have been replaced while the fetch was in
      // flight (tab switch) — re-resolve before painting.
      const live = document.getElementById('dev-sessions-strip');
      if (!live) return;
      if (!mine.length) { live.innerHTML = ''; return; }
      live.innerHTML = `
        <div class="space-y-2">
          ${mine.map((s) => {
            const label = escapeHtml(s.pr_title || s.branch_name || `Session #${s.id}`);
            const statusTag = s.busy
              ? '<span class="inline-flex items-center gap-1 text-xs text-emerald-500 shrink-0"><span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>working…</span>'
              : (s.status === 'paused' ? '<span class="text-xs text-zinc-500 shrink-0">paused</span>' : '');
            return `<button data-session-chip="${s.id}"
              class="${AppView.DEV_CARD_CLS} ${AppView.DEV_CARD_HOVER_CLS}"
              title="${s.busy ? 'AI is working — ' : ''}${label}">
              ${AppView._devCardIcon('session')}
              <span class="flex-1 min-w-0">
                <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">${label}</span>
                <span class="block text-xs text-zinc-500 dark:text-zinc-400 truncate">Your dev session</span>
              </span>
              ${statusTag}
              <svg class="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            </button>`;
          }).join('')}
        </div>`;
      live.querySelectorAll('[data-session-chip]').forEach((btn) => {
        btn.addEventListener('click', () => {
          App.switchTab('dev', parseInt(btn.dataset.sessionChip, 10), 'sessions');
        });
      });
    } catch {
      el.innerHTML = '';
    }
  },

  // Refresh the strip's busy indicators on a slow tick while the forum
  // is mounted; self-clears when the strip leaves the DOM.
  _syncStripPolling() {
    if (AppView._stripTimer) return;
    AppView._stripTimer = setInterval(() => {
      if (!document.getElementById('dev-sessions-strip')) {
        clearInterval(AppView._stripTimer);
        AppView._stripTimer = null;
        return;
      }
      AppView._renderSessionsStrip();
    }, 15000);
  },

  // The issue's body (GitHub markdown), rendered in the topic
  // sub-view between the header card and the thread.
  _issueBodyHtml(issue) {
    const renderMd = (typeof DevChat !== 'undefined' && DevChat.renderMarkdown)
      ? (s) => DevChat.renderMarkdown(s)
      : (s) => `<pre class="whitespace-pre-wrap font-sans">${escapeHtml(s)}</pre>`;
    return issue && issue.body && issue.body.trim()
      ? `<div class="dev-issue-body text-xs text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 mt-2">${renderMd(issue.body)}</div>`
      : '';
  },

  // "New issue" modal — title + description, posted to the existing
  // POST /api/apps/:slug/issues with kind='general' (which creates the
  // GitHub twin and announces to general chat).
  openNewIssueModal() {
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug) return;
    let root = document.getElementById('new-issue-modal');
    if (root) root.remove();
    root = document.createElement('div');
    root.id = 'new-issue-modal';
    root.className = 'fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-black/60';
    root.innerHTML = `
      <div data-modal-backdrop class="flex min-h-full items-center justify-center p-4">
        <div class="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-md shadow-xl relative">
          <h2 class="text-lg font-bold mb-3 text-zinc-900 dark:text-zinc-100">New issue</h2>
          <label class="block text-xs font-medium text-zinc-500 mb-1" for="new-issue-title">Title</label>
          <input id="new-issue-title" maxlength="200" autocomplete="off"
            class="w-full mb-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100"
            placeholder="Short summary of the problem or idea">
          <label class="block text-xs font-medium text-zinc-500 mb-1" for="new-issue-desc">Description <span class="text-zinc-400 font-normal">(optional)</span></label>
          <textarea id="new-issue-desc" rows="4" maxlength="5000"
            class="w-full mb-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100"
            placeholder="What's wrong, or what should the app do?"></textarea>
          <p id="new-issue-error" class="hidden text-xs text-red-400 mb-2"></p>
          <div class="flex justify-end gap-2">
            <button data-role="cancel" type="button"
              class="rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">Cancel</button>
            <button data-role="create" type="button"
              class="rounded-lg px-4 py-2 text-sm font-medium text-white bg-violet-600 hover:bg-violet-500 transition-colors">Create issue</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);
    const close = () => root.remove();
    root.querySelector('[data-role="cancel"]').addEventListener('click', close);
    root.addEventListener('click', (e) => {
      if (e.target === root || e.target.dataset.modalBackdrop !== undefined) close();
    });
    const createBtn = root.querySelector('[data-role="create"]');
    createBtn.addEventListener('click', async () => {
      const title = root.querySelector('#new-issue-title').value.trim();
      const description = root.querySelector('#new-issue-desc').value.trim();
      const err = root.querySelector('#new-issue-error');
      if (!title) {
        err.textContent = 'Title required';
        err.classList.remove('hidden');
        return;
      }
      createBtn.disabled = true;
      createBtn.textContent = 'Creating…';
      try {
        const res = await fetch(`/api/apps/${slug}/issues`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description, kind: 'general' }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        close();
        AppView.refreshDevData('issue');
      } catch (e2) {
        err.textContent = e2.message;
        err.classList.remove('hidden');
        createBtn.disabled = false;
        createBtn.textContent = 'Create issue';
      }
    });
    setTimeout(() => root.querySelector('#new-issue-title').focus(), 0);
  },

  // One PR-proposal card: line 1 is identity + info (icon chip, title,
  // PR meta, tally pill, badges), line 2 is the action pills (vote /
  // preview / kudos / Discussion / Open session). With { noNav: true }
  // (the topic sub-view's header card) the tap-to-open affordance and
  // Discussion button are dropped — you're already in the discussion.
  _renderProposalCard(pr, opts) {
    const noNav = !!(opts && opts.noNav);
    const ctx = AppView._proposalsCtx || {};
    const majority = ctx.majority || 1;
    const isMerging = pr.status === 'merging';
    const isMerged = pr.status === 'merged';
    let titleHtml;
    if (pr.revert_of_session_id) {
      const origLabel = pr.original_pr_title
        ? `${escapeHtml(pr.original_pr_title)}`
        : `PR #${pr.original_pr_number || pr.revert_of_session_id}`;
      titleHtml = `<span class="text-amber-500">↩ Revert of</span> ${origLabel}`;
    } else {
      titleHtml = pr.pr_title ? escapeHtml(pr.pr_title) : `Change by ${escapeHtml(pr.username || '')}`;
    }
    const metaParts = [
      `<a href="${pr.pr_url || '#'}" target="_blank" rel="noopener" class="font-mono text-violet-400 hover:underline">PR#${pr.pr_number || pr.id}</a>`,
      escapeHtml(pr.username || ''),
    ];
    if (pr.created_at) metaParts.push(escapeHtml(relTime(pr.created_at)));
    const closesPills = AppView.closesPillHtml(pr);

    const kudosBtn = window.Kudos ? Kudos.renderButton(pr, { compact: true }) : '';
    const isUnvoted = pr.status === 'promoted' && !pr.my_vote;
    const unvotedBadge = isUnvoted
      ? '<span class="inline-flex items-center gap-1 text-[0.65rem] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400 shrink-0" title="You haven\'t voted on this yet"><span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75 animate-ping"></span><span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-violet-500"></span></span>Vote</span>'
      : '';
    const stateBadge = isMerging ? AppView.mergingBadgeHtml()
      : isMerged ? AppView.mergedBadgeHtml() : '';
    // Sessions are owner-scoped (GET /api/sessions/:id), so the session
    // button only renders for the proposer.
    const chatN = parseInt(pr.chat_count) || 0;
    const sessionBtn = (App.user && pr.user_id === App.user.id)
      ? `<button class="gc-vote-btn" title="Open the dev session behind this proposal" onclick="AppView.openProposalSession(${pr.id})">Open session</button>`
      : '';
    // #195: before/after capture tiles so voters can judge a visual change
    // without opening the staging preview.
    const visualsHtml = AppView.visualsTilesHtml(pr.visuals);

    // Merged proposals (topic-view fallback) drop the live vote buttons —
    // the vote is settled; kudos stays open.
    const actions = (isMerged
      ? [kudosBtn, sessionBtn]
      : [AppView.voteButtonsHtml(pr), kudosBtn, sessionBtn]
    ).filter(Boolean).join('');

    return `
      <div class="gc-vote-item ${AppView.DEV_CARD_CLS}${noNav ? '' : ` ${AppView.DEV_CARD_HOVER_CLS}`}${isMerging ? ' opacity-70' : ''}"${isUnvoted ? ' data-unvoted="1"' : ''} data-ref-pr="${pr.pr_number || pr.id}"${noNav ? '' : ` data-proposal-row="${pr.id}" title="Open this proposal's discussion"`}>
        ${AppView._devCardIcon(isMerged ? 'done' : 'proposal')}
        <div class="flex-1 min-w-0">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div class="flex-1 min-w-0">
              <div class="text-sm text-zinc-800 dark:text-zinc-200 truncate">${titleHtml}</div>
              <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate">${metaParts.join(' · ')}${closesPills ? ` ${closesPills}` : ''}</div>
            </div>
            ${unvotedBadge}
            ${AppView.voteCountPill(pr, majority)}
            ${stateBadge}
            ${AppView._devChatBadge(chatN)}
          </div>
          ${visualsHtml ? `<div class="mt-1.5">${visualsHtml}</div>` : ''}
          ${actions ? `<div class="flex flex-wrap items-center gap-1.5 mt-1.5">${actions}</div>` : ''}
        </div>
        ${noNav ? '' : AppView.DEV_CARD_CHEVRON}
      </div>`;
  },

  // The proposal's details block (PR link, proposer, linked issues,
  // vote roster, locked note), rendered in the topic sub-view between
  // the header card and the thread.
  _proposalDetailsHtml(pr) {
    const ctx = AppView._proposalsCtx || {};
    const slug = AppView.appData ? AppView.appData.slug : '';
    const linked = (Array.isArray(pr.linked_issues) ? pr.linked_issues : [])
      .map((v) => (typeof v === 'number' ? v : Number(v)))
      .filter((n) => Number.isInteger(n) && n > 0);
    const chips = linked.map((n) =>
      `<a href="#app/${slug}/dev/issues/${n}" class="inline-flex items-center text-[0.65rem] font-medium font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20" title="Open issue #${n}">#${n}</a>`
    ).join(' ');
    const details = [];
    if (pr.pr_url) details.push(`<a href="${pr.pr_url}" target="_blank" rel="noopener" class="text-violet-400 hover:underline">View PR on GitHub</a>`);
    details.push(`proposed by <span class="font-medium">${escapeHtml(pr.username || '')}</span>`);
    if (pr.created_at) details.push(escapeHtml(relTime(pr.created_at)));
    const lockedNote = (ctx.locked && pr.status !== 'merged')
      ? '<div class="text-xs text-amber-500 mt-1">App is locked — this also needs at least one admin yes before it merges.</div>'
      : '';
    const roster = pr.status !== 'merged'
      ? `<div id="dev-vote-roster-${pr.id}" class="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Loading votes…</div>`
      : '';
    return `
      <div class="text-xs text-zinc-500 dark:text-zinc-400 mt-2 px-1">
        <div>${details.join(' · ')}</div>
        ${chips ? `<div class="mt-1 flex flex-wrap gap-1 items-center"><span>Linked issues:</span> ${chips}</div>` : ''}
        ${roster}
        ${lockedNote}
      </div>`;
  },

  // One governance card (env-var change, or a legacy rename row still
  // open from before renames moved to dapp.json PRs). Up/down controls
  // post to the existing /api/issues/:id/vote.
  _renderGovCard(issue, opts) {
    const noNav = !!(opts && opts.noNav);
    const ctx = AppView._proposalsCtx || {};
    const majority = ctx.majority || 1;
    const myVote = issue.my_vote;
    const upCount = parseInt(issue.up_count) || 0;
    const downCount = parseInt(issue.down_count) || 0;
    const isRename = issue.kind === 'rename';
    const titleText = isRename
      ? `Rename to "${(issue.payload && issue.payload.newName) || issue.title}"`
      : issue.title;
    const metaParts = ['Governance proposal'];
    if (issue.created_by_username) metaParts.push(escapeHtml(issue.created_by_username));
    if (issue.created_at) metaParts.push(escapeHtml(relTime(issue.created_at)));
    const tallyPill = AppView.voteCountPill({ yes_count: upCount, no_count: downCount }, majority);
    const yesBtn = `<button class="gc-vote-btn gc-vote-btn-yes${myVote === 'up' ? ' gc-vote-active' : ''}" onclick="AppView.castIssueVote(${issue.id}, 'up')">Yes (${upCount})</button>`;
    const noBtn = `<button class="gc-vote-btn gc-vote-btn-no${myVote === 'down' ? ' gc-vote-active' : ''}" onclick="AppView.castIssueVote(${issue.id}, 'down')">No (${downCount})</button>`;
    const adminBtn = (!isRename && App.user?.isAdmin)
      ? `<button class="gc-vote-btn gc-vote-btn-admin" title="Admin: apply this change right now, bypassing the vote majority" onclick="AppView.castIssueAdminApply(${issue.id})">Admin merge</button>`
      : '';
    const govChatN = parseInt(issue.chat_count) || 0;

    return `
      <div class="gc-vote-item ${AppView.DEV_CARD_CLS}${noNav ? '' : ` ${AppView.DEV_CARD_HOVER_CLS}`}" data-gov-row="${issue.id}"${issue.github_issue_number ? ` data-ref-issue="${issue.github_issue_number}"` : ''}${noNav ? '' : ' title="Open this proposal\'s discussion"'}>
        ${AppView._devCardIcon('gov')}
        <div class="flex-1 min-w-0">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div class="flex-1 min-w-0">
              <div class="text-sm text-zinc-800 dark:text-zinc-200 truncate" title="${escapeHtml(titleText)}">${escapeHtml(titleText)}</div>
              <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate">${metaParts.join(' · ')}</div>
            </div>
            ${tallyPill}
            ${AppView._devChatBadge(govChatN)}
          </div>
          <div class="flex flex-wrap items-center gap-1.5 mt-1.5">
            ${yesBtn}
            ${noBtn}
            ${adminBtn}
          </div>
        </div>
        ${noNav ? '' : AppView.DEV_CARD_CHEVRON}
      </div>`;
  },

  // Who voted yes/no on a PR proposal (GET /api/sessions/:id/votes),
  // painted into the expanded card.
  async _loadVoteRoster(sessionId) {
    const el = document.getElementById(`dev-vote-roster-${sessionId}`);
    if (!el) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/votes`);
      if (!res.ok) { el.textContent = ''; return; }
      const data = await res.json();
      const ctx = AppView._proposalsCtx || {};
      const fmt = (arr) => (arr && arr.length ? arr.map((u) => '@' + u).join(', ') : '—');
      el.innerHTML =
        `<span class="text-emerald-500 font-medium">Yes (${(data.yes || []).length}):</span> ${escapeHtml(fmt(data.yes))}`
        + ` &nbsp;<span class="text-red-400 font-medium">No (${(data.no || []).length}):</span> ${escapeHtml(fmt(data.no))}`
        + `<span class="text-zinc-500"> · needs ${ctx.majority || 1} of ${ctx.activeUsers || 1} active users</span>`;
    } catch {
      el.textContent = '';
    }
  },

  // "Create proposal" — proposals are PRs, and PRs come from dev
  // sessions, so this opens a fresh session on the Sessions sub-tab
  // with a one-line hint that promoting the session's PR creates the
  // proposal.
  // "Open session" on a proposal card — jump into the dev session
  // behind the proposal (proposer only; sessions are owner-scoped).
  openProposalSession(sessionId) {
    if (!sessionId) return;
    if (typeof App !== 'undefined' && App.switchTab) {
      App.switchTab('dev', sessionId, 'sessions');
    }
  },

  async createProposal() {
    if (!AppView.appData || typeof DevChat === 'undefined') return;
    const session = await DevChat.createSession(AppView.appData.slug);
    if (!session) return; // createSession already alerts (cap reached / error)
    AppView._proposalHint = true;
    if (typeof App !== 'undefined' && App.switchTab) {
      await App.switchTab('dev', session.id, 'sessions');
    }
  },

  // Small "💬 N" thread-message badge shared by issue rows and proposal
  // cards. Always rendered (even at 0) so live bumps have a target.
  _devChatBadge(count) {
    const n = parseInt(count) || 0;
    return `<span class="dev-chat-badge inline-flex items-center text-[0.65rem] font-medium px-1.5 py-0.5 rounded ${n ? 'bg-violet-500/10 text-violet-400' : 'bg-zinc-500/10 text-zinc-500'}" data-count="${n}" title="Messages in this thread">&#128172; ${n}</span>`;
  },

  // Live badge bump for a thread the viewer doesn't have open (called
  // from GroupChat when a threaded message arrives).
  bumpThreadBadge(type, ref) {
    let sel = null;
    if (type === 'issue') {
      const issue = (AppView._ghIssues || []).find((i) => i.number === ref);
      if (issue) issue.chatCount = (parseInt(issue.chatCount) || 0) + 1;
      sel = `[data-issue-row="${ref}"] .dev-chat-badge`;
    } else if (type === 'session') {
      const pr = (AppView._proposals || []).find((p) => p.id === ref);
      if (pr) pr.chat_count = (parseInt(pr.chat_count) || 0) + 1;
      sel = `[data-proposal-row="${ref}"] .dev-chat-badge`;
    } else if (type === 'governance') {
      const g = (AppView._govProposals || []).find((i) => i.id === ref);
      if (g) g.chat_count = (parseInt(g.chat_count) || 0) + 1;
      sel = `[data-gov-row="${ref}"] .dev-chat-badge`;
    }
    const el = sel && document.querySelector(sel);
    if (el) {
      const n = (parseInt(el.dataset.count) || 0) + 1;
      el.dataset.count = String(n);
      el.innerHTML = `&#128172; ${n}`;
      el.classList.remove('bg-zinc-500/10', 'text-zinc-500');
      el.classList.add('bg-violet-500/10', 'text-violet-400');
    }
  },

  // #130/#194: reveal a PR / issue reference (from a chat chip or a
  // notification) — opens the matching full-screen topic view. Falls
  // back to GitHub for PR numbers that aren't resolvable locally.
  revealInDrawer(type, number) {
    const n = parseInt(number, 10);
    if (!n || typeof App === 'undefined') return;

    if (type !== 'pr') {
      // Bare-# chips are issues first. A closed issue won't resolve in
      // the topic view, which falls back to the card list.
      AppView.openTopic('issue', n);
      return;
    }

    const st = AppView.voteState || {};
    const pr = (st.byPrNumber && st.byPrNumber[String(n)])
      || (st.bySession && st.bySession[String(n)]);
    if (pr) {
      // Open, merging, or merged — the topic view handles all three
      // (merged renders with a read-only thread).
      AppView.openTopic('proposal', pr.id);
      return;
    }

    // GitHub fallback — same repo_url normalization as before.
    const repo = AppView.appData && AppView.appData.repo_url;
    if (!repo) return;
    const base = repo.replace(/\.git$/, '').replace(/\/$/, '');
    window.open(`${base}/pull/${n}`, '_blank', 'noopener');
  },

  // #16: undo a merged PR. A single click opens a revert PR (like
  // proposing a change) which then needs the normal merge vote to land —
  // no separate undo-vote gate. Guarded by a ConfirmModal since it's a
  // concrete action (it creates a PR). The revert (clone + git revert +
  // push + PR create) runs server-side in the background and takes a few
  // seconds; the resulting revert PR appears via the WS vote_update
  // broadcast, which refreshes this panel.
  async undoPr(sessionId) {
    const key = `undo:${sessionId}`;
    if (AppView._voteInFlight.has(key)) return;
    const ok = await ConfirmModal.show({
      title: 'Undo this merge?',
      message:
        'This opens a revert PR that backs out this merged change.\n\n'
        + 'It still needs a merge vote to land — undoing is a proposal the group votes on, just like any other change.',
      confirmLabel: 'Open revert PR',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    AppView._voteInFlight.add(key);
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        // 409 means a revert is already in flight, or eligibility was
        // lost between render and click. Show the message and re-fetch
        // so the UI reflects reality.
        alert(data.error || `Undo failed (HTTP ${resp.status}).`);
      }
      AppView.refreshDevData('vote');
    } catch (err) {
      alert(`Undo failed: ${err.message}`);
    } finally {
      AppView._voteInFlight.delete(key);
    }
  },

  // Admin force-apply for an env-var (secret_change) proposal: bypass the
  // active-user vote majority and apply the change right now. Gated
  // server-side by /api/issues/:id/admin-apply (admin-only). Mirrors
  // castAdminMerge's ConfirmModal misclick guard — the button sits inline
  // with the regular Yes/No buttons.
  async castIssueAdminApply(issueId) {
    if (!App.user?.isAdmin) return;
    const key = `issue-admin-apply:${issueId}`;
    if (AppView._voteInFlight.has(key)) return;
    const ok = await ConfirmModal.show({
      title: 'Apply this env-var change now?',
      message:
        'This bypasses the active-user vote majority and applies the proposed secret change right now (the app redeploys with the new value).\n\n'
        + 'Use only when you\'re confident the change should ship — the override is announced in group chat with your username.',
      confirmLabel: 'Apply now',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    AppView._voteInFlight.add(key);
    try {
      const resp = await fetch(`/api/issues/${issueId}/admin-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        alert(data.error || `Admin apply failed (HTTP ${resp.status}).`);
      }
      AppView.refreshDevData('vote');
    } catch (err) {
      alert(`Admin apply failed: ${err.message}`);
    } finally {
      AppView._voteInFlight.delete(key);
    }
  },

  // ---- Open Issues section ------------------------------------------------

  // The Open Issues list exactly as rendered: env-var-proposal twins
  // filtered out (#131 — those rows render in the dedicated Environment
  // variables section), then sorted so issues with a live auto-solve
  // session float to the top (#177): ongoing ('generating') first,
  // finished ('ready') next, everything else after. Within each group the
  // fetch order (GitHub updated-desc) is preserved — sort() is stable and
  // runs on the filter copy, so _ghIssues itself keeps the canonical fetch
  // order. Sorting happens here at render time (not server-side) because
  // the optimistic auto-solve start and the headless poller both mutate
  // `headless` in place and re-render without refetching. Paging
  // The feed renderer and the open-card index lookup must both use
  // this helper so paging counts match what's on screen.
  _visibleGhIssues() {
    const rank = (i) => {
      const s = i.headless && i.headless.status;
      return s === 'generating' ? 0 : s === 'ready' ? 1 : 2;
    };
    return (AppView._ghIssues || [])
      .filter((i) => !(AppView._envIssueNumbers && AppView._envIssueNumbers.has(i.number)))
      .sort((a, b) => rank(a) - rank(b));
  },

  // One issue row for the forum feed, with everything the old Open
  // Issues section rendered per row (bounty/kudos, Create PR, the
  // Auto-solve state machine, Preview, creator attribution) plus the
  // accordion expansion into the issue body + thread chat.
  _renderIssueRow(issue, opts) {
    const noNav = !!(opts && opts.noNav);
    const meta = AppView._ghIssuesMeta || {};
    const budgetSpent = meta.myRemaining === 0;
    let html = '';

    const n = issue.number;
    const href = issue.htmlUrl || '#';
    // The GitHub label pill is intentionally not rendered for now — every
    // open issue currently carries the same `usernode` label, so the badge
    // added noise without distinguishing rows. See _renderOpenIssuesInner
    // history if label display is reintroduced.
    const bountyPill = issue.bounty_count
      ? `<span class="inline-flex items-center text-[0.65rem] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500" title="Kudos bounties pledged on this issue">&#9733; ${issue.bounty_count}</span>`
      : '';
    // "Give kudos" disables once the viewer has an open bounty here or has
    // spent their shared weekly allowance.
    const kudosDisabled = issue.my_bounty || budgetSpent;
    const kudosTitle = issue.my_bounty
      ? 'You already placed a bounty on this issue'
      : (budgetSpent ? 'Weekly kudos allowance spent' : 'Pledge a kudos bounty — paid to whoever\'s merged PR closes this issue');
    const kudosBtn = `<button class="gc-vote-btn"${kudosDisabled ? ' disabled' : ''} title="${kudosTitle}" onclick="AppView.giveIssueBounty(${n})">${issue.my_bounty ? '&#9733; Bountied' : 'Pledge kudos'}</button>`;
    const createBtn = `<button class="gc-vote-btn" title="Start a dev chat to solve this issue" onclick="AppView.createPrForIssue(${n})">Create PR</button>`;
    // #155: headless auto-session button. Four states driven by the
    // issue's `headless` field from /github-issues:
    //   none/failed → "Auto-solve" (opens the confirm + model popup)
    //   generating  → disabled progress label
    //   ready       → contextual clone-for-me label by outcome (#168):
    //                 "Review spec / Review solution / Answer question
    //                 & start session", generic fallback otherwise
    //   ready + viewer already cloned (mySessionId, #172) → "Go to
    //                 session", navigating to their derived session
    //                 instead of offering a second clone
    const h = issue.headless;
    let autoBtn;
    if (h && h.status === 'generating') {
      autoBtn = `<button class="gc-vote-btn" disabled title="A headless AI session is working on this issue${h.username ? ` (started by ${escapeAttr(h.username)})` : ''}">Generating auto-solve&hellip;</button>`;
    } else if (h && h.status === 'ready') {
      // #183: a code/spec_code run with a live preview gets the
      // changes-ready treatment — label + a Preview button that opens
      // the auto run's staging (plain open, same overlay as PR rows).
      // stagingUrl is nulled when the preview is GC'd, so the row
      // degrades back to the plain outcome wording.
      const hasPreview = !!h.stagingUrl && (h.outcome === 'code' || h.outcome === 'spec_code');
      const previewBtn = hasPreview
        ? `<button class="gc-vote-btn gc-vote-btn-preview" title="Open the auto-solve staging preview" onclick="AppView.swapToStagingForSession(${h.sessionId}, '${h.stagingUrl}')">Preview</button>`
        : '';
      if (h.mySessionId) {
        autoBtn = `${previewBtn}<button class="gc-vote-btn" title="You already started a session from this auto session — open it" onclick="AppView.goToAutoSessionClone(${h.mySessionId})">Go to session</button>`;
      } else {
        const outcomeNote = h.outcome === 'spec' ? 'it drafted a spec'
          : h.outcome === 'code' ? 'it pushed a code change'
          : h.outcome === 'spec_code' ? 'it drafted a spec and pushed a code change'
          : 'it has a question for you';
        const autoLabel = hasPreview ? 'Changes ready &mdash; review &amp; start session'
          : h.outcome === 'spec' ? 'Review spec &amp; start session'
          : h.outcome === 'code' ? 'Review solution &amp; start session'
          : h.outcome === 'question' ? 'Answer question &amp; start session'
          : 'Start session from auto session';
        autoBtn = `${previewBtn}<button class="gc-vote-btn" title="Clone the finished auto session (${outcomeNote}) into your own dev chat — others can clone it too" onclick="AppView.startFromAutoSession(${h.sessionId})">${autoLabel}</button>`;
      }
      // #150: a question outcome doesn't block re-running — answer the
      // questions on the issue, then press Auto-solve again and the new
      // run reads the answers. Both paths stay available (whether or not
      // the viewer already cloned this run).
      if (h.outcome === 'question') {
        autoBtn += `<button class="gc-vote-btn" title="Questions were posted on the issue — answer them, then run auto-solve again" onclick="AppView.confirmAutoSession(${n})">Auto-solve</button>`;
      }
    } else {
      autoBtn = `<button class="gc-vote-btn" title="Spin up a headless AI session that starts solving this issue on its own — uses your credits" onclick="AppView.confirmAutoSession(${n})">Auto-solve</button>`;
    }
    // #133: the creating user renders in the meta line below the title.
    // created_by_username comes from the /github-issues route (local
    // issues table → body Source line → GitHub login); omitted when the
    // creator couldn't be resolved.
    const rowTitle = issue.created_by_username
      ? `${issue.title} · ${issue.created_by_username}`
      : issue.title;

    html += `
      <div class="gc-vote-item ${AppView.DEV_CARD_CLS}${noNav ? '' : ` ${AppView.DEV_CARD_HOVER_CLS}`}" data-ref-issue="${n}"${noNav ? '' : ` data-issue-row="${n}" title="Open this issue's discussion"`}>
        ${AppView._devCardIcon('issue')}
        <div class="flex-1 min-w-0">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div class="flex-1 min-w-0">
              <div class="text-sm text-zinc-800 dark:text-zinc-200 truncate" title="${escapeHtml(rowTitle)}">${escapeHtml(issue.title)}</div>
              <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate"><a href="${href}" target="_blank" rel="noopener" class="font-mono text-violet-400 hover:underline">#${n}</a>${issue.created_by_username ? ` · ${escapeHtml(issue.created_by_username)}` : ''}</div>
            </div>
            ${bountyPill}
            ${AppView._devChatBadge(issue.chatCount)}
          </div>
          <div class="flex flex-wrap items-center gap-1.5 mt-1.5">
            ${kudosBtn}
            ${createBtn}
            ${autoBtn}
          </div>
        </div>
        ${noNav ? '' : AppView.DEV_CARD_CHEVRON}
      </div>`;
    return html;
  },

  // ---- Merged (closed) PRs section ----------------------------------------

  // #149: only the first 3 closed PRs render by default; the rest sit behind
  // a show-more toggle, mirroring the Open Issues pattern above.
  _mergedShownDefault: 3,

  // Build the inner HTML for the Merged section from the cached
  // AppView._merged list. Rendered once inside loadVotePanel's bodyHtml and
  // re-rendered in place (into #gc-merged) by toggleMergedPrs so the
  // show-more/show-less toggle needs no refetch.
  _renderMergedInner() {
    const merged = AppView._merged || [];
    const { majority, activeUsers } = AppView._mergedCtx || { majority: 1, activeUsers: 1 };
    const shown = AppView._mergedExpanded
      ? merged.length
      : Math.min(AppView._mergedShownDefault, merged.length);

    let html = `<div class="text-xs uppercase font-semibold text-zinc-500 dark:text-zinc-400 tracking-wider mb-1">Completed</div><div class="space-y-2">`;
    for (let i = 0; i < shown; i++) {
      const pr = merged[i];
      const date = new Date(pr.created_at).toLocaleDateString();
      const mergedLabel = pr.pr_title
        ? `${escapeHtml(pr.pr_title)} <span class="text-zinc-500">· ${escapeHtml(pr.username)}</span>`
        : `by ${escapeHtml(pr.username)}`;
      const mergedQuoteTitle = pr.pr_title || `PR #${pr.pr_number || pr.id}`;
      // Merged PRs are still eligible for kudos (promoted + merging
      // + merged) — that's intentional. People often come back to
      // a recently-merged PR and want to thank the author.
      const kudosBtn = window.Kudos
        ? Kudos.renderButton(pr, { compact: true })
        : '';

      // #16: undo is a single direct action — clicking Undo opens a
      // revert PR (like proposing a change) which then needs the
      // normal merge vote to land. The button only renders on
      // ordinary merged PRs that don't already have a revert in
      // flight or merged:
      //   - revert_of_session_id != null on this row means this
      //     row IS itself a revert PR; undoing a revert would
      //     create an infinite undo-undo loop.
      //   - revert_session_id (from the LEFT JOIN) means a revert
      //     PR already exists pointing at this row — show its
      //     status as a label instead.
      let undoUI = '';
      if (pr.revert_of_session_id) {
        // This row is a revert PR. (Shouldn't appear in the
        // merged list often — revert PRs are short-lived in
        // 'promoted' before they themselves merge — but show a
        // breadcrumb if they do.)
        undoUI = `<span class="text-xs text-zinc-500" title="This PR is itself a revert">↩ revert</span>`;
      } else if (pr.revert_session_id) {
        const rs = pr.revert_status;
        const rpr = pr.revert_pr_number || pr.revert_session_id;
        const label = rs === 'merged'
          ? `Undone by PR#${rpr}`
          : rs === 'merging'
            ? `Revert merging (PR#${rpr})`
            : `Revert in vote · PR#${rpr}`;
        const linkHref = pr.revert_pr_url || '#';
        undoUI = `<a href="${linkHref}" target="_blank" class="text-xs text-amber-500 hover:text-amber-400 font-medium">${label}</a>`;
      } else {
        undoUI = `
          <button class="gc-vote-btn gc-vote-btn-undo"
            title="Open a revert PR for this merge. It still needs a merge vote to land."
            onclick="AppView.undoPr(${pr.id})">Undo</button>`;
      }

      html += `
        <div class="gc-vote-item ${AppView.DEV_CARD_CLS}" data-ref-pr="${pr.pr_number || pr.id}">
          ${AppView._devCardIcon('done')}
          <div class="flex-1 min-w-0">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <div class="flex-1 min-w-0">
                <div class="text-sm text-zinc-800 dark:text-zinc-200 truncate" title="${escapeHtml(mergedQuoteTitle)}">${mergedLabel}</div>
                <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate"><a href="${pr.pr_url || '#'}" target="_blank" rel="noopener" class="font-mono text-emerald-400 hover:underline">PR#${pr.pr_number || pr.id}</a> · ${date}${AppView.closesPillHtml(pr) ? ` ${AppView.closesPillHtml(pr)}` : ''}</div>
              </div>
              ${AppView.voteCountPill(pr, majority)}
            </div>
            <div class="flex flex-wrap items-center gap-1.5 mt-1.5">
              ${AppView.voteButtonsHtml(pr, { collapseVoted: true })}
              ${undoUI}
              ${kudosBtn}
            </div>
          </div>
        </div>`;
    }
    html += '</div>';

    // Show-more / show-less footer, same styling as the Open Issues pager.
    if (merged.length > AppView._mergedShownDefault) {
      const label = AppView._mergedExpanded
        ? 'Show less'
        : `Show ${merged.length - shown} more`;
      html += `<div class="mt-1"><button class="gc-vote-btn" onclick="AppView.toggleMergedPrs()">${label}</button></div>`;
    }
    return html;
  },

  // Expand / collapse the Merged section in place (no panel reload).
  toggleMergedPrs() {
    AppView._mergedExpanded = !AppView._mergedExpanded;
    const el = document.getElementById('gc-merged');
    if (el) el.innerHTML = AppView._renderMergedInner();
  },

  // "Give kudos" — pledge a bounty on a GitHub issue. Debits the shared
  // weekly kudos allowance server-side; optimistically bumps the local count
  // and disables the button on success.
  async giveIssueBounty(issueNumber) {
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug) return;
    const key = `bounty:${issueNumber}`;
    if (AppView._bountyInFlight.has(key)) return;
    AppView._bountyInFlight.add(key);
    try {
      const resp = await fetch(`/api/apps/${slug}/issues/${issueNumber}/bounty`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        alert(data.error || `Couldn't place bounty (HTTP ${resp.status}).`);
        return;
      }
      // Reflect the new state locally: mark this issue bountied, set its
      // count from the server, and update the remaining-allowance gate.
      const issue = (AppView._ghIssues || []).find((i) => i.number === issueNumber);
      if (issue) {
        issue.my_bounty = true;
        issue.bounty_count = typeof data.bountyCount === 'number' ? data.bountyCount : (issue.bounty_count || 0) + 1;
      }
      if (typeof data.remaining === 'number') AppView._ghIssuesMeta.myRemaining = data.remaining;
      AppView._rerenderFeed();
    } catch (err) {
      alert(`Couldn't place bounty: ${err.message}`);
    } finally {
      AppView._bountyInFlight.delete(key);
    }
  },

  // "Create PR" — spin up a fresh dev chat for this issue and seed the first
  // turn with the issue's number/title/body so the Mayor links it
  // (addresses_issues → linked_issues → `Closes #N`) and solves it. Mirrors
  // DevChat.startNewChange's create→open→render flow, then sends the seed.
  async createPrForIssue(issueNumber) {
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug || typeof DevChat === 'undefined') return;
    const issue = (AppView._ghIssues || []).find((i) => i.number === issueNumber);

    const session = await DevChat.createSession(slug);
    if (!session) return; // createSession already alerts (cap reached / error)

    // Land on the Dev Chat tab focused on the new session. switchTab
    // ('individual-chat') → renderDevChatTab(sessionId) opens the session,
    // renders the chat view, and syncs the hash for us.
    if (typeof App !== 'undefined' && App.switchTab) {
      await App.switchTab('dev', session.id, 'sessions');
    }

    // Seed the first turn so the Mayor links the issue (addresses_issues →
    // linked_issues → `Closes #N`) and solves it. Naming the number is what
    // drives the merge-time bounty payout.
    const title = issue ? issue.title : '';
    const body = issue && issue.body ? `\n\n${issue.body}` : '';
    const seed =
      `Please implement GitHub issue #${issueNumber}: "${title}".${body}\n\n`
      + `Open a PR that closes this issue (include "Closes #${issueNumber}" so it links and closes the issue on merge).`;
    if (typeof DevChat.sendMessage === 'function') DevChat.sendMessage(seed);
  },

  // ---- Headless auto sessions (#155) --------------------------------------

  _headlessPollTimer: null,

  // "Auto-solve" — confirmation popup (token warning + model selector)
  // before spinning up a headless AI session on this issue. The session is
  // billed to the clicking user but isn't attached to their dev chat.
  async confirmAutoSession(issueNumber) {
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug) return;

    // Model list comes from the same GET /api/models the dev-chat dropdown
    // uses, so the popup can never offer a model the server would reject.
    let models = [];
    let defaultModel = '';
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      models = Array.isArray(data.models) ? data.models : [];
      defaultModel = data.default || (models[0] && models[0].id) || '';
    } catch {
      alert("Couldn't load the model list — try again.");
      return;
    }
    const stored = localStorage.getItem('usernode:dc:model');
    const preselect = models.some((m) => m.id === stored) ? stored : defaultModel;

    const choice = await AppView._showAutoSessionModal(issueNumber, models, preselect);
    if (!choice) return;

    try {
      const resp = await fetch(`/api/apps/${slug}/issues/${issueNumber}/headless-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: choice }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        alert(data.error || `Couldn't start the auto session (HTTP ${resp.status}).`);
        return;
      }
      const issue = (AppView._ghIssues || []).find((i) => i.number === issueNumber);
      if (issue) issue.headless = { sessionId: data.session.id, status: 'generating' };
      AppView._rerenderFeed();
    } catch (err) {
      alert(`Couldn't start the auto session: ${err.message}`);
    }
  },

  // Singleton confirm popup for Auto-solve. Same scrim/card styling as
  // ConfirmModal (confirm-modal.js) plus a model <select>; resolves to the
  // chosen model id, or null on cancel/backdrop/Esc.
  _showAutoSessionModal(issueNumber, models, preselect) {
    let root = document.getElementById('auto-session-modal');
    if (root) root.remove();
    root = document.createElement('div');
    root.id = 'auto-session-modal';
    root.className = 'fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-black/60';
    const options = models.map((m) =>
      `<option value="${escapeAttr(m.id)}"${m.id === preselect ? ' selected' : ''}>${escapeHtml(m.label || m.id)}</option>`
    ).join('');
    root.innerHTML = `
      <div data-modal-backdrop class="flex min-h-full items-center justify-center p-4">
        <div class="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-md shadow-xl relative">
          <h2 class="text-lg font-bold mb-2 text-zinc-900 dark:text-zinc-100">Start auto session for issue #${issueNumber}?</h2>
          <p class="text-sm text-zinc-600 dark:text-zinc-400 mb-3">
            This spins up a <b>headless AI session</b> that immediately starts working on the
            issue on its own — investigating the repo and drafting a spec, pushing a code
            change, or coming back with a question. When the drafted spec looks
            straightforward, the session <b>may also implement it</b> in the same run
            (committing and pushing to its own branch — never a PR or deploy). It is not
            connected to your dev chat, but it <b>will automatically use your
            tokens/credits</b> the moment you confirm.
          </p>
          <p class="text-xs text-amber-500 mb-4">
            Experimental — not recommended for normal users at the moment. Costs are billed
            to you even if the result isn't useful.
          </p>
          <label class="block text-xs font-medium text-zinc-500 mb-1" for="auto-session-model">Model</label>
          <select id="auto-session-model"
            class="w-full mb-5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100">
            ${options}
          </select>
          <div class="flex justify-end gap-2">
            <button data-role="cancel" type="button"
              class="rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">Cancel</button>
            <button data-role="confirm" type="button"
              class="rounded-lg px-4 py-2 text-sm font-medium text-white bg-violet-600 hover:bg-violet-500 transition-colors">Start auto session</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);

    return new Promise((resolve) => {
      let settled = false;
      const cleanup = (result) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        root.remove();
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
      };
      root.querySelector('[data-role="cancel"]').addEventListener('click', () => cleanup(null));
      root.querySelector('[data-role="confirm"]').addEventListener('click', () => {
        const sel = root.querySelector('#auto-session-model');
        cleanup((sel && sel.value) || null);
      });
      root.addEventListener('click', (e) => {
        if (e.target === root || e.target.dataset.modalBackdrop !== undefined) cleanup(null);
      });
      document.addEventListener('keydown', onKey, true);
    });
  },

  // "Start session from auto session" — clone the finished headless session
  // (chat history + spec + branch + CC memory) into a dev chat owned by the
  // clicking user, then land them in it. Any number of users can do this
  // independently; each clone gets its own branch and PR path.
  async startFromAutoSession(headlessSessionId) {
    if (typeof DevChat === 'undefined') return;
    try {
      const resp = await fetch(`/api/sessions/${headlessSessionId}/clone-headless`, { method: 'POST' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        alert(data.error || `Couldn't start a session from the auto session (HTTP ${resp.status}).`);
        return;
      }
      // #172: remember the clone locally so a back-navigation to the
      // issues panel shows "Go to session" before the next refetch. The
      // server's headless.mySessionId is the source of truth on every
      // re-render/poll.
      for (const issue of AppView._ghIssues || []) {
        if (issue.headless && issue.headless.sessionId === headlessSessionId) {
          issue.headless.mySessionId = data.session.id;
        }
      }
      DevChat.sessions.unshift(data.session);
      if (typeof App !== 'undefined' && App.switchTab) {
        await App.switchTab('dev', data.session.id, 'sessions');
      }
    } catch (err) {
      alert(`Couldn't start a session from the auto session: ${err.message}`);
    }
  },

  // #172: "Go to session" — the viewer already cloned this auto session,
  // so navigate to their existing derived session instead of cloning
  // again. No DevChat.sessions.unshift needed: the switchTab path reloads
  // the session list itself before opening the session.
  async goToAutoSessionClone(sessionId) {
    if (typeof DevChat === 'undefined') return;
    if (typeof App !== 'undefined' && App.switchTab) {
      await App.switchTab('dev', sessionId, 'sessions');
    }
  },

  // While any rendered issue shows a generating auto session, poll the
  // issues endpoint so the button flips to its outcome-specific "Review
  // … & start session" label (or back to Auto-solve on failure) without
  // a manual refresh.
  _syncHeadlessPolling() {
    const generating = (AppView._ghIssues || []).some(
      (i) => i.headless && i.headless.status === 'generating'
    );
    if (!generating) {
      if (AppView._headlessPollTimer) {
        clearInterval(AppView._headlessPollTimer);
        AppView._headlessPollTimer = null;
      }
      return;
    }
    if (AppView._headlessPollTimer) return;
    AppView._headlessPollTimer = setInterval(async () => {
      const slug = AppView.appData && AppView.appData.slug;
      if (!slug || !document.getElementById('dev-feed')) {
        clearInterval(AppView._headlessPollTimer);
        AppView._headlessPollTimer = null;
        return;
      }
      try {
        const res = await fetch(`/api/apps/${slug}/github-issues`);
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data.issues)) return;
        // Merge just the headless field — bounty state may have optimistic
        // local updates we don't want a poll to clobber.
        const byNumber = new Map(data.issues.map((i) => [i.number, i.headless || null]));
        for (const issue of AppView._ghIssues || []) {
          if (byNumber.has(issue.number)) issue.headless = byNumber.get(issue.number);
        }
        AppView._rerenderFeed();
      } catch {}
    }, 8000);
  },

  // Core PR voting controls (Preview / Yes / No / Admin-merge) as an HTML
  // string. Shared by the vote panel rows and the inline buttons on
  // group-chat activity rows (group-chat.js) so the two never diverge.
  // Expects a `pr` row from /promoted (id, status, staging_url, my_vote,
  // yes_count, no_count). Admin merge only renders for admins.
  // Rounded "yes / majority" tally pill, white-filled with a state-colored
  // outline: purple while neither side has enough votes, green once Yes hits
  // majority, red once No hits it. Shared by the vote panel rows and the
  // inline group-chat activity rows so the two never diverge.
  voteCountPill(pr, majority) {
    if (!pr) return '';
    // #58: for merged PRs prefer the threshold snapshotted at merge time
    // (votes_required) so the denominator reflects history rather than the
    // live majority. Open PRs (and legacy merged rows with no snapshot) fall
    // back to the live majority passed in.
    const snap = parseInt(pr.votes_required);
    const hasSnap = Number.isFinite(snap) && snap > 0;
    const maj = hasSnap ? snap : (majority || 1);
    const yes = parseInt(pr.yes_count) || 0;
    const no = parseInt(pr.no_count) || 0;
    const state = yes >= maj ? 'yes' : no >= maj ? 'no' : 'pending';
    // #58: when both at-merge figures are present, surface the historical
    // context as a hover tooltip on the pill. Only merged rows carry these.
    const activeAtMerge = parseInt(pr.active_users_at_merge);
    const titleAttr = (hasSnap && Number.isFinite(activeAtMerge) && activeAtMerge > 0)
      ? ` title="needed ${snap} of ${activeAtMerge} active users at merge time"`
      : '';
    let fills;
    if (state === 'yes' || state === 'no') {
      // Finalized: a side reached majority — the whole pill fills solid with
      // the winning side's color (green = Yes, red = No).
      fills = `<span class="gc-vote-fill gc-vote-fill-full gc-vote-fill-full-${state}"></span>`;
    } else {
      // In progress: top stripe = Yes share, bottom stripe = No share, each a
      // fraction of the majority threshold, filling left→right.
      const yesPct = Math.min(100, (yes / maj) * 100);
      const noPct = Math.min(100, (no / maj) * 100);
      fills = `<span class="gc-vote-fill gc-vote-fill-yes" style="width:${yesPct}%"></span>`
        + `<span class="gc-vote-fill gc-vote-fill-no" style="width:${noPct}%"></span>`;
    }
    return `<span class="gc-vote-count gc-vote-count-${state}"${titleAttr}>`
      + fills
      + `<span class="gc-vote-count-label">${yes} / ${maj}</span>`
      + `</span>`;
  },

  // "Merging…" badge shown alongside (not instead of) the vote controls
  // once a PR crosses the threshold and the merge pipeline is in flight.
  // Shared by the vote panel rows and the inline group-chat rows.
  mergingBadgeHtml() {
    return `<span class="gc-merging-badge"><span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>Merging…</span>`;
  },

  // "Merged" badge — the settled counterpart of the merging badge, shown
  // next to the (now read-only) tally pill / "You voted X" box on group-chat
  // rows after a PR lands so the voting info doesn't disappear.
  mergedBadgeHtml() {
    return `<span class="gc-merged-badge">✓ Merged</span>`;
  },

  // #195: before/after visual tiles for a session's stored capture
  // artifacts. `visuals` is the server shape { before: {png,webm,gif},
  // after: {...} } of /visuals/:id tokens. Shared by the vote-panel PR
  // rows here and the dev-chat staging card (which calls through
  // window.AppView). Webm plays as a silent loop with the PNG as poster;
  // PNG-only sets render a plain image. Click opens full size in a new
  // tab. Deliberately dedicated DOM — the markdown sanitizer's whitelist
  // stays untouched (<img>/<video> remain stripped from chat markdown).
  visualsTilesHtml(visuals) {
    if (!visuals) return '';
    const idOk = (id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
    const tile = (label, v) => {
      if (!v) return '';
      const png = idOk(v.png) ? v.png : null;
      const webm = idOk(v.webm) ? v.webm : null;
      const gif = idOk(v.gif) ? v.gif : null;
      if (!png && !webm && !gif) return '';
      const mediaStyle = 'display:block;width:100%;max-height:160px;object-fit:contain;object-position:top;background:rgba(0,0,0,0.25);border:1px solid rgba(127,127,127,0.25);border-radius:6px';
      const media = webm
        ? `<video src="/visuals/${webm}"${png ? ` poster="/visuals/${png}"` : ''} muted loop autoplay playsinline style="${mediaStyle}"></video>`
        : `<img src="/visuals/${png || gif}" alt="${label}" loading="lazy" style="${mediaStyle}">`;
      const href = `/visuals/${webm || gif || png}`;
      return `<a href="${href}" target="_blank" rel="noopener" title="${label} — open full size" style="flex:1 1 0;min-width:0;display:block;text-decoration:none">
        <div class="text-[0.65rem] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400" style="margin-bottom:2px">${label}</div>
        ${media}
      </a>`;
    };
    const before = tile('Before', visuals.before);
    const after = tile('After', visuals.after);
    if (!after && !before) return '';
    return `<div class="usn-visual-tiles" style="display:flex;gap:8px;align-items:flex-start;margin:4px 0 2px">${before}${after}</div>`;
  },

  // #211: sessions whose before/after tiles the viewer expanded in the
  // App-information-and-activity panel. Module-level (not DOM) state so
  // the open/closed choice survives the panel's frequent full re-renders.
  _visualsOpen: new Set(),

  // #211: collapsed-by-default wrapper around visualsTilesHtml for the
  // App-information-and-activity panel's PR rows. Renders a small
  // "Show before/after" toggle; the tiles themselves sit in an inert
  // <template> until expanded, so hidden screenshots/videos cost no
  // bandwidth and autoplay loops don't run off-screen. The dev-chat
  // "Changes ready" card intentionally keeps calling visualsTilesHtml
  // directly — its inline tiles stay as before (issue #211).
  visualsToggleHtml(sessionId, visuals) {
    const tiles = AppView.visualsTilesHtml(visuals);
    if (!tiles) return '';
    const open = AppView._visualsOpen.has(sessionId);
    return `<div class="usn-visuals-toggle">
      <button type="button" class="gc-vote-btn" aria-expanded="${open}" onclick="AppView.toggleVisuals(${sessionId}, this)">${open ? 'Hide before/after' : 'Show before/after'}</button>
      <template class="usn-visuals-tpl">${tiles}</template>
      <div class="usn-visuals-body">${open ? tiles : ''}</div>
    </div>`;
  },

  // #211: expand/collapse handler for the toggle above. Injects the tile
  // markup from the row's <template> on open and clears it on close
  // (clearing, rather than display:none, stops any looping <video>).
  toggleVisuals(sessionId, btn) {
    const wrap = btn.closest('.usn-visuals-toggle');
    if (!wrap) return;
    const body = wrap.querySelector('.usn-visuals-body');
    const tpl = wrap.querySelector('template.usn-visuals-tpl');
    const open = !AppView._visualsOpen.has(sessionId);
    if (open) {
      AppView._visualsOpen.add(sessionId);
      if (body && tpl) body.innerHTML = tpl.innerHTML;
    } else {
      AppView._visualsOpen.delete(sessionId);
      if (body) body.innerHTML = '';
    }
    btn.textContent = open ? 'Hide before/after' : 'Show before/after';
    btn.setAttribute('aria-expanded', String(open));
  },

  // #80: derive the GitHub issue URL for issue #N from a PR's html_url
  // (https://github.com/<owner>/<repo>/pull/<prNumber>) by swapping the
  // `/pull/<n>` segment for `/issues/<issueNumber>`. Returns '' when the
  // PR url is missing or doesn't look like a GitHub PR url so callers can
  // skip rendering a dead link.
  issueUrlFromPrUrl(prUrl, issueNumber) {
    if (!prUrl || !Number.isInteger(issueNumber) || issueNumber <= 0) return '';
    const out = prUrl.replace(/\/pull\/\d+(?=$|[/?#])/, `/issues/${issueNumber}`);
    // No substitution happened → not a recognizable PR url; bail rather
    // than linking to a /pull/ page for an issue.
    return out === prUrl ? '' : out;
  },

  // #80: "Closes #N" / "Closed #N" pills for the GitHub issues a PR closes.
  // Reads `linked_issues` (Postgres INTEGER[], populated in #75 and written
  // into the PR body as `Closes #N` by src/services/pr-metadata.js). Wording
  // follows the canonical merge check used elsewhere: status === 'merged'
  // is the only merged state, everything else ('promoted'/'merging'/'active'/
  // 'paused') reads as still-open. One independently-clickable pill per
  // issue, each opening the issue on GitHub in a new tab (#61). Renders
  // nothing when there are no linked issues or no usable PR url.
  closesPillHtml(pr) {
    if (!pr || !pr.pr_url) return '';
    // Sanitize defensively (mirror prMetadata.sanitizeIssueNumbers): drop
    // anything that isn't a positive integer, dedupe, sort ascending.
    const raw = Array.isArray(pr.linked_issues) ? pr.linked_issues : [];
    const seen = new Set();
    const nums = [];
    for (const v of raw) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); nums.push(n); }
    }
    if (!nums.length) return '';
    nums.sort((a, b) => a - b);

    const merged = pr.status === 'merged';
    const verb = merged ? 'Closed' : 'Closes';
    // Match the PR-number link tint at each site: emerald for merged,
    // violet for open.
    const cls = merged
      ? 'inline-flex items-center text-[0.65rem] font-medium font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20'
      : 'inline-flex items-center text-[0.65rem] font-medium font-mono px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 hover:bg-violet-500/20';

    return nums.map((n) => {
      const href = AppView.issueUrlFromPrUrl(pr.pr_url, n);
      if (!href) return '';
      return `<a href="${href}" target="_blank" rel="noopener" class="${cls}" title="${verb} issue #${n} on GitHub">${verb} #${n}</a>`;
    }).join(' ');
  },

  voteButtonsHtml(pr, opts) {
    if (!pr) return '';
    // Group-chat inline rows pass { collapseVoted: true }: once the viewer
    // has voted, the whole control set is replaced by a single read-only
    // "You voted X" box. The activity drawer passes nothing, so it keeps the
    // full Preview/Yes/No/Admin-merge set (with the chosen side highlighted)
    // so voters can re-cast or preview after voting.
    if (opts && opts.collapseVoted && (pr.my_vote === 'yes' || pr.my_vote === 'no')) {
      const choice = pr.my_vote === 'yes' ? 'Yes' : 'No';
      return `<span class="gc-vote-voted-box gc-vote-voted-box-${pr.my_vote}">You voted ${choice}</span>`;
    }
    // In the chat, a merging/merged PR has closed voting — don't render live
    // (now no-op) Yes/No buttons for someone who never voted; the pill +
    // status badge already convey the outcome.
    if (opts && opts.collapseVoted && pr.status !== 'promoted') return '';
    // #127: stash the PR's testing guidance in the by-session registry so
    // the Preview onclick passes it to the overlay (which renders its own
    // "Test this change" button + instructions panel) without the markdown
    // ever transiting an HTML attribute. No new button here — the row is
    // already dense.
    if (pr.testing_md || pr.testing_path) {
      AppView._sessionTesting[pr.id] = { md: pr.testing_md || null, path: pr.testing_path || null };
    } else {
      delete AppView._sessionTesting[pr.id];
    }
    const preview = pr.staging_url
      ? `<button class="gc-vote-btn gc-vote-btn-preview" onclick="AppView.swapToStagingForSession(${pr.id}, '${pr.staging_url}')">Preview</button>`
      : '';
    const adminMerge = App.user?.isAdmin
      ? `<button class="gc-vote-btn gc-vote-btn-admin" title="Admin: merge this PR right now, bypassing the vote majority" onclick="AppView.castAdminMerge(${pr.id})">Admin merge</button>`
      : '';
    const yesBtn = `<button class="gc-vote-btn gc-vote-btn-yes${pr.my_vote === 'yes' ? ' gc-vote-active' : ''}" onclick="AppView.castVote(${pr.id}, 'yes')">Yes (${pr.yes_count})</button>`;
    const noBtn = `<button class="gc-vote-btn gc-vote-btn-no${pr.my_vote === 'no' ? ' gc-vote-active' : ''}" onclick="AppView.castVote(${pr.id}, 'no')">No (${pr.no_count})</button>`;
    return preview + yesBtn + noBtn + adminMerge;
  },

  // Admin force-merge: bypass the active-user vote majority entirely
  // and merge a promoted PR right now. Gated server-side by
  // /api/sessions/:id/admin-merge (admin-only). The ConfirmModal here
  // is the misclick guard — the "Admin merge" button sits inline with
  // the regular Yes/No buttons, and we don't want a fat-finger to
  // accidentally bypass voting when the admin meant to just vote.
  async castAdminMerge(sessionId) {
    if (!App.user?.isAdmin) return;
    const key = `admin-merge:${sessionId}`;
    if (AppView._voteInFlight.has(key)) return;
    const ok = await ConfirmModal.show({
      title: 'Force-merge this PR?',
      message:
        'This bypasses the active-user vote majority and merges the PR right now.\n\n'
        + 'Use only when you\'re confident the change should ship — the override is announced in group chat with your username.',
      confirmLabel: 'Force-merge',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    AppView._voteInFlight.add(key);
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/admin-merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        alert(data.error || `Force-merge failed (HTTP ${resp.status}).`);
      }
      AppView.refreshDevData('vote');
    } catch (err) {
      alert(`Force-merge failed: ${err.message}`);
    } finally {
      AppView._voteInFlight.delete(key);
    }
  },


  _voteInFlight: new Set(),
  async castVote(sessionId, vote) {
    // Guard against double-click / mashing: one in-flight vote per session.
    // The server is now idempotent on an unchanged vote (won't re-post
    // to chat or re-enter checkAndMerge), but blocking here still avoids
    // pointless network round-trips and keeps the UI responsive.
    const key = `${sessionId}:${vote}`;
    if (AppView._voteInFlight.has(key)) return;
    AppView._voteInFlight.add(key);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vote }),
      });
      AppView.refreshDevData('vote');
      // Only refresh notifications once the backend confirms the vote — the
      // server clears this PR's nudge as a side effect, so re-pull to drop it
      // from the unread badge. Never optimistic: skip on a non-ok response.
      if (res.ok) window.Notifications?.refresh?.();
    } catch {}
    finally {
      AppView._voteInFlight.delete(key);
    }
  },

  async castIssueVote(issueId, vote) {
    try {
      const res = await fetch(`/api/issues/${issueId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vote }),
      });
      const data = await res.json().catch(() => ({}));
      // If a rename proposal just crossed the threshold, the WS app_update
      // event will refresh state for everyone; we just reload the panel.
      if (data?.renamed?.applied) {
        // Optimistic local update; the WS handler will re-sync.
        if (AppView.appData) AppView.appData.name = data.renamed.newName;
      }
      AppView.refreshDevData('vote');
    } catch {}
  },

  promptRename() {
    if (!AppView.appData) return;
    const modal = document.getElementById('rename-modal');
    const input = document.getElementById('rename-input');
    const current = document.getElementById('rename-current');
    const err = document.getElementById('rename-error');
    if (!modal || !input || !current) return;

    current.textContent = AppView.appData.name || '';
    input.value = AppView.appData.name || '';
    err.classList.add('hidden');
    err.textContent = '';
    modal.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 0);
  },

  closeRenameModal() {
    const modal = document.getElementById('rename-modal');
    const input = document.getElementById('rename-input');
    const err = document.getElementById('rename-error');
    if (modal) modal.classList.add('hidden');
    if (input) input.value = '';
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
  },

  // Share modal — exposes the app's bare subdomain URL so users can pass
  // it around outside the platform. The URL itself never carries auth;
  // child apps that gate visitors handle that at their own login page,
  // public apps (e.g. echo) render directly. resolveDevHost rewrites
  // localhost-shaped URLs to whatever hostname the browser is actually on,
  // so the link is reachable from a phone on the same LAN as the dev box.
  openShareModal() {
    const url = AppView.appData?.url ? resolveDevHost(AppView.appData.url) : '';
    const modal = document.getElementById('share-modal');
    const input = document.getElementById('share-url-input');
    const link = document.getElementById('share-open-link');
    const copyBtn = document.getElementById('share-copy-btn');
    if (input) input.value = url;
    if (link) link.href = url || '#';
    if (copyBtn) copyBtn.textContent = 'Copy';
    if (modal) modal.classList.remove('hidden');
    setTimeout(() => { if (input) { input.focus(); input.select(); } }, 0);
  },

  closeShareModal() {
    const modal = document.getElementById('share-modal');
    if (modal) modal.classList.add('hidden');
  },

  // Copy the share URL to the clipboard and flash "Copied!" on the button.
  // Falls back to selecting the input + execCommand for browsers/contexts
  // where navigator.clipboard isn't available (e.g. http: localhost in
  // some browsers).
  async copyShareUrl() {
    const input = document.getElementById('share-url-input');
    const btn = document.getElementById('share-copy-btn');
    const url = input?.value || '';
    if (!url) return;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch {}
    if (!ok && input) {
      try {
        input.focus();
        input.select();
        ok = document.execCommand('copy');
      } catch {}
    }
    if (btn) {
      const original = btn.textContent;
      btn.textContent = ok ? 'Copied!' : 'Copy failed';
      setTimeout(() => { btn.textContent = original; }, 1500);
    }
  },

  async submitRename(e) {
    if (e) e.preventDefault();
    if (!AppView.appData) return;
    const input = document.getElementById('rename-input');
    const err = document.getElementById('rename-error');
    const submitBtn = document.getElementById('rename-submit');
    const next = (input?.value || '').trim();
    const current = AppView.appData.name || '';

    const showError = (msg) => {
      if (!err) return;
      err.textContent = msg;
      err.classList.remove('hidden');
    };

    if (!next || next.length < 3) return showError('Name must be at least 3 characters');
    if (next.length > 64) return showError('Name must be 64 characters or fewer');
    if (next === current) return showError('New app name must differ from the current one');

    submitBtn.disabled = true;
    submitBtn.textContent = 'Opening PR...';
    try {
      // Renames now open a PR that edits dapp.json's `name` field; it
      // lands through the normal merge-vote pipeline (the new name applies
      // when the PR merges and the app redeploys). See
      // POST /api/apps/:slug/rename in src/routes/apps.js.
      const res = await fetch(`/api/apps/${AppView.appData.slug}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showError(data.error || 'Failed to open rename PR');
        return;
      }
      AppView.closeRenameModal();
      AppView.refreshDevData('vote');
    } catch {
      showError('Network error while opening rename PR');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Open PR';
    }
  },

  // Called by the global WS handler when this app is renamed by group vote.
  applyRename(newName) {
    if (!AppView.appData) return;
    AppView.appData.name = newName;
    if (App.currentTab === 'dev') {
      AppView.refreshDevData('vote');
    }
  },

  // Forum revision: the dedicated session view. There is no session
  // list / meta panel anymore — sessions are reached from the forum's
  // Your-sessions strip, proposal cards, and the "+" flow, and a
  // missing/unopenable id bounces back to the card list. The App
  // secrets / display-name shortcuts that used to live here moved to
  // the App settings sub-page (_renderSettingsView).
  async renderDevChatTab(restoreSessionId) {
    const content = AppView._devContainer();
    if (!content) return;
    if (!restoreSessionId) {
      if (typeof App !== 'undefined' && App.switchTab) App.switchTab('dev');
      return;
    }

    content.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;min-height:0">
        <div id="dc-view" style="flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden"></div>
      </div>`;

    if (!AppView.appData) return;

    // Ground-truth guard: if the in-memory session belongs to a
    // different app than the one we're rendering, drop it before
    // loading (fixes #20).
    if (
      DevChat.currentSession &&
      DevChat.currentSession.app_slug &&
      DevChat.currentSession.app_slug !== AppView.appData.slug
    ) {
      DevChat.reset();
    }

    await DevChat.loadSessions(AppView.appData.slug);
    await DevChat.openSession(restoreSessionId);

    // Archived / inaccessible session: fall back to the forum rather
    // than stranding an empty view.
    if (!DevChat.currentSession || String(DevChat.currentSession.id) !== String(restoreSessionId)) {
      if (typeof App !== 'undefined' && App.switchTab) App.switchTab('dev');
      return;
    }

    DevChat.renderChatView();

    // #194: one-shot hint set by the "+" menu's "Propose a change" —
    // proposals are PRs, so the path runs through a session.
    if (AppView._proposalHint) {
      AppView._proposalHint = false;
      const view = document.getElementById('dc-view');
      if (view) {
        view.insertAdjacentHTML('afterbegin',
          '<div class="mx-3 mt-2 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-xs text-zinc-600 dark:text-zinc-300 shrink-0">'
          + 'Describe the change you want — when it\'s ready, promoting this session\'s PR is what creates the proposal everyone votes on.'
          + '</div>');
      }
    }
  },

  // Fetch the current secrets summary and paint the preview slot in
  // the dev-chat Edit row. Called on tab mount and again from
  // Secrets.handleSet/handleClear so direct admin edits reflect
  // immediately without a tab reload. Silently no-ops when the row
  // isn't mounted (e.g. user is on a different tab).
  async refreshDevChatSecretsState() {
    const stateEl = document.getElementById('dc-secrets-state');
    if (!stateEl || !AppView.appData) return;

    const setLabel = (text, tone) => {
      stateEl.textContent = text;
      stateEl.className = 'text-xs ' + (tone === 'err'
        ? 'font-medium text-red-500 dark:text-red-400'
        : 'text-zinc-400 dark:text-zinc-500');
    };

    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/secrets`);
      if (!res.ok) {
        setLabel('', 'neutral');
        return;
      }
      const data = await res.json();
      if (!data.manifestKnown) {
        // Pre-first-deploy hint — distinct from "everything's fine"
        // because the manifest just hasn't been ingested yet.
        setLabel('No manifest yet', 'neutral');
        return;
      }
      // Only `required && !hasValue` is actionable: it blocks deploys.
      // Optional-but-unset keys (including ones that fall back to a
      // default declared in dapp.json) are fine, so they shouldn't
      // light anything up. When nothing is broken we leave the slot
      // blank — the chevron alone says "tap to manage".
      const list = Array.isArray(data.secrets) ? data.secrets : [];
      const missing = list.filter((s) => s.required && !s.hasValue).length;
      if (missing > 0) {
        setLabel(`${missing} required missing`, 'err');
      } else {
        setLabel('', 'neutral');
      }
    } catch {
      setLabel('', 'neutral');
    }
  },

  async pollStatus() {
    if (!AppView.appData || App.currentTab !== 'app') return;
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}`);
      if (!res.ok) return;
      const { app: updated } = await res.json();
      AppView.appData = updated;
      if (updated.status === 'running') {
        await AppView.refreshToken();
        AppView.renderAppTab();
      } else if (updated.status === 'creating') {
        setTimeout(() => AppView.pollStatus(), 3000);
      } else {
        AppView.renderAppTab();
      }
    } catch {}
  },

  // Activity tracking: counts seconds while the user is on the App tab
  startActivityTracking(slug) {
    AppView.activeSeconds = 0;
    AppView.iframeFocused = false;

    AppView.activityInterval = setInterval(() => {
      if (App.currentTab === 'app' && document.visibilityState === 'visible') {
        AppView.activeSeconds++;

        // Flush every 30 seconds
        if (AppView.activeSeconds >= 30) {
          AppView.flushActivity(slug);
        }
      }
    }, 1000);

    // Flush on tab switch or page hide
    document.addEventListener('visibilitychange', AppView._onVisibilityChange);
  },

  stopActivityTracking() {
    if (AppView.activityInterval) {
      clearInterval(AppView.activityInterval);
      AppView.activityInterval = null;
    }
    if (AppView.appData && AppView.activeSeconds > 0) {
      AppView.flushActivity(AppView.appData.slug);
    }
    document.removeEventListener('visibilitychange', AppView._onVisibilityChange);
  },

  _onVisibilityChange() {
    if (document.visibilityState === 'hidden' && AppView.appData && AppView.activeSeconds > 0) {
      AppView.flushActivity(AppView.appData.slug);
    }
  },

  async flushActivity(slug) {
    const seconds = AppView.activeSeconds;
    if (seconds <= 0) return;
    AppView.activeSeconds = 0;

    try {
      await fetch(`/api/apps/${slug}/activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds }),
      });
    } catch {}
  },

  // Open staging in fullscreen overlay.
  //
  // #127: `testing` is the session's bot-generated testing guidance
  // ({ md, path } | null) and `opts.jump` opens the iframe directly at the
  // deep-link path (the dev-chat "Test this change" button does this).
  // Callers must never thread the markdown through an HTML attribute —
  // use a wrapper that looks the object up at click time
  // (swapToStagingForSession / DevChat.previewStaging).
  swapToStaging(stagingUrl, testing, opts) {
    const overlay = document.getElementById('staging-overlay');
    const iframe = document.getElementById('staging-iframe');
    const label = document.getElementById('staging-url-label');
    if (!overlay || !iframe) return;

    const resolved = resolveDevHost(stagingUrl);

    // Re-validate the deep link client-side (the server already did via
    // testing-notes.validatePath, but defense-in-depth is cheap): must be
    // relative and not protocol-relative, so new URL() below can never
    // leave the staging origin.
    const rawPath = testing && typeof testing.path === 'string' ? testing.path : null;
    const safePath = rawPath && rawPath.startsWith('/') && !rawPath.startsWith('//') ? rawPath : null;
    const testingMd = testing && typeof testing.md === 'string' && testing.md.trim() ? testing.md : null;
    AppView._stagingTesting = (safePath || testingMd) ? { md: testingMd, path: safePath } : null;

    // Build iframe URLs with the URL API so a deep link carrying its own
    // query string composes with the token param (no '?token=' concat).
    const buildSrc = (path) => {
      let url;
      try { url = new URL(path || '/', resolved); } catch { return resolved; }
      if (AppView.iframeToken) url.searchParams.set('token', AppView.iframeToken);
      return url.toString();
    };
    const jump = !!(opts && opts.jump) && !!safePath;
    // Mutable so a "Test this change" click during the readiness poll
    // retargets the pending load instead of being clobbered by it.
    const pending = { src: buildSrc(jump ? safePath : null) };

    if (label) label.textContent = resolved;
    overlay.classList.remove('hidden');
    if (window.DevConsole) DevConsole.setButtonVisible(true);

    AppView._renderTestingControls(buildSrc, pending);

    document.getElementById('staging-back').onclick = () => {
      AppView.closeStagingOverlay();
    };

    // Don't point the iframe at the host until it actually answers. A fresh
    // preview's on-demand TLS cert can take a minute (occasionally a few) to
    // issue; loading the iframe during that window shows a black void with no
    // feedback. Probe the host first and only swap in the real src once the
    // TLS handshake succeeds. Each probe also nudges Caddy's on-demand
    // issuance along, so polling actively warms the cert too. (The probe
    // always targets the origin root, not the deep link — readiness is a
    // host/TLS property, and the deep path may be app-routed or auth-gated.)
    iframe.src = '';
    const loadId = ++AppView._stagingLoadId;
    AppView._waitForStagingReady(resolved, loadId).then((ready) => {
      // A newer swap (or a close) superseded this one — drop the result.
      if (loadId !== AppView._stagingLoadId) return;
      AppView._setStagingLoader(false);
      if (ready) iframe.src = pending.src;
    });
  },

  // #127: Preview entry point for vote-panel / group-chat rows — looks up
  // the testing guidance stashed by voteButtonsHtml at render time, so the
  // existing Preview button passes it through without any new UI there.
  swapToStagingForSession(sessionId, stagingUrl) {
    AppView.swapToStaging(stagingUrl, (AppView._sessionTesting || {})[sessionId] || null);
  },

  // #127: per-render registry of { md, path } testing guidance keyed by
  // session id, populated by voteButtonsHtml. Exists so bot-authored
  // markdown never transits an inline onclick attribute.
  _sessionTesting: {},

  // The current preview's testing guidance ({ md, path } | null), set by
  // swapToStaging and cleared on close.
  _stagingTesting: null,

  // #127: show/hide + wire the overlay's "Test this change" button and the
  // collapsible "How to test" panel for the current preview.
  _renderTestingControls(buildSrc, pending) {
    const btn = document.getElementById('staging-test-btn');
    const panel = document.getElementById('staging-testing-panel');
    const content = document.getElementById('staging-testing-content');
    const closeBtn = document.getElementById('staging-testing-close');
    const iframe = document.getElementById('staging-iframe');
    if (!btn || !panel || !content) return;

    panel.classList.add('hidden');
    const t = AppView._stagingTesting;
    if (!t) {
      btn.classList.add('hidden');
      content.innerHTML = '';
      return;
    }

    // Bot-authored markdown: render through DevChat's escaping markdown
    // pipeline when available, otherwise fall back to escaped plain text.
    if (t.md) {
      content.innerHTML = (window.DevChat && typeof DevChat.renderMarkdown === 'function')
        ? DevChat.renderMarkdown(t.md)
        : `<pre class="whitespace-pre-wrap font-sans">${escapeHtml(t.md)}</pre>`;
    } else {
      content.innerHTML = '<span class="text-zinc-500">Use the button above to jump to the changed feature.</span>';
    }

    btn.classList.remove('hidden');
    btn.title = t.path ? 'Open the preview at the changed feature' : 'Show the testing instructions';
    btn.onclick = () => {
      if (t.path) {
        // Retarget the (possibly still pending) load at the deep link.
        pending.src = buildSrc(t.path);
        if (iframe && iframe.src) iframe.src = pending.src;
        if (t.md) panel.classList.remove('hidden');
      } else {
        panel.classList.toggle('hidden');
      }
    };
    if (closeBtn) closeBtn.onclick = () => panel.classList.add('hidden');

    // Auto-open the instructions so a tester landing in the preview sees
    // the steps without hunting; the × dismisses them.
    if (t.md) panel.classList.remove('hidden');
  },

  // Incremented on every swap/close so an in-flight readiness poll for a
  // superseded preview can detect it's stale and bail without touching the
  // iframe.
  _stagingLoadId: 0,

  _setStagingLoader(visible, { title, sub } = {}) {
    const loader = document.getElementById('staging-loader');
    if (!loader) return;
    loader.classList.toggle('hidden', !visible);
    if (title) {
      const t = document.getElementById('staging-loader-title');
      if (t) t.textContent = title;
    }
    if (sub) {
      const s = document.getElementById('staging-loader-sub');
      if (s) s.textContent = sub;
    }
  },

  // Poll the staging host until its TLS handshake + HTTP response succeed.
  // Uses a no-cors GET: it resolves for any reply (even opaque/redirect/4xx),
  // and rejects on the network/TLS failure we get while the cert is still
  // issuing — exactly the readiness signal we want. Resolves true when ready,
  // false only if the user backed out (stale loadId).
  async _waitForStagingReady(resolved, loadId) {
    AppView._setStagingLoader(true, {
      title: 'Provisioning secure preview…',
      sub: 'Issuing a TLS certificate for this preview. First load can take a minute.',
    });
    const startedAt = Date.now();
    let attempt = 0;
    while (loadId === AppView._stagingLoadId) {
      attempt += 1;
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 8000);
      try {
        await fetch(resolved, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
        clearTimeout(to);
        return true; // handshake + response succeeded → cert is live
      } catch {
        clearTimeout(to);
        if (loadId !== AppView._stagingLoadId) return false;
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        // Escalate the copy so a longer-than-usual wait doesn't look hung.
        if (elapsed >= 90) {
          AppView._setStagingLoader(true, {
            title: 'Still provisioning…',
            sub: `The certificate authority is taking longer than usual (${elapsed}s). Hang tight — this keeps retrying automatically.`,
          });
        } else if (elapsed >= 30) {
          AppView._setStagingLoader(true, {
            title: 'Provisioning secure preview…',
            sub: `Almost there — waiting on the TLS certificate (${elapsed}s).`,
          });
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    return false; // superseded/closed
  },

  closeStagingOverlay() {
    const overlay = document.getElementById('staging-overlay');
    const iframe = document.getElementById('staging-iframe');
    // Invalidate any in-flight readiness poll and hide the loader.
    AppView._stagingLoadId += 1;
    AppView._setStagingLoader(false);
    if (overlay) overlay.classList.add('hidden');
    if (iframe) iframe.src = '';
    // #127: reset the testing affordances so the next preview starts clean.
    AppView._stagingTesting = null;
    const testBtn = document.getElementById('staging-test-btn');
    if (testBtn) testBtn.classList.add('hidden');
    const testPanel = document.getElementById('staging-testing-panel');
    if (testPanel) testPanel.classList.add('hidden');
    // Restore dev-console button visibility based on whatever tab the
    // user lands back on.
    if (window.DevConsole) {
      const showForApp = App.currentTab === 'app'
        && AppView.appData?.status === 'running';
      DevConsole.setButtonVisible(showForApp);
    }
  },

  // Swap back to production
  swapToProduction() {
    if (AppView.appData?.url) {
      AppView.renderAppTab();
    }
  },

  // ── Members & visibility modal ─────────────────────────────────────
  //
  // One modal, two concerns:
  //   - visibility controls (creator/admin only) → PATCH /visibility
  //   - member list + invite typeahead (collab-private apps) →
  //     /collaborators, /invites, /api/users/search
  // State is re-fetched on every open so a stale modal can't show a
  // removed member or an already-accepted invite.

  _membersVis: { collab: 'public', view: 'public' },
  _inviteDebounce: null,

  async openMembersModal() {
    const appData = AppView.appData;
    if (!appData) return;
    const modal = document.getElementById('members-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    AppView._membersVis = {
      collab: appData.collab_visibility || 'public',
      view: appData.view_visibility || 'public',
    };

    // Visibility section: creator/admin only.
    const visSection = document.getElementById('members-visibility-section');
    if (visSection) {
      visSection.classList.toggle('hidden', !appData.can_manage);
      if (appData.can_manage) AppView._renderMembersVisPills();
    }
    AppView._wireMembersModal();

    // Member list + invite input: collab-private apps only.
    const isPrivate = appData.collab_visibility === 'private';
    const inviteSection = document.getElementById('members-invite-section');
    const listSection = document.getElementById('members-list-section');
    if (inviteSection) inviteSection.classList.toggle('hidden', !isPrivate || !appData.can_collaborate);
    if (listSection) listSection.classList.toggle('hidden', !isPrivate || !appData.can_collaborate);
    const status = document.getElementById('members-invite-status');
    if (status) { status.textContent = ''; status.className = 'text-sm mt-2'; }
    const input = document.getElementById('members-invite-input');
    if (input) input.value = '';
    AppView._hideInviteSuggestions();
    if (isPrivate && appData.can_collaborate) await AppView.loadCollaborators();
  },

  hideMembersModal() {
    const modal = document.getElementById('members-modal');
    if (modal) modal.classList.add('hidden');
    AppView._hideInviteSuggestions();
  },

  // Idempotent wiring (cloneNode swap clears stale listeners, mirroring
  // Home.wireCreateButtons) for the pills + invite input.
  _wireMembersModal() {
    document.querySelectorAll('#members-visibility-section [data-m-collab-vis], #members-visibility-section [data-m-view-vis]')
      .forEach((pill) => {
        const fresh = pill.cloneNode(true);
        pill.parentNode.replaceChild(fresh, pill);
        fresh.addEventListener('click', () => {
          if (fresh.dataset.mCollabVis) AppView._setMembersVisibility('collab', fresh.dataset.mCollabVis);
          else AppView._setMembersVisibility('view', fresh.dataset.mViewVis);
        });
      });
    const input = document.getElementById('members-invite-input');
    if (input) {
      const fresh = input.cloneNode(true);
      input.parentNode.replaceChild(fresh, input);
      fresh.addEventListener('input', () => {
        clearTimeout(AppView._inviteDebounce);
        AppView._inviteDebounce = setTimeout(() => AppView._searchInviteUsers(fresh.value.trim()), 200);
      });
      fresh.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const name = fresh.value.trim();
          if (name) AppView.sendInvite(name);
        }
        if (e.key === 'Escape') AppView._hideInviteSuggestions();
      });
    }
  },

  _renderMembersVisPills() {
    const { collab, view } = AppView._membersVis;
    const collabPublic = collab === 'public';
    document.querySelectorAll('#members-visibility-section [data-m-collab-vis]').forEach((p) => {
      p.classList.toggle('active', p.dataset.mCollabVis === collab);
    });
    document.querySelectorAll('#members-visibility-section [data-m-view-vis]').forEach((p) => {
      p.classList.toggle('active', p.dataset.mViewVis === view);
      p.disabled = collabPublic;
    });
    const hint = document.getElementById('members-vis-hint');
    if (hint) hint.classList.toggle('hidden', !collabPublic);
  },

  // Pill click → optimistic local state + PATCH. On failure, revert to
  // the server's last-known values from appData.
  async _setMembersVisibility(kind, value) {
    const prev = { ...AppView._membersVis };
    const v = value === 'private' ? 'private' : 'public';
    if (kind === 'collab') {
      AppView._membersVis.collab = v;
      if (v === 'public') AppView._membersVis.view = 'public';
    } else {
      AppView._membersVis.view = (AppView._membersVis.collab === 'private') ? v : 'public';
    }
    AppView._renderMembersVisPills();
    if (prev.collab === AppView._membersVis.collab && prev.view === AppView._membersVis.view) return;

    const errEl = document.getElementById('members-vis-error');
    if (errEl) errEl.classList.add('hidden');
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/visibility`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collabVisibility: AppView._membersVis.collab,
          viewVisibility: AppView._membersVis.view,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Keep the in-memory app row honest so re-opens render correctly
      // and tab gating recomputes on the next open.
      AppView.appData.collab_visibility = AppView._membersVis.collab;
      AppView.appData.view_visibility = AppView._membersVis.view;
      // Going collab-public dissolves the invite/member sections.
      const isPrivate = AppView._membersVis.collab === 'private';
      const inviteSection = document.getElementById('members-invite-section');
      const listSection = document.getElementById('members-list-section');
      if (inviteSection) inviteSection.classList.toggle('hidden', !isPrivate);
      if (listSection) listSection.classList.toggle('hidden', !isPrivate);
      if (isPrivate) AppView.loadCollaborators();
    } catch (err) {
      AppView._membersVis = prev;
      AppView._renderMembersVisPills();
      if (errEl) {
        errEl.textContent = `Visibility change failed: ${err.message}`;
        errEl.classList.remove('hidden');
      }
    }
  },

  async loadCollaborators() {
    const list = document.getElementById('members-list');
    if (!list || !AppView.appData) return;
    list.innerHTML = '<div class="px-3 py-2 text-sm text-zinc-500">Loading…</div>';
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/collaborators`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      AppView._renderCollaborators(data.collaborators || []);
    } catch (err) {
      list.innerHTML = `<div class="px-3 py-2 text-sm text-red-400">Failed to load members: ${escapeHtml(err.message)}</div>`;
    }
  },

  _renderCollaborators(rows) {
    const list = document.getElementById('members-list');
    if (!list) return;
    const me = (typeof App !== 'undefined' && App.user) ? App.user : {};
    const canManage = !!AppView.appData?.can_manage;
    if (!rows.length) {
      list.innerHTML = '<div class="px-3 py-2 text-sm text-zinc-500">No collaborators yet.</div>';
      return;
    }
    list.innerHTML = rows.map((r) => {
      const pending = r.status === 'invited';
      const tag = r.isCreator
        ? '<span class="text-[0.65rem] text-violet-500 font-medium ml-1">creator</span>'
        : (pending ? '<span class="text-[0.65rem] text-amber-500 font-medium ml-1">invited</span>' : '');
      // Remove/revoke: creator/admin for anyone but the creator; users
      // may remove themselves (leave). Mirrors the server rules.
      const canRemove = !r.isCreator && (canManage || r.userId === me.id);
      const removeBtn = canRemove
        ? `<button data-remove-user="${r.userId}" class="text-xs text-zinc-400 hover:text-red-500 px-2 py-1" title="${pending ? 'Revoke invite' : (r.userId === me.id ? 'Leave app' : 'Remove')}">${pending ? 'Revoke' : (r.userId === me.id ? 'Leave' : 'Remove')}</button>`
        : '';
      return `<div class="flex items-center justify-between px-3 py-2 ${pending ? 'opacity-70' : ''}">
        <span class="text-sm text-zinc-700 dark:text-zinc-300 truncate">@${escapeHtml(r.username)}${tag}</span>
        ${removeBtn}
      </div>`;
    }).join('');
    list.querySelectorAll('[data-remove-user]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await fetch(
            `/api/apps/${AppView.appData.slug}/collaborators/${btn.dataset.removeUser}`,
            { method: 'DELETE' }
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          // Leaving an app yourself: you may have just lost access —
          // bounce home rather than leave a dead view up.
          if (Number(btn.dataset.removeUser) === me.id && !me.isAdmin) {
            AppView.hideMembersModal();
            App.navigateHome();
            return;
          }
          AppView.loadCollaborators();
        } catch (err) {
          alert(`Remove failed: ${err.message}`);
          btn.disabled = false;
        }
      });
    });
  },

  async _searchInviteUsers(q) {
    const box = document.getElementById('members-invite-suggestions');
    if (!box || !AppView.appData) return;
    if (!q) { AppView._hideInviteSuggestions(); return; }
    try {
      const params = new URLSearchParams({ q, excludeApp: AppView.appData.slug });
      const res = await fetch(`/api/users/search?${params.toString()}`);
      if (!res.ok) return;
      const { users } = await res.json();
      if (!users || !users.length) { AppView._hideInviteSuggestions(); return; }
      box.innerHTML = users.map((u) =>
        `<button data-invite-user="${escapeAttr(u.username)}" class="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">@${escapeHtml(u.username)}</button>`
      ).join('');
      box.classList.remove('hidden');
      box.querySelectorAll('[data-invite-user]').forEach((btn) => {
        btn.addEventListener('click', () => AppView.sendInvite(btn.dataset.inviteUser));
      });
    } catch { /* typeahead is best-effort */ }
  },

  _hideInviteSuggestions() {
    const box = document.getElementById('members-invite-suggestions');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  },

  async sendInvite(username) {
    const status = document.getElementById('members-invite-status');
    const input = document.getElementById('members-invite-input');
    AppView._hideInviteSuggestions();
    if (status) { status.textContent = 'Inviting…'; status.className = 'text-sm mt-2'; }
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (status) {
        status.textContent = `✓ Invited @${data.username || username}`;
        status.className = 'text-sm mt-2 import-status--ok';
      }
      if (input) input.value = '';
      AppView.loadCollaborators();
    } catch (err) {
      if (status) {
        status.textContent = err.message;
        status.className = 'text-sm mt-2 import-status--err';
      }
    }
  },
};

// Small helpers used by the #21 version pill. Kept local so app-view
// stays self-contained — the dev-console has its own copy of these.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/\n/g, ' '); }
function relTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}
