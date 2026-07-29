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

## Verification record

Fresh post-commit checks:

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
