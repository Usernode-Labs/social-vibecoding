# C8: local CLI preview handoff

Admission requires `PREVIEW_CLI_HANDOFF_ENABLED=true`, Kubernetes/kpack and the
existing enabled checks lifecycle. It is default-off and selects only native CLI
handoffs, including their exactly pinned managed promoted revisions. This owner
scopes recoverable clone, Build and runtime capabilities to its own preparation
requests; the switch does not enable those capabilities for other callers.
The dedicated worker is started separately. Imported proposals,
Docker and other Dev callers retain their existing paths. Persisted enrollment,
rather than the admission flag, determines the recovery owner after admission.

- **Admission:** existing route authentication, membership, uploaded-head and GitHub
  ancestry checks remain. Under the shared session transaction, a validated action
  accepts the head and pending checks, then admits exactly one preparation request.
  History, spec and visible-change revisions join that transaction. Rejection or
  an operation error rolls it all back. A retry of the accepted head returns its
  stored request. Explicit resubmission after a completed preparation failure may
  admit one fresh isolated attempt; queued, running or uncertain work is joined.
  GitHub advancement remains
  an external precondition, not an atomic participant in PostgreSQL.
- **Preparation:** the existing external worker owns source → clone → Build →
  runtime. Candidate acceptance, the CLI handoff fact and a stable continuation
  request commit together. Preparation preserves the serving preview. Neither the
  request handler nor repair/recheck paths may build an enrolled session.
  The preview reducer also rejects competing preparation requests under the same
  aggregate lock: only the candidate action tied to this admission may create a
  flow. The direct builder fence alone would leave a supersession race.
- **Activation:** the continuation worker requests activation through the preview
  actions and uses the existing conditional binding adapter, resource locks and
  UID/image/health verification. Lost replies are resolved by inspecting the
  desired/observed binding. A newer head cannot bypass unresolved activation.
- **Checks continuation:** after observed activation, a validated handoff action
  authorizes the existing capture/check policy. The work request remains pending
  until the same head has a persisted verdict or policy deferral. A restart after
  that write adopts it. A restart before it retries under the existing preview
  lifecycle, which fences/cancels orphan checks. This is recoverable at-least-once
  invocation, not exactly-once external checking or notification delivery.

Stable identities belong to the accepted head, preparation effect, candidate fact
and continuation effect. Execution attempts retain their separate claim identities.
Both domain owners use the same aggregate lock and decision runtime. Superseded
work cannot activate or start checks for the new head; existing guarded checks
writers reject an old verdict. Claims expiring do not prove creation has stopped.
Cleanup keeps the late-creation tombstones and the existing database fence.

Repair requests join the enrolled owner even with admission disabled. Missing or
conflicting resources are not an invitation to fall back to the old builder.
An authorized missing-preview repair may admit one replacement only while
admission is enabled and the caller's observed runtime name still matches. This
prevents a delayed repair request from replacing its successor. New-head admission
is disabled when the switch is off; existing work and checks recovery continue.
Explicit forced rechecks retain existing admission/check policies and receive a
durable continuation request. Same-head visible-change amendments keep their
existing policy; new-head history/spec/visible changes join atomic admission.
The legacy web activation timer excludes enrolled flows. Global locks,
recovery/check-harvest owners and
legacy builders needed by other callers remain. No production rollout, migration
of imported proposal revisions or general execution engine is part of this slice.

## Evidence and limits

`tests/cli-preview-handoff-integration.test.js` uses real source checkout, database
clone, kpack Build, Kubernetes runtime/health and conditional Ingress replacement.
Separate processes are killed after admission, atomic candidate/continuation
completion, the external activation change before its receipt, observed activation
and guarded checks persistence. Recovery preserves the database OID, Build UID and
digest, all three runtime UIDs and Ingress UID. The serving binding is unchanged
during preparation; the previous runtime remains healthy after activation.

GitHub route responses and checks execution are injected. The verdict uses actual
guarded PostgreSQL persistence. These tests exercise the durable admission service
across process loss, not an actual HTTP server crash or real public capture/check
Jobs. Fixture template selection, internal database address translation, Service
proxy health transport, edge warmup and notifications are documented substitutions.
The public sample does not exercise app-specific database migrations. Local
Ingress API evidence does not establish production edge/TLS or compatibility.
Supersession/recheck/atomic rollback tests use actual PostgreSQL with injected
resource facts; C7's rerun supplies actual predecessor/successor cleanup evidence.

Checks retain their existing lifecycle and harvest owner. Interrupted invocations
may repeat checks or notifications; this slice durably preserves the obligation,
not exactly-once external delivery. Uncertain activation blocks new admission;
unresolved creator closure keeps recurring cleanup obligations. Long-held resource
locks and retention protections remain. Preview v10 adds admission ownership;
frozen v9 preserves retained replay. Historical pruning requires a retained-data
audit, not a new permanent compatibility promise. The overall migration is incomplete.
