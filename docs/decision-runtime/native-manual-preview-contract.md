# Ordinary native manual preview requests

The canonical integration is pinned to `da6ecb00880cab9a1749a6256992fb3d1706d9be`.
This cutover enrolls only ordinary native (`source NULL/'native'`), non-headless
Kubernetes/kpack sessions through deploy, ensure and recheck. Admission is
separately default-off (`PREVIEW_NATIVE_MANUAL_ENABLED`). CLI upload/sync policy
and legacy Docker/imported/headless callers retain their existing boundaries.

## Authority and identity

Deploy remains owner-only, active/promoted; recheck remains owner/write-admin,
active/paused/promoted. Ensure retains owner/shared/review-member access. The
router's authentication, membership/collaboration and same-origin guards remain.
The action rechecks source, status, branch, busy turn, checks pin, preview pointer
and request authorization under the shared aggregate lock. Promoted/merging
requests must use the reviewed revision; manual requests cannot change approvals.
Deploy resolves an exact GitHub branch revision. Ensure/recheck use the accepted
checks/review pin, resolving the branch only when an active session has no pin.
A branch lookup failure is not permission to build `latest`.

Each mutating intent supplies a UUID `Idempotency-Key`. The session/UUID receipt
stores actor, kind, accepted head and work identity atomically with admission.
Before source lookup, a retry checks that receipt; even a completed or superseded
request returns its original work. Reusing an ID for a different actor or kind
is rejected. A new ID is a new intent; concurrent requests for an outstanding
head join the same work. A completed recheck with a new ID may request new checks.
Receipt retention lasts as long as supported request retries; do not delete it
as a consequence of attempt retirement.

## Existing owners reused

A native head action and required complete preparation commit together. It does
not write CLI upload/head fields or alter the session source. Candidate acceptance
durably enqueues the existing continuation. Conditional activation remains
separate from preparation. The continuation owns pinned checks; settlement owns
verdict/history/graduation and durable gates. The existing manifest/harvester and
preview retirement own original Jobs, consumers and predecessor resources.
Historical CLI table/work names are persisted identifiers, not source policy.
No additional executor or preparation/settlement implementation is introduced.

Admitted work recovers with both admission switches off. An unresolved activation/resource admission returns an explicit waiting response
after rolling back the entire head/work composition. A new preparation while
admission is off is rejected explicitly, never handed to a legacy builder.
Preparation and stale completion/cleanup preserve serving and successor resources;
unresolved external creation remains discoverable through the existing owners.
Alternate staging/rebuild/recheck entry points must join the durable owner for any
enrolled session. An alternate check caller cannot launch capture without the
matching flow authority. Unenrolled legacy behavior remains until its own cutover.

## Verification boundary

HTTP/PostgreSQL tests exercise real route admission, transactions, actions, work,
continuation and failure recovery in an ownership-verified disposable database.
GitHub source transport and resource/check services are injected in these tests;
prior actual-resource proofs establish the unchanged preparation/retirement
adapters, not a production installation. Admission stays off; no rollout is claimed.

## Demonstrated results and limits

Real HTTP and isolated PostgreSQL demonstrate concurrent admission, rollback after
partial work writes, process-owner recreation, candidate/activation/verdict lost
replies, durable continuation, stale snapshot/completion rejection, exact reviewed
merging policy, admission-off recovery and original manual-request identity after
completion/supersession. Native manifests reserve/release the existing preview
consumer; native settlement records history once and durably invokes the substituted
merge policy. Source, runtime/check execution and deletion facts are injected here.
No new actual Kubernetes/registry evidence or production compatibility is claimed.

Already enrolled CLI preparation/continuation/settlement/retirement formats and v3
traces remain supported. CLI's older headerless manual request protocol still uses
its previous join/repair behavior; completing its intent-receipt protocol is a final
caller-consolidation item, not proved by the native UUID tests. Legacy/unmigrated
head writers may leave a durable pin/enrollment mismatch. Recovery exposes
`native_head_admission_required` with native admission as reconciliation owner;
this slice does not automatically accept their revisions. Finish those head-writer
cutovers before enabling the cohort. Original Job creation/cleanup uncertainty,
external creator fencing, retained artifacts and private screenshot limitations
remain as documented for the shared foundation.


Same-head recheck follow-up: new checks now require validated command admission,
not forced observational native recovery. Completed request retries preserve their
receipt; fresh rechecks while admission is off or prior consumers remain unresolved
return an explicit rejection/waiting outcome. Testing resubmission composes metadata
and continuation atomically; see [native rechecks](native-recheck-contract.md).
