# Social Vibecoding shell execution plan

**Status:** Accepted delivery plan

**Date:** 2026-07-29

**Goal:** produce one integrated, reviewable shell branch quickly without
allowing parallel agents to overwrite shared design-system sources

This plan operationalizes the
[`shell-refinement-guide.md`](shell-refinement-guide.md), the
[`shell-component-audit.md`](shell-component-audit.md), the
[`platform-navigation-proposal.md`](platform-navigation-proposal.md), and the
existing
[`content-guidelines.md`](../frontend/design-system/content-guidelines.md).

## Delivery rules

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

## Dependency map

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
                         M8 host/static frame proof
                                   │
                         M9 optional Motion decision
                                   │
                            M10 cutover review
```

## Wave 0 — Charter and preset freeze

**Owners**

- Documentation agent: accepted docs and cross-links.
- Create investigator: uses the shadcn CLI and Create UI to propose the exact
  Base UI + Luma code; no source mutations.
- Coordinator: accepts the preset record and commits the wave.

**Outputs**

- coherent audit, navigation, refinement, host, and execution records;
- exact opaque Create preset code, decoded fields, URL, CLI version, and
  rationale;
- current-state record: Base UI/Base-Nova;
- target-state record: frozen Base UI + Luma preset, merge-mode adoption.

**Stop/go G0**

Stop if the preset code is absent, manually reconstructed, changes the
primitive base, or its decoded choices do not match the accepted review. Go
when the code is reproducible through `preset decode`, `preset url`, and
`preset resolve`.

**Milestone commit**

`docs(shell): freeze accepted charter and Create baseline`

## Wave 1 — Parallel foundations

Run three disjoint lanes after G0.

### Lane 1A — Structural integrity

**Ownership:** shell landmarks, route heading elements, route fallback,
targeted axe configuration/tests, style-policy coverage, exception inventory,
stale authority reference, avatar contrast fix.

Required results:

- one shell-owned `main`;
- one route-owned `h1`;
- named navigation landmark;
- serious avatar contrast finding fixed;
- moderate landmark/heading rules enforced;
- widened style-policy inventory ledgered with owner and expiry;
- viewport tag unchanged pending device evidence.

No visual redesign and no general copy pass.

### Lane 1B — Content governance

**Ownership:** content-contract schema/authority, objective content checker,
fixtures, and Storybook content review requirements.

Mechanically check only objective rules: canonical terms, banned filler,
invalid ellipses, migration language, and machine-verifiable label/name
relationships. Keep context restatement, defensive reassurance, and other
judgment-heavy failures in named human review.

### Lane 1C — Luma reconnaissance

**Ownership:** isolated scratch project and an impact report under `docs/`.
No edits to production primitives, CSS, tokens, or feature components.

Compare the frozen Luma preset with every installed official component. Record
upstream changes, local accessibility/platform deviations to preserve,
expected token/CSS effects, and likely conflicts with lanes 1A/1B.

**Stop/go G1**

Go only when structural tests are green, content checks are green, existing
style-policy violations are ledgered rather than silently ignored, and the
Luma report identifies every shared file it will touch.

**Milestone commits**

- `fix(shell): restore landmark heading and contrast integrity`
- `feat(content): enforce shell content contracts`
- `docs(shadcn): record Luma merge impact`

## Wave 2 — Single-owner Luma adoption

Freeze feature edits to shared UI sources during this wave.

**Ownership:** one Luma integration agent owns `components.json`, global CSS,
official UI primitives, font setup, and baseline theme tokens. The coordinator
resolves any overlap with Wave 1; other agents review or work only in disjoint
docs/tests.

Use merge mode:

1. update configuration without reinstalling detected components;
2. inspect each component with `--dry-run` and `--diff`;
3. merge official Luma geometry and styling;
4. preserve documented local accessibility/platform changes;
5. run format/generation commands and review their exact diff.

Do not add Usernode identity/status/attention roles here. This milestone proves
the upstream baseline by itself.

**Stop/go G2**

- preset resolution matches the frozen record;
- no blind overwrite or unexplained local primitive fork;
- light/dark Storybook and route screenshots show coherent Luma;
- axe has no new critical, serious, or governed moderate findings;
- typecheck, unit, Storybook, and targeted browser tests pass;
- feature-specific styling did not enter official primitives.

**Milestone commit**

`feat(ds): adopt frozen Luma baseline in merge mode`

## Wave 3 — Product-semantic foundation

Parallelize discovery and stories, but serialize writes to shared tokens and
generated CSS.

### Lane 3A — Semantic tokens and theme contract

Own finite identity palette roles, positive/warning/critical/unknown status
roles, attention, aliases/generation, and Light/Dark/System compatibility.
Absent storage key continues to mean System.

### Lane 3B — `AppIdentity`

After token names stabilize, own artwork failure, Unicode-aware monogram
fallback, immutable-ID mapping, and light/dark named states. The mapping is
finite and deterministic; no runtime hue generation.

### Lane 3C — `StatusDot`

After token names stabilize, own the rendering primitive, accessible-name
format, and explicit Node/App/Connection domain adapters. Semantic roles are
shared; domain states are not collapsed.

The menu attention dot is static. Record candidate motion metadata only.

**Stop/go G3**

- token generation and style policy pass;
- deterministic mapping tests cover stable IDs and fallback behavior;
- contrast passes for every identity/status role in both themes;
- theme storage remains byte-compatible with legacy behavior;
- no Motion dependency or direct hardcoded status/identity color exists.

**Milestone commit**

`feat(ds): add shell identity status and theme semantics`

## Wave 4 — Successor contracts

Build props-only, Storybook-first contracts before route wiring. Agents may run
in parallel with disjoint component/story ownership:

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

**Stop/go G4**

All named states pass Storybook interaction tests and both-theme axe scans.
`FocusedAppFrame` declares iframe mount continuity as a performance contract.
No pattern calls an endpoint directly.

**Milestone commits**

- `feat(shell): define header and app discovery contracts`
- `feat(shell): define navigation and focused-app contracts`

## Wave 5 — Parallel product slices

### Lane 5A — Home and Explore

Replace the mixed Apps Home:

- Home is sparse, personal, and launches apps directly;
- Explore owns search, discovery, detail entry, and Create app;
- Home previews at most three important Activity items;
- first-run, empty collection, no results, loading, and error are distinct;
- deprecate, migrate, then remove `AppCard` and its obsolete test anchors.

### Lane 5B — Navigation and contextual chrome

Implement Home, Explore, Work, Challenges, Activity, separate Node, and bottom
utilities. Add gated Admin, static menu attention, Activity count inside the
drawer, Use/Improve/Close/Back semantics, and theme inside Settings. Remove the
duplicate global toolbar and page-body Back controls.

Lanes may proceed together only if route tables, shell composition, and shared
fixtures have one named owner. Integrate Home/Explore before final navigation
route assertions.

**Stop/go G5**

- route/deep-link compatibility passes;
- Home launch and Explore detail jobs remain distinct;
- drawer labels and content terms follow the content authority;
- keyboard, focus order, narrow/wide states, and authorization states pass;
- superseded surfaces are removed or explicitly deprecated with no new uses.

**Milestone commits**

- `feat(apps): split personal Home from Explore`
- `feat(shell): land platform drawer and contextual chrome`

## Wave 6 — Static focused-app and host verification

Run web and host lanes in parallel; do not add JS motion.

### Web lane

Prove drawer open/close does not remount the iframe. Preserve form, scroll, and
JavaScript state. Make the shifted app inert while the temporary drawer owns
focus. Preserve direct routes, legacy hashes, browser history, and external
link behavior.

### Host lane

Complete or evidence:

- edge-to-edge safe-area ownership without double insets;
- native bridge caller authentication and privilege isolation;
- shortcuts/widgets reopen the web-owned focused-app route with matching
  assets;
- real-device iOS/Android viewport zoom, Back, and offline behavior;
- service-worker readiness and route parity.

**Stop/go G6**

Bridge caller authentication is a hard cutover blocker. So are iframe remount,
double safe-area inset, broken native Back, unproven viewport behavior, and
shortcut/widget route divergence. Static behavior must pass before Motion can
be reconsidered.

**Milestone commits**

- `feat(shell): preserve focused-app state across navigation`
- host-repository commit(s), referenced by immutable revision in evidence

## Wave 7 — Optional Motion experiment

This wave does not start automatically. G6 opens a decision, not an obligation.

If approved, one owner may add a small `@/lib/motion` adapter and only:

- drawer/`FocusedAppFrame` settling;
- a one-time attention appearance pulse.

Require reduced-motion no-op behavior, measured bundle impact, no direct
Motion imports, no looping animation, and real WebView evidence. If any check
fails, retain the static implementation.

**Milestone commit, only if accepted**

`feat(shell): add measured focused-app settling`

## Wave 8 — Cutover and final review

The coordinator rebases/integrates milestone commits, resolves generated
artifacts once, and runs the complete evidence matrix.

### Required review evidence

| Area | Evidence |
| --- | --- |
| Authority | frozen preset record; current/target resolution; generated artifacts clean |
| Structure | landmark/heading tests; no unledgered style-policy violations |
| Content | content checker; named human failure-mode review |
| Visual | deterministic light/dark, mobile/desktop screenshots for every successor state |
| Accessibility | axe with critical/serious and governed moderate rules; keyboard and focus traces |
| Behavior | Home/Explore jobs, drawer states, admin gating, theme compatibility |
| Hosted app | iframe mount identity plus form/scroll/JS continuity |
| Routing | direct URLs, legacy hashes, browser Back, Android Back, shortcut/widget entry |
| Host | safe-area, viewport zoom, bridge authentication, offline/service worker on real devices |
| Performance | bundle gate, route loading, declared sensitive interactions; Motion separately if adopted |

### Final stop/go G7

Cut over only when all required evidence is attached, no hard host blocker
remains, and the complete frontend gate passes from a clean worktree. Otherwise
ship the last green milestone for review and name the exact blocker; do not
weaken a gate to manufacture completion.

**Final milestone commit**

`chore(shell): attach cutover evidence and retire legacy shell`
