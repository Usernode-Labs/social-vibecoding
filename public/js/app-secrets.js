// Per-app secrets UI.
//
// Backend lives in src/services/app-secrets.js + src/services/app-manifest.js
// and src/routes/apps.js (REST endpoints). The vote-based proposal path
// rides the existing issues machinery (kind='secret_change').
//
// This module renders a modal listing the manifest-declared keys, plus
// any orphan keys the dapp no longer declares. Admins set/clear values
// directly via PUT/DELETE; non-admins POST a 'secret_change' issue that
// other users can vote on. Either path triggers a fresh
// rebuildProduction; the version pill in the header reflects deploy
// progress via the existing app_redeploy_status WS broadcast.
const Secrets = {
  currentSlug: null,

  init() {
    const btn = document.getElementById('app-secrets-btn');
    const close = document.getElementById('app-secrets-close');
    const modal = document.getElementById('app-secrets-modal');
    const redeploy = document.getElementById('app-secrets-redeploy');
    if (!btn || !close || !modal) return;

    btn.addEventListener('click', () => {
      const slug = AppView.appData?.slug;
      if (!slug) return;
      Secrets.open(slug);
    });
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

  // Toggle the header button's red badge based on the current app's
  // missingSecrets list. Called from app.js whenever app data refreshes.
  applyMissingBadge(missingSecrets) {
    const badge = document.getElementById('app-secrets-badge');
    if (!badge) return;
    badge.classList.toggle('hidden', !(Array.isArray(missingSecrets) && missingSecrets.length));
  },

  // Show the header button (called by AppView.open)
  show() {
    document.getElementById('app-secrets-btn')?.classList.remove('hidden');
  },
  // Hide the header button + close any open modal (called by AppView.close)
  hide() {
    document.getElementById('app-secrets-btn')?.classList.add('hidden');
    Secrets.close();
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
    footer?.classList.toggle('hidden', !isAdmin);

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
          This app's <code class="text-xs">social-vibecoding.json</code>
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
    let actions;
    if (isAdmin) {
      actions = `
        <button data-action="set" data-key="${escapeAttr(s.key)}" data-sensitive="${sensitiveAttr}"
          class="text-xs px-2 py-1 rounded bg-violet-600 hover:bg-violet-500 text-white">${setVerb}</button>
        ${s.hasValue ? `<button data-action="clear" data-key="${escapeAttr(s.key)}"
          class="text-xs px-2 py-1 rounded border border-red-400 text-red-600 hover:bg-red-50 dark:hover:bg-red-950">clear</button>` : ''}
      `;
    } else {
      actions = `
        <button data-action="propose-set" data-key="${escapeAttr(s.key)}" data-sensitive="${sensitiveAttr}"
          class="text-xs px-2 py-1 rounded bg-violet-600 hover:bg-violet-500 text-white">propose ${setVerb}</button>
        ${s.hasValue ? `<button data-action="propose-clear" data-key="${escapeAttr(s.key)}"
          class="text-xs px-2 py-1 rounded border border-red-400 text-red-600 hover:bg-red-50 dark:hover:bg-red-950">propose clear</button>` : ''}
      `;
    }

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
