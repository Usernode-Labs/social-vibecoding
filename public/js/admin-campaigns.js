'use strict';

// Maintenance campaigns section of the admin console (#860, #853) — the one
// block on the retired standalone /admin page that the console never picked
// up, ported into #admin/campaigns.
//
// Fleet-wide platform maintenance: "New campaign" here only PROPOSES — it
// opens a kind='maintenance_campaign' governance issue on the platform app,
// and the engine starts when that vote passes (or an admin force-applies
// the proposal). This section tracks per-app fan-out progress and offers
// retry / re-run-checks / merge-all-green once PRs exist.
//
// Changes from the standalone page:
//
//   - `render(host)` / `destroy()`; `destroy()` clears the 8s expanded-
//     campaign poll, which the standalone page left running for the life
//     of the tab;
//   - the `/admin#campaign-<id>` deep link becomes `#admin/campaigns/<id>`.
//     This module owns that second hash level entirely on its own —
//     reading it at render time and writing it back with replaceState,
//     guarded on '#admin/campaigns' — the same pattern
//     admin-topochain.js uses for its sub-nav, rather than teaching
//     admin-console.js general multi-level routing. The old
//     `#campaign-<id>` form is mapped by public/admin.html's redirect stub.
//   - window.confirm / window.alert are replaced by PlatformUI (webview-safe).
//
// PERMISSIONS: visible to any admin (isAdmin — full and view-only); every
// mutating control is gated on AdminConsole.canWrite() (canAdminWrite), so
// a view-only admin sees the list and the per-app states but no New
// campaign form, no Retry, no Re-run checks and no Merge-all-green. The
// server enforces this independently on /api/campaigns/*.

const AdminCampaigns = (() => {
  let host = null;
  let pollTimer = null;
  const EXPANDED = new Set();

  const esc = (s) => (window.AdminConsole
    ? AdminConsole.esc(s)
    : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

  const canWrite = () => !!(window.AdminConsole && AdminConsole.canWrite());

  // Reuse the console's non-throwing fetch helper: an /api/* route that
  // falls through to the SPA shell on auth loss returns 200 + HTML, and
  // res.json() on that throws.
  async function fetchJson(url) {
    if (window.AdminConsole?.fetchJson) return AdminConsole.fetchJson(url);
    try {
      const res = await fetch(url);
      if (!res.ok) return { status: res.status, ok: false, data: null };
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return { status: res.status, ok: true, data: null };
      return { status: res.status, ok: true, data: await res.json().catch(() => null) };
    } catch {
      return { status: 0, ok: false, data: null };
    }
  }

  function alertMsg(message) {
    if (window.PlatformUI?.alert) {
      PlatformUI.alert({ title: 'Maintenance campaigns', message: String(message) });
    } else {
      try { window.alert(message); } catch { /* headless */ }
    }
  }

  async function confirmMsg(opts) {
    if (window.PlatformUI?.confirm) return PlatformUI.confirm(opts);
    try {
      return window.confirm([opts.title, opts.message].filter(Boolean).join('\n\n'));
    } catch { return false; }
  }

  // ── Sub-hash (#admin/campaigns/<id>) ─────────────────────────────────
  // Read once at render so a deep link pre-expands that campaign; written
  // back on expand/collapse so the address always reflects what's open.
  function readSubId() {
    const m = String(location.hash || '').match(/^#admin\/campaigns\/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  function writeSubHash(id) {
    if (!String(location.hash || '').startsWith('#admin/campaigns')) return;
    const target = id ? `#admin/campaigns/${id}` : '#admin/campaigns';
    if (location.hash !== target) history.replaceState(null, '', target);
  }

  function campaignAppBadge(state) {
    const map = {
      pending: ['bg-gray-500/10 text-gray-500', 'Pending'],
      running: ['bg-indigo-500/10 text-indigo-500', 'Running'],
      pr_open: ['bg-sky-500/10 text-sky-600 dark:text-sky-400', 'PR open'],
      merged: ['bg-green-500/10 text-green-600 dark:text-green-400', 'Merged'],
      skipped: ['bg-gray-500/10 text-gray-400', 'Skipped'],
      failed: ['bg-red-500/10 text-red-500', 'Failed'],
    };
    const [cls, label] = map[state] || ['bg-gray-500/10 text-gray-400', state || '—'];
    return `<span class="text-[0.65rem] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${cls} shrink-0">${esc(label)}</span>`;
  }

  async function loadCampaigns() {
    const list = document.getElementById('admin-campaign-list');
    if (!list) return;
    const { data } = await fetchJson('/api/campaigns');
    if (!document.getElementById('admin-campaign-list')) return;
    const campaigns = Array.isArray(data?.campaigns) ? data.campaigns : [];
    document.getElementById('admin-campaign-empty')?.classList.toggle('hidden', campaigns.length > 0);
    list.innerHTML = '';
    for (const c of campaigns) {
      const row = document.createElement('div');
      row.className = 'rounded-lg bg-gray-100 dark:bg-gray-800 p-3';
      row.id = `admin-campaign-${c.id}`;
      const statusCls = c.status === 'running' ? 'text-indigo-500'
        : c.status === 'done' ? 'text-green-600 dark:text-green-400' : 'text-gray-400';
      const failedNote = c.failed_apps
        ? ` · <span class="text-red-500">${c.failed_apps} failed</span>` : '';
      row.innerHTML = `
        <div class="flex items-center justify-between gap-3 cursor-pointer" data-campaign-toggle="${c.id}">
          <div class="min-w-0">
            <div class="font-medium truncate">${esc(c.title)}</div>
            <div class="text-xs text-gray-500">
              #${c.id} · <span class="${statusCls}">${esc(c.status)}</span>
              · by ${esc(c.created_by_username || 'platform')}
              · ${new Date(c.created_at).toLocaleString()}
            </div>
          </div>
          <div class="text-xs font-mono shrink-0">${c.merged_apps}/${c.total_apps} merged${failedNote}</div>
        </div>
        <div class="mt-2 hidden" data-campaign-detail="${c.id}"></div>`;
      list.appendChild(row);
      if (EXPANDED.has(c.id)) refreshCampaignDetail(c.id).catch(() => {});
    }
  }

  async function refreshCampaignDetail(id) {
    const el = document.querySelector(`[data-campaign-detail="${id}"]`);
    if (!el) return;
    el.classList.remove('hidden');
    const { data } = await fetchJson(`/api/campaigns/${id}`);
    if (!document.querySelector(`[data-campaign-detail="${id}"]`)) return;
    const c = data?.campaign;
    if (!c) { el.innerHTML = '<p class="text-xs text-red-500 dark:text-red-400">Failed to load campaign detail.</p>'; return; }
    const write = canWrite();
    const rows = (c.apps || []).map((a) => {
      const pr = a.prUrl
        ? `<a href="${esc(a.prUrl)}" target="_blank" rel="noopener" class="text-indigo-500 dark:text-indigo-400 hover:underline text-xs">PR #${a.prNumber || '?'}</a>` : '';
      const check = a.checkState
        ? `<span class="text-xs ${a.checkState === 'passing' ? 'text-green-500' : a.checkState === 'failing' || a.checkState === 'error' ? 'text-red-500 dark:text-red-400' : 'text-gray-500'}">checks: ${esc(a.checkState)}</span>` : '';
      const err = a.error
        ? `<div class="text-xs text-red-500 dark:text-red-400 mt-0.5 break-words">${esc(a.error)}</div>` : '';
      const retry = (write && (a.state === 'failed' || a.state === 'skipped'))
        ? `<button type="button" class="campaign-retry-btn text-xs text-indigo-500 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 dark:hover:text-indigo-300 shrink-0" data-campaign="${c.id}" data-app="${a.appId}">Retry</button>` : '';
      // Failing/error checks on an open campaign PR: offer the same manual
      // re-run as the proposal card (#447). POSTs to the session recheck
      // endpoint, which stamps 'pending' and rebuilds staging if the preview
      // is gone — the 8s poll refreshes the row.
      const recheck = (write && a.state === 'pr_open' && a.sessionId
        && (a.checkState === 'failing' || a.checkState === 'error'))
        ? `<button type="button" class="campaign-recheck-btn text-xs text-indigo-500 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 dark:hover:text-indigo-300 shrink-0" data-campaign="${c.id}" data-session="${a.sessionId}">Re-run checks</button>` : '';
      return `
        <li class="p-2 rounded bg-white dark:bg-gray-900">
          <div class="flex items-center justify-between gap-3">
            <span class="font-mono text-sm truncate">${esc(a.slug)}</span>
            <span class="flex items-center gap-2">${pr}${check}${campaignAppBadge(a.state)}${recheck}${retry}</span>
          </div>
          ${err}
        </li>`;
    }).join('');
    // "Green" = open campaign PR whose checks pass — what merge-green will
    // force-merge (mirrors the server-side query in
    // fleet-maintenance.mergeGreen).
    const green = (c.apps || []).filter((a) => a.state === 'pr_open'
      && (a.checkState === 'passing' || a.checkState === 'skipped')).length;
    const mergeBtn = (write && green > 0)
      ? `<button type="button" class="campaign-merge-green-btn rounded-lg bg-green-600 hover:bg-green-500 px-3 py-1.5 text-xs font-medium text-white transition-colors" data-campaign="${c.id}">Merge all green (${green})</button>` : '';
    // Bulk companion to the per-row Re-run checks button. Each recheck is
    // fire-and-forget server-side; the loop below just queues them.
    const failingChecks = (c.apps || []).filter((a) => a.state === 'pr_open' && a.sessionId
      && (a.checkState === 'failing' || a.checkState === 'error'));
    const recheckAllBtn = (write && failingChecks.length > 0)
      ? `<button type="button" class="campaign-recheck-all-btn ${AdminUI.btn.primarySm}" data-campaign="${c.id}" data-sessions="${failingChecks.map((a) => a.sessionId).join(',')}">Re-run failing checks (${failingChecks.length})</button>` : '';
    el.innerHTML = `
      <details class="mb-2">
        <summary class="text-xs text-gray-500 cursor-pointer">Instructions</summary>
        <pre class="text-xs text-gray-500 whitespace-pre-wrap mt-1 p-2 rounded bg-white dark:bg-gray-900 max-h-48 overflow-y-auto">${esc(c.instructions || '')}</pre>
      </details>
      <ul class="space-y-1">${rows || '<li class="text-xs text-gray-500">No target apps.</li>'}</ul>
      <div class="flex items-center justify-end gap-2 mt-2">
        <span class="campaign-detail-status text-xs text-gray-500"></span>
        ${recheckAllBtn}
        ${mergeBtn}
      </div>`;
  }

  // POST one session recheck; resolves to true when the server accepted it
  // (including the "already running" coalesce response).
  async function postRecheck(sessionId) {
    const res = await fetch(`/api/sessions/${sessionId}/recheck`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return true;
  }

  async function onListClick(e) {
    const toggle = e.target.closest('[data-campaign-toggle]');
    const retryBtn = e.target.closest('.campaign-retry-btn');
    const mergeBtn = e.target.closest('.campaign-merge-green-btn');
    const recheckBtn = e.target.closest('.campaign-recheck-btn');
    const recheckAllBtn = e.target.closest('.campaign-recheck-all-btn');
    if (recheckBtn) {
      const campaignId = Number(recheckBtn.dataset.campaign);
      recheckBtn.disabled = true;
      recheckBtn.textContent = 'Rechecking…';
      try {
        await postRecheck(recheckBtn.dataset.session);
      } catch (err) {
        alertMsg(`Re-run checks failed: ${err.message}`);
      }
      refreshCampaignDetail(campaignId).catch(() => {});
      return;
    }
    if (recheckAllBtn) {
      const campaignId = Number(recheckAllBtn.dataset.campaign);
      const sessions = (recheckAllBtn.dataset.sessions || '').split(',').filter(Boolean);
      recheckAllBtn.disabled = true;
      recheckAllBtn.textContent = 'Rechecking…';
      const statusEl = recheckAllBtn.closest('div')?.querySelector('.campaign-detail-status');
      let failed = 0;
      for (const sid of sessions) {
        try {
          await postRecheck(sid);
        } catch { failed++; }
        if (statusEl) statusEl.textContent = `Queued rechecks — ${failed ? `${failed} failed to queue, ` : ''}watching for results…`;
      }
      refreshCampaignDetail(campaignId).catch(() => {});
      return;
    }
    if (retryBtn) {
      const campaignId = Number(retryBtn.dataset.campaign);
      retryBtn.disabled = true;
      retryBtn.textContent = 'Retrying…';
      const res = await fetch(`/api/campaigns/${campaignId}/apps/${retryBtn.dataset.app}/retry`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alertMsg(`Retry failed: ${data.error || `HTTP ${res.status}`}`);
      }
      refreshCampaignDetail(campaignId).catch(() => {});
      return;
    }
    if (mergeBtn) {
      const campaignId = Number(mergeBtn.dataset.campaign);
      const ok = await confirmMsg({
        title: 'Merge all green?',
        message: 'Force-merge every campaign PR whose checks pass? Each merge triggers a production rebuild of that app.',
        confirmLabel: 'Merge all green',
        destructive: true,
      });
      if (!ok) return;
      mergeBtn.disabled = true;
      mergeBtn.textContent = 'Merging…';
      const statusEl = mergeBtn.closest('div')?.querySelector('.campaign-detail-status');
      if (statusEl) statusEl.textContent = 'Merging sequentially — this can take a while…';
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/merge-green`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const merged = (data.results || []).filter((r) => r.merged).length;
        const failed = (data.results || []).length - merged;
        alertMsg(`Merge-green done: ${merged} merged${failed ? `, ${failed} failed (see per-app rows)` : ''}.`);
      } catch (err) {
        alertMsg(`Merge-green failed: ${err.message}`);
      }
      loadCampaigns().catch(() => {});
      return;
    }
    if (toggle) {
      const id = Number(toggle.dataset.campaignToggle);
      const detail = document.querySelector(`[data-campaign-detail="${id}"]`);
      if (!detail) return;
      if (detail.classList.contains('hidden')) {
        EXPANDED.add(id);
        writeSubHash(id);
        refreshCampaignDetail(id).catch(() => {});
      } else {
        EXPANDED.delete(id);
        detail.classList.add('hidden');
        writeSubHash(EXPANDED.size ? Array.from(EXPANDED)[0] : null);
      }
    }
  }

  async function onSubmitCampaign() {
    const status = document.getElementById('admin-campaign-form-status');
    const show = (msg, ok) => {
      if (!status) return;
      status.textContent = msg;
      status.className = `text-xs ${ok ? 'text-green-500' : 'text-red-500 dark:text-red-400'}`;
      status.classList.remove('hidden');
    };
    const title = (document.getElementById('admin-campaign-title')?.value || '').trim();
    const instructions = (document.getElementById('admin-campaign-instructions')?.value || '').trim();
    const targetsRaw = (document.getElementById('admin-campaign-targets')?.value || '').trim();
    if (!title) return show('Title is required.', false);
    if (!instructions) return show('Instructions are required.', false);
    const targetFilter = targetsRaw
      ? targetsRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const btn = document.getElementById('admin-campaign-submit-btn');
    if (btn) btn.disabled = true;
    try {
      // Campaign proposals live on the self-hosted platform app's issues
      // surface; resolve its slug first.
      const meta = await fetchJson('/api/campaigns/meta');
      const slug = meta.data?.selfAppSlug;
      if (!slug) throw new Error('Platform self-app not found — is self-hosting configured?');
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'maintenance_campaign',
          title,
          payload: { instructions, ...(targetFilter ? { targetFilter } : {}) },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      show('Proposal opened on the platform app — the campaign starts when the vote passes (or an admin applies it).', true);
      for (const id of ['admin-campaign-title', 'admin-campaign-instructions', 'admin-campaign-targets']) {
        const el = document.getElementById(id);
        if (el) el.value = '';
      }
    } catch (err) {
      show(`Propose failed: ${err.message}`, false);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function markup() {
    const write = canWrite();
    return `
      <div id="admin-campaigns-root" class="${AdminUI.card} p-4">
        <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 class="${AdminUI.cardTitle}">Maintenance campaigns</h2>
          <div class="flex items-center gap-3">
            <button id="admin-refresh-campaigns" type="button" class="${AdminUI.btn.link} text-xs">Refresh</button>
            ${write ? `<button id="admin-new-campaign-btn" type="button" class="${AdminUI.btn.primary}">New campaign</button>` : ''}
          </div>
        </div>
        <p class="text-xs text-gray-500 mb-3">
          Fleet-wide platform maintenance. A campaign fans one set of AI instructions out across every app as its own PR;
          this list tracks per-app progress.
        </p>
        ${write ? `
        <div id="admin-campaign-form" class="hidden mb-4 rounded-lg bg-gray-100 dark:bg-gray-800 p-3 space-y-2">
          <input id="admin-campaign-title" type="text" maxlength="200"
            class="w-full rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm"
            placeholder="Campaign title — becomes each app's PR title">
          <textarea id="admin-campaign-instructions" rows="6" maxlength="20000"
            class="w-full rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm font-mono"
            placeholder="Instructions for the AI — what to change in each app, with code snippets where helpful. The AI reads each repo and applies these per-app."></textarea>
          <input id="admin-campaign-targets" type="text"
            class="w-full rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm font-mono"
            placeholder="Optional: comma-separated app slugs to target (blank = every app)">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs text-gray-500">Submitting opens a governance proposal on the platform app. The campaign starts when the vote passes, or when an admin applies the proposal.</p>
            <button id="admin-campaign-submit-btn" type="button" class="${AdminUI.btn.primary} shrink-0">Propose campaign</button>
          </div>
          <p id="admin-campaign-form-status" class="text-xs hidden"></p>
        </div>` : ''}
        <div id="admin-campaign-list" class="space-y-2"></div>
        <p id="admin-campaign-empty" class="text-sm text-gray-500 hidden">No campaigns yet.</p>
      </div>`;
  }

  return {
    render(sectionHost) {
      host = sectionHost;
      host.innerHTML = markup();

      EXPANDED.clear();
      const deep = readSubId();
      if (deep) EXPANDED.add(deep);

      document.getElementById('admin-campaign-list')
        ?.addEventListener('click', (e) => { onListClick(e).catch(() => {}); });
      document.getElementById('admin-refresh-campaigns')
        ?.addEventListener('click', () => { loadCampaigns().catch(() => {}); });
      document.getElementById('admin-new-campaign-btn')
        ?.addEventListener('click', () => {
          document.getElementById('admin-campaign-form')?.classList.toggle('hidden');
        });
      document.getElementById('admin-campaign-submit-btn')
        ?.addEventListener('click', () => { onSubmitCampaign().catch(() => {}); });

      loadCampaigns().catch(() => {});

      // Live progress while a fan-out runs: cheap per-campaign status poll,
      // but only for campaigns the admin has expanded.
      clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        if (!document.getElementById('admin-campaigns-root')) return;
        for (const id of EXPANDED) {
          // Skip if a merge-green is mid-flight in this detail (button
          // disabled) so the poll doesn't wipe the in-progress UI.
          const el = document.querySelector(`[data-campaign-detail="${id}"]`);
          if (el && el.querySelector('.campaign-merge-green-btn:disabled')) continue;
          refreshCampaignDetail(id).catch(() => {});
        }
      }, 8000);
    },

    destroy() {
      clearInterval(pollTimer);
      pollTimer = null;
      EXPANDED.clear();
      host = null;
    },
  };
})();

window.AdminCampaigns = AdminCampaigns;
