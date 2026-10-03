# Lifecycle migration: current roadmap

2 October 2026. The internal pilot review and strict unit-source correction
(`ed13ea6fa`) are reconciled with explicitly pinned canonical main
`74276a2fb7002da251e1b3975ae22b81dbc765e3`. Newer discussion/scheduling,
issue-comment identity and shots-worker retirement behavior are preserved.
The native CLI Kubernetes/kpack cohort remains **default-off**. Progress means
guarantees demonstrated **and competing ownership removed**, not growing checkpoint
numbers. No production compatibility, installation or rollout is claimed.

## Demonstrated internal guarantees

| Deliverable | Status / evidence |
| --- | --- |
| Reusable decision foundation | Validated actions, guards, pure reducers, data-only effects, aggregate coordination, atomic state/work/receipt/trace writes. Caught operation errors invalidate the whole transaction. A distinct review workflow proves reuse. |
| Reusable execution foundation | Separate worker, stable identities, bounded/fair claims/retries and discovery. The review workflow reuses scheduling/recovery without a second engine. Temporal adoption is deferred. |
| Complete recoverable preparation | Actual source → clone → kpack → Kubernetes candidate. Partial creation, interruption and lost replies adopt verified OIDs, Build UID/digest and runtime UIDs. Preparation preserves serving; activation has separate authority. |
| Durable CLI continuation/checks | Atomic head/admission and candidate-to-continuation handoff. Enrolled rebuild/restart paths join the same owner. Original browser/unit Jobs and destructive retirement steps recover; unknown creation/output retains reconciliation ownership. |
| Atomic gating settlement | Accepted run/revision receipt, verdict, app-wide history/graduation and required follow-ups commit together. Recovery neither recounts history nor overwrites committed verdicts with errors. Worker dependencies initialize explicitly; unavailable GitHub retains retry ownership. Policy calls are substituted evidence. |
| Ordinary repeated use | **Complete locally at `511e84e35`:** five revisions on one session, overlapping checks/supersession/restarts, four predecessors' active dependencies released, fifth serving and legacy sentinel protected. Original Jobs do not compete; unresolved creators remain discoverable. |
| New admission and retention consolidation | One complete preparation format; four capability flags/config shim and three partial handlers removed. Fresh experimental stores only. Twelve historical reducer copies/live dispatch removed after independently verified replay archive. Legacy protections remain. |
| Manual enrolled requests | Real HTTP/disposable PostgreSQL proves durable join/guarded repair/forced recheck, rollback and lost-response recovery. Web pending/build/publication/capture ownership is excluded for enrollment. Ordinary native manual admission remains open. Unused chat-file Docker builder/parser removed. |
| Verified unit requirement | Enrolled inspection requires a verified exact commit/root tree; present packages also require a matching blob and valid metadata. Inaccessible/unverified source keeps reconciliation ownership; legacy nullable-source skipping and explicit disable/deferral policy remain. Helper tests substitute Octokit transport only. |
| Canonical/focused verification | Explicit pin integrated with newer approval/recovery behavior preserved. Writer inventory, focused PostgreSQL/SQL and disposable checks/retirement proof pass. Actual packaged default web CMD, standalone worker and migration run non-root. GitHub CI/Linux installation is not proved locally. |
| HTTPS/identity boundary | Real TLS, shipped forward-auth/session exchange, private assets and original-Job restart recovery proved for an explicitly authorized account. Ordinary private-project screenshot permission is assessed separately without a fixture grant. |

Exact evidence/substitutions: [support assessment](supported-cli-contract-review.md),
[packaged entry points](packaged-cli-entrypoints-contract.md),
[HTTPS/private capture](https-private-capture-contract.md),
[published predecessor release](published-predecessor-retirement-contract.md).
All test mutation paths require verified disposable destination ownership; a URL
or test flag is insufficient. See [PostgreSQL preflight](postgres-test-isolation.md).

## Current completion target

The CLI pilot is an internal checkpoint, **not the merge deliverable**. The branch
remains unmerged until the original preview/check caller migration and competing
ownership removal are complete. The [completion checklist](preview-check-completion-checklist.md)
maps every remaining caller/mechanism to its replacement, proof and removal gate.
Cutovers reuse the established foundation; no unrelated workflow or new framework
is required. Manual enrolled entry points are the first bounded cutover.

Remaining implementation: ordinary native/hosted/imported/promotion/manual/fleet
admission, head invalidation, recovery/teardown, Docker resource preparation and
correlated ownership/status. Consolidation removes each replaced writer, queue,
timer, flag or compatibility path after its caller/data gate is satisfied.
Canonical reconciliation, failure-path tests and retained-obligation inventories
remain verification gates throughout, rather than a final pilot-only check.

Installation/RBAC and the supported image/schema/protocol tuple remain separate
**enablement verification**. Disposable cluster-admin/TLS-router evidence is not
production installation proof. Admission remains off; no push or deployment.
Fresh-store retention/archive decisions are complete; unknown external developer
stores require named inventory/reconciliation, not permanent formats.

## Completion gates and final owners

**Internal CLI support checkpoint:** the contained native CLI Kubernetes/kpack contract,
complete real preparation, durable checks/gates and repeated-use retirement proofs,
plus an explicitly verified installation/image tuple and stated capture permissions.
Ordinary private screenshots are excluded until their separate permission follow-up
is demonstrated; their absence does not invalidate required checks.
Recovery with admission off must retain one owner; no competing builder, detached
required continuation, restart recapture or best-effort required settlement remains.
Completing this gate does **not** authorize production rollout.

Admission belongs to the authenticated route and validated machine actions.
The shared decision runtime commits authority and required work. The standalone
worker owns preparation, conditional activation, checks continuation and required
gate delivery. Named services reconcile resources. Existing checks lifecycle/
manifest/harvester owns original Jobs and inputs; preview retirement releases
predecessors after verified consumer completion, keeping unresolved creators.

**Full migration:** the CLI gate plus remaining callers in both runtimes, one owner
per operation, correlated outcomes and cutover/restart/rollback verification.
Remove legacy writers only after their callers and retained obligations are handled.
This does not require rewriting every platform lifecycle.

## Separate product follow-up and optional hardening

Ordinary private-project screenshots need a permission-policy decision and a
bounded, verified grant mechanism before being promised. The valid screenshot
identity has no automatic private-project membership. This pre-existing product
gap is outside the preview/check migration; do not conceal it with fixture membership
or admin screenshots. Existing denied-credential/privacy checks remain required.

Narrower locks, database-role enforcement beyond module/CI boundaries, stronger
optional media/notification delivery, source-fetch optimization, terminal artifact
GC and creator/receipt compaction are optional follow-ups. Current locks and
unknown-creation/consumer protections are essential safeguards until replacements
are proved. Terminal experimental Builds/Jobs and registry output/cache are retained;
active dependency release does not establish creator closure or artifact collection.

Temporal reconsideration conditions remain in the [backend comparison](c0-backend-comparison.md).
Broader turn/merge/release refactors follow this migration rather than extending its
acceptance criteria. The [retirement inventory](migration-retirement-inventory.md)
records exactly what is gone and what remains. The original preview/check caller migration continues; no unrelated workflow or
framework expansion is authorized.
