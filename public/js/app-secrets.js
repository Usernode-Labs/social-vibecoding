// Per-app secrets UI — and, for the platform's own row, its "Platform
// variables" panel. One modal, two scopes.
//
// Backend lives in src/services/app-secrets.js + src/services/app-manifest.js
// and src/routes/apps.js (REST endpoints). The vote-based proposal path
// rides the existing issues machinery (kind='secret_change').
//
// This module renders a modal listing the manifest-declared keys (read
// from each dapp's `dapp.json`), plus any orphan keys the dapp no longer
// declares. Admins can either set/clear values directly via PUT/DELETE
// or open a 'secret_change' issue (when they want community buy-in for a
// sensitive change). Non-admins only see the propose path.
//
// The response's `scope` picks the semantics, and they differ in the one
// way a user has to know about:
//   'app'      — applying triggers a fresh rebuildProduction; the version
//                pill reflects deploy progress via the existing
//                app_redeploy_status WS broadcast, and the footer offers
//                "redeploy now".
//   'platform' — nothing is rebuilt. The value is materialized by the
//                platform's next deploy, so the panel says so up front and
//                there is no redeploy shortcut to offer. Rows additionally
//                carry `state` (set / unset / managed / orphan), a `group`
//                heading, and `unwritable` for the keys the deploy owns —
//                which get no controls at all, since the server refuses
//                both the direct write and the proposal.
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

  // Row-state badges, for the platform-variables view. The server sends
  // `state` (set / unset / managed / orphan) and the badge is the whole
  // reason the four states are worth distinguishing: "not set" falling back
  // to a committed default and "deploy-managed, not yours to set" look
  // identical without it.
  STATE_BADGES: {
    set: { label: 'Set', cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
    unset: { label: 'Not set', cls: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400' },
    managed: { label: 'Deploy-managed', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
    orphan: { label: 'No longer declared', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
  },

  render(data) {
    const list = document.getElementById('app-secrets-list');
    const footer = document.getElementById('app-secrets-footer');
    const title = document.getElementById('app-secrets-title');
    const subtitle = document.getElementById('app-secrets-subtitle');
    if (!list) return;
    // View-only admins can SEE the secrets list (gated on isAdmin server-
    // side) but only full admins get the direct-write fast path — the
    // "Set/Replace/Clear" buttons and the "redeploy now" footer all gate
    // on canAdminWrite (issue #311). Everyone else still gets the vote-
    // based propose flow.
    const canWrite = !!App.user?.canAdminWrite;
    // The platform's own variables are the same panel with different
    // semantics: they reach the process through the platform's next DEPLOY,
    // not through a rebuild of this container, and there is no "redeploy
    // now" to offer (POST /redeploy refuses the self-app row).
    const isPlatform = data.scope === 'platform';
    const showFooter = canWrite && data.redeployable !== false;
    footer?.classList.toggle('hidden', !showFooter);

    if (title) {
      title.textContent = isPlatform ? 'Platform variables' : 'App secrets';
    }
    if (subtitle) {
      subtitle.innerHTML = isPlatform
        ? 'The platform\'s own environment variables, declared in its '
          + '<code class="text-xs">dapp.json</code>. '
          + '<span class="font-semibold text-zinc-700 dark:text-zinc-300">A change here is not live '
          + 'immediately — it is applied by the platform\'s next deploy.</span>'
        : 'Environment variables this app declares in <code class="text-xs">dapp.json</code>.';
    }

    if (!data.manifestKnown) {
      list.innerHTML = `
        <p class="text-sm text-zinc-500">
          No manifest snapshot yet. Once this app's first deploy completes the
          declared secrets show up here.
        </p>`;
      return;
    }
    if (!data.secrets || !data.secrets.length) {
      list.innerHTML = isPlatform
        ? `<p class="text-sm text-zinc-500">
             No platform variables are declared yet. Add a
             <code class="text-xs">platform_env</code> block to the platform's
             <code class="text-xs">dapp.json</code>.
           </p>`
        : `<p class="text-sm text-zinc-500">
             This app's <code class="text-xs">dapp.json</code>
             doesn't declare any secrets. Add a
             <code class="text-xs">secrets</code> array to start using this panel.
           </p>`;
      return;
    }

    // Platform variables arrive pre-ordered by group (the server sinks the
    // groups nobody can act on to the bottom), so render the group headings
    // in first-seen order rather than re-sorting here.
    if (isPlatform) {
      const groups = [];
      const byGroup = new Map();
      for (const s of data.secrets) {
        const g = s.group || 'General';
        if (!byGroup.has(g)) { byGroup.set(g, []); groups.push(g); }
        byGroup.get(g).push(s);
      }
      list.innerHTML = groups.map((g) => `
        <div class="mb-3">
          <h3 class="text-xs uppercase tracking-wide text-zinc-500 mb-1">${escapeHtml(g)}</h3>
          ${byGroup.get(g).map((s) => Secrets.renderRow(s, canWrite)).join('')}
        </div>`).join('');
    } else {
      list.innerHTML = data.secrets.map((s) => Secrets.renderRow(s, canWrite)).join('');
    }

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

  renderRow(s, canWrite) {
    const requiredBadge = s.required
      ? `<span class="text-[0.65rem] uppercase font-bold text-red-500">required</span>`
      : '';
    const sensitiveBadge = s.sensitive
      ? `<span class="text-[0.65rem] uppercase font-bold text-amber-500" title="value never shown after save">sensitive</span>`
      : '';
    const orphanBadge = s.orphan
      ? `<span class="text-[0.65rem] uppercase font-bold text-zinc-500">orphan</span>`
      : '';
    // Present only on the platform-variables view; ordinary app secrets
    // send no `state` and keep exactly the badges they always had.
    const badge = s.state && Secrets.STATE_BADGES[s.state];
    const stateBadge = badge
      ? `<span class="rounded px-1.5 py-0.5 text-[0.6rem] font-medium ${badge.cls}">${badge.label}</span>`
      : '';

    let valueDisplay;
    if (s.hasValue && s.value != null) {
      // A non-private platform variable whose plaintext the server was
      // willing to return (admins only). Showing it in full is the point of
      // marking a variable non-private.
      valueDisplay = `<code class="text-xs font-mono text-zinc-700 dark:text-zinc-300 break-all">${escapeHtml(s.value)}</code>`;
    } else if (s.hasValue && s.private && s.state) {
      valueDisplay = '<span class="text-xs text-zinc-500 font-mono">•••••••• (private — never displayed)</span>';
    } else if (s.hasValue && s.state === 'set' && !s.private && s.valueLast4 == null) {
      // Stored, but the plaintext couldn't be decrypted (rotated
      // JWT_SECRET, corrupt row). listView() degrades to this rather than
      // erroring the whole panel, so say so instead of rendering "set".
      valueDisplay = '<span class="text-xs text-amber-600 dark:text-amber-400">set, but the stored value could not be read</span>';
    } else if (s.hasValue) {
      const last4 = s.valueLast4 ? `…${escapeHtml(s.valueLast4)}` : '••••••••';
      valueDisplay = `<span class="font-mono text-xs text-emerald-600 dark:text-emerald-400">set ${last4}</span>`;
    } else if (s.required && !s.unwritable) {
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
    // An `unwritable` row gets NEITHER path. Its value comes from a GitHub
    // secret at deploy time and the server refuses both the direct write and
    // the proposal, so a button here could only ever produce an error — or,
    // worse, a vote that can't be honoured. Offering none is the honest UI.
    const actions = s.unwritable
      ? ''
      : (canWrite
        ? `${directButtons}<span class="inline-block w-px h-4 bg-zinc-300 dark:bg-zinc-700 mx-1 self-center" aria-hidden="true"></span>${proposeButtons}`
        : proposeButtons);

    return `
      <div class="py-3 border-b border-zinc-200 dark:border-zinc-800 last:border-b-0">
        <div class="flex items-center gap-2 mb-1 flex-wrap">
          <code class="text-sm font-mono font-bold text-zinc-900 dark:text-zinc-100">${escapeHtml(s.key)}</code>
          ${stateBadge}
          ${requiredBadge}
          ${sensitiveBadge}
          ${orphanBadge}
        </div>
        ${s.description ? `<p class="text-xs text-zinc-500 mb-2">${escapeHtml(s.description)}</p>` : ''}
        ${s.unwritable ? `<p class="text-xs text-zinc-500 mb-2">
          Set by the deploy from a GitHub secret. It can't be edited here.</p>` : ''}
        ${s.state === 'orphan' ? `<p class="text-xs text-amber-600 dark:text-amber-400 mb-2">
          No longer declared in <code class="text-[0.65rem]">dapp.json</code>. Its value is kept so a
          rollback still works — clear it once you're sure.</p>` : ''}
        <div class="flex items-center gap-2 flex-wrap">
          ${valueDisplay}
          <span class="flex-1"></span>
          ${actions}
        </div>
      </div>`;
  },

  async handleSet(key, sensitive) {
    const value = await PlatformUI.prompt({
      title: `Set ${key}`,
      message: sensitive ? 'This value is sensitive — it is encrypted at rest and never shown again.' : undefined,
      placeholder: 'value',
      confirmLabel: 'Save',
    });
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
    if (!await PlatformUI.confirm({ title: `Clear ${key}?`, confirmLabel: 'Clear', danger: true })) return;
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
    const value = await PlatformUI.prompt({
      title: `Propose setting ${key}`,
      message: (sensitive ? 'This value is sensitive. ' : '') + 'A majority of active users must vote up before this applies.',
      placeholder: 'value',
      confirmLabel: 'Propose',
    });
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
    if (!await PlatformUI.confirm({ title: `Propose removing ${key}?`, confirmLabel: 'Propose', danger: true })) return;
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
