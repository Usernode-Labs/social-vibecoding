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
// ── WHAT THIS FILE IS SINCE #1120 slice 35 ────────────────────────────
//
// A ROUTER. All eleven screens are React components under ./topochain/,
// dispatched through TOPO_REACT_SCREENS; this module renders no markup at
// all beyond the one content host it hands them. What stays here is the
// address (_subFromHash / _readSeasonEventsDeepLink / _syncHash), the
// screen-switch lifecycle (_renderShell / _renderSub / _unmountScreen), and
// the three helpers the screens defer to (canWrite / _alert / _confirm).
//
// LAYOUT: every screen renders through the shared list component (a real
// table at md+, a card stack below) and the shared Skeleton/EmptyState/
// ErrorState components in ./topochain/ui.tsx, so "loading", "nothing here"
// and "the request failed" never look alike.
//
// SECURITY (a previous task shipped an XSS here — non-negotiable): the
// escaping discipline this file used to carry as esc() is React's now — a
// value is a text child, never a string spliced into markup — and the
// screens are held to it by "no dangerouslySetInnerHTML, no innerHTML"
// assertions in tests/topochain-admin-screens.test.js. The one rule esc()
// could not express is per-screen: an admin/API-supplied URL is NEVER
// rendered as a clickable anchor (app-version-configs' update_url,
// challenge-templates' cta_link/mobile_cta_link and a waitlist signup's
// made_url are shown as text, not links), and the last of those has its own
// executed test against a hostile payload
// (tests/topochain-waitlist-survey.test.js). The one applicable outbound
// navigation, the CSV export, builds a same-origin path from a numeric id
// the client fetched itself.
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
  // programme Users screen is NOT listed: it has no section of its own —
  // features/admin/admin-users.tsx renders <ProgrammeUsers/> directly.
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
  //
  // What is left after #1120 slice 35: the three the screens defer to, and
  // the two fetch wrappers. Every markup builder this module carried —
  // esc(), safeHref(), the field/panel/list/pager/skeleton/empty/error
  // family — went with the screens, because nothing here renders markup any
  // more. Their React counterparts are ./topochain/ui.tsx, and the escaping
  // discipline they existed for is React's: a value is a text child, never
  // a string spliced into markup. The one rule esc()/safeHref() could not
  // express — never render an API-supplied URL as a clickable href — is now
  // per-screen and has its own executed test
  // (tests/topochain-waitlist-survey.test.js).

  canWrite() { return !!(window.AdminConsole && AdminConsole.canWrite()); },
  _alert(message) { if (window.AdminConsole) AdminConsole._alert(message); else window.alert(message); },
  async _confirm(opts) { return window.AdminConsole ? AdminConsole._confirm(opts) : window.confirm(opts.message); },

  // Safe fetch+parse, never throws, and its JSON-body wrapper. Both live in
  // ./topochain/api.ts so the screens and this module share one copy; these
  // stay as members because the module's own surface is what the tests pin.
  async fetchJson(url, opts) { return fetchJson(url, opts); },

  async send(method, url, body) { return send(method, url, body); },

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
  // Programme users — moved to ./topochain/programme-users.tsx
  // (#1120 slice 35). It was never a SUBS screen: it renders inside the
  // console's own Users section, which is React, so it is a child
  // component there rather than a host this module fills.
  // ══════════════════════════════════════════════════════════════════

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
