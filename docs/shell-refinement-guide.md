# Shell refinement guide

**Status:** Accepted direction; the single worker-facing implementation
authority for the shell refinement

**Date:** 2026-07-29 (consolidated; absorbs the previously separate Create
baseline record, Luma merge impact, semantic token specification, successor
contract specification, and execution plan)

**Scope:** React platform shell only, as governed by
`frontend/design-system/authority.json`

Read first:

- [`shell-component-audit.md`](shell-component-audit.md) — findings,
  supersessions, and structural prerequisite;
- [`platform-navigation-proposal.md`](platform-navigation-proposal.md) —
  accepted information architecture and host appendix;
- [`../frontend/design-system/content-guidelines.md`](../frontend/design-system/content-guidelines.md)
  — copy authority (kept beside `tokens.json` because `check:content` anchors
  to it);
- `frontend/AGENTS.md` — working rules.

Start every implementation task with:

```sh
node tool/ui-workflow.mjs --task "<task>"
```

---

## Part I — Thesis and authority

### Thesis

User attention is the shell's scarcest resource. The shell competes with the
apps it hosts, so decoration in the shell is attention taken from the user's
current app.

Distinctiveness therefore comes from a few details applied consistently, not
from decorating every component. The shell is quiet by default. Before adding
a treatment, accent, animation, or explanatory sentence, ask whether it serves
one of the three signatures below. If it does not, use the upstream default. If
that default is wrong everywhere, fix the preset or semantic layer rather than
patching one instance.

### The three signatures

1. **App identity** — `AppIdentity` artwork and monograms. Apps are the content,
   so their identity is the shell's primary expressive color.
2. **Status language** — one `StatusDot` rendering primitive backed by shared
   semantic roles, while each domain retains truthful state vocabulary.
3. **Attention indicator** — one platform-menu dot. It is static initially.
   A single appearance pulse is an approved future motion candidate, not a
   current dependency or acceptance requirement.

Buttons, cards, lists, headers, forms, and empty states remain quiet,
official-shadcn, and token-driven.

### Authority split

| Authority | Owns | Does not own |
| --- | --- | --- |
| Frozen Create preset | Upstream style, primitive base, geometry, density, fonts, icons, radius, menu treatment, and baseline theme | Usernode product meaning or platform behavior |
| Usernode DTCG tokens and authority | App-identity palette, status roles, attention role, theme-storage compatibility, and shell-specific semantic gaps proven after Luma | Recreating Luma per component |
| Owned shell patterns | Platform-specific composition, routing, focus/inert behavior, iframe mount continuity, and contextual chrome | New primitive styling without a semantic reason |
| Content guidelines | Vocabulary, information hierarchy, visible labels, accessible names, state copy, and named failure modes | Visual geometry or runtime behavior |

When a global visual choice feels wrong, return to Create. When product meaning
is missing, add a Usernode semantic role. When one instance looks different
without a semantic reason, remove the override.

### System laws

Every future law must state **what** it constrains, **why** an observed failure
requires it, and **where** it is enforced.

#### 1. Color flows through owned slots

Chromatic product meaning uses semantic roles (`identity-*`, `status-*`,
`attention`). Baseline structure uses the frozen preset. No component writes a
raw hue.

**Why:** raw values made brand and theme changes a file-by-file hunt.

**Where:** DTCG tokens, style policy, Storybook contrast evidence.

#### 2. Spacing has one owner

The screen owns margins and inter-surface gaps; a surface owns its inset; a
leaf owns content padding. Parents use `gap-*`; components carry no external
margin.

**Why:** ad-hoc margin stacks make composition order change spacing.

**Where:** official Luma composition, successor stories, review checklist.

#### 3. Every surface is classified

A surface is scaffold, content, inherited, inverse/transient, or separation.
If unclear, inherit. Adopt Luma elevation and shadows first; add a shell
surface or shadow token only when a named pattern proves a semantic gap.

**Why:** the current dark shell separates nearly everything with borders.

**Where:** stories in both themes and component review.

#### 4. Fix the system, not the instance

Do not add per-instance color, font, radius, shadow, or density overrides. Fix
the Create preset when the upstream baseline is wrong globally; fix a semantic
role or owned pattern when a product distinction is missing.

**Why:** local overrides created competing title scales and surface styles.

**Where:** style policy, exception ledger, review checklist.

#### 5. The shell canvas uses available width

Do not impose one arbitrary centered frame on every route. Each content pattern
owns its internal measure, columns, and responsive grid. Prose constrains its
own readable line length. Conversation, board, console, and table surfaces use
the available canvas.

**Why:** six page-level widths make adjacent routes jump and starve wide work
surfaces.

**Where:** route layouts as touched and successor-pattern stories.

#### 6. Taste waits for evidence

Defer choices that the current product does not require:

- experimental display fonts;
- a redesigned five-color chart ramp;
- custom elevation or shadows beyond Luma;
- achromatic-versus-branded structural roles;
- mono display heroes.

Revisit them through Create or a recorded semantic decision when real content
requires them.

---

## Part II — Upstream baseline: shadcn Create

[shadcn Create](https://ui.shadcn.com/create) is the key design-system control
for the consumer shell. It chooses a coherent upstream system rather than
serving as a theme swatch generator.

### Frozen decision record

**Status: frozen by user; implementation may proceed through merge mode.**

| Field | Current production | Frozen target |
| --- | --- | --- |
| Preset code | `b2fA` | `b1VlIwYS` |
| Primitive base | Base UI | Base UI |
| Style | Nova | Luma |
| Base color / theme / charts | Neutral | Neutral |
| Font / heading | Geist / inherit | Geist / inherit |
| Icons | Lucide | Lucide |
| Radius | Default | Default |
| Menu accent / color | Subtle / default | Subtle / default |

`b1VlIwYS` is the exact official Base UI + Luma + Geist preset generated in
shadcn Create and accepted by the user: rounded, breathable, consumer-facing,
and close to official shadcn defaults. G0 is satisfied. Geist stays the shell
font; Luma changes upstream component style and geometry without creating an
unrelated typography migration. The frozen URL is
[`https://ui.shadcn.com/create?preset=b1VlIwYS`](https://ui.shadcn.com/create?preset=b1VlIwYS).
Base UI is retained by the existing project configuration; preset codes do not
encode the primitive base.

Do not manually decode the code or construct its URL. Reproduce the record from
`frontend/` (official CLI `4.16.0` reproduced both records):

```sh
npx shadcn@latest preset resolve
npx shadcn@latest preset decode b1VlIwYS
npx shadcn@latest preset url b1VlIwYS
npx shadcn@latest --version
```

Record the CLI version and generated URL in the implementation PR evidence.
The frozen preset record must always contain: the opaque code and generated
URL; decoded style, theme, base color, font, heading font, icon, radius, and
menu choices; Base UI as the retained primitive base; CLI version, adoption
date, rationale, and deliberately deferred knobs.

### Probe evidence

A fresh official Base UI + Luma scratch project generated the same 29 official
primitives currently installed:

- 2 are byte-identical;
- 27 differ, including production's concurrent avatar contrast fix;
- the Luma side contains 449 insertions and removes 183 production lines;
- much of the large `select`, `alert-dialog`, and `tabs` delta is formatting,
  but their geometry and surface classes also change.

Compared with the prior Inter probe, 25 component files are byte-identical.
`field`, `input-group`, `message-scroller`, and `sheet` differ only by the
presence or absence of `"use client"` after generation in a different add
context. No component class, geometry, or disposition changed because of the
font choice. This guide uses the fresh frozen-preset output as the count
baseline.

This is a structural component-style migration, not a palette swap. The result
validates a scratch comparison and component-by-component merge. A blanket
`apply` or overwrite is prohibited.

### Adoption rule

Adopt Luma in **merge mode**. Never run a blind overwrite.

1. Resolve the current preset and inventory installed official components.
2. Generate the frozen Base UI + Luma preset in an isolated scratch project.
3. Generate the same official components there and produce an impact report.
4. In the real project, update configuration without reinstalling components.
5. For each installed component, inspect `--dry-run` and `--diff`.
6. Merge upstream Luma changes while preserving documented local accessibility
   and platform fixes.
7. Keep feature composition out of the primitive migration.

Only one integration owner edits shared shadcn primitives, global CSS, and
baseline tokens during adoption. Reconnaissance and feature work may proceed
in parallel only in disjoint files.

### Component dispositions

Disposition meanings:

- **Identical** — no production source change.
- **Take upstream** — the delta is limited to Luma presentation or a harmless
  client-boundary addition; still land through reviewed diff, not overwrite.
- **Merge carefully** — Luma presentation is wanted, but a high-fan-out API,
  interaction, focus, disabled, overlay, or structural contract requires
  targeted regression evidence.
- **Preserve local behavior** — adopt compatible Luma presentation while
  deliberately retaining a production behavior that upstream removes.

The delta column is Luma additions / production removals.

| Primitive | Delta | Disposition | Merge note |
| --- | ---: | --- | --- |
| `accordion` | +8 / −5 | Merge carefully | Luma adds the bordered rounded container and larger inset, but drops the trigger's explicit focus-visible border/ring classes. Retain a clearly visible keyboard focus treatment and verify open/closed animation. |
| `alert-dialog` | +137 / −20 | Merge carefully | Mostly formatting plus larger radius, inset, media, shadow, and darker overlay. Preserve Base UI portal, title/description semantics, action/cancel API, focus trap, Escape, and focus return. |
| `alert` | +2 / −2 | Take upstream | Radius, inset, gap, and action position only. Check destructive and default contrast. |
| `attachment` | +3 / −3 | Take upstream | Radius and focus-ring alpha only; attachment state, orientation, and media behavior are unchanged. |
| `avatar` | +2 / −2 | Preserve local behavior | Production now uses `text-foreground` for fallback and group-count contrast. Frozen Luma still uses `text-muted-foreground`; retain the accepted contrast fix and its evidence. |
| `badge` | +1 / −1 | Take upstream | Radius only. Product status still moves to `StatusDot`; do not create new status-badge semantics. |
| `bubble` | +1 / −1 | Take upstream | Radius, padding, and focus-ring alpha only. Preserve chat alignment and link/button focus behavior. |
| `button-group` | +4 / −4 | Take upstream | Luma adds pill geometry and outline-child border/focus coordination. Verify mixed input/select/button groups. |
| `button` | +11 / −13 | Merge carefully | Central, high-fan-out change: all heights/padding/radii, outline dark surface, destructive treatment, and focus-ring alpha change. Keep variant/size names and Base UI `render` behavior; app-chrome 48px targets remain an owned-pattern contract. |
| `card` | +4 / −7 | Merge carefully | Luma adds larger radius, spacing, and shadow and changes footer treatment. Audit consumers that rely on flush muted footers, `size="sm"`, image clipping, or skeleton geometry. Do not polish the superseded `AppCard`. |
| `empty` | +4 / −4 | Take upstream | Larger inset, media, title, and content gaps match Luma. Content discipline still limits the owned state to one glyph, one line, and at most one action. |
| `field` | +6 / −6 | Take upstream | Spacing and selected-field surface change. Preserve `fieldset`/`legend`, `data-invalid`, disabled, checkbox, and radio contracts. |
| `input-group` | +13 / −14 | Merge carefully | Surface, height, radius, KBD styling, block-addon inset, and official client boundary change. Luma removes several explicit disabled background rules; prove disabled, invalid, textarea, button-addon, and combobox-nesting states before accepting. |
| `input` | +1 / −1 | Take upstream | Luma changes height, pill geometry, transparent border, filled surface, focus alpha, and disabled surface. Semantics and API are unchanged; verify autofill, file input, invalid, and disabled contrast. |
| `label` | +2 / −0 | Take upstream | Only the official client directive is added. |
| `marker` | 0 / 0 | Identical | No action. |
| `message-scroller` | +1 / −1 | Take upstream | Increases message gap. Preserve the production client boundary, scroll anchoring, streaming follow, and jump-to-latest behavior. |
| `message` | +2 / −2 | Take upstream | Header/footer horizontal inset only. |
| `select` | +148 / −49 | Merge carefully | Large generated diff plus trigger/menu geometry and density. Preserve Base UI portal/positioner, trigger sizing API, item indicator, scroll arrows, disabled/invalid behavior, keyboard typeahead, and focus return. Inspect a fresh CLI `--diff`; do not copy the scratch file wholesale. |
| `separator` | 0 / 0 | Identical | No action. |
| `sheet` | +5 / −5 | Merge carefully | Darker overlay, larger header/footer inset, secondary close surface, and shadow change. Retain the client directive, title contract, focus trap/return, Escape, side geometry, and accessible close label. |
| `sidebar` | +20 / −19 | Merge carefully | Luma changes menu density/radii and removes production's client directive. Retain the directive, `SidebarInset` as the shell's sole `main`, cookie/state behavior, keyboard shortcut, mobile Sheet semantics, and wide/mobile collapse behavior. This file cannot merge before the structural-integrity owner finishes. |
| `skeleton` | +1 / −1 | Take upstream | Radius only. Successor skeletons must still derive from their real components. |
| `switch` | +2 / −4 | Merge carefully | Geometry changes from a compact round thumb to Luma's wider track/thumb and removes production's client directive. Retain the directive and expanded pointer target; prove checked/unchecked, disabled, focus, invalid, and both themes. |
| `tabs` | +60 / −10 | Merge carefully | Formatting plus pill geometry, density, vertical shape, and trigger state changes. Preserve Base UI activation, keyboard navigation, line variant, vertical orientation, disabled state, and visible focus. |
| `textarea` | +1 / −1 | Preserve local behavior | Adopt Luma surface, radius, inset, and focus treatment, but do not silently add `resize-none`. Production allows user resize; remove it only with an explicit product/accessibility decision. |
| `toggle-group` | +2 / −2 | Take upstream | Luma changes joined outline geometry, padding, shadow, and selected surface. Preserve orientation, spacing, group context, keyboard behavior, and mutually exclusive semantics where the consumer requires them. |
| `toggle` | +4 / −4 | Take upstream | Radius, sizes, transition, and focus alpha change. Preserve visible pressed state through the Base UI `aria-pressed` contract. |
| `tooltip` | +4 / −2 | Take upstream | Adds the official client directive and adjusts radius/arrow position. Preserve provider delay, portal, side placement, hover/focus opening, Escape, and non-duplication with native `title`. |

Summary by disposition:

- **Identical:** `marker`, `separator`.
- **Take upstream:** `alert`, `attachment`, `badge`, `bubble`, `button-group`,
  `empty`, `field`, `input`, `label`, `message-scroller`, `message`, `skeleton`,
  `toggle-group`, `toggle`, `tooltip`.
- **Merge carefully:** `accordion`, `alert-dialog`, `button`, `card`,
  `input-group`, `select`, `sheet`, `sidebar`, `switch`, `tabs`.
- **Preserve local behavior:** `avatar`, `textarea`.

### Exact production source impact

**Direct primitive files.** An accepted migration would edit the 27
non-identical files under `frontend/@/components/ui/`. The two identical files
should remain untouched. No owned feature component belongs in the
primitive-migration commit.

**Configuration and global CSS:**

| Production file | Expected disposition |
| --- | --- |
| `frontend/components.json` | Change the style only after the preset freeze; retain Base UI, aliases, RTL choice, and the `@usernode-shell` registry. Never replace the file with the scratch config. |
| `frontend/src/index.css` | Merge manually. Preserve the Geist font import, generated-token import, `--font-sans-authority`, custom dark variant, token-to-Tailwind mappings, and explicit light/dark `color-scheme`. |
| `frontend/design-system/tokens.json` | Remains canonical. Neutral colors, Geist, and `0.625rem` radius already match the frozen Luma preset; do not paste the probe's `:root`/`.dark` block into global CSS. |
| `frontend/src/generated/design-tokens.css` | No preset-driven value change is needed. Regenerate only after a separately accepted token change; never hand-edit. |
| `frontend/scripts/design-token-tools.mjs` and `build-design-tokens.mjs` | Preserve the generator contract. No Luma-specific change is currently justified. |
| `frontend/package.json` and `frontend/package-lock.json` | No font dependency change is needed. Preserve `@fontsource-variable/geist`; do not import the scratch project's unrelated React, Vite, TypeScript, Tailwind, Lucide, or formatter versions. |
| `frontend/design-system/exceptions.json` | Re-inventory official-source exact matches after the merge. Remove resolved Nova exceptions, update still-required upstream exceptions with reviewed exact matches, and do not weaken the policy. |

The generated `frontend/design-system/catalog.json`, root catalog, manifest, and
registry do not embed these official primitive sources. They change only if an
authority contract changes; do not regenerate them merely because component
classes changed. `storybook-static` and `public/r` are generated outputs and
must not be hand-edited during the merge.

### Contracts to preserve during the merge

Accessibility:

- Keep visible keyboard focus on every trigger and control. The accordion
  upstream delta specifically removes explicit focus classes and needs a
  deliberate merge.
- Preserve Dialog/Sheet title requirements, modal focus trapping, Escape,
  focus return, and accessible close controls.
- Preserve Select and Tabs keyboard navigation, disabled semantics, typeahead,
  activation behavior, and focus return.
- Verify Luma's lower focus-ring alpha and transparent input borders in both
  themes, including destructive and invalid states.
- Preserve Switch's enlarged pointer target and the shell's 48px app-chrome
  targets; primitive size alone does not satisfy the latter.
- Keep textareas resizable until an explicit decision proves removing resize is
  appropriate.

Platform and local behavior:

- `SidebarInset` remains the single shell-owned `main`; route modules do not
  regain their own `main`.
- Sidebar mobile presentation must preserve focus ownership and, later, the
  hosted-app inert/mount-continuity contract.
- Keep existing `"use client"` boundaries in `sheet`, `sidebar`, and `switch`
  while merging classes. New official directives may be accepted where the
  Luma source adds them.
- The DTCG token generator remains the sole color/radius/font authority. Do not
  allow shadcn application to duplicate its generated values into
  `src/index.css`.
- Preserve Light/Dark/System storage compatibility and `color-scheme`; Luma
  adoption is not the theme-adapter migration.
- Do not change child apps, safe-area/viewport behavior, native bridge,
  shortcuts/widgets, routing, service worker, or Motion in this wave.

### Shared-file collision risks

| Concurrent lane | Collision | Coordination rule |
| --- | --- | --- |
| Structural integrity | `sidebar.tsx`, shell composition, route tests | Structural owner lands first. Luma owner then merges only Sidebar presentation around the retained `main` and landmark contract. |
| Content governance | `authority.json`, schemas, catalog generation, exception ledgers | Luma work avoids content authority. Exception-ledger reconciliation occurs once after content changes settle. |
| Semantic foundation | `tokens.json`, generated CSS, `index.css`, theme files, package/lock | Begins only after Luma. It extends the accepted baseline rather than resolving simultaneous token edits. |
| Successor contracts | Button/Card/Sidebar consumers, stories, authority/registry | Begin after the primitive milestone so screenshot geometry and interaction tests target final Luma primitives. |
| Home/Explore and navigation | Route composition and fixture screenshots | May perform read-only design work, but source integration waits for successor contracts and Luma. |

One Luma integration owner must exclusively control all 27 primitive files,
`components.json`, `src/index.css`, token/font changes, package metadata, lock
file, and exception reconciliation for the duration of the merge.

### Go/no-go checklist for the merge

Before production mutation:

1. the exact frozen preset remains `b1VlIwYS`;
2. Geist remains the accepted shell font;
3. structural integrity is green and `sidebar.tsx` ownership is released;
4. each of the 27 differing primitives has an assigned disposition and test;
5. the Luma owner captures fresh CLI `--dry-run` and per-file `--diff` output;
6. DTCG/global-CSS preservation is part of the merge review;
7. no blanket `apply`, `--overwrite`, or scratch-file copy is used.

After mutation, require typecheck, token/style/content gates, Storybook,
both-theme axe, targeted primitive interactions, shell route tests,
deterministic mobile/desktop screenshots, and a clean bundle check before the
Luma milestone can merge.

---

## Part III — Semantic token specification

Status: proposal only. This part specifies a minimal extension to the shell's
DTCG authority; it does not authorize a token, component, theme, or route
implementation until its wave opens.

### Why this is the next addition

The shell already has one correct authority source:
`frontend/design-system/tokens.json`. It emits light `:root` and dark `.dark`
variables with identical names, then `frontend/src/index.css` maps those
variables into shadcn/Tailwind utilities.

Three small gaps are now visible:

1. `AppIdentity` hashes the mutable display name and emits inline HSL. Rename
   changes a dApp's visual identity and the color is neither a DTCG token nor
   reviewed in both modes.
2. Status meaning is carried inconsistently by generic `secondary`, `outline`,
   and `destructive` variants. The only direct colored status utility is an
   emerald wallet-link check. An "attention" state has no named role.
3. The theme adapter resolves light/dark correctly, but its persisted contract
   is only `light | dark`; system following is an implicit absence of a stored
   preference rather than a selectable, testable preference.

In scope: finite dApp identity artwork for the React shell only; semantic
status and attention roles in both modes; a compatible Light / Dark / System
preference model; mechanical contrast and deterministic-mapping evidence.
Out of scope: child-app source and themes, the hosted `usernode-native/v1`
contract, changing server app records, broad visual restyling, and legacy
route retirement.

### Exact proposed DTCG additions

Add these color tokens under both `semantic.light` and `semantic.dark` in
`frontend/design-system/tokens.json`. They are all `$type: "color"` and use
OKLCH values. The token build must continue to reject a mode-name mismatch.

#### 1. Finite app identity palette

There are eight slots, deliberately numbered rather than named after a domain
or feature. A slot is identity artwork, not an interactive-platform color.

```
semantic.{light|dark}.identity-1-surface
semantic.{light|dark}.identity-1-foreground
semantic.{light|dark}.identity-1-border
...
semantic.{light|dark}.identity-8-surface
semantic.{light|dark}.identity-8-foreground
semantic.{light|dark}.identity-8-border
```

The foreground is the initial/fallback glyph. The border is the one-pixel
shape edge, not a second decoration. A remote `icon_url` remains image content
and does not receive a palette treatment.

Runtime aliases, set only by `AppIdentity`, are:

```
--app-identity-surface: var(--identity-{slot}-surface)
--app-identity-foreground: var(--identity-{slot}-foreground)
--app-identity-border: var(--identity-{slot}-border)
```

`frontend/src/index.css` would expose the corresponding Tailwind aliases only
when a concrete consumer needs them (`--color-app-identity-*`). No generic
`text-identity-*` or `bg-identity-*` public utility should be introduced. The
finite palette remains owned by `AppIdentity` until a second, different shell
pattern proves a reusable need.

#### 2. Status roles

Add four roles, each with a surface, foreground, and border. "Positive" is
success, not a generic brand green; "negative" is the status counterpart to
the existing destructive action color, not a replacement for it.

```
semantic.{light|dark}.status-positive-{surface|foreground|border}
semantic.{light|dark}.status-info-{surface|foreground|border}
semantic.{light|dark}.status-warning-{surface|foreground|border}
semantic.{light|dark}.status-negative-{surface|foreground|border}
```

Runtime/Tailwind aliases use the same names (`--status-positive-surface`,
`--color-status-positive-surface`, and so on). Do not alias `destructive` to
`status-negative-*`: destructive is an action treatment; status-negative is a
readable state treatment. The status-consuming pattern owns the choice of
role; status strings from APIs must not select raw colors.

#### 3. Attention

Attention is intentionally separate from warning. It represents something the
user should notice (unread, needs review, new work) without implying a fault.

```
semantic.{light|dark}.attention-{surface|foreground|border}
```

Aliases are `--attention-{surface|foreground|border}` and their `--color-*`
Tailwind counterparts. The first consumers should be notification unread state
and a review-needed marker, not arbitrary highlighted cards. The platform-menu
dot consumes the attention role; it never displays a count — the drawer
Activity row owns the count.

### Deterministic immutable dApp identity mapping

`AppRecord` already provides both `id` and `slug`. The mapping contract is:

1. Canonical identity key is `app.id` exactly. It must be non-empty.
2. A legacy/test-only record missing `id` may use `app.slug`; a missing ID is
   an adapter-data defect to report, not a reason to hash the display name.
3. Compute FNV-1a 32-bit over UTF-8 bytes of `"usernode:app-identity:v1:" +
   canonicalKey`.
4. Slot is `(hash >>> 0) % 8 + 1` and is returned as a number from 1–8.
5. The mapping is pure, has no random seed, does not inspect theme, and never
   writes storage. The same immutable ID therefore selects the same slot on
   every shell, after reload, and after an app rename.
6. A future palette expansion does not change v1. It requires a new mapping
   version and explicit migration evidence; do not change modulo 8 in place.

The component applies `data-identity-slot="1"` through `"8"`, rather than
assembling raw HSL or arbitrary inline styles. CSS maps each data value to the
three runtime aliases above. `AppIdentity` remains decorative (`alt=""` for
an image and `aria-hidden` for fallback initials); its label belongs to the
nearby dApp name.

### Theme compatibility contract

The persistent preference becomes:

```
type ThemePreference = "light" | "dark" | "system"
type EffectiveThemeMode = "light" | "dark"
```

- Existing local-storage values `light` and `dark` continue unchanged.
- Missing storage is interpreted as the new `system` preference, preserving
  current behavior exactly.
- `system` stores the literal `system`, listens to `prefers-color-scheme`, and
  applies only the resolved effective class/data attribute (`light` or `dark`).
- `data-theme`, `color-scheme`, the `theme-color` meta tag, event detail, and
  subscribers continue to receive the effective mode. Add preference metadata
  only in a backwards-compatible field, never by changing the current event
  payload shape.
- The switcher exposes Light, Dark, and System as a single accessible choice
  group. "System" names the preference and shows the resolved mode in its
  description, not as a second selected state.

The CSS contract stays `.dark` for dark variables and `:root` for light. This
avoids changing shadcn's current dark selector or the native WebView's first
paint behavior.

### Contrast and state evidence matrix

Implementation is accepted only when automated color-pair tests and visual
evidence cover every cell below. Color tests must calculate contrast from the
resolved generated CSS/OKLCH colors, not only inspect token names.

| Contract | Light | Dark | Required assertion |
|---|---:|---:|---|
| Every identity slot foreground on its surface | 8 slots | 8 slots | WCAG AA normal text, ≥4.5:1 |
| Every identity slot border against surrounding `card` | 8 slots | 8 slots | visible non-text boundary, ≥3:1 |
| Positive/info/warning/negative foreground on surface | 4 roles | 4 roles | AA normal text, ≥4.5:1 |
| Every status border against `card` | 4 roles | 4 roles | non-text contrast, ≥3:1 |
| Attention foreground and border | 1 role | 1 role | ≥4.5:1 text, ≥3:1 boundary |
| Focus ring over identity/status surface | 13 surfaces | 13 surfaces | visible focus indicator, ≥3:1 |
| System preference | resolved light | resolved dark | same token snapshot as explicit mode |

Stories or route fixtures additionally cover: icon image present/fallback,
slot 1 and slot 8, dApp rename without color change, all four status roles,
attention unread/read, Light/Dark/System, and forced-colors/high-contrast
fallback. Status always includes text or an icon/accessible label; color never
is the only state signal.

### Migration inventory and order

1. **Token infrastructure.** Extend DTCG source, generator support if aliases
   are needed, generated CSS, and token tests. Do not change UI at this step.
2. **Theme adapter and switcher.** `@/lib/theme.ts` currently stores only
   light/dark and treats an absent key as system. `ThemeSwitcherView` currently
   has two controls. Add preference tests before exposing System.
3. **App identity.** `@/features/apps/app-identity.tsx` currently hashes
   `app.name` and emits inline HSL; it is used by `app-card.tsx` and
   `app-details.tsx`. Move only this fallback artwork to the finite mapping.
4. **Status primitives.** Inventory current `Badge`/`Alert` uses in app
   lifecycle, challenges, Dev board/session, GitHub issue, node status,
   wallet linking, and administration. Introduce an owned status mapping
   pattern before changing feature-specific status strings.
5. **Attention.** Start with the React Notifications destination and a
   review-needed state. Do not retrospectively recolor all secondary badges.
6. **Cleanup.** Replace the direct `text-emerald-500` wallet-link check only
   once the positive status role exists. Retire the `AppIdentity` inline-style
   exception only after deterministic mapping and both mode stories are green.

Each slice needs its normal Storybook / fixture browser / accessibility
evidence plus `check:tokens`, `check:design-system`, `check:style-policy`, and
the new contrast tests. No server, bridge, hash, iframe, or child-app change
is implied.

### Explicit deferrals

- **Charts:** existing `chart-1`…`chart-5` remain grayscale compatibility
  tokens. A data-visualization scale needs a separate semantics and legend
  review.
- **Display font:** Geist remains the sole shell typeface. No display-font
  token or typography hierarchy is part of this color/identity wave.
- **Motion:** no durations, easing, status animations, or attention pulses are
  added. Reduced-motion behavior stays governed by existing primitives until a
  separate motion contract has evidence.

### Brand arrival path

Law 6 defers whether the eventual brand colors structural roles (`primary`,
`ring`, buttons) or stays confined to the identity/status/attention slots
above. That choice is deliberately not made here. What is fixed now is the
*mechanism* so the eventual decision costs one change, not a token hunt:

1. `tokens.json` gains a `primitive` layer (`primitive.brand.{100..900}`) the
   day a brand palette is accepted. Until then no such layer exists — this is
   not an invitation to pre-populate it with a placeholder hue.
2. Every semantic slot this wave defines (`identity-*`, `status-*`,
   `attention`) becomes a DTCG alias onto that primitive layer at brand-arrival
   time, not a literal value copied file-by-file.
3. Structural roles (`primary`, `ring`, `sidebar-primary`, `chart-*`) either
   stay aliased to the neutral Luma baseline or move onto the same primitive
   layer — that is exactly the law 6 decision, made once, in one file.

Acceptance for the brand-arrival change itself: swapping the primitive ramp
re-colors every consuming slot with zero component edits, and both-theme
contrast evidence (Part III's matrix) is re-run against the new values.

---

## Part IV — Successor contracts

Status: accepted-direction specification. This names the next reusable shell
patterns and their contracts without changing any React route, component, API,
or native bridge behavior.

### Product decisions encoded here

- The platform remains discoverable from every route, but a selected hosted
  dApp gets the majority of the viewport. Platform navigation is a compact
  header trigger and responsive sidebar, not a persistent mobile tab strip.
- Desktop expands the same navigation into a sidebar; it must not invent a
  separate information architecture.
- "Your apps" is a fast personal shortcut rail. "Explore" is discovery. They
  have different density and actions, rather than one `AppCard` forced into
  two jobs.
- dApp artwork is separate from platform icons. A finite, deterministic
  identity palette is specified in Part III.
- App status and attention remain legible without color; they are compact
  state summaries, not generic decorative badges.
- The existing iframe, session-cookie, iframe-token, sandbox, direct-link,
  bridge, WebView, and offline contracts are preserved exactly until a
  dedicated host-contract test approves a change.

### Contract index

| Successor | Replaces / consolidates | Initial owner |
|---|---|---|
| `PageHeader` | `PlatformShell`'s inline `<header>`, `IconLink`, title/actions wiring | shell worker |
| `PlatformNavigation` | `PlatformSidebar`, `mainLinks`, desktop/mobile navigation splitting | shell worker |
| `HomeAppShortcut` | personal-use branch of `AppCard`, favorite ordering controls in `AppsHome` | apps-home worker |
| `ExploreAppCard` | discovery branch of `AppCard`, generic catalog grid | apps-home worker |
| `AppIdentity` | name-hashed inline HSL fallback in `app-identity.tsx` | identity/token worker |
| `StatusDot` | ad hoc `Badge` status visual mapping and direct semantic color use | status worker |
| `FocusedAppFrame` + `AppChrome` | `HostedApp`, iframe-state presentation and selected-app shell affordances | host-frame worker |

No successor deletes its predecessor in the same change. Existing routes keep
working while each consumer moves after the new contract has its own evidence.

### `PageHeader`

Public props:

```ts
type PageHeaderProps = {
  title: string
  description?: string
  action?: ReactNode
  compact?: boolean
}
```

`PageHeader` is the route's sole `h1`. It owns route context, an optional
Read-layer description, and at most one contextual route action. It does not
own the platform-navigation trigger, global destinations, attention badges,
Back, Close, or app chrome. Genuine nested Back belongs to `AppChrome`;
platform navigation belongs to shell composition.

`HeaderLayout` is the lower-level shared layout for page and section headings.
The caller supplies the semantic heading level; the layout owns only responsive
placement and internal spacing.

States and evidence:

- `WithDescription`, `WithAction`, `Compact`, `LongTitle`, `Narrow`, and
  `NoDescription` stories.
- Every story renders light/dark and desktop/mobile evidence. Interaction
  assertions prove one `h1`, description linkage, action behavior, and no
  narrow horizontal clipping.
- Route orchestration resolves authorization and action behavior before
  supplying the optional action.

Accessibility and performance:

- The header is labelled by its `h1` and described by the optional paragraph.
- The action is caller-owned and must retain its visible label or accessible
  name.
- Native title sync remains in the host adapter; `PageHeader` never calls the
  bridge.
- The pattern is static, props-only, and never remounts navigation or a hosted
  iframe.
- No custom PageHeader motion is planned.

### `PlatformNavigation`

Public props:

```ts
type PlatformNavItem = {
  id: string
  label: string
  href: string
  icon: LucideIcon
  match: (pathname: string) => boolean
  group?: "primary" | "node" | "utility"
  visible?: boolean
  trailing?: ReactNode
}

type PlatformNavigationProps = {
  items: readonly PlatformNavItem[]
  pathname: string
  brand: { label: "dApps"; href: string }
  onNavigate?: () => void
}
```

The same item source drives desktop sidebar, off-canvas narrow sidebar, and
the shell-owned header trigger. The accepted primary items are Home, Explore,
Work, Challenges, and Activity. Node is a separately divided technical row.
Account, Settings, Send feedback, and authorization-gated Admin are utility
rows in the footer. Theme selection lives inside Settings and is not a
navigation control.

`trailing` carries adapter-fed evidence such as the Activity attention count
or Node `StatusDot`; it does not authorize the navigation component to fetch
either value. The dApps brand link is not a second active navigation row:
Home alone owns `aria-current` on the root route.

States and evidence:

- `DesktopExpanded`, `NarrowClosed`, `NarrowOpen`, `ActiveChallenges`,
  `AccountFooter`, `AdminAbsent`, `AttentionCount`, `NodeStatus`, and
  `DesktopExpandedDark` stories.
- Browser fixture: active route semantics, Escape closes off-canvas navigation,
  focus returns to header trigger, and navigation closes before route content
  receives focus on narrow screens.

Boundaries:

- This is presentation and route matching only. It does not fetch admin state,
  profile data, Activity attention, or Node status.
- It supersedes `PlatformSidebar` and `mainLinks` in
  `@/components/platform-shell.tsx`; `PlatformShell` remains composition and
  provider ownership until all consumers are migrated.

### `HomeAppShortcut`

This is deliberately not a small `ExploreAppCard`. It is a personal launch
surface for saved or collaborated dApps, optimized for a known destination.

Public props:

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

States and evidence:

- `Running`, `Unavailable`, `Collaborator`, `ReorderFirst`, `ReorderMiddle`,
  `ReorderLast`, `ReorderPending` stories.
- Browser fixture: ordered list semantics; left/right reorder controls have
  app-specific accessible labels, retain focus after the optimistic update,
  and roll back only through the route/adaptor's existing server error path.
- No drag-and-drop is introduced. Current reorder semantics are explicit
  earlier/later actions and remain keyboard/screen-reader operable.

Boundaries: `AppsHome` retains `listApps`, search, favorite filtering, server
write, and rollback behavior. The shortcut is props-only and must not call an
endpoint or decide a personal/favorite grouping.

### `ExploreAppCard`

This is the browse/discovery card for every dApp, including a dApp the user
has not saved. It has one action: view details. Management, favorite, sharing,
and contribution actions belong one level below in app details.

Public props:

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

States and evidence:

- `Running`, `Building`, `AwaitingSecrets`, `Unavailable`, `WithCommunity`,
  `NoDescription` stories.
- Browser fixture: title and details action are independently intelligible;
  no hidden per-card overflow action; app image fallback has no duplicate
  accessible name.

Boundaries: it succeeds the discovery use of `AppCard` in
`@/features/apps/app-card.tsx` and the `All apps` branch in `AppsHome`.
AppDetails remains the owner of favorite, collaborator, rename, share, and
Improve actions.

### `AppIdentity`

Public props:

```ts
type AppIdentityProps = {
  app: Pick<AppRecord, "id" | "slug" | "name" | "icon_url">
  size?: "sm" | "md" | "lg"
  decorative?: boolean // default true
}
```

For a supplied image it renders an empty-alt decorative image. For the
fallback it derives a slot solely from immutable `app.id`, using the v1 mapping
in Part III. It never hashes `name`, uses inline HSL, or acts as a platform
control icon.

States and evidence:

- `RemoteImage`, `FallbackSlot1`, `FallbackSlot8`, `RenameStable`,
  `Light`, `Dark`, and each size story.
- Unit tests cover stable ID → slot mapping, slug fallback only for malformed
  legacy fixtures, and a rename that keeps the selected slot.
- Contrast tests cover every slot/mode foreground, border, and focus ring.

Boundary: this updates only `@/features/apps/app-identity.tsx`, consumed today
by `app-card.tsx` and `app-details.tsx`. It is not a child-app avatar or
generic icon primitive.

### `StatusDot`

Public props:

```ts
type StatusDotRole =
  | "positive"
  | "info"
  | "warning"
  | "negative"
  | "attention"
  | "neutral"

type StatusDotProps = {
  role: StatusDotRole
  subject: string
  label: string
  detail?: string
  size?: "sm" | "md"
  showLabel?: boolean // default true
}
```

Domain adapters own finite mappings. The app adapter, for example, maps:

| Presentation status | Semantic role | Minimum non-color signal |
|---|---|---|
| running | positive | `Running` label or screen-reader name |
| building | info | `Building` label + progress context where available |
| awaiting-secrets | warning | `Configuration required` label |
| unavailable | negative | `Unavailable` / failure label |
| paused | attention | `Paused` label |
| unknown | neutral (existing muted/outline) | `Unknown` label |

`StatusDot` owns rendering, shape, size, semantic-role consumption, and the
accessible-name format (`<subject>, <state>` — `Node, synced` ·
`Game Corner, building`). Domain adapters (Node, App, Connection) own their
state vocabulary and mapping; sharing a semantic role does not make `syncing`
and `building` the same domain
state.

`StatusDot` is the compact state glyph. It does not replace `Alert` for an
error that needs a recovery action, or `Badge` for arbitrary metadata. A
consumer must supply the human label; it may not render a raw API status as
the visual contract.

States and evidence:

- One story per status in light/dark, `DotOnly`, `WithLabel`, and
  `WithDetail`, plus explicit App/Node/Connection adapter stories.
- Dot-only has an accessible name. Color is never the sole state signal.
- The dot's role colors use only the canonical status/attention tokens.

### `FocusedAppFrame` and `AppChrome`

These two parts separate contract-heavy hosting from platform presentation.

Public props:

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
  mode: "use" | "improve" | "nested"
  state: "loading" | "ready" | "offline" | "unavailable" | "self-hosted"
  onClose: () => void
  onBack?: () => void
  onImprove?: () => void
  onRetry?: () => void
  onUse?: () => void
  onOpenOverflow?: () => void
  consoleError?: boolean
  nestedLabel?: string
}
```

`FocusedAppFrame` owns the exact iframe source validation, sandbox string,
frame ref, dev-console frame registration, load handoff, and no unrequested
iframe remount. The route/host orchestration adapter owns app loading, the
45-minute iframe-token refresh cadence, online/offline subscriptions, native
title sync, routing, and retry policy.

`AppChrome` is the focused route's compact, props-only presentation layer: its
app name is the route `h1`; it shows identity, state, exactly one reciprocal
Use/Improve action where authorized, Close, genuine nested Back, and optional
overflow/console-error evidence. It is absolutely overlaid and must not reserve
permanent iframe space. It never shows Use and Improve as equal-weight
persistent modes.

States and evidence:

- AppChrome stories: `Loading`, `Ready`, `OfflineRetry`, `SelfHosted`,
  `NotRunning`, `NarrowFocused`, `ImproveMode`, `NestedRoute`, and
  `ConsoleError`.
- FocusedAppFrame stories: `TokenUnavailable`, `OfflineRetry`,
  `UnsafeDestination`, `SelfHosted`, and `NotRunning`. A fake ready iframe is
  deliberately absent from Storybook.
- Browser host-contract tests assert source sanitization, `sandbox`,
  `allow`, token refresh, offline retry, direct-link inner path, header/native
  title handoff, back/history, and iframe continuity across compact chrome
  state updates.
- Screen-reader users get a named iframe and visible/announced loading or
  unavailable state. No fake iframe content is put in Storybook.

Performance and motion metadata: `FocusedAppFrame` is a
mount-continuity-sensitive pattern: it stays mounted across header/sidebar,
notifications, state badge, and compact-chrome updates. Only a URL/token/retry
change may replace the frame. It is a `review-later` performance contract
until browser profiling confirms the implementation. Motion candidates are
drawer/frame settling and compact-chrome state changes only. They must respect
reduced motion and must never animate iframe dimensions in a way that causes
resize/reload or hides a focused child-app control.

### Parallel source and story ownership

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

### Integration order

1. Approve the semantic-token specification (Part III) before identity/status
   styling.
2. Land PageHeader and PlatformNavigation with adapters around the current
   `PlatformShell`; preserve route/deep-link behavior while retiring the
   superseded global toolbar.
3. Split `AppCard` into `HomeAppShortcut` and `ExploreAppCard`; route data and
   favorite/reorder mutation behavior stay in `AppsHome`.
4. Migrate AppIdentity with deterministic slots and then introduce StatusDot
   after role tokens are available.
5. Extract FocusedAppFrame without changing iframe URL, sandbox, allow, token
   cadence, or offline behavior; layer AppChrome on it only after parity
   fixtures pass.
6. Update catalog, Storybook, browser/a11y evidence, and cutover notes per
   slice. Retire an old local pattern only once all of its route consumers have
   moved and the route-parity checklist is approved.

---

## Part V — Motion policy

Do not install Motion during the baseline, token, or successor-contract waves.
Stories and authority entries may record candidate metadata only:

- intent and trigger;
- spatial relationship communicated;
- mount-continuity requirement;
- reduced-motion behavior;
- bundle and WebView risk;
- adoption gate.

CSS hover, focus, and pressed states remain upstream behavior. No looping or
idle animation is allowed; determinate or indeterminate progress is the only
exception.

After the static `FocusedAppFrame` proves iframe mount continuity and real
WebView behavior, a separate decision may authorize a small
`@/lib/motion` adapter for drawer/frame settling and the one-time attention
pulse. Failure of that experiment does not block the static model.

---

## Part VI — Execution plan

**Goal:** produce one integrated, reviewable shell branch quickly without
allowing parallel agents to overwrite shared design-system sources.

### Delivery rules

- One coordinator owns the integration branch, dependency gates, shared-file
  assignments, and final evidence.
- Every task starts with `node tool/ui-workflow.mjs --task "<task>"`.
- Agents receive explicit file ownership and do not revert unrelated changes.
- Only one agent at a time owns shared primitives, generated tokens, global
  CSS, authority files, or package metadata.
- Read-only reconnaissance can run ahead. Mutating work starts only after its
  dependency gate passes.
- Each milestone is independently reviewable and green. Do not hide unrelated
  work in one large final commit.
- The final branch is reviewed as the sum of milestone commits; it is not
  squashed until reviewers request it.
- Do not polish `AppCard`, the mixed Apps Home composition, or the global
  toolbar. They are superseded.

### Dependency map

```text
M0 accepted charter + frozen Create preset
 ├─ M1 structural integrity
 ├─ M2 content governance
 └─ Luma reconnaissance (read-only/scratch)
          │
          └─ M3 single-owner Luma merge
                    │
                    └─ M4 semantic foundation
                              │
                 ┌────────────┼────────────┐
                 │            │            │
          M5a identity    M5b app      M5c navigation/
          and headers     discovery    app-frame contracts
                 │            │            │
                 └──────┬─────┘            │
                        │                  │
                   M6 Home/Explore     M7 drawer/chrome
                        └──────────┬────────┘
                                   │
                       M6c quiet pass (surviving surfaces)
                                   │
                         M8 host/static frame proof
                                   │
                         M9 optional Motion decision
                                   │
                            M10 cutover review
```

### Current execution checkpoint

This table is the branch-level source of truth for what may be built next.
Milestones are complete only when their dedicated commit and required evidence
exist; uncommitted work remains in progress even when focused checks pass.

| Milestone | Status | Branch evidence |
| --- | --- | --- |
| M0 accepted charter + frozen Create preset | Complete | `e9334f1`, `67af90a`, and the consolidated authority in this guide |
| M1 structural integrity | Complete | `635eb93` |
| M2 content governance | Complete | `f12635a` |
| Luma probe and reliability preparation | Complete | `521e926`, `aedb14d` |
| M3 single-owner Luma merge | Complete | `4c5d93e` |
| M4 semantic foundation | Complete | `565c5ff`; AppIdentity, StatusDot, Light/Dark/System parity, DTCG roles, contrast and forced-colors evidence, 165 Storybook states, production-review tests, and shell gates are green |
| M5 successor contracts | Complete | `e2a8189`, `14ef98a`; six registered props-only patterns, 207 Storybook states/tests, both-theme evidence, interaction assertions, authority/catalog contracts, build, bundle and shell gates are green |
| M6–M7 Home/Explore, navigation, app chrome, and quiet pass | Ready | route integration may begin with one owner for route tables, shell composition and shared fixtures |
| M8–M10 host proof, optional Motion, and cutover | Not started | follow the gates below; do not collapse host proof or Motion into route integration |

### Wave 0 — Charter and preset freeze

**Owners:** documentation agent (accepted docs and cross-links); Create
investigator (uses the shadcn CLI and Create UI to propose the exact Base UI +
Luma code; no source mutations); coordinator (accepts the preset record and
commits the wave).

**Outputs:** coherent audit, navigation, refinement, host, and execution
records; exact opaque Create preset code, decoded fields, URL, CLI version,
and rationale; current-state record (Base UI/Base-Nova); target-state record
(frozen Base UI + Luma preset, merge-mode adoption).

**Stop/go G0:** stop if the preset code is absent, manually reconstructed,
changes the primitive base, or its decoded choices do not match the accepted
review. Go when the code is reproducible through `preset decode`, `preset
url`, and `preset resolve`.

**Milestone commit:** `docs(shell): freeze accepted charter and Create baseline`

*Status: complete — G0 is satisfied by the frozen record in Part II.*

### Wave 1 — Parallel foundations

Run three disjoint lanes after G0.

**Lane 1A — Structural integrity.** Ownership: shell landmarks, route heading
elements, route fallback, targeted axe configuration/tests, style-policy
coverage, exception inventory, stale authority reference, avatar contrast fix.
Required results: one shell-owned `main`; one route-owned `h1`; named
navigation landmark; serious avatar contrast finding fixed; moderate
landmark/heading rules enforced; widened style-policy inventory ledgered with
owner and expiry; viewport tag unchanged pending device evidence. No visual
redesign and no general copy pass.

**Lane 1B — Content governance.** Ownership: content-contract
schema/authority, objective content checker, fixtures, and Storybook content
review requirements. Mechanically check only objective rules: canonical terms,
banned filler, invalid ellipses, migration language, and machine-verifiable
label/name relationships. Keep context restatement, defensive reassurance, and
other judgment-heavy failures in named human review.

**Lane 1C — Luma reconnaissance.** Ownership: isolated scratch project and an
impact report. No edits to production primitives, CSS, tokens, or feature
components. Compare the frozen Luma preset with every installed official
component. Record upstream changes, local accessibility/platform deviations to
preserve, expected token/CSS effects, and likely conflicts with lanes 1A/1B.
*Output: the component dispositions and impact analysis in Part II.*

**Stop/go G1:** go only when structural tests are green, content checks are
green, existing style-policy violations are ledgered rather than silently
ignored, and the Luma report identifies every shared file it will touch.

**Milestone commits:**

- `fix(shell): restore landmark heading and contrast integrity`
- `feat(content): enforce shell content contracts`
- `docs(shadcn): record Luma merge impact`

### Wave 2 — Single-owner Luma adoption

Freeze feature edits to shared UI sources during this wave.

**Ownership:** one Luma integration agent owns `components.json`, global CSS,
official UI primitives, font setup, and baseline theme tokens. The coordinator
resolves any overlap with Wave 1; other agents review or work only in disjoint
docs/tests.

Use merge mode (Part II adoption rule): update configuration without
reinstalling detected components; inspect each component with `--dry-run` and
`--diff`; merge official Luma geometry and styling; preserve documented local
accessibility/platform changes; run format/generation commands and review
their exact diff.

Do not add Usernode identity/status/attention roles here. This milestone proves
the upstream baseline by itself.

**Stop/go G2:**

- preset resolution matches the frozen record;
- no blind overwrite or unexplained local primitive fork;
- light/dark Storybook and route screenshots show coherent Luma;
- axe has no new critical, serious, or governed moderate findings;
- typecheck, unit, Storybook, and targeted browser tests pass;
- feature-specific styling did not enter official primitives.

**Milestone commit:** `feat(ds): adopt frozen Luma baseline in merge mode`

### Wave 3 — Product-semantic foundation

Parallelize discovery and stories, but serialize writes to shared tokens and
generated CSS. The specification is Part III.

**Lane 3A — Semantic tokens and theme contract.** Own finite identity palette
roles, positive/info/warning/negative status roles, attention,
aliases/generation, and Light/Dark/System compatibility. Absent storage key
continues to mean System.

**Lane 3B — `AppIdentity`.** After token names stabilize, own artwork failure,
Unicode-aware monogram fallback, immutable-ID mapping, and light/dark named
states. The mapping is finite and deterministic; no runtime hue generation.

**Lane 3C — `StatusDot`.** After token names stabilize, own the rendering
primitive, accessible-name format, and explicit Node/App/Connection domain
adapters. Semantic roles are shared; domain states are not collapsed.

The menu attention dot is static. Record candidate motion metadata only.

**Stop/go G3:**

- token generation and style policy pass;
- deterministic mapping tests cover stable IDs and fallback behavior;
- contrast passes for every identity/status role in both themes;
- theme storage remains byte-compatible with legacy behavior;
- no Motion dependency or direct hardcoded status/identity color exists.

**Milestone commit:** `feat(ds): add shell identity status and theme semantics`

### Wave 4 — Successor contracts

Build props-only, Storybook-first contracts before route wiring, per Part IV.
Agents may run in parallel with disjoint component/story ownership:

| Lane | Patterns |
| --- | --- |
| 4A | `PageHeader`, shared section-header layout |
| 4B | `HomeAppShortcut`, `ExploreAppCard` |
| 4C | `PlatformNavigation`, `AppChrome`, `FocusedAppFrame` |

One authority/harness integrator serializes manifest, authority, catalog,
registry, and generated-artifact changes after component branches settle.

Every pattern declares user job, content layer, production copy, accessible
name and focus contract, light/dark, mobile/desktop, loading/error/empty states
where relevant, performance expectations, and motion-candidate metadata.
Prefer official Luma primitives; `className` is for layout rather than
restyling them.

**Stop/go G4:** all named states pass Storybook interaction tests and
both-theme axe scans. `FocusedAppFrame` declares iframe mount continuity as a
performance contract. No pattern calls an endpoint directly.

**Milestone commits:**

- `feat(shell): define header and app discovery contracts`
- `feat(shell): define navigation and focused-app contracts`

### Wave 5 — Parallel product slices

**Lane 5A — Home and Explore.** Replace the mixed Apps Home:

- Home is sparse, personal, and launches apps directly;
- Explore owns search, discovery, detail entry, and Create app;
- Home previews at most three important Activity items;
- first-run, empty collection, no results, loading, and error are distinct;
- deprecate, migrate, then remove `AppCard` and its obsolete test anchors.

**Lane 5B — Navigation and contextual chrome.** Implement Home, Explore, Work,
Challenges, Activity, separate Node, and bottom utilities. Add gated Admin,
static menu attention, Activity count inside the drawer,
Use/Improve/Close/Back semantics, and theme inside Settings. Remove the
duplicate global toolbar and page-body Back controls.

Lanes may proceed together only if route tables, shell composition, and shared
fixtures have one named owner. Integrate Home/Explore before final navigation
route assertions.

**Stop/go G5:**

- route/deep-link compatibility passes;
- Home launch and Explore detail jobs remain distinct;
- drawer labels and content terms follow the content authority;
- keyboard, focus order, narrow/wide states, and authorization states pass;
- superseded surfaces are removed or explicitly deprecated with no new uses.

**Milestone commits:**

- `feat(apps): split personal Home from Explore`
- `feat(shell): land platform drawer and contextual chrome`

**Lane 5C — Quiet pass on surviving surfaces.** Starts only after 5A/5B
remove or deprecate the superseded surfaces, so no edit lands on doomed code.
Ownership: Work, Challenges, Activity, Node, Account, Settings, Feedback, the
Admin suite, app details, and the Dev surfaces — every route that survives the
Home/Explore split but was not rewritten by it.

This lane is deletion-only. It applies the content guidelines' judgment-heavy
failure modes that Lane 1B's mechanical checker cannot catch: context
restatement, defensive reassurance, mechanism-as-content, internal-state leak,
performative apology, plus the icon policy (no decorative button icons) and
badge suppression (no badge restating its own section). Every removal cites
its failure mode by name in the PR, per the content guidelines' review
procedure. If a diff adds a class or a visual treatment, it is out of scope
for this lane — that belongs to a successor-contract or Luma wave, not here.

**Stop/go G5c:**

- every changed string names its failure mode;
- no visual/structural diff accompanies a copy-only change;
- content checker (Lane 1B) and existing route/a11y tests stay green;
- superseded surfaces (already removed by 5A/5B) are out of scope, not
  incidentally touched.

**Milestone commit:** `fix(content): remove restated and defensive copy from surviving shell routes`

### Wave 6 — Static focused-app and host verification

Run web and host lanes in parallel; do not add JS motion.

**Web lane.** Prove drawer open/close does not remount the iframe. Preserve
form, scroll, and JavaScript state. Make the shifted app inert while the
temporary drawer owns focus. Preserve direct routes, legacy hashes, browser
history, and external link behavior.

**Host lane.** Complete or evidence: edge-to-edge safe-area ownership without
double insets; native bridge caller authentication and privilege isolation;
shortcuts/widgets reopening the web-owned focused-app route with matching
assets; real-device iOS/Android viewport zoom, Back, and offline behavior;
service-worker readiness and route parity.

**Stop/go G6:** bridge caller authentication is a hard cutover blocker. So are
iframe remount, double safe-area inset, broken native Back, unproven viewport
behavior, and shortcut/widget route divergence. Static behavior must pass
before Motion can be reconsidered.

**Milestone commits:**

- `feat(shell): preserve focused-app state across navigation`
- host-repository commit(s), referenced by immutable revision in evidence

### Wave 7 — Optional Motion experiment

This wave does not start automatically. G6 opens a decision, not an obligation.

If approved, one owner may add a small `@/lib/motion` adapter and only:

- drawer/`FocusedAppFrame` settling;
- a one-time attention appearance pulse.

Require reduced-motion no-op behavior, measured bundle impact, no direct
Motion imports, no looping animation, and real WebView evidence. If any check
fails, retain the static implementation.

**Milestone commit, only if accepted:**
`feat(shell): add measured focused-app settling`

### Wave 8 — Cutover and final review

The coordinator rebases/integrates milestone commits, resolves generated
artifacts once, and runs the complete evidence matrix.

Required review evidence:

| Area | Evidence |
| --- | --- |
| Authority | frozen preset record; current/target resolution; generated artifacts clean |
| Structure | landmark/heading tests; no unledgered style-policy violations |
| Content | content checker; named human failure-mode review; Lane 5C quiet-pass evidence for surviving surfaces |
| Visual | deterministic light/dark, mobile/desktop screenshots for every successor state |
| Accessibility | axe with critical/serious and governed moderate rules; keyboard and focus traces |
| Behavior | Home/Explore jobs, drawer states, admin gating, theme compatibility |
| Hosted app | iframe mount identity plus form/scroll/JS continuity |
| Routing | direct URLs, legacy hashes, browser Back, Android Back, shortcut/widget entry |
| Host | safe-area, viewport zoom, bridge authentication, offline/service worker on real devices |
| Performance | bundle gate, route loading, declared sensitive interactions; Motion separately if adopted |

**Final stop/go G7:** cut over only when all required evidence is attached, no
hard host blocker remains, and the complete frontend gate passes from a clean
worktree. Otherwise ship the last green milestone for review and name the exact
blocker; do not weaken a gate to manufacture completion.

**Final milestone commit:**
`chore(shell): attach cutover evidence and retire legacy shell`

---

## Review checklist

For every shell PR:

1. Is the surface still part of the accepted target?
2. Is the choice owned by Create, DTCG, an owned pattern, or content guidance?
3. Does new color carry named product meaning through a semantic slot?
4. Does spacing have one owner and does the pattern own its internal measure?
5. Is the surface classified before receiving a background or border?
6. Is copy's Glance/Read/Expert layer named and are failure modes reviewed?
7. Does Storybook use production-quality copy for loading, empty, error,
   offline, and attention states?
8. Is motion absent unless the deferred gate has explicitly opened?
9. Are both themes, mobile/desktop, axe, targeted interaction tests, and the
   narrowest project gates represented in evidence?

## Deliberate rejections

Per-component accent colors; unrestricted hue generation; looping or idle
animation; decorative button icons; reassurance copy; badges that restate
context; blind preset overwrite; a second design vocabulary layered over
Luma; styling legacy surfaces scheduled for removal; page-wide centering as a
universal route rule; changes to hosted child apps.
