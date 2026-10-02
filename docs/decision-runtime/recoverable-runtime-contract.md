# C5: recoverable Kubernetes candidate preparation

**Current admission:** only complete `native-preview-kubernetes-prepare` is newly
admitted under the default-off CLI switch. Earlier capability flags and partial
formats described below are historical recovery/evidence contracts, not new
admission choices. Retained formats remain supported; see the
[consolidated admission contract](bounded-preview-contract.md#current-admission-contract-2-october-2026).

Contract before implementation, 1 October 2026. One new experimental work kind;
old admitted work keeps its old behavior. Shared decision transactions, aggregate
locks, receipts/traces and execution claims/checkpoints/fair retries stay in use.
No caller migration, activation change or general workflow engine.

## Desired state and authority

A current preparing flow with a completed clone and verified immutable Build output
may select one runtime specification through a validated action. Persist image,
command, service account, resource settings, encrypted environment and fixed probe/
security policy before I/O. Namespace and Secret/Service/Deployment names derive
from the reserved attempt; flow/head/attempt/specification labels identify each.
The selected specification cannot be changed on retry. No plaintext environment
is stored in actions, traces, work input or errors. Preparation creates no stable
route or Ingress. Activation remains a separate guarded action.

Each resource has a durable submitted flag and observed UID. A guarded action
records permission/submission before POST, in order Secret → Service → Deployment;
the predecessor must have a verified UID. A reported UID cannot overwrite a prior
one. Historical retirement may record late observations, but cannot create work.

## Recovery

- Not submitted and absent: obtain fresh action permission, then create once.
- Matching object: compare owned identity and behavior with the saved specification;
  adopt its UID, report it durably and continue the next unsubmitted step.
- Submitted but absent: uncertain; do not recreate. Retry inspection fairly. A crash
  between durable submission and POST can therefore leave a contained obligation.
- Different owner, UID, Secret data, Service selector/ports or Deployment policy:
  block; never replace/upsert it. Transport errors are retryable, not absence.
- Complete resources: require current Deployment generation, available/ready replica
  and successful HTTP health through the candidate Service; reverify identities
  after probing. Persist the complete receipt and accept candidate completion only
  with all observed UIDs and the verified image provenance. Lost replies recover by
  inspecting the same objects and replaying receipts, not creating replacements.

SDK calls cancel and join timed-out HTTP requests. An expired claim does not mean
external creation stopped. Existing staging/lifecycle locks remain. Authorization
is checked separately from execution claims, including each resource creation.

## Retirement and dependencies

Cleanup obtains fresh domain permission, checks the external serving binding, and
inspects all resources before deleting any. Delete only matching physical UIDs with
resourceVersion preconditions, Deployment first with foreground propagation. Wait
for controller/Pod/resource disappearance on recurring passes; unknown ownership
or transport errors defer cleanup. Retained locators and recurring SQL cleanup
obligations inspect late resources even after a pass observed absence.

Retirement prevents permission for any new creation step. If Deployment was never
submitted and inspection confirms no runtime consumers, the clone can be released;
late Secret/Service POSTs cannot launch Pods and remain discoverable for cleanup.
If Deployment **was submitted**, C5 retains the clone and cleanup obligation even
when all runtime objects/Pods appear absent. Foreground deletion plus one empty
list is not a proof against every delayed controller Pod creation. Safely releasing
that dependency needs a later demonstrated consumer/creator closure or database
fencing mechanism. Retention is intentional containment, not cleanup completion.
A current or desired serving binding protects the attempt regardless of health.

## Required evidence and limitations

New disposable local fixture and full C4 isolation preflight only. Demonstrate
actual worker SIGKILL between creation steps, lost API and SQL replies, matching
partial recovery/healthy adoption, conflict rejection, late creation reconciliation,
successor protection, and unchanged real serving resources/traffic and SQL projection.
Distinguish actual Kubernetes/HTTP/database observations from injected timing and
clone/build inputs. No production credentials/settings/artifacts, push or deployment.
Production fleet compatibility, arbitrary controller timing, hermetic images,
retention limits, supervised deployment and overall migration completion remain open.

## Implemented boundary and evidence

`runtime-intent.js` defines the versioned recipe and encrypted desired data;
`runtime-reducer.js` permits specification selection, one resource submission and
immutable UID observations. `store.js` persists those decisions in B2's aggregate
transaction with receipts and version-9 traces; version 8 remains frozen for replay.
`runtime-operation.js` performs named inspect/prepare/retire service operations.
The existing work handler and shared executor own polling, claims, fair retry and
settlement. No second scheduler, transaction runtime or execution engine was added.

Admission requires `nativePreviewRecoverableRuntime: true` plus existing native,
worker, recoverable-clone and recoverable-build gates. It creates only
`native-preview-kubernetes-prepare`, contract version 1, on explicit Kubernetes /
kpack. Existing admitted work kinds retain their original runtime behavior. The
staging adapter supplies the hook only to this kind; ordinary deployment keeps its
existing dispatcher. Desired data preserves self-app prebuilt-shell environment,
app/session labels and preview database affinity. Fixed `kubernetes-v1` recipe
changes require an explicit compatibility/version decision; retry cannot update a
selected recipe. Encryption-key loss defers recovery rather than replacing resources.

Six actual-resource scenarios passed in the new disposable local fixture: worker
SIGKILL after Secret or Service creation, SIGKILL after healthy runtime observation,
lost actual POST acknowledgments, lost receipt replies after actual SQL commit,
healthy predecessor retirement, delayed Deployment creation after absence, and a
conflicting replacement Service UID. The three interruption tests include reply
loss during recovery; the six tests are not six separate transport guarantees.
Actual Deployment/ReplicaSet/Pod/Service/Secret/Endpoints, HTTP through the candidate
and serving Services, and PostgreSQL decisions/claims/receipts are exercised.
Recovery adopts the same physical objects, resumes only unsubmitted steps, reaches
candidate state and preserves the serving Deployment UID/specification/traffic and
SQL tuple. Retirement preserves a distinct healthy successor's three UIDs/traffic;
conflicts prevent any deletion. The late Deployment UID is journaled and removed
on a later shared cleanup execution. Its dependency and obligation remain retained.

Clone and Build operations are explicit injected inputs in C5 tests. A digest-pinned,
non-root Node image is seeded only into the dedicated local registry; C5 does not
claim an end-to-end actual clone → kpack output → application deployment. C3/C4
have their separate evidence. Delayed POST and lost replies are injected at the
service boundary; SIGKILL, API objects, controller/GC behavior, HTTP and SQL are
actual. This is not proof of an API-server request continuing after cancellation.
Health is an observation, not a transaction spanning PostgreSQL and Kubernetes;
external writers may change resources afterward and activation rechecks them.
Activation/Ingress changes, production admission/webhooks and fleet behavior were
not exercised.

No old timer, long-held lock, cleanup owner or recovery path is removed. Only this
new kind replaces whole-attempt abandonment for interrupted partial runtime
preparation. Submitted-but-absent creation can remain uncertain indefinitely;
missing Deployment health remains waiting. A replaced UID or unexpected repeated
external creation is contained for explicit resolution, not overwritten. Once
Deployment was submitted, clone release, orphan-consumer closure and retention
bounds remain the next required resource-lifecycle proof before rollout. B2/C2's
shared decision/execution reuse remains demonstrated; the overall refactor is
incomplete and Temporal remains deferred under C0's recorded conditions.

C6 supersedes the submitted-Deployment **database retention** limitation above:
[retired database release](retired-database-release-contract.md) reuses the existing
clone fence and verifies absence plus the retained NOLOGIN role. Runtime absence
still does not prove creator closure, so locators and recurring cleanup remain.
C5's six actual runtime scenarios were rerun after this change; clone/Build inputs
in those cases remain injected. C6 adds its separate actual SQL dependency proof.
