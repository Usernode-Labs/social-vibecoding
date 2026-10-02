# Lifecycle migration: current roadmap

2 October 2026. Admission consolidation implemented on accepted local checkpoint
`241e0e6cd9ac45e6110382cbc8b4d5e86846f519`; canonical main fetched at
`a15a460a46b42ad370e7326c561d9e00bc9c5157`. Integration remains pending.
The Kubernetes/kpack native CLI cohort remains default-off. No production
compatibility or rollout is claimed. Checkpoint numbers identify historical
evidence; progress means guarantees demonstrated **and replaced machinery removed**.

## Demonstrated guarantees

- **Shared decisions:** validated actions, guards, pure reducers, data-only effects,
  aggregate coordination, deduplication, atomic writes and replayable traces.
  Caught operation errors roll back the composition. A distinct review flow proves reuse.
- **Shared execution:** required work committed with decisions, a separate worker,
  stable work/claim identities, fair retries and bounded discovery. The review
  workflow uses the same delivery machinery without copying it.
- **Recoverable preparation:** actual source → clone → kpack Build → Kubernetes
  candidate in disposable fixtures. Recovery adopts verified database OIDs,
  Build UID/digest and runtime UIDs, including partial creation and lost replies.
  New admission now emits only that complete contract; four capability flags and
  the CLI configuration shim are removed. Retained formats still recover with
  admission disabled.
- **Separate activation:** preparation preserves serving; desired/observed bindings
  and conditional operations protect successors under retained locks.
- **Durable CLI handoff and checks:** atomic head/admission and candidate-to-
  continuation handoff; enrolled rebuilds join that owner. Actual browser/unit Jobs
  are recovered without launching competing executions; stale results are rejected.
- **Recoverable retirement:** existing connections/delayed Pods cannot regain a
  retired clone; checks cleanup resumes after destructive steps. Unknown creation
  stays discoverable. Enrolled synchronous preparation, restart recapture, adapter
  input release and premature manifest removal are replaced; legacy owners remain.

Evidence and fixture substitutions are recorded in the operation contracts and
local ledger. Internal HTTP, seeded templates, selected source/manifest inputs and
injected interruption points do not prove public-edge or installation compatibility.

## Remaining mandatory work

| Deliverable | Kind | Scope / completion evidence |
| --- | --- | --- |
| Consolidate one CLI contract | Consolidation + verification | **New admission consolidated.** Inventory retained work/receipts/manifests/traces before pruning recovery/replay formats. Follow the [removal slice](migration-retirement-inventory.md); keep legacy safeguards. |
| Integrate canonical main and CI | Consolidation + verification; fixes where needed | Reconcile owners/adapters/schema, refresh writer inventory and current focused CI coverage. Rerun real-PG and disposable-resource evidence on the integrated revision. |
| Resolve unknown checks outcomes | New implementation + verification | Explicit recover-or-block outcome and reconciliation owner for unconfirmed creation or lost/expired output. Absence/timeout/lease expiry cannot establish creator closure. |
| Idempotent check gating settlement | New implementation + verification | Verdict, history/graduation and required gate follow-ups commit together or have durable deduplicated delivery. Best-effort `checkHistory.recordRun` does not provide this. Preserve graduation policy. |
| Verify capture/worker boundaries | Verification; adapter changes where needed | Backend revision, public origin/assets/TLS/access, private-user behavior, permissions and compatible restart/admission pause, in isolated fixtures. Current substitutions leave these unproved. |
| Migrate remaining writers | New implementation + consolidation + verification; **after CLI gate** | Hosted/imported/manual/promotion/fleet/head-invalidation/teardown/recovery paths, with explicit policies. Prove Docker separately; retire competing owners and allowlist entries after handling retained work. |
| Correlated status and owner integration | New implementation + verification; full migration | Explain revision, owner, obligation and rejection. Preserve separate shots/governance/merge/release authority and required handoffs. |

## Completion gates

**First supported CLI slice:** only native CLI Kubernetes/kpack is supported by
the new contract. The first five deliverables must pass. Recovery with admission
off must retain one owner, without competing builders or stranded required work.
Document conservative retention, long-held locks and best-effort optional artifacts.
This completes support for the bounded implementation, **not production rollout**.

**Full preview/check migration:** the CLI gate plus the final two deliverables,
all listed callers in both runtimes, one owner per operation and compatible
cutover/restart/rollback rehearsal. Drain/adopt obligations before removing old
writers/recovery authority. Shared reuse remains required and demonstrated.
This scope does not require rewriting every platform lifecycle.

## Optional follow-ups

- Temporal adoption under the preserved [comparison and reconsideration conditions](c0-backend-comparison.md).
- Database-role enforcement beyond the required module/action/CI boundary.
- Source-fetch optimization, narrower locks, automated creator-closure/compaction,
  and stronger delivery of optional media/diagnostics/notifications. Each needs
  its own proof; current protections and locators remain until then.
- Broader turn, merge and release lifecycle refactors after this migration.

**Next action:** canonical integration and verification. Retained recovery/replay
stays until an explicit supported-store/trace decision. No new capability, workflow
or caller expansion before that review.
