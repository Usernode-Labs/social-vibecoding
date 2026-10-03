# Enrolled CLI sync-head acceptance

This cutover applies only to sessions already enrolled in the bounded CLI path.
Unenrolled callers keep their existing policies and safeguards. Admission remains
default-off; this work does not authorize rollout.

The sync worker owns the Git merge/push. Its successful result and a fresh branch
read identify the revision; a local upload awaiting submission does not. Acceptance
compares the original session, branch, head, upload, checks, review and serving
runtime snapshots under the shared aggregate lock. A concurrent newer acceptance
rejects the old fact. Repeated delivery of the accepted revision joins its stored
work instead of preparing again.

One decision transaction accepts the head, invalidates the summary/shots for the
new revision, applies the canonical promoted approval classification, pins required
checks and admits the existing complete preparation request. It preserves all
serving-preview pointers. Mechanical/bounded conflict-resolution merges keep the
approval epoch; other promoted changes advance it. Existing shots invalidation and
summary freshness rules remain the owners of their policies. Git inspection and
optional notifications happen outside the transaction.

Canonical sync still prepares and checks the new revision even for a mechanical
merge; its previous promoted tail rebuilt after review reconciliation. Explicit-
approval classification in the sync service remains unchanged. The new actions
extend the current CLI v3 machine without changing existing actions' decisions or
adding historical versions. Scheduling timestamps are excluded from reducer inputs.

With new admission disabled, the same transaction records an explicit sync
reconciliation obligation and a blocked checks phase. It does not launch a legacy
builder or report checks started. The enrolled handoff owner retains this obligation;
recovery admits its exact revision when admission is enabled, provided the lifecycle
and revision still permit it. Previously admitted work continues with admission off.
Supersession replaces the current obligation without granting obsolete work
activation or verdict authority; existing resource retirement remains responsible
for its late creators and consumers.

Preparation and activation remain separate. Accepted candidate completion durably
enqueues the existing continuation; activation and capture use their existing
guards. The web sync call owns neither preparation nor a detached staging/recheck
tail. After interruption or a lost commit reply, redelivery/recovery inspects stored
admission, work and continuation identities. It never relies on the HTTP reply as
proof of acceptance.

Verification uses owned disposable PostgreSQL and the real sync-to-handoff
integration, reducers, mappings and queue. Git/worker results and resource/check
execution may be injected and must be identified as such. This evidence does not
establish new Kubernetes installation compatibility or close the full migration.
