# The frame's nine looks — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native, as the
> foundation plan ran). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every look the 2026-11-06 screen tour kept beside C Glass — D Brand kit, F Workbench,
H Paper, I Pastel, J Mosaic, K Sunrise, L Today, S Playground — is selectable on a device and
draws Home in the one frame, at the depth glass has today.

**Architecture:** One mechanism, nine values. `window.Skin` stores the look and sets `data-skin`
on `<html>`; app.css draws a look from that attribute: a token block (`--fr-*`, light and dark),
its typeface from our own origin, and a few rules on the frame's own hooks (`.fr-title`,
`.fr-card`, `.fr-row` …) for what a token cannot say (Mosaic's tile grid, Pastel's rotating
tints, Paper's sheet). The primitives carry the kit's neutral geometry; a look only overrides.
Home's frame body (`HomeFrame`, was `HomeGlass`) mounts for any frame look.

**Tech stack:** React island + Tailwind 3.4.17 literals, app.css, vendored OFL fonts.

**Spec:** `docs/superpowers/specs/2026-11-08-one-frame-glass-spec.md` (the eight rules of the
frame are the same for every look; the looks' own values come from the tour's theme files,
copied into "Looks" below).

## Global constraints

- A look is `html[data-skin="<id>"]`; every rule of a look starts from it. Ids: `glass`,
  `brandkit`, `workbench`, `paper`, `pastel`, `mosaic`, `sunrise`, `today`, `playground`.
  `brand` (New look, "Baseplate") is not a frame look and is not touched.
- Light and dark for every look; a look's dark block redeclares every `--fr-*` token its light
  block declares (a light value otherwise outranks the dark default).
- Fonts from `public/fonts/<family>/` with LICENSE.txt + README.md (npm package, version, source
  path, sha384, size), absolute `/fonts/…` URLs, latin + latin-ext subsets.
- `--accent-tint` is a literal rgba at or under 0.2 alpha in every block (dev-chat-ground).
- The looks' section sits between "SKIN TOKEN DEFAULTS" and the brand block, which stays last.
- Catalog text in `frontend/locales/en/*.json`; complete Tailwind literals; logical spacing.
- Glass must render as it did before this plan (pixel-compared on Home, four variants).
- The picker is an admin's preview (the gate already on the branch); `?skin=<id>` stays open.

## Review focus

1. Dark mode under each look: a token set in light but not in dark shows the light value.
2. A phone (under 768px): each look's phone sizes, Mosaic one column, Workbench two-line rows.
3. A browser without `backdrop-filter` under the three translucent looks (glass, workbench, mosaic).
4. A stored look that is no longer in the list (or `brand`) with the picker open.
5. Home with nothing in it (no feed, no pins) under Paper, whose sheet would be an empty slab.

## Looks (values copied from the tour's theme files)

| id | Typeface | Title (desk/phone, weight) | Group | Signature |
|---|---|---|---|---|
| brandkit | Geist; Source Serif 4 titles and buttons; Geist Mono labels | 44/31, 460, serif | 14px, hairline | cream page (#fffeea / #000), yellow main button with a thin black edge |
| workbench | IBM Plex Sans; IBM Plex Mono labels | 22/20, 650 | 10px, frosted, hairline | one-line 42px rows from 768px, wider column, square controls |
| paper | Instrument Sans | 34/26, 700 | 16px grey panel, no outline | the page is one white sheet on the wallpaper |
| pastel | DM Sans | 42/30, 700 | 26px, lavender / pink / peach in turn | white-glass leads on the tints |
| mosaic | Urbanist | 40/30, 800 | 22px glass | rows are tiles, two across from 768px |
| sunrise | Plus Jakarta Sans | 36/28, 800 | 20px white, soft shadow | gradient main button |
| today | Figtree | 44/34, 800 | 24px white, soft shadow | 22px group names, 72px rows, 48px pictures |
| playground | Nunito | 38/30, 900 | 20px, 3px bottom edge | heavy type, 2px dividers, block buttons |

## Tasks

### Task 1: the registry — nine frame looks in the head, the hook and Home

**Files:** `frontend/src/head.html`, `frontend/src/lib/skin.ts`, `frontend/src/features/home/index.tsx`,
`tests/glass-skin.test.js`, `tests/home-frame.test.js` (was home-glass).

**Interfaces — produces:** `FRAME_SKINS: readonly Skin[]` (the nine), `isFrameSkin(skin: Skin): boolean`
from `lib/skin.ts`; head `SKINS = ['brand', …FRAME_SKINS]`.

- [ ] Tests: each of the nine is stored, applied and pinned by `?skin=`; `isFrameSkin` is true for
      the nine, false for `standard` and `brand`; head list === `['brand', ...FRAME_SKINS]`;
      HomeScreen branches on `isFrameSkin(skin) && viewer`.
- [ ] Run → fail. Implement. Run → pass. Commit.

### Task 2: the frame's hooks and neutral base; HomeGlass becomes HomeFrame

**Files:** `frontend/@/components/ui/frame.tsx`, `status.tsx`, `frontend/src/features/home/frame/home-frame.tsx`
(moved from `glass/home-glass.tsx`), `frontend/locales/en/home.json` (`glass.*` → `frame.*`),
`public/css/app.css` (glass geometry as rules), `tests/frame-primitives.test.js`, `tests/home-frame.test.js`.

**Interfaces — produces:** hook classes `fr-page fr-title fr-purpose fr-cols fr-main fr-side fr-group
fr-label fr-card fr-row fr-row-sm fr-row-tx fr-row-t fr-row-s fr-lead fr-lead-pic fr-btn fr-btn-quiet
fr-pill fr-fact`. Base geometry: title 24/28 700, label 12 bold caps, card 20px, rows 64/50, lead 40.

- [ ] Capture glass Home (4 variants) as the before.
- [ ] Tests: each primitive renders its hook; base classes read tokens only; glass block carries
      the rules that restore its geometry (title 36/28, label 13/650 sentence case, card 24).
- [ ] Run → fail. Implement. Run → pass. Capture again; compare with the before. Commit.

### Task 3: the typefaces

**Files:** `public/fonts/{source-serif-4,ibm-plex-sans,ibm-plex-mono,instrument-sans,dm-sans,urbanist,plus-jakarta-sans,figtree,nunito}/`.

- [ ] Test (`tests/frame-looks.test.js`): each family's files exist over 10 KB with an OFL
      LICENSE.txt and a README carrying sha384. Run → fail.
- [ ] `npm pack` each package at 5.3.0 into the scratchpad, copy latin + latin-ext woff2 and the
      licence, write the README from computed hashes. Run → pass. Commit.

### Task 4: the eight looks in app.css

**Files:** `public/css/app.css`, `tests/frame-looks.test.js`, `tests/glass-skin.test.js` (its
stylesheet tests move to the table), `tests/new-look.test.js` (the Geist guard reads past the
looks' section: Brand kit names Geist by design).

- [ ] Table-driven tests over the nine: block present and scoped; `.dark` block with token
      parity; root `font-family` names the family then `system-ui`; `@font-face` URLs absolute and
      on disk; `--accent-tint` literal in both modes; translucent looks carry the `@supports not`
      fallback; only brandkit moves the ground; section order defaults < looks < brand; signature
      rules (mosaic grid, pastel tints, paper sheet, workbench one-line rows, playground edge,
      today 22px labels, sunrise gradient button, brandkit serif title). Run → fail.
- [ ] Write the shared rule (platform tokens retargeted from `--fr-*`, row inks, separators) and
      the eight blocks. Run → pass, with `dev-chat-ground`, `new-look`, `tailwind-build`. Commit.

### Task 5: the picker

**Files:** `frontend/src/features/settings/sections/experimental.tsx`, `settings.js`,
`frontend/locales/en/settings.json`, `tests/glass-skin.test.js`, `tests/shell-id-inventory.test.js`.

- [ ] Tests: `#settings-look-section` ships hidden and holds `<Select id="settings-look">` with
      Standard and the nine in tour order; settings.js sets the look through `window.Skin`, paints
      the stored one, and keeps New look exclusive; `_renderAdminSection` lifts the section for a
      real admin; catalog entries. Run → fail. Implement. Run → pass. Commit.

### Task 6: look at them

- [ ] Capture Home under standard and the nine × desktop/phone × light/dark on the production
      copy; read every image; fix what is wrong with a test first; record findings below.

### Task 7: review

- [ ] `test:changed --files` over the branch; one fresh reviewer on the whole diff since
      `258689653`; one fix pass; notes.

## Notes
