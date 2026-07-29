# From current patterns to Candidate A: fit map and next steps

**Status:** planning addendum, 2026-07-28
**Inputs:** [frontend platform programme](frontend-platform-decision-plan.md), [Candidate A foundation charter](frontend-platform-pre-registration.md), and the [user-perceived pattern audit](social-vibecoding-user-perceived-pattern-audit.md).

This document answers only two questions:

1. Where does the **official shadcn surface** already offer a good behavioral/presentation starting point?
2. What is the smallest next sequence to prove that Candidate A can absorb the shared system without erasing real Usernode or child-app behavior?

It does **not** authorize a migration, select a preset, or declare the current visual language correct.

## Decision rule

Use the closest official shadcn primitive or documented composition for a generic interaction. Build an owned Usernode pattern only when the visual audit proves a repeated product contract that needs behavior or responsive transformation beyond that primitive. Keep an app-local pattern local when it represents an app’s own product identity.

```text
generic interaction → official shadcn source component/composition
repeated Social contract → owned pattern composed from official source components
app-specific product → local composition, subject only to host/accessibility contracts
Flutter-native route → native companion; do not fake convergence in web markup
```

## Fit matrix

“Direct” means the official surface is a credible starting implementation. “Composition” means official pieces are useful but the resulting contract remains owned. “No direct fit” is not a gap in shadcn—it is evidence that this is product/application architecture rather than a reusable primitive.

| Pattern IDs | Current user-perceived pattern | Fit | Official shadcn starting point | What still belongs to Usernode |
|---|---|---|---|---|
| P-03, P-05 | Root sheet, temporary panel, overflow action | **Direct + composition** | Drawer, Sheet, DropdownMenu, Popover, AlertDialog | Mobile/desktop adaptive rule, sheet stack policy, safe-area/keyboard ownership, bridge-aware action restrictions. |
| P-04, P-08, P-09 | Grouped settings/work/notification rows | **Composition** | Item, Field, Separator, Avatar, Badge, Collapsible | Named row families: settings, work, notification and dense data rows have different slots and actions; do not make one universal row. |
| P-06, P-07, W-10 | Create/import/feedback/configuration/consequential modal | **Direct + composition** | Dialog or Drawer, AlertDialog, FieldGroup/Field, Input/Select/RadioGroup/ToggleGroup, Textarea, Button | Workflow state, permissions, bridge/API side effects, mode switch, destructive policy and deterministic fixtures. |
| P-10, W-08 | Status/chip/lifecycle state | **Direct + composition** | Badge, Alert, Button variants, Tooltip | Canonical semantic lifecycle vocabulary, non-colour cue rules, counts, state derivation and live-update policy. |
| P-11 | Loading, empty, degraded, retry | **Direct + composition** | Skeleton, Spinner, Empty, Alert, Progress | One named async-state taxonomy: blank hosted-app initialisation, offline, permission-denied, locked, empty, retryable failure and stale state are not interchangeable. |
| P-13, P-14 | Admin and ranking/history data views | **Composition** | Tabs, ToggleGroup, Table, Card, Input, Select, Empty, Pagination | Mobile dense-row/table transformation, read-only capability banner, filtering/query state, data ownership and export danger workflow. |
| P-15 | Challenge/season progression | **Composition** | Card, Badge, Tabs/Select, Progress | Challenge/reward state and domain content model. |
| W-06, W-09 | Work filter strip and inline property chooser | **Direct + composition** | InputGroup, Select/Combobox, ToggleGroup, Popover, Command | Filter persistence, capability gating, choice data, async search and permission/review rules. |
| W-07, W-11 | Thread, composer, agent session | **Composition** | Official MessageScroller, Message, Bubble, Attachment, Marker, plus Field/InputGroup/Button | Session semantics, streaming/reconnect, spend/model state, work-thread context, attachments, moderation and bridge integration. |
| P-01 | Catalogue app tile browser | **Owned pattern** | Card, Avatar, Badge, Button/DropdownMenu are useful pieces | Tile geometry, icon strategy, availability/member summary, reorder/long-press/overflow behavior and app inventory state. |
| P-02 | Icon action header | **Owned pattern** | Button, Tooltip, Badge, DropdownMenu/Drawer | Collision behavior, capability-aware actions, top safe-area, title/back rules and mobile density. |
| W-01, W-02 | Hosted App/Dev frame and Developer workspace shell | **Owned pattern** | Tabs/ToggleGroup, Sidebar, ScrollArea, Resizable as parts | Hash/history contracts, iframe/bridge lifecycle, chromeless mode, one-scroll-owner, App/Dev navigation and responsive modes. |
| W-03, W-04, W-05 | General-chat entry, lifecycle work item, List/Kanban/PM projections | **Owned domain compounds** | Card, Item, Badge, Tabs, ToggleGroup, Empty, ScrollArea | Work-type state model, projection rules, counted mobile kanban columns, drag/reorder alternative, governance actions. |
| W-12, W-13 | Private preview/visual comparison and capability banner | **Owned domain compounds** | Alert, Card, Button, Tabs/ToggleGroup, Skeleton/Empty | iframe security/status, preview/test routing, before/after evidence lifecycle, app capability boundaries. |
| N-01…N-05 | Native settings, benchmark, native profile | **No web replacement fit** | None at this stage | Flutter design system remains the authoritative implementation; align semantic vocabulary and scenarios later, not component source. |
| D (all) | Child-app product UI | **App-local by default** | Optional source primitives where an app chooses them | The app's visual identity and specialised domain patterns. The platform enforces hosting, accessibility and interaction contracts—not a single aesthetic. |

## What this means for scope

### Official shadcn is sufficient to begin

The first slice does **not** need a third-party component library beyond the already chosen Base UI behavioral base. Official shadcn source covers the generic building blocks needed for the first shared families: fields, option sets, buttons, dialogs/drawers, menus/popovers, tabs, badges, cards/items, async feedback, data display and chat primitives. Its CLI, monorepo support, private registry format, skill and MCP server are the right discovery/distribution substrate for agent work.

### Official shadcn is not the design system by itself

It cannot decide any of the product-specific contracts exposed by the audit: App/Dev mode and iframe lifecycle, work-item vocabulary, mobile Kanban projection, native capability boundaries, or which child-app UI must remain diverse. Those are the owned pattern layer and the exact reason to use source-owned components instead of a fixed visual kit.

## Recommended next sequence

### Stage 1 — Pattern decision workshop (no product rewrite)

**Goal:** human-review the audit and freeze a compact initial taxonomy.

1. Take the 33 audited patterns and classify each as **foundation primitive**, **owned shared pattern**, **domain compound**, **native companion**, **app-local**, or **legacy**.
2. Confirm the non-negotiable host contracts: mobile safe areas, one scroll owner, keyboard, App/Dev and hash/history, iframe/bridge capability states, offline/initial-load behavior, and child-app visual autonomy.
3. Select exactly one first vertical slice from the evidence. The recommended candidate is the **mobile root sheet + grouped setting/action rows** because it is shared across navigation, wallet/node, work and notifications; it reveals safe area, overlay, focus, state and native-bridge constraints without prematurely rebuilding the App/Dev shell.
4. Produce a one-page slice spec: user job, screenshots, states, acceptance behaviors, API/data boundary, explicit exclusions, and decision owner.

**Exit evidence:** reviewed taxonomy plus one signed slice spec. No new framework code yet.

### Stage 2 — Official-source reconnaissance (time-boxed, no migration)

**Goal:** validate the exact upstream source components and composition APIs for the chosen slice.

1. Create the minimal Candidate A React/TypeScript workspace with the selected **Base UI** base and official shadcn configuration.
2. Use the official CLI/docs to inspect only the components required by the slice; do not bulk-install the catalogue or add community registries.
3. Create an owned registry namespace but publish only token/config and the selected slice once its contract is accepted.
4. Capture a dependency allowlist: React, Tailwind, Base UI, official shadcn source, selected icon library. Every addition is explicit.

**Exit evidence:** generated source inspected by agents, dependency record, and a source/API delta note against the slice spec.

### Stage 3 — Build the slice in isolation

**Goal:** establish the first governed primitive/pattern loop.

1. Define semantic tokens required by the slice—not a full palette. Include surface/text/focus/status pairs, spacing, radius, target size, motion, safe-area variables and light/dark roles.
2. Build the selected primitive and its owned composition in `packages/ui`; keep bridge/API calls outside presentation code.
3. Create deterministic Storybook scenarios directly from the visual evidence: sheet closed/open; navigation rows; node/wallet unavailable; work/notification rows; light/dark; keyboard; safe-area; reduced motion; capability absent.
4. Write one real integration boundary with mock bridge data; preserve existing source untouched until the comparison is accepted.

**Exit evidence:** inspectable stories, component contract/API, fixture set, real integration proof and screenshot comparison.

### Stage 4 — Establish the minimal agent verification loop

**Goal:** prove agents can discover, compose, check and repair the slice.

Use only the four already approved project-local skills:

| Skill | Purpose in this slice | Required evidence |
|---|---|---|
| `ui-intake` | Turns screenshot/state evidence into the slice spec and checks whether an existing pattern fits. | Pattern decision record and screenshot references. |
| `ui-component` | Searches the official/owned registry, composes the pattern, writes stories and records an explicit gap. | CLI/MCP discovery record, changed source, stories. |
| `ui-integrate-webview` | Connects mock/real bridge data without leaking bridge calls into presentation. | Integration test and capability-state story. |
| `ui-verify` | Runs lint, component/story, interaction, a11y, visual and scoped performance checks; reports category-specific failures. | Command output, screenshots/traces, pass/fail classification. |

Initial mechanical gates:

- Type/lint: no raw colours outside token definition; no direct bridge global outside adapter; no app-local source import into foundation package.
- Story coverage: every slice state has a named deterministic story.
- Interaction/a11y: keyboard and focus tests plus zero serious/critical axe findings in governed stories.
- Visual: mobile reference screenshot comparison under the pinned device/browser; human review for intentional changes.
- Performance: stress story and real flow trace; capture long-animation-frame/interaction evidence rather than guessing from a score.

**Exit evidence:** one agent can make an intentional violation and the system catches it with an actionable failure; a second agent can repair it through the documented loop.

### Stage 5 — Decide the second slice from evidence

Do not construct a broad component catalogue. Use Stage 4’s actual friction and the audit’s recurrence to choose one next surface:

1. **Form/confirmation workflow** if field/validation/async conventions remain unclear.
2. **Lifecycle work item** if the Dev workspace is the most repeated product contract.
3. **Hosted App/Dev shell state** if iframe/safe-area/back/offline behavior blocks all other integration work.

The prerequisite is a recorded reason from stories, agent traces or observed repetition—not taste or catalogue completeness.

## Tool lineup: minimum, complementary, and deferred

| Role | Start with | Why it earns a place | Do not add yet |
|---|---|---|---|
| Owned source/discovery | official shadcn CLI, `components.json`, private registry, official skill/MCP | Agents can inspect project/base/aliases, search approved items and distribute owned source. | Community registries and block marketplaces. |
| Accessible interaction basis | Base UI through official shadcn source | Handles difficult composite widget mechanics while presentation stays owned. | A second headless base; reconsider only if a named required interaction fails. |
| Component workshop | Storybook | Deterministic scenarios isolate presentation from real API/bridge state. | A second catalogue. |
| Browser evidence | Playwright + axe-core | Interaction, focus, accessibility and mobile-viewport evidence. | Broad E2E suite before the first slice is stable. |
| Visual evidence | Start with Storybook/Playwright screenshot baseline; evaluate Chromatic vs Argos only after baseline stability | Allows a data-handling/flake/reviewer decision from actual stories. | Two visual platforms simultaneously. |
| Mechanical enforcement | TypeScript, ESLint plus narrow custom rules, Stylelint only if a concrete CSS rule needs it | Enforces our token/import/architecture policies rather than generic style opinion. | A large lint/plugin stack. |
| Performance | Playwright traces, browser Performance APIs/LoAF, bundle budget | Explains interaction jank in the actual slice. | A generic performance dashboard without named flows. |
| Agent judgement | four project-local skills, with shadcn official skill as upstream component knowledge | Keeps instructions small, executable and portable across agents. | An inherited mega-harness or many generic taste/design skills as authority. |

## Immediate decision required

Approve or change the proposed first slice:

> **Mobile root sheet + grouped setting/action rows**, proven against catalogue navigation, wallet/node, work, and notifications.

If approved, the next action is to write its one-page evidence-backed slice spec. If not, choose **form/confirmation**, **lifecycle work item**, or **hosted App/Dev shell state** and apply the exact same process.
