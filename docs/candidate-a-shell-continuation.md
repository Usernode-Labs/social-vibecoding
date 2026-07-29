# Candidate A shell continuation record

## Decision

Continue Candidate A for the Social Vibecoding React **platform shell only**.
The authority includes platform-owned routes, reusable shell patterns, and the
shell-side hosted-app frame. It excludes child-app source, app-factory
scaffolds/prompts, and existing `usernode-native/v1` consumers.

## Authorization basis

The product owner explicitly requested on 2026-07-29 that Candidate A's missing
design authority and agent-lifecycle evidence be completed while narrowing the
plan to the shell and deferring the app-factory boundary.

## Evidence

- Canonical DTCG tokens: `frontend/design-system/tokens.json`
- Resolved authority/catalog: `frontend/design-system/authority.json` and
  `frontend/design-system/catalog.json`
- Owned shadcn registry: `frontend/registry.json` and generated
  `frontend/public/r`
- Enforcement: token, catalog, registry, style-policy and architecture checks
- Executable component catalog: 37 Storybook files / 135 named states pass in
  Chromium with axe assertions enabled; the catalog production build also
  passes
- Portable workflow: `agent-skills/ui-development` and
  `tool/ui-workflow.mjs`
- Agent battery:
  `frontend/design-system/evidence/candidate-a-shell-battery.json`
  — T1–T5 pass; deliberate violation enforcement is 5/5
- Fresh-agent battery:
  `frontend/design-system/evidence/candidate-a-shell-live-agent-battery.json`
  — T1–T5 pass using separate Codex CLI turns
- Retry and intervention ledger:
  `frontend/design-system/evidence/candidate-a-shell-live-agent-retries.json`
  — 1,157,008 lifecycle input tokens, 291,980 ms known execution time,
  two retries, and two harness interventions

## Execution record

- Branch: `codex/react-shadcn-migration`
- Baseline commit: `808f7da68ddd563563bc7152fb6db3e0ee9933ae`
- Technical executor: Codex current task
- Technical attestation date: 2026-07-29
- Retries/interventions: recorded in the battery evidence
- Token telemetry: Codex CLI JSONL supplied per-task usage for the live
  battery. The deterministic in-process battery still marks tokens
  unavailable because that host surface does not expose them.

## Conditions

This record authorizes continued shell work, not production cutover and not an
app-factory design system. Native WebView, iframe/bridge, authentication,
offline/service-worker, visual-baseline, and route-retirement proofs remain
independent gates. New tokens, primitive categories, or exception categories
require shell design-system approver review.

Technical attestation: **Codex — 2026-07-29**

Product continuation authorization: **recorded from the user's explicit
instruction in the current task; final release approval remains separate.**

This is a human-readable technical attestation, not a cryptographic signature.
The historical live-agent run lacked a pre-registered token ceiling; that
deviation and the exact observed usage are retained in the retry ledger. Any
new live-agent battery must record its ceiling before execution.
