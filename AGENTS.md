# Social Vibecoding React migration

## Purpose

This branch migrates the platform UI from the existing static, vanilla-JS
shell to React and official shadcn/Base UI components without changing the
server/API, authentication, bridge, iframe, service-worker, hash-link, or
child-app security contracts until an equivalent replacement is verified.

## Universal working agreement

This file is deliberately vendor-neutral. Codex, Claude, and other coding
agents should read it before making migration changes.

For React route, component, or UI-review work, read
`agent-skills/ui-development/SKILL.md`. Run `tool/setup-agent-skills.sh` to
expose that same canonical skill through local `.agents`, `.claude`, and
`.codex` discovery paths; those generated adapters are intentionally ignored.
Begin UI work with `node tool/ui-workflow.mjs --task "<task>"`; it provides
progressive, task-specific context and gates without depending on one agent
vendor's hook runtime. Its classifications compose: follow every selected
workflow, not only the first label. Run `cd frontend && npm run check:ui`
before handoff; harness integrity proves that authority still matches package
scripts, continuous integration, adapters, and the deterministic agent
battery. The expensive live-agent evaluator is a prerelease diagnostic, not a
per-commit freshness gate.

1. Preserve a working legacy route until its React replacement has parity
   evidence for loading, error, empty, permission, narrow and desktop states.
2. Reuse an official shadcn source component before creating an owned pattern.
3. Keep API calls in the React data layer; do not introduce direct `fetch()`
   calls in presentation components.
4. Treat hashes, browser history, native bridge capability discovery, iframe
   sandboxing, session cookies, and service-worker behaviour as public
   compatibility contracts.
5. Add a harness rule only after a specific migration failure proves it is
   needed. Record the trigger, proof command and owner next to that rule.
6. For a registered text-bearing pattern, use the optional content contract in
   `frontend/design-system/authority.json`, read
   `frontend/design-system/content-guidelines.md`, and run
   `npm run check:content` from `frontend/`. The gate is deliberately narrow;
   use its exact, expiring ledger for existing migration copy rather than
   pretending subjective writing judgment is mechanically decidable.

## Commit messages

Write for a future reader who has the diff but not the task conversation.

- Use an imperative subject that describes the outcome, not the files changed.
- Add a body only when the change has context the diff cannot explain.
- Preserve the reason for the change and any important decision, tradeoff, or
  intentional deviation.
- Record meaningful verification that was actually performed and any known
  remaining risk that affects future work.
- Derive verification and risk claims from command output produced at the exact
  commit being described, not from session memory or a dirty neighboring tree.
- Omit empty headings, diff summaries, file lists, session transcripts,
  abandoned debugging paths, and agent, model, token, or task metadata.
- Never claim a test or check passed unless it was run.

## Commit size and shape

- Keep one concern per commit. If the subject needs "and", split the change.
- Do not mix mechanical output with semantic implementation. Generated
  catalogs, lockfiles, codemod output, and bulk evidence scaffolding belong in
  commits labeled as mechanical so reviewers can distinguish derived changes
  from decisions.
- Treat roughly 400 hand-written changed lines or 20 files as a soft review
  limit. If a semantic commit exceeds it, explain in the body why the change
  cannot be split without breaking its contract.
- Every commit must pass its required gate on its own. A commit that cannot be
  checked independently is either too large or cut at the wrong boundary.
- Keep enforcement advisory unless a specific failure proves a mechanical rule
  is needed. Commit shape remains a review judgment, not a line-count contest.

## Design-authority scope

The Candidate A design authority governs only the React platform shell:
platform-owned routes, reusable shell patterns, and the shell-side hosted-app
frame. It explicitly excludes child-app source, the app-factory
scaffold/prompts, and hosted `usernode-native/v1` consumers. Do not edit child
apps to demonstrate shell conformance.

## Migration evidence required per route

- deterministic fixture evidence for loading, success, empty/error and any
  capability/permission variation. Use Storybook for reusable presentation
  components and fixture-driven browser tests for routes, adapters, and
  host-contract behavior;
- desktop and mobile browser interaction evidence;
- accessibility scan with no critical or serious violations;
- an explicit compatibility note for route/hash/back behaviour.

## Commands

Legacy server tests remain authoritative for server behaviour:

```sh
npm test
```

React migration commands live in `frontend/` and will be listed in its
package manifest. Run only the narrowest relevant checks while iterating, and
run the full migration gate before handoff.

## Scope boundary

Do not delete `public/js`, legacy HTML, or any deployment route merely because
a new React screen exists. Removal requires the route-parity checklist in
`docs/react-migration.md` to be complete and reviewed.
