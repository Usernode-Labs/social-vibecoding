# shadcn Luma merge impact

**Status:** Read-only reconnaissance; no preset applied

**Date:** 2026-07-29

**Scope:** the 29 official primitives currently installed in the React
frontend, plus the configuration, font, and token sources an eventual Luma
merge would affect

This report is the Wave 1C output from
[`shell-execution-plan.md`](shell-execution-plan.md). It compares production
Base UI + Nova against a fresh Base UI + Luma scratch project. It does not
authorize production adoption.

## Reproduced preset facts

Official shadcn CLI `4.16.0` reproduced both records:

| Field | Current production | Exact proposal |
| --- | --- | --- |
| Code | `b2fA` | `b1VlIwYS` |
| Style | Nova | Luma |
| Base color / theme / charts | Neutral | Neutral |
| Font / heading | Geist / inherit | Geist / inherit |
| Icons | Lucide | Lucide |
| Radius | Default | Default |
| Menu accent / color | Subtle / default | Subtle / default |

The proposed URL is
[`https://ui.shadcn.com/create?preset=b1VlIwYS`](https://ui.shadcn.com/create?preset=b1VlIwYS).
Base UI is retained by the existing project configuration; preset codes do not
encode the primitive base.

Reproduction commands, run from `frontend/`:

```sh
npx shadcn@latest preset resolve
npx shadcn@latest preset decode b1VlIwYS
npx shadcn@latest --version
```

The user froze this exact code with Geist preserved. There is no font-package
or font-token migration in the Luma adoption.

## Probe summary

The scratch project generated the same 29 official primitives as production:

- 3 are byte-identical;
- 26 differ;
- the Luma side contains 449 insertions and removes 183 production lines;
- much of the large `select`, `alert-dialog`, and `tabs` delta is formatting,
  but their geometry and surface classes also change.

Disposition meanings:

- **Identical** — no production source change.
- **Take upstream** — the delta is limited to Luma presentation or a harmless
  client-boundary addition; still land through reviewed diff, not overwrite.
- **Merge carefully** — Luma presentation is wanted, but a high-fan-out API,
  interaction, focus, disabled, overlay, or structural contract requires
  targeted regression evidence.
- **Preserve local behavior** — adopt compatible Luma presentation while
  deliberately retaining a production behavior that upstream removes.

## All component dispositions

The delta column is Luma additions / production removals.

| Primitive | Delta | Disposition | Merge note |
| --- | ---: | --- | --- |
| `accordion` | +8 / −5 | Merge carefully | Luma adds the bordered rounded container and larger inset, but drops the trigger's explicit focus-visible border/ring classes. Retain a clearly visible keyboard focus treatment and verify open/closed animation. |
| `alert-dialog` | +137 / −20 | Merge carefully | Mostly formatting plus larger radius, inset, media, shadow, and darker overlay. Preserve Base UI portal, title/description semantics, action/cancel API, focus trap, Escape, and focus return. |
| `alert` | +2 / −2 | Take upstream | Radius, inset, gap, and action position only. Check destructive and default contrast. |
| `attachment` | +3 / −3 | Take upstream | Radius and focus-ring alpha only; attachment state, orientation, and media behavior are unchanged. |
| `avatar` | 0 / 0 | Identical | The primitive does not fix application fallback contrast by itself; retain the structural patch's consumer-level contrast evidence. |
| `badge` | +1 / −1 | Take upstream | Radius only. Product status still moves to `StatusDot`; do not create new status-badge semantics. |
| `bubble` | +1 / −1 | Take upstream | Radius, padding, and focus-ring alpha only. Preserve chat alignment and link/button focus behavior. |
| `button-group` | +4 / −4 | Take upstream | Luma adds pill geometry and outline-child border/focus coordination. Verify mixed input/select/button groups. |
| `button` | +11 / −13 | Merge carefully | Central, high-fan-out change: all heights/padding/radii, outline dark surface, destructive treatment, and focus-ring alpha change. Keep variant/size names and Base UI `render` behavior; app-chrome 48px targets remain an owned-pattern contract. |
| `card` | +4 / −7 | Merge carefully | Luma adds larger radius, spacing, and shadow and changes footer treatment. Audit consumers that rely on flush muted footers, `size="sm"`, image clipping, or skeleton geometry. Do not polish the superseded `AppCard`. |
| `empty` | +4 / −4 | Take upstream | Larger inset, media, title, and content gaps match Luma. Content discipline still limits the owned state to one glyph, one line, and at most one action. |
| `field` | +8 / −6 | Take upstream | Spacing and selected-field surface change; Luma adds a client directive. Preserve `fieldset`/`legend`, `data-invalid`, disabled, checkbox, and radio contracts. |
| `input-group` | +11 / −14 | Merge carefully | Surface, height, radius, KBD styling, and block-addon inset change. Luma removes several explicit disabled background rules; prove disabled, invalid, textarea, button-addon, and combobox-nesting states before accepting. |
| `input` | +1 / −1 | Take upstream | Luma changes height, pill geometry, transparent border, filled surface, focus alpha, and disabled surface. Semantics and API are unchanged; verify autofill, file input, invalid, and disabled contrast. |
| `label` | +2 / −0 | Take upstream | Only the official client directive is added. |
| `marker` | 0 / 0 | Identical | No action. |
| `message-scroller` | +3 / −1 | Take upstream | Adds the official client directive and increases message gap. Preserve scroll anchoring, streaming follow, and jump-to-latest behavior. |
| `message` | +2 / −2 | Take upstream | Header/footer horizontal inset only. |
| `select` | +148 / −49 | Merge carefully | Large generated diff plus trigger/menu geometry and density. Preserve Base UI portal/positioner, trigger sizing API, item indicator, scroll arrows, disabled/invalid behavior, keyboard typeahead, and focus return. Inspect a fresh CLI `--diff`; do not copy the scratch file wholesale. |
| `separator` | 0 / 0 | Identical | No action. |
| `sheet` | +5 / −7 | Merge carefully | Darker overlay, larger header/footer inset, secondary close surface, and shadow change; the probe removes production's client directive. Retain the directive, title contract, focus trap/return, Escape, side geometry, and accessible close label. |
| `sidebar` | +20 / −19 | Merge carefully | Luma changes menu density/radii and removes production's client directive. Retain the directive, `SidebarInset` as the shell's sole `main`, cookie/state behavior, keyboard shortcut, mobile Sheet semantics, and wide/mobile collapse behavior. This file cannot merge before the structural-integrity owner finishes. |
| `skeleton` | +1 / −1 | Take upstream | Radius only. Successor skeletons must still derive from their real components. |
| `switch` | +2 / −4 | Merge carefully | Geometry changes from a compact round thumb to Luma's wider track/thumb and removes production's client directive. Retain the directive and expanded pointer target; prove checked/unchecked, disabled, focus, invalid, and both themes. |
| `tabs` | +60 / −10 | Merge carefully | Formatting plus pill geometry, density, vertical shape, and trigger state changes. Preserve Base UI activation, keyboard navigation, line variant, vertical orientation, disabled state, and visible focus. |
| `textarea` | +1 / −1 | Preserve local behavior | Adopt Luma surface, radius, inset, and focus treatment, but do not silently add `resize-none`. Production allows user resize; remove it only with an explicit product/accessibility decision. |
| `toggle-group` | +2 / −2 | Take upstream | Luma changes joined outline geometry, padding, shadow, and selected surface. Preserve orientation, spacing, group context, keyboard behavior, and mutually exclusive semantics where the consumer requires them. |
| `toggle` | +4 / −4 | Take upstream | Radius, sizes, transition, and focus alpha change. Preserve visible pressed state through the Base UI `aria-pressed` contract. |
| `tooltip` | +4 / −2 | Take upstream | Adds the official client directive and adjusts radius/arrow position. Preserve provider delay, portal, side placement, hover/focus opening, Escape, and non-duplication with native `title`. |

Summary by disposition:

- **Identical:** `avatar`, `marker`, `separator`.
- **Take upstream:** `alert`, `attachment`, `badge`, `bubble`, `button-group`,
  `empty`, `field`, `input`, `label`, `message-scroller`, `message`, `skeleton`,
  `toggle-group`, `toggle`, `tooltip`.
- **Merge carefully:** `accordion`, `alert-dialog`, `button`, `card`,
  `input-group`, `select`, `sheet`, `sidebar`, `switch`, `tabs`.
- **Preserve local behavior:** `textarea`.

## Exact production source impact

### Direct primitive files

An accepted migration would edit the 26 non-identical files under
`frontend/@/components/ui/`. The three identical files should remain untouched.
No owned feature component belongs in the primitive-migration commit.

### Configuration and global CSS

| Production file | Expected disposition |
| --- | --- |
| `frontend/components.json` | Change the style only after the preset freeze; retain Base UI, aliases, RTL choice, and the `@usernode-shell` registry. Never replace the file with the scratch config. |
| `frontend/src/index.css` | Merge manually. Preserve the Geist font import, generated-token import, `--font-sans-authority`, custom dark variant, token-to-Tailwind mappings, and explicit light/dark `color-scheme`. |
| `frontend/design-system/tokens.json` | Remains canonical. Neutral colors, Geist, and `0.625rem` radius already match the frozen Luma preset; do not paste the probe's `:root`/`.dark` block into global CSS. |
| `frontend/src/generated/design-tokens.css` | Regenerate from DTCG after any accepted font/token change; never hand-edit. |
| `frontend/scripts/design-token-tools.mjs` and `build-design-tokens.mjs` | Preserve the generator contract. No Luma-specific change is currently justified. |
| `frontend/package.json` and `frontend/package-lock.json` | No font dependency change is expected. Do not import the scratch project's unrelated React, Vite, TypeScript, Tailwind, Lucide, or formatter versions. |
| `frontend/design-system/exceptions.json` | Re-inventory official-source exact matches after the merge. Remove resolved Nova exceptions, update still-required upstream exceptions with reviewed exact matches, and do not weaken the policy. |

The generated `frontend/design-system/catalog.json`, root catalog, manifest, and
registry do not embed these official primitive sources. They change only if an
authority contract changes; do not regenerate them merely because component
classes changed. `storybook-static` and `public/r` are generated outputs and
must not be hand-edited during the merge.

## Contracts to preserve

### Accessibility

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

### Platform and local behavior

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

## Shared-file collision risks

| Concurrent lane | Collision | Coordination rule |
| --- | --- | --- |
| Structural integrity | `sidebar.tsx`, shell composition, route tests | Structural owner lands first. Luma owner then merges only Sidebar presentation around the retained `main` and landmark contract. |
| Content governance | `authority.json`, schemas, catalog generation, exception ledgers | Luma work avoids content authority. Exception-ledger reconciliation occurs once after content changes settle. |
| Semantic foundation | `tokens.json`, generated CSS, `index.css`, theme files, package/lock | Begins only after Luma. It extends the accepted baseline rather than resolving simultaneous token edits. |
| Successor contracts | Button/Card/Sidebar consumers, stories, authority/registry | Begin after the primitive milestone so screenshot geometry and interaction tests target final Luma primitives. |
| Home/Explore and navigation | Route composition and fixture screenshots | May perform read-only design work, but source integration waits for successor contracts and Luma. |

One Luma integration owner must exclusively control all 26 primitive files,
`components.json`, `src/index.css`, token/font changes, package metadata, lock
file, and exception reconciliation for the duration of the merge.

## Go/no-go checklist for the eventual merge

Before production mutation:

1. the exact frozen preset remains `b1VlIwYS`;
2. Geist remains the accepted shell font;
3. structural integrity is green and `sidebar.tsx` ownership is released;
4. each of the 26 differing primitives has an assigned disposition and test;
5. the Luma owner captures fresh CLI `--dry-run` and per-file `--diff` output;
6. DTCG/global-CSS preservation is part of the merge review;
7. no blanket `apply`, `--overwrite`, or scratch-file copy is used.

After mutation, require typecheck, token/style/content gates, Storybook,
both-theme axe, targeted primitive interactions, shell route tests, deterministic
mobile/desktop screenshots, and a clean bundle check before the Luma milestone
can merge.
