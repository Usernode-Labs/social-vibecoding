# Shell successor contracts — parallel implementation specification

Status: accepted-direction specification. This names the next reusable shell
patterns and their contracts without changing any React route, component, API,
or native bridge behavior.

## Product decisions encoded here

- The platform remains discoverable from every route, but a selected hosted
  dApp gets the majority of the viewport. Platform navigation is a compact
  header trigger and responsive sidebar, not a persistent mobile tab strip.
- Desktop expands the same navigation into a sidebar; it must not invent a
  separate information architecture.
- “Your apps” is a fast personal shortcut rail. “Explore” is discovery. They
  have different density and actions, rather than one `AppCard` forced into
  two jobs.
- dApp artwork is separate from platform icons. A finite, deterministic
  identity palette is specified in `shell-semantic-token-spec.md`.
- App status and attention remain legible without color; they are compact
  state summaries, not generic decorative badges.
- The existing iframe, session-cookie, iframe-token, sandbox, direct-link,
  bridge, WebView, and offline contracts are preserved exactly until a
  dedicated host-contract test approves a change.

## Contract index

| Successor | Replaces / consolidates | Initial owner |
|---|---|---|
| `PageHeader` | `PlatformShell`’s inline `<header>`, `IconLink`, title/actions wiring | shell worker |
| `PlatformNavigation` | `PlatformSidebar`, `mainLinks`, desktop/mobile navigation splitting | shell worker |
| `HomeAppShortcut` | personal-use branch of `AppCard`, favorite ordering controls in `AppsHome` | apps-home worker |
| `ExploreAppCard` | discovery branch of `AppCard`, generic catalog grid | apps-home worker |
| `AppIdentity` | name-hashed inline HSL fallback in `app-identity.tsx` | identity/token worker |
| `StatusDot` | ad hoc `Badge` status visual mapping and direct semantic color use | status worker |
| `FocusedAppFrame` + `AppChrome` | `HostedApp`, iframe-state presentation and selected-app shell affordances | host-frame worker |

No successor deletes its predecessor in the same change. Existing routes keep
working while each consumer moves after the new contract has its own evidence.

---

## `PageHeader`

### Public props

```ts
type PageHeaderAction = {
  id: "leaderboard" | "feedback" | "account" | "settings" |
      "notifications" | "admin" | "dev-console" | string
  label: string
  icon: LucideIcon
  href?: string
  onSelect?: () => void
  visible?: boolean
  badge?: { count?: number; tone?: "attention" | "status" }
}

type PageHeaderProps = {
  title: string
  navigationLabel: string
  onNavigationToggle: () => void
  actions: readonly PageHeaderAction[]
  compact?: boolean
  back?: { label: string; href: string } | null
}
```

`title` is route context, not a second platform brand. On platform home it is
`dApps`; in a focused dApp it is the dApp name. `compact` changes spacing and
may hide low-priority labels, never action reachability or action order.

### States and evidence

- `PlatformHome`, `FocusedApp`, `BackNavigation`, `NarrowOverflow`,
  `NotificationAttention`, and `AdminHidden` stories.
- Browser fixture: narrow and desktop header, keyboard navigation trigger,
  every visible action label, and no horizontal clipping at 320 CSS px.
- The action list is props-only. Admin eligibility and notification counts are
  resolved in owned adapters/route orchestration, not the header.

### Accessibility and performance

- Header is a landmark label or contains a labelled navigation trigger.
- Every icon-only action has one accessible name and a tooltip. `PlatformIcon`
  continues to own icon-grid sizing.
- Native title sync remains in the host adapter; `PageHeader` never calls the
  bridge.
- Static action arrays are stable. Badge updates should not remount navigation
  or the hosted iframe.
- Motion candidate: sidebar-trigger state only. Use reduced-motion-safe
  official sidebar motion; no custom header animation in this wave.

---

## `PlatformNavigation`

### Public props

```ts
type PlatformNavItem = {
  id: "apps" | "work" | "community" | "account" | "settings" | string
  label: string
  href: string
  icon: LucideIcon
  match: (pathname: string) => boolean
  group?: "platform" | "account"
  visible?: boolean
}

type PlatformNavigationProps = {
  items: readonly PlatformNavItem[]
  pathname: string
  brand: { label: "dApps"; href: string }
  preferenceControl: ReactNode
  onNavigate?: () => void
}
```

The same item source drives desktop sidebar, off-canvas narrow sidebar, and
header trigger. The known initial items are Apps, Your work, Community,
Account, and Settings. Notifications remains a PageHeader destination, not a
top-level navigation group. Its event-history meaning must remain distinct
from the Notifications destination.

### States and evidence

- `DesktopExpanded`, `NarrowClosed`, `NarrowOpen`, `ActiveCommunity`,
  `AccountFooter`, `AdminAbsent`, `SystemThemePreference` stories.
- Browser fixture: active route semantics, Escape closes off-canvas navigation,
  focus returns to header trigger, and navigation closes before route content
  receives focus on narrow screens.

### Boundaries

- This is presentation and route matching only. It does not fetch admin state,
  profile data, or notifications.
- It supersedes `PlatformSidebar` and `mainLinks` in
  `@/components/platform-shell.tsx`; `PlatformShell` remains composition and
  provider ownership until all consumers are migrated.

---

## `HomeAppShortcut`

This is deliberately not a small `ExploreAppCard`. It is a personal launch
surface for saved or collaborated dApps, optimized for a known destination.

### Public props

```ts
type HomeAppShortcutProps = {
  app: AppRecord
  href: string
  status: AppPresentationStatus
  reorder?: {
    position: number
    total: number
    disabled?: boolean
    pending?: boolean
    onMoveEarlier: () => void
    onMoveLater: () => void
  }
}
```

It displays `AppIdentity`, name, a concise personal marker where applicable,
status, and one primary destination. Reorder controls are absent unless the
explicit `reorder` contract is present; they do not appear as a three-dot menu
or on discovery cards.

### States and evidence

- `Running`, `Unavailable`, `Collaborator`, `ReorderFirst`, `ReorderMiddle`,
  `ReorderLast`, `ReorderPending` stories.
- Browser fixture: ordered list semantics; left/right reorder controls have
  app-specific accessible labels, retain focus after the optimistic update,
  and roll back only through the route/adaptor’s existing server error path.
- No drag-and-drop is introduced. Current reorder semantics are explicit
  earlier/later actions and remain keyboard/screen-reader operable.

### Boundaries

`AppsHome` retains `listApps`, search, favorite filtering, server write, and
rollback behavior. The shortcut is props-only and must not call an endpoint or
decide a personal/favorite grouping.

---

## `ExploreAppCard`

This is the browse/discovery card for every dApp, including a dApp the user
has not saved. It has one action: view details. Management, favorite, sharing,
and contribution actions belong one level below in app details.

### Public props

```ts
type ExploreAppCardProps = {
  app: AppRecord
  href: string
  status: AppPresentationStatus
  showCommunitySignal?: boolean
}
```

The layout is card/grid responsive: one column on narrow mobile, then a
bounded grid at wider viewports. Every card in a section uses the same width;
there is no intentionally mixed full-width/card-width presentation in a
single collection.

### States and evidence

- `Running`, `Building`, `AwaitingSecrets`, `Unavailable`, `WithCommunity`,
  `NoDescription` stories.
- Browser fixture: title and details action are independently intelligible;
  no hidden per-card overflow action; app image fallback has no duplicate
  accessible name.

### Boundaries

It succeeds the discovery use of `AppCard` in
`@/features/apps/app-card.tsx` and the `All apps` branch in `AppsHome`.
AppDetails remains the owner of favorite, collaborator, rename, share, and
Improve actions.

---

## `AppIdentity`

### Public props

```ts
type AppIdentityProps = {
  app: Pick<AppRecord, "id" | "slug" | "name" | "icon_url">
  size?: "sm" | "md" | "lg"
  decorative?: boolean // default true
}
```

For a supplied image it renders an empty-alt decorative image. For the
fallback it derives a slot solely from immutable `app.id`, using the v1 mapping
in `shell-semantic-token-spec.md`. It never hashes `name`, uses inline HSL, or
acts as a platform control icon.

### States and evidence

- `RemoteImage`, `FallbackSlot1`, `FallbackSlot8`, `RenameStable`,
  `Light`, `Dark`, and each size story.
- Unit tests cover stable ID → slot mapping, slug fallback only for malformed
  legacy fixtures, and a rename that keeps the selected slot.
- Contrast tests cover every slot/mode foreground, border, and focus ring.

### Boundary

This updates only `@/features/apps/app-identity.tsx`, consumed today by
`app-card.tsx` and `app-details.tsx`. It is not a child-app avatar or generic
icon primitive.

---

## `StatusDot`

### Public props

```ts
type AppPresentationStatus =
  | "running"
  | "building"
  | "awaiting-secrets"
  | "unavailable"
  | "paused"
  | "unknown"

type StatusDotProps = {
  status: AppPresentationStatus
  label: string
  detail?: string
  size?: "sm" | "md"
  showLabel?: boolean // default true
}
```

The mapping is owned and finite:

| Presentation status | Semantic role | Minimum non-color signal |
|---|---|---|
| running | positive | `Running` label or screen-reader name |
| building | info | `Building` label + progress context where available |
| awaiting-secrets | warning | `Configuration required` label |
| unavailable | negative | `Unavailable` / failure label |
| paused | attention | `Paused` label |
| unknown | neutral (existing muted/outline) | `Unknown` label |

`StatusDot` is the compact state glyph. It does not replace `Alert` for an
error that needs a recovery action, or `Badge` for arbitrary metadata. A
consumer must supply the human label; it may not render a raw API status as
the visual contract.

### States and evidence

- One story per status in light/dark, `DotOnly`, `WithLabel`, and
  `WithDetail`.
- Dot-only has an accessible name. Color is never the sole state signal.
- The dot’s role colors use only the proposed status/attention tokens. The
  single direct emerald wallet-link icon is not migrated until the positive
  role exists.

---

## `FocusedAppFrame` and `AppChrome`

These two parts separate contract-heavy hosting from platform presentation.

### Public props

```ts
type FocusedAppFrameProps = {
  app: AppDetail
  innerPath: string | null
  iframeToken: string | null
  offline: boolean
  onRetry: () => void
  onFrameLoad: () => void
}

type AppChromeProps = {
  app: AppDetail
  state: "loading" | "ready" | "offline" | "unavailable" | "self-hosted"
  onOpenDetails: () => void
  onImprove?: () => void
  onRetry?: () => void
}
```

`FocusedAppFrame` owns the exact iframe source validation, sandbox string,
token refresh cadence, frame ref, dev-console frame registration, and no
unrequested iframe remount. `AppChrome` is a compact, props-only presentation
layer around it: app title/identity, state, and essential escape hatches. It
is not a replacement page header and must not consume permanent vertical space
when the iframe is ready.

### States and evidence

- `Loading`, `Ready`, `OfflineRetry`, `TokenUnavailable`, `UnsafeDestination`,
  `SelfHosted`, `NotRunning`, and `NarrowFocused` fixture evidence.
- Browser host-contract tests assert source sanitization, `sandbox`,
  `allow`, token refresh, offline retry, direct-link inner path, header/native
  title handoff, back/history, and iframe continuity across compact chrome
  state updates.
- Screen-reader users get a named iframe and visible/announced loading or
  unavailable state. No fake iframe content is put in Storybook.

### Performance and motion metadata

`FocusedAppFrame` is a mount-continuity-sensitive pattern: it stays mounted
across header/sidebar, notifications, state badge, and compact-chrome updates.
Only a URL/token/retry change may replace the frame. It is a `review-later`
performance contract until browser profiling confirms the implementation.

Motion candidate: the `AppChrome` compact/expanded transition only. It must
respect reduced motion and must never animate an iframe size in a way that
causes resize/reload or hides a focused child-app control.

---

## Parallel source and story ownership

| Worker | New/changed source ownership | Story/test ownership | Must not edit |
|---|---|---|---|
| shell | `@/components/page-header.tsx`, `platform-navigation.tsx`, shell composition only | matching stories; platform navigation browser fixture | app cards, iframe host, token files |
| apps home | `@/features/apps/home-app-shortcut.tsx`, `explore-app-card.tsx`, AppsHome composition | both stories; apps-home route tests | shell/sidebar, app details mutations |
| identity/token | `@/features/apps/app-identity.tsx`; later token wave after approval | identity stories/unit/contrast matrix | AppsHome grouping, iframe host |
| status | `@/components/status-dot.tsx` and its mapping adapter | status stories and component a11y tests | token values until semantic-token approval |
| host frame | `@/features/apps/focused-app-frame.tsx`, `app-chrome.tsx`, HostedApp composition | host-contract browser tests | native bridge API, shell navigation internals |

Every owned reusable component must enter `design-system.manifest.json` only
when it has its named story states. Route-only orchestration remains evidenced
by fixture-driven browser tests. No worker may widen scope by importing legacy
`public/js` implementation or making direct API calls from presentation.

## Integration order

1. Approve the semantic-token specification before identity/status styling.
2. Land PageHeader and PlatformNavigation with adapters around the current
   `PlatformShell`; preserve current route/href behavior and header icons.
3. Split `AppCard` into `HomeAppShortcut` and `ExploreAppCard`; route data and
   favorite/reorder mutation behavior stay in `AppsHome`.
4. Migrate AppIdentity with deterministic slots and then introduce StatusDot
   after role tokens are available.
5. Extract FocusedAppFrame without changing iframe URL, sandbox, token, or
   offline behavior; layer AppChrome on it only after parity fixtures pass.
6. Update catalog, Storybook, browser/a11y evidence, and cutover notes per
   slice. Retire an old local pattern only once all of its route consumers have
   moved and the route-parity checklist is approved.
