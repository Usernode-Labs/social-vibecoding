---
name: harness-fitness
description: Audit repository agent-harness integrity, loaded-context fitness, portability, and model drift. Use when asked to audit harness fitness, review AGENTS.md or SKILL.md growth, prepare a Claude or Codex model/runtime migration, refresh vendor guidance, or evaluate a harness, router, adapter, tool, or permission change. Do not use for ordinary UI review, feature implementation, design-system audit, or general code linting without harness changes.
---

# Harness Fitness

Keep the harness thin by separating mechanical truth from judgment and model
behavior.

1. Resolve the harness workflow from the repository root:
   `node tool/ui-workflow.mjs --task "<task>" --files "<changed files>"`.
2. Run `npm run check:harness-integrity` from `frontend/`. Treat any failure as
   blocking; do not waive broken adapters, routes, references, commands, or
   continuous-integration parity.
3. Run `npm run check:harness-fitness`. Treat context growth, duplication,
   broad triggers, missing provenance, and stale evidence as review findings,
   not automatic failures.
4. Read [references/rubric.md](references/rubric.md) only for model migrations,
   doctrine refreshes, or a requested full fitness audit.
5. Run the live Claude-and-Codex battery only for a model/runtime change, a
   measured instruction experiment, or a prerelease checkpoint. Keep task,
   final-state grader, permissions, budgets, effort, and trial count matched.
6. Change one instruction, tool group, or orchestration layer at a time. Keep
   the change only when deterministic checks hold and matched behavioral
   evidence remains equal or improves.

Never update the committed fitness baseline during a routine check. Record a
new baseline only after the changed footprint and evidence are explicitly
accepted. Add `--doctrine-reviewed` only when current primary vendor guidance
was actually reviewed; ordinary footprint acceptance carries the prior doctrine
date forward. External linters are advisory references; project scripts and
outcome evidence remain authoritative.

Report `Adopt Now`, `Consider`, `Reject`, `Watchlist`, and pull-request-sized
backlog items. Name the exact local owner for every proposed change.
