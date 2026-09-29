# Visual evidence failure audit — 25 September 2026

## Scope and method

I paged through all 1,871 merged proposal records returned by Homeroom for
`usernode-2d5619`, then checked the accessible open and promoted proposal
lists. I fetched run diagnostics for 80 failed records in the merged snapshot
and three additional failed records in the other lists. These are **historical
failure records**, not 83 currently failing runs: proposals can be rerun, and
the latest state may change. Archived proposals returned 404 from this
account's API and are outside this inventory.

The platform's run diagnostics were the evidence for each classification.
Where they do not identify a unique cause, the entry remains unresolved. I
did not infer that every old failure still exists on the current deployment.

| Recorded failure code | Count | What the diagnostics show |
| --- | ---: | --- |
| `missing_evidence_replay` | 24 | No accepted executable plan. Nine visible changes carried `impact: none` and zero stories, so the planner had no lawful claim to execute; other records need their individual trace. |
| `evidence_run_interrupted` | 15 | Progress stopped; the old recovery timer left several runs pending for about 25 minutes. A rollout coincided with one recent interruption, but the diagnostics do not prove that every interruption was caused by deployment. |
| `visual_evidence_failed` | 9 | Two database reset read timeouts (#4923, #4924); seven earlier unique-key collisions while scrubbing `registration_code`. The scrub fix was already merged before this audit. |
| `evidence_agent_timeout` | 5 | The hosted planner exhausted its exploration budget. One recent run (#4868) made 47 browser calls; this is not evidence of a browser crash or image-recognition failure. |
| `evidence_agent_failed` | 4 | Planner ended without a passing plan; older traces lack enough detail to assign one common cause. |
| `invalid_visual_evidence` | 4 | The submitted replay had `impact: none` and no stories, although executable replay requires a visible story. |
| `locator_not_found` | 4 | Planned browser targets did not exist at replay time. These predate later locator diagnostics and bounded planner repair work. |
| `browser_diagnostics` | 3 | #4937 reached the claimed screen but retained `ERR_NETWORK_CHANGED` after successful navigation. #4922 had a similar `/health` failure, but its trace does not prove that exact request later succeeded. A separate later rerun of #4935 confirmed the same recovered-navigation defect as #4937. |
| `replay_failed` | 3 | Two initial navigations failed with `ERR_NETWORK_CHANGED`; one older wait timed out. |
| `ambiguous_locator` | 3 | Planned targets were not unique or did not resolve; includes an older Browse flow. |
| Database client limit (`2`) | 2 | PostgreSQL rejected connections with “too many clients already.” Historical database capacity issue, not proof of a visual replay code regression. |
| `missing_replay_result` | 2 | No bounded replay result was recorded. Older telemetry does not prove a single cause. |
| Other individual codes | 5 | One each: `non_reproducible`, Kubernetes job 404, `unexpected_fallback`, `assertion_failed`, `locator_not_visible`. |

## Confirmed current defects and fixes on this branch

1. **Healthy navigation incorrectly failed after a recovered network change.**
   In #4937 and a later rerun of #4935, the initial page navigation retried,
   returned HTTP 200, and all actions/assertions passed, but a first-attempt
   `ERR_NETWORK_CHANGED` remained in browser diagnostics. Replay now discards
   only a failure for the exact request that subsequently succeeded. An
   unresolved failure, a different URL/method, a page exception, and a real
   application console error still fail replay.
2. **Ordinary server JavaScript was classified as UI.** The evidence
   classifier's `tsx?`/`jsx?` pattern matched `.ts` and `.js`, enrolling
   server-only changes such as #4945. Both staging capture and evidence now
   use one file classifier. A genuinely visible change still needs `impact:
   ui` even if it changes only reused text or error state.
3. **A required preview with `impact: none` wasted a hosted planner turn.**
   For #4863 and #4864 the agent received zero accepted stories and correctly
   refused to invent one. The platform now stops before provisioning with an
   explicit intent-conflict reason, and author instructions require a claim.
   This does **not** manufacture evidence for an old proposal whose author
   omitted the claim; a replacement intent and new run are required.
4. **Error states could not be staged honestly.** #4863 needs a failed
   messages GET; #4864 needs a failed account-details GET. An author may now
   declare one exact API GET path. The hosted agent can block it during
   exploration, and deterministic replay blocks it on both revisions,
   requiring a real matching request on each side. The reviewer-visible flow
   explicitly says it is a controlled failure test. The normal success path
   remains available for separate evidence.
5. **Stopped runs took too long to become actionable.** Once a run has a
   durable progress heartbeat, five minutes of silence now ends it with a
   visible interruption reason and manual rerun option. This does not
   automatically spend another model run or assert that deployment was the
   cause. Older runs without a heartbeat keep the legacy grace period.

## What remains to verify

- The first post-deploy #4937 rerun (`4d4e3721611aaecc3cf7aacebeb1bb07`)
  failed at `worker_prepare_start`, before model exploration or browser replay.
  Kubernetes refused a new `sv-worker-s4937-state` PVC: the worker namespace
  had reached both limits, 120/120 claims and 600/600 GiB requested. This
  result does not test the recovered-navigation fix. Evidence planners for
  imported or already merged proposals now use temporary pod storage and
  release the worker after the run, including failure. Active native coding
  sessions retain their resumable PVCs. Concurrent PR #3118 can reclaim idle
  volumes under quota pressure; this evidence fix does not rely on freeing
  another session's storage. The exact owners of the 120 claims at failure
  were not inspected, so their individual retention status remains unknown.
  PR #3118 also blocked all evidence scheduling after merge; this follow-up
  preserves its automatic stop while allowing an explicit manual rerun.
- Once the temporary-worker change deploys, rerun #4937/#4935 to confirm the
  recovered-navigation fix under a normal Homeroom run. A passing local test
  alone does not prove the production browser behaves identically.
- Rerun #4863/#4864 with **new, truthful UI intent** and a controlled failure
  plan after deployment; their old `impact: none` declarations cannot be
  repaired by replaying the same intent.
- A #4923 rerun started at 12:59:44 UTC and stopped reporting progress at
  `checkout_revisions` immediately. The old recovery sweep marked it
  `evidence_run_interrupted` at 13:24:26. The production `/api/version`
  endpoint reports a deployment starting at 13:10:16, but the missing
  heartbeat predates that deployment by about ten minutes; deployment alone
  is not an established cause. This attempt never reached database reset,
  so it cannot establish whether the already merged serial reset fix removed
  the earlier timeout. Rerun #4923 and then #4924 only once the platform is
  stable enough to keep progress heartbeats.
- #4885 passed both replays but produced different base screenshots (perceptual
  hash distance 10 on the phone viewport). The old run did not retain both
  screenshots, so the changing pixels and cause are unknown. Do not weaken
  reproducibility checks just to make it pass.
- The old Kubernetes job 404, database client-limit failures, and agent
  exploration timeouts need a fresh recurrence with current telemetry before
  changing infrastructure or budgets. The historical records alone do not
  support a safe generic fix.
