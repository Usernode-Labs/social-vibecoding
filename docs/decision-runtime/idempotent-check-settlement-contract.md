# Idempotent checks settlement for the enrolled CLI flow

## Identity and authority

A capture run UUID and its pinned revision identify one settlement. A forced recheck has a new run, even on the same revision. Only the current enrolled flow, verified serving binding, activated revision, running capture lifecycle and current manifest owner may accept a first verdict. Reports have decision action IDs; accepted receipts additionally have a unique `(session_id, run_id)` slot and pin the revision. Rejected reports retain traces without occupying that slot, so an obsolete reporter cannot prevent its replacement owner from settling. A stored settlement is immutable: replay returns its original verdict, including after supersession; replay does not authorize new publication or follow-ups.

The CLI checks machine accepts validated facts, applies pure guards/reducers and produces data-only gate effects. Its persistence mapping uses the shared decision transaction. It locks the session, then its manifest, then the app row. The app lock coordinates enrolled settlements across sessions because graduation history belongs to the app. Existing history upserts preserve arithmetic and first-pass graduation for legacy writers; legacy writers do not acquire this new app lock and remain outside the complete settlement guarantee.

## Atomic settlement and delivery

The verdict, compatibility console columns, check history, decision receipt/trace and required gate work requests commit together. Any mapping failure rolls everything back, including when a composition catches it. The existing history policy is unchanged: first pass graduates and later failures do not demote a retained check; observed repeat counts accumulate; any failure resets the streak; an infrastructure/error outcome records no history. Dispatch/advisory policy and legacy bootstrap remain unchanged.

A committed receipt wins over an error encountered after COMMIT or during optional artifact work. On a lost acknowledgment, recovery reads and adopts that receipt before attempting another write. It cannot replace a committed passing/failing verdict with an error or count the same run again.

Passing/skipped settlements durably request the existing merge-queue policy check; failing settlements durably request the existing bot checks policy. Stable effect identities deduplicate their admission. Delivery uses the shared fair, recoverable execution queue outside the web process. Each delivery rechecks the enrolled run/revision and current session before invoking the existing policy service. Superseded work completes as obsolete. A delivery error remains retryable; a lost delivery acknowledgment may repeat a policy invocation. An active/paused proposal completes delivery as not yet in review, matching the existing policy; later promotion retains its own merge trigger. Existing merge claims and bot queue uniqueness still own external deduplication. This is not an exactly-once GitHub merge guarantee.

Checks continuation is complete after verdict settlement and consumer retirement, with required gate requests durably admitted. Gate requests retain their own execution owner until delivered or obsolete. Screenshots, shots scheduling, notifications, display-only platform-variable refresh and PR body updates are optional and do not carry required gate ownership.

## Containment and evidence

Only already-enrolled CLI capture runs use this mapping. Admission remains default-off; legacy callers retain their safeguards. No production destination is used by the proof. Tests must verify disposable PostgreSQL ownership before mutation, and actual Kubernetes evidence uses the existing dedicated fixture preflight.

Required regressions: partial-write rollback; restart and lost COMMIT reply; duplicate and conflicting settlement; concurrent sessions sharing app history; supersession; required delivery retry/lost reply. Retained check manifests and lifecycle retirement continue to own unresolved late creation; settlement does not establish that Kubernetes creation or cleanup has ended.

## Compatibility and limits

Already-admitted pending runs use the new settlement mapping. New manifests pin `cliFlowId`; retained manifests without it use the existing current-run, head, enrollment and verified-serving-binding guards. Old terminal verdicts written before this contract have no atomic receipt. They must not be backfilled by replaying history, because it is unknown whether the old best-effort counter write succeeded. Their required-delivery status needs the supported-store/reconciliation decision; no historical exactly-once guarantee is claimed.

Classification retains existing dispatch/advisory and bootstrap semantics. The app lock serializes final history application across enrolled sessions, not external check execution or every legacy writer. The same 90-day stale-history pruning policy is included in atomic history application; the legacy wrapper retains its best-effort failure behavior. Required history writes never swallow failures. Gate delivery is at least once; production GitHub/bot execution, public-edge/private-user compatibility and retained-store/trace policy are subsequent gates. Settlement does not replace cleanup, lifecycle locks, other callers' owners or recovery timers.

## Implementation references

- [Actions and pure reducer](../../src/services/cli-preview-handoff/settlement-reducer.js)
- [Mapping, receipts and durable gate delivery](../../src/services/cli-preview-handoff/settlement.js)
- [Strict shared history mapping](../../src/services/check-history.js)
- [Live settlement](../../src/services/visuals.js) and [harvested settlement](../../src/services/check-harvest.js)
- [PostgreSQL regressions](../../tests/cli-check-settlement-postgres.test.js) and [actual browser recovery](../../tests/cli-preview-checks-integration.test.js)

## Bounded evidence

Focused contract runner: 992 passed, including 11 real disposable-PostgreSQL
settlement regressions and strict existing-policy delivery tests. Actual checks/
retirement matrix: 15 passed in the dedicated local cluster/database/registry;
SIGKILL after verdict COMMIT preserved receipt, history and required gate work.
The final owner/run correction is covered by that actual rerun; subsequent optional
diagnostics and the unchanged pruning policy are covered by PostgreSQL regressions.
GitHub/bot policy service failures and duplicate delivery are injected; no production
external merge/bot execution is claimed. Fixture metadata/private-origin transport
and failure timing remain substitutions. All fixture resources were retired with
ownership verification. The local ledger records full evidence and the existing
unrelated launcher failure in the broader mapped run.
