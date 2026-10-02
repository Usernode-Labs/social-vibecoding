# Lifecycle migration: current roadmap

2 October 2026. Canonical main `d600eb4308b0d283ba050addf4c19c915078086c`
integrated into accepted admission checkpoint `2bf702dbd8651f9877d492f0d21645c24a444668`.
See the [integration record](canonical-integration.md) for fixes and evidence.
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
| Integrate canonical main and CI | Consolidation + verification | **Integrated locally:** canonical behavior, persisted specs, writer inventory and focused CI reconciled. PostgreSQL and disposable-resource failure matrix rerun; CI execution on GitHub remains unverified because no push is authorized. See the integration record. |
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

**Next action:** review the integrated supported contract and retained-store/trace
policy, then address the mandatory unknown-check-outcome and gating-settlement
gaps. New callers remain behind the first supported CLI gate. CI configuration
is validated locally; running it on GitHub requires separate push authorization.
