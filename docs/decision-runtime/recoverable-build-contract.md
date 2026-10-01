# Recoverable candidate image build: kpack only

1 October 2026. Contract written before implementation. This extends experimental
native preparation by one operation; it does not enable rollout or replace the
execution worker with a workflow engine.

## Choice and identity

The kpack adapter already creates a named Kubernetes Build whose controller runs
independently of the platform process. The Docker adapter runs a CLI subprocess
without a durable build handle. Use **kpack only**, with an explicitly pinned
builder digest and a separate admission flag/work kind. Do not fall back to
BuildKit, Docker, another attempt's cached output, or the legacy build adapter.

Admission reserves the source repository and full source SHA, build namespace,
builder digest, service account, environment, resource limits and attempt-specific
output/cache tags. The Build name derives from the resource-attempt UUID, not an
execution claim or serving-preview name. A validated action selects the script
from the exact checked-out revision, once; subsequent decisions cannot change it.
The complete recipe is recorded atomically with its decision receipt and trace
before external creation. Accepted output records the Build UID and immutable
registry digest. Later observations must match that receipt.

`RequestCandidateImageBuild` authorizes creation/inspection only for the current
preparing flow, matching head/generation, reserved operation and completed clone,
before retirement. `CandidateImageBuilt` reports output; it does not authorize
activation. A separate runtime-preparation action checks that completion again
before the existing one-shot deployment phase. Claims schedule execution; they
do not grant lifecycle authority.

## Inspection and recovery

- **Absent:** a successful Kubernetes 404, before creation was durably marked as
  submitted. A current authorized operation may submit its exact recipe once.
  After submission has begun, absence is uncertain: do not recreate the Build,
  because a delayed create or an unobserved old Pod may still exist.
- **Running:** matching name, ownership labels, complete recipe and UID (where
  previously known), without a current terminal condition. Defer fairly through
  the existing worker. A restarted worker observes the same resource; it does
  not submit another build or cancel the existing one.
- **Succeeded:** current observed generation, `Succeeded=True`, and a digest in
  the reserved output repository. Record/adopt that output with the fixed
  completion-action identity. A tag alone, stale status, changed UID or recipe,
  deletion timestamp, or invalid digest is insufficient. Verification trusts
  kpack's completion record; it does not independently pull or attest image bytes.
- **Failed:** a current terminal condition. Known lifecycle detect/build exits
  establish an ordinary build failure. Known eviction, OOM, scheduling deadline
  or node failure establishes an infrastructure failure. Unknown failures remain
  explicitly unclassified rather than being described as faulty application code.
  A terminal Build is never restarted under the same identity. Infrastructure
  failure permits a *fresh domain attempt*, not blind resubmission here.
- **Uncertain:** transport/API failures, missing submitted resources, conflicting
  ownership, unreadable failure details or incomplete completion evidence.
  Transient observation errors retry with the shared bounded backoff. Identity
  conflicts retire the domain attempt while blocking destructive guesses.

Persist a submission checkpoint **before** create. A create acknowledgment lost
after server acceptance is repaired by read/adoption. If the request never reached
the server, the checkpoint may conservatively retire an absent operation; this
slice does not claim exactly-once creation or solve ambiguous absence with a new
build supervisor. Persist an observed UID checkpoint before waiting on output.
Execution after image completion still uses one-shot runtime preparation; an
interruption before a verifiable healthy runtime exists retains conservative
retirement. A healthy runtime can be adopted as described below; recovery never
repeats its deployment.

### Healthy runtime after a lost receipt

Deployment can succeed before its candidate receipt is persisted. The runtime
observer establishes health, flow/head labels, reserved runtime identity, physical
UID and deployed image, but returns `buildRef: null`: it cannot establish Build
provenance by itself. Do not persist that incomplete observation as the candidate
receipt or relax `PreviewCandidatePrepared` to accept it.

Recovery first requires the already accepted image-completion fact and a complete
clone. It re-inspects the reserved Build against its accepted UID, full recipe,
observed generation and digest. A recorded execution UID must also match. The
runtime's attempt, kind, name and source revision must match the reservation, and
its image must equal that verified digest. Only then does recovery attach the
verified namespace/Build name to the runtime observation and persist the complete
candidate receipt. A non-null, conflicting Build reference is rejected.

If the earlier receipt write committed but its acknowledgment was lost, its
physical runtime identity, image and provenance must match the reconstructed
receipt. Recovery adopts that immutable receipt; it does not overwrite conflicts.
If no write committed, recovery stores the reconstructed receipt. Both paths use
the existing completion action, so current head/generation/lifecycle and image
provenance remain enforced at decision commit, including changes during inspection.
Neither path creates another runtime or Build, activates a candidate, or changes
the serving preview. This joins two verified observations; it is not an atomic
snapshot of Kubernetes and PostgreSQL or protection against cluster compromise.

## Ownership and cleanup

Retain the Build and its Pod while it runs, even after the flow is retired. Lease
expiry, database-lock loss and a client timeout do not terminate external work.
Cleanup inspects the reserved Build and defers while running or uncertain. It
does not cancel/delete/recreate it, mutate a successor, or delete registry images.
Terminal Build records remain external tombstones/diagnostics in this slice;
generic success/failed/app-wide build deletion must exclude these owned Builds.
Retained platform cleanup obligations also reconcile absence and delayed creation
fairly after completion; no age-based expiry is added. An absent retirement does
not prevent a delayed Kubernetes create, but the obligation stays discoverable
and the later Build remains isolated and tracked until terminal.

Existing serving-binding, physical-runtime, clone and consumer guards remain.
Build resources use an attempt-specific namespace/name/tag/cache identity; the
currently serving preview is preserved. Only separately authorized activation
changes its stable route. Cleanup cannot select a successor's different attempt.
Administrative deletion/recreation with copied labels, registry pruning, builder
or cluster compromise and cross-cluster failover remain outside these guarantees.
Build/Pod/registry tombstone compaction is deferred, not silently delegated to GC.

## Compatibility and evidence boundary

Old opaque and recoverable-clone work keeps its original handlers and semantics.
Only newly admitted work with both existing gates, recoverable clone enabled,
recoverable build enabled, and an explicit Kubernetes kpack configuration uses
this operation. Workers consume the pinned reservation even if flags/config later
change. No callers migrate; no production worker/deployment changes are included.

Required evidence separates injected Kubernetes regressions from real PostgreSQL
admission/receipt/trace recovery and **actual kpack resources**. Actual proof must
interrupt the observing worker during a real Build, adopt its verified output,
and cover acknowledgment loss and successor-preserving retirement in an isolated
namespace. This host currently has no Kubernetes context, kpack controller,
isolated build namespace, registry push credentials or pinned fixture source.
Docker availability is not kpack evidence. Until those prerequisites are supplied
and the integration job passes, the image-build integration checkpoint is blocked
and must not be described as demonstrated.

## Implemented boundary and evidence

[`image-build-intent.js`](../../src/services/preview-flow/image-build-intent.js)
validates the reservation and supplies its data-only recipe.
[`image-build-operation.js`](../../src/services/preview-flow/image-build-operation.js)
provides named `inspect`, `prepare` and `retire` operations. It issues one API
observation per delivery rather than running another polling loop. HTTP requests
use the installed client-node cancellation middleware with a 10s deadline and
await its rejected request; they are not detached on a JavaScript timeout. This
is not a total bound on kubeconfig credential helpers or network outages; the
existing execution process fail-stop bound remains necessary.

[`work.js`](../../src/services/preview-flow/work.js) admits only
`native-preview-kpack-prepare`, version 1, under `nativePreviewRecoverableBuild:
true` plus recoverable-clone and existing gates. It preserves both older work
handlers. The Build submission/UID checkpoints use the same work journal; recipe
selection and completion use the same aggregate transaction/receipt/trace runtime.
Reducer version 8 adds image actions and candidate-output checks; version 7 is
frozen for historical replay. There is no new schema table or execution backend.
Recipe and output receipts live in the typed resource intent, with their decision
journal committed atomically.

[`staging.js`](../../src/services/staging.js) verifies the checked-out SHA, derives
the npm script from that revision, consumes the named image operation, and calls
the separately guarded runtime-preparation hook immediately before deployment.
It can repeat source fetch and build observation; it does not rerun an existing
Build. Source fetch, manifest/secrets inspection and final runtime deployment are
not themselves recoverable operations. The runtime-start checkpoint remains
conservative. This slice removes whole-attempt abandonment during image building
only for the new work kind; it removes no existing guard, timer or legacy recovery
owner. Kpack's source is the reserved remote Git revision, so deleting the local
checkout cannot interrupt its external build.

[`cleanup.js`](../../src/services/preview-flow/cleanup.js) consumes named build
retirement before removing candidate/clone resources. An uncertain/running build
defers cleanup. Experimental Build ownership uses a separate managed-by value and
no legacy app-id label: successful retention, failed-build GC, app-wide deletion
and legacy completed-image borrowing cannot claim these records. Terminal Builds,
Pods, registry output/cache and platform tombstones have no compaction policy
here. This storage cost is intentional experimental containment, not a production
retention policy. Admission changes or app deletion do not erase the cleanup
locator. Reconciliation uses the originally reserved build namespace; changing
cluster/registry endpoints beneath admitted work remains unsupported.

The kpack controller/API is trusted to enforce immutable recipes and report
completed output. Comparison fails closed on unexpected recipe changes or
behavior-bearing admission mutations; actual fleet/CRD compatibility is not yet
proven. Source/builder pinning does not make dependencies or the builder's run
image hermetic. A nonzero detect/build phase is a build-step failure, not proof
that application source is at fault. Confirmed missing diagnostic Pods yield an
unclassified terminal failure; transport failures reading them remain retryable.

Focused regressions in
[`recoverable-preview-build.test.js`](../../tests/recoverable-preview-build.test.js)
use actual PostgreSQL, actual worker SIGKILL, actual claim recovery and the real
Kubernetes HTTP client, **with injected Build/Pod resources**. Lost replies are
injected after external acceptance or actual decision commits. They cover UID,
recipe and output conflicts; submission checkpoint failure; classified failure;
atomic recipe rollback; stale completion/runtime permission; legacy retention;
and successor-preserving cleanup with injected runtime/clone removal. Staging
adapter regressions are also injected. These establish control flow and database
coordination, not actual Kubernetes building, Pod termination or runtime serving.

Healthy-runtime adoption regressions use the **production runtime observer** with
injected Kubernetes Deployments/Builds and injected health responses, backed by
real PostgreSQL. Failures are injected both before receipt persistence and after
its SQL commit. Recovery accepts candidate completion with the same Build UID,
runtime UID and digest, one Build creation and one deployment, and an unchanged
serving preview. Conflicting Build UID/recipe/digest, runtime image/flow/head/UID,
stored Build reference, failed health and changed lifecycle cannot complete the
candidate. This is database/adoption evidence, not actual deployment or kpack proof.

The actual-resource job is
`scripts/test-recoverable-preview-build.js`. It requires both a disposable
`PREVIEW_FLOW_TEST_DATABASE_URL` and `KPACK_RECOVERY_TEST_CONFIG`, a JSON file with:

- `config`: explicit `appRuntime: "kubernetes"` and the existing `kubernetes`
  build configuration, including `buildEngine: "kpack"`, pinned builder digest,
  registry/cache prefixes, service account, node version and deadline.
- `repoUrl`, `revision`: a reachable fixture repository and its full source SHA.
- `runScript`: `null`, `"build"` or `"ensure:shell"`, matching that fixture revision.

Its build namespace must start with `preview-recovery-test-` and have label
`social.usernode.io/recovery-test=true`; the kpack controller, registry access and
build service account must already be configured there. This job creates actual
Builds, kills the actual execution worker after creation, recovers the same UID
and digest, and injects a lost reply after the image fact's actual SQL commit.
Clone and runtime deployment remain injected. On success it explicitly tears down
the verified terminal test Build using UID/resourceVersion preconditions; that
teardown is separate from production retirement. Failed runs can leave their
attempt-specific Build/Pod and registry artifacts in the disposable namespace.

**C4 integration remains pending.** Rechecked after the adoption correction:
`kubectl config get-contexts -o name` is empty and `current-context` is unset;
`KPACK_RECOVERY_TEST_CONFIG`, `KUBECONFIG` and `KUBERNETES_SERVICE_HOST` are unset.
There is no local kind/k3d/minikube fixture. Disposable PostgreSQL is available;
the actual-resource job still exits 1 for the missing explicit kpack configuration.
An optional test skip or an injected resource is not actual-resource proof.

The missing inputs are:

- An explicit test-cluster context/access with compatible kpack controller and
  Build CRD. Do not select a production cluster implicitly.
- A disposable `preview-recovery-test-*` build namespace with the required label,
  a build service account and registry push/pull access, plus reserved output and
  cache repository prefixes. If testing actual deployment, also supply a labeled
  disposable runtime namespace and its dependencies.
- A compatible builder image pinned by digest, node version and bounded deadline.
- A reachable fixture repository, full successful revision, matching `runScript`,
  and a full revision that predictably fails a detect/build phase. Record these
  with the explicit configuration file path in `KPACK_RECOVERY_TEST_CONFIG`.

Once provided, extend and run the isolated job for actual terminal failure,
delayed creation and successor-preserving retirement as well as its existing
worker-interruption and lost-decision-acknowledgment scenario. Delay/loss may be
injected at the client boundary, but Build/Pod creation and completion must occur
in the real cluster; record that distinction. Verify that absent retired work
remains discoverable when delayed creation arrives, that it is not recreated,
and that retirement leaves the successor's UID/output intact. The current job
does not yet establish those cases. Preserve protections and experimental admission
until the expanded evidence and fleet-defaulting checks pass.
