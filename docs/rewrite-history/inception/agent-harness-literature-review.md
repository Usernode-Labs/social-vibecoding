# Agent Harness: Literature Review and Reset Hypothesis

## Question

The current Usernode agent harness has useful material, but it may have evolved as a collection of individually reasonable skills, scripts, and adapters rather than as one intentional operating model. This review asks what should be retained, removed, or re-earned before the web design-system work relies on it.

This is deliberately a **reset hypothesis**, not a decision to import another project's harness.

## The common model

Across the sources, the durable unit is not a prompt or an agent persona. It is a bounded loop:

```text
small durable context → focused task skill → deterministic evidence → fix/retry → independent gate → human decision only where judgment is irreducible
```

The loop is healthy only when an agent can find the right instructions, exercise the relevant surface in a safe environment, observe an objective result, and either repair or escalate with a specific failure. More prose, more roles, or more MCP servers do not improve this by themselves.

## What the sources actually support

### 1. Codex: separate durable guidance, reusable workflows, and external capability

OpenAI’s current Codex guidance explicitly separates `AGENTS.md` (small persistent repository rules), skills (repeatable workflow plus scripts/references), MCP (external systems), and subagents (specialized delegation). It recommends adding a durable rule only for repeated mistakes and pairing rules with hooks, linters, and type checks. [Customization overview](https://learn.chatgpt.com/docs/customization/overview)

**Valid lesson:** put global/repo invariants and exact commands in a short `AGENTS.md`; put multi-step work in a skill; make enforcement executable. Do not use a global prompt, an MCP, and a skill to all express the same rule.

### 2. Claude: verification loops are only valuable when they close autonomously

Claude’s recent writing defines a loop as repeated work until a stop condition. Its core advice is to start with the simplest loop, give the agent tools that can quantitatively inspect the result, package repeated manual checks as skills, and use an independent reviewer for high-value review. [Getting started with loops](https://claude.com/blog/getting-started-with-loops) [Building verification loops with skills](https://claude.com/blog/building-verification-loops-in-claude-code-with-skills)

It distinguishes standalone checks, embedded checks, chained checks, and PR-wide gates. The key ordering is important: prove a check locally; make it part of a producing workflow if it is always needed; promote it to CI only when stable. Their broader workflow guidance says default to sequential work, parallelize only independent work, and add evaluator–optimizer loops only when the quality gain is measurable. [Common workflow patterns](https://claude.com/blog/common-workflow-patterns-for-ai-agents-and-when-to-use-them)

**Valid lesson:** a skill must name a stop condition and evidence command. Chain only the checks that genuinely always belong together. Avoid a permanent multi-agent review ritual unless it catches a measurable defect class.

### 3. t3code: high-specificity skills are justified by dangerous, stateful integration surfaces

`pingdotgg/t3code` is not a design-system harness. It is a coding-agent product with volatile local state, one-time pairing URLs, worktrees, browser/mobile clients, and competing dev servers. Its root `AGENTS.md` stays compact: targeted checks only, an integrated verification requirement for user-visible changes, explicit package boundaries, and strong worktree-local state rules. [Root guidance](https://github.com/pingdotgg/t3code/blob/main/AGENTS.md)

Its deep skills are intentionally operational: `test-t3-app` and `test-t3-mobile` instruct agents how to create disposable state, avoid touching a shared user database, seed fixtures safely, authenticate once, control a device semantically, capture evidence, and clean up only processes they own. Those skills carry detail because a generic “run the app and test it” would be unsafe and unreliable. Its observability document makes a persisted trace file the local record of completed spans, with stdout treated as human-only output. [Repository](https://github.com/pingdotgg/t3code) [Observability guide](https://github.com/pingdotgg/t3code/blob/main/docs/operations/observability.md)

**Valid lesson:** make a deep skill only for a dangerous or high-friction boundary—WebView/native bridge, seeded UI state, visual capture, or device verification. It should encode isolation, ownership, exact evidence, and cleanup. This is stronger than a generic “frontend taste” instruction.

**Non-transfer:** do not duplicate t3code’s product-specific provider, pairing, mobile, Effect, or worktree rules. They solve its own operational hazards.

### 4. Codex’s harness model: context and tool results are part of the loop

OpenAI’s explanation of the Codex agent loop describes the harness as the orchestration layer that prepares context, executes tools, returns results to the model, and repeats. It is a useful reminder that a harness is not only a file of instructions: reproducible tool outputs, context selection, and sandbox boundaries determine behavior. [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)

**Valid lesson:** a design-system harness should prioritize inspectable registry data, stories, stable commands, deterministic fixtures, and CI output over ever more descriptive policy.

## Diagnosis of the current Usernode direction

The existing Flutter-side harness already has valuable pieces: canonical usernode skills, setup discovery adapters, design specs, Widgetbook, linting, focused scripts, hooks, and CI. The risk is not that it lacks machinery. The risk is that its many layers may be overlapping authorities:

- a skill can describe a rule already enforced in a script;
- a broad “taste” workflow can conflict with a DS build workflow;
- adapter links for several agent hosts can become another maintenance surface;
- catalogs, prose specs, and code can each appear authoritative;
- a skill can become a long historical scrapbook rather than a route to a command and an artifact.

For the web programme, importing this harness wholesale would repeat the problem. The first web harness should be deliberately smaller than the accumulated Flutter harness, and every later addition should earn itself through observed failure data.

## Proposed minimal web harness (to validate, not yet adopt)

### One authority stack

| Concern | Single authority | Evidence/enforcement |
|---|---|---|
| Durable repo rules and command routing | Root/nested `AGENTS.md` | Short, checked in, scoped by directory |
| Tokens, components, variants, maturity | Usernode registry metadata and source | Type/lint validation |
| Rendered states and component behavior | CSF stories and fixtures | Storybook test/a11y/visual artifacts |
| Data, bridge, WebView capability semantics | Typed adapter contracts | Contract/integration tests |
| Mechanical policy | Scripts + CI | Non-bypassable checks |
| Human design judgment | Product/design approval | Explicit baseline or ADR decision |

Nothing else may become a second authority. Skills explain how to move through this stack; they do not restate it.

### Four initial skills

1. **`ui-intake`** — converts a request into a scenario/gap-proof artifact. Stop condition: classified as reuse, extension, feature-local, or new public component, with named owner.
2. **`ui-component`** — searches registry, implements/extends a presentational component, creates required stories/fixtures, and runs narrow component checks. Stop condition: green local evidence or an explicit blocked dependency.
3. **`ui-integrate-webview`** — wires a proven component to typed data/bridge adapters and runs one isolated WebView/browser route check. Stop condition: captured route evidence plus bridge/adapter tests; no raw bridge global in presentation code.
4. **`ui-verify`** — runs the smallest applicable lint, story interaction, axe, visual, and route tests; categorizes failures and repairs them before handoff. Stop condition: prescribed evidence bundle or a reproducible failing command.

`ui-review` should initially be a second-agent invocation or PR workflow, not a fifth broad skill. `ui-release`, Figma, generic taste tooling, performance trace diagnosis, and fleet scaffolding should be added only after the first vertical slice proves a recurring gap.

### Skill design rules

- A skill description must state exactly when it triggers; its body names inputs, commands, artifacts, stop condition, and escalation.
- Store stable scripts next to the skill. Do not make the model rediscover deterministic work.
- A skill may call another only when the second verification step is mandatory for every use of the first.
- One primary agent owns dev-server/device/browser lifecycle. Subagents may inspect or run targeted checks but do not create competing environments by default.
- Every skill has an owner, a test fixture or self-test where possible, a version/review date, and a deletion criterion.

## Promotion ladder for harness changes

```text
one-off human correction
  → task-local instruction
  → reusable skill (after repetition)
  → embedded/chained verification (after it is consistently useful)
  → required CI gate (after stable and low-noise)
```

Do not jump directly from an interesting article or a one-time agent failure to a permanent rule. This ladder reconciles fast agent iteration with a harness that stays coherent.

## First audit before building

Audit each existing skill/script/hook against five questions:

1. What failure or costly manual action does it prevent?
2. What is its sole authority boundary?
3. What concrete command/artifact proves success?
4. Is it duplicated by another skill, prompt, hook, or CI check?
5. If removed, what measured regression would re-justify it?

Classify each as **retain**, **merge**, **demote to reference**, **replace with executable check**, or **delete**. Do not rewrite content before this inventory; the goal is reduction of authorities, not a prettier pile of instructions.

## Recommendation for the current plan

Before selecting the eventual web design-system bundle, run a bounded harness-reset pilot on one component slice. Use the four skills above, the existing registry/Storybook direction, one isolated route verification, and the pre-registered gates. Measure: agent discovery success, duplicate prevention, evidence completeness, false-positive gate rate, tokens per green change, and human intervention count.

If this minimal loop cannot reliably produce and verify one component slice, adding Astryx, shadcn MCP, more reviewer agents, or an elaborate workflow engine will not solve the actual issue. If it works, promote only the missing capability exposed by its failures.
