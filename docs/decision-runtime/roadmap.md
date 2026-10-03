# Lifecycle migration: current roadmap

3 October 2026. The accepted sync revision `8ed150abf` is reconciled with
explicitly pinned canonical main `da6ecb00880cab9a1749a6256992fb3d1706d9be`
at local merge `ab2f0411234eab1dec154b446c1189ac220dc52b`. Its newer bot
recovery/activity, agent prompt/capability, UI and connector behavior is preserved.
Ordinary native Kubernetes/kpack manual requests now reuse the established owner,
with separate native authority and stable manual-intent receipts. Their admission
switch (`PREVIEW_NATIVE_MANUAL_ENABLED`) is separately default-off.
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
| Manual enrolled requests | Real HTTP/disposable PostgreSQL proves durable join/guarded repair/forced recheck, rollback and lost-response recovery. Web pending/build/publication/capture ownership is excluded for enrollment. Ordinary non-headless native Kubernetes/kpack deploy/ensure/recheck now have explicit source/actor/review guards, atomic work and completed-request retry receipts. Docker, headless and unenrolled/default-off callers retain legacy behavior. Unused chat-file Docker builder/parser removed. |
| Enrolled Sync with main | Trusted worker revision acceptance and complete preparation admission commit together. Serving pointers, approval epoch policy, summary freshness and shots invalidation are preserved. Disabled admission retains explicit reconciliation; duplicate/lost replies and supersession use the same durable owner. Unenrolled writers/tails remain. |
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
is required. Manual enrolled entry points and active/promoted enrolled sync are bounded cutovers. Native manual admission and ordinary native app-repository changed-head fork submission (active/paused/promoted) are bounded cutovers too. Unenrolled sync and the other caller rows remain open.

Remaining implementation: ordinary hosted/imported/promotion/headless/Docker/fleet
admission, remaining head invalidation, recovery/teardown, Docker resource preparation and
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

## Native manual verification and remaining boundary

See the [native manual contract](native-manual-preview-contract.md). Native sessions
retain `source NULL/native` and never acquire CLI upload/head pins. Existing complete
preparation, conditional activation, continuation, atomic settlement/gates, manifest
harvest and retirement are shared. The `cli_*` table/work identifiers are retained
wire/storage names; ordinary manifests use `durableNative` and `previewFlowId`.
Manual request receipts survive completion and attempt retirement.

Hosted/promotion/fleet/Docker/imported head writers are not migrated by this slice.
A mismatched persisted head reports `native_head_admission_required`, owned by native
admission; a recovery tail cannot claim the old work is the new head's work. Finish
those caller rows before enablement: this containment is not their automatic head
admission. Global legacy timers/locks and 16 projection statements remain required
for other callers. No rollout or production installation proof is implied.


Enrolled native same-head metadata delivery is now a validated command, separate
from observational recovery. Metadata and required continuation commit together;
duplicate receipts survive completion. Unresolved consumers/admission yield an
explicit waiting outcome, without a detached required kick. See the
[native recheck contract](native-recheck-contract.md). This correction does not
close any remaining head-writer/caller or installation gate above.


Current bounded submission evidence: [native changed-head contract](native-changed-head-contract.md).
It removes competing web staging/check ownership from the selected fork-update
caller, preserving review policy and serving resources. Git-to-database acceptance
still requires producer retry if interrupted before the transaction. The full
caller/ownership checklist remains the merge gate; this is not pilot completion
or enablement.
