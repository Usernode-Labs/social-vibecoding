// Admin & moderation console (#818) — the full-page SPA screen behind the
// header shield icon. #588 shipped the icon plus a "Coming soon"
// placeholder; this module is the real console. Hash route
// #admin[/section], hosted in #admin-screen / #admin-root (index.html) and
// mounted/unmounted by App.navigateToAdminConsole / App._exitAdminConsole
// (public/js/app.js), the same shape as the Challenges / Profile screens.
//
// It reorganizes the standalone /admin page's sections (public/admin.html:
// Operations overview, Maintenance campaigns, LLM spend limits, Activation
// codes, Users) plus the /admin-features viewer into one page with a
// navigation menu — a fixed sidebar on md+ viewports. Every data endpoint
// is an EXISTING route, enforced server-side by adminMiddleware (reads)
// and requireAdminWrite (mutations) — this module adds no new capabilities
// and no new endpoints.
//
// MOBILE HIERARCHY: below md the sidebar has no room, and the horizontally
// scrolling tab strip that used to stand in for it (the Dev board's
// kanban-tabs pattern, #814) made fifteen ungrouped sections a thumb-swipe
// scavenger hunt. Phones now get a real two-level nav instead:
//
//   level 1 (#admin)        the grouped section menu, one tappable row per
//                           section under the same Operations / People /
//                           Insights / Platform headings as the sidebar;
//   level 2 (#admin/<key>)  that one section, full width, with the platform
//                           header's back button flipped to an arrow and
//                           its title set to the section label.
//
// The hash stays the single source of truth for WHICH section shows; the
// level is derived from it (bare #admin on mobile = the menu). A menu tap
// is a REAL hash navigation, so it pushes a history entry and the device /
// WebView back gesture pops back to the menu through exactly the same code
// path as the on-screen arrow (see _openSection / handleBack / route).
// Desktop is untouched: same sidebar, same instant switching, same URLs.
//
// #860 completed the consolidation: /status, /node-status, /dashboard,
// /debug and /gallery are sections here too, and all seven old URLs are
// now client-side redirect stubs into the matching #admin/<key>. Nothing
// in the admin experience opens a new browser tab any more, which is why
// the old TOOLS external-link block is gone.
//
// Permissions: the page itself is reachable for anyone with
// App.user.isAdmin (full AND view-only admins — the navigation gate lives
// in app.js). Write controls render only when App.user.canAdminWrite is
// true; view-only admins get read-only labels plus the amber banner,
// mirroring public/admin.html's CAN_WRITE behaviour (issue #311). The
// "View as non-admin" preview masks both flags before this module can read
// them (see the boot masking in app.js), so no extra handling is needed
// here. Never gated on USERNODE_ENV — identical in staging and production.
//
// PUBLIC MODE (#860): the two sections carrying a `public: true` flag —
// Health & status and Node & chain — were publicly reachable as /status
// and /node-status before the fold, so they stay reachable for a
// signed-in NON-admin who follows an old link. app.js mounts the console
// in public mode for those, and _publicMode() below filters the menu down
// to just them and suppresses the view-only banner. The DATA boundary is
// entirely server-side: GET /api/status runs the payload through
// src/services/status.js redact(), which withholds worker progress, model
// names, spend, host load, stuck sessions and the event log from
// non-admins.

const AdminConsole = {
  _open: false,
  _section: 'overview',
  _menusWired: false,
  // Set by app.js when the console is mounted for a non-admin who
  // deep-linked one of the `public` sections. Never true for an admin.
  _public: false,
  // The section module (if any) currently rendered — used to call its
  // destroy() before swapping in the next one. See _renderSection.
  _activeModule: null,

  // ── Mobile two-level state ───────────────────────────────────────────
  // Which level the phone layout is showing: 1 = the section menu,
  // 2 = one section. Kept in sync on desktop too (it is ignored there)
  // so a viewport crossing resolves without guessing.
  _level: 1,
  // True while the level-2 entry we're sitting on was PUSHED by a menu
  // tap during this mount — the only case where history.back() is
  // guaranteed to land on our own menu entry. A deep link (bookmark, one
  // of the retired-page redirect stubs) leaves it false, and back
  // replaces the entry instead of creating a forward one. Per-mount
  // state: open() resets it, because the stack below the console stops
  // being ours to reason about the moment we leave.
  _pushedFromMenu: false,
  // #admin-screen scrollTop saved on drill-in, restored on the way back.
  _menuScrollTop: 0,
  _mediaBound: false,

  // The single source of truth in JS for where the sidebar layout starts.
  // Must stay in step with the `md:` classes in _renderShell (Tailwind's
  // md breakpoint IS 768px) — same discipline as AppView's
  // KANBAN_MULTICOL_MEDIA / _STAGING_DOCK_MEDIA.
  DESKTOP_MEDIA: '(min-width: 768px)',

  // In-SPA sections. Keys are the #admin/<key> hash segments; `group` is
  // the heading they sit under — in the desktop sidebar AND in the mobile
  // level-1 menu, which share _groupedSections(). Order here IS menu order.
  SECTIONS: [
    { key: 'overview', label: 'Overview', group: 'Operations' },
    // Health & status and Node & chain are the two `public` sections —
    // see the PUBLIC MODE note above.
    { key: 'status', label: 'Health & status', group: 'Operations', public: true },
    { key: 'node', label: 'Node & chain', group: 'Operations', public: true },
    { key: 'merges', label: 'Merge debug', group: 'Operations' },
    { key: 'rollover', label: 'Container rollover', group: 'Operations' },
    { key: 'staging-reap', label: 'Stale previews', group: 'Operations' },

    { key: 'users', label: 'Users', group: 'People' },
    { key: 'codes', label: 'Activation codes', group: 'People' },
    { key: 'limits', label: 'Spend limits', group: 'People' },

    { key: 'analytics', label: 'Analytics', group: 'Insights' },
    { key: 'gallery', label: 'Screenshot gallery', group: 'Insights' },
    { key: 'features', label: 'Submitted features', group: 'Insights' },

    { key: 'campaigns', label: 'Maintenance campaigns', group: 'Platform' },
    { key: 'db-export', label: 'Database export', group: 'Platform' },
    // Topochain (Task 15, migration plan Global Constraint #8): ONE
    // section, its own sub-nav under #admin/topochain/<sub> — see
    // SECTION_MODULES below and public/js/admin-topochain.js,
    // which owns that second hash level entirely on its own (mirrors
    // leaderboard.js's _setSub/_syncHash pattern) rather than teaching
    // this file general multi-level routing. Maintenance campaigns does
    // the same for #admin/campaigns/<id>.
    { key: 'topochain', label: 'Topochain', group: 'Platform' },
  ],

  isOpen() { return AdminConsole._open; },

  // Below the sidebar breakpoint — i.e. the two-level layout is live.
  // Anything that can't answer (no matchMedia) is treated as desktop, so
  // a browser without it keeps today's behaviour rather than a phone
  // layout it never asked for.
  _isMobile() {
    try { return !window.matchMedia(AdminConsole.DESKTOP_MEDIA).matches; }
    catch { return false; }
  },

  // One-time viewport listener: crossing the breakpoint re-resolves the
  // layout in place. Crossing UP renders the active section in the
  // sidebar shell; crossing DOWN keeps that section as level 2 (no menu
  // flash) and writes its explicit hash so the address matches what's on
  // screen. Lazy-bound like AppView._ensureStagingDockListeners.
  _ensureMediaListener() {
    if (AdminConsole._mediaBound || !window.matchMedia) return;
    try {
      const mql = window.matchMedia(AdminConsole.DESKTOP_MEDIA);
      const onChange = () => {
        if (!AdminConsole._open) return;
        // A real section is showing (or was, on desktop) → keep it as
        // level 2 on the way down. Only a menu-level mobile view, or a
        // desktop view sitting on the bare #admin overview, lands on 1.
        if (!mql.matches && AdminConsole._level !== 1) {
          AdminConsole._writeHash(AdminConsole._section);
        }
        AdminConsole._renderShell();
        AdminConsole._renderContent();
        AdminConsole._syncChrome();
      };
      if (mql.addEventListener) mql.addEventListener('change', onChange);
      else if (mql.addListener) mql.addListener(onChange);
      AdminConsole._mediaBound = true;
    } catch { /* no matchMedia — desktop path stands */ }
  },

  // True while the console is mounted for a non-admin on a `public`
  // section. Belt-and-braces: also require the absence of isAdmin, so a
  // stale flag can never narrow an admin's own menu.
  _publicMode() {
    return !!AdminConsole._public && !(window.App && App.user && App.user.isAdmin);
  },

  // The sections the current viewer may navigate to.
  _visibleSections() {
    return AdminConsole._publicMode()
      ? AdminConsole.SECTIONS.filter((s) => s.public)
      : AdminConsole.SECTIONS;
  },

  // Single write gate for every mutating control on the page. View-only
  // admins (is_admin && admin_readonly) carry isAdmin but not
  // canAdminWrite — they see everything read-only.
  canWrite() { return !!(window.App && App.user && App.user.canAdminWrite); },

  // `opts.public` is set by app.js when a non-admin deep-linked one of the
  // `public` sections; it must be resolved BEFORE the first _renderShell so
  // the menu is filtered on the very first paint.
  open(section, opts) {
    AdminConsole._open = true;
    AdminConsole._public = !!(opts && opts.public);
    AdminConsole._pushedFromMenu = false;
    AdminConsole._menuScrollTop = 0;
    AdminConsole._ensureMediaListener();
    const visible = AdminConsole._visibleSections();
    const valid = visible.some((s) => s.key === section);
    // In public mode, fall back to the first PUBLIC section rather than
    // Overview (which the viewer can't see) — and never resurrect a
    // last-visited admin section from an earlier admin login in this tab.
    const fallback = AdminConsole._publicMode()
      ? (visible.some((s) => s.key === AdminConsole._section) ? AdminConsole._section : visible[0]?.key)
      : (AdminConsole._section || 'overview');
    // On mobile, a bare #admin means the MENU — never a last-visited
    // section resurrected from earlier in this tab. On desktop it keeps
    // meaning Overview (or the last section), exactly as before.
    if (AdminConsole._isMobile() && !valid) {
      AdminConsole._level = 1;
      AdminConsole._section = fallback;
      AdminConsole._renderShell();
      AdminConsole._renderContent();
      AdminConsole._syncChrome();
      return;
    }
    AdminConsole._level = 2;
    AdminConsole._renderShell();
    // Deep-linked section wins; otherwise keep the last-visited section
    // (instant repaint on re-entry), defaulting to Overview.
    AdminConsole.setSection(valid ? section : fallback, { writeHash: false });
    // Runs after app.js's own setHeaderTitle, so on a mobile deep link the
    // header ends up showing the section's name rather than the console's.
    AdminConsole._syncChrome();
  },

  close() {
    AdminConsole._open = false;
    AdminConsole._public = false;
    AdminConsole._pushedFromMenu = false;
    // Tear the active section's timers/listeners down: leaving the console
    // must not leave a 5s /api/status or 2s /api/node-status poll running
    // for the life of the tab (see _teardownActiveSection).
    AdminConsole._teardownActiveSection();
  },

  // Re-entry while the console is ALREADY mounted (app.js routes here
  // instead of re-running the whole screen swap — see
  // navigateToAdminConsole). Resolves the target level from the requested
  // section, picks the transition direction by comparing it to the level
  // we're on, and repaints. On desktop this is just setSection.
  route(section, opts) {
    if (opts && typeof opts.public === 'boolean') AdminConsole._public = !!opts.public;
    const visible = AdminConsole._visibleSections();
    const valid = !!section && visible.some((s) => s.key === section);
    if (!AdminConsole._isMobile()) {
      // Desktop: bare #admin is Overview, as it has always been.
      AdminConsole.setSection(
        valid ? section : (AdminConsole._publicMode() ? (visible[0]?.key || 'status') : 'overview'),
        { writeHash: false },
      );
      AdminConsole._level = 2;
      AdminConsole._syncChrome();
      return;
    }
    const targetLevel = valid ? 2 : 1;
    // 1→2 push, 2→1 pop, same level (section→section deep link) instant:
    // the kit's fidelity rule is no animation on same-level repaints.
    const type = targetLevel === AdminConsole._level
      ? 'none'
      : (targetLevel === 2 ? 'push' : 'pop');
    if (targetLevel === 2) {
      AdminConsole._menuScrollTop = AdminConsole._level === 1
        ? AdminConsole._scrollTop()
        : AdminConsole._menuScrollTop;
      AdminConsole._section = section;
    } else {
      AdminConsole._pushedFromMenu = false;
    }
    AdminConsole._level = targetLevel;
    AdminConsole._transition(() => {
      AdminConsole._renderShell();
      AdminConsole._renderContent();
      AdminConsole._syncChrome();
      AdminConsole._restoreScroll();
    }, type);
  },

  // The on-screen back arrow AND the platform header's back button both
  // land here (app.js:back-btn). Returns true when the press was consumed
  // — i.e. mobile, inside a section — so the header falls through to
  // navigateHome() everywhere else (all of desktop included).
  handleBack() {
    if (!AdminConsole._open) return false;
    if (!AdminConsole._isMobile() || AdminConsole._level !== 2) return false;
    if (AdminConsole._pushedFromMenu) {
      // We pushed that entry ourselves, so the one below it IS our menu:
      // popping routes back through popstate → restoreFromHash → route(),
      // the same path the device back gesture takes.
      history.back();
      return true;
    }
    // Deep link / redirect stub: nothing of ours below. REPLACE the entry
    // with the menu rather than pushing one, so back can't bounce the
    // viewer between the section and the menu forever.
    try { history.replaceState(null, '', '#admin'); } catch { /* non-fatal */ }
    AdminConsole._level = 1;
    AdminConsole._transition(() => {
      AdminConsole._renderShell();
      AdminConsole._renderContent();
      AdminConsole._syncChrome();
      AdminConsole._restoreScroll();
    }, 'pop');
    return true;
  },

  // Drill-in from a level-1 menu row. A REAL hash navigation (the
  // leaderboard profile drill-in precedent) so the pushed entry makes the
  // browser / WebView back gesture work for free; restoreFromHash routes
  // it back into route() a tick later. Assigning location.hash preserves
  // the query string, so ?demo=1 survives the drill-in.
  _openSection(key) {
    AdminConsole._menuScrollTop = AdminConsole._scrollTop();
    AdminConsole._pushedFromMenu = true;
    const target = `#admin/${key}`;
    if (location.hash === target) {
      // Same-value assignment fires no hashchange — route by hand.
      AdminConsole.route(key);
      return;
    }
    location.hash = target;
  },

  _transition(fn, type) {
    if (window.PlatformUI?.transition) PlatformUI.transition(fn, { type: type || 'none' });
    else fn();
  },

  _scrollTop() {
    const el = document.getElementById('admin-screen');
    return el ? el.scrollTop : 0;
  },

  // A pushed screen starts at the top; a pop restores where the menu was.
  _restoreScroll() {
    const el = document.getElementById('admin-screen');
    if (!el) return;
    el.scrollTop = (AdminConsole._isMobile() && AdminConsole._level === 1)
      ? AdminConsole._menuScrollTop
      : 0;
  },

  // Platform-header chrome for the current level: inside a mobile section
  // the header becomes that section's nav bar (arrow + section name),
  // everywhere else it stays the console's own title and the home icon.
  // setHeaderTitle mirrors into document.title, so the native shell's
  // AppBar picks the section name up too.
  _syncChrome() {
    if (!window.App) return;
    const inSection = AdminConsole._isMobile() && AdminConsole._level === 2;
    if (App.setBackIcon) App.setBackIcon(inSection ? 'arrow' : 'home');
    if (!App.setHeaderTitle) return;
    if (inSection) {
      const s = AdminConsole._visibleSections().find((x) => x.key === AdminConsole._section);
      App.setHeaderTitle(s ? s.label : 'Admin & moderation');
    } else {
      App.setHeaderTitle(AdminConsole._publicMode() ? 'Platform status' : 'Admin & moderation');
    }
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

  // ── Shell: menu (sidebar / mobile list) + content host ────────────────

  // The visible sections bucketed by `group`, in first-appearance order.
  // Shared by the desktop sidebar and the mobile level-1 menu so the two
  // can never drift into different groupings.
  _groupedSections() {
    const groups = [];
    for (const s of AdminConsole._visibleSections()) {
      const name = s.group || 'Other';
      let g = groups.find((x) => x.name === name);
      if (!g) { g = { name, items: [] }; groups.push(g); }
      g.items.push(s);
    }
    return groups;
  },

  // Desktop sidebar rows, grouped under headings. Fifteen flat rows is a
  // lot to scan; the headings are the mitigation (and stay cheap — no
  // second level of nav state).
  _navItemsHtml() {
    const active = AdminConsole._section;
    const itemHtml = (s) => {
      const isActive = s.key === active;
      const cls = 'admin-nav-item block w-full text-left rounded-lg px-3 py-2 text-sm font-medium transition-colors '
        + (isActive
          ? 'bg-violet-600/10 text-violet-600 dark:text-violet-400'
          : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800');
      return `<button type="button" role="tab" aria-selected="${isActive ? 'true' : 'false'}"
        data-admin-section="${s.key}" class="${cls}">${AdminConsole.esc(s.label)}</button>`;
    };
    return AdminConsole._groupedSections().map((g, i) => `
      <div class="${i === 0 ? '' : 'mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800'}">
        <div class="px-3 pb-1 text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">${AdminConsole.esc(g.name)}</div>
        ${g.items.map(itemHtml).join('')}
      </div>`).join('');
  },

  // Mobile level 1: the section menu. A list, not a tab set — so plain
  // buttons in a <nav>, no role="tab"/aria-selected, and the drawer-row
  // idiom from index.html (44px minimum, hairline between rows, chevron
  // on the right) rather than the kit's inset-grouped card, which would
  // read as a foreign surface next to the rest of the platform.
  _mobileMenuHtml() {
    const chevron = `<svg class="w-4 h-4 shrink-0 text-zinc-400 dark:text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>`;
    const rowHtml = (s) => `
      <button type="button" data-admin-section="${s.key}"
              class="admin-menu-row flex items-center gap-3 w-full text-left min-h-[44px] px-4 py-2
                     border-b border-zinc-100 dark:border-zinc-800
                     text-zinc-700 dark:text-zinc-200
                     hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors">
        <span class="flex-1 min-w-0 text-sm font-medium truncate">${AdminConsole.esc(s.label)}</span>
        ${chevron}
      </button>`;
    const groups = AdminConsole._groupedSections().map((g) => `
      <div class="mb-5">
        <div class="px-4 pb-1.5 text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">${AdminConsole.esc(g.name)}</div>
        <div class="rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900
                    [&>button:last-child]:border-b-0">
          ${g.items.map(rowHtml).join('')}
        </div>
      </div>`).join('');
    return `<nav id="admin-mobile-menu" aria-label="Admin sections" class="-mx-4">${groups}</nav>`;
  },

  _renderShell() {
    const root = document.getElementById('admin-root');
    if (!root) return;
    // In public mode the viewer isn't an admin at all, so the view-only
    // ADMIN banner would be nonsense — suppress it rather than showing an
    // amber "you can't make changes" strip to a regular member.
    const viewOnly = !AdminConsole.canWrite() && !AdminConsole._publicMode();
    root.innerHTML = `
      <div class="md:flex md:items-start md:gap-6">
        <!-- Desktop sidebar menu. Below md there is no nav here at all:
             phones get the two-level hierarchy instead (the level-1 menu
             renders INTO #admin-section-content). -->
        <nav id="admin-nav-desktop" aria-label="Admin sections"
             class="hidden md:block md:w-56 shrink-0 space-y-1">
          ${AdminConsole._navItemsHtml()}
        </nav>
        <div class="flex-1 min-w-0">
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
            Give this to <span id="admin-temp-pw-username" class="font-medium text-zinc-800 dark:text-zinc-200"></span> out-of-band (chat, in person). They use it as their password to log in, then set their own from <a href="#settings/password" class="text-violet-500 hover:text-violet-400 underline">Settings → Change password</a>. It signs them out everywhere and <span class="font-medium">won't be shown again</span>.
          </p>
          <div class="flex gap-2">
            <code id="admin-temp-pw-value" class="flex-1 min-w-0 break-all rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-900 dark:text-zinc-100"></code>
            <button id="admin-temp-pw-copy" class="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors">Copy</button>
          </div>
          <button id="admin-temp-pw-close" class="mt-4 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">Done</button>
        </div>
      </div>`;

    AdminConsole._wireSectionButtons(root);
  },

  // Every [data-admin-section] control routes through here. On mobile a
  // press is a DRILL-IN (a real hash navigation that pushes history); on
  // desktop it's the same in-place sidebar switch it has always been.
  _wireSectionButtons(root) {
    if (!root) return;
    root.querySelectorAll('[data-admin-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.adminSection;
        if (AdminConsole._isMobile()) AdminConsole._openSection(key);
        else AdminConsole.setSection(key);
      });
    });
  },

  setSection(key, opts) {
    const visible = AdminConsole._visibleSections();
    if (!visible.some((s) => s.key === key)) {
      key = AdminConsole._publicMode() ? (visible[0]?.key || 'status') : 'overview';
    }
    AdminConsole._section = key;
    // Repaint the sidebar's active state without rebuilding the shell.
    const root = document.getElementById('admin-root');
    if (!root || !document.getElementById('admin-section-content')) {
      AdminConsole._renderShell();
    } else {
      const sideHost = document.getElementById('admin-nav-desktop');
      if (sideHost) sideHost.innerHTML = AdminConsole._navItemsHtml();
      AdminConsole._wireSectionButtons(root);
    }
    if (!opts || opts.writeHash !== false) AdminConsole._writeHash(key);
    AdminConsole._renderSection();
  },

  // Section switches update the address without polluting history —
  // replaceState, and only while we're actually on the #admin route (the
  // Leaderboard._setSub pattern). Entering/leaving the page still gets a
  // real history entry via normal hash navigation.
  //
  // Sections that own a second hash level (topochain, campaigns) are left
  // alone once we're already inside them, so their own replaceState isn't
  // fought over on every repaint.
  //
  // Mobile writes #admin/overview rather than bare #admin: down here a
  // bare #admin means the MENU, so Overview needs an explicit segment to
  // stay distinguishable (and deep-linkable) from level 1. Desktop keeps
  // the historical overview → #admin mapping.
  _writeHash(key) {
    const target = (key === 'overview' && !AdminConsole._isMobile())
      ? '#admin'
      : `#admin/${key}`;
    if (location.hash.startsWith(`${target}/`)) return;
    if (location.hash.startsWith('#admin') && location.hash !== target) {
      history.replaceState(null, '', target);
    }
  },

  // Sections whose content is owned by a separate module (#860). Each
  // exposes render(host) / destroy(); destroy() is what stops their
  // polling when you navigate away. Resolved lazily by name so a module
  // that failed to load degrades to a message instead of a crash.
  SECTION_MODULES: {
    status: 'AdminStatus',
    node: 'AdminNode',
    analytics: 'AdminAnalytics',
    merges: 'AdminMerges',
    gallery: 'AdminGallery',
    campaigns: 'AdminCampaigns',
    topochain: 'AdminTopochain',
  },

  // Stop the outgoing section's background work before its DOM is replaced.
  // Without this, Health & status keeps polling /api/status every 5s (which
  // shells out to `docker stats` server-side) and Node & chain keeps polling
  // every 2s, for the rest of the tab's life.
  _teardownActiveSection() {
    const mod = AdminConsole._activeModule;
    AdminConsole._activeModule = null;
    if (mod && typeof mod.destroy === 'function') {
      try { mod.destroy(); } catch (err) { console.error('admin section destroy failed', err); }
    }
  },

  // The single dispatcher for what goes in the content host: the mobile
  // level-1 menu, or a section. Everything that changes level goes through
  // here so the teardown below can't be skipped.
  _renderContent() {
    if (AdminConsole._isMobile() && AdminConsole._level === 1) {
      const host = document.getElementById('admin-section-content');
      if (!host) return;
      // Leaving a section for the menu MUST tear it down: otherwise a back
      // press out of Health & status leaves its 5s /api/status poll (which
      // shells out to `docker stats` server-side) running for the life of
      // the tab — exactly the leak #860's lifecycle work fixed.
      AdminConsole._teardownActiveSection();
      AdminConsole._renderMobileMenu(host);
      return;
    }
    AdminConsole._renderSection();
  },

  _renderMobileMenu(host) {
    host.innerHTML = AdminConsole._mobileMenuHtml();
    AdminConsole._wireSectionButtons(host);
  },

  _renderSection() {
    const host = document.getElementById('admin-section-content');
    if (!host) return;
    // Always tear the previous section down first — this is the single
    // choke point every section switch passes through.
    AdminConsole._teardownActiveSection();

    const key = AdminConsole._section;
    const modName = AdminConsole.SECTION_MODULES[key];
    if (modName) {
      const mod = window[modName];
      if (!mod || typeof mod.render !== 'function') {
        host.innerHTML = `<p class="p-4 text-sm text-zinc-500">The ${AdminConsole.esc(key)} console module failed to load.</p>`;
        return;
      }
      AdminConsole._activeModule = mod;
      mod.render(host);
      return;
    }
    switch (key) {
      case 'users': return AdminConsole.renderUsersSection(host);
      case 'codes': return AdminConsole.renderCodesSection(host);
      case 'limits': return AdminConsole.renderLimitsSection(host);
      case 'features': return AdminConsole.renderFeaturesSection(host);
      case 'rollover': return AdminConsole.renderRolloverSection(host);
      case 'staging-reap': return AdminConsole.renderStalePreviewsSection(host);
      case 'db-export': return AdminConsole.renderDbExportSection(host);
      default: return AdminConsole.renderOverviewSection(host);
    }
  },

  // ── Delegated sections ──────────────────────────────────────────────
  //
  // Topochain (Task 15), Health & status / Node & chain / Analytics /
  // Merge debug / Screenshot gallery / Maintenance campaigns (#860) all
  // live in their own modules, dispatched by SECTION_MODULES above rather
  // than by a render*Section method here. Two of them own a second hash
  // level entirely on their own — AdminTopochain under
  // #admin/topochain/<sub> and AdminCampaigns under
  // #admin/campaigns/<id> — reading location.hash directly and writing it
  // back with replaceState, the same pattern leaderboard.js uses for its
  // own tab state, so this file never needs general multi-level routing.

  // ── Container rollover ────────────────────────────────────────────────
  //
  // One press recreates every running child-app container with freshly
  // assembled env. Progress arrives on the shell's existing /ws/events
  // socket as `admin_rollover_status` (admin-only broadcast) and is routed
  // here by App's onmessage; GET /api/admin/rollover covers first paint and
  // WS reconnect. See src/services/app-rollover.js for why an env change
  // needs a container recreate at all.

  // Per-app outcome → chip. Mirrors the outcome vocabulary in
  // src/services/app-rollover.js; an unknown state falls back to the raw
  // string so a new outcome shows up rather than disappearing.
  ROLLOVER_STATES: {
    pending: { label: 'Queued', cls: 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300' },
    running: { label: 'Rolling over…', cls: 'bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300' },
    rolled: { label: 'Done', cls: 'bg-green-100 dark:bg-green-950/60 text-green-700 dark:text-green-400' },
    rebuilt: { label: 'Rebuilt', cls: 'bg-green-100 dark:bg-green-950/60 text-green-700 dark:text-green-400' },
    skipped_deploying: { label: 'Skipped — deploying', cls: 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300' },
    skipped_missing_secrets: { label: 'Skipped — missing secrets', cls: 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300' },
    skipped_no_db_password: { label: 'Skipped — no DB role', cls: 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300' },
    skipped_deleted: { label: 'Skipped — app gone', cls: 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300' },
    failed: { label: 'Failed', cls: 'bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-400' },
  },

  renderRolloverSection(host) {
    const canWrite = AdminConsole.canWrite();
    host.innerHTML = `
      <div class="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 border border-zinc-200 dark:border-zinc-800">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold">Container rollover</h2>
          <button id="admin-refresh-rollover" class="text-xs text-zinc-400 hover:text-violet-400">Refresh</button>
        </div>
        <p class="text-sm text-zinc-600 dark:text-zinc-400 mb-2">
          Recreates every running app container so it picks up the environment
          this platform build hands out. Needed after a platform change to what
          gets injected into containers — a restart is not enough, because a
          restarted container keeps the environment it was created with.
        </p>
        <p class="text-xs text-zinc-500 mb-4">
          This re-runs each app's existing build: it changes the environment and
          nothing else — no new code is shipped, unlike a per-app redeploy. Each
          app blinks offline for a few seconds as its turn comes up. The platform
          app itself is never touched.
        </p>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
            <div class="text-xs uppercase tracking-wide text-zinc-500">Eligible apps</div>
            <div id="admin-rollover-eligible" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
            <div class="text-xs uppercase tracking-wide text-zinc-500">At a time</div>
            <div id="admin-rollover-concurrency" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
            <div class="text-xs uppercase tracking-wide text-zinc-500">Failed</div>
            <div id="admin-rollover-failed" class="text-2xl font-bold mt-1">—</div>
          </div>
        </div>
        ${canWrite ? `
        <button id="admin-rollover-btn"
          class="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:hover:bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors">
          Roll over all app containers
        </button>` : `
        <p class="text-xs text-zinc-500">View-only admin — you can watch a rollover, but not start one.</p>`}
        <p id="admin-rollover-summary" class="text-sm text-zinc-500 mt-3">Loading…</p>
        <div id="admin-rollover-list" class="space-y-2 mt-3"></div>
      </div>`;

    document.getElementById('admin-refresh-rollover')
      ?.addEventListener('click', () => AdminConsole.loadRollover());
    document.getElementById('admin-rollover-btn')
      ?.addEventListener('click', () => AdminConsole._startRollover());

    AdminConsole.loadRollover();
  },

  async loadRollover() {
    // The page's ?demo=1 rides along on the status read so a staging
    // preview renders the demo job (routes/admin.js serves it only behind
    // IS_STAGING && ?demo=1) — same pass-through home.js and settings.js
    // use for their own demo-injected endpoints.
    const demoQS = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
    const { data } = await AdminConsole.fetchJson(`/api/admin/rollover${demoQS}`);
    if (!data || typeof data !== 'object') return;
    if (AdminConsole._section !== 'rollover') return; // navigated away mid-fetch
    AdminConsole._rolloverEligible = typeof data.eligible === 'number' ? data.eligible : null;
    AdminConsole._rolloverConcurrency = data.concurrency || null;
    AdminConsole._rolloverDemo = !!data.demo;
    AdminConsole._paintRollover(data.job || null);
  },

  // Routed here from App's /ws/events onmessage. The section may not be
  // mounted (an admin can be anywhere in the shell while a sweep runs) —
  // in that case there is nothing to repaint and the next mount picks the
  // state up from the GET.
  handleRolloverStatus(data) {
    if (!data || !AdminConsole._open) return;
    if (AdminConsole._section !== 'rollover') return;
    if (!document.getElementById('admin-rollover-list')) return;
    AdminConsole._paintRollover(data.job || null);
  },

  async _startRollover() {
    const btn = document.getElementById('admin-rollover-btn');
    const count = AdminConsole._rolloverEligible;
    const many = typeof count === 'number' ? `${count} app container${count === 1 ? '' : 's'}` : 'every running app container';
    const ok = await AdminConsole._confirm({
      title: 'Roll over all app containers?',
      message: `This recreates ${many} with the environment this platform build injects. `
        + 'Each app is briefly unavailable (a few seconds) as its turn comes up, '
        + 'and only the environment changes — no new code is shipped. '
        + 'The platform app itself is not touched.',
      confirmLabel: 'Roll over',
    });
    if (!ok) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
    try {
      const res = await fetch('/api/admin/rollover', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // Singleton job: a second press is a no-op, not an error.
        window.PlatformUI?.toast?.('A rollover is already in progress.');
        if (data && data.job) AdminConsole._paintRollover(data.job);
        return;
      }
      if (!res.ok) {
        AdminConsole._alert((data && data.error) || `Rollover failed to start (HTTP ${res.status})`);
        return;
      }
      window.PlatformUI?.toast?.('Rollover started.');
      if (data && data.job) AdminConsole._paintRollover(data.job);
    } catch (err) {
      AdminConsole._alert(`Rollover failed to start: ${err.message}`);
    } finally {
      AdminConsole.loadRollover();
    }
  },

  _paintRollover(job) {
    const esc = AdminConsole.esc;
    const eligibleEl = document.getElementById('admin-rollover-eligible');
    const concEl = document.getElementById('admin-rollover-concurrency');
    const failedEl = document.getElementById('admin-rollover-failed');
    const summary = document.getElementById('admin-rollover-summary');
    const list = document.getElementById('admin-rollover-list');
    if (!summary || !list) return;

    const running = !!(job && !job.finishedAt && !job.stale);

    if (eligibleEl) {
      eligibleEl.textContent = AdminConsole._rolloverEligible == null
        ? '—' : String(AdminConsole._rolloverEligible);
    }
    if (concEl) {
      concEl.textContent = job ? String(job.concurrency)
        : (AdminConsole._rolloverConcurrency ? String(AdminConsole._rolloverConcurrency) : '—');
    }
    if (failedEl) failedEl.textContent = job ? String(job.failed) : '—';

    const btn = document.getElementById('admin-rollover-btn');
    if (btn) {
      // A staging preview has no production containers to recreate, and the
      // route refuses the POST there — say so on the button rather than
      // letting a reviewer press it into a 400.
      const demo = !!AdminConsole._rolloverDemo;
      btn.disabled = running || demo;
      btn.textContent = demo
        ? 'Unavailable in previews'
        : (running ? 'Rollover in progress…' : 'Roll over all app containers');
    }
    const summaryPrefix = AdminConsole._rolloverDemo
      ? '<span class="text-violet-500">Staging demo data</span> — ' : '';

    if (!job) {
      summary.textContent = 'No rollover has run since this platform process started.';
      list.innerHTML = '';
      return;
    }
    if (!job.total) {
      summary.textContent = job.finishedAt
        ? 'Finished — no eligible app containers were found.'
        : 'Starting…';
      list.innerHTML = '';
      return;
    }

    const parts = [`${job.done} of ${job.total} done`];
    if (job.failed) parts.push(`${job.failed} failed`);
    const when = job.finishedAt ? 'Finished' : (job.stale ? 'Stalled' : 'Running');
    const by = job.startedBy ? ` · started by ${esc(job.startedBy)}` : '';
    summary.innerHTML = `${summaryPrefix}<span class="font-medium">${when}</span> — ${esc(parts.join(', '))}${by}`;

    list.innerHTML = '';
    for (const app of job.apps || []) {
      const chip = AdminConsole.ROLLOVER_STATES[app.state]
        || { label: app.state, cls: 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300' };
      const el = document.createElement('div');
      el.className = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-2.5 rounded-lg bg-zinc-100 dark:bg-zinc-800';
      el.setAttribute('data-rollover-slug', app.slug);
      el.setAttribute('data-rollover-state', app.state);
      const secs = app.ms == null ? '' : `${(app.ms / 1000).toFixed(1)}s`;
      el.innerHTML = `
        <span class="flex-1 min-w-0">
          <code class="font-mono text-sm">${esc(app.slug)}</code>
          ${app.error ? `<span class="block text-xs text-red-500 mt-0.5">${esc(app.error)}</span>` : ''}
        </span>
        <span class="flex items-center gap-2 shrink-0">
          ${secs ? `<span class="text-xs text-zinc-500">${esc(secs)}</span>` : ''}
          <span class="text-xs px-2 py-0.5 rounded-full ${chip.cls}">${esc(chip.label)}</span>
        </span>`;
      list.appendChild(el);
    }
  },

  // ── Stale previews ────────────────────────────────────────────────────
  //
  // The preview half of the rollover above. A staging preview's environment
  // is fixed when it is BUILT, and previews live for weeks — so a platform
  // env change leaves them running happily with stale env, which the
  // existing staging-heal sweep cannot see (it only rebuilds previews whose
  // container has STOPPED). This shuts them down; the next Preview click
  // rebuilds any that someone actually wants. Progress arrives on the
  // shell's /ws/events socket as `admin_staging_reap_status` (admin-only
  // broadcast) and is routed here by App's onmessage; GET
  // /api/admin/staging-reap covers first paint and WS reconnect. See
  // src/services/staging-reap.js.

  // Per-preview outcome → chip. Mirrors the outcome vocabulary in
  // src/services/staging-reap.js; an unknown state falls back to the raw
  // string so a new outcome shows up rather than disappearing.
  REAP_STATES: {
    pending: { label: 'Queued', cls: 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300' },
    running: { label: 'Shutting down…', cls: 'bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300' },
    torn_down: { label: 'Shut down', cls: 'bg-green-100 dark:bg-green-950/60 text-green-700 dark:text-green-400' },
    torn_down_no_db: { label: 'Shut down — database kept', cls: 'bg-green-100 dark:bg-green-950/60 text-green-700 dark:text-green-400' },
    skipped_gone: { label: 'Skipped — already gone', cls: 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300' },
    failed: { label: 'Failed', cls: 'bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-400' },
  },

  // Why each preview was picked up. Presentational only — the sweep tears
  // down everything it enumerates; this just explains what the admin is
  // looking at, and distinguishes "expected leftover of a merged proposal"
  // from "the session row is gone entirely".
  REAP_CLASSIFICATIONS: {
    merged: 'proposal merged',
    archived: 'proposal abandoned',
    promoted: 'up for a vote',
    merging: 'merging now',
    active: 'session open',
    paused: 'session paused',
    merged_unlinked: 'merged — leaked past teardown',
    archived_unlinked: 'abandoned — leaked past teardown',
    promoted_unlinked: 'up for a vote — link lost',
    no_session_row: 'session no longer exists',
  },

  renderStalePreviewsSection(host) {
    const canWrite = AdminConsole.canWrite();
    host.innerHTML = `
      <div class="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 border border-zinc-200 dark:border-zinc-800">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold">Stale previews</h2>
          <button id="admin-refresh-reap" class="text-xs text-zinc-400 hover:text-violet-400">Refresh</button>
        </div>
        <p class="text-sm text-zinc-600 dark:text-zinc-400 mb-2">
          Shuts down every proposal preview that is still running. A preview's
          settings are fixed when it is built, so after a platform change to
          what gets injected into containers, old previews keep running with
          the old settings — typically showing a login screen instead of the
          app. Out-of-date previews are now found and cleaned up
          automatically in the background; this button is the immediate
          version, and takes every preview rather than only the stale ones.
        </p>
        <p class="text-xs text-zinc-500 mb-4">
          Nothing is lost that matters: clicking Preview on a proposal rebuilds
          it automatically with current settings, the same way a preview that
          went to sleep does. A preview's throwaway test data is discarded, and
          rebuilding re-runs that proposal's automated checks.
        </p>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
            <div class="text-xs uppercase tracking-wide text-zinc-500">Open previews</div>
            <div id="admin-reap-stale" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
            <div class="text-xs uppercase tracking-wide text-zinc-500">Out of date</div>
            <div id="admin-reap-outdated" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
            <div class="text-xs uppercase tracking-wide text-zinc-500">At a time</div>
            <div id="admin-reap-concurrency" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
            <div class="text-xs uppercase tracking-wide text-zinc-500">Failed</div>
            <div id="admin-reap-failed" class="text-2xl font-bold mt-1">—</div>
          </div>
        </div>
        <p id="admin-reap-automatic" class="text-xs text-zinc-500 mb-4"></p>
        ${canWrite ? `
        <button id="admin-reap-btn"
          class="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:hover:bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors">
          Shut down stale previews
        </button>` : `
        <p class="text-xs text-zinc-500">View-only admin — you can watch a sweep, but not start one.</p>`}
        <p id="admin-reap-summary" class="text-sm text-zinc-500 mt-3">Loading…</p>
        <div id="admin-reap-list" class="space-y-2 mt-3"></div>
      </div>`;

    document.getElementById('admin-refresh-reap')
      ?.addEventListener('click', () => AdminConsole.loadStagingReap());
    document.getElementById('admin-reap-btn')
      ?.addEventListener('click', () => AdminConsole._startStagingReap());

    AdminConsole.loadStagingReap();
  },

  async loadStagingReap() {
    // The page's ?demo=1 rides along on the status read so a staging preview
    // renders the demo job (routes/admin.js serves it only behind
    // IS_STAGING && ?demo=1) — a preview has no docker socket, so there is
    // nothing real for this section to show there. Same pass-through
    // loadRollover uses.
    const demoQS = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
    const { data } = await AdminConsole.fetchJson(`/api/admin/staging-reap${demoQS}`);
    if (!data || typeof data !== 'object') return;
    if (AdminConsole._section !== 'staging-reap') return; // navigated away mid-fetch
    // `open` is every preview (what the button shuts down); `stale` is the
    // out-of-date subset the automatic pass acts on. Older payloads carried
    // only `stale` meaning "all previews", so fall back to it for `open`.
    AdminConsole._reapOpen = typeof data.open === 'number' ? data.open
      : (typeof data.stale === 'number' ? data.stale : null);
    AdminConsole._reapOutdated = typeof data.stale === 'number' ? data.stale : null;
    AdminConsole._reapAutomatic = data.automatic || null;
    AdminConsole._reapConcurrency = data.concurrency || null;
    AdminConsole._reapDemo = !!data.demo;
    // Tracked separately from _reapDemo: the POST is refused in a preview
    // whether or not the reviewer arrived with ?demo=1.
    AdminConsole._reapStaging = !!data.staging;
    AdminConsole._paintStagingReap(data.job || null);
  },

  // Routed here from App's /ws/events onmessage. The section may not be
  // mounted (an admin can be anywhere in the shell while a sweep runs) — in
  // that case there is nothing to repaint and the next mount picks the state
  // up from the GET.
  handleStagingReapStatus(data) {
    if (!data || !AdminConsole._open) return;
    if (AdminConsole._section !== 'staging-reap') return;
    if (!document.getElementById('admin-reap-list')) return;
    AdminConsole._paintStagingReap(data.job || null);
  },

  async _startStagingReap() {
    const btn = document.getElementById('admin-reap-btn');
    // The button takes EVERY open preview, not just the out-of-date ones, so
    // the confirmation counts `open` — saying "4 previews" when it will shut
    // down 6 would be a lie about a fleet-wide action.
    const count = AdminConsole._reapOpen;
    const many = typeof count === 'number'
      ? `${count} preview${count === 1 ? '' : 's'}`
      : 'every open preview';
    const ok = await AdminConsole._confirm({
      title: 'Shut down stale previews?',
      message: `This shuts down ${many}. Anyone who wants one back gets it `
        + 'rebuilt automatically on their next Preview click, with current '
        + "settings. Each preview's throwaway test data is discarded, and "
        + "rebuilding re-runs that proposal's automated checks.",
      confirmLabel: 'Shut down',
    });
    if (!ok) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
    try {
      const res = await fetch('/api/admin/staging-reap', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // Singleton job: a second press is a no-op, not an error.
        window.PlatformUI?.toast?.('A sweep is already in progress.');
        if (data && data.job) AdminConsole._paintStagingReap(data.job);
        return;
      }
      if (!res.ok) {
        AdminConsole._alert((data && data.error) || `Sweep failed to start (HTTP ${res.status})`);
        return;
      }
      window.PlatformUI?.toast?.('Sweep started.');
      if (data && data.job) AdminConsole._paintStagingReap(data.job);
    } catch (err) {
      AdminConsole._alert(`Sweep failed to start: ${err.message}`);
    } finally {
      AdminConsole.loadStagingReap();
    }
  },

  // "3 minutes ago" for the automatic pass's last run. Kept local and tiny:
  // the only consumer is the one line below.
  _reapAgo(iso) {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return null;
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  },

  _paintStagingReap(job) {
    const esc = AdminConsole.esc;
    const staleEl = document.getElementById('admin-reap-stale');
    const outdatedEl = document.getElementById('admin-reap-outdated');
    const autoEl = document.getElementById('admin-reap-automatic');
    const concEl = document.getElementById('admin-reap-concurrency');
    const failedEl = document.getElementById('admin-reap-failed');
    const summary = document.getElementById('admin-reap-summary');
    const list = document.getElementById('admin-reap-list');
    if (!summary || !list) return;

    const running = !!(job && !job.finishedAt && !job.stale);

    if (staleEl) {
      staleEl.textContent = AdminConsole._reapOpen == null
        ? '—' : String(AdminConsole._reapOpen);
    }
    if (outdatedEl) {
      outdatedEl.textContent = AdminConsole._reapOutdated == null
        ? '—' : String(AdminConsole._reapOutdated);
    }
    if (autoEl) {
      const auto = AdminConsole._reapAutomatic;
      if (!auto || !auto.intervalMs) {
        autoEl.textContent = 'The automatic background sweep is switched off.';
      } else if (!auto.lastRunAt) {
        const every = Math.round(auto.intervalMs / 60000);
        autoEl.textContent = `Automatic sweep runs every ${every} minutes — it hasn't run yet since this platform process started.`;
      } else {
        const ago = AdminConsole._reapAgo(auto.lastRunAt) || 'recently';
        const bits = [`Automatic sweep last ran ${ago}`];
        bits.push(`${auto.tornDown || 0} shut down`);
        if (auto.failed) bits.push(`${auto.failed} failed`);
        autoEl.textContent = `${bits.join(' · ')}.`;
      }
    }
    if (concEl) {
      concEl.textContent = job ? String(job.concurrency)
        : (AdminConsole._reapConcurrency ? String(AdminConsole._reapConcurrency) : '—');
    }
    if (failedEl) failedEl.textContent = job ? String(job.failed) : '—';

    const btn = document.getElementById('admin-reap-btn');
    if (btn) {
      // A preview has no docker socket, so it cannot manage other previews,
      // and the route refuses the POST there — say so on the button rather
      // than letting a reviewer press it into a 400. Gate on `staging`, not
      // on `demo`: the refusal applies with or without ?demo=1.
      const preview = !!AdminConsole._reapStaging || !!AdminConsole._reapDemo;
      btn.disabled = running || preview;
      btn.textContent = preview
        ? 'Unavailable in previews'
        : (running ? 'Sweep in progress…' : 'Shut down stale previews');
    }
    const summaryPrefix = AdminConsole._reapDemo
      ? '<span class="text-violet-500">Staging demo data</span> — ' : '';

    if (!job) {
      summary.textContent = 'No sweep has run since this platform process started.';
      list.innerHTML = '';
      return;
    }
    if (!job.total) {
      summary.textContent = job.finishedAt
        ? 'Finished — no open previews were found.'
        : 'Starting…';
      list.innerHTML = '';
      return;
    }

    const parts = [`${job.done} of ${job.total} done`];
    if (job.failed) parts.push(`${job.failed} failed`);
    const when = job.finishedAt ? 'Finished' : (job.stale ? 'Stalled' : 'Running');
    const by = job.startedBy ? ` · started by ${esc(job.startedBy)}` : '';
    summary.innerHTML = `${summaryPrefix}<span class="font-medium">${when}</span> — ${esc(parts.join(', '))}${by}`;

    list.innerHTML = '';
    for (const preview of job.previews || []) {
      const chip = AdminConsole.REAP_STATES[preview.state]
        || { label: preview.state, cls: 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300' };
      const why = AdminConsole.REAP_CLASSIFICATIONS[preview.classification]
        || preview.classification;
      const el = document.createElement('div');
      el.className = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-2.5 rounded-lg bg-zinc-100 dark:bg-zinc-800';
      el.setAttribute('data-reap-name', preview.name);
      el.setAttribute('data-reap-state', preview.state);
      const secs = preview.ms == null ? '' : `${(preview.ms / 1000).toFixed(1)}s`;
      el.innerHTML = `
        <span class="flex-1 min-w-0">
          <code class="font-mono text-sm">${esc(preview.slug)}</code>
          <span class="text-xs text-zinc-500 ml-1">#${esc(String(preview.sessionId))}</span>
          <span class="block text-xs text-zinc-500 mt-0.5">${esc(why)}</span>
          ${preview.error ? `<span class="block text-xs text-red-500 mt-0.5">${esc(preview.error)}</span>` : ''}
        </span>
        <span class="flex items-center gap-2 shrink-0">
          ${secs ? `<span class="text-xs text-zinc-500">${esc(secs)}</span>` : ''}
          <span class="text-xs px-2 py-0.5 rounded-full ${chip.cls}">${esc(chip.label)}</span>
        </span>`;
      list.appendChild(el);
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
        // In-SPA register route (fold-auth-pages-into-SPA); the old
        // /register.html?code=… form still works via the redirect stub.
        const url = `${location.origin}/#register/${encodeURIComponent(btn.dataset.code)}`;
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
