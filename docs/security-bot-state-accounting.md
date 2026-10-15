# Security bot campaign and accounting contract

This is the run-control and accounting slice of issue #4678, for change 8678.
It depends on the settings, identity, locks and schema in PR #5145. It adds
no scheduler, route, provisioner, key lookup or startup hook. The shipped
`security_bot.enabled` default remains false.

## Run ownership

Call `createRun(pool, { trigger, idempotencyKey })` after an explicit trusted
start action. Scheduled calls use the database's current UTC date and default
to `scheduled:YYYY-MM-DD`; a different key for an already claimed day fails.
Manual calls generate a fresh key when omitted. A repeated supplied key
returns the original run. Empty or malformed keys fail. No caller can select
an older scheduled day to create catch-up campaigns.

`claimRun(pool, { runId, owner })` serializes claims under
`SECURITY_BOT_RUN_LOCK`. One campaign may own execution at a time. Unfinished
cleanup, including exhausted teardown retries, also blocks a new campaign.
Use `leaseFor(run)` to obtain `{ runId, owner, generation }`. Renew it through
`heartbeat`; a renewal cannot revive an expired lease or extend the original
campaign deadline.

The existing database status constraint is preserved:

| Phase | Run status |
| --- | --- |
| queued | pending |
| preparing | claimed |
| probing or verifying | running |
| cancellation requested | cancelling |
| finished | completed, cancelled or failed |
| expired owner | interrupted, then one bounded recovery or failed |

Use `setPhase` in order. Successful completion requires the verifying phase
and persisted probe coverage for all six `CATEGORIES` exported by `runs.js`:
`private-data`, `admin-infra`, `secret-exposure`, `governance`, `rate-caps`, and
`prompt-injection`. Skipped or unsupported coverage cannot finish with the
`completed` outcome. Coverage counts are derived from stored probes. A limit
stop uses the existing `budget_exhausted`, `time_exhausted`, `request_exhausted`
or `calls_exhausted` outcome and can retain incomplete coverage. Independent
verification of candidate findings remains the verifier's responsibility.

Protect probe, verification and alert writes with
`withLease(pool, lease, async (client, run) => { ... })`, using that transaction
client. The row is locked and the lease is checked again before commit. A
callback that crosses its expiry rolls back. Do not do network work or
acquire the budget lock inside this callback. Before each external broker
action, use `assertCanDispatch`; count every physical target request,
including verification and retries, through `admitTargetRequest`. The HTTP
broker must separately enforce `max_parallel_requests`.

`cancelRun(pool, { runId, generation, actorId })` immediately advances the
execution generation, revokes database-backed capabilities, clears the owner,
and persists cleanup intent. Brokers must validate capabilities against this
current record, rather than accept a cached grant. `reconcileRestart` examines
persisted expiry/deadline information; it never assumes another live worker
is dead because this process restarted. Expired attempts are fenced before
cleanup or recovery. Recovery preserves the run, deadline, counters, limits
and spending; at most one recovered execution is admitted.

Run `runCleanup(pool, { owner, revokeCapabilities, stopJobs, destroyArena })`
from a trusted cleanup worker. All adapters must be idempotent and bound to
the run and `cleanup_target_generation`, including jobs whose arena reference
was never saved. Cleanup has an independent lease and generation. Failed or
crashed cleanup is retried at most three times; it remains durably failed
after exhaustion for operator action. Cancellation becomes cancelled when
cleanup succeeds. A recovered campaign cannot start before cleanup completes.
Do not give teardown adapters permission to destroy resources belonging to a
newer execution generation.

## Model admission and settlement

`invokeAccounted(pool, lease, request, dispatch, { signal })` admits exactly
one physical model invocation. The trusted dispatch adapter owns the dedicated
service credential. It must disable automatic provider retries and fallbacks.
Both attacker and defender calls use this path. A retry supplies the same
`logicalCallKey`, a new `idempotencyKey`, and `attempt + 1`; only attempts 1–3
are admitted. An earlier ambiguous call keeps its reservation during a retry.

The request contains:

```js
{
  idempotencyKey: 'physical-request-uuid',
  logicalCallKey: 'logical-request-uuid',
  role: 'attacker', // or defender
  attempt: 1,
  credentialRevision: '0123456789abcdef', // opaque hash/revision, never a key
  promptTokens: 1000, // verified upper bound, including protocol/tool overhead
  outputTokens: 4096, // includes billable reasoning tokens
  quote: {
    model: 'registered-model-id',
    provider: 'pinned-provider-id',
    upperBound: true,
    validUntil: 'a timestamp no more than five minutes in the future',
    pricing: { prompt: '0.000001', completion: '0.000002', request: '0' }
  }
}
```

The quote must come from trusted, current provider metadata. `upperBound`
asserts that routing is pinned, token limits are enforced, and applicable
tiers, provider fees and rounding are bounded. A catalogue's advertised
minimum model price is insufficient. Prices use USD per token/request as in
the [OpenRouter models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).
Reasoning is included within output usage; see the
[OpenRouter reasoning contract](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
The estimator reserves the maximum output/reasoning rate, includes cache-write
fees conservatively, and refuses unknown nonzero price dimensions or raw
conditional pricing. The gateway must refuse or normalize such prices into a
verified bound before admission. No live pricing or paid inference is fetched
by these modules.

All reservations are serialized under `SECURITY_BOT_BUDGET_LOCK`. Current
settings and the run's original limits both apply; the lower cap wins. The
default combined cap is USD 5 per UTC day. The weekly backstop is USD 35,
using Monday 00:00 UTC like Homeroom's shared weekly allowance. Outstanding
uncertainty from earlier weeks continues to count until reconciliation.
Additional finite ceilings are 60 defender calls, 1,000,000 combined reserved
or measured tokens, two retries, and one recovery. Attacker/output/request/time
ceilings come from the existing settings snapshot.

The ledger stores money at its existing four-decimal precision and rounds
up with exact integer arithmetic. `reserved_usd` is the outstanding hold;
`spent_usd` is settled spending; `released_usd` records unused released bounds.
The admission decision includes all concurrent reservations. A dispatch marker
is committed before calling the transport, so an uncertain crash is never
permission to replay a physical call. Admission is checked again at dispatch.
Reservations cannot be dispatched on a different UTC day or with stale pricing.

The transport returns `{ costUsd, usage, generationId, result }`. Optional
usage is `{ promptTokens, outputTokens, reasoningTokens }`, with reasoning a
subset of output. Only safe accounting fields are persisted. An authoritative
provider charge settles the original day's reservation. If only tokens or an
ambiguous error/timeout/cancellation are available, keep the charge unknown
and the full bound reserved. Cancellation signals abort the waiting wrapper,
but cannot prove the provider did not bill a dispatched request.

Use `reconcileInvocation(pool, currentLease, callId, providerResult)` from the
trusted controller to resolve a fenced attempt. After a run stops, pass its
current `{ runId, generation }`; an active run also requires the current owner
and unexpired lease. An undispatched reservation can be released as a proven
zero-cost cancellation. Repeated settlements are idempotent; conflicting ones
fail. Actual charges above a bound are recorded truthfully and block further
admission pending operator review. Provider rounding and in-flight uncertainty
are never silently converted to zero spending.

The arena, broker, provider quote resolver, scheduler and full-admin API must
integrate these seams in the remaining release work. Neither this slice nor
its scripted transport tests authorize activation or any live scan.

## Local validation

The two `security-bot-*-postgres.test.js` suites execute the full schema in
isolated databases, including concurrent connections and a separate-process
budget read. Set `TEST_DATABASE_URL` to require Postgres instead of permitting
an unavailable-database skip. Provider and cleanup adapters in these suites
are scripted fixtures; there is no live provider charge or attack traffic.

Run the repository's changed-file suites against the recorded base and run
`npm run lint:sql` with `SQL_CHECK_CONNECTION_URL` pointing to a disposable
local Postgres instance. No generated shell artifacts belong in the commit.
