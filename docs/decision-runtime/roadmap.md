# Lifecycle migration: current roadmap

2 October 2026. Accepted product `c01dc0687` incorporates explicitly pinned
canonical main `d9cf30cd73a0810be72b199f8b2a194f8c56b793` at merge
`6730b091306c0dcbcf22579548dc2dd273b2f1f7`. Benchmark orphan recovery,
sealed-checkout validity and fresh live approval behavior are preserved.
See the [integration record](canonical-integration.md),
[supported CLI/retention review](supported-cli-contract-review.md) and
[packaged entry-point contract](packaged-cli-entrypoints-contract.md).
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
  the CLI configuration shim are removed. Complete work recovers with admission
  disabled. Historical partial formats and replay dispatch are removed after
  verified offline archival under the fresh-store-only decision.
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
| Current CLI contract | **Consolidation, support decision and archive/removal implemented** | [Fresh-store-only decision](experimental-retention-decision.md): no supported historical store; local physical fixtures are retired. Offline sources/dependencies, goldens and test traces replay independently. Three partial handlers and twelve replay-only reducers are removed. Startup refuses unsupported work/traces; legacy protections remain. |
| Canonical main and CI | **Pinned reconciliation and focused verification complete** | Pinned `d9cf30cd7` is integrated; current focused PostgreSQL, SQL, writer and actual checks/retirement evidence is recorded in the integration contract. GitHub CI/Linux installation is not demonstrated by local coverage. |
| Unknown outcomes and idempotent gating | **Implementation and contained verification complete** | [Unknown outcomes](unknown-check-outcomes-contract.md), [atomic settlement/dependency delivery](idempotent-check-settlement-contract.md). Permanent evidence loss remains explicitly blocked with the original reconciliation owner. Unmarked retained manifests and old terminal verdicts without receipts remain inventory/reconciliation limits; never recount unknown history. No new implementation gate for these accepted corrections. |
| Capture/standalone boundaries | **Packaged HTTP/main/schema/non-root restart proof complete**; remaining compatibility verification | [Packaged proof](packaged-cli-entrypoints-contract.md) records actual clone/Build/runtime/Jobs, stable identities, normal check-heartbeat recovery and durable bot delivery. The source/image tuple is recorded; GitHub/bot effects and internal origin transport remain substituted. Least-privilege RBAC, supervision, protocol edge cases, local TLS/assets and private identity exchange remain. No new workflow/cohort. |
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

**Next action:** prove public HTTPS/private capture and the remaining installation
boundaries. The fresh-only support decision and offline archive/removal are
implemented. Unsupported historical stores require inventory and reconciliation
before reuse. New callers remain behind the first supported CLI gate. Global
legacy inventory and full installation compatibility remain unproved.
GitHub CI requires separate push authorization; this roadmap does not authorize it.
