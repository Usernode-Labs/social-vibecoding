# Lifecycle migration: current roadmap

2 October 2026. Canonical main `d600eb4308b0d283ba050addf4c19c915078086c`
integrated into accepted admission checkpoint `2bf702dbd8651f9877d492f0d21645c24a444668`.
See the [integration record](canonical-integration.md) for fixes and evidence.
Current accepted implementation: `d24b0c0dd`; the
[supported CLI/retention review](supported-cli-contract-review.md) compares it with
fetched canonical `4c0ef27fb7381e9ecb89e2732e6c2c784b9395c6`.
That newer canonical revision is **not integrated**; adapter agreement does not
close the canonical freshness gate.
PostgreSQL-only tests additionally require [verified disposable ownership](postgres-test-isolation.md);
a URL or test flag does not authorize mutations.
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
- **Idempotent enrolled check settlement:** one accepted run/revision receipt;
  verdict, history/graduation, trace and required gate requests commit together.
  Same-app history coordinates across sessions; lost replies adopt the verdict.
  Stale reporters cannot consume the valid owner's settlement slot. The shared
  worker owns required delivery; optional artifacts are separate. Standalone SDK
  initialization is explicit; unavailable GitHub retains retry ownership instead
  of falsely completing delivery. GitHub policy calls remain substituted evidence.
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
| Current CLI contract | **Review and new-admission consolidation complete**; remaining inventory/archive/removal | [Contract and retention decisions](supported-cli-contract-review.md) distinguish handlers, receipt retry and replay. Local fixture audit is complete; named supported stores/exports remain unknown. Remove only unused early dispatch and archive-only replay copies after that gate; keep legacy safeguards. |
| Canonical main and CI | Earlier integration complete; **newer reconciliation + verification remaining** | `d600eb43` matrix is demonstrated. Reconcile current canonical benchmark recovery and live approval behavior; refresh schema/writers/CI and rerun on the pinned revision. GitHub CI/Linux installation is not demonstrated by local coverage. |
| Unknown outcomes and idempotent gating | **Implementation and contained verification complete** | [Unknown outcomes](unknown-check-outcomes-contract.md), [atomic settlement/dependency delivery](idempotent-check-settlement-contract.md). Permanent evidence loss remains explicitly blocked with the original reconciliation owner. Unmarked retained manifests and old terminal verdicts without receipts remain inventory/reconciliation limits; never recount unknown history. No new implementation gate for these accepted corrections. |
| Capture/standalone boundaries | **Code review complete; isolated harness work + verification remaining** | Follow the review's concrete matrix: packaged `main`/schema/non-root/RBAC and HTTP admission restarts; exact backend/capture/unit image tuple; local TLS/assets and private identity exchange. Product adapter/preflight changes only where those proofs expose a gap. No new workflow or cohort. |
| Migrate remaining writers | New implementation + consolidation + verification; **after CLI gate** | Hosted/imported/manual/promotion/fleet/head-invalidation/teardown/recovery paths, with explicit policies. Prove Docker separately; retire competing owners and allowlist entries after handling retained work. |
| Correlated status and owner integration | New implementation + verification; full migration | Explain revision, owner, obligation and rejection. Preserve separate shots/governance/merge/release authority and required handoffs. |

## Completion gates

**First supported CLI slice:** only native CLI Kubernetes/kpack is covered by
the intended supported contract. The first four deliverables must pass. Recovery
with admission off must retain one owner, without competing builders or stranded required work.
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

**Next action:** reconcile the pinned current canonical revision, then prove the
actual packaged standalone/HTTP boundary in the disposable fixture. Reconcile
unmarked checks only if a named supported store retains them. Close the
named store/export and replay-archive decision before the removal slice. The
contract/retention review is complete; global retained inventory and installation
proof are not. New callers remain behind the first supported CLI gate. Running
GitHub CI requires separate push authorization; this roadmap does not authorize it.
