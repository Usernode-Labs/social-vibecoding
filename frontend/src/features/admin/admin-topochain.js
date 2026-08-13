// The programme admin console screens (Task 15; reorganised by #1179).
// This module started as ONE AdminConsole section ("Seasons, Events &
// Challenges") that rendered its own horizontal sub-navigation over
// eleven screens. #1179 retired that second-level nav: each screen is a
// FIRST-CLASS AdminConsole section now, listed in the console's own menu
// under the Programme / People / Platform groups, and every one of them
// still renders through this module — AdminConsole._renderSection
// dispatches all ten section keys to it via SECTION_MODULES (#860), and
// render() reads the active section key back from AdminConsole to pick
// the screen. One exception: the programme Users screen is not a section
// of its own — it is merged into the console's existing Users section
// (admin-console.js renderUsersSection calls renderUsers directly).
//
// Season events still owns tail segments below its section:
// #admin/season-events/<eventId> is "managing this event's challenges",
// and .../new-challenge[/<templateId>] is its Add-challenge form, on that
// template, already filled in. _readSeasonEventsDeepLink() parses them on
// first render and _syncHash() writes them back via replaceState, the
// same pattern features/leaderboard/leaderboard.js uses for its own tab
// state — so admin-console.js's single-level setSection/_writeHash needed
// no changes.
//
// NAMING & LEGACY ADDRESSES: the umbrella section was called "Topochain",
// then "Seasons, Events & Challenges" at #admin/seasons/<sub>. Both
// two-level address families (#admin/seasons/<sub> and
// #admin/topochain/<sub>, tails included) are PERMANENT aliases: app.js
// promotes the screen segment to the section segment and rewrites the
// address bar, and this module's _subFromHash()/_syncHash() accept the
// legacy prefixes on their own too, so a bookmark self-heals either way.
// The file name, the AdminTopochain global, the `topochain_` settings-key
// prefix, the /api/v4/admin/* routes and the database tables are all
// deliberately unchanged — the reorganisations are user-facing copy and
// routing only.
//
// LAYOUT: every screen renders through the shared _list() renderer (a
// real table at md+, a card stack below) and the shared
// _skeleton()/_empty()/_error() helpers, so "loading", "nothing here"
// and "the request failed" never look alike.
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
// None of the three gaps above appear in SUBS — a missing tab beats a
// dead one.
//
// (`seasons` used to be a fourth gap here: the screen was a read-only
// view derived by grouping season-events by season_id, because no
// /api/v4/admin/seasons resource existed. It does now — see
// src/routes/topochain/admin/seasons.js — so renderSeasons() below is
// full CRUD like every other resource screen.)
'use strict';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';

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
  + 'focus-visible:ring-indigo-500 disabled:opacity-40 disabled:pointer-events-none';
const BTN_MD = 'min-h-[44px] sm:min-h-[36px] px-4 py-2 text-sm';
const BTN_SM = 'min-h-[44px] sm:min-h-[34px] px-3 py-1.5 text-sm';
const BTN_ROW = 'min-h-[36px] sm:min-h-[30px] px-2.5 py-1 text-xs';
const BTN = {
  // Page/panel-level primary + secondary (Save, Cancel, Run, Send).
  primary: `${BTN_BASE} ${BTN_MD} bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm`,
  secondary: `${BTN_BASE} ${BTN_MD} border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800`,
  // Toolbar variants — same colours, one size down.
  primarySm: `${BTN_BASE} ${BTN_SM} bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm`,
  secondarySm: `${BTN_BASE} ${BTN_SM} border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800`,
  dangerSm: `${BTN_BASE} ${BTN_SM} bg-red-600 hover:bg-red-500 text-white`,
  warnSm: `${BTN_BASE} ${BTN_SM} border border-amber-400 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40`,
  // Row actions. Chips, not bare text links: a bordered box is a target
  // you can see and hit, and it wraps predictably inside both the table
  // cell and the card footer _list() renders them into.
  row: `${BTN_BASE} ${BTN_ROW} border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-800 dark:hover:text-indigo-300`,
  rowPrimary: `${BTN_BASE} ${BTN_ROW} border border-indigo-300 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40`,
  rowDanger: `${BTN_BASE} ${BTN_ROW} border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40`,
  rowWarn: `${BTN_BASE} ${BTN_ROW} border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40`,
  // Full-width list entry in a reference sidebar (SQL templates, schema
  // tables). Left-aligned rather than centred, and tall enough to hit.
  sidebar: 'flex w-full items-center min-h-[36px] rounded-lg px-2.5 py-1.5 text-left text-xs '
    + 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 '
    + 'touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
  // Back control on a nested screen, and the ✕ in a panel header.
  back: `${BTN_BASE} min-h-[44px] sm:min-h-[36px] -ml-2 px-2 py-1 text-sm text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40`,
  close: 'inline-flex shrink-0 items-center justify-center h-9 w-9 rounded-lg text-gray-500 '
    + 'hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 '
    + 'touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
};

// Text inputs / selects / textareas. Same 44px-then-36px rule as the
// buttons so a field and the button beside it line up at every width.
const FIELD_CLS = 'w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 '
  + 'px-3 py-2 text-sm min-h-[44px] sm:min-h-[36px] focus:outline-none focus:ring-2 '
  + 'focus:ring-indigo-500 focus:border-transparent disabled:opacity-60';
// Textareas set their height from `rows`, so they take everything but
// the min-height.
const TEXTAREA_CLS = 'w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 '
  + 'px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent';

// Panel and card surfaces, shared by every form, picker and detail view.
const PANEL_CLS = AdminUI.card; // identical recipe — one source of truth

const AdminTopochain = {
  _host: null,
  _sub: null,

  // Built screens only (see the file-header gap list above for what's
  // deliberately absent and why). Every key here is a first-class
  // AdminConsole SECTIONS key since #1179 — the two lists must agree
  // (tests/topochain-admin-screens.test.js checks it), which is why the
  // programme Users screen is NOT listed: it has no section of its own,
  // the console's Users section embeds renderUsers directly.
  SUBS: [
    { key: 'seasons', label: 'Seasons' },
    { key: 'season-events', label: 'Season events' },
    { key: 'challenge-templates', label: 'Challenge templates' },
    { key: 'waitlist', label: 'Waitlist' },
    { key: 'onchain-accounts', label: 'Onchain accounts' },
    { key: 'user-activities', label: 'User activities' },
    { key: 'settings', label: 'Settings' },
    { key: 'app-version', label: 'App version' },
    { key: 'sql-console', label: 'SQL console' },
    { key: 'api-tester', label: 'API tester' },
  ],

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
      <span class="font-medium text-gray-600 dark:text-gray-400">${esc(label)}</span>
      <div class="mt-1">${innerHtml}</div>
      ${help ? `<span class="block mt-1 text-[11px] leading-snug text-gray-400">${esc(help)}</span>` : ''}
    </label>`;
  },

  // A checkbox reads as a control plus its label, not as a label with a
  // control under it, so it gets its own row shape with a tap target
  // that covers the text as well as the box.
  _checkField(id, label, checked, help) {
    const esc = AdminTopochain.esc;
    return `<label class="flex items-start gap-2.5 min-h-[44px] sm:min-h-[36px] py-2 cursor-pointer">
      <input id="${esc(id)}" type="checkbox" ${checked ? 'checked' : ''}
        class="mt-0.5 h-5 w-5 shrink-0 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-2 focus:ring-indigo-500">
      <span class="text-xs">
        <span class="font-medium text-gray-600 dark:text-gray-400">${esc(label)}</span>
        ${help ? `<span class="block mt-0.5 text-[11px] leading-snug text-gray-400">${esc(help)}</span>` : ''}
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
        class="h-5 w-5 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-2 focus:ring-indigo-500" ${opts.value ? 'checked' : ''}>`;
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
      return `<div class="h-4 ${w} rounded bg-gray-200 dark:bg-gray-800"></div>`;
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
      ? `<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">${esc(o.body)}</p>` : '';
    const action = (o.actionId && AdminTopochain.canWrite())
      ? `<div class="mt-4 flex justify-center"><button id="${esc(o.actionId)}" type="button"
           class="${BTN.primarySm}">${esc(o.actionLabel || 'Create')}</button></div>`
      : '';
    return `<div class="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 px-4 py-10 text-center">
      <p class="text-sm font-medium text-gray-600 dark:text-gray-300">${esc(o.title || 'Nothing here yet')}</p>
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
      : 'bg-white/90 dark:bg-gray-900/90 border-gray-200 dark:border-gray-800';
    const subtitle = o.subtitle
      ? `<p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">${esc(o.subtitle)}</p>` : '';
    const footer = o.footer
      ? `<div class="flex flex-wrap items-center gap-2 border-t border-gray-200 dark:border-gray-800 px-4 py-3 sm:px-5">${o.footer}</div>`
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
      ? `<p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">${esc(o.subtitle)}</p>` : '';
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

  // A labelled rule between groups of fields inside one form panel. The
  // long forms (challenge template, add challenge) are otherwise a wall
  // of inputs in which "which of these is the CTA?" has to be answered
  // by reading every label.
  _formSection(label) {
    return `<p class="mt-5 mb-3 border-t border-gray-200 dark:border-gray-800 pt-4 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">${AdminTopochain.esc(label)}</p>`;
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
      return `<tr class="border-t border-gray-100 dark:border-gray-800 ${rowClass(it)}">${cells}${act}</tr>`
        + (ex ? `<tr class="border-t border-gray-100 dark:border-gray-800"><td colspan="${span}" class="px-3 py-3">${ex}</td></tr>` : '');
    }).join('');

    const table = `<div class="hidden md:block overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-900 text-xs uppercase tracking-wide text-gray-500"><tr>${head}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;

    const primary = cols.find((c) => c.primary) || cols[0];
    const cards = `<div class="md:hidden space-y-2">${items.map((it) => {
      const rest = cols.filter((c) => c !== primary && !c.hideOnCard).map((c) => `
        <div class="flex items-start justify-between gap-3 py-1">
          <dt class="shrink-0 text-xs uppercase tracking-wide text-gray-500">${esc(c.label)}</dt>
          <dd class="min-w-0 text-right text-sm break-words">${c.cell(it)}</dd>
        </div>`).join('');
      const act = actions(it);
      const ex = extra(it);
      return `<div class="${PANEL_CLS} px-4 py-3 ${rowClass(it)}">
        <p class="text-sm font-medium break-words">${primary ? primary.cell(it) : ''}</p>
        <dl class="mt-1 divide-y divide-gray-100 dark:divide-gray-800">${rest}</dl>
        ${act ? `<div class="mt-2 flex flex-wrap gap-1 border-t border-gray-100 dark:border-gray-800 pt-2">${act}</div>` : ''}
        ${ex ? `<div class="mt-2">${ex}</div>` : ''}
      </div>`;
    }).join('')}</div>`;

    return table + cards;
  },

  _pagerHtml(meta, idPrefix) {
    if (!meta) return '';
    const esc = AdminTopochain.esc;
    return `<div class="mt-4 flex flex-col gap-2 text-xs text-gray-500 sm:flex-row sm:items-center sm:justify-between">
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

  // Same idea as _fetchAllEvents for the (even smaller) seasons list —
  // used by the season <select> on the Season events form and by the
  // season filter on the Season events list. Not cached, so a season
  // created seconds ago is already pickable.
  async _fetchAllSeasons() {
    const out = [];
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const { ok, data } = await AdminTopochain.fetchJson(
        `/api/v4/admin/seasons?page=${page}&per_page=100`);
      if (!ok || !data?.success || !Array.isArray(data.data)) break;
      out.push(...data.data);
      const meta = data.meta;
      if (!meta || page >= meta.total_pages) break;
      page += 1;
    }
    return out;
  },

  _seasonOptions(seasons) {
    return seasons.map((s) => ({ value: s.id, label: `${s.name} (#${s.id})` }));
  },

  // Where a season sits relative to now, as a small coloured chip.
  // Derived client-side from starts_at/ends_at/is_active rather than
  // asked of the API: the API returns the raw window (there is no
  // server-computed status field) and "is it running right now" is a
  // question about the viewer's clock anyway.
  _seasonStatus(s) {
    const now = Date.now();
    const starts = s.starts_at ? new Date(s.starts_at).getTime() : null;
    const ends = s.ends_at ? new Date(s.ends_at).getTime() : null;
    if (!s.is_active) return { label: 'Inactive', tone: 'zinc' };
    if (ends != null && !Number.isNaN(ends) && ends < now) return { label: 'Closed', tone: 'zinc' };
    if (starts != null && !Number.isNaN(starts) && starts > now) return { label: 'Upcoming', tone: 'amber' };
    return { label: 'Running', tone: 'green' };
  },

  _badgeHtml(label, tone) {
    const esc = AdminTopochain.esc;
    const tones = {
      green: 'bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400',
      amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
      violet: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400',
      zinc: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
    };
    return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone] || tones.zinc}">${esc(label)}</span>`;
  },

  // ── Shell ─────────────────────────────────────────────────────────────

  // Entry point, called by AdminConsole._renderSection every time one of
  // this module's promoted sections is (re)selected (#1179). The active
  // section key IS the screen key — the console's own menu and routing
  // already decided what to show — with a legacy-address fallback: a
  // two-level #admin/seasons/<sub> / #admin/topochain/<sub> hash that
  // somehow reached this module without app.js's rewrite still lands on
  // its screen (and self-heals in _syncHash).
  render(host) {
    AdminTopochain._host = host;
    const section = window.AdminConsole ? AdminConsole._section : null;
    const sub = AdminTopochain.SUBS.some((s) => s.key === section)
      ? section
      : (AdminTopochain._subFromHash() || AdminTopochain._sub || 'seasons');
    // Season events owns two more segments (the event being managed, and
    // its Add-challenge form). They are read BEFORE the first paint so a
    // deep link opens that screen directly instead of the event list.
    AdminTopochain._readSeasonEventsDeepLink(sub);
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

  // Legacy addresses only: the retired two-level prefixes
  // (#admin/seasons/<sub> and the even older #admin/topochain/<sub>), so
  // a link minted before #1179 still deep-links its screen. The canonical
  // single-level address needs no parsing here — the section key names
  // the screen and render() reads it from AdminConsole. app.js has
  // normally already rewritten the address by the time we get here, but
  // reading the legacy forms keeps this module correct on its own.
  _subFromHash() {
    const m = /^#admin\/(?:seasons|topochain)\/([^/]+)/.exec(location.hash);
    return m ? decodeURIComponent(m[1]) : null;
  },

  // The Season-events tail: #admin/season-events/<eventId>
  // [/new-challenge[/<templateId>]] (legacy two-level prefixes accepted
  // too). Reading it here is what makes the
  // nested screens addressable — before this, "manage this event" and
  // "add a challenge from this template" could only be reached by
  // clicking, so neither could be linked, bookmarked or screenshotted.
  // Absent segments RESET the state rather than leaving whatever the last
  // visit left behind: the address is the source of truth on entry.
  _readSeasonEventsDeepLink(sub) {
    if (sub !== 'season-events') return;
    const m = /^#admin\/(?:(?:seasons|topochain)\/)?season-events\/(\d+)(\/new-challenge(?:\/(\d+))?)?/
      .exec(location.hash);
    AdminTopochain._se.detailId = m ? parseInt(m[1], 10) : null;
    AdminTopochain._ch.open = !!(m && m[2]);
    AdminTopochain._ch.pendingTemplateId = (m && m[3]) || null;
    // The picked template is adopted from the address too, not just
    // remembered as "pending". _syncHash runs during the event-detail
    // render — before the form (and its picker) exist — so leaving the
    // PREVIOUS visit's templateId in place here lets that early sync
    // overwrite the address we are in the middle of reading, and the
    // re-render then reads its own stale value back. Deriving both from
    // the hash makes the whole path idempotent.
    AdminTopochain._ch.templateId = (m && m[3]) || '';
  },

  setSub(sub) {
    if (!AdminTopochain.SUBS.some((s) => s.key === sub)) sub = 'seasons';
    AdminTopochain._sub = sub;
    AdminTopochain._syncHash();
    AdminTopochain._renderShell();
  },

  // Cross-screen jump from inside a screen (e.g. a season's "View
  // events"). Every screen is a first-class console section since #1179,
  // so the jump goes through AdminConsole.setSection — which repaints the
  // sidebar's active row and re-enters render() — rather than this
  // module's own setSub. Module state set before the call (filters, a
  // cleared detail id) survives it; setSub is the standalone fallback.
  _gotoSub(sub) {
    if (window.AdminConsole && AdminConsole.isOpen()) AdminConsole.setSection(sub);
    else AdminTopochain.setSub(sub);
  },

  // Keep the hash deep-linkable (#admin/<screen>) without polluting
  // history — replaceState, and only while actually on this screen's own
  // address (mirrors leaderboard.js's _syncHash). The legacy two-level
  // prefixes (#admin/seasons/<sub>, #admin/topochain/<sub>) are accepted
  // as a starting point and rewritten to the canonical single-level one,
  // so an old bookmark self-heals even if it somehow bypassed app.js.
  _syncHash() {
    let target = `#admin/${AdminTopochain._sub}`;
    // Season events' nested screens extend the address rather than
    // hiding behind it (see _readSeasonEventsDeepLink). The template id
    // is part of it because a prefilled form is a STATE — without the
    // segment the same URL reopens an empty one.
    if (AdminTopochain._sub === 'season-events' && AdminTopochain._se.detailId != null) {
      target += `/${AdminTopochain._se.detailId}`;
      if (AdminTopochain._ch.open) {
        target += '/new-challenge';
        if (AdminTopochain._ch.templateId) target += `/${AdminTopochain._ch.templateId}`;
      }
    }
    const h = location.hash;
    const own = h === `#admin/${AdminTopochain._sub}`
      || h.startsWith(`#admin/${AdminTopochain._sub}/`)
      || /^#admin\/(?:seasons|topochain)\//.test(h);
    if (own && h !== target) {
      history.replaceState(null, '', target);
    }
  },

  // The host holds just the screen content since #1179: the horizontal
  // sub-nav is gone — the console's own menu names every screen — so
  // there is nothing above the content node. The #admin-topo-content
  // wrapper survives because every screen renderer and several async
  // guards look it up by id.
  _renderShell() {
    const host = AdminTopochain._host;
    if (!host) return;
    host.innerHTML = '<div id="admin-topo-content"></div>';
    AdminTopochain._renderSub();
  },

  _renderSub() {
    const c = document.getElementById('admin-topo-content');
    if (!c) return;
    switch (AdminTopochain._sub) {
      case 'season-events': return AdminTopochain.renderSeasonEvents(c);
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
  // Seasons — full CRUD against /api/v4/admin/seasons, the top tier of
  // Season -> Season event -> Challenge. (Until that resource existed
  // this screen was a read-only view derived by grouping season-events
  // by season_id; see the file-header note.)
  //
  // Delete is guarded server-side: a season still referenced by events,
  // enrollments, onchain accounts or token allocations comes back 409
  // `season_in_use` with a message naming what is in the way, which is
  // surfaced verbatim rather than being second-guessed here.
  // ══════════════════════════════════════════════════════════════════

  _sn: {
    page: 1, perPage: 20, search: '', items: [], meta: null, error: null, editingId: null,
  },

  renderSeasons(host) {
    const canWrite = AdminTopochain.canWrite();
    const esc = AdminTopochain.esc;
    host.innerHTML = `
      ${AdminTopochain._screenHeader({
    title: 'Seasons',
    subtitle: 'The top tier: each season holds season events, which hold challenges.',
    actions: `<input id="admin-topo-sn-search" type="text" placeholder="Search name&hellip;"
            value="${esc(AdminTopochain._sn.search)}" aria-label="Search seasons"
            class="${FIELD_CLS} sm:w-56">
          ${canWrite ? `<button id="admin-topo-sn-new" type="button" class="${BTN.primarySm}">New season</button>` : ''}`,
  })}
      <div id="admin-topo-sn-form"></div>
      <div id="admin-topo-sn-table">${AdminTopochain._skeleton(4)}</div>
      <div id="admin-topo-sn-unassigned" class="mt-4"></div>`;
    document.getElementById('admin-topo-sn-search').addEventListener('change', (e) => {
      AdminTopochain._sn.search = e.target.value.trim();
      AdminTopochain._sn.page = 1;
      AdminTopochain._loadSeasons();
    });
    document.getElementById('admin-topo-sn-new')?.addEventListener('click', () => AdminTopochain._openSeasonForm(null));
    AdminTopochain._loadSeasons();
    AdminTopochain._loadUnassignedEvents();
  },

  async _loadSeasons() {
    const s = AdminTopochain._sn;
    const params = new URLSearchParams({ page: String(s.page), per_page: String(s.perPage) });
    if (s.search) params.set('search', s.search);
    const { ok, data, status } = await AdminTopochain.fetchJson(`/api/v4/admin/seasons?${params}`);
    if (AdminTopochain._sub !== 'seasons') return;
    if (ok && data?.success) {
      s.items = data.data;
      s.meta = data.meta;
      s.error = null;
    } else {
      s.items = [];
      s.meta = null;
      s.error = { status, message: (data && data.error) || null };
    }
    AdminTopochain._renderSeasonsTable();
  },

  _renderSeasonsTable() {
    const table = document.getElementById('admin-topo-sn-table');
    if (!table) return;
    const esc = AdminTopochain.esc;
    const canWrite = AdminTopochain.canWrite();
    const s = AdminTopochain._sn;
    if (s.error) {
      table.innerHTML = AdminTopochain._error({
        title: "Couldn't load seasons", status: s.error.status,
        message: s.error.message, retryId: 'admin-topo-sn-retry',
      });
      AdminTopochain._wireRetry('admin-topo-sn-retry', () => AdminTopochain._loadSeasons());
      return;
    }
    if (!s.items.length) {
      table.innerHTML = AdminTopochain._empty({
        title: s.search ? 'No seasons match that search' : 'No seasons yet',
        body: s.search ? 'Clear the search box to see every season.'
          : 'Create the first season, then add season events to it.',
        actionId: s.search ? null : 'admin-topo-sn-empty-new',
        actionLabel: 'New season',
      });
      document.getElementById('admin-topo-sn-empty-new')
        ?.addEventListener('click', () => AdminTopochain._openSeasonForm(null));
      return;
    }
    table.innerHTML = AdminTopochain._list({
      items: s.items,
      columns: [
        { label: 'Name', primary: true, cell: (sn) => esc(sn.name) },
        {
          label: 'Status',
          cell: (sn) => {
            const st = AdminTopochain._seasonStatus(sn);
            return AdminTopochain._badgeHtml(st.label, st.tone)
              + (sn.internal ? ` ${AdminTopochain._badgeHtml('Internal', 'violet')}` : '');
          },
        },
        { label: 'Starts', cell: (sn) => esc(AdminTopochain._fmt(sn.starts_at)), tdClass: 'text-xs text-gray-500' },
        { label: 'Ends', cell: (sn) => esc(AdminTopochain._fmt(sn.ends_at)), tdClass: 'text-xs text-gray-500' },
        { label: 'Events', cell: (sn) => (sn.season_events_count != null ? esc(sn.season_events_count) : '—'), tdClass: 'text-gray-500' },
        { label: 'Users', cell: (sn) => (sn.users_count != null ? esc(sn.users_count) : '—'), tdClass: 'text-gray-500' },
        { label: 'Order', cell: (sn) => esc(sn.display_order ?? 0), tdClass: 'text-gray-500' },
      ],
      actions: (sn) => `
        <button data-season-events="${sn.id}" type="button" class="${BTN.rowPrimary}">View events</button>
        ${canWrite ? `<button data-edit="${sn.id}" type="button" class="${BTN.row}">Edit</button>` : ''}
        ${canWrite ? `<button data-delete="${sn.id}" type="button" class="${BTN.rowDanger}">Delete</button>` : ''}`,
    }) + AdminTopochain._pagerHtml(s.meta, 'admin-topo-sn-pg');
    table.querySelectorAll('[data-season-events]').forEach((b) => b.addEventListener('click', () => {
      // Hand the Season events screen a pre-set filter rather than a
      // free-text search — season_id is an exact filter the API does
      // itself, so the list that opens is exactly this season's events.
      AdminTopochain._se.seasonFilter = b.dataset.seasonEvents;
      AdminTopochain._se.page = 1;
      AdminTopochain._se.detailId = null;
      AdminTopochain._gotoSub('season-events');
    }));
    table.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => AdminTopochain._openSeasonForm(parseInt(b.dataset.edit, 10))));
    table.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', () => AdminTopochain._deleteSeason(parseInt(b.dataset.delete, 10))));
    if (s.meta) AdminTopochain._wirePager(s.meta, 'admin-topo-sn-pg', (page) => { s.page = page; AdminTopochain._loadSeasons(); });
  },

  // Events with no season at all are invisible from the seasons list by
  // definition, and they are exactly the rows an admin needs to notice
  // (a new event nobody linked up yet). One extra request, rendered
  // only when the count is non-zero.
  async _loadUnassignedEvents() {
    const { ok, data } = await AdminTopochain.fetchJson(
      '/api/v4/admin/season-events?season_id=none&per_page=100');
    const host = document.getElementById('admin-topo-sn-unassigned');
    if (!host || AdminTopochain._sub !== 'seasons') return;
    if (!ok || !data?.success || !Array.isArray(data.data) || !data.data.length) {
      host.innerHTML = '';
      return;
    }
    const esc = AdminTopochain.esc;
    const rows = data.data.map((ev) => `
      <li class="flex flex-col gap-1 py-2 border-t border-gray-100 dark:border-gray-800 first:border-t-0 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2">
        <span class="text-sm">${esc(ev.name)} <span class="text-xs text-gray-500">(${esc(ev.type)})</span></span>
        <span class="text-xs text-gray-500">${esc(AdminTopochain._fmt(ev.starts_at))} &ndash; ${esc(AdminTopochain._fmt(ev.ends_at))}</span>
      </li>`).join('');
    host.innerHTML = `<section class="${PANEL_CLS} overflow-hidden">
      <header class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 dark:border-gray-800 px-4 py-3 sm:px-5">
        <div class="min-w-0">
          <h3 class="text-sm font-semibold">Events not assigned to a season</h3>
          <p class="mt-0.5 text-xs text-gray-500">${esc(String(data.data.length))} event${data.data.length === 1 ? '' : 's'} with no season. Edit one to link it.</p>
        </div>
        <button id="admin-topo-sn-unassigned-go" type="button" class="${BTN.secondarySm}">Show in Season events</button>
      </header>
      <ul class="px-4 py-2 sm:px-5">${rows}</ul>
    </section>`;
    document.getElementById('admin-topo-sn-unassigned-go')?.addEventListener('click', () => {
      AdminTopochain._se.seasonFilter = 'none';
      AdminTopochain._se.page = 1;
      AdminTopochain._se.detailId = null;
      AdminTopochain._gotoSub('season-events');
    });
  },

  async _openSeasonForm(id) {
    if (!AdminTopochain.canWrite()) return;
    AdminTopochain._sn.editingId = id;
    let sn = null;
    if (id != null) {
      const { ok, data } = await AdminTopochain.fetchJson(`/api/v4/admin/seasons/${encodeURIComponent(id)}`);
      if (ok && data?.success) sn = data.data;
    }
    const f = AdminTopochain._inputHtml, field = AdminTopochain._field;
    const iso = AdminTopochain._isoToLocalInput;
    const check = AdminTopochain._checkField;
    const host = document.getElementById('admin-topo-sn-form');
    if (!host) return;
    host.innerHTML = AdminTopochain._panel({
      title: id == null ? 'New season' : `Edit season #${id}`,
      subtitle: 'Name, window and visibility. Season events are attached from the Season events screen.',
      closeId: 'admin-topo-sn-close',
      closeLabel: 'Close the season form',
      body: `
        ${AdminTopochain._formGrid(`
          ${field('Name *', f('admin-topo-sn-f-name', { value: sn?.name }))}
          ${field('Display order', f('admin-topo-sn-f-display_order', { type: 'number', value: sn?.display_order ?? 0 }), 'Lowest first in the seasons list.')}
          ${field('Starts at *', f('admin-topo-sn-f-starts_at', { type: 'datetime-local', value: iso(sn?.starts_at) }))}
          ${field('Ends at *', f('admin-topo-sn-f-ends_at', { type: 'datetime-local', value: iso(sn?.ends_at) }))}
          <div class="md:col-span-2">${field('Pool info', f('admin-topo-sn-f-pool_info', { value: sn?.pool_info }), 'Free text shown with the reward pool, e.g. "1,000,000 TOPO".')}</div>
          <div class="md:col-span-2">${field('Description', AdminTopochain._textareaHtml('admin-topo-sn-f-description', sn?.description || '', 3))}</div>
        `)}
        <fieldset class="mt-5 border-t border-gray-200 dark:border-gray-800 pt-4">
          <legend class="sr-only">Visibility</legend>
          <p class="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Visibility</p>
          <div class="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            ${check('admin-topo-sn-f-is_active', 'Active', sn ? sn.is_active : true)}
            ${check('admin-topo-sn-f-internal', 'Internal', sn?.internal, 'Hidden from the public app; for dry runs.')}
          </div>
        </fieldset>
        ${AdminTopochain._formErrorSlot('admin-topo-sn-form-err')}`,
      footer: AdminTopochain._formActions('admin-topo-sn-save', 'admin-topo-sn-cancel', 'Save season'),
    });
    const closeForm = () => { host.innerHTML = ''; AdminTopochain._sn.editingId = null; };
    document.getElementById('admin-topo-sn-save').addEventListener('click', () => AdminTopochain._saveSeason());
    document.getElementById('admin-topo-sn-cancel').addEventListener('click', closeForm);
    document.getElementById('admin-topo-sn-close').addEventListener('click', closeForm);
  },

  async _saveSeason() {
    if (!AdminTopochain.canWrite()) return;
    const errEl = document.getElementById('admin-topo-sn-form-err');
    errEl.classList.add('hidden');
    const val = (id) => document.getElementById(id)?.value ?? '';
    const checked = (id) => !!document.getElementById(id)?.checked;
    const orderRaw = val('admin-topo-sn-f-display_order').trim();

    const body = {
      name: val('admin-topo-sn-f-name').trim(),
      description: val('admin-topo-sn-f-description').trim() || null,
      starts_at: AdminTopochain._localInputToIso(val('admin-topo-sn-f-starts_at')),
      ends_at: AdminTopochain._localInputToIso(val('admin-topo-sn-f-ends_at')),
      pool_info: val('admin-topo-sn-f-pool_info').trim() || null,
      display_order: orderRaw === '' ? 0 : Number(orderRaw),
      is_active: checked('admin-topo-sn-f-is_active'),
      internal: checked('admin-topo-sn-f-internal'),
    };
    if (!body.name) { errEl.textContent = 'Name is required.'; errEl.classList.remove('hidden'); return; }
    if (!body.starts_at || !body.ends_at) { errEl.textContent = 'Starts at and ends at are required.'; errEl.classList.remove('hidden'); return; }
    if (new Date(body.ends_at) <= new Date(body.starts_at)) {
      errEl.textContent = 'Ends at must be after starts at.';
      errEl.classList.remove('hidden');
      return;
    }

    const id = AdminTopochain._sn.editingId;
    const url = id == null ? '/api/v4/admin/seasons' : `/api/v4/admin/seasons/${encodeURIComponent(id)}`;
    const { ok, data } = await AdminTopochain.send(id == null ? 'POST' : 'PUT', url, body);
    if (!ok || !data?.success) {
      errEl.textContent = (data && data.error) || 'Save failed.';
      errEl.classList.remove('hidden');
      return;
    }
    document.getElementById('admin-topo-sn-form').innerHTML = '';
    AdminTopochain._sn.editingId = null;
    AdminTopochain._loadSeasons();
    AdminTopochain._loadUnassignedEvents();
  },

  async _deleteSeason(id) {
    if (!AdminTopochain.canWrite()) return;
    const confirmed = await AdminTopochain._confirm({
      title: 'Delete this season?',
      message: 'Seasons that still have events, enrollments, onchain accounts or token allocations cannot be deleted — unlink or remove those first. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    const res = await AdminTopochain.send('DELETE', `/api/v4/admin/seasons/${encodeURIComponent(id)}`);
    if (res.ok && res.data?.success) {
      AdminTopochain._loadSeasons();
      AdminTopochain._loadUnassignedEvents();
    } else {
      // The 409 body names exactly what still references the season;
      // show it as-is rather than a generic "Delete failed."
      AdminTopochain._alert((res.data && res.data.error) || 'Delete failed.');
    }
  },

  // ══════════════════════════════════════════════════════════════════
  // Season events — full CRUD. Challenges are managed in the nested
  // detail view (Manage button), not a separate top-level tab.
  // ══════════════════════════════════════════════════════════════════

  // `seasonFilter` is '' (all), 'none' (events with no season), or a
  // season id as a string — the three states the API's own `season_id`
  // query param accepts. The Seasons screen writes it before switching
  // tabs, which is why it lives on the state block rather than inside
  // renderSeasonEvents. `seasons` caches the picker options for the
  // filter and the form.
  _se: {
    page: 1, perPage: 20, search: '', seasonFilter: '', seasons: [], items: [], meta: null, formOpen: false, editingId: null, detailId: null,
  },

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
    actions: `${AdminTopochain._seasonFilterHtml()}
          <input id="admin-topo-se-search" type="text" placeholder="Search name&hellip;"
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
    AdminTopochain._wireSeasonFilter();
    document.getElementById('admin-topo-se-new')?.addEventListener('click', () => AdminTopochain._openSeasonEventForm(null));
    AdminTopochain._loadSeasonEvents();
    AdminTopochain._refreshSeasonPicker();
  },

  // The season filter, rendered from whatever is already cached in
  // `_se.seasons` so first paint isn't blocked on a second request;
  // _refreshSeasonPicker() fetches and re-renders it in place.
  _seasonFilterHtml() {
    const s = AdminTopochain._se;
    const options = [{ value: 'none', label: '— No season —' }, ...AdminTopochain._seasonOptions(s.seasons)];
    return `<label class="sr-only" for="admin-topo-se-season-filter">Filter by season</label>
      ${AdminTopochain._selectHtml('admin-topo-se-season-filter', options, s.seasonFilter, { blank: 'All seasons' })}`;
  },

  _wireSeasonFilter() {
    document.getElementById('admin-topo-se-season-filter')?.addEventListener('change', (e) => {
      AdminTopochain._se.seasonFilter = e.target.value;
      AdminTopochain._se.page = 1;
      AdminTopochain._loadSeasonEvents();
    });
  },

  // Loads the season list once per visit to this screen and re-renders
  // the filter <select> with it, keeping the current selection.
  async _refreshSeasonPicker() {
    const seasons = await AdminTopochain._fetchAllSeasons();
    if (AdminTopochain._sub !== 'season-events') return;
    AdminTopochain._se.seasons = seasons;
    const sel = document.getElementById('admin-topo-se-season-filter');
    if (!sel) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = AdminTopochain._seasonFilterHtml();
    const fresh = wrap.querySelector('#admin-topo-se-season-filter');
    if (!fresh) return;
    sel.innerHTML = fresh.innerHTML;
    sel.value = AdminTopochain._se.seasonFilter;
  },

  async _loadSeasonEvents() {
    const s = AdminTopochain._se;
    const params = new URLSearchParams({ page: String(s.page), per_page: String(s.perPage) });
    if (s.search) params.set('search', s.search);
    if (s.seasonFilter) params.set('season_id', s.seasonFilter);
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
      const filtered = !!(s.search || s.seasonFilter);
      table.innerHTML = AdminTopochain._empty({
        title: filtered ? 'No events match these filters' : 'No season events yet',
        body: filtered ? 'Clear the search box and the season filter to see every event.'
          : 'Create the first event to start scheduling challenges.',
        actionId: filtered ? null : 'admin-topo-se-empty-new',
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
        {
          label: 'Season',
          // The API sends the joined season object; fall back to the raw
          // id so a row still says something if the join ever comes back
          // empty (e.g. an older cached response).
          cell: (ev) => (ev.season?.name ? esc(ev.season.name)
            : (ev.season_id != null ? `#${esc(ev.season_id)}` : '—')),
          tdClass: 'text-gray-500',
        },
        { label: 'Type', cell: (ev) => esc(ev.type), tdClass: 'text-gray-500' },
        { label: 'Active', cell: (ev) => (ev.is_active ? '<span class="text-green-600 dark:text-green-400">yes</span>' : '—') },
        { label: 'Starts', cell: (ev) => esc(AdminTopochain._fmt(ev.starts_at)), tdClass: 'text-xs text-gray-500' },
        { label: 'Ends', cell: (ev) => esc(AdminTopochain._fmt(ev.ends_at)), tdClass: 'text-xs text-gray-500' },
        { label: 'Users', cell: (ev) => (ev.users_count != null ? esc(ev.users_count) : '—'), tdClass: 'text-gray-500' },
      ],
      actions: (ev) => `
        <button data-manage="${ev.id}" type="button" class="${BTN.rowPrimary}">Manage</button>
        ${canWrite ? `<button data-edit="${ev.id}" type="button" class="${BTN.row}">Edit</button>` : ''}
        ${canWrite ? `<button data-delete="${ev.id}" type="button" class="${BTN.rowDanger}">Delete</button>` : ''}`,
    }) + AdminTopochain._pagerHtml(s.meta, 'admin-topo-se-pg');
    table.querySelectorAll('[data-manage]').forEach((b) => b.addEventListener('click', () => {
      AdminTopochain._se.detailId = parseInt(b.dataset.manage, 10);
      AdminTopochain._ch.open = false;
      AdminTopochain._syncHash();
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
    // Season is a real resource now, so the form picks one by name
    // instead of asking an admin to type its numeric id.
    const seasons = await AdminTopochain._fetchAllSeasons();
    AdminTopochain._se.seasons = seasons;
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
          ${field('Season', sel('admin-topo-se-f-season_id', AdminTopochain._seasonOptions(seasons), ev?.season_id ?? '', { blank: '— No season —' }), 'Manage the list on the Seasons screen.')}
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
        <fieldset class="mt-5 border-t border-gray-200 dark:border-gray-800 pt-4">
          <legend class="sr-only">Visibility</legend>
          <p class="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Visibility</p>
          <div class="grid grid-cols-1 gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
            ${check('admin-topo-se-f-is_active', 'Active', ev ? ev.is_active : true)}
            ${check('admin-topo-se-f-internal', 'Internal', ev?.internal)}
            ${check('admin-topo-se-f-display_leaderboard', 'Show leaderboard', ev ? ev.display_leaderboard : true)}
            ${check('admin-topo-se-f-display_disclaimer', 'Show disclaimer', ev?.display_disclaimer)}
            ${check('admin-topo-se-f-display_activities', 'Show activities', ev?.display_activities)}
          </div>
        </fieldset>
        <div class="grid grid-cols-1 gap-4 mt-5 border-t border-gray-200 dark:border-gray-800 pt-4">
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
      AdminTopochain._ch.open = false;
      AdminTopochain._syncHash();
      AdminTopochain._renderSub();
    });
    document.getElementById('admin-topo-ch-new')?.addEventListener('click', () => AdminTopochain._openChallengeForm(null));
    // A /new-challenge deep link (and a re-render while the form is open)
    // reopens it, on the template the address names. Gated by canWrite
    // like the button itself — _openChallengeForm returns early for a
    // view-only admin, so the segment is simply inert for them.
    if (AdminTopochain._ch.open) {
      const pending = AdminTopochain._ch.pendingTemplateId;
      AdminTopochain._ch.pendingTemplateId = null;
      AdminTopochain._openChallengeForm(null, { templateId: pending });
    }

    const { ok, data, status } = await AdminTopochain.fetchJson(`/api/v4/admin/season-events/${encodeURIComponent(id)}`);
    const hero = document.getElementById('admin-topo-se-detail-hero');
    if (hero) {
      if (ok && data?.success) {
        const ev = data.data;
        const stat = (label, value) => `<div class="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2">
            <dt class="text-[11px] uppercase tracking-wide text-gray-400 dark:text-gray-500">${esc(label)}</dt>
            <dd class="mt-0.5 text-sm font-medium">${esc(value)}</dd>
          </div>`;
        hero.innerHTML = `<section class="${PANEL_CLS} px-4 py-4 sm:px-5">
          <h2 class="text-base font-semibold sm:text-lg">${esc(ev.name)}</h2>
          <p class="mt-0.5 text-xs text-gray-500">${esc(AdminTopochain._fmt(ev.starts_at))} &ndash; ${esc(AdminTopochain._fmt(ev.ends_at))}</p>
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
        { label: 'Kind', cell: (c) => esc(c.card_preview?.label || ''), tdClass: 'text-xs text-gray-500' },
        { label: 'Enabled', cell: (c) => (c.enabled ? '<span class="text-green-600 dark:text-green-400">enabled</span>' : '<span class="text-gray-400">disabled</span>') },
        { label: 'Completed', cell: (c) => (c.completed ? 'completed' : '—'), tdClass: 'text-gray-500' },
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
        body: '<p class="text-sm text-gray-500">There is no other event to move this challenge to.</p>',
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

  // ── Challenge form state + the template-driven prefill ──────────────
  //
  // `templates` caches the FULL template objects behind the picker (the
  // options only carry an id and a label, and the prefill needs every
  // field). `open` and `templateId` are what _syncHash writes into the
  // address; `pendingTemplateId` is what a deep link asked for, spent
  // once by the form that opens.
  _ch: {
    templates: [], templateId: '', open: false, pendingTemplateId: null,
  },

  // Every field the Add-challenge form fills from the picked template.
  // `id` is BOTH the `admin-topo-ch-f-<id>` input suffix and the key on
  // the template projection (formatTemplate in
  // src/routes/topochain/challenge-view.js) — which is also the key the
  // POST body writes back, so one list drives the render, the prefill
  // and the save and they cannot drift apart. `type` is only about how
  // the value crosses the DOM boundary.
  _CH_TEMPLATE_FIELDS: [
    { id: 'goal' }, { id: 'reward' }, { id: 'kind' },
    { id: 'schedule_start', type: 'date' }, { id: 'schedule_end', type: 'date' },
    { id: 'cta_button' }, { id: 'cta_label' }, { id: 'cta_type' }, { id: 'cta_link' },
    { id: 'mobile_cta_label' }, { id: 'mobile_cta_type' }, { id: 'mobile_cta_link' },
    { id: 'metric_type' }, { id: 'metric_label' }, { id: 'metric_target', type: 'number' },
    { id: 'task' }, { id: 'description' }, { id: 'requirements' }, { id: 'reward_logic' },
  ],

  // The subset the EDIT form shows and saves. The challenges list is the
  // only source an edit has, and it reports back exactly the override
  // keys (buildChallengeListItem's `overrides`) — so the edit form stays
  // on them. Rendering the rest there would show the TEMPLATE's values
  // in fields that save as challenge-level overrides, quietly freezing
  // them into the event on the next save.
  _CH_EDIT_FIELDS: ['goal', 'reward', 'kind', 'task', 'description'],

  // Write one value into a live control AND into the markup that
  // serialises it: `.value` alone leaves the DOM's own attributes still
  // showing the empty form, so a prefilled field is invisible to
  // anything reading attributes (a snapshot, a selector assertion).
  // Default value first, live value last, so the live one wins whatever
  // the element type does with the other.
  _setFieldValue(el, value) {
    if (el.tagName === 'TEXTAREA') el.textContent = value;
    else if (el.tagName === 'SELECT') {
      Array.from(el.options || []).forEach((o) => {
        if (String(o.value) === String(value)) o.setAttribute('selected', 'selected');
        else o.removeAttribute('selected');
      });
    } else el.setAttribute('value', value);
    el.value = value;
  },

  // Fill the whole Add-challenge form from one template. Runs on EVERY
  // `change` of the picker, not just the first, and writes every field
  // in _CH_TEMPLATE_FIELDS unconditionally: a template that leaves a
  // field null clears the input rather than skipping it, so nothing the
  // previously-picked template put there can survive the switch. Fields
  // the template has no say in (display order) are the operator's and
  // are deliberately left alone.
  _applyChallengeTemplate(templateId) {
    const t = AdminTopochain._templateById(templateId);
    AdminTopochain._ch.templateId = t ? String(t.id) : '';
    for (const f of AdminTopochain._CH_TEMPLATE_FIELDS) {
      const el = document.getElementById(`admin-topo-ch-f-${f.id}`);
      if (!el) continue;
      AdminTopochain._setFieldValue(el, AdminTopochain._templateFieldText(t, f));
    }
    const host = document.getElementById('admin-topo-ch-form');
    if (host) host.dataset.templateApplied = AdminTopochain._ch.templateId;
    AdminTopochain._syncHash();
  },

  _templateById(templateId) {
    return (AdminTopochain._ch.templates || [])
      .find((x) => String(x.id) === String(templateId)) || null;
  },

  // What one template field looks like IN the form. Shared by the fill and
  // by the save below, which compares against it — if these two ever
  // disagreed, every untouched field would read as operator-edited.
  _templateFieldText(t, f) {
    const raw = t ? t[f.id] : null;
    if (raw == null) return '';
    return f.type === 'date' ? AdminTopochain._isoToLocalInput(raw) : String(raw);
  },

  async _openChallengeForm(challengeId, opts = {}) {
    if (!AdminTopochain.canWrite()) {
      // Keeps a view-only admin's address honest: the /new-challenge
      // segment can be typed, but nothing opens, so it must not persist.
      AdminTopochain._ch.open = false;
      AdminTopochain._ch.templateId = '';
      AdminTopochain._syncHash();
      return;
    }
    const eventId = AdminTopochain._se.detailId;
    const existing = challengeId != null ? (AdminTopochain._challenges || []).find((c) => String(c.id) === String(challengeId)) : null;
    const f = AdminTopochain._inputHtml, sel = AdminTopochain._selectHtml, field = AdminTopochain._field;
    const section = AdminTopochain._formSection;
    let host = document.getElementById('admin-topo-ch-form');
    if (!host) return;

    let templateOptions = [];
    AdminTopochain._ch.templates = [];
    // Held across the await below, so the address keeps naming the template
    // this form is opening WITH rather than briefly falling back to none.
    AdminTopochain._ch.templateId = opts.templateId == null ? '' : String(opts.templateId);
    AdminTopochain._ch.open = !existing;
    if (!existing) {
      const { ok, data } = await AdminTopochain.fetchJson(
        `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges/available-activity-types`);
      if (ok && data?.success) {
        // The full rows are kept, not just the option pair: they ARE the
        // prefill source.
        AdminTopochain._ch.templates = data.data;
        templateOptions = data.data.map((t) => ({ value: t.id, label: `${t.category}: ${t.goal}` }));
      }
      // The event detail may have re-rendered while that request was in
      // flight (a deep link renders it twice), which detaches the div we
      // captured. Writing the form into the orphan would leave no buttons
      // in the document and throw on the wiring below, so re-resolve and
      // let the newer call own the screen.
      host = document.getElementById('admin-topo-ch-form');
      if (!host) return;
    }
    const ov = existing?.overrides || {};
    const ctaOptions = ['', 'url', 'app'].map((v) => ({ value: v, label: v || '(none)' }));
    // Two bodies, because the two modes have different sources of truth:
    // create fills from the template (so it shows everything the template
    // defines), edit shows the per-event overrides the API reports back.
    const editBody = `
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
        ${AdminTopochain._formErrorSlot('admin-topo-ch-form-err')}`;
    const createBody = `
        <div class="mb-4">${field('Challenge template *',
    sel('admin-topo-ch-f-template', templateOptions, '', { blank: 'Choose a template…' }),
    templateOptions.length
      ? 'Picking a template fills in every field below with its values; switching template fills them in again.'
      : 'No unused Challenge templates are available for this event — create one in the Challenge templates tab first.')}</div>
        ${AdminTopochain._formGrid(`
          ${field('Goal', f('admin-topo-ch-f-goal'))}
          ${field('Reward', f('admin-topo-ch-f-reward'))}
          ${field('Kind', f('admin-topo-ch-f-kind'), 'No admin listing endpoint exists for Kinds (documented gap) — must match an existing challenge_kinds id.')}
          ${field('Display order', f('admin-topo-ch-f-display_order', { type: 'number', min: 0, value: 0 }), 'Not part of a template — where this challenge sits in the event.')}
          ${field('Schedule start', f('admin-topo-ch-f-schedule_start', { type: 'datetime-local' }))}
          ${field('Schedule end', f('admin-topo-ch-f-schedule_end', { type: 'datetime-local' }))}
        `)}
        ${section('Call to action')}
        ${AdminTopochain._formGrid(`
          ${field('CTA button label', f('admin-topo-ch-f-cta_button'))}
          ${field('CTA label', f('admin-topo-ch-f-cta_label'))}
          ${field('CTA type', sel('admin-topo-ch-f-cta_type', ctaOptions, ''))}
          ${field('CTA link', f('admin-topo-ch-f-cta_link'))}
          ${field('Mobile CTA label', f('admin-topo-ch-f-mobile_cta_label'))}
          ${field('Mobile CTA type', sel('admin-topo-ch-f-mobile_cta_type', ctaOptions, ''))}
          ${field('Mobile CTA link', f('admin-topo-ch-f-mobile_cta_link'))}
        `)}
        ${section('Metric')}
        ${AdminTopochain._formGrid(`
          ${field('Metric type', f('admin-topo-ch-f-metric_type'))}
          ${field('Metric label', f('admin-topo-ch-f-metric_label'))}
          ${field('Metric target', f('admin-topo-ch-f-metric_target', { type: 'number', step: '0.01' }))}
        `, 3)}
        ${section('Copy')}
        <div class="grid grid-cols-1 gap-4">
          ${field('Task', AdminTopochain._textareaHtml('admin-topo-ch-f-task', '', 3))}
          ${field('Description', AdminTopochain._textareaHtml('admin-topo-ch-f-description', '', 3))}
          ${field('Requirements', AdminTopochain._textareaHtml('admin-topo-ch-f-requirements', '', 3))}
          ${field('Reward logic', AdminTopochain._textareaHtml('admin-topo-ch-f-reward_logic', '', 3))}
        </div>
        ${AdminTopochain._formErrorSlot('admin-topo-ch-form-err')}`;
    host.innerHTML = AdminTopochain._panel({
      title: existing ? 'Edit challenge' : 'Add challenge',
      subtitle: existing
        ? 'Overrides apply to this event only; the template is untouched.'
        : 'Pick a template to fill the form in, then change anything that should differ for this event. Nothing here is written back to the template.',
      closeId: 'admin-topo-ch-close',
      closeLabel: 'Close the challenge form',
      body: existing ? editBody : createBody,
      footer: AdminTopochain._formActions('admin-topo-ch-save', 'admin-topo-ch-cancel', 'Save challenge'),
    });
    const closeForm = () => {
      host.innerHTML = '';
      AdminTopochain._ch.open = false;
      AdminTopochain._ch.templateId = '';
      AdminTopochain._syncHash();
    };
    if (!existing) {
      const picker = document.getElementById('admin-topo-ch-f-template');
      picker?.addEventListener('change', (e) => AdminTopochain._applyChallengeTemplate(e.target.value));
      // A deep-linked template is applied exactly as if it had just been
      // picked, so the address and the form always agree.
      const pre = opts.templateId == null ? '' : String(opts.templateId);
      if (picker && pre && AdminTopochain._ch.templates.some((t) => String(t.id) === pre)) {
        AdminTopochain._setFieldValue(picker, pre);
        AdminTopochain._applyChallengeTemplate(pre);
      } else {
        AdminTopochain._syncHash();
      }
    }
    document.getElementById('admin-topo-ch-save').addEventListener('click', () => AdminTopochain._saveChallenge(eventId, challengeId));
    document.getElementById('admin-topo-ch-cancel').addEventListener('click', closeForm);
    document.getElementById('admin-topo-ch-close').addEventListener('click', closeForm);
  },

  async _saveChallenge(eventId, challengeId) {
    if (!AdminTopochain.canWrite()) return;
    const errEl = document.getElementById('admin-topo-ch-form-err');
    errEl.classList.add('hidden');
    const val = (id) => (document.getElementById(`admin-topo-ch-f-${id}`)?.value ?? '').trim();
    const isCreate = challengeId == null;
    const body = { display_order: Number(val('display_order') || 0) };
    // These columns are per-event OVERRIDES of the template, and null means
    // "keep inheriting". So create sends only what the operator actually
    // changed away from the prefilled value: a field left exactly as the
    // template filled it stays null and keeps tracking the template, which
    // is what a challenge created before the prefill existed did. Sending
    // the whole form back would freeze a copy of the template into every
    // new challenge and quietly stop later template edits reaching it.
    // Edit stays on _CH_EDIT_FIELDS — the only values that form was given,
    // hence the only ones it may write.
    const tpl = isCreate ? AdminTopochain._templateById(AdminTopochain._ch.templateId) : null;
    for (const fld of AdminTopochain._CH_TEMPLATE_FIELDS) {
      if (!isCreate && !AdminTopochain._CH_EDIT_FIELDS.includes(fld.id)) continue;
      const raw = val(fld.id);
      if (isCreate && raw === AdminTopochain._templateFieldText(tpl, fld).trim()) {
        body[fld.id] = null;
        continue;
      }
      if (fld.type === 'date') body[fld.id] = AdminTopochain._localInputToIso(raw);
      else if (fld.type === 'number') body[fld.id] = raw === '' ? null : Number(raw);
      else body[fld.id] = raw || null;
    }
    let url = `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges`;
    let method = 'POST';
    if (isCreate) {
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
    AdminTopochain._ch.open = false;
    AdminTopochain._ch.templateId = '';
    AdminTopochain._syncHash();
    AdminTopochain._loadChallenges(eventId);
  },

  // ══════════════════════════════════════════════════════════════════
  // Users — full CRUD + toggle-exclude-podium + import-csv + export-csv.
  // accept_logs also lives here (mobile-logs gap — see file header).
  // ══════════════════════════════════════════════════════════════════

  _users: { page: 1, perPage: 50, search: '', items: [], meta: null, editingId: null, deleteConfirm: null },

  // Rendered INSIDE the console's Users section since #1179 (one Users
  // menu entry, both user surfaces) — admin-console.js's
  // renderUsersSection hands this a host below the platform-accounts
  // card and sets _sub = 'users' first, because the loaders below use
  // _sub as their stale-response guard. Not a SUBS screen of its own.
  renderUsers(host) {
    const canWrite = AdminTopochain.canWrite();
    const esc = AdminTopochain.esc;
    host.innerHTML = `
      ${AdminTopochain._screenHeader({
    title: 'Programme users',
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
        { label: 'Email', cell: (u) => esc(u.email || '—'), tdClass: 'text-xs text-gray-500' },
        { label: 'Telegram', cell: (u) => esc(u.telegram || '—'), tdClass: 'text-xs text-gray-500' },
        { label: 'Discord', cell: (u) => esc(u.discord || '—'), tdClass: 'text-xs text-gray-500' },
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
        class="w-full rounded-lg bg-white dark:bg-gray-900 border border-red-300 dark:border-red-800 px-3 py-2 text-xs font-mono min-h-[44px] sm:min-h-[36px] focus:outline-none focus:ring-2 focus:ring-red-500 sm:max-w-sm">
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
        <div class="mt-4 border-t border-gray-200 dark:border-gray-800 pt-3">
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
        <div class="mt-3 border-t border-gray-200 dark:border-gray-800 pt-3">
          ${AdminTopochain._checkField('admin-topo-u-imp-link', 'Link onchain accounts too', false)}
        </div>
        <div class="mt-3">${AdminTopochain._formGrid(`
          ${field('Min balance', AdminTopochain._inputHtml('admin-topo-u-imp-min', { type: 'number', min: 0 }))}
          ${field('Max balance', AdminTopochain._inputHtml('admin-topo-u-imp-max', { type: 'number', min: 0 }))}
        `)}</div>
        ${AdminTopochain._formErrorSlot('admin-topo-u-imp-err')}
        <div id="admin-topo-u-imp-result" class="mt-3 text-xs text-gray-500"></div>`,
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
        body: '<p class="text-sm text-gray-500">There is no event to export users for yet.</p>',
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
            : ' <span class="text-gray-400 text-xs" title="Never followed the confirm link in the join email — this address is unproven">unconfirmed</span>'}`,
        },
        { label: 'Joined', cell: (w) => esc(AdminTopochain._fmt(w.submitted_at)), tdClass: 'text-xs text-gray-500' },
        {
          label: 'Account',
          cell: (w) => (w.linked_username
            ? `${esc(w.linked_username)}${w.has_platform_access ? ' <span class="text-emerald-600 dark:text-emerald-400 text-xs">(has access)</span>' : ''}`
            : '<span class="text-gray-400">no account yet</span>'),
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
          <summary class="cursor-pointer select-none text-gray-500 min-h-[36px] flex items-center">Survey answers</summary>
          <div class="mt-1 space-y-0.5 text-gray-600 dark:text-gray-300">${AdminTopochain._wlAnswersHtml(w.answers)}</div>
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
      if (value) lines.push(`<div><span class="text-gray-400">${esc(label)}:</span> ${value}</div>`);
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
      line('Invites', esc(a.invites.join(', ')) + (a.admit_together ? ' <span class="text-gray-400">(only together)</span>' : ''));
    } else if (a.admit_together) {
      line('Invites', '<span class="text-gray-400">only together</span>');
    }
    return lines.join('') || '<div class="text-gray-400">No survey answers.</div>';
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
        { label: 'Email', cell: (u) => esc(u.email || '—'), tdClass: 'text-xs text-gray-500 font-mono' },
        { label: 'Requested', cell: (u) => esc(AdminTopochain._fmt(u.bp_requested_at)), tdClass: 'text-xs text-gray-500' },
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
        { label: 'Tier', cell: (a) => esc(a.tier), tdClass: 'text-gray-500' },
        { label: 'Amount', cell: (a) => esc(a.amount), tdClass: 'font-mono text-right', thClass: 'text-right' },
        { label: 'Event', cell: (a) => (a.event ? esc(a.event.name) : '—'), tdClass: 'text-xs text-gray-500' },
        { label: 'Status', cell: (a) => (a.is_used ? '<span class="text-amber-600 dark:text-amber-400">used</span>' : '<span class="text-green-600 dark:text-green-400">free</span>') },
        { label: 'User', cell: (a) => (a.user ? esc(a.user.username) : '—'), tdClass: 'text-xs text-gray-500' },
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
        <div id="admin-topo-oa-imp-result" class="mt-3 text-xs text-gray-500"></div>`,
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
        { label: 'Event', cell: (a) => esc(a.event?.name || a.season_event_id), tdClass: 'text-xs text-gray-500' },
        { label: 'Challenge', cell: (a) => esc(a.challenge?.goal || '—'), tdClass: 'text-xs text-gray-500' },
        { label: 'Type', cell: (a) => esc(a.activity_type), tdClass: 'text-xs' },
        { label: 'Points', cell: (a) => esc(a.points), tdClass: 'font-mono text-right', thClass: 'text-right' },
        { label: 'At', cell: (a) => esc(AdminTopochain._fmt(a.activity_at)), tdClass: 'text-xs text-gray-500' },
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
        <div id="admin-topo-act-imp-result" class="mt-3 text-xs text-gray-500"></div>`,
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
        <tr class="border-t border-gray-200 dark:border-gray-800">
          <td class="px-2 py-1 text-xs">${esc(t.user.display_name || t.user.email || t.user.id)}</td>
          <td class="px-2 py-1 text-xs font-mono text-right">${esc(t.total_points)}</td>
          <td class="px-2 py-1 text-xs font-mono text-right">${esc(t.total_activities)}</td>
        </tr>`).join('');
      const typeRows = d.type_totals.map((t) => `
        <tr class="border-t border-gray-200 dark:border-gray-800">
          <td class="px-2 py-1 text-xs">${esc(t.activity_type)}</td>
          <td class="px-2 py-1 text-xs font-mono text-right">${esc(t.count)}</td>
          <td class="px-2 py-1 text-xs font-mono text-right">${esc(t.total_points)}</td>
          <td class="px-2 py-1 text-xs font-mono text-right">${esc(t.unique_users)}</td>
        </tr>`).join('');
      const stat = (label, value) => `<div class="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2">
          <dt class="text-[11px] uppercase tracking-wide text-gray-400 dark:text-gray-500">${esc(label)}</dt>
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
            <div class="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">By user (top 50)</div>
            <table class="w-full"><thead class="text-xs text-gray-500"><tr><th class="text-left px-2">User</th><th class="text-right px-2">Points</th><th class="text-right px-2">Count</th></tr></thead><tbody>${userRows}</tbody></table></div>
          <div class="min-w-0 overflow-x-auto">
            <div class="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">By type</div>
            <table class="w-full"><thead class="text-xs text-gray-500"><tr><th class="text-left px-2">Type</th><th class="text-right px-2">Count</th><th class="text-right px-2">Points</th><th class="text-right px-2">Users</th></tr></thead><tbody>${typeRows}</tbody></table></div>
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
        { label: 'Category', cell: (t) => esc(t.category), tdClass: 'text-xs text-gray-500' },
        { label: 'Reward', cell: (t) => esc(t.reward), tdClass: 'text-gray-500' },
        { label: 'Kind', cell: (t) => esc(t.kind || '—'), tdClass: 'text-xs text-gray-500' },
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
    const section = AdminTopochain._formSection;
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
      <div class="text-gray-500 mt-1">
        Sending as <code class="font-mono text-xs">${esc(m.from || '(unset)')}</code>${
  m.usingDefaultFrom ? ' <span class="text-gray-400">(built-in default)</span>' : ''}
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
          <span class="text-gray-500"> — login codes and waitlist confirmations are being sent
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
    return 'text-gray-500';
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
      <tr class="border-t border-gray-100 dark:border-gray-800">
        <td class="py-1.5 pr-3 whitespace-nowrap text-gray-500">${esc(
    r.created_at ? String(r.created_at).replace('T', ' ').slice(0, 19) : '')}</td>
        <td class="py-1.5 pr-3 whitespace-nowrap">${esc(r.kind || '')}</td>
        <td class="py-1.5 pr-3">${esc(r.recipient || '')}</td>
        <td class="py-1.5 pr-3 whitespace-nowrap text-gray-500">${esc(r.provider || '—')}</td>
        <td class="py-1.5 pr-3 whitespace-nowrap font-medium ${
  AdminTopochain._mailStatusClass(r.status)}">${esc(r.status || '')}</td>
        <td class="py-1.5 text-gray-500">${esc(r.error || '')}</td>
      </tr>`).join('');

    host.innerHTML = `
      <div class="${PANEL_CLS} px-4 py-3 sm:px-5">
        <div class="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-2">
          <h3 class="text-sm font-semibold">Recent email activity</h3>
          <span class="text-xs text-gray-500">${totals ? `last 24h: ${totals}` : 'nothing in the last 24h'}</span>
        </div>
        ${recent.length ? `
        <div class="overflow-x-auto mt-3 -mx-4 px-4 sm:mx-0 sm:px-0">
          <table class="w-full text-xs">
            <thead class="text-gray-500">
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
    : '<p class="text-sm text-gray-500 mt-2">No mail has been attempted yet.</p>'}
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
        { label: 'Description', cell: (s) => esc(s.description || '—'), tdClass: 'text-xs text-gray-500' },
        { label: 'Updated', cell: (s) => esc(AdminTopochain._fmt(s.updated_at)), tdClass: 'text-xs text-gray-500' },
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
        <p class="text-xs text-gray-500 mt-4">
          No version checks in the last ${esc(a.window_days ?? 7)} days — no app
          build has asked this platform whether it needs to update.
        </p>`;
      return;
    }
    const rows = (a.by_os || []).map((r) => `
      <tr class="border-t border-gray-200 dark:border-gray-800">
        <td class="px-3 py-1.5 text-sm">${esc(r.os || '—')}</td>
        <td class="px-3 py-1.5 text-sm">${esc(UPGRADE_LABEL[r.upgrade] || r.upgrade)}</td>
        <td class="px-3 py-1.5 text-sm font-mono text-right">${esc(r.count)}</td>
      </tr>`).join('');
    host.innerHTML = `
      <h3 class="text-sm font-semibold mt-8 mb-3">
        Version checks &middot; last ${esc(a.window_days ?? 7)} days
        <span class="font-normal text-gray-500">(${esc(a.total)} total)</span>
      </h3>
      <div class="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
        <table class="w-full">
          <thead class="bg-gray-50 dark:bg-gray-900 text-xs uppercase tracking-wide text-gray-500">
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
        { label: 'Current version', cell: (c) => esc(c.current_version || '—'), tdClass: 'text-xs text-gray-500' },
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
              <label class="flex items-center gap-2 text-xs text-gray-500">
                <span>Limit</span>
                <input id="admin-topo-sql-limit" type="number" min="1" max="1000" value="100"
                  class="w-24 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs font-mono min-h-[44px] sm:min-h-[36px] focus:outline-none focus:ring-2 focus:ring-indigo-500">
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
    subtitle: 'Every table in the app database, including the auth and push tables. Credential columns are hidden. Click one to draft a SELECT.',
    // The list covers the whole schema now (~108 tables — every base
    // table in `public`, not the original 20 topochain ones and no longer
    // minus the 20 credential-bearing ones #1130 was filed about), so a
    // filter box is the difference between a browsable panel and a
    // scroll. Filtering is client-side over the already-fetched schema —
    // no request per keystroke.
    body: `
              <input id="admin-topo-sql-schema-filter" type="search" placeholder="Filter tables&hellip;"
                aria-label="Filter tables" autocomplete="off" class="${FIELD_CLS} mb-2">
              <p id="admin-topo-sql-schema-count" class="mb-1 text-xs text-zinc-500" role="status"></p>
              <div id="admin-topo-sql-schema" class="space-y-1 max-h-96 overflow-y-auto">${AdminTopochain._skeleton(3)}</div>`,
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
    if (!ok || !data?.success) { host.innerHTML = '<p class="text-xs text-gray-500">Unavailable.</p>'; return; }
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
    if (!ok || !data?.success) { host.innerHTML = '<p class="text-xs text-gray-500">Unavailable.</p>'; return; }
    // Server order is already alphabetical across the whole schema
    // (db-console-scope.js sorts it); don't re-sort, just render.
    AdminTopochain._sql.schema = data.data;
    AdminTopochain._renderSqlSchemaList('');
    const filter = document.getElementById('admin-topo-sql-schema-filter');
    if (filter) {
      filter.addEventListener('input', () => AdminTopochain._renderSqlSchemaList(filter.value));
    }
  },

  // Renders (or re-renders) the schema list, optionally narrowed to
  // tables whose name contains `term`. Indexes into `_sql.schema` are
  // kept as the button's `data-table` so the click handler never has to
  // re-resolve a name against the filtered view.
  _renderSqlSchemaList(term) {
    const host = document.getElementById('admin-topo-sql-schema');
    if (!host) return;
    const esc = AdminTopochain.esc;
    const all = AdminTopochain._sql.schema || [];
    const needle = String(term || '').trim().toLowerCase();
    const shown = all
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => !needle || t.name.toLowerCase().includes(needle));

    const count = document.getElementById('admin-topo-sql-schema-count');
    if (count) {
      count.textContent = needle
        ? `${shown.length} of ${all.length} tables`
        : `${all.length} tables`;
    }

    if (!shown.length) {
      host.innerHTML = '<p class="text-xs text-zinc-500">No table matches that filter.</p>';
      return;
    }
    host.innerHTML = shown.map(({ t, i }) => `
      <button data-table="${i}" type="button" title="${esc(t.comment || '')}"
        class="${BTN.sidebar} font-mono justify-between gap-2">
        <span class="truncate">${esc(t.name)}</span>
        <span class="shrink-0 text-zinc-400 dark:text-zinc-500">${t.columns.length}</span>
      </button>`).join('');
    host.querySelectorAll('[data-table]').forEach((b) => b.addEventListener('click', () => {
      const t = AdminTopochain._sql.schema[parseInt(b.dataset.table, 10)];
      // Never `SELECT *` — the console rejects bare wildcards; list the
      // table's own columns explicitly instead so the inserted query is
      // guaranteed to pass validation as-is. `t.columns` is already
      // redaction-filtered server-side, so a credential column is never
      // in the drafted query either.
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
    result.innerHTML = note('bg-gray-100 dark:bg-gray-800 text-gray-500', 'Running&hellip;');
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
      <tr class="border-t border-gray-200 dark:border-gray-800">
        ${cols.map((c) => `<td class="px-2 py-1 text-xs font-mono whitespace-nowrap">${esc(row[c] == null ? '' : String(row[c]))}</td>`).join('')}
      </tr>`).join('');
    // Deliberately NOT the shared _list() card/table pair: the columns
    // here are whatever the query returned, so there is no primary
    // column to title a card with and no stable label set. A scrolling
    // result grid is the right shape for arbitrary SQL output, on a
    // phone as much as anywhere.
    result.innerHTML = `
      <p class="text-xs text-gray-500 mb-2 mt-3">${esc(data.row_count)} row(s)${data.limited ? ' (truncated to the limit)' : ''} in ${esc(data.execution_time_ms)} ms</p>
      <div class="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
        <table class="w-full">
          <thead class="bg-gray-50 dark:bg-gray-900 text-xs uppercase tracking-wide text-gray-500">
            <tr>${cols.map((c) => `<th class="px-2 py-1 text-left">${esc(c)}</th>`).join('')}</tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  },

  // ══════════════════════════════════════════════════════════════════
  // API tester — pick an endpoint (or "Custom…"), method + JSON body,
  // same-origin fetch.
  //
  // The endpoint list is NOT hardcoded here: it comes from
  // GET /api/v4/admin/api-catalog, which introspects Express's own router
  // stack server-side, so the select always offers exactly the routes this
  // build mounted. (It used to be a single placeholder path,
  // `/season-events`, which isn't even a mounted route — the real one is
  // `/admin/season-events` — so the tool only worked for an operator who
  // already knew the surface.)
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

  // Sentinel <option> value for "I'll type the path myself". Not a legal
  // catalog entry (every real one is `METHOD /path`), so it can never
  // collide with a route.
  API_CUSTOM: '__custom__',

  // Filled by _loadApiCatalog(); `null` until the first fetch settles.
  _apiCatalog: null,

  renderApiTester(host) {
    host.innerHTML = `
      ${AdminTopochain._screenHeader({
    title: 'API tester',
    subtitle: 'Same-origin requests sent with your own session — the platform still applies its own gates.',
  })}
      ${AdminTopochain._panel({
    title: 'Request',
    subtitle: 'Pick a mounted /api/v4 endpoint (or Custom…), then a method and an optional JSON body.',
    body: `
          <div class="min-w-0">
            <label for="admin-topo-api-endpoint" class="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Endpoint</label>
            ${AdminTopochain._selectHtml('admin-topo-api-endpoint',
    [{ value: AdminTopochain.API_CUSTOM, label: 'Custom…' }], AdminTopochain.API_CUSTOM)}
            <p id="admin-topo-api-catalog-note" class="mt-1 text-xs text-zinc-500" role="status">Loading the endpoint list&hellip;</p>
          </div>
          <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[auto_1fr]">
            <div class="sm:w-32">
              <label for="admin-topo-api-method" class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Method</label>
              ${AdminTopochain._selectHtml('admin-topo-api-method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], 'GET')}
            </div>
            <div class="min-w-0 hidden" id="admin-topo-api-path-row">
              <label for="admin-topo-api-path" class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Path <span class="font-mono font-normal text-gray-400">(prefixed with /api/v4)</span>
              </label>
              <input id="admin-topo-api-path" type="text" placeholder="/admin/seasons" value="/admin/seasons"
                class="${FIELD_CLS} font-mono">
            </div>
          </div>
          <p class="mt-3 text-xs text-zinc-500">
            Target <span id="admin-topo-api-target" class="font-mono text-zinc-700 dark:text-zinc-300">GET /api/v4/admin/seasons</span>
          </p>
          <div class="mt-4">
            <label for="admin-topo-api-body" class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              JSON body <span class="font-normal text-gray-400">(ignored for GET)</span>
            </label>
            ${AdminTopochain._textareaHtml('admin-topo-api-body', '', 6)}
          </div>`,
    footer: `<button id="admin-topo-api-send" type="button" class="${BTN.primary}">Send request</button>`,
  })}
      <div id="admin-topo-api-result"></div>`;
    document.getElementById('admin-topo-api-send').addEventListener('click', () => AdminTopochain._runApiTest());
    document.getElementById('admin-topo-api-endpoint')
      .addEventListener('change', () => AdminTopochain._onApiEndpointChange());
    document.getElementById('admin-topo-api-method')
      .addEventListener('change', () => AdminTopochain._syncApiTarget());
    document.getElementById('admin-topo-api-path')
      .addEventListener('input', () => AdminTopochain._syncApiTarget());
    // The path row starts hidden and the select starts at Custom…, so open
    // the field for that state until the catalog arrives and picks a route.
    AdminTopochain._onApiEndpointChange();
    AdminTopochain._loadApiCatalog();
  },

  async _runApiTest() {
    const esc = AdminTopochain.esc;
    const method = document.getElementById('admin-topo-api-method').value;
    const path = AdminTopochain._apiTargetPath();
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
    result.innerHTML = note('bg-gray-100 dark:bg-gray-800 text-gray-500', 'Sending&hellip;');
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
          <header class="flex flex-wrap items-center gap-2 border-b border-gray-200 dark:border-gray-800 px-4 py-3 sm:px-5">
            <h3 class="text-sm font-semibold">Response</h3>
            <span class="rounded-full px-2 py-0.5 text-xs font-medium ${okTone}">HTTP ${esc(res.status)} ${esc(res.statusText)}</span>
          </header>
          <pre class="text-xs font-mono bg-gray-50 dark:bg-gray-950 p-4 overflow-x-auto whitespace-pre-wrap max-h-[32rem]">${esc(pretty)}</pre>
        </div>`;
    } catch (err) {
      result.innerHTML = note('bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400',
        `Network error: ${esc(err.message)}`);
    }
  },

  // ─── Endpoint select ──────────────────────────────────────────────
  //
  // The path INPUT stays the single source of truth for what gets sent —
  // the select writes into it and is then hidden for a concrete route, so
  // _runApiTest() never has to know which of the two the operator used.

  _apiTargetPath() {
    const el = document.getElementById('admin-topo-api-path');
    let p = ((el && el.value) || '').trim();
    if (!p) p = '/';
    if (!p.startsWith('/')) p = `/${p}`;
    return p;
  },

  _syncApiTarget() {
    const target = document.getElementById('admin-topo-api-target');
    const methodSel = document.getElementById('admin-topo-api-method');
    if (!target || !methodSel) return;
    target.textContent = `${methodSel.value} /api/v4${AdminTopochain._apiTargetPath()}`;
  },

  _onApiEndpointChange() {
    const sel = document.getElementById('admin-topo-api-endpoint');
    const pathRow = document.getElementById('admin-topo-api-path-row');
    const pathInput = document.getElementById('admin-topo-api-path');
    const methodSel = document.getElementById('admin-topo-api-method');
    if (!sel || !pathRow || !pathInput || !methodSel) return;
    const val = sel.value;
    if (val === AdminTopochain.API_CUSTOM) {
      pathRow.classList.remove('hidden');
      AdminTopochain._syncApiTarget();
      return;
    }
    const sp = val.indexOf(' ');
    const method = sp > 0 ? val.slice(0, sp) : 'GET';
    const path = sp > 0 ? val.slice(sp + 1) : val;
    if ([...methodSel.options].some((o) => o.value === method)) methodSel.value = method;
    pathInput.value = path;
    // A `:id`-style route can't be fired as written, so the field stays
    // OPEN (prefilled) for exactly those — the operator substitutes the
    // value in place. A concrete route hides it: the select is the target.
    const route = (AdminTopochain._apiCatalog || []).find((r) => `${r.method} ${r.path}` === val);
    pathRow.classList.toggle('hidden', !(route && route.has_params));
    AdminTopochain._syncApiTarget();
  },

  // GET /api/v4/admin/api-catalog — every route this build actually
  // mounted, introspected from Express's router stack server-side (see
  // src/routes/topochain/admin/api-catalog.js). Nothing here is a
  // hardcoded list, so a route added or renamed anywhere under
  // src/routes/topochain/ appears in this select with no client change.
  async _loadApiCatalog() {
    const esc = AdminTopochain.esc;
    const sel = document.getElementById('admin-topo-api-endpoint');
    const note = document.getElementById('admin-topo-api-catalog-note');
    if (!sel) return;
    let routes = null;
    try {
      const res = await fetch('/api/v4/admin/api-catalog', { credentials: 'same-origin' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.success) {
        throw new Error((data && data.error) || `HTTP ${res.status}`);
      }
      routes = Array.isArray(data.data) ? data.data : [];
    } catch (err) {
      // A tester that can't list the surface still has to be usable: leave
      // the free-text path exactly as it was and say why the list is gone.
      AdminTopochain._apiCatalog = [];
      if (note) note.textContent = `Could not load the endpoint list (${err.message}) — enter a path by hand.`;
      AdminTopochain._onApiEndpointChange();
      return;
    }
    // The operator may have navigated away while the fetch was in flight.
    if (!document.body.contains(sel)) return;
    AdminTopochain._apiCatalog = routes;
    if (!routes.length) {
      if (note) note.textContent = 'No /api/v4 endpoints were reported — enter a path by hand.';
      AdminTopochain._onApiEndpointChange();
      return;
    }
    const groups = [];
    routes.forEach((r) => { if (!groups.includes(r.group)) groups.push(r.group); });
    const label = (r) => `${r.method} ${r.path}`;
    sel.innerHTML = `${groups.map((g) => `
      <optgroup label="${esc(g)}">${routes.filter((r) => r.group === g).map((r) => `
        <option value="${esc(label(r))}">${esc(label(r))}</option>`).join('')}</optgroup>`).join('')}
      <option value="${esc(AdminTopochain.API_CUSTOM)}">Custom&hellip;</option>`;
    // Default to the Seasons index — this screen lives under Seasons, and
    // it is a parameter-free GET, so it is safe to have preselected.
    const preferred = routes.find((r) => r.method === 'GET' && r.path === '/admin/seasons')
      || routes.find((r) => r.method === 'GET' && !r.has_params)
      || routes[0];
    sel.value = label(preferred);
    if (note) {
      note.textContent = `${routes.length} endpoint${routes.length === 1 ? '' : 's'} mounted in this build`
        + ' — pick “Custom…” to send any other path.';
    }
    AdminTopochain._onApiEndpointChange();
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') window.AdminTopochain = AdminTopochain;
