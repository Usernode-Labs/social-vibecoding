# Preview/check migration completion checklist

3 October 2026 · integrated canonical pin
`da6ecb00880cab9a1749a6256992fb3d1706d9be` (local merge `ab2f0411234eab1dec154b446c1189ac220dc52b`).
The CLI pilot is an **internal proof, not the merge deliverable**. This branch stays
unmerged while the original preview/check migration is completed. Admission stays
off; no push, deployment or production access is authorized.

Every unchecked row needs implementation and caller-specific verification. A row
closes only when its competing owner is removed, or a narrowly named legacy/data
exception remains with a reconciliation plan. Reusing the existing decision and
execution foundation is required; adding workflows unrelated to preview/checks
is not a completion criterion.

## Caller cutovers

| Remaining caller / current owner | Replacement | Verification and removal criterion |
| --- | --- | --- |
| [Native external handoff](../../src/routes/proposal-handoff.js), [local Dev agent handoff](../../src/services/handoff-pipeline.js), [CLI head sync](../../src/services/cli-handoff-sync.js) | Atomic exact-head acceptance + existing preparation/continuation work, with each caller's authorization and lifecycle policy | CLI path proved internally. **Enrolled active/promoted sync now admits trusted worker revisions atomically, preserving serving pointers; disabled admission retains a reconciliation obligation.** Finish ordinary hosted/native submission tails and unenrolled head adoption; native manual requests have their own source policy. Retry/lost reply and paused/promoted guards; remove submission-tail/process-pipeline ownership and pointer-clearing writers after all consumers migrate. |
| [Manual deploy, ensure, recheck](../../src/routes/sessions.js) | Durable admission or join/guarded repair of existing work; forced checks remain an action | Owner/admin/member and headless policies unchanged. Concurrent clicks, web loss, blocked outcome, supersession, admission-off recovery. Remove detached builders/check kicks and process sets for migrated callers. **Enrolled deploy/ensure/recheck cutover implemented and tested.** **Ordinary non-headless native Kubernetes/kpack manual deploy/ensure/recheck are now cut over, separately default-off.** Actor/source/review guards and a session/UUID receipt make admission atomic and retries stable after completion. Recovery joins with admission off; native fields are preserved. Web builders/publication/pending/detached kicks and process sets are excluded for this cohort. Docker/headless and unenrolled legacy behavior remains. |
| [Hosted interactive/headless/resumed tails](../../src/routes/sessions.js), [boot-recovered tail](../../server.js) | Accepted worker result atomically schedules exact-head preparation; checks continue outside web/worker-chat process | All four completion paths, headless clone behavior, restart after push, overlapping turns and cancellation. Remove direct result publication, synchronous staging tail and detached capture in each path. |
| [Promotion and vote rechecks](../../src/routes/votes.js) | Reviewed-head action joins/requests durable work; required gate delivery retains existing merge/bot policy | Promotion during preparation/checks; missing preview; stale reviewed head; restart before follow-up. Remove post-response builder/recheck ownership and direct publication/pending writes, without changing graduation/voting policy. |
| [Imported PR initial build and changed head](../../src/services/pr-import-sync.js), imported revision checks in [votes](../../src/routes/votes.js) | Explicit imported-head policy and exact repository/revision specification using same execution machinery | Fork-only SHA, mirror changes, closed PR, duplicate poll, stale completion/cleanup; never write the contributor's branch. Remove both import publishers and old-result teardown once retained resources reconcile. |
| [Native head update/invalidation](../../src/services/proposal-update.js), [CLI sync](../../src/services/cli-handoff-sync.js), [handoff route](../../src/routes/proposal-handoff.js) | Aggregate-coordinated head action changes desired state and schedules required preparation/retirement atomically | **Enrolled sync's independent pin/reset writer and detached staging/recheck owners are bypassed and replaced.** Local upload remains distinct from trusted sync; approval epoch, summary and shots policies are composed in admission. **Enrolled ordinary native same-head testing resubmission now atomically admits metadata and required recheck work, with completion-stable duplicate delivery and explicit waiting/blocked outcomes.** Its detached required recheck handoff is excluded. Remaining active/paused/promoted head writers and concurrent upload/turn/promotion still require migration. |
| [Fleet maintenance](../../src/services/fleet-maintenance.js) | Resolve exact source revision, then validated admission/join | No `latest`/null-check revision; concurrent manual/turn request; restart. Remove fleet builder, pointer write and detached capture. Fleet scheduling itself remains adjacent policy. |
| [Recovery/recheck](../../src/services/staging-recovery.js), [boot/heal/idle sweeps](../../server.js) | Discovery reconciles persisted obligations; joins existing work instead of creating another builder/check execution | Lost claims, busy aggregate, admission disabled, unmarked retained resources. Remove migrated rebuild publisher, failure tuple clearing and process recheck ownership; retain named legacy recovery until its inventory drains. |
| [Idle/archive/merge/demo teardown](../../src/services/session-lifecycle.js), [merge](../../src/routes/votes.js), [proposal teardown](../../src/services/proposal-update.js), [reaper](../../src/services/staging-reap.js) | Existing durable preview retirement plus consumer lifecycle/manifest owner | Runtime/clone/input release, delayed creation, published predecessors, worker loss after each destructive step, serving/successor protection. Remove migrated direct teardown/tuple-clear owners; keep unresolved creators discoverable. App deletion/orphan cleanup must explicitly delegate or retain a scoped owner. |
| [App deletion](../../src/routes/apps.js) and orphan cleanup in [reaper](../../src/services/staging-reap.js) | Persist/delegate preview/check retirement before session/resource metadata disappears | Delete during preparation/checks, cascade removal and restart; prove discoverable attempt/Job/input/clone obligations after the app row is gone. Preserve production-app deletion policy; replace only its preview/check handoff and orphan inference. |
| Docker callers through [staging](../../src/services/staging.js) | Same actions/receipts/work contract; explicit Docker resource preparation/activation/reconciliation services | Actual disposable Docker preparation, lost acknowledgments, attempt isolation, stable routing CAS and cleanup. Remove synchronous stable-name replacement and long-held locks only after replacements are proved. Kubernetes proof alone does not close this row. |

## Shared ownership removal

| Mechanism still present | Intended final owner / removal gate |
| --- | --- |
| Direct preview projection writes and [legacy writer allowlist](../../src/services/preview-flow/legacy-writers.json) | Action persistence owns the complete projection. Remove entries as corresponding SQL disappears; retain only named staging/demo fixture exceptions. Audit all occurrences, not just distinct fingerprints. |
| Synchronous native/candidate-native adapters, partial staging metadata writes, `nativePreviewAttempts` | Full preparation work + named resource services. Remove after every caller and retained candidate is handled, not after the CLI proof. |
| `preview_operations` authority, lifecycle locks, session/build queues | One explicit admission/activation/check owner with aggregate coordination and external-resource guards. Inventory each phase/consumer before replacement; independent machine locks and lease expiry are insufficient. No blanket lock removal. |
| `_inFlight`, deferred captures, web activation/cleanup/recovery timers | Shared execution scheduling plus existing check manifest/harvester reconciler. Eliminate duplicate launch/recovery authority; retain timers only for distinct consumer/artifact duties. Verify both work and cleanup fairness. |
| Legacy verdict/history writes and detached required merge/bot kicks | Existing atomic run/revision settlement + deduplicated gate work, including app-wide history coordination. Port each caller's policy; remove best-effort gating ownership. Optional media/notifications remain distinct. |
| Check Jobs, inputs, unmarked/old manifests, consumer leases | Existing lifecycle/manifest/harvester owns creation inspection and recoverable retirement. Drain/adopt retained obligations before deleting compatibility. Unknown outcomes remain visibly blocked with a reconciliation owner. |
| Shots association, stop/rerun/waiver, paired runtimes/databases | Preserve the existing shots owner and artifact policy; explicit revision/run handoff and retirement coordination. Verify stale shots cannot attach to a successor or release a live consumer's dependencies. No new shots executor. |
| Retired attempt/role/resource receipts and historical formats | Fresh experimental stores only; verified offline replay archive. Reconcile any discovered unresolved store before removal. Production/legacy compatibility is a separate retained-data obligation. Tombstones cannot expire merely because resources are absent. |
| Dead `buildStagingFromFiles` / `parseFileChanges` in sessions | **Removed:** no caller or export in the repository. Deleted 120 lines and two imports; no replacement or resource obligation. Generated-Dockerfile guards still pass. |
| Enrolled CLI sync's detached staging/recheck tails and pointer clearing | **Removed for this cohort:** sync uses the shared action transaction and existing complete preparation/continuation. Disabled-admission obligation is reconciled by the handoff owner through bounded discovery or explicit recovery. The two legacy SQL exceptions remain solely for unenrolled callers. |
| Correlated status/error API and request retries | Persisted revision, execution owner, desired/observed state, pending/blocked obligation and rejection; stable client request identities covering response loss even after completion. Verify UI/API projections for each caller; normal waiting must not become build failure. |

## Completion gates

**Merge deliverable:** all caller rows and shared ownership gates above are closed
for the original preview/check scope, with canonical integration, focused SQL/writer/
failure-path checks and actual-resource evidence for supported runtimes. Each
remaining legacy exception names its data/consumer requirement. No competing
preparation/publication/check/retirement owner remains for migrated callers.
The CLI proof and its historical PR drafts are not sufficient.

**Enablement:** separately verify installation/RBAC, privileges, supervised worker,
image/schema/protocol tuple, HTTPS/identity and operating capacity. Existing private
screenshot permissions are a separately recorded product gap, not concealed by
fixture grants. Completing migration does not authorize enablement.

**Outside scope:** new turn/merge/production-release workflows, Temporal adoption,
optional artifact GC and generic execution framework expansion. Existing governance,
merge and infrastructure services keep their policy and external duties; required
preview/check handoffs to them must be durable.

Native manual [contract/evidence](native-manual-preview-contract.md) is a bounded
caller cutover. It does not close hosted, promotion, imported, fleet, Docker,
teardown or head-invalidation rows. Unmigrated head changes expose explicit
`native_head_admission_required` reconciliation rather than competing preparation.

Final manual caller consolidation must also apply the completed-intent receipt
protocol to retained CLI/manual compatibility callers. Their older headerless
join/repair semantics are preserved here; native UUID proof does not silently
claim idempotence for every legacy request. This is a bounded implementation item,
not a new executor or workflow.


Focused correction: [native recheck contract](native-recheck-contract.md). Explicit
native recheck delivery is distinct from observational recovery. The actual
producer/adapter regression uses real disposable PostgreSQL; capture and deletion
are injected. It adds no caller rollout or new actual Kubernetes proof. Optional
shots/PR projections and legacy CLI/unenrolled metadata tails retain their owners.
