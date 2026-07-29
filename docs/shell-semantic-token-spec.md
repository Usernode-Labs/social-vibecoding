# Shell semantic token specification — next wave

Status: proposal only. This document specifies a minimal extension to the
React shell's DTCG authority; it does not authorize a token, component, theme,
or route implementation.

## Why this is the next addition

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
   emerald wallet-link check. An “attention” state has no named role.
3. The theme adapter resolves light/dark correctly, but its persisted contract
   is only `light | dark`; system following is an implicit absence of a stored
   preference rather than a selectable, testable preference.

This specification changes none of the platform contracts, does not reach
child apps, and does not replace the official shadcn primitives. It gives
those primitives and the owned shell patterns semantic color inputs.

## Scope and non-goals

In scope:

- finite dApp identity artwork for the React shell only;
- semantic status and attention roles in both light and dark modes;
- a compatible Light / Dark / System preference model;
- mechanical contrast and deterministic-mapping evidence.

Out of scope: child-app source and themes, the hosted `usernode-native/v1`
contract, changing server app records, broad visual restyling, and legacy
route retirement.

## Exact proposed DTCG additions

Add these color tokens under both `semantic.light` and `semantic.dark` in
`frontend/design-system/tokens.json`. They are all `$type: "color"` and use
OKLCH values. The token build must continue to reject a mode-name mismatch.

### 1. Finite app identity palette

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
when a concrete consumer needs them:

```
--color-app-identity-surface: var(--app-identity-surface)
--color-app-identity-foreground: var(--app-identity-foreground)
--color-app-identity-border: var(--app-identity-border)
```

No generic `text-identity-*` or `bg-identity-*` public utility should be
introduced. The finite palette remains owned by `AppIdentity` until a second,
different shell pattern proves a reusable need.

### 2. Status roles

Add four roles, each with a surface, foreground, and border. “Positive” is
success, not a generic brand green; “negative” is the status counterpart to
the existing destructive action color, not a replacement for it.

```
semantic.{light|dark}.status-positive-surface
semantic.{light|dark}.status-positive-foreground
semantic.{light|dark}.status-positive-border
semantic.{light|dark}.status-info-surface
semantic.{light|dark}.status-info-foreground
semantic.{light|dark}.status-info-border
semantic.{light|dark}.status-warning-surface
semantic.{light|dark}.status-warning-foreground
semantic.{light|dark}.status-warning-border
semantic.{light|dark}.status-negative-surface
semantic.{light|dark}.status-negative-foreground
semantic.{light|dark}.status-negative-border
```

Runtime/Tailwind aliases use the same names (`--status-positive-surface`,
`--color-status-positive-surface`, and so on). Do not alias `destructive` to
`status-negative-*`: destructive is an action treatment; status-negative is a
readable state treatment. The eventual `StatusBadge` or `StatusNotice` owns
the choice of role; status strings from APIs must not select raw colors.

### 3. Attention

Attention is intentionally separate from warning. It represents something the
user should notice (unread, needs review, new work) without implying a fault.

```
semantic.{light|dark}.attention-surface
semantic.{light|dark}.attention-foreground
semantic.{light|dark}.attention-border
```

Aliases are `--attention-{surface|foreground|border}` and their
`--color-*` Tailwind counterparts. The first consumers should be notification
unread state and a review-needed marker, not arbitrary highlighted cards.

## Deterministic immutable dApp identity mapping

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

## Theme compatibility contract

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
  group. “System” names the preference and shows the resolved mode in its
  description, not as a second selected state.

The CSS contract stays `.dark` for dark variables and `:root` for light. This
avoids changing shadcn's current dark selector or the native WebView’s first
paint behavior.

## Contrast and state evidence matrix

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

## Migration inventory and order

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

## Explicit deferrals

- **Charts:** existing `chart-1`…`chart-5` remain grayscale compatibility
  tokens. A data-visualization scale needs a separate semantics and legend
  review.
- **Display font:** Geist remains the sole shell typeface. No display-font
  token or typography hierarchy is part of this color/identity wave.
- **Motion:** no durations, easing, status animations, or attention pulses are
  added. Reduced-motion behavior stays governed by existing primitives until a
  separate motion contract has evidence.
