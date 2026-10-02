# Contained CLI consolidation and retirement inventory

2 October 2026. Admission checkpoint `2bf702dbd` now incorporates canonical main
`d600eb4308b0d283ba050addf4c19c915078086c`. This replaces the
checkpoint-by-checkpoint inventory with current removal decisions. The
[roadmap](roadmap.md) defines completion; earlier evidence remains in contracts,
Git history and the local ledger. Admission consolidation below is implemented
locally; old recovery/replay formats remain. The [integration record](canonical-integration.md)
documents canonical reconciliation and current validation. No rollout or production change.
Current accepted implementation is `d24b0c0dd`. The
[supported CLI review](supported-cli-contract-review.md) pins current behavior,
retention decisions and bounded boundary verification. Canonical
`4c0ef27fb7381e9ecb89e2732e6c2c784b9395c6` was reviewed but is not integrated.

## What is replaced for this cohort

Only enrolled native CLI Kubernetes/kpack uses the complete durable preparation
and continuation. Its former synchronous preparation/local queue/inline activation,
alternate rebuild dispatch, restart cancellation/recapture, adapter-owned input
release, settlement-time manifest deletion, best-effort verdict/history composition and detached required gate kicks are replaced. The same functions
or policies may still serve unenrolled callers; removing their selected dispatch
is not permission to delete their global protection.

## Current inventory

| Item | Decision / replacement | Removal gate |
| --- | --- | --- |
| Three early durable preparation kinds: `native-preview-prepare`, `native-preview-template-prepare`, `native-preview-kpack-prepare` (v1) | **Emission removed.** No retained live instance established in this review; recovery dispatch stays temporarily for unknown stores. Current complete preparation, retirement, CLI continuation, gate and review delivery handlers remain supported. | Delete early handlers/exclusive branches only after named stores have no unfinished work or dependent obligations, or those are safely drained. Include succeeded/blocked work and detached resources. Never rename old payloads to the complete kind. |
| `nativePreviewWorkerEnabled` and three `nativePreviewRecoverable*` booleans | Removed from admission and the CLI config shim. New work always includes clone, image and runtime operations under the existing default-off CLI policy. | Keep admission separate from recovery. Direct experiment tests must use the supported contract; old persisted kind recovery cannot depend on current flags. |
| `nativePreviewAttempts` / `PREVIEW_NATIVE_ATTEMPTS_ENABLED` | Still selects synchronous `native` → `candidate-native` for unenrolled callers. Durable CLI admission no longer supplies or depends on it. | Its redundant durable-admission/shim use is removed, **not** the synchronous feature or activation/cleanup protections. Delete globally only after its callers/retained candidates are handled. |
| Preview frozen v1–v9; CLI v1–v2; review v1 | Replay-only; live versions are preview v10, CLI v3, review v2, settlement v1. Old work recovery and receipt retry do not execute frozen reducers. | Remove from runtime after named trace/export policy and reproducible offline archive/goldens. Preview v9 requires v8. No explicit golden was found for preview v2/v5/v6/v7; external trace inventory is unknown, not zero. Old request parser support has a separate retry gate. |
| One-shot runtime observation/start branches and staging `preparedClone` / `onRuntimeStarting` | Early durable kinds use these; complete preparation uses named operations. `onClonePrepared` remains used by synchronous `candidate-native`; current complete completion still writes creation checkpoints. | Prune exclusive dispatch only with old handlers. Check `RequestCandidateRuntime` receipts/callers before removing its parser/guard. Do not blanket-remove callbacks/checkpoint fields, shared candidate verification or clone/build provenance guards. Optional `runScript`/desired-spec fields also represent current reservation phases. |
| `recoverExisting`, persisted `durableCli`, `operation.durableChecks`, `retainInputForRetirement` | Required ownership selection, not redundant rollout switches. Unmarked manifests select legacy cleanup/redrive and best-effort settlement even in an enrolled session; enrolled dispatch rejoins the durable owner but does not upgrade those guarantees. | Retain while contracts coexist. An in-memory marker selects a persisted owner; it cannot grant admission or stand in for the manifest. |
| Older durable manifests without `unitSuite`/retirement progress; missing-manifest recovery branch | Unknown companion creation stays conservative. An enrolled pending missing manifest now gets a conservative locator and explicit block, instead of fresh execution. Provisional launches cannot re-drive or forget unknown creation. Known retirement resumes from observed identities; manifest deletion can still precede final lifecycle closure. | Inventory manifests/lifecycle rows. Remove only old-format compatibility after they are handled; preserve current final-closure recovery. Do not turn absence into an exemption or discard a late-creation locator. |
| Session staging/lifecycle locks, build-retention guard/fail-stop, staging process queue | Legacy/shared resource and check-consumer boundaries remain; complete candidate isolation does not fence all stable binding/legacy mutations or build retention. | Keep. Narrow/remove only through demonstrated replacement tests and writer/consumer audit, not as part of pruning checkpoint variants. |
| Web cleanup/activation recovery, build retention and global check harvest/recovery timers | Preview cleanup excludes `preparation_owner = bounded`; activation recovery excludes the enrolled desired flow. Worker census/continuation owns this cohort; global owners still cover other work. | Keep these exclusions and legacy owners. No global timer can be removed by this cohort consolidation. Legacy oldest-50 harvest fairness remains a separate limit. |
| Attempt/Build/runtime/role tombstones, manifests and recurring retirement | Preserve unknown late creation and dependency fences. Database release is distinct from creator closure. | No age/absence-based expiry. Retain locators until creator termination/reconciliation is proven. Do not delete resource records because preparation work says `succeeded`. |
| Enrolled verdict/history and detached merge/bot kicks | Replaced by `cli-checks-settlement` actions/receipts and `native-cli-check-gate` delivery using the existing shared decision/execution runtime. Live and harvested runs share one mapping. Optional artifacts retain separate best-effort ownership. | No new scheduler, timer or external merge owner. Keep legacy wrappers and existing merge/bot policies for other callers. Old terminal verdicts without receipts require retained-store reconciliation; never backfill by recounting unknown history. |
| Worker reliance on web SDK initialization / silent merge-delivery success when GitHub is absent | **Removed** by `d24b0c0dd`: initialize SDKs before claiming; missing prerequisites retain the same durable request with bounded retry. Domain no-op and successful policy invocation are distinct. | Complete locally; fresh-process and disposable PostgreSQL evidence exists. External GitHub effects and packaged worker installation remain unproved. |

Sources: [admission/handlers](../../src/services/preview-flow/work.js),
[CLI owner](../../src/services/cli-preview-handoff/work.js),
[live/replay reducers](../../src/services/preview-flow/reducer.js),
[synchronous adapter](../../src/services/preview-flow/native.js),
[staging](../../src/services/staging.js), [cleanup selection](../../src/services/preview-flow/cleanup.js),
[activation selection](../../src/services/preview-flow/activation.js),
[checks recovery](../../src/services/cli-preview-handoff/checks.js),
[retirement](../../src/services/check-retirement.js),
[legacy writers](../../src/services/preview-flow/legacy-writers.json).

## Retained-data findings and gate

Admission code now emits only the complete kind, behind the default-off policy. Historical regression
fixtures seed original payloads explicitly through test-only code; there is no
production option to admit an early durable kind. The dedicated worker still
registers all early handlers. Removing one handler without a data gate is unsafe:
`execution/store.claim` selects only registered kinds,
so that work would silently stop being claimed, rather than become explicitly blocked.

The updated bounded audit found **14** local Kubernetes fixture setup journals
marked `torn-down`; recorded owned teardown evidence exists in the ledger. All
**seven** discovered PostgreSQL fixture manifests passed metadata validation;
local read-only Docker selection by exact fixture label found no container.
No database was connected and no row inventory is claimed. No standalone decision
trace export was found in the searched repository decision docs/test fixtures.
Logs, test assertions and private evidence remain. Other developer databases,
failed-test schemas outside those fixtures, backups and external exports are
**unknown**. See the review for the exact search/authority boundary.
Canonical main has none of the new decision/execution/preview/CLI directories;
this session has not deployed them. No production destination was contacted.

Before handler/version deletion, record an explicit list of supported retained
stores/exports. Inspect only verified disposable destinations: kind/version/status
counts, work attempts/events, flow/resource intents and receipts, desired/observed
bindings, CLI handoff references, preview/review/CLI decision versions and
`check_runs` manifest markers/companion/retirement journals plus lifecycle and
settlement journals. Include succeeded work, deleted sessions and blocked work: these can still retain cleanup/retry/replay requirements.
Test schemas normally drop in `close()`; interrupted test processes can bypass it.
Missing store/export inventories remain unknown, not zero.

Action retries validate their input and return a stored receipt; they do not rerun
a frozen reducer. Removing a reducer snapshot is therefore different from removing
an action parser or effect handler. Explicit historical assertions cover preview
v1/v3/v4/v8/v9 and CLI v1/v2; review v1 is retained in its dispatcher. Absence of
a fixture for preview v2/v5/v6/v7 is not evidence that their traces may be discarded.
Preview v9 composes v8. `legacy-reducer.js` is **live** delegation and shared cleanup policy, so its name does not make it historical code.
CLI frozen v2 currently imports the live preview enabling conditions. An offline
archive must snapshot that dependency and preserve its golden behavior; merely
copying `versions/` or keeping a Git SHA is insufficient for independent replay.

## Admission consolidation completed; retained-format removals gated

1. **Completed:** complete Kubernetes preparation is the sole new durable format.
   Four capability booleans, three-way partial format selection/assembly and the
   CLI config shim are removed. Default-off CLI/worker switches, persisted
   enrollment, domain guards and recovery with admission off remain. Old registry
   dispatch and replay are unchanged; no schema, reducer or work version changed.
2. Close the retained-store/export gate above. If an early work contract remains,
   retain its original recovery handler until it is drained or explicitly adopted;
   do not add another general compatibility framework. Otherwise delete its three
   constants/handlers, one-shot observation/checkpoint branches and exclusive
   staging callbacks. Preserve failure tests by porting their guarantees to the
   supported complete contract; old checkpoint tests remain historical evidence.
3. Remove runtime replay copies against the review's current-contract support
   policy, a named store/export decision and reproducible offline trace archive.
   Old development checkpoints do not receive permanent runtime support merely
   because they existed. Keep required fixtures/replay available in that archive;
   pin an archive that survives eventual PR squash/history changes. Do not change
   live reducer policy or invent a new permanent version merely for code movement.

This is contract consolidation, not another workflow or rollout. Canonical
integration is now implemented locally; unknown retention does not block simplifying
new admission. Its acceptance is fewer admission variants and obsolete branches,
plus unchanged atomic
admission, fair scheduling, cross-machine coordination, identity-preserving recovery,
continuation handoff, stale-result/cleanup protection and late-creation retention.
Rerun shared decision/execution, complete preparation, CLI, checks and retirement
regressions. Keep all unresolved retention gates explicit. Only the admission
selector and config shim are recorded as removed here; old recovery/replay, shared
execution and legacy safeguards remain.

## Canonical integration and remaining readiness gates

Integrated canonical `d600eb4308b0d283ba050addf4c19c915078086c` (100 commits
absent from the accepted branch, 24 branch commits absent from main). Six content
conflicts were resolved by preserving both contracts: schema, application runtime,
Kubernetes, staging progress, visuals recovery and the DB-tools credential audit.
Canonical notifications, imported fresh-head reconciliation, description behavior,
benchmark recovery exclusions and explicit user/node reporting remain.

New candidate selection persists canonical zone/host placement; retained specs
keep their original host-only recipe without changing identities or spec labels.
Canonical inventory excludes attempt names `sv-p-*`; a regression now explicitly
checks that boundary. Attempt retirement remains under its persisted resource owner.
The writer inventory adds only one reviewed canonical shots-demo fixture exception;
all prior writer fingerprints/counts remain unchanged. No real writer is removed
or made less restricted.

Focused CI now includes shared decision/execution, complete runtime, CLI admission,
checks/retirement and isolation safeguards, with matching path filters. PostgreSQL
tests with injected external operations require verified disposable container/server
ownership ([contract](postgres-test-isolation.md)), run without a Kubernetes fixture and cannot
silently skip the CLI contract. Actual-resource tests still require full dedicated
preflight and remain separate evidence. The workflow provisions an owned tmpfs PostgreSQL container with a verified loopback
destination for its interruption child tests. Its command runs locally;
GitHub execution is unverified until a separately authorized push.

Review the net diff and explicit supported/retained contracts before PR readiness.
Unknown checks resolution, atomic gating and standalone dependency initialization
are implemented with contained verification. The contract/retention and boundary
code review is now complete. Named supported-store/export inventory, reproducible
replay archive/removal and actual packaged HTTP/worker/TLS/private-user verification
remain open. Retained unmarked checks need the explicit reconciliation proof
in that matrix if their stores are supported; enrollment alone does not upgrade
their cleanup or settlement. The [review matrix](supported-cli-contract-review.md) defines their
bounded evidence. Current canonical reconciliation is also still required.
No execution owner, lock, timer, handler or replay version was removed in
integration. No production deployment, worker installation or push is authorized;
default-off code integration is not full migration completion.


## Unknown-check-outcome correction

No new work kind, capability flag, timer or executor. The retained continuation
polls the original run; `check-harvest` remains the reconciliation/retirement owner.
`checks_recovery` records current flow/head/run/reason/owner. Its lifecycle guard
and manifest-owner exclusion use the shared decision transaction; live reducer
v3 is used and v2 is retained only for existing traces. Required recover/replay
support remains subject to the store/export audit, not a permanent checkpoint rule.

For new durable-marked runs, removed authority is **provisional/missing-manifest re-drive**,
implicit “pending forever” for named unknown outcomes, and lifecycle closure after
an inspection exception. Capture deadlines/lost logs no longer fabricate terminal
outcomes. Confirmed failures and graduation policy remain. Legacy re-drive,
lifecycle locks, global harvest timers and best-effort optional artifacts are still
required; none is removed by this correction. Exact-run continuation discovery
cannot be hidden behind batches of retained predecessors; this does not repair
legacy global oldest-50 cleanup scheduling.

Provisional/reconstructed locators intentionally persist after visible cleanup,
including supersession. Removing them requires trustworthy original creation
closure/specification evidence. There is no age-based expiry or operator reset
API here. See [the contract](unknown-check-outcomes-contract.md).
