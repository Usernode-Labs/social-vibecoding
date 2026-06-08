const AppView = {
  appData: null,
  iframeToken: null,
  activityInterval: null,
  tokenRefreshInterval: null,
  activeSeconds: 0,
  iframeFocused: false,

  _INFO_PANEL_OPEN_KEY_PREFIX: 'gc-info-panel-open-v1:',
  // Persisted height of the "App information and activity" panel,
  // stored as a percentage (10–90) of the group-chat container so it
  // survives viewport/zoom changes. Per-app slug, mirroring the
  // open-state key above.
  _INFO_PANEL_HEIGHT_KEY_PREFIX: 'gc-info-panel-height-v1:',
  // Clamp the panel between 10% and 90% of the container so neither the
  // panel nor the chat below it can be dragged away entirely.
  _INFO_PANEL_MIN_PCT: 10,
  _INFO_PANEL_MAX_PCT: 90,

  _readInfoPanelOpen(appSlug) {
    if (!appSlug) return false;
    try { return localStorage.getItem(AppView._INFO_PANEL_OPEN_KEY_PREFIX + appSlug) === '1'; }
    catch { return false; }
  },

  _writeInfoPanelOpen(appSlug, isOpen) {
    if (!appSlug) return;
    try { localStorage.setItem(AppView._INFO_PANEL_OPEN_KEY_PREFIX + appSlug, isOpen ? '1' : '0'); }
    catch {}
  },

  _readInfoPanelHeight(appSlug) {
    if (!appSlug) return null;
    try {
      const v = parseFloat(localStorage.getItem(AppView._INFO_PANEL_HEIGHT_KEY_PREFIX + appSlug) || '');
      if (!Number.isFinite(v)) return null;
      return Math.min(AppView._INFO_PANEL_MAX_PCT, Math.max(AppView._INFO_PANEL_MIN_PCT, v));
    } catch { return null; }
  },

  _writeInfoPanelHeight(appSlug, pct) {
    if (!appSlug) return;
    const clamped = Math.min(AppView._INFO_PANEL_MAX_PCT, Math.max(AppView._INFO_PANEL_MIN_PCT, pct));
    try { localStorage.setItem(AppView._INFO_PANEL_HEIGHT_KEY_PREFIX + appSlug, String(Math.round(clamped * 10) / 10)); }
    catch {}
  },

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
    // default-tab logic in App.navigateToApp/switchTab routes to Group Chat
    // instead. Show it again for non-self-hosted (mounting AppView is per-
    // app, so a previous self-app open could have left the button hidden).
    const appTabBtn = document.querySelector('.app-tab[data-tab="app"]');
    if (appTabBtn) {
      appTabBtn.classList.toggle('hidden', !!appData.self_hosted);
    }

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
      <a href="${href}" target="_blank" rel="noopener noreferrer" class="app-version-pill" title="${escapeAttr(tip)}">
        ${quiet ? '' : '<span class="app-version-pill-dot"></span>'}
        <span class="app-version-pill-label">
          ${slugPart}
          ${escapeHtml(sha)}
        </span>
      </a>`;
  },

  renderGroupChatTab() {
    const content = document.getElementById('app-content');

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
    // Layout mirrors dev-chat's session view: a vertical column for
    // the cross-cutting strips (vote panel here / session header
    // there), then a flex-row body that holds the chat pane on the
    // left and a slot for the spec side-panel on the right. The slot
    // is empty + display:none until "View full spec" is clicked, so
    // the chat occupies 100% width by default. CSS toggles the
    // side-panel layout vs. fullscreen-modal layout based on
    // viewport width.
    content.innerHTML = `
      <div class="flex flex-col h-full">
        <!-- Vote/issue panel (spans full width above the body row).
             Capped at 50% of the chat container's height so a long
             expanded dashboard (lots of PRs / kudos / etc) can never
             push the messages list off-screen. The percentage resolves
             against the parent's definite height (.flex-col.h-full
             inside #app-content's flex track). overflow-y-auto turns
             the whole panel into a scroll region — toggle button is at
             the top, so it scrolls into view at content-start. -->
        <div id="gc-panel" class="shrink-0 max-h-[50%] overflow-y-auto overscroll-contain">
          <div id="gc-panel-content" class="px-3 py-2"></div>
        </div>

        <!-- Draggable divider between the info/activity panel and the
             chat below it. Acts as a plain 1px border when the panel is
             collapsed; once the panel is open the .gc-panel-resizer-draggable
             class turns it into a grabbable handle. AppView._initPanelResizer
             wires a pointer-event drag that sets the panel's inline height
             (clamped to 10–90% of the container) and persists the final
             percentage to localStorage. -->
        <div id="gc-panel-resizer" class="gc-panel-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize app information panel"></div>

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

    // #15: Escape clears a staged reply quote (when the input is empty so
    // we don't fight other Escape semantics mid-typing).
    gcInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && GroupChat.replyDraft && !gcInput.value) {
        e.preventDefault();
        GroupChat.clearQuote();
      }
    });

    // #15: clicking a PR title in the activity panel stages it as a reply
    // quote. Bound once on the stable #gc-panel (content is re-rendered by
    // loadVotePanel, so delegate). Tap-not-drag, same as the chat rows.
    AppView._bindPanelQuoteHandler();

    if (AppView.appData) {
      // `mount` re-uses the existing WS + message cache when the user
      // comes back to this tab, preserving their scroll position; it only
      // opens a fresh connection on the first visit to an app.
      GroupChat.mount(AppView.appData.slug);
      AppView.loadVotePanel(AppView.appData.slug);
      // Wire the draggable info-panel divider and restore its saved
      // height. Bind + sync immediately (the #gc-panel / resizer nodes
      // exist now even though loadVotePanel fills the content async).
      AppView._initPanelResizer(AppView.appData.slug);
      AppView._syncPanelResizer(AppView.appData.slug);
    }
    // Re-render any staged reply preview (the composer DOM was just
    // recreated on this tab (re-)entry, but replyDraft persists).
    GroupChat._renderQuotePreview();
  },

  // #15: delegated tap-to-quote for PR titles in the activity panel.
  _bindPanelQuoteHandler() {
    const panel = document.getElementById('gc-panel');
    if (!panel || panel._gcQuoteBound) return;
    panel._gcQuoteBound = true;
    panel.addEventListener('pointerdown', (e) => {
      AppView._panelTap = { x: e.clientX, y: e.clientY };
    }, true);
    panel.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      const t = e.target.closest('.gc-quote-pr');
      if (!t || typeof GroupChat === 'undefined') return;
      const tap = AppView._panelTap || { x: e.clientX, y: e.clientY };
      if (Math.abs(e.clientX - tap.x) + Math.abs(e.clientY - tap.y) > 8) return;
      const sel = window.getSelection && window.getSelection();
      if (sel && String(sel).trim() !== '') return;
      const sessionId = parseInt(t.dataset.sessionId || '', 10);
      if (!sessionId) return;
      GroupChat.setQuote({
        source: 'pr',
        sessionId,
        prNumber: parseInt(t.dataset.prNumber || '', 10) || null,
        author: t.dataset.prAuthor || null,
        snippet: t.dataset.prTitle || `PR #${t.dataset.prNumber || ''}`,
        href: t.dataset.prUrl || null,
      });
    });
  },

  // Apply (or clear) the persisted panel height. Only takes effect when
  // the panel is open: a collapsed panel stays content-sized (just the
  // pill) so we don't strand a tall empty box above the chat. The saved
  // value is a percentage of the container, re-applied as an inline
  // height so it tracks viewport resizes. maxHeight is forced to none so
  // it can override the default Tailwind max-h-[50%] cap.
  _applySavedPanelHeight(slug) {
    const panel = document.getElementById('gc-panel');
    if (!panel) return;
    const open = AppView._readInfoPanelOpen(slug);
    const pct = open ? AppView._readInfoPanelHeight(slug) : null;
    if (pct != null) {
      panel.style.height = `${pct}%`;
      panel.style.maxHeight = 'none';
    } else {
      // Revert to the default content-driven height (capped by the
      // Tailwind max-h-[50%] class on the element).
      panel.style.height = '';
      panel.style.maxHeight = '';
    }
  },

  // Toggle the resizer between "plain divider" and "grabbable handle"
  // based on whether the panel is open, and (re)apply the saved height.
  // Call this on mount and whenever the open state flips.
  _syncPanelResizer(slug) {
    const resizer = document.getElementById('gc-panel-resizer');
    if (resizer) {
      resizer.classList.toggle('gc-panel-resizer-draggable', AppView._readInfoPanelOpen(slug));
    }
    AppView._applySavedPanelHeight(slug);
  },

  // Wire the pointer-event drag handler on the panel resizer. Idempotent
  // per handle element (the node is recreated on every tab re-render, so
  // we tag it to avoid double-binding within a single render).
  _initPanelResizer(slug) {
    const handle = document.getElementById('gc-panel-resizer');
    const panel = document.getElementById('gc-panel');
    if (!handle || !panel) return;
    if (handle._gcPanelResizerBound) return;
    handle._gcPanelResizerBound = true;

    handle.addEventListener('pointerdown', (e) => {
      // Only resize when the panel is open — a collapsed panel has no
      // meaningful height to drag.
      if (!AppView._readInfoPanelOpen(slug)) return;
      const container = panel.parentElement;
      if (!container) return;
      e.preventDefault();

      const containerRect = container.getBoundingClientRect();
      const containerH = containerRect.height;
      if (containerH <= 0) return;
      const minPx = (AppView._INFO_PANEL_MIN_PCT / 100) * containerH;
      const maxPx = (AppView._INFO_PANEL_MAX_PCT / 100) * containerH;

      handle.setPointerCapture(e.pointerId);
      handle.classList.add('gc-panel-resizer-active');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'row-resize';
      panel.style.maxHeight = 'none';

      // Anchor the chat by its distance from the bottom while dragging.
      // Resizing the chat pane changes its height, and the messages list
      // is top-anchored, so without this the visible messages shift (and
      // the async ResizeObserver in group-chat.js only re-pins when the
      // user happens to be at the very bottom, a frame late). Capturing
      // the bottom-gap and restoring it synchronously on every step keeps
      // the same messages steady relative to the input box — whether the
      // user is pinned to the bottom or scrolled up reading history.
      const msgs = document.getElementById('gc-messages');
      const bottomGap = msgs
        ? Math.max(0, msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight)
        : 0;
      const pinChat = () => {
        if (!msgs) return;
        msgs.scrollTop = Math.max(0, msgs.scrollHeight - msgs.clientHeight - bottomGap);
      };

      let finalPct = null;
      const onMove = (ev) => {
        // The panel's top edge is the container top; its bottom edge
        // follows the pointer.
        const nextPx = Math.max(minPx, Math.min(maxPx, ev.clientY - containerRect.top));
        finalPct = (nextPx / containerH) * 100;
        panel.style.height = `${finalPct}%`;
        pinChat();
      };

      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        try { handle.releasePointerCapture(e.pointerId); } catch {}
        handle.classList.remove('gc-panel-resizer-active');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        pinChat();
        if (finalPct != null) AppView._writeInfoPanelHeight(slug, finalPct);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  },

  // The dropdown started life as an "activity feed" (open PRs, merged
  // work, etc.) and is gradually growing into an app-info dashboard
  // (engaged-user count first, more tiles to follow). It's collapsed
  // by default now so the chat itself is what users land on; the pill
  // header summarises any current activity inline so opening it is
  // optional, not required.
  panelOpen: false,

  async loadVotePanel(slug) {
    const panel = document.getElementById('gc-panel-content');
    if (!panel) return;
    AppView.panelOpen = AppView._readInfoPanelOpen(slug);

    try {
      const [promotedRes, issuesRes, mergedRes] = await Promise.all([
        fetch(`/api/apps/${slug}/promoted`),
        fetch(`/api/apps/${slug}/issues`),
        fetch(`/api/apps/${slug}/merged`),
      ]);

      const promotedData = promotedRes.ok ? await promotedRes.json() : { promoted: [] };
      const promoted = promotedData.promoted;
      const activeUsers = promotedData.activeUsers || 1;
      const majority = promotedData.majority || 1;
      // Merged sessions are read up-front (not just for the "Merged" panel
      // section below) so they can be folded into voteState — this keeps the
      // group-chat activity row's "x / y" pill + "You voted X" box alive
      // after a PR merges, with a "Merged" badge instead of the controls
      // disappearing. /merged now carries status + yes/no/my_vote for this.
      const merged = mergedRes.ok ? (await mergedRes.json()).merged : [];
      // Shared snapshot for the inline vote buttons rendered on group-chat
      // "promoted / voted" activity rows (see group-chat.js). Keyed by
      // session id; rebuilt on every panel reload so the inline buttons
      // track the panel exactly (live counts, my_vote, votable status).
      // Promoted/merging come first; merged rows fill in any sessions not
      // already present so an open PR's live row always wins over its
      // merged snapshot.
      const voteRows = [...(merged || []), ...(promoted || [])];
      AppView.voteState = {
        bySession: Object.fromEntries(voteRows.map((pr) => [String(pr.id), pr])),
        // Also index by GitHub PR number so group-chat activity rows that
        // predate the metadata.vote tag (or any row, as a fallback) can be
        // matched from the "PR #N" in their text. pr_number is unique per
        // app, and the endpoints are app-scoped, so this is unambiguous.
        byPrNumber: Object.fromEntries(
          voteRows.filter((pr) => pr.pr_number != null).map((pr) => [String(pr.pr_number), pr])
        ),
        majority,
        activeUsers,
      };
      // Whether the current viewer is in the active set for this app
      // (per src/services/active-users.js). Surfaced as a one-line
      // status on the Users dashboard tile.
      const viewerActive = !!promotedData.viewerActive;
      // Admin-gated change lock (apps.locked). When true, every merge
      // path (PR merge, rename proposal, secret-change proposal) also
      // requires an admin yes/up vote on top of the active-user
      // majority — see routes/votes.js + routes/issues.js. Surface as
      // a one-line hint on the relevant sections so voters aren't
      // confused by a stuck-at-majority PR.
      const appLocked = !!promotedData.locked;
      const lockedHint = appLocked
        ? ' <span class="text-amber-500 font-normal">· locked: also needs an admin yes</span>'
        : '';
      // Always-visible top-level notice for locked apps. The panel
      // body is collapsed by default, so the per-section `lockedHint`
      // above is invisible until a user expands the panel — which
      // means a non-admin who promotes a PR has no on-screen signal
      // about why their majority-reached PR isn't merging. This line
      // sits *outside* `gc-panel-body` so it's visible whether the
      // panel is open or closed. Refresh on lock toggle is already
      // wired: `App.handleAppUpdate` calls `loadVotePanel()` on the
      // `lock_changed` WS event.
      const lockNotice = appLocked
        ? `<div class="mt-2 text-xs text-amber-500">App is locked — an admin must approve any PR before it merges.</div>`
        : '';
      const issuesData = issuesRes.ok ? await issuesRes.json() : { issues: [] };
      const allIssues = issuesData.issues || [];
      const renameProposals = allIssues.filter((i) => i.kind === 'rename');
      const issues = allIssues.filter((i) => i.kind !== 'rename');

      // Activity-only summary (excludes the Users tile, which is
      // always present and isn't really "activity"). Empty when
      // nothing's happening so the pill stays clean.
      const counts = [
        promoted.length && `${promoted.length} open PR${promoted.length > 1 ? 's' : ''}`,
        renameProposals.length && `${renameProposals.length} rename proposal${renameProposals.length > 1 ? 's' : ''}`,
        issues.length && `${issues.length} issue${issues.length > 1 ? 's' : ''}`,
        merged.length && `${merged.length} merged`,
      ].filter(Boolean).join(' · ');

      // How many open PRs the viewer still hasn't voted on. We count only
      // PRs that are actually votable for them right now: status
      // 'promoted' (not 'merging', which is past the vote) with no
      // recorded vote. The viewer's own PRs are included — authors still
      // need to cast an explicit yes/no on their own proposal. Drives the
      // "Vote on N →" CTA in the panel header so the call to action is
      // visible even while the panel body is collapsed.
      const unvotedCount = promoted.filter(
        (pr) => pr.status === 'promoted' && !pr.my_vote
      ).length;
      const unvotedCtaHtml = unvotedCount
        ? `<span id="gc-vote-cta" role="button" tabindex="0" class="cursor-pointer text-xs font-medium text-violet-600 dark:text-violet-400 hover:underline whitespace-nowrap" title="Jump to the PRs you haven't voted on yet">Vote on ${unvotedCount} PR${unvotedCount === 1 ? '' : 's'} &rarr;</span>`
        : '';

      // (3) Just-in-time teaching: the first time a viewer sees open PRs
      // in the vote panel, explain what a vote actually does. Gated on a
      // localStorage flag so it teaches once, then gets out of the way —
      // "onboarding that's indistinguishable from using the app".
      let voteHintHtml = '';
      try {
        if (promoted.length && !localStorage.getItem('usernode_seen_vote_hint')) {
          voteHintHtml = `<div class="text-xs text-zinc-500 dark:text-zinc-400 mb-1 italic">These are proposed changes. When a majority of the app's active users vote yes, the change merges and goes live for everyone.</div>`;
          localStorage.setItem('usernode_seen_vote_hint', '1');
        }
      } catch { /* private-mode / disabled storage: just skip the hint */ }

      let bodyHtml = '';

      // Users tile — first piece of the new dashboard. activeUsers is
      // the same metric the platform uses for vote-majority thresholds
      // (sticky qualification: >=60s on a single day ever + visit in
      // the last 10 days, see src/services/active-users.js). Always
      // rendered, even when there's no other activity, so the panel
      // always has something worth opening for. The viewer-status
      // sub-line tells the current user whether they're counted and,
      // if not, how to qualify.
      const viewerStatusHtml = viewerActive
        ? `<div class="text-xs mt-1 text-emerald-600 dark:text-emerald-400">&check; You're a voting user of this app — your vote helps decide which changes ship.</div>`
        : `<div class="text-xs mt-1 text-zinc-500 dark:text-zinc-400">Spend a minute on the App tab to become a voting user — then you help decide which changes ship.</div>`;
      bodyHtml += `
        <div class="mb-3">
          <div class="text-xs text-zinc-500 dark:text-zinc-400 mb-1 font-medium">Users</div>
          <div class="text-sm text-zinc-700 dark:text-zinc-300">
            <span class="font-semibold text-zinc-900 dark:text-zinc-100">${activeUsers}</span>
            active in the last 10 days
          </div>
          ${viewerStatusHtml}
        </div>`;

      if (promoted.length) {
        // The inner divide-y wrapper draws a 1px line between consecutive
        // gc-vote-items on phones where each item now spans 2 rows
        // (title row + controls row). On sm+ we drop the dividers via
        // `sm:divide-y-0` so the original single-row list stays visually
        // unchanged. Same pattern on every list section below.
        bodyHtml += `<div class="mb-2"><div class="text-xs text-zinc-500 mb-1 font-medium">Open PRs <span class="text-zinc-600 font-normal">(need ${majority}/${activeUsers} votes to merge)</span>${lockedHint}</div>${voteHintHtml}<div class="divide-y divide-zinc-200 dark:divide-zinc-800 sm:divide-y-0 border-y border-zinc-200 dark:border-zinc-800 sm:border-y-0">`;
        for (const pr of promoted) {
          const isMerging = pr.status === 'merging';
          // Prefer the LLM-generated PR title when present; fall back
          // to the original "by <user>" label so old rows (pre-pr_title)
          // still render reasonably.
          // #11: revert PRs get a distinctive label so voters in the
          // panel know this is a rollback (not a forward feature).
          // original_pr_number/_title come from the LEFT JOIN against
          // chat_sessions in /promoted (see routes/votes.js).
          let labelText;
          if (pr.revert_of_session_id) {
            const origLabel = pr.original_pr_title
              ? `${escapeHtml(pr.original_pr_title)}`
              : `PR #${pr.original_pr_number || pr.revert_of_session_id}`;
            labelText = `<span class="text-amber-500">↩ Revert of</span> ${origLabel} <span class="text-zinc-500">· ${escapeHtml(pr.username)}</span>`;
          } else {
            labelText = pr.pr_title
              ? `${escapeHtml(pr.pr_title)} <span class="text-zinc-500">· ${escapeHtml(pr.username)}</span>`
              : `by ${escapeHtml(pr.username)}`;
          }
          // While merging is in flight we keep the full row (tally pill +
          // vote controls) so none of the voting info vanishes; a "Merging…"
          // badge is appended alongside instead of replacing everything.
          // Kudos button piggybacks on the same PR row. The vote
          // panel/PR card already carries kudos_count + my_kudos from
          // the /promoted query (extended in routes/votes.js); we
          // pass the full row so Kudos.renderButton's self-kudos
          // check (viewer === pr.user_id) works.
          const kudosBtn = window.Kudos
            ? Kudos.renderButton(pr, { compact: true })
            : '';
          // Admin force-merge button: lets an admin land a PR right
          // now without waiting for the active-user majority. Sits to
          // the right of the regular Yes/No buttons so the normal
          // voting affordances stay primary; the danger styling +
          // ConfirmModal in castAdminMerge keep it from being a
          // misclick risk. Mirrors the visibility gate used on the
          // home-card admin actions: App.user?.isAdmin only — the
          // "View as non-admin" tool already masks this client-side
          // (see app.js).
          // Preview / Yes / No / Admin-merge buttons come from the shared
          // AppView.voteButtonsHtml so the panel and the inline group-chat
          // activity-row buttons stay byte-identical.
          // #15: make the PR title tap-to-quote into group chat. A clean
          // text snapshot rides along in data-* so the composer/preview
          // doesn't have to re-parse the labelText HTML.
          const prQuoteTitle = pr.pr_title || `PR #${pr.pr_number || pr.id}`;
          const prQuoteAttrs = `class="text-xs text-zinc-300 flex-1 min-w-0 truncate gc-quote-pr" `
            + `data-session-id="${pr.id}" data-pr-number="${pr.pr_number || pr.id}" `
            + `data-pr-title="${escapeHtml(prQuoteTitle)}" data-pr-author="${escapeHtml(pr.username)}" `
            + `data-pr-url="${pr.pr_url || ''}" title="Tap to reply in chat"`;
          // Mobile layout: PR# + title share row 1; counts + vote/admin/
          // kudos buttons live in a wrapper that's `basis-full` (its own
          // row) below sm and `sm:contents` (transparent passthrough) at
          // sm+. The outer flex-wrap + the wrapper's basis-full force a
          // line break before the controls on narrow screens, so the
          // title with `flex-1 min-w-0 truncate` actually has horizontal
          // room to render the LLM-generated PR title (otherwise the
          // ~400px sum of trailing buttons starves it on 360-390px
          // phones). On sm+ display:contents removes the wrapper from
          // the box tree and the layout collapses back to the original
          // single-row form, preserving desktop UX exactly.
          // Tag rows the viewer hasn't voted on (same rule as the header
          // CTA count) so the CTA can smooth-scroll to the first one, and
          // show an at-a-glance "Vote" marker (pulsing dot, mirroring the
          // status.html ping pattern) so it's obvious which rows still
          // want your input.
          const isUnvoted = pr.status === 'promoted' && !pr.my_vote;
          const unvotedBadge = isUnvoted
            ? `<span class="inline-flex items-center gap-1 text-[0.65rem] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400 shrink-0" title="You haven't voted on this yet"><span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75 animate-ping"></span><span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-violet-500"></span></span>Vote</span>`
            : '';
          const mergingBadge = isMerging ? AppView.mergingBadgeHtml() : '';
          bodyHtml += `
            <div class="gc-vote-item flex flex-wrap items-center gap-x-2 gap-y-1 py-1${isMerging ? ' opacity-70' : ''}"${isUnvoted ? ' data-unvoted="1"' : ''}>
              <a href="${pr.pr_url || '#'}" target="_blank" rel="noopener noreferrer" class="text-xs text-violet-400 font-mono hover:underline">PR#${pr.pr_number || pr.id}</a>
              <span ${prQuoteAttrs}>${labelText}</span>
              <div class="basis-full sm:basis-auto sm:contents flex items-center gap-2">
                ${unvotedBadge}
                ${AppView.voteCountPill(pr, majority)}
                ${AppView.voteButtonsHtml(pr)}
                ${mergingBadge}
                ${kudosBtn}
              </div>
            </div>`;
        }
        bodyHtml += '</div></div>';
      }

      if (renameProposals.length) {
        bodyHtml += `<div class="mb-2"><div class="text-xs text-zinc-500 mb-1 font-medium">Rename proposals <span class="text-zinc-600 font-normal">(need ${majority}/${activeUsers} up-votes to apply)</span>${lockedHint}</div><div class="divide-y divide-zinc-200 dark:divide-zinc-800 sm:divide-y-0 border-y border-zinc-200 dark:border-zinc-800 sm:border-y-0">`;
        for (const issue of renameProposals) {
          const myVote = issue.my_vote;
          const upCount = parseInt(issue.up_count) || 0;
          const progress = majority > 0 ? Math.min(100, (upCount / majority) * 100) : 0;
          const newName = (issue.payload && issue.payload.newName) || issue.title;
          bodyHtml += `
            <div class="gc-vote-item flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
              <span class="text-xs text-zinc-300 flex-1 min-w-0 truncate" title="Proposed by ${issue.created_by_username || ''}">&#8594; ${escapeHtml(newName)}</span>
              <div class="basis-full sm:basis-auto sm:contents flex items-center gap-2">
                <span class="text-xs text-zinc-500">${upCount}/${majority}</span>
                <button class="gc-vote-btn ${myVote === 'up' ? 'gc-vote-active' : ''}" onclick="AppView.castIssueVote(${issue.id}, 'up')">&#9650; ${issue.up_count}</button>
                <button class="gc-vote-btn ${myVote === 'down' ? 'gc-vote-active' : ''}" onclick="AppView.castIssueVote(${issue.id}, 'down')">&#9660; ${issue.down_count}</button>
              </div>
            </div>`;
        }
        bodyHtml += '</div></div>';
      }

      if (issues.length) {
        bodyHtml += '<div class="mb-2"><div class="text-xs text-zinc-500 mb-1 font-medium">Issues</div><div class="divide-y divide-zinc-200 dark:divide-zinc-800 sm:divide-y-0 border-y border-zinc-200 dark:border-zinc-800 sm:border-y-0">';
        for (const issue of issues.slice(0, 5)) {
          const myVote = issue.my_vote;
          bodyHtml += `
            <div class="gc-vote-item flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
              <span class="text-xs text-zinc-300 flex-1 min-w-0 truncate">${escapeHtml(issue.title)}</span>
              <div class="basis-full sm:basis-auto sm:contents flex items-center gap-2">
                <button class="gc-vote-btn ${myVote === 'up' ? 'gc-vote-active' : ''}" onclick="AppView.castIssueVote(${issue.id}, 'up')">&#9650; ${issue.up_count}</button>
                <button class="gc-vote-btn ${myVote === 'down' ? 'gc-vote-active' : ''}" onclick="AppView.castIssueVote(${issue.id}, 'down')">&#9660; ${issue.down_count}</button>
              </div>
            </div>`;
        }
        bodyHtml += '</div></div>';
      }

      // Note: the "Propose rename" trigger lives in the dev-chat tab's
      // Edit section now (see renderDevChatTab) — keeping the group
      // chat panel focused on visible PRs / issues / merged work.

      if (merged.length) {
        bodyHtml += `<div><div class="text-xs text-zinc-500 mb-1 font-medium">Merged <span class="text-zinc-600 font-normal">(undo opens a revert PR — needs ${majority}/${activeUsers} votes to land)</span></div><div class="divide-y divide-zinc-200 dark:divide-zinc-800 sm:divide-y-0 border-y border-zinc-200 dark:border-zinc-800 sm:border-y-0">`;
        for (const pr of merged) {
          const date = new Date(pr.created_at).toLocaleDateString();
          const mergedLabel = pr.pr_title
            ? `${escapeHtml(pr.pr_title)} <span class="text-zinc-500">· ${escapeHtml(pr.username)}</span>`
            : `by ${escapeHtml(pr.username)}`;
          // #15: merged PR title is also tap-to-quote into group chat.
          const mergedQuoteTitle = pr.pr_title || `PR #${pr.pr_number || pr.id}`;
          const mergedQuoteAttrs = `class="text-xs text-zinc-400 flex-1 min-w-0 truncate gc-quote-pr" `
            + `data-session-id="${pr.id}" data-pr-number="${pr.pr_number || pr.id}" `
            + `data-pr-title="${escapeHtml(mergedQuoteTitle)}" data-pr-author="${escapeHtml(pr.username)}" `
            + `data-pr-url="${pr.pr_url || ''}" title="Tap to reply in chat"`;
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
            undoUI = `<a href="${linkHref}" target="_blank" rel="noopener noreferrer" class="text-xs text-amber-500 hover:text-amber-400 font-medium">${label}</a>`;
          } else {
            undoUI = `
              <button class="gc-vote-btn gc-vote-btn-undo"
                title="Open a revert PR for this merge. It still needs a merge vote to land."
                onclick="AppView.undoPr(${pr.id})">Undo</button>`;
          }

          bodyHtml += `
            <div class="gc-vote-item flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
              <a href="${pr.pr_url || '#'}" target="_blank" rel="noopener noreferrer" class="text-xs text-emerald-400 font-mono hover:underline">PR#${pr.pr_number || pr.id}</a>
              <span ${mergedQuoteAttrs}>${mergedLabel}</span>
              <div class="basis-full sm:basis-auto sm:contents flex items-center gap-2">
                ${AppView.voteCountPill(pr, majority)}
                ${AppView.voteButtonsHtml(pr, { collapseVoted: true })}
                <span class="text-xs text-zinc-600">${date}</span>
                ${undoUI}
                ${kudosBtn}
              </div>
            </div>`;
        }
        bodyHtml += '</div></div>';
      } else {
        // (#2) Empty vote panel → teach the Dev-Chat ↔ voting connection,
        // the single most important link in the loop. Shown whenever no
        // PR is currently up for a vote.
        bodyHtml += `<div class="mb-2"><div class="text-xs text-zinc-500 dark:text-zinc-400">No changes are up for a vote right now. Got an idea? Open <span class="font-medium text-emerald-600 dark:text-emerald-400">Dev Chat</span> and describe it.</div></div>`;
      }

      // Pill: fixed title on the left ("App information and activity")
      // + an optional activity summary on the right. The summary keeps
      // the at-a-glance utility the old pill had ("2 open PRs · ..."),
      // but only when there's actually something — when nothing's
      // open, the right side stays empty and the pill is just a clean
      // affordance for opening the dashboard.
      // Sticky header so the toggle + activity summary stay reachable
      // while the panel body scrolls. -mx-3/-mt-2 cancels the parent's
      // px-3/py-2 padding so the header bg spans the full panel width
      // and sits flush against the top of the scroll container; px-3
      // py-2 inside puts the same padding back on the toggle itself,
      // so the visual position of the button doesn't shift. The
      // border-b only appears once content has scrolled underneath the
      // sticky bar (CSS sibling selector + JS scroll listener below).
      panel.innerHTML = `
        <div id="gc-panel-sticky" class="sticky top-0 z-10 -mx-3 -mt-2 px-3 py-2 bg-white dark:bg-zinc-950 border-b border-transparent">
          <button id="gc-panel-toggle" class="flex items-center gap-2 w-full text-left">
            <span class="text-xs text-zinc-500 dark:text-zinc-400">${AppView.panelOpen ? '&#9660;' : '&#9654;'}</span>
            <span class="text-xs font-medium text-zinc-700 dark:text-zinc-300">App information and activity</span>
            <span class="flex-1"></span>
            ${counts ? `<span class="text-xs text-zinc-500 dark:text-zinc-400 truncate">${counts}</span>` : ''}
            ${unvotedCtaHtml}
          </button>
        </div>
        ${lockNotice}
        <div id="gc-panel-body" class="${AppView.panelOpen ? '' : 'hidden'} mt-2">${bodyHtml}</div>`;

      // Keep the inline vote buttons on group-chat activity rows in sync
      // with the panel we just rebuilt (covers the "chat rendered before
      // the panel finished fetching" race on first open, and every live
      // vote/session update that reloads the panel).
      if (typeof GroupChat !== 'undefined' && GroupChat.refreshVoteControls) {
        GroupChat.refreshVoteControls();
      }

      // Add a faint border to the sticky header once the panel scrolls,
      // so it visually separates from content sliding underneath it.
      const stickyEl = document.getElementById('gc-panel-sticky');
      const scrollEl = document.getElementById('gc-panel');
      if (stickyEl && scrollEl) {
        const updateStickyBorder = () => {
          stickyEl.classList.toggle('border-zinc-200', scrollEl.scrollTop > 0);
          stickyEl.classList.toggle('dark:border-zinc-800', scrollEl.scrollTop > 0);
          stickyEl.classList.toggle('border-transparent', scrollEl.scrollTop === 0);
        };
        scrollEl.addEventListener('scroll', updateStickyBorder, { passive: true });
        updateStickyBorder();
      }

      document.getElementById('gc-panel-toggle').addEventListener('click', () => {
        AppView.panelOpen = !AppView.panelOpen;
        AppView._writeInfoPanelOpen(slug, AppView.panelOpen);
        const body = document.getElementById('gc-panel-body');
        const arrow = document.querySelector('#gc-panel-toggle span:first-child');
        if (body) body.classList.toggle('hidden');
        if (arrow) arrow.innerHTML = AppView.panelOpen ? '&#9660;' : '&#9654;';
        // Flip the divider between plain border / grabbable handle and
        // (re)apply the saved height now that the open state changed.
        AppView._syncPanelResizer(slug);
      });

      // "Vote on N →" CTA: lives inside the toggle button, so we stop
      // propagation (we always want to *open* the panel and jump to the
      // first unvoted PR, never toggle it closed) and then scroll the
      // first unvoted row into view.
      const voteCta = document.getElementById('gc-vote-cta');
      if (voteCta) {
        const openAndScroll = (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (!AppView.panelOpen) {
            AppView.panelOpen = true;
            AppView._writeInfoPanelOpen(slug, true);
            const body = document.getElementById('gc-panel-body');
            const arrow = document.querySelector('#gc-panel-toggle span:first-child');
            if (body) body.classList.remove('hidden');
            if (arrow) arrow.innerHTML = '&#9660;';
            AppView._syncPanelResizer(slug);
          }
          const target = panel.querySelector('[data-unvoted="1"]');
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
        voteCta.addEventListener('click', openAndScroll);
        voteCta.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') openAndScroll(e);
        });
      }

      // Bind hover + click handlers for any kudos buttons we just
      // rendered. Idempotent — Kudos.attach skips wrappers it has
      // already bound (data-kudos-bound flag).
      if (window.Kudos) Kudos.attach(panel);
    } catch {
      panel.innerHTML = '';
    }
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
      if (AppView.appData) AppView.loadVotePanel(AppView.appData.slug);
    } catch (err) {
      alert(`Undo failed: ${err.message}`);
    } finally {
      AppView._voteInFlight.delete(key);
    }
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
    const preview = pr.staging_url
      ? `<button class="gc-vote-btn gc-vote-btn-preview" onclick="AppView.swapToStaging('${pr.staging_url}')">Preview</button>`
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
      if (AppView.appData) AppView.loadVotePanel(AppView.appData.slug);
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
      await fetch(`/api/sessions/${sessionId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vote }),
      });
      if (AppView.appData) AppView.loadVotePanel(AppView.appData.slug);
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
      if (AppView.appData) AppView.loadVotePanel(AppView.appData.slug);
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
    submitBtn.textContent = 'Proposing...';
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'rename', payload: { newName: next } }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showError(data.error || 'Failed to propose rename');
        return;
      }
      AppView.closeRenameModal();
      AppView.loadVotePanel(AppView.appData.slug);
    } catch {
      showError('Network error while proposing rename');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Propose';
    }
  },

  // Called by the global WS handler when this app is renamed by group vote.
  applyRename(newName) {
    if (!AppView.appData) return;
    AppView.appData.name = newName;
    if (App.currentTab === 'group-chat') {
      AppView.loadVotePanel(AppView.appData.slug);
    }
  },

  async renderDevChatTab(restoreSessionId) {
    const content = document.getElementById('app-content');
    // Layout: a meta block (#dc-meta) holds two stacked sections — the
    // app-edit shortcuts and the sessions header — sitting above the
    // session list / chat surface (#dc-view). DevChat.renderChatView
    // toggles `hidden` on #dc-meta when a session opens so the chat
    // gets the full tab; backing out via #dc-back unhides it.
    // Layout note: each row is styled like an iOS settings cell — icon,
    // label, current value preview, chevron — so a glance at the panel
    // tells you the app's secret-fill status and current display name
    // without opening either modal. The right-side preview text is
    // populated below: display name comes straight from appData; the
    // secrets summary is fetched async via refreshDevChatSecretsState
    // so this render path stays synchronous.
    const currentName = escapeHtml(AppView.appData?.name || '');
    content.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;min-height:0">
        <div id="dc-meta" class="shrink-0">
          <!-- Active Sessions panel: cross-app view of every
               non-archived session the user owns, with the busy ones
               (CC actively running) listed and an (x/y) indicator in
               the header. Lives in the meta block so it's visible
               whenever the user is in the session list (and hides
               with the rest of #dc-meta on session open, where the
               focused chat takes over). DevChat.startActiveSessionsPoll
               fills #dc-active-list and updates #dc-active-counter on
               a 5s tick. -->
          <div class="px-3 pt-3 pb-3 border-b border-zinc-200 dark:border-zinc-800">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs uppercase font-semibold text-zinc-500 dark:text-zinc-400 tracking-wider">Sessions</span>
              <span id="dc-active-counter" class="text-xs text-zinc-400 dark:text-zinc-500 font-mono">(0/3)</span>
            </div>
            <div id="dc-active-list" class="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 divide-y divide-zinc-200 dark:divide-zinc-700" style="max-height:200px;overflow-y:auto"></div>
          </div>

          <!-- Edit section: app-level controls that previously lived in
               the global header (App secrets) or the group-chat vote
               panel (Propose rename). Both still pop the same modals;
               only the entry point moved. -->
          <div class="px-3 pt-3 pb-3 border-b border-zinc-200 dark:border-zinc-800 space-y-2">
            <div class="text-xs uppercase font-semibold text-zinc-500 dark:text-zinc-400 tracking-wider mb-1">Edit</div>
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
          </div>

          <!-- Sessions section header: matches the Edit label's small
               uppercase treatment so the two sections feel like a
               single panel rather than two unrelated rows. -->
          <div class="flex items-center justify-between px-3 pt-3 pb-2 border-b border-zinc-200 dark:border-zinc-800">
            <span class="text-xs uppercase font-semibold text-zinc-500 dark:text-zinc-400 tracking-wider">Dev Sessions</span>
            <button id="dc-new-session" class="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1 text-xs font-medium text-white transition-colors">+ New Session</button>
          </div>
        </div>

        <div id="dc-view" style="flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden"></div>
      </div>`;

    // Populate the secrets-state preview. Fire-and-forget — the row
    // shows "Loading…" until the fetch lands. AppView.refreshDevChatSecretsState
    // is also called by Secrets after a successful direct edit so the
    // row stays in sync without a manual reload.
    AppView.refreshDevChatSecretsState();

    // Kick off the cross-app active-sessions poll. startActiveSessionsPoll
    // tears down any previous timer first, so re-rendering the tab
    // (e.g. on hash restore or app switch) doesn't stack pollers.
    DevChat.startActiveSessionsPoll();

    if (AppView.appData) {
      // Ground-truth guard: if the in-memory session belongs to a
      // different app than the one we're rendering (e.g. user was on
      // app A's dev chat, navigated away, then opened app B), drop it
      // before loading sessions. Otherwise `renderChatView` would
      // re-render the stale session for the wrong app (fixes #20).
      if (
        DevChat.currentSession &&
        DevChat.currentSession.app_slug &&
        DevChat.currentSession.app_slug !== AppView.appData.slug
      ) {
        DevChat.reset();
      }

      await DevChat.loadSessions(AppView.appData.slug);

      if (restoreSessionId) {
        await DevChat.openSession(restoreSessionId);
      } else if (!DevChat.currentSession) {
        DevChat.messages = [];
      }
      DevChat.renderChatView();
    }

    document.getElementById('dc-new-session').addEventListener('click', async () => {
      if (!AppView.appData) return;
      const session = await DevChat.createSession(AppView.appData.slug);
      if (session) {
        await DevChat.openSession(session.id);
        DevChat.renderChatView();
        // Sync the hash so a page refresh stays on this session instead
        // of dropping back to the session list.
        App.updateHash();
      }
    });

    // Edit section wiring. Both buttons just open the existing modals
    // — no behavior change vs the old header / group-chat triggers.
    document.getElementById('dc-edit-secrets').addEventListener('click', () => {
      if (window.Secrets) Secrets.openForCurrentApp();
    });
    document.getElementById('dc-edit-rename').addEventListener('click', () => {
      AppView.promptRename();
    });
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

  // Open staging in fullscreen overlay
  swapToStaging(stagingUrl) {
    const overlay = document.getElementById('staging-overlay');
    const iframe = document.getElementById('staging-iframe');
    const label = document.getElementById('staging-url-label');
    if (!overlay || !iframe) return;

    const resolved = resolveDevHost(stagingUrl);
    const src = AppView.iframeToken
      ? `${resolved}?token=${AppView.iframeToken}`
      : resolved;

    iframe.src = src;
    if (label) label.textContent = resolved;
    overlay.classList.remove('hidden');
    if (window.DevConsole) DevConsole.setButtonVisible(true);

    document.getElementById('staging-back').onclick = () => {
      AppView.closeStagingOverlay();
    };
  },

  closeStagingOverlay() {
    const overlay = document.getElementById('staging-overlay');
    const iframe = document.getElementById('staging-iframe');
    if (overlay) overlay.classList.add('hidden');
    if (iframe) iframe.src = '';
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
