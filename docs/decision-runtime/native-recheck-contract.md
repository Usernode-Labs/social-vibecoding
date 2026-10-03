# Enrolled native same-head rechecks

Recovery observes or resumes admitted work. A new native recheck is a command,
never a completed-work lookup. Its UUID identifies one intent across retry,
restart, acknowledgment loss and completion. A different explicit intent needs a different
UUID. The adapter returns an explicit blocked result when an identity is missing.

For testing-metadata resubmission, the producer derives that UUID from the session,
revision, normalized submitted metadata and previous accepted metadata intent.
Consecutive duplicate submissions reuse the last intent; A → B → A is a new
metadata transition, not a replay of the first A. Repeating the same submission delivers
the same intent, including after completion. An explicit recheck can supply
`recheckRequestId` to request another run of an unchanged specification.

A validated native action checks enrollment, current revision, serving activation,
source/owner, session lifecycle, admission and unresolved consumers. Under the
shared aggregate transaction, testing metadata, pending verdict, decision receipt,
trace and the existing continuation commit together. A rejection rolls back the
composition and reports waiting/blocked; retry can reconsider it after its owner
resolves the obstruction. Existing accepted requests recover with admission off.
A different request cannot adopt an older completed continuation as fulfillment.

The continuation and capture lifecycle remain the sole execution owners. Lost
verdict replies adopt committed facts; manifest/lifecycle recovery reuses existing
Jobs. Required capture is not started from a detached metadata-resubmission promise.
Supersession rejects obsolete delivery. Same-head changes do not clear votes or
approval epochs, or change graduation policy. Optional shots/PR projections retain
their existing owners; they are not part of the required testing transaction.

Containment stays default-off. CLI compatibility recovery and unenrolled callers
retain their existing paths. New evidence uses disposable PostgreSQL with injected
external capture/resources; it does not establish new Kubernetes behavior.
