// Build trigger: no-op change to force a fresh staging build (2026-06-16).
// localStorage key for the user's last-chosen model. Single global
// key (not per-app/per-session) so the preference is sticky wherever
// the user goes — nobody wants "I set Opus here, but the next app
// reset me back to Sonnet".
const MODEL_STORAGE_KEY = 'usernode:dc:model';

function loadStoredModel() {
  try {
    const v = localStorage.getItem(MODEL_STORAGE_KEY);
    return typeof v === 'string' && v.trim() ? v : null;
  } catch {
    return null;
  }
}

const DevChat = {
  sessions: [],
  currentSession: null,
  messages: [],
  isStreaming: false,
  selectedModel: loadStoredModel() || 'claude-opus-4-8',
  _staleTimer: null,
  _abortController: null,
  // Most recent event _seq we've processed across any channel (POST SSE,
  // resumable EventSource, global WS). Used as the replay cursor when we
  // (re)open the resumable GET /events stream so the server's ring
  // buffer can backfill anything we missed during a disconnect.
  _lastSeenSeq: null,
  // Handle to the resumable EventSource, if open.
  _eventSource: null,

  // ----- Browser-title status indicator (#108, #142, #161) -----
  // While the user is on the dev-chat tab, the document title carries a
  // status marker for the current session's turn: "thinking" while the
  // Mayor / Claude Code is working. The old streaming-driven "✅ Done"
  // marker is gone (#161): every "finished while away" case now arms
  // notify_on_done server-side, so a session_done / auto_solve_done
  // notification always exists, and its ARRIVAL drives the completion
  // marker instead (see Notifications.handleIncoming →
  // setCompletionTitle). The completion marker lives in a separate slot
  // (_titleCompletion) that outranks the streaming status, is exempt
  // from the dev-chat-tab scoping, and STAYS until the user actually
  // comes back (visibilitychange / window focus — listeners at the
  // bottom of this file) or the triggering notification is read.
  _titleStatus: null, // null | 'thinking'
  // null | 'sessionDone' | 'autoSolveDone' | 'autoSolveFailed' (#161).
  // Single slot, last-write-wins — the badge count carries multiplicity.
  _titleCompletion: null,

  budget: null,

  // ----- Cross-app active sessions panel state -----
  // Powers the "Active Sessions (x/y)" section at the top of the
  // dev-chat tab. Lists every non-archived session the user owns
  // across all apps, with a `busy` flag for the ones where Claude
  // is actively running a turn right now. The point is "see all
  // your in-progress AI work at a glance, even from other apps"
  // so the user can hop between them without losing context.
  //
  // Refresh model: poll every 5s while the dev-chat tab is the
  // mounted tab; stop polling when the tab is unmounted (the
  // `_activePollTimer` guard cleans up). 5s is a compromise — fast
  // enough that the busy indicator feels live, slow enough that we
  // don't hammer the cross-app endpoint just because the user is
  // sitting on the dev-chat tab.
  activeSessions: { sessions: [], totals: { active: 0, promoted: 0, paused: 0, busy: 0, total: 0 } },
  _activePollTimer: null,

  // ----- Spec viewer state -----
  // Read-only viewer for the current session's spec doc + frozen
  // version history. Opened from inline preview cards rendered in the
  // chat timeline (see renderMessages). On wide viewports the viewer
  // mounts beside the chat as a side panel; on narrow viewports it
  // takes over the screen as a full-screen modal — handled by CSS, not
  // JS. State here only tracks open/closed + which version the user is
  // looking at.
  specViewer: {
    open: false,
    sessionId: null,           // session this state belongs to (guards stale loads)
    draftContent: '',          // latest spec_md from GET /api/sessions/:id/spec (always == latest version's content)
    versions: [],              // [{ version, built_at, commit_sha, pr_number, shared_to_group_at, ... }]
    viewVersion: 'latest',     // 'latest' (follow the highest version) or a specific version number
    viewVersionContent: null,  // cached content for a non-latest selection
    isLoading: false,
    activeTab: 'user',         // #196: 'user' | 'tech' — selected half of a two-section spec
  },

  // Initial MODELS map. Populated authoritatively from GET /api/models
  // at startup so the UI dropdown can never offer something the server
  // wouldn't accept (server-side allowlist lives in src/services/models.js).
  // Kept seeded with the current set so the dropdown renders correctly
  // before the fetch resolves on a slow connection. Each value carries
  // the display label plus output cost ($/MTok) so the selector can
  // surface cost; loadModels() refreshes this from the server.
  MODELS: {
    'claude-haiku-4-5': { label: 'Haiku 4.5', outputCostPerMTok: 5 },
    'claude-sonnet-5': { label: 'Sonnet 5', outputCostPerMTok: 15 },
    'claude-opus-4-8': { label: 'Opus 4.8', outputCostPerMTok: 25 },
    'claude-fable-5': { label: 'Fable 5', outputCostPerMTok: 50 },
  },

  // Default model id used when sanitization rejects a stale storage
  // value. Overwritten by GET /api/models with the server's authoritative
  // default so the two stay aligned.
  _defaultModel: 'claude-opus-4-8',

  // Fetch the authoritative model allowlist from the server. Replaces
  // the inline MODELS map so adding/removing a model on the server
  // (src/services/models.js) automatically flows to the dropdown
  // without a client redeploy. Resilient to network failures: on error
  // we keep whatever MODELS was previously populated with.
  async loadModels() {
    try {
      const res = await fetch('/api/models');
      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.models) && data.models.length) {
        const next = {};
        for (const m of data.models) {
          if (m && typeof m.id === 'string') {
            const label = (typeof m.label === 'string' && m.label) ? m.label : m.id;
            const outputCostPerMTok = typeof m.outputCostPerMTok === 'number'
              ? m.outputCostPerMTok
              : undefined;
            next[m.id] = { label, outputCostPerMTok };
          }
        }
        DevChat.MODELS = next;
      }
      if (data && typeof data.default === 'string' && data.default) {
        DevChat._defaultModel = data.default;
      }
      DevChat._sanitizeStoredModel();
    } catch {}
  },

  // Guard against a persisted model id that's no longer in MODELS
  // (e.g. we removed an old model). Without this the dropdown would
  // fall back to the first option visually while `selectedModel` held
  // the stale id — so the user would see "Haiku" on screen but send
  // some ancient slug on submit. Called right after module load and
  // again after loadModels() refreshes the allowlist.
  _sanitizeStoredModel() {
    if (!DevChat.MODELS[DevChat.selectedModel]) {
      DevChat.selectedModel = DevChat._defaultModel;
    }
  },

  // Clears all per-app state. Called when the user leaves an app (via
  // `AppView.close()`), so that opening another app and switching to the
  // dev chat tab shows a fresh session list instead of re-rendering the
  // previous app's session.
  reset() {
    // #161: leaving the app (home / different app) while a turn is
    // running counts as leaving the session — arm its completion
    // notification before the state below is dropped.
    if (DevChat.isStreaming && DevChat.currentSession) {
      DevChat._setNotifyOnDone(DevChat.currentSession.id, true);
    }
    DevChat.sessions = [];
    DevChat.currentSession = null;
    DevChat.messages = [];
    DevChat.isStreaming = false;
    DevChat.setTitleStatus(null);
    DevChat._staleTimer = null;
    DevChat._lastSeenSeq = null;
    DevChat._resetSpecViewer();
    DevChat.stopActiveSessionsPoll();
    if (DevChat._abortController) {
      try { DevChat._abortController.abort(); } catch {}
      DevChat._abortController = null;
    }
    if (DevChat._eventSource) {
      try { DevChat._eventSource.close(); } catch {}
      DevChat._eventSource = null;
    }
  },

  _resetSpecViewer() {
    DevChat.specViewer = {
      open: false,
      sessionId: null,
      draftContent: '',
      versions: [],
      viewVersion: 'latest',
      viewVersionContent: null,
      isLoading: false,
      activeTab: 'user',
    };
  },

  async refreshBudget() {
    try {
      const res = await fetch('/api/budget');
      if (res.ok) DevChat.budget = await res.json();
    } catch {}
    DevChat.renderBudget();
  },

  renderBudget() {
    // #463: budget data just changed (usage event, chat open, key
    // save/remove) — sync the credits-exhausted banner alongside the
    // meter. Runs before the meter's own element guard so the banner
    // clears/appears even when the meter isn't mounted.
    DevChat._applyCreditsBanner();
    const el = document.getElementById('dc-budget');
    if (!el) return;
    // BYOK (#30/#119/#212): billing is limit-first — the daily platform
    // allowance is consumed before any spend hits the user's own key —
    // so key-holders see the limit progress first (same red/yellow
    // thresholds as everyone else) and a "your key $X" figure only once
    // spillover billing to their key has actually started today. The
    // BYOK figure never gets threshold coloring — no cap applies to it.
    if (window.Settings?.state?.hasApiKey) {
      const last4 = window.Settings.state.keyLast4 || '••••';
      if (!DevChat.budget) {
        // Budget fetch hasn't landed yet — static badge until it does.
        el.innerHTML = `<span class="text-emerald-400" title="Using your Anthropic API key">your key · ${last4}</span>`;
        return;
      }
      const byokCents = DevChat.budget.byokSpentCents || 0;
      const byok = (byokCents / 100).toFixed(2);
      const spent = (DevChat.budget.spentCents / 100).toFixed(2);
      const limit = (DevChat.budget.limitCents / 100).toFixed(2);
      const pct = Math.min(100, (DevChat.budget.spentCents / DevChat.budget.limitCents) * 100);
      const color = pct > 80 ? 'text-red-400' : pct > 50 ? 'text-yellow-400' : 'text-emerald-400';
      const tip = `Today: $${spent} of your $${limit} platform daily limit`
        + (byokCents > 0 ? ` + $${byok} billed to your Anthropic key (…${last4})` : '')
        + `. The daily limit is used first; your key (…${last4}) takes over once it runs out. Resets at midnight UTC.`;
      let html = `<span class="text-zinc-600">limit </span><span class="${color}">$${spent}</span><span class="text-zinc-600">/$${limit}</span>`;
      if (byokCents > 0) {
        html += `<span class="text-zinc-600"> · </span><span class="text-emerald-400">your key $${byok}</span>`;
      }
      el.innerHTML = `<span title="${tip}">${html}</span>`;
      return;
    }
    if (!DevChat.budget) return;
    const spent = (DevChat.budget.spentCents / 100).toFixed(2);
    const limit = (DevChat.budget.limitCents / 100).toFixed(2);
    // #463: exhausted (no key saved) keeps the familiar $spent/$limit
    // pair — just unmistakably red, with the tooltip pointing at the
    // BYOK escape hatch. The banner carries the wordy explanation.
    if (DevChat._creditsExhausted()) {
      el.innerHTML = `<span title="Your free daily AI credits are used up. Resets at midnight UTC — or add your own Anthropic API key in Settings to keep working."><span class="text-red-500 font-semibold">$${spent}</span><span class="text-red-400">/$${limit}</span></span>`;
      return;
    }
    const pct = Math.min(100, (DevChat.budget.spentCents / DevChat.budget.limitCents) * 100);
    const color = pct > 80 ? 'text-red-400' : pct > 50 ? 'text-yellow-400' : 'text-emerald-400';
    el.innerHTML = `<span class="${color}">$${spent}</span><span class="text-zinc-600">/$${limit}</span>`;
  },

  // #463: true when the signed-in user is out of free credits AND has no
  // BYOK key to spill over to — the only state where AI work is actually
  // blocked. Key-holders never match (billing continues on their key),
  // and a missing budget fetch stays quiet rather than guessing.
  _creditsExhausted() {
    const b = DevChat.budget;
    if (!b) return false;
    if (window.Settings?.state?.hasApiKey) return false;
    const userOut = typeof b.spentCents === 'number' && typeof b.limitCents === 'number'
      && b.spentCents >= b.limitCents;
    const globalOut = typeof b.globalSpentCents === 'number' && typeof b.globalLimitCents === 'number'
      && b.globalSpentCents >= b.globalLimitCents;
    return userOut || globalOut;
  },

  // #463: the credits-exhausted banner (sibling of the sync banner,
  // #dc-sync-banner). Empty string when the show-condition doesn't hold.
  _renderCreditsBannerHtml() {
    if (!DevChat._creditsExhausted()) return '';
    const b = DevChat.budget;
    const userOut = b.spentCents >= b.limitCents;
    const lead = userOut
      ? 'You&rsquo;ve used up today&rsquo;s free AI credits.'
      : 'The platform&rsquo;s shared daily AI budget is used up.';
    return `
      <div id="dc-credits-banner" class="flex items-center gap-2 px-3 py-2 bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-900/50 text-xs">
        <svg class="w-4 h-4 text-red-500 dark:text-red-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
        </svg>
        <span class="text-red-800 dark:text-red-200 flex-1"><span class="font-semibold">${lead}</span> Resets at midnight UTC &mdash; or add your own Anthropic API key to keep working right now, billed to your own Anthropic account.</span>
        <button id="dc-credits-add-key" type="button" class="rounded bg-red-600 hover:bg-red-500 text-white px-2 py-1 text-xs font-medium shrink-0">Add API key</button>
      </div>`;
  },

  // Swap/insert/remove the banner in place (mirror of _applySyncBanner,
  // minus the full re-render fallback: the banner slot sits directly
  // above .dc-session-body, so we can insert without re-rendering and
  // avoid disturbing an in-flight stream).
  _applyCreditsBanner() {
    const existing = document.getElementById('dc-credits-banner');
    const html = DevChat.currentSession ? DevChat._renderCreditsBannerHtml() : '';
    if (existing) {
      if (html) {
        existing.outerHTML = html;
        DevChat._wireCreditsBanner();
      } else {
        existing.remove();
      }
    } else if (html) {
      const body = document.querySelector('.dc-session-body');
      if (body) {
        body.insertAdjacentHTML('beforebegin', html);
        DevChat._wireCreditsBanner();
      }
    }
  },

  _wireCreditsBanner() {
    const btn = document.getElementById('dc-credits-add-key');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (window.Settings) Settings.open({ focusApiKey: true });
    });
  },

  async loadSessions(appSlug) {
    try {
      const res = await fetch(`/api/apps/${appSlug}/sessions`);
      if (!res.ok) return;
      const { sessions } = await res.json();
      DevChat.sessions = sessions;
    } catch {}
  },

  // ── Cross-app active sessions ─────────────────────────────
  //
  // Pulls the user's full set of non-archived sessions across every
  // app they own and re-renders the "Active Sessions (x/y)" panel
  // on the dev-chat tab. Tolerates network blips (the panel just
  // shows the previous snapshot until the next poll lands).

  async loadActiveSessions() {
    try {
      const res = await fetch('/api/me/active-sessions');
      if (!res.ok) return;
      const data = await res.json();
      DevChat.activeSessions = {
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
        totals: data.totals || { active: 0, promoted: 0, paused: 0, busy: 0, total: 0 },
      };
      DevChat.renderActiveSessions();
    } catch {}
  },

  // Start the 5s poll that drives the active-sessions panel. Safe
  // to call multiple times — it tears down any previous timer
  // before installing a new one, which keeps double-mounts (e.g.
  // restoreFromHash → renderDevChatTab during navigation) from
  // stacking.
  startActiveSessionsPoll() {
    DevChat.stopActiveSessionsPoll();
    DevChat.loadActiveSessions();
    DevChat._activePollTimer = setInterval(() => {
      DevChat.loadActiveSessions();
    }, 5000);
  },

  stopActiveSessionsPoll() {
    if (DevChat._activePollTimer) {
      clearInterval(DevChat._activePollTimer);
      DevChat._activePollTimer = null;
    }
  },

  renderActiveSessions() {
    const container = document.getElementById('dc-active-list');
    const counter = document.getElementById('dc-active-counter');
    if (!container || !counter) return;

    const { sessions, totals } = DevChat.activeSessions;
    // Counter shows running-vs-cap on the left and the promoted/paused
    // backlogs on the right. The "/3" denominator is the per-user
    // active-session cap enforced by /api/apps/:slug/sessions and
    // /api/sessions/:id/resume — which counts only 'active' sessions
    // (#193): promoted ones (PR in a merge vote) are un-pausable and
    // exempt from the cap, so they're surfaced as their own " · N in
    // vote" segment instead of inflating the numerator. Paused sessions
    // are unlimited so they're surfaced separately too. Zero-count
    // segments are omitted to keep the common case clean.
    const ACTIVE_CAP = 3;
    const segments = [`(${totals.active}/${ACTIVE_CAP})`];
    if (totals.promoted > 0) segments.push(`${totals.promoted} in vote`);
    if (totals.paused > 0) segments.push(`${totals.paused} paused`);
    counter.textContent = segments.join(' · ');

    if (totals.total === 0) {
      container.innerHTML = `
        <div class="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
          No open dev sessions yet.
        </div>`;
      return;
    }

    // Sort: busy → other active → paused, then most-recent within
    // each bucket. Surfaces in-flight work first, paused at the
    // bottom where it's still visible but doesn't compete with the
    // sessions the user is actively working on.
    const rank = (s) => (s.busy ? 0 : s.status === 'paused' ? 2 : 1);
    const sorted = sessions.slice().sort((a, b) => {
      const dr = rank(a) - rank(b);
      if (dr !== 0) return dr;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    const currentSlug = (typeof AppView !== 'undefined' && AppView.appData && AppView.appData.slug) || '';

    container.innerHTML = sorted.map((s) => {
      const title = escapeHtml(s.session_title || s.pr_title || s.branch_name || 'Session');
      const appName = escapeHtml(s.app_name || s.app_slug || '');
      const isOtherApp = s.app_slug && s.app_slug !== currentSlug;
      // Dot color tracks lifecycle:
      //   active   → emerald
      //   promoted → violet
      //   paused   → zinc/gray (no warm container)
      // Busy modifier adds a pulse ring on top, only meaningful
      // for active/promoted (paused sessions can't be busy).
      let statusClass;
      let dotTitle;
      if (s.status === 'paused') { statusClass = 'dc-active-dot-paused'; dotTitle = 'Paused'; }
      else if (s.status === 'promoted') {
        statusClass = 'dc-active-dot-promoted';
        // #405: "Promoted (merged)" was ambiguous (a promoted PR is in a
        // vote, NOT merged). Use the canonical lifecycle label instead.
        const pLife = (window.MergeStatus && MergeStatus.lifecycle) ? MergeStatus.lifecycle(s) : null;
        const pLabel = (pLife && pLife.label) || 'Proposed';
        dotTitle = s.busy ? `Claude is running · ${pLabel}` : pLabel;
      }
      else { statusClass = 'dc-active-dot-active'; dotTitle = s.busy ? 'Claude is running' : 'Active'; }
      const busyClass = s.busy ? ' dc-active-dot-busy' : '';
      const isPaused = s.status === 'paused';
      // Primary action toggles between Pause and Resume. Archive is
      // a secondary, quieter affordance for the "really delete this"
      // case. data-action lets the click handler dispatch.
      const primaryAction = isPaused ? 'resume' : 'pause';
      const primaryLabel = isPaused ? 'Resume' : 'Pause';
      return `
        <div class="dc-active-item" data-id="${s.id}" data-slug="${escapeHtml(s.app_slug || '')}">
          <span class="dc-active-dot ${statusClass}${busyClass}" title="${dotTitle}"></span>
          <span class="dc-active-title" title="${title}">${title}</span>
          ${isOtherApp ? `<span class="dc-active-app" title="${appName}">${appName}</span>` : ''}
          <button class="dc-active-action ${isPaused ? 'dc-active-action-resume' : 'dc-active-action-pause'}" data-id="${s.id}" data-action="${primaryAction}">${primaryLabel}</button>
          <button class="dc-active-archive" data-id="${s.id}" data-name="${title}" title="Archive (frees the slot; restorable for a while)">Archive</button>
          <svg class="dc-active-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
        </div>`;
    }).join('');

    container.querySelectorAll('.dc-active-item').forEach((el) => {
      el.addEventListener('click', () => {
        const id = parseInt(el.dataset.id, 10);
        const slug = el.dataset.slug;
        if (!Number.isFinite(id) || !slug) return;
        // Same-app click: keep the in-memory state warm by routing
        // through openSession + renderChatView, then sync the URL.
        // Cross-app click: just set the hash and let restoreFromHash
        // handle the full app+tab+session restore — that path also
        // closes the previous app cleanly via App.openApp.
        if (typeof AppView !== 'undefined' && AppView.appData && AppView.appData.slug === slug) {
          DevChat.openSession(id).then(() => {
            DevChat.renderChatView();
            if (typeof App !== 'undefined' && App.updateHash) App.updateHash();
          });
        } else {
          location.hash = `#app/${slug}/dev/sessions/${id}`;
        }
      });
    });

    // Pause / Resume primary action. Stop propagation so the row's
    // navigate-to-session click doesn't fire alongside the toggle.
    container.querySelectorAll('.dc-active-action').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        const action = btn.dataset.action;
        const original = btn.textContent;
        btn.textContent = action === 'pause' ? 'Pausing…' : 'Resuming…';
        btn.disabled = true;
        let body = {};
        try {
          const resp = await fetch(`/api/sessions/${id}/${action}`, { method: 'POST' });
          body = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            alert(body.error || `Failed to ${action} session`);
            btn.textContent = original;
            btn.disabled = false;
            return;
          }
        } catch {
          btn.textContent = original;
          btn.disabled = false;
          return;
        }
        // Deliberate pause of the session that's open in the chat view:
        // sync the local copy so the heartbeat's refocus auto-resume
        // (which only heals *sweeper* pauses the client doesn't know
        // about) doesn't silently undo it (#193). keptPromoted means the
        // server left the status 'promoted', so don't mislabel it.
        if (action === 'pause' && !body.keptPromoted
            && DevChat.currentSession && Number(DevChat.currentSession.id) === id) {
          DevChat.currentSession.status = 'paused';
        }
        await DevChat._refreshSessionListsAfterMutation();
      });
    });

    // Archive (destructive, irreversible — drops Claude's memory,
    // destroys the warm worker + CC volume, and closes the PR). Gate
    // behind ConfirmModal (a webview-safe replacement for native
    // window.confirm, which is no-op'd in several mobile/in-app
    // browsers the platform runs in). data-name carries the PR/branch
    // title (escapeHtml'd at render time) so the prompt can name the
    // thing being archived.
    container.querySelectorAll('.dc-active-archive').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const name = btn.dataset.name || 'this session';
        const ok = await ConfirmModal.show({
          title: `Archive "${name}"?`,
          message: "This closes the PR and frees the slot. You can Unarchive it later from the app's session list (chat memory is kept for 30 days).",
          confirmLabel: 'Archive',
          danger: true,
        });
        if (!ok) return;
        btn.textContent = '...';
        btn.disabled = true;
        const id = parseInt(btn.dataset.id, 10);
        try {
          await fetch(`/api/sessions/${id}/archive`, { method: 'POST' });
        } catch {}
        await DevChat._refreshSessionListsAfterMutation();
      });
    });
  },

  // Shared post-mutation refresh for pause/resume/archive: pull the
  // cross-app panel data, and if we're currently viewing the same
  // app the session belongs to, refresh the per-app list too so
  // both surfaces stay in sync in a single tick.
  async _refreshSessionListsAfterMutation() {
    await DevChat.loadActiveSessions();
    if (
      typeof AppView !== 'undefined' &&
      AppView.appData &&
      AppView.appData.slug
    ) {
      await DevChat.loadSessions(AppView.appData.slug);
      DevChat.renderSessionList();
    }
  },

  // #287: an optional issueNumber links the new session back to the issue
  // row's start-work button (created_from_issue_number) so the row can
  // swap "Create proposal" → "Create new proposal". Omitted on the generic
  // "+ New chat" path, which sends no body and stores NULL.
  async createSession(appSlug, issueNumber) {
    try {
      const hasIssue = Number.isInteger(issueNumber) && issueNumber > 0;
      const res = await fetch(`/api/apps/${appSlug}/sessions`, {
        method: 'POST',
        ...(hasIssue
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ issueNumber }),
            }
          : {}),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to create session');
        return null;
      }
      DevChat.sessions.unshift(data.session);
      return data.session;
    } catch {
      alert('Network error');
      return null;
    }
  },

  // Re-sync the open session's server-side status and, if it was auto-
  // paused while we held it open, resume it. This closes the stale-client
  // gap behind "Active session not found": the sweeper flips an idle
  // 'active' session to 'paused' after ~5 min, and a backgrounded tab
  // stops heartbeating — but /activity can't revive a 'paused' row, and
  // the local currentSession.status is still 'active', so the next chat
  // send 404s. Calling this on refocus (and as a chat-send retry) heals
  // it the same way openSession's auto-resume does.
  //
  // Returns true when the session is now active/promoted (resumable),
  // false otherwise. `silent` suppresses the user-facing alert so a
  // transient failure on every refocus doesn't nag.
  async _resumeCurrentSessionIfPaused({ silent = false } = {}) {
    const s = DevChat.currentSession;
    if (!s || !s.id) return false;
    const sessionId = s.id;
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) return false;
      const { session } = await res.json();
      if (!session) return false;

      // Already active/promoted — just keep the local copy in sync.
      if (session.status !== 'paused') {
        if (DevChat.currentSession && DevChat.currentSession.id === sessionId) {
          DevChat.currentSession.status = session.status;
        }
        return ['active', 'promoted'].includes(session.status);
      }

      const rr = await fetch(`/api/sessions/${sessionId}/resume`, { method: 'POST' });
      if (rr.ok) {
        if (DevChat.currentSession && DevChat.currentSession.id === sessionId) {
          DevChat.currentSession.status = 'active';
        }
        DevChat._refreshSessionListsAfterMutation().catch(() => {});
        return true;
      }
      if (!silent) {
        const data = await rr.json().catch(() => ({}));
        alert(data.error || 'Could not resume this session right now. Try again in a moment.');
      }
      return false;
    } catch {
      // Network blip — leave local state as-is; the caller decides what to
      // surface (the chat-send path still shows its own error on retry).
      return false;
    }
  },

  // Activity heartbeat. While a session is open and the browser tab is
  // visible, ping the server (~every 60s) so last_activity_at stays
  // fresh. That's what lets the server's auto-pause timer run on a short
  // (~5 min) window aligned with worker eviction without pausing a
  // session the user is actively reading. A single persistent interval
  // is created once and no-ops whenever no session is open or the tab is
  // hidden/backgrounded — so a session pauses ~5 min after the user
  // actually leaves (closes/backgrounds the tab, or navigates out of the
  // app, which clears currentSession via reset()).
  _startHeartbeat() {
    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      const s = DevChat.currentSession;
      if (!s || !s.id) return;
      fetch(`/api/sessions/${s.id}/activity`, { method: 'POST' }).catch(() => {});
    };
    if (!DevChat._heartbeatVisHandler) {
      // Bump immediately on regaining visibility so a just-refocused
      // session isn't caught by the next sweep tick. If the session was
      // already auto-paused while the tab was hidden (>5 min), the bump
      // alone can't revive it — /activity only touches active/promoted
      // rows — so also re-sync and resume so the next send doesn't 404.
      //
      // Skip the resume when the LOCAL status already says 'paused':
      // that means the user deliberately paused this session (the pause
      // click-handlers sync the local copy), and silently re-activating
      // it would re-occupy the slot they just freed (#193). The heal is
      // only for the stale-client case where local status still says
      // 'active'. Sending a chat message or reopening the session still
      // resumes explicitly via their own paths.
      DevChat._heartbeatVisHandler = () => {
        if (document.visibilityState !== 'visible') return;
        beat();
        if (DevChat.currentSession && DevChat.currentSession.status === 'paused') return;
        DevChat._resumeCurrentSessionIfPaused({ silent: true });
      };
      document.addEventListener('visibilitychange', DevChat._heartbeatVisHandler);
    }
    if (DevChat._heartbeatTimer) return;
    DevChat._heartbeatTimer = setInterval(beat, 60000);
  },

  async openSession(sessionId) {
    // #161: opening a DIFFERENT session while the current one is
    // mid-turn counts as leaving it — arm its completion notification.
    // (Returning to the SAME session needs no client call: the server's
    // GET /api/sessions/:id below disarms it.)
    if (DevChat.isStreaming && DevChat.currentSession
        && Number(DevChat.currentSession.id) !== Number(sessionId)) {
      DevChat._setNotifyOnDone(DevChat.currentSession.id, true);
    }

    // Session-open is authoritative for the streaming UI. When opening a
    // DIFFERENT session than the one currently tracked, tear down the
    // per-turn client streaming state to idle FIRST, so a
    // previously-streaming session can't leak its red Stop button or
    // "⏳ Thinking…" title into a freshly-opened idle session (e.g. a
    // proposal clone, which is always idle on open). The `if (busy)`
    // block further down is then the SOLE place that re-arms streaming,
    // so a session that is genuinely mid-turn still re-enters the live
    // UI. We only tear down THIS tab's UI + subscriptions here — the
    // previous session's server-side turn keeps running untouched (its
    // completion notification was just armed above). Gated on a
    // session-id change so reopening a genuinely busy session doesn't
    // flicker the Stop button off and immediately back on (or needlessly
    // drop and reopen its resumable stream). _setStreamingUI(false)
    // clears the live 'thinking' marker but leaves the sticky #161
    // completion marker (_titleCompletion) alone.
    const switchingSession = !DevChat.currentSession
      || Number(DevChat.currentSession.id) !== Number(sessionId);
    if (switchingSession) {
      DevChat.isStreaming = false;
      DevChat._streamingPhase = null;
      DevChat._stopProgressPolling();
      DevChat._closeResumableStream();
      // Abort the previous session's in-flight POST SSE the same way
      // reset() does. Without this, the old session's chat reader loop
      // keeps running after the switch and leaks its tokens / cc_progress
      // lines into the freshly-opened session's view (#329). isStreaming
      // was just set false, so the post-loop recovery branch won't reopen
      // a resumable stream for the abandoned turn.
      if (DevChat._abortController) {
        try { DevChat._abortController.abort(); } catch {}
        DevChat._abortController = null;
      }
      DevChat._setStreamingUI(false);
    }
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) return;
      const { session, messages } = await res.json();

      // Auto-resume on open: opening a paused session transparently
      // resumes it (the backend applies the per-user LRU + global cap
      // logic, auto-pausing the user's least-recently-active session if
      // needed). We flip the local status optimistically so the rest of
      // renderChatView treats it as active; other tabs sync via the
      // server's 'resumed' WS event. If resume is refused (e.g. the
      // global cap is hit), leave it paused and tell the user.
      if (session.status === 'paused') {
        try {
          const rr = await fetch(`/api/sessions/${sessionId}/resume`, { method: 'POST' });
          if (rr.ok) {
            session.status = 'active';
          } else {
            const data = await rr.json().catch(() => ({}));
            alert(data.error || 'Could not resume this session right now. Try again in a moment.');
          }
        } catch { /* network blip — fall through; session stays paused */ }
      }

      DevChat.currentSession = session;
      DevChat._startHeartbeat();
      // Drop any streaming title marker carried over from the previous
      // session. If THIS session is mid-run, the busy check below
      // re-applies "thinking" via _setStreamingUI. The #161 completion
      // marker lives in its own slot (_titleCompletion) and is
      // deliberately untouched here — it stays sticky while the user is
      // away and clears on return / notification read.
      DevChat.setTitleStatus(null);
      // #233: the spec viewer is a single global state slot, not keyed
      // per session — switching sessions must drop the previous
      // session's content (and open flag) or it leaks into the new
      // session's panel. Number-compare because openSession receives
      // the id from DOM datasets (string) while openSpecViewer stores
      // currentSession.id (number). Re-opening the SAME session keeps
      // the cached content so returning repaints instantly.
      if (DevChat.specViewer.sessionId != null
          && Number(DevChat.specViewer.sessionId) !== Number(sessionId)) {
        DevChat._resetSpecViewer();
      }
      // Restore the spec viewer's open/closed state from localStorage
      // before the caller's renderChatView fires, so a refresh on a
      // session that had the viewer open paints with the panel
      // already mounted. The data fetch is kicked off in the
      // background by _loadSpecViewer; the empty side-panel renders
      // immediately and fills in once the spec_md round-trip lands.
      if (DevChat._readSpecViewerOpen(sessionId)) {
        DevChat.specViewer.open = true;
        DevChat.specViewer.sessionId = sessionId;
        DevChat.specViewer.viewVersion = 'latest';
        DevChat.specViewer.viewVersionContent = null;
        DevChat.specViewer.activeTab = 'user';
        // Don't await — caller's renderChatView shouldn't block on
        // the fetch. _loadSpecViewer calls _renderSpecViewer when it
        // resolves, which patches the body in place.
        DevChat._loadSpecViewer({ force: true });
      }
      // Q/A chip selection is per-question-turn — never carry one across
      // a session switch / reload.
      DevChat._qaSelection = {};
      DevChat.messages = messages.map((m) => {
        if (m.metadata) {
          if (m.metadata.stagingUrl) m.stagingUrl = m.metadata.stagingUrl;
          // #361: the "Changes ready" card is driven by an explicit marker
          // (set on both the staging-success and staging-failed branches of
          // runClaudeCodeTool) rather than incidentally by stagingUrl, so it
          // rehydrates the same whether or not a preview built. When staging
          // failed the disabled-Preview note reads stagingErrorName /
          // stagingMissingKeys; prNumber/prUrl back the header + GitHub link.
          if (m.metadata.changesReady) m.changesReady = true;
          if (m.metadata.stagingFailed) m.stagingFailed = true;
          if (m.metadata.stagingErrorName) m.stagingErrorName = m.metadata.stagingErrorName;
          if (m.metadata.stagingMissingKeys) m.stagingMissingKeys = m.metadata.stagingMissingKeys;
          if (m.metadata.prNumber != null) m.prNumber = m.metadata.prNumber;
          if (m.metadata.prUrl) m.prUrl = m.metadata.prUrl;
          if (m.metadata.ccLog) m.ccLog = m.metadata.ccLog;
          if (m.metadata.ccOutput) m.ccOutput = m.metadata.ccOutput;
          if (m.metadata.ccSummary) m.ccSummary = m.metadata.ccSummary;
          if (m.metadata.progressLog) m.progressLog = m.metadata.progressLog;
          // #50: terminal statuses persist how long the run took so the
          // "(took 4m 12s)" suffix survives a reload.
          if (m.metadata.durationMs != null) m.durationMs = m.metadata.durationMs;
          // #286: a persisted AI progress estimate ({ text, remainingSeconds })
          // hydrates the running line's guess on load — mirrors the live
          // cc_estimate path (_applyEstimate) so a seeded/recovered active
          // run shows the same '✦ AI guess' span. Absent on real runs that
          // never persist it, so this is a no-op there.
          if (m.metadata.estimate && m.metadata.estimate.text) {
            m._estimate = String(m.metadata.estimate.text).trim();
            m._estimateRemaining = m.metadata.estimate.remainingSeconds == null
              ? null
              : m.metadata.estimate.remainingSeconds;
            // #359: re-anchor the count-down from load time. metadata.estimate
            // carries no "estimated-at" stamp, so this reads slightly high; the
            // next live cc_estimate corrects it within ~a minute.
            m._countdownTo = DevChat._countdownTarget(m._estimateRemaining);
          }
          // Spec preview cards: scout dispatches persist these on the
          // status row so a refresh re-renders the same inline card the
          // user saw mid-stream. See runScoutTool. Older recovered scout
          // turns persisted scoutOutput without specPreview — derive the
          // preview so their cards still render.
          if (m.metadata.specPreview) m.specPreview = m.metadata.specPreview;
          else if (m.metadata.scoutOutput && m.metadata.specVersion != null) {
            const t = String(m.metadata.scoutOutput);
            m.specPreview = t.length <= 400 ? t : `${t.slice(0, 400)}…`;
          }
          if (m.metadata.specLines) m.specLines = m.metadata.specLines;
          if (m.metadata.specVersion != null) m.specVersion = m.metadata.specVersion;
          // Q/A mode (#32): suggested-answer chips for the Mayor's
          // clarifying questions survive refresh via metadata.
          if (m.metadata.suggestions) m.suggestions = m.metadata.suggestions;
          // Quick-reply pills (#285): next-step suggestions survive refresh
          // via metadata.quickReplies on the assistant row.
          if (m.metadata.quickReplies) m.quickReplies = m.metadata.quickReplies;
          // File attachments (#450): user rows carry a metadata summary
          // [{ id, kind, filename, contentType, sizeBytes }]; bytes are
          // served by GET /api/sessions/:id/attachments/:attId.
          if (Array.isArray(m.metadata.attachments) && m.metadata.attachments.length) {
            m.attachments = m.metadata.attachments;
          }
          // Platform-issue drafts: the agent suggested escalating a
          // platform-level blocker; the card's confirm/dismiss buttons
          // post to /api/sessions/:id/platform-issue/:msgId/*. The DB row
          // id doubles as the draft's msgId on rehydrate.
          if (m.metadata.platformIssueDraft) {
            m.platformIssueDraft = { ...m.metadata.platformIssueDraft, msgId: m.id };
          }
        }
        return m;
      });

      // #252: sync state is keyed per session — drop a stale indicator
      // (in-flight or terminal feedback) when switching to a different
      // session. Re-opening the SAME session keeps it; the status
      // check below refreshes the in-flight phase from the server.
      if (DevChat._syncState
          && Number(DevChat._syncState.sessionId) !== Number(sessionId)) {
        DevChat._syncState = null;
        DevChat._stopSyncPolling();
      }

      // Check if Claude Code is running for this session
      try {
        const statusRes = await fetch(`/api/sessions/${sessionId}/status`);
        if (statusRes.ok) {
          const { busy, progress, phase, sync } = await statusRes.json();
          // #252: reload recovery for the sync banner. A MODE=sync turn
          // also flips `busy` (it holds the worker), so check it first
          // and don't arm the chat-turn streaming UI for a sync.
          if (sync && sync.phase) {
            DevChat._syncState = {
              sessionId: Number(sessionId), phase: sync.phase, since: Date.now(),
            };
            DevChat._startSyncPolling(Number(sessionId));
          } else if (DevChat._syncState && !DevChat._syncState.terminal) {
            // Stale in-flight state with nothing running server-side
            // (e.g. the platform restarted mid-sync) — clear it.
            // Terminal feedback is left alone so refresh-triggered
            // openSession calls don't wipe the success/failure notice.
            DevChat._syncState = null;
            DevChat._stopSyncPolling();
          }
          if (busy && !(sync && sync.phase)) {
            DevChat.isStreaming = true;
            DevChat._setStreamingUI(true, phase || null);
            // Reuse the most recent persisted progress message as the live
            // append target so the polling fallback updates IT instead of
            // creating a second "Claude Code output (N lines)" collapsible.
            for (let i = DevChat.messages.length - 1; i >= 0; i--) {
              const m = DevChat.messages[i];
              if (m.role === 'system' && m.progressLog) { m._progress = true; break; }
            }
            // `_active` is a client-only flag that swaps the static gear
            // glyph for the arc spinner, so on refresh mid-run the latest
            // status line ("Claude Code is running…") needs it
            // re-applied. Pick the newest system message that isn't a
            // finalized artefact (ccOutput / progressLog / stagingUrl /
            // ccLog) — those are terminal, not in-flight.
            //
            // Note: progressLog is technically not "terminal" — it grows
            // as live output streams in. But we treat it as terminal here
            // so `_active` lands on the *parent* "Claude Code is running"
            // status line instead, which then renders as the disclosure
            // summary above the inline log (see renderMessages).
            for (let i = DevChat.messages.length - 1; i >= 0; i--) {
              const m = DevChat.messages[i];
              if (m.role !== 'system') continue;
              if (m.ccOutput || m.progressLog || m.stagingUrl || m.ccLog) continue;
              m._active = true;
              break;
            }
            // Hook into the resumable event stream so we get *live*
            // updates from this tab (tokens, status transitions, PR
            // created, etc.) instead of only what the 3s polling can
            // reconstruct from the DB. Polling stays on as a safety net.
            DevChat._openResumableStream(sessionId);
            DevChat._startProgressPolling(sessionId, progress);
          }
        }
      } catch {}
    } catch {}
  },

  // ── Streaming + send ─────────────────────────────────────

  async sendMessage(message, attachments = []) {
    if (!DevChat.currentSession || DevChat.isStreaming) return;
    // #450: attachments-only sends are allowed; the server stores a
    // "(attached files)" stub caption, mirrored here for the optimistic
    // bubble. `attachments` entries come from pendingAttachments (already
    // uploaded — each carries a server id + objectUrl for image thumbs).
    const sentAttachments = (attachments || []).filter((a) => a && a.id);
    if (!message && !sentAttachments.length) return;
    // #138: a send is a user gesture — unlock the AudioContext and lazily
    // request OS-notification permission now, so the completion chime /
    // notification can fire when this turn finishes (browsers only allow
    // audio + permission prompts from inside a gesture).
    if (window.DevAlerts) {
      DevAlerts._unlockAudio();
      DevAlerts.requestNotifyPermission();
    }
    const model = DevChat.selectedModel;
    DevChat.isStreaming = true;
    DevChat._setStreamingUI(true);
    DevChat._seenSeqs = new Set();
    // Any Q/A chip selection belonged to the question turn we're now
    // answering — the chips vanish on re-render (the question row is no
    // longer last), so the selection must not leak into a later turn.
    DevChat._qaSelection = {};

    // A previous turn's progress message may still be flagged as the live
    // append target. Clear it so this turn's cc_progress events create a
    // fresh collapsible instead of appending to the prior turn's log.
    for (const m of DevChat.messages) {
      if (m._progress) m._progress = false;
    }

    DevChat.messages.push({
      role: 'user',
      content: message || '(attached files)',
      created_at: new Date().toISOString(),
      ...(sentAttachments.length ? { attachments: sentAttachments } : {}),
    });
    // Clear the composer strip — restored on the failure paths below.
    if (sentAttachments.length) {
      DevChat.pendingAttachments = [];
      DevChat._renderAttachStrip();
    }
    // `let`, not `const`: the `assistant_message_end` handler reassigns this
    // to a fresh object when the Mayor seals phase-1 so the phase-2 wrap-up
    // lands in its own bubble. A `const` here used to throw silently inside
    // the per-event try/catch, leaving the phase-2 tokens appended onto the
    // phase-1 object and causing the second bubble to show phase-1 text.
    let assistantMsg = { role: 'assistant', content: '', created_at: null };
    let assistantPushed = false;
    DevChat.renderMessages();
    DevChat._showSpinner();
    DevChat.scrollToBottom();

    DevChat._abortController = new AbortController();

    try {
      const sessionId = DevChat.currentSession.id;
      const postChat = () => fetch(`/api/sessions/${sessionId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message, model,
          ...(sentAttachments.length ? { attachmentIds: sentAttachments.map((a) => a.id) } : {}),
        }),
        signal: DevChat._abortController.signal,
      });

      let res = await postChat();

      // The session may have been auto-paused while we held it open (the
      // sweeper flips idle 'active' → 'paused' after ~5 min; a backgrounded
      // tab stops heartbeating). The chat route 404s with "Active session
      // not found" in that case. Transparently resume and retry once so the
      // user never sees it — same heal as the refocus path above.
      if (res.status === 404) {
        const peek = await res.clone().json().catch(() => ({}));
        if (/active session not found/i.test(peek?.error || '')) {
          const resumed = await DevChat._resumeCurrentSessionIfPaused({ silent: true });
          if (resumed && DevChat.currentSession && DevChat.currentSession.id === sessionId) {
            res = await postChat();
          }
        }
      }

      if (res.status === 429) {
        const data = await res.json();
        DevChat._removeSpinner();
        // #463: budget exhaustion is not rate limiting — tell the user
        // what actually happened and point at the BYOK escape hatch.
        // Only the server's billing path sets code: 'budget_exceeded';
        // chatLimiter throttles keep the old wording.
        if (data.code === 'budget_exceeded') {
          DevChat.messages.push({
            role: 'assistant',
            content: `**You've used up today's free AI credits.** ${data.error || 'They reset at midnight UTC.'}\n\nOpen Settings from the menu (or use the banner above) to add your key — your work then bills to your own Anthropic account.`,
            created_at: new Date().toISOString(),
          });
          // Refresh the meter + banner right away so the "out of
          // credits" state is visible without waiting for a usage event.
          DevChat.refreshBudget();
        } else {
          DevChat.messages.push({ role: 'assistant', content: `**Rate limit reached.** ${data.error || 'Try again later.'}`, created_at: new Date().toISOString() });
        }
        DevChat._finishStreaming();
        // #370: the cap rejected the send before any turn ran. Put the
        // text back in the composer (editable, draft re-saved) and drop
        // the optimistic user bubble so the message lives only in the
        // editor — the user never has to retype it. Restore AFTER
        // _finishStreaming so the input is re-enabled before we focus it.
        DevChat._restoreComposer(message, { dropOptimisticUser: true });
        if (sentAttachments.length) {
          DevChat.pendingAttachments = sentAttachments;
          DevChat._renderAttachStrip();
        }
        DevChat.renderMessages();
        return;
      }

      // Any other non-2xx response (404 missing/archived session, 400 bad
      // input, 500 server error, …) returns JSON, not SSE. Surface it as
      // an assistant error message and tear down the streaming UI so we
      // don't sit on the spinner forever or kick off resumable-SSE +
      // status polling against a session that was never going to stream.
      if (!res.ok) {
        let errText = `HTTP ${res.status}`;
        try {
          const data = await res.json();
          if (data?.error) errText = data.error;
        } catch {}
        DevChat._removeSpinner();
        DevChat.messages.push({
          role: 'assistant',
          content: `**Couldn't send message:** ${errText}`,
          created_at: new Date().toISOString(),
        });
        DevChat._finishStreaming();
        // #370: restore the typed text into the composer and drop the
        // optimistic (never-persisted) user bubble so the message isn't
        // lost — same recovery as the 429 cap path above. Leaving the
        // bubble in the list while the spinner disappears is what the
        // user perceived as "my message disappears".
        DevChat._restoreComposer(message, { dropOptimisticUser: true });
        if (sentAttachments.length) {
          DevChat.pendingAttachments = sentAttachments;
          DevChat._renderAttachStrip();
        }
        DevChat.renderMessages();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let gotFirstToken = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          // Defensive scope guard (#329): if the user has since switched to
          // a different session, this POST SSE belongs to the one we left.
          // The abort in openSession's teardown normally stops us, but it's
          // async relative to already-buffered events — drop the rest of
          // this batch rather than apply it to the now-current session.
          if (Number(sessionId) !== Number(DevChat.currentSession?.id)) break;
          try {
            const data = JSON.parse(line.slice(6));
            if (data._seq && DevChat._seenSeqs?.has(data._seq)) continue;
            if (data._seq) { DevChat._seenSeqs?.add(data._seq); DevChat._lastSeenSeq = data._seq; }
            switch (data.type) {
              case 'token':
                if (!gotFirstToken) { DevChat._removeSpinner(); gotFirstToken = true; }
                assistantMsg.content += data.text;
                if (!assistantPushed) {
                  assistantMsg.created_at = new Date().toISOString();
                  DevChat.messages.push(assistantMsg);
                  assistantPushed = true;
                  DevChat.renderMessages();
                } else {
                  // Update in place — don't re-render entire list on each token.
                  // The stabilized updater holds back the trailing incomplete
                  // line and throttles to one paint/frame so checkbox rows
                  // don't blink as partial markdown re-parses.
                  const displayContent = assistantMsg.content.replace(/^\[CHAT_ONLY\]\s*/i, '');
                  const msgEls = document.querySelectorAll('#dc-messages .dc-msg-assistant .dc-msg-content');
                  const lastEl = msgEls[msgEls.length - 1];
                  if (lastEl) DevChat._renderStreamingMarkdown(lastEl, displayContent);
                }
                DevChat.scrollToBottom();
                break;
              case 'done':
                DevChat._flushStreamingFinal();
                DevChat._deactivateLastStatus();
                DevChat.renderMessages();
                DevChat._finishStreaming();
                reader.cancel();
                break;
              case 'phase':
                DevChat._setStreamingUI(true, data.phase);
                break;
              case 'stopped':
                DevChat._flushStreamingFinal();
                DevChat._removeSpinner();
                DevChat._deactivateLastStatus();
                DevChat.renderMessages();
                DevChat._finishStreaming();
                reader.cancel();
                break;
              case 'assistant_message_end':
                // Mayor's first turn just finished (typically followed by
                // a tool dispatch → CC progress → Mayor wrap-up). Seal
                // the current bubble so the wrap-up tokens land in a
                // fresh one below the status/progress system messages.
                // Flush the held-back trailing line first so the sealed
                // bubble shows its complete final content.
                DevChat._flushStreamingFinal();
                if (assistantMsg) assistantMsg._finalized = true;
                assistantPushed = false;
                assistantMsg = { role: 'assistant', content: '', created_at: new Date().toISOString() };
                break;
              case 'status':
                DevChat._flushStreamingFinal();
                DevChat._removeSpinner();
                DevChat._deactivateLastStatus();
                // A status line always closes the current streaming bubble
                // (#99): tokens that arrive after it must render BELOW it,
                // never append to the bubble above. Same sealing as
                // assistant_message_end; a no-op when nothing is streaming.
                if (assistantMsg) assistantMsg._finalized = true;
                assistantPushed = false;
                assistantMsg = { role: 'assistant', content: '', created_at: new Date().toISOString() };
                DevChat.messages.push({ role: 'system', content: data.text, ccOutput: data.ccOutput, ccSummary: data.ccSummary, specPreview: data.specPreview, specLines: data.specLines, specVersion: data.specVersion, durationMs: data.durationMs, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2,8), _active: true });
                DevChat.renderMessages();
                DevChat.scrollToBottom();
                break;
              case 'platform_issue_draft':
                // Agent-suggested platform report (human gate). Deliberately
                // NOT a status event: it lands mid-turn and must not seal
                // bubbles or deactivate the running spinner line.
                DevChat._pushPlatformIssueDraft(data);
                break;
              case 'staging_ready':
                DevChat._removeSpinner();
                DevChat._deactivateLastStatus();
                DevChat.messages.push({ role: 'system', content: 'Staging deployed!', stagingUrl: data.url, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2,8) });
                DevChat.renderMessages();
                DevChat.scrollToBottom();
                if (data.url) {
                  DevChat.currentSession.staging_url = data.url;
                  // #127: testing guidance rides along so the PR card's
                  // "Test this change" button works without a refetch.
                  if ('testingMd' in data) DevChat.currentSession.testing_md = data.testingMd;
                  if ('testingPath' in data) DevChat.currentSession.testing_path = data.testingPath;
                }
                break;
              case 'staging_failed':
                // Staging build failed in a recoverable way (most often a
                // dapp.json staging_default missing, or a required secret
                // unset). The server has already pushed a remediation-rich
                // tool_result back to the Mayor — this UI message is the
                // user-facing companion. Phase-2 wrap-up will follow up
                // with the Mayor's natural-language explanation.
                DevChat._removeSpinner();
                DevChat._deactivateLastStatus();
                DevChat.messages.push({
                  role: 'system',
                  content: `Staging build failed: ${data.error || 'unknown error'}`,
                  // #361: a staging_failed event always implies a pushed,
                  // proposable commit, so render the "Changes ready" card
                  // (disabled Preview + working Propose) — not a card-less line.
                  changesReady: true,
                  stagingFailed: true,
                  stagingErrorName: data.errorName || 'Error',
                  stagingMissingKeys: data.missingKeys || [],
                  prNumber: data.prNumber != null ? data.prNumber : (DevChat.currentSession?.pr_number ?? null),
                  prUrl: data.prUrl || DevChat.currentSession?.pr_url || null,
                  created_at: new Date().toISOString(),
                  _slug: Math.random().toString(36).slice(2, 8),
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
                    // #249: the server mirrors pr_title into
                    // session_title; mirror client-side too so the
                    // display name flips without a refetch.
                    DevChat.currentSession.session_title = data.prTitle;
                  }
                  // Re-render so the new title shows up in the PR card / header
                  // immediately (these only re-render on renderChatView / message
                  // pushes, not on raw event arrival).
                  DevChat.renderChatView();
                }
                break;
              case 'session_titled':
                // #249: a pre-PR display name landed (first message or
                // turn-end refresh) — update the header + session lists.
                if (DevChat.currentSession && data.sessionTitle) {
                  DevChat.currentSession.session_title = data.sessionTitle;
                  DevChat.renderChatView();
                }
                break;
              case 'visuals_ready':
                // #195: the capture finished after staging_ready — stash
                // the artifact ids on the session and re-render so the
                // staging card upgrades in place with the media tiles.
                if (DevChat.currentSession && data.visuals) {
                  DevChat.currentSession.visuals = data.visuals;
                  DevChat.renderMessages();
                }
                break;

              case 'mayor_reasoning': {
                // Server sends the full raw Mayor output after the token
                // stream completes. This is authoritative: even if individual
                // token events were lost in transit (e.g. an older WS-dedup
                // race), we recover the full text here. The raw content —
                // including any [CHAT_ONLY] prefix — is stored on the live
                // assistant message so renderMessages() can show a "Mayor
                // reasoning" collapsible both during streaming and after
                // refresh.
                if (!data.text) break;
                if (!assistantPushed) {
                  assistantMsg.content = data.text;
                  assistantMsg.created_at = new Date().toISOString();
                  DevChat.messages.push(assistantMsg);
                  assistantPushed = true;
                } else if (assistantMsg.content.length < data.text.length) {
                  assistantMsg.content = data.text;
                }
                DevChat.renderMessages();
                DevChat.scrollToBottom();
                break;
              }
              case 'suggestions': {
                // Q/A mode (#32): structured suggested answers for the
                // clarifying questions in the current bubble. Sent right
                // after mayor_reasoning, so the assistant message exists;
                // renderMessages draws the tappable chips under it.
                if (!Array.isArray(data.suggestions) || !data.suggestions.length) break;
                if (assistantPushed) {
                  assistantMsg.suggestions = data.suggestions;
                  DevChat.renderMessages();
                  DevChat.scrollToBottom();
                }
                break;
              }
              case 'quick_replies': {
                // Quick-reply pills (#285): flat next-step suggestions for
                // the current bubble, rendered as tappable pills ABOVE the
                // composer (prefill-on-tap, never auto-send). The pill bar
                // reads from the latest assistant message's quickReplies, so
                // attaching it here is enough — _renderQuickReplies redraws.
                if (!Array.isArray(data.replies) || !data.replies.length) break;
                if (assistantPushed) {
                  assistantMsg.quickReplies = data.replies;
                  DevChat._renderQuickReplies();
                }
                break;
              }
              case 'cc_progress': {
                DevChat._appendProgressLine(data.text);
                DevChat.scrollToBottom();
                // Start /status polling as a fallback in case the SSE stream
                // or the global WS drops before we receive the 'done' event.
                // The first cc_progress tells us a worker is actually running
                // (vs. a CHAT_ONLY reply that never dispatches one), so we
                // only arm the fallback here to avoid prematurely concluding
                // a chat-only turn is "finished".
                if (!DevChat._progressPollTimer && DevChat.currentSession) {
                  DevChat._startProgressPolling(DevChat.currentSession.id, []);
                }
                break;
              }
              case 'cc_estimate':
                // Experimental AI progress estimate (opt-in, server-gated).
                DevChat._applyEstimate(data.text, data.remainingSeconds);
                break;
              case 'cc_log':
                DevChat.messages.push({ role: 'system', ccLog: data.log, content: 'Claude Code log', created_at: new Date().toISOString() });
                DevChat.renderMessages();
                DevChat.scrollToBottom();
                break;
              case 'error':
                DevChat._removeSpinner();
                assistantMsg.content += `\n\n> **Error:** ${data.error}`;
                DevChat.renderMessages();
                break;
              case 'usage':
                assistantMsg.model = data.model;
                assistantMsg.costCents = data.costCents;
                DevChat.refreshBudget();
                break;
              case 'spec_updated':
                // A scout dispatch drafted (or revised) the live
                // spec_md. The accompanying status event already
                // pushed an inline preview card into the timeline — we
                // just keep the open viewer in sync if the user
                // happens to have it open on the live draft.
                DevChat._handleSpecUpdated(data);
                break;
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        DevChat._removeSpinner();
      }
    }

    // The primary POST SSE either drained to 'done' (which already called
    // _finishStreaming and set isStreaming = false) or it died early.
    // In the latter case, recover via two parallel fallbacks:
    //
    //   1. The resumable GET /events SSE — same server, replays from our
    //      last seen _seq via EventSource's built-in Last-Event-Id retry.
    //      This is the *live* recovery path; it keeps the UI feeling
    //      real-time across network blips, proxy idle-kills, and WS
    //      reconnect churn.
    //
    //   2. /status polling — covers the worst case where the Node
    //      process restarted and the in-memory ring buffer is gone. The
    //      on-disk progressLog is still authoritative, and the poll
    //      flips busy=false to finalize the UI when the run completes.
    if (DevChat.isStreaming && DevChat.currentSession) {
      DevChat._openResumableStream(DevChat.currentSession.id);
      // Single progress source while streaming: when the resumable SSE is
      // live it APPENDS progress lines (deduped by _seenSeqs, replayed from
      // our last seen _seq). Running the 3s /status poll too would REPLACE
      // the same log, and a lagging snapshot can momentarily shrink it then
      // regrow — the log visibly flickers. So only arm the poll when the
      // EventSource couldn't open; if the stream later dies for good, its
      // onerror brings the poll up as the Node-restart fallback.
      if (!DevChat._eventSource && !DevChat._progressPollTimer) {
        DevChat._startProgressPolling(DevChat.currentSession.id, []);
      }
    }
  },

  _finishStreaming() {
    // Flush any throttled streaming render to the bubble's exact final
    // content before the full renderMessages() below rebuilds the list.
    DevChat._flushStreamingFinal();
    DevChat.isStreaming = false;
    DevChat._abortController = null;
    DevChat._stopProgressPolling();
    DevChat._closeResumableStream();
    DevChat._lastSeenSeq = null;
    DevChat._setStreamingUI(false);
    DevChat.renderMessages();
    DevChat.refreshBudget();
    // #138: the chime/notification is no longer fired from here. Every
    // interactive turn completion now creates a session_done notification
    // server-side (see notifySessionDone), so the WS `notification_new`
    // arrival in Notifications.handleIncoming → DevAlerts.onCompletion is
    // the single source of the chime (foreground) / OS notification
    // (backgrounded), even when the user is watching this same dev chat.
  },

  // Self-healing sync for degraded turns (#446): called from the WS and
  // resumable 'done' handlers — the two paths that only run when the
  // primary POST SSE did NOT finish the turn (a healthy primary stream
  // delivers its own 'done' first and seq-dedup swallows the copies).
  // Anything that rode only the dead stream (suggestion chips, quick-reply
  // pills, a late mayor_reasoning) is persisted but missing from the
  // in-memory timeline, so reload the session — the automated equivalent
  // of the manual refresh users do today. Mirrors what the /status poll
  // fallback already does when it sees busy=false.
  async _reconcileAfterFallbackDone(sessionId) {
    const sid = sessionId != null ? sessionId : DevChat.currentSession?.id;
    if (sid == null) return;
    if (Number(sid) !== Number(DevChat.currentSession?.id)) return;
    // A newer turn already started — its own stream owns the timeline now.
    if (DevChat.isStreaming) return;
    try {
      await DevChat.openSession(sid);
      DevChat.renderMessages();
      DevChat.scrollToBottom();
    } catch { /* the next poll or manual refresh still recovers */ }
  },

  // Open (or reopen) the resumable GET /events SSE for the active session.
  // EventSource handles reconnect automatically and sends Last-Event-Id on
  // each retry, which the server uses to replay missed events from its
  // per-session ring buffer. On the first connect we also pass `?since=`
  // explicitly so we can replay events that were already delivered over
  // the primary POST SSE but lost mid-stream.
  _openResumableStream(sessionId) {
    if (typeof EventSource === 'undefined') return;
    if (DevChat._eventSource) return;
    const since = DevChat._lastSeenSeq;
    const url = since
      ? `/api/sessions/${sessionId}/events?since=${encodeURIComponent(since)}`
      : `/api/sessions/${sessionId}/events`;
    let es;
    try { es = new EventSource(url); } catch { return; }
    DevChat._eventSource = es;
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        DevChat._handleResumedEvent(data, sessionId);
      } catch {}
    };
    es.onerror = () => {
      // EventSource silently auto-retries. If the browser closes it for
      // good (readyState === CLOSED), drop our reference so a later
      // cc_progress or drop-detection can open a fresh one. Progress
      // polling is the last-resort fallback in that window.
      if (es.readyState === 2 /* CLOSED */ && DevChat._eventSource === es) {
        DevChat._eventSource = null;
        // The resumable SSE gave up for good. It was the single live
        // progress source (we suppress the poll while it's open), so now
        // bring the 3s /status poll up as the worst-case fallback — this
        // is what finalizes the UI if a Node restart lost the ring buffer.
        if (DevChat.isStreaming && DevChat.currentSession && !DevChat._progressPollTimer) {
          DevChat._startProgressPolling(DevChat.currentSession.id, []);
        }
      }
    };
  },

  _closeResumableStream() {
    if (DevChat._eventSource) {
      try { DevChat._eventSource.close(); } catch {}
      DevChat._eventSource = null;
    }
  },

  // Handle an event arriving on the *resumable* channel (either the
  // GET /events EventSource opened after a POST SSE drop, or a later
  // retry of same). The closure-local state from sendMessage's POST SSE
  // loop (assistantMsg / assistantPushed / gotFirstToken) is no longer
  // reachable here — instead we locate the live assistant message by
  // scanning DevChat.messages, and create one if the run ended up with
  // no tokens before the drop.
  _handleResumedEvent(data, sessionId) {
    // Defensive scope guard (#329): drop a late resumable-SSE event that
    // arrives for a session the user has already navigated away from, so
    // it can't paint into the now-current session. `sessionId` is the id
    // the EventSource was opened for; absent (legacy callers) skips the
    // check.
    if (sessionId != null && Number(sessionId) !== Number(DevChat.currentSession?.id)) return;
    if (data._seq) {
      if (DevChat._seenSeqs?.has(data._seq)) return;
      if (!DevChat._seenSeqs) DevChat._seenSeqs = new Set();
      DevChat._seenSeqs.add(data._seq);
      DevChat._lastSeenSeq = data._seq;
    }
    const lastAssistantMsg = () => {
      for (let i = DevChat.messages.length - 1; i >= 0; i--) {
        if (DevChat.messages[i].role === 'assistant') return DevChat.messages[i];
      }
      return null;
    };
    switch (data.type) {
      case 'token': {
        DevChat._removeSpinner();
        let am = lastAssistantMsg();
        // No assistant message yet for this turn → push a fresh one.
        // The user message is already in DevChat.messages so insertion
        // order is correct.
        if (!am || am._finalized) {
          am = { role: 'assistant', content: '', created_at: new Date().toISOString() };
          DevChat.messages.push(am);
          DevChat.renderMessages();
        }
        am.content += data.text;
        const displayContent = am.content.replace(/^\[CHAT_ONLY\]\s*/i, '');
        const els = document.querySelectorAll('#dc-messages .dc-msg-assistant .dc-msg-content');
        const el = els[els.length - 1];
        if (el) DevChat._renderStreamingMarkdown(el, displayContent);
        DevChat.scrollToBottom();
        break;
      }
      case 'mayor_reasoning': {
        if (!data.text) break;
        let am = lastAssistantMsg();
        // Once an assistant bubble is sealed (_finalized, via
        // assistant_message_end), a fresh mayor_reasoning belongs to
        // the *next* bubble — otherwise we'd overwrite phase-1's text
        // with phase-2's wrap-up when replaying on reconnect.
        if (!am || am._finalized) {
          DevChat.messages.push({ role: 'assistant', content: data.text, created_at: new Date().toISOString() });
          DevChat.renderMessages();
        } else if (am.content !== data.text) {
          // Reconcile an EXISTING live bubble to the server's authoritative
          // text whenever it DIFFERS — not only when it's longer (#358). The
          // server may have SHORTENED the text by scrubbing a hallucinated
          // "[CODING AGENT COMPLETED]" marker the user already saw stream in;
          // a grow-only patch would leave that fake marker on screen until
          // reload. Patch the content node in place via the stabilized
          // streaming updater rather than tearing down and rebuilding the
          // whole list (which would re-parse and re-mount every
          // checkbox-bearing message mid-stream). The full renderMessages()
          // still runs when a new bubble is pushed above.
          am.content = data.text;
          const displayContent = am.content.replace(/^\[CHAT_ONLY\]\s*/i, '');
          const els = document.querySelectorAll('#dc-messages .dc-msg-assistant .dc-msg-content');
          const el = els[els.length - 1];
          if (el) DevChat._renderStreamingMarkdown(el, displayContent);
          else DevChat.renderMessages();
        }
        DevChat.scrollToBottom();
        break;
      }
      case 'suggestions': {
        // Q/A mode (#32): attach the suggested answers to the live
        // assistant bubble (replayed right after mayor_reasoning). A
        // sealed bubble means a dispatch turn, where suggestions were
        // already dropped server-side — skip rather than mis-attach.
        if (!Array.isArray(data.suggestions) || !data.suggestions.length) break;
        const am = lastAssistantMsg();
        if (am && !am._finalized) {
          am.suggestions = data.suggestions;
          DevChat.renderMessages();
          DevChat.scrollToBottom();
        }
        break;
      }
      case 'quick_replies': {
        // Quick-reply pills (#285), replayed right after the wrap-up
        // mayor_reasoning. This case was missing, so a "Build it" pill
        // delivered over the resumable channel was silently dropped until
        // refresh. Mirrors the primary POST-SSE handler: attach to the
        // latest assistant bubble; the pill bar reads from it (hidden
        // while streaming, surfaces when _finishStreaming re-renders).
        if (!Array.isArray(data.replies) || !data.replies.length) break;
        const am = lastAssistantMsg();
        if (am) {
          am.quickReplies = data.replies;
          DevChat._renderQuickReplies();
        }
        break;
      }
      case 'done':
        DevChat._deactivateLastStatus();
        DevChat._finishStreaming();
        // A 'done' on the resumable channel means the primary POST SSE never
        // finished this turn — reconcile from the DB so anything that rode
        // only the dead stream shows without a manual refresh (#446).
        DevChat._reconcileAfterFallbackDone(sessionId);
        break;
      case 'phase':
        // Server announces which phase of the turn we're in so the UI
        // can toggle between stop-button (interruptible) and spinner
        // (wrap-up). The `_setStreamingUI(true, …)` call is cheap and
        // idempotent — it just swaps the button glyph.
        DevChat._setStreamingUI(true, data.phase);
        break;
      case 'stopped': {
        DevChat._removeSpinner();
        DevChat._deactivateLastStatus();
        // The status system-message ("Stopped by @user.") was already
        // persisted and emitted server-side via sendStatus, so no need
        // to add another row here — just tear down the streaming UI.
        DevChat._finishStreaming();
        break;
      }
      case 'assistant_message_end': {
        // Seal the current assistant bubble so a subsequent `token`
        // event starts a fresh one (matches the primary POST-SSE path).
        // Flush the held-back trailing line so the sealed bubble is exact.
        DevChat._flushStreamingFinal();
        const am = lastAssistantMsg();
        if (am) am._finalized = true;
        break;
      }
      case 'status': {
        DevChat._flushStreamingFinal();
        DevChat._removeSpinner();
        DevChat._deactivateLastStatus();
        // A status line always closes the current streaming bubble (#99):
        // tokens replayed after it must start a fresh bubble below it,
        // matching the primary POST-SSE path's seal-on-status.
        const sealMsg = lastAssistantMsg();
        if (sealMsg) sealMsg._finalized = true;
        DevChat.messages.push({ role: 'system', content: data.text, ccOutput: data.ccOutput, ccSummary: data.ccSummary, specPreview: data.specPreview, specLines: data.specLines, specVersion: data.specVersion, durationMs: data.durationMs, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2, 8), _active: true });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
      }
      case 'platform_issue_draft':
        DevChat._pushPlatformIssueDraft(data);
        break;
      case 'staging_ready':
        DevChat._removeSpinner();
        DevChat._deactivateLastStatus();
        // #439: a replayed staging_ready may be resolving an on-demand
        // Preview-click rebuild — open the new URL if its loader is pending.
        AppView.onStagingRebuildResult(sessionId, { url: data.url });
        DevChat.messages.push({ role: 'system', content: 'Staging deployed!', stagingUrl: data.url, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2, 8) });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        if (data.url && DevChat.currentSession) {
          DevChat.currentSession.staging_url = data.url;
          // #127: keep the replayed session's testing guidance in sync too.
          if ('testingMd' in data) DevChat.currentSession.testing_md = data.testingMd;
          if ('testingPath' in data) DevChat.currentSession.testing_path = data.testingPath;
        }
        break;
      case 'staging_failed':
        DevChat._removeSpinner();
        DevChat._deactivateLastStatus();
        // #439: surface a failed on-demand rebuild in the preview loader.
        AppView.onStagingRebuildResult(sessionId, { failed: true, error: data.error });
        DevChat.messages.push({
          role: 'system',
          content: `Staging build failed: ${data.error || 'unknown error'}`,
          // #361: same as the primary SSE path — a failed staging build still
          // means there's a reviewable commit, so render the card.
          changesReady: true,
          stagingFailed: true,
          stagingErrorName: data.errorName || 'Error',
          stagingMissingKeys: data.missingKeys || [],
          prNumber: data.prNumber != null ? data.prNumber : (DevChat.currentSession?.pr_number ?? null),
          prUrl: data.prUrl || DevChat.currentSession?.pr_url || null,
          created_at: new Date().toISOString(),
          _slug: Math.random().toString(36).slice(2, 8),
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
          DevChat.renderChatView();
        }
        break;
      case 'session_titled':
        // #249: pre-PR display name landed — refresh header/session UI.
        if (DevChat.currentSession && data.sessionTitle) {
          DevChat.currentSession.session_title = data.sessionTitle;
          DevChat.renderChatView();
        }
        break;
      case 'visuals_ready':
        // #195: same upgrade-in-place as the primary POST-SSE path.
        if (DevChat.currentSession && data.visuals) {
          DevChat.currentSession.visuals = data.visuals;
          DevChat.renderMessages();
        }
        break;
      case 'cc_progress':
        DevChat._appendProgressLine(data.text);
        DevChat.scrollToBottom();
        break;
      case 'cc_estimate':
        // Experimental AI progress estimate (opt-in, server-gated).
        DevChat._applyEstimate(data.text, data.remainingSeconds);
        break;
      case 'cc_log':
        DevChat.messages.push({ role: 'system', ccLog: data.log, content: 'Claude Code log', created_at: new Date().toISOString() });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
      case 'error': {
        DevChat._removeSpinner();
        const am = lastAssistantMsg();
        if (am) am.content += `\n\n> **Error:** ${data.error}`;
        else DevChat.messages.push({ role: 'assistant', content: `> **Error:** ${data.error}`, created_at: new Date().toISOString() });
        DevChat.renderMessages();
        break;
      }
      case 'usage': {
        const am = lastAssistantMsg();
        if (am) { am.model = data.model; am.costCents = data.costCents; }
        DevChat.refreshBudget();
        break;
      }
      case 'spec_updated':
        DevChat._handleSpecUpdated(data);
        break;
    }
  },

  _handleSpecUpdated(data) {
    // The status event for this same write already pushed an inline
    // preview card into the timeline (see the case 'status' arms),
    // which is the user-facing surface. The only thing left to do
    // here is keep the side viewer in sync if the user is following
    // the latest version — a write creates a new highest version, and
    // the 'latest' sentinel should advance to it on reload.
    if (DevChat.specViewer.open && DevChat.specViewer.viewVersion === 'latest') {
      DevChat._loadSpecViewer({ force: true });
    }
  },

  // Phase-aware button state (#28):
  //   - idle: "Send"
  //   - mayor1 / cc: red "Stop" button (clickable, aborts the turn)
  //   - mayor2: spinner (the wrap-up cannot be stopped because CC
  //             already pushed a commit + opened the PR)
  // A `null` phase while streaming means the client hasn't received a
  // `phase` event yet (older turn before this feature, or reconnect
  // before the first phase emit). Default to the stop affordance so the
  // user always has a way out; the server rejects the /stop request if
  // it's already in phase-2 anyway.
  _streamingPhase: null,

  // Title markers for the dev-chat status indicator (#108). Kept as a
  // map so applyTitleStatus can strip whichever one is currently
  // applied before re-prefixing.
  // Status text leads the title so it survives browser-tab truncation —
  // a glance at a narrow tab shows "⏳ Thinking…" even when the app
  // name doesn't fit.
  TITLE_STATUS_MARKERS: {
    thinking: '⏳ Thinking… · ',
    // #161 completion tier — set by notification arrival (see
    // setCompletionTitle), not by stream end.
    sessionDone: '✅ Session done · ',
    autoSolveDone: '🤖 Proposal ready · ',
    autoSolveFailed: '⚠️ Proposal failed · ',
  },

  // "Away" = the user can't currently see this page: the browser tab is
  // hidden, or the window has lost focus (another window on top). Used
  // to decide whether a finished run should leave a sticky "done"
  // marker in the title (#142).
  _userIsAway() {
    return document.visibilityState === 'hidden' || !document.hasFocus();
  },

  // #161: arm/disarm the server-side "notify me when this turn
  // finishes" flag for a session. Fire-and-forget — arming is
  // best-effort and the endpoint is idempotent, so duplicate or lost
  // calls are harmless (the pagehide beacon is the backstop for tab
  // close / hard navigations, where a normal fetch may be killed).
  _setNotifyOnDone(sessionId, armed) {
    if (!sessionId) return;
    try {
      fetch(`/api/sessions/${sessionId}/notify-on-done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ armed: !!armed }),
      }).catch(() => {});
    } catch { /* non-fatal */ }
  },

  // Set (or clear, with null) the dev-chat status reflected in
  // document.title. Non-null statuses only stick while the dev-chat tab
  // is the mounted tab — a turn finishing while the user is on the App
  // or Group Chat tab must not decorate those views' titles.
  setTitleStatus(status) {
    if (status && (typeof App === 'undefined' || !(App.currentTab === 'dev' && App.currentSubTab === 'sessions'))) {
      status = null;
    }
    if (DevChat._titleStatus === status) return;
    DevChat._titleStatus = status;
    DevChat.applyTitleStatus();
  },

  // #161: set (or clear, with null) the completion marker. Unlike
  // setTitleStatus this is NOT scoped to the dev-chat tab — the whole
  // point is the user is elsewhere (another tab, another view) when the
  // completion notification arrives. Cleared by the visibility/focus
  // return handler at the bottom of this file and by
  // Notifications._reconcileCompletionTitle when the triggering
  // notification is read.
  setCompletionTitle(status) {
    if (DevChat._titleCompletion === status) return;
    DevChat._titleCompletion = status;
    DevChat.applyTitleStatus();
  },

  // Re-derive document.title from the current base title + status
  // marker. Composes with Notifications._updateTitle's "(N) " unread
  // prefix: the count stays outermost — `(2) ⏳ MyApp` — because the
  // notifications module treats everything after the count as the base,
  // and we treat the count as a passthrough prefix here. Also safe to
  // call when no marker applies (it just strips a stale one). Exposed
  // (not underscored) because App.setHeaderTitle calls it after every
  // navigation re-set of the title.
  applyTitleStatus() {
    const full = document.title;
    const countMatch = full.match(/^\(\d+\)\s*/);
    const count = countMatch ? countMatch[0] : '';
    let base = full.slice(count.length);
    for (const m of Object.values(DevChat.TITLE_STATUS_MARKERS)) {
      if (base.startsWith(m)) { base = base.slice(m.length); break; }
    }
    // Precedence (#161): completion marker outranks the streaming
    // status; clearing the completion falls back to the live status, so
    // a still-streaming watched session reverts to "⏳ Thinking…".
    const active = DevChat._titleCompletion || DevChat._titleStatus;
    const marker = active ? DevChat.TITLE_STATUS_MARKERS[active] : '';
    const next = count + marker + base;
    if (next === full) return;
    document.title = next;
    // Mirror setHeaderTitle's fast-path sync to the native shell so the
    // Flutter AppBar tracks the marker too (unknown methods are dropped
    // by older app builds — see setHeaderTitle for the full story).
    try {
      if (window.Usernode && typeof window.Usernode.postMessage === 'function') {
        window.Usernode.postMessage(JSON.stringify({
          method: 'titleChanged',
          value: document.title,
        }));
      }
    } catch (_) {}
  },

  _setStreamingUI(streaming, phase = null) {
    if (streaming) DevChat._streamingPhase = phase;
    else DevChat._streamingPhase = null;

    // Every streaming state transition funnels through here (send,
    // reconnect, phase change, finish, stop), so this is the one hook
    // needed for the live-status indicator: streaming → "thinking";
    // streaming→idle just clears it. The legacy stream-end "done"
    // marker is gone (#161): finishing while away always produces a
    // session_done notification now, and its arrival sets the
    // completion marker via setCompletionTitle instead.
    if (streaming) DevChat.setTitleStatus('thinking');
    else if (DevChat._titleStatus === 'thinking') DevChat.setTitleStatus(null);

    const btn = document.getElementById('dc-send-btn');
    if (!btn) return;
    if (streaming) {
      const isWrapUp = phase === 'mayor2';
      if (isWrapUp) {
        btn.disabled = true;
        btn.classList.remove('dc-btn-stop');
        btn.classList.add('dc-btn-streaming');
        btn.setAttribute('aria-label', 'Finishing up');
        btn.title = 'Finishing up…';
        btn.innerHTML = '<span class="dc-send-spinner"></span>';
      } else {
        btn.disabled = false;
        btn.classList.remove('dc-btn-streaming');
        btn.classList.add('dc-btn-stop');
        btn.setAttribute('aria-label', 'Stop');
        btn.title = 'Stop';
        btn.innerHTML = '<span class="dc-stop-icon" aria-hidden="true"></span>';
      }
    } else {
      btn.disabled = false;
      btn.classList.remove('dc-btn-streaming');
      btn.classList.remove('dc-btn-stop');
      btn.setAttribute('aria-label', 'Send');
      btn.title = 'Send';
      btn.textContent = 'Send';
    }

    const input = document.getElementById('dc-input');
    if (input) input.disabled = streaming;

    // #252: the sync banner's button disables (with a hint) while a
    // chat turn holds the worker — keep it in step with every
    // streaming transition. Cheap no-op when no banner is mounted.
    if (document.getElementById('dc-sync-banner')) DevChat._applySyncBanner();

    // #285: hide the quick-reply pills while a turn is streaming (they're
    // stale until the new reply lands), restore them when it settles.
    DevChat._renderQuickReplies();
  },

  async _stopCurrentTurn() {
    if (!DevChat.isStreaming || !DevChat.currentSession) return;
    if (DevChat._streamingPhase === 'mayor2') return;
    const sessionId = DevChat.currentSession.id;

    // Restore the message the user was stopping into the input so they
    // can edit + resend without retyping. We pull from the in-memory
    // messages array (most recent user row is the one they just sent)
    // rather than plumbing it through from sendMessage so this also
    // works when stop is pressed after a cross-tab reconnect. onlyIfEmpty
    // keeps a half-typed follow-up from being clobbered; the sent bubble
    // stays in the timeline (the turn really ran), so no splice here.
    try {
      for (let i = DevChat.messages.length - 1; i >= 0; i--) {
        const m = DevChat.messages[i];
        if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
          DevChat._restoreComposer(m.content, { onlyIfEmpty: true });
          break;
        }
      }
    } catch {}

    // Optimistically disable the stop button so double-clicks don't
    // fire two POSTs. Keep isStreaming true until the server emits
    // `stopped` — we want the status bubble to show up before the UI
    // unwinds.
    const btn = document.getElementById('dc-send-btn');
    if (btn) btn.disabled = true;
    try {
      await fetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
    } catch (err) {
      console.warn('[dc] stop request failed', err);
      if (btn) btn.disabled = false;
    }
  },

  _showSpinner() {
    const container = document.getElementById('dc-messages');
    if (!container) return;
    const el = document.createElement('div');
    el.id = 'dc-spinner';
    el.className = 'px-3 py-2';
    el.innerHTML = '<div class="dc-streaming-dots"><span></span><span></span><span></span></div>';
    container.appendChild(el);
  },

  _removeSpinner() {
    const el = document.getElementById('dc-spinner');
    if (el) el.remove();
  },

  _progressPollTimer: null,

  _startProgressPolling(sessionId, initialProgress) {
    DevChat._stopProgressPolling();

    // Show initial progress if any. Use replace (not append per-line) because
    // the persisted message loaded by openSession already contains these
    // lines — appending would double them up.
    if (initialProgress?.length) {
      DevChat._replaceProgressLog(initialProgress);
    }

    DevChat._progressPollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/status`);
        if (!res.ok) return;
        const { busy, progress, estimate } = await res.json();

        if (progress?.length) {
          DevChat._replaceProgressLog(progress);
        }

        // Experimental AI progress estimate: the /status fallback carries
        // the latest in-memory guess so an SSE/WS drop doesn't lose it.
        // `estimate` is now { text, remainingSeconds }; tolerate a legacy
        // bare-string shape from an older server.
        if (estimate) {
          if (typeof estimate === 'string') {
            DevChat._applyEstimate(estimate);
          } else {
            DevChat._applyEstimate(estimate.text, estimate.remainingSeconds);
          }
        }

        if (!busy) {
          DevChat._stopProgressPolling();
          DevChat.isStreaming = false;
          DevChat._setStreamingUI(false);
          // Reload messages to get final state
          await DevChat.openSession(sessionId);
          DevChat.renderMessages();
          DevChat.scrollToBottom();
        }
      } catch {}
    }, 3000);
  },

  _stopProgressPolling() {
    if (DevChat._progressPollTimer) {
      clearInterval(DevChat._progressPollTimer);
      DevChat._progressPollTimer = null;
    }
  },

  // Live progress updates. We keep a single progress message per run, stored
  // in DevChat.messages with `_progress: true`, whose progressLog array drives
  // the "Claude Code output (N lines)" collapsible in renderMessages(). We
  // used to also inject a DOM-only "Claude Code live output" <details> via
  // _appendProgressLine, but that caused TWO collapsibles for the same turn
  // whenever SSE dropped and we fell back to polling (or the user refreshed
  // mid-run), because by then the persisted log had already been rendered
  // from the server.
  // Returns the message we should append live progress lines to. Only
  // matches messages flagged `_progress: true` so that prior turns'
  // persisted "Claude Code output (N lines)" collapsibles don't get
  // accidentally re-used as the target for a new run.
  _currentProgressMsg() {
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      const m = DevChat.messages[i];
      if (m.role === 'system' && m._progress) return m;
    }
    return null;
  },

  _appendProgressLine(text) {
    let msg = DevChat._currentProgressMsg();
    const isNew = !msg;
    if (!msg) {
      msg = {
        role: 'system',
        content: 'Claude Code progress',
        progressLog: [],
        _progress: true,
        created_at: new Date().toISOString(),
        _slug: Math.random().toString(36).slice(2, 8),
      };
      DevChat.messages.push(msg);
    }
    msg.progressLog.push(text);
    if (isNew) DevChat.renderMessages();
    else DevChat._patchProgressDom(msg);
  },

  _replaceProgressLog(lines) {
    let msg = DevChat._currentProgressMsg();
    const isNew = !msg;
    if (!msg) {
      msg = {
        role: 'system',
        content: 'Claude Code progress',
        progressLog: [],
        _progress: true,
        created_at: new Date().toISOString(),
        _slug: Math.random().toString(36).slice(2, 8),
      };
      DevChat.messages.push(msg);
    }
    msg.progressLog = lines.slice();
    if (isNew) DevChat.renderMessages();
    else DevChat._patchProgressDom(msg);
  },

  // Targeted DOM update so we don't rebuild the whole message list on every
  // streamed line (which would flicker and reset scroll). Falls back to a
  // full renderMessages() if the collapsible hasn't been rendered yet.
  _patchProgressDom(msg) {
    const pid = DevChat._detailsId(msg, 'progress');
    // The element with this pid is either:
    //   - the inner <pre> in the merged "Claude Code is running"
    //     <details> (current shape — no surrounding box), OR
    //   - the legacy gray-box <details> wrapping a <pre> (orphan
    //     progress messages persisted in the DB before the merge).
    const target = document.querySelector(`#dc-messages [data-persist-id="${CSS.escape(pid)}"]`);
    if (!target) {
      DevChat.renderMessages();
      return;
    }
    const text = msg.progressLog.join('\n');
    if (target.tagName === 'PRE') {
      target.textContent = text;
      target.scrollTop = target.scrollHeight;
      DevChat._patchProgressSummary(target, msg);
      return;
    }
    // Legacy details-wrapping element: keep updating the inner pre
    // and the line-count summary so old timeline entries still work.
    const summary = target.querySelector('.dc-cc-log-toggle');
    const pre = target.querySelector('.dc-cc-log-content');
    if (summary) summary.textContent = `Claude Code output (${msg.progressLog.length} lines)`;
    if (pre) {
      pre.textContent = text;
      pre.scrollTop = pre.scrollHeight;
    }
  },

  // #50: keep the running summary's live-activity snippet + step counter in
  // sync as progress lines stream in, without a full re-render. `target` is
  // the inner <pre> _patchProgressDom just updated; the spans live in the
  // enclosing <details>' summary. Covers both the live-append path
  // (_appendProgressLine) and the polling fallback (_replaceProgressLog),
  // since both funnel through _patchProgressDom.
  _patchProgressSummary(target, msg) {
    if (typeof summarizeCcProgress !== 'function') return;
    const details = target.closest ? target.closest('details.dc-cc-attached') : null;
    if (!details) return;
    const summ = summarizeCcProgress(msg.progressLog || []);
    const cur = details.querySelector('.dc-cc-current');
    if (cur) cur.textContent = summ.currentLabel ? `— ${summ.currentLabel}` : '';
    const steps = details.querySelector('.dc-cc-steps');
    if (steps) steps.textContent = summ.steps ? `· ${summ.steps} steps` : '';
  },

  // Experimental AI progress estimate (opt-in, server-gated). Stores the
  // latest Haiku guess on the active status message (so full re-renders
  // keep it) and patches the running summary's estimate span in place.
  // The server only emits cc_estimate when the user's toggle is ON, so
  // with the toggle off this never runs and the line is pixel-identical
  // to before.
  // #359: turn the latest remaining-seconds guess into an absolute target
  // end-timestamp the shared 1s ticker can count down from. Returns null
  // when the model declined a number (remainingSeconds == null/invalid) so
  // the phrase renders alone, exactly as before #50's "phrase only" path.
  _countdownTarget(remainingSeconds) {
    if (remainingSeconds == null) return null;
    const n = Number(remainingSeconds);
    if (!Number.isFinite(n) || n < 0) return null;
    return Date.now() + n * 1000;
  },

  // The trailing live count-down span (#359, replacing the static "· ~X
  // left" suffix from #50). Carries an absolute `data-countdown-to`
  // end-timestamp that _tickElapsed recomputes each second; empty (no span)
  // when there's no numeric guess to count down from. The initial
  // textContent is filled here so the span isn't blank for the up-to-1s
  // before the first tick.
  _countdownSpanHtml(countdownTo) {
    if (countdownTo == null || typeof formatCountdown !== 'function') return '';
    const initial = formatCountdown(countdownTo, Date.now());
    return `<span class="dc-cc-countdown" data-countdown-to="${countdownTo}">${initial}</span>`;
  },

  _applyEstimate(text, remainingSeconds) {
    const clean = (text || '').toString().trim();
    if (!clean) return;
    const remaining = remainingSeconds == null ? null : remainingSeconds;
    let target = null;
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      const m = DevChat.messages[i];
      if (m.role === 'system' && m._active) { target = m; break; }
    }
    if (!target) {
      // No active running line yet (the estimate beat the first status
      // render, or we just reconnected). Stash it so the next render/poll
      // applies it instead of dropping it silently (#323).
      DevChat._pendingEstimate = { text: clean, remainingSeconds: remaining };
      return;
    }
    DevChat._pendingEstimate = null;
    target._estimate = clean;
    target._estimateRemaining = remaining;
    // #359: re-anchor the count-down to this fresh guess (or clear it when
    // the model declined a number) so the next tick counts from here.
    target._countdownTo = DevChat._countdownTarget(remaining);
    // Patch in place within THIS run's own DOM node (keyed by persist-id)
    // rather than the last estimate span on the page, so a prior collapsed
    // run's span can't be mis-targeted (#323).
    const pid = DevChat._detailsId(target, 'ccrun');
    let span = document.querySelector(`#dc-messages [data-persist-id="${pid}"] .dc-cc-estimate`);
    if (!span) {
      // Fallback: before the progress log attaches the run may render via a
      // different path — patch the last estimate span as the old code did.
      const spans = document.querySelectorAll('#dc-messages .dc-cc-estimate');
      span = spans.length ? spans[spans.length - 1] : null;
    }
    // innerHTML (not textContent): the count-down lives in a child span the
    // ticker patches in place. The phrase is escaped because it's model output.
    if (span) span.innerHTML = `· ✦ AI guess: ${escapeHtml(clean)}${DevChat._countdownSpanHtml(target._countdownTo)}`;
  },

  // ── #50: elapsed-time ticker ────────────────────────────────
  //
  // Active status lines render a `[data-elapsed-since]` span; one shared
  // 1s interval recomputes each from its start timestamp (drift-proof
  // under background-tab throttling — browsers may fire the interval
  // late, but the displayed value is always now - startedAt) and patches
  // textContent only, never re-rendering the message list.
  _elapsedTimer: null,

  _syncElapsedTicker() {
    // #359: the same 1s heartbeat now also drives the AI-estimate
    // count-down span, so the predicate matches either kind of ticking span.
    const any = document.querySelector('#dc-messages [data-elapsed-since], #dc-messages [data-countdown-to]');
    if (any && !DevChat._elapsedTimer) {
      DevChat._elapsedTimer = setInterval(() => DevChat._tickElapsed(), 1000);
    } else if (!any && DevChat._elapsedTimer) {
      clearInterval(DevChat._elapsedTimer);
      DevChat._elapsedTimer = null;
    }
    // Fill immediately so the spans aren't blank until the first tick.
    if (any) DevChat._tickElapsed();
  },

  _tickElapsed() {
    const els = document.querySelectorAll('#dc-messages [data-elapsed-since]');
    // #359: count-down spans share this loop — anchored to an absolute
    // target end-timestamp and clamped at "due now" (formatCountdown), so a
    // late-firing tick under tab throttling still shows the right value.
    const downs = document.querySelectorAll('#dc-messages [data-countdown-to]');
    if (!els.length && !downs.length) {
      if (DevChat._elapsedTimer) {
        clearInterval(DevChat._elapsedTimer);
        DevChat._elapsedTimer = null;
      }
      return;
    }
    const now = Date.now();
    if (typeof formatElapsed === 'function') {
      els.forEach((el) => {
        const since = parseInt(el.dataset.elapsedSince, 10);
        if (!Number.isFinite(since)) return;
        el.textContent = formatElapsed(Math.max(0, now - since));
      });
    }
    if (typeof formatCountdown === 'function') {
      downs.forEach((el) => {
        const to = parseInt(el.dataset.countdownTo, 10);
        if (!Number.isFinite(to)) return;
        el.textContent = formatCountdown(to, now);
      });
    }
  },

  // The elapsed/duration suffix for a system status row:
  //   - `_active` rows get the live ticker span (filled by _tickElapsed);
  //   - finished rows show a static "(took Xm Ys)" from the server's
  //     persisted durationMs (reload-safe) or the client-side freeze
  //     stamped by _deactivateLastStatus (live-session only).
  _statusElapsedHtml(msg) {
    // A server-persisted duration wins even while the row is still
    // `_active` (e.g. "Claude Code finished" arriving mid-turn): the row
    // describes a completed step, so a fresh ticker would be misleading.
    if (msg.durationMs != null && typeof formatElapsed === 'function') {
      return `<span class="dc-status-elapsed">(took ${formatElapsed(Math.max(0, msg.durationMs))})</span>`;
    }
    if (msg._active && msg.created_at) {
      const since = new Date(msg.created_at).getTime();
      if (!Number.isFinite(since)) return '';
      return `<span class="dc-status-elapsed" data-elapsed-since="${Math.min(since, Date.now())}"></span>`;
    }
    if (msg._elapsedFinalMs != null && typeof formatElapsed === 'function') {
      return `<span class="dc-status-elapsed">(took ${formatElapsed(Math.max(0, msg._elapsedFinalMs))})</span>`;
    }
    return '';
  },

  _deactivateLastStatus() {
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      if (DevChat.messages[i]._active) {
        const m = DevChat.messages[i];
        m._active = false;
        // #50: freeze the elapsed display at the step's total so later
        // renders in this live session show "(took Xm Ys)" instead of a
        // ticker. Client-only; reload persistence for terminal lines
        // comes from the server's durationMs metadata.
        if (m._elapsedFinalMs == null && m.created_at) {
          const started = new Date(m.created_at).getTime();
          if (Number.isFinite(started)) {
            m._elapsedFinalMs = Math.max(0, Date.now() - started);
          }
        }
        // Experimental AI estimate: a finished/stopped step never shows a
        // guess — the real duration replaces it. Clear the count-down anchor
        // too (#359) so a stale target can't be re-rendered.
        delete m._estimate;
        delete m._countdownTo;
        break;
      }
    }
  },

  

  // #127: open the staging preview with the session's testing guidance
  // attached. `jump` opens the iframe directly at the deep-link path (the
  // "Test this change" button); plain Preview starts at the app root but
  // still carries the guidance so the overlay can offer its own "Test this
  // change" button + "How to test" panel. The markdown is looked up here at
  // click time so it never transits an HTML attribute.
  previewStaging(url, jump) {
    const s = DevChat.currentSession || {};
    const testing = (s.testing_md || s.testing_path)
      ? { md: s.testing_md || null, path: s.testing_path || null }
      : null;
    // #439: route through ensure-then-open so a preview torn down while the
    // user was away (idle GC, lost container) rebuilds on click. Prefer the
    // session's live staging_url over the (possibly stale) message URL as
    // the fallback for the already-live case. With no session id we can't
    // ensure — fall back to the legacy direct open.
    if (s.id) {
      AppView.ensureStaging(s.id, s.staging_url || url, testing, { jump: !!jump });
    } else {
      AppView.swapToStaging(url, testing, { jump: !!jump });
    }
  },

  async promotePR() {
    if (!DevChat.currentSession?.id) return;
    try {
      const res = await fetch(`/api/sessions/${DevChat.currentSession.id}/promote`, { method: 'POST' });
      if (res.ok) {
        // #183: promote may have lazily created the PR (sessions cloned
        // from a headless auto run arrive PR-less). Fold the returned PR
        // info into the session so the staging card header flips from
        // "Changes ready" to the PR link without a refetch.
        const data = await res.json().catch(() => ({}));
        DevChat.currentSession.status = 'promoted';
        if (data.prNumber) {
          DevChat.currentSession.pr_number = data.prNumber;
          if (data.prUrl) DevChat.currentSession.pr_url = data.prUrl;
          if (data.prTitle) {
            DevChat.currentSession.pr_title = data.prTitle;
            // #249: server mirrors pr_title into session_title.
            DevChat.currentSession.session_title = data.prTitle;
          }
        }
        DevChat.renderMessages();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to promote');
      }
    } catch {
      alert('Network error');
    }
  },

  // Append a live agent-suggested platform-report card to the timeline.
  // Called from every live channel (POST SSE, resumable SSE, WS), so
  // dedupe by the draft's DB msgId — the channels overlap by design.
  _pushPlatformIssueDraft(data) {
    const draft = data && data.platformIssueDraft;
    if (!draft || !draft.msgId) return;
    if (DevChat.messages.some(
      (m) => m.platformIssueDraft && m.platformIssueDraft.msgId === draft.msgId
    )) return;
    DevChat.messages.push({
      role: 'system',
      content: data.text || 'The AI thinks this may be a platform-level issue',
      platformIssueDraft: draft,
      created_at: new Date().toISOString(),
      _slug: Math.random().toString(36).slice(2, 8),
    });
    DevChat.renderMessages();
    DevChat.scrollToBottom();
  },

  // Human gate for agent-drafted platform issue reports: confirm files
  // the GitHub issue (server-side, bot PAT), dismiss kills the draft.
  // Either way the card's state flips in place — no refetch needed.
  async resolvePlatformIssueDraft(msgId, action, btn) {
    if (!DevChat.currentSession?.id || !msgId) return;
    // Disable both buttons on the card so a double-tap can't double-file
    // (the server also claims the draft atomically, this is just UX).
    const card = btn?.closest ? btn.closest('.dc-pr-card') : null;
    if (card) card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const res = await fetch(
        `/api/sessions/${DevChat.currentSession.id}/platform-issue/${msgId}/${action}`,
        { method: 'POST' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 409) {
        alert(data.error || 'Failed — try again');
        if (card) card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        return;
      }
      // 409 means another member resolved it first — fold in whatever
      // final state the server reports, same as a success.
      const msg = DevChat.messages.find(
        (m) => m.platformIssueDraft && m.platformIssueDraft.msgId === msgId
      );
      if (msg) {
        msg.platformIssueDraft.status = data.status
          || (action === 'dismiss' ? 'dismissed' : 'filed');
        if (data.url) msg.platformIssueDraft.issueUrl = data.url;
        if (data.number) msg.platformIssueDraft.issueNumber = data.number;
        DevChat.renderMessages();
      }
    } catch {
      alert('Network error');
      if (card) card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  },

  // ── Rendering ─────────────────────────────────────────────

  

  renderMessages() {
    const container = document.getElementById('dc-messages');
    if (!container) return;
    const session = DevChat.currentSession;

    // Drain a pending AI progress estimate (#323): an estimate can arrive
    // before the active running line exists in DevChat.messages (estimate
    // beat the first status render, or a reconnect). Apply it now so the
    // guess survives onto the line instead of being silently dropped.
    if (DevChat._pendingEstimate) {
      for (let i = DevChat.messages.length - 1; i >= 0; i--) {
        const m = DevChat.messages[i];
        if (m.role === 'system' && m._active) {
          m._estimate = DevChat._pendingEstimate.text;
          m._estimateRemaining = DevChat._pendingEstimate.remainingSeconds;
          // #359: anchor the count-down for the drained pending estimate too.
          m._countdownTo = DevChat._countdownTarget(m._estimateRemaining);
          DevChat._pendingEstimate = null;
          break;
        }
      }
    }

    // Pre-pass: pair each `progressLog` system message with the
    // nearest preceding active-CC status line ("Claude Code is
    // running" for build, legacy "Claude Code is making changes",
    // and "Scout reading the codebase" for scout) so we can render
    // the live log inline under it as a click-to-collapse <details>
    // instead of as a separate gray-boxed "Claude Code output (N
    // lines)" entry that disappears on reload. Two indices keep the
    // main render loop cheap:
    //   progressByStatus  — statusMsgRef → progressMsg (used to render)
    //   mergedProgress    — progressMsgRef → true       (skip standalone)
    const progressByStatus = new Map();
    const mergedProgress = new Set();
    // Matches all status lines that wrap a worker exec: build mode
    // emits "Claude Code is running" (and the older "...is making
    // changes" wording for legacy DB rows); scout emits "Scout
    // reading the codebase"; sync-with-main emits "Syncing with main".
    // Each is paired with a 'Claude Code progress' system row whose
    // live log we want to attach.
    const ACTIVE_CC_STATUS_RE
      = /^(Claude Code is (running|making changes)|Scout reading the codebase|Syncing with main)/i;
    // Helper: is this a viable status candidate for pairing? Stop on
    // any non-system row (status/progress pairs always live inside a
    // single dispatch turn) and skip rows that already carry their
    // own attached artefact (ccOutput / progressLog / stagingUrl /
    // ccLog / specPreview) so we don't accidentally re-use a row
    // belonging to a previous CC run.
    const isPairableStatus = (s) => {
      if (s.role !== 'system') return null; // null → caller breaks
      if (s.progressLog) return false;
      if (s.ccLog || s.ccOutput || s.stagingUrl || s.specPreview) return false;
      return ACTIVE_CC_STATUS_RE.test(String(s.content || ''));
    };
    for (let i = 0; i < DevChat.messages.length; i++) {
      const m = DevChat.messages[i];
      if (m.role !== 'system' || !m.progressLog) continue;

      // Walk backward first — this is the post-reload case where
      // sendStatus's INSERT lands BEFORE the progress INSERT in the
      // DB, so the timeline order is "status → progress".
      let paired = null;
      for (let j = i - 1; j >= 0; j--) {
        const s = DevChat.messages[j];
        if (s.role !== 'system') break;
        const ok = isPairableStatus(s);
        if (ok === null) break;
        if (ok === true) { paired = s; break; }
      }

      // Walk forward if backward found nothing. This is the LIVE case:
      // the first `cc_progress` SSE event (typically from the
      // `ensureWorker` bootstrap clone/checkout phase) creates the
      // in-memory progress message BEFORE the upcoming
      // "Claude Code is running…" / "Scout reading the codebase…"
      // sendStatus event arrives, so the active-CC status sits at a
      // later index than the progress row until the next reload.
      if (!paired) {
        for (let j = i + 1; j < DevChat.messages.length; j++) {
          const s = DevChat.messages[j];
          if (s.role !== 'system') break;
          const ok = isPairableStatus(s);
          if (ok === null) break;
          if (ok === true) { paired = s; break; }
        }
      }

      if (paired) {
        progressByStatus.set(paired, m);
        mergedProgress.add(m);
      }
    }

    // Q/A mode (#32): suggested-answer chips render only under the LAST
    // non-system message — and only when the session is one the viewer
    // can still act in. Once the user replies (chip or typed), the
    // question row stops being last and the chips vanish on re-render,
    // so no explicit teardown is needed.
    let qaLastConvoIdx = -1;
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      if (DevChat.messages[i].role !== 'system') { qaLastConvoIdx = i; break; }
    }
    const qaInteractive = !!session && (session.status === 'active' || session.status === 'promoted');

    container.innerHTML = DevChat.messages.map((msg, msgIdx) => {
      // System messages — each is a single immutable status line
      if (msg.role === 'system') {
        // Inline spec preview card. The Mayor's scout dispatch
        // emits this metadata alongside the status line; clicking the
        // card opens the read-only spec viewer (side panel on wide
        // viewports, fullscreen modal on narrow). We clip the snippet
        // server-side (~400 chars) and again here client-side so the
        // card stays compact in the timeline.
        if (msg.specPreview) {
          const sTs = msg.created_at ? new Date(msg.created_at).getTime() : '';
          const sId = msg.id || msg._slug || '';
          const lineCount = msg.specLines || (msg.specPreview.split('\n').length);
          // Clip the snippet to WHOLE LINES only, so a partial task item is
          // never half-included: as a scout redraft shifts the text, a
          // `- [ ]` line near the boundary would otherwise pop in and out
          // (its checkbox flickering) between drafts. clipSpecSnippet drops
          // any line the 200-char boundary would bisect; it falls back to
          // the old whitespace-boundary clip only for a single over-long
          // line with no newline in range (no task item to bisect there).
          const snippet = typeof clipSpecSnippet === 'function'
            ? clipSpecSnippet(msg.specPreview, 200)
            : msg.specPreview;
          const versionAttr = msg.specVersion != null ? msg.specVersion : 'latest';
          const headerLabel = msg.specVersion != null
            ? `Spec v${msg.specVersion} · ${lineCount} lines`
            : `Spec drafted · ${lineCount} lines`;
          return `
            <div class="dc-status-line"><span class="dc-status-icon dc-status-check" aria-hidden="true">&#10003;</span> ${msg.content} ${DevChat._statusElapsedHtml(msg)}<span style="font-size:9px;opacity:0.4;margin-left:auto">${sId} ${sTs}</span></div>
            <div class="dc-spec-preview-card" data-spec-version="${versionAttr}" role="button" tabindex="0" aria-label="Open spec viewer">
              <div class="dc-spec-preview-header">
                <span class="dc-spec-preview-title">${escapeHtml(headerLabel)}</span>
                <span class="dc-spec-preview-cta">View full spec →</span>
              </div>
              <div class="dc-spec-preview-snippet">${DevChat.renderMarkdown(snippet, { breaks: false })}</div>
            </div>`;
        }
        // Platform-issue draft card (human gate): the agent suggested
        // escalating a platform-level blocker. Nothing is filed until a
        // user taps "Report to platform"; Dismiss kills the draft. Both
        // buttons need the DB msgId — a live-pushed draft carries it in
        // the event, a rehydrated one gets it from the row id.
        if (msg.platformIssueDraft) {
          const d = msg.platformIssueDraft;
          const pTs = msg.created_at ? new Date(msg.created_at).getTime() : '';
          const pId = msg.id || msg._slug || '';
          const bodyPreview = String(d.body || '').length > 300
            ? `${String(d.body).slice(0, 300)}…` : String(d.body || '');
          let actionsHtml = '';
          if (d.status === 'filed' && d.issueUrl) {
            actionsHtml = `<a href="${escapeHtml(d.issueUrl)}" target="_blank" class="dc-pr-btn dc-pr-btn-preview" style="text-decoration:none">Reported — issue #${d.issueNumber}</a>`;
          } else if (d.status === 'filed') {
            actionsHtml = '<span style="color:var(--text-muted);font-size:12px">Reported to the platform</span>';
          } else if (d.status === 'dismissed') {
            actionsHtml = '<span style="color:var(--text-muted);font-size:12px">Dismissed</span>';
          } else if (d.msgId) {
            actionsHtml = `
              <button class="dc-pr-btn dc-pr-btn-promote" onclick="DevChat.resolvePlatformIssueDraft(${d.msgId}, 'confirm', this)">Report to platform</button>
              <button class="dc-pr-btn dc-pr-btn-preview" onclick="DevChat.resolvePlatformIssueDraft(${d.msgId}, 'dismiss', this)">Dismiss</button>`;
          }
          return `
            <div class="dc-status-line"><span class="dc-status-icon dc-status-check" aria-hidden="true">&#9873;</span> ${escapeHtml(msg.content || 'The AI thinks this may be a platform-level issue')}<span style="font-size:9px;opacity:0.4;margin-left:auto">${pId} ${pTs}</span></div>
            <div class="dc-pr-card" data-platform-issue-msg="${d.msgId || ''}">
              <div class="dc-pr-card-header">
                <span style="color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em">Suggested platform report</span>
              </div>
              <div style="font-weight:600;margin:4px 0 2px">${escapeHtml(d.title || '')}</div>
              ${bodyPreview ? `<div style="font-size:13px;color:var(--text-muted);white-space:pre-wrap;margin-bottom:6px">${escapeHtml(bodyPreview)}</div>` : ''}
              <div class="dc-pr-card-actions">${actionsHtml}</div>
            </div>`;
        }
        if (msg.ccLog) {
          const pid = DevChat._detailsId(msg, 'cclog');
          return `<details class="dc-cc-log" data-persist-id="${pid}"><summary class="dc-cc-log-toggle">Claude Code log</summary><pre class="dc-cc-log-content">${msg.ccLog.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre></details>`;
        }
        if (msg.progressLog?.length) {
          // Already merged into a parent "Claude Code is running"
          // status line by the pre-pass above — nothing to render here.
          if (mergedProgress.has(msg)) return '';
          // Orphan progress message — old DB rows that didn't have a
          // matching predecessor status line. Render in the SAME new
          // attached style (not the legacy gray box) with a synthetic
          // status line, so the visual stays consistent across the
          // timeline regardless of how the row was originally written.
          const logText = msg.progressLog.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const innerPid = DevChat._detailsId(msg, 'progress');
          const outerPid = DevChat._detailsId(msg, 'ccrunorphan');
          const ts = msg.created_at ? new Date(msg.created_at).getTime() : '';
          const id = msg.id || msg._slug || '';
          const icon = '<span class="dc-status-icon dc-status-check" aria-hidden="true">&#10003;</span>';
          return `<details class="dc-cc-attached" data-persist-id="${outerPid}" data-default-open="1" open><summary class="dc-status-line dc-cc-attached-summary">${icon} Claude Code output<span class="dc-cc-attached-chevron" aria-hidden="true"></span><span style="font-size:9px;opacity:0.4;margin-left:auto">${id} ${ts}</span></summary><pre class="dc-cc-attached-log" data-persist-id="${innerPid}">${logText}</pre></details>`;
        }
        // #361: the "Changes ready" card renders whenever the turn produced
        // a reviewable commit — i.e. either a preview built (msg.stagingUrl)
        // OR the staging-independent marker (msg.changesReady) is set on the
        // message (staging-failed turns, rehydrated metadata, cloned rows).
        // Staging is an ENRICHMENT of the card, not its on/off switch: when
        // the preview is absent, the Preview button is shown disabled with a
        // short "rebuild on propose" note (surfacing the missing-secret hint
        // when that was the cause), while Propose still works — promote
        // lazily creates the PR and rebuilds staging itself (routes/votes.js).
        if (msg.stagingUrl || msg.changesReady) {
          const stgTs = msg.created_at ? new Date(msg.created_at).getTime() : '';
          const stgId = msg.id || msg._slug || '';
          // Once the PR merges (or is mid-merge), the merge path tears down
          // the staging container, so this historical preview link is dead —
          // clicking it lands on a 502/blank page. Disable it instead, with a
          // tooltip pointing the user at the now-live app.
          const previewGone = !!session && (session.status === 'merged' || session.status === 'merging' || !!session.merged_at);
          // #439: the Preview button is ACTIVE whenever this card represents
          // reviewable work that isn't merged. Clicking always routes through
          // DevChat.previewStaging → ensure-staging, which opens a live
          // preview as-is OR rebuilds a torn-down one on demand (idle GC /
          // lost container) — no more dead links or "proposing will rebuild
          // it" dead-ends. It renders disabled only once the change is merged
          // (previewGone), when the preview is intentionally gone and the
          // change is live in the app.
          const canPreview = !previewGone;
          // Best-known URL handed to the opener as a fallback. ensure-staging
          // keys off the session id and prefers the session's live
          // staging_url, so this is only used for the already-live fast path;
          // prefer the session row over the (possibly stale) message URL.
          const liveUrl = (session && session.staging_url) || msg.stagingUrl || '';
          // #127: bot-emitted testing guidance lives on the session row
          // (testing_md / testing_path). When present, offer a "Test this
          // change" button that opens the preview at the deep link with the
          // instructions panel showing. The markdown is looked up at click
          // time (DevChat.previewStaging) — never inlined in the attribute.
          const hasTesting = !!(session?.testing_md || session?.testing_path);
          // Active Test button whenever a preview can be opened/rebuilt; the
          // disabled "Test this change" only once the merge tore it down.
          const testBtn = !hasTesting ? '' : (canPreview
            ? `<button class="dc-pr-btn dc-pr-btn-preview" onclick="DevChat.previewStaging('${liveUrl}', true)">Test this change</button>`
            : `<button class="dc-pr-btn dc-pr-btn-preview" disabled title="Preview removed after merge — this change is now live in the app">Test this change</button>`);
          // Disabled tooltip only applies to the merged case now — a missing/
          // failed-build preview is rebuilt on click and surfaces any reason
          // (missing secret, etc.) in the preview loader, not here.
          const previewBtnTitle = 'Preview removed after merge — this change is now live in the app';
          const previewBtnHtml = canPreview
            ? `<button class="dc-pr-btn dc-pr-btn-preview" onclick="DevChat.previewStaging('${liveUrl}', false)">Preview staging</button>`
            : `<button class="dc-pr-btn dc-pr-btn-preview" disabled title="${escapeHtml(previewBtnTitle)}">Preview staging</button>`;
          // #439: no inline "proposing will rebuild it" note anymore — the
          // Preview button itself rebuilds on click.
          const previewNote = '';
          // PR link prefers the session row, falling back to the marker the
          // message carries (so a rehydrated/cloned failure card still links
          // out even before the session refetch lands).
          const prUrl = session?.pr_url || msg.prUrl || null;
          const prNumber = session?.pr_number || msg.prNumber || null;
          // #195: before/after capture tiles. Visuals are latest-set-per-
          // session, so only the NEWEST staging card carries them — older
          // cards from earlier turns would just repeat the same media. The
          // scan recognizes changesReady cards too so a later success card
          // still wins; visuals only attach to a card that has a live URL.
          let visualsHtml = '';
          if (window.AppView && session?.visuals) {
            let latestStagingMsg = null;
            for (let vi = DevChat.messages.length - 1; vi >= 0; vi--) {
              if (DevChat.messages[vi].stagingUrl || DevChat.messages[vi].changesReady) { latestStagingMsg = DevChat.messages[vi]; break; }
            }
            if (latestStagingMsg === msg && msg.stagingUrl) visualsHtml = AppView.visualsTilesHtml(session.visuals);
          }
          // #405: the change card's status used to freeze on "Proposed!"
          // and never reflect the later merge stages. Drive it from the
          // shared lifecycle helper so it tracks In vote → Passed → Merging…
          // → ✓ Merged; the merged case gets a friendlier, self-explanatory
          // label that doubles as the reason the preview link is gone.
          let cardStatusHtml = '';
          if (session && session.status !== 'active' && window.MergeStatus && MergeStatus.lifecycle) {
            const cardLife = MergeStatus.lifecycle(session);
            if (cardLife && cardLife.key === 'merged') {
              cardStatusHtml = '<span class="ms-badge ms-badge-violet" title="This change is merged and now live in the app.">✓ Merged — now live in the app</span>';
            } else if (cardLife && cardLife.label) {
              cardStatusHtml = MergeStatus.badgeHtml(cardLife);
            }
          }
          return `
            <div class="dc-status-line"><span class="dc-status-icon dc-status-check" aria-hidden="true">&#10003;</span> ${msg.content} <span style="font-size:9px;opacity:0.4;margin-left:auto">${stgId} ${stgTs}</span></div>
            <div class="dc-pr-card" id="dc-pr-card">
              <div class="dc-pr-card-header">
                ${prUrl ? `<a href="${prUrl}" target="_blank" class="dc-pr-link">PR #${prNumber}</a>` : '<span style="color:var(--text-muted)">Changes ready</span>'}
                ${(session?.session_title || session?.pr_title) ? `<span class="dc-pr-title">${escapeHtml(session.session_title || session.pr_title)}</span>` : ''}
                ${window.AppView ? AppView.closesPillHtml(session) : ''}
                <span style="font-size:9px;opacity:0.4;margin-left:8px">${stgId} ${stgTs}</span>
              </div>
              ${visualsHtml ? `<div class="dc-pr-card-visuals" style="margin:6px 0 2px">${visualsHtml}</div>` : ''}
              <div class="dc-pr-card-actions">
                ${previewBtnHtml}
                ${testBtn}
                ${prUrl ? `<a href="${prUrl}" target="_blank" class="dc-pr-btn dc-pr-btn-preview" style="text-decoration:none">View on GitHub</a>` : ''}
                ${session?.status === 'active' ? `<button class="dc-pr-btn dc-pr-btn-promote" onclick="DevChat.promotePR()">Propose to group</button>` : ''}
                ${cardStatusHtml}
              </div>
              ${previewNote}
            </div>`;
        }
        const sTs = msg.created_at ? new Date(msg.created_at).getTime() : '';
        const sId = msg.id || msg._slug || '';
        // While `_active`, show a CSS arc spinner (clearly rotating, unlike
        // the near-symmetric gear glyph). Once done, swap to a check mark
        // so the user can see at a glance which steps have completed.
        const iconHtml = msg._active
          ? '<span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>'
          : '<span class="dc-status-icon dc-status-check" aria-hidden="true">&#10003;</span>';

        const sumClass = 'dc-status-line dc-cc-attached-summary';
        const chevron = '<span class="dc-cc-attached-chevron" aria-hidden="true"></span>';
        const tsSpan = `<span style="font-size:9px;opacity:0.4;margin-left:auto">${sId} ${sTs}</span>`;
        // #50: live elapsed ticker while `_active`, static "(took …)" once
        // the step finishes (server durationMs or client-side freeze).
        const elapsedHtml = DevChat._statusElapsedHtml(msg);

        // Attached live progress log? Render the status line as the
        // <summary> of an open-by-default <details>, with the
        // streaming log block inline below. No box, slightly muted
        // monospaced text — clicking the summary collapses the log
        // (preserved across renders via _applyDetailsPersistence).
        const attachedProgress = progressByStatus.get(msg);
        if (attachedProgress) {
          const logText = (attachedProgress.progressLog || []).join('\n')
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const outerPid = DevChat._detailsId(msg, 'ccrun');
          // Inner pre keeps the legacy progress pid so
          // _patchProgressDom() can target it directly when streaming
          // appends new lines mid-run.
          const innerPid = DevChat._detailsId(attachedProgress, 'progress');
          // #50: live activity snippet + step counter, visible even when
          // the log is collapsed. The spans render unconditionally (even
          // empty) so _patchProgressSummary can patch them in place as
          // lines stream in.
          const summ = typeof summarizeCcProgress === 'function'
            ? summarizeCcProgress(attachedProgress.progressLog || [])
            : { currentLabel: '', steps: 0 };
          const currentSpan = `<span class="dc-cc-current">${summ.currentLabel ? `— ${escapeHtml(summ.currentLabel)}` : ''}</span>`;
          const stepsSpan = `<span class="dc-cc-steps">${summ.steps ? `· ${summ.steps} steps` : ''}</span>`;
          // Experimental AI progress estimate: rendered unconditionally
          // (even empty) so _applyEstimate can patch it in place; only
          // populated while the server emits cc_estimate for this run.
          // #359: the remaining-time portion is a live count-down child span
          // (data-countdown-to) the shared ticker decrements; the phrase stays
          // plain escaped text. Empty when there's no numeric guess.
          const estimateSpan = `<span class="dc-cc-estimate" title="Experimental: a small AI model's rough guess from the progress log. May be wrong.">${msg._estimate ? `· ✦ AI guess: ${escapeHtml(msg._estimate)}${DevChat._countdownSpanHtml(msg._countdownTo)}` : ''}</span>`;
          return `<details class="dc-cc-attached" data-persist-id="${outerPid}" data-default-open="1" open><summary class="${sumClass}">${iconHtml} ${msg.content}${currentSpan}${stepsSpan}${estimateSpan}${elapsedHtml}${chevron}${tsSpan}</summary><pre class="dc-cc-attached-log" data-persist-id="${innerPid}">${logText}</pre></details>`;
        }

        // Post-turn ccOutput (the markdown summary that the worker
        // emits when the run finishes — typically attached to a
        // "Claude Code finished" status line). Same merged shape as
        // the live-progress case: status line is the <summary>,
        // markdown body inline below in muted text. We use a
        // dedicated body class because the content is rendered
        // markdown HTML, not a monospaced log dump — different font
        // and indentation than .dc-cc-attached-log.
        if (msg.ccOutput) {
          const outerPid = DevChat._detailsId(msg, 'ccout');
          return `<details class="dc-cc-attached" data-persist-id="${outerPid}" data-default-open="1" open><summary class="${sumClass}">${iconHtml} ${msg.content}${elapsedHtml}${chevron}${tsSpan}</summary><div class="dc-cc-attached-md">${DevChat.renderMarkdown(msg.ccOutput)}</div></details>`;
        }

        return `<div class="dc-status-line">${iconHtml} ${msg.content} ${elapsedHtml}${tsSpan}</div>`;
      }

      // Skip truly empty assistant placeholders that exist only as the
      // streaming-target before any tokens arrived. Once content is present
      // (even if just a [CHAT_ONLY] marker with no body) we always render so
      // the user can see the reasoning collapsible.
      if (msg.role === 'assistant' && !msg.content) return '';

      const isUser = msg.role === 'user';
      const isCCOutput = (msg.model || '').startsWith('claude-code/');
      const costLabel = msg.costCents ? ` · $${(msg.costCents).toFixed(3)}` : '';
      const ts = msg.created_at ? new Date(msg.created_at).getTime() : '';
      const idLabel = msg.id ? `#${msg.id}` : '';
      const rawContent = msg.content || '';
      const hadChatOnly = /^\[CHAT_ONLY\]/i.test(rawContent);
      const content = rawContent.replace(/^\[CHAT_ONLY\]\s*/i, '');
      const displayContent = content.trim()
        ? DevChat.renderMarkdown(content)
        : `<span style="color:var(--text-muted);font-style:italic">(no visible reply — see reasoning below)</span>`;
      // For any assistant message that carried a [CHAT_ONLY] tag, surface the
      // raw output in a collapsible so nothing is ever invisibly swallowed.
      const reasoningDetail = hadChatOnly
        ? `<details class="dc-cc-log" style="margin-top:6px" data-persist-id="${DevChat._detailsId(msg, 'mayorraw')}"><summary class="dc-cc-log-toggle">Mayor reasoning (raw)</summary><pre class="dc-cc-log-content">${rawContent.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre></details>`
        : '';

      if (isCCOutput) {
        // Extract summary (first line or paragraph) vs full details
        const lines = content.replace(/^\*\*Claude Code output:\*\*\n?/i, '').trim();
        const firstPara = lines.split('\n\n')[0] || lines.split('\n')[0];
        const hasMore = lines.length > firstPara.length + 10;
        return `
          <div class="dc-msg dc-msg-assistant">
            <div class="dc-msg-header">
              <span class="text-emerald-400">Claude Code</span>
              <span style="color:var(--text-muted);font-size:9px;opacity:0.5">${idLabel} ${ts}</span>
            </div>
            <div class="dc-msg-content">${DevChat.renderMarkdown(firstPara)}</div>
            ${hasMore ? `<details class="dc-cc-log" style="margin-top:6px" data-persist-id="${DevChat._detailsId(msg, 'ccfull')}"><summary class="dc-cc-log-toggle">Full output</summary><div class="dc-msg-content" style="padding:8px 10px">${DevChat.renderMarkdown(lines)}</div></details>` : ''}
          </div>`;
      }

      // Q/A chips (#32): only on the latest assistant message of an
      // interactive session. Rendered even mid-stream (the 'done' event
      // re-renders before isStreaming flips, so gating on it here would
      // hide the chips forever) — taps are guarded by isStreaming in the
      // click handlers instead.
      const qaChips = (!isUser
        && msgIdx === qaLastConvoIdx
        && qaInteractive
        && Array.isArray(msg.suggestions) && msg.suggestions.length)
        ? DevChat._qaChipsHtml(msg)
        : '';

      return `
        <div class="dc-msg ${isUser ? 'dc-msg-user' : 'dc-msg-assistant'}">
          <div class="dc-msg-header">
            <span class="${isUser ? 'text-violet-400' : 'text-emerald-400'}">${isUser ? 'You' : 'AI'}</span>
            ${msg.model ? `<span style="color:var(--text-muted)">${msg.model.split('-').slice(0, 2).join('-')}${costLabel}</span>` : ''}
            <span style="color:var(--text-muted);font-size:9px;opacity:0.5">${idLabel} ${ts}</span>
          </div>
          <div class="dc-msg-content">${isUser ? DevChat.renderMarkdown(content) : displayContent}</div>
          ${isUser ? DevChat._attachmentsRowHtml(msg) : ''}
          ${isUser ? '' : reasoningDetail}
          ${qaChips}
        </div>`;
    }).join('');

    DevChat._applyDetailsPersistence();
    // #50: start/stop the shared elapsed ticker based on whether this
    // render left any active status line in the DOM.
    DevChat._syncElapsedTicker();
    // #285: keep the quick-reply pill bar in sync with the latest message
    // (it clears once a sent user row becomes the last message).
    DevChat._renderQuickReplies();
  },

  // ── Q/A mode: suggested-answer chips (#32) ─────────────────
  //
  // `suggestions` is [{ question, answers }] — sanitized server-side
  // (the Mayor's suggest_answers tool) and persisted as
  // metadata.suggestions on the assistant row. Single question: tapping
  // a chip sends that answer immediately. Multiple questions: taps
  // select one answer per group (held in _qaSelection, keyed by group
  // index) and "Send answers" / "Use the suggested defaults" compose a
  // numbered reply. The textarea stays usable throughout — chips are a
  // shortcut, never a constraint.

  _qaSelection: {},

  _qaChipsHtml(msg) {
    const groups = msg.suggestions;
    const multi = groups.length > 1;
    const groupsHtml = groups.map((g, gi) => {
      const chips = (g.answers || []).map((a, ai) => {
        const selected = multi && DevChat._qaSelection[gi] === ai;
        const cls = `dc-qa-chip${ai === 0 ? ' dc-qa-chip-default' : ''}${selected ? ' dc-qa-chip-selected' : ''}`;
        const hint = ai === 0 ? '<span class="dc-qa-chip-hint">suggested</span>' : '';
        return `<button type="button" class="${cls}" data-qa-group="${gi}" data-qa-answer="${ai}">${escapeHtml(a)}${hint}</button>`;
      }).join('');
      const label = multi && g.question
        ? `<div class="dc-qa-group-label">${escapeHtml(g.question)}</div>`
        : '';
      return `<div class="dc-qa-group">${label}<div class="dc-qa-chip-row">${chips}</div></div>`;
    }).join('');
    const actions = multi
      ? `<div class="dc-qa-actions">
          <button type="button" class="dc-qa-send" data-qa-send="1">Send answers</button>
          <button type="button" class="dc-qa-defaults" data-qa-defaults="1">Use the suggested defaults</button>
        </div>`
      : '';
    return `<div class="dc-qa-chips">${groupsHtml}${actions}</div>`;
  },

  // The chips on screen always belong to the last non-system message
  // (renderMessages gates rendering to exactly that row), so handlers
  // resolve the suggestion groups from it rather than trusting the DOM.
  _qaCurrentGroups() {
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      const m = DevChat.messages[i];
      if (m.role === 'system') continue;
      return (m.role === 'assistant' && Array.isArray(m.suggestions) && m.suggestions.length)
        ? m.suggestions
        : null;
    }
    return null;
  },

  _onQaChipClick(chip) {
    if (DevChat.isStreaming) return;
    const groups = DevChat._qaCurrentGroups();
    if (!groups) return;
    const gi = parseInt(chip.dataset.qaGroup, 10);
    const ai = parseInt(chip.dataset.qaAnswer, 10);
    const answer = groups[gi]?.answers?.[ai];
    if (answer == null) return;
    if (groups.length === 1) {
      DevChat.sendMessage(answer);
      return;
    }
    // Multi-question: toggle this group's selection; sending happens via
    // the "Send answers" / defaults buttons.
    if (DevChat._qaSelection[gi] === ai) delete DevChat._qaSelection[gi];
    else DevChat._qaSelection[gi] = ai;
    DevChat.renderMessages();
  },

  _qaSendSelected() {
    if (DevChat.isStreaming) return;
    const groups = DevChat._qaCurrentGroups();
    if (!groups) return;
    const parts = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const ai = DevChat._qaSelection[gi];
      const answer = ai != null ? groups[gi]?.answers?.[ai] : null;
      if (answer != null) parts.push(`${gi + 1}. ${answer}`);
    }
    if (!parts.length) return;
    DevChat.sendMessage(parts.join('\n'));
  },

  _qaSendDefaults() {
    if (DevChat.isStreaming) return;
    const groups = DevChat._qaCurrentGroups();
    if (!groups) return;
    DevChat.sendMessage(groups.map((g, gi) => `${gi + 1}. ${g.answers[0]}`).join('\n'));
  },

  // ── Quick-reply pills (#285) ───────────────────────────────
  //
  // A row of tappable pills ABOVE the composer suggesting the user's likely
  // next message. The Mayor attaches 2-3 per turn (suggest_replies → SSE
  // 'quick_replies' → metadata.quickReplies). Unlike the #32 answer chips
  // (inline, send-on-tap), tapping a pill PREFILLS the text box — editable,
  // never auto-send. The bar renders from the LATEST assistant message's
  // quickReplies, so it clears the moment the user sends (a new user row
  // becomes last) and refreshes when the next turn's pills arrive.

  // Generic starter pills for a brand-new session that has no Mayor reply
  // yet — keeps the affordance present from the first screen.
  STARTER_QUICK_REPLIES: [
    'Change the colors',
    'Add a new feature',
    'Fix something that\'s broken',
  ],

  // Resolve the pills to show: the latest non-system message's quickReplies
  // when it's an interactive assistant turn, the starter set on a fresh
  // session, or null (hide the bar) otherwise. Hidden entirely while a turn
  // is streaming so the user never taps a stale suggestion.
  _currentQuickReplies() {
    const session = DevChat.currentSession;
    if (!session) return null;
    if (DevChat.isStreaming) return null;
    const interactive = session.status === 'active' || session.status === 'promoted';
    if (!interactive) return null;
    // Latest non-system message.
    let last = null;
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      if (DevChat.messages[i].role !== 'system') { last = DevChat.messages[i]; break; }
    }
    if (!last) return DevChat.STARTER_QUICK_REPLIES;
    if (last.role === 'assistant' && Array.isArray(last.quickReplies) && last.quickReplies.length) {
      return last.quickReplies;
    }
    return null;
  },

  _renderQuickReplies() {
    const bar = document.getElementById('dc-quick-replies');
    if (!bar) return;
    const replies = DevChat._currentQuickReplies();
    if (!replies || !replies.length) {
      bar.innerHTML = '';
      bar.classList.remove('dc-quick-replies-active');
      return;
    }
    bar.innerHTML = replies.map((r, i) =>
      `<button type="button" class="dc-quick-pill" data-quick-reply-idx="${i}">${escapeHtml(r)}</button>`
    ).join('');
    bar.classList.add('dc-quick-replies-active');
  },

  // Bind the pill-bar click delegation once per renderChatView (the bar
  // element is recreated on every session re-render, like #dc-messages).
  _wireQuickReplies() {
    const bar = document.getElementById('dc-quick-replies');
    if (!bar || bar._qrWired) return;
    bar._qrWired = true;
    bar.addEventListener('click', (e) => {
      const pill = e.target.closest('[data-quick-reply-idx]');
      if (!pill) return;
      DevChat._onQuickReplyClick(pill);
    });
  },

  // True when the device's PRIMARY pointer is coarse (finger) — i.e. a
  // phone/tablet, where focusing a text input pops the on-screen keyboard.
  // A desktop with a touchscreen still reports a fine primary pointer, so
  // it keeps desktop behavior. maxTouchPoints is the fallback for engines
  // without matchMedia.
  _isCoarsePointer() {
    try {
      if (window.matchMedia) return window.matchMedia('(pointer: coarse)').matches;
    } catch {}
    return (navigator.maxTouchPoints || 0) > 0;
  },

  // Tap = PREFILL the composer (never send). Overwrites the box since pills
  // are complete messages, re-runs the auto-resize, and persists the draft
  // so a tab switch keeps it. On desktop it also focuses with the cursor
  // parked at the end; on touch devices it deliberately does NOT focus —
  // focusing would pop the on-screen keyboard over the chat (#568), and the
  // pill already filled the box.
  _onQuickReplyClick(pill) {
    const idx = parseInt(pill.dataset.quickReplyIdx, 10);
    const replies = DevChat._currentQuickReplies();
    const text = replies && replies[idx];
    if (text == null) return;
    const input = document.getElementById('dc-input');
    if (!input) return;
    input.value = text;
    if (!DevChat._isCoarsePointer()) {
      input.focus();
      try { input.setSelectionRange(text.length, text.length); } catch {}
    }
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    if (DevChat.currentSession) DevChat._setDraft(DevChat.currentSession.id, text);
  },

  // ── <details> open/closed persistence ─────────────────────
  //
  // renderMessages() blows away the DOM on every re-render, so native <details>
  // elements forget their open state. We tag each one with a stable
  // data-persist-id (scoped per-session) and round-trip its open flag through
  // localStorage so refreshing / tab-switching preserves what the user had
  // expanded (e.g. "Full Claude Code output").

  _DETAILS_KEY_PREFIX: 'dc-details-v1:',

  _detailsId(msg, kind) {
    const base = msg.id || msg._slug || (msg.created_at ? new Date(msg.created_at).getTime() : '');
    return `${base}:${kind}`;
  },

  _readDetailsState(sessionId) {
    try { return JSON.parse(localStorage.getItem(DevChat._DETAILS_KEY_PREFIX + sessionId) || '{}'); }
    catch { return {}; }
  },

  _writeDetailsState(sessionId, state) {
    try { localStorage.setItem(DevChat._DETAILS_KEY_PREFIX + sessionId, JSON.stringify(state)); }
    catch {}
  },

  _applyDetailsPersistence() {
    const sid = DevChat.currentSession?.id;
    if (!sid) return;
    const state = DevChat._readDetailsState(sid);
    document.querySelectorAll('#dc-messages [data-persist-id]').forEach((el) => {
      // The persistence layer applies to <details> only — the inner
      // <pre> we tag with a persist-id (so live progress updates can
      // find it) isn't a disclosure widget and has no toggle event.
      if (el.tagName !== 'DETAILS') return;
      const key = el.dataset.persistId;
      const defaultOpen = el.dataset.defaultOpen === '1';
      // Storage convention:
      //   state[key] === 1 → user explicitly opened a default-closed widget
      //   state[key] === 0 → user explicitly closed a default-open widget
      //   missing          → use the widget's default
      if (state[key] === 1) el.open = true;
      else if (state[key] === 0) el.open = false;
      else el.open = defaultOpen;
      el.addEventListener('toggle', () => {
        const s = DevChat._readDetailsState(sid);
        if (el.open === defaultOpen) {
          delete s[key]; // back to default — drop the override
        } else {
          s[key] = el.open ? 1 : 0;
        }
        DevChat._writeDetailsState(sid, s);
      });
    });
  },

  // Render markdown to sanitized HTML.
  //   opts.breaks — when true (default) soft single newlines become <br>
  //     (desirable for chat). Spec surfaces pass { breaks: false } so a
  //     prose spec keeps standard markdown paragraph semantics instead of
  //     getting a <br> on every wrapped line (F5).
  renderMarkdown(text, opts = {}) {
    if (!text) return '';

    const breaks = opts.breaks !== undefined ? opts.breaks : true;

    // F7: if the markdown libs failed to load (CDN blocked, SRI mismatch,
    // offline native shell), don't flatten the doc into <br>-joined text —
    // that hides fences and headings and reads exactly like "markdown is
    // broken". Show the raw source in a <pre> (whitespace + fences intact)
    // behind a small notice so the degradation is obvious and diagnosable.
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<div class="dc-md-fallback-notice">Rich text formatting is unavailable right now — showing raw markdown.</div>`
        + `<pre class="dc-md-fallback">${escaped}</pre>`;
    }

    if (!DevChat._markdownReady) {
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      marked.use({
        breaks: true,
        gfm: true,
        renderer: {
          code({ text, lang, escaped }) {
            let language = lang || '';
            let filepath = '';
            if (language.includes(':')) {
              const i = language.indexOf(':');
              filepath = language.slice(i + 1);
              language = language.slice(0, i);
            }
            const safe = escaped ? text : esc(text);
            const header = filepath
              ? `<div class="dc-code-header">${esc(filepath)}</div>`
              : (language ? `<div class="dc-code-header">${esc(language)}</div>` : '');
            return `${header}<pre class="dc-code-block"><code>${safe}</code></pre>`;
          },
          codespan({ text }) {
            return `<code class="dc-inline-code">${esc(text)}</code>`;
          },
          html({ text }) {
            return esc(text);
          },
          // F3: real heading hierarchy. # → h3 (largest), ## → h4,
          // ### and deeper → h5, so a spec's title, sections and
          // subsections are visually distinct instead of all collapsing
          // into one or two levels.
          heading({ tokens, depth }) {
            const inner = this.parser.parseInline(tokens);
            const tag = depth === 1 ? 'h3' : depth === 2 ? 'h4' : 'h5';
            const cls = depth === 1 ? 'dc-h3' : depth === 2 ? 'dc-h4' : 'dc-h5';
            return `<${tag} class="${cls}">${inner}</${tag}>`;
          },
          blockquote({ tokens }) {
            const body = this.parser.parse(tokens);
            return `<div class="dc-blockquote">${body}</div>`;
          },
          list(token) {
            const { ordered, start, items } = token;
            const tag = ordered ? 'ol' : 'ul';
            const cls = ordered ? 'dc-ol' : 'dc-ul';
            const startAttr = ordered && start !== 1 && start !== '' ? ` start="${start}"` : '';
            let body = '';
            for (const item of items) {
              body += this.listitem(item);
            }
            return `<${tag} class="${cls}"${startAttr}>${body}</${tag}>`;
          },
          // F4: GFM task items. marked's default emits an <input
          // type=checkbox>, which DOMPurify strips (input isn't allowed),
          // leaving a bare bullet. Render a non-interactive span marker
          // instead so checklists in specs keep their ☐ / ✓ state.
          listitem(item) {
            const body = this.parser.parse(item.tokens, !!item.loose);
            if (item.task) {
              const mark = item.checked
                ? '<span class="dc-task-check dc-task-checked" aria-hidden="true">&#10003;</span> '
                : '<span class="dc-task-check" aria-hidden="true">&#9744;</span> ';
              return `<li class="dc-task-item">${mark}${body}</li>`;
            }
            return `<li>${body}</li>`;
          },
          // F1: tag the table with dc-table so it can be styled globally
          // (the old .dc-msg-content table rules never reached the spec
          // viewer or preview snippet). Alignment attributes are
          // intentionally dropped — DOMPurify strips them anyway — so cells
          // left-align by default.
          table(token) {
            let header = '';
            for (const cell of token.header) header += this.tablecell(cell);
            let body = '';
            for (const row of token.rows) {
              let rowHtml = '';
              for (const cell of row) rowHtml += this.tablecell(cell);
              body += this.tablerow({ text: rowHtml });
            }
            return `<table class="dc-table"><thead>${this.tablerow({ text: header })}</thead>`
              + `${body ? `<tbody>${body}</tbody>` : ''}</table>`;
          },
          paragraph({ tokens }) {
            return `<p class="dc-p">${this.parser.parseInline(tokens)}</p>`;
          },
          link({ href, title, tokens }) {
            const inner = this.parser.parseInline(tokens);
            if (!/^https?:\/\//i.test(href)) return inner;
            return `<a href="${href}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
          },
          image({ href, title, text }) {
            const safeText = esc(text || '');
            if (!/^https?:\/\//i.test(href)) return safeText;
            return `<a href="${href}" target="_blank" rel="noopener noreferrer">${safeText || esc(href)}</a>`;
          },
        },
      });

      DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A') {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
          const href = node.getAttribute('href') || '';
          if (href && !/^https?:\/\//i.test(href)) {
            node.removeAttribute('href');
          }
        }
      });

      DevChat._markdownReady = true;
    }

    // breaks is overridden per-call (the global default set above is true);
    // the registered renderers persist regardless of the per-parse options.
    const html = marked.parse(text, { breaks });

    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['a', 'b', 'strong', 'i', 'em', 'code', 'pre', 'h3', 'h4', 'h5',
        'p', 'br', 'ol', 'ul', 'li', 'div', 'span', 'table', 'thead', 'tbody',
        'tr', 'th', 'td', 'hr', 'del'],
      // 'start' keeps non-1 ordered lists numbering correctly (F2).
      ALLOWED_ATTR: ['class', 'href', 'target', 'rel', 'start'],
      ALLOW_DATA_ATTR: false,
    });
  },

  // Stabilized updater for the LIVE streaming assistant bubble. Replaces the
  // old per-token `el.innerHTML = renderMarkdown(partialContent)` with three
  // anti-flicker behaviours (see the proposal/dev-session spec):
  //   • Holds back the trailing incomplete line — only the completed portion
  //     is parsed as markdown, the in-progress final line is appended as
  //     escaped plaintext. A `- [ ]` fragment never momentarily renders as a
  //     checkbox; the row appears once, when its line is finished.
  //   • Throttles DOM writes to one paint per animation frame, so rows above
  //     the cursor don't redraw on every token.
  //   • Swaps idempotently — the rendered HTML is cached on the element and
  //     the innerHTML assignment is skipped when it hasn't changed.
  // `el` is the .dc-msg-content node; `fullText` is the full display content
  // so far; `opts.breaks` honours the caller's chat-vs-spec line-break mode.
  _renderStreamingMarkdown(el, fullText, opts = {}) {
    if (!el) return;
    el._streamPending = { fullText, breaks: opts.breaks !== false };
    DevChat._streamEl = el;
    if (el._streamRaf != null) return; // a flush is already scheduled
    const flush = () => {
      el._streamRaf = null;
      const pend = el._streamPending;
      if (!pend) return;
      el._streamPending = null;
      DevChat._writeStreamingHtml(el, pend.fullText, pend.breaks, false);
    };
    if (typeof requestAnimationFrame === 'function') {
      el._streamRaf = requestAnimationFrame(flush);
      el._streamRafKind = 'raf';
    } else {
      el._streamRaf = setTimeout(flush, 16);
      el._streamRafKind = 'timeout';
    }
  },

  // Compute the bubble HTML (held-back tail unless `final`) and assign it
  // only when it differs from the last write, eliminating redundant node
  // churn. `final` renders the FULL content with no held-back line so a
  // finished bubble is byte-exact.
  _writeStreamingHtml(el, fullText, breaks, final) {
    let html;
    if (final) {
      html = fullText ? DevChat.renderMarkdown(fullText, { breaks }) : '';
    } else if (typeof renderStreamingHtml === 'function') {
      html = renderStreamingHtml(
        fullText,
        (md) => DevChat.renderMarkdown(md, { breaks }),
        escapeHtml
      );
    } else {
      // Helper script failed to load — degrade to the plain full render.
      html = DevChat.renderMarkdown(fullText, { breaks });
    }
    if (el._streamHtml === html) return;
    el._streamHtml = html;
    el.innerHTML = html;
  },

  // Flush any pending throttled render and re-render the active streaming
  // bubble with its FULL final content (no held-back line). Called on
  // done / stopped / assistant_message_end / _finishStreaming so the sealed
  // bubble is exact even if a frame was still queued.
  _flushStreamingFinal() {
    const el = DevChat._streamEl;
    if (!el) return;
    DevChat._streamEl = null;
    if (el._streamRaf != null) {
      if (el._streamRafKind === 'raf' && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(el._streamRaf);
      } else {
        clearTimeout(el._streamRaf);
      }
      el._streamRaf = null;
    }
    const pend = el._streamPending;
    el._streamPending = null;
    if (pend) DevChat._writeStreamingHtml(el, pend.fullText, pend.breaks, true);
  },

  _lockedToBottom: true,
  // Per-session scroll memory so that leaving the dev-chat tab and coming
  // back lands the user where they left off. Keyed by session id; each
  // entry is `{ scrollTop, lockedToBottom }`. `lockedToBottom === true`
  // means "keep following the conversation" (restore to bottom on return
  // regardless of saved scrollTop).
  _savedScrollBySession: {},

  initScrollTracking() {
    const container = document.getElementById('dc-messages');
    if (!container) return;

    // Click delegation for inline spec preview cards. We rebind on
    // every renderChatView re-render (since #dc-messages itself is
    // recreated when the user navigates between sessions), so a single
    // listener here is enough — innerHTML rewrites inside renderMessages
    // don't break it.
    container.addEventListener('click', (e) => {
      // Q/A chips (#32) — delegated like the spec cards, so innerHTML
      // rewrites inside renderMessages don't drop the handlers.
      const chip = e.target.closest('[data-qa-group]');
      if (chip) { DevChat._onQaChipClick(chip); return; }
      if (e.target.closest('[data-qa-send]')) { DevChat._qaSendSelected(); return; }
      if (e.target.closest('[data-qa-defaults]')) { DevChat._qaSendDefaults(); return; }
      const card = e.target.closest('.dc-spec-preview-card');
      if (!card) return;
      const version = card.dataset.specVersion;
      DevChat.openSpecViewer(version);
    });
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.dc-spec-preview-card');
      if (!card) return;
      e.preventDefault();
      DevChat.openSpecViewer(card.dataset.specVersion);
    });

    container.addEventListener('scroll', () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
      DevChat._lockedToBottom = atBottom;
      if (DevChat.currentSession) {
        DevChat._savedScrollBySession[DevChat.currentSession.id] = {
          scrollTop: container.scrollTop,
          lockedToBottom: atBottom,
        };
      }
    });
    // Watch for DOM changes (collapsibles expanding, new content) and auto-scroll
    const observer = new MutationObserver(() => {
      if (DevChat._lockedToBottom) {
        requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
      }
    });
    observer.observe(container, { childList: true, subtree: true, attributes: true });
  },

  // Apply a previously saved scroll position for the current session, if
  // any. Falls back to scrolling to the bottom (which is the desired
  // behavior on first entry into a session).
  //
  // We use scrollTo({ behavior: 'instant' }) rather than assigning
  // .scrollTop directly because .dc-messages-container has CSS
  // `scroll-behavior: smooth` set (so streaming messages glide nicely).
  // That CSS rule applies to .scrollTop assignments too, which would
  // otherwise turn the tab-switch restore into a multi-second animated
  // scroll from 0 → scrollHeight. 'instant' overrides the CSS just for
  // this one programmatic jump.
  restoreSessionScroll() {
    const container = document.getElementById('dc-messages');
    if (!container) return;
    const saved = DevChat.currentSession
      ? DevChat._savedScrollBySession[DevChat.currentSession.id]
      : null;
    if (saved && !saved.lockedToBottom) {
      container.scrollTo({ top: saved.scrollTop, behavior: 'instant' });
      DevChat._lockedToBottom = false;
    } else {
      container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
      DevChat._lockedToBottom = true;
    }
  },

  scrollToBottom(force) {
    const container = document.getElementById('dc-messages');
    if (!container) return;
    if (force || DevChat._lockedToBottom) {
      requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
    }
  },

  // ── Session list ──────────────────────────────────────────

  renderSessionList() {
    const container = document.getElementById('dc-session-list');
    if (!container) return;

    if (DevChat.sessions.length === 0) {
      container.innerHTML = `
        <div class="text-center px-6 py-12">
          <p class="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Want to change this app? Just ask.</p>
          <p class="text-xs text-zinc-500 dark:text-zinc-400 mb-3 max-w-xs mx-auto">
            Describe what you'd like different in plain English — an AI writes the code and opens a
            real pull request. No coding required. The app's users then vote it in.
          </p>
          <p class="text-xs text-zinc-500 dark:text-zinc-500">
            Hit <span class="font-medium text-emerald-600 dark:text-emerald-400">+ New Session</span>
            above to start, e.g. <span class="italic">"make the header dark blue"</span>.
          </p>
        </div>`;
      return;
    }

    container.innerHTML = DevChat.sessions.map((s) => {
      const statusColor =
        s.status === 'active' ? 'text-emerald-400' :
        s.status === 'promoted' ? 'text-violet-400' :
        s.status === 'paused' ? 'text-zinc-400' :
        'text-zinc-500';
      // Promoted sessions can't be demoted to 'paused' (their PR must
      // stay votable), but a warm worker can still be freed — same
      // endpoint, server keeps status 'promoted' (keptPromoted). Once
      // the worker is gone (`warm` false) there's nothing left to free,
      // so no button.
      const isPausable = s.status === 'active';
      const isFreeable = s.status === 'promoted' && s.warm;
      const isPaused = s.status === 'paused';
      const isArchived = s.status === 'archived';
      const isActionable = isPausable || isFreeable || isPaused;
      // Archive is gated independently of isActionable: the backend
      // archives any open session (active/promoted/paused) regardless of
      // warm state, so a cold promoted proposal must keep its Archive
      // button even though it has nothing left to Free. (Re-coupling this
      // to isActionable is the regression this restores.)
      const isArchivable = s.status === 'active' || s.status === 'promoted' || s.status === 'paused';
      const date = new Date(s.created_at).toLocaleDateString();
      return `
        <div class="dc-session-item px-3 py-2 cursor-pointer hover:bg-zinc-800/50 flex items-center gap-2" data-id="${s.id}">
          <span class="text-xs ${statusColor} font-mono">${s.status}</span>
          <span class="text-sm text-zinc-300 flex-1 truncate" title="${escapeHtml(s.branch_name || '')}">${escapeHtml(s.session_title || s.pr_title || s.branch_name || 'Session')}</span>
          ${s.pr_url ? `<a href="${s.pr_url}" target="_blank" class="text-xs text-violet-400 hover:text-violet-300" onclick="event.stopPropagation()">PR#${s.pr_number}</a>` : ''}
          ${isPausable ? `<button class="dc-pause-btn text-xs text-zinc-400 hover:text-emerald-400" data-id="${s.id}" data-action="pause" onclick="event.stopPropagation()">Pause</button>` : ''}
          ${isFreeable ? `<button class="dc-pause-btn text-xs text-zinc-400 hover:text-emerald-400" data-id="${s.id}" data-action="pause" data-freeing="1" title="Frees the AI worker. The PR stays up for voting." onclick="event.stopPropagation()">Free worker</button>` : ''}
          ${isPaused ? `<button class="dc-pause-btn text-xs text-emerald-400 hover:text-emerald-300" data-id="${s.id}" data-action="resume" onclick="event.stopPropagation()">Resume</button>` : ''}
          ${isArchived ? `<button class="dc-unarchive-btn text-xs text-emerald-400 hover:text-emerald-300" data-id="${s.id}" onclick="event.stopPropagation()" title="Restore this session (reopens the PR)">Unarchive</button>` : ''}
          ${isArchivable ? `<button class="dc-archive-btn text-xs text-zinc-500 hover:text-red-400" data-id="${s.id}" data-name="${escapeHtml(s.session_title || s.pr_title || s.branch_name || 'Session')}" title="Archive (frees the slot; restorable for a while)" onclick="event.stopPropagation()">Archive</button>` : ''}
          <span class="text-xs text-zinc-600">${date}</span>
        </div>`;
    }).join('');

    container.querySelectorAll('.dc-session-item').forEach((el) => {
      el.addEventListener('click', async () => {
        await DevChat.openSession(parseInt(el.dataset.id));
        DevChat.renderChatView();
        App.updateHash();
      });
    });

    // Pause / Free-worker / Resume buttons. All share the .dc-pause-btn
    // class and dispatch via data-action so we don't have near-identical
    // handlers ("Free worker" is the pause endpoint hitting a promoted
    // session — the server frees the worker and answers keptPromoted).
    // On 4xx (e.g. cap reached on resume), surface the server's error
    // message rather than silently failing.
    container.querySelectorAll('.dc-pause-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        const freeing = !!btn.dataset.freeing;
        const original = btn.textContent;
        btn.textContent = action === 'pause' ? (freeing ? 'Freeing…' : 'Pausing…') : 'Resuming…';
        btn.disabled = true;
        let body = {};
        try {
          const resp = await fetch(`/api/sessions/${id}/${action}`, { method: 'POST' });
          body = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            alert(body.error || `Failed to ${action} session`);
            btn.textContent = original;
            btn.disabled = false;
            return;
          }
          const data = await resp.json().catch(() => ({}));
          // The row will re-render without the button (warm flips false),
          // so flash the outcome here where the user just clicked.
          if (data.keptPromoted) btn.textContent = 'Worker freed';
        } catch {
          btn.textContent = original;
          btn.disabled = false;
          return;
        }
        // Same deliberate-pause sync as the cross-app panel (#193): keep
        // the local currentSession copy honest so the refocus auto-resume
        // doesn't silently re-activate a session the user just paused.
        // keptPromoted = server left the status 'promoted'; don't mislabel.
        if (action === 'pause' && !body.keptPromoted
            && DevChat.currentSession && Number(DevChat.currentSession.id) === Number(id)) {
          DevChat.currentSession.status = 'paused';
        }
        if (AppView.appData) {
          await DevChat.loadSessions(AppView.appData.slug);
          DevChat.renderSessionList();
        }
        await DevChat.loadActiveSessions();
      });
    });

    // Archive. Reversible now: it frees the active-session slot, tears
    // down staging + worker, and closes the PR, but keeps Claude's memory
    // and the branch so Unarchive can restore it (until the retention GC
    // eventually purges memory). Wording reflects that it's recoverable.
    container.querySelectorAll('.dc-archive-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name || 'this session';
        const ok = await ConfirmModal.show({
          title: `Archive "${name}"?`,
          message: "This closes the PR and frees the slot. You can Unarchive it later to restore it (chat memory is kept for 30 days).",
          confirmLabel: 'Archive',
          danger: true,
        });
        if (!ok) return;
        btn.textContent = '...';
        await fetch(`/api/sessions/${btn.dataset.id}/archive`, { method: 'POST' });
        if (AppView.appData) {
          await DevChat.loadSessions(AppView.appData.slug);
          DevChat.renderSessionList();
        }
        await DevChat.loadActiveSessions();
      });
    });

    // Unarchive. Restores an archived session to 'paused' (opening it then
    // auto-resumes) and best-effort reopens its PR. If the retention GC
    // already purged the CC volume, we warn that Claude starts fresh.
    container.querySelectorAll('.dc-unarchive-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const original = btn.textContent;
        btn.textContent = '...';
        btn.disabled = true;
        try {
          const resp = await fetch(`/api/sessions/${btn.dataset.id}/unarchive`, { method: 'POST' });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            alert(data.error || 'Failed to unarchive session');
            btn.textContent = original;
            btn.disabled = false;
            return;
          }
          if (data.ccPurged) {
            alert("Session restored. Note: Claude's memory had already been cleared, so this picks up as a fresh chat on the same branch.");
          }
        } catch {
          btn.textContent = original;
          btn.disabled = false;
          return;
        }
        if (AppView.appData) {
          await DevChat.loadSessions(AppView.appData.slug);
          DevChat.renderSessionList();
        }
        await DevChat.loadActiveSessions();
      });
    });
  },

  // ── Sync-with-main banner (#8, progress #252) ─────────────
  //
  // Shows up below the session header whenever the branch is behind
  // origin/main OR a sync is in flight. Click triggers
  // POST /api/sessions/:id/sync-main, which dispatches a worker turn
  // in MODE=sync. The worker short-circuits when the merge is clean
  // (no LLM spend); only dispatches CC when there are real conflicts
  // to resolve.
  //
  // The behind count is refreshed live via the WS session_update
  // event (action='behind_main'), and the in-flight phase / terminal
  // outcome via action='sync_status'; see App.handleSessionUpdate.
  //
  // _syncState is the server-derived sync indicator (NOT a per-tab
  // flag): null when idle, { sessionId, phase, since } while a sync
  // runs anywhere (this tab, another tab, the resume auto-trigger or
  // the conflict-resolver), and { sessionId, terminal, ok, message }
  // once it finishes. Fed by WS sync_status events, openSession's
  // status check, the poll fallback, and optimistically by the click.
  _syncState: null,
  _syncPollTimer: null,

  _syncPhaseLabel(phase) {
    switch (phase) {
      case 'resolving': return 'Resolving merge conflicts with Claude…';
      case 'pushing': return 'Pushing the merged branch…';
      default: return 'Syncing with main…'; // starting / merging
    }
  },

  // The current _syncState if (and only if) it belongs to the given
  // session — a terminal notice from session A must not render on
  // session B's banner.
  _syncStateFor(session) {
    const st = DevChat._syncState;
    if (!st || !session) return null;
    return Number(st.sessionId) === Number(session.id) ? st : null;
  },

  // #405: the session header's merge-lifecycle pill. Mirrors the canonical
  // state shown on the proposal feed card / home strip so the user no longer
  // has to leave the session to learn where it is — Draft → In vote →
  // Checks running → Behind → Resolving → Passed → Merging… → ✓ Merged. The
  // session payload (GET /api/sessions/:id) carries status / check_state /
  // merge_conflict_state / behind_main, plus yes_count + majority (added for
  // this feature) so the in-vote tally and the "Passed — merging shortly"
  // state resolve exactly as on the feed.
  _renderHeaderStatusPill(session) {
    return `<span id="dc-status-pill">${DevChat._statusPillInnerHtml(session)}</span>`;
  },

  _statusPillInnerHtml(session) {
    if (!session || !(window.MergeStatus && MergeStatus.lifecycle)) return '';
    const life = MergeStatus.lifecycle(session);
    if (!life || !life.label) return '';
    return MergeStatus.pillHtml(life);
  },

  // #405: patch the header pill in place (used while a turn is streaming, so
  // we don't re-render the whole view and disrupt the live message stream).
  _patchHeaderStatusPill() {
    const el = document.getElementById('dc-status-pill');
    if (!el) return;
    el.innerHTML = DevChat._statusPillInnerHtml(DevChat.currentSession);
  },

  // #405: re-read the open session's lifecycle fields after a vote_update /
  // app_version_changed WS event so the header pill + change card advance
  // live (In vote → Passed → Merging… → ✓ Merged) without a manual reload.
  // No-op unless the event pertains to the session currently open. A full
  // re-render repaints the change card too; while a chat turn is streaming
  // we only patch the header pill to avoid disturbing the live stream.
  async refreshCurrentSessionStatus(sessionId) {
    const cur = DevChat.currentSession;
    if (!cur) return;
    if (sessionId != null && Number(sessionId) !== Number(cur.id)) return;
    if (!document.getElementById('dc-view')) return;
    try {
      const res = await fetch(`/api/sessions/${cur.id}`);
      if (!res.ok) return;
      const { session } = await res.json();
      if (!session || !DevChat.currentSession
          || Number(DevChat.currentSession.id) !== Number(session.id)) return;
      // Lifecycle-relevant scalars decide whether anything visible changed;
      // copy them onto the live row either way.
      const watch = ['status', 'check_state', 'merge_conflict_state', 'behind_main',
                     'yes_count', 'no_count', 'majority', 'merged_at'];
      let changed = false;
      for (const k of watch) {
        if (session[k] !== undefined && DevChat.currentSession[k] !== session[k]) changed = true;
        if (session[k] !== undefined) DevChat.currentSession[k] = session[k];
      }
      // Arrays/objects the card reads are refreshed unconditionally.
      if (session.test_results !== undefined) DevChat.currentSession.test_results = session.test_results;
      if (session.conflict_files !== undefined) DevChat.currentSession.conflict_files = session.conflict_files;
      if (!changed) return;
      if (DevChat.isStreaming) DevChat._patchHeaderStatusPill();
      else DevChat.renderChatView();
    } catch { /* network blip — ignore, next event/reload reconciles */ }
  },

  _renderSyncBannerHtml(session) {
    const behind = session && Number(session.behind_main) || 0;
    const sync = DevChat._syncStateFor(session);
    if (behind <= 0 && !sync) return '';

    const warnIcon = `<svg class="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.732 0 2.814-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
        </svg>`;
    const btnCls = 'rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-60 disabled:cursor-not-allowed px-3 py-1 text-xs font-medium text-white transition-colors shrink-0';
    const chatBusy = !!DevChat.isStreaming;
    const busyAttr = chatBusy
      ? 'disabled title="Claude is busy with a turn — sync will be available when it finishes"'
      : '';

    // In flight — spinner + phase text, disabled button.
    if (sync && !sync.terminal) {
      return `
      <div id="dc-sync-banner" class="flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900/50 text-xs">
        <svg class="w-4 h-4 animate-spin text-amber-600 dark:text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
        </svg>
        <span class="text-amber-800 dark:text-amber-200 flex-1">${escapeHtml(DevChat._syncPhaseLabel(sync.phase))}</span>
        <button id="dc-sync-btn" type="button" disabled class="${btnCls}">Syncing…</button>
      </div>`;
    }

    // Terminal success — green confirmation; auto-dismissed by the
    // timer in _setSyncTerminal (the behind_main → 0 broadcast removes
    // the banner anyway).
    if (sync && sync.terminal && sync.ok) {
      return `
      <div id="dc-sync-banner" class="flex items-center gap-2 px-3 py-2 bg-emerald-50 dark:bg-emerald-950/30 border-b border-emerald-200 dark:border-emerald-900/50 text-xs">
        <svg class="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/>
        </svg>
        <span class="text-emerald-800 dark:text-emerald-200 flex-1">${escapeHtml(sync.message || 'Synced with main.')}</span>
      </div>`;
    }

    // Terminal failure (unresolved conflict, budget/infra error, or the
    // 409 chat-turn-busy notice) — the message stays put with a
    // re-enabled Try again button. No alert() popups.
    if (sync && sync.terminal && !sync.ok) {
      return `
      <div id="dc-sync-banner" class="flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900/50 text-xs">
        ${warnIcon}
        <span class="text-amber-800 dark:text-amber-200 flex-1">${escapeHtml(sync.message || 'Sync with main failed.')}</span>
        <button id="dc-sync-btn" type="button" ${busyAttr} class="${btnCls}">Try again</button>
      </div>`;
    }

    // Idle — behind main, nothing in flight.
    const noun = behind === 1 ? 'commit' : 'commits';
    return `
      <div id="dc-sync-banner" class="flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900/50 text-xs">
        ${warnIcon}
        <span class="text-amber-800 dark:text-amber-200 flex-1">
          main has moved <span class="font-semibold">${behind}</span> ${noun} ahead of this branch.
        </span>
        <button id="dc-sync-btn" type="button" ${busyAttr} class="${btnCls}">Sync with main</button>
      </div>`;
  },

  // A session maps to exactly one branch + one PR. Once that PR exists
  // and especially once it's been proposed to the group, continuing to
  // chat here adds MORE changes to the same PR — which bundles unrelated
  // work into one votable unit. Surface a nudge to "Start a new change"
  // (a fresh session) so each PR stays focused. Shown when the session
  // already has a PR and it's past the active-editing stage
  // (promoted / merging / merged). Active sessions with a PR don't get
  // the banner — the user is presumably still refining that change.
  _renderNewChangeBannerHtml(session) {
    if (!session || !session.pr_number) return '';
    const status = session.status;
    if (status !== 'promoted' && status !== 'merging' && status !== 'merged') return '';
    const proposed = status === 'promoted' || status === 'merging';
    const stateLabel = proposed
      ? `proposed to the group (PR #${session.pr_number})`
      : `merged (PR #${session.pr_number})`;
    return `
      <div id="dc-new-change-banner" class="flex items-center gap-2 px-3 py-2 bg-violet-50 dark:bg-violet-950/30 border-b border-violet-200 dark:border-violet-900/50 text-xs">
        <svg class="w-4 h-4 text-violet-600 dark:text-violet-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/>
        </svg>
        <span class="text-violet-800 dark:text-violet-200 flex-1">
          This change has been ${stateLabel}. New work in this chat is added to the same PR — start a new change to keep PRs focused.
        </span>
        <button id="dc-new-change-btn" type="button"
          class="rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-60 disabled:cursor-not-allowed px-3 py-1 text-xs font-medium text-white transition-colors shrink-0">
          Start a new change
        </button>
      </div>`;
  },

  // Spin up a fresh session (new branch → new PR) for the same app and
  // open it. Reuses createSession's per-user 3-active-session cap +
  // error alerting. Intentionally does NOT carry over Claude's memory or
  // the spec — a new change starts clean on its own branch.
  async startNewChange() {
    const slug = (typeof AppView !== 'undefined' && AppView.appData && AppView.appData.slug)
      || (DevChat.currentSession && DevChat.currentSession.app_slug);
    if (!slug) return;
    const btn = document.getElementById('dc-new-change-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
    const session = await DevChat.createSession(slug);
    if (!session) {
      if (btn) { btn.disabled = false; btn.textContent = 'Start a new change'; }
      return;
    }
    await DevChat.openSession(session.id);
    DevChat.renderChatView();
    if (typeof App !== 'undefined' && App.updateHash) App.updateHash();
    if (typeof DevChat.loadActiveSessions === 'function') DevChat.loadActiveSessions();
  },

  // Replace just the banner element if the rest of the chat view is
  // mounted; otherwise full re-render so the new element lands in the
  // right slot. Shared by every path that mutates banner-relevant
  // state (behind_main updates, sync_status events, the click handler).
  _applySyncBanner() {
    const existing = document.getElementById('dc-sync-banner');
    const html = DevChat.currentSession
      ? DevChat._renderSyncBannerHtml(DevChat.currentSession) : '';
    if (existing) {
      if (html) {
        existing.outerHTML = html;
        DevChat._wireSyncBanner();
      } else {
        existing.remove();
      }
    } else if (html) {
      DevChat.renderChatView();
    }
  },

  _setSyncInFlight(sessionId, phase) {
    DevChat._syncState = { sessionId: Number(sessionId), phase, since: Date.now() };
    DevChat._applySyncBanner();
    DevChat._startSyncPolling(Number(sessionId));
  },

  _setSyncTerminal(sessionId, { ok, message }) {
    DevChat._stopSyncPolling();
    const t = {
      sessionId: Number(sessionId),
      terminal: true,
      ok: !!ok,
      message: message || (ok ? 'Synced with main.' : 'Sync with main failed.'),
      since: Date.now(),
    };
    DevChat._syncState = t;
    DevChat._applySyncBanner();
    if (ok) {
      // Success feedback is transient — dismiss after ~5s. Failure
      // sticks around with its Try again button. Identity check so a
      // newer state (e.g. a retry already in flight) is never clobbered.
      setTimeout(() => {
        if (DevChat._syncState === t) {
          DevChat._syncState = null;
          DevChat._applySyncBanner();
        }
      }, 5000);
    }
  },

  // Called by App.handleSessionUpdate when an action='sync_status'
  // event arrives (from this tab's click, another tab, the resume
  // auto-trigger or the conflict-resolver). No-op when the event is
  // for a session that isn't open — list rows are out of scope (#252).
  applySyncStatusUpdate(data) {
    const sessionId = Number(data.sessionId);
    if (!DevChat.currentSession || Number(DevChat.currentSession.id) !== sessionId) return;
    if (data.state === 'done' || data.state === 'failed') {
      DevChat._setSyncTerminal(sessionId, {
        ok: data.state === 'done',
        message: data.message,
      });
      // Refresh so the persisted system note + new behind_main land.
      // Idempotent with the click handler's own refresh.
      DevChat.openSession(sessionId)
        .then(() => DevChat.renderChatView())
        .catch(() => {});
    } else {
      DevChat._setSyncInFlight(sessionId, data.state);
    }
  },

  // Poll fallback while a sync is in flight: catches a missed terminal
  // WS event (tab offline, server restart mid-sync) and keeps the
  // phase text honest if a phase broadcast was dropped. Cleared on any
  // terminal transition and when the open session changes.
  _startSyncPolling(sessionId) {
    if (DevChat._syncPollTimer) return;
    DevChat._syncPollTimer = setInterval(async () => {
      const st = DevChat._syncState;
      if (!st || st.terminal || Number(st.sessionId) !== Number(sessionId)
          || !DevChat.currentSession
          || Number(DevChat.currentSession.id) !== Number(sessionId)) {
        DevChat._stopSyncPolling();
        return;
      }
      try {
        const res = await fetch(`/api/sessions/${sessionId}/status`);
        if (!res.ok) return;
        const { sync } = await res.json();
        if (sync && sync.phase) {
          if (DevChat._syncState && !DevChat._syncState.terminal
              && DevChat._syncState.phase !== sync.phase) {
            DevChat._syncState = { ...DevChat._syncState, phase: sync.phase };
            DevChat._applySyncBanner();
          }
        } else if (Date.now() - st.since > 5000) {
          // No sync in flight server-side — we missed the terminal
          // event. The grace window keeps the optimistic click-state
          // from being cleared before the server registers the run.
          DevChat._stopSyncPolling();
          DevChat._syncState = null;
          await DevChat.openSession(sessionId);
          DevChat.renderChatView();
        }
      } catch {}
    }, 4000);
  },

  _stopSyncPolling() {
    if (DevChat._syncPollTimer) {
      clearInterval(DevChat._syncPollTimer);
      DevChat._syncPollTimer = null;
    }
  },

  _wireSyncBanner() {
    const btn = document.getElementById('dc-sync-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const st = DevChat._syncState;
      if (st && !st.terminal) return; // already in flight
      const sessionId = DevChat.currentSession?.id;
      if (!sessionId) return;
      // Optimistic in-flight state; the WS sync_status events and the
      // poll fallback take over from here. If a sync is already
      // running server-side this POST coalesces onto it and returns
      // the same final result.
      DevChat._setSyncInFlight(sessionId, 'starting');
      try {
        const resp = await fetch(`/api/sessions/${sessionId}/sync-main`, { method: 'POST' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          // 409 = a chat turn holds the worker (friendly message from
          // the route); anything else is a real failure. Either way:
          // inline banner text, never alert().
          DevChat._setSyncTerminal(sessionId, {
            ok: false,
            message: data.error || `Sync failed (HTTP ${resp.status}).`,
          });
        } else {
          // The POST response is the authoritative final result —
          // applied idempotently with the WS terminal event. Refresh
          // the session record so behind_main + the system note pick
          // up the new state even if the tab missed the WS events.
          DevChat._setSyncTerminal(sessionId, {
            ok: data.ok !== false,
            message: data.message,
          });
          await DevChat.openSession(sessionId);
          DevChat.renderChatView();
        }
      } catch (err) {
        DevChat._setSyncTerminal(sessionId, { ok: false, message: `Sync failed: ${err.message}` });
      }
    });
  },

  // Called by App.handleSessionUpdate when an action='behind_main'
  // event arrives. Patches currentSession + re-renders the banner
  // without tearing down the rest of the chat view. No-op if the
  // event is for a different session.
  applyBehindMainUpdate(sessionId, behindMain) {
    if (!DevChat.currentSession || DevChat.currentSession.id !== sessionId) {
      // Update the in-memory sessions cache so a back-to-list click
      // shows the right state without a refetch.
      if (Array.isArray(DevChat.sessions)) {
        const row = DevChat.sessions.find((s) => s.id === sessionId);
        if (row) row.behind_main = behindMain;
      }
      return;
    }
    DevChat.currentSession.behind_main = behindMain;
    DevChat._applySyncBanner();
  },

  // ── Chat view ─────────────────────────────────────────────

  renderChatView() {
    const content = document.getElementById('dc-view');
    if (!content) return;

    // The dev-chat tab's meta strip (Edit shortcuts + sessions header)
    // takes up vertical space we want to reclaim once the user is
    // inside a chat. Hide it on session open; show it again on back.
    // Lookup is best-effort because some test harnesses mount
    // renderChatView without the surrounding tab shell.
    const meta = document.getElementById('dc-meta');

    if (!DevChat.currentSession) {
      if (meta) meta.classList.remove('hidden');
      content.innerHTML = `
        <div id="dc-session-list" class="divide-y divide-zinc-800" style="flex:1;overflow-y:auto;min-height:0"></div>`;
      DevChat.renderSessionList();
      return;
    }

    if (meta) meta.classList.add('hidden');

    const modelOptions = Object.entries(DevChat.MODELS)
      .map(([id, meta]) => {
        const label = (meta && typeof meta === 'object') ? meta.label : meta;
        const cost = (meta && typeof meta === 'object') ? meta.outputCostPerMTok : undefined;
        const text = typeof cost === 'number' ? `${label} — $${cost}/MTok` : label;
        return `<option value="${id}" ${id === DevChat.selectedModel ? 'selected' : ''}>${text}</option>`;
      })
      .join('');

    const viewerOpen = !!DevChat.specViewer.open;
    // Saved viewer width from a previous drag. Applied as inline style
    // on the side panel; CSS clamps to a min/max so a stale value
    // can't make the chat unusably narrow.
    const savedWidth = DevChat._readSpecViewerWidth();
    const viewerStyle = viewerOpen && savedWidth
      ? ` style="width:${savedWidth}px"`
      : '';

    content.innerHTML = `
      <div class="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <button id="dc-back" class="text-zinc-400 hover:text-zinc-200 text-sm">&larr;</button>
        <span class="text-xs text-zinc-400 truncate flex-1" title="${escapeHtml(DevChat.currentSession.branch_name || '')}">${escapeHtml(DevChat.currentSession.session_title || DevChat.currentSession.pr_title || DevChat.currentSession.branch_name || 'Session')}</span>
        ${DevChat.currentSession.pr_number
          ? `<button id="dc-pr-header-link" class="text-xs text-violet-400 hover:text-violet-300" title="This session's pull request — every change in this chat goes to PR #${DevChat.currentSession.pr_number}. Use “Start a new change” for separate work.">PR #${DevChat.currentSession.pr_number}</button>`
          : '<span class="text-xs text-zinc-500" title="This chat is one change → one pull request. A PR opens after the first build.">New change</span>'}
        ${DevChat._renderHeaderStatusPill(DevChat.currentSession)}
      </div>
      ${DevChat._renderSyncBannerHtml(DevChat.currentSession)}
      ${DevChat._renderNewChangeBannerHtml(DevChat.currentSession)}
      ${DevChat._renderCreditsBannerHtml()}
      <div class="dc-session-body flex-1 flex min-h-0">
        <div id="dc-tab-chat" class="dc-chat-pane flex-1 flex flex-col min-h-0">
          <div id="dc-messages" class="dc-messages-container flex-1 overflow-y-auto py-2"></div>
          <div class="shrink-0 border-t border-zinc-200 dark:border-zinc-800 p-2">
            <div class="flex items-center gap-2 mb-2">
              <label class="text-xs text-zinc-500">Model:</label>
              <select id="dc-model-select" class="rounded bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-violet-500">
                ${modelOptions}
              </select>
              <input type="file" id="dc-file-input" class="hidden" multiple
                accept=".png,.jpg,.jpeg,.gif,.webp,.txt,.md,.markdown,.csv,.tsv,.json,.log,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.sql,.sh,image/png,image/jpeg,image/gif,image/webp">
              <button type="button" id="dc-attach-btn" title="Attach files — images (PNG/JPEG/GIF/WebP, ≤4 MB) or text files (≤200 KB), up to 4 per message" aria-label="Attach files"
                class="dc-attach-btn rounded border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-900 text-zinc-500 hover:text-violet-400 hover:border-violet-500 px-1.5 py-1 shrink-0 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              </button>
              <span class="flex-1"></span>
              <span id="dc-budget" class="text-xs font-mono"></span>
            </div>
            <div id="dc-quick-replies" class="dc-quick-replies"></div>
            <div id="dc-attachments" class="dc-attach-strip"></div>
            <div id="dc-attach-error" class="dc-attach-error hidden"></div>
            <form id="dc-form" class="flex gap-2 items-end">
              <textarea
                id="dc-input"
                rows="1"
                placeholder="Describe a change in plain English — e.g. &quot;add a dark mode toggle&quot;. No coding needed."
                autocomplete="off"
                class="dc-textarea flex-1 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent resize-none"
              ></textarea>
              <button type="submit" id="dc-send-btn" class="dc-send-btn rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors shrink-0">
                Send
              </button>
            </form>
            <div class="text-xs text-zinc-600 mt-1 text-right" id="dc-shortcut-hint">
              <kbd class="dc-kbd">Ctrl</kbd>+<kbd class="dc-kbd">Enter</kbd> to send
            </div>
          </div>
        </div>
        <div id="dc-spec-resizer" class="dc-spec-resizer ${viewerOpen ? 'dc-spec-resizer-open' : ''}" role="separator" aria-orientation="vertical" aria-label="Resize spec viewer"></div>
        <div id="dc-spec-viewer" class="dc-spec-viewer ${viewerOpen ? 'dc-spec-viewer-open' : ''}"${viewerStyle}></div>
      </div>`;

    DevChat.renderMessages();
    DevChat._renderQuickReplies();
    DevChat._wireQuickReplies();
    // #463: the template above may have rendered the credits banner from
    // the cached budget — wire its button now; refreshBudget() re-syncs
    // banner + meter once fresh figures land.
    DevChat._wireCreditsBanner();
    DevChat.refreshBudget();
    // Attach tracker first so the scroll set below is observed, then
    // restore the session's last known position (or fall through to
    // scroll-to-bottom for a brand-new session / follow-along view).
    DevChat.initScrollTracking();
    DevChat.restoreSessionScroll();
    DevChat._setupTextareaResize();
    DevChat._setupKeyboardShortcuts();
    DevChat._setupAttachments();
    DevChat._restoreDraft();
    if (DevChat.isStreaming) DevChat._setStreamingUI(true);

    document.getElementById('dc-model-select').addEventListener('change', (e) => {
      DevChat.selectedModel = e.target.value;
      // Persist across refreshes + new sessions (fixes #31). Wrapped
      // in try/catch so private-mode browsers or quota errors don't
      // break the selector.
      try { localStorage.setItem(MODEL_STORAGE_KEY, e.target.value); } catch {}
    });

    const prHeaderLink = document.getElementById('dc-pr-header-link');
    if (prHeaderLink) {
      prHeaderLink.addEventListener('click', () => {
        const card = document.getElementById('dc-pr-card');
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.add('dc-pr-card-highlight');
          setTimeout(() => card.classList.remove('dc-pr-card-highlight'), 1500);
        }
      });
    }

    document.getElementById('dc-back').addEventListener('click', () => {
      DevChat.currentSession = null;
      DevChat.messages = [];
      // The title marker describes the session we just left — drop it
      // so the forum doesn't claim to be thinking / done.
      DevChat.setTitleStatus(null);
      // Forum revision: backing out of a session returns to the dev
      // forum page (there is no session-list screen anymore).
      if (typeof App !== 'undefined' && App.switchTab) {
        App.switchTab('dev');
      } else {
        DevChat.renderChatView();
      }
    });

    DevChat._wireSyncBanner();

    const newChangeBtn = document.getElementById('dc-new-change-btn');
    if (newChangeBtn) {
      newChangeBtn.addEventListener('click', () => DevChat.startNewChange());
    }

    document.getElementById('dc-form').addEventListener('submit', (e) => {
      e.preventDefault();
      // When streaming, the same button is the "Stop" affordance — so
      // a submit event means "stop this turn" rather than "send a new
      // message" (the input is disabled while streaming anyway).
      if (DevChat.isStreaming) {
        DevChat._stopCurrentTurn();
        return;
      }
      DevChat._submitFromInput();
    });

    // Render the spec viewer if it was open before this re-render
    // (toggling layout, version selection, etc. all re-enter via
    // renderChatView).
    if (DevChat.specViewer.open) {
      DevChat._renderSpecViewer();
    }

    // Wire up the draggable divider between chat pane and viewer. Idempotent —
    // we re-bind on every renderChatView since the resizer element gets
    // recreated whenever the session view re-renders.
    DevChat._initSpecResizer();
  },

  _submitFromInput() {
    const input = document.getElementById('dc-input');
    const msg = input.value.trim();
    const atts = DevChat.pendingAttachments.filter((a) => !a.uploading);
    // Attachments alone are a valid send (#450) — the server stores a
    // "(attached files)" stub caption.
    if ((!msg && !atts.length) || DevChat.isStreaming) return;
    if (DevChat.pendingAttachments.some((a) => a.uploading)) {
      DevChat._setAttachError('Still uploading — one moment…');
      return;
    }
    input.value = '';
    input.style.height = 'auto';
    if (DevChat.currentSession) DevChat._setDraft(DevChat.currentSession.id, '');
    DevChat.sendMessage(msg, atts);
  },

  // ── File attachments (#450) ─────────────────────────────────
  //
  // Upload-before-send: each picked/pasted/dropped file is validated
  // client-side (mirroring src/services/attachments.js), POSTed as raw
  // octet-stream to /api/sessions/:id/attachments, and parked in
  // `pendingAttachments` (rendered as a strip above the composer) until
  // the message sends with the attachment ids. Orphans left by removed
  // or abandoned uploads are GC'd server-side after 24h.
  pendingAttachments: [],

  ATTACH_LIMITS: {
    maxPerMessage: 4,
    maxImageBytes: 4 * 1024 * 1024,
    maxTextBytes: 200 * 1024,
    imageExts: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
    textExts: ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'sql', 'sh'],
  },

  _setupAttachments() {
    const btn = document.getElementById('dc-attach-btn');
    const fileInput = document.getElementById('dc-file-input');
    const textarea = document.getElementById('dc-input');
    const messagesEl = document.getElementById('dc-messages');
    if (!btn || !fileInput) return;

    // Pending uploads belong to the session they were uploaded to.
    const sid = DevChat.currentSession?.id;
    DevChat.pendingAttachments = DevChat.pendingAttachments.filter((a) => a.sessionId === sid);
    DevChat._renderAttachStrip();

    btn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.length) DevChat._addFiles(fileInput.files);
      fileInput.value = '';
    });

    // Paste an image straight from the clipboard (screenshots).
    if (textarea) {
      textarea.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items || [];
        const files = [];
        for (const item of items) {
          if (item.kind === 'file') {
            const f = item.getAsFile();
            if (f) {
              // Clipboard images often arrive nameless — synthesize one.
              if (!f.name || f.name === 'image.png' || !/\./.test(f.name)) {
                const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
                const named = new File([f], `pasted-image-${Date.now() % 100000}.${ext}`, { type: f.type });
                files.push(named);
              } else {
                files.push(f);
              }
            }
          }
        }
        if (files.length) {
          e.preventDefault();
          DevChat._addFiles(files);
        }
      });
    }

    // Drag-and-drop onto the message area or the composer.
    for (const el of [messagesEl, document.getElementById('dc-form')]) {
      if (!el) continue;
      el.addEventListener('dragover', (e) => { e.preventDefault(); });
      el.addEventListener('drop', (e) => {
        if (e.dataTransfer?.files?.length) {
          e.preventDefault();
          DevChat._addFiles(e.dataTransfer.files);
        }
      });
    }
  },

  async _addFiles(fileList) {
    if (!DevChat.currentSession || DevChat.isStreaming) return;
    DevChat._setAttachError(null);
    const sid = DevChat.currentSession.id;
    const L = DevChat.ATTACH_LIMITS;
    for (const file of Array.from(fileList)) {
      if (DevChat.pendingAttachments.length >= L.maxPerMessage) {
        DevChat._setAttachError(`Up to ${L.maxPerMessage} files per message.`);
        break;
      }
      const ext = (file.name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
      const isImage = L.imageExts.includes(ext);
      const isText = L.textExts.includes(ext);
      if (!isImage && !isText) {
        DevChat._setAttachError(`"${file.name}" isn't supported — attach an image (PNG/JPEG/GIF/WebP) or a text file.`);
        continue;
      }
      if (isImage && file.size > L.maxImageBytes) {
        DevChat._setAttachError(`"${file.name}" is too big — images max ${Math.round(L.maxImageBytes / 1024 / 1024)} MB.`);
        continue;
      }
      if (isText && file.size > L.maxTextBytes) {
        DevChat._setAttachError(`"${file.name}" is too big — text files max ${Math.round(L.maxTextBytes / 1024)} KB.`);
        continue;
      }
      const entry = {
        sessionId: sid,
        uploading: true,
        id: null,
        kind: isImage ? 'image' : 'text',
        filename: file.name,
        sizeBytes: file.size,
        objectUrl: isImage ? URL.createObjectURL(file) : null,
      };
      DevChat.pendingAttachments.push(entry);
      DevChat._renderAttachStrip();
      try {
        const res = await fetch(`/api/sessions/${sid}/attachments?filename=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `Upload failed (HTTP ${res.status})`);
        entry.id = data.id;
        entry.kind = data.kind;
        entry.uploading = false;
      } catch (err) {
        DevChat.pendingAttachments = DevChat.pendingAttachments.filter((a) => a !== entry);
        if (entry.objectUrl) { try { URL.revokeObjectURL(entry.objectUrl); } catch {} }
        DevChat._setAttachError(err.message || 'Upload failed');
      }
      DevChat._renderAttachStrip();
    }
  },

  _removeAttachment(idx) {
    const entry = DevChat.pendingAttachments[idx];
    if (!entry || entry.uploading) return;
    DevChat.pendingAttachments.splice(idx, 1);
    if (entry.objectUrl) { try { URL.revokeObjectURL(entry.objectUrl); } catch {} }
    // Server row stays until the 24h orphan sweep — harmless.
    DevChat._setAttachError(null);
    DevChat._renderAttachStrip();
  },

  _setAttachError(msg) {
    const el = document.getElementById('dc-attach-error');
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  },

  _humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
  },

  _renderAttachStrip() {
    const strip = document.getElementById('dc-attachments');
    if (!strip) return;
    const items = DevChat.pendingAttachments;
    if (!items.length) {
      strip.innerHTML = '';
      strip.classList.remove('dc-attach-strip-active');
      return;
    }
    strip.classList.add('dc-attach-strip-active');
    strip.innerHTML = items.map((a, i) => {
      const name = escapeHtml(a.filename);
      const removeBtn = a.uploading
        ? '<span class="dc-attach-uploading">…</span>'
        : `<button type="button" class="dc-attach-remove" data-attach-idx="${i}" title="Remove" aria-label="Remove ${name}">&times;</button>`;
      if (a.kind === 'image' && a.objectUrl) {
        return `<div class="dc-attach-item"><img class="dc-attach-thumb" src="${a.objectUrl}" alt="${name}" title="${name}">${removeBtn}</div>`;
      }
      return `<div class="dc-attach-item dc-attach-chip" title="${name}"><span class="dc-attach-name">${name}</span><span class="dc-attach-size">${DevChat._humanSize(a.sizeBytes)}</span>${removeBtn}</div>`;
    }).join('');
    strip.querySelectorAll('.dc-attach-remove').forEach((btn) => {
      btn.addEventListener('click', () => DevChat._removeAttachment(Number(btn.dataset.attachIdx)));
    });
  },

  // Attachment row inside a user bubble. Rendered OUTSIDE renderMarkdown
  // (the DOMPurify allowlist strips <img>, and must keep doing so for
  // untrusted markdown). Optimistic sends carry objectUrl until the
  // reload swaps in the server URL.
  _attachmentsRowHtml(msg) {
    const atts = msg.attachments;
    if (!Array.isArray(atts) || !atts.length) return '';
    const sid = DevChat.currentSession?.id;
    const items = atts.map((a) => {
      const name = escapeHtml(String(a.filename || 'file'));
      const idOk = typeof a.id === 'string' && /^[a-f0-9]{32}$/.test(a.id);
      const url = a.objectUrl || (idOk && sid ? `/api/sessions/${sid}/attachments/${a.id}` : null);
      if (!url) return '';
      if (a.kind === 'image') {
        return `<a href="${url}" target="_blank" rel="noopener" title="${name} — open full size"><img class="dc-msg-att-img" src="${url}" alt="${name}" loading="lazy"></a>`;
      }
      return `<a class="dc-msg-att-chip" href="${url}" download="${name}" title="Download ${name}"><span class="dc-attach-name">${name}</span><span class="dc-attach-size">${DevChat._humanSize(a.sizeBytes)}</span></a>`;
    }).filter(Boolean).join('');
    return items ? `<div class="dc-msg-attachments">${items}</div>` : '';
  },

  _setupTextareaResize() {
    const textarea = document.getElementById('dc-input');
    if (!textarea) return;
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
      // Persist the draft per-session so it survives both tab switches
      // (which rebuild the textarea DOM) and full page refreshes.
      if (DevChat.currentSession) DevChat._setDraft(DevChat.currentSession.id, textarea.value);
    });
  },

  // Per-session draft helpers, backed by localStorage.
  _draftKey(sessionId) {
    return `usernode:dc-draft:${sessionId}`;
  },
  _getDraft(sessionId) {
    if (!sessionId) return '';
    try { return localStorage.getItem(DevChat._draftKey(sessionId)) || ''; }
    catch { return ''; }
  },
  _setDraft(sessionId, value) {
    if (!sessionId) return;
    try {
      if (value) localStorage.setItem(DevChat._draftKey(sessionId), value);
      else localStorage.removeItem(DevChat._draftKey(sessionId));
    } catch {}
  },

  // #370: put a message the user was about to send (or just sent, on a
  // turn that bounced) back into the composer so they never have to
  // retype it. Shared by _stopCurrentTurn and sendMessage's failure
  // paths (429 token/spend cap, generic non-ok response).
  //
  // - `dropOptimisticUser` (cap/error paths): the optimistic user row
  //   pushed in sendMessage was never persisted (no id) and the turn
  //   never ran — splice it so the text lives only in the editor, not
  //   as a duplicate sent-looking bubble. Scans backwards for the most
  //   recent un-persisted user row so it still finds it even after an
  //   assistant error message has been pushed on top.
  // - `onlyIfEmpty` (Stop path): never clobber a half-typed follow-up,
  //   and — matching the original inline behaviour — do nothing at all
  //   when the textarea isn't mounted.
  //
  // Every DOM / storage touch is guarded (the textarea may be gone if
  // the user navigated away) and an empty message is a no-op.
  _restoreComposer(message, { dropOptimisticUser = false, onlyIfEmpty = false } = {}) {
    if (!message || typeof message !== 'string') return;
    const input = document.getElementById('dc-input');
    if (onlyIfEmpty && (!input || input.value.trim())) return;
    if (dropOptimisticUser) {
      for (let i = DevChat.messages.length - 1; i >= 0; i--) {
        const m = DevChat.messages[i];
        if (m.role === 'user' && !m.id) { DevChat.messages.splice(i, 1); break; }
      }
    }
    if (input) {
      input.value = message;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      if (dropOptimisticUser) { try { input.focus(); } catch {} }
    }
    if (DevChat.currentSession) DevChat._setDraft(DevChat.currentSession.id, message);
  },

  _restoreDraft() {
    if (!DevChat.currentSession) return;
    const textarea = document.getElementById('dc-input');
    if (!textarea) return;
    const draft = DevChat._getDraft(DevChat.currentSession.id);
    if (!draft) return;
    textarea.value = draft;
    // Re-run the height calculation so the textarea opens at the right
    // size instead of collapsed.
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  },

  _setupKeyboardShortcuts() {
    const textarea = document.getElementById('dc-input');
    if (!textarea) return;

    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        DevChat._submitFromInput();
      }
    });
  },

  // ===== Spec viewer resizer (draggable divider) =====
  //
  // The chat pane / spec viewer split is fixed at 480px by default but
  // users want to widen the viewer when reading a long spec or shrink
  // it back. CSS handles the side-panel-vs-modal layout switch (CSS
  // wins above 1024px); this just lets the user drag the boundary on
  // wide viewports.
  //
  // Width is persisted to localStorage so it sticks across reloads.
  // The CSS rule `min-width: 280px; max-width: calc(100vw - 320px)`
  // clamps stale or hostile values so the chat pane is always usable.

  _SPEC_VIEWER_WIDTH_KEY: 'dc-spec-viewer-width-v1',
  // The viewer's open/closed state is persisted per-session, not
  // global — a new session that has no spec yet shouldn't auto-open
  // an empty viewer just because the user had it open in a prior
  // session. Width is global (one consistent layout preference);
  // open/closed is per-session.
  _SPEC_VIEWER_OPEN_KEY_PREFIX: 'dc-spec-viewer-open-v1:',

  _readSpecViewerWidth() {
    try {
      const v = parseInt(localStorage.getItem(DevChat._SPEC_VIEWER_WIDTH_KEY) || '', 10);
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
  },

  _writeSpecViewerWidth(px) {
    try { localStorage.setItem(DevChat._SPEC_VIEWER_WIDTH_KEY, String(Math.round(px))); }
    catch {}
  },

  _readSpecViewerOpen(sessionId) {
    if (!sessionId) return false;
    try { return localStorage.getItem(DevChat._SPEC_VIEWER_OPEN_KEY_PREFIX + sessionId) === '1'; }
    catch { return false; }
  },

  _writeSpecViewerOpen(sessionId, isOpen) {
    if (!sessionId) return;
    try { localStorage.setItem(DevChat._SPEC_VIEWER_OPEN_KEY_PREFIX + sessionId, isOpen ? '1' : '0'); }
    catch {}
  },

  _initSpecResizer() {
    const handle = document.getElementById('dc-spec-resizer');
    const viewer = document.getElementById('dc-spec-viewer');
    if (!handle || !viewer) return;

    handle.addEventListener('pointerdown', (e) => {
      // Only start dragging when the resizer is actually visible (the
      // viewer is open AND we're in side-panel layout — CSS handles
      // the latter via the dc-spec-resizer-open visibility rule). On
      // narrow viewports the modal layout takes over and this handler
      // is harmless because the resizer itself is `display: none`.
      if (!DevChat.specViewer.open) return;
      e.preventDefault();

      const sessionBody = handle.parentElement;
      const startX = e.clientX;
      const startWidth = viewer.getBoundingClientRect().width;
      const bodyRect = sessionBody.getBoundingClientRect();
      const minWidth = 280;
      const maxWidth = Math.max(minWidth + 1, bodyRect.width - 320);

      // Capture pointer so we keep getting move events even if the
      // cursor strays out of the 4px-wide handle.
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dc-spec-resizer-active');
      // Disable text selection during the drag — selecting random
      // chat / spec text while resizing is just visual noise.
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const onMove = (ev) => {
        // Dragging right shrinks the viewer (its left edge moves right).
        const delta = ev.clientX - startX;
        const next = Math.max(minWidth, Math.min(maxWidth, startWidth - delta));
        viewer.style.width = `${next}px`;
      };

      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        try { handle.releasePointerCapture(e.pointerId); } catch {}
        handle.classList.remove('dc-spec-resizer-active');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        const finalWidth = viewer.getBoundingClientRect().width;
        DevChat._writeSpecViewerWidth(finalWidth);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  },

  // ===== Spec viewer helpers =====
  //
  // Read-only viewer that opens when the user clicks an inline spec
  // preview card in the chat timeline. Mounts as a side panel beside
  // the chat on wide viewports and as a fullscreen modal on narrow
  // ones — the layout switch is pure CSS (see app.css), the JS just
  // toggles state + re-renders.

  // Open the viewer for a specific version ('latest' to follow the
  // highest version, or a numeric version string/number for an older
  // frozen snapshot). Legacy inline cards from before per-change
  // versioning carry 'draft' — treat that as 'latest' for back-compat.
  // Triggers a network fetch for the latest content + version metadata,
  // and a second fetch for the selected frozen version's content if
  // needed. Safe to call when already open (just reloads).
  openSpecViewer(version) {
    if (!DevChat.currentSession) return;
    const sid = DevChat.currentSession.id;
    DevChat.specViewer.open = true;
    DevChat.specViewer.sessionId = sid;
    DevChat.specViewer.viewVersion = (version === 'draft' || version === 'latest' || version == null) ? 'latest' : version;
    DevChat.specViewer.viewVersionContent = null;
    DevChat._writeSpecViewerOpen(sid, true);
    DevChat.renderChatView();
    DevChat._loadSpecViewer({ force: true });
  },

  closeSpecViewer() {
    const sid = DevChat.currentSession ? DevChat.currentSession.id : null;
    DevChat.specViewer.open = false;
    DevChat._writeSpecViewerOpen(sid, false);
    DevChat.renderChatView();
  },

  // Fetch the latest spec content + frozen-version metadata. Called
  // when the viewer opens and whenever a spec_updated SSE event lands
  // while the viewer is following the latest version.
  async _loadSpecViewer(opts = {}) {
    const session = DevChat.currentSession;
    if (!session) return;
    const sid = session.id;
    if (DevChat.specViewer.isLoading && !opts.force) return;

    DevChat.specViewer.isLoading = true;
    DevChat._renderSpecViewer();

    try {
      const resp = await fetch(`/api/sessions/${sid}/spec`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!DevChat.currentSession || DevChat.currentSession.id !== sid) return;

      DevChat.specViewer.sessionId = sid;
      DevChat.specViewer.draftContent = data.spec || '';
      DevChat.specViewer.versions = data.versions || [];
    } catch (err) {
      console.warn('loadSpecViewer failed:', err);
    } finally {
      DevChat.specViewer.isLoading = false;
      DevChat._renderSpecViewer();
    }
  },

  _renderSpecViewer() {
    const pane = document.getElementById('dc-spec-viewer');
    if (!pane || !DevChat.currentSession) return;
    if (!DevChat.specViewer.open) return;
    // #233 fail-closed guard: never render another session's spec. Any
    // path that forgets to reset the global specViewer slot on a
    // session switch gets a blank panel, not stale content.
    if (DevChat.specViewer.sessionId != null
        && Number(DevChat.specViewer.sessionId) !== Number(DevChat.currentSession.id)) return;

    // Numbered versions are the single spec surface now (#69). The
    // dropdown lists v1…vN; the highest is the live latest and its
    // content is byte-identical to chat_sessions.spec_md, which we
    // already have cached in `draftContent` (no extra fetch needed).
    // 'latest' is a sentinel that follows the highest version as new
    // ones are auto-created on each Mayor spec edit.
    const versions = DevChat.specViewer.versions; // DESC sorted
    const hasVersions = versions.length > 0;
    const latest = hasVersions ? versions[0] : null;

    let selectedVersion;
    if (DevChat.specViewer.viewVersion === 'latest') {
      selectedVersion = latest;
    } else {
      selectedVersion = versions.find((v) => String(v.version) === String(DevChat.specViewer.viewVersion)) || latest;
    }
    const isLatest = !!(selectedVersion && latest && selectedVersion.version === latest.version);

    // Latest content lives in draftContent (== spec_md); older versions
    // are lazily fetched into viewVersionContent.
    const displayContent = (isLatest || !hasVersions)
      ? DevChat.specViewer.draftContent
      : (DevChat.specViewer.viewVersionContent || '');

    const versionOptions = versions.map((v) => {
      const built = v.built_at ? new Date(v.built_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const isThisLatest = latest && v.version === latest.version;
      // The latest option carries the 'latest' value so re-selecting it
      // resumes following new versions; older options carry their number.
      const optValue = isThisLatest ? 'latest' : String(v.version);
      const sel = selectedVersion && v.version === selectedVersion.version ? 'selected' : '';
      const label = `v${v.version}${isThisLatest ? ' (latest)' : ''}${built ? ` · ${built}` : ''}${v.pr_number ? ` · PR #${v.pr_number}` : ''}`;
      return `<option value="${optValue}" ${sel}>${label}</option>`;
    }).join('');

    // Header action: [Share to group] for the selected version (any
    // version is shareable now — the redundant draft/Save-version step
    // was removed in #69). Disabled + "Shared" once already posted.
    const isEmpty = !displayContent || !displayContent.trim();
    const alreadyShared = !!(selectedVersion && selectedVersion.shared_to_group_at);
    const shareBtnHtml = (!selectedVersion || isEmpty)
      ? `<button class="dc-spec-action-btn" disabled title="No spec version to share yet">Share to group</button>`
      : `<button id="dc-spec-viewer-share" class="dc-spec-action-btn" ${alreadyShared ? 'disabled' : ''} title="${alreadyShared ? 'Already shared to group chat' : 'Post a card linking to this spec in the group chat'}">${alreadyShared ? 'Shared' : 'Share to group'}</button>`;

    // (#86) Private share: send this version to ONE person, who gets a
    // notification deep-linking to the read-only spec panel. Repeatable
    // (no alreadyShared disabling — the owner can share with several
    // people one at a time) and independent of the group-share state.
    const shareUserBtnHtml = (!selectedVersion || isEmpty)
      ? `<button class="dc-spec-action-btn" disabled title="No spec version to share yet">Share to user</button>`
      : `<button id="dc-spec-viewer-share-user" class="dc-spec-action-btn" title="Privately share this spec version with one person">Share to user</button>`;

    // #196: a conforming spec (BOTH marker headings present — see
    // public/js/spec-sections.js) renders as two tabs so non-technical
    // readers land on the plain-language half. The preamble (title +
    // summary before the first marker) stays visible above the tabs.
    // A null split — legacy or non-conforming doc — renders the single
    // untabbed body exactly as before.
    const split = displayContent ? splitSpecSections(displayContent) : null;
    let specBodyHtml = '';
    if (split) {
      const activeTab = DevChat.specViewer.activeTab === 'tech' ? 'tech' : 'user';
      const activeHalf = activeTab === 'tech' ? split.technical : split.userFacing;
      const tabBtn = (key, label) =>
        `<button class="dc-spec-viewer-tab${activeTab === key ? ' dc-spec-viewer-tab-active' : ''}" role="tab" aria-selected="${activeTab === key}" data-spec-tab="${key}">${label}</button>`;
      // An empty-but-present half still gets its tab (with a muted
      // placeholder) so the toggle doesn't appear/disappear between
      // versions.
      specBodyHtml = `${split.preamble ? `<div class="dc-spec-viewer-body dc-spec-viewer-preamble">${DevChat.renderMarkdown(split.preamble, { breaks: false })}</div>` : ''}
        <div class="dc-spec-viewer-tabs" role="tablist" aria-label="Spec sections">
          ${tabBtn('user', 'User-facing')}
          ${tabBtn('tech', 'Technical')}
        </div>
        <div class="dc-spec-viewer-body" role="tabpanel">${
          activeHalf
            ? DevChat.renderMarkdown(activeHalf, { breaks: false })
            : '<p class="dc-spec-tab-empty">Nothing in this section.</p>'
        }</div>`;
    } else if (displayContent) {
      specBodyHtml = `<div class="dc-spec-viewer-body">${DevChat.renderMarkdown(displayContent, { breaks: false })}</div>`;
    }
    const bodyHtml = DevChat.specViewer.isLoading && !displayContent
      ? `<div class="p-4 text-sm text-zinc-500">Loading spec…</div>`
      : displayContent
        ? specBodyHtml
        : `<div class="p-4 text-sm text-zinc-500">No spec yet. Ask the AI to draft one.</div>`;

    // Spec planning and building are two separate steps: drafting a spec
    // does NOT build anything. Make the handoff explicit so a finished
    // spec doesn't read as a finished change (there is no in-UI build
    // button — the user asks the Mayor in chat). Only shown while viewing
    // the non-empty latest version, where the next action is to dispatch
    // a build.
    const buildHintHtml = isLatest && !isEmpty
      ? `<div class="dc-spec-viewer-build-hint">This is a plan, not a built change. Ready? Ask the AI in chat to build it.</div>`
      : '';

    pane.innerHTML = `
      <div class="dc-spec-viewer-header">
        <select id="dc-spec-viewer-version" class="text-xs rounded bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1" ${hasVersions ? '' : 'disabled'}>
          ${hasVersions ? versionOptions : '<option>No versions yet</option>'}
        </select>
        ${shareUserBtnHtml}
        ${shareBtnHtml}
        <button id="dc-spec-viewer-close" class="dc-spec-viewer-close" aria-label="Close spec viewer">×</button>
        <div id="dc-spec-share-pop" class="dc-spec-share-pop hidden">
          <input id="dc-spec-share-input" class="dc-spec-share-input" type="text"
                 placeholder="Username…" autocomplete="off" spellcheck="false" maxlength="32" />
          <div id="dc-spec-share-suggestions" class="dc-spec-share-suggestions"></div>
          <div id="dc-spec-share-error" class="dc-spec-share-error hidden"></div>
          <button id="dc-spec-share-send" class="dc-spec-action-btn dc-spec-share-send">Send</button>
        </div>
      </div>
      <div class="dc-spec-viewer-body-wrap">
        ${bodyHtml}
      </div>
      ${buildHintHtml}`;

    const versionSel = pane.querySelector('#dc-spec-viewer-version');
    if (versionSel) {
      versionSel.addEventListener('change', (e) => {
        DevChat._switchSpecViewerVersion(e.target.value);
      });
    }

    const closeBtn = pane.querySelector('#dc-spec-viewer-close');
    if (closeBtn) closeBtn.addEventListener('click', () => DevChat.closeSpecViewer());

    const shareBtn = pane.querySelector('#dc-spec-viewer-share');
    if (shareBtn && selectedVersion) shareBtn.addEventListener('click', () => DevChat._shareSpecVersion(selectedVersion.version));

    const shareUserBtn = pane.querySelector('#dc-spec-viewer-share-user');
    if (shareUserBtn && selectedVersion) DevChat._bindSpecSharePopover(pane, shareUserBtn, selectedVersion.version);

    // #196: tab switches are pure re-renders of cached content — no
    // refetch. The selection lives in specViewer.activeTab so it
    // survives version switches and spec_updated refreshes within the
    // panel's lifetime.
    pane.querySelectorAll('.dc-spec-viewer-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.specTab === 'tech' ? 'tech' : 'user';
        if (DevChat.specViewer.activeTab === tab) return;
        DevChat.specViewer.activeTab = tab;
        DevChat._renderSpecViewer();
      });
    });

    // Lazy-fetch frozen content when an older (non-latest) version is
    // selected and we don't have it cached.
    if (selectedVersion && !isLatest && !DevChat.specViewer.viewVersionContent) {
      DevChat._loadSpecVersion(selectedVersion.version).catch(() => {});
    }
  },

  _switchSpecViewerVersion(value) {
    DevChat.specViewer.viewVersion = value === 'latest' ? 'latest' : value;
    DevChat.specViewer.viewVersionContent = null;
    DevChat._renderSpecViewer();
  },

  async _loadSpecVersion(version) {
    if (!DevChat.currentSession) return;
    const sid = DevChat.currentSession.id;
    try {
      const resp = await fetch(`/api/sessions/${sid}/specs/${version}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!DevChat.currentSession || DevChat.currentSession.id !== sid) return;
      // Bail if the user picked another version while we were fetching.
      if (String(DevChat.specViewer.viewVersion) !== String(version)) return;
      DevChat.specViewer.viewVersionContent = data.spec.content || '';
      DevChat._renderSpecViewer();
    } catch (err) {
      console.warn('loadSpecVersion failed:', err);
    }
  },

  async _shareSpecVersion(version) {
    if (!DevChat.currentSession || version === 'draft' || version === 'latest' || version == null) return;
    const sid = DevChat.currentSession.id;
    try {
      const resp = await fetch(`/api/sessions/${sid}/specs/${version}/share`, {
        method: 'POST',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // Mark the version as shared locally so the button flips without
      // a full reload — the server's broadcast already handled the
      // group chat side.
      const v = DevChat.specViewer.versions.find((x) => x.version === Number(version));
      if (v) v.shared_to_group_at = new Date().toISOString();
      DevChat._renderSpecViewer();
    } catch (err) {
      console.warn('shareSpecVersion failed:', err);
    }
  },

  // (#86) Wire the "Share to user" button + its popover. The popover
  // lives inside the freshly-rendered pane, so all state here is local
  // to this render pass — a re-render (version switch, spec update)
  // simply closes it. Suggestions come from the same endpoint the
  // group-chat @mention autocomplete uses, fetched once per open and
  // prefix-filtered client-side as the user types.
  _bindSpecSharePopover(pane, btn, version) {
    const pop = pane.querySelector('#dc-spec-share-pop');
    const input = pane.querySelector('#dc-spec-share-input');
    const sugBox = pane.querySelector('#dc-spec-share-suggestions');
    const errBox = pane.querySelector('#dc-spec-share-error');
    const sendBtn = pane.querySelector('#dc-spec-share-send');
    if (!pop || !input || !sugBox || !errBox || !sendBtn) return;

    let suggestions = [];

    const setError = (msg) => {
      errBox.textContent = msg || '';
      errBox.classList.toggle('hidden', !msg);
    };

    const renderSuggestions = () => {
      const q = input.value.trim().toLowerCase();
      const matches = suggestions
        .filter((name) => !q || name.toLowerCase().startsWith(q))
        .slice(0, 6);
      sugBox.innerHTML = matches
        .map((name) => `<button type="button" class="dc-spec-share-sug" data-username="${escapeHtml(name)}">@${escapeHtml(name)}</button>`)
        .join('');
      sugBox.querySelectorAll('.dc-spec-share-sug').forEach((s) => {
        s.addEventListener('click', () => {
          input.value = s.dataset.username;
          sugBox.innerHTML = '';
          input.focus();
        });
      });
    };

    const close = () => {
      pop.classList.add('hidden');
      document.removeEventListener('pointerdown', onOutside, true);
    };
    const onOutside = (e) => {
      if (pop.contains(e.target) || e.target === btn) return;
      close();
    };

    btn.addEventListener('click', async () => {
      if (!pop.classList.contains('hidden')) { close(); return; }
      pop.classList.remove('hidden');
      setError(null);
      input.value = '';
      sugBox.innerHTML = '';
      input.focus();
      document.addEventListener('pointerdown', onOutside, true);
      // Lazy one-shot fetch of mention candidates for this app.
      if (!suggestions.length
          && typeof AppView !== 'undefined' && AppView.appData && AppView.appData.slug) {
        try {
          const res = await fetch(`/api/apps/${AppView.appData.slug}/mention-suggestions`);
          if (res.ok) {
            const { users } = await res.json();
            suggestions = Array.isArray(users)
              ? users.map((u) => (u && u.username) || '').filter(Boolean)
              : [];
            if (!pop.classList.contains('hidden')) renderSuggestions();
          }
        } catch { /* suggestions are best-effort; exact usernames still work */ }
      }
    });

    input.addEventListener('input', () => { setError(null); renderSuggestions(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendBtn.click(); }
      if (e.key === 'Escape') close();
    });

    sendBtn.addEventListener('click', async () => {
      const username = input.value.trim().replace(/^@/, '');
      if (!username) { setError('Enter a username'); return; }
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      const result = await DevChat._shareSpecToUser(version, username);
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
      if (!result.ok) {
        setError(result.error || 'Failed to share');
        return;
      }
      // Transient confirmation, then reset for the next share.
      setError(null);
      sugBox.innerHTML = '';
      const sentName = (result.recipient && result.recipient.username) || username;
      btn.textContent = `Sent to @${sentName}`;
      close();
      setTimeout(() => { btn.textContent = 'Share to user'; }, 2500);
    });
  },

  // POST the private share; returns the parsed response (or an {ok:false,
  // error} shape) so the popover can surface server-side 4xx messages
  // ("User not found", "That user doesn't have access…") inline.
  async _shareSpecToUser(version, username) {
    if (!DevChat.currentSession || version == null) return { ok: false, error: 'No session' };
    const sid = DevChat.currentSession.id;
    try {
      const resp = await fetch(`/api/sessions/${sid}/specs/${version}/share-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      let data = {};
      try { data = await resp.json(); } catch {}
      if (!resp.ok) return { ok: false, error: data.error || `HTTP ${resp.status}` };
      return data;
    } catch {
      return { ok: false, error: 'Network error' };
    }
  },
};

DevChat._sanitizeStoredModel();
// Fire-and-forget: refreshes MODELS from the server's allowlist. If
// the page rendered the dropdown before this resolves, the next
// renderChatView() pass will pick up the new entries.
DevChat.loadModels();

// Combined away/return handler (#142, #161). On leaving (tab hidden or
// window blurred) while a turn is streaming, arm the server-side
// completion notification for the open session. On returning, clear any
// sticky completion title marker and — if the user is back on the
// dev-chat tab with the same turn still streaming — disarm the flag
// (they're watching again, so no notification needed). All three events
// matter: visibilitychange fires on browser-tab switches, window
// blur/focus on window-to-window switches where the tab stays
// "visible" the whole time.
DevChat._awayReturnHandler = () => {
  const away = DevChat._userIsAway();
  if (!away && DevChat._titleCompletion) DevChat.setCompletionTitle(null);
  if (DevChat.isStreaming && DevChat.currentSession) {
    if (away) {
      DevChat._setNotifyOnDone(DevChat.currentSession.id, true);
    } else if (typeof App !== 'undefined' && (App.currentTab === 'dev' && App.currentSubTab === 'sessions')) {
      DevChat._setNotifyOnDone(DevChat.currentSession.id, false);
    }
  }
};
document.addEventListener('visibilitychange', DevChat._awayReturnHandler);
window.addEventListener('focus', DevChat._awayReturnHandler);
window.addEventListener('blur', DevChat._awayReturnHandler);

// Tab close / hard navigation while a turn is streaming: a normal fetch
// may be killed mid-flight, so arm via sendBeacon (cookies ride along;
// the endpoint parses the JSON blob body like any other request).
window.addEventListener('pagehide', () => {
  if (!DevChat.isStreaming || !DevChat.currentSession) return;
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify({ armed: true })], { type: 'application/json' });
      navigator.sendBeacon(`/api/sessions/${DevChat.currentSession.id}/notify-on-done`, blob);
    }
  } catch { /* best-effort */ }
});
