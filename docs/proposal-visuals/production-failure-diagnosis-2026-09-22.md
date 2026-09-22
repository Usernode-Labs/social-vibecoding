# Visual evidence production failures, 22 September 2026

## What the existing runs establish

- Proposal 4676, run `c5f6edb22b095e163c72e3da58954c8b`, reached the
  platform replay with an agent-submitted plan. Its first base-side action
  searched for a **link** named exactly `Browse`. The page has a **button**
  with the accessible name `Browse all apps`. Replay found zero matches and
  failed with `ambiguous_locator`. The run had one plan call and no artifacts.
  This proves a locator in that particular plan was wrong. It does not prove
  whether the agent inspected the page before writing the plan.
- Proposal 4550, run `8486f16a8958c406b3aaaea490291cad`, timed out before
  submitting a plan. Its stored trace reports about 98 seconds provisioning
  and 160 seconds in agent exploration, with zero replay time. It stores no
  worker or browser tool timeline, so it cannot establish whether the time
  went to worker startup, model startup, a model response, browser navigation,
  or repeated exploration.
- Proposals 4649 and 4656 also report `evidence_agent_timeout`. Their detailed
  diagnostics are no longer available through the owner diagnostics route.
  They cannot establish the same cause as proposal 4550.
- Local historical replay passed only with plans supplied by the tester.
  Those runs checked browser capture and media creation, not hosted model
  exploration or plan creation. They are not evidence of live agent parity.

## Diagnostic change

For each normal hosted evidence run, the owner-only failed-run diagnostics now
retain a bounded timeline of worker preparation, browser authentication
bootstrap, model startup, model output, evidence/browser tool calls and
results, and the deadline/stop. The provider init event includes tool and MCP
server counts when supplied by the model runner. A tool start without a
matching result is reported as pending. The trace records fixed tool names,
event kinds,
persona, and elapsed milliseconds. It never stores prompts, reasoning, page
text, screenshots, URLs, tool arguments or results, cookies, tokens, or model
responses. The worker emits the events directly while consuming its normal
journal, and the orchestrator persists them on failure, including when the
model turn times out before returning a result.

This patch is **diagnostics only**. It does not claim to repair either failure.
The timeout cause cannot be identified to high confidence from the old runs;
a normal hosted rerun with this code must supply the missing event sequence.

## Next normal-flow check after deployment

1. Rerun visual evidence on proposal 4550 through the owner route, without
   an author-supplied plan. Keep its accepted intent and exact revision.
2. Read the new failed-run diagnostics. The last completed event and pending
   tool locate the boundary that consumed the budget:
   - no `provider_dispatched`: worker preparation or dispatch;
   - dispatched but no `provider_init`: runner, browser bootstrap, or MCP
     startup (the last `runner_phase` distinguishes them);
   - initialized but no `first_output`: model request/startup;
   - pending browser tool: the named browser operation;
   - many completed browser calls but no `evidence_run_plan`: exploration or
     plan-generation budget/strategy.
3. Fix the identified boundary, then rerun the same historical case and the
   4676 locator case through the hosted agent. Require a plan submitted by
   that agent, two clean platform replays, stored media, and human review.
   A deterministic author-plan replay is a separate capture check.
