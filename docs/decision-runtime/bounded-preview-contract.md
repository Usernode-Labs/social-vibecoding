# Bounded native preview preparation: contract

1 October 2026. Temporal adoption is deferred. C0 remains comparison evidence;
this slice implements bounded PostgreSQL execution, not a general workflow engine.

## Authority and containment

An explicitly invoked native preview request composes the validated
`RequestCandidatePreview` action, attempt-specific resource reservation and work
admission inside B2's one-aggregate transaction. Rejections create no work.
Original action receipts and a unique effect key deduplicate retries, including
lost commit acknowledgments. Existing routes and native callers are not migrated;
this API and worker require explicit experimental configuration. Defaults and
existing preview rollout stay unchanged.

Preview actions, enabling conditions and reducers own permission. The shared
queue owns execution status only. Preparation ends at `candidate`, preserving
the serving tuple and stable route. Activation still requires its existing
separate action and conditional external binding operation; preparation never
activates or overwrites a serving runtime.

## Identity and recovery

- A work UUID/effect key names one durable obligation. Its input/contract version
  is immutable. A claim UUID names one execution attempt, with persisted start,
  heartbeat and settlement records. Reclaiming work creates a new attempt without
  changing its domain flow, generation, head or resource-attempt UUID.
- Resource intent and encrypted clone credentials commit before any creation.
  A creation-start checkpoint commits before invoking the existing staging
  adapter. Every execution first inspects existing resources under retained
  resource locks; failed observation is not absence.
- A verified healthy candidate with matching physical ID, flow/head labels and
  confirmed clone completion is adopted. Lost result/decision acknowledgments
  are repaired using the same reported-fact action ID and receipts.
- The existing combined staging adapter is **not safely resumable**. It is called
  at most once for this resource attempt. After interrupted/ambiguous creation,
  an incomplete candidate is retired through its domain owner, never overwritten
  or blindly recreated. Clone existence alone is not completion. Automatic
  resumption of partially completed source/clone/build phases remains subsequent
  resource-adapter work; an explicit new domain request creates a fresh attempt.
- Expired execution claims do not revoke external ownership or prove a creator
  stopped. Resource/session/retention guards remain. Lock loss terminates the
  execution worker, not HTTP; supervised restart reconciles durable work.

## Scheduling, settlement and cleanup

The shared execution store admits work through B2, claims bounded batches with
`SKIP LOCKED`, rotates queue position before I/O, renews claims, and settles
checkpoint/result plus execution journal atomically. Expired or replaced claims
cannot start a checkpoint or domain settlement. A settlement locks the work row
and aggregate through commit; its authority is checked at entry, and it contains
no external I/O. Claim expiry during that short transaction does not let another
worker replace it before commit. Domain mapping failures poison and roll
back the complete B2 transaction, including work settlement.

The worker runs a fixed registry of handlers outside the web process. It has
bounded concurrency, polling, attempt duration and capped retry delay. Busy locks
return promptly. Retryable failures retain work without an arbitrary discard cap;
blocked/permanent outcomes stay explicit. Fair selection prevents old failing or
busy rows pinning a batch. Progress requires available storage, supervised workers,
bounded calls and capacity; fairness does not promise completion of permanent
conflicts or a fixed latency under overload.

Worker timeouts request cooperative abort and fail-stop the worker if work has
not ended; they do not release ownership and settle a retry while the old callback
continues. A heartbeat is a liveness signal, not evidence of resource ownership.

Enrolled unactivated preparation remains protected from cleanup while its domain
permission is current, including between execution claims and after preparation
success. Historical retirement uses a separate deduplicated cleanup obligation,
with the same scheduler. A bounded resource census asks the domain owner for
cleanup permission and atomically records accepted work; it does not delete
resources itself. Legacy cleanup selection excludes enrolled resources. Existing
UID/label/binding/consumer checks still execute under the retained guards.

Retired attempt locators remain discoverable even after a pass observes absence
or reports cleanup complete. Repeated reconciliation catches delayed external
creation. No age expiry or exhausted-retry deletion is introduced. Successor
bindings and resources remain protected. This slice does not retire published
consumers or compact tombstones without proof that creation/consumption ended.

## What this slice can replace

For explicitly enrolled work, durable admission and claim recovery replace the
requesting HTTP process's responsibility to keep an async preparation alive.
Execution heartbeat/retry/polling are implemented once in the shared queue/worker.
Enrolled cleanup execution moves out of the legacy cleanup timer; its resource
census becomes discovery only. Legacy callers, staging/check recovery, check
harvesting and activation recovery keep their current owners. No fleet timer or
long-held resource/retention lock is removed. The combined staging operation still
holds resource guards through creation; finer isolated resource steps must prove
replacement behavior before these locks narrow.

The second execution checkpoint is now demonstrated by imported proposal return
and durable thread announcement; see the [contract](second-execution-contract.md).
It shares this queue, claims, fair retry, settlement, tracing and polling service.
It proves reuse for SQL publication; external resource-step recovery and live
rollout remain subsequent checkpoints. B2 decision coordination stays intact.

Reconsider Temporal if additional workflows need durable waits/signals/fan-out,
complex compatible deployment/history replay, or if maintaining this bounded
machinery costs more complexity than operating Temporal. Reuse C0's failure
matrix and include service/storage/retention/security costs in that decision.

## Implementation and operation

- [`preview-flow/work.js`](../../src/services/preview-flow/work.js) is the trusted
  internal owner. `request(action)` requires both `nativePreviewWorkerEnabled:
  true` and the existing native-attempt opt-in; it accepts CLI handoffs only.
  No HTTP/MCP route invokes it. Authentication remains a future caller-adapter
  obligation, not a capability encoded in an action payload.
- [`execution/store.js`](../../src/services/execution/store.js) composes admission
  and domain settlement through B2. Claims use PostgreSQL time and rotate durable
  positions before I/O. A receipt means an accepted decision; a claim means
  permission to attempt delivery, not resource or lifecycle authority.
- [`execution/worker.js`](../../src/services/execution/worker.js) supplies the fixed
  handler registry, bounded slots, renewable claims, capped retry backoff and
  fail-stop duration bound. Work IDs, attempt rows and `execution_work_events`
  correlate with the causal action and preview's versioned reducer traces.
- [`preview-preparation-worker.js`](../../scripts/preview-preparation-worker.js)
  is a separate process entry point. After applying the normal platform schema,
  a supervised process with the existing platform service configuration can run:
  `PREVIEW_PREPARATION_WORKER_ENABLED=true node scripts/preview-preparation-worker.js`.
  It needs the same database, runtime access, encryption key and resource guard
  environment as staging. No deployment manifests or admission defaults change.
  Disabling new admission must not stop recovery of accepted obligations.
- Legacy cleanup skips resources owned by `bounded`; the worker's rotating census
  discovers those resources, and domain actions admit recurring retirement work.
  Runtime observation validates the built head, flow label, physical UID/image and
  health. The clone-completion marker remains mandatory. Preparation suppresses
  legacy progress/projection writes instead of acquiring unowned write permission.

The worker must be supervised and configured for the original external backend.
Locators are runtime names and namespaces, not portable cluster/daemon identities;
changing external endpoints underneath pending obligations is unsupported. This
slice does not prove live-cluster fencing, failover, automatic blocked-work repair,
partial-clone resumption, published-consumer retirement, journal/tombstone retention
limits, or production worker deployment. These are explicit subsequent contracts,
not guarantees provided by queue leases. Repeatedly retired tombstones consume
storage and reconciliation capacity until creator termination can be proven.

The required regression job is `scripts/test-preview-flow.js` with a disposable
`PREVIEW_FLOW_TEST_DATABASE_URL`. New tests use real PostgreSQL and process death;
Docker/Kubernetes operations are injected transports. Existing runtime safety
suites remain required. A live deployment demonstration is still a rollout gate.

## Discovery liveness correction

Execution polling and discovery are independent, awaited loops. Discovery never
occupies an execution-pool connection. Its separate one-connection pool bounds
connection acquisition (1s), PostgreSQL lock waits (100ms) and each statement (1s),
including the rotating selection and every B2 admission transaction. An unavailable
aggregate defers that obligation and later rows in the batch are still considered.
PostgreSQL cancels timed-out statements; B2 awaits the error and rollback before
releasing the client. No JavaScript timeout race or detached transaction is used.
Discovery cannot overlap itself, and shutdown joins both loops and closes its pool.
Waiting between scans is interruptible; active database operations are awaited.

The real PostgreSQL regression holds the oldest session row lock throughout
unrelated preview completion and later cleanup completion, verifies the blocked
obligation has no partial decision/work admission or idle aborted transaction,
then releases the lock and observes its deferred cleanup complete. The selected
resource remains retained/rotated for retry; atomicity and ownership checks stay.
Server-side deadlines assume a reachable PostgreSQL server; process supervision
still contains transport failure or unresponsive execution. This does not claim
an absolute network-outage/shutdown bound or transaction-wide deadline.
