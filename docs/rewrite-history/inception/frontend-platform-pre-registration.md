# Candidate A Foundation Charter

## Status and authority

This is the bounded execution charter for the first Social Vibecoding web design-system slice. It commits to Candidate A and governs its evidence, harness reset, and reassessment. The companion [programme](frontend-platform-decision-plan.md) supplies context and delivery policy; it does not expand this first slice.

**Direction: committed.** Build Candidate A first; do not spend agent capacity producing parallel implementations of other candidate systems. Before code starts, record the execution envelope and the named approver for this slice:

### 2026-07-29 scope correction

Candidate A is now the design authority for the **Social Vibecoding platform
shell only**: platform-owned routes, reusable shell patterns, and the
shell-side hosted-app frame. Child-app source, app-factory scaffold/prompts,
and existing `usernode-native/v1` consumers are explicitly excluded. The
earlier RecipeBot proof remains migration evidence, not a claim that the shell
design system governs hosted apps. An app-factory design system requires a
separate charter after the shell authority and lifecycle are proven.

The inherited four-skill proposal is consolidated into one canonical,
vendor-neutral `ui-development` skill plus a repository-owned dynamic workflow
resolver. The resolver classifies authority, component, route, contract, and
review work and returns the smallest relevant context, commands, evidence, and
stop condition. Mechanical scripts and CI remain authoritative; a skill cannot
waive a gate.

| Required authorization | Value |
|---|---|
| Slice approver | **Product owner — authorization recorded in the 2026-07-29 task instruction to repair Candidate A and continue with shell-only scope.** |
| Reassessment reviewer | **Codex technical attestation plus product-owner continuation authorization. A separate release reviewer is still required for cutover.** |
| Reassessment checkpoint | **2026-07-29 shell-authority checkpoint after the T1–T5 battery and browser Storybook gate.** |
| Permitted extension | One bounded evidence cycle, signed by the approver and stating the smallest missing experiment and its token/tool ceiling. |
| Agent execution budget | **Historical deviation:** the live battery was run before a ceiling was pinned. Actual lifecycle use is recorded exactly (1,157,008 input tokens; 291,980 ms known wall time; two retries). No further live-agent battery may run without a task-set ceiling recorded first. |
| Human review budget | **Two checkpoints:** product-owner shell-scope authorization and review of the continuation record. Production cutover remains a separate approval. |

## Fixed scope

- **Committed platform:** **Candidate A — Usernode registry + shadcn + Base UI + Tailwind + Storybook**.
- **Runtime:** React + TypeScript. A minimal Vite/client-shell baseline; application runtime choice is out of scope.
- **Initial vertical slice:** **responsive Apps home and platform hosting shell**, recorded in [the slice spec](apps-home-platform-shell-slice-spec.md). It covers the catalogue's app browser, global navigation model, app detail, and route/frame handoff. RecipeBot is fixture content used to exercise the shell boundary; its child-app UI is not governed by Candidate A.
- **Framework-neutral assets, not counted against a candidate:** canonical tokens, scenario vocabulary, MSW handlers/fixtures, agent prompts, bridge fixtures, CI templates, and Storybook configuration patterns.
- **Initial scope budget:** one component-family vertical slice and the minimal harness needed to produce and verify it. It covers styling/component wiring, registry configuration, Storybook, deterministic fixtures, four initial skills, and lint integration. Record tokens, wall time, tool calls, retries, and changed files. Do not build parallel candidate implementations or a general workflow platform.

## Agent execution model

Code is produced by agents. The foundation slice therefore measures reproducible **agent-to-evidence loops**, not estimated human implementation duration:

1. An agent receives a pinned task and execution envelope in a clean candidate checkout.
2. It searches the approved system, changes code, runs the prescribed verification commands, and returns artifacts.
3. CI independently checks the resulting patch; a human reviewer evaluates only the pre-defined decision evidence and risk acceptance.
4. Repeated runs expose whether a candidate is reliably operable or merely succeeds once with unusually favorable prompting.

Tokens per successful verified change, wall-clock latency, retry count, tool calls, and CI cost are recorded separately. Do not translate them into engineer-weeks; they answer different questions.

## Inputs required before the foundation slice

1. Canonical semantic tokens and a light design-intent brief.
2. A fixed specification for the selected initial slice.
3. Pinned repository commit, candidate versions, Node/package-manager version, Storybook version, model/version, device, browser/WebView, network profile, and test commands.
4. Reference Android WebView baseline and production compatibility inventory.

Pattern discovery can continue in parallel. The slice waits only for these four inputs, not a complete taxonomy or final visual system.

## Foundation gates

All gates are binary. Narrative enthusiasm cannot override a failure.

1. **Safety and compatibility:** no unresolved iframe/bridge privilege failure relevant to the slice; the slice passes bridge bootstrapping and its required legacy-route coexistence without breaking service worker, App-Bound Domain constraints, or hosted `usernode-native/v1` consumers.
2. **Interaction and accessibility:** the slice passes its agreed safe-area, keyboard, and mobile interaction acceptance checks; axe reports zero serious or critical violations.
3. **Performance:** candidate meets the pre-recorded Android WebView budgets. Until calibrated against baseline, the provisional targets are ≤200 KB gzip initial route JavaScript, ≤50 KB critical CSS, LCP ≤2.5 s, INP ≤200 ms, and a recorded memory ceiling.
4. **Enforcement:** T4 catches the deliberate violation in **5/5 runs** and emits an actionable failure. This is the only agent-battery binary gate.
5. **Evidence stability:** the full CI suite passes **10/10 consecutive identical runs**; visual baseline comparison produces **0 flaky outcomes in 10 reruns** under the pinned environment.

T1–T3 and T5 are learning evidence, not a competitive score. They show whether the initial harness reliably guides agents through real component work.

## Agentic evidence battery

Run the relevant tasks on fresh clones with the same prompt, model/version, token/tool/wall-clock envelope, and verification commands. Preserve transcript, patch, command output, and artifacts. Begin with one run per task; repeat only a failure or an ambiguous result rather than manufacturing a leaderboard.

| ID | Task | Primary measurement |
|---|---|---|
| T1 | Build a specified screen using existing approved components. | Discovery/reuse rate; no duplicate component or raw styling. |
| T2 | Add a destructive Button variant. | Pass@1 for correct API, tokens, story, and green gates. |
| T3 | Build the developer-work card from the fixed specification. | Compound conformance rate, token use, time to green. |
| T4 | Attempt a raw hex value or arbitrary utility. | Enforcement catch rate and actionable remediation. |
| T5 | Repair a Storybook accessibility failure using only the candidate harness. | Pass@1 using candidate discovery and verification tooling. |

Report pass/failure, token use, wall time, retries, and resulting artifacts. T1–T3/T5 identify learning needs; T4 is governed solely by the hard gate above.

### 2026-07-29 evidence result

- Deterministic T1–T5 battery: **5/5**, with T4 rejecting the deliberate
  violation **5/5**.
- Fresh Codex task battery: **5/5**. Per-task token usage and commands are
  retained in the shell evidence record; the full pilot/retry history is
  retained separately rather than overwritten.
- Browser component evidence: **37 story files / 135 named states pass** in
  Chromium with Storybook's axe accessibility assertions enabled.
- Continuation is **shell-only and conditional**. This checkpoint does not
  claim the safety, WebView, offline, visual-stability, or production-cutover
  gates below have passed.

## Harness reset and gradual build

Start by removing the inherited web harness as an authority. Preserve it only as read-only reference until each existing skill, hook, script, or rule has passed the audit in the [literature review](agent-harness-literature-review.md): failure prevented, unique authority boundary, proof command/artifact, duplication check, and re-justification trigger.

Build one canonical project-local `ui-development` skill, exposed through thin
`.agents`, `.claude`, and `.codex` discovery adapters. A repository-owned
`tool/ui-workflow.mjs` performs task classification and emits the task-specific
inputs, commands, artifacts, stop condition, and escalation boundary. Keep
vendor hooks optional; the portable contract is the skill, machine-readable
authority, scripts, and CI. Add another skill only when a repeated failure
cannot be expressed as progressive-disclosure guidance in this workflow or as
an executable gate.

## Reassessment rule

After the first vertical slice, review raw artifacts rather than scoring alternatives in advance.

Continue Candidate A when it passes the foundation gates and agents can discover, compose, verify, and repair the slice through the minimal harness without recurring unbounded workarounds.

Open a **narrow falsifying experiment**—not a full multi-candidate bake-off—only when evidence identifies one of these unmet needs:

- Base UI cannot express a required accessible/mobile interaction without unacceptable custom behavior;
- Tailwind/token enforcement cannot prevent repeat style drift with actionable failures;
- shadcn/private-registry discovery is materially unreliable for agents after the harness has been corrected;
- a required compound makes the Base UI composition model unmaintainable;
- fleet distribution becomes a confirmed cross-framework requirement.

The experiment must name the specific alternative and the single failing requirement. React Aria is the first behavioral-base alternative; Astryx or Park/Ark/Panda require their own evidence-driven rationale. No alternative is implemented merely to maintain optionality.

## Required slice record

The slice record contains: Candidate A versions; token/registry ownership; the
canonical skill and workflow-resolver version; scenario and fixtures; T1–T5
evidence actually run; gate results; tokens/wall time/tool calls; human
interventions; deviations and their cause; first migration boundary; reversal
seams; and the next smallest experiment, if any. When the execution host does
not expose token counts, record that limitation explicitly rather than
fabricating a number; a later fresh-agent evaluation must supply the missing
telemetry before making cross-model efficiency claims.
