# Shared decision runtime: B2 contract

Two distinct owners now use one decision runtime: native preview preparation,
activation and cleanup, and the proposal's **Move back to Underway** operation.
This is a database decision boundary, not an execution engine. Preview admission
remains default-off and limited to the native experiment.

## What belongs where

| Shared mechanism | Explicit domain definition |
| --- | --- |
| Connection, transaction and rollback | Action schema and enabling conditions |
| Session aggregate lock, including deleted-session fallback | State snapshot and resource rows to inspect |
| Action hash, original-receipt lookup and conflict handling | Receipt and trace table mappings |
| Atomic state, receipt and versioned trace persistence | Pure reducer and SQL mapping of its decision |
| Captured inputs and data-only effects | Trusted observations/identity allocation and effect handlers |

The implementation is [`decision-runtime/`](../../src/services/decision-runtime/).
Each machine supplies `parseAction`, `load`, `facts`, `reduce`, `persist` and
`journal` mappings, plus a reducer version and action-conflict error. Those
mappings contain ordinary, explicit SQL; the runtime does not generate domain
queries or infer transitions. Reducers receive frozen plain data and synchronously
return an accepted/rejected decision with a reason and data-only `effects`.
SQL and external I/O stay outside reducers. Freezing and JSON checks detect input
mutation and executable effects; they do not sandbox code or prohibit global
time/random/I/O calls. Purity also depends on code review and replay tests.

Only one session aggregate is supported per transaction. Machines lock the same
`chat_sessions` row before domain resource rows. After deletion, actions share
the same transaction advisory lock keyed by the original session ID. IDs must
never be recycled. Different machine locks are not substitutes for this lock.
App-wide/multi-session resources need a separately designed ownership scope.

## Concrete second workflow

The existing `POST /api/sessions/:id/unpromote` route still delegates to
[`unpromoteSession`](../../src/services/session-lifecycle.js). It now issues a
validated `RequestReturnToDevelopment` action to
[`proposal-review/store.js`](../../src/services/proposal-review/store.js).
The actor is supplied by authenticated server code, not trusted from an arbitrary
client claim. [`proposal-review/reducer.js`](../../src/services/proposal-review/reducer.js)
owns these rules:

- Only the author can return a non-headless proposal. Private sessions retain
  their existing not-found response to other users.
- A proposal in review must have no running turn, process-local busy owner or
  pending secret declaration. Merging/merged proposals cannot be returned.
- Native proposals return to `paused`; imported PRs return to `active`.
- The same commit advances `approval_epoch`, clears stale-notification and
  integration-block state, and stores the decision's receipt, effects and trace.
  Existing vote rows remain. The PR and accepted serving preview remain.
- Already-underway proposals produce a no-change decision.

The review owner then coordinates with the preview owner **inside that same
transaction**. For an isolated current attempt it sends
`RetirePreviewPreparation`, naming the execution and original review action.
Preview validates the newly stored review receipt against the
current status and approval epoch. Review does not write preview state itself.

| Which decision wins the aggregate lock first? | Result |
| --- | --- |
| Return to Underway | An unactivated preparation becomes superseded, and any reserved resource gets a cleanup obligation. Late prepared/activation facts cannot regain permission. Candidate reservation also takes the aggregate lock, so it cannot insert locators after retirement. |
| Preview activation authorization | Returning to Underway preserves the desired activation and its recovery owner. A correctly correlated route observation may still settle that authorization; cancellation cannot assume the external mutation stopped. |
| Serving/published preview already exists | Its resources and serving tuple stay protected. This operation does not retire published consumers. |

Legacy previews are not enrolled in isolated-attempt retirement by this operation.
The second workflow demonstrates review cancellation, not migration of all review,
submission, vote or withdrawal paths.

## Receipts, traces and composition

```js
const review = createProposalReview(pool);
const result = await review.apply({
  type: 'RequestReturnToDevelopment',
  actionId,             // reuse this UUID to retry the same logical request
  sessionId,
  userId,               // authenticated actor
  actorUsername,
});
```

The internal coordinator uses `runtime.transact(...)`, awaits the review decision,
reads preview through its owner, and awaits the explicit preview action. Both
machines use the shared `transaction.apply` mechanism; neither copies transaction,
deduplication or tracing code. Composition callbacks and persistence mappings are
trusted server code: await operations sequentially, do not launch detached or
parallel work on the transaction client, and perform no external I/O while it is
open. The runtime rejects a second aggregate and use of a closed transaction
handle. `withSession` is the narrow locked SQL boundary for candidate locator
reservation; it is not an action decision or trace.

A receipt is scoped by **machine journal, session ID and action UUID**. Identical
normalized input returns the original decision, even if current state has changed
or the session was deleted. Reusing that identity for different input is an error.
Accepted and rejected decisions receive receipts. A genuinely new request after a
rejection needs a new action UUID. Domain action schemas provide canonical field
order for hashing; arbitrary unordered objects are not a public action format.

Use `preview.trace(sessionId)` and `review.trace(sessionId)` to inspect captured
`pre_state`, `action`, trusted `facts`, `decision` and `reducer_version`.
`RetirePreviewPreparation.reviewActionId` links the two decisions. Pass an entry
to the corresponding domain `replayDecision` to reproduce the decision without
I/O. Preview versions 1–4 are frozen; version 5 adds review retirement. Review
starts at version 1. Reducer versions are domain-owned; the runtime does not
select historical policy. Traces are captured decision inputs, not execution
histories or proof of external completion.

## Demonstrated guarantees and remaining limits

| Boundary | Guarantee / limit |
| --- | --- |
| Decision commit | Domain changes, original receipt, data-only effects and versioned trace commit or roll back together. Review and dependent preview retirement share the commit. Failure in either journal rolls back both. |
| Contention | Independent PostgreSQL connections serialize the two machines on the aggregate. Existing merge/vote row-lock/CAS rules still compete with the return operation. Resource locks follow the aggregate for action decisions. |
| Lost database acknowledgment | Retry with the same action returns the original receipt. Vote invalidation and preview retirement are not applied again. |
| Execution delivery | No durable dispatch was added. The route still performs existing worker teardown, chat and WebSocket effects after commit, best effort. A crash/lost commit acknowledgment can leave those effects unexecuted; receipt replay does not redeliver them. The HTTP route currently generates its action UUID server-side, so the public client does not yet have a stable request-receipt API. |
| Worker ownership | The existing process-local busy check and `active_turn` check remain. They do not fence another process or stable-name worker replacement after commit. Worker teardown needs execution identity/fencing in a later slice. |
| External preview ownership | B1 attempt IDs, resource/retention locks, conditional activation, physical runtime identity checks and serving-consumer guards remain. Database locking alone does not fence external operations or bypassing legacy/operator writers. |
| Delayed creation | B1's retired isolated intents remain discoverable tombstones, including after apparent cleanup completion. Recovery can reconcile later resources; safe compaction still needs external creation settlement. |
| Coverage of other writers | This runtime governs these migrated paths, not all lifecycle SQL. Pending-secret writers, worker-start paths and other transitions have not all adopted it. No claim of global lifecycle enforcement is made. |

[`tests/decision-runtime.test.js`](../../tests/decision-runtime.test.js) uses real
PostgreSQL connections to demonstrate both lock orders, atomic cross-machine
rollback, reservation/cancellation races, stale facts, scoped receipt conflicts,
lost acknowledgments, deletion and deterministic replay. The existing
[`unpromote` integration suite](../../tests/unpromote-proposal-postgres.test.js)
also verifies the actual API route, guards, vote invalidation, effects and merge
race. Existing preview failure-path tests cover both Docker and Kubernetes through
controlled transports. No new live runtime/cluster fencing proof is claimed.

Run the required contract job with a disposable PostgreSQL database:

```sh
PREVIEW_FLOW_TEST_DATABASE_URL=<disposable-url> node scripts/test-preview-flow.js
```

**B2's shared-foundation/second-workflow checkpoint is demonstrated. The overall
refactor remains incomplete.** C0 next compares durable execution options outside
the web process. It must address effect delivery, interrupted attempts, external
ownership/settlement, retention and fair retry scheduling. Busy or repeatedly
failing work must not indefinitely block unrelated eligible work. Implement and
test those execution guarantees once across workflows, while keeping eligibility
and resource policy in domain actions/reducers. No generic executor or additional
preview caller rollout was added in B2.
