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
vendor's hook runtime.

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
