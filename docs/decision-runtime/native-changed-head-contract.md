# Ordinary native fork submission: exact head and durable preparation

This slice covers the existing `updateProposalFromForkBranch` app-repository
submission path for ordinary, non-headless Kubernetes/kpack sessions selected by
`nativeManualPreviewEnabled` or already enrolled. It does not admit another cohort.
Imported, CLI, user-fork, headless and unenrolled/disabled callers keep their named
legacy paths.

The producer retains membership/owner checks, a freshly verified GitHub link,
fork attribution, ancestry and the lease-checked push. It verifies the landed
branch head before submitting `AcceptNativeSubmissionHead`. The action guards
owner, lifecycle, branch, previous check/review pins, approval epoch and serving
identity. Under the shared aggregate transaction, acceptance changes the exact
check/review head and schedules complete preparation, receipts and traces together.
Testing metadata and the active/paused Changes-ready card join that transaction. Preparing preserves the serving runtime;
activation, checks continuation, settlement and retirement keep their existing
owners. Candidate completion durably schedules continuation.

Promoted submissions use the existing mirror/classifier: mechanical/resolved
moves keep approvals; authored/unknown moves increment the epoch; first binding
keeps unbound approvals. Mechanical moves alone can carry a current green verdict.
Summary invalidation preserves an author's fresh exact-head summary; shots use the
existing stale-head policy. Optional PR/title/description/shots-intent projections
remain outside required preparation ownership.

Same accepted session/head retries (including headerless retries with unchanged testing metadata) return the original work even after completion
or while admission is disabled. A stale snapshot cannot accept a different head
or rewind a successor. A push can succeed before the database transaction or its
reply fails: retry verifies the author's fork and current app branch, then admits
the landed head or adopts its committed work. Git and PostgreSQL are not atomic;
there is no claim of autonomous recovery of a push interrupted before admission.
The submitter owns retry/reconciliation of that unaccepted external mutation; no
new pending verdict is committed without work or a recorded obligation.

Paused sessions do not start preparation. Enrolled submissions while admission is
disabled likewise record a blocked head/preparation obligation atomically, with
no legacy fallback or claim that checks started. The existing bounded discovery
and explicit recovery consume it after the session is active/promoted and
admission is enabled. Its native policy is distinct from CLI sync, although the
existing `sync_reconciliation` storage/discovery slot is reused. Admitted work
continues recovering with admission disabled. Unresolved external creators and
consumers remain discoverable through the existing retirement owner.

Removed ownership for this caller: independent pending/pointer reset, active web
handoff builder/publisher, paused direct teardown, promoted best-effort head/check
handoff and detached required checks. Legacy code remains for excluded callers.
This is not completion of the full preview/check migration.


## Verification and limits

The actual `updateProposalFromForkBranch` producer, PostgreSQL aggregate locking,
head/metadata/card/approval/summary/shots persistence, work admission, candidate
commit, durable continuation and worker decisions run together in 18 focused
regressions. They cover interruption after enqueue, a real COMMIT whose reply is
lost, push reply loss, concurrent retries/newer-head admission, supersession,
blocked/paused recovery, fresh enrollment containment, source readback failure,
mechanical green carry, exact-head author summary and completed/headerless retry.
Capture/build/runtime/activation, GitHub identity/transport and mirror
classification facts are substituted. This adds PostgreSQL integration evidence,
not another actual Kubernetes/build/check Job or production installation proof.

The consolidated contract run passed 1,151 tests; the final affected boundary and
API run passed 614 with no skips/failures. SQL validated 3,301 unique statements
(4,213 variants). Projection audit still finds 16 named legacy statements: this
caller stops reaching them, but excluded callers still need them. The mapped run
selected 529 suites and passed 9,302 tests, with two skips and two failures; its
introduced HTTP-status inventory omission was fixed and the affected suites passed.
The separately established canonical macOS occupied-port launcher failure remains.
No executor, work kind, rollout flag or cleanup owner was introduced. Default-off
switches, legacy callers/protections, retained-resource guards and supported
v3/v4/v5 admission traces remain. Removing retained replay support requires its
inventory/export decision; no frozen reducer copy was added.

Final receipt boundary: original submission request/work identity survives a distinct same-head manual repair. The original required preparation and accepted admission journal remain available for supported live retries; do not remove their locators during trace retention/export consolidation. No frozen reducer copy or new request table is introduced. Final native/CLI/protocol receipt run: 448 pass, no skips/failures (`/private/tmp/native-submit-receipt-final.log`); final SQL: 3,301 unique / 4,213 variants.

Required preparation guard rejection (including retained consumer capacity) rolls the transaction back and returns explicit reconciliation. It is ordinary waiting, not a failed build. The landed Git mutation still requires submitter retry after the existing retirement owner releases the constraint. The accepted serving head/verdict/card remain intact; no new pending verdict or fallback builder is committed.
