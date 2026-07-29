# Rewrite milestones

Baseline: `808f7da68ddd563563bc7152fb6db3e0ee9933ae`

Branch: `codex/react-shadcn-migration`

Recorded: 2026-07-29

## 1. Discovery and Candidate A charter

Commit: `f28faa4` — `docs(rewrite): preserve discovery and Candidate A charter`

Intent:

- preserve the product and code pattern audits that preceded implementation;
- make the React and Candidate A decisions explicit;
- retain the reviews that introduced performance, accessibility, agent
  operability, and mechanical decision requirements;
- preserve a self-contained, shell-facing visual baseline.

Contents:

- ten inception/discovery documents;
- five substantive review records;
- 73 curated screenshots from the 155-screen source audit;
- an index that labels active, historical, and deferred material.

Deliberately omitted:

- native-only Flutter screens;
- child-app visual interiors and the deferred app-factory system;
- transient browser screenshots that only captured abandoned styling
  experiments.

## 2. Governed React shell

Commit: `cd1e725` — `feat(frontend): build governed React shadcn shell`

Intent:

- establish the compiled React shell beside the still-working legacy frontend;
- preserve API, session, iframe, bridge, history, and service-worker contracts
  behind owned adapters;
- express reusable UI through official shadcn/Base UI primitives and governed
  platform patterns;
- make states inspectable in Storybook and executable in browser tests.

Contents:

- React routes for the platform-owned shell surfaces;
- typed API, stream, browser, and native-bridge adapters;
- DTCG tokens and reproducible generated CSS;
- component catalog, ownership metadata, exceptions, and owned shadcn registry;
- Storybook states, Playwright route/contract checks, bundle budget, and
  Express/Docker coexistence integration.

This commit does not delete or claim parity retirement for the legacy shell.

## 3. Portable agent workflow and gates

Commit: `bb47cbe` — `chore(harness): codify portable UI workflow and gates`

Intent:

- give Codex, Claude, and other agents the same repository-owned workflow;
- load only task-relevant context while keeping enforcement independent of any
  agent vendor;
- convert important rules into checks and record the agent lifecycle evidence.

Contents:

- root and frontend `AGENTS.md` contracts;
- canonical `ui-development` skill and thin discovery adapters;
- task resolver and skill setup scripts;
- required GitHub checks;
- T1–T5 battery definitions and deterministic/live evidence;
- retry, intervention, elapsed-time, and token ledger;
- conditional Candidate A continuation record.

Follow-up commits:

- `55bffd2` — `docs(rewrite): record verified milestone sequence`
- `9dddc22` — `feat(design-system): add scoped performance contracts`

These preserve the verified rewrite record and add the component-level
performance metadata now resolved into 12 current contracts.

## Historical verification record at `bb47cbe`

The following measurements describe the original verified harness checkpoint,
not the current refined shell:

- lint: 0 errors, 12 known Fast Refresh export warnings;
- DTCG token/source generation: pass;
- design authority: 37 governed shell patterns pass;
- owned shadcn registry: 2 installable patterns pass;
- style and architecture policies: pass;
- T1–T5 deterministic agent battery: 5/5, including T4 at 5/5;
- TypeScript: pass;
- production build: pass;
- initial React JavaScript: 151.3 KiB gzip against a 160 KiB budget;
- Storybook: 37 files / 135 states pass in Chromium with axe assertions;
- Storybook production catalog build: pass;
- browser route/contract suite: 601 passed, 51 intentionally skipped;
- production-readonly mutation suite: 40 passed;
- cutover contract: all implemented checks pass, but status remains
  `not-ready` because a real Flutter WebView iOS/Android contract run is absent.

One browser-suite run observed a single notification WebSocket timing failure.
The same case then passed 10/10 under repetition, and the complete 652-case
suite rerun passed. It is recorded as a flake observation rather than hidden or
misrepresented as a product failure.

Open dependency signal:

- `npm audit --omit=dev` reports two high advisories for the current
  `react-router` / `react-router-dom` range. No automatic major-version change
  was made as part of history cleanup.

## 4. Shell refinement foundation

Commits:

- `e9334f1` — `docs(shell): freeze accepted charter and execution plan`
- `67af90a` — `docs(shadcn): freeze Luma baseline with Geist`
- `635eb93` — `fix(shell): restore structural and style-policy integrity`
- `f12635a` — `feat(content): enforce shell content contracts`
- `521e926` — `docs(shadcn): verify frozen Geist probe`
- `aedb14d` — `test(frontend): stabilize route fixtures and realtime reads`
- `4c5d93e` — `feat(ds): adopt frozen Luma baseline in merge mode`
- `b20f9d8` — `docs(shell): consolidate refinement authority`
- `d8ef5ca` — `fix(a11y): restore component heading hierarchy`
- `565c5ff` — `feat(ds): establish shell identity and status semantics`
- `f258d56` — `docs(shell): advance refinement checkpoint`
- `e2a8189` — `feat(shell): define header and app discovery contracts`
- `14ef98a` — `feat(shell): define navigation and focused-app contracts`
- `7763e94` — `docs(shell): advance refinement checkpoint`

Intent:

- adopt the frozen official Luma baseline without blindly overwriting local
  accessibility and platform behavior;
- establish theme-aware app identity and status semantics;
- specify successor patterns before route integration;
- keep Motion deferred until host behavior is proven.

## 5. Home, Explore, navigation, and focused-app chrome

Commits:

- `a989984` — `feat(apps): split personal Home from Explore`
- `e6c05ab` — `feat(shell): land platform drawer and contextual chrome`
  (M7a)

Intent:

- separate personal launch from catalog discovery;
- establish platform navigation and the first contextual-chrome/mount-
  continuity boundary;
- preserve focused iframe identity and state while temporary navigation opens;
- keep browser routes and compatibility adapters intact.

## 6. Activity unification

Commit: `0eb307f` — `fix(content): unify Activity with notifications feed`

Activity is the user-facing name for the existing notifications feed. It keeps
the `/react/notifications` route, notification API, live events, pagination,
unread/invite behavior, and internal module names as compatibility contracts.
It is not a second feed, and Work remains a separate product destination.

## 7. Host cutover decision

Commit: `cc6d3d9` — `docs(shell): record host cutover no-go evidence`

The browser candidate proves focused-frame mount continuity and the implemented
static cutover checks. G6 remains closed because the audited Flutter host does
not yet prove or satisfy bridge caller isolation, single safe-area ownership,
canonical shortcut/widget routing and identity, accessible viewport behavior,
native Back/history, service-worker readiness/offline behavior, and universal
external-link delegation.

Consequences:

- the implemented M8 browser/static proof is complete, but host proof is a
  no-go;
- M9 Motion remains deferred and blocked;
- M10 production cutover and legacy retirement are not complete.

## 8. Quiet pass and contrast integrity

Commit: `13f74d6` — `fix(shell): complete quiet refinement and contrast contracts`

This commit closes M6c. Its quiet-pass changes are mapped to the content
authority's named failure modes:

| Failure mode / rule | Evidence in the surviving shell |
| --- | --- |
| Context restatement | Removed route ledes and section descriptions that repeated their heading |
| Defensive reassurance | Removed explanations that argued for safety instead of helping the user act |
| Mechanism as content / internal-state leak | Replaced migration, legacy, server-side, cache, and bridge implementation language with task language |
| Decorative-button-icon policy | Removed icons that did not communicate direction, status, or externality |
| Context-aware badge/label discipline | Removed or simplified labels whose parent context already carried the meaning |

The same commit contains separately scoped integrity work needed to keep the
quiet pass honest: tokenized accessible button contrast, avatar/identity
contrast corrections, exception-ledger cleanup, and matching browser
assertions. Those fixes are not presented as copy-only G5c work; they are the
contrast/integrity follow-up bundled under the commit's explicit title.

## 9. Activity authority follow-up

Commit: `1becfcb` — `fix(ds): align Activity content authority`

The resolved design authority and generated catalog now use the same Activity
product label as the route while retaining notification-named transport and
module boundaries.

## 10. Contextual chrome and route composition

Commits:

- `c0fb2c4` — `feat(shell): complete contextual chrome and route composition`
- `bd6e380` — `fix(shell): remove duplicate recovery navigation`

`c0fb2c4` closes M7b and the route-composition milestone recorded as M11. M7
is complete only with M7a `e6c05ab` plus that commit. The intended shell routes
now compose the shared `PageHeader` over the available-width canvas rather than
keeping route-local heading/centering systems. The deliberate exceptions are
Login, Register, `HostedApp`, `StagingPreview`, and `NotFound`, whose
authentication, iframe, preview, or fallback jobs require different semantics.
The final source sweep found one duplicate recovery navigation control;
`bd6e380` removes it and strengthens the focused route assertion without
changing the milestone boundary.

## 11. Host contracts and cutover preparation

Commits:

- `bea0b56` — `fix(content): finish Activity story rename`
- `6785617` — `feat(host): harden WebView shell contracts`
- `2eca16f` — `feat(pwa): verify readiness and isolate sessions`
- `db0ea79` — `ci(cutover): deploy exact verified shell artifacts`
- `0770c36` — `docs(cutover): record verified shell evidence`
- `aad39af` — `fix(shortcuts): defer legacy route cutover`
- `ab2034d` — `ci(cutover): require complete authority gates`
- `587e6e3` — `docs(cutover): sanitize physical proof runbook`
- `0e5617c` — `fix(host): keep external navigation in trusted frame`

Intent:

- finish the Activity naming closure without renaming compatibility transport;
- define deny-by-default child relay provenance and bounded native work;
- establish exact worker readiness, immediate-offline and logout-isolation
  contracts;
- preserve one exact-SHA tested artifact through deployment;
- keep legacy shortcut routing unchanged until Flutter adopts and proves the
  versioned React route contract;
- require the complete root and frontend authority gates before packaging;
- keep same-origin special activations in the trusted top frame and expose the
  validated hosted `openExternal` wrapper;
- turn remaining physical-device questions into a sanitized reproducible
  two-platform runbook.

These commits close browser, static, and pipeline gaps only. They do not provide
a deployed immutable candidate or physical iOS/Android evidence, so G6 remains
closed.

## Current verification snapshot

These current measurements supersede the historical `bb47cbe` catalog counts
without rewriting that checkpoint:

- design authority: 44 manifest patterns and 12 component performance
  contracts;
- owned shadcn registry: 2 installable entries;
- style policy: 162 governed modules;
- agent battery: T1–T5 pass 5/5, including T4 deliberate enforcement at 5/5;
- Storybook: 47 files / 228 tests passed;
- full browser route/contract suite: 727 passed, 53 intentionally skipped,
  0 failed;
- complete root suite: 3,277/3,277 passed;
- production-readonly mutation suite: 40/40 passed;
- native bridge contract: 8/8 passed;
- production build and Storybook build: pass;
- initial React JavaScript: 4.1 KiB gzip against a 160 KiB budget;
- cutover contract: 10 verified, 0 failed, 1 explicit
  `native-webview-e2e` blocker;
- production cutover: G6 no-go.

The browser runs emitted expected Vite proxy teardown/isolation warnings
(`ECONNRESET`/`EPIPE` in the full suite and `example.invalid` in the
production-readonly suite). They did not produce test failures. The historical
Fast Refresh and dependency advisory notes above remain checkpoint-specific;
they are not inflated into current product failures.

## What a later rewrite agent should copy

- the evidence-first route inventory;
- the coexistence/adapter migration boundary;
- the official-primitive-first component decision;
- canonical tokens and component metadata before broad styling;
- deterministic stories and route fixtures;
- progressive task context plus independent mechanical gates;
- explicit reporting of skips, retries, exceptions, and cutover blockers.

What it should not copy blindly:

- API shapes that are still evolving;
- legacy compatibility code after the finished APIs make it unnecessary;
- current temporary exceptions without revalidating their owner and expiry;
- shell decisions as an app-factory design system for hosted child apps.
