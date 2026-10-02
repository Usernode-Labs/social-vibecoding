# Contained CLI consolidation and retirement inventory

2 October 2026. Consolidation on local `241e0e6cd9ac45e6110382cbc8b4d5e86846f519`;
canonical main `a15a460a46b42ad370e7326c561d9e00bc9c5157`. This replaces the
checkpoint-by-checkpoint inventory with current removal decisions. The
[roadmap](roadmap.md) defines completion; earlier evidence remains in contracts,
Git history and the local ledger. Admission consolidation below is implemented
locally; old recovery/replay formats remain. No rollout or production change.

## What is replaced for this cohort

Only enrolled native CLI Kubernetes/kpack uses the complete durable preparation
and continuation. Its former synchronous preparation/local queue/inline activation,
alternate rebuild dispatch, restart cancellation/recapture, adapter-owned input
release and settlement-time manifest deletion are replaced. The same functions
or policies may still serve unenrolled callers; removing their selected dispatch
is not permission to delete their global protection.

## Current inventory

| Item | Decision / replacement | Removal gate |
| --- | --- | --- |
| Three early durable preparation kinds: `native-preview-prepare`, `native-preview-template-prepare`, `native-preview-kpack-prepare` | No longer emitted by new admission; it always uses `native-preview-kubernetes-prepare`; keep `native-preview-retire` and `native-cli-preview-continuation`. | Stop emitting early kinds first. Delete handlers/checkpoint branches only after retained queued/running/blocked work and their resource obligations are inventoried and finished/adopted under the original contract. Never rename a persisted payload to the new kind. |
| `nativePreviewWorkerEnabled` and three `nativePreviewRecoverable*` booleans | Removed from admission and the CLI config shim. New work always includes clone, image and runtime operations under the existing default-off CLI policy. | Keep admission separate from recovery. Direct experiment tests must use the supported contract; old persisted kind recovery cannot depend on current flags. |
| `nativePreviewAttempts` / `PREVIEW_NATIVE_ATTEMPTS_ENABLED` | Still selects synchronous `native` → `candidate-native` for unenrolled callers. Durable CLI admission no longer supplies or depends on it. | Its redundant durable-admission/shim use is removed, **not** the synchronous feature or activation/cleanup protections. Delete globally only after its callers/retained candidates are handled. |
| Preview frozen v1–v9; CLI v1; review v1 | Historical replay only; live versions are preview v10, CLI v2, review v2. Old copies are not alternative live state machines. | Define which persisted/exported traces retain replay support. Development checkpoints alone do not require permanent runtime copies. Preserve a reproducible archive for retained traces before removing versions from runtime; v9 requires v8. |
| Old one-shot runtime observer/creation checkpoints and staging `preparedClone` / `onRuntimeStarting` callbacks | Needed by the three early durable kinds; complete path uses named clone/image/runtime operations and persisted resource submissions. | Remove with old handlers. `startCandidateRuntime` and its old action/receipt compatibility need their own usage/retention check; do not delete shared candidate verification or current clone/build provenance guards. |
| `recoverExisting`, persisted `durableCli`, `operation.durableChecks`, `retainInputForRetirement` | Required ownership selection, not redundant rollout switches. Existing legacy manifests/adapters have different cleanup/re-drive behavior. | Retain while contracts coexist. An in-memory marker selects a persisted owner; it cannot grant admission or stand in for the manifest. |
| Older durable manifests without `unitSuite`/retirement progress; missing-manifest recovery branch | Unknown companion creation stays conservative. Known retirement resumes from observed identities; manifest deletion can still precede final lifecycle closure. | Inventory manifests/lifecycle rows. Remove only old-format compatibility after they are handled; preserve current final-closure recovery. Do not turn absence into an exemption or discard a late-creation locator. |
| Session staging/lifecycle locks, build-retention guard/fail-stop, staging process queue | Legacy/shared resource and check-consumer boundaries remain; complete candidate isolation does not fence all stable binding/legacy mutations or build retention. | Keep. Narrow/remove only through demonstrated replacement tests and writer/consumer audit, not as part of pruning checkpoint variants. |
| Web cleanup/activation recovery, build retention and global check harvest/recovery timers | Preview cleanup excludes `preparation_owner = bounded`; activation recovery excludes the enrolled desired flow. Worker census/continuation owns this cohort; global owners still cover other work. | Keep these exclusions and legacy owners. No global timer can be removed by this cohort consolidation. Legacy oldest-50 harvest fairness remains a separate limit. |
| Attempt/Build/runtime/role tombstones, manifests and recurring retirement | Preserve unknown late creation and dependency fences. Database release is distinct from creator closure. | No age/absence-based expiry. Retain locators until creator termination/reconciliation is proven. Do not delete resource records because preparation work says `succeeded`. |

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

Production admission now emits only the complete kind. Historical regression
fixtures seed original payloads explicitly through test-only code; there is no
production option to admit an early durable kind. The dedicated worker still
registers all early handlers. Removing one handler without a data gate is unsafe:
`execution/store.claim` selects only registered kinds,
so that work would silently stop being claimed, rather than become explicitly blocked.

The ten local fixtures inspected during the audit, and the new consolidation
fixture, have setup records marked `torn-down`.
Recorded owned-resource teardown evidence exists for the later accepted fixtures;
there is no live database inventory obtained in this audit. No standalone
trace/work export was found by the bounded filename search in the checkout or
fixture roots. Logs, test fixtures and private evidence remain. This does **not**
prove there are no other developer databases, failed-test schemas or exported traces.
Canonical main has none of the new decision/execution/preview/CLI directories;
this session has not deployed them. No production destination was contacted.

Before handler/version deletion, record an explicit list of supported retained
stores/exports. Inspect only verified disposable destinations: kind/version/status
counts, work attempts/events, flow/resource intents and receipts, desired/observed
bindings, CLI handoff references, preview/review/CLI decision versions and
`check_runs` plus lifecycle obligations. Include succeeded work, deleted sessions
and blocked work: these can still retain cleanup/retry/replay requirements.
Test schemas normally drop in `close()`; interrupted test processes can bypass it.
Missing store/export inventories remain unknown, not zero.

Action retries validate their input and return a stored receipt; they do not rerun
a frozen reducer. Removing a reducer snapshot is therefore different from removing
an action parser or effect handler. Explicit replay fixtures cover preview
v1/v3/v4/v8/v9 and CLI v1; review v1 is also retained. Absence of a fixture for
v2/v5/v6/v7 is not evidence that their traces may be discarded. Preview snapshots
are 3,230 lines; v9 composes v8. `legacy-reducer.js` is **live** delegation and
shared cleanup policy, so its name does not make it historical code.

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
3. Remove runtime replay copies only against a documented supported-version policy
   and reproducible retained-trace archive. Keep required fixtures/replay available;
   pin an archive that survives eventual PR squash/history changes. Do not change
   live reducer policy or invent a new permanent version merely for code movement.

This is contract consolidation, not another workflow or rollout. Canonical
integration is the following gate; unknown retention does not block simplifying
new admission. Its acceptance is fewer admission variants and obsolete branches,
plus unchanged atomic
admission, fair scheduling, cross-machine coordination, identity-preserving recovery,
continuation handoff, stale-result/cleanup protection and late-creation retention.
Rerun shared decision/execution, complete preparation, CLI, checks and retirement
regressions. Keep all unresolved retention gates explicit. Only the admission
selector and config shim are recorded as removed here; old recovery/replay, shared
execution and legacy safeguards remain.

## Canonical integration before PR readiness

At the accepted checkpoint, the branch has 23 commits absent from canonical main;
canonical has 99 absent from it, from common ancestor
`f30d0ec1581ea7646685ebf08a9d9a0165e21538`. The earlier audit found 14 overlapping
changed files, not 14 proven merge conflicts; refresh that inventory at integration.
Owners and
adapters overlap in `server.js`, schema, sessions, staging, Kubernetes/application
runtime, visuals/harvest, import sync and proposal update, plus the SQL baseline
and three tests. Integrate explicitly on the work branch after consolidation;
this audit neither merges nor rebases it.

Preserve canonical bot checks notifications on live/harvest settlement, imported
fresh-head reconciliation, proposal-description behavior and benchmark recovery
exclusions. Reconcile schema additions and SQL inventory. New Kubernetes zone/host
database affinity, explicit user override and scheduled-node reporting must be
reviewed against the persisted candidate-spec adapter; do not silently change an
already admitted specification. Canonical stale-preview inventory recognizes only
`sv-preview-<app>-s<session>`, not attempt names `sv-p-*`; keep attempt retirement
under its manifest owner and test the reaper boundary after integration.

Refresh writer allowlist fingerprints with reviewed reasons, not blanket acceptance.
The current dedicated CI runner/path filter predates current CLI/runtime/retirement
suites and shared execution paths; update them so relevant changes trigger the
focused real-PG suite. Actual disposable-resource runs remain separate evidence.
Run affected suites/SQL checks and the contained failure matrix on the integrated
revision, then review the net diff and explicit supported/retained contracts.
No production deployment, worker installation or push is authorized; default-off
code integration alone is not installation compatibility or full migration completion.
