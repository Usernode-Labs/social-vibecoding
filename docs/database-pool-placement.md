# Shared database pools and the central migration

Decision: 2026-09-24. This is the next implementation plan, not an enabled
allocator or authorization to migrate production. It supersedes dedicated-app
promotion as the next milestone. The existing staging move/recovery machinery
remains useful as the execution engine; a dedicated cluster tier is deferred.

## Target shape

- Keep the SV platform database in its Argo-managed central CNPG cluster.
- Create a small fleet of shared app pools through the admin control surface,
  using approved CNPG resource/storage/replica profiles. The existing create
  flow only accepts preconfigured target IDs; arbitrary new pool creation still
  needs implementation and scoped infra permissions.
- Each app has one durable assignment to a pool. Pool identity survives primary
  failover and is independent of physical worker names. No automatic rebalancing
  of existing apps when utilization changes.
- Keep disposable previews single-instance. Independent preview-pool routing is
  a separate capability; current app-family routing follows the app's binding.
- Dedicated per-app clusters and the product flow to promote/demote into that
  tier are deferred. Shared-to-shared maintenance moves remain useful internally.

## One reviewed bulk migration

The admin flow is: select eligible shared pools, generate a dry-run distribution,
review assignments/capacity/exclusions, confirm planned downtime, then start one
persisted batch. This is one operator action containing individually checkpointed
moves, not one PostgreSQL transaction and not an all-or-nothing rollback.

1. Inventory current app databases, sizes, activity, owners, binding identities,
   active previews and supported PostgreSQL features. Exclude the platform DB
   and unselected apps explicitly; account for templates/previews instead of
   treating every SQL database as an independent app.
2. Place the largest/most demanding apps first into the pool with the most
   suitable remaining capacity. Balance projected utilization relative to each
   pool's budget; equal app counts are only a tie-breaker for similar apps.
   Include existing assignments and outstanding reservations.
3. Freeze the reviewed app-to-pool mapping, source/destination UIDs, expected
   binding revisions, estimates and policy version in durable batch intent.
   Revalidate before each child move; changed state pauses the batch.
4. Initially execute one app at a time. Extract a batch maintenance context from
   the existing operator so it can hold its lock and pause platform writers once,
   rather than restarting the entire platform between every app. Quiesce the app
   being copied and any of its writers; restore it after its own cutover.
5. Reuse verified copy, writer fencing, binding cutover and explicit recovery.
   Failure stops scheduling new child moves. Completed apps remain on their new
   pool; retry resumes the unfinished checkpoint. Cancellation stops pending
   apps and recovers the current app only where pre-cutover abort is still safe.
6. Verify destination data/schema/sequences and application readiness plus a
   suitable read/write check, then delete the fenced source database and its
   exclusive owner. Source cleanup is a durable, retryable stage. Cleanup failure
   must not reverse the binding or mark the entire operation as fully cleaned.
7. Finish with an assignment report, exclusions, cleanup results and failures.
   Preserve audit/checkpoint records after removing SQL copies. Completed Pod
   cleanup is separate from database deletion.

Ordinary completed moves should leave no retired SQL copy. Before cutover, retain
only what explicit abort needs. After destination writes, recovery moves forward;
never reactivate a stale source. Existing archives need identity-checked cleanup.
Backups remain deferred to the agreed final workstream; this plan does not claim
backup recovery is available. Production execution remains a separate rollout.

## New-app placement

Use the same allocator for the batch plan and new app creation:

1. Filter to pools that are Ready, accepting new apps, compatible with the app,
   have fresh capacity information and have sufficient reserved headroom.
   Draining, unhealthy and full pools are ineligible.
2. Capacity is a pool budget, including its replicas and the underlying worker
   and storage capacity. Use storage free space/growth, memory pressure and CPU
   utilization, with connection pressure and disk latency as saturation signals.
   Do not interpret Linux cache usage as unavailable RAM or rely on one noisy
   instantaneous CPU sample. Use a smoothed, timestamped observation window.
3. Score projected utilization after adding the app's estimate. Prefer the pool
   with the lowest highest utilization across the limiting resource dimensions;
   use a deterministic tie-breaker. Keep safety/growth/failover headroom and
   include reservations that have not appeared in live metrics yet.
4. For a new app with no history, use a configurable conservative starter budget.
   Budgets account for demand; they are not hard per-database PostgreSQL quotas.
5. Atomically reserve capacity and persist the app's assignment before any SQL
   provisioning, using the app identity as an idempotency key. Concurrent creates
   must serialize/retry their reservation decision. A retry reuses the assignment;
   it never picks a new pool after partially creating a database.
6. All creation paths, including imports, forks and retries, must use the same
   reservation/binding contract. Release abandoned reservations only after proving
   that no live database remains. Resolve endpoints from the persisted binding.
7. If metrics are stale or no pool fits, report waiting-for-capacity to the admin.
   Never silently fall back to the central platform cluster.

Resource weights/thresholds and starter budgets should be explicit policy with
visible placement reasons. Start conservatively and tune from staging measurements;
no unmeasured numeric defaults are being enabled by this document.

## Implementation order and acceptance

1. Pool creation/profile and capacity inventory controls.
2. Durable capacity reservations and placement decisions, then opt-in new-app
   provisioning on shared pools. Generalize the current static binding allowlist
   and central-origin assumptions before enabling it.
3. Reviewed bulk planner and resumable batch execution with verified source cleanup.
4. Staging tests covering unequal pool sizes, insufficient/stale capacity,
   concurrent creates, retries, partial provisioning, worker restarts during a
   batch and during cleanup, and preserving the platform DB.
5. Backup/restore workstream and separately scheduled production migration.

The installed staging release still creates unselected apps centrally, exposes
single-app moves, and retains their sources. It has no bulk-run API or automatic
placement yet. The one-off cleanup recorded in infra removes existing retired
copies; automatic post-verification deletion is part of the next executor change.
