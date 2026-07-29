# Social Vibecoding code pattern index

**Scope:** current production `main`, `808f7da68ddd563563bc7152fb6db3e0ee9933ae`, audited 2026-07-28. Production `/api/status` reported the same SHA during the audit.

**Method:** code-only, user-perceived pattern audit. This is an index for the screenshot/TLDraw review, not a claim that existing markup defines the future design system or a framework mapping.

## 1. Surface map

| User-visible surface | Entry route / host | Principal code | Candidate system area |
|---|---|---|---|
| Platform home and app catalogue | `#`, `#create` | `home.js` | application shell; app tile/grid; create CTA; contextual app menu |
| Hosted child app | `#app/<slug>/app`, `#app/<slug>/full` | `app-view.js` | iframe host, embedded/chromeless state, app header/tabs, safe-area/back behavior |
| Developer workspace | `#app/<slug>/dev` plus chat/session/topic deep links | `app-view.js`, `dev-chat.js`, `group-chat.js` | work-item cards/rows, message/composer, forum/topic, kanban, PM board, spec/build tooling |
| Leaderboard | `#leaderboard[/history|users/... ]` | `leaderboard.js` | tabs/segmented control; dense data rows; profile detail |
| Challenges | `#challenges` | `challenges.js` | domain card/list and progress/status |
| Profile | `#profile` | `profile.js` | profile header, token/event cards, allocation/status |
| Admin | `#admin[/users|codes|limits|features|db-export]` | `admin-console.js` | responsive admin shell, section nav, data display, forms/confirmation |
| Global chrome | all shell routes | `index.html`, `app.js`, `header-layout.js` | app shell, header, drawers, mobile safe areas, title/back state |
| Global native/account surfaces | menus/sheets/settings | `native-chrome.js`, `node-pill.js`, `wallet-sheet.js`, `settings.js` | capability-gated setting rows, device status, wallet/receipt sheet |
| Work and notifications | global header actions | `work-drawer.js`, `notifications.js` | anchored panel → touch sheet, notification/actionable rows, badges |
| Auth and legacy standalone surfaces | separate HTML pages | `login.html`, `register.html`, dashboard/debug/gallery/older admin pages | separate visual-audit bucket; do not silently treat as canonical shell patterns |

The hash router in `app.js` is the canonical page-state index. It also preserves historical routes and supports a chromeless child-app mode with a validated inner path. The future framework must preserve those entry contracts until a coordinated replacement exists.

## 2. Structural facts, not design verdicts

- The SPA is static HTML plus ordered classic scripts: 43,322 total lines across `public/js`, `app.css`, and `index.html`; the largest UI modules are `app-view.js` (10,560 lines), `dev-chat.js` (5,933), `app.js` (3,370), `group-chat.js` (3,317), `home.js` (2,474), and `app.css` (3,636).
- Rendering is imperative and string-template based: 247 `innerHTML` assignments across 19 JavaScript files, 312 literal buttons, 68 literal inputs/textareas/selects, and 206 `fetch()` call sites in frontend JS.
- Presentation is not centrally constrained: 2,992 literal Tailwind colour utility occurrences appear across HTML/JS/CSS. This measures duplication, not necessarily visual inconsistency.
- There is a useful hosted interaction kit (`usernode-native/v1`) plus `PlatformUI`, especially for toasts, adaptive menus, sheets/dialogs, transitions, switch behavior, drag/reorder and pull-to-refresh. Adoption is selective: the live shell uses safe-area classes and switches, but the grouped-row and touch-target helpers are not broadly used.
- The current code already has several genuine domain-level render seams: `Home.renderAppCard`, issue/proposal/governance/session cards in `AppView`, markdown rendering, `MergeStatus`, and notification/work rows. These are candidates for evidence-driven product patterns, not generic primitives by default.

## 3. Candidate user-perceived pattern map

This is a hypothesis list awaiting visual confirmation. It names the interaction the user perceives and the behavior the code is currently carrying. It deliberately does **not** say how to implement it in a future system.

| Candidate pattern | Code evidence | What the user perceives / can do | Screenshot questions |
|---|---|---|---|---|
| **App shell and scroll owner** | `index.html` fixed header, separate sibling mains, `app-view`, bottom App/Dev nav | A persistent platform frame; users move between catalogue, platform views, an app, and its developer workspace while one screen region scrolls. | Is there exactly one intended scroller on each surface? What changes on mobile/desktop, keyboard and chromeless iframe? |
| **Header + contextual actions** | `platform-header`, collision-aware `header-layout.js`, back/menu/work/notification/admin actions | A changing title and contextual controls: navigate back, open menu, inspect work/notifications, enter admin. | Which controls are persistent, contextual, overflowed, or absent by viewport/mode? |
| **Adaptive drawer/panel** | header menu, work drawer, notifications; `PlatformUI` touch adaptation | A temporary task-focused surface for navigation, status, work items, or alerts; anchored on desktop and sheet-like on touch. | Desktop anchored panel vs touch sheet; focus/escape, state persistence and action density? |
| **Button and icon action** | 312 literal buttons, widespread copied utility strings | Users trigger creation, navigation, save, retry, destructive actions, overflow menus, and compact toolbar operations. | Which variants/states recur: primary, destructive, ghost, compact toolbar, icon-only, loading? |
| **Fields and form sections** | settings/admin/create/auth/app secrets and inline dev tools | Users enter, select, toggle, search, upload, confirm and receive validation or save feedback. | Error/help/live-state placement, mobile keyboard, capability/permission/async states? |
| **Tabs, segmented controls and filters** | App/Dev nav, leaderboard, kanban, admin sections, theme and filters | Users switch between peer views, modes, time windows, filters, or sections without leaving a conceptual screen. | Which are navigation versus selection/filtering? What becomes a sheet/tab strip at narrow widths? |
| **Actionable row families** | settings, drawer, notifications, leaderboard, admin and roster rows | Users scan compact items with a leading identity/status, primary label, metadata and a trailing value/action; some rows navigate, select, reorder or reveal details. | Leading/trailing slots, nested actions, badges, navigation, swipe/reorder, selection? |
| **Cards/work items** | home app tiles; issue, proposal, governance, session, merged cards; profile/challenges | Users browse independently actionable summaries: apps, developer work, challenge/profile items and lifecycle records. | Are the cards a common surface or separate app/browser/workflow metaphors? |
| **Status/badge/pill** | status selectors, app/version/fork/status helpers, `MergeStatus` | Users read concise state: deployment, lifecycle, role, unread count, ownership, review/vote/merge state. | Is colour supplemented by icon/text? What live/unknown/error states must exist? |
| **Async boundary** | scattered loading, empty, failure and retry markup in every major surface | Users understand whether data is loading, absent, unavailable, denied, stale or needs a retry. | What is the distinction among loading, empty, offline, permission-denied, degraded and error? |
| **Overlay confirmation/feedback** | `PlatformUI` toast/alert/confirm/menu; legacy modal adoption | Users receive transient success/error feedback or must confirm/complete a focused task without losing context. | Focus trap/restore, destructive confirmation, async dismissal and stacked overlays? |
| **Data display / admin table** | leaderboard rows, dashboard table, admin responsive rows | Users compare, filter, select and act on structured records; presentation changes with density and viewport. | Do wide tables transform into cards/rows on mobile? Which sorting/filtering/selection behavior is truly shared? |
| **Conversation and composer** | `dev-chat.js`, `group-chat.js`, streaming, attachments, mentions, Q&A, drafts | Users converse with an agent or people, follow streamed/progress states, attach context, reply, choose next actions and recover drafts. | What is shared between AI chat and group chat versus irreducibly different? |
| **Kanban / PM board** | `AppView` board, filters, drag, breakpoint work in #815/#822 | Users organize, inspect and move work across stages; the same work needs a viable narrow-screen representation. | At which widths is it tabs, horizontal board, or list? What is keyboard/touch drag fallback? |
| **Hosted child-app shell** | app iframe, chromeless route, bridge/native escape paths | Users enter an app in platform chrome or full-screen, retain an escape path, and encounter online/loading/error/native-capability boundaries. | What visual responsibility is platform-owned vs child-app-owned? Online/offline, direct visit, safe areas, loading and bridge states? |

## 4. What the current index deliberately does *not* conclude

1. It does not declare every repeated class string a component.
2. It does not treat legacy standalone pages or compatibility modal plumbing as a model for the new system.
3. It does not judge visual hierarchy, quality, responsiveness, accessibility correctness or cross-child-app consistency—those require the screenshot/TLDraw pass.
4. It does not prescribe a future framework, component mapping or migration order. Those come only after user-perceived patterns have been confirmed.

## 5. Next evidence pass

For each screenshot/state, attach: route, viewport/mode, state/data condition, interaction notes, matching candidate pattern(s), and code owner. Then decide only whether it is a **shared cross-surface pattern**, **domain compound pattern**, **app-local detail**, or **legacy/compatibility artifact**.

Framework and component mapping begins only after that cross-check—not from this code index alone.
