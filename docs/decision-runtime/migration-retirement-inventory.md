# Migration simplification checkpoint

1 October 2026. Acceptance requires both demonstrated guarantees and removal of
replaced ownership/machinery. Another opt-in path alone is not migration progress.
Keep current protections until their replacement is proved. No production cutover
or deletion is authorized by this inventory.

| Temporary item | Intended replacement | Removal gate |
| --- | --- | --- |
| `native-preview-prepare`, `native-preview-template-prepare`, `native-preview-kpack-prepare` and their checkpoint branches | One complete recoverable native Kubernetes preparation contract | Prove actual clone → Build → runtime → separate activation/recovery; inventory and drain/finish retained old work. Do not reinterpret queued payloads. |
| Layered experiment admission flags (`nativePreviewAttempts`, worker/clone/build/runtime flags) | One bounded caller's supported admission policy | Complete-path proof and explicit caller cutover; confirm no caller or retained work depends on old flags. Keep admission and recovery ownership separate. |
| Frozen experimental reducer versions | Supported decision contract versions for retained traces/work | Audit real persisted versions and promised trace retention. Preserve replay where required; archive development-only history in Git/fixtures, not automatically in production runtime forever. |
| Long-held PostgreSQL staging/retention/lifecycle session locks (`advisory-locks.js`, `build-retention-guard.js`) and process-local queue (`staging.js`) | Proven attempt isolation, externally fenced database retirement, conditional activation and one durable execution owner | Complete-path/caller proof under interruption/overlap. Keep locks while any shared-resource/legacy writer needs them; partial resource isolation alone does not replace them. |
| Synchronous `staging.js` + `preview-flow/native.js` / `candidate-native.js` plus durable `preview-flow/work.js` | One preparation/publication owner for the selected caller | Cut over one real caller and remove its old dispatch/recovery path together; explicitly exclude other callers until their own cutovers. |
| `preview-flow/cleanup.start` and `build-retention` recovery timers plus durable `work.census` / `scripts/preview-preparation-worker.js` and `execution/service.js` | One discoverable, fair recovery owner per admitted contract | Inventory admitted work/resource locators and consumers; demonstrate worker restart/recovery before removing the selected owner's old timer. Do not orphan retained work. |
| C5 indefinite clone retention after Deployment submission (replaced in C6) | Existing clone ownership/retired-role/NOLOGIN/forced-drop fence | C6 proves connections, delayed Pods, lost replies/restarts and successor protection. Runtime creation obligations and retired roles remain discoverable; database release is not creator closure. |
| Role/runtime/Build tombstones and retained artifacts | Explicitly proven retention/compaction policy | No current expiry/removal gate. Elapsed time or absence is insufficient; preserve required identities and recovery ownership. |
| Injected Build/clone phases in C5 runtime proof (replaced as complete-path evidence in C7) | Actual staging source → clone → kpack → candidate runtime → accepted candidate | C7 uses actual services/output and preserves identities across interruption/lost replies. Focused injected regressions remain useful and explicitly labeled. Fixture template selection and HTTP transport remain substitutions. |
| A separately constructed clone inspector and legacy existence/removal branch in the Kubernetes preparation path (bypassed in C7) | Named `prepareClone` from the same worker-owned service that creates/retires the clone | C7 verifies source first, then the actual clone, Build and runtime. Keep older work kinds' dispatch while retained work depends on it; no legacy builder/cleanup path may take ownership of this path's database. |
| Repeated staging source fetch and retry-local diagnostics while a Build is pending | A bounded source/recipe preparation boundary within the selected execution contract | Measure at caller cutover; retain exact revision verification. No new source cache/work kind added by C7. This is an execution inefficiency, not evidence of duplicate external creation. |

Next sequence: C6 safe release and C7 complete-path proof → cut over one bounded
caller and remove its duplicate ownership. Do not expand to
additional workflows before this replacement is demonstrated. Track the mechanisms
actually removed, retained compatibility obligations, and remaining guarantees.

Version review at C6: `reducer.js` uses v9 for live decisions and v1–v8 only for
historical replay. Explicit historical fixtures cover v1 (`preview-flow.test.js`),
v3/v4 (`preview-candidate.test.js`) and v8 (`recoverable-preview-runtime.test.js`).
v2/v5/v6/v7 have no separately named replay fixtures. None of these older versions
is a distinct live reducer selected by a caller. Canonical main at the recorded
revision lacks this experimental directory, and this session has not deployed it;
that is repository evidence, not an inventory of every retained deployment/trace.
Keep existing replay support during C6. Before cutover, inventory persisted
`preview_flow_decisions.reducer_version` and retained exported traces/work, then
choose supported versions and archive unsupported development-only versions with
their fixtures in Git. Do not infer safe removal from missing test coverage. C6
changes no reducer policy/action schema, so it adds no frozen reducer version.

Current `native-preview-kubernetes-prepare` and `native-preview-retire` remain the
selected experiment's preparation/recovery owners. Complete-path proof should
replace older preparation kinds for one caller; creator obligations must keep a
recovery owner until a separate closure/compaction contract is proved. B2/C2 reuse
is retained; further workflow expansion waits for the caller replacement above.

## Bounded caller selected after C7

Select native CLI handoff **on Kubernetes/kpack** entering
`src/routes/proposal-handoff.js` → `handoff-pipeline.startHandoffPipeline` /
`runStaging`. Exclude Docker, imported proposals and hosted/local Dev sessions
sharing that module. No caller was changed by C7.

The competing preparation owner to remove for this caller is
`preview-flow/native.prepareNativePreview` →
`candidate-native.prepareCandidatePreview` →
`staging.buildAndDeployStaging`: synchronous admission/resource reservation,
process-local build queue, receipt consumption, inline failure cleanup and
activation. Replace its preparation with atomic `work.request` and the existing
external worker. Activation stays separately authorized after accepted candidate
completion. Its staging-ready notification/edge verification/checks continuation
needs a recoverable, deduplicated completion boundary before this caller can be
called migrated; a detached web promise is insufficient.

The cutover must also close alternate entry points for **enrolled attempts**:
`staging-recovery.rebuildSessionStaging` calls `staging.buildAndDeployStaging`
directly; `routes/sessions.js`'s preview-click and
`staging-recovery.recheckSessionChecks` enter that rebuilding path. Route this
cohort's preparation/recovery through its durable owner rather than admitting a
second synchronous builder. Replace preview-preparation uses of
`handoffPipelines`/`active-workers` with durable ownership checks; preserve
submission serialization and unrelated checks/Dev-worker coordination. Remove
selected cleanup timer dispatch only after inventorying its retained locators and
moving every obligation to durable discovery. Shared timers/locks required by
other callers stay. Their deletion is not implied by one caller's cutover.

Acceptance for that subsequent slice: a lost submit/completion reply and web or
worker restart cannot create duplicate work or lose the continuation; supersession
cannot activate an obsolete candidate; every selected rebuild/cleanup entry has
one owner; record the old branches/flags/process ownership actually removed and
the retained compatibility obligations. No production rollout is authorized here.

## C8: selected ownership replaced, default-off

The Kubernetes/kpack CLI submit route now accepts its head, details, pending checks
and `native-preview-kubernetes-prepare` request in one shared transaction. Accepted
candidate completion atomically admits `native-cli-preview-continuation` on the
existing execution store. This is a named handler using shared scheduling,
deduplication, claims and traces; it adds no execution framework or unrelated flow.

| Old ownership removed for enrolled sessions | Replacement / retained boundary |
| --- | --- |
| Submit route's detached `startHandoffPipeline` preparation and promoted managed revision's import checker dispatch | Atomic CLI admission; the external worker owns preparation and its durable completion handoff. GitHub/submission serialization remains. |
| `native` → `candidate-native` → synchronous `staging.buildAndDeployStaging`, its local queue and inline cleanup/activation | Attempt-specific preparation, recurring retirement work and separately authorized continuation activation. Those old functions remain for unenrolled callers. |
| Preview-click rebuild, `staging-recovery` rebuild/recheck and native `pr-import-sync` preparation dispatch | Join the persisted CLI owner. An explicit retry/repair may admit a fresh attempt only under current domain permission and observed-runtime guard. No fallback with switches off. |
| Old request paths superseding an enrolled preview before reaching the builder fence | Preview v10 checks the persisted admission identity under the shared aggregate transaction. A rejected competing action creates no new flow. |
| Web activation recovery timer consuming an enrolled desired binding | The durable continuation worker inspects/reconciles activation. Timer dispatch remains for other callers; bounded cleanup already belongs to worker discovery. |
| Preparation/check continuation depending on `handoffPipelines` and `active-workers` process lifetime | Durable work identities after admission. Short GitHub/admission coordination and unrelated caller coordination retain their process-local protections. |
| Layered preparation flags required to enable this caller | One default-off CLI admission switch scopes the complete preparation capabilities inside this owner. Recovery follows persisted enrollment; other experiments retain their old admission flags. |
| Expected image/runtime waiting logged as staging build failure | Informational waiting diagnostics; actual adapter errors still log failure. |

The continuation kind remains necessary until activation/checks have another proven
durable owner. Retire it only after draining retained work and moving every pending
obligation. Old preparation payloads remain interpreted by their original work
kind; C8 emits only the complete runtime preparation kind. The worker's behavior
is selected by persisted payload/kind, not by reopening old caller dispatch.

Retained compatibility review: v10 is the live preview reducer; v9 is frozen and
has an explicit replay regression. No production refactor rollout occurred. The
disposable test schemas are dropped and their trace samples remain in test/log
evidence. This is not proof that all retained developer work/exported traces are
gone, so existing historical replay remains pending a concrete retention audit.
Neither C8's new CLI reducer v1 nor preview v10 is a permanent production support
promise merely because it existed at a checkpoint.

**Still retained:** shared resource/session locks, legacy callers, orphan-check
harvest/cancellation, at-least-once capture/notification delivery, and recurring
late-creation/database retirement obligations. Public capture/check Jobs and
production ingress behavior were not proved by injected checks/local API binding.
Next, review retained obligations and prove the real checks continuation for this
same caller before considering wider rollout or more workflows. Prune only owners
whose replacement and retained-data gate have both been demonstrated.

## C9: same checks owner survives worker loss

For enrolled CLI continuation only, replace restart-time cancellation/recapture of
an existing run with inspection under the existing lifecycle resource lock and
`check-harvest` adoption. A terminal verdict alone no longer completes the durable
continuation: current-head manifest/lifecycle obligations must be released. Loss
after verdict commit closes as completed, preserving explicit same-head rechecks.
Required manifests precede Job creation; failed launch/settlement keeps its locator.
Run-tagged input Secrets plus UID-checked retirement recover the lost-Job-reply gap.

**Ownership actually removed:** this enrolled restart no longer replaces a
recoverable running Job, and no longer treats verdict persistence as completion
while its check run still owns release work. Settlement still uses the existing
harvester and guarded pools. No check executor, timer or shared lock was deleted;
legacy callers retain their cancellation/re-drive policy. The durable continuation
kind and existing lifecycle/harvest owners remain necessary.

| Retained item | Removal gate |
| --- | --- |
| `recoverExisting` / manifest `durableCli` marker | One supported checks admission/recovery contract plus a retained C8 manifest audit; other callers still use best-effort manifests. |
| Missing submitted capture locator | Persisted creator closure or explicit operator reconciliation; elapsed time/absence cannot authorize forgetting it or a competing capture. |
| Legacy harvest global ticker and oldest-50 selection | Inventory legacy obligations and prove fair scheduling/cleanup replacement; targeted enrolled inspection does not replace the global owner. |
| CLI reducer v1 replay snapshot, v2 current guard | Retained work/exported-trace audit; no permanent support obligation inferred from an experimental checkpoint. |
| Post-verdict diagnostics/media, shots and merge/release | Keep their documented independent owners; checks completion does not guarantee delivery of every subsequent artifact. |

Actual isolated Chromium Job recovery, verdict-commit interruption and stale-output
rejection are demonstrated. Unit-suite Job/private-user/public-edge/production
compatibility remain unproved. A submitted Job that never appears stays pending
for reconciliation; this safety containment is an explicit liveness limit. Default
off, no broader caller migration or rollout. See the C9 contract and local ledger.
