# Preview/check migration retirement inventory

3 October 2026. The cohort remains default-off. Progress is demonstrated
ownership replacement and removed code, not added checkpoint numbers.
See the [roadmap](roadmap.md), [support decision](experimental-retention-decision.md)
and [packaged proof](packaged-cli-entrypoints-contract.md). The [completion checklist](preview-check-completion-checklist.md) defines the
original migration merge gate; the [pilot review](final-pilot-review.md) is an
internal checkpoint. Private screenshots are a
separate product follow-up. The final correction replaces unjustified unavailable
or unverified source exemptions with exact-commit/root-tree and blob inspection;
it adds no work kind, executor, flag or cleanup owner. Legacy nullable-source
skipping remains. Canonical main `74276a2fb7002da251e1b3975ae22b81dbc765e3`
is reconciled; its shots-worker hold/retirement and other caller protections remain.

| Mechanism | Current status / replacement | Removal gate |
| --- | --- | --- |
| Enrolled active/promoted CLI Sync with main writer and detached staging/recheck tail | **Replaced:** trusted sync acceptance, review policy persistence and required preparation share the aggregate transaction. Serving pointers are preserved. Existing candidate/continuation owns activation/checks. | Disposable PostgreSQL sync integration, rollback/lost reply, duplicate, admission-off obligation and newer-head/supersession guards. Unenrolled sync keeps two explicitly scoped writer exceptions until its cutover. |
| Disabled-admission sync reconciliation | Current required obligation in the handoff row; existing bounded discovery and handoff recovery consume it. No new work kind, executor or flag. | Supersession/closed lifecycle cannot authorize old publication. Admission enabled admits the stored exact-head preparation once; old admitted work recovers with the flag off. Retain this obligation while the experimental admission split exists. |
| Manual enrolled deploy/ensure/recheck web owners | **Removed for persisted enrollment:** no route-local pending reset, mutable branch resolution, web builder, pointer publication or detached capture/recheck. Existing action/continuation owns requests and repair. | Real HTTP/disposable PostgreSQL proof; Ordinary non-headless native Kubernetes/kpack manual requests now share these owners through explicit native actions and UUID receipts. Docker/headless and unenrolled/default-off callers still require cutover. Legacy SQL allowlist remains unchanged because unenrolled paths still use it. |
| Dead chat-file Docker builder/parser and unused identity/Caddy imports | **Deleted 120 lines plus two imports.** No callers or exports; existing source-generation guards remain green. | Complete; no replacement executor or compatibility branch. |
| Four preparation capability flags and CLI config shim | **Removed** at `2bf702dbd`. Sole new admission is complete Kubernetes/kpack preparation. | Complete; retain default-off admission/worker switches. |
| Three partial preparation work kinds, selection flags, one-shot observation/start branches and unused completion flags | **Removed** after fresh-only decision and verified archive. Named clone/Build/runtime operations own preparation. | Complete locally; unsupported startup fails visibly, preserving records. |
| Preview frozen v1–v9, CLI v1–v2, review v1 and live historical dispatch | **Twelve source copies removed from live runtime.** Exact dependencies, golden sources and 153 replay cases are archived independently of Git history. | Verified offline. Current preview v11/native-admission v4/review v2 policies and replay remain. Admission v3 replay is retained for work/traces admitted under accepted `8ed150abf`; the same CLI decisions are replayed without a copied reducer. Removal needs that supported-store/trace inventory or export, not a permanent checkpoint obligation. Exact v10 policy is already archived; fresh-only support adds no historical live branch. |
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

The supported historical experimental-store list is empty. Bounded local inventories
and ownership-verified teardown records cover the disposable fixtures only. Other
developer stores/backups remain unknown and unsupported, not presumed empty.
Startup refuses removed work kinds (including succeeded records) and historical
traces before claiming; it neither mutates nor adopts unsupported stores. No
production destination was accessed. See the support decision for historical
inventory counts and the individual contracts/ledger for subsequent fixtures.

Sources: [current preparation](../../src/services/preview-flow/work.js),
[store support guard](../../src/services/preview-flow/experimental-support.js),
[offline archive](../../archives/experimental-replay-c01dc0687/README.md),
[CLI owner](../../src/services/cli-preview-handoff/work.js),
[legacy writers](../../src/services/preview-flow/legacy-writers.json).

Pinned canonical main `da6ecb00880cab9a1749a6256992fb3d1706d9be` is integrated at local merge `ab2f0411234eab1dec154b446c1189ac220dc52b`.
Five-revision predecessor release is complete at accepted `511e84e35` for the
contained cohort. Original preview/check migration and removal of other owners
remain mandatory before merging this branch; installation is a separate gate.

## Ordinary-use replacement gate

The first supported CLI gate now includes repeated heads on the same session,
overlapping checks, supersession and retirement of **published predecessors**.
The final owner map is in the roadmap. The CLI route must not prepare or launch
checks in a detached promise; enrolled rebuild/restart paths must not become a
second builder/capture owner. Required settlement/gates stay with the shared worker;
Job/input retirement stays with the existing manifest/lifecycle/harvester. Published
preview retirement releases runtime/clone/check-input dependencies after consumers
finish while retaining unresolved creation and immutable build artifacts. This is mandatory verification, with
bounded fixes if needed; it is now demonstrated by the separate five-revision proof.
Global legacy locks, timers and safeguards are not removal candidates for this
cohort alone. Removal evidence must name the competing owner actually eliminated.


The earlier authorized-private HTTPS proof removed internal HTTP rewriting from
that proof path, without removing product lifecycle owners/locks/timers. The
current ordinary-private assessment removes the fixture's manual capture membership
and platform-access override. It tests shipped migration/identity/authorization
behavior, not a new grant mechanism. No privacy check is weakened. The earlier
successfully authorized case remains historical evidence at `a7d5a946f`; it does
not establish permission for ordinary private projects.

The old blanket published-predecessor retention is replaced for the bounded CLI
cohort by preparation/continuation identity and durable consumer release evidence.
The two-attempt budget now counts **unreleased dependencies**, not creator
tombstones. The existing retirement owner records active dependency release and
keeps the same recurring late-creation obligation. Legacy published protection
remains; no new cleanup executor, work kind, product capability flag or timer was
introduced. Actual five-revision proof passed: four predecessors released active dependencies,
the fifth stayed serving, and the original recurring cleanup obligations remained.

[Release contract](published-predecessor-retirement-contract.md),
[candidate policy](../../src/services/preview-flow/candidate-reducer.js),
[consumer admission/release](../../src/services/check-runs.js) and
[existing retirement owner](../../src/services/preview-flow/cleanup.js).

Essential correctness is safe consumer/runtime/database release and serving/
successor protection. Registry output/cache, terminal experimental Builds and
consumer/creator receipt compaction are retained limitations, not new workflow
requirements for this slice. Shots own separate paired runtimes and databases
(`shots-environment.js`) and can reuse the immutable preview image; this slice
therefore makes no image/artifact deletion claim. Global Build retention selects
another owner label and does not collect these experimental Builds.

## Ordinary native manual cutover

Removed ownership for enrollment: route-local/process-set deduplication, pool-level
pending/reset writers, synchronous/detached web preparation, direct preview-pointer
publication, detached required capture/recheck and competing rebuild/recovery tails.
These branches remain physically present for named legacy callers. No global lock,
timer or legacy adapter was deleted, and the projection inventory still has 16
statements. Alternate staging and capture services now fence all enrolled sessions,
not only CLI source; manifests, consumer release and settlement use the same owners.

Added only the separately default-off native cohort admission switch and stable
manual-request receipt mapping. No new execution kind, executor, preparation adapter,
continuation, settlement or cleanup owner. Historical CLI storage/work names remain
explicit retained identifiers. A head mismatch from an unmigrated writer exposes
reconciliation under native admission; hosted/promotion head acceptance is still open.
Client request identity persists through unknown replies (session storage when
available, in-memory otherwise); a complete definitive response permits a new intent.
