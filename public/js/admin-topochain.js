// "Seasons, Events & Challenges" admin console screens (Task 15,
// migration plan Global Constraint #8: "Admin screens are ONE
// AdminConsole section that renders its own sub-navigation from
// public/js/admin-topochain.js").
// Mounted by AdminConsole._renderSection via SECTION_MODULES (#860;
// public/js/admin-console.js)
// into the section's #admin-section-content host, exactly like every other
// renderXSection — the only difference is this module owns a SECOND hash
// level of its own (#admin/seasons/<sub>) that AdminConsole never learns
// the keys of. It reads location.hash directly for the deep-linked sub-key
// on first render and writes it back itself via replaceState, guarded on
// '#admin/seasons' — the same pattern public/js/leaderboard.js uses for
// its own tab state (_setSub/_syncHash) — so admin-console.js's existing
// single-level setSection/_writeHash needed no changes at all.
//
// NAMING: the section was called "Topochain" until the rename, and the
// canonical route is now #admin/seasons/<sub> (the Seasons tab itself is
// #admin/seasons/seasons). #admin/topochain/<sub> is a PERMANENT alias:
// _subFromHash() reads either prefix, _syncHash() only ever writes the
// canonical one, and app.js rewrites the address bar so a bookmark
// self-heals. The file name, the AdminTopochain global, the
// `topochain_` settings-key prefix, the /api/v4/admin/* routes and the
// database tables are all deliberately unchanged — this rename is
// user-facing copy and routing only.
//
// LAYOUT: the eleven subsections are grouped into two collapsible groups
// (SUB_GROUPS below) shown in a LEFT MENU, not a top strip. At lg+ the
// menu is a sticky 13rem column beside the screen; below lg it collapses
// to a single summary button ("<group> · <screen>") that opens the same
// two groups as an accordion, because a second permanent column would
// starve the tables. Both layouts render from the same markup rules and
// the visible one is chosen by breakpoint classes alone — there is no
// matchMedia here, so nothing has to be re-rendered on resize.
// Expanding/collapsing a group mutates the menu DOM IN PLACE and never
// calls _renderShell()/_renderSub(): remounting would throw away the SQL
// console's editor contents, the API tester's request body and every
// screen's pagination. Which groups are collapsed persists in
// localStorage (NAV_GROUPS_KEY), except that the group owning the screen
// you are actually on is always forced open. Every screen renders
// through the shared _list() renderer (a real table at md+, a card stack
// below) and the shared _skeleton()/_empty()/_error() helpers, so
// "loading", "nothing here" and "the request failed" never look alike.
//
// SECURITY (a previous task shipped an XSS here — non-negotiable): every
// interpolated value goes through esc() below, including attribute values
// (esc() escapes quotes too, ported verbatim from topochain-challenges.js /
// topochain-leaderboard.js's hardened version — plain &/</> escaping is
// not enough for a double-quoted attribute value). Any URL this module
// would ever render into an href goes through safeHref() first (http(s)
// scheme only) — in practice this module never renders an admin/API-
// supplied URL as a clickable anchor at all (app-version-configs'
// update_url and challenge-templates' cta_link/mobile_cta_link are shown
// as escaped text, not links, since neither screen needs them to be
// clickable), but safeHref() is kept here per the task brief's standing
// instruction and used for the one applicable case (the CSV export link).
//
// VOCABULARY (SPEC §5.4's rename table): every label here says "Event"
// (never "Phase"), "User" (never "Participant"), "Challenge template"
// (never "Activity type"), "Kind" for the challenge sub-category. This
// file must never introduce "Phase" or "Participant" as a user-facing
// label — tests/topochain-admin-screens.test.js checks for it.
//
// canWrite() (delegates to AdminConsole.canWrite()) gates EVERY mutating
// control: view-only admins (is_admin && admin_readonly) see the same
// data with every Save/Delete/Import/Reset/Run-a-write button simply
// absent from the rendered HTML, mirroring admin-console.js's own
// convention. Every handler that performs a mutating fetch also opens
// with an `if (!AdminTopochain.canWrite()) return;` guard as defense in
// depth (the control shouldn't be reachable at all, but a stale DOM
// reference or a copy/paste of this pattern elsewhere should not be able
// to fire the request either).
//
// DOCUMENTED API GAPS (per the task brief: build only what the API
// supports; document what's missing rather than inventing endpoints or
// shipping dead UI):
//   - `seasons`: there is no /api/v4/admin/seasons resource at all (only
//     season_events carries a season_id). This subsection is therefore a
//     READ-ONLY view derived by grouping GET /api/v4/admin/season-events
//     by season_id — no create/edit/delete, because there is nothing to
//     call. See renderSeasons() below.
//   - `challenge-kinds`: no admin (or public) endpoint lists
//     `challenge_kinds` rows at all — every reference in the API is a
//     server-side existence check on `kind` (challenge-templates.js,
//     challenges.js), never a listable resource. Not built; the Kind
//     field on Challenge templates/Challenges is a free-text input with
//     inline help text saying so.
//   - `terms-versions` and `token-allocation`: no admin CRUD/read routes
//     exist for either (only mobile.js reads terms_versions/token_allocation
//     for the mobile client, which is a different auth surface). Not
//     built — there is nothing under /api/v4/admin for either resource.
//   - `mobile-logs`: no admin endpoint lists per-user log payloads. The
//     one related admin capability that DOES exist is `accept_logs` on
//     the Users resource (PUT/PATCH /api/v4/admin/users/:id), which is
//     surfaced as a field on the Users edit form instead of a standalone
//     "Mobile logs" tab — this is the judgment call the task brief
//     anticipated ("surface via users' accept_logs toggle, documented").
// None of the four gaps above appear in SUBS — a missing tab beats a
// dead one.
'use strict';

// ── Control styling tokens ───────────────────────────────────────────
//
// Every button, field and panel in this file is built from the strings
// below rather than a hand-written class list, so size, radius, focus
// ring and colour are identical on all eleven screens — the first pass
// modernised the LISTS and left each form and editor with whatever
// classes it happened to be written with.
//
// They are plain string constants rather than a helper that RETURNS a
// <button> for two reasons: the class names stay WHOLE LITERALS, which
// is the only form Tailwind's extractor scans for, and the markup keeps
// the literal ``canWrite ? `<button …`` shape that
// tests/topochain-admin-screens.test.js counts to prove every mutating
// control is gated.
//
// Tap targets are >= 44px tall below sm: (a finger) and tighten to a
// pointer-sized control at sm: and up, where a mouse is likely and
// vertical space is worth more. `touch-manipulation` drops the 300ms
// double-tap delay that otherwise makes the small row chips feel dead.
const BTN_BASE = 'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium '
  + 'transition-colors touch-manipulation focus:outline-none focus-visible:ring-2 '
  + 'focus-visible:ring-violet-500 disabled:opacity-40 disabled:pointer-events-none';
const BTN_MD = 'min-h-[44px] sm:min-h-[36px] px-4 py-2 text-sm';
const BTN_SM = 'min-h-[44px] sm:min-h-[34px] px-3 py-1.5 text-sm';
const BTN_ROW = 'min-h-[36px] sm:min-h-[30px] px-2.5 py-1 text-xs';
const BTN = {
  // Page/panel-level primary + secondary (Save, Cancel, Run, Send).
  primary: `${BTN_BASE} ${BTN_MD} bg-violet-600 hover:bg-violet-500 text-white shadow-sm`,
  secondary: `${BTN_BASE} ${BTN_MD} border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800`,
  // Toolbar variants — same colours, one size down.
  primarySm: `${BTN_BASE} ${BTN_SM} bg-violet-600 hover:bg-violet-500 text-white shadow-sm`,
  secondarySm: `${BTN_BASE} ${BTN_SM} border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800`,
  dangerSm: `${BTN_BASE} ${BTN_SM} bg-red-600 hover:bg-red-500 text-white`,
  warnSm: `${BTN_BASE} ${BTN_SM} border border-amber-400 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40`,
  // Row actions. Chips, not bare text links: a bordered box is a target
  // you can see and hit, and it wraps predictably inside both the table
  // cell and the card footer _list() renders them into.
  row: `${BTN_BASE} ${BTN_ROW} border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400`,
  rowPrimary: `${BTN_BASE} ${BTN_ROW} border border-violet-300 dark:border-violet-800 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/40`,
  rowDanger: `${BTN_BASE} ${BTN_ROW} border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40`,
  rowWarn: `${BTN_BASE} ${BTN_ROW} border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40`,
  // Full-width list entry in a reference sidebar (SQL templates, schema
  // tables). Left-aligned rather than centred, and tall enough to hit.
  sidebar: 'flex w-full items-center min-h-[36px] rounded-lg px-2.5 py-1.5 text-left text-xs '
    + 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 '
    + 'touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500',
  // Back control on a nested screen, and the ✕ in a panel header.
  back: `${BTN_BASE} min-h-[44px] sm:min-h-[36px] -ml-2 px-2 py-1 text-sm text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/40`,
  close: 'inline-flex shrink-0 items-center justify-center h-9 w-9 rounded-lg text-zinc-500 '
    + 'hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 '
    + 'touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500',
};

// Text inputs / selects / textareas. Same 44px-then-36px rule as the
// buttons so a field and the button beside it line up at every width.
const FIELD_CLS = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 '
  + 'px-3 py-2 text-sm min-h-[44px] sm:min-h-[36px] focus:outline-none focus:ring-2 '
  + 'focus:ring-violet-500 focus:border-transparent disabled:opacity-60';
// Textareas set their height from `rows`, so they take everything but
// the min-height.
const TEXTAREA_CLS = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 '
  + 'px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent';

// Panel and card surfaces, shared by every form, picker and detail view.
const PANEL_CLS = 'rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm';

// Which left-menu groups the operator has collapsed, as a JSON
// groupKey -> true map. Only collapsed groups are stored, so a group
// added later defaults to whatever DEFAULT_COLLAPSED says rather than
// inheriting a stale preference.
const NAV_GROUPS_KEY = 'topoNavGroups';

const AdminTopochain = {
  _host: null,
  _sub: null,

  // Built subsections only (see the file-header gap list above for what's
  // deliberately absent and why).
  SUBS: [
    { key: 'seasons', label: 'Seasons' },
    { key: 'season-events', label: 'Season events' },
    { key: 'users', label: 'Users' },
    { key: 'waitlist', label: 'Waitlist' },
    { key: 'onchain-accounts', label: 'Onchain accounts' },
    { key: 'user-activities', label: 'User activities' },
    { key: 'challenge-templates', label: 'Challenge templates' },
    { key: 'settings', label: 'Settings' },
    { key: 'app-version', label: 'App version' },
    { key: 'sql-console', label: 'SQL console' },
    { key: 'api-tester', label: 'API tester' },
  ],

  // The same eleven keys, grouped for the left menu. SUBS stays the flat
  // key -> label source of truth (routing, validation and the sub titles
  // all read it); SUB_GROUPS only decides ORDER and HEADINGS, so a new
  // subsection is added in both places and nowhere else. The two lists
  // are a bijection — tests/topochain-admin-screens.test.js checks that
  // every SUBS key appears in exactly one group and vice versa, so a key
  // can never go missing from the nav by being added to only one list.
  //
  // Two groups, not the previous four: the menu is now a column, and a
  // column of four two-item headings is mostly headings. The first group
  // is the programme and the people in it — everything you open this
  // section FOR. The second is what people did plus the operator tooling
  // (raw SQL, arbitrary API calls, the settings that change how the
  // mobile app behaves) — the sharp ones, deliberately last and
  // collapsed by default.
  SUB_GROUPS: [
    {
      key: 'programme',
      label: 'Seasons, Events & Challenges',
      subs: ['seasons', 'season-events', 'challenge-templates', 'users', 'waitlist', 'onchain-accounts'],
    },
    {
      key: 'platform',
      label: 'Activity & platform tools',
      subs: ['user-activities', 'settings', 'app-version', 'sql-console', 'api-tester'],
    },
  ],

  // Which groups start collapsed for an operator who has never touched
  // the menu. A stored preference wins over this; the group owning the
  // current screen overrides both (see setSub).
  DEFAULT_COLLAPSED: { platform: true },

  // ── Shared helpers ─────────────────────────────────────────────────

  // Escapes every character dangerous in EITHER a text-node OR a
  // double-quoted attribute-value context (this module interpolates into
  // both, e.g. inside data-* attributes) — ported verbatim from
  // topochain-challenges.js's hardened esc(), NOT the older &/</>-only
  // version in admin-console.js.
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  // href-safe URL: only http(s) links may ever become a real anchor.
  // esc() alone stops attribute breakout but not a `javascript:` scheme,
  // which executes on click with no markup injection needed at all.
  safeHref(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
  },

  canWrite() { return !!(window.AdminConsole && AdminConsole.canWrite()); },
  _alert(message) { if (window.AdminConsole) AdminConsole._alert(message); else window.alert(message); },
  async _confirm(opts) { return window.AdminConsole ? AdminConsole._confirm(opts) : window.confirm(opts.message); },

  // Safe fetch+parse, never throws — same contract as
  // AdminConsole.fetchJson/TopochainChallenges.fetchJson, extended with an
  // options bag so this module can also POST/PUT/PATCH/DELETE (the other
  // two only ever GET).
  async fetchJson(url, opts) {
    try {
      const res = await fetch(url, { credentials: 'same-origin', ...(opts || {}) });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return { status: res.status, ok: res.ok, data: null };
      try { return { status: res.status, ok: res.ok, data: await res.json() }; }
      catch { return { status: res.status, ok: res.ok, data: null }; }
    } catch {
      return { status: 0, ok: false, data: null };
    }
  },

  // JSON-body convenience wrapper for the mutating verbs.
  async send(method, url, body) {
    const opts = { method };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    return AdminTopochain.fetchJson(url, opts);
  },

  // ── Small HTML-building helpers (used across every subsection) ─────

  // One labelled field. `block` + `w-full` on the control means a field
  // is full-width wherever it is put; the multi-column forms get their
  // columns from _formGrid()'s grid, never from the field itself.
  _field(label, innerHtml, help) {
    const esc = AdminTopochain.esc;
    return `<label class="block text-xs">
      <span class="font-medium text-zinc-600 dark:text-zinc-400">${esc(label)}</span>
      <div class="mt-1">${innerHtml}</div>
      ${help ? `<span class="block mt-1 text-[11px] leading-snug text-zinc-400">${esc(help)}</span>` : ''}
    </label>`;
  },

  // A checkbox reads as a control plus its label, not as a label with a
  // control under it, so it gets its own row shape with a tap target
  // that covers the text as well as the box.
  _checkField(id, label, checked, help) {
    const esc = AdminTopochain.esc;
    return `<label class="flex items-start gap-2.5 min-h-[44px] sm:min-h-[36px] py-2 cursor-pointer">
      <input id="${esc(id)}" type="checkbox" ${checked ? 'checked' : ''}
        class="mt-0.5 h-5 w-5 shrink-0 rounded border-zinc-300 dark:border-zinc-600 text-violet-600 focus:ring-2 focus:ring-violet-500">
      <span class="text-xs">
        <span class="font-medium text-zinc-600 dark:text-zinc-400">${esc(label)}</span>
        ${help ? `<span class="block mt-0.5 text-[11px] leading-snug text-zinc-400">${esc(help)}</span>` : ''}
      </span>
    </label>`;
  },

  _inputHtml(id, opts = {}) {
    const esc = AdminTopochain.esc;
    const type = opts.type || 'text';
    const val = opts.value == null ? '' : opts.value;
    const parts = [
      `id="${esc(id)}"`, `type="${esc(type)}"`,
      `class="${FIELD_CLS}"`,
    ];
    if (opts.step != null) parts.push(`step="${esc(opts.step)}"`);
    if (opts.min != null) parts.push(`min="${esc(opts.min)}"`);
    if (opts.placeholder) parts.push(`placeholder="${esc(opts.placeholder)}"`);
    if (opts.disabled) parts.push('disabled');
    if (type === 'checkbox') {
      return `<input ${parts.filter((p) => !p.startsWith('class=')).join(' ')}
        class="h-5 w-5 rounded border-zinc-300 dark:border-zinc-600 text-violet-600 focus:ring-2 focus:ring-violet-500" ${opts.value ? 'checked' : ''}>`;
    }
    return `<input ${parts.join(' ')} value="${esc(val)}">`;
  },

  _textareaHtml(id, value, rows) {
    const esc = AdminTopochain.esc;
    return `<textarea id="${esc(id)}" rows="${esc(rows || 3)}"
      class="${TEXTAREA_CLS}">${esc(value)}</textarea>`;
  },

  _selectHtml(id, options, selected, opts = {}) {
    const esc = AdminTopochain.esc;
    const optsHtml = options.map((o) => {
      const val = typeof o === 'object' ? o.value : o;
      const label = typeof o === 'object' ? o.label : o;
      const isSel = String(selected) === String(val) ? ' selected' : '';
      return `<option value="${esc(val)}"${isSel}>${esc(label)}</option>`;
    }).join('');
    return `<select id="${esc(id)}" ${opts.multiple ? 'multiple size="5"' : ''} ${opts.disabled ? 'disabled' : ''}
      class="${FIELD_CLS}">
      ${opts.blank ? `<option value="">${esc(opts.blank)}</option>` : ''}${optsHtml}</select>`;
  },

  _isoToLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },
  _localInputToIso(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  },

  // ── Shared state blocks ────────────────────────────────────────────
  //
  // Loading, empty and failed used to look identical on these screens: a
  // grey "Loading…" that either stayed forever or was replaced by
  // nothing. These three helpers make the states distinguishable at a
  // glance, and every loader below uses them.

  // Loading placeholder shaped like the rows it is standing in for, so
  // the layout doesn't jump when the data lands.
  _skeleton(rows) {
    const n = Math.max(1, Math.min(rows == null ? 4 : rows, 10));
    const bars = Array.from({ length: n }, (_, i) => {
      const w = ['w-3/4', 'w-full', 'w-5/6', 'w-2/3'][i % 4];
      return `<div class="h-4 ${w} rounded bg-zinc-200 dark:bg-zinc-800"></div>`;
    }).join('');
    return `<div class="animate-pulse space-y-2 py-2" aria-hidden="true">${bars}</div>
      <p class="sr-only" role="status">Loading&hellip;</p>`;
  },

  // "Nothing here yet" — a title, an optional explanation, and an
  // optional call to action. The action is dropped entirely for
  // view-only admins (same rule as every other control in this file):
  // an empty state whose only affordance 403s is worse than no
  // affordance.
  _empty(opts) {
    const esc = AdminTopochain.esc;
    const o = opts || {};
    const body = o.body
      ? `<p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">${esc(o.body)}</p>` : '';
    const action = (o.actionId && AdminTopochain.canWrite())
      ? `<div class="mt-4 flex justify-center"><button id="${esc(o.actionId)}" type="button"
           class="${BTN.primarySm}">${esc(o.actionLabel || 'Create')}</button></div>`
      : '';
    return `<div class="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 px-4 py-10 text-center">
      <p class="text-sm font-medium text-zinc-600 dark:text-zinc-300">${esc(o.title || 'Nothing here yet')}</p>
      ${body}${action}
    </div>`;
  },

  // "The request failed" — visually distinct from empty (red, not
  // dashed-grey) and always retryable. `retryId` wires to whatever
  // loader produced it; a status of 0 means the request never got an
  // answer at all (offline / server down), which is worth saying.
  _error(opts) {
    const esc = AdminTopochain.esc;
    const o = opts || {};
    const detail = o.status === 0
      ? "Couldn't reach the server."
      : (o.message || `Request failed${o.status ? ` (HTTP ${o.status})` : ''}.`);
    const retry = o.retryId
      ? `<div class="mt-4 flex justify-center"><button id="${esc(o.retryId)}" type="button"
           class="${BTN_BASE} ${BTN_SM} border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-950/60">Try again</button></div>`
      : '';
    return `<div class="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-4 py-8 text-center">
      <p class="text-sm font-medium text-red-700 dark:text-red-300">${esc(o.title || "Couldn't load this")}</p>
      <p class="mt-1 text-xs text-red-600 dark:text-red-400">${esc(detail)}</p>
      ${retry}
    </div>`;
  },

  // Wires the retry button an _error() block rendered. Safe to call when
  // no error is on screen.
  _wireRetry(retryId, onRetry) {
    document.getElementById(retryId)?.addEventListener('click', onRetry);
  },

  // ── Shared panel / form chrome ─────────────────────────────────────
  //
  // Every create, edit, import, detail and console surface in this file
  // is rendered through _panel(), so they all get the same border,
  // padding, header treatment and dismiss control. The header is
  // `sticky top-0` inside the panel: on a long form (the challenge
  // template editor, the settings editor) the title and the ✕ stay put
  // while the fields scroll past, so "how do I get out of this" is
  // always answerable without scrolling back up.
  //
  // opts:
  //   title / subtitle: header text (subtitle optional).
  //   closeId:   id for the ✕ control. Omit for a panel that has no
  //              dismiss (the always-present consoles).
  //   closeLabel: accessible name for it (default "Close").
  //   body:      already-escaped html.
  //   footer:    already-escaped html for the action bar. Rendered in a
  //              `flex-wrap` row that wraps instead of overflowing.
  //   tone:      'danger' tints the header for destructive panels.
  //   class:     extra classes on the outer element.
  _panel(opts) {
    const esc = AdminTopochain.esc;
    const o = opts || {};
    const closeLabel = o.closeLabel || 'Close';
    const close = o.closeId
      ? `<button id="${esc(o.closeId)}" type="button" class="${BTN.close}"
           aria-label="${esc(closeLabel)}" title="${esc(closeLabel)}">
           <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"/></svg>
         </button>`
      : '';
    const headTone = o.tone === 'danger'
      ? 'bg-red-50/90 dark:bg-red-950/40 border-red-200 dark:border-red-900'
      : 'bg-white/90 dark:bg-zinc-900/90 border-zinc-200 dark:border-zinc-800';
    const subtitle = o.subtitle
      ? `<p class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">${esc(o.subtitle)}</p>` : '';
    const footer = o.footer
      ? `<div class="flex flex-wrap items-center gap-2 border-t border-zinc-200 dark:border-zinc-800 px-4 py-3 sm:px-5">${o.footer}</div>`
      : '';
    return `<section class="${PANEL_CLS} overflow-hidden mb-4 ${o.class || ''}">
      <header class="sticky top-0 z-10 flex items-start justify-between gap-3 border-b px-4 py-3 sm:px-5 backdrop-blur ${headTone}">
        <div class="min-w-0">
          <h3 class="text-sm font-semibold truncate">${esc(o.title || '')}</h3>
          ${subtitle}
        </div>
        ${close}
      </header>
      <div class="px-4 py-4 sm:px-5">${o.body || ''}</div>
      ${footer}
    </section>`;
  },

  // The heading strip at the top of a screen: title on the left,
  // toolbar on the right. Stacks below sm: so a long title and three
  // buttons don't fight over one line on a phone.
  _screenHeader(opts) {
    const esc = AdminTopochain.esc;
    const o = opts || {};
    const subtitle = o.subtitle
      ? `<p class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">${esc(o.subtitle)}</p>` : '';
    const actions = o.actions
      ? `<div class="flex flex-wrap items-center gap-2 sm:justify-end">${o.actions}</div>` : '';
    return `<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <h2 class="text-base font-semibold">${esc(o.title || '')}</h2>
        ${subtitle}
      </div>
      ${actions}
    </div>`;
  },

  // The field grid every form uses: one full-width column on a phone,
  // two from md: up. `cols: 3` opts into a third column at lg: for the
  // short numeric forms. Fields that need the full width in the wider
  // layouts carry `md:col-span-2` / `lg:col-span-3` themselves.
  _formGrid(innerHtml, cols) {
    const wide = cols === 3
      ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
      : 'grid-cols-1 md:grid-cols-2';
    return `<div class="grid gap-4 ${wide}">${innerHtml}</div>`;
  },

  // Save / Cancel pair for a _panel footer, in that visual order with
  // the primary first so it is under the thumb on a phone.
  _formActions(saveId, cancelId, saveLabel) {
    const esc = AdminTopochain.esc;
    return `<button id="${esc(saveId)}" type="button" class="${BTN.primary}">${esc(saveLabel || 'Save')}</button>
      <button id="${esc(cancelId)}" type="button" class="${BTN.secondary}">Cancel</button>`;
  },

  // Inline validation / submit-failure slot for a form panel. Rendered
  // empty and hidden; the save handlers fill it in.
  _formErrorSlot(id) {
    const esc = AdminTopochain.esc;
    return `<p id="${esc(id)}" class="hidden mt-3 rounded-lg bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-600 dark:text-red-400" role="alert"></p>`;
  },

  // ── Shared responsive list renderer ────────────────────────────────
  //
  // ONE column definition renders BOTH layouts: a real <table> at md+
  // (where there is room for it) and a stack of cards below, where a
  // table could only ever be scrolled sideways one column at a time.
  // Both layouts are always in the DOM with the other hidden by a
  // Tailwind breakpoint class, so a resize needs no re-render and no
  // matchMedia listener — and, importantly, every data-* hook exists
  // TWICE. Handlers must therefore be wired with querySelectorAll (not
  // querySelector), which is what every _wire* below does.
  //
  // opts:
  //   columns:  [{ label, cell(item) -> already-escaped html, primary?,
  //                hideOnCard?, thClass?, tdClass? }]
  //             `primary: true` marks the column used as the card's
  //             heading (falls back to the first column).
  //   items:    the rows
  //   actions:  (item) -> html for the trailing actions cell/footer.
  //             Return '' for none. Callers already omit mutating
  //             controls for view-only admins.
  //   extra:    (item) -> html rendered directly beneath the row (the
  //             users typed-delete confirm, the waitlist survey
  //             answers). Table gets a full-width <tr>; card gets a
  //             block. Return '' for none.
  //   rowClass: (item) -> extra classes for the row / card.
  _list(opts) {
    const esc = AdminTopochain.esc;
    const cols = opts.columns || [];
    const items = opts.items || [];
    const actions = opts.actions || (() => '');
    const extra = opts.extra || (() => '');
    const rowClass = opts.rowClass || (() => '');
    const anyActions = items.some((it) => actions(it));
    const span = cols.length + (anyActions ? 1 : 0);

    const head = cols.map((c) => `<th class="px-3 py-2 text-left font-medium ${c.thClass || ''}">${esc(c.label)}</th>`).join('')
      + (anyActions ? '<th class="px-3 py-2 text-right font-medium">Actions</th>' : '');

    const bodyRows = items.map((it) => {
      const cells = cols.map((c) => `<td class="px-3 py-2 ${c.tdClass || ''}">${c.cell(it)}</td>`).join('');
      const act = anyActions
        ? `<td class="px-3 py-2"><div class="flex flex-wrap items-center justify-end gap-1">${actions(it)}</div></td>`
        : '';
      const ex = extra(it);
      return `<tr class="border-t border-zinc-100 dark:border-zinc-800 ${rowClass(it)}">${cells}${act}</tr>`
        + (ex ? `<tr class="border-t border-zinc-100 dark:border-zinc-800"><td colspan="${span}" class="px-3 py-3">${ex}</td></tr>` : '');
    }).join('');

    const table = `<div class="hidden md:block overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
      <table class="w-full text-sm">
        <thead class="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500"><tr>${head}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;

    const primary = cols.find((c) => c.primary) || cols[0];
    const cards = `<div class="md:hidden space-y-2">${items.map((it) => {
      const rest = cols.filter((c) => c !== primary && !c.hideOnCard).map((c) => `
        <div class="flex items-start justify-between gap-3 py-1">
          <dt class="shrink-0 text-xs uppercase tracking-wide text-zinc-500">${esc(c.label)}</dt>
          <dd class="min-w-0 text-right text-sm break-words">${c.cell(it)}</dd>
        </div>`).join('');
      const act = actions(it);
      const ex = extra(it);
      return `<div class="${PANEL_CLS} px-4 py-3 ${rowClass(it)}">
        <p class="text-sm font-medium break-words">${primary ? primary.cell(it) : ''}</p>
        <dl class="mt-1 divide-y divide-zinc-100 dark:divide-zinc-800">${rest}</dl>
        ${act ? `<div class="mt-2 flex flex-wrap gap-1 border-t border-zinc-100 dark:border-zinc-800 pt-2">${act}</div>` : ''}
        ${ex ? `<div class="mt-2">${ex}</div>` : ''}
      </div>`;
    }).join('')}</div>`;

    return table + cards;
  },

  _pagerHtml(meta, idPrefix) {
    if (!meta) return '';
    const esc = AdminTopochain.esc;
    return `<div class="mt-4 flex flex-col gap-2 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
      <span>Page ${esc(meta.page)} of ${esc(Math.max(meta.total_pages, 1))} &middot; ${esc(meta.total)} total</span>
      <div class="flex flex-wrap gap-2">
        <button id="${idPrefix}-prev" type="button" class="${BTN.row}" ${meta.page <= 1 ? 'disabled' : ''}>Prev</button>
        <button id="${idPrefix}-next" type="button" class="${BTN.row}" ${meta.page >= meta.total_pages ? 'disabled' : ''}>Next</button>
      </div>
    </div>`;
  },

  _wirePager(meta, idPrefix, onPage) {
    document.getElementById(`${idPrefix}-prev`)?.addEventListener('click', () => {
      if (meta.page > 1) onPage(meta.page - 1);
    });
    document.getElementById(`${idPrefix}-next`)?.addEventListener('click', () => {
      if (meta.page < meta.total_pages) onPage(meta.page + 1);
    });
  },

  _fmt(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  },

  // Fetches every season-event (small admin-seeded dataset — a handful of
  // pages at most) for use in <select> pickers across several
  // subsections. Not cached: each picker refetches so a just-created
  // event shows up immediately.
  async _fetchAllEvents() {
    const out = [];
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const { ok, data } = await AdminTopochain.fetchJson(
        `/api/v4/admin/season-events?page=${page}&per_page=100`);
      if (!ok || !data?.success || !Array.isArray(data.data)) break;
      out.push(...data.data);
      const meta = data.meta;
      if (!meta || page >= meta.total_pages) break;
      page += 1;
    }
    return out;
  },

  _eventOptions(events) {
    return events.map((ev) => ({ value: ev.id, label: `${ev.name} (#${ev.id})` }));
  },

  // ── Shell / sub-nav ──────────────────────────────────────────────────

  // groupKey -> true for every collapsed group. Shared by BOTH layouts:
  // the lg+ column and the compact accordion render the same open/closed
  // state, so collapsing a group on a phone and then rotating to a
  // tablet width shows the same menu. Loaded lazily on first read so a
  // test (or a private-mode browser) that never opens the menu never
  // touches storage.
  _navCollapsed: null,
  // Compact layout only: is the summary button's panel open? Deliberately
  // NOT persisted — a menu that reopens itself on every page load would
  // cover the screen you asked for.
  _navOpen: false,

  // Storage is a preference, never a correctness dependency: a browser
  // in private mode, with storage disabled, or with a corrupted value
  // must still render the menu, so every access is wrapped and every
  // failure falls back to the defaults.
  _loadNavGroups() {
    if (AdminTopochain._navCollapsed) return AdminTopochain._navCollapsed;
    let stored = null;
    try {
      const raw = localStorage.getItem(NAV_GROUPS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
    } catch { /* unreadable or unparseable — fall through to defaults */ }
    const out = {};
    for (const g of AdminTopochain.SUB_GROUPS) {
      out[g.key] = stored && Object.prototype.hasOwnProperty.call(stored, g.key)
        ? stored[g.key] === true
        : AdminTopochain.DEFAULT_COLLAPSED[g.key] === true;
    }
    AdminTopochain._navCollapsed = out;
    return out;
  },

  _saveNavGroups() {
    try {
      const state = AdminTopochain._navCollapsed || {};
      const collapsed = {};
      for (const g of AdminTopochain.SUB_GROUPS) if (state[g.key]) collapsed[g.key] = true;
      localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(collapsed));
    } catch { /* storage may be unavailable; the menu still works */ }
  },

  _isCollapsed(key) {
    return AdminTopochain._loadNavGroups()[key] === true;
  },

  // Entry point, called by AdminConsole._renderSection every time the
  // top-level "Seasons, Events & Challenges" nav item is (re)selected.
  // `sub` is read straight from location.hash (not passed down by
  // admin-console.js — see the file-header comment) so a hand-typed or
  // deep-linked #admin/seasons/<sub> (or the legacy
  // #admin/topochain/<sub>) lands on the right tab on first paint.
  render(host) {
    AdminTopochain._host = host;
    const sub = AdminTopochain._subFromHash() || AdminTopochain._sub || 'seasons';
    AdminTopochain.setSub(sub);
  },

  // Half of the render/destroy contract every console section module
  // implements (#860). Nothing to tear down here: this module holds no
  // timers and binds every listener on elements inside the section host,
  // which AdminConsole replaces wholesale on the next section. Dropping
  // the host reference keeps a detached tree from being retained.
  destroy() {
    AdminTopochain._host = null;
  },

  // Accepts BOTH the canonical prefix and the retired one, so a link
  // minted before the rename still deep-links its tab. Only
  // #admin/seasons is ever written back (see _syncHash) — app.js has
  // normally already rewritten the address by the time we get here, but
  // reading both keeps this module correct on its own.
  _subFromHash() {
    const m = /^#admin\/(?:seasons|topochain)\/([^/]+)/.exec(location.hash);
    return m ? decodeURIComponent(m[1]) : null;
  },

  _groupOf(sub) {
    return AdminTopochain.SUB_GROUPS.find((g) => g.subs.includes(sub)) || null;
  },

  _labelOf(sub) {
    return (AdminTopochain.SUBS.find((s) => s.key === sub) || {}).label || sub;
  },

  setSub(sub) {
    if (!AdminTopochain.SUBS.some((s) => s.key === sub)) sub = 'seasons';
    AdminTopochain._sub = sub;
    // The group owning the screen you are on is always open — otherwise a
    // deep link into a collapsed group (or the default-collapsed platform
    // group) paints a menu with no visible active item and no clue where
    // you are. Done HERE and nowhere else: the toggle handler must not
    // re-apply it, or collapsing the group you're in would silently undo
    // itself. The preference is rewritten so the forced state is what a
    // reload sees, matching what's on screen.
    const state = AdminTopochain._loadNavGroups();
    const group = AdminTopochain._groupOf(sub);
    if (group && state[group.key]) {
      state[group.key] = false;
      AdminTopochain._saveNavGroups();
    }
    // Picking a screen answers the question the compact menu was open to
    // ask, so it closes behind you.
    AdminTopochain._navOpen = false;
    AdminTopochain._syncHash();
    AdminTopochain._renderShell();
  },

  // Expand/collapse one group. Mutates the rendered menu IN PLACE — no
  // _renderShell(), no _renderSub() — because the screen beside the menu
  // is live: remounting it would discard the SQL console's editor
  // contents, the API tester's request body, an open edit form and the
  // page you had paged to. The menu markup is small enough that flipping
  // three attributes is also simply less work than rebuilding it.
  _toggleGroup(key) {
    if (!AdminTopochain.SUB_GROUPS.some((g) => g.key === key)) return;
    const state = AdminTopochain._loadNavGroups();
    const collapsed = !state[key];
    state[key] = collapsed;
    AdminTopochain._saveNavGroups();
    const host = AdminTopochain._host;
    if (!host) return;
    // Both layouts are in the DOM at once (one is hidden by a breakpoint
    // class), so every match is updated — not just the visible one.
    // Matched by dataset rather than an interpolated selector: no
    // CSS.escape dependency, and nothing this module builds can turn a
    // group key into selector syntax.
    host.querySelectorAll('[data-topo-group]').forEach((btn) => {
      if (btn.dataset.topoGroup !== key) return;
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.querySelector('[data-topo-chevron]')?.classList.toggle('rotate-90', !collapsed);
    });
    host.querySelectorAll('[data-topo-group-panel]').forEach((panel) => {
      if (panel.dataset.topoGroupPanel !== key) return;
      panel.classList.toggle('hidden', collapsed);
    });
  },

  // Compact layout only: open/close the whole menu behind its summary
  // button. Same in-place rule as _toggleGroup — the screen underneath
  // keeps its state.
  _toggleCompact() {
    AdminTopochain._navOpen = !AdminTopochain._navOpen;
    const host = AdminTopochain._host;
    if (!host) return;
    const btn = host.querySelector('#admin-topo-nav-toggle');
    const panel = host.querySelector('#admin-topo-nav-panel');
    if (btn) {
      btn.setAttribute('aria-expanded', AdminTopochain._navOpen ? 'true' : 'false');
      btn.querySelector('[data-topo-chevron]')?.classList.toggle('rotate-90', AdminTopochain._navOpen);
    }
    panel?.classList.toggle('hidden', !AdminTopochain._navOpen);
  },

  // Keep the hash deep-linkable (#admin/seasons/<sub>) without polluting
  // history — replaceState, and only while actually on this section's
  // hash (mirrors leaderboard.js's _syncHash). The legacy prefix is
  // accepted as a starting point and rewritten to the canonical one, so
  // an old bookmark self-heals even if it somehow bypassed app.js.
  _syncHash() {
    const target = `#admin/seasons/${AdminTopochain._sub}`;
    const h = location.hash;
    if ((h.startsWith('#admin/seasons') || h.startsWith('#admin/topochain')) && h !== target) {
      history.replaceState(null, '', target);
    }
  },

  // ── Sub-nav markup ─────────────────────────────────────────────────

  // The chevron both layouts use for "this thing opens". It points right
  // when closed and is rotated a quarter turn to point down when open,
  // so one glyph carries both states and the transition is a rotation
  // rather than a swap. aria-hidden: aria-expanded on the button is what
  // a screen reader announces.
  _chevronHtml(open) {
    return `<svg data-topo-chevron viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
      class="w-4 h-4 shrink-0 text-zinc-400 transition-transform${open ? ' rotate-90' : ''}"><path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clip-rule="evenodd"/></svg>`;
  },

  // One group: a heading that is itself the expand/collapse control, and
  // the list of its screens. `compact` only changes the sizing (a finger
  // target below lg, a pointer-sized row in the column) — the structure,
  // the data-* hooks and the ARIA wiring are identical, which is what
  // lets _toggleGroup update both copies with the same code.
  _groupHtml(g, compact) {
    const esc = AdminTopochain.esc;
    const collapsed = AdminTopochain._isCollapsed(g.key);
    const panelId = `admin-topo-group-${compact ? 'compact-' : ''}${g.key}`;
    const rows = g.subs.map((key) => {
      const isActive = key === AdminTopochain._sub;
      const cls = 'admin-topo-tab flex w-full items-center rounded-lg px-3 text-left text-sm font-medium '
        + 'transition-colors touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 '
        + (compact ? 'min-h-[44px] py-2 ' : 'min-h-[36px] py-1.5 ')
        + (isActive
          ? 'bg-violet-600/10 text-violet-600 dark:text-violet-400'
          : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800');
      return `<button type="button" data-topo-sub="${esc(key)}"${isActive ? ' aria-current="page"' : ''} class="${cls}">${esc(AdminTopochain._labelOf(key))}</button>`;
    }).join('');
    return `<div>
      <button type="button" data-topo-group="${esc(g.key)}"
        aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="${esc(panelId)}"
        class="flex w-full items-center justify-between gap-2 rounded-lg px-3 text-left transition-colors touch-manipulation
          focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 hover:bg-zinc-100 dark:hover:bg-zinc-800
          ${compact ? 'min-h-[44px] py-2' : 'min-h-[36px] py-1.5'}">
        <span class="min-w-0 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">${esc(g.label)}</span>
        ${AdminTopochain._chevronHtml(!collapsed)}
      </button>
      <div id="${esc(panelId)}" data-topo-group-panel="${esc(g.key)}"
        class="mt-0.5 space-y-0.5${collapsed ? ' hidden' : ''}">${rows}</div>
    </div>`;
  },

  // lg+: a sticky column beside the screen. lg rather than md because
  // admin-console.js already spends md:w-56 on its own section list, and
  // a third column at 768px leaves the wide tables here nothing to live
  // in. It sticks to the top of #admin-screen (the scroll container) and
  // scrolls internally if the two groups ever outgrow the viewport.
  _sidebarNavHtml() {
    const groups = AdminTopochain.SUB_GROUPS
      .map((g) => AdminTopochain._groupHtml(g, false)).join('');
    return `<nav aria-label="Seasons, events and challenges sections"
      class="hidden lg:block lg:w-52 shrink-0 lg:sticky lg:top-0 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto space-y-3">${groups}</nav>`;
  },

  // Below lg: one summary button naming where you are, opening the same
  // two groups underneath it. A permanently-expanded list would push the
  // screen a scroll-length down the page on every visit.
  _compactNavHtml() {
    const esc = AdminTopochain.esc;
    const open = AdminTopochain._navOpen;
    const group = AdminTopochain._groupOf(AdminTopochain._sub);
    const where = (group ? `${group.label} · ` : '') + AdminTopochain._labelOf(AdminTopochain._sub);
    const groups = AdminTopochain.SUB_GROUPS
      .map((g) => AdminTopochain._groupHtml(g, true)).join('');
    return `<nav aria-label="Seasons, events and challenges sections (compact)" class="lg:hidden mb-4">
      <button type="button" id="admin-topo-nav-toggle"
        aria-expanded="${open ? 'true' : 'false'}" aria-controls="admin-topo-nav-panel"
        class="flex w-full items-center justify-between gap-3 min-h-[44px] px-3 py-2 rounded-lg text-left
          border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 touch-manipulation
          focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
        <span class="min-w-0 truncate text-sm font-medium">${esc(where)}</span>
        ${AdminTopochain._chevronHtml(open)}
      </button>
      <div id="admin-topo-nav-panel"
        class="mt-2 space-y-3 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2${open ? '' : ' hidden'}">${groups}</div>
    </nav>`;
  },

  _renderShell() {
    const host = AdminTopochain._host;
    if (!host) return;
    // Both navs are always in the tree; the breakpoint decides which one
    // is visible. The compact one sits above the content (it's a
    // disclosure, not a column), so only the lg+ layout is a flex row —
    // hence lg:flex on the wrapper rather than a plain flex.
    host.innerHTML = `
      <div class="lg:flex lg:items-start lg:gap-6">
        ${AdminTopochain._sidebarNavHtml()}
        <div class="min-w-0 lg:flex-1">
          ${AdminTopochain._compactNavHtml()}
          <div id="admin-topo-content"></div>
        </div>
      </div>`;
    host.querySelectorAll('[data-topo-sub]').forEach((btn) => {
      btn.addEventListener('click', () => AdminTopochain.setSub(btn.dataset.topoSub));
    });
    host.querySelectorAll('[data-topo-group]').forEach((btn) => {
      btn.addEventListener('click', () => AdminTopochain._toggleGroup(btn.dataset.topoGroup));
    });
    host.querySelector('#admin-topo-nav-toggle')
      ?.addEventListener('click', AdminTopochain._toggleCompact);
    AdminTopochain._renderSub();
  },

  _renderSub() {
    const c = document.getElementById('admin-topo-content');
    if (!c) return;
    switch (AdminTopochain._sub) {
      case 'season-events': return AdminTopochain.renderSeasonEvents(c);
      case 'users': return AdminTopochain.renderUsers(c);
      case 'waitlist': return AdminTopochain.renderWaitlist(c);
      case 'onchain-accounts': return AdminTopochain.renderOnchainAccounts(c);
      case 'user-activities': return AdminTopochain.renderUserActivities(c);
      case 'challenge-templates': return AdminTopochain.renderChallengeTemplates(c);
      case 'settings': return AdminTopochain.renderSettings(c);
      case 'app-version': return AdminTopochain.renderAppVersion(c);
      case 'sql-console': return AdminTopochain.renderSqlConsole(c);
      case 'api-tester': return AdminTopochain.renderApiTester(c);
      default: return AdminTopochain.renderSeasons(c);
    }
  },

  // ══════════════════════════════════════════════════════════════════
  // Seasons — READ-ONLY, derived (documented gap: no /admin/seasons API;
  // see the file-header comment). Grouped client-side from the
  // season-events list, which is the only place a season_id surfaces.
  // ══════════════════════════════════════════════════════════════════

  async renderSeasons(host) {
    host.innerHTML = `
      ${AdminTopochain._screenHeader({
    title: 'Seasons',
    subtitle: 'Season events grouped by the season they belong to.',
    actions: `<button id="admin-topo-seasons-goto-events" type="button" class="${BTN.secondarySm}">Manage season events</button>`,
  })}
      <div class="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 px-4 py-3 text-sm mb-4">
        There is no dedicated Seasons API (no <code>/api/v4/admin/seasons</code> endpoint) — this view
        is derived by grouping Season events by their <code>season_id</code>. Manage individual
        events in the Season events tab.
      </div>
      <div id="admin-topo-seasons-list" class="space-y-3">${AdminTopochain._skeleton(4)}</div>`;
    document.getElementById('admin-topo-seasons-goto-events')
      ?.addEventListener('click', () => AdminTopochain.setSub('season-events'));
    const events = await AdminTopochain._fetchAllEvents();
    AdminTopochain._renderSeasonsList(events);
  },

  _renderSeasonsList(events) {
    const host = document.getElementById('admin-topo-seasons-list');
    if (!host) return;
    const esc = AdminTopochain.esc;
    if (!events.length) {
      host.innerHTML = AdminTopochain._empty({
        title: 'No seasons yet',
        body: 'Seasons appear here as soon as a season event is created with a season id.',
      });
      return;
    }
    const groups = new Map();
    for (const ev of events) {
      const key = ev.season_id == null ? 'none' : String(ev.season_id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ev);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === 'none') return 1;
      if (b === 'none') return -1;
      return Number(a) - Number(b);
    });
    host.innerHTML = keys.map((key) => {
      const list = groups.get(key);
      const title = key === 'none' ? 'No season assigned' : `Season #${esc(key)}`;
      const rows = list.map((ev) => `
        <li class="flex flex-col gap-1 py-2 border-t border-zinc-100 dark:border-zinc-800 first:border-t-0 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2">
          <span class="text-sm">${esc(ev.name)} <span class="text-xs text-zinc-500">(${esc(ev.type)})</span></span>
          <span class="text-xs text-zinc-500">${esc(AdminTopochain._fmt(ev.starts_at))} &ndash; ${esc(AdminTopochain._fmt(ev.ends_at))}
            ${ev.is_active ? '<span class="ml-2 text-green-600 dark:text-green-400">active</span>' : ''}</span>
        </li>`).join('');
      return `<section class="${PANEL_CLS} overflow-hidden">
        <header class="border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 sm:px-5">
          <h3 class="text-sm font-semibold">${title}</h3>
          <p class="mt-0.5 text-xs text-zinc-500">${esc(String(list.length))} event${list.length === 1 ? '' : 's'}</p>
        </header>
        <ul class="px-4 py-2 sm:px-5">${rows}</ul>
      </section>`;
    }).join('');
  },

  // ══════════════════════════════════════════════════════════════════
  // Season events — full CRUD. Challenges are managed in the nested
  // detail view (Manage button), not a separate top-level tab.
  // ══════════════════════════════════════════════════════════════════

  _se: { page: 1, perPage: 20, search: '', items: [], meta: null, formOpen: false, editingId: null, detailId: null },

  renderSeasonEvents(host) {
    if (AdminTopochain._se.detailId != null) {
      return AdminTopochain._renderSeasonEventDetail(host);
    }
    const canWrite = AdminTopochain.canWrite();
    const esc = AdminTopochain.esc;
    host.innerHTML = `
      ${AdminTopochain._screenHeader({
    title: 'Season events',
    subtitle: 'Every event, its schedule, and the challenges scheduled inside it.',
    actions: `<input id="admin-topo-se-search" type="text" placeholder="Search name&hellip;"
            value="${esc(AdminTopochain._se.search)}" aria-label="Search season events"
            class="${FIELD_CLS} sm:w-56">
          ${canWrite ? `<button id="admin-topo-se-new" type="button" class="${BTN.primarySm}">New event</button>` : ''}`,
  })}
      <div id="admin-topo-se-form"></div>
      <div id="admin-topo-se-table">${AdminTopochain._skeleton(4)}</div>`;
    document.getElementById('admin-topo-se-search').addEventListener('change', (e) => {
      AdminTopochain._se.search = e.target.value.trim();
      AdminTopochain._se.page = 1;
      AdminTopochain._loadSeasonEvents();
    });
    document.getElementById('admin-topo-se-new')?.addEventListener('click', () => AdminTopochain._openSeasonEventForm(null));
    AdminTopochain._loadSeasonEvents();
  },

  async _loadSeasonEvents() {
    const s = AdminTopochain._se;
    const params = new URLSearchParams({ page: String(s.page), per_page: String(s.perPage) });
    if (s.search) params.set('search', s.search);
    const { ok, data, status } = await AdminTopochain.fetchJson(`/api/v4/admin/season-events?${params}`);
    if (AdminTopochain._sub !== 'season-events') return;
    if (ok && data?.success) {
      s.items = data.data;
      s.meta = data.meta;
      s.error = null;
    } else {
      s.items = [];
      s.meta = null;
      // A failed request and a genuinely empty list used to render the
      // same "No events found." — keep them apart.
      s.error = { status, message: (data && data.error) || null };
    }
    AdminTopochain._renderSeasonEventsTable();
  },

  _renderSeasonEventsTable() {
    const table = document.getElementById('admin-topo-se-table');
    if (!table) return;
    const esc = AdminTopochain.esc;
    const canWrite = AdminTopochain.canWrite();
    const s = AdminTopochain._se;
    if (s.error) {
      table.innerHTML = AdminTopochain._error({
        title: "Couldn't load season events", status: s.error.status,
        message: s.error.message, retryId: 'admin-topo-se-retry',
      });
      AdminTopochain._wireRetry('admin-topo-se-retry', () => AdminTopochain._loadSeasonEvents());
      return;
    }
    if (!s.items.length) {
      table.innerHTML = AdminTopochain._empty({
        title: s.search ? 'No events match that search' : 'No season events yet',
        body: s.search ? 'Clear the search box to see every event.'
          : 'Create the first event to start scheduling challenges.',
        actionId: s.search ? null : 'admin-topo-se-empty-new',
        actionLabel: 'New event',
      });
      document.getElementById('admin-topo-se-empty-new')
        ?.addEventListener('click', () => AdminTopochain._openSeasonEventForm(null));
      return;
    }
    table.innerHTML = AdminTopochain._list({
      items: s.items,
      columns: [
        { label: 'Name', primary: true, cell: (ev) => esc(ev.name) },
        { label: 'Season', cell: (ev) => (ev.season_id != null ? esc(ev.season_id) : '—'), tdClass: 'text-zinc-500' },
        { label: 'Type', cell: (ev) => esc(ev.type), tdClass: 'text-zinc-500' },
        { label: 'Active', cell: (ev) => (ev.is_active ? '<span class="text-green-600 dark:text-green-400">yes</span>' : '—') },
        { label: 'Starts', cell: (ev) => esc(AdminTopochain._fmt(ev.starts_at)), tdClass: 'text-xs text-zinc-500' },
        { label: 'Ends', cell: (ev) => esc(AdminTopochain._fmt(ev.ends_at)), tdClass: 'text-xs text-zinc-500' },
        { label: 'Users', cell: (ev) => (ev.users_count != null ? esc(ev.users_count) : '—'), tdClass: 'text-zinc-500' },
      ],
      actions: (ev) => `
        <button data-manage="${ev.id}" type="button" class="${BTN.rowPrimary}">Manage</button>
        ${canWrite ? `<button data-edit="${ev.id}" type="button" class="${BTN.row}">Edit</button>` : ''}
        ${canWrite ? `<button data-delete="${ev.id}" type="button" class="${BTN.rowDanger}">Delete</button>` : ''}`,
    }) + AdminTopochain._pagerHtml(s.meta, 'admin-topo-se-pg');
    table.querySelectorAll('[data-manage]').forEach((b) => b.addEventListener('click', () => {
      AdminTopochain._se.detailId = parseInt(b.dataset.manage, 10);
      AdminTopochain._renderSub();
    }));
    table.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => AdminTopochain._openSeasonEventForm(parseInt(b.dataset.edit, 10))));
    table.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', () => AdminTopochain._deleteSeasonEvent(parseInt(b.dataset.delete, 10))));
    if (s.meta) AdminTopochain._wirePager(s.meta, 'admin-topo-se-pg', (page) => { s.page = page; AdminTopochain._loadSeasonEvents(); });
  },

  async _openSeasonEventForm(id) {
    if (!AdminTopochain.canWrite()) return;
    AdminTopochain._se.editingId = id;
    let ev = null;
    if (id != null) {
      const { ok, data } = await AdminTopochain.fetchJson(`/api/v4/admin/season-events/${encodeURIComponent(id)}`);
      if (ok && data?.success) ev = data.data;
    }
    const f = AdminTopochain._inputHtml, sel = AdminTopochain._selectHtml, field = AdminTopochain._field;
    const iso = AdminTopochain._isoToLocalInput;
    const scoring = ev?.scoring_formula || {};
    const check = AdminTopochain._checkField;
    const host = document.getElementById('admin-topo-se-form');
    host.innerHTML = AdminTopochain._panel({
      title: id == null ? 'New event' : `Edit event #${id}`,
      subtitle: 'Schedule, scoring and what the event shows to users.',
      closeId: 'admin-topo-se-close',
      closeLabel: 'Close the event form',
      body: `
        ${AdminTopochain._formGrid(`
          ${field('Name *', f('admin-topo-se-f-name', { value: ev?.name }))}
          ${field('Season id', f('admin-topo-se-f-season_id', { type: 'number', min: 1, value: ev?.season_id }))}
          ${field('Type', sel('admin-topo-se-f-type', ['regular', 'season'], ev?.type || 'regular'))}
          ${field('Chain id', f('admin-topo-se-f-chain_id', { value: ev?.chain_id }))}
          ${field('Starts at *', f('admin-topo-se-f-starts_at', { type: 'datetime-local', value: iso(ev?.starts_at) }))}
          ${field('Ends at *', f('admin-topo-se-f-ends_at', { type: 'datetime-local', value: iso(ev?.ends_at) }))}
          ${field('Score start time', f('admin-topo-se-f-score_start_time', { type: 'datetime-local', value: iso(ev?.score_start_time) }))}
          ${field('Score end time', f('admin-topo-se-f-score_end_time', { type: 'datetime-local', value: iso(ev?.score_end_time) }))}
          ${field('Start epoch', f('admin-topo-se-f-start_epoch', { type: 'number', min: 0, value: ev?.start_epoch }))}
          ${field('End epoch', f('admin-topo-se-f-end_epoch', { type: 'number', min: 0, value: ev?.end_epoch }))}
          ${field('Rank basis *', sel('admin-topo-se-f-rank_basis', [{ value: 'BP', label: 'Blocks produced' }, { value: 'RATE', label: 'Success rate' }], ev?.rank_based_on_bp_or_success_rate || 'BP'))}
          ${field('Account inheritance mode', f('admin-topo-se-f-account_inheritance_mode', { value: ev?.account_inheritance_mode || 'none' }))}
          ${field('Account source event id', f('admin-topo-se-f-account_source_season_event_id', { type: 'number', min: 1, value: ev?.account_source_season_event_id }))}
          ${field('Scoring: offchain weight *', f('admin-topo-se-f-offchain_weight', { type: 'number', min: 0, step: '0.01', value: scoring.offchain_weight ?? 0 }))}
          <div class="md:col-span-2">${field('Scoring: metrics (comma-separated) *', f('admin-topo-se-f-metrics', { value: (scoring.metrics || []).join(', ') }))}</div>
        `)}
        <fieldset class="mt-5 border-t border-zinc-200 dark:border-zinc-800 pt-4">
          <legend class="sr-only">Visibility</legend>
          <p class="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Visibility</p>
          <div class="grid grid-cols-1 gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
            ${check('admin-topo-se-f-is_active', 'Active', ev ? ev.is_active : true)}
            ${check('admin-topo-se-f-internal', 'Internal', ev?.internal)}
            ${check('admin-topo-se-f-display_leaderboard', 'Show leaderboard', ev ? ev.display_leaderboard : true)}
            ${check('admin-topo-se-f-display_disclaimer', 'Show disclaimer', ev?.display_disclaimer)}
            ${check('admin-topo-se-f-display_activities', 'Show activities', ev?.display_activities)}
          </div>
        </fieldset>
        <div class="grid grid-cols-1 gap-4 mt-5 border-t border-zinc-200 dark:border-zinc-800 pt-4">
          ${field('Description', AdminTopochain._textareaHtml('admin-topo-se-f-description', ev?.description || '', 3))}
          ${field('Disclaimer', AdminTopochain._textareaHtml('admin-topo-se-f-disclaimer', ev?.disclaimer || '', 3))}
        </div>
        ${AdminTopochain._formErrorSlot('admin-topo-se-form-err')}`,
      footer: AdminTopochain._formActions('admin-topo-se-save', 'admin-topo-se-cancel', 'Save event'),
    });
    const closeForm = () => { host.innerHTML = ''; AdminTopochain._se.editingId = null; };
    document.getElementById('admin-topo-se-save').addEventListener('click', () => AdminTopochain._saveSeasonEvent());
    document.getElementById('admin-topo-se-cancel').addEventListener('click', closeForm);
    document.getElementById('admin-topo-se-close').addEventListener('click', closeForm);
  },

  async _saveSeasonEvent() {
    if (!AdminTopochain.canWrite()) return;
    const errEl = document.getElementById('admin-topo-se-form-err');
    errEl.classList.add('hidden');
    const val = (id) => document.getElementById(id)?.value ?? '';
    const checked = (id) => !!document.getElementById(id)?.checked;
    const num = (id) => { const v = val(id).trim(); return v === '' ? null : Number(v); };
    const metrics = val('admin-topo-se-f-metrics').split(',').map((s) => s.trim()).filter(Boolean);

    const body = {
      name: val('admin-topo-se-f-name').trim(),
      season_id: num('admin-topo-se-f-season_id'),
      type: val('admin-topo-se-f-type'),
      chain_id: val('admin-topo-se-f-chain_id').trim() || null,
      starts_at: AdminTopochain._localInputToIso(val('admin-topo-se-f-starts_at')),
      ends_at: AdminTopochain._localInputToIso(val('admin-topo-se-f-ends_at')),
      score_start_time: AdminTopochain._localInputToIso(val('admin-topo-se-f-score_start_time')),
      score_end_time: AdminTopochain._localInputToIso(val('admin-topo-se-f-score_end_time')),
      start_epoch: num('admin-topo-se-f-start_epoch'),
      end_epoch: num('admin-topo-se-f-end_epoch'),
      rank_based_on_bp_or_success_rate: val('admin-topo-se-f-rank_basis'),
      account_inheritance_mode: val('admin-topo-se-f-account_inheritance_mode').trim() || 'none',
      account_source_season_event_id: num('admin-topo-se-f-account_source_season_event_id'),
      scoring_formula: { metrics, offchain_weight: Number(val('admin-topo-se-f-offchain_weight') || 0) },
      is_active: checked('admin-topo-se-f-is_active'),
      internal: checked('admin-topo-se-f-internal'),
      display_leaderboard: checked('admin-topo-se-f-display_leaderboard'),
      display_disclaimer: checked('admin-topo-se-f-display_disclaimer'),
      display_activities: checked('admin-topo-se-f-display_activities'),
      description: val('admin-topo-se-f-description').trim() || null,
      disclaimer: val('admin-topo-se-f-disclaimer').trim() || null,
    };
    if (!body.name) { errEl.textContent = 'Name is required.'; errEl.classList.remove('hidden'); return; }
    if (!body.starts_at || !body.ends_at) { errEl.textContent = 'Starts at and ends at are required.'; errEl.classList.remove('hidden'); return; }

    const id = AdminTopochain._se.editingId;
    const url = id == null ? '/api/v4/admin/season-events' : `/api/v4/admin/season-events/${encodeURIComponent(id)}`;
    const { ok, data } = await AdminTopochain.send(id == null ? 'POST' : 'PUT', url, body);
    if (!ok || !data?.success) {
      errEl.textContent = (data && data.error) || 'Save failed.';
      errEl.classList.remove('hidden');
      return;
    }
    document.getElementById('admin-topo-se-form').innerHTML = '';
    AdminTopochain._se.editingId = null;
    AdminTopochain._loadSeasonEvents();
  },

  async _deleteSeasonEvent(id) {
    if (!AdminTopochain.canWrite()) return;
    const ok = await AdminTopochain._confirm({
      title: 'Delete this event?',
      message: 'This permanently removes the event and cascades to its challenges, user activities, onchain accounts and enrollments. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const res = await AdminTopochain.send('DELETE', `/api/v4/admin/season-events/${encodeURIComponent(id)}`);
    if (res.ok && res.data?.success) AdminTopochain._loadSeasonEvents();
    else AdminTopochain._alert((res.data && res.data.error) || 'Delete failed.');
  },

  // ── Season event detail: nested Challenges CRUD ─────────────────────

  async _renderSeasonEventDetail(host) {
    const id = AdminTopochain._se.detailId;
    const esc = AdminTopochain.esc;
    host.innerHTML = `
      <button id="admin-topo-se-back" type="button" class="${BTN.back} mb-2">
        <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12.79 5.23a.75.75 0 0 1-.02 1.06L8.832 10l3.938 3.71a.75.75 0 1 1-1.04 1.08l-4.5-4.25a.75.75 0 0 1 0-1.08l4.5-4.25a.75.75 0 0 1 1.06.02Z" clip-rule="evenodd"/></svg>
        Back to season events
      </button>
      <div id="admin-topo-se-detail-hero" class="mb-4">${AdminTopochain._skeleton(4)}</div>
      ${AdminTopochain._screenHeader({
    title: 'Challenges',
    subtitle: 'Ordered as users see them. Reorder with the arrows.',
    actions: AdminTopochain.canWrite() ? `<button id="admin-topo-ch-new" type="button" class="${BTN.primarySm}">Add challenge</button>` : '',
  })}
      <div id="admin-topo-ch-form"></div>
      <div id="admin-topo-ch-table">${AdminTopochain._skeleton(4)}</div>`;
    document.getElementById('admin-topo-se-back').addEventListener('click', () => {
      AdminTopochain._se.detailId = null;
      AdminTopochain._renderSub();
    });
    document.getElementById('admin-topo-ch-new')?.addEventListener('click', () => AdminTopochain._openChallengeForm(null));

    const { ok, data, status } = await AdminTopochain.fetchJson(`/api/v4/admin/season-events/${encodeURIComponent(id)}`);
    const hero = document.getElementById('admin-topo-se-detail-hero');
    if (hero) {
      if (ok && data?.success) {
        const ev = data.data;
        const stat = (label, value) => `<div class="rounded-lg bg-zinc-50 dark:bg-zinc-800/60 px-3 py-2">
            <dt class="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">${esc(label)}</dt>
            <dd class="mt-0.5 text-sm font-medium">${esc(value)}</dd>
          </div>`;
        hero.innerHTML = `<section class="${PANEL_CLS} px-4 py-4 sm:px-5">
          <h2 class="text-base font-semibold sm:text-lg">${esc(ev.name)}</h2>
          <p class="mt-0.5 text-xs text-zinc-500">${esc(AdminTopochain._fmt(ev.starts_at))} &ndash; ${esc(AdminTopochain._fmt(ev.ends_at))}</p>
          <dl class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            ${stat('Users', ev.users_count ?? 0)}
            ${stat('Accounts', ev.onchain_accounts_count ?? 0)}
            ${stat('Type', ev.type || '—')}
            ${stat('Active', ev.is_active ? 'yes' : 'no')}
          </dl>
        </section>`;
      } else {
        hero.innerHTML = AdminTopochain._error({
          title: 'Event not found', status,
          message: (data && data.error) || null,
        });
      }
    }
    AdminTopochain._loadChallenges(id);
  },

  async _loadChallenges(eventId) {
    const { ok, data, status } = await AdminTopochain.fetchJson(`/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges`);
    if (AdminTopochain._se.detailId !== eventId) return;
    const good = ok && data?.success && Array.isArray(data.data);
    AdminTopochain._challenges = good ? data.data : [];
    AdminTopochain._challengesError = good ? null : { status, message: (data && data.error) || null };
    AdminTopochain._renderChallengesTable(eventId);
  },

  _renderChallengesTable(eventId) {
    const table = document.getElementById('admin-topo-ch-table');
    if (!table) return;
    const esc = AdminTopochain.esc;
    const canWrite = AdminTopochain.canWrite();
    const items = AdminTopochain._challenges || [];
    if (AdminTopochain._challengesError) {
      const e = AdminTopochain._challengesError;
      table.innerHTML = AdminTopochain._error({
        title: "Couldn't load challenges", status: e.status, message: e.message,
        retryId: 'admin-topo-ch-retry',
      });
      AdminTopochain._wireRetry('admin-topo-ch-retry', () => AdminTopochain._loadChallenges(eventId));
      return;
    }
    if (!items.length) {
      table.innerHTML = AdminTopochain._empty({
        title: 'No challenges for this event yet',
        body: 'Add one, or stamp a set out of the Challenge templates library.',
        actionId: 'admin-topo-ch-empty-new',
        actionLabel: 'Add challenge',
      });
      document.getElementById('admin-topo-ch-empty-new')
        ?.addEventListener('click', () => AdminTopochain._openChallengeForm(null));
      return;
    }
    const idx = new Map(items.map((c, i) => [c, i]));
    table.innerHTML = AdminTopochain._list({
      items,
      columns: [
        { label: 'Goal', primary: true, cell: (c) => esc(c.card_preview?.goal || '') },
        { label: 'Kind', cell: (c) => esc(c.card_preview?.label || ''), tdClass: 'text-xs text-zinc-500' },
        { label: 'Enabled', cell: (c) => (c.enabled ? '<span class="text-green-600 dark:text-green-400">enabled</span>' : '<span class="text-zinc-400">disabled</span>') },
        { label: 'Completed', cell: (c) => (c.completed ? 'completed' : '—'), tdClass: 'text-zinc-500' },
      ],
      actions: (c) => {
        const i = idx.get(c);
        return `
          ${canWrite ? `<button data-up="${i}" type="button" aria-label="Move up" title="Move up" class="${BTN.row}" ${i === 0 ? 'disabled' : ''}>&uarr;</button>` : ''}
          ${canWrite ? `<button data-down="${i}" type="button" aria-label="Move down" title="Move down" class="${BTN.row}" ${i === items.length - 1 ? 'disabled' : ''}>&darr;</button>` : ''}
          ${canWrite ? `<button data-toggle-enabled="${c.id}" type="button" class="${BTN.row}">Toggle</button>` : ''}
          ${canWrite ? `<button data-toggle-completed="${c.id}" type="button" class="${BTN.row}">Complete</button>` : ''}
          ${canWrite ? `<button data-edit-ch="${c.id}" type="button" class="${BTN.row}">Edit</button>` : ''}
          ${canWrite ? `<button data-move-ch="${c.id}" type="button" class="${BTN.row}">Move&hellip;</button>` : ''}
          ${canWrite ? `<button data-delete-ch="${c.id}" type="button" class="${BTN.rowDanger}">Delete</button>` : ''}`;
      },
    }) + '<div id="admin-topo-ch-move"></div>';
    table.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => AdminTopochain._reorderChallenge(eventId, parseInt(b.dataset.up, 10), -1)));
    table.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => AdminTopochain._reorderChallenge(eventId, parseInt(b.dataset.down, 10), 1)));
    table.querySelectorAll('[data-toggle-enabled]').forEach((b) => b.addEventListener('click', () => AdminTopochain._toggleChallenge(eventId, b.dataset.toggleEnabled, 'toggle-enabled')));
    table.querySelectorAll('[data-toggle-completed]').forEach((b) => b.addEventListener('click', () => AdminTopochain._toggleChallenge(eventId, b.dataset.toggleCompleted, 'toggle-completed')));
    table.querySelectorAll('[data-edit-ch]').forEach((b) => b.addEventListener('click', () => AdminTopochain._openChallengeForm(b.dataset.editCh)));
    table.querySelectorAll('[data-move-ch]').forEach((b) => b.addEventListener('click', () => AdminTopochain._moveChallenge(eventId, b.dataset.moveCh)));
    table.querySelectorAll('[data-delete-ch]').forEach((b) => b.addEventListener('click', () => AdminTopochain._deleteChallenge(eventId, b.dataset.deleteCh)));
  },

  async _reorderChallenge(eventId, idx, dir) {
    if (!AdminTopochain.canWrite()) return;
    const items = AdminTopochain._challenges;
    const j = idx + dir;
    if (j < 0 || j >= items.length) return;
    [items[idx], items[j]] = [items[j], items[idx]];
    const challenges = items.map((c, i) => ({ id: c.id, display_order: i }));
    const { ok, data } = await AdminTopochain.send(
      'PATCH', `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges/update-display-orders`,
      { challenges });
    if (ok && data?.success) AdminTopochain._loadChallenges(eventId);
    else AdminTopochain._alert((data && data.error) || 'Reorder failed.');
  },

  async _toggleChallenge(eventId, challengeId, action) {
    if (!AdminTopochain.canWrite()) return;
    const { ok, data } = await AdminTopochain.send(
      'PATCH', `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges/${encodeURIComponent(challengeId)}/${action}`);
    if (ok && data?.success) AdminTopochain._loadChallenges(eventId);
    else AdminTopochain._alert((data && data.error) || 'Update failed.');
  },

  async _deleteChallenge(eventId, challengeId) {
    if (!AdminTopochain.canWrite()) return;
    const ok = await AdminTopochain._confirm({
      title: 'Remove this challenge from the event?', confirmLabel: 'Remove', danger: true,
      message: 'This removes the challenge from the event; its recorded user activities are cascaded away with it.',
    });
    if (!ok) return;
    const res = await AdminTopochain.send('DELETE', `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges/${encodeURIComponent(challengeId)}`);
    if (res.ok && res.data?.success) AdminTopochain._loadChallenges(eventId);
    else AdminTopochain._alert((res.data && res.data.error) || 'Delete failed.');
  },

  // Move a challenge to another event. This was a window.prompt() asking
  // the operator to read an id out of a newline-joined list and type it
  // back — unstyled, unreadable on a phone, impossible to cancel
  // cleanly, and a typo silently moved the challenge somewhere else.
  // It's an inline panel with a real <select> now: the ids never have to
  // be transcribed, so there is nothing to mistype.
  async _moveChallenge(eventId, challengeId) {
    if (!AdminTopochain.canWrite()) return;
    const host = document.getElementById('admin-topo-ch-move');
    if (!host) return;
    const esc = AdminTopochain.esc;
    const closePanel = () => { host.innerHTML = ''; };
    host.innerHTML = `<div class="mt-3">${AdminTopochain._panel({
      title: 'Move this challenge', body: AdminTopochain._skeleton(2),
    })}</div>`;
    const events = await AdminTopochain._fetchAllEvents();
    if (!document.getElementById('admin-topo-ch-move')) return;
    const others = events.filter((e) => e.id !== eventId);
    if (!others.length) {
      // Distinct id per branch: the two panels used to share
      // `admin-topo-ch-move-cancel`, so the dismiss control depended on
      // which one happened to render.
      host.innerHTML = `<div class="mt-3">${AdminTopochain._panel({
        title: 'Move this challenge',
        closeId: 'admin-topo-ch-move-close',
        closeLabel: 'Close the move panel',
        body: '<p class="text-sm text-zinc-500">There is no other event to move this challenge to.</p>',
      })}</div>`;
      document.getElementById('admin-topo-ch-move-close').addEventListener('click', closePanel);
      return;
    }
    const opts = others.map((e) => `<option value="${esc(e.id)}">${esc(e.name)} (#${esc(e.id)})</option>`).join('');
    host.innerHTML = `<div class="mt-3">${AdminTopochain._panel({
      title: 'Move this challenge',
      subtitle: 'The challenge keeps its configuration; its recorded user activities move with it.',
      closeId: 'admin-topo-ch-move-close',
      closeLabel: 'Close the move panel',
      body: AdminTopochain._field('Destination event',
        `<select id="admin-topo-ch-move-target" class="${FIELD_CLS}">${opts}</select>`),
      footer: `<button id="admin-topo-ch-move-go" type="button" class="${BTN.primary}">Move</button>
        <button id="admin-topo-ch-move-cancel" type="button" class="${BTN.secondary}">Cancel</button>`,
    })}</div>`;
    document.getElementById('admin-topo-ch-move-go').addEventListener('click', async () => {
      const targetId = parseInt(document.getElementById('admin-topo-ch-move-target').value, 10);
      if (!Number.isInteger(targetId)) return;
      await AdminTopochain._submitChallengeMove(eventId, challengeId, targetId);
    });
    document.getElementById('admin-topo-ch-move-cancel').addEventListener('click', closePanel);
    document.getElementById('admin-topo-ch-move-close').addEventListener('click', closePanel);
  },

  async _submitChallengeMove(eventId, challengeId, targetId) {
    if (!AdminTopochain.canWrite()) return;
    const { ok, data } = await AdminTopochain.send(
      'PATCH', `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges/${encodeURIComponent(challengeId)}/move`,
      { target_season_event_id: targetId });
    if (ok && data?.success) AdminTopochain._loadChallenges(eventId);
    else AdminTopochain._alert((data && data.error) || 'Move failed.');
  },

  async _openChallengeForm(challengeId) {
    if (!AdminTopochain.canWrite()) return;
    const eventId = AdminTopochain._se.detailId;
    const existing = challengeId != null ? (AdminTopochain._challenges || []).find((c) => String(c.id) === String(challengeId)) : null;
    const f = AdminTopochain._inputHtml, sel = AdminTopochain._selectHtml, field = AdminTopochain._field;
    const host = document.getElementById('admin-topo-ch-form');

    let templateOptions = [];
    if (!existing) {
      const { ok, data } = await AdminTopochain.fetchJson(
        `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges/available-activity-types`);
      if (ok && data?.success) {
        templateOptions = data.data.map((t) => ({ value: t.id, label: `${t.category}: ${t.goal}` }));
      }
    }
    const ov = existing?.overrides || {};
    host.innerHTML = AdminTopochain._panel({
      title: existing ? 'Edit challenge' : 'Add challenge',
      subtitle: existing
        ? 'Overrides apply to this event only; the template is untouched.'
        : 'Pick a template, then override anything that should differ for this event.',
      closeId: 'admin-topo-ch-close',
      closeLabel: 'Close the challenge form',
      body: `
        ${existing ? '' : `<div class="mb-4">${field('Challenge template *', sel('admin-topo-ch-f-template', templateOptions, '', { blank: 'Choose a template…' }),
    templateOptions.length ? undefined : 'No unused Challenge templates are available for this event — create one in the Challenge templates tab first.')}</div>`}
        ${AdminTopochain._formGrid(`
          ${field('Goal override', f('admin-topo-ch-f-goal', { value: ov.goal }))}
          ${field('Reward override', f('admin-topo-ch-f-reward', { value: ov.reward }))}
          ${field('Kind', f('admin-topo-ch-f-kind', { value: existing?.activity_type?.kind }), 'No admin listing endpoint exists for Kinds (documented gap) — must match an existing challenge_kinds id.')}
          ${field('Display order', f('admin-topo-ch-f-display_order', { type: 'number', min: 0, value: existing?.display_order ?? 0 }))}
        `)}
        <div class="grid grid-cols-1 gap-4 mt-4">
          ${field('Task override', AdminTopochain._textareaHtml('admin-topo-ch-f-task', ov.task || '', 3))}
          ${field('Description override', AdminTopochain._textareaHtml('admin-topo-ch-f-description', ov.description || '', 3))}
        </div>
        ${AdminTopochain._formErrorSlot('admin-topo-ch-form-err')}`,
      footer: AdminTopochain._formActions('admin-topo-ch-save', 'admin-topo-ch-cancel', 'Save challenge'),
    });
    const closeForm = () => { host.innerHTML = ''; };
    document.getElementById('admin-topo-ch-save').addEventListener('click', () => AdminTopochain._saveChallenge(eventId, challengeId));
    document.getElementById('admin-topo-ch-cancel').addEventListener('click', closeForm);
    document.getElementById('admin-topo-ch-close').addEventListener('click', closeForm);
  },

  async _saveChallenge(eventId, challengeId) {
    if (!AdminTopochain.canWrite()) return;
    const errEl = document.getElementById('admin-topo-ch-form-err');
    errEl.classList.add('hidden');
    const val = (id) => document.getElementById(id)?.value ?? '';
    const body = {
      goal: val('admin-topo-ch-f-goal').trim() || null,
      reward: val('admin-topo-ch-f-reward').trim() || null,
      kind: val('admin-topo-ch-f-kind').trim() || null,
      task: val('admin-topo-ch-f-task').trim() || null,
      description: val('admin-topo-ch-f-description').trim() || null,
      display_order: Number(val('admin-topo-ch-f-display_order') || 0),
    };
    let url = `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges`;
    let method = 'POST';
    if (challengeId == null) {
      const templateId = document.getElementById('admin-topo-ch-f-template')?.value;
      if (!templateId) { errEl.textContent = 'Choose a challenge template.'; errEl.classList.remove('hidden'); return; }
      body.challenge_template_id = parseInt(templateId, 10);
    } else {
      url += `/${encodeURIComponent(challengeId)}`;
      method = 'PUT';
    }
    const { ok, data } = await AdminTopochain.send(method, url, body);
    if (!ok || !data?.success) {
      errEl.textContent = (data && data.error) || 'Save failed.';
      errEl.classList.remove('hidden');
      return;
    }
    document.getElementById('admin-topo-ch-form').innerHTML = '';
    AdminTopochain._loadChallenges(eventId);
  },

  // ══════════════════════════════════════════════════════════════════
  // Users — full CRUD + toggle-exclude-podium + import-csv + export-csv.
  // accept_logs also lives here (mobile-logs gap — see file header).
  // ══════════════════════════════════════════════════════════════════

  _users: { page: 1, perPage: 50, search: '', items: [], meta: null, editingId: null, deleteConfirm: null },

  renderUsers(host) {
    const canWrite = AdminTopochain.canWrite();
    const esc = AdminTopochain.esc;
    host.innerHTML = `
      ${AdminTopochain._screenHeader({
    title: 'Users',
    subtitle: 'Everyone enrolled in an event, and their podium and log settings.',
    actions: `<input id="admin-topo-u-search" type="text" placeholder="Search email/telegram/discord/name&hellip;"
            value="${esc(AdminTopochain._users.search)}" aria-label="Search users"
            class="${FIELD_CLS} sm:w-64">
          ${canWrite ? `<button id="admin-topo-u-new" type="button" class="${BTN.primarySm}">New user</button>` : ''}
          ${canWrite ? `<button id="admin-topo-u-import" type="button" class="${BTN.secondarySm}">Import CSV&hellip;</button>` : ''}
          <button id="admin-topo-u-export" type="button" class="${BTN.secondarySm}">Export CSV&hellip;</button>`,
  })}
      <div id="admin-topo-u-form"></div>
      <div id="admin-topo-u-table">${AdminTopochain._skeleton(4)}</div>`;
    document.getElementById('admin-topo-u-search').addEventListener('change', (e) => {
      AdminTopochain._users.search = e.target.value.trim();
      AdminTopochain._users.page = 1;
      AdminTopochain._loadUsers();
    });
    document.getElementById('admin-topo-u-new')?.addEventListener('click', () => AdminTopochain._openUserForm(null));
    document.getElementById('admin-topo-u-import')?.addEventListener('click', () => AdminTopochain._openUserImportForm());
    document.getElementById('admin-topo-u-export').addEventListener('click', () => AdminTopochain._openUserExport());
    AdminTopochain._loadUsers();
  },

  async _loadUsers() {
    const s = AdminTopochain._users;
    const params = new URLSearchParams({ page: String(s.page), per_page: String(s.perPage) });
    if (s.search) params.set('search', s.search);
    const { ok, data, status } = await AdminTopochain.fetchJson(`/api/v4/admin/users?${params}`);
    if (AdminTopochain._sub !== 'users') return;
    if (ok && data?.success) { s.items = data.data; s.meta = data.meta; s.error = null; }
    else { s.items = []; s.meta = null; s.error = { status, message: (data && data.error) || null }; }
    AdminTopochain._renderUsersTable();
  },

  _renderUsersTable() {
    const table = document.getElementById('admin-topo-u-table');
    if (!table) return;
    const esc = AdminTopochain.esc;
    const canWrite = AdminTopochain.canWrite();
    const s = AdminTopochain._users;
    if (s.error) {
      table.innerHTML = AdminTopochain._error({
        title: "Couldn't load users", status: s.error.status,
        message: s.error.message, retryId: 'admin-topo-u-retry',
      });
      AdminTopochain._wireRetry('admin-topo-u-retry', () => AdminTopochain._loadUsers());
      return;
    }
    if (!s.items.length) {
      table.innerHTML = AdminTopochain._empty({
        title: s.search ? 'No users match that search' : 'No users yet',
        body: s.search ? 'Clear the search box to see everyone.'
          : 'Users appear here once they join an event, or you can add one directly.',
        actionId: s.search ? null : 'admin-topo-u-empty-new',
        actionLabel: 'New user',
      });
      document.getElementById('admin-topo-u-empty-new')
        ?.addEventListener('click', () => AdminTopochain._openUserForm(null));
      return;
    }
    const ident = (u) => u.email || u.telegram || u.discord || `user #${u.id}`;
    table.innerHTML = AdminTopochain._list({
      items: s.items,
      columns: [
        { label: 'User', primary: true, cell: (u) => esc(u.display_name || ident(u)) },
        { label: 'Email', cell: (u) => esc(u.email || '—'), tdClass: 'text-xs text-zinc-500' },
        { label: 'Telegram', cell: (u) => esc(u.telegram || '—'), tdClass: 'text-xs text-zinc-500' },
        { label: 'Discord', cell: (u) => esc(u.discord || '—'), tdClass: 'text-xs text-zinc-500' },
        { label: 'Podium', cell: (u) => (u.exclude_podium ? '<span class="text-amber-600 dark:text-amber-400">excluded</span>' : '—') },
        { label: 'Accept logs', cell: (u) => (u.accept_logs ? 'yes' : 'no') },
      ],
      actions: (u) => `
        ${canWrite ? `<button data-toggle-podium="${u.id}" type="button" class="${BTN.row}">Toggle podium</button>` : ''}
        ${canWrite ? `<button data-edit-u="${u.id}" type="button" class="${BTN.row}">Edit</button>` : ''}
        ${canWrite ? `<button data-delete-u="${u.id}" data-identifier="${esc(ident(u))}" type="button" class="${BTN.rowDanger}">Delete</button>` : ''}`,
      // The typed-identifier confirm rides along as the row's extra
      // block, so it lands directly under the row in the table AND
      // inside the card on a phone.
      extra: (u) => (s.deleteConfirm?.id === u.id
        ? AdminTopochain._userDeleteConfirmBlock(u, ident(u)) : ''),
      rowClass: (u) => (s.deleteConfirm?.id === u.id ? 'bg-red-50 dark:bg-red-950/30' : ''),
    }) + AdminTopochain._pagerHtml(s.meta, 'admin-topo-u-pg');
    table.querySelectorAll('[data-toggle-podium]').forEach((b) => b.addEventListener('click', () => AdminTopochain._togglePodium(b.dataset.togglePodium)));
    table.querySelectorAll('[data-edit-u]').forEach((b) => b.addEventListener('click', () => AdminTopochain._openUserForm(parseInt(b.dataset.editU, 10))));
    table.querySelectorAll('[data-delete-u]').forEach((b) => b.addEventListener('click', () => {
      AdminTopochain._users.deleteConfirm = { id: parseInt(b.dataset.deleteU, 10), identifier: b.dataset.identifier };
      AdminTopochain._renderUsersTable();
    }));
    table.querySelectorAll('[data-confirm-delete-u]').forEach((b) => b.addEventListener('click', () => AdminTopochain._deleteUser(b.dataset.confirmDeleteU)));
    table.querySelectorAll('[data-cancel-delete-u]').forEach((b) => b.addEventListener('click', () => { AdminTopochain._users.deleteConfirm = null; AdminTopochain._renderUsersTable(); }));
    // querySelectorAll, not querySelector: _list() renders the row in
    // both the table and the card stack, so the confirm button exists
    // twice and only the visible copy would otherwise ever enable.
    table.querySelectorAll('[data-typed-check]').forEach((inp) => inp.addEventListener('input', () => {
      const match = inp.value === inp.dataset.expect;
      table.querySelectorAll(`[data-confirm-delete-u="${inp.dataset.typedCheck}"]`)
        .forEach((btn) => { btn.disabled = !match; });
    }));
    if (s.meta) AdminTopochain._wirePager(s.meta, 'admin-topo-u-pg', (page) => { s.page = page; AdminTopochain._loadUsers(); });
  },

  // STRONG confirm (the task brief: "the endpoint can delete any platform
  // user"). A plain yes/no confirm isn't enough here — this DELETE has
  // NO server-side confirmation body param at all (per the API contract:
  // only a self-delete guard and a last-full-admin guard), and it targets
  // the SHARED platform users table, so it could remove a real login,
  // not just a topochain-only row. The admin must type the user's own
  // displayed identifier (exact match) before the real Delete button
  // enables — mirrors the DB export section's typed-EXPORT idiom rather
  // than a native confirm()/prompt().
  // Layout-neutral (no <tr>/<td>): _list() drops it into a full-width
  // row under the table row AND into the card on a phone, so it has to
  // work in both.
  _userDeleteConfirmBlock(u, identifier) {
    const esc = AdminTopochain.esc;
    return `<div class="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4">
      <p class="text-xs text-red-700 dark:text-red-300 mb-3">
        This permanently deletes <strong>${esc(identifier)}</strong> from the platform users table —
        this can be ANY platform user, including real logins and other admins, not just a user of
        this programme. Type <code>${esc(identifier)}</code> exactly to confirm.
      </p>
      <input data-typed-check="${u.id}" data-expect="${esc(identifier)}" type="text"
        aria-label="Type the identifier to confirm deletion"
        class="w-full rounded-lg bg-white dark:bg-zinc-900 border border-red-300 dark:border-red-800 px-3 py-2 text-xs font-mono min-h-[44px] sm:min-h-[36px] focus:outline-none focus:ring-2 focus:ring-red-500 sm:max-w-sm">
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button data-confirm-delete-u="${u.id}" type="button" disabled class="${BTN.dangerSm}">Delete permanently</button>
        <button data-cancel-delete-u="${u.id}" type="button" class="${BTN.secondarySm}">Cancel</button>
      </div>
    </div>`;
  },

  async _togglePodium(id) {
    if (!AdminTopochain.canWrite()) return;
    const { ok, data } = await AdminTopochain.send('PATCH', `/api/v4/admin/users/${encodeURIComponent(id)}/toggle-exclude-podium`);
    if (ok && data?.success) AdminTopochain._loadUsers();
    else AdminTopochain._alert((data && data.error) || 'Update failed.');
  },

  async _deleteUser(id) {
    if (!AdminTopochain.canWrite()) return;
    const res = await AdminTopochain.send('DELETE', `/api/v4/admin/users/${encodeURIComponent(id)}`);
    AdminTopochain._users.deleteConfirm = null;
    if (res.ok && res.data?.success) AdminTopochain._loadUsers();
    else AdminTopochain._alert((res.data && res.data.error) || 'Delete failed.');
  },

  async _openUserForm(id) {
    if (!AdminTopochain.canWrite()) return;
    AdminTopochain._users.editingId = id;
    let u = null;
    if (id != null) {
      const { ok, data } = await AdminTopochain.fetchJson(`/api/v4/admin/users/${encodeURIComponent(id)}`);
      if (ok && data?.success) u = data.data;
    }
    const events = await AdminTopochain._fetchAllEvents();
    const enrolledIds = new Set((u?.events || []).map((e) => e.id));
    const f = AdminTopochain._inputHtml, field = AdminTopochain._field, esc = AdminTopochain.esc;
    const optionsHtml = events.map((ev) => `<option value="${ev.id}" ${enrolledIds.has(ev.id) ? 'selected' : ''}>${esc(ev.name)} (#${ev.id})</option>`).join('');
    const host = document.getElementById('admin-topo-u-form');
    host.innerHTML = AdminTopochain._panel({
      title: id == null ? 'New user' : `Edit user #${esc(id)}`,
      subtitle: 'At least one identifier is required. Enrolment is set here too.',
      closeId: 'admin-topo-u-close',
      closeLabel: 'Close the user form',
      body: `
        ${AdminTopochain._formGrid(`
          ${field('Email', f('admin-topo-u-f-email', { value: u?.email }))}
          ${field('Telegram', f('admin-topo-u-f-telegram', { value: u?.telegram }))}
          ${field('Discord', f('admin-topo-u-f-discord', { value: u?.discord }))}
          ${field('Display name', f('admin-topo-u-f-display_name', { value: u?.display_name }))}
        `)}
        <div class="mt-4 border-t border-zinc-200 dark:border-zinc-800 pt-3">
          ${AdminTopochain._checkField('admin-topo-u-f-accept_logs', 'Accept logs', u ? u.accept_logs : true,
    'Mobile log opt-out lives here — no separate log-payload viewer exists; see Task 15 notes.')}
        </div>
        <div class="mt-4">
          ${field('Events (ctrl/cmd-click to select multiple)', `<select id="admin-topo-u-f-events" multiple size="5"
            class="${FIELD_CLS}">${optionsHtml}</select>`)}
        </div>
        ${AdminTopochain._formErrorSlot('admin-topo-u-form-err')}`,
      footer: AdminTopochain._formActions('admin-topo-u-save', 'admin-topo-u-cancel', 'Save user'),
    });
    const closeForm = () => { host.innerHTML = ''; AdminTopochain._users.editingId = null; };
    document.getElementById('admin-topo-u-save').addEventListener('click', () => AdminTopochain._saveUser());
    document.getElementById('admin-topo-u-cancel').addEventListener('click', closeForm);
    document.getElementById('admin-topo-u-close').addEventListener('click', closeForm);
  },

  async _saveUser() {
    if (!AdminTopochain.canWrite()) return;
    const errEl = document.getElementById('admin-topo-u-form-err');
    errEl.classList.add('hidden');
    const val = (id) => (document.getElementById(id)?.value ?? '').trim();
    const selected = [...document.getElementById('admin-topo-u-f-events').selectedOptions].map((o) => parseInt(o.value, 10));
    const body = {
      email: val('admin-topo-u-f-email') || null,
      telegram: val('admin-topo-u-f-telegram') || null,
      discord: val('admin-topo-u-f-discord') || null,
      display_name: val('admin-topo-u-f-display_name') || null,
      accept_logs: !!document.getElementById('admin-topo-u-f-accept_logs')?.checked,
      season_event_ids: selected,
    };
    if (!body.email && !body.telegram && !body.discord) {
      errEl.textContent = 'At least one identifier (email, telegram, or discord) is required.';
      errEl.classList.remove('hidden');
      return;
    }
    const id = AdminTopochain._users.editingId;
    const url = id == null ? '/api/v4/admin/users' : `/api/v4/admin/users/${encodeURIComponent(id)}`;
    const { ok, data } = await AdminTopochain.send(id == null ? 'POST' : 'PUT', url, body);
    if (!ok || !data?.success) {
      errEl.textContent = (data && data.error) || 'Save failed.';
      errEl.classList.remove('hidden');
      return;
    }
    document.getElementById('admin-topo-u-form').innerHTML = '';
    AdminTopochain._users.editingId = null;
    AdminTopochain._loadUsers();
  },

  async _openUserImportForm() {
    if (!AdminTopochain.canWrite()) return;
    const events = await AdminTopochain._fetchAllEvents();
    const sel = AdminTopochain._selectHtml, field = AdminTopochain._field;
    const host = document.getElementById('admin-topo-u-form');
    host.innerHTML = AdminTopochain._panel({
      title: 'Import users',
      subtitle: 'CSV-style, one user per line.',
      closeId: 'admin-topo-u-imp-close',
      closeLabel: 'Close the import panel',
      body: `
        <div class="grid grid-cols-1 gap-4">
          ${field('Event *', sel('admin-topo-u-imp-event', AdminTopochain._eventOptions(events), '', { blank: 'Choose an event…' }))}
          ${field('Users — one "email,username" per line *', AdminTopochain._textareaHtml('admin-topo-u-imp-rows', '', 8),
    'username here maps to the Discord handle column, per the import API.')}
        </div>
        <div class="mt-3 border-t border-zinc-200 dark:border-zinc-800 pt-3">
          ${AdminTopochain._checkField('admin-topo-u-imp-link', 'Link onchain accounts too', false)}
        </div>
        <div class="mt-3">${AdminTopochain._formGrid(`
          ${field('Min balance', AdminTopochain._inputHtml('admin-topo-u-imp-min', { type: 'number', min: 0 }))}
          ${field('Max balance', AdminTopochain._inputHtml('admin-topo-u-imp-max', { type: 'number', min: 0 }))}
        `)}</div>
        ${AdminTopochain._formErrorSlot('admin-topo-u-imp-err')}
        <div id="admin-topo-u-imp-result" class="mt-3 text-xs text-zinc-500"></div>`,
      footer: `<button id="admin-topo-u-imp-go" type="button" class="${BTN.primary}">Import</button>
        <button id="admin-topo-u-imp-cancel" type="button" class="${BTN.secondary}">Cancel</button>`,
    });
    const closeForm = () => { host.innerHTML = ''; };
    document.getElementById('admin-topo-u-imp-go').addEventListener('click', () => AdminTopochain._runUserImport());
    document.getElementById('admin-topo-u-imp-cancel').addEventListener('click', closeForm);
    document.getElementById('admin-topo-u-imp-close').addEventListener('click', closeForm);
  },

  async _runUserImport() {
    if (!AdminTopochain.canWrite()) return;
    const errEl = document.getElementById('admin-topo-u-imp-err');
    errEl.classList.add('hidden');
    const eventId = document.getElementById('admin-topo-u-imp-event').value;
    if (!eventId) { errEl.textContent = 'Choose an event.'; errEl.classList.remove('hidden'); return; }
    const lines = document.getElementById('admin-topo-u-imp-rows').value.split('\n').map((l) => l.trim()).filter(Boolean);
    const participants = lines.map((line) => {
      const [email, username] = line.split(',').map((s) => (s || '').trim());
      return { email, username };
    });
    if (!participants.length) { errEl.textContent = 'Add at least one user row.'; errEl.classList.remove('hidden'); return; }
    const body = {
      season_event_id: parseInt(eventId, 10),
      participants,
      link_accounts: !!document.getElementById('admin-topo-u-imp-link').checked,
    };
    const min = document.getElementById('admin-topo-u-imp-min').value.trim();
    const max = document.getElementById('admin-topo-u-imp-max').value.trim();
    if (min !== '') body.min_balance = Number(min);
    if (max !== '') body.max_balance = Number(max);
    const { ok, data } = await AdminTopochain.send('POST', '/api/v4/admin/users/import-csv', body);
    if (!ok || !data?.success) {
      errEl.textContent = (data && data.error) || 'Import failed.';
      errEl.classList.remove('hidden');
      return;
    }
    const r = data.data;
    const esc = AdminTopochain.esc;
    document.getElementById('admin-topo-u-imp-result').innerHTML =
      `Created ${esc(r.created_count)}, linked ${esc(r.linked_count)}, added to event ${esc(r.added_to_phase_count)},
       already enrolled ${esc(r.already_in_phase_count)}, skipped ${esc(r.skipped_count)}.
       ${r.errors.length ? `<br>${r.errors.map((e) => esc(e)).join('<br>')}` : ''}`;
    AdminTopochain._loadUsers();
  },

  // Export users for one event. Was a window.prompt() listing "id: name"
  // pairs the operator had to read and retype — an inline panel with a
  // real <select> now, rendered into the same host the New/Import forms
  // use so only one of the three is ever open.
  async _openUserExport() {
    const host = document.getElementById('admin-topo-u-form');
    if (!host) return;
    const esc = AdminTopochain.esc;
    const closePanel = () => { host.innerHTML = ''; };
    host.innerHTML = AdminTopochain._panel({ title: 'Export users as CSV', body: AdminTopochain._skeleton(2) });
    const events = await AdminTopochain._fetchAllEvents();
    if (AdminTopochain._sub !== 'users' || !document.getElementById('admin-topo-u-form')) return;
    if (!events.length) {
      // Distinct id per branch — a shared one made the dismiss control
      // depend on which branch happened to render.
      host.innerHTML = AdminTopochain._panel({
        title: 'Export users as CSV',
        closeId: 'admin-topo-u-exp-close',
        closeLabel: 'Close the export panel',
        body: '<p class="text-sm text-zinc-500">There is no event to export users for yet.</p>',
      });
      document.getElementById('admin-topo-u-exp-close').addEventListener('click', closePanel);
      return;
    }
    const opts = events.map((e) => `<option value="${esc(e.id)}">${esc(e.name)} (#${esc(e.id)})</option>`).join('');
    host.innerHTML = AdminTopochain._panel({
      title: 'Export users as CSV',
      subtitle: 'Downloads every user enrolled in the selected event.',
      closeId: 'admin-topo-u-exp-close',
      closeLabel: 'Close the export panel',
      body: AdminTopochain._field('Event',
        `<select id="admin-topo-u-exp-event" class="${FIELD_CLS}">${opts}</select>`),
      footer: `<button id="admin-topo-u-exp-go" type="button" class="${BTN.primary}">Download CSV</button>
        <button id="admin-topo-u-exp-cancel" type="button" class="${BTN.secondary}">Cancel</button>`,
    });
    document.getElementById('admin-topo-u-exp-go').addEventListener('click', () => {
      const id = parseInt(document.getElementById('admin-topo-u-exp-event').value, 10);
      if (!Number.isInteger(id) || id <= 0) return;
      // Same-origin, server-generated path built from a numeric id we
      // just fetched ourselves (never attacker-controlled) —
      // navigation, not a Blob, since this is a streamed CSV
      // attachment.
      window.location.href = `/api/v4/admin/users/export-csv/${encodeURIComponent(id)}`;
    });
    document.getElementById('admin-topo-u-exp-cancel').addEventListener('click', closePanel);
    document.getElementById('admin-topo-u-exp-close').addEventListener('click', closePanel);
  },

  // ══════════════════════════════════════════════════════════════════
  // Waitlist — the platform waitlist (email-keyed queue with release)
  // and the block-producer queue (users who asked to produce blocks),
  // stacked on one tab. Onboarding flow alignment: "release" on the
  // platform list grants access now (if an account exists) or at
  // account creation; "release" on the BP list is the manual key
  // release that lets the mobile node enable block production.
  // ══════════════════════════════════════════════════════════════════

  _waitlist: { page: 1, perPage: 50, status: 'pending', items: [], meta: null },
  _bpq: { page: 1, perPage: 50, status: 'pending', items: [], meta: null },

  renderWaitlist(host) {
    const esc = AdminTopochain.esc;
    const statusSelect = (id, current, label) => `
      <select id="${esc(id)}" aria-label="${esc(label)}" class="${FIELD_CLS} sm:w-40">
        ${['pending', 'released', 'all'].map((v) =>
    `<option value="${v}"${v === current ? ' selected' : ''}>${v[0].toUpperCase()}${v.slice(1)}</option>`).join('')}
      </select>`;
    host.innerHTML = `
      ${AdminTopochain._screenHeader({
    title: 'Platform waitlist',
    subtitle: 'Signups from the public join form. Releasing grants access.',
    actions: statusSelect('admin-topo-wl-status', AdminTopochain._waitlist.status, 'Filter the waitlist by status'),
  })}
      <div id="admin-topo-wl-table">${AdminTopochain._skeleton(4)}</div>
      <div class="mt-10">
        ${AdminTopochain._screenHeader({
    title: 'Block-producer queue',
    subtitle: 'Users who asked to produce blocks. Releasing hands over the key.',
    actions: statusSelect('admin-topo-bpq-status', AdminTopochain._bpq.status, 'Filter the block-producer queue by status'),
  })}
      </div>
      <div id="admin-topo-bpq-table">${AdminTopochain._skeleton(4)}</div>`;
    document.getElementById('admin-topo-wl-status').addEventListener('change', (e) => {
      AdminTopochain._waitlist.status = e.target.value;
      AdminTopochain._waitlist.page = 1;
      AdminTopochain._loadWaitlist();
    });
    document.getElementById('admin-topo-bpq-status').addEventListener('change', (e) => {
      AdminTopochain._bpq.status = e.target.value;
      AdminTopochain._bpq.page = 1;
      AdminTopochain._loadBpQueue();
    });
    AdminTopochain._loadWaitlist();
    AdminTopochain._loadBpQueue();
  },

  async _loadWaitlist() {
    const s = AdminTopochain._waitlist;
    const params = new URLSearchParams({ page: String(s.page), per_page: String(s.perPage) });
    if (s.status !== 'all') params.set('status', s.status);
    const { ok, data, status } = await AdminTopochain.fetchJson(`/api/v4/admin/waitlist?${params}`);
    if (AdminTopochain._sub !== 'waitlist') return;
    if (ok && data?.success) { s.items = data.data; s.meta = data.meta; s.error = null; }
    else { s.items = []; s.meta = null; s.error = { status, message: (data && data.error) || null }; }
    AdminTopochain._renderWaitlistTable();
  },

  _renderWaitlistTable() {
    const table = document.getElementById('admin-topo-wl-table');
    if (!table) return;
    const esc = AdminTopochain.esc;
    const canWrite = AdminTopochain.canWrite();
    const s = AdminTopochain._waitlist;
    if (s.error) {
      table.innerHTML = AdminTopochain._error({
        title: "Couldn't load the waitlist", status: s.error.status,
        message: s.error.message, retryId: 'admin-topo-wl-retry',
      });
      AdminTopochain._wireRetry('admin-topo-wl-retry', () => AdminTopochain._loadWaitlist());
      return;
    }
    if (!s.items.length) {
      table.innerHTML = AdminTopochain._empty({
        title: 'No waitlist entries',
        body: 'Signups from the public join form land here.',
      });
      return;
    }
    table.innerHTML = AdminTopochain._list({
      items: s.items,
      columns: [
        {
          label: 'Email',
          primary: true,
          tdClass: 'font-mono',
          cell: (w) => `${esc(w.email)}${w.confirmed_at
            ? ' <span class="text-emerald-600 dark:text-emerald-400 text-xs" title="Followed the confirm link in the join email">✓ confirmed</span>'
            : ' <span class="text-zinc-400 text-xs" title="Never followed the confirm link in the join email — this address is unproven">unconfirmed</span>'}`,
        },
        { label: 'Joined', cell: (w) => esc(AdminTopochain._fmt(w.submitted_at)), tdClass: 'text-xs text-zinc-500' },
        {
          label: 'Account',
          cell: (w) => (w.linked_username
            ? `${esc(w.linked_username)}${w.has_platform_access ? ' <span class="text-emerald-600 dark:text-emerald-400 text-xs">(has access)</span>' : ''}`
            : '<span class="text-zinc-400">no account yet</span>'),
        },
        {
          label: 'Status',
          cell: (w) => (w.released_at
            ? `<span class="text-emerald-600 dark:text-emerald-400 text-xs">Released ${esc(AdminTopochain._fmt(w.released_at))}</span>`
            : '<span class="text-amber-600 dark:text-amber-400 text-xs">pending</span>'),
        },
      ],
      actions: (w) => (canWrite && !w.released_at
        ? `<button data-release-wl="${w.id}" data-email="${esc(w.email)}" type="button" class="${BTN.rowPrimary}">Release</button>`
        : ''),
      extra: (w) => (w.answers ? `
        <details class="text-xs">
          <summary class="cursor-pointer select-none text-zinc-500 min-h-[36px] flex items-center">Survey answers</summary>
          <div class="mt-1 space-y-0.5 text-zinc-600 dark:text-zinc-300">${AdminTopochain._wlAnswersHtml(w.answers)}</div>
        </details>` : ''),
    }) + AdminTopochain._pagerHtml(s.meta, 'admin-topo-wl-pg');
    table.querySelectorAll('[data-release-wl]').forEach((b) => b.addEventListener('click', () =>
      AdminTopochain._releaseWaitlist(parseInt(b.dataset.releaseWl, 10), b.dataset.email)));
    if (s.meta) AdminTopochain._wirePager(s.meta, 'admin-topo-wl-pg', (page) => { s.page = page; AdminTopochain._loadWaitlist(); });
  },

  // Human-readable rendering of a signup's two-stage survey answers
  // (waitlist_signups.answers — stage 1 at join, stage 2 merged in
  // later). Only known keys are surfaced; everything is escaped.
  _wlAnswersHtml(a) {
    const esc = AdminTopochain.esc;
    const lines = [];
    const line = (label, value) => {
      if (value) lines.push(`<div><span class="text-zinc-400">${esc(label)}:</span> ${value}</div>`);
    };
    if (a.made_url) {
      // Escaped text, not an anchor — this module never renders
      // API-supplied URLs as clickable hrefs (esc() alone wouldn't stop a
      // javascript: scheme). Admins can copy the URL out.
      line('Made', `<span class="select-all break-all">${esc(a.made_url)}</span>${a.made_note ? ` — ${esc(a.made_note)}` : ''}`);
    }
    if (a.country || a.city) line('Where', esc([a.city, a.country].filter(Boolean).join(', ')));
    if (a.discovery && a.discovery.source) {
      line('Found us', esc(a.discovery.source) + (a.discovery.detail ? ` — ${esc(a.discovery.detail)}` : ''));
    }
    if (a.referrer_handle) line('Referred by', esc(a.referrer_handle));
    if (a.group && Object.keys(a.group).length) {
      const g = a.group;
      line('Group', esc([g.name, g.size, g.role, (g.tools || []).join('/')].filter(Boolean).join(' · ')));
      if (g.need) line('Group need', esc(g.need));
    }
    if (a.loss && Object.keys(a.loss).length) {
      const l = a.loss;
      line('Lost a tool', esc([l.had, l.product, (l.kind || []).join('/')].filter(Boolean).join(' · ')));
      if (l.story) line('Loss story', esc(l.story));
    }
    if (a.verified && Object.keys(a.verified).length) {
      line('Verified', Object.entries(a.verified)
        .map(([p, h]) => `<span class="text-emerald-600 dark:text-emerald-400">✓ ${esc(p)} · ${esc(h)}</span>`)
        .join('  '));
    }
    if (a.handles && Object.keys(a.handles).length) {
      line('Handles', esc(Object.entries(a.handles).map(([p, h]) => `${p}: ${h}`).join(' · ')));
    }
    if (Array.isArray(a.invites) && a.invites.length) {
      line('Invites', esc(a.invites.join(', ')) + (a.admit_together ? ' <span class="text-zinc-400">(only together)</span>' : ''));
    } else if (a.admit_together) {
      line('Invites', '<span class="text-zinc-400">only together</span>');
    }
    return lines.join('') || '<div class="text-zinc-400">No survey answers.</div>';
  },

  async _releaseWaitlist(id, email) {
    if (!AdminTopochain.canWrite()) return;
    const okd = await AdminTopochain._confirm({
      title: 'Release off the waitlist?',
      message: `${email} gets platform access — immediately if they already have an account, otherwise the moment they create one. They'll be emailed a link to sign in or create their account.`,
      confirmLabel: 'Release',
    });
    if (!okd) return;
    const { ok, data } = await AdminTopochain.send('POST', `/api/v4/admin/waitlist/${id}/release`);
    if (!ok || !data?.success) { AdminTopochain._alert(data?.error || 'Release failed.'); return; }
    AdminTopochain._loadWaitlist();
  },

  async _loadBpQueue() {
    const s = AdminTopochain._bpq;
    const params = new URLSearchParams({ page: String(s.page), per_page: String(s.perPage) });
    if (s.status !== 'all') params.set('status', s.status);
    const { ok, data, status } = await AdminTopochain.fetchJson(`/api/v4/admin/bp-queue?${params}`);
    if (AdminTopochain._sub !== 'waitlist') return;
    if (ok && data?.success) { s.items = data.data; s.meta = data.meta; s.error = null; }
    else { s.items = []; s.meta = null; s.error = { status, message: (data && data.error) || null }; }
    AdminTopochain._renderBpQueueTable();
  },

  _renderBpQueueTable() {
    const table = document.getElementById('admin-topo-bpq-table');
    if (!table) return;
    const esc = AdminTopochain.esc;
    const canWrite = AdminTopochain.canWrite();
    const s = AdminTopochain._bpq;
    if (s.error) {
      table.innerHTML = AdminTopochain._error({
        title: "Couldn't load block-production requests", status: s.error.status,
        message: s.error.message, retryId: 'admin-topo-bpq-retry',
      });
      AdminTopochain._wireRetry('admin-topo-bpq-retry', () => AdminTopochain._loadBpQueue());
      return;
    }
    if (!s.items.length) {
      table.innerHTML = AdminTopochain._empty({
        title: 'No block-production requests',
        body: 'Requests appear here when a user asks for producer keys from the app.',
      });
      return;
    }
    const bpIdent = (u) => u.display_name || u.username || u.email || `user #${u.id}`;
    table.innerHTML = AdminTopochain._list({
      items: s.items,
      columns: [
        { label: 'User', primary: true, cell: (u) => esc(u.display_name || u.username || `user #${u.id}`) },
        { label: 'Email', cell: (u) => esc(u.email || '—'), tdClass: 'text-xs text-zinc-500 font-mono' },
        { label: 'Requested', cell: (u) => esc(AdminTopochain._fmt(u.bp_requested_at)), tdClass: 'text-xs text-zinc-500' },
        {
          label: 'Status',
          cell: (u) => (u.bp_released_at
            ? `<span class="text-emerald-600 dark:text-emerald-400 text-xs">Released ${esc(AdminTopochain._fmt(u.bp_released_at))}</span>`
            : '<span class="text-amber-600 dark:text-amber-400 text-xs">pending</span>'),
        },
      ],
      actions: (u) => (canWrite && !u.bp_released_at
        ? `<button data-release-bp="${u.id}" data-identifier="${esc(bpIdent(u))}" type="button" class="${BTN.rowPrimary}">Release keys</button>`
        : ''),
    }) + AdminTopochain._pagerHtml(s.meta, 'admin-topo-bpq-pg');
    table.querySelectorAll('[data-release-bp]').forEach((b) => b.addEventListener('click', () =>
      AdminTopochain._releaseBp(parseInt(b.dataset.releaseBp, 10), b.dataset.identifier)));
    if (s.meta) AdminTopochain._wirePager(s.meta, 'admin-topo-bpq-pg', (page) => { s.page = page; AdminTopochain._loadBpQueue(); });
  },

  async _releaseBp(id, identifier) {
    if (!AdminTopochain.canWrite()) return;
    const okd = await AdminTopochain._confirm({
      title: 'Release block production?',
      message: `${identifier}'s phone will start producing blocks the next time the app syncs its profile.`,
      confirmLabel: 'Release keys',
    });
    if (!okd) return;
    const { ok, data } = await AdminTopochain.send('POST', `/api/v4/admin/users/${id}/release-bp`);
    if (!ok || !data?.success) { AdminTopochain._alert(data?.error || 'Release failed.'); return; }
    AdminTopochain._loadBpQueue();
  },

  // ══════════════════════════════════════════════════════════════════
  // Onchain accounts — index/show/import/:id/reset (no create/edit/
  // delete singular routes exist per the API surface — nothing invented
  // here beyond what's documented).
  // ══════════════════════════════════════════════════════════════════

  _accts: { page: 1, perPage: 50, search: '', items: [], meta: null },

  renderOnchainAccounts(host) {
    const canWrite = AdminTopochain.canWrite();
    const esc = AdminTopochain.esc;
    host.innerHTML = `
      ${AdminTopochain._screenHeader({
    title: 'Onchain accounts',
    subtitle: 'Accounts linked to users, with their identity and balances.',
    actions: `<input id="admin-topo-oa-search" type="text" placeholder="Search public key/identity/code&hellip;"
            value="${esc(AdminTopochain._accts.search)}" aria-label="Search onchain accounts"
            class="${FIELD_CLS} sm:w-64">
          ${canWrite ? `<button id="admin-topo-oa-import" type="button" class="${BTN.primarySm}">Import&hellip;</button>` : ''}`,
  })}
      <div id="admin-topo-oa-form"></div>
      <div id="admin-topo-oa-table">${AdminTopochain._skeleton(4)}</div>`;
    document.getElementById('admin-topo-oa-search').addEventListener('change', (e) => {
      AdminTopochain._accts.search = e.target.value.trim();
      AdminTopochain._accts.page = 1;
      AdminTopochain._loadAccounts();
    });
    document.getElementById('admin-topo-oa-import')?.addEventListener('click', () => AdminTopochain._openAccountImportForm());
    AdminTopochain._loadAccounts();
  },

  async _loadAccounts() {
    const s = AdminTopochain._accts;
    const params = new URLSearchParams({ page: String(s.page), per_page: String(s.perPage) });
    if (s.search) params.set('search', s.search);
    const { ok, data, status } = await AdminTopochain.fetchJson(`/api/v4/admin/onchain-accounts?${params}`);
    if (AdminTopochain._sub !== 'onchain-accounts') return;
    if (ok && data?.success) { s.items = data.data; s.meta = data.meta; s.error = null; }
    else { s.items = []; s.meta = null; s.error = { status, message: (data && data.error) || null }; }
    AdminTopochain._renderAccountsTable();
  },

  _renderAccountsTable() {
    const table = document.getElementById('admin-topo-oa-table');
    if (!table) return;
    const esc = AdminTopochain.esc;
    const canWrite = AdminTopochain.canWrite();
    const s = AdminTopochain._accts;
    if (s.error) {
      table.innerHTML = AdminTopochain._error({
        title: "Couldn't load onchain accounts", status: s.error.status,
        message: s.error.message, retryId: 'admin-topo-oa-retry',
      });
      AdminTopochain._wireRetry('admin-topo-oa-retry', () => AdminTopochain._loadAccounts());
      return;
    }
    if (!s.items.length) {
      table.innerHTML = AdminTopochain._empty({
        title: s.search ? 'No accounts match that search' : 'No onchain accounts yet',
        body: s.search ? 'Clear the search box to see every account.'
          : 'Import a batch of accounts to hand out registration codes for an event.',
        actionId: s.search ? null : 'admin-topo-oa-empty-import',
        actionLabel: 'Import accounts',
      });
      document.getElementById('admin-topo-oa-empty-import')
        ?.addEventListener('click', () => AdminTopochain._openAccountImportForm());
      return;
    }
    table.innerHTML = AdminTopochain._list({
      items: s.items,
      columns: [
        { label: 'Public key', primary: true, cell: (a) => esc(a.public_key), tdClass: 'text-xs font-mono' },
        { label: 'Tier', cell: (a) => esc(a.tier), tdClass: 'text-zinc-500' },
        { label: 'Amount', cell: (a) => esc(a.amount), tdClass: 'font-mono text-right', thClass: 'text-right' },
        { label: 'Event', cell: (a) => (a.event ? esc(a.event.name) : '—'), tdClass: 'text-xs text-zinc-500' },
        { label: 'Status', cell: (a) => (a.is_used ? '<span class="text-amber-600 dark:text-amber-400">used</span>' : '<span class="text-green-600 dark:text-green-400">free</span>') },
        { label: 'User', cell: (a) => (a.user ? esc(a.user.username) : '—'), tdClass: 'text-xs text-zinc-500' },
      ],
      actions: (a) => (canWrite && a.is_used
        ? `<button data-reset="${a.id}" type="button" class="${BTN.rowWarn}">Reset</button>` : ''),
    }) + AdminTopochain._pagerHtml(s.meta, 'admin-topo-oa-pg');
    table.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => AdminTopochain._resetAccount(b.dataset.reset)));
    if (s.meta) AdminTopochain._wirePager(s.meta, 'admin-topo-oa-pg', (page) => { s.page = page; AdminTopochain._loadAccounts(); });
  },

  async _resetAccount(id) {
    if (!AdminTopochain.canWrite()) return;
    const ok = await AdminTopochain._confirm({
      title: 'Reset this account?',
      message: 'Clears the current user’s claim (user_id, is_used, used_at) so the account becomes assignable again. The registration code itself is kept.',
      confirmLabel: 'Reset',
    });
    if (!ok) return;
    const res = await AdminTopochain.send('POST', `/api/v4/admin/onchain-accounts/${encodeURIComponent(id)}/reset`);
    if (res.ok && res.data?.success) AdminTopochain._loadAccounts();
    else AdminTopochain._alert((res.data && res.data.error) || 'Reset failed.');
  },

  async _openAccountImportForm() {
    if (!AdminTopochain.canWrite()) return;
    const events = await AdminTopochain._fetchAllEvents();
    const sel = AdminTopochain._selectHtml, field = AdminTopochain._field;
    const host = document.getElementById('admin-topo-oa-form');
    host.innerHTML = AdminTopochain._panel({
      title: 'Import onchain accounts',
      subtitle: 'One account per line, for a single event.',
      closeId: 'admin-topo-oa-imp-close',
      closeLabel: 'Close the import panel',
      body: `
        <div class="grid grid-cols-1 gap-4">
          ${field('Event *', sel('admin-topo-oa-imp-event', AdminTopochain._eventOptions(events), '', { blank: 'Choose an event…' }))}
          ${field('Accounts — one "amount,identity_uid,address,public_key,secret_key,tier,description" per line *',
    AdminTopochain._textareaHtml('admin-topo-oa-imp-rows', '', 8),
    'registration_code is generated server-side; do not include it.')}
        </div>
        ${AdminTopochain._formErrorSlot('admin-topo-oa-imp-err')}
        <div id="admin-topo-oa-imp-result" class="mt-3 text-xs text-zinc-500"></div>`,
      footer: `<button id="admin-topo-oa-imp-go" type="button" class="${BTN.primary}">Import</button>
        <button id="admin-topo-oa-imp-cancel" type="button" class="${BTN.secondary}">Cancel</button>`,
    });
    const closeForm = () => { host.innerHTML = ''; };
    document.getElementById('admin-topo-oa-imp-go').addEventListener('click', () => AdminTopochain._runAccountImport());
    document.getElementById('admin-topo-oa-imp-cancel').addEventListener('click', closeForm);
    document.getElementById('admin-topo-oa-imp-close').addEventListener('click', closeForm);
  },

  async _runAccountImport() {
    if (!AdminTopochain.canWrite()) return;
    const errEl = document.getElementById('admin-topo-oa-imp-err');
    errEl.classList.add('hidden');
    const eventId = document.getElementById('admin-topo-oa-imp-event').value;
    if (!eventId) { errEl.textContent = 'Choose an event.'; errEl.classList.remove('hidden'); return; }
    const lines = document.getElementById('admin-topo-oa-imp-rows').value.split('\n').map((l) => l.trim()).filter(Boolean);
    const accounts = lines.map((line) => {
      const [amount, identity_uid, address, public_key, secret_key, tier, description] = line.split(',').map((s) => (s || '').trim());
      return { amount: Number(amount), identity_uid, address, public_key, secret_key, tier, description: description || null };
    });
    if (!accounts.length) { errEl.textContent = 'Add at least one account row.'; errEl.classList.remove('hidden'); return; }
    const { ok, data } = await AdminTopochain.send('POST', '/api/v4/admin/onchain-accounts/import',
      { season_event_id: parseInt(eventId, 10), accounts });
    if (!ok || !data?.success) {
      errEl.textContent = (data && data.error) || 'Import failed.';
      errEl.classList.remove('hidden');
      return;
    }
    const r = data.data;
    const esc = AdminTopochain.esc;
    document.getElementById('admin-topo-oa-imp-result').innerHTML =
      `Imported ${esc(r.imported_count)}, skipped ${esc(r.skipped_count)}.
       ${r.errors.length ? `<br>${r.errors.map((e) => esc(e)).join('<br>')}` : ''}`;
    AdminTopochain._loadAccounts();
  },

  // ══════════════════════════════════════════════════════════════════
  // User activities — full CRUD + import + totals + refresh-totals.
  // ══════════════════════════════════════════════════════════════════

  _acts: { page: 1, perPage: 20, items: [], meta: null, editingId: null },

  renderUserActivities(host) {
    const canWrite = AdminTopochain.canWrite();
    host.innerHTML = `
      ${AdminTopochain._screenHeader({
    title: 'User activities',
    subtitle: 'Everything users have recorded against a challenge, and the points it scored.',
    actions: `${canWrite ? `<button id="admin-topo-act-new" type="button" class="${BTN.primarySm}">New activity</button>` : ''}
          ${canWrite ? `<button id="admin-topo-act-import" type="button" class="${BTN.secondarySm}">Import JSON&hellip;</button>` : ''}
          <button id="admin-topo-act-totals" type="button" class="${BTN.secondarySm}">Totals&hellip;</button>`,
  })}
      <div id="admin-topo-act-form"></div>
      <div id="admin-topo-act-table">${AdminTopochain._skeleton(4)}</div>`;
    document.getElementById('admin-topo-act-new')?.addEventListener('click', () => AdminTopochain._openActivityForm(null));
    document.getElementById('admin-topo-act-import')?.addEventListener('click', () => AdminTopochain._openActivityImportForm());
    document.getElementById('admin-topo-act-totals').addEventListener('click', () => AdminTopochain._openActivityTotals());
    AdminTopochain._loadActivities();
  },

  async _loadActivities() {
    const s = AdminTopochain._acts;
    const params = new URLSearchParams({ page: String(s.page), per_page: String(s.perPage) });
    const { ok, data, status } = await AdminTopochain.fetchJson(`/api/v4/admin/user-activities?${params}`);
    if (AdminTopochain._sub !== 'user-activities') return;
    if (ok && data?.success) { s.items = data.data; s.meta = data.meta; s.error = null; }
    else { s.items = []; s.meta = null; s.error = { status, message: (data && data.error) || null }; }
    AdminTopochain._renderActivitiesTable();
  },

  _renderActivitiesTable() {
    const table = document.getElementById('admin-topo-act-table');
    if (!table) return;
    const esc = AdminTopochain.esc;
    const canWrite = AdminTopochain.canWrite();
    const s = AdminTopochain._acts;
    if (s.error) {
      table.innerHTML = AdminTopochain._error({
        title: "Couldn't load user activities", status: s.error.status,
        message: s.error.message, retryId: 'admin-topo-act-retry',
      });
      AdminTopochain._wireRetry('admin-topo-act-retry', () => AdminTopochain._loadActivities());
      return;
    }
    if (!s.items.length) {
      table.innerHTML = AdminTopochain._empty({
        title: 'No activities yet',
        body: 'Activities are recorded when users complete challenges — you can also add one by hand.',
        actionId: 'admin-topo-act-empty-new',
        actionLabel: 'New activity',
      });
      document.getElementById('admin-topo-act-empty-new')
        ?.addEventListener('click', () => AdminTopochain._openActivityForm(null));
      return;
    }
    table.innerHTML = AdminTopochain._list({
      items: s.items,
      columns: [
        { label: 'User', primary: true, cell: (a) => esc(a.user?.display_name || a.user?.email || a.user_id) },
        { label: 'Event', cell: (a) => esc(a.event?.name || a.season_event_id), tdClass: 'text-xs text-zinc-500' },
        { label: 'Challenge', cell: (a) => esc(a.challenge?.goal || '—'), tdClass: 'text-xs text-zinc-500' },
        { label: 'Type', cell: (a) => esc(a.activity_type), tdClass: 'text-xs' },
        { label: 'Points', cell: (a) => esc(a.points), tdClass: 'font-mono text-right', thClass: 'text-right' },
        { label: 'At', cell: (a) => esc(AdminTopochain._fmt(a.activity_at)), tdClass: 'text-xs text-zinc-500' },
      ],
      actions: (a) => `
        ${canWrite ? `<button data-edit-act="${a.id}" type="button" class="${BTN.row}">Edit</button>` : ''}
        ${canWrite ? `<button data-delete-act="${a.id}" type="button" class="${BTN.rowDanger}">Delete</button>` : ''}`,
    }) + AdminTopochain._pagerHtml(s.meta, 'admin-topo-act-pg');
    table.querySelectorAll('[data-edit-act]').forEach((b) => b.addEventListener('click', () => AdminTopochain._openActivityForm(parseInt(b.dataset.editAct, 10))));
    table.querySelectorAll('[data-delete-act]').forEach((b) => b.addEventListener('click', () => AdminTopochain._deleteActivity(b.dataset.deleteAct)));
    if (s.meta) AdminTopochain._wirePager(s.meta, 'admin-topo-act-pg', (page) => { s.page = page; AdminTopochain._loadActivities(); });
  },

  async _deleteActivity(id) {
    if (!AdminTopochain.canWrite()) return;
    const ok = await AdminTopochain._confirm({ title: 'Delete this activity?', confirmLabel: 'Delete', danger: true, message: 'This cannot be undone.' });
    if (!ok) return;
    const res = await AdminTopochain.send('DELETE', `/api/v4/admin/user-activities/${encodeURIComponent(id)}`);
    if (res.ok && res.data?.success) AdminTopochain._loadActivities();
    else AdminTopochain._alert((res.data && res.data.error) || 'Delete failed.');
  },

  async _openActivityForm(id) {
    if (!AdminTopochain.canWrite()) return;
    AdminTopochain._acts.editingId = id;
    let a = null;
    if (id != null) {
      const { ok, data } = await AdminTopochain.fetchJson(`/api/v4/admin/user-activities/${encodeURIComponent(id)}`);
      if (ok && data?.success) a = data.data;
    }
    const events = await AdminTopochain._fetchAllEvents();
    const f = AdminTopochain._inputHtml, sel = AdminTopochain._selectHtml, field = AdminTopochain._field;
    const host = document.getElementById('admin-topo-act-form');
    host.innerHTML = AdminTopochain._panel({
      title: id == null ? 'New activity' : `Edit activity #${AdminTopochain.esc(id)}`,
      subtitle: 'Who did what, in which event, and what it scored.',
      closeId: 'admin-topo-act-close',
      closeLabel: 'Close the activity form',
      body: `
        ${AdminTopochain._formGrid(`
          ${field('User id *', f('admin-topo-act-f-user_id', { type: 'number', min: 1, value: a?.user_id }))}
          ${field('Event *', sel('admin-topo-act-f-event', AdminTopochain._eventOptions(events), a?.season_event_id, { blank: 'Choose an event…' }))}
          ${field('Challenge (loads after picking an event) *', sel('admin-topo-act-f-challenge', [], a?.challenge_id, { blank: 'Choose an event first…' }))}
          ${field('Points *', f('admin-topo-act-f-points', { type: 'number', step: '0.01', value: a?.points }))}
          ${field('Activity at *', f('admin-topo-act-f-activity_at', { type: 'datetime-local', value: AdminTopochain._isoToLocalInput(a?.activity_at) }))}
        `)}
        <div class="grid grid-cols-1 gap-4 mt-4">
          ${field('Description', AdminTopochain._textareaHtml('admin-topo-act-f-description', a?.description || '', 3))}
          ${field('Metadata (JSON, optional)', AdminTopochain._textareaHtml('admin-topo-act-f-metadata', a?.metadata ? JSON.stringify(a.metadata) : '', 3),
    'activity_type is derived automatically from the selected challenge’s template category (the API overrides whatever is submitted).')}
        </div>
        ${AdminTopochain._formErrorSlot('admin-topo-act-form-err')}`,
      footer: AdminTopochain._formActions('admin-topo-act-save', 'admin-topo-act-cancel', 'Save activity'),
    });
    const loadChallengeOptions = async (eventId, selectedChallengeId) => {
      const chSel = document.getElementById('admin-topo-act-f-challenge');
      if (!eventId) { chSel.innerHTML = ''; return; }
      const { ok, data } = await AdminTopochain.fetchJson(`/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges`);
      const esc = AdminTopochain.esc;
      const items = (ok && data?.success) ? data.data : [];
      chSel.innerHTML = items.map((c) => `<option value="${c.id}" data-category="${esc(c.activity_type?.category || '')}" ${String(c.id) === String(selectedChallengeId) ? 'selected' : ''}>${esc(c.card_preview?.goal || `challenge #${c.id}`)}</option>`).join('');
    };
    document.getElementById('admin-topo-act-f-event').addEventListener('change', (e) => loadChallengeOptions(e.target.value, null));
    if (a?.season_event_id) await loadChallengeOptions(a.season_event_id, a.challenge_id);
    const closeForm = () => { host.innerHTML = ''; AdminTopochain._acts.editingId = null; };
    document.getElementById('admin-topo-act-save').addEventListener('click', () => AdminTopochain._saveActivity());
    document.getElementById('admin-topo-act-cancel').addEventListener('click', closeForm);
    document.getElementById('admin-topo-act-close').addEventListener('click', closeForm);
  },

  async _saveActivity() {
    if (!AdminTopochain.canWrite()) return;
    const errEl = document.getElementById('admin-topo-act-form-err');
    errEl.classList.add('hidden');
    const val = (id) => document.getElementById(id)?.value ?? '';
    const chSel = document.getElementById('admin-topo-act-f-challenge');
    const chOpt = chSel?.selectedOptions[0];
    if (!chOpt) { errEl.textContent = 'Choose an event and a challenge.'; errEl.classList.remove('hidden'); return; }
    let metadata;
    const rawMeta = val('admin-topo-act-f-metadata').trim();
    if (rawMeta) {
      try { metadata = JSON.parse(rawMeta); } catch { errEl.textContent = 'Metadata must be valid JSON.'; errEl.classList.remove('hidden'); return; }
    } else {
      metadata = null;
    }
    const body = {
      user_id: Number(val('admin-topo-act-f-user_id')),
      season_event_id: Number(val('admin-topo-act-f-event')),
      challenge_id: Number(chOpt.value),
      activity_type: chOpt.dataset.category || 'community_contribution',
      points: Number(val('admin-topo-act-f-points')),
      activity_at: AdminTopochain._localInputToIso(val('admin-topo-act-f-activity_at')),
      description: val('admin-topo-act-f-description').trim() || null,
      metadata,
    };
    const id = AdminTopochain._acts.editingId;
    const url = id == null ? '/api/v4/admin/user-activities' : `/api/v4/admin/user-activities/${encodeURIComponent(id)}`;
    const { ok, data } = await AdminTopochain.send(id == null ? 'POST' : 'PUT', url, body);
    if (!ok || !data?.success) {
      errEl.textContent = (data && data.error) || 'Save failed.';
      errEl.classList.remove('hidden');
      return;
    }
    document.getElementById('admin-topo-act-form').innerHTML = '';
    AdminTopochain._acts.editingId = null;
    AdminTopochain._loadActivities();
  },

  async _openActivityImportForm() {
    if (!AdminTopochain.canWrite()) return;
    const host = document.getElementById('admin-topo-act-form');
    host.innerHTML = AdminTopochain._panel({
      title: 'Import activities',
      subtitle: 'Paste a JSON array of activity rows.',
      closeId: 'admin-topo-act-imp-close',
      closeLabel: 'Close the import panel',
      body: `
        ${AdminTopochain._field('activities JSON *', AdminTopochain._textareaHtml('admin-topo-act-imp-json',
    '[\n  {"user_id":1,"season_event_id":1,"challenge_id":1,"activity_type":"community_contribution","points":10,"activity_at":"2026-01-01T00:00:00.000Z"}\n]', 8))}
        ${AdminTopochain._formErrorSlot('admin-topo-act-imp-err')}
        <div id="admin-topo-act-imp-result" class="mt-3 text-xs text-zinc-500"></div>`,
      footer: `<button id="admin-topo-act-imp-go" type="button" class="${BTN.primary}">Import</button>
        <button id="admin-topo-act-imp-cancel" type="button" class="${BTN.secondary}">Cancel</button>`,
    });
    const closeForm = () => { host.innerHTML = ''; };
    document.getElementById('admin-topo-act-imp-go').addEventListener('click', () => AdminTopochain._runActivityImport());
    document.getElementById('admin-topo-act-imp-cancel').addEventListener('click', closeForm);
    document.getElementById('admin-topo-act-imp-close').addEventListener('click', closeForm);
  },

  async _runActivityImport() {
    if (!AdminTopochain.canWrite()) return;
    const errEl = document.getElementById('admin-topo-act-imp-err');
    errEl.classList.add('hidden');
    let activities;
    try {
      activities = JSON.parse(document.getElementById('admin-topo-act-imp-json').value);
      if (!Array.isArray(activities) || !activities.length) throw new Error('empty');
    } catch {
      errEl.textContent = 'Paste a valid, non-empty JSON array of activity rows.';
      errEl.classList.remove('hidden');
      return;
    }
    const { ok, data } = await AdminTopochain.send('POST', '/api/v4/admin/user-activities/import', { activities });
    if (!ok || !data?.success) {
      errEl.textContent = (data && data.error) || 'Import failed.';
      errEl.classList.remove('hidden');
      return;
    }
    const esc = AdminTopochain.esc;
    document.getElementById('admin-topo-act-imp-result').innerHTML =
      `Imported ${esc(data.data.imported_count)}.${data.data.errors.length ? `<br>${data.data.errors.map((e) => esc(e)).join('<br>')}` : ''}`;
    AdminTopochain._loadActivities();
  },

  async _openActivityTotals() {
    const events = await AdminTopochain._fetchAllEvents();
    const sel = AdminTopochain._selectHtml, field = AdminTopochain._field, esc = AdminTopochain.esc;
    const host = document.getElementById('admin-topo-act-form');
    host.innerHTML = AdminTopochain._panel({
      title: 'Activity totals',
      subtitle: 'Points and counts, by user and by type.',
      closeId: 'admin-topo-act-tot-close',
      closeLabel: 'Close the totals panel',
      body: `
        <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
          <div class="sm:w-64">${field('Event', sel('admin-topo-act-tot-event', AdminTopochain._eventOptions(events), '', { blank: 'All events' }))}</div>
          ${AdminTopochain.canWrite() ? `<button id="admin-topo-act-tot-refresh" type="button" class="${BTN.secondarySm}">Refresh totals (ended events)</button>` : ''}
        </div>
        <div id="admin-topo-act-tot-body" class="mt-4">${AdminTopochain._skeleton(4)}</div>`,
    });
    const loadTotals = async () => {
      const eventId = document.getElementById('admin-topo-act-tot-event').value;
      const params = eventId ? `?season_event_id=${encodeURIComponent(eventId)}` : '';
      const { ok, data, status } = await AdminTopochain.fetchJson(`/api/v4/admin/user-activities/totals${params}`);
      const body = document.getElementById('admin-topo-act-tot-body');
      if (!body) return;
      if (!ok || !data?.success) {
        body.innerHTML = AdminTopochain._error({
          title: "Couldn't load totals", status, message: (data && data.error) || null,
          retryId: 'admin-topo-act-tot-retry',
        });
        AdminTopochain._wireRetry('admin-topo-act-tot-retry', loadTotals);
        return;
      }
      const d = data.data;
      const userRows = d.user_totals.slice(0, 50).map((t) => `
        <tr class="border-t border-zinc-200 dark:border-zinc-800">
          <td class="px-2 py-1 text-xs">${esc(t.user.display_name || t.user.email || t.user.id)}</td>
          <td class="px-2 py-1 text-xs font-mono text-right">${esc(t.total_points)}</td>
          <td class="px-2 py-1 text-xs font-mono text-right">${esc(t.total_activities)}</td>
        </tr>`).join('');
      const typeRows = d.type_totals.map((t) => `
        <tr class="border-t border-zinc-200 dark:border-zinc-800">
          <td class="px-2 py-1 text-xs">${esc(t.activity_type)}</td>
          <td class="px-2 py-1 text-xs font-mono text-right">${esc(t.count)}</td>
          <td class="px-2 py-1 text-xs font-mono text-right">${esc(t.total_points)}</td>
          <td class="px-2 py-1 text-xs font-mono text-right">${esc(t.unique_users)}</td>
        </tr>`).join('');
      const stat = (label, value) => `<div class="rounded-lg bg-zinc-50 dark:bg-zinc-800/60 px-3 py-2">
          <dt class="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">${esc(label)}</dt>
          <dd class="mt-0.5 text-sm font-medium font-mono">${esc(value)}</dd>
        </div>`;
      body.innerHTML = `
        <dl class="grid grid-cols-3 gap-2">
          ${stat('Points', d.grand_total.total_points)}
          ${stat('Activities', d.grand_total.total_activities)}
          ${stat('Users', d.grand_total.unique_users)}
        </dl>
        <div class="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
          <div class="min-w-0 overflow-x-auto">
            <div class="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-1">By user (top 50)</div>
            <table class="w-full"><thead class="text-xs text-zinc-500"><tr><th class="text-left px-2">User</th><th class="text-right px-2">Points</th><th class="text-right px-2">Count</th></tr></thead><tbody>${userRows}</tbody></table></div>
          <div class="min-w-0 overflow-x-auto">
            <div class="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-1">By type</div>
            <table class="w-full"><thead class="text-xs text-zinc-500"><tr><th class="text-left px-2">Type</th><th class="text-right px-2">Count</th><th class="text-right px-2">Points</th><th class="text-right px-2">Users</th></tr></thead><tbody>${typeRows}</tbody></table></div>
        </div>`;
    };
    document.getElementById('admin-topo-act-tot-event').addEventListener('change', loadTotals);
    document.getElementById('admin-topo-act-tot-close').addEventListener('click', () => { host.innerHTML = ''; });
    document.getElementById('admin-topo-act-tot-refresh')?.addEventListener('click', async () => {
      if (!AdminTopochain.canWrite()) return;
      const eventId = document.getElementById('admin-topo-act-tot-event').value;
      if (!eventId) { AdminTopochain._alert('Choose a specific event to refresh (only available for ended events).'); return; }
      const { ok, data } = await AdminTopochain.send('POST', '/api/v4/admin/user-activities/refresh-totals', { season_event_id: parseInt(eventId, 10) });
      if (ok && data?.success) { AdminTopochain._alert(data.message || 'Refreshed.'); loadTotals(); }
      else AdminTopochain._alert((data && data.error) || 'Refresh failed.');
    });
    loadTotals();
  },

  // ══════════════════════════════════════════════════════════════════
  // Challenge templates — full CRUD + /categories.
  // ══════════════════════════════════════════════════════════════════

  _tmpl: { page: 1, perPage: 20, search: '', category: '', items: [], meta: null, editingId: null },

  async renderChallengeTemplates(host) {
    const canWrite = AdminTopochain.canWrite();
    const esc = AdminTopochain.esc;
    const { ok, data } = await AdminTopochain.fetchJson('/api/v4/admin/challenge-templates/categories');
    const categories = (ok && data?.success) ? data.data : [];
    host.innerHTML = `
      ${AdminTopochain._screenHeader({
    title: 'Challenge templates',
    subtitle: 'The reusable library that event challenges are stamped out of.',
    actions: `<input id="admin-topo-tpl-search" type="text" placeholder="Search&hellip;" value="${esc(AdminTopochain._tmpl.search)}"
            aria-label="Search challenge templates" class="${FIELD_CLS} sm:w-48">
          <div class="w-full sm:w-48">${AdminTopochain._selectHtml('admin-topo-tpl-category', categories, AdminTopochain._tmpl.category, { blank: 'All categories' })}</div>
          ${canWrite ? `<button id="admin-topo-tpl-new" type="button" class="${BTN.primarySm}">New template</button>` : ''}`,
  })}
      <div id="admin-topo-tpl-form"></div>
      <div id="admin-topo-tpl-table">${AdminTopochain._skeleton(4)}</div>`;
    document.getElementById('admin-topo-tpl-search').addEventListener('change', (e) => {
      AdminTopochain._tmpl.search = e.target.value.trim();
      AdminTopochain._tmpl.page = 1;
      AdminTopochain._loadTemplates();
    });
    document.getElementById('admin-topo-tpl-category').addEventListener('change', (e) => {
      AdminTopochain._tmpl.category = e.target.value;
      AdminTopochain._tmpl.page = 1;
      AdminTopochain._loadTemplates();
    });
    document.getElementById('admin-topo-tpl-new')?.addEventListener('click', () => AdminTopochain._openTemplateForm(null));
    AdminTopochain._loadTemplates();
  },

  async _loadTemplates() {
    const s = AdminTopochain._tmpl;
    const params = new URLSearchParams({ page: String(s.page), per_page: String(s.perPage) });
    if (s.search) params.set('search', s.search);
    if (s.category) params.set('category', s.category);
    const { ok, data, status } = await AdminTopochain.fetchJson(`/api/v4/admin/challenge-templates?${params}`);
    if (AdminTopochain._sub !== 'challenge-templates') return;
    if (ok && data?.success) { s.items = data.data; s.meta = data.meta; s.error = null; }
    else { s.items = []; s.meta = null; s.error = { status, message: (data && data.error) || null }; }
    AdminTopochain._renderTemplatesTable();
  },

  _renderTemplatesTable() {
    const table = document.getElementById('admin-topo-tpl-table');
    if (!table) return;
    const esc = AdminTopochain.esc;
    const canWrite = AdminTopochain.canWrite();
    const s = AdminTopochain._tmpl;
    if (s.error) {
      table.innerHTML = AdminTopochain._error({
        title: "Couldn't load challenge templates", status: s.error.status,
        message: s.error.message, retryId: 'admin-topo-tpl-retry',
      });
      AdminTopochain._wireRetry('admin-topo-tpl-retry', () => AdminTopochain._loadTemplates());
      return;
    }
    if (!s.items.length) {
      table.innerHTML = AdminTopochain._empty({
        title: 'No challenge templates yet',
        body: 'Templates are the reusable library challenges are stamped out of.',
        actionId: 'admin-topo-tpl-empty-new',
        actionLabel: 'New template',
      });
      document.getElementById('admin-topo-tpl-empty-new')
        ?.addEventListener('click', () => AdminTopochain._openTemplateForm(null));
      return;
    }
    table.innerHTML = AdminTopochain._list({
      items: s.items,
      columns: [
        { label: 'Goal', primary: true, cell: (t) => esc(t.goal) },
        { label: 'Category', cell: (t) => esc(t.category), tdClass: 'text-xs text-zinc-500' },
        { label: 'Reward', cell: (t) => esc(t.reward), tdClass: 'text-zinc-500' },
        { label: 'Kind', cell: (t) => esc(t.kind || '—'), tdClass: 'text-xs text-zinc-500' },
      ],
      actions: (t) => `
        ${canWrite ? `<button data-edit-tpl="${t.id}" type="button" class="${BTN.row}">Edit</button>` : ''}
        ${canWrite ? `<button data-delete-tpl="${t.id}" type="button" class="${BTN.rowDanger}">Delete</button>` : ''}`,
    }) + AdminTopochain._pagerHtml(s.meta, 'admin-topo-tpl-pg');
    table.querySelectorAll('[data-edit-tpl]').forEach((b) => b.addEventListener('click', () => AdminTopochain._openTemplateForm(parseInt(b.dataset.editTpl, 10))));
    table.querySelectorAll('[data-delete-tpl]').forEach((b) => b.addEventListener('click', () => AdminTopochain._deleteTemplate(b.dataset.deleteTpl)));
    if (s.meta) AdminTopochain._wirePager(s.meta, 'admin-topo-tpl-pg', (page) => { s.page = page; AdminTopochain._loadTemplates(); });
  },

  async _deleteTemplate(id) {
    if (!AdminTopochain.canWrite()) return;
    const ok = await AdminTopochain._confirm({ title: 'Delete this challenge template?', confirmLabel: 'Delete', danger: true, message: 'Fails if any challenge still references it.' });
    if (!ok) return;
    const res = await AdminTopochain.send('DELETE', `/api/v4/admin/challenge-templates/${encodeURIComponent(id)}`);
    if (res.ok && res.data?.success) AdminTopochain._loadTemplates();
    else AdminTopochain._alert((res.data && res.data.error) || 'Delete failed.');
  },

  async _openTemplateForm(id) {
    if (!AdminTopochain.canWrite()) return;
    AdminTopochain._tmpl.editingId = id;
    let t = null;
    if (id != null) {
      const { ok, data } = await AdminTopochain.fetchJson(`/api/v4/admin/challenge-templates/${encodeURIComponent(id)}`);
      if (ok && data?.success) t = data.data;
    }
    const f = AdminTopochain._inputHtml, sel = AdminTopochain._selectHtml, field = AdminTopochain._field;
    const ctaOptions = ['', 'url', 'app'].map((v) => ({ value: v, label: v || '(none)' }));
    const host = document.getElementById('admin-topo-tpl-form');
    const section = (label) => `<p class="mt-5 mb-3 border-t border-zinc-200 dark:border-zinc-800 pt-4 text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">${AdminTopochain.esc(label)}</p>`;
    host.innerHTML = AdminTopochain._panel({
      title: id == null ? 'New challenge template' : `Edit template #${AdminTopochain.esc(id)}`,
      subtitle: 'What the challenge asks for, what it rewards, and how it is presented.',
      closeId: 'admin-topo-tpl-close',
      closeLabel: 'Close the template form',
      body: `
        ${AdminTopochain._formGrid(`
          ${field('Category *', f('admin-topo-tpl-f-category', { value: t?.category }))}
          ${field('Goal *', f('admin-topo-tpl-f-goal', { value: t?.goal }))}
          ${field('Reward *', f('admin-topo-tpl-f-reward', { value: t?.reward }))}
          ${field('Kind', f('admin-topo-tpl-f-kind', { value: t?.kind }), 'No admin listing endpoint exists for Kinds (documented gap) — must match an existing challenge_kinds id.')}
          ${field('Schedule start', f('admin-topo-tpl-f-schedule_start', { type: 'datetime-local', value: AdminTopochain._isoToLocalInput(t?.schedule_start) }))}
          ${field('Schedule end', f('admin-topo-tpl-f-schedule_end', { type: 'datetime-local', value: AdminTopochain._isoToLocalInput(t?.schedule_end) }))}
        `)}
        ${section('Call to action')}
        ${AdminTopochain._formGrid(`
          ${field('CTA button label', f('admin-topo-tpl-f-cta_button', { value: t?.cta_button }))}
          ${field('CTA label', f('admin-topo-tpl-f-cta_label', { value: t?.cta_label }))}
          ${field('CTA type', sel('admin-topo-tpl-f-cta_type', ctaOptions, t?.cta_type || ''))}
          ${field('CTA link', f('admin-topo-tpl-f-cta_link', { value: t?.cta_link }))}
          ${field('Mobile CTA label', f('admin-topo-tpl-f-mobile_cta_label', { value: t?.mobile_cta_label }))}
          ${field('Mobile CTA type', sel('admin-topo-tpl-f-mobile_cta_type', ctaOptions, t?.mobile_cta_type || ''))}
          ${field('Mobile CTA link', f('admin-topo-tpl-f-mobile_cta_link', { value: t?.mobile_cta_link }))}
        `)}
        ${section('Metric')}
        ${AdminTopochain._formGrid(`
          ${field('Metric type', f('admin-topo-tpl-f-metric_type', { value: t?.metric_type }))}
          ${field('Metric label', f('admin-topo-tpl-f-metric_label', { value: t?.metric_label }))}
          ${field('Metric target', f('admin-topo-tpl-f-metric_target', { type: 'number', step: '0.01', value: t?.metric_target }))}
        `, 3)}
        ${section('Copy')}
        <div class="grid grid-cols-1 gap-4">
          ${field('Task *', AdminTopochain._textareaHtml('admin-topo-tpl-f-task', t?.task || '', 3))}
          ${field('Description', AdminTopochain._textareaHtml('admin-topo-tpl-f-description', t?.description || '', 3))}
          ${field('Requirements', AdminTopochain._textareaHtml('admin-topo-tpl-f-requirements', t?.requirements || '', 3))}
          ${field('Reward logic', AdminTopochain._textareaHtml('admin-topo-tpl-f-reward_logic', t?.reward_logic || '', 3))}
        </div>
        ${AdminTopochain._formErrorSlot('admin-topo-tpl-form-err')}`,
      footer: AdminTopochain._formActions('admin-topo-tpl-save', 'admin-topo-tpl-cancel', 'Save template'),
    });
    const closeForm = () => { host.innerHTML = ''; AdminTopochain._tmpl.editingId = null; };
    document.getElementById('admin-topo-tpl-save').addEventListener('click', () => AdminTopochain._saveTemplate());
    document.getElementById('admin-topo-tpl-cancel').addEventListener('click', closeForm);
    document.getElementById('admin-topo-tpl-close').addEventListener('click', closeForm);
  },

  async _saveTemplate() {
    if (!AdminTopochain.canWrite()) return;
    const errEl = document.getElementById('admin-topo-tpl-form-err');
    errEl.classList.add('hidden');
    const val = (id) => (document.getElementById(id)?.value ?? '').trim();
    const numOrNull = (id) => { const v = val(id); return v === '' ? null : Number(v); };
    const body = {
      category: val('admin-topo-tpl-f-category'),
      goal: val('admin-topo-tpl-f-goal'),
      task: val('admin-topo-tpl-f-task'),
      reward: val('admin-topo-tpl-f-reward'),
      kind: val('admin-topo-tpl-f-kind') || null,
      description: val('admin-topo-tpl-f-description') || null,
      requirements: val('admin-topo-tpl-f-requirements') || null,
      reward_logic: val('admin-topo-tpl-f-reward_logic') || null,
      schedule_start: AdminTopochain._localInputToIso(val('admin-topo-tpl-f-schedule_start')),
      schedule_end: AdminTopochain._localInputToIso(val('admin-topo-tpl-f-schedule_end')),
      cta_button: val('admin-topo-tpl-f-cta_button') || null,
      cta_label: val('admin-topo-tpl-f-cta_label') || null,
      cta_type: val('admin-topo-tpl-f-cta_type') || null,
      cta_link: val('admin-topo-tpl-f-cta_link') || null,
      mobile_cta_label: val('admin-topo-tpl-f-mobile_cta_label') || null,
      mobile_cta_type: val('admin-topo-tpl-f-mobile_cta_type') || null,
      mobile_cta_link: val('admin-topo-tpl-f-mobile_cta_link') || null,
      metric_type: val('admin-topo-tpl-f-metric_type') || null,
      metric_label: val('admin-topo-tpl-f-metric_label') || null,
      metric_target: numOrNull('admin-topo-tpl-f-metric_target'),
    };
    if (!body.category || !body.goal || !body.task || !body.reward) {
      errEl.textContent = 'Category, goal, task and reward are required.';
      errEl.classList.remove('hidden');
      return;
    }
    const id = AdminTopochain._tmpl.editingId;
    const url = id == null ? '/api/v4/admin/challenge-templates' : `/api/v4/admin/challenge-templates/${encodeURIComponent(id)}`;
    const { ok, data } = await AdminTopochain.send(id == null ? 'POST' : 'PUT', url, body);
    if (!ok || !data?.success) {
      errEl.textContent = (data && data.error) || 'Save failed.';
      errEl.classList.remove('hidden');
      return;
    }
    document.getElementById('admin-topo-tpl-form').innerHTML = '';
    AdminTopochain._tmpl.editingId = null;
    AdminTopochain._loadTemplates();
  },

  // ══════════════════════════════════════════════════════════════════
  // Settings — full CRUD + /reset (needs {confirm:true}). Keyed by
  // `key` (topochain_* only), not a numeric id.
  // ══════════════════════════════════════════════════════════════════

  _settings: { items: [], editingKey: null, isNew: false },

  renderSettings(host) {
    const canWrite = AdminTopochain.canWrite();
    host.innerHTML = `
      ${AdminTopochain._screenHeader({
    title: 'Settings',
    subtitle: 'Numeric knobs read by the mobile app, plus outbound-mail readiness.',
    actions: `
          ${canWrite ? `<button id="admin-topo-set-new" type="button" class="${BTN.primarySm}">New setting</button>` : ''}
          ${canWrite ? `<button id="admin-topo-set-reset" type="button" class="${BTN.warnSm}">Reset to defaults&hellip;</button>` : ''}`,
  })}
      <div id="admin-topo-mail-status" class="mb-4"></div>
      <div id="admin-topo-mail-activity" class="mb-4"></div>
      <div id="admin-topo-set-form"></div>
      <div id="admin-topo-set-table">${AdminTopochain._skeleton(4)}</div>`;
    document.getElementById('admin-topo-set-new')?.addEventListener('click', () => AdminTopochain._openSettingForm(null));
    document.getElementById('admin-topo-set-reset')?.addEventListener('click', () => AdminTopochain._resetSettings());
    AdminTopochain._loadSettings();
    AdminTopochain._loadMailStatus();
    AdminTopochain._loadMailActivity();
  },

  // Outbound-mail readiness. Read-only and deliberately value-free: the
  // endpoint returns presence only, never the provider URL or credential.
  // This row exists because both mail flows are always-200 by contract, so
  // "no transport configured" is otherwise completely invisible.
  async _loadMailStatus() {
    const { ok, data } = await AdminTopochain.fetchJson('/api/v4/admin/settings/mail-status');
    if (AdminTopochain._sub !== 'settings') return;
    const host = document.getElementById('admin-topo-mail-status');
    if (!host) return;
    const esc = AdminTopochain.esc;
    if (!ok || !data?.success) { host.innerHTML = ''; return; }

    const m = data.data || {};
    const flows = (m.affectedFlows || []).map((f) => `<li>${esc(f)}</li>`).join('');
    // The sender address is safe to render — it is in the From header of
    // every mail the platform sends. No key or endpoint is ever returned.
    const sender = `
      <div class="text-zinc-500 mt-1">
        Sending as <code class="font-mono text-xs">${esc(m.from || '(unset)')}</code>${
  m.usingDefaultFrom ? ' <span class="text-zinc-400">(built-in default)</span>' : ''}
      </div>`;

    // A staging preview is a clone of production data, so it can never
    // reach a real provider — say so plainly rather than letting a tester
    // read a card and wait for an inbox that will never fill.
    if (m.stagingLogOnly) {
      host.innerHTML = `
        <div class="rounded-xl border border-sky-300 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 px-4 py-3 text-sm sm:px-5">
          <div class="font-semibold text-sky-800 dark:text-sky-300">
            Staging preview — email is rendered to the log, never delivered
          </div>
          <p class="text-sky-800/80 dark:text-sky-300/80 mt-1">
            This preview holds a clone of production data, so it must not mail real
            people. Login codes and links appear in the platform log
            (<code class="font-mono text-xs">platform-mail</code>) so you can complete
            a flow by hand.
          </p>
          ${sender}
        </div>`;
      return;
    }

    if (m.configured) {
      host.innerHTML = `
        <div class="${PANEL_CLS} px-4 py-3 text-sm sm:px-5">
          <span class="font-semibold text-emerald-600 dark:text-emerald-400">Email is configured</span>
          <span class="text-zinc-500"> — login codes and waitlist confirmations are being sent
            via <span class="font-medium">${esc(m.provider || 'unknown')}</span>.</span>
          ${sender}
        </div>`;
      return;
    }

    // Per-provider readiness, so the card says which provider needs what
    // instead of a flat "mail is broken".
    const providers = (m.providers || []).map((p) => `
      <li>
        ${esc(p.label || p.name)} —
        ${p.configured
    ? '<span class="text-emerald-700 dark:text-emerald-400">ready</span>'
    : `needs ${(p.missing || []).map((k) => `<code class="font-mono text-xs">${esc(k)}</code>`).join(', ')}`}
      </li>`).join('');

    host.innerHTML = `
      <div class="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm sm:px-5">
        <div class="font-semibold text-amber-800 dark:text-amber-300">
          Email is not deliverable — no mail sender configured
        </div>
        <p class="text-amber-800/80 dark:text-amber-300/80 mt-1">
          These flows still report success to the user but deliver nothing:
        </p>
        <ul class="list-disc ml-5 mt-1 text-amber-800/80 dark:text-amber-300/80">${flows}</ul>
        <p class="text-amber-800/80 dark:text-amber-300/80 mt-2">Providers:</p>
        <ul class="list-disc ml-5 mt-1 text-amber-800/80 dark:text-amber-300/80">${providers}</ul>
        <p class="text-amber-800/80 dark:text-amber-300/80 mt-2">
          Set ${(m.missing || []).map((k) => `<code class="font-mono text-xs">${esc(k)}</code>`).join(', ')}
          in the platform&rsquo;s Platform variables panel, then redeploy. The mailbox
          behind those credentials must also be authorised to send as
          <code class="font-mono text-xs">${esc(m.from || '')}</code>.
        </p>
      </div>`;
  },

  // Colour per delivery status. `sent` is the only unambiguously good
  // outcome; `suppressed_rate_limit` is the throttle working, not a fault,
  // so it reads as informational rather than red.
  _mailStatusClass(status) {
    if (status === 'sent') return 'text-emerald-700 dark:text-emerald-400';
    if (status === 'failed') return 'text-rose-700 dark:text-rose-400';
    if (status === 'suppressed_rate_limit') return 'text-amber-700 dark:text-amber-400';
    if (status === 'no_transport') return 'text-amber-700 dark:text-amber-400';
    return 'text-zinc-500';
  },

  // Recent email activity. The ONLY place a delivery failure is visible:
  // every endpoint that triggers mail is always-200 by contract, so it
  // cannot tell the waiting user their code never went out.
  async _loadMailActivity() {
    const { ok, data } = await AdminTopochain.fetchJson('/api/v4/admin/settings/mail-activity');
    if (AdminTopochain._sub !== 'settings') return;
    const host = document.getElementById('admin-topo-mail-activity');
    if (!host) return;
    const esc = AdminTopochain.esc;
    if (!ok || !data?.success) { host.innerHTML = ''; return; }

    const recent = (data.data && data.data.recent) || [];
    const last24h = (data.data && data.data.last24h) || {};
    const totals = Object.keys(last24h).sort()
      .map((k) => `${esc(k)} ${last24h[k]}`).join(' · ');

    const rows = recent.map((r) => `
      <tr class="border-t border-zinc-100 dark:border-zinc-800">
        <td class="py-1.5 pr-3 whitespace-nowrap text-zinc-500">${esc(
    r.created_at ? String(r.created_at).replace('T', ' ').slice(0, 19) : '')}</td>
        <td class="py-1.5 pr-3 whitespace-nowrap">${esc(r.kind || '')}</td>
        <td class="py-1.5 pr-3">${esc(r.recipient || '')}</td>
        <td class="py-1.5 pr-3 whitespace-nowrap text-zinc-500">${esc(r.provider || '—')}</td>
        <td class="py-1.5 pr-3 whitespace-nowrap font-medium ${
  AdminTopochain._mailStatusClass(r.status)}">${esc(r.status || '')}</td>
        <td class="py-1.5 text-zinc-500">${esc(r.error || '')}</td>
      </tr>`).join('');

    host.innerHTML = `
      <div class="${PANEL_CLS} px-4 py-3 sm:px-5">
        <div class="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-2">
          <h3 class="text-sm font-semibold">Recent email activity</h3>
          <span class="text-xs text-zinc-500">${totals ? `last 24h: ${totals}` : 'nothing in the last 24h'}</span>
        </div>
        ${recent.length ? `
        <div class="overflow-x-auto mt-3 -mx-4 px-4 sm:mx-0 sm:px-0">
          <table class="w-full text-xs">
            <thead class="text-zinc-500">
              <tr>
                <th class="text-left font-medium pb-1 pr-3">When</th>
                <th class="text-left font-medium pb-1 pr-3">Kind</th>
                <th class="text-left font-medium pb-1 pr-3">Recipient</th>
                <th class="text-left font-medium pb-1 pr-3">Provider</th>
                <th class="text-left font-medium pb-1 pr-3">Status</th>
                <th class="text-left font-medium pb-1">Detail</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`
    : '<p class="text-sm text-zinc-500 mt-2">No mail has been attempted yet.</p>'}
      </div>`;
  },

  async _loadSettings() {
    const { ok, data, status } = await AdminTopochain.fetchJson('/api/v4/admin/settings');
    if (AdminTopochain._sub !== 'settings') return;
    const good = ok && data?.success;
    AdminTopochain._settings.items = good ? data.data : [];
    AdminTopochain._settings.error = good ? null : { status, message: (data && data.error) || null };
    AdminTopochain._renderSettingsTable();
  },

  _renderSettingsTable() {
    const table = document.getElementById('admin-topo-set-table');
    if (!table) return;
    const esc = AdminTopochain.esc;
    const canWrite = AdminTopochain.canWrite();
    const st = AdminTopochain._settings;
    const items = st.items;
    if (st.error) {
      table.innerHTML = AdminTopochain._error({
        title: "Couldn't load settings", status: st.error.status,
        message: st.error.message, retryId: 'admin-topo-set-retry',
      });
      AdminTopochain._wireRetry('admin-topo-set-retry', () => AdminTopochain._loadSettings());
      return;
    }
    if (!items.length) {
      table.innerHTML = AdminTopochain._empty({
        title: 'No settings yet',
        body: 'Settings are numeric knobs read by the mobile app. Keys must start with topochain_.',
        actionId: 'admin-topo-set-empty-new',
        actionLabel: 'New setting',
      });
      document.getElementById('admin-topo-set-empty-new')
        ?.addEventListener('click', () => AdminTopochain._openSettingForm(null));
      return;
    }
    table.innerHTML = AdminTopochain._list({
      items,
      columns: [
        { label: 'Key', primary: true, cell: (s) => esc(s.key), tdClass: 'text-xs font-mono' },
        { label: 'Value', cell: (s) => esc(s.value), tdClass: 'font-mono text-right', thClass: 'text-right' },
        { label: 'Description', cell: (s) => esc(s.description || '—'), tdClass: 'text-xs text-zinc-500' },
        { label: 'Updated', cell: (s) => esc(AdminTopochain._fmt(s.updated_at)), tdClass: 'text-xs text-zinc-500' },
      ],
      actions: (s) => `
        ${canWrite ? `<button data-edit-set="${esc(s.key)}" type="button" class="${BTN.row}">Edit</button>` : ''}
        ${canWrite ? `<button data-delete-set="${esc(s.key)}" type="button" class="${BTN.rowDanger}">Delete</button>` : ''}`,
    });
    table.querySelectorAll('[data-edit-set]').forEach((b) => b.addEventListener('click', () => AdminTopochain._openSettingForm(b.dataset.editSet)));
    table.querySelectorAll('[data-delete-set]').forEach((b) => b.addEventListener('click', () => AdminTopochain._deleteSetting(b.dataset.deleteSet)));
  },

  async _deleteSetting(key) {
    if (!AdminTopochain.canWrite()) return;
    const ok = await AdminTopochain._confirm({ title: `Delete "${key}"?`, confirmLabel: 'Delete', danger: true, message: 'This cannot be undone.' });
    if (!ok) return;
    const res = await AdminTopochain.send('DELETE', `/api/v4/admin/settings/${encodeURIComponent(key)}`);
    if (res.ok && res.data?.success) AdminTopochain._loadSettings();
    else AdminTopochain._alert((res.data && res.data.error) || 'Delete failed.');
  },

  async _openSettingForm(key) {
    if (!AdminTopochain.canWrite()) return;
    AdminTopochain._settings.editingKey = key;
    AdminTopochain._settings.isNew = key == null;
    const existing = key != null ? AdminTopochain._settings.items.find((s) => s.key === key) : null;
    const f = AdminTopochain._inputHtml, field = AdminTopochain._field, esc = AdminTopochain.esc;
    const host = document.getElementById('admin-topo-set-form');
    host.innerHTML = AdminTopochain._panel({
      title: key == null ? 'New setting' : `Edit ${esc(key)}`,
      subtitle: 'Keys must start with topochain_ and values are numbers the app reads at runtime.',
      closeId: 'admin-topo-set-close',
      closeLabel: 'Close the setting form',
      body: `
        ${AdminTopochain._formGrid(`
          ${field('Key * (must start with topochain_)', f('admin-topo-set-f-key', { value: existing?.key }))}
          ${field('Value * (number ≥ 0)', f('admin-topo-set-f-value', { type: 'number', min: 0, step: 'any', value: existing?.value }))}
          <div class="md:col-span-2">
            ${field('Description', AdminTopochain._textareaHtml('admin-topo-set-f-description', existing?.description || '', 3))}
          </div>
        `)}
        ${AdminTopochain._formErrorSlot('admin-topo-set-form-err')}`,
      footer: AdminTopochain._formActions('admin-topo-set-save', 'admin-topo-set-cancel', 'Save setting'),
    });
    const closeForm = () => { host.innerHTML = ''; AdminTopochain._settings.editingKey = null; };
    document.getElementById('admin-topo-set-save').addEventListener('click', () => AdminTopochain._saveSetting());
    document.getElementById('admin-topo-set-cancel').addEventListener('click', closeForm);
    document.getElementById('admin-topo-set-close').addEventListener('click', closeForm);
  },

  async _saveSetting() {
    if (!AdminTopochain.canWrite()) return;
    const errEl = document.getElementById('admin-topo-set-form-err');
    errEl.classList.add('hidden');
    const key = document.getElementById('admin-topo-set-f-key').value.trim();
    const value = document.getElementById('admin-topo-set-f-value').value.trim();
    const description = document.getElementById('admin-topo-set-f-description').value.trim();
    if (!key.startsWith('topochain_')) { errEl.textContent = 'Key must start with "topochain_".'; errEl.classList.remove('hidden'); return; }
    if (value === '' || Number.isNaN(Number(value)) || Number(value) < 0) { errEl.textContent = 'Value must be a number >= 0.'; errEl.classList.remove('hidden'); return; }
    const isNew = AdminTopochain._settings.isNew;
    const body = { key, value: Number(value), description: description === '' ? null : description };
    const url = isNew ? '/api/v4/admin/settings' : `/api/v4/admin/settings/${encodeURIComponent(AdminTopochain._settings.editingKey)}`;
    const { ok, data } = await AdminTopochain.send(isNew ? 'POST' : 'PUT', url, body);
    if (!ok || !data?.success) {
      errEl.textContent = (data && data.error) || 'Save failed.';
      errEl.classList.remove('hidden');
      return;
    }
    document.getElementById('admin-topo-set-form').innerHTML = '';
    AdminTopochain._settings.editingKey = null;
    AdminTopochain._loadSettings();
  },

  async _resetSettings() {
    if (!AdminTopochain.canWrite()) return;
    const ok = await AdminTopochain._confirm({
      title: 'Reset settings to defaults?',
      message: 'Restores the 6 scoring-related topochain_* settings to their shipped defaults. Any other custom topochain_* settings are left untouched.',
      confirmLabel: 'Reset',
      danger: true,
    });
    if (!ok) return;
    const { ok: sendOk, data } = await AdminTopochain.send('POST', '/api/v4/admin/settings/reset', { confirm: true });
    if (sendOk && data?.success) AdminTopochain._loadSettings();
    else AdminTopochain._alert((data && data.error) || 'Reset failed.');
  },

  // ══════════════════════════════════════════════════════════════════
  // App version — full CRUD over app_version_configs (one row per OS).
  // ══════════════════════════════════════════════════════════════════

  _appver: { items: [], editingId: null },

  renderAppVersion(host) {
    const canWrite = AdminTopochain.canWrite();
    host.innerHTML = `
      ${AdminTopochain._screenHeader({
    title: 'App version',
    subtitle: 'One update rule per OS. Build numbers decide forced and suggested updates.',
    actions: canWrite ? `<button id="admin-topo-av-new" type="button" class="${BTN.primarySm}">New config</button>` : '',
  })}
      <div id="admin-topo-av-gate"></div>
      <div id="admin-topo-av-form"></div>
      <div id="admin-topo-av-table">${AdminTopochain._skeleton(4)}</div>
      <div id="admin-topo-av-activity"></div>`;
    document.getElementById('admin-topo-av-new')?.addEventListener('click', () => AdminTopochain._openAppVersionForm(null));
    AdminTopochain._loadAppVersions();
    AdminTopochain._loadAppVersionActivity();
  },

  async _loadAppVersions() {
    const { ok, data, status } = await AdminTopochain.fetchJson('/api/v4/admin/app-version-configs');
    if (AdminTopochain._sub !== 'app-version') return;
    const good = ok && data?.success;
    AdminTopochain._appver.items = good ? data.data : [];
    AdminTopochain._appver.error = good ? null : { status, message: (data && data.error) || null };
    AdminTopochain._renderAppVersionsTable();
    AdminTopochain._renderAppVersionGate();
  },

  // Per-OS "no rule configured" warning. Without a row (or with the row
  // inactive) POST /app-version/check answers `upgrade: 0` to EVERY build,
  // including ones that should be forced to update — the gate is off, and
  // nothing else on this screen says so.
  _renderAppVersionGate() {
    const host = document.getElementById('admin-topo-av-gate');
    if (!host) return;
    const esc = AdminTopochain.esc;
    const items = AdminTopochain._appver.items || [];
    const missing = ['ios', 'android'].filter(
      (os) => !items.some((c) => c.os === os && c.is_active)
    );
    if (!missing.length) { host.innerHTML = ''; return; }
    const label = { ios: 'iOS', android: 'Android' };
    host.innerHTML = missing.map((os) => `
      <div class="mb-3 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm sm:px-5">
        <span class="font-semibold text-amber-800 dark:text-amber-300">
          No active version rule for ${esc(label[os])}
        </span>
        <span class="text-amber-800/80 dark:text-amber-300/80">
          — every ${esc(label[os])} build is told it is up to date, including
          old ones. Add an active config for ${esc(os)} to turn the update
          gate on.
        </span>
      </div>`).join('');
  },

  // Last 7 days of version checks. Answers "is the gate doing anything?" —
  // an all-zero table with traffic means the rule is permissive; no traffic
  // at all means no shell is calling.
  async _loadAppVersionActivity() {
    const { ok, data } = await AdminTopochain.fetchJson(
      '/api/v4/admin/app-version-configs/check-activity');
    if (AdminTopochain._sub !== 'app-version') return;
    const host = document.getElementById('admin-topo-av-activity');
    if (!host) return;
    const esc = AdminTopochain.esc;
    if (!ok || !data?.success) { host.innerHTML = ''; return; }

    const a = data.data || {};
    const UPGRADE_LABEL = {
      0: 'up to date',
      1: 'suggested update',
      2: 'forced update',
    };
    if (!a.total) {
      host.innerHTML = `
        <p class="text-xs text-zinc-500 mt-4">
          No version checks in the last ${esc(a.window_days ?? 7)} days — no app
          build has asked this platform whether it needs to update.
        </p>`;
      return;
    }
    const rows = (a.by_os || []).map((r) => `
      <tr class="border-t border-zinc-200 dark:border-zinc-800">
        <td class="px-3 py-1.5 text-sm">${esc(r.os || '—')}</td>
        <td class="px-3 py-1.5 text-sm">${esc(UPGRADE_LABEL[r.upgrade] || r.upgrade)}</td>
        <td class="px-3 py-1.5 text-sm font-mono text-right">${esc(r.count)}</td>
      </tr>`).join('');
    host.innerHTML = `
      <h3 class="text-sm font-semibold mt-8 mb-3">
        Version checks &middot; last ${esc(a.window_days ?? 7)} days
        <span class="font-normal text-zinc-500">(${esc(a.total)} total)</span>
      </h3>
      <div class="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table class="w-full">
          <thead class="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
            <tr><th class="px-3 py-2 text-left">OS</th>
              <th class="px-3 py-2 text-left">Told</th>
              <th class="px-3 py-2 text-right">Checks</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  },

  _renderAppVersionsTable() {
    const table = document.getElementById('admin-topo-av-table');
    if (!table) return;
    const esc = AdminTopochain.esc;
    const canWrite = AdminTopochain.canWrite();
    const av = AdminTopochain._appver;
    const items = av.items;
    if (av.error) {
      table.innerHTML = AdminTopochain._error({
        title: "Couldn't load app version configs", status: av.error.status,
        message: av.error.message, retryId: 'admin-topo-av-retry',
      });
      AdminTopochain._wireRetry('admin-topo-av-retry', () => AdminTopochain._loadAppVersions());
      return;
    }
    if (!items.length) {
      table.innerHTML = AdminTopochain._empty({
        title: 'No app version configs yet',
        body: 'Without a rule per OS the update gate is off — every build is told it is up to date.',
        actionId: 'admin-topo-av-empty-new',
        actionLabel: 'New config',
      });
      document.getElementById('admin-topo-av-empty-new')
        ?.addEventListener('click', () => AdminTopochain._openAppVersionForm(null));
      return;
    }
    table.innerHTML = AdminTopochain._list({
      items,
      columns: [
        { label: 'OS', primary: true, cell: (c) => esc(c.os) },
        { label: 'Min build', cell: (c) => esc(c.min_build_number), tdClass: 'font-mono text-right', thClass: 'text-right' },
        { label: 'Recommended', cell: (c) => (c.recommended_build_number != null ? esc(c.recommended_build_number) : '—'), tdClass: 'font-mono text-right', thClass: 'text-right' },
        { label: 'Current version', cell: (c) => esc(c.current_version || '—'), tdClass: 'text-xs text-zinc-500' },
        { label: 'Active', cell: (c) => (c.is_active ? '<span class="text-green-600 dark:text-green-400">active</span>' : '—') },
      ],
      actions: (c) => `
        ${canWrite ? `<button data-edit-av="${c.id}" type="button" class="${BTN.row}">Edit</button>` : ''}
        ${canWrite ? `<button data-delete-av="${c.id}" type="button" class="${BTN.rowDanger}">Delete</button>` : ''}`,
    });
    table.querySelectorAll('[data-edit-av]').forEach((b) => b.addEventListener('click', () => AdminTopochain._openAppVersionForm(parseInt(b.dataset.editAv, 10))));
    table.querySelectorAll('[data-delete-av]').forEach((b) => b.addEventListener('click', () => AdminTopochain._deleteAppVersion(b.dataset.deleteAv)));
  },

  async _deleteAppVersion(id) {
    if (!AdminTopochain.canWrite()) return;
    const ok = await AdminTopochain._confirm({ title: 'Delete this app version config?', confirmLabel: 'Delete', danger: true, message: 'This cannot be undone.' });
    if (!ok) return;
    const res = await AdminTopochain.send('DELETE', `/api/v4/admin/app-version-configs/${encodeURIComponent(id)}`);
    if (res.ok && res.data?.success) AdminTopochain._loadAppVersions();
    else AdminTopochain._alert((res.data && res.data.error) || 'Delete failed.');
  },

  async _openAppVersionForm(id) {
    if (!AdminTopochain.canWrite()) return;
    AdminTopochain._appver.editingId = id;
    const existing = id != null ? AdminTopochain._appver.items.find((c) => c.id === id) : null;
    const f = AdminTopochain._inputHtml, sel = AdminTopochain._selectHtml, field = AdminTopochain._field;
    const host = document.getElementById('admin-topo-av-form');
    host.innerHTML = AdminTopochain._panel({
      title: id == null ? 'New app version config' : `Edit ${AdminTopochain.esc(existing?.os)}`,
      subtitle: 'The gate compares build numbers. An inactive rule tells every build it is up to date.',
      closeId: 'admin-topo-av-close',
      closeLabel: 'Close the app version form',
      body: `
        ${AdminTopochain._formGrid(`
          ${field('OS *', sel('admin-topo-av-f-os', ['ios', 'android'], existing?.os || 'ios', { disabled: id != null }))}
          ${field('Current version', f('admin-topo-av-f-current_version', { value: existing?.current_version }),
    'Display only — the gate compares build numbers, not this string.')}
          ${field('Min build number *', f('admin-topo-av-f-min_build_number', { type: 'number', min: 1, value: existing?.min_build_number }),
    'FORCED update: builds below this are blocked until the user updates.')}
          ${field('Recommended build number', f('admin-topo-av-f-recommended_build_number', { type: 'number', min: 1, value: existing?.recommended_build_number }),
    'SUGGESTED update: builds below this get a dismissible prompt. Leave blank for none.')}
          <div class="md:col-span-2">
            ${field('Update URL', f('admin-topo-av-f-update_url', { value: existing?.update_url }),
    'Must be http(s). Only sent when an update is required or suggested — leave it blank and a forced update gives the user nowhere to go.')}
          </div>
          <div class="md:col-span-2">
            ${AdminTopochain._checkField('admin-topo-av-f-is_active', 'Active', existing ? existing.is_active : true,
    'Turn the update gate on for this OS.')}
          </div>
        `)}
        <div class="grid grid-cols-1 gap-4 mt-4">
          ${field('Must-update message', AdminTopochain._textareaHtml('admin-topo-av-f-must_update_message', existing?.must_update_message || '', 3))}
          ${field('Should-update message', AdminTopochain._textareaHtml('admin-topo-av-f-should_update_message', existing?.should_update_message || '', 3))}
        </div>
        ${AdminTopochain._formErrorSlot('admin-topo-av-form-err')}`,
      footer: AdminTopochain._formActions('admin-topo-av-save', 'admin-topo-av-cancel', 'Save config'),
    });
    const closeForm = () => { host.innerHTML = ''; AdminTopochain._appver.editingId = null; };
    document.getElementById('admin-topo-av-save').addEventListener('click', () => AdminTopochain._saveAppVersion());
    document.getElementById('admin-topo-av-cancel').addEventListener('click', closeForm);
    document.getElementById('admin-topo-av-close').addEventListener('click', closeForm);
  },

  async _saveAppVersion() {
    if (!AdminTopochain.canWrite()) return;
    const errEl = document.getElementById('admin-topo-av-form-err');
    errEl.classList.add('hidden');
    const val = (id) => (document.getElementById(id)?.value ?? '').trim();
    const numOrNull = (id) => { const v = val(id); return v === '' ? null : Number(v); };
    const updateUrl = val('admin-topo-av-f-update_url');
    if (updateUrl && !/^https?:\/\//i.test(updateUrl)) {
      errEl.textContent = 'Update URL must be http(s).';
      errEl.classList.remove('hidden');
      return;
    }
    const body = {
      os: val('admin-topo-av-f-os'),
      min_build_number: Number(val('admin-topo-av-f-min_build_number')),
      recommended_build_number: numOrNull('admin-topo-av-f-recommended_build_number'),
      current_version: val('admin-topo-av-f-current_version') || null,
      update_url: updateUrl || null,
      must_update_message: val('admin-topo-av-f-must_update_message') || null,
      should_update_message: val('admin-topo-av-f-should_update_message') || null,
      is_active: !!document.getElementById('admin-topo-av-f-is_active').checked,
    };
    const id = AdminTopochain._appver.editingId;
    const url = id == null ? '/api/v4/admin/app-version-configs' : `/api/v4/admin/app-version-configs/${encodeURIComponent(id)}`;
    const { ok, data } = await AdminTopochain.send(id == null ? 'POST' : 'PUT', url, body);
    if (!ok || !data?.success) {
      errEl.textContent = (data && data.error) || 'Save failed.';
      errEl.classList.remove('hidden');
      return;
    }
    document.getElementById('admin-topo-av-form').innerHTML = '';
    AdminTopochain._appver.editingId = null;
    AdminTopochain._loadAppVersions();
  },

  // ══════════════════════════════════════════════════════════════════
  // SQL console — POST sql-query/execute, schema sidebar, templates.
  // Handles the 503 "console unavailable" state explicitly.
  // ══════════════════════════════════════════════════════════════════

  _sql: { schema: null, templates: null },

  renderSqlConsole(host) {
    // Editor first in the DOM so a phone gets the thing it came for
    // without scrolling past two reference lists; `lg:order-*` puts the
    // sidebar back on the left once there is room for both.
    host.innerHTML = `
      ${AdminTopochain._screenHeader({
    title: 'SQL console',
    subtitle: 'Read-only queries against the app database. Pick a template or a table to start.',
  })}
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        <div class="lg:order-2">
          ${AdminTopochain._panel({
    title: 'Query',
    subtitle: 'SELECT only — bare wildcards are rejected.',
    body: `
              <textarea id="admin-topo-sql-query" rows="8" placeholder="SELECT ..."
                aria-label="SQL query" class="${TEXTAREA_CLS}"></textarea>`,
    footer: `
              <button id="admin-topo-sql-run" type="button" class="${BTN.primary}">Run query</button>
              <label class="flex items-center gap-2 text-xs text-zinc-500">
                <span>Limit</span>
                <input id="admin-topo-sql-limit" type="number" min="1" max="1000" value="100"
                  class="w-24 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs font-mono min-h-[44px] sm:min-h-[36px] focus:outline-none focus:ring-2 focus:ring-violet-500">
              </label>`,
  })}
          <div id="admin-topo-sql-result"></div>
        </div>
        <div class="lg:order-1 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">
          ${AdminTopochain._panel({
    title: 'Templates',
    body: `<div id="admin-topo-sql-templates" class="space-y-1">${AdminTopochain._skeleton(3)}</div>`,
  })}
          ${AdminTopochain._panel({
    title: 'Schema',
    body: `<div id="admin-topo-sql-schema" class="space-y-1 max-h-96 overflow-y-auto">${AdminTopochain._skeleton(3)}</div>`,
  })}
        </div>
      </div>`;
    document.getElementById('admin-topo-sql-run').addEventListener('click', () => AdminTopochain._runSqlQuery());
    AdminTopochain._loadSqlSchema();
    AdminTopochain._loadSqlTemplates();
  },

  async _loadSqlTemplates() {
    const { ok, data } = await AdminTopochain.fetchJson('/api/v4/admin/sql-query/templates');
    const host = document.getElementById('admin-topo-sql-templates');
    if (!host) return;
    const esc = AdminTopochain.esc;
    if (!ok || !data?.success) { host.innerHTML = '<p class="text-xs text-zinc-500">Unavailable.</p>'; return; }
    AdminTopochain._sql.templates = data.data;
    host.innerHTML = data.data.map((t, i) => `
      <button data-tpl="${i}" type="button" title="${esc(t.description)}"
        class="${BTN.sidebar}">${esc(t.name)}</button>`).join('');
    host.querySelectorAll('[data-tpl]').forEach((b) => b.addEventListener('click', () => {
      document.getElementById('admin-topo-sql-query').value = AdminTopochain._sql.templates[parseInt(b.dataset.tpl, 10)].query;
    }));
  },

  async _loadSqlSchema() {
    const { ok, data } = await AdminTopochain.fetchJson('/api/v4/admin/sql-query/schema');
    const host = document.getElementById('admin-topo-sql-schema');
    if (!host) return;
    const esc = AdminTopochain.esc;
    if (!ok || !data?.success) { host.innerHTML = '<p class="text-xs text-zinc-500">Unavailable.</p>'; return; }
    AdminTopochain._sql.schema = data.data;
    host.innerHTML = data.data.map((t, i) => `
      <button data-table="${i}" type="button" title="${esc(t.comment || '')}"
        class="${BTN.sidebar} font-mono">${esc(t.name)}</button>`).join('');
    host.querySelectorAll('[data-table]').forEach((b) => b.addEventListener('click', () => {
      const t = AdminTopochain._sql.schema[parseInt(b.dataset.table, 10)];
      // Never `SELECT *` — the console rejects bare wildcards; list the
      // table's own columns explicitly instead so the inserted query is
      // guaranteed to pass validation as-is.
      const cols = t.columns.map((c) => c.name).join(', ');
      document.getElementById('admin-topo-sql-query').value = `SELECT ${cols} FROM ${t.name} LIMIT 100`;
    }));
  },

  async _runSqlQuery() {
    // Read-only by construction server-side (BEGIN TRANSACTION READ ONLY
    // under a restricted role) — no canWrite() gate needed here, this is
    // the one mutating-looking control in this file that isn't actually
    // a write.
    const query = document.getElementById('admin-topo-sql-query').value.trim();
    const limit = document.getElementById('admin-topo-sql-limit').value.trim() || '100';
    const result = document.getElementById('admin-topo-sql-result');
    const esc = AdminTopochain.esc;
    const note = (cls, text) => `<p class="mt-3 rounded-lg px-3 py-2 text-sm ${cls}" role="status">${text}</p>`;
    if (!query) { result.innerHTML = note('bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400', 'Enter a query.'); return; }
    result.innerHTML = note('bg-zinc-100 dark:bg-zinc-800 text-zinc-500', 'Running&hellip;');
    const { status, ok, data } = await AdminTopochain.fetchJson('/api/v4/admin/sql-query/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: Number(limit) }),
    });
    if (status === 503) {
      result.innerHTML = note('bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400',
        esc((data && data.error) || 'The SQL console is not available right now.'));
      return;
    }
    if (!ok || !data?.success) {
      result.innerHTML = note('bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400',
        esc((data && data.error) || 'Query failed.'));
      return;
    }
    if (!data.data.length) {
      result.innerHTML = `<div class="mt-3">${AdminTopochain._empty({
        title: 'No rows',
        body: `The query ran in ${data.execution_time_ms} ms and matched nothing.`,
      })}</div>`;
      return;
    }
    const cols = data.columns;
    const rows = data.data.map((row) => `
      <tr class="border-t border-zinc-200 dark:border-zinc-800">
        ${cols.map((c) => `<td class="px-2 py-1 text-xs font-mono whitespace-nowrap">${esc(row[c] == null ? '' : String(row[c]))}</td>`).join('')}
      </tr>`).join('');
    // Deliberately NOT the shared _list() card/table pair: the columns
    // here are whatever the query returned, so there is no primary
    // column to title a card with and no stable label set. A scrolling
    // result grid is the right shape for arbitrary SQL output, on a
    // phone as much as anywhere.
    result.innerHTML = `
      <p class="text-xs text-zinc-500 mb-2 mt-3">${esc(data.row_count)} row(s)${data.limited ? ' (truncated to the limit)' : ''} in ${esc(data.execution_time_ms)} ms</p>
      <div class="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table class="w-full">
          <thead class="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
            <tr>${cols.map((c) => `<th class="px-2 py-1 text-left">${esc(c)}</th>`).join('')}</tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  },

  // ══════════════════════════════════════════════════════════════════
  // API tester — method + /api/v4 path + JSON body, same-origin fetch.
  //
  // Deliberately not gated on canWrite(): this is a generic HTTP console
  // that fires requests using the admin's OWN session cookies (same-
  // origin credentials, nothing more), exactly like every route it hits.
  // A view-only admin who picks PUT/POST/DELETE here still gets the
  // platform's own 403 "Full admin access required." from adminWriteGate
  // server-side — the tool grants no capability beyond what the session
  // already has, so hiding it would be UX-only, not a security boundary
  // (mirrors why the SQL console's run button isn't canWrite()-gated
  // either — see the comment on _runSqlQuery below).
  // ══════════════════════════════════════════════════════════════════

  renderApiTester(host) {
    host.innerHTML = `
      ${AdminTopochain._screenHeader({
    title: 'API tester',
    subtitle: 'Same-origin requests sent with your own session — the platform still applies its own gates.',
  })}
      ${AdminTopochain._panel({
    title: 'Request',
    subtitle: 'Method, path under /api/v4, and an optional JSON body.',
    body: `
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-[auto_1fr]">
            <div class="sm:w-32">
              <label for="admin-topo-api-method" class="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Method</label>
              ${AdminTopochain._selectHtml('admin-topo-api-method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], 'GET')}
            </div>
            <div class="min-w-0">
              <label for="admin-topo-api-path" class="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                Path <span class="font-mono font-normal text-zinc-400">(prefixed with /api/v4)</span>
              </label>
              <input id="admin-topo-api-path" type="text" placeholder="/season-events" value="/season-events"
                class="${FIELD_CLS} font-mono">
            </div>
          </div>
          <div class="mt-4">
            <label for="admin-topo-api-body" class="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
              JSON body <span class="font-normal text-zinc-400">(ignored for GET)</span>
            </label>
            ${AdminTopochain._textareaHtml('admin-topo-api-body', '', 6)}
          </div>`,
    footer: `<button id="admin-topo-api-send" type="button" class="${BTN.primary}">Send request</button>`,
  })}
      <div id="admin-topo-api-result"></div>`;
    document.getElementById('admin-topo-api-send').addEventListener('click', () => AdminTopochain._runApiTest());
  },

  async _runApiTest() {
    const esc = AdminTopochain.esc;
    const method = document.getElementById('admin-topo-api-method').value;
    let path = document.getElementById('admin-topo-api-path').value.trim();
    if (!path.startsWith('/')) path = `/${path}`;
    const fullUrl = `/api/v4${path}`;
    const result = document.getElementById('admin-topo-api-result');
    const opts = { method, credentials: 'same-origin' };
    const note = (cls, text) => `<p class="mt-3 rounded-lg px-3 py-2 text-sm ${cls}" role="status">${text}</p>`;
    if (method !== 'GET' && method !== 'DELETE') {
      const raw = document.getElementById('admin-topo-api-body').value.trim();
      if (raw) {
        try { JSON.parse(raw); } catch {
          result.innerHTML = note('bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400', 'Body must be valid JSON.');
          return;
        }
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = raw;
      }
    }
    result.innerHTML = note('bg-zinc-100 dark:bg-zinc-800 text-zinc-500', 'Sending&hellip;');
    try {
      const res = await fetch(fullUrl, opts);
      const text = await res.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON, show raw */ }
      const okTone = res.ok
        ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400'
        : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400';
      result.innerHTML = `
        <div class="mt-4 ${PANEL_CLS} overflow-hidden">
          <header class="flex flex-wrap items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 sm:px-5">
            <h3 class="text-sm font-semibold">Response</h3>
            <span class="rounded-full px-2 py-0.5 text-xs font-medium ${okTone}">HTTP ${esc(res.status)} ${esc(res.statusText)}</span>
          </header>
          <pre class="text-xs font-mono bg-zinc-50 dark:bg-zinc-950 p-4 overflow-x-auto whitespace-pre-wrap max-h-[32rem]">${esc(pretty)}</pre>
        </div>`;
    } catch (err) {
      result.innerHTML = note('bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400',
        `Network error: ${esc(err.message)}`);
    }
  },
};

window.AdminTopochain = AdminTopochain;
