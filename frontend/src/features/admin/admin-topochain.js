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

// The shared admin class-string registry used to be imported here too — its
// last use in this file was the onchain-accounts detail dialog, which left in
// #1120 slice 29. ./topochain/tokens.ts still imports it for PANEL_CLS, so the
// evaluation-time dependency this module has on admin-console.js is unchanged;
// it is one file further away.

// ── Control styling tokens ───────────────────────────────────────────
//
// Moved to ./topochain/tokens.ts in #1120 slice 24, verbatim, so the screens
// being converted to React build from the SAME strings the innerHTML screens
// below do. That file carries the reasoning that used to live here.
import {
  BTN_BASE, BTN_SM, BTN, FIELD_CLS, TEXTAREA_CLS, PANEL_CLS,
} from './topochain/tokens.ts';

// The React screens, and the portal seam that mounts them. `unmountLegacyPortal`
// is imported here rather than re-exported through screens.tsx because this file
// is plain JS: it may hold a component MAP, but it renders no JSX itself.
import {
  eventOptions, fetchAllEvents, fetchAllSeasons, fetchJson, seasonOptions, send,
} from './topochain/api.ts';
import { TOPO_REACT_SCREENS } from './topochain/screens.tsx';
import { unmountLegacyPortal } from '../../lib/legacy-portals';

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
    { key: 'delegations', label: 'Delegations' },
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

  // Safe fetch+parse, never throws, and its JSON-body wrapper. Both moved to
  // ./topochain/api.ts in #1120 slice 25 so the React screens share this
  // module's copy rather than growing one; these stay as members because ~50
  // call sites below name them, and because the tests pin the surface.
  async fetchJson(url, opts) { return fetchJson(url, opts); },

  async send(method, url, body) { return send(method, url, body); },

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

  // A labelled rule between groups of fields inside one form panel. The
  // long forms (challenge template, add challenge) are otherwise a wall
  // of inputs in which "which of these is the CTA?" has to be answered
  // by reading every label.
  _formSection(label) {
    return `<p class="mt-5 mb-3 border-t border-zinc-200 dark:border-zinc-800 pt-4 text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">${AdminTopochain.esc(label)}</p>`;
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
        <thead class="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400"><tr>${head}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;

    const primary = cols.find((c) => c.primary) || cols[0];
    const cards = `<div class="md:hidden space-y-2">${items.map((it) => {
      const rest = cols.filter((c) => c !== primary && !c.hideOnCard).map((c) => `
        <div class="flex items-start justify-between gap-3 py-1">
          <dt class="shrink-0 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">${esc(c.label)}</dt>
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
    return `<div class="mt-4 flex flex-col gap-2 text-xs text-zinc-500 dark:text-zinc-400 sm:flex-row sm:items-center sm:justify-between">
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
  async _fetchAllEvents() { return fetchAllEvents(); },

  _eventOptions(events) { return eventOptions(events); },

  // Same idea as _fetchAllEvents for the (even smaller) seasons list —
  // used by the season <select> on the Season events form and by the
  // season filter on the Season events list. Not cached, so a season
  // created seconds ago is already pickable.
  async _fetchAllSeasons() { return fetchAllSeasons(); },

  _seasonOptions(seasons) { return seasonOptions(seasons); },

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
      violet: 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400',
      zinc: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
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
    AdminTopochain._unmountScreen();
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
    // A converted screen owns #admin-topo-content through a portal. Dropping
    // the node from under it would leave the portal mounted on a detached
    // host, so it comes down BEFORE the innerHTML that discards the node —
    // rule 1 in lib/legacy-portals.tsx.
    AdminTopochain._unmountScreen();
    host.innerHTML = '<div id="admin-topo-content"></div>';
    AdminTopochain._renderSub();
  },

  // The host of the currently-mounted React screen, or null. Only the portal
  // seam reads it; an innerHTML screen leaves it null and needs no teardown,
  // because AdminConsole replaces the whole section host on the next switch.
  _reactHost: null,

  _unmountScreen() {
    const h = AdminTopochain._reactHost;
    AdminTopochain._reactHost = null;
    if (h) unmountLegacyPortal(h);
  },

  // Mount a React screen and remember its host, so the next screen switch
  // tears it down before the innerHTML that discards the node.
  _mountReactScreen(host, screen) {
    AdminTopochain._reactHost = host;
    screen.mount(host);
  },

  _renderSub() {
    const c = document.getElementById('admin-topo-content');
    if (!c) return;
    // React screens first (#1120 slice 24); the switch below is what is left
    // of the innerHTML renderers, and shrinks by one `case` per conversion.
    const react = TOPO_REACT_SCREENS[AdminTopochain._sub];
    if (react) return AdminTopochain._mountReactScreen(c, react);
    // Every screen is a React one since #1120 slice 34, so there is no
    // `switch` left: an address this build does not know about lands on
    // Seasons. (setSub already normalises an unknown key to 'seasons', so
    // this is reachable only if SUBS and the registry ever disagree —
    // tests/topochain-admin-screens.test.js checks that they do not.)
    return AdminTopochain._mountReactScreen(c, TOPO_REACT_SCREENS.seasons);
  },

  // ══════════════════════════════════════════════════════════════════
  // Seasons — moved to ./topochain/seasons.tsx (#1120 slice 33).
  // ══════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════
  // Season events (and the nested Challenges detail) — moved to
  // ./topochain/season-events.tsx and ./topochain/challenges.tsx
  // (#1120 slice 34). The ADDRESS stayed here: _readSeasonEventsDeepLink
  // and _syncHash still own the #admin/season-events/<id>[/new-challenge…]
  // tail, and the screen seeds itself from `_se` / `_ch` and publishes
  // back. The state block below is what those two functions read and
  // write; it is the router's, not a screen's.
  // ══════════════════════════════════════════════════════════════════

  // `seasonFilter` is '' (all), 'none' (events with no season), or a
  // season id as a string — the three states the API's own `season_id`
  // query param accepts. The Seasons screen writes it before switching
  // screens; the Season events screen seeds itself from it on mount.
  _se: { seasonFilter: '', detailId: null },

  // The Add-challenge form's slice of the address: `open` and `templateId`
  // are what _syncHash writes into the /new-challenge tail, and
  // `pendingTemplateId` is what a deep link asked for — spent once by the
  // form that opens. The screen publishes back into these; nothing here
  // renders.
  _ch: { templateId: '', open: false, pendingTemplateId: null },

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
        <div id="admin-topo-u-imp-result" class="mt-3 text-xs text-zinc-500 dark:text-zinc-400"></div>`,
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
        body: '<p class="text-sm text-zinc-500 dark:text-zinc-400">There is no event to export users for yet.</p>',
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
  // Waitlist — moved to ./topochain/waitlist.tsx (#1120 slice 28).
  // ══════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════
  // Onchain accounts — moved to ./topochain/onchain-accounts.tsx
  // (#1120 slice 29).
  // ══════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════
  // User activities — moved to ./topochain/user-activities.tsx
  // (#1120 slice 30).
  // ══════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════
  // Delegations — moved to ./topochain/delegations.tsx (#1120 slice 31).
  // ══════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════
  // Challenge templates — moved to ./topochain/challenge-templates.tsx
  // (#1120 slice 32).
  // ══════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════
  // Settings — moved to ./topochain/settings.tsx (#1120 slice 26).
  // ══════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════
  // App version — moved to ./topochain/app-version.tsx (#1120 slice 27).
  // ══════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════
  // SQL console — moved to ./topochain/sql-console.tsx (#1120 slice 25).
  // ══════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════
  // API tester — moved to ./topochain/api-tester.tsx (#1120 slice 24).
  // It is the first of this module's eleven screens through the portal seam;
  // _renderSub dispatches it through TOPO_REACT_SCREENS rather than a `case`.
  // ══════════════════════════════════════════════════════════════════
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') window.AdminTopochain = AdminTopochain;
