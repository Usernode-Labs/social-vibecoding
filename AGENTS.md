# Coding-agent project guidance

## Shared task workflows

This repository keeps conditional procedures as portable Agent Skills instead
of loading them for every task. The canonical copies live in
`.agents/skills/`; `.claude/skills/` links to that directory for Claude
Code discovery. OpenCode discovers `.agents/skills/` directly, so it does not
need a duplicate skill tree; its project plugin entry point under
`.opencode/plugins/` links back to the canonical adapter in `.agents/hooks/`.
Use the matching skill whenever its description fits:

- `usernode-api` — inspect or change Usernode app/platform state.
- `usernode-proposal` — run a locally authored native proposal through
  staging, checks, and optional promotion.
- `react-shell-migration` — convert a legacy-owned shell region to React.
- `mobile-push-testing` — verify push delivery through a real phone.

`CLAUDE.md` imports this file for the always-on repository rules below.
Claude Code, Codex, and OpenCode load the full workflow bodies only when a task
selects a skill.

## Know your base commit before you write code — the checkout will not tell you

- **This checkout can be a fork whose `main` is far behind the platform
  repository, and nothing in it says so.** A session dispatched onto a
  ready-made branch inherits whatever commit that branch was cut from. Once
  that was ~190 merged pull requests behind the commit the request itself
  described: the files it named had moved, `src/services/mcp-charter.js` did
  not exist yet, and the drift surfaced only because the request happened to
  quote a SHA. **Do not assume the branch you were handed is based
  correctly**, and do not reach for the fork's default branch as the base —
  that is the thing most likely to be stale.
- **Establish the base commit before the first edit, then verify it.** It
  comes from the work order (`prepare_work`), from the guided hand-off's
  `Base commit:` line, or — with neither to hand — from asking. Then run
  `git rev-parse HEAD` and compare all forty characters. This is the check
  step 2 of the `usernode-proposal` skill already makes, hoisted here on
  purpose: a skill body loads only when a task selects that skill, so a
  session that arrives on a branch somebody else cut never reads it.
- **If they disagree, stop and ask — do not merge `upstream/main` yourself.**
  Which commit a proposal is diffed against decides what the group is voting
  on, so changing it is not the agent's call. A wrong base IS caught, but only
  at `submit_work` (`mirrorForkBranch` → `base_mismatch`) — after the change
  is written, when the remedy has become a rebase across everything that moved
  underneath it.

## `public/index.html` is a GENERATED artifact — edit `frontend/`, never commit outputs

- The shell's markup is React now. **Do not edit `public/index.html`** — it is
  built from `frontend/` and any hand edit is overwritten by the next build.
  The sources are:
  - `frontend/src/Shell.tsx` — the whole `<body>`: a static tree that composes
    the converted screens' island components (see the statefulness rule
    below). It holds no state itself.
  - `frontend/src/head.html` — the `<head>`, carried over verbatim.
  - `frontend/@/components/ui/` — shadcn primitives, restyled to the
    platform's existing `zinc`/`violet` palette (`cssVariables: false`).
- **Never add or commit `public/index.html` or
  `public/shell/assets/shell.js`.** Both are gitignored and rebuilt from the
  lockfile-pinned frontend sources by every Docker image. For local browser
  work run `npm run ensure:shell` (or `npm run build:shell` after installing
  `frontend/`); `npm test`, `npm start`, and `npm run dev` ensure the ignored
  outputs they need automatically. `tests/shell-build.test.js` pins that
  lifecycle instead of comparing a committed fixture.
- `npm run ensure:shell` generates the shell and then its CSS in the required
  order. If invoking the low-level commands directly, **run `build:shell`
  FIRST, then `build:css`.**
  `public/index.html` is a Tailwind content source *and* a shell-build output,
  so compiling the stylesheet first scans the previous document. The Docker
  image build enforces the same ordering: its shell builder prerenders the
  current `index.html`, then the CSS builder scans that generated document.
  There is no loop — `tailwind.css` is not a shell input.
- **`Shell.tsx` is now hand-maintained; resolve conflicts in it directly.** The
  one-time generators that derived it from the hand-written document
  (`html-to-jsx.cjs`, `apply-step1-edits.cjs`) and the pre-migration fixture
  they read are gone — step 2 changes the markup on purpose, so re-deriving it
  from main would throw the conversion away. Merge `Shell.tsx` like any other
  source file.
- Two constraints in `frontend/src/Shell.tsx` are load-bearing, and its header
  comment explains each: it **renders the legacy `<script>` tags** in their
  original order (`app.js` must stay last), and **converted markup is
  like-for-like** — same ids, class strings, `hidden` semantics and `data-*`
  attributes as the hand-written shell, because `public/js/**` looks those up
  by `getElementById` and `dapp.json`'s 338 declared tests select on deep
  chains of them. The structural baseline is
  `tests/baselines/shell-markup.json` (ids, `data-*` names, script order,
  stylesheet order), enforced by `tests/shell-id-inventory.test.js`,
  `tests/dapp-selectors-resolve.test.js` and
  `tests/shell-script-order.test.js`. **Never refresh the baseline to go
  green** — record each deliberate change in that chunk's commit in the
  `RETIRED_IDS`/`ADDED_IDS` and `RETIRED_SCRIPTS`/`ADDED_SCRIPTS` maps, with a
  reason. `scripts/derive-shell-baseline.js` exists for a reviewed wholesale
  refresh only.
- **A region may become stateful only when its entire subtree is React-owned**
  — no `public/js/**` module may write into any node inside it. The shell is a
  static tree containing stateful islands; React reconciling over DOM that a
  legacy module also mutates is the failure this rule prevents. Two corollaries:
  an island's *initial* render must emit exactly the empty/hidden markup the
  hand-written shell shipped (data loads in effects, never in initial render —
  otherwise hydration mismatches `console.error`, which fails proposal checks),
  and screen visibility must be published through
  `frontend/src/lib/visibility-store.ts` rather than by toggling `.hidden` from
  outside React.
- **The nine dialogs present themselves through
  `frontend/src/lib/static-modal.ts` — nothing outside React lifts their
  cards.** That seam used to be `PlatformUI.adoptStaticModal`, which watched
  each root in `STATIC_MODAL_IDS` and, when `hidden` came off, lifted the card
  element out of the root — leaving a comment placeholder — into the native
  kit's `presentModal` shell. Two owners wrote to those nodes, so the dialogs
  had to stay markup-only. #1078 chunk I moved the lift inside React
  (`useStaticModal`, driven by `features/dialogs/use-dialog.ts`) and retired the
  `public/js/**` copy, which is what made all nine stateful. **Drive a dialog
  only through `useDialog`** — it owns `hidden`, the kit hand-off, the
  backdrop-dismiss rule and the ghost-click guard, and it publishes the
  controller on `window.UsernodeReact.dialogs.<name>` for the legacy callers.
  Two things it does not relax: the root's `className` is still rendered once,
  as a constant, because the kit writes `platform-modal-adopted` to that node;
  and anything a controller module fills by `innerHTML` (the members roster,
  the secrets rows, the feedback status line) stays that module's host. The
  same applies to any element the kit or `app.css` writes classes to at runtime
  — use the `useHiddenClass` / `useClassToggle` refs in
  `frontend/src/lib/legacy-dom.ts`, never a rendered `className`.
- Adding or removing a `public/js/**` script means updating `SHELL_ASSETS` in
  `public/sw.js` and the count in `tests/shell-script-order.test.js` too.

## Two design systems, one bundle — keep the boundary

This repo ships **two** class vocabularies, and they are not a migration in
progress. Neither is waiting to absorb the other.

- **The platform shell** — `frontend/@/components/ui/**`. shadcn primitives,
  hand-rolled, `cssVariables: false`, styled in the platform's `zinc`/`violet`
  palette. Twelve modules today: `alert`, `anchored-panel`, `button`, `dialog`,
  `field`, `icons`, `input`, `label`, `select`, `switch`, `tabs`, `textarea`.
  Variants are `cva` tables; every class in them is a complete literal, because
  Tailwind's extractor is a regex over source text and a computed class name is
  a class name that never gets compiled.
- **The admin console** — the `AdminUI` registry in
  `frontend/src/features/admin/admin-console.js`. A frozen object of class
  *recipes* (`AdminUI.card`, `AdminUI.btn.primary`, `AdminUI.cardTitle`, …)
  interpolated into template-literal `innerHTML`, in the topochain admin
  vocabulary: `gray`/`indigo`, not `zinc`/`violet`. It is published on
  `window.AdminUI` as well as exported, because the section modules
  (`admin-analytics.js`, `admin-mail.js`, `admin-topochain.js`, …) read it as a
  bare identifier at call time.

**Do not cross them.** An admin section that reaches for `@/components/ui/*`
gets a `zinc`/`violet` control sitting in a `gray`/`indigo` page; a shell
component that reaches for `AdminUI` inverts the same mistake and drags an
`innerHTML`-oriented registry into a reconciled tree. Both directions are
enforced — `tests/admin-ui-registry.test.js` asserts that no admin source
imports from `@/components/ui/`, that nothing outside `features/admin/`
mentions `AdminUI` in code (prose in comments is fine), and that neither
palette appears in the other system's files. It also holds the console to its
own registry: a section module may not hand-write a class string a recipe of
five or more utilities already covers — interpolate the key, or the copy stops
tracking the recipe the first time it changes.

The admin console is **not** step-3 work, and converting it is not a
like-for-like exercise: it is a second product surface with its own palette,
its own idiom and its own tests. Leave it alone unless an issue asks for it by
name.

## Shell CSS is generated by the image build — do not commit it

- The platform shell's Tailwind is **compiled**, not loaded from a CDN:
  `tailwind.config.js` + `styles/tailwind-input.css` build to
  `public/css/tailwind.css` via `npm run build:css`. The Dockerfile runs that
  command in a disposable builder stage on every production/staging image and
  copies only the result into the production-only runtime stage.
- `public/css/tailwind.css` is gitignored and excluded from the Docker build
  context. **Never add or commit it.** For local browser work, run
  `npm run build:css` (or `npm run watch:css`); the ignored output is only a
  convenience for that checkout.
- The compiler scans `public/index.html`, `public/js/**`, the usernode-native
  demo, and `frontend/**`. The frontend tree is scanned because shadcn variant
  tables hold classes that appear in no static markup.
- Tailwind stays pinned at **v3.4.17**. v4 changes utility semantics (default
  border colour, ring width, opacity utilities, the `space-*` selector) and
  would silently restyle the whole shell — it is a deliberate later decision
  with its own before/after evidence, not a free upgrade.
- `tests/tailwind-build.test.js` performs a fresh compile into a temporary
  directory, validates representative utilities and palette semantics, and
  pins the Docker builder/copy contract. Its `public/index.html` input is the
  ignored output materialized by the test preflight, never a committed
  artifact.
- The shell loads **no cross-origin assets**. marked, DOMPurify and qrcodejs
  are vendored under `public/vendor/` by `npm run vendor:assets` (provenance
  in `public/vendor/README.md`). Don't add a CDN `<script>`/`<link>` to
  `frontend/src/head.html` — vendor or compile it instead; three tests
  enforce this.
- The three stylesheet links must stay in the order `native.css` → `app.css`
  → `tailwind.css`, with the compiled utilities **last**. `app.css` was
  written against a cascade where Tailwind wins equal-specificity conflicts;
  inverting it silently restyled the whole dev screen once (#938). The head
  also probes this at runtime and `console.error`s when it breaks — which
  fails proposal checks, since a console error on any route does.
