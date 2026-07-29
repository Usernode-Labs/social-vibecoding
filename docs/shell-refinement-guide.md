# Shell refinement guide

**Status:** Accepted direction; worker-facing implementation guide

**Date:** 2026-07-29

**Scope:** React platform shell only, as governed by
`frontend/design-system/authority.json`

Read first:

- [`shell-component-audit.md`](shell-component-audit.md) — findings,
  supersessions, and structural prerequisite;
- [`platform-navigation-proposal.md`](platform-navigation-proposal.md) —
  accepted information architecture and host appendix;
- [`shell-execution-plan.md`](shell-execution-plan.md) — dependency waves,
  agent ownership, gates, and review evidence;
- [`shadcn-create-baseline.md`](shadcn-create-baseline.md) — reproducible
  current/proposed preset evidence and Luma impact;
- [`../frontend/design-system/content-guidelines.md`](../frontend/design-system/content-guidelines.md)
  — copy authority;
- `frontend/AGENTS.md` — working rules.

Start every implementation task with:

```sh
node tool/ui-workflow.mjs --task "<task>"
```

## Thesis

User attention is the shell's scarcest resource. The shell competes with the
apps it hosts, so decoration in the shell is attention taken from the user's
current app.

Distinctiveness therefore comes from a few details applied consistently, not
from decorating every component. The shell is quiet by default. Before adding
a treatment, accent, animation, or explanatory sentence, ask whether it serves
one of the three signatures below. If it does not, use the upstream default. If
that default is wrong everywhere, fix the preset or semantic layer rather than
patching one instance.

## The three signatures

1. **App identity** — `AppIdentity` artwork and monograms. Apps are the content,
   so their identity is the shell's primary expressive color.
2. **Status language** — one `StatusDot` rendering primitive backed by shared
   semantic roles, while each domain retains truthful state vocabulary.
3. **Attention indicator** — one platform-menu dot. It is static initially.
   A single appearance pulse is an approved future motion candidate, not a
   current dependency or acceptance requirement.

Buttons, cards, lists, headers, forms, and empty states remain quiet,
official-shadcn, and token-driven.

## Upstream baseline: shadcn Create

[shadcn Create](https://ui.shadcn.com/create) is the key design-system control
for the consumer shell. It chooses a coherent upstream system rather than
serving as a theme swatch generator.

The present project resolves to Base UI + Nova preset `b2fA`. The exact
proposed target is the official Base UI + Luma preset `b1VlIttI`: rounded,
breathable, consumer-facing, and close to official shadcn defaults. It remains
a proposal until the G0 review explicitly freezes it; no production source may
apply it before then. See
[`shadcn-create-baseline.md`](shadcn-create-baseline.md).

Do not reconstruct preset URLs or decode codes by hand. Use the project package
runner and shadcn CLI:

```sh
pnpm dlx shadcn@latest preset decode <code>
pnpm dlx shadcn@latest preset url <code>
pnpm dlx shadcn@latest preset resolve --json
```

The frozen preset record must contain:

- opaque preset code and generated Create URL;
- decoded style, theme, base color, font, heading font, icon, radius, and menu
  choices;
- Base UI as the retained primitive base;
- CLI version, adoption date, rationale, and deliberately deferred knobs.

Preset `b1VlIttI` decodes to Luma, Neutral, Inter, Lucide, default radius,
subtle menu accent, and default menu color. The current Nova preset uses Geist.
Retaining Geist is a valid review choice, but it requires generating and
recording a different exact Create code; it must not be patched into
`b1VlIttI` by description.

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

## Authority split

| Authority | Owns | Does not own |
| --- | --- | --- |
| Frozen Create preset | Upstream style, primitive base, geometry, density, fonts, icons, radius, menu treatment, and baseline theme | Usernode product meaning or platform behavior |
| Usernode DTCG tokens and authority | App-identity palette, status roles, attention role, theme-storage compatibility, and shell-specific semantic gaps proven after Luma | Recreating Luma per component |
| Owned shell patterns | Platform-specific composition, routing, focus/inert behavior, iframe mount continuity, and contextual chrome | New primitive styling without a semantic reason |
| Content guidelines | Vocabulary, information hierarchy, visible labels, accessible names, state copy, and named failure modes | Visual geometry or runtime behavior |

When a global visual choice feels wrong, return to Create. When product meaning
is missing, add a Usernode semantic role. When one instance looks different
without a semantic reason, remove the override.

## System laws

Every future law must state **what** it constrains, **why** an observed failure
requires it, and **where** it is enforced.

### 1. Color flows through owned slots

Chromatic product meaning uses semantic roles (`identity-*`, `status-*`,
`attention`). Baseline structure uses the frozen preset. No component writes a
raw hue.

**Why:** raw values made brand and theme changes a file-by-file hunt.

**Where:** DTCG tokens, style policy, Storybook contrast evidence.

### 2. Spacing has one owner

The screen owns margins and inter-surface gaps; a surface owns its inset; a
leaf owns content padding. Parents use `gap-*`; components carry no external
margin.

**Why:** ad-hoc margin stacks make composition order change spacing.

**Where:** official Luma composition, successor stories, review checklist.

### 3. Every surface is classified

A surface is scaffold, content, inherited, inverse/transient, or separation.
If unclear, inherit. Adopt Luma elevation and shadows first; add a shell
surface or shadow token only when a named pattern proves a semantic gap.

**Why:** the current dark shell separates nearly everything with borders.

**Where:** stories in both themes and component review.

### 4. Fix the system, not the instance

Do not add per-instance color, font, radius, shadow, or density overrides. Fix
the Create preset when the upstream baseline is wrong globally; fix a semantic
role or owned pattern when a product distinction is missing.

**Why:** local overrides created competing title scales and surface styles.

**Where:** style policy, exception ledger, review checklist.

### 5. The shell canvas uses available width

Do not impose one arbitrary centered frame on every route. Each content pattern
owns its internal measure, columns, and responsive grid. Prose constrains its
own readable line length. Conversation, board, console, and table surfaces use
the available canvas.

**Why:** six page-level widths make adjacent routes jump and starve wide work
surfaces.

**Where:** route layouts as touched and successor-pattern stories.

### 6. Taste waits for evidence

Defer choices that the current product does not require:

- experimental display fonts;
- a redesigned five-color chart ramp;
- custom elevation or shadows beyond Luma;
- achromatic-versus-branded structural roles;
- mono display heroes.

Revisit them through Create or a recorded semantic decision when real content
requires them.

## Product-semantic contracts

### App identity

Use a finite, reviewed palette:

```text
immutable app ID
→ frozen mapping algorithm
→ stable palette token
→ theme-specific surface / foreground / border
```

Do not generate unrestricted runtime hues. The same app ID must resolve to the
same token across sessions, routes, and light/dark themes. Artwork failure and
Unicode-aware monogram fallback are required states.

### Status

`StatusDot` owns rendering, shape, size, accessible-name format, and semantic
role consumption. Domain adapters own their state vocabulary and mapping.

| Domain state | Semantic role | Accessible example |
| --- | --- | --- |
| Node `synced` | `status-positive` | `Node, synced` |
| Node `syncing` | `status-warning` | `Node, syncing` |
| App `building` | `status-warning` | `Game Corner, building` |
| App `failed` | `status-critical` | `Game Corner, failed` |
| Connection `offline` | `status-critical` | `Connection, offline` |
| Unknown domain state | `status-unknown` | `<subject>, status unknown` |

Sharing a semantic role does not make `syncing` and `building` the same domain
state.

### Attention

The menu uses one dot with an attention semantic role. It never displays a
count; the drawer Activity row owns the count. The initial implementation is
static.

## Motion policy

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

## Work sequence

The detailed parallel plan and stop/go gates live in
[`shell-execution-plan.md`](shell-execution-plan.md). The required order is:

1. accepted charter and exact Create-preset freeze;
2. structural integrity and content governance;
3. Luma reconnaissance, then single-owner merge;
4. narrow Usernode semantic foundation;
5. Storybook-first successor contracts;
6. Home and Explore;
7. navigation and contextual chrome;
8. static focused-app behavior and host verification;
9. optional Motion experiment;
10. evidence-backed cutover.

Do not polish `AppCard`, the mixed Apps Home composition, or the global toolbar.
They are superseded.

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
