# Social Vibecoding: evolutionary UX organization

**Purpose:** a first-principles information-architecture and interaction direction derived from the pattern audit. It deliberately challenges the current organic arrangement while preserving the product’s recognizable destinations and strongest workflows.

This is a **north-star organization**, not a mandate to redesign every screen or child app.

## Design stance

The product is not one application. It is a platform where users:

1. discover and use apps;
2. make and supervise changes to those apps;
3. participate in a community/governance system; and
4. manage their identity, wallet, node and device.

The existing UI has all of these capabilities, but exposes many of them as peer icon actions, separate drawers, or newly added screens. The result is capable but cognitively flat: users must remember what each icon or sheet represents before they can orient themselves.

The corrective is **not** a radical new product model. It is to give the existing concepts an explicit hierarchy:

```text
Platform
├── Apps       — discover, open and manage the apps I use
├── Work       — my active changes, notifications and decisions needing attention
├── Community  — challenges, rankings, contribution/profile history
└── Account    — wallet, node, settings and device capabilities

Inside an app
├── App        — the app’s own product experience
└── Dev        — the shared development workspace for that app

Conditional
└── Admin      — operational controls, visibly separate from ordinary use
```

This keeps every familiar destination. It changes their *organization*, labels and prominence so a user can answer “where am I, what needs me, and what can I do next?” without decoding an icon cluster.

## What should stay

### 1. The catalogue remains the home

The app grid is the platform’s clearest mental model. It should remain the default landing surface: search, app identity, availability, membership and app-local actions are all meaningful. Do not turn it into a generic dashboard.

### 2. App and Dev remain a hard boundary

This is already the strongest structural decision in the product. **App** belongs to the child app and keeps its own identity; **Dev** is a Usernode platform workspace for work, review, governance and agent sessions. The new system should strengthen that boundary, not homogenize the two sides.

### 3. The Dev workspace remains one work set with multiple projections

List, Kanban and PM are alternate views of the same work—not separate destinations. The current mobile Kanban transformation into counted status tabs is a sound non-radical direction. Keep it, but make the selected view and filter state legible and persistent.

### 4. Native companion surfaces remain native

Wallet, node, device permissions, benchmark and retained Flutter settings should keep their implementation boundaries. The web system should share concepts and state vocabulary with them, not force false visual or technical convergence.

### 5. Child-app visual identity remains app-owned

RecipeBot, Supply Line, Game Corner, Tier Lists and other apps demonstrate that the factory must produce compatible applications, not identical skins. The platform should standardize host behavior and accessibility contracts, not impose one creative direction on app content.

## What should be reorganized

### A. Replace the “many peer icons” model with a job model

The catalogue header currently makes community, work, navigation, settings, notifications and admin feel like equal, icon-only peer destinations. On a small phone that is visually dense and semantically weak.

**Evolutionary direction:** retain compact header actions only for the current-context action, global search where relevant, and an attention indicator. Move destination semantics into a small, named platform navigation model:

| User job | Existing destinations consolidated under it | Why this is clearer |
|---|---|---|
| **Apps** | catalogue, create/import, app-local overflow | The default “use an app” job stays primary. |
| **Work** | Your work, notifications, active sessions/proposals, actions needing vote/review | These all answer “what needs me now?” and should share an attention model rather than live in separate sheets. |
| **Community** | leaderboard/kudos, challenges, profile/history | These are contribution/progression/discovery, not device settings or app browsing. |
| **Account** | node, wallet, settings, theme, device permission state | These are personal capability/control state; they need clearer trust and status hierarchy. |
| **Admin** | current admin console | Conditional, explicitly operational, never a peer consumer destination. |

This can be introduced first as a labelled navigation/menu structure before committing to a permanent bottom navigation. The change is semantic and organizational before it is visual.

### B. Turn Work and Notifications into one attention centre

The two current sheets use similar mechanics but divide related questions:

- *What am I currently doing?*
- *What changed that needs attention?*

Users should encounter one **Work** destination with top-level sections such as **Needs your attention**, **Active sessions**, and **Recent activity**. The current grouped notification rows and personal work rows become two row families inside one destination, not competing header affordances.

Do not merge their data model or force their layouts to match. The shared abstraction is attention and recency, not identical row markup.

### C. Give account/device state a deliberate trust surface

The root drawer currently mixes node, wallet, settings, challenges, profile and theme. Node/wallet health is operationally important and security-adjacent; challenges/profile are community destinations. That mix weakens hierarchy.

**Direction:** Account becomes the home for wallet/node/settings/device. Its first view should answer:

1. Is this device/account usable right now?
2. Is an action required?
3. What high-trust action can I take next?

Community moves out of that list. Existing native “Action Needed” treatment is useful evidence: permissions/health deserve an explicit callout, not an incidental menu row.

### D. Make the App/Dev boundary self-explanatory

The bottom App/Dev switch is a good persistent affordance, but the Dev entry needs a short, concrete orienting state: app identity, current capability/lock state, active work count and selected projection. This helps users understand that they are leaving the app product to manage its evolution—not opening an unrelated feature.

### E. Reduce card/chip competition in Dev

The lifecycle work card is valuable but often carries title, author, PR metadata, several status chips, checks, votes, priority, category, assignee and actions at equal weight. This is where an organic system most visibly becomes noisy.

Give each work card a hierarchy contract:

1. **Primary:** what is the work and what does the user need to decide/do?
2. **Secondary:** lifecycle state and owner/review relevance.
3. **Tertiary:** PR number, timestamps, less urgent tags and diagnostics.

Do not remove important data; progressively disclose it through the detail surface or a compact overflow. Status must answer *what is true now and whether action is required*, rather than becoming decorative pills.

### F. Design one responsive system, beginning with the strongest constrained evidence

The available evidence is Android/mobile, so it exposes the hardest density, safe-area, keyboard and touch constraints. It must not become a mobile-only product decision. Every shared pattern needs one cross-viewport contract: the user job, state and information hierarchy stay constant; navigation density, projection and placement adapt.

Adopt the mobile constraints as first-class:

- one intended scroll owner per state;
- named top/bottom safe-area ownership;
- sheets and dialogs that do not lose keyboard focus or dismiss critical context;
- touch-readable metadata and action targets;
- a responsive projection for dense workspace data rather than a compressed desktop layout.

Desktop/browser can add width, side-by-side context, persistent navigation and richer comparison surfaces, but it must preserve the same user jobs and state model. A responsive design is not “the mobile screen stretched”: it has deliberate wide-layout states.

| Shared area | Narrow/touch expression | Wide browser expression | Invariant |
|---|---|---|---|
| Platform destinations | compact labelled navigation or menu; one primary content region | persistent rail/sidebar or clear named top navigation | Apps, Work, Community, Account and conditional Admin remain the same destinations. |
| Work attention | sheet or full-screen list; prioritised sections | persistent inbox panel or split view beside current context | One attention model, with the same work/notification states. |
| App catalogue | two-column/compact responsive grid | denser grid with optional context/filters pane | App identity, availability, membership and local actions stay legible. |
| Account/device | focused full-width task/sheet | settings/detail split view where useful | High-trust status, native handoffs and action-required states stay explicit. |
| App Dev workspace | one projection at a time; counted Kanban status tabs | list/board/PM can coexist with inspector/detail panes | One work set, one filter state and one lifecycle vocabulary. |
| Work detail/session | full-screen detail with persistent bottom composer | detail + context/preview/inspector panels where space earns them | Conversation, evidence, action and decision state remain coherent. |

## Screen-level organization direction

| Current area | Evolutionary organization | Explicit restraint |
|---|---|---|
| Catalogue | **Apps**: search, app tiles, create/import, local app actions | Keep two-column browse model and app-owned icon identity. |
| Work drawer + Notifications sheet | **Work**: one attention centre with needs-attention, sessions and activity sections | Preserve distinct work and notification row families. |
| Leaderboard + Challenges + Profile | **Community**: contribution/progression hub with tabs/subsections | Do not turn it into a generic social feed. |
| Node + Wallet + Settings + Theme | **Account**: capability, balance, device and settings | Keep high-trust native flows opaque/native where needed. |
| Per-app App/Dev tabs | **App / Dev**: persistent app context, explicit switch | Never force child app UI into platform visual identity. |
| Dev list/kanban/PM | **Work views** of one work set | Preserve mobile status-tab Kanban rather than horizontal squeezing. |
| Issue/proposal/session detail | **Work detail**: evidence, discussion, decision, action | Keep the fixed composer and lifecycle evidence; reduce visual competition. |
| Admin | **Admin**: conditional operational area | Keep read-only/danger/permission state unmistakable. |

## Principles for an iterative redesign

1. **Move before inventing.** Consolidate existing destinations around user jobs before creating any new surface.
2. **Name the destination, not its implementation.** “Work” is meaningful; “drawer” and “notifications” are mechanisms.
3. **One focal point per surface.** Catalogue = find/open an app; Work = decide what needs me; Account = trust/capability; Dev card = next decision.
4. **Use the lightest visual separation that works.** Dense operational lists need rows/dividers first, not nested cards and badges.
5. **State is part of information architecture.** Locked, loading, offline, read-only, pending review and action-required states belong in the named structure, not as surprise overlays.
6. **Keep intent stable through migration.** Existing deep links, App/Dev routes, hosted iframe paths and native escape hatches remain compatibility contracts while their presentation improves.
7. **Make the user’s next action obvious.** Especially in empty, degraded, permission and governance states.

## Suggested design exercise before implementation

Create a small, reviewable set of static information-architecture sketches—not high-fidelity screens—for these five moments:

1. Apps catalogue with the revised platform navigation.
2. Work attention centre, combining the current work and notification concepts.
3. Community hub with progression/ranking/history.
4. Account/capability home with native wallet/node handoffs.
5. App Dev workspace list view and its mobile Kanban transformation.

For each sketch, evaluate against the captured screenshots:

- Does every current major destination still have a clear home?
- Does a user know where they are and what needs action without icon memorization?
- Has any child-app visual identity been incorrectly absorbed into platform chrome?
- Can an existing deep link/bridge/native handoff still land in an understandable state?

Only after this review should the first implementation slice be selected. The likely first slice may remain the mobile sheet + grouped rows, but its contract should include a narrow and wide scenario and reflect the final **Work** and **Account** organization rather than preserving the current mixed root drawer.
