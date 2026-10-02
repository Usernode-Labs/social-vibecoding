# Supported CLI contract and retention review

Reviewed 2 October 2026 at accepted local `d24b0c0dd15fd22ee9654243e423ce449777d925`;
canonical main `4c0ef27fb7381e9ecb89e2732e6c2c784b9395c6` was fetched and inspected.
The subsequent pinned integration is `d9cf30cd73a0810be72b199f8b2a194f8c56b793`
at merge `6730b091306c0dcbcf22579548dc2dd273b2f1f7`; see the
[packaged proof contract](packaged-cli-entrypoints-contract.md) for its new evidence.
This original section is a code/retention review, not permission to expand
admission. Existing protections and default-off admission remain.

## The contract we intend to support

The first supported cohort is native `cli_handoff`, Kubernetes/kpack, with the
preview lifecycle enabled. New admission accepts the uploaded exact head and
commits its complete preparation request in the same aggregate transaction.
Recovery follows persisted enrollment even with admission disabled. It cannot
fall back to a synchronous or competing builder.

| Owner | Required behavior and persisted authority |
| --- | --- |
| CLI admission | Session authorization and head guards; `cli_preview_handoffs` identifies the current flow and required preparation/continuation. |
| Preparation worker | `native-preview-kubernetes-prepare` v1; source, `template-v1` clone, `kpack-v1` Build, `kubernetes-v1` candidate. Persisted identities/specifications and verified OID/UID/digest determine adoption, not existence alone or current configuration. |
| Activation continuation | `native-cli-preview-continuation` v1; a separate action authorizes changing the stable route. Desired/observed binding and conditional UID/target checks protect the serving preview and successors. Candidate completion durably admits this continuation. |
| Checks lifecycle/harvester | For durable-marked runs, the original run, manifest, companion requirement and retirement journal own Jobs and inputs. Live heartbeat is joined; orphan work is inspected. Unknown creation/output stays discoverable and explicitly blocked; an absent Job or manifest does not authorize competing execution. |
| Checks settlement | `cli-checks-settlement` v1; accepted run/revision receipt, verdict, history/graduation and `native-cli-check-gate` v1 requests commit atomically. App history coordinates across sessions. Lost replies adopt the committed verdict. |
| Gate delivery | Standalone worker initializes dependencies before polling. Missing GitHub initialization/credentials retains retry ownership; successful policy invocation is distinct from domain no-op and actual merge. Existing merge/bot services own their policy, claims and external deduplication. |
| Retirement | `native-preview-retire` v1 plus existing checks retirement. Retire only the recorded resources; dependency release is distinct from proving every creator stopped. Keep unresolved late-creation locators, including after supersession. |

The distinct `proposal-review-announce-return` v1 workflow remains the demonstrated
shared-runtime reuse checkpoint. It is not another preview format. Live reducer
versions are preview **10**, CLI **3**, review **2**, settlement **1**. Work contract,
reducer, clone/build/runtime operation and manifest versions are different axes.
A work contract v1 does not require executing reducer v1.

Sources: [CLI owner](../../src/services/cli-preview-handoff/work.js),
[preparation](../../src/services/preview-flow/work.js),
[checks recovery](../../src/services/cli-preview-handoff/checks.js),
[settlement](../../src/services/cli-preview-handoff/settlement.js),
[retirement](../../src/services/check-retirement.js).
Operation contracts supply the detailed guarantees and recorded evidence.

This is the contract for new complete admission and durable-marked checks runs.
Retained unmarked manifests are an exception, not silently upgraded enrollment.
[`check-harvest`](../../src/services/check-harvest.js) selects uncertainty,
settlement and journalled retirement by `manifest.durableCli`; an older unmarked
manifest can still take legacy cancellation, redrive and best-effort settlement.
[`staging-recovery`](../../src/services/staging-recovery.js) intercepts the redrive
for an enrolled session and rejoins its durable owner, preventing fallback to a
competing builder. That does not retroactively give the old run durable cleanup
or atomic settlement. Inventory and reconcile those records before promising the
current checks guarantees for a retained store. Never add a marker to unknown
creation or recount an old verdict's history just to make it look current.

## Retention rules and removal decisions

Product support should cover the current contract above. An older development
checkpoint is supported for **specific retained obligations or replay evidence**,
not because it once existed. Unknown stores do not become a permanent promise;
they need a named owner/store decision before removal. No formats are removed in
this review because that list has not been established.

| Item | Actual requirement / bounded removal |
| --- | --- |
| Three early handlers: `native-preview-prepare`, `native-preview-template-prepare`, `native-preview-kpack-prepare`, all v1 | Recovery-only; no new admission emits them. No live retained instance was established by this review. Keep temporarily for the unknown-store gate. Remove their registry entries and exclusive one-shot observation/runtime-start branches once named stores have no unfinished work or dependent resource obligations, or those obligations have been safely drained. Do not relabel old payloads as complete preparation. |
| Preview frozen v1–v9, CLI v1–v2, review v1 | Replay-only. Decision application uses the live reducer; validated duplicate actions return stored receipts. In-repository historical expectations use preview v1/v3/v4/v8/v9, CLI v1/v2; review v1 is retained in the dispatcher. Preview v9 imports v8. These are removable from the worker runtime after the relevant goldens/retained traces and exact source/dependencies are preserved in an independently reproducible replay archive. They are not needed merely because an old work row exists. |
| Preview v2/v5/v6/v7 | No explicit historical golden found in the reviewed suites. That is a removal candidate, not proof that exported traces are absent. Apply the same named-export/archive gate; do not invent permanent support or delete unknown evidence silently. |
| Old action parsers and receipts | Separate from frozen reducers: `transaction.apply` validates input before looking up a receipt. Keep old request shapes while supported callers or retained requests can retry them. A replay archive alone does not preserve live request retry compatibility. |
| Old desired runtime placement; unmarked manifests or manifests without companion/retirement fields | These are persisted data, not flags. Do not rewrite desired specs or assume an absent field means no obligation. Prune only after an inventory of the corresponding resource/run records proves the branch unused or reconciliation closes it safely. |
| `legacy-reducer`, `candidate-native`, staging/lifecycle/retention locks and harvest timers | Still live policy or shared safeguards for other callers. Keep. `onClonePrepared` is also used by synchronous `candidate-native`; it cannot be removed with the early durable handlers. The complete path still writes some creation checkpoints, so their names alone do not establish obsolescence. |

`execution/store.claim` selects registered workflow names. Removing a handler can
leave its work unclaimed; an unsupported contract version of a **registered** kind
instead becomes blocked. Neither outcome closes cleanup. [Runtime receipt lookup](../../src/services/decision-runtime/index.js)
does not execute the frozen replay dispatcher. Retain current live reducers and
the supported operation/manifest mappings regardless of archived replay removal.
Optional operation fields are not automatically old compatibility: new admission
reserves a build before authorizing its `runScript`, and reserves a runtime before
selecting its desired spec. Keep those legitimate current lifecycle phases.

One replay dependency needs particular care: CLI `versions/v2.js` imports the
live preview enabling conditions. Its filename alone does not freeze behavior.
Archive the dependency at the retained trace's producing revision, and run the
v2 golden plus retained traces against it. The current golden alone does not prove
every historical v2 trace. Live-policy edits must not silently change historical replay.

### What was actually inventoried

- Read-only bounded scan of the repository's decision docs/test fixtures found no
  standalone decision-trace JSON/JSONL exports. Generated test assertions and logs
  are evidence, not a census of supported databases or exports.
- All **14** discovered `preview-recovery-test-*` setup journals in the local
  temporary directory say `torn-down`. Earlier ledger entries record verified
  fixture teardown; no retired cluster was reconnected.
- All **seven** discovered PostgreSQL fixture manifests passed metadata validation;
  read-only local Docker selection by each fixture's exact ownership label found
  no container. No database was connected and no rows were counted. The fixture-scoped resources are gone; this is not a global retained-row inventory.
- Other developer stores, interrupted schemas outside those fixtures, backups and
  trace exports outside the bounded search are **unknown**. Production is outside
  this review. Canonical main has no new runtime directories; that is source
  evidence, not proof about any deployed/custom branch or database.

Before pruning, record the named supported store/export list. For each verified
disposable store, take a consistent read-only inventory of all work kinds/versions/
statuses and referenced attempts/events; flows/resources and creation/cleanup
progress; desired/observed bindings; handoffs and receipts; all four decision
journals by reducer version; and `check_runs`/`preview_operations` retirement
obligations, including `durableCli`, companion and retirement journal presence. Include succeeded and blocked work and deleted session IDs. Export
counts, references and checksums without credentials. A terminal work status or
database release does not establish creator closure. A missing store is unknown,
not an empty inventory. A fresh-store-only support decision is valid; excluded
stores must be reconciled before running the new worker against them, rather than
receiving permanent compatibility by default. Old terminal verdicts without settlement receipts must
not be reconciled by recounting history whose write status is unknown.

For first support on a fresh isolated store, prove it is empty of historical
formats before admission and pin the supported image/schema tuple. If other
retained stores are to be supported, list them and drain/adopt under their original
contracts. Historical replay should be a versioned offline artifact with goldens,
source and dependency checksums that survives PR squash; a Git SHA alone is not
the archive. There is no time-based expiry of unresolved work or tombstones.

## Actual standalone and capture boundary

[`main`/`runWorker`](../../scripts/preview-preparation-worker.js) loads config and
the normal pool; initializes GitHub/LLM; registers preview, CLI/gate and review
handlers; and runs independent bounded discovery. It does **not** run web startup,
migrations, a web server or legacy recovery timers. Its shutdown joins operations,
then has a fail-stop deadline; a process exit does not prove external work stopped.
`Dockerfile.kubernetes` ships the entry point, but its default command is still the
web server. The subsequent [packaged proof](packaged-cli-entrypoints-contract.md)
now runs that default CMD, worker `main` and migration as separate non-root
containers, with real HTTP admission/restarts and real resource observations.
Earlier bootstrap/service-factory tests remain separate evidence. Supervised
installation and least-privilege RBAC are still unproved.

Capture chooses runtime partly from environment (`captureRuntimeMode`), while Job
admission uses config. Both must say Kubernetes. `runCheckJob` enforces digest-pinned
capture/unit images; it does not establish that their code/protocol matches the
backend revision. The worker needs separate app/build/check namespace access and
database/clone privileges; capture/unit Pods use the configured worker ServiceAccount
with token automount disabled. Current fixture API access does not prove least-
privilege worker RBAC. Packaged non-root behavior is now demonstrated only for
the recorded disposable image/source tuple.

[`visuals`](../../src/services/visuals.js) targets public **HTTPS** preview origins.
Non-admin capture identity signs screenshots; the view-only admin identity signs
assertions. Tokens use app-scoped RS256 identity authority; missing identity/key
can degrade to unauthenticated capture. [The existing fixture](../../tests/lib/cli-checks-fixture.js)
substitutes internal Service HTTP, capture users, GitHub metadata, warming and
notifications. Real Chromium/Jobs/PNG and recovery were demonstrated; private app
access, Secure cookie exchange, TLS/assets and an actual HTTP admission restart were
not by that earlier fixture. Packaged HTTP admission/restarts are now proved;
private identities/TLS remain unproved. A missing capture identity must not be mistaken for proof of private access.

### Bounded verification steps before first CLI support

| Step | Work needed | Acceptance evidence |
| --- | --- | --- |
| Current canonical reconciliation | **Complete against explicit pin** | `d9cf30cd7` merged at `6730b0913`; preserved benchmark/approval behavior, refreshed CI and unchanged writer inventory. Focused PostgreSQL, SQL, actual checks/retirement and packaged proof pass; see the integration record. No rollout. |
| Supported-store and replay decision | Inventory + archive/removal implementation | Named store/export list, read-only results, historical goldens reproduced from the archive. Remove only proven-unused early handler branches and runtime replay copies; keep unresolved recovery and parser shapes. Inventory/replay removal is not a new machine version. |
| Retained unmarked checks, if any | Inventory + focused reconciliation verification; a bounded fix only if needed | Seed an original unmarked manifest in verified disposable PostgreSQL, with delayed/absent Jobs and an old terminal verdict, then restart/supersede. Prove no competing capture or builder, no lost cleanup locator, no history recount and no false required-gate completion. A legacy branch failing that proof requires draining or a bounded reconciliation correction before supporting that retained format; changing the marker alone is not the correction. |
| Packaged standalone entry point | **Core proof complete**; remaining installation/permission verification | Shipped image/default web CMD, worker `main` and migration run non-root. Real HTTP admission and four loss boundaries recover with admission disabled and stable identities; original checks retire and required bot delivery invokes its substituted policy boundary once. The recorded image tuple passes. Prove least-privilege/denied permissions and supervision separately; cluster-admin fixture access does not cover them. No product fix was needed. |
| Image/protocol tuple | Verification; small preflight change if required | Record exact backend SHA/schema, capture and unit image digests and relevant protocol cases. Run stdin Secret transport, repeat/advisory/console/malformed/partial output and unit completion against those images. There is currently no negotiated protocol/version handshake; support the tested tuple, not arbitrary mixed old/new images. Keep images of running Jobs available for recovery. |
| Public origin and private identities | Disposable fixture extension + actual verification | Local ingress/TLS and trusted local CA, real asset routes and generated identity keys; a small DB-using private app and self-app staging exchange. No internal HTTP rewrite. Verify screenshot non-admin/assertion view-only admin behavior, denied cross-app/expired tokens and anonymous access, missing key/identity behavior, static assets and credential isolation. Restart while Jobs run; adopt their output rather than recreate Jobs or reissue their execution. |

These steps do not require another workflow, caller cohort or generic executor.
Optional shots/media/notification delivery remains separate from required gating.
Canonical changes since integrated `d600eb4308b0d283ba050addf4c19c915078086c` leave
the reviewed capture/runtime/JWT/Job/worker-image adapters unchanged. Relevant drift
is benchmark orphan recovery in `server.js` (`a3ebbf92c`) and fresh live approval
enrichment in `votes.js`/`merge-requirements.js` (`c1c0a2e8e`); these survive the subsequent pinned integration. The original review did not
establish freshness; the later reconciliation does so against the explicit pin. GitHub delivery is substituted, Linux CI execution is unverified, and
the first supported CLI gate and full migration remain open.
