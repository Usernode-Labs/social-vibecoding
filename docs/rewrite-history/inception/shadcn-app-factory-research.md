# Can shadcn underpin an app-factory design system?

## Short answer

**Yes, as an owned distribution and composition substrate; no, as a finished app factory.**

The public ecosystem contains strong pieces of an app factory, but I did not find a mature open-source project that is genuinely comparable to Material or Apple’s design systems while also using shadcn to safely generate many product apps. That absence is useful evidence: the missing layer is not another collection of buttons. It is the governed product vocabulary, scenario evidence, and agent verification loop we have been defining.

## What “app factory” means here

For Usernode, this does **not** mean a universal no-code builder or a component catalogue large enough to imitate every consumer application. It means a mature system that can produce coherent applications across mobile and desktop from a controlled vocabulary:

```text
tokens + behavioral primitives + app topology + approved product patterns
  + typed capability adapters + deterministic scenarios + gates + agent workflow
```

The system must let agents build a new or migrated surface from approved pieces, recognize when a requested surface exceeds the vocabulary, and escalate a structured gap rather than inventing arbitrary markup and styles. A Usernode product slice is only the proving ground, not the boundary of the system’s ambition.

## The closest public precedents, by role

## Official shadcn-only starting surface

The right reading of “stay close to the initial authors” is **official shadcn source and tooling only**, not literal zero external packages. shadcn is intentionally an open-code distribution system, not a vertically integrated component runtime: its accessible behavioral bases are Base UI, Radix UI, or React Aria, and some documented recipes deliberately add focused dependencies (for example, TanStack Table for data grids). We should make those a tiny, explicit foundation allowlist rather than silently accumulating third-party registries.

### What shadcn itself now supplies

| Native shadcn surface | What we can use immediately | Fit for the application kernel |
|---|---|---|
| **Source-owned primitives** | An official component collection covering actions, fields, selection controls, navigation, overlays, feedback, layout and content: Button, Field/Input/InputGroup/Textarea, Select/Combobox, Checkbox/Radio/Switch, Tabs, Sheet/Dialog/Drawer/Menu, Toast, Empty, Spinner/Skeleton, Sidebar, Table, Badge, Card, Item, Avatar, and more. | Strong raw material; adopt selectively rather than installing the whole catalogue. |
| **Semantic theme convention** | CSS-variable semantic pairs for surfaces and foregrounds, focus rings, borders, destructive state, chart and sidebar roles; OKLCH, dark-mode overrides, radius derivation, plus custom tokens. | A good *seed* for our token contract, but not a complete cross-platform token source. |
| **Application and AI-adjacent components** | Sidebar and dashboard/login blocks; data-table guidance; and newer chat primitives such as Attachment, Bubble, Marker, Message, and Message Scroller. | Useful reference/accelerator. Blocks are examples, not approved Usernode patterns. Chat must wait for evidence. |
| **CLI and monorepo routing** | `init --monorepo`, `add`, `search`, `view`, `docs`, `diff`, `info`, and `build`; it routes shared primitives into `packages/ui` and app-local blocks into an app workspace. | Direct fit for our foundation/product/app layering. |
| **Registry and agent discovery** | A private registry can distribute components, hooks, pages, config, rules and other files; the official skill reads `components.json`, and MCP can browse compatible registries. | Strong substrate for agents to discover approved components, but our registry metadata and rules remain our responsibility. |

### Official-only boundary for Candidate A

**Allowed at foundation time:** shadcn CLI, official shadcn registry/components/blocks as source references, its monorepo structure, an owned Usernode registry, and the explicitly selected Base UI behavioral base. React, Tailwind and the chosen icon library are also dependencies, but should be listed—not smuggled in as part of a “shadcn” label.

**Not allowed by default:** community registries, copy-paste component galleries, third-party template packs, third-party theme generators, and generic agent skills that can add arbitrary visual languages. Any exception needs a record of capability gained, dependency/license/security review, and a removal/ownership plan.

**Still ours to create:** the canonical cross-platform token schema; mobile-safe-area, keyboard and responsive contracts; the product-pattern layer; Storybook scenarios; design-system linting; accessibility/visual/performance gates; typed API/native-bridge adapters; component ownership/deprecation; and focused multi-agent skills. shadcn can make these easier to distribute and discover, but it does not enforce them.

### 1. shadcn itself: the distribution factory

shadcn’s current monorepo support is the most direct technical precedent for Candidate A. It creates an `apps/web` and `packages/ui` shape; the CLI routes primitive source to the shared UI package and app-specific blocks/forms to the consuming app, while using `components.json` aliases to maintain imports. [Official monorepo documentation](https://ui.shadcn.com/docs/monorepo)

The official registry template adds a second distribution mode: `registry.json` defines items, `shadcn build` generates static registry artifacts, and custom components/hooks/pages can be consumed by React projects through the CLI. [Registry template](https://github.com/shadcn-ui/registry-template)

**What transfers:** source ownership, explicit routing between shared primitives and app-local composition, versioned registry items, and an agent-readable CLI surface.

**What is missing:** product patterns, ownership/deprecation governance, quality gates, scenario fixtures, and any decision about which kinds of applications the system is allowed to make.

### 2. Shadcn Space: a block/template catalogue

Shadcn Space is a real open-code system built on shadcn and Base UI. It distributes components, reusable blocks, templates, and dashboard layouts through the shadcn CLI and makes the copied source editable. [Repository](https://github.com/shadcnspace/shadcnspace)

It is a useful **catalogue precedent**: primitives → blocks → layouts/templates is a real layering. It is not an app-factory governance precedent: its mission is broad reusable supply for sites, dashboards, SaaS, and internal tools, rather than a constrained product family with migration-safe WebView/bridge behavior.

**Take:** study its taxonomy and source distribution, but do not import its breadth into v1.

### 3. Next.js SaaS Starter and next-forge: app seeds/workshops

The official Next.js SaaS Starter demonstrates a reusable application archetype: authentication, teams/RBAC, billing, dashboard CRUD, activity logging, and shadcn/ui. [Repository](https://github.com/nextjs/saas-starter) Next-forge separates Storybook as a workshop for the design system, with component stories and the application’s fonts/providers. [Storybook documentation](https://www.next-forge.com/docs/apps/storybook)

These are good precedents for **app seed + component workshop**. They are not the Usernode architecture: their value lies in showing that a reusable app topology is more valuable than a large selection of visual blocks.

**Take:** eventually define a Usernode app seed, but only after the first shell slice identifies its stable topology and capability boundaries.

### 4. AI “app factories”: cautionary, not foundations

Some products explicitly call themselves app factories and use shadcn—for example, App Factory says its dApp builder generates Next.js + shadcn/ui applications. It also advertises single-shot operation with no approval gates. [Architecture description](https://factoryapp.dev/docs/how-it-works)

This demonstrates that shadcn is usable inside generation pipelines. It is the opposite of our desired operating model: single-shot generation and opaque quality scoring do not give us product vocabulary ownership, repairable evidence, WebView safety, or controlled component evolution.

**Take:** do not copy “one prompt → complete app.” Our factory should be constrained, incremental, and evidence-led.

## The architecture we should borrow

The first factory should have four deliberately distinct layers:

| Layer | Initial responsibility | Must not absorb |
|---|---|---|
| **Foundation package** | semantic tokens; Base UI-backed primitives; accessibility/motion contracts | product workflows or bridge calls |
| **Product-pattern package** | cross-app patterns: settings sections, async states, dense rows/cards, navigation, data display, mobile/desktop adaptation | arbitrary one-off feature screens |
| **App/surface package** | route composition, typed view models, integrations/adapters | duplicated primitive styling |
| **Factory harness** | intake → reuse/gap decision → scenario → implementation → verification | design authority or runtime business logic |

shadcn maps cleanly onto this: its monorepo `packages/ui` is a plausible foundation package; its registry can distribute governed items; app-local components are the composition layer. The important addition is that Usernode’s registry metadata must distinguish **foundation**, **product pattern**, **app-local**, and **legacy/compatibility** items. Without this, a registry becomes an unbounded pile of copyable files.

## Maturity target: an application-capable cross-platform system

The standard is closer to a **small, evolving Material/Apple-style system** than to a template marketplace:

- One semantic foundation drives mobile and desktop themes, density, motion, type, safe areas, and accessibility.
- One behavioral foundation gives components keyboard, pointer, touch, focus, overlay, and reduced-motion behavior.
- Patterns express recurring application jobs—navigation, settings, forms, lists, data display, feedback, and async work—rather than a particular brand’s screen markup.
- Responsive adaptation is part of the component/pattern contract: a desktop navigation rail may become a mobile bottom/sheet navigation model, and dense data surfaces may become actionable rows.
- A catalog presents states on phone and desktop viewports; a verification loop proves the same component across interaction modes.
- Product applications compose the system; they do not fork it.

This target must still be approached by evidence. “Capable of producing apps” does not mean “complete every component category before making the first app.”

## Minimal subset: the application-system kernel

Do not begin by recreating Material’s breadth. Build the smallest kernel that can deliver a coherent application surface on both narrow touch and wide pointer/keyboard layouts:

1. **Semantic token contract** — surfaces, text, borders, action/status roles, spacing, radius, type, focus, motion; dark mode and safe-area ownership.
2. **Action/form kernel** — Button/IconButton; Field and input family; Switch/Checkbox/Radio; validation/async-submit state.
3. **Overlay/feedback kernel** — Sheet/menu, dialog/confirmation, toast, banner, loading/error/empty state.
4. **Application-topology kernel** — AppShell; header/back behavior; one scroll-owner rule; desktop rail/sidebar and mobile tab/sheet/navigation adaptation; safe-area and keyboard model.
5. **Four application patterns only** — settings/form section; actionable list row; dense card/work item; async state boundary. These exercise tokens, forms, statuses, overlays, loading/error, touch, pointer/keyboard, and responsive adaptation without pretending to cover every product domain.
6. **Scenario and integration kernel** — deterministic fixtures; Storybook states at phone and desktop viewports; one real route; integrations isolated behind typed adapters rather than presentation components.
7. **Four-skill harness** — intake, component, WebView integration, verification—each with a stop condition and executable evidence.

This is enough to make the second application surface cheaper and more coherent. It is intentionally insufficient for chat, kanban, advanced data grids, governance, arbitrary child apps, or a universal page builder. Those graduate only after an observed repeated need.

## Factory output contract

An agent should not be asked to “build an app.” The initial factory request should produce a bounded artifact:

```text
Input: selected application surface specification and target contexts (mobile, desktop, or both)
Output: app-local screen composed from approved patterns, deterministic cross-viewport scenarios,
typed integration boundary, passing gates, and a gap record if the vocabulary is insufficient
```

The factory succeeds when it says either **“composed from existing vocabulary”** or **“new pattern required; here is the evidence and contract.”** It fails when it quietly creates a new visual language or hides missing behavior in one-off code.

## Recommendation

Candidate A is a credible foundation for an application-capable system precisely because shadcn lets Usernode own and distribute source, while Base UI provides behavior rather than visual identity. The first goal should be **a cross-platform application-system kernel**, not a generic application generator.

The next design-system decision is therefore not “which 100 components ship in v1?” It is: **which representative application surface will prove this kernel on both mobile and desktop?** The existing capability-gated settings form remains a strong first proof because it exercises fields, rows, async state, sheets/confirmation, keyboard, safe areas, and an integration boundary; it must be rendered and tested in both mobile and desktop scenarios.
