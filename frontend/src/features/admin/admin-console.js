// Admin & moderation console (#818) — the full-page SPA screen behind the
// header shield icon. #588 shipped the icon plus a "Coming soon"
// placeholder; this module is the real console. Hash route
// #admin[/section], hosted in #admin-screen / #admin-root and
// mounted/unmounted by App.navigateToAdminConsole / App._exitAdminConsole
// (public/js/app.js), the same shape as the Challenges / Profile screens.
//
// ── #1082 chunk E: this file used to be public/js/admin-console.js ──────
// The screen root and the console CHASSIS are a React island now
// (./index.tsx): #admin-screen, #admin-root, the md:flex column pair, the
// desktop nav host, the view-only banner, #admin-section-content and the
// temporary-password dialog are all rendered by React and ship in
// public/index.html. This module was MOVED into that bundle rather than
// rewritten — the change here is the three lines that seam it to React:
//
//   * the AdminUI registry is an `export` (plus the same window publication
//     it always had), so the ten section modules import it instead of
//     depending on <script> order;
//   * _renderShell() no longer writes root.innerHTML — the chassis is
//     React's, and writing over it is the one thing the island rule
//     forbids. It repaints the nav host and the banner instead, which is
//     exactly what setSection() already did on every switch;
//   * window.AdminConsole is published behind a `typeof window` guard,
//     because the SSG prerender pass evaluates this module in Node.
//
// Everything below that is unchanged: #admin-section-content is still an
// innerHTML host that this file and the section modules own outright, so
// every render()/destroy() lifecycle, every id and every declared #admin/*
// dapp test sees the DOM it saw before.
//
// It reorganizes the standalone /admin page's sections (public/admin.html:
// Operations overview, Maintenance campaigns, LLM spend limits, Activation
// codes, Users) plus the /admin-features viewer into one page with a
// navigation menu — a fixed sidebar on md+ viewports. Every data endpoint
// is enforced server-side by adminMiddleware (reads) and requireAdminWrite
// (mutations); the client-side visibility gates are only presentation.
//
// MOBILE HIERARCHY: below md the sidebar has no room, and the horizontally
// scrolling tab strip that used to stand in for it (the Dev board's
// kanban-tabs pattern, #814) made sixteen ungrouped sections a thumb-swipe
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

// ── AdminUI: shared class recipes, in the platform's widget language ────
// Data-only class-string constants used by this file and every admin-*.js
// section module. They used to depend on <script> ORDER for this object to
// exist — this file loaded first, the section modules read the global. Now
// that the console lives in the React bundle (#1082 chunk E) the dependency
// is a real `import { AdminUI } from './admin-console.js'` in each of them,
// which is also what makes the SSG prerender pass work: admin-topochain.js
// reads AdminUI.card at module-evaluation time, and in Node there is no
// `window` to have published it.
//
// THE CONSOLE SPEAKS THE SHELL'S LANGUAGE NOW. It used to be a second design
// system on purpose — gray neutrals and an indigo accent, matching
// ../topochain's admin verbatim, kept apart from the shell's zinc/violet by
// tests/admin-ui-registry.test.js. The widget-language reskin folded it in:
// same scales, same figure/ground, same filled controls, same radii.
//
// What survives is a RENDERING boundary, not a palette one, and that is why
// the registry still exists. The console draws with template literals and
// `innerHTML`; the shell draws with React components under
// @/components/ui/. You cannot interpolate a component into a template
// string, so the same vocabulary needs two forms — components there, class
// recipes here. The test still forbids the console from importing the
// shell's primitives, for exactly that reason.
//
// Every value is a COMPLETE class literal: Tailwind's extractor is a regex
// over the content globs (which now include frontend/src/**/*.js), and
// tests/admin-ui-registry.test.js + tests/tailwind-build.test.js enforce
// the discipline. Never index this registry dynamically.
export const AdminUI = Object.freeze({
  // Surfaces — a floating card: no border, no shadow, the language's radius.
  // The language separates by FIGURE/GROUND, so the card is the surface and
  // the hairline it used to trace is what the ground now does.
  card: 'bg-white dark:bg-zinc-900 rounded-2xl',
  cardHeader: 'flex items-center justify-between gap-2 mb-4',
  cardTitle: 'text-lg font-semibold text-zinc-900 dark:text-zinc-100',
  cardDescription: 'text-sm text-zinc-500 dark:text-zinc-400',
  // Tables — topochain data-table. NOTE: deliberately no sideways-scroll
  // utility on the wrapper — nothing in the console scrolls horizontally
  // (#860, pinned by admin-console-page.test.js, which regexes this file's
  // raw source).
  // A table inside a card needs no second box around it.
  tableWrap: 'w-full rounded-xl overflow-hidden',
  table: 'w-full text-sm',
  // No fill on the head: the column labels are already uppercase and muted,
  // and a tinted band inside a floating card reads as a second surface.
  thead: 'border-b border-zinc-200 dark:border-zinc-800',
  th: 'px-6 py-3 text-left align-middle text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400',
  td: 'px-6 py-4 align-middle',
  trHover: 'border-b border-zinc-100 dark:border-zinc-800/60 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
  // Buttons — topochain's canonical button strings.
  btn: Object.freeze({
    primary: 'bg-violet-600 hover:bg-violet-500 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium',
    // `outline` keeps its KEY and stops being an outline. The language draws
    // no outlined control — a filled neutral is its secondary, the same shape
    // the profile screen's buttons and every dialog's Cancel now take. The
    // key stays because 60-odd call sites name it, and renaming them would be
    // a diff with no rendered difference.
    //
    // zinc-100, not white: these sit ON a card, and white on white is the
    // invisible half of this palette. (On the page ground it is the reverse —
    // see the note on the browse detail page's pill.)
    outline: 'inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 bg-zinc-100 dark:bg-zinc-800 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors',
    destructive: 'bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium',
    ghost: 'font-medium transition-colors text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
    link: 'font-medium transition-colors text-violet-700 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300',
    primarySm: 'bg-violet-600 hover:bg-violet-500 text-white px-3 py-1.5 rounded-lg transition-colors text-xs font-medium',
    outlineSm: 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-900 dark:text-zinc-100 bg-zinc-100 dark:bg-zinc-800 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors',
    destructiveSm: 'bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded-lg transition-colors text-xs font-medium',
  }),
  // Form controls — topochain's canonical input string (+ dark translation).
  input: 'w-full border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500',
  select: 'w-full border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500',
  textarea: 'w-full min-h-[80px] border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500',
  label: 'text-sm font-medium text-zinc-700 dark:text-zinc-300',
  // Badges — topochain's ring-tinted rounded-full pills.
  badge: Object.freeze({
    default: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-zinc-50 text-zinc-600 ring-1 ring-inset ring-zinc-500/10 dark:bg-zinc-500/10 dark:text-zinc-300 dark:ring-zinc-400/20',
    secondary: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-700/10 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/20',
    outline: 'inline-flex items-center rounded-full border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:text-zinc-300',
    destructive: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-50 text-red-700 ring-1 ring-inset ring-red-700/10 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/20',
    success: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-700/10 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20',
    warn: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-700/10 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20',
  }),
  // Overlay — topochain modal: black/50 backdrop, xl-rounded white panel.
  dialogOverlay: 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4',
  dialogPanel: 'w-full max-w-md bg-white dark:bg-zinc-900 rounded-2xl p-6 shadow-xl',
  // Typography / misc.
  sectionTitle: 'text-lg font-semibold text-zinc-900 dark:text-zinc-100',
  muted: 'text-sm text-zinc-500 dark:text-zinc-400',
  separator: 'border-t border-zinc-200 dark:border-zinc-800',
  kbd: 'rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-900 dark:text-zinc-100',
});

// Still published on the global: admin-topochain.js's sub-modules and a few
// section modules read `AdminUI` as a bare identifier inside functions, and
// the standalone /admin page's remaining scripts have never imported it.
// Guarded because the prerender pass evaluates this module in Node.
if (typeof window !== 'undefined') window.AdminUI = AdminUI;

// Which menu groups (Operations, Programme, People, Insights, Platform) the
// viewer has COLLAPSED, persisted per browser (#1152). Versioned key, same
// shape as Notifications' notif_expanded_groups_v1.
//
// The set stores the COLLAPSED names, not the expanded ones, and that
// inversion is load-bearing: SECTIONS has grown repeatedly (Push delivery,
// Email delivery, Estimator accuracy, Seasons), so "absent means expanded" is
// what keeps every future section visible to someone whose store predates it.
// It also makes "all four expanded on a first visit" the empty-store default.
const NAV_COLLAPSED_KEY = 'admin_nav_collapsed_groups_v1';

/**
 * One nav glyph, in the console's own frame.
 *
 * The console draws the SAME family as the shell — lucide v1.35.0 — at 1.5
 * rather than 2. That is AGENTS.md's density boundary, not two icon sets: a
 * 20px glyph at stroke 2 is right beside a 44px tap target and heavy above a
 * table of 130 rows. The weight is the tuning; the drawing is shared.
 *
 * The paths are transcribed here rather than imported because
 * tests/admin-ui-registry.test.js forbids an admin source from reaching into
 * @/components/ui/ — so this is the console's copy on purpose, and the frame
 * lives in one helper so the 29 entries below are just their shapes.
 *
 * The console's two CHROME chevrons are not nav glyphs and do not take 1.5:
 * they follow the shell's small-size rule (w-3 → 3, w-4 → 2), which is what
 * keeps a 12px caret legible. Those three values are the console's whole
 * weight story — there is no fourth.
 */
const navIcon = (shapes) => '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor"'
  + ' viewBox="0 0 24 24" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
  + ` aria-hidden="true">${shapes}</svg>`;

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
  // True between an open({ chrome: false }) and the syncChrome() app.js
  // runs inside the screen transition (#979) — _syncChrome is a no-op
  // while it is set, so the platform header is never rewritten before the
  // View Transition has captured the page the viewer is leaving.
  _chromeSuspended: false,

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
    { key: 'push', label: 'Push delivery', group: 'Operations' },
    { key: 'merges', label: 'Merge debug', group: 'Operations' },
    { key: 'rollover', label: 'Container rollover', group: 'Operations' },
    { key: 'staging-reap', label: 'Stale previews', group: 'Operations' },

    // Programme (#1179): what the programme IS — the seasons, the events
    // inside them, and the template library challenges are stamped out of.
    // These screens (and the People/Platform ones below marked #1179)
    // used to hide behind a single "Seasons, Events & Challenges" entry
    // with its own horizontal sub-nav; each is a first-class section now,
    // all still rendered by admin-topochain.js via SECTION_MODULES. The
    // module file name, the AdminTopochain global, the `topochain_`
    // settings-key prefix and the /api/v4/admin/* routes are historical
    // and deliberately unchanged. Season events still owns the tail
    // segments below its section (#admin/season-events/<eventId>
    // [/new-challenge[/<templateId>]]) — mirroring leaderboard.js's
    // _setSub/_syncHash pattern — so this file still needs no multi-level
    // routing. Maintenance campaigns does the same for
    // #admin/campaigns/<id>.
    { key: 'seasons', label: 'Seasons', group: 'Programme' },
    { key: 'season-events', label: 'Season events', group: 'Programme' },
    { key: 'challenge-templates', label: 'Challenge templates', group: 'Programme' },

    // The Users section carries BOTH user surfaces since #1179: the
    // platform accounts card (roles, quotas, caps) and the programme
    // users card (enrolment, podium/log settings, CSV import/export) —
    // one menu entry, merged. See features/admin/admin-users.tsx.
    { key: 'users', label: 'Users', group: 'People' },
    { key: 'codes', label: 'Activation codes', group: 'People' },
    { key: 'limits', label: 'Spend limits', group: 'People' },
    // Programme people screens, promoted by the same #1179 reshuffle.
    { key: 'waitlist', label: 'Waitlist', group: 'People' },
    { key: 'onchain-accounts', label: 'Onchain accounts', group: 'People' },
    { key: 'user-activities', label: 'User activities', group: 'People' },
    // Read-only view over the testnet accounts' staking delegation
    // periods (the mobile app is the delegation actor; admins only look).
    { key: 'delegations', label: 'Delegations', group: 'People' },

    { key: 'analytics', label: 'Analytics', group: 'Insights' },
    // Estimator accuracy (#898): platform analytics, split out of the
    // Analytics section, which is otherwise entirely USER analytics.
    { key: 'estimator', label: 'Estimator accuracy', group: 'Insights' },
    { key: 'gallery', label: 'Screenshot gallery', group: 'Insights' },
    { key: 'features', label: 'Submitted features', group: 'Insights' },
    // The last full end-to-end sweep of the product against production.
    // A generated REPORT, not a runner — the counterpart to the unit and
    // dapp suites, which cover components rather than journeys.
    { key: 'e2e', label: 'E2E coverage', group: 'Insights' },

    { key: 'campaigns', label: 'Maintenance campaigns', group: 'Platform' },
    // The home screen's "Featured apps" row. NOT the `features` key
    // above — that one is "Submitted features" (user feature requests).
    { key: 'featured-apps', label: 'Featured apps', group: 'Platform' },
    { key: 'db-export', label: 'Database export', group: 'Platform' },
    // Platform outbound mail: configuration, a test send, and the
    // delivery ledger. Separate from the programme's Settings section
    // (which keeps its own read-only status/activity card) because the
    // audience is every mail flow, not just the programme's.
    { key: 'mail', label: 'Email delivery', group: 'Platform' },
    // Programme operator tooling, promoted by #1179 — deliberately last:
    // these are the sharp ones (raw SQL, arbitrary API calls, the
    // settings that change how the mobile app behaves).
    { key: 'settings', label: 'Settings', group: 'Platform' },
    { key: 'app-version', label: 'App version', group: 'Platform' },
    { key: 'sql-console', label: 'SQL console', group: 'Platform' },
    { key: 'api-tester', label: 'API tester', group: 'Platform' },
  ],

  // Retired section keys that must keep resolving forever, so links and
  // bookmarks minted before a rename don't 404 into the fallback section.
  // Resolved at the two entry points (open/setSection) BEFORE visibility,
  // module lookup, nav highlighting or hash writing see the key, so the
  // rest of the file only ever deals in canonical keys. app.js rewrites
  // the address bar itself so the bookmark self-heals.
  LEGACY_SECTION_KEYS: {
    topochain: 'seasons',
  },

  // One per section — lucide v1.35.0, in navIcon()'s 1.5 frame (see above).
  // Complete inline literals; the shell loads no cross-origin assets.
  NAV_ICONS: Object.freeze({
    'overview': navIcon('<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>'),  // lucide/layout-grid
    'status': navIcon('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),  // lucide/circle-check
    'node': navIcon('<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),  // lucide/box
    'push': navIcon('<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>'),  // lucide/bell
    'merges': navIcon('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>'),  // lucide/git-merge
    'rollover': navIcon('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),  // lucide/refresh-cw
    'staging-reap': navIcon('<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),  // lucide/trash-2
    'users': navIcon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>'),  // lucide/users
    'codes': navIcon('<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>'),  // lucide/ticket
    'limits': navIcon('<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>'),  // lucide/gauge
    'analytics': navIcon('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>'),  // lucide/chart-line
    'estimator': navIcon('<rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="16" x2="16" y1="14" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/>'),  // lucide/calculator
    'gallery': navIcon('<path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16"/><path d="M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2"/><circle cx="13" cy="7" r="1" fill="currentColor"/><rect x="8" y="2" width="14" height="14" rx="2"/>'),  // lucide/images
    'features': navIcon('<circle cx="15" cy="12" r="3"/><rect width="20" height="14" x="2" y="5" rx="7"/>'),  // lucide/toggle-right
    'campaigns': navIcon('<path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14"/><path d="M8 6v8"/>'),  // lucide/megaphone
    'featured-apps': navIcon('<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>'),  // lucide/star
    'db-export': navIcon('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>'),  // lucide/database
    'mail': navIcon('<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/>'),  // lucide/mail
    'seasons': navIcon('<path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M8 13h.01"/><path d="M12 13h.01"/><path d="M16 13h.01"/><path d="M8 17h.01"/><path d="M12 17h.01"/><path d="M16 17h.01"/>'),  // lucide/calendar-days
    'season-events': navIcon('<path d="M16 14v2.2l1.6 1"/><path d="M16 2v3"/><path d="M21 7.338V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h2.338"/><path d="M3 9h5.859"/><path d="M8 2v3"/><circle cx="16" cy="16" r="6"/>'),  // lucide/calendar-clock
    'challenge-templates': navIcon('<path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2"/><path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2"/><path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3"/><path d="M4 22h16"/><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/><path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3"/>'),  // lucide/trophy
    'waitlist': navIcon('<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>'),  // lucide/list-checks
    'onchain-accounts': navIcon('<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>'),  // lucide/wallet
    'user-activities': navIcon('<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>'),  // lucide/activity
    'delegations': navIcon('<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/>'),  // lucide/handshake
    'settings': navIcon('<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>'),  // lucide/settings
    'app-version': navIcon('<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>'),  // lucide/tag
    'sql-console': navIcon('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 15 21.84"/><path d="M21 5V8"/><path d="M21 12L18 17H22L19 22"/><path d="M3 12A9 3 0 0 0 14.59 14.87"/>'),  // lucide/database-zap
    'api-tester': navIcon('<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>'),  // lucide/square-terminal
  }),

  _canonicalSection(key) {
    return (key && AdminConsole.LEGACY_SECTION_KEYS[key]) || key;
  },

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
  //
  // `opts.chrome === false` renders WITHOUT touching the platform header
  // (#979): the console renders into a still-hidden #admin-screen, which
  // is invisible, but the header title / back icon are not — writing them
  // before the screen transition starts bakes the incoming console's
  // chrome into the snapshot of the page being left. app.js calls
  // AdminConsole.syncChrome() inside the transition callback instead.
  open(section, opts) {
    AdminConsole._open = true;
    AdminConsole._public = !!(opts && opts.public);
    AdminConsole._pushedFromMenu = false;
    AdminConsole._chromeSuspended = !!(opts && opts.chrome === false);
    AdminConsole._menuScrollTop = 0;
    AdminConsole._ensureMediaListener();
    section = AdminConsole._canonicalSection(section);
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
      // This branch repaints without going through setSection, so the
      // arrival rule has to be applied here too (#1152).
      AdminConsole._ensureActiveGroupExpanded();
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
  //
  // IDEMPOTENT (#1102), for the same reason Settings.route is — this is a
  // copy of the same two-level router, over an already-VISIBLE screen root.
  // One history traversal fires popstate AND hashchange, so restoreFromHash
  // runs twice in one tick and this is called twice with the same section;
  // the second call resolves the same level, asks for 'none', and the kit
  // runs 'none' SYNCHRONOUSLY — landing the level swap before the first
  // call's pending View Transition captured the outgoing page, so the
  // animation played two copies of the incoming page. Resolve the target
  // first and bail out when it is already on screen.
  route(section, opts) {
    // Applied before the comparison: _visibleSections() reads it, so the
    // public-mode flag decides what "the same target" even means.
    if (opts && typeof opts.public === 'boolean') AdminConsole._public = !!opts.public;
    const visible = AdminConsole._visibleSections();
    const valid = !!section && visible.some((s) => s.key === section);
    const mobile = AdminConsole._isMobile();
    // The level and section this call WOULD end on. Level 1 keeps whatever
    // section sits behind the menu, so there the level is the whole target.
    const targetLevel = (!mobile || valid) ? 2 : 1;
    const targetSection = valid
      ? section
      : (mobile
        ? AdminConsole._section
        : (AdminConsole._publicMode() ? (visible[0]?.key || 'status') : 'overview'));
    if (targetLevel === AdminConsole._level && targetSection === AdminConsole._section) {
      AdminConsole._reapplySectionHash();
      return;
    }
    if (!mobile) {
      // Desktop: bare #admin is Overview, as it has always been.
      AdminConsole.setSection(targetSection, { writeHash: false });
      AdminConsole._level = 2;
      AdminConsole._syncChrome();
      return;
    }
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
      // Mobile drill-in / pop repaints without setSection — same arrival
      // rule, applied before the menu and sidebar are rebuilt (#1152).
      AdminConsole._ensureActiveGroupExpanded();
      AdminConsole._renderShell();
      AdminConsole._renderContent();
      AdminConsole._syncChrome();
      AdminConsole._restoreScroll();
    }, type);
  },

  // The address this console last rendered itself from, recorded AFTER the
  // render so it holds whatever the section module healed the hash to (both
  // AdminTopochain and AdminCampaigns own a second level below the section
  // segment and replaceState it back themselves). Compared, not merely
  // remembered — see _reapplySectionHash.
  _routedHash: null,

  _markRouted() {
    AdminConsole._routedHash = location.hash;
  },

  // #1146: the level+section bail-out above is a guard against ONE dispatch
  // arriving twice, not a statement that the address hasn't moved. Sections
  // that own a second hash level are addressed by a tail the comparison
  // above cannot see — #admin/season-events, #admin/season-events/12 and
  // #admin/season-events/12/new-challenge/3 all resolve to level 2,
  // section 'season-events' — so a switch BETWEEN two of those siblings
  // used to return here without repainting, leaving the previous tail's
  // screen up.
  // Cold loading hid it (the module reads the address in render()); a
  // sibling-fragment hash switch, which is how the grouped capture runner
  // reaches every cohort of a document, does not.
  //
  // Re-running _renderSection() is exactly the cold-load path: it tears the
  // section down and calls the module's render(), which re-reads the hash
  // and resets whatever the tail no longer names. Gated on the address
  // having actually CHANGED since the last render, which is what preserves
  // the #1102 guard — a traversal's popstate and hashchange carry the same
  // hash, so the second of the pair still bails out.
  _reapplySectionHash() {
    if (AdminConsole._routedHash === location.hash) return;
    // Mark before as well as after: the render below replaceStates the
    // healed address, and a mark-only-after would leave a window in which a
    // re-entrant call saw the stale value.
    AdminConsole._markRouted();
    // Level 1 on mobile is the menu, not a section — nothing below the
    // #admin segment is addressing anything there.
    if (AdminConsole._isMobile() && AdminConsole._level === 1) return;
    AdminConsole._renderSection();
    AdminConsole._markRouted();
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
  // The public half of _syncChrome: clears the suspension a
  // `chrome: false` open() set and applies the chrome for real. app.js
  // calls this INSIDE the screen transition's callback (#979).
  syncChrome() {
    AdminConsole._chromeSuspended = false;
    AdminConsole._syncChrome();
  },

  _syncChrome() {
    if (!window.App || AdminConsole._chromeSuspended) return;
    const inSection = AdminConsole._isMobile() && AdminConsole._level === 2;
    // #1036: the header control is a real anchor — inside a section the
    // chevron pops to the console's own menu, so that is its href.
    // Always an arrow, and at the root it points at PROFILE — see the same
    // call in features/settings/settings.js for why the parent is Profile and
    // not home.
    if (App.setBackIcon) App.setBackIcon('arrow', inSection ? '#admin' : '#profile');
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

  // ── Menu group collapse state (#1152) ─────────────────────────────────

  // The COLLAPSED group names, lazily loaded from localStorage on first
  // read. Both menu builders regenerate their markup from THIS on every
  // repaint and neither derives anything from the DOM, so a toggle survives
  // a section switch, a viewport crossing and a reload identically.
  _collapsedGroups: null,

  _collapsed() {
    if (!AdminConsole._collapsedGroups) AdminConsole._loadCollapsedGroups();
    return AdminConsole._collapsedGroups;
  },

  // Corrupt, foreign or unavailable storage all resolve to "nothing
  // collapsed": this runs inside a render path, so it must never throw.
  _loadCollapsedGroups() {
    AdminConsole._collapsedGroups = new Set();
    // Only render/toggle paths reach here, but the guard sits next to the
    // storage read regardless — the prerender pass evaluates this module in
    // Node, where there is no localStorage (see the window.AdminUI guard).
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(NAV_COLLAPSED_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return;
      // Prune names no SECTIONS entry carries any more, so the store can't
      // grow unbounded and a RENAMED group resets to expanded — the safe
      // direction, since a stale entry would hide live rows.
      const live = new Set(AdminConsole.SECTIONS.map((s) => s.group || 'Other'));
      let changed = false;
      for (const name of arr) {
        const key = String(name);
        if (live.has(key)) AdminConsole._collapsedGroups.add(key);
        else changed = true;
      }
      if (changed) AdminConsole._saveCollapsedGroups();
    } catch {
      AdminConsole._collapsedGroups = new Set();
    }
  },

  _saveCollapsedGroups() {
    try {
      localStorage.setItem(
        NAV_COLLAPSED_KEY,
        JSON.stringify([...AdminConsole._collapsed()])
      );
    } catch { /* storage may be unavailable; non-fatal, in-memory for the session */ }
  },

  _isGroupCollapsed(name) {
    return AdminConsole._collapsed().has(String(name));
  },

  _setGroupCollapsed(name, collapsed) {
    const set = AdminConsole._collapsed();
    const key = String(name);
    if (collapsed) set.add(key);
    else set.delete(key);
    AdminConsole._saveCollapsedGroups();
  },

  // "Never hide where I am": arriving at a section reveals its group, so a
  // deep link into a collapsed group (a bookmark, one of the retired-page
  // redirect stubs) can't leave the highlighted row invisible. Called
  // BEFORE the repaint that follows it, and only on ARRIVAL — deliberately
  // not enforced continuously, or the group you are using would be the one
  // group you cannot collapse.
  _ensureActiveGroupExpanded() {
    const s = AdminConsole._visibleSections().find((x) => x.key === AdminConsole._section);
    if (!s) return;
    const name = String(s.group || 'Other');
    const set = AdminConsole._collapsed();
    if (!set.has(name)) return;
    set.delete(name);
    AdminConsole._saveCollapsedGroups();
  },

  // aria-controls targets have to be unique, and at phone width the hidden
  // desktop sidebar and the level-1 menu are BOTH in the document — hence
  // one id prefix per surface ('admin-nav-group', 'admin-menu-group').
  _groupDomId(prefix, name) {
    return `${prefix}-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  },

  // The heading affordance both menus share: a real <button>, so Tab plus
  // Enter/Space come for free and no keydown handler is needed, with the
  // aria-expanded/aria-controls pair and the platform's chevron idiom
  // (down when open, right when closed — home-panels.js's rotation trick).
  _groupToggleHtml(name, domId, collapsed, cls) {
    const label = `${collapsed ? 'Expand' : 'Collapse'} ${name}`;
    const chevron = `<svg data-admin-group-chevron aria-hidden="true"
        class="w-3 h-3 shrink-0 transition-transform${collapsed ? ' -rotate-90' : ''}"
        fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
    return `<button type="button" data-admin-group-toggle="${AdminConsole.esc(name)}"
        aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="${domId}"
        title="${AdminConsole.esc(label)}" aria-label="${AdminConsole.esc(label)}"
        class="${cls}">${chevron}<span class="flex-1 min-w-0 truncate">${AdminConsole.esc(name)}</span></button>`;
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

  // Desktop sidebar rows, grouped under headings. Nineteen flat rows is a
  // lot to scan; the headings are the mitigation, and since #1152 each one
  // is a collapse/expand button whose state persists per browser.
  _navItemsHtml() {
    const active = AdminConsole._section;
    const itemHtml = (s) => {
      const isActive = s.key === active;
      const cls = 'admin-nav-item flex items-center gap-3 w-full text-left rounded-md px-3 py-2.5 text-sm font-medium transition-colors '
        + (isActive
          ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
          : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/60');
      return `<button type="button" role="tab" aria-selected="${isActive ? 'true' : 'false'}"
        data-admin-section="${s.key}" class="${cls}">${AdminConsole.NAV_ICONS[s.key] || ''}<span class="flex-1 min-w-0 truncate">${AdminConsole.esc(s.label)}</span></button>`;
    };
    return AdminConsole._groupedSections().map((g, i) => {
      // Rendered from the persisted set, never from the DOM — so this
      // wholesale repaint (it runs on every section switch) reproduces
      // whatever the viewer collapsed.
      const collapsed = AdminConsole._isGroupCollapsed(g.name);
      const domId = AdminConsole._groupDomId('admin-nav-group', g.name);
      // No spacing utility on the items wrapper: the rows were adjacent
      // before this became a wrapped group, and they stay adjacent.
      return `
      <div class="${i === 0 ? '' : 'mt-6'}">
        ${AdminConsole._groupToggleHtml(g.name, domId, collapsed,
          'flex items-center gap-1.5 w-full text-left px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors')}
        <div id="${domId}" data-admin-group="${AdminConsole.esc(g.name)}"${collapsed ? ' class="hidden"' : ''}>
          ${g.items.map(itemHtml).join('')}
        </div>
      </div>`;
    }).join('');
  },

  // Mobile level 1: the section menu. A list, not a tab set — so plain
  // buttons in a <nav>, no role="tab"/aria-selected, and the drawer-row
  // idiom from index.html (44px minimum, hairline between rows, chevron
  // on the right) rather than the kit's inset-grouped card, which would
  // read as a foreign surface next to the rest of the platform.
  _mobileMenuHtml() {
    const chevron = `<svg class="w-4 h-4 shrink-0 text-zinc-500 dark:text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
    const rowHtml = (s) => `
      <button type="button" data-admin-section="${s.key}"
              class="admin-menu-row flex items-center gap-3 w-full text-left min-h-[44px] px-4 py-2
                     border-b border-zinc-100 dark:border-zinc-800
                     text-zinc-700 dark:text-zinc-200
                     hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors">
        <span class="text-zinc-500 dark:text-zinc-500">${AdminConsole.NAV_ICONS[s.key] || ''}</span>
        <span class="flex-1 min-w-0 text-sm font-medium truncate">${AdminConsole.esc(s.label)}</span>
        ${chevron}
      </button>`;
    // The toggle stays OUTSIDE the card, so [&>button:last-child] keeps
    // meaning "the last section row" rather than picking up a heading.
    const groups = AdminConsole._groupedSections().map((g) => {
      const collapsed = AdminConsole._isGroupCollapsed(g.name);
      const domId = AdminConsole._groupDomId('admin-menu-group', g.name);
      return `
      <div class="mb-5">
        ${AdminConsole._groupToggleHtml(g.name, domId, collapsed,
          'flex items-center gap-1.5 w-full text-left px-4 pb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500')}
        <div id="${domId}" data-admin-group="${AdminConsole.esc(g.name)}"
             class="${AdminUI.card} overflow-hidden
                    [&>button:last-child]:border-b-0${collapsed ? ' hidden' : ''}">
          ${g.items.map(rowHtml).join('')}
        </div>
      </div>`;
    }).join('');
    return `<nav id="admin-mobile-menu" aria-label="Admin sections" class="-mx-4">${groups}</nav>`;
  },

  // Repaint the chassis's two variable parts. React owns the chassis MARKUP
  // (./index.tsx), which is why this no longer touches root.innerHTML: the
  // nav host and the banner are the only things about it that depend on who
  // is looking, and both were already repainted in place on every section
  // switch (see setSection). The name is kept because eight call sites and
  // the mobile transition callbacks read as "repaint the shell".
  //
  // #admin-nav-desktop ships EMPTY, exactly as #settings-nav-desktop does:
  // React hydrates an empty host and never looks inside it again, so the
  // innerHTML write below is not a write into React-owned DOM.
  _renderShell() {
    const sideHost = document.getElementById('admin-nav-desktop');
    if (sideHost) {
      sideHost.innerHTML = AdminConsole._navItemsHtml();
      // Scoped to the sidebar, where the old whole-root wire was scoped to a
      // subtree this function had just emptied. It has to be: #admin-root is
      // no longer wiped here, so wiring the whole root would ALSO re-bind the
      // level-1 menu buttons still sitting in #admin-section-content, one
      // extra click handler per repaint. The other two [data-admin-section]
      // producers wire their own output — _renderMobileMenu right after its
      // innerHTML write, and each section module for its own controls.
      AdminConsole._wireSectionButtons(sideHost);
      AdminConsole._wireGroupToggles(sideHost);
    }
    // In public mode the viewer isn't an admin at all, so the view-only
    // ADMIN banner would be nonsense — suppress it rather than showing an
    // amber "you can't make changes" strip to a regular member.
    const viewOnly = !AdminConsole.canWrite() && !AdminConsole._publicMode();
    const banner = document.getElementById('admin-view-only-banner');
    // classList, not a rendered className: the banner is a static React node
    // and its class attribute must be written once at hydration and then
    // only ever toggled from here (the useHiddenClass contract).
    if (banner) banner.classList.toggle('hidden', !viewOnly);
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

  // Menu-group headings (#1152). A press is a MENU-ONLY action: it mutates
  // the persisted set and then the DOM IN PLACE — never setSection,
  // _renderShell, _renderContent, _writeHash or location.hash. Three
  // reasons: the section on screen keeps rendering untouched, a phone
  // repaint would tear the menu's own rows down mid-gesture, and focus
  // stays on the heading you just pressed so several can be collapsed in a
  // row. Scoped to the host just written, exactly like _wireSectionButtons,
  // so repaints can't accumulate handlers.
  _wireGroupToggles(root) {
    if (!root) return;
    root.querySelectorAll('[data-admin-group-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.adminGroupToggle;
        const next = !AdminConsole._isGroupCollapsed(name);
        AdminConsole._setGroupCollapsed(name, next);
        btn.setAttribute('aria-expanded', next ? 'false' : 'true');
        const label = `${next ? 'Expand' : 'Collapse'} ${name}`;
        btn.setAttribute('title', label);
        btn.setAttribute('aria-label', label);
        const chevron = btn.querySelector('[data-admin-group-chevron]');
        if (chevron) chevron.classList.toggle('-rotate-90', next);
        // `hidden` takes the rows out of tab order too, so tabbing skips a
        // collapsed group rather than walking invisible buttons.
        const id = btn.getAttribute('aria-controls');
        const items = id && document.getElementById(id);
        if (items) items.classList.toggle('hidden', next);
      });
    });
  },

  setSection(key, opts) {
    key = AdminConsole._canonicalSection(key);
    const visible = AdminConsole._visibleSections();
    if (!visible.some((s) => s.key === key)) {
      key = AdminConsole._publicMode() ? (visible[0]?.key || 'status') : 'overview';
    }
    AdminConsole._section = key;
    // Arrival at a section reveals its group, before the repaint that would
    // otherwise draw the active row inside a collapsed one (#1152).
    AdminConsole._ensureActiveGroupExpanded();
    // Repaint the sidebar's active state. This used to be the "the shell is
    // already built" half of a branch whose other half rebuilt #admin-root
    // from scratch; the chassis is React's now, so it always exists and
    // _renderShell IS this repaint.
    AdminConsole._renderShell();
    if (!opts || opts.writeHash !== false) AdminConsole._writeHash(key);
    AdminConsole._renderSection();
    // Recorded after the render, so it holds whatever the section module
    // healed the address to. See _reapplySectionHash.
    AdminConsole._markRouted();
  },

  // Section switches update the address without polluting history —
  // replaceState, and only while we're actually on the #admin route (the
  // Leaderboard._setSub pattern). Entering/leaving the page still gets a
  // real history entry via normal hash navigation.
  //
  // Sections that own a second hash level (seasons, campaigns) are left
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
    // `overview` is also the console's DEFAULT section — see the `default:`
    // arm of _renderSection, which dispatches through the same helper.
    overview: 'AdminOverview',
    codes: 'AdminCodes',
    'featured-apps': 'AdminFeaturedApps',
    'db-export': 'AdminDbExport',
    features: 'AdminFeatures',
    limits: 'AdminLimits',
    users: 'AdminUsers',
    rollover: 'AdminRollover',
    'staging-reap': 'AdminStagingReap',
    status: 'AdminStatus',
    node: 'AdminNode',
    analytics: 'AdminAnalytics',
    estimator: 'AdminEstimator',
    merges: 'AdminMerges',
    gallery: 'AdminGallery',
    campaigns: 'AdminCampaigns',
    mail: 'AdminMail',
    push: 'AdminPush',
    e2e: 'AdminE2E',
    // The ten promoted programme screens (#1179) all render through
    // admin-topochain.js — the section key names the screen, and the
    // module reads it back in its render(). The programme's Users screen
    // is the one exception: it is merged into the Users section, which
    // embeds AdminTopochain.renderUsers in a host of its own
    // (features/admin/admin-users.tsx).
    seasons: 'AdminTopochain',
    'season-events': 'AdminTopochain',
    'challenge-templates': 'AdminTopochain',
    waitlist: 'AdminTopochain',
    'onchain-accounts': 'AdminTopochain',
    'user-activities': 'AdminTopochain',
    delegations: 'AdminTopochain',
    settings: 'AdminTopochain',
    'app-version': 'AdminTopochain',
    'sql-console': 'AdminTopochain',
    'api-tester': 'AdminTopochain',
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
      AdminConsole._markRouted();
      return;
    }
    AdminConsole._renderSection();
    AdminConsole._markRouted();
  },

  _renderMobileMenu(host) {
    host.innerHTML = AdminConsole._mobileMenuHtml();
    AdminConsole._wireSectionButtons(host);
    AdminConsole._wireGroupToggles(host);
  },

  _renderSection() {
    const host = document.getElementById('admin-section-content');
    if (!host) return;
    // Always tear the previous section down first — this is the single
    // choke point every section switch passes through.
    AdminConsole._teardownActiveSection();

    const key = AdminConsole._section;
    const modName = AdminConsole.SECTION_MODULES[key];
    if (modName) return AdminConsole._renderModule(host, modName, key);
    // Anything the address bar names that this build does not know about
    // lands on the default section, which is Overview — a delegated module
    // since #1120, so it goes through the same dispatch. Every section is a
    // delegated module now, so this is the only arm left: the `switch` the
    // console dispatched its own renderers through is gone (#1120 slice 23).
    return AdminConsole._renderModule(host, 'AdminOverview', 'overview');
  },

  // Hand a section host to a delegated module, and remember it so the next
  // switch can tear it down. Extracted from _renderSection when `overview`
  // became a module: it is now reachable both by name and as the default.
  _renderModule(host, modName, key) {
    const mod = window[modName];
    if (!mod || typeof mod.render !== 'function') {
      host.innerHTML = `<p class="${AdminUI.muted} p-4">The ${AdminConsole.esc(key)} console module failed to load.</p>`;
      return;
    }
    AdminConsole._activeModule = mod;
    mod.render(host);
  },

  // ── Delegated sections ──────────────────────────────────────────────
  //
  // Topochain (Task 15), Health & status / Node & chain / Analytics /
  // Merge debug / Screenshot gallery / Maintenance campaigns (#860) and
  // Estimator accuracy (#898) all
  // live in their own modules, dispatched by SECTION_MODULES above rather
  // than by a render*Section method here. Two of them own tail segments
  // below the section entirely on their own — AdminTopochain under
  // #admin/season-events/<eventId> and AdminCampaigns under
  // #admin/campaigns/<id> — reading location.hash directly and writing it
  // back with replaceState, the same pattern leaderboard.js uses for its
  // own tab state, so this file never needs general multi-level routing.

  // ── Sweep forwarders (Container rollover / Stale previews) ───────────
  //
  // Both sections are React modules now (#1120 slice 23:
  // features/admin/admin-rollover.tsx and admin-staging-reap.tsx), but they
  // are the only two with a caller OUTSIDE the console: public/js/app.js
  // routes `admin_rollover_status` / `admin_staging_reap_status` frames from
  // the shell's /ws/events socket to the two handlers below, and calls the
  // two loaders on socket reconnect so a dropped socket cannot leave a job
  // half-painted.
  //
  // That surface belongs to the shell, not to the console, so it stays
  // exactly where app.js already looks for it and forwards to the module.
  // Each forwarder is a no-op while its section is not mounted — the module
  // holds a `live` handle that is non-null exactly while it is on screen,
  // which is what the old handlers approximated with a `_section === …`
  // check plus a getElementById probe. Nothing is lost by dropping a frame:
  // the next mount reads the job from the GET.
  handleRolloverStatus(data) {
    if (!AdminConsole._open) return;
    window.AdminRollover?.handleStatus?.(data);
  },

  loadRollover() { window.AdminRollover?.reload?.(); },

  handleStagingReapStatus(data) {
    if (!AdminConsole._open) return;
    window.AdminStagingReap?.handleStatus?.(data);
  },

  loadStagingReap() { window.AdminStagingReap?.reload?.(); },

  // ── Temporary-password dialog (filled for the Users section) ───────────
  //
  // The dialog is chassis furniture: index.tsx renders #admin-temp-pw-modal
  // as static React markup and this fills it. It stayed here when the Users
  // section moved out (#1120 slice 22), so that section never reaches for a
  // chassis id — the OFF_LIMITS rule in
  // tests/admin-heavy-sections-island.test.js.

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
  }
};

// app.js reaches for window.AdminConsole (route / open / syncChrome / the
// rollover + stale-preview WS handlers), and _renderSection dispatches the
// section modules through window[modName], so the global publication stays.
// Guarded: the prerender pass evaluates this module in Node.
if (typeof window !== 'undefined') window.AdminConsole = AdminConsole;
