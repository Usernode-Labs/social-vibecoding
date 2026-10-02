# Contained CLI retirement inventory

2 October 2026. The cohort remains default-off. Progress is demonstrated
ownership replacement and removed code, not added checkpoint numbers.
See the [roadmap](roadmap.md), [support decision](experimental-retention-decision.md)
and [packaged proof](packaged-cli-entrypoints-contract.md).

| Mechanism | Current status / replacement | Removal gate |
| --- | --- | --- |
| Four preparation capability flags and CLI config shim | **Removed** at `2bf702dbd`. Sole new admission is complete Kubernetes/kpack preparation. | Complete; retain default-off admission/worker switches. |
| Three partial preparation work kinds, selection flags, one-shot observation/start branches and unused completion flags | **Removed** after fresh-only decision and verified archive. Named clone/Build/runtime operations own preparation. | Complete locally; unsupported startup fails visibly, preserving records. |
| Preview frozen v1–v9, CLI v1–v2, review v1 and live historical dispatch | **Twelve source copies removed from live runtime.** Exact dependencies, golden sources and 153 replay cases are archived independently of Git history. | Verified offline. Current preview v10/CLI v3/review v2 policies and replay remain. |
| Historical-format test admission/worker helpers; exclusive staging `preparedClone`/`onRuntimeStarting` | **Removed.** Relevant failures are ported to current complete admission and named operations. Original sources remain archive provenance. | Complete. Synchronous `onClonePrepared` is still required and retained. |
| Enrolled synchronous preparation, alternate rebuild/restart owners, detached checks continuation | **Replaced** by atomic admission and durable candidate-to-continuation work. | Complete for this cohort; preserve unenrolled callers and ownership exclusions. |
| Enrolled best-effort verdict/history and detached required merge/bot kicks | **Replaced** by atomic settlement and deduplicated gate delivery. Standalone initializes dependencies explicitly. | Complete locally; GitHub/bot calls remain substituted evidence. Optional artifacts have separate owners. |
| Validated action/receipt retry shapes and live `legacy-reducer` | **Retained.** Current reducers keep their unchanged decision contract; synchronous callers share live policy. | Do not remove with offline reducer copies or handler dispatch. A separate caller/action inventory must establish obsolescence. |
| `nativePreviewAttempts`, synchronous native/candidate-native adapters | **Retained for unenrolled callers.** Durable CLI admission does not use the flag. | Remove only after those callers and retained candidates are handled. |
| Persisted `durableCli`, `durableChecks`, `recoverExisting`, input-retirement ownership | **Retained.** These select an existing owner and distinguish required recovery, not redundant capabilities. | Remove only when competing contracts no longer coexist. |
| Manifest/placement compatibility, unmarked checks and old verdict reconciliation | **Retained safeguards.** Fresh-only experimental support does not authorize production compatibility removal. | Named legacy inventory and replacement/reconciliation proof. Never infer creator closure or recount unknown history. |
| Session staging/lifecycle locks, retention guard/fail-stop and process queue | **Retained distinct concurrency boundaries.** Candidate isolation does not fence every stable binding, legacy writer or consumer. | Demonstrated replacement plus writer/consumer audit. |
| Web activation/cleanup, build retention and global harvest/recovery timers | **Retained for other callers**, with enrolled/bounded ownership exclusions. Shared worker owns this cohort. | No global timer removal follows from this slice. Legacy oldest-50 harvest fairness remains a separate limitation. |
| Attempt/Build/runtime/retired-role tombstones and recurring retirement | **Retained** for unresolved late creation. Database release does not prove Kubernetes creator closure. | Explicit creator termination/reconciliation; never age or observed absence alone. |

The supported historical experimental-store list is empty. The bounded local
inventory found 19 kind fixture journals retired, and earlier PostgreSQL tmpfs
containers absent from the explicit local daemon. Only the new correction fixture
was live. Other developer stores/backups remain unknown and unsupported, not
presumed empty. No production destination was accessed. Startup refuses removed
work kinds (including succeeded records) and historical traces before claiming.
It does not mutate or automatically adopt unsupported stores.

Sources: [current preparation](../../src/services/preview-flow/work.js),
[store support guard](../../src/services/preview-flow/experimental-support.js),
[offline archive](../../archives/experimental-replay-c01dc0687/README.md),
[CLI owner](../../src/services/cli-preview-handoff/work.js),
[legacy writers](../../src/services/preview-flow/legacy-writers.json).

Canonical main was pinned and integrated at `d9cf30cd7`. The subsequent freshness
check fetched `708faeedf`; relevant capture/auth/runtime paths are unchanged.
This bounded removal stays on accepted `c01dc0687`. A later canonical update is a
separate integration gate. Authorized private HTTPS proof is now recorded in its contract;
this inventory does not establish production compatibility or authorize rollout.
Repeated-use and published-predecessor retirement proof is the following
correctness gate; no additional workflow expansion precedes it.


## Ordinary-use replacement gate

The first supported CLI gate now includes repeated heads on the same session,
overlapping checks, supersession and retirement of **published predecessors**.
The final owner map is in the roadmap. The CLI route must not prepare or launch
checks in a detached promise; enrolled rebuild/restart paths must not become a
second builder/capture owner. Required settlement/gates stay with the shared worker;
Job/input retirement stays with the existing manifest/lifecycle/harvester. Published
preview retirement must release clone/build/runtime dependencies after consumers
finish while retaining unresolved creation. This is mandatory verification, with
bounded fixes if needed; it is not yet demonstrated by the single-revision proof.
Global legacy locks, timers and safeguards are not removal candidates for this
cohort alone. Removal evidence must name the competing owner actually eliminated.


This HTTPS verification slice removes the internal-HTTP substitution from its
proof path only. No product lifecycle owner, timer, lock or reducer is removed;
the older HTTP harness remains for its earlier matrix. All three new actual
fixtures and the PostgreSQL-only container have been verified and retired.
Ordinary-use/published-predecessor replacement is still pending, not demonstrated
by authorized private capture. Production and unenrolled callers remain protected.


The current candidate reducer intentionally retains every published predecessor
(`consumer_retirement_required`) and refuses new preparation with two retained
published attempts. This is a deferred containment safeguard, not a regression
introduced by the HTTPS slice. Ordinary repeated use requires **new bounded cohort
retirement authorization and actual verification**, not documentation alone.
Keep the guard for legacy callers/unrepresented consumers; replace it for this
cohort only after proving original check/creation obligations and consumers are
retired. [Candidate policy](../../src/services/preview-flow/candidate-reducer.js)
and [resource loading](../../src/services/preview-flow/store.js) contain the boundary.
