# Coding-agent project guidance

## Shared task workflows

Task procedures are portable Agent Skills, canonical in `.agents/skills/`.
OpenCode discovers `.agents/skills/` directly; `.claude/skills/` and
`.opencode/plugins/` link into that tree and `.agents/hooks/` — never
duplicate trees to "fix" the wiring.

- `usernode-api` — inspect or change Usernode app/platform state.
- `usernode-proposal` — stage, check, promote a locally authored native proposal.
- `react-shell-migration` — convert a legacy-owned shell region to React.
- `mobile-push-testing` — verify push delivery through a real phone.

`CLAUDE.md` imports this file; skill bodies lazy-load per task.

**The rules below are written "X except where Y", and the exception is part of the rule.** Three
sweeps have applied the X and dropped the Y. Applying a rule to its named exempt case is a
regression, not a completion.

## Know your base commit before you write code — the checkout will not tell you

- This checkout can be a fork far behind the platform repo, and nothing says
  so. The fork's default branch is the likeliest stale base.
- Establish the base before the first edit — from the work order (`prepare_work`), the hand-off's
  `Base commit:` line, or by asking — then `git rev-parse HEAD` and compare all forty characters.
- On disagreement stop and ask; do not merge `upstream/main` yourself — the base decides what the
  group votes on. A wrong base is caught only at `submit_work` (`mirrorForkBranch` →
  `base_mismatch`), when the remedy is a rebase.

## `public/index.html` is GENERATED — edit `frontend/`, never commit outputs

- Sources: `frontend/src/Shell.tsx` (the whole `<body>`, a static tree of islands),
  `frontend/src/head.html` (the `<head>`), `frontend/@/components/ui/` (primitives).
- `public/index.html` and `public/shell/assets/shell.js` are gitignored and rebuilt by every
  Docker image — never edit or commit them. Locally: `npm run ensure:shell`;
  `npm test`/`start`/`dev` materialize what they need (`tests/shell-build.test.js`).
- Low-level: `build:shell` FIRST, then `build:css` — `index.html` is both Tailwind content
  source and shell-build output.
- `Shell.tsx` is hand-maintained; resolve merge conflicts in it directly — re-deriving from main
  throws the conversion away.
- Converted markup is like-for-like (ids, class strings, `hidden`, `data-*`) because
  `public/js/**` finds nodes by `getElementById` and `dapp.json`'s checks select on them.
  Enforced against `tests/baselines/shell-markup.json` by `tests/shell-id-inventory.test.js`,
  `tests/dapp-selectors-resolve.test.js` and `tests/shell-script-order.test.js` (script order,
  `app.js` last). NEVER refresh the baseline to go green: record deliberate changes in the
  `RETIRED_*`/`ADDED_*` maps with a reason.
- A region becomes stateful only when its ENTIRE subtree is React-owned — the failure prevented
  is React reconciling over DOM a legacy module also mutates. Corollaries: an island's initial
  render emits exactly the shipped empty/hidden markup (data loads in effects; a
  hydration-mismatch `console.error` fails proposal checks); screen visibility goes
  through `frontend/src/lib/visibility-store.ts`, never a `.hidden` toggle
  (`tests/visibility-store.test.js`).
- Drive a dialog only through `useDialog`, which publishes `window.UsernodeReact.dialogs.<name>`
  to legacy callers (`tests/dialog-behaviour.test.js`). Not relaxed: the root's `className`
  renders once as a constant (the kit writes `platform-modal-adopted` there); `innerHTML`
  regions stay the legacy module's host; kit-mutated classes take `useHiddenClass`/
  `useClassToggle` (`frontend/src/lib/legacy-dom.ts`).
- Adding or removing a `public/js/**` script also means `SHELL_ASSETS` in `public/sw.js` and the
  count in `tests/shell-script-order.test.js`.

## One language, two surfaces — keep the boundary

One vocabulary, two tunings, split by SURFACE density — a 44px tap target is right on `#home`,
wrong in a dense admin table — and the boundary does not dissolve as sections convert.

- Shell: `frontend/@/components/ui/**` — hand-rolled shadcn primitives, `cssVariables: false`,
  on the platform's own ramps. Count the directory; lists here go stale. Variants are `cva`
  tables of complete literal classes — the extractor is a regex, so a computed class name never
  compiles (`tests/shell-primitive-adoption.test.js`, `tests/tailwind-build.test.js`).
- Admin: the frozen `AdminUI` recipe registry in `frontend/src/features/admin/admin-console.js`,
  also on `window.AdminUI` — section modules read it as a bare identifier.
- `tests/admin-ui-registry.test.js` enforces the boundary both ways (no admin import of
  `@/components/ui/`; no `AdminUI` outside `features/admin/`), bans `gray-*`/`indigo-*`
  product-wide, and forbids hand-writing a class string a recipe of five or more utilities covers.

The scale keys in `tailwind.config.js` are IDENTITIES, not hues — **read the hex, not the key**:
a stray `bg-gray-100` renders an untuned stock hue no diff reviewer spots. This warning once
read "`violet-*` is the BLUE accent" — the key moved twice; the stale reading is the trap:
**`violet-*` is the YELLOW ramp** (`violet-600` `#FFC93A` CTA fill, `violet-300` `#FFEE6F` brand
yellow); blue is `azure` (`azure-500` `#3090E1` brand, `azure-700` `#1D81CD` working ink);
`zinc` is a warm neutral, `meadow` the green, `red`/`amber` retuned warm. `text-violet-600` as a
link is pale yellow. Count overridden keys in the config; each defines all eleven steps — a
partial override quietly renders stock Tailwind.

### The console is React — add a section the same way

`admin-console.js` is a chassis; `admin-topochain.js` routes the programme screens under
`features/admin/topochain/`. Neither builds markup. A new section follows the portal seam, never
a new `innerHTML` one: `render(el)` calls `mountLegacyPortal(el, <Section/>)`; `destroy()`
unmounts and nulls the host — the state reset.

- The host is single-owner: every path into `#admin-section-content` runs
  `_teardownActiveSection()` first; topochain nests this in `#admin-topo-content`, tearing
  the portal down BEFORE the discarding `innerHTML`.
- Build from the surface: `AdminUI` recipes for sections;
  `topochain/ui.tsx` + `tokens.ts` + `api.ts` for programme screens.
- Ids are like-for-like on a conversion (`tests/dapp-selectors-resolve.test.js`). React escapes
  text, but the rule `esc()` could not express survives: an admin- or API-supplied URL is NEVER
  rendered as a clickable anchor.
- Scope the host in `scripts/audit-react-ownership.mjs` (advisory; `OWNED` + `ROUTES`); the
  `when` clause is load-bearing because the host is shared.
- React's defaults lose two behaviours: a search box driving a paged server
  query commits on blur or Enter (uncontrolled, `defaultValue`), and a
  cross-screen jump needs an explicit export — a bare global read broke
  silently.

## Contrast is APCA (Lc), not WCAG — and the target is PARITY, not a floor

- WCAG 2.x ratios are no longer tracked; older comments and tests still quote them,
  recording what was believed then.
- Lc is SIGNED — positive dark-on-light, negative light-on-dark — compare magnitudes. Ladder
  (|Lc|): 90 small/thin-label floor · 75 body minimum · 60 larger-or-bolder · 45 large headline
  · 30 non-content/disabled · 15 barely visible. Reference implementation: the APCA-W3 port
  pinned in `tests/theme-ink-guards.test.js`.
- A dark ink is right when its |Lc| MATCHES its light counterpart's — parity, not a floor. The
  `red`/`amber` ramps are solved to it: 700 on white pairs 200 on the dark card — on a dark
  ground a pale tint IS the readable ink.
- Blessed deviation (to end re-litigation): the warn ink is `text-amber-800`
  (dark `dark:text-amber-200`), heavier than the parity-solved 700.
- The `--state-*` tokens in `app.css` have `.dark` counterparts; no class-name test sees a raw
  hex — regressions there need a live look.
- APCA is a TEXT metric — never judge two adjacent SURFACES with it; surface separation is
  elevation and shape, not ink contrast.
- `tests/theme-ink-guards.test.js` asserts spellings, not rendered results — a live sweep is
  the thorough half. Its budgets are RATCHETS — twice left with silent headroom: lower the
  budget in the fixing commit and name the sweep.

## Four colour roles — yellow acts, blue speaks, black selects, grey is the rest

- Yellow is scarce: exactly ONE filled action per screen; `bg-violet-600` /
  `hover:bg-violet-500` are the only yellow surfaces (why: the config's palette comment). Of two
  controls opening the same thing, the persistent one keeps the yellow; the duplicate goes
  near-black.
- Yellow INVERTS the ink convention: an accent fill takes near-black, never white. The flip
  lives in two places — `button.tsx`'s `ink` table (`solid*` are `text-black`) and
  `--accent-ink` in `public/css/app.css` (`#000000` in BOTH themes, on purpose).
- Blue carries every non-action accent — links, text buttons, own bubble, unread counts,
  identity, badges; ink AND wash. The step is SETTLED (an older "known open item" note is
  stale): link ink is `text-azure-800 dark:text-azure-200`; chips, washes and
  solid fills stay `azure-700`. A link is not a chip; don't average the two.
- Black selects (`bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900`) in a set — EXCEPT
  in a track, where selection is a raised white pill on a recessed `zinc-200` track
  (`SECTION_TAB_ACTIVE`, `frontend/@/components/ui/tabs.tsx`; dark keeps the bright pill — no
  quieter direction). A chip floats on a card, a tab sits in a track: don't unify the spellings.
- A focus ring is neither: `focus:ring-zinc-900 dark:focus:ring-zinc-100` — black marks the
  current thing.
- Grey is everything else; tinting a non-signal (segments, secondary actions, badges, panels)
  spends the accent until it signals nothing.

## Type and radius are named ladders — and one ladder is not ours

- `fontSize` is seven steps in TUPLE form, binding leading to size — one decision, not a
  `leading-*` the next site forgets. Five steps restate stock Tailwind; the config comment
  records the two that shift.
- The named ladder has NO step below 12px: below it APCA has no readability row, so the fix for
  a tiny chip is type, not hue. `tests/dev-chip-geometry.test.js` pins `.dev-badge` at
  12–12.5px. Sub-12px arbitrary utilities compile on purpose; raising them is a call-site pass.
- 13/15/17/22/34px get NO name: that is the iOS system ramp, the frozen ladder
  `public/usernode-native/v1/` publishes, and the native-mimicking components (`feed`, `chat`,
  `chip`, `grouped-list`, `icon-tile`) sit on it on purpose — naming it invites the two ladders
  to drift into one.
- Radius is 4 · 8 · 12 · 20 · full: 4 a text-line mark, 12 a control, 20 a container, 8 the
  concentric INNER of a 12px control (inner = outer − padding). Remap the SCALE, never the call
  sites — the churn hides the real change.

## Layout: keylines, separation, arcs, and 44px

- Three keyline tiers (`tests/screen-keyline.test.js`; a screen unlisted in its manifest is
  unguarded). CONTENT-12 = `--screen-gutter` (0.75rem, `app.css`), aliased as `spacing.gutter`
  (`px-gutter`); CHROME-16 = platform header, auth, reading columns, native-kit surfaces;
  ADMIN = `p-4 lg:px-6`, and `px-gutter` never crosses into `features/admin/`. Trap: the
  screen-level scroller spells the gutter ONCE — interior padding is not the keyline.
- Containers own separation: parents space children with `gap`; a margin passed into a
  component's `className` is the caller reaching into the callee. `m*-auto`, negative margins,
  markdown rhythm and a gutter on a lone child are PART of the rule. Conversion trap: `flex`
  disables margin collapse, so a child keeping its margin DOUBLES the gap, invisibly.
  Guard: `tests/layout-separation-guards.test.js`.
- Content in a rounded container clears the corner arc (`pt-5` on a 1.25rem top radius); no
  guard yet — review item.
- `min-h-[44px]` vs `h-11` is SEMANTIC: `h-11` is a square box, `min-h-[44px]` a grow-with-text
  floor. A 44px sweep matches every spelling plus raw `height: 44px` in `app.css` —
  `tests/vertical-ladder.test.js` is the census; its budgets are EQUALITIES, re-pinned with the
  change.

## Dark mode is the same design re-tuned — not a second palette

- No shadows on a dark ground: every `shadow-*` carries `dark:shadow-none`, every `box-shadow`
  in `app.css` a dark counterpart. Two argued exemptions: a surface dark in BOTH themes
  (`#dc-tip`) is outside the rule; a panel whose only edge IS the shadow needs a border first
  (`AdminUI.dialogPanel` gains a dark inset ring).
- `color-scheme` is declared per theme in `app.css` — scrollbars, popups and pickers are chrome
  no CSS colour reaches.
- A large coloured panel loses its ground in dark (a border carries the semantic); a badge KEEPS
  its ground — sweeping the rule into badges is over-applying it.
- Do not flatten the heading LEVELS: "one heading colour in dark" means no grey-plus-brand mix,
  not collapsing the three-level ink ladder — light secondary 500/600/700 pairs `dark-300`.
- Every `:root` colour variable needs a `.dark` counterpart, or it renders its LIGHT value in
  dark; `tests/theme-ink-guards.test.js` pins the sets equal against a named exemption list —
  argue a new exemption, never just omit it.

## The icon set is lucide, transcribed — one family, two weights

- `frontend/@/components/ui/icons.tsx` is the only place a glyph lives: lucide v1.35.0 (ISC),
  transcribed verbatim, not imported (the `<Glyph>` tables interpolate shapes into markup).
  Every export carries a `// lucide/<slug>` provenance comment — fix a wrong glyph against
  lucide's file, never by redrawing. `tests/shell-icon-set.test.js` enforces all of this.
- Two weights: shell is stroke 2; admin is 1.5 — the density boundary, not a second set. Admin
  glyphs are transcribed on the admin side (`tests/admin-ui-registry.test.js` forbids importing
  the shell's).
- A call site overrides `strokeWidth` only to hold the rendered stroke (strokeWidth × size ÷ 24)
  near 1.5px: w-4+ → 2, w-3.5 → 2.5, w-3 → 3. Sites INHERITING stroke 2 are deliberately left
  alone — applying the table to them is a regression.

## Shell CSS is generated by the image build — do not commit it

- `tailwind.config.js` + `styles/tailwind-input.css` compile to `public/css/tailwind.css` via
  `npm run build:css`. The output is gitignored — never commit it.
- Tailwind stays pinned at v3.4.17: v4 changes utility semantics and would silently restyle the
  whole shell, and v4-era guidance hands you utilities that compile to NOTHING (`inset-ring` →
  spell `ring-1 ring-inset`) — the no-op fails silently. `tests/tailwind-build.test.js` pins the
  compile, palette semantics and the Docker contract.
- The shell loads NO cross-origin assets: families are vendored under `public/vendor/` via
  `npm run vendor:assets` (provenance in the README there). No CDN `<script>`/`<link>` in
  `frontend/src/head.html` — vendor or compile it; tests enforce this.
- Stylesheet order is `native.css` → `app.css` → `tailwind.css`, compiled utilities LAST:
  `app.css` assumes Tailwind wins equal-specificity conflicts; inverting it once silently
  restyled a whole screen (#938). The head probes the order at runtime and `console.error`s —
  which fails proposal checks.

## The native kit is a published /v1/ contract — re-theme it by variable

- Never edit `public/usernode-native/v1/native.css` or `native.js` for looks: every app on the
  platform loads them from central hosting — an edit restyles apps nobody here has seen.
  The variable list is frozen `/v1/` surface: additions fine, renames/removals need a `/v2/`.
- Re-theme by overriding `--un-*` custom properties from `public/css/app.css`. `--un-accent`
  still DEFAULTS to `#7c3aed` — the platform violet from two palettes ago — so a kit control
  looking like an older theme means a missing bridge line, not a kit edit. Read app.css for what
  is bridged — counts here drifted before.
- Physics, thresholds and gesture geometry are deliberately NOT themeable — native feel stays
  uniform across differently-branded apps, which is why the kit is hosted rather than copied.
  `tests/native-kit.test.js` exercises that half headlessly.
