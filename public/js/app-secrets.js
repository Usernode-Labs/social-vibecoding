// Per-app secrets UI.
//
// Backend lives in src/services/app-secrets.js + src/services/app-manifest.js
// and src/routes/apps.js (REST endpoints). The vote-based proposal path
// rides the existing issues machinery (kind='secret_change').
//
// This module renders a modal listing the manifest-declared keys (read
// from each dapp's `dapp.json`), plus any orphan keys the dapp no longer
// declares. Admins can either set/clear values directly via PUT/DELETE
// or open a 'secret_change' issue (when they want community buy-in for a
// sensitive change). Non-admins only see the propose path. Either path
// triggers a fresh rebuildProduction once applied; the version pill in
// the header reflects deploy progress via the existing
// app_redeploy_status WS broadcast.
const Secrets = {
  currentSlug: null,

  init() {
    const close = document.getElementById('app-secrets-close');
    const modal = document.getElementById('app-secrets-modal');
    const redeploy = document.getElementById('app-secrets-redeploy');
    // Modal is the only piece this module hard-requires now. The entry-
    // point button moved to the dev-chat tab; AppView wires its click
    // to Secrets.openForCurrentApp() when that tab renders.
    if (!close || !modal) return;

    close.addEventListener('click', () => Secrets.close());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) Secrets.close();
    });
    redeploy?.addEventListener('click', async () => {
      if (!Secrets.currentSlug) return;
      Secrets.setStatus('Triggering redeploy…', 'info');
      try {
        const res = await fetch(`/api/apps/${Secrets.currentSlug}/redeploy`, { method: 'POST' });
        if (!res.ok) {
          const { error } = await res.json().catch(() => ({}));
          throw new Error(error || `HTTP ${res.status}`);
        }
        Secrets.setStatus('Redeploy started — watch the version pill.', 'ok');
      } catch (err) {
        Secrets.setStatus(`Redeploy failed: ${err.message}`, 'err');
      }
    });
  },

  // Convenience for callers (currently the dev-chat Edit panel) that
  // know "the current app" but don't track its slug locally.
  openForCurrentApp() {
    const slug = AppView.appData?.slug;
    if (slug) Secrets.open(slug);
  },

  // Legacy header-badge hook. The standalone red dot is gone — the
  // dev-chat tab's "App secrets" row now shows "N missing" inline
  // (see AppView.refreshDevChatSecretsState). Kept as a no-op so older
  // call-sites don't break; safe to delete once nothing references it.
  applyMissingBadge() { /* no-op */ },

  // Kept as a noop-ish hook so AppView.close() can keep calling it
  // unchanged; it just makes sure any open modal is dismissed when the
  // user navigates away from the app.
  hide() {
    Secrets.close();
  },

  // Re-render the dev-chat secrets row after a successful direct edit
  // so "N missing" / "N of M set" reflects the new state without
  // forcing a tab reload. Best-effort: if the dev-chat tab isn't
  // mounted (user is on App / Group Chat) the helper itself no-ops.
  notifyDevChatRefresh() {
    if (window.AppView && typeof AppView.refreshDevChatSecretsState === 'function') {
      AppView.refreshDevChatSecretsState();
    }
  },

  async open(slug) {
    Secrets.currentSlug = slug;
    const modal = document.getElementById('app-secrets-modal');
    const list = document.getElementById('app-secrets-list');
    if (!modal || !list) return;
    modal.classList.remove('hidden');
    list.innerHTML = '<p class="text-sm text-zinc-500">Loading…</p>';
    Secrets.setStatus('', '');
    try {
      const res = await fetch(`/api/apps/${slug}/secrets`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      Secrets.render(data);
    } catch (err) {
      list.innerHTML = `<p class="text-sm text-red-500">Failed to load: ${escapeHtml(err.message)}</p>`;
    }
  },

  close() {
    const modal = document.getElementById('app-secrets-modal');
    modal?.classList.add('hidden');
    Secrets.currentSlug = null;
  },

  render(data) {
    const list = document.getElementById('app-secrets-list');
    const footer = document.getElementById('app-secrets-footer');
    if (!list) return;
    const isAdmin = !!App.user?.isAdmin;
    // Footer contains the "redeploy now" shortcut, which hits
    // /api/apps/:slug/redeploy. For self-hosted apps that endpoint is
    // gated by refuseIfSelfHosted (the platform deploys via GitHub
    // Actions). The /api/apps/:slug/secrets response sets readOnly=true
    // for self-hosted apps; respect it here so admins don't get a
    // confusing 403 from a button that shouldn't have been offered.
    const showFooter = isAdmin && !data.readOnly;
    footer?.classList.toggle('hidden', !showFooter);

    if (!data.manifestKnown) {
      list.innerHTML = `
        <p class="text-sm text-zinc-500">
          No manifest snapshot yet. Once this app's first deploy completes the
          declared secrets show up here.
        </p>`;
      return;
    }
    if (!data.secrets || !data.secrets.length) {
      list.innerHTML = `
        <p class="text-sm text-zinc-500">
          This app's <code class="text-xs">dapp.json</code>
          doesn't declare any secrets. Add a
          <code class="text-xs">secrets</code> array to start using this panel.
        </p>`;
      return;
    }

    list.innerHTML = data.secrets.map((s) => Secrets.renderRow(s, isAdmin)).join('');

    list.querySelectorAll('[data-action="set"]').forEach((btn) => {
      btn.addEventListener('click', () => Secrets.handleSet(btn.dataset.key, btn.dataset.sensitive === '1'));
    });
    list.querySelectorAll('[data-action="clear"]').forEach((btn) => {
      btn.addEventListener('click', () => Secrets.handleClear(btn.dataset.key));
    });
    list.querySelectorAll('[data-action="propose-set"]').forEach((btn) => {
      btn.addEventListener('click', () => Secrets.handleProposeSet(btn.dataset.key, btn.dataset.sensitive === '1'));
    });
    list.querySelectorAll('[data-action="propose-clear"]').forEach((btn) => {
      btn.addEventListener('click', () => Secrets.handleProposeClear(btn.dataset.key));
    });
  },

  renderRow(s, isAdmin) {
    const requiredBadge = s.required
      ? `<span class="text-[0.65rem] uppercase font-bold text-red-500">required</span>`
      : '';
    const sensitiveBadge = s.sensitive
      ? `<span class="text-[0.65rem] uppercase font-bold text-amber-500" title="value never shown after save">sensitive</span>`
      : '';
    const orphanBadge = s.orphan
      ? `<span class="text-[0.65rem] uppercase font-bold text-zinc-500">orphan</span>`
      : '';

    let valueDisplay;
    if (s.hasValue) {
      const last4 = s.valueLast4 ? `…${escapeHtml(s.valueLast4)}` : '••••••••';
      valueDisplay = `<span class="font-mono text-xs text-emerald-600 dark:text-emerald-400">set ${last4}</span>`;
    } else if (s.required) {
      valueDisplay = `<span class="text-xs font-medium text-red-500">missing — deploys are blocked</span>`;
    } else if (s.default != null) {
      valueDisplay = `<span class="font-mono text-xs text-zinc-500">default: ${escapeHtml(s.default)}</span>`;
    } else {
      valueDisplay = `<span class="text-xs text-zinc-500">not set</span>`;
    }

    const setVerb = s.hasValue ? 'replace' : 'set';
    const sensitiveAttr = s.sensitive ? '1' : '0';
    // Direct path (admin only): filled violet for set/replace, red-outline
    // for clear — these slam the change in via PUT/DELETE.
    const directButtons = `
      <button data-action="set" data-key="${escapeAttr(s.key)}" data-sensitive="${sensitiveAttr}"
        class="text-xs px-2 py-1 rounded bg-violet-600 hover:bg-violet-500 text-white">${setVerb}</button>
      ${s.hasValue ? `<button data-action="clear" data-key="${escapeAttr(s.key)}"
        class="text-xs px-2 py-1 rounded border border-red-400 text-red-600 hover:bg-red-50 dark:hover:bg-red-950">clear</button>` : ''}
    `;
    // Vote path (everyone): muted outline styling so admins reach for
    // direct first by default, but can opt into the vote flow per row.
    const proposeButtons = `
      <button data-action="propose-set" data-key="${escapeAttr(s.key)}" data-sensitive="${sensitiveAttr}"
        class="text-xs px-2 py-1 rounded border border-violet-400 text-violet-600 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950">propose ${setVerb}</button>
      ${s.hasValue ? `<button data-action="propose-clear" data-key="${escapeAttr(s.key)}"
        class="text-xs px-2 py-1 rounded border border-red-300 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950">propose clear</button>` : ''}
    `;
    const actions = isAdmin
      ? `${directButtons}<span class="inline-block w-px h-4 bg-zinc-300 dark:bg-zinc-700 mx-1 self-center" aria-hidden="true"></span>${proposeButtons}`
      : proposeButtons;

    return `
      <div class="py-3 border-b border-zinc-200 dark:border-zinc-800 last:border-b-0">
        <div class="flex items-center gap-2 mb-1 flex-wrap">
          <code class="text-sm font-mono font-bold text-zinc-900 dark:text-zinc-100">${escapeHtml(s.key)}</code>
          ${requiredBadge}
          ${sensitiveBadge}
          ${orphanBadge}
        </div>
        ${s.description ? `<p class="text-xs text-zinc-500 mb-2">${escapeHtml(s.description)}</p>` : ''}
        <div class="flex items-center gap-2 flex-wrap">
          ${valueDisplay}
          <span class="flex-1"></span>
          ${actions}
        </div>
      </div>`;
  },

  async handleSet(key, sensitive) {
    const value = window.prompt(`New value for ${key}` + (sensitive ? ' (sensitive)' : ''));
    if (value == null || !value.length) return;
    Secrets.setStatus(`Setting ${key}…`, 'info');
    try {
      const res = await fetch(`/api/apps/${Secrets.currentSlug}/secrets/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        throw new Error(error || `HTTP ${res.status}`);
      }
      Secrets.setStatus(`Saved ${key}.`, 'ok');
      Secrets.notifyDevChatRefresh();
      await Secrets.open(Secrets.currentSlug);
    } catch (err) {
      Secrets.setStatus(`Failed to set ${key}: ${err.message}`, 'err');
    }
  },

  async handleClear(key) {
    if (!window.confirm(`Clear ${key}?`)) return;
    Secrets.setStatus(`Clearing ${key}…`, 'info');
    try {
      const res = await fetch(`/api/apps/${Secrets.currentSlug}/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        throw new Error(error || `HTTP ${res.status}`);
      }
      Secrets.setStatus(`Cleared ${key}.`, 'ok');
      Secrets.notifyDevChatRefresh();
      await Secrets.open(Secrets.currentSlug);
    } catch (err) {
      Secrets.setStatus(`Failed to clear ${key}: ${err.message}`, 'err');
    }
  },

  async handleProposeSet(key, sensitive) {
    const value = window.prompt(`Propose setting ${key}` + (sensitive ? ' (sensitive)' : '') +
      `\n\nA majority of active users must vote up before this applies.`);
    if (value == null || !value.length) return;
    Secrets.setStatus(`Opening proposal for ${key}…`, 'info');
    try {
      const res = await fetch(`/api/apps/${Secrets.currentSlug}/issues`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'secret_change',
          payload: { key, action: 'set', value },
        }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        throw new Error(error || `HTTP ${res.status}`);
      }
      Secrets.setStatus(`Proposal opened. Vote in the group chat tab.`, 'ok');
    } catch (err) {
      Secrets.setStatus(`Failed: ${err.message}`, 'err');
    }
  },

  async handleProposeClear(key) {
    if (!window.confirm(`Propose removing ${key}?`)) return;
    Secrets.setStatus(`Opening proposal for ${key}…`, 'info');
    try {
      const res = await fetch(`/api/apps/${Secrets.currentSlug}/issues`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'secret_change',
          payload: { key, action: 'delete' },
        }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        throw new Error(error || `HTTP ${res.status}`);
      }
      Secrets.setStatus(`Proposal opened. Vote in the group chat tab.`, 'ok');
    } catch (err) {
      Secrets.setStatus(`Failed: ${err.message}`, 'err');
    }
  },

  setStatus(msg, level) {
    const el = document.getElementById('app-secrets-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
    el.classList.remove('text-zinc-500', 'text-emerald-500', 'text-red-500');
    if (level === 'ok') el.classList.add('text-emerald-500');
    else if (level === 'err') el.classList.add('text-red-500');
    else el.classList.add('text-zinc-500');
  },
};

document.addEventListener('DOMContentLoaded', () => Secrets.init());
window.Secrets = Secrets;
