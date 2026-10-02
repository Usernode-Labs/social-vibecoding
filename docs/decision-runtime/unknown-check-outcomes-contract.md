# Enrolled CLI checks: unknown outcomes

Scope: the default-off native CLI Kubernetes/kpack cohort. This is a checks
reconciliation correction, not another executor, rollout or caller migration.

## Recover or block

The existing check harvester owns reconciliation of the original run. The CLI
continuation joins it on bounded execution polls. Missing creation replies,
observed absence, heartbeat expiry and a collection deadline do not authorize a
replacement checks run or establish that external creation/consumers stopped.

A matching Job with a verifiable outcome is adopted through the existing
lifecycle, collectors and settlement policies. Capture requires its frame stream;
unit success/failure remains based on verified Job termination, even without TAP
text. No suite result is inferred from absence. If a required Job is absent, an
observed Job disappears, or terminal output cannot be recovered, persist an
explicit blocked outcome identifying the flow, head, run, reason and reconciliation
owner. A provisional launch that did not reach its full manifest also blocks;
this slice does not infer creator closure or repeat its setup. A missing manifest
for an unfinished pending run gets a conservative cleanup locator, retaining that
run's identity and unknown requirements. It cannot be judged from reconstructed
inputs or forgotten on supersession.

A blocked outcome is a domain condition, not a terminal queue failure. The shared
executor retains fair, bounded polls, allowing late work/output to be recovered.
The persisted state and continuation journal distinguish this from normal waiting.
The authenticated proposal-handoff status response exposes the block and owner.
A persisted current verdict plus released manifest/lifecycle permits completion
and clears the block. Existing failing/error/graduation policies remain unchanged;
uncertainty cannot become an invented pass, failure or omitted expected unit row.

## Authority and cleanup

Validated CLI actions, the shared aggregate transaction and pure reducer govern
blocked-state persistence. The current flow/head, lifecycle run and manifest owner
must still match. Block persistence and its decision receipt/trace are atomic.
The observer cannot change a successor's status, verdict or preparation.

Blocked manifests remain discoverable by the harvester. On supersession it retires
only that run's resources through the existing journal and UID/run checks. Unknown
late creation or missing specification remains a retained cleanup obligation;
absence or elapsed time never closes it. Reconstructed missing-manifest inputs are
conservative metadata, not an external creation recipe or permission to capture.
A conflicting resource identity blocks rather than overwrites or deletes it.

Normal inspection/transport errors remain retryable and do not close an enrolled
lifecycle. Continuation discovery selects the exact run, so batches of older
retained obligations cannot hide it. Legacy global oldest-50 selection remains a
separate scheduling limitation. A deadline while a Job still
runs is uncertainty, not proof that the Job failed. An observed terminal failure
with accessible output retains the existing grading/error policy. Missing output
is re-inspected on later polls; this slice adds no log archive, manual override,
creator-closure protocol or automatic reset of a permanently lost run. Such a run
stays explicitly blocked with the harvester as owner until trustworthy evidence
arrives; an operator may diagnose it but this slice adds no unsafe "retry anyway".
Older settled-verdict/manifest-removal gap recovery remains compatible and bounded
to its exact lifecycle run. Retained decision traces keep their prior reducer.

## Verification

Before every mutation, verify disposable PostgreSQL ownership, or the full dedicated
cluster/database/registry preflight for actual resources. Test worker restart and
lost block-write replies, delayed Job appearance, vanished/expired output,
provisional/missing manifests, conflicting owners, terminal failure policy and
supersession. Assert one run/continuation, no competing creation, atomic journals,
retained cleanup, successor/serving preservation and recovery with admission off.
Clearly label injected Kubernetes observations separately from actual-resource
runs. No production access, push or deployment. Idempotent gating settlement and
supported capture/worker compatibility remain separate mandatory gates.


## Demonstrated evidence (2 October 2026)

- Verified disposable PostgreSQL: 25 CLI admission/continuation cases, including
  atomic rollback after blocked-state/manifest writes, lost block-reply adoption,
  restart/admission-off recovery, current owner/run/head/flow guards, delayed Job
  adoption, provisional/missing-manifest retention, temporary inspection failures,
  lost output and discovery behind 55 retained predecessors. External resource
  observations and selected settlement/retirement results in this suite are
  injected; it is transaction evidence, not Kubernetes proof.
- Actual disposable cluster/database/registry: 15 checks/retirement cases. The
  Chromium recovery scenario injects an unavailable-log **reply** after reading
  actual output, then recovers the original run and Job UID when observation
  resumes. A separate actual Job deletion outside the retirement journal produces
  a durable block and retains its locator after supersession. It preserves the
  activated preview and original serving sentinel. Actual companion unit creation
  after observed absence and supersession, plus 12 retirement interruption/lost-
  reply scenarios, remain passing.
- Focused contract suite: 935 passing, no skips. Repository-mapped affected tests:
  8,337 passing, 14 intentionally skipped integration cases; actual-resource
  execution is the separate preflighted run above. SQL: 3,222 unique statements /
  4,117 static variants validated without a dynamic-baseline change. Writer
  inventory remains 16 explicit legacy exceptions.

Fixture substitutions remain the pinned tiny unit repo, source/manifest metadata,
private-origin transport, unauthenticated sample users and injected interruption/
observation failures. This does not establish production origin/TLS/private-user
compatibility, durable log archiving, permanent-loss recovery, globally fair legacy
cleanup or atomic gating/graduation/follow-up settlement. No rollout, caller
migration, production changes, push or deployment.

## References

[Validated action/reducer](../../src/services/cli-preview-handoff/reducer.js),
[atomic persistence](../../src/services/cli-preview-handoff/store.js),
[named observation service](../../src/services/cli-preview-handoff/checks-outcome.js),
[continuation recovery](../../src/services/cli-preview-handoff/checks.js),
[harvester](../../src/services/check-harvest.js),
[live lifecycle](../../src/services/preview-lifecycle.js),
[retirement](../../src/services/check-retirement.js),
[PostgreSQL regressions](../../tests/cli-preview-handoff-postgres.test.js),
[actual browser proof](../../tests/cli-preview-checks-integration.test.js).
