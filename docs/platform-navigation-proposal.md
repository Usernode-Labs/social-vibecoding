# Platform navigation proposal

**Status:** Accepted product direction; implementation pending

**Date:** 2026-07-29

**Scope:** React platform shell, platform-owned routes, and shell-side hosted-app frame

Implementation authority, including the delivery waves:
[`shell-refinement-guide.md`](shell-refinement-guide.md).

## Decision

Use a platform Home, a push drawer, and focused mini-app cards.

- Global navigation lives in the drawer.
- Home is a personalized launch surface.
- Explore is the ecosystem catalog.
- An open app is a visually contained card on the platform plane.
- Use, Improve, Close, app diagnostics, and true nested Back are contextual app
  controls.
- The platform-menu control shows only an attention dot. Counts and sources
  appear after the drawer opens.

The primary platform destinations are:

1. Home
2. Explore
3. Work
4. Challenges
5. Activity

Node health is a separate technical section. Account, Settings, Send feedback,
and a conditionally visible Admin entry sit below it.

## Why this model

### Navigation should match switching frequency

Apps, Work, and Challenges are not destinations people repeatedly switch
between during one focused session. A persistent bottom bar would consume
mobile space without matching the expected hub-and-spoke behavior:

1. enter through a personal app shortcut or attention item;
2. use or contribute to an app;
3. return to the platform or switch scope when needed.

### Platform guidance supports adaptive drawers and nested Back

- Apple uses tab bars for peer destinations that merit persistent,
  high-frequency access and sidebars for broader information architecture.
- Android distinguishes top-level drawer navigation from Back/Up navigation
  within a task.
- Wider layouts may reveal the drawer as a sidebar. Narrow layouts may present
  it temporarily while preserving the same destination order and meaning.

Primary references:

- [Apple Human Interface Guidelines: Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
- [Apple Human Interface Guidelines: Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Apple Human Interface Guidelines: Split views](https://developer.apple.com/design/human-interface-guidelines/split-views)
- [Android navigation principles](https://developer.android.com/guide/navigation/principles)
- [Android navigation drawer](https://developer.android.com/develop/ui/compose/quick-guides/content/create-navigation-drawer)
- [Android NavigationUI](https://developer.android.com/guide/navigation/integrations/ui)

### Apps are focused contexts

People enter an app to use it or contribute to it, then work deeply. The
platform must remain reachable without:

- leaking the previous platform page beneath the app;
- turning the app into a cramped embedded viewport;
- creating desktop-style window management;
- duplicating global navigation inside every app.

### Attention needs one source of truth

The platform needs one global indication that something important exists.
The drawer reveals the count, and Activity explains the source, context, and
next action. Counts should not be scattered across every platform destination
or app.

## Pattern decision

- **Operating mode:** quick check and exploration leading into focused app use
  or contribution.
- **Session shape:** glanceable and interruptible at platform level; high-focus
  inside an app.
- **Trust level:** normal for navigation and app use; elevated for Improve,
  permissions, administration, and infrastructure actions.
- **Device context:** one-handed mobile first and small-screen safe; adaptive
  sidebar behavior on wide screens.
- **Chosen pattern:** platform Home, pushed app routes, same-plane push drawer,
  and contextual app chrome.
- **Primary action placement:** current-route or current-app action in the app
  bar; at most one primary action plus overflow.
- **Escape routes:** Close returns an app to Home; Back handles genuine nested
  routes; the menu opens global scope.
- **Rejected alternatives:** persistent bottom navigation, a six-icon global
  toolbar, an unlabeled Home icon, overlaying the drawer on top of the app,
  and treating the Dev Console as a platform destination.

## Information architecture

### Drawer

```text
[Platform identity]                         [close]

Home
Explore
Work
Challenges
Activity                                      3

------------------------------------------------

NODE
Node                                           ●

------------------------------------------------

Account
Settings
Send feedback
Admin                         verified admins only
```

Rules:

- The order and labels are stable across window sizes.
- The menu control may show an attention dot, never a number.
- The Activity row shows the unresolved attention count after the drawer opens.
- Opening the drawer does not mark anything read.
- Theme selection lives inside Settings.
- Admin is one server-verified, capability-gated entry. Admin subnavigation
  belongs to the Admin area, not the primary drawer.
- Healthy Node status does not need another global toolbar control.

### Destination meanings

| Destination | Job |
| --- | --- |
| Home | Personalized app shortcuts and a small important-attention preview |
| Explore | Search and discover the ecosystem app catalog |
| Work | Sessions, proposals, and completed improvement work |
| Challenges | The current community experience; leaderboard and reputation remain secondary content within it |
| Activity | Complete attention and notification history across platform sources |
| Node | Read-only node and infrastructure health |

Use **Explore**, not **App Store**, until apps have a meaningful add, install,
purchase, ownership, permission, or update lifecycle.

### Proposed route ownership

Preserve compatibility while changing labels and page composition.

| Product destination | Proposed React route | Notes |
| --- | --- | --- |
| Home | `/react/` | Replaces the mixed personal/catalog Apps Home |
| Explore | `/react/explore` | Receives search, discovery, and the current all-app catalog |
| Work | `/react/work` | Existing route |
| Challenges | `/react/community/challenges` | Existing route; drawer label becomes Challenges |
| Activity | `/react/notifications` | Existing route may retain its URL while its product label becomes Activity |
| Node | `/react/node-status` | Existing route |
| Account | `/react/account/profile` | Existing route |
| Settings | `/react/settings` | Existing route |
| Send feedback | `/react/feedback` | Existing route |
| Admin | `/react/admin` | Existing route; visible only after verified authorization |

App routes remain separate from platform destinations:

- `/react/apps/:slug` — platform-owned app detail;
- `/react/apps/:slug/open` — focused app use;
- `/react/apps/:slug/dev` — focused contribution workspace;
- nested session, issue, governance, proposal, preview, and discussion routes
  remain children of the app improvement context.

Route changes must preserve existing hash/deep-link and browser/native Back
contracts until parity evidence authorizes retirement.

## Home

Home is the conceptual equivalent of a phone or desktop home screen. Keep it
deliberately sparse.

```text
Your apps

[icon]       [icon]       [icon]
Puzzle       Habit        Game
Orbit        Lab          Corner

Explore apps →

Needs attention
Proposal ready for review · Puzzle Orbit
Challenge invitation · Game Corner

View all activity →
```

Requirements:

- Show labeled app icons; do not use icon-only launching.
- Prefer pinned apps, then recent apps.
- Tapping an app opens it directly.
- Provide a small Explore CTA rather than embedding catalog search.
- Preview at most three important Activity items.
- Do not add a general chronological feed, recommendations, statistics, or
  platform administration to v1 Home.
- Closing an app returns to Home.

If the personal app collection eventually exceeds the useful Home capacity,
add a dedicated My Apps management view later. Do not put a long app list in
the drawer.

## Explore

Explore owns ecosystem discovery:

- search;
- categories;
- new and notable apps;
- popular or trending apps;
- the complete app catalog;
- app detail entry;
- Create app, when available, as a contextual Explore action.

Explore does not own personal attention, current work, account settings, or
node health.

## Activity and attention

Activity is the single explanation layer for important platform events.

### Platform-menu indicator

- Hidden when no important unresolved activity exists.
- A dot only when attention exists.
- Never display a platform-level count or source.
- Accessible name example: `Open platform menu; new activity needs attention`.

### Drawer Activity row

- Show the unresolved attention count only after opening the drawer.
- Cap the visual count if needed, for example `9+`.
- Do not clear the count merely because the drawer opened.

### Activity page

- Explain the originating app or platform section.
- State why the item needs attention.
- Provide one clear next action.
- Order actionable items before ordinary history.
- Treat blocking, directly addressed, and time-sensitive items as higher
  priority than recent informational events.
- Link Work-related events back to their Work or app improvement destination
  rather than maintaining a competing copy.

Home shows only a small preview. Activity owns the complete history.

## Node

Node is a single technical drawer section separated from primary navigation
and bottom utilities.

Visual status:

| Dot | Meaning |
| --- | --- |
| Green | Synced |
| Amber | Syncing |
| Red | Unavailable or needs attention |
| Grey | Unknown |

The row label remains `Node`; the dot is not an icon-only destination. Expose
the status through an accessible name, such as `Node, synced`. Tapping the row
opens the detailed Node status route.

Node health and Activity attention are independent:

- the platform-menu dot means important user attention exists;
- the Node dot means infrastructure health;
- a Node failure may create an Activity item only when the user must act.

## Open-app spatial model

The platform is the base plane. The mini-app is a card on that plane. Opening
the drawer reveals more of the platform plane and moves the card aside.

```text
Closed

platform background
┌────────────────────────────────────────────┐
│ app card                                   │
│ ☰•  Puzzle Orbit             Improve    ×  │
│                                            │
│ mini-app uses the available viewport       │
└────────────────────────────────────────────┘


Drawer open

platform background
Home          ┌────────────────────────────────────────┐
Explore       │ Puzzle Orbit             Improve    ×  │
Work          │                                        │
Challenges    │ app remains mounted and preserves state│
Activity  3   └────────────────────────────────────────┘
Node  ●
```

Behavior:

- Wide screens: drawer and app may settle side by side.
- Phones: retain the app width and translate it mostly offscreen; do not
  compress it into an unusable column.
- The drawer sits on the platform background rather than inside another card.
- Do not show the previous Home, Explore, or Activity page beneath the app.
- Do not use draggable, resizable, stacked, or overlapping app windows.
- Opening the drawer must not unmount or reset the hosted app iframe.
- While the temporary mobile drawer is open, move accessibility focus into it
  and make the shifted app inert.
- Provide a visible drawer Close control. Tapping an exposed app edge may also
  close the drawer but cannot be the only escape.

## Contextual app chrome

Example states:

```text
Use mode
☰•  Puzzle Orbit                     Improve    ×

Contribution mode
☰•  Puzzle Orbit · Improve               Use    …    ×
```

Rules:

- The app name communicates the current app.
- `Improve` enters the app contribution workspace. The technical route may
  remain `/dev`.
- In contribution mode, the reciprocal action is `Use` or `Open app`.
- `×` closes the app and returns Home without unexpectedly destroying app
  state.
- App-specific secondary actions live in overflow.
- Do not show both Use and Improve as permanent equal-weight mode buttons.
- Hide contribution actions when they are not meaningful or authorized.
- All icon controls have at least a 48-by-48 CSS-pixel target and an accessible
  label or tooltip.

### Dev Console

The Dev Console is contextual diagnostics for the active hosted app or staging
preview. It is not a drawer destination or the contribution workspace.

- Place Console in app overflow or improvement chrome.
- Surface an error badge only while an active app or preview reports errors.
- Preserve the existing error-only versus always-visible preference under
  Settings → Developer experience.
- Do not show Console when no active app or staging preview owns its output.

## Back, Close, and menu

These controls answer different questions:

| Control | Meaning |
| --- | --- |
| Menu | Change global platform scope without closing the current app |
| Close | Put away the current app and return Home |
| Back | Return from a genuine nested route to its parent |

Remove page-body buttons such as:

- `← Back to apps`;
- `← App details`;
- `← App Dev`;
- `← All sessions`.

Replacement rules:

- Platform roots use the menu control.
- Open app use and app improvement roots use Close.
- Genuine nested app routes put one Back affordance in app chrome.
- Deep flows may add a short breadcrumb when it materially improves context.
- Back must preserve React Router, browser history, native WebView, and
  existing deep-link behavior. The drawer is not a replacement for the route
  stack.

## Global destinations versus contextual actions

Move the current global toolbar into the drawer:

| Current control | New ownership |
| --- | --- |
| Leaderboard | Challenges |
| Admin operations | Conditional Admin entry |
| Send feedback | Bottom utility |
| Account | Bottom utility |
| Settings | Bottom utility |
| Theme | Settings |
| Notifications | Activity |

Keep route- and app-specific actions contextual:

| Context | Example primary action |
| --- | --- |
| Home | None required |
| Explore | Search; Create app when available |
| Work | Current work action or Refresh |
| Challenges | Current challenge action |
| Activity | Mark all read; secondary refresh in overflow |
| App detail | Use or Improve |
| App use | Improve and Close |
| App improvement | Use, current improvement action, overflow, and Close |
| Nested app route | Back plus one current-route action |

## Deliberate v1 removals

- Persistent bottom navigation.
- The six-icon global toolbar.
- An unlabeled Home icon in app chrome.
- A long My Apps list in the drawer.
- Source badges scattered across Work, Challenges, and individual apps.
- A platform-level numeric badge.
- Theme as a global control.
- Dev Console as a global destination.
- Expanded Admin links in the main drawer.
- Dashboard or app context visibly preserved beneath an open app.
- Window-management behavior for mini-app cards.

## Implementation guardrails

- Candidate A governs only the React platform shell and shell-side hosted-app
  frame. Do not modify child-app source or app-factory scaffolds for shell
  conformance.
- Preserve API, authentication, native bridge, iframe sandbox, service worker,
  session cookie, hash/deep-link, external-link, and browser-history contracts.
- Keep the existing legacy route reachable until route-parity evidence is
  complete and reviewed.
- Use the official local shadcn/Base UI primitives before creating an owned
  pattern.
- Keep server reads and writes in `@/lib`; presentation components do not call
  endpoints directly.
- The shell owns one `main` landmark. Each route owns one route-aware `h1`.
- Register any new reusable shell pattern and its named Storybook states in
  the design-system authority.

## Host-contract appendix

The completed Flutter/WebView review establishes this boundary:

- **The web shell owns all presentation.** Flutter hosts the WebView and native
  capabilities; it does not duplicate shell navigation, app chrome, safe-area
  padding, or theme presentation.
- **Safe areas require a host fix.** The host must provide true edge-to-edge
  content and avoid wrapping the web shell in padding that creates double
  insets. Keep the web viewport contract unchanged until device evidence
  authorizes it.
- **Bridge caller authentication is a cutover blocker.** Privileged native
  bridge methods must authenticate the calling web origin/frame and retain
  least-privilege boundaries; route parity is not a substitute.
- **Shortcuts and widgets reopen the web-owned route.** Every native shortcut
  or widget uses the same focused-app URL/deep-link contract and canonical app
  assets as the web shell.
- **Real devices provide the final evidence.** iOS and Android must prove
  viewport zoom, browser/native Back, drawer dismissal, offline/service-worker
  readiness, external-link handling, keyboard/focus, and safe-area behavior.

These are parallel host-lane responsibilities in the execution plan inside
[`shell-refinement-guide.md`](shell-refinement-guide.md). The static web shell
may be reviewed before they finish, but cutover may not bypass their stop
gates.

## Required implementation evidence

At minimum, provide deterministic evidence for:

- Home: populated, empty, loading, attention preview, mobile, and desktop;
- Explore: search, catalog, empty/error, mobile, and desktop;
- drawer: open/closed, attention/no-attention, each Node state, admin/non-admin,
  mobile temporary and wide persistent presentations;
- app chrome: Use, Improve, nested route, Dev Console error, offline/error, and
  Close;
- Activity: no items, important items, history, pagination, and mark-read;
- hosted-app mount continuity while opening and closing the drawer;
- route, hash, browser Back, and native WebView Back behavior;
- keyboard and focus order;
- accessibility scans with no critical or serious violations.

## Suggested implementation sequence

1. Split the current Apps Home responsibilities into Home and Explore without
   retiring legacy routes.
2. Introduce a props-only shell/navigation view with explicit drawer,
   attention, Node, and authorization states.
3. Move global toolbar destinations into the drawer and Theme into Settings.
4. Add focused app chrome and same-plane drawer behavior while preserving
   hosted-app iframe mount continuity.
5. Replace page-body Back controls with route-aware shell/app chrome.
6. Consolidate Home preview and Activity count semantics on one data model.
7. Add deterministic stories, route fixtures, history tests, accessibility
   evidence, and the route-parity record.

## Acceptance statement

The platform contains apps. Home is personal. Explore is the ecosystem.
The drawer owns global navigation. App chrome owns context.
