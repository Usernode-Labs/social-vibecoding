# Second execution workflow: imported proposal return

This contained checkpoint uses the existing proposal-review domain: returning an
imported proposal to development and recording its announcement in the proposal's
thread. Admission requires an explicit experimental service flag. Existing routes
continue their current behavior; no native worker-stop or caller migration occurs.

`RequestImportedReturnToDevelopment` uses review's ownership, busy/secret/status
rules, changes status/vote epoch and atomically admits its announcement work through
B2. Native proposals are rejected by the domain guard for this bounded entry point;
none of their required worker-stop effects are silently dropped. Original action
and effect identities deduplicate acknowledgment loss and interrupted delivery.

The worker prepares no external resource. A stable `RequestReturnAnnouncement`
action names the original return decision; its reducer obtains content and thread
identity from that receipt, not from worker-supplied text. This is a historical
notice: subsequent status changes do not revoke an already accepted return. A
missing/deleted or moved aggregate cannot grant permission to a different project.

The domain mapping inserts the thread message in the same B2 transaction as its
publication decision receipt/trace and queue settlement. Retry cannot produce a
second message after committed acknowledgment loss. Message history is durable;
WebSocket/push delivery is outside this checkpoint and is not claimed exactly once.
Readers see the message through ordinary thread reads. No external notification
is sent from inside an open decision transaction.

Both preview and review handlers use one fixed-registry execution store/worker and
shared polling service. They do not copy transaction, claim, deduplication, retry,
scheduling, settlement or trace code. Review and preview decisions sharing a
session serialize through B2; domain SQL mappings remain explicit. Discovery uses
the bounded dedicated pool and independent awaited loop already demonstrated.

Required evidence: atomic return/work admission, genuine domain rejections,
interruption/reclaim and acknowledgment loss, caught-error rollback including
message/queue/journals, fair progress across both handler families, and shared
aggregate locking. These tests use real PostgreSQL. Append-only SQL effects do not
prove external Job adoption or permit removal of preview resource protections.

## Implementation and demonstrated boundary

[`proposal-review/work.js`](../../src/services/proposal-review/work.js) exposes
`request(action)` with `proposalReviewWorkerEnabled: true`. Its imported-specific
action is validated by review's schema and guard. No existing route calls it.
The worker registry processes accepted work even when new admission is disabled.

[`proposal-review/store.js`](../../src/services/proposal-review/store.js) composes
through B2 and explicitly maps authorized announcements to `chat_messages`.
The domain snapshot loads the original receipt and prior announcement identity.
The reducer rejects missing originals or project changes and recognizes an already
recorded announcement even with a different publication action ID. Review reducer
v2 is traced; frozen v1 remains replayable. Existing return actions retain behavior.

[`execution/service.js`](../../src/services/execution/service.js) shares polling,
nonoverlapping discovery and joined shutdown. Both handlers use the existing
execution store/worker unchanged; no second queue, transaction manager or retry
implementation was introduced. Discovery retains its dedicated bounded pool.
Shutdown avoids starting another long sleep after an active operation finishes.

The second-workflow regression job is included in `scripts/test-preview-flow.js`:
real PostgreSQL proves admission failure/acknowledgment loss, interruption/reclaim,
message deduplication, publication rollback/acknowledgment loss, caught-error
rollback including earlier preview decisions, shared aggregate contention with
unrelated progress, and multibatch fairness/retry across both handler families.
These establish the bounded second execution checkpoint. The SQL publication
shape does not demonstrate another external-resource adapter, automatic push/
WebSocket delivery, native worker ownership or broader caller migration.
