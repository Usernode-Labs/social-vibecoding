// Admin & moderation console (#818) — the full-page SPA screen behind the
// header shield icon. #588 shipped the icon plus a "Coming soon"
// placeholder; this module is the real console. Hash route
// #admin[/section], hosted in #admin-screen / #admin-root (index.html) and
// mounted/unmounted by App.navigateToAdminConsole / App._exitAdminConsole
// (public/js/app.js), the same shape as the Challenges / Profile screens.
//
// It reorganizes the standalone /admin page's sections (public/admin.html:
// Operations overview, LLM spend limits, Activation codes, Users) plus the
// /admin-features viewer (public/js/admin-features.js) into one page with
// a navigation menu — a fixed sidebar on md+ viewports, a horizontally
// scrollable tab strip below md (the Dev board's mobile kanban-tabs
// pattern, #814). Every data endpoint is an EXISTING /api/admin/* route,
// enforced server-side by adminMiddleware (reads) and requireAdminWrite
// (mutations) — this module adds no new capabilities and no new endpoints;
// the legacy standalone pages keep working unchanged.
//
// Permissions: the page itself is reachable for anyone with
// App.user.isAdmin (full AND view-only admins — the navigation gate lives
// in app.js). Write controls render only when App.user.canAdminWrite is
// true; view-only admins get read-only labels plus the amber banner,
// mirroring public/admin.html's CAN_WRITE behaviour (issue #311). The
// "View as non-admin" preview masks both flags before this module can read
// them (see the boot masking in app.js), so no extra handling is needed
// here. Never gated on USERNODE_ENV — identical in staging and production.

const AdminConsole = {
  _open: false,
  _section: 'overview',
  _menusWired: false,

  // In-SPA sections. Keys are the #admin/<key> hash segments.
  SECTIONS: [
    { key: 'overview', label: 'Overview' },
    { key: 'users', label: 'Users' },
    { key: 'codes', label: 'Activation codes' },
    { key: 'limits', label: 'Spend limits' },
    { key: 'features', label: 'Submitted features' },
    { key: 'platform-env', label: 'Platform variables' },
    { key: 'db-export', label: 'Database export' },
  ],

  // Heavier admin surfaces that stay standalone full-browser pages for
  // now (each is its own sizable app — see the spec's deferred work).
  // Rendered as external links at the bottom of the menu.
  TOOLS: [
    { href: '/dashboard', label: 'Analytics dashboard' },
    { href: '/debug', label: 'Merge debug' },
    { href: '/gallery', label: 'Gallery' },
    { href: '/status', label: 'Platform status' },
  ],

  isOpen() { return AdminConsole._open; },

  // Single write gate for every mutating control on the page. View-only
  // admins (is_admin && admin_readonly) carry isAdmin but not
  // canAdminWrite — they see everything read-only.
  canWrite() { return !!(window.App && App.user && App.user.canAdminWrite); },

  open(section) {
    AdminConsole._open = true;
    const valid = AdminConsole.SECTIONS.some((s) => s.key === section);
    AdminConsole._renderShell();
    // Deep-linked section wins; otherwise keep the last-visited section
    // (instant repaint on re-entry), defaulting to Overview.
    AdminConsole.setSection(
      valid ? section : (AdminConsole._section || 'overview'),
      { writeHash: false }
    );
  },

  close() {
    AdminConsole._open = false;
  },

  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  // Safe fetch+parse for the admin endpoints (ported from
  // public/admin.html). Returns { status, ok, data } and NEVER throws: a
  // non-OK response, a non-JSON content-type, or a body that fails to
  // parse all yield data === null. This matters when an /api/* route
  // falls through to the SPA shell on auth loss and returns 200 + HTML —
  // res.json() on that throws "Unexpected token '<'".
  async fetchJson(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return { status: res.status, ok: false, data: null };
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        return { status: res.status, ok: true, data: null };
      }
      try {
        return { status: res.status, ok: true, data: await res.json() };
      } catch {
        return { status: res.status, ok: true, data: null };
      }
    } catch {
      return { status: 0, ok: false, data: null };
    }
  },

  // The DB and API are cents-native; the UI presents dollars. Convert at
  // the edge only (ported from public/admin.html).
  centsToDollars(c) {
    return (Number(c) / 100).toFixed(2);
  },
  parseDollarsToCents(label, raw) {
    if (raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${label} must be a non-negative dollar amount or blank.`);
    }
    return Math.round(n * 100);
  },

  _alert(message) {
    if (window.PlatformUI?.alert) {
      PlatformUI.alert({ title: 'Admin', message: String(message) });
    } else {
      try { window.alert(message); } catch {}
    }
  },

  async _confirm(opts) {
    if (window.PlatformUI?.confirm) return PlatformUI.confirm(opts);
    try {
      return window.confirm([opts.title, opts.message].filter(Boolean).join('\n\n'));
    } catch { return false; }
  },

  // ── Shell: menu (sidebar / tab strip) + content host ──────────────────

  _navItemsHtml(mode) {
    // mode 'side' → vertical sidebar rows; mode 'tabs' → the mobile strip.
    const active = AdminConsole._section;
    const items = AdminConsole.SECTIONS.map((s) => {
      const isActive = s.key === active;
      const cls = mode === 'side'
        ? 'admin-nav-item block w-full text-left rounded-lg px-3 py-2 text-sm font-medium transition-colors '
          + (isActive
            ? 'bg-violet-600/10 text-violet-600 dark:text-violet-400'
            : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800')
        : 'admin-nav-item shrink-0 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors '
          + (isActive
            ? 'border-violet-500 text-violet-600 dark:text-violet-400'
            : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300');
      return `<button type="button" role="tab" aria-selected="${isActive ? 'true' : 'false'}"
        data-admin-section="${s.key}" class="${cls}">${AdminConsole.esc(s.label)}</button>`;
    }).join('');
    const toolCls = mode === 'side'
      ? 'flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-zinc-500 hover:text-violet-500 dark:hover:text-violet-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
      : 'shrink-0 flex items-center gap-1 px-3 py-2 text-sm text-zinc-500 hover:text-violet-500 whitespace-nowrap border-b-2 border-transparent';
    const tools = AdminConsole.TOOLS.map((t) =>
      `<a href="${t.href}" target="_blank" rel="noopener" class="${toolCls}">
        <span>${AdminConsole.esc(t.label)}</span>
        <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
      </a>`).join('');
    if (mode === 'side') {
      return `${items}
        <div class="mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800">
          <div class="px-3 pb-1 text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">More tools</div>
          ${tools}
        </div>`;
    }
    return items + tools;
  },

  _renderShell() {
    const root = document.getElementById('admin-root');
    if (!root) return;
    const viewOnly = !AdminConsole.canWrite();
    root.innerHTML = `
      <div class="md:flex md:items-start md:gap-6">
        <!-- Desktop sidebar menu -->
        <nav id="admin-nav-desktop" aria-label="Admin sections"
             class="hidden md:block md:w-56 shrink-0 space-y-1">
          ${AdminConsole._navItemsHtml('side')}
        </nav>
        <div class="flex-1 min-w-0">
          <!-- Mobile tab strip (the Dev board kanban-tabs pattern, #814):
               only the strip itself scrolls sideways. -->
          <nav id="admin-nav-mobile" role="tablist" aria-label="Admin sections"
               class="md:hidden flex items-stretch gap-1 mb-3 -mx-4 px-4 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
            ${AdminConsole._navItemsHtml('tabs')}
          </nav>
          <!-- View-only admin banner (issue #311), same copy as /admin. -->
          <div id="admin-view-only-banner" class="${viewOnly ? '' : 'hidden '}bg-amber-100 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-200 rounded-lg px-4 py-3 mb-4 text-sm">
            <span class="font-semibold">View-only — read access only.</span>
            You can see every admin surface but can't make changes. Mutating controls are hidden.
          </div>
          <div id="admin-section-content" class="pb-8"></div>
        </div>
      </div>
      <!-- Temporary password modal (issue #282): the reset response is the
           only time the plaintext exists — shown once, never persisted. -->
      <div id="admin-temp-pw-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div class="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-md shadow-xl border border-zinc-200 dark:border-zinc-800">
          <h2 class="text-lg font-bold mb-1 text-zinc-900 dark:text-zinc-100">Temporary password</h2>
          <p class="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            Give this to <span id="admin-temp-pw-username" class="font-medium text-zinc-800 dark:text-zinc-200"></span> out-of-band (chat, in person). They use it as their password to log in, then set their own from Settings → Change password. It signs them out everywhere and <span class="font-medium">won't be shown again</span>.
          </p>
          <div class="flex gap-2">
            <code id="admin-temp-pw-value" class="flex-1 min-w-0 break-all rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-900 dark:text-zinc-100"></code>
            <button id="admin-temp-pw-copy" class="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors">Copy</button>
          </div>
          <button id="admin-temp-pw-close" class="mt-4 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">Done</button>
        </div>
      </div>`;

    root.querySelectorAll('[data-admin-section]').forEach((btn) => {
      btn.addEventListener('click', () => AdminConsole.setSection(btn.dataset.adminSection));
    });
  },

  setSection(key, opts) {
    if (!AdminConsole.SECTIONS.some((s) => s.key === key)) key = 'overview';
    AdminConsole._section = key;
    // Repaint the active state in both menus without rebuilding the shell.
    const root = document.getElementById('admin-root');
    if (!root || !document.getElementById('admin-section-content')) {
      AdminConsole._renderShell();
    } else {
      const sideHost = document.getElementById('admin-nav-desktop');
      const tabHost = document.getElementById('admin-nav-mobile');
      if (sideHost) sideHost.innerHTML = AdminConsole._navItemsHtml('side');
      if (tabHost) tabHost.innerHTML = AdminConsole._navItemsHtml('tabs');
      root.querySelectorAll('[data-admin-section]').forEach((btn) => {
        btn.addEventListener('click', () => AdminConsole.setSection(btn.dataset.adminSection));
      });
    }
    if (!opts || opts.writeHash !== false) AdminConsole._writeHash(key);
    AdminConsole._renderSection();
  },

  // Section switches update the address without polluting history —
  // replaceState, and only while we're actually on the #admin route (the
  // Leaderboard._setSub pattern). Entering/leaving the page still gets a
  // real history entry via normal hash navigation.
  _writeHash(key) {
    const target = key === 'overview' ? '#admin' : `#admin/${key}`;
    if (location.hash.startsWith('#admin') && location.hash !== target) {
      history.replaceState(null, '', target);
    }
  },

  _renderSection() {
    const host = document.getElementById('admin-section-content');
    if (!host) return;
    switch (AdminConsole._section) {
      case 'users': return AdminConsole.renderUsersSection(host);
      case 'codes': return AdminConsole.renderCodesSection(host);
      case 'limits': return AdminConsole.renderLimitsSection(host);
      case 'features': return AdminConsole.renderFeaturesSection(host);
      case 'platform-env': return AdminConsole.renderPlatformEnvSection(host);
      case 'db-export': return AdminConsole.renderDbExportSection(host);
      default: return AdminConsole.renderOverviewSection(host);
    }
  },

  // ── Overview (operations snapshot) ─────────────────────────────────────

  renderOverviewSection(host) {
    host.innerHTML = `
      <div class="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 border border-zinc-200 dark:border-zinc-800">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold">Operations</h2>
          <button id="admin-refresh-overview" class="text-xs text-zinc-400 hover:text-violet-400">Refresh</button>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
            <div class="text-xs uppercase tracking-wide text-zinc-500">Stuck apps</div>
            <div id="admin-overview-stuck" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
            <div class="text-xs uppercase tracking-wide text-zinc-500">LLM spend today</div>
            <div id="admin-overview-llm" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
            <div class="text-xs uppercase tracking-wide text-zinc-500">Orphan workers</div>
            <div id="admin-overview-orphan" class="text-2xl font-bold mt-1">—</div>
          </div>
        </div>
        <div id="admin-overview-details" class="space-y-3 text-sm">
          <p class="text-xs text-zinc-500">Loading…</p>
        </div>
      </div>`;
    document.getElementById('admin-refresh-overview')
      .addEventListener('click', () => AdminConsole.loadOverview());
    AdminConsole.loadOverview();
  },

  async loadOverview() {
    // status.gather can take a moment; the tiles show em-dashes until it
    // lands, and only this section blocks — never the whole page.
    const { data } = await AdminConsole.fetchJson('/api/admin/overview');
    if (!data || typeof data !== 'object') return;
    if (AdminConsole._section !== 'overview') return; // navigated away mid-fetch
    AdminConsole._paintOverview(data);
  },

  _paintOverview(data) {
    const esc = AdminConsole.esc;
    const stuck = data.stuckApps || [];
    const orphans = data.orphanWorkers || [];
    const llm = data.llmToday || { totalSpendCents: 0, users: [] };

    const stuckEl = document.getElementById('admin-overview-stuck');
    const orphanEl = document.getElementById('admin-overview-orphan');
    const llmEl = document.getElementById('admin-overview-llm');
    const detail = document.getElementById('admin-overview-details');
    if (!stuckEl || !detail) return;
    stuckEl.textContent = String(stuck.length);
    orphanEl.textContent = String(orphans.length);
    llmEl.textContent = `$${(llm.totalSpendCents / 100).toFixed(2)}`;

    detail.innerHTML = '';
    if (stuck.length) {
      const sec = document.createElement('div');
      sec.innerHTML = `
        <div class="text-xs uppercase tracking-wide text-zinc-500 mb-1">Stuck apps</div>
        <ul class="space-y-1">
          ${stuck.map((a) => `
            <li class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-2 rounded bg-zinc-100 dark:bg-zinc-800">
              <span>
                <span class="font-mono">${esc(a.slug)}</span>
                <span class="text-xs text-zinc-500">(${esc(a.dbStatus)}, by ${esc(a.createdBy || '—')})</span>
              </span>
              <span class="text-xs text-zinc-500">${new Date(a.createdAt).toLocaleString()}</span>
            </li>`).join('')}
        </ul>`;
      detail.appendChild(sec);
    }
    if (orphans.length) {
      const sec = document.createElement('div');
      sec.innerHTML = `
        <div class="text-xs uppercase tracking-wide text-zinc-500 mb-1">Orphan workers</div>
        <ul class="space-y-1">
          ${orphans.map((w) => `
            <li class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-2 rounded bg-zinc-100 dark:bg-zinc-800">
              <span>
                <span class="font-mono">${esc(w.name)}</span>
                <span class="text-xs text-zinc-500">
                  ${w.appSlug ? `app ${esc(w.appSlug)}` : 'no app'}
                  · up ${Math.round((w.uptimeSeconds || 0) / 60)}m
                  ${w.sessionArchived ? '· session archived' : ''}
                </span>
              </span>
            </li>`).join('')}
        </ul>`;
      detail.appendChild(sec);
    }
    if (llm.users?.length) {
      const sec = document.createElement('div');
      const rows = llm.users.slice(0, 5).map((u) =>
        `<li class="flex items-center justify-between gap-3 p-2 rounded bg-zinc-100 dark:bg-zinc-800">
          <span>${esc(u.username)}</span>
          <span class="text-xs font-mono text-zinc-400">$${(u.costCents / 100).toFixed(2)}</span>
        </li>`).join('');
      sec.innerHTML = `
        <div class="text-xs uppercase tracking-wide text-zinc-500 mb-1">Top LLM spenders today</div>
        <ul class="space-y-1">${rows}</ul>`;
      detail.appendChild(sec);
    }
    if (!detail.children.length) {
      detail.innerHTML = '<p class="text-xs text-zinc-500">All clear — no stuck apps, no orphan workers, no LLM spend recorded today.</p>';
    }
  },

  // ── Spend limits ────────────────────────────────────────────────────────

  renderLimitsSection(host) {
    const canWrite = AdminConsole.canWrite();
    const dis = canWrite ? '' : 'disabled';
    host.innerHTML = `
      <div class="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 border border-zinc-200 dark:border-zinc-800">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold">LLM Spend Limits</h2>
          <span class="text-xs text-zinc-500">USD · resets midnight UTC</span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <label class="block">
            <span class="text-xs uppercase tracking-wide text-zinc-500">Default per-user daily cap</span>
            <div class="relative mt-1">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-500 pointer-events-none">$</span>
              <input id="admin-limit-user" type="number" min="0" step="0.01" inputmode="decimal" ${dis}
                class="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 pl-6 pr-3 py-2 text-sm font-mono disabled:opacity-60"
                placeholder="25.00">
            </div>
          </label>
          <label class="block">
            <span class="text-xs uppercase tracking-wide text-zinc-500">Global daily cap</span>
            <div class="relative mt-1">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-500 pointer-events-none">$</span>
              <input id="admin-limit-global" type="number" min="0" step="0.01" inputmode="decimal" ${dis}
                class="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 pl-6 pr-3 py-2 text-sm font-mono disabled:opacity-60"
                placeholder="200.00">
            </div>
          </label>
          <label class="block">
            <span class="text-xs uppercase tracking-wide text-zinc-500" title="Funds platform-driven merge-conflict / sync-with-main resolution turns">System tokens daily cap</span>
            <div class="relative mt-1">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-500 pointer-events-none">$</span>
              <input id="admin-limit-system" type="number" min="0" step="0.01" inputmode="decimal" ${dis}
                class="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 pl-6 pr-3 py-2 text-sm font-mono disabled:opacity-60"
                placeholder="25.00">
            </div>
          </label>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs text-zinc-500">Per-user overrides live in the Users section; these are the platform defaults.</p>
          ${canWrite ? '<button id="admin-save-limits-btn" class="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors">Save</button>' : ''}
        </div>
        <p id="admin-limits-status" class="text-xs mt-2 hidden"></p>
      </div>`;
    document.getElementById('admin-save-limits-btn')
      ?.addEventListener('click', () => AdminConsole.saveLimits());
    AdminConsole.loadLimits();
  },

  async loadLimits() {
    const { data } = await AdminConsole.fetchJson('/api/admin/limits');
    if (!data || typeof data !== 'object') return;
    AdminConsole._fillLimits(data);
  },

  _fillLimits(data) {
    const u = document.getElementById('admin-limit-user');
    const g = document.getElementById('admin-limit-global');
    const s = document.getElementById('admin-limit-system');
    if (!u) return;
    u.value = AdminConsole.centsToDollars(data.user_daily_limit_cents);
    g.value = AdminConsole.centsToDollars(data.global_daily_limit_cents);
    s.value = AdminConsole.centsToDollars(data.system_tokens_daily_limit_cents);
  },

  async saveLimits() {
    const status = document.getElementById('admin-limits-status');
    status.classList.add('hidden');
    const body = {};
    try {
      const u = AdminConsole.parseDollarsToCents('Default per-user',
        document.getElementById('admin-limit-user').value.trim());
      const g = AdminConsole.parseDollarsToCents('Global',
        document.getElementById('admin-limit-global').value.trim());
      const s = AdminConsole.parseDollarsToCents('System tokens',
        document.getElementById('admin-limit-system').value.trim());
      if (u !== null) body.user = u;
      if (g !== null) body.global = g;
      if (s !== null) body.system = s;
      if (!Object.keys(body).length) throw new Error('Provide at least one value.');
    } catch (err) {
      status.textContent = err.message;
      status.className = 'text-xs mt-2 text-red-400';
      status.classList.remove('hidden');
      return;
    }
    try {
      const res = await fetch('/api/admin/limits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      AdminConsole._fillLimits(await res.json());
      status.textContent = 'Saved.';
      status.className = 'text-xs mt-2 text-green-500';
      status.classList.remove('hidden');
      setTimeout(() => status.classList.add('hidden'), 2000);
    } catch (err) {
      status.textContent = `Save failed: ${err.message}`;
      status.className = 'text-xs mt-2 text-red-400';
      status.classList.remove('hidden');
    }
  },

  // ── Activation codes ────────────────────────────────────────────────────

  renderCodesSection(host) {
    const canWrite = AdminConsole.canWrite();
    host.innerHTML = `
      <div class="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 border border-zinc-200 dark:border-zinc-800">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold">Activation Codes</h2>
          ${canWrite ? '<button id="admin-generate-code-btn" class="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors">Generate Code</button>' : ''}
        </div>
        <div id="admin-code-list" class="space-y-2"></div>
        <p id="admin-code-empty" class="text-sm text-zinc-500 hidden">No activation codes yet.</p>
      </div>`;
    document.getElementById('admin-generate-code-btn')
      ?.addEventListener('click', async () => {
        await fetch('/api/admin/codes', { method: 'POST' });
        AdminConsole.loadCodes();
      });
    AdminConsole.loadCodes();
  },

  async loadCodes() {
    const { data } = await AdminConsole.fetchJson('/api/admin/codes');
    if (!Array.isArray(data)) return;
    if (AdminConsole._section !== 'codes') return;
    AdminConsole._paintCodes(data);
  },

  _paintCodes(codes) {
    const esc = AdminConsole.esc;
    const list = document.getElementById('admin-code-list');
    const empty = document.getElementById('admin-code-empty');
    if (!list) return;
    list.innerHTML = '';
    if (!codes.length) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    const canWrite = AdminConsole.canWrite();

    for (const code of codes) {
      const el = document.createElement('div');
      el.className = 'flex flex-wrap items-center justify-between gap-3 p-2.5 rounded-lg bg-zinc-100 dark:bg-zinc-800';
      const used = !!code.used_by_username;
      let statusHtml;
      if (used) {
        const date = new Date(code.used_at).toLocaleDateString();
        statusHtml = `<span class="text-xs text-zinc-500">Used by <strong class="text-zinc-400">${esc(code.used_by_username)}</strong> on ${date}</span>`;
      } else {
        statusHtml = '<span class="text-xs text-green-500">Available</span>';
      }
      el.innerHTML = `
        <div class="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1">
          <code class="font-mono text-sm ${used ? 'text-zinc-400 line-through' : 'text-violet-400'}">${esc(code.code)}</code>
          ${statusHtml}
        </div>
        <div class="flex items-center gap-2 shrink-0">
          ${!used ? `<button class="admin-copy-code-btn text-xs text-zinc-400 hover:text-violet-400 transition-colors" data-code="${esc(code.code)}">Copy</button>` : ''}
          ${!used ? `<button class="admin-share-code-btn text-xs text-zinc-400 hover:text-green-400 transition-colors" data-code="${esc(code.code)}">Share link</button>` : ''}
          ${!used && canWrite ? `<button class="admin-delete-code-btn text-xs text-zinc-400 hover:text-red-400 transition-colors" data-id="${code.id}" aria-label="Delete code">&times;</button>` : ''}
        </div>`;
      list.appendChild(el);
    }

    list.querySelectorAll('.admin-copy-code-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.code);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
    });
    list.querySelectorAll('.admin-share-code-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = `${location.origin}/register.html?code=${encodeURIComponent(btn.dataset.code)}`;
        navigator.clipboard.writeText(url);
        btn.textContent = 'Link copied!';
        setTimeout(() => { btn.textContent = 'Share link'; }, 1500);
      });
    });
    list.querySelectorAll('.admin-delete-code-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/admin/codes/${btn.dataset.id}`, { method: 'DELETE' });
        AdminConsole.loadCodes();
      });
    });
  },

  // ── Users ───────────────────────────────────────────────────────────────

  renderUsersSection(host) {
    const canWrite = AdminConsole.canWrite();
    host.innerHTML = `
      <div class="bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div class="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 class="text-lg font-semibold">Users</h2>
          ${canWrite ? `
          <div id="admin-bulk-quota-control" class="flex items-center gap-2" title="Set every user's app quota to this number.">
            <span class="text-xs text-zinc-400">Set all quotas to</span>
            <input id="admin-bulk-quota-input" type="number" min="0" step="1" inputmode="numeric"
              class="w-16 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs font-mono"
              placeholder="0">
            <button id="admin-bulk-quota-btn" class="rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-1 text-xs font-medium text-white transition-colors">Set all</button>
          </div>` : ''}
        </div>
        <div id="admin-user-list" class="divide-y divide-zinc-200 dark:divide-zinc-800">
          <p class="p-4 text-xs text-zinc-500">Loading…</p>
        </div>
      </div>`;
    document.getElementById('admin-bulk-quota-btn')
      ?.addEventListener('click', () => AdminConsole._bulkQuota());
    AdminConsole.loadUsers();
  },

  async _bulkQuota() {
    const input = document.getElementById('admin-bulk-quota-input');
    const raw = input.value.trim();
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < 0) {
      AdminConsole._alert('Enter a non-negative whole number.');
      return;
    }
    const ok = await AdminConsole._confirm({
      title: 'Set all quotas?',
      message: `Set EVERY user's app quota to ${n}? This overwrites all current quotas.`,
      confirmLabel: 'Set all',
    });
    if (!ok) return;
    const btn = document.getElementById('admin-bulk-quota-btn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/admin/users/app-quota', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quota: n }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        AdminConsole._alert(data.error || `Set all failed (HTTP ${res.status})`);
        return;
      }
      input.value = '';
      await AdminConsole.loadUsers();
    } catch (err) {
      AdminConsole._alert(`Set all failed: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  },

  async loadUsers() {
    const { status, data } = await AdminConsole.fetchJson('/api/admin/users');
    if (AdminConsole._section !== 'users') return;
    const list = document.getElementById('admin-user-list');
    if (!list) return;
    if (status === 403) {
      list.innerHTML = '<p class="p-4 text-sm text-zinc-500">Admin access required.</p>';
      return;
    }
    if (!Array.isArray(data)) return;
    AdminConsole._paintUsers(data);
  },

  _paintUsers(users) {
    const esc = AdminConsole.esc;
    const canWrite = AdminConsole.canWrite();
    const list = document.getElementById('admin-user-list');
    if (!list) return;
    list.innerHTML = '';

    // Disable the role selector for the sole remaining FULL admin — the
    // server enforces the same rule (last-full-admin guard); this is the
    // matching UX affordance. View-only admins don't count (issue #311).
    const fullAdminCount = users.filter((u) => u.is_admin && !u.admin_readonly).length;

    for (const user of users) {
      const el = document.createElement('div');
      el.className = 'p-4 flex items-start gap-3';

      const codeInfo = user.activation_code
        ? `<span class="text-xs text-zinc-500">code: <code class="text-zinc-400">${esc(user.activation_code)}</code></span>`
        : '';
      const costToday = (parseFloat(user.cost_today_cents || 0) / 100).toFixed(2);

      const isAdmin = !!user.is_admin;
      const isReadonlyAdmin = isAdmin && !!user.admin_readonly;
      const role = !isAdmin ? 'user' : (isReadonlyAdmin ? 'view_admin' : 'admin');
      const isSelf = !!user.is_self;
      const isLastFullAdmin = isAdmin && !isReadonlyAdmin && fullAdminCount <= 1;
      const roleSelectDisabled = isSelf || isLastFullAdmin;
      let roleTitle;
      if (isSelf) {
        roleTitle = "You can't change your own role.";
      } else if (isLastFullAdmin) {
        roleTitle = "Can't drop the last full admin.";
      } else {
        roleTitle = "Set this user's role.";
      }
      const roleLabel = { user: 'User', view_admin: 'View-only admin', admin: 'Admin' }[role];
      const roleControlHtml = canWrite
        ? `
        <div class="flex items-center gap-2 shrink-0" title="${roleTitle}">
          <span class="text-xs text-zinc-400">Role</span>
          <select class="admin-role-select rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs"
            data-user-id="${user.id}" data-original="${role}" ${roleSelectDisabled ? 'disabled' : ''}>
            <option value="user" ${role === 'user' ? 'selected' : ''}>User</option>
            <option value="view_admin" ${role === 'view_admin' ? 'selected' : ''}>View-only admin</option>
            <option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </div>`
        : `
        <div class="flex items-center gap-2 shrink-0">
          <span class="text-xs text-zinc-400">Role</span>
          <span class="text-xs font-medium text-zinc-500 dark:text-zinc-300">${roleLabel}</span>
        </div>`;

      const appQuota = user.app_quota == null ? 0 : user.app_quota;
      const appsCreated = user.apps_created == null ? 0 : user.apps_created;
      const quotaHtml = `
        <div class="flex items-center gap-1 shrink-0" title="Max apps this user may create. 0 = cannot create. Admins bypass this.">
          <span class="text-xs text-zinc-400">App quota</span>
          <input type="number" min="0" step="1" inputmode="numeric"
            class="admin-quota-input w-16 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs font-mono disabled:opacity-60"
            data-user-id="${user.id}"
            data-original="${appQuota}"
            value="${appQuota}" ${canWrite ? '' : 'disabled'}>
          <span class="text-xs text-zinc-500 whitespace-nowrap">${appsCreated} used</span>
        </div>`;

      const overrideCents = user.daily_limit_cents;
      const overrideDollars = overrideCents == null ? '' : AdminConsole.centsToDollars(overrideCents);
      const limitHtml = `
        <div class="flex items-center gap-1 shrink-0" title="Per-user daily cap in dollars. Blank = use platform default.">
          <span class="text-xs text-zinc-400">Cap $</span>
          <input type="number" min="0" step="0.01" inputmode="decimal"
            class="admin-user-limit-input w-20 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs font-mono disabled:opacity-60"
            data-user-id="${user.id}"
            data-original="${overrideDollars}"
            value="${overrideDollars}"
            placeholder="default" ${canWrite ? '' : 'disabled'}>
        </div>`;

      const walletAddr = user.usernode_pubkey == null ? '' : user.usernode_pubkey;
      const walletHtml = `
        <div class="flex items-center gap-1 shrink-0" title="Linked Usernode wallet (ut1…). Blank = no wallet linked.">
          <span class="text-xs text-zinc-400">Wallet</span>
          <input type="text" autocomplete="off" spellcheck="false"
            class="admin-wallet-input w-44 max-w-full rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs font-mono disabled:opacity-60"
            data-user-id="${user.id}"
            data-original="${esc(walletAddr)}"
            value="${esc(walletAddr)}"
            placeholder="none" ${canWrite ? '' : 'disabled'}>
        </div>`;

      // Per-row actions in a "…" overflow menu; only full admins get one
      // (view-only admins have no actions). Delete stays hidden for admins.
      const deleteItem = !user.is_admin
        ? `<button data-delete-id="${user.id}" class="admin-delete-user-btn block w-full text-left px-3 py-2 text-sm text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-700">Delete</button>`
        : '';
      const kebabHtml = canWrite ? `
        <div class="relative shrink-0 admin-user-actions">
          <button type="button" class="admin-kebab-btn rounded px-2 py-1 text-lg leading-none text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" aria-label="User actions" aria-haspopup="true" aria-expanded="false">&#8943;</button>
          <div class="admin-kebab-menu hidden absolute right-0 mt-1 z-20 min-w-[11rem] rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 py-1 shadow-lg">
            <button data-reset-id="${user.id}" data-username="${esc(user.username)}" class="admin-reset-pw-btn block w-full text-left px-3 py-2 text-sm text-violet-500 hover:bg-zinc-100 dark:hover:bg-zinc-700">Reset password</button>
            ${deleteItem}
          </div>
        </div>` : '';

      el.innerHTML = `
        <div class="flex-1 min-w-0 flex flex-col gap-2">
          <div>
            <div class="font-medium break-words">${esc(user.username)}</div>
            <div class="text-sm text-zinc-500 truncate">$${costToday} spent today ${codeInfo}</div>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            ${walletHtml}
            ${limitHtml}
            ${roleControlHtml}
            ${quotaHtml}
          </div>
        </div>
        ${kebabHtml}`;
      list.appendChild(el);
    }

    AdminConsole._wireUserRows(list);
  },

  _wireUserRows(list) {
    const esc = AdminConsole.esc;

    list.querySelectorAll('.admin-user-limit-input').forEach((inp) => {
      // Save on blur or Enter. Empty string clears the override. Input is
      // dollars; the API speaks integer cents.
      const commit = async () => {
        const next = inp.value.trim();
        const orig = inp.dataset.original || '';
        if (next === orig) return;
        const userId = inp.dataset.userId;
        inp.disabled = true;
        let body;
        if (next === '') {
          body = { cents: null };
        } else {
          try {
            body = { cents: AdminConsole.parseDollarsToCents('Cap', next) };
          } catch (err) {
            AdminConsole._alert(err.message);
            inp.value = orig;
            inp.disabled = false;
            return;
          }
        }
        try {
          const res = await fetch(`/api/admin/users/${userId}/daily-limit`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            AdminConsole._alert(data.error || `Save failed (HTTP ${res.status})`);
            inp.value = orig;
          } else {
            const data = await res.json();
            const v = data.daily_limit_cents == null ? '' : AdminConsole.centsToDollars(data.daily_limit_cents);
            inp.value = v;
            inp.dataset.original = v;
          }
        } catch (err) {
          AdminConsole._alert(`Save failed: ${err.message}`);
          inp.value = orig;
        } finally {
          inp.disabled = false;
        }
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      });
    });

    list.querySelectorAll('.admin-wallet-input').forEach((inp) => {
      // Save on blur or Enter. Empty = clear the wallet. On a 409 the
      // address already belongs to another user; offer to reassign (move)
      // it, which the backend does atomically.
      const commit = async () => {
        const next = inp.value.trim();
        const orig = inp.dataset.original || '';
        if (next === orig) return;
        const userId = inp.dataset.userId;
        if (next !== '' && !/^ut1\S{5,252}$/.test(next)) {
          AdminConsole._alert('Wallet address must start with "ut1" and contain no spaces.');
          inp.value = orig;
          return;
        }
        inp.disabled = true;
        const send = async (reassign) => {
          const body = { pubkey: next === '' ? null : next };
          if (reassign) body.reassign = true;
          return fetch(`/api/admin/users/${userId}/wallet`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        };
        try {
          let res = await send(false);
          if (res.status === 409) {
            const data = await res.json().catch(() => ({}));
            const other = data.conflictUser?.username || 'another user';
            const move = await AdminConsole._confirm({
              title: 'Wallet already linked',
              message: `${next} is currently linked to "${other}". Move it to this user? This clears it from "${other}".`,
              confirmLabel: 'Move it',
            });
            if (move) {
              res = await send(true);
            } else {
              inp.value = orig;
              return;
            }
          }
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            AdminConsole._alert(data.error || `Save failed (HTTP ${res.status})`);
            inp.value = orig;
          } else {
            // A reassign empties the previous holder's row too; reload so
            // both affected rows reflect the new state.
            await AdminConsole.loadUsers();
            return;
          }
        } catch (err) {
          AdminConsole._alert(`Save failed: ${err.message}`);
          inp.value = orig;
        } finally {
          inp.disabled = false;
        }
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      });
    });

    list.querySelectorAll('.admin-role-select').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const userId = sel.dataset.userId;
        const orig = sel.dataset.original;
        const next = sel.value;
        if (next === orig) return;
        sel.disabled = true;
        try {
          const res = await fetch(`/api/admin/users/${userId}/is-admin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: next }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            sel.value = orig;
            AdminConsole._alert(data.error || `Role change failed (HTTP ${res.status})`);
            return;
          }
          // Re-render so the last-full-admin disabling and the Delete
          // visibility (hidden for admins) all refresh.
          await AdminConsole.loadUsers();
        } catch (err) {
          sel.value = orig;
          AdminConsole._alert(`Role change failed: ${err.message}`);
        } finally {
          sel.disabled = false;
        }
      });
    });

    list.querySelectorAll('.admin-quota-input').forEach((inp) => {
      const commit = async () => {
        const next = inp.value.trim();
        const orig = inp.dataset.original || '';
        if (next === orig) return;
        const userId = inp.dataset.userId;
        const n = Number(next);
        if (next === '' || !Number.isInteger(n) || n < 0) {
          AdminConsole._alert('Quota must be a non-negative whole number.');
          inp.value = orig;
          return;
        }
        inp.disabled = true;
        try {
          const res = await fetch(`/api/admin/users/${userId}/app-quota`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quota: n }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            AdminConsole._alert(data.error || `Save failed (HTTP ${res.status})`);
            inp.value = orig;
          } else {
            const data = await res.json();
            const v = String(data.app_quota);
            inp.value = v;
            inp.dataset.original = v;
          }
        } catch (err) {
          AdminConsole._alert(`Save failed: ${err.message}`);
          inp.value = orig;
        } finally {
          inp.disabled = false;
        }
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      });
    });

    list.querySelectorAll('.admin-delete-user-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        AdminConsole._closeUserMenus();
        const ok = await AdminConsole._confirm({
          title: 'Delete user?',
          message: 'This will remove all their data.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        const res = await fetch(`/api/admin/users/${btn.dataset.deleteId}`, { method: 'DELETE' });
        if (res.ok) AdminConsole.loadUsers();
      });
    });

    list.querySelectorAll('.admin-reset-pw-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        AdminConsole._closeUserMenus();
        const username = btn.dataset.username;
        const ok = await AdminConsole._confirm({
          title: `Reset ${username}'s password?`,
          message: 'This signs them out everywhere and issues a one-time temporary password.',
          confirmLabel: 'Reset',
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/admin/users/${btn.dataset.resetId}/reset-password`, { method: 'POST' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            AdminConsole._alert(data.error || `Reset failed (HTTP ${res.status})`);
            return;
          }
          AdminConsole._showTempPasswordModal(data.username || username, data.tempPassword);
        } catch (err) {
          AdminConsole._alert(`Reset failed: ${err.message}`);
        } finally {
          btn.disabled = false;
        }
      });
    });

    // Kebab overflow menus: one open at a time; the document-level
    // outside-click/Escape close handler binds once for the module's
    // lifetime (rows re-render on every reload).
    list.querySelectorAll('.admin-kebab-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = btn.parentElement.querySelector('.admin-kebab-menu');
        const isOpen = !menu.classList.contains('hidden');
        AdminConsole._closeUserMenus();
        if (!isOpen) {
          menu.classList.remove('hidden');
          btn.setAttribute('aria-expanded', 'true');
        }
      });
    });
    if (!AdminConsole._menusWired) {
      AdminConsole._menusWired = true;
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.admin-user-actions')) AdminConsole._closeUserMenus();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') AdminConsole._closeUserMenus();
      });
    }
  },

  _closeUserMenus() {
    document.querySelectorAll('.admin-kebab-menu').forEach((m) => m.classList.add('hidden'));
    document.querySelectorAll('.admin-kebab-btn').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  },

  // Temporary-password modal — shows the one-time plaintext exactly once.
  _showTempPasswordModal(username, tempPassword) {
    const modal = document.getElementById('admin-temp-pw-modal');
    if (!modal) return;
    document.getElementById('admin-temp-pw-username').textContent = username;
    const valueEl = document.getElementById('admin-temp-pw-value');
    valueEl.textContent = tempPassword;
    const copyBtn = document.getElementById('admin-temp-pw-copy');
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(tempPassword);
        copyBtn.textContent = 'Copied';
      } catch {
        // Clipboard API can be blocked (insecure context); select instead.
        const range = document.createRange();
        range.selectNodeContents(valueEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        copyBtn.textContent = 'Select & copy';
      }
    };
    document.getElementById('admin-temp-pw-close').onclick = () => {
      modal.classList.add('hidden');
      valueEl.textContent = '';
    };
    modal.classList.remove('hidden');
  },

  // ── Submitted features (cross-app, ported from admin-features.js) ──────

  // The endpoint caps limit at 200; also the CSV paging page size.
  FEATURES_PAGE: 200,
  FEATURES_CSV_FIELDS: [
    'id', 'app_id', 'app_slug', 'app_name', 'title', 'description',
    'kind', 'status', 'github_issue_number', 'created_at',
    'created_by', 'created_by_username', 'up_count', 'down_count',
  ],
  FEATURES_STATUS_BADGE: {
    open:      { label: 'Open',    cls: 'bg-green-500/20 text-green-600 dark:text-green-300' },
    closed:    { label: 'Closed',  cls: 'bg-zinc-500/20 text-zinc-600 dark:text-zinc-300' },
    completed: { label: 'Shipped', cls: 'bg-violet-500/20 text-violet-600 dark:text-violet-300' },
  },

  renderFeaturesSection(host) {
    host.innerHTML = `
      <div class="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 border border-zinc-200 dark:border-zinc-800">
        <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 class="text-lg font-semibold">Submitted features</h2>
          <div class="flex items-center gap-2">
            <select id="admin-features-status" class="rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs">
              <option value="all" selected>All</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="completed">Shipped</option>
            </select>
            <button id="admin-features-refresh" class="text-xs text-zinc-400 hover:text-violet-400 px-1 py-1">Refresh</button>
            <button id="admin-features-csv" class="rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-1 text-xs font-medium text-white transition-colors">Download CSV</button>
          </div>
        </div>
        <p id="admin-features-summary" class="text-xs text-zinc-500 mb-3"></p>
        <div id="admin-features-list" class="space-y-3"></div>
        <p id="admin-features-empty" class="text-sm text-zinc-500 hidden"></p>
      </div>`;
    document.getElementById('admin-features-status')
      .addEventListener('change', () => AdminConsole.loadFeatures());
    document.getElementById('admin-features-refresh')
      .addEventListener('click', () => AdminConsole.loadFeatures());
    document.getElementById('admin-features-csv')
      .addEventListener('click', () => AdminConsole.downloadFeaturesCsv());
    AdminConsole.loadFeatures();
  },

  _featuresStatus() {
    // Default 'all' so an admin lands on the full cross-app list — shipped
    // features carry status='completed', invisible under open/closed (#565).
    return document.getElementById('admin-features-status')?.value || 'all';
  },

  _fmtTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  },

  _featureCard(f, rank) {
    const esc = AdminConsole.esc;
    const b = AdminConsole.FEATURES_STATUS_BADGE[f.status]
      || { label: f.status || '—', cls: 'bg-zinc-500/20 text-zinc-600 dark:text-zinc-300' };
    const el = document.createElement('div');
    el.className = 'border border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-100 dark:bg-zinc-800/60 p-4';
    const gh = f.github_issue_number
      ? `<span class="text-xs text-zinc-500">GitHub #${esc(f.github_issue_number)}</span>` : '';
    const submitter = f.created_by_username ? esc(f.created_by_username) : '—';
    el.innerHTML = `
      <div class="flex items-start gap-3">
        <div class="text-zinc-400 font-mono text-sm pt-0.5 w-8 shrink-0">#${rank}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-semibold">${esc(f.title)}</span>
            <span class="text-[11px] font-semibold px-2 py-0.5 rounded ${b.cls}">${esc(b.label)}</span>
          </div>
          ${f.description ? `<div class="text-sm text-zinc-500 mt-1 whitespace-pre-wrap break-words">${esc(f.description)}</div>` : ''}
          <div class="text-xs text-zinc-500 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="text-violet-500 dark:text-violet-400">${esc(f.app_name)}</span>
            <span class="text-zinc-500">${esc(f.app_slug)}</span>
            <span>by ${submitter}</span>
            <span>${esc(AdminConsole._fmtTime(f.created_at))}</span>
            ${gh}
          </div>
        </div>
        <div class="text-right text-sm shrink-0">
          <div class="text-green-500 dark:text-green-400 font-semibold">▲ ${esc(f.up_count)}</div>
          <div class="text-zinc-400">▼ ${esc(f.down_count)}</div>
        </div>
      </div>`;
    return el;
  },

  async loadFeatures() {
    const status = AdminConsole._featuresStatus();
    const container = document.getElementById('admin-features-list');
    const empty = document.getElementById('admin-features-empty');
    const summary = document.getElementById('admin-features-summary');
    if (!container) return;
    container.innerHTML = '';
    empty.classList.add('hidden');
    summary.textContent = 'Loading…';

    const { status: httpStatus, data } = await AdminConsole.fetchJson(
      `/api/admin/submitted-features?status=${encodeURIComponent(status)}&limit=${AdminConsole.FEATURES_PAGE}&offset=0`);
    if (AdminConsole._section !== 'features') return;
    if (httpStatus === 403) {
      summary.textContent = 'Admin access required.';
      return;
    }
    if (!data || typeof data !== 'object') {
      summary.textContent = 'Couldn’t load submitted features — try Refresh.';
      return;
    }

    const features = data.features || [];
    const total = typeof data.total === 'number' ? data.total : features.length;
    if (!features.length) {
      summary.textContent = '';
      empty.textContent = status === 'all'
        ? 'No submitted features yet.'
        : 'No submitted features match this filter — try the “All” status.';
      empty.classList.remove('hidden');
      return;
    }
    features.forEach((f, i) => container.appendChild(AdminConsole._featureCard(f, i + 1)));
    summary.textContent = total > features.length
      ? `Showing the top ${features.length} of ${total} — use Download CSV for the full list.`
      : `${total} feature${total === 1 ? '' : 's'}.`;
  },

  _csvCell(v) {
    return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  },

  async downloadFeaturesCsv() {
    const btn = document.getElementById('admin-features-csv');
    const status = AdminConsole._featuresStatus();
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    try {
      // Pull the ENTIRE filtered set (looping the offset param), not just
      // the visible page. Hard iteration cap guards a non-advancing page.
      const all = [];
      let offset = 0;
      let total = Infinity;
      for (let guard = 0; guard < 10000 && all.length < total; guard++) {
        const { ok, data } = await AdminConsole.fetchJson(
          `/api/admin/submitted-features?status=${encodeURIComponent(status)}&limit=${AdminConsole.FEATURES_PAGE}&offset=${offset}`);
        if (!ok || !data) throw new Error('export failed');
        const batch = data.features || [];
        if (typeof data.total === 'number') total = data.total;
        if (!batch.length) break;
        all.push(...batch);
        offset += AdminConsole.FEATURES_PAGE;
        if (batch.length < AdminConsole.FEATURES_PAGE) break;
      }
      const lines = [AdminConsole.FEATURES_CSV_FIELDS.map(AdminConsole._csvCell).join(',')];
      for (const r of all) {
        lines.push(AdminConsole.FEATURES_CSV_FIELDS.map((k) => AdminConsole._csvCell(r[k])).join(','));
      }
      const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `submitted-features-${status}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      const summary = document.getElementById('admin-features-summary');
      if (summary) summary.textContent = 'CSV export failed — try again.';
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  },

  // ── Database export ────────────────────────────────────────────────────
  //
  // Downloads a full, unredacted pg_dump of the platform database as a
  // gzip-compressed plain-SQL file (`.sql.gz`, restored with gunzip + psql).
  // The file is a live credential bundle — every password hash, every valid
  // session token, every app credential — so this section is deliberately sober:
  // a permanent red warning panel, a typed confirmation plus password
  // re-entry on every run, and an append-only history nobody can clear.
  //
  // WHY THE BUTTON'S ENABLED STATE COMES FROM THE SERVER: availability is
  // decided by GET /api/admin/db-export/status, which returns a `reason`
  // code this module maps to copy. The client contains no environment
  // check of its own — the server owns that decision (and enforces it on
  // both the ticket and the stream route), which is also what keeps this
  // file identical across environments as tests/admin-console-page.test.js
  // requires.
  //
  // The download itself is a two-step ticket, not a fetch: POST the
  // confirmation, then NAVIGATE to the returned single-use URL. A Blob
  // (the pattern downloadFeaturesCsv uses above) would hold a
  // multi-hundred-megabyte dump in page memory; navigating gives a real
  // streamed download with the browser's own progress UI — and lets the
  // browser save the gzip bytes verbatim instead of trying to decode them.

  DB_EXPORT_REASONS: {
    staging: 'Database export is disabled in staging previews.',
    unavailable: 'Database export is unavailable on this deployment.',
    in_progress: 'An export is already in progress — try again shortly.',
    rate_limited: 'Daily export limit reached — try again later.',
  },

  DB_EXPORT_STATUS_BADGE: {
    completed:   { label: 'Completed',   cls: 'bg-green-500/20 text-green-600 dark:text-green-400' },
    streaming:   { label: 'Streaming',   cls: 'bg-violet-500/20 text-violet-600 dark:text-violet-400' },
    requested:   { label: 'Requested',   cls: 'bg-violet-500/20 text-violet-600 dark:text-violet-400' },
    failed:      { label: 'Failed',      cls: 'bg-red-500/20 text-red-600 dark:text-red-400' },
    cancelled:   { label: 'Cancelled',   cls: 'bg-amber-500/20 text-amber-700 dark:text-amber-400' },
    interrupted: { label: 'Interrupted', cls: 'bg-amber-500/20 text-amber-700 dark:text-amber-400' },
    denied:      { label: 'Denied',      cls: 'bg-red-500/20 text-red-600 dark:text-red-400' },
  },

  _fmtBytes(n) {
    const b = Number(n);
    if (!Number.isFinite(b) || b <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  },

  _fmtDuration(startIso, endIso) {
    if (!startIso || !endIso) return '—';
    const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${ms} ms`;
    const s = ms / 1000;
    if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
    return `${Math.round(s / 60)} min`;
  },

  // ── Platform variables ─────────────────────────────────────────────────
  //
  // The platform's own environment variables — the ones deploy.yml writes
  // into /opt/usernode/.env. The single most important thing this screen
  // has to communicate is that a change here is NOT live: it is picked up
  // by the next deploy. Hence the banner at the top rather than a footnote.
  //
  // Row states come straight from the API (`state`): set / unset /
  // managed / orphan. `managed` variables are shown but never editable —
  // they come from GitHub secrets and an edit box would be a lie.

  PLATFORM_ENV_STATE_BADGES: {
    set: { label: 'Set', cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
    unset: { label: 'Not set', cls: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400' },
    managed: { label: 'Deploy-managed', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
    orphan: { label: 'No longer declared', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
  },

  renderPlatformEnvSection(host) {
    host.innerHTML = `
      <div id="admin-platform-env-panel" class="space-y-4">
        <div class="rounded-lg border border-violet-300 dark:border-violet-900 bg-violet-50 dark:bg-violet-950/40 p-4">
          <h2 class="text-lg font-semibold text-violet-800 dark:text-violet-200">Platform variables</h2>
          <p class="text-sm text-violet-900 dark:text-violet-200 mt-2">
            These are the platform's own environment variables — what ends up in
            <code class="font-mono">/opt/usernode/.env</code> on the server. They are declared in the
            platform's <code class="font-mono">dapp.json</code> and their values are set here.
          </p>
          <p class="text-sm font-semibold text-violet-900 dark:text-violet-100 mt-2">
            A change here does not take effect immediately. Values are resolved by the
            next deploy, which restarts the platform with the new environment.
          </p>
        </div>

        <div class="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 border border-zinc-200 dark:border-zinc-800">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <p id="admin-platform-env-summary" class="text-sm text-zinc-500">Loading…</p>
            <button id="admin-platform-env-refresh" class="text-xs text-zinc-400 hover:text-violet-400 px-1 py-1">Refresh</button>
          </div>
          <div id="admin-platform-env-list" class="space-y-4"></div>
          <p id="admin-platform-env-empty" class="hidden text-sm text-zinc-500">
            No platform variables are declared yet. Add a <code class="font-mono">platform_env</code>
            block to the platform's <code class="font-mono">dapp.json</code>.
          </p>
        </div>
      </div>`;

    document.getElementById('admin-platform-env-refresh')
      .addEventListener('click', () => AdminConsole.loadPlatformEnv());

    // One delegated listener for the whole list — rows are re-rendered on
    // every load, so per-row listeners would have to be re-wired each time.
    document.getElementById('admin-platform-env-list')
      .addEventListener('click', (e) => AdminConsole._platformEnvClick(e));

    AdminConsole.loadPlatformEnv();
  },

  async loadPlatformEnv() {
    const { status: httpStatus, data } = await AdminConsole.fetchJson('/api/admin/platform-env');
    if (AdminConsole._section !== 'platform-env') return;
    const list = document.getElementById('admin-platform-env-list');
    const summary = document.getElementById('admin-platform-env-summary');
    const empty = document.getElementById('admin-platform-env-empty');
    if (!list || !summary || !empty) return;

    if (httpStatus === 403) {
      summary.textContent = 'Platform variables require admin access.';
      list.innerHTML = '';
      return;
    }
    if (!data || !Array.isArray(data.variables)) {
      summary.textContent = 'Could not load platform variables.';
      list.innerHTML = '';
      return;
    }

    const esc = AdminConsole.esc;
    const vars = data.variables;
    const canWrite = AdminConsole.canWrite();

    if (!vars.length) {
      summary.textContent = '';
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    const missing = vars.filter((v) => v.required && !v.hasValue && !v.unwritable);
    const parts = [`${vars.length} variable${vars.length === 1 ? '' : 's'}`];
    if (missing.length) parts.push(`${missing.length} required and unset`);
    if (data.gitSha) parts.push(`running ${esc(String(data.gitSha).slice(0, 7))}`);
    summary.innerHTML = missing.length
      ? `<span class="text-amber-600 dark:text-amber-400">${parts.join(' · ')}</span>`
      : parts.join(' · ');

    // Group in first-seen order — the API already sorts by group then key.
    const groups = [];
    const byGroup = new Map();
    for (const v of vars) {
      if (!byGroup.has(v.group)) { byGroup.set(v.group, []); groups.push(v.group); }
      byGroup.get(v.group).push(v);
    }

    // …then float the groups nobody can act on to the bottom. The API's
    // alphabetical order puts "Managed by the deploy" first, which is the
    // one group whose rows are read-only documentation — leading with it
    // pushes every editable variable below the fold.
    const rank = (g) => {
      const rows = byGroup.get(g);
      if (rows.every((v) => v.state === 'orphan')) return 2;
      if (rows.every((v) => v.unwritable)) return 1;
      return 0;
    };
    groups.sort((a, b) => rank(a) - rank(b));

    list.innerHTML = groups.map((g) => `
      <div>
        <h3 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">${esc(g)}</h3>
        <div class="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800">
          ${byGroup.get(g).map((v) => AdminConsole._platformEnvRow(v, canWrite)).join('')}
        </div>
      </div>`).join('');
  },

  _platformEnvRow(v, canWrite) {
    const esc = AdminConsole.esc;
    const badge = AdminConsole.PLATFORM_ENV_STATE_BADGES[v.state]
      || AdminConsole.PLATFORM_ENV_STATE_BADGES.unset;

    // What we're allowed to show of the value. A private variable never
    // returns its plaintext from the API at all — there is no client-side
    // "reveal", because there is nothing to reveal.
    let valueHtml;
    if (!v.hasValue) {
      valueHtml = v.defaultValue
        ? `<span class="text-xs text-zinc-500">not set — deploy falls back to <code class="font-mono">${esc(v.defaultValue)}</code></span>`
        : '<span class="text-xs text-zinc-500">not set</span>';
    } else if (v.private) {
      valueHtml = '<span class="text-xs text-zinc-500 font-mono">•••••••• (private — never displayed)</span>';
    } else if (v.value == null) {
      valueHtml = '<span class="text-xs text-amber-600 dark:text-amber-400">set, but the stored value could not be decrypted</span>';
    } else {
      valueHtml = `<code class="text-xs font-mono text-zinc-700 dark:text-zinc-300 break-all">${esc(v.value)}</code>`;
    }

    const meta = [];
    if (v.required) meta.push('required');
    if (v.private) meta.push('private');
    if (v.hasValue && v.updatedBy) meta.push(`last set by ${esc(v.updatedBy)}`);

    const editable = canWrite && !v.unwritable;

    return `
      <div class="p-3" data-platform-env-row="${esc(v.key)}">
        <div class="flex items-start justify-between gap-2">
          <div class="flex-1 min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <code class="font-mono text-sm text-zinc-900 dark:text-zinc-100">${esc(v.key)}</code>
              <span class="rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}">${badge.label}</span>
              ${meta.length ? `<span class="text-[10px] text-zinc-500">${meta.join(' · ')}</span>` : ''}
            </div>
            ${v.description ? `<p class="text-xs text-zinc-500 mt-1">${esc(v.description)}</p>` : ''}
            ${v.state === 'orphan' ? `<p class="text-xs text-amber-600 dark:text-amber-400 mt-1">
              This variable is no longer declared in dapp.json. Its value is kept so a rollback still works — clear it once you're sure.</p>` : ''}
            ${v.unwritable ? `<p class="text-xs text-zinc-500 mt-1">
              Set by the deploy from a GitHub secret. Editing it here is not possible.</p>` : ''}
            <div class="mt-1">${valueHtml}</div>
          </div>
          ${editable ? `
          <div class="flex items-center gap-2 shrink-0">
            <button class="admin-platform-env-edit text-xs text-zinc-400 hover:text-violet-400" data-key="${esc(v.key)}">
              ${v.hasValue ? 'Edit' : 'Set'}</button>
            ${v.hasValue ? `<button class="admin-platform-env-clear text-xs text-zinc-400 hover:text-red-500" data-key="${esc(v.key)}">Clear</button>` : ''}
          </div>` : ''}
        </div>
        <div class="admin-platform-env-editor hidden mt-3" data-key="${esc(v.key)}">
          <div class="flex flex-wrap items-center gap-2">
            <input type="${v.private ? 'password' : 'text'}" autocomplete="off" spellcheck="false"
              class="admin-platform-env-input flex-1 min-w-[12rem] rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono"
              placeholder="New value">
            <button class="admin-platform-env-save rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-2 text-xs font-medium text-white transition-colors" data-key="${esc(v.key)}">Save</button>
            <button class="admin-platform-env-cancel rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors" data-key="${esc(v.key)}">Cancel</button>
          </div>
          <p class="admin-platform-env-error hidden text-xs text-red-600 dark:text-red-400 mt-2"></p>
        </div>
      </div>`;
  },

  _platformEnvRowEl(key) {
    return document.querySelector(`[data-platform-env-row="${CSS.escape(key)}"]`);
  },

  _platformEnvClick(e) {
    const edit = e.target.closest('.admin-platform-env-edit');
    if (edit) {
      const row = AdminConsole._platformEnvRowEl(edit.dataset.key);
      const editor = row && row.querySelector('.admin-platform-env-editor');
      if (!editor) return;
      editor.classList.remove('hidden');
      const input = editor.querySelector('.admin-platform-env-input');
      if (input) { input.value = ''; input.focus(); }
      return;
    }
    const cancel = e.target.closest('.admin-platform-env-cancel');
    if (cancel) {
      const row = AdminConsole._platformEnvRowEl(cancel.dataset.key);
      const editor = row && row.querySelector('.admin-platform-env-editor');
      if (editor) editor.classList.add('hidden');
      return;
    }
    const save = e.target.closest('.admin-platform-env-save');
    if (save) { AdminConsole._platformEnvSave(save.dataset.key); return; }
    const clear = e.target.closest('.admin-platform-env-clear');
    if (clear) { AdminConsole._platformEnvClear(clear.dataset.key); }
  },

  _platformEnvError(key, message) {
    const row = AdminConsole._platformEnvRowEl(key);
    const el = row && row.querySelector('.admin-platform-env-error');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('hidden', !message);
  },

  async _platformEnvSave(key) {
    const row = AdminConsole._platformEnvRowEl(key);
    const input = row && row.querySelector('.admin-platform-env-input');
    const btn = row && row.querySelector('.admin-platform-env-save');
    if (!input) return;
    const value = input.value;
    if (!value) {
      AdminConsole._platformEnvError(key, 'Enter a value, or use Clear to remove it.');
      return;
    }
    AdminConsole._platformEnvError(key, '');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/api/admin/platform-env/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        AdminConsole._platformEnvError(key, data.error || `Save failed (HTTP ${res.status})`);
        return;
      }
    } catch {
      AdminConsole._platformEnvError(key, 'Save failed — network error.');
      return;
    } finally {
      if (btn) btn.disabled = false;
    }
    await AdminConsole.loadPlatformEnv();
  },

  async _platformEnvClear(key) {
    const ok = await AdminConsole._confirm({
      title: 'Clear this variable?',
      message: `Remove the stored value for ${key}? The next deploy will run without it.`,
      confirmLabel: 'Clear',
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/admin/platform-env/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        AdminConsole._alert(data.error || `Clear failed (HTTP ${res.status})`);
        return;
      }
    } catch {
      AdminConsole._alert('Clear failed — network error.');
      return;
    }
    await AdminConsole.loadPlatformEnv();
  },

  renderDbExportSection(host) {
    const canWrite = AdminConsole.canWrite();
    host.innerHTML = `
      <div id="admin-db-export-panel" class="space-y-4">
        <div class="rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-4">
          <h2 class="text-lg font-semibold text-red-700 dark:text-red-300">Database export — handle as a credential</h2>
          <p class="text-sm text-red-800 dark:text-red-200 mt-2">
            This downloads a complete, unredacted copy of the platform database.
            Anyone holding the file can take over accounts and reach every app's data.
            It contains:
          </p>
          <ul class="text-sm text-red-800 dark:text-red-200 mt-2 list-disc pl-5 space-y-1">
            <li>every user's password hash and every currently-valid login session token</li>
            <li>every activation code, used and unused</li>
            <li>every app's database password, LLM proxy token and file-storage token</li>
            <li>the encrypted blobs for users' own Anthropic API keys and every app's stored secrets</li>
            <li>every chat message, spec, dev-session transcript, uploaded attachment and screenshot</li>
            <li>all analytics, votes, kudos, bounties and moderation history</li>
          </ul>
          <p class="text-sm text-red-800 dark:text-red-200 mt-3">
            It does <span class="font-semibold">not</span> contain the individual apps' own databases,
            uploaded app-file bytes (those live in object storage), the chain node's data,
            or the platform's environment file — which matters, because the key that
            decrypts the API-key and app-secret blobs lives only there.
          </p>
        </div>

        <div class="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 border border-zinc-200 dark:border-zinc-800">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <p id="admin-db-export-target" class="text-sm text-zinc-500">Loading…</p>
            <button id="admin-db-export-refresh" class="text-xs text-zinc-400 hover:text-violet-400 px-1 py-1">Refresh</button>
          </div>
          <div class="mt-3">
            ${canWrite
              ? `<button id="admin-db-export-btn" disabled
                   class="rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:hover:bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors">
                   Export database</button>`
              : `<span class="inline-block rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-500">
                   Exporting the database requires full admin.</span>`}
            <p id="admin-db-export-reason" class="text-xs text-zinc-500 mt-2"></p>
          </div>

          <!-- Inline confirm panel. Both fields are required on every export;
               there is no remember-me and no session-scoped bypass. -->
          <div id="admin-db-export-confirm" class="hidden mt-4 rounded-lg border border-red-300 dark:border-red-900 bg-white dark:bg-zinc-950 p-4">
            <p class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Confirm the export</p>
            <p class="text-xs text-zinc-500 mt-1">
              Type <code class="font-mono text-red-600 dark:text-red-400">EXPORT</code> and re-enter your own account password.
            </p>
            <div class="mt-3 space-y-2">
              <input id="admin-db-export-phrase" type="text" autocomplete="off" spellcheck="false"
                placeholder="EXPORT"
                class="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono">
              <input id="admin-db-export-password" type="password" autocomplete="current-password"
                placeholder="Your password"
                class="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm">
            </div>
            <p id="admin-db-export-error" class="hidden text-xs text-red-600 dark:text-red-400 mt-2"></p>
            <div class="flex items-center gap-2 mt-3">
              <button id="admin-db-export-go"
                class="rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white transition-colors">
                Download the .sql.gz</button>
              <button id="admin-db-export-cancel"
                class="rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                Cancel</button>
            </div>
          </div>

          <p class="text-xs text-zinc-500 mt-4">
            The file is a gzip-compressed plain-SQL dump (<code class="font-mono">.sql.gz</code>),
            taken with <code class="font-mono">--no-owner --no-privileges</code>. Restore it with:<br>
            <code class="font-mono text-zinc-600 dark:text-zinc-300 break-all">gunzip -c &lt;file&gt;.sql.gz | psql -v ON_ERROR_STOP=1 -d &lt;target-db&gt;</code><br>
            Read it without unpacking with <code class="font-mono">zless</code> / <code class="font-mono">zgrep</code>.
          </p>
        </div>

        <details id="admin-db-export-guidance" class="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4">
          <summary class="text-sm font-semibold text-amber-800 dark:text-amber-200 cursor-pointer">After you download it — and what to do if it leaks</summary>
          <ul class="text-sm text-amber-800 dark:text-amber-200 mt-3 list-disc pl-5 space-y-1">
            <li>Treat the file as a live credential: keep it encrypted, never on shared storage, and delete it when you're done.</li>
            <li>It is unencrypted in your Downloads folder — gzip is compression, not protection; cloud backup may sync it and anyone can read it with <code class="font-mono">zless</code>.</li>
            <li>If it may have been exposed, deletion is not enough — rotate:</li>
            <li class="list-none pl-4">— the platform JWT secret (invalidates every session; stored API keys and app secrets must be re-entered afterwards)</li>
            <li class="list-none pl-4">— the platform database password</li>
            <li class="list-none pl-4">— every per-app database password, LLM proxy token and storage token</li>
            <li class="list-none pl-4">— invalidate all activation codes, and force a password reset for all users</li>
            <li>Everything in the file stays valid until those rotations happen.</li>
          </ul>
        </details>

        <div class="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 border border-zinc-200 dark:border-zinc-800">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-1">
            <h3 class="text-base font-semibold">Export history</h3>
            <span class="text-xs text-zinc-500">Append-only — cannot be cleared</span>
          </div>
          <p class="text-xs text-zinc-500 mb-3">Every attempt, including refused ones, is recorded here permanently.</p>
          <div id="admin-db-export-history" class="space-y-2"></div>
          <p id="admin-db-export-history-empty" class="text-sm text-zinc-500 hidden">No exports recorded yet.</p>
        </div>
      </div>`;

    document.getElementById('admin-db-export-refresh')
      .addEventListener('click', () => {
        AdminConsole.loadDbExportStatus();
        AdminConsole.loadDbExportHistory();
      });

    const btn = document.getElementById('admin-db-export-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        document.getElementById('admin-db-export-confirm').classList.remove('hidden');
        btn.disabled = true;
        const phrase = document.getElementById('admin-db-export-phrase');
        if (phrase) phrase.focus();
      });
      document.getElementById('admin-db-export-cancel')
        .addEventListener('click', () => AdminConsole._resetDbExportConfirm());
      document.getElementById('admin-db-export-go')
        .addEventListener('click', () => AdminConsole.startDbExport());
    }

    AdminConsole.loadDbExportStatus();
    AdminConsole.loadDbExportHistory();
  },

  _resetDbExportConfirm() {
    const panel = document.getElementById('admin-db-export-confirm');
    if (panel) panel.classList.add('hidden');
    const phrase = document.getElementById('admin-db-export-phrase');
    const pw = document.getElementById('admin-db-export-password');
    if (phrase) phrase.value = '';
    if (pw) pw.value = '';
    const err = document.getElementById('admin-db-export-error');
    if (err) err.classList.add('hidden');
    AdminConsole.loadDbExportStatus();
  },

  _dbExportError(message) {
    const err = document.getElementById('admin-db-export-error');
    if (!err) return;
    err.textContent = message;
    err.classList.remove('hidden');
  },

  async loadDbExportStatus() {
    const target = document.getElementById('admin-db-export-target');
    const reasonEl = document.getElementById('admin-db-export-reason');
    const btn = document.getElementById('admin-db-export-btn');
    if (!target) return;

    const { status: httpStatus, data } = await AdminConsole.fetchJson('/api/admin/db-export/status');
    if (AdminConsole._section !== 'db-export') return;
    if (httpStatus === 403) { target.textContent = 'Admin access required.'; return; }
    if (!data || typeof data !== 'object') {
      target.textContent = 'Couldn’t read the export status — try Refresh.';
      return;
    }

    const esc = AdminConsole.esc;
    target.innerHTML = `Target database <code class="font-mono text-zinc-700 dark:text-zinc-200">${esc(data.dbName || 'unknown')}</code>`
      + ` · current size <span class="font-medium">${esc(AdminConsole._fmtBytes(data.dbSizeBytes))}</span>`
      + ` <span class="text-zinc-500">(the .sql.gz download is smaller)</span>`
      + ` · <span class="text-zinc-500">${esc(data.remainingToday)} of ${esc(data.maxPerDay)} exports left today</span>`;

    if (btn) {
      btn.disabled = !data.available;
      // Don't re-enable the button out from under an open confirm panel.
      const confirming = !document.getElementById('admin-db-export-confirm')?.classList.contains('hidden');
      if (confirming) btn.disabled = true;
    }
    if (reasonEl) {
      reasonEl.textContent = data.available
        ? ''
        : (AdminConsole.DB_EXPORT_REASONS[data.reason] || 'Database export is currently unavailable.');
    }
  },

  async startDbExport() {
    const go = document.getElementById('admin-db-export-go');
    const phrase = document.getElementById('admin-db-export-phrase');
    const pw = document.getElementById('admin-db-export-password');
    if (!go || !phrase || !pw) return;
    const err = document.getElementById('admin-db-export-error');
    if (err) err.classList.add('hidden');

    if (phrase.value.trim() !== 'EXPORT') {
      AdminConsole._dbExportError('Type EXPORT exactly to confirm.');
      return;
    }
    if (!pw.value) {
      AdminConsole._dbExportError('Your password is required.');
      return;
    }

    const original = go.textContent;
    go.disabled = true;
    go.textContent = 'Exporting…';
    try {
      const res = await fetch('/api/admin/db-export/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'EXPORT', password: pw.value }),
      });
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON error page */ }
      if (!res.ok || !data || !data.url) {
        AdminConsole._dbExportError((data && data.error) || 'Export could not be started.');
        go.disabled = false;
        go.textContent = original;
        AdminConsole.loadDbExportHistory();
        return;
      }
      pw.value = '';
      // Navigate — do NOT fetch. The response is a streamed attachment and
      // must go straight to the browser's download machinery.
      window.location.href = data.url;
      AdminConsole._resetDbExportConfirm();
      const guidance = document.getElementById('admin-db-export-guidance');
      if (guidance) guidance.open = true;
      // The navigation doesn't repaint the page, so poll the history a
      // couple of times to pick up the row as it moves to its final state.
      setTimeout(() => AdminConsole.loadDbExportHistory(), 3000);
      setTimeout(() => AdminConsole.loadDbExportHistory(), 12000);
    } catch {
      AdminConsole._dbExportError('Network error — the export was not started.');
      go.disabled = false;
      go.textContent = original;
    }
  },

  _dbExportRow(r) {
    const esc = AdminConsole.esc;
    const b = AdminConsole.DB_EXPORT_STATUS_BADGE[r.status]
      || { label: r.status || '—', cls: 'bg-zinc-500/20 text-zinc-600 dark:text-zinc-300' };
    const el = document.createElement('div');
    el.className = 'border border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-100 dark:bg-zinc-800/60 p-3';
    const denied = r.denied_reason
      ? `<span class="text-zinc-500">reason: ${esc(String(r.denied_reason).replace(/_/g, ' '))}</span>` : '';
    const errLine = r.error
      ? `<div class="text-xs text-red-600 dark:text-red-400 mt-1 break-words">${esc(r.error)}</div>` : '';
    el.innerHTML = `
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-medium">${esc(r.username)}</span>
            <span class="text-[11px] font-semibold px-2 py-0.5 rounded ${b.cls}">${esc(b.label)}</span>
          </div>
          <div class="text-xs text-zinc-500 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>${esc(AdminConsole._fmtTime(r.requested_at))}</span>
            <span class="font-mono">${esc(r.db_name)}</span>
            <span title="compressed size downloaded">${esc(AdminConsole._fmtBytes(r.bytes_sent))}</span>
            <span>${esc(AdminConsole._fmtDuration(r.started_at, r.finished_at))}</span>
            <span>from ${esc(r.ip || '—')}</span>
            ${denied}
          </div>
          ${errLine}
        </div>
      </div>`;
    return el;
  },

  async loadDbExportHistory() {
    const container = document.getElementById('admin-db-export-history');
    const empty = document.getElementById('admin-db-export-history-empty');
    if (!container) return;
    const { status: httpStatus, data } = await AdminConsole.fetchJson(
      '/api/admin/db-export/history?limit=25&offset=0');
    if (AdminConsole._section !== 'db-export') return;
    if (httpStatus === 403 || !data || typeof data !== 'object') return;
    container.innerHTML = '';
    const rows = data.exports || [];
    if (!rows.length) {
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    rows.forEach((r) => container.appendChild(AdminConsole._dbExportRow(r)));
  },
};

window.AdminConsole = AdminConsole;
