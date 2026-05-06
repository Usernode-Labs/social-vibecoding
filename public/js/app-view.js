const AppView = {
  appData: null,
  iframeToken: null,
  activityInterval: null,
  tokenRefreshInterval: null,
  activeSeconds: 0,
  iframeFocused: false,

  // Iframe tokens are signed for 1h. Refresh at 45min so the child app never
  // sees an expired JWT during a long reading/editing session.
  TOKEN_REFRESH_MS: 45 * 60 * 1000,

  async open(slug) {
    const res = await fetch(`/api/apps/${slug}`);
    if (!res.ok) return;
    const { app: appData } = await res.json();
    AppView.appData = appData;

    await AppView.refreshToken();
    AppView.startActivityTracking(slug);
    AppView.startTokenRefresh();
    if (window.DevConsole) DevConsole.setCurrentApp(slug);
    // Populate the deployed-version pill in the header. It lives in the
    // shared header so it's visible across tabs (App / group-chat /
    // dev-chat) for the duration this app is open; close() clears it.
    AppView.refreshVersionPill();
    if (window.Secrets) {
      Secrets.show();
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
    if (!slug) return '';

    const isDeploying = !!(deployProgress && deployProgress.deploying);
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
            <span class="app-version-pill-name">${escapeHtml(slug)}</span>
            <span class="app-version-pill-sep">·</span>
            deploying
          </span>
        </span>`;
    }

    if (!version || !version.sha) {
      // Mirror the platform-version pill's "dev" state: render a
      // low-key chip so the slot is never empty (which can look like
      // a layout bug or a JS failure to render). Reachable for apps
      // still in `creating`, apps without a repo, or pre-#21 rows
      // that haven't been backfilled yet.
      return `
        <span class="app-version-pill" title="No deployed version recorded yet">
          <span class="app-version-pill-dot" style="background:#71717a;box-shadow:none"></span>
          <span class="app-version-pill-label">
            <span class="app-version-pill-name">${escapeHtml(slug)}</span>
            <span class="app-version-pill-sep">·</span>
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
    return `
      <a href="${href}" target="_blank" rel="noopener" class="app-version-pill" title="${escapeAttr(tip)}">
        <span class="app-version-pill-dot"></span>
        <span class="app-version-pill-label">
          <span class="app-version-pill-name">${escapeHtml(slug)}</span>
          <span class="app-version-pill-sep">·</span>
          ${escapeHtml(sha)}
        </span>
      </a>`;
  },

  renderGroupChatTab() {
    const content = document.getElementById('app-content');
    content.innerHTML = `
      <div class="flex flex-col h-full">
        <!-- Vote/issue panel -->
        <div id="gc-panel" class="shrink-0 border-b border-zinc-200 dark:border-zinc-800">
          <div id="gc-panel-content" class="px-3 py-2"></div>
        </div>

        <!-- Messages -->
        <div id="gc-messages" class="flex-1 overflow-y-auto py-2 space-y-0.5"></div>

        <!-- Typing indicator -->
        <div id="gc-typing" class="px-3 text-xs text-zinc-500 h-5 shrink-0"></div>

        <!-- Input -->
        <div class="shrink-0 border-t border-zinc-200 dark:border-zinc-800 p-2">
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

    if (AppView.appData) {
      // `mount` re-uses the existing WS + message cache when the user
      // comes back to this tab, preserving their scroll position; it only
      // opens a fresh connection on the first visit to an app.
      GroupChat.mount(AppView.appData.slug);
      AppView.loadVotePanel(AppView.appData.slug);
    }
  },

  panelOpen: true,

  async loadVotePanel(slug) {
    const panel = document.getElementById('gc-panel-content');
    if (!panel) return;

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
      const issuesData = issuesRes.ok ? await issuesRes.json() : { issues: [] };
      const allIssues = issuesData.issues || [];
      const renameProposals = allIssues.filter((i) => i.kind === 'rename');
      const issues = allIssues.filter((i) => i.kind !== 'rename');
      const merged = mergedRes.ok ? (await mergedRes.json()).merged : [];

      const counts = [
        promoted.length && `${promoted.length} open PR${promoted.length > 1 ? 's' : ''}`,
        renameProposals.length && `${renameProposals.length} rename proposal${renameProposals.length > 1 ? 's' : ''}`,
        issues.length && `${issues.length} issue${issues.length > 1 ? 's' : ''}`,
        merged.length && `${merged.length} merged`,
      ].filter(Boolean).join(' · ') || 'No activity';

      let bodyHtml = '';

      if (promoted.length) {
        bodyHtml += `<div class="mb-2"><div class="text-xs text-zinc-500 mb-1 font-medium">Open PRs <span class="text-zinc-600 font-normal">(need ${majority}/${activeUsers} votes to merge)</span></div>`;
        for (const pr of promoted) {
          const yesCount = parseInt(pr.yes_count);
          const isMerging = pr.status === 'merging';
          // Prefer the LLM-generated PR title when present; fall back
          // to the original "by <user>" label so old rows (pre-pr_title)
          // still render reasonably.
          const labelText = pr.pr_title
            ? `${escapeHtml(pr.pr_title)} <span class="text-zinc-500">· ${escapeHtml(pr.username)}</span>`
            : `by ${escapeHtml(pr.username)}`;
          if (isMerging) {
            // Threshold crossed; the merge pipeline (GitHub merge +
            // prod rebuild + staging teardown) is in flight. Keep the
            // row visible with a spinner so it doesn't look like the
            // PR got lost between "majority reached" and "merged".
            bodyHtml += `
              <div class="gc-vote-item flex items-center gap-2 py-1 opacity-70">
                <a href="${pr.pr_url || '#'}" target="_blank" class="text-xs text-violet-400 font-mono hover:underline">PR#${pr.pr_number || pr.id}</a>
                <span class="text-xs text-zinc-300 flex-1 truncate">${labelText}</span>
                <span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>
                <span class="text-xs text-emerald-400">Merging…</span>
              </div>`;
            continue;
          }
          bodyHtml += `
            <div class="gc-vote-item flex items-center gap-2 py-1">
              <a href="${pr.pr_url || '#'}" target="_blank" class="text-xs text-violet-400 font-mono hover:underline">PR#${pr.pr_number || pr.id}</a>
              <span class="text-xs text-zinc-300 flex-1 truncate">${labelText}</span>
              <span class="text-xs text-zinc-500">${yesCount}/${majority}</span>
              ${pr.staging_url ? `<button class="gc-vote-btn gc-vote-btn-preview" onclick="AppView.swapToStaging('${pr.staging_url}')">Preview</button>` : ''}
              <button class="gc-vote-btn gc-vote-btn-yes${pr.my_vote === 'yes' ? ' gc-vote-active' : ''}" onclick="AppView.castVote(${pr.id}, 'yes')">Yes (${pr.yes_count})</button>
              <button class="gc-vote-btn gc-vote-btn-no${pr.my_vote === 'no' ? ' gc-vote-active' : ''}" onclick="AppView.castVote(${pr.id}, 'no')">No (${pr.no_count})</button>
            </div>`;
        }
        bodyHtml += '</div>';
      }

      if (renameProposals.length) {
        bodyHtml += `<div class="mb-2"><div class="text-xs text-zinc-500 mb-1 font-medium">Rename proposals <span class="text-zinc-600 font-normal">(need ${majority}/${activeUsers} up-votes to apply)</span></div>`;
        for (const issue of renameProposals) {
          const myVote = issue.my_vote;
          const upCount = parseInt(issue.up_count) || 0;
          const progress = majority > 0 ? Math.min(100, (upCount / majority) * 100) : 0;
          const newName = (issue.payload && issue.payload.newName) || issue.title;
          bodyHtml += `
            <div class="gc-vote-item flex items-center gap-2 py-1">
              <span class="text-xs text-zinc-300 flex-1 truncate" title="Proposed by ${issue.created_by_username || ''}">&#8594; ${escapeHtml(newName)}</span>
              <span class="text-xs text-zinc-500">${upCount}/${majority}</span>
              <button class="gc-vote-btn ${myVote === 'up' ? 'gc-vote-active' : ''}" onclick="AppView.castIssueVote(${issue.id}, 'up')">&#9650; ${issue.up_count}</button>
              <button class="gc-vote-btn ${myVote === 'down' ? 'gc-vote-active' : ''}" onclick="AppView.castIssueVote(${issue.id}, 'down')">&#9660; ${issue.down_count}</button>
            </div>`;
        }
        bodyHtml += '</div>';
      }

      if (issues.length) {
        bodyHtml += '<div class="mb-2"><div class="text-xs text-zinc-500 mb-1 font-medium">Issues</div>';
        for (const issue of issues.slice(0, 5)) {
          const myVote = issue.my_vote;
          bodyHtml += `
            <div class="gc-vote-item flex items-center gap-2 py-1">
              <span class="text-xs text-zinc-300 flex-1 truncate">${escapeHtml(issue.title)}</span>
              <button class="gc-vote-btn ${myVote === 'up' ? 'gc-vote-active' : ''}" onclick="AppView.castIssueVote(${issue.id}, 'up')">&#9650; ${issue.up_count}</button>
              <button class="gc-vote-btn ${myVote === 'down' ? 'gc-vote-active' : ''}" onclick="AppView.castIssueVote(${issue.id}, 'down')">&#9660; ${issue.down_count}</button>
            </div>`;
        }
        bodyHtml += '</div>';
      }

      bodyHtml += `
        <div class="pt-1 border-t border-zinc-200 dark:border-zinc-800">
          <button class="gc-vote-btn" onclick="AppView.promptRename()">Propose rename</button>
        </div>`;

      if (merged.length) {
        bodyHtml += '<div><div class="text-xs text-zinc-500 mb-1 font-medium">Merged</div>';
        for (const pr of merged) {
          const date = new Date(pr.created_at).toLocaleDateString();
          const mergedLabel = pr.pr_title
            ? `${escapeHtml(pr.pr_title)} <span class="text-zinc-500">· ${escapeHtml(pr.username)}</span>`
            : `by ${escapeHtml(pr.username)}`;
          bodyHtml += `
            <div class="gc-vote-item flex items-center gap-2 py-1">
              <a href="${pr.pr_url || '#'}" target="_blank" class="text-xs text-emerald-400 font-mono hover:underline">PR#${pr.pr_number || pr.id}</a>
              <span class="text-xs text-zinc-400 flex-1 truncate">${mergedLabel}</span>
              <span class="text-xs text-zinc-600">${date}</span>
            </div>`;
        }
        bodyHtml += '</div>';
      }

      panel.innerHTML = `
        <button id="gc-panel-toggle" class="flex items-center gap-2 w-full text-left">
          <span class="text-xs text-zinc-400">${AppView.panelOpen ? '&#9660;' : '&#9654;'}</span>
          <span class="text-xs text-zinc-400 flex-1">${counts}</span>
        </button>
        <div id="gc-panel-body" class="${AppView.panelOpen ? '' : 'hidden'} mt-2">${bodyHtml}</div>`;

      document.getElementById('gc-panel-toggle').addEventListener('click', () => {
        AppView.panelOpen = !AppView.panelOpen;
        const body = document.getElementById('gc-panel-body');
        const arrow = document.querySelector('#gc-panel-toggle span:first-child');
        if (body) body.classList.toggle('hidden');
        if (arrow) arrow.innerHTML = AppView.panelOpen ? '&#9660;' : '&#9654;';
      });
    } catch {
      panel.innerHTML = '';
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
    if (next === current) return showError('New name must differ from the current one');

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
    content.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;min-height:0">
        <div class="flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <span class="text-sm font-medium text-zinc-300">Dev Sessions</span>
          <button id="dc-new-session" class="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1 text-xs font-medium text-white transition-colors">+ New Session</button>
        </div>
        <div id="dc-view" style="flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden"></div>
      </div>`;

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
