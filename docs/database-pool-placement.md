# Shared database pools and the central migration

Decision: 2026-09-24. This is the next implementation plan, not an enabled
allocator or authorization to migrate production. It supersedes dedicated-app
promotion as the next milestone. The existing staging move/recovery machinery
remains useful as the execution engine; a dedicated cluster tier is deferred.

## Implemented staging foundation

The [operator workflow and read-only capacity inventory](database-pool-operations.md)
are deployed in staging. SV pool creation is disabled and its provisioner is stopped;
existing pools are retained. A second shared pool was created through the operator
CLI and verified under repeated reconciliation. New-app placement, reservations and
bulk execution remain the next increments; capacity observations do not admit apps.

## Target shape

- Keep the SV platform database in its Argo-managed central CNPG cluster.
- Infrastructure operators create, resize, restore and retire shared app pools
  through declarative infra/GitOps workflows. SV does not create CNPG clusters,
  resize their resources or change their replica counts. New pool-creation UI
  and platform-driven infrastructure provisioning are out of scope.
- Each app has one durable assignment to a pool. Pool identity survives primary
  failover and is independent of physical worker names. No automatic rebalancing
  of existing apps when utilization changes.
- Keep disposable previews single-instance. Independent preview-pool routing is
  a separate capability; current app-family routing follows the app's binding.
- Dedicated per-app clusters and the product flow to promote/demote into that
  tier are deferred. Shared-to-shared maintenance moves remain useful internally.

## Responsibility boundary and capacity warnings

**Infra/operator:** own pool definitions, resource/storage budgets, replicas,
backup/restore, credentials distribution, networking and lifecycle. Provision
and verify a pool before publishing its stable ID, cluster identity, endpoint,
secret references, capacity budget and admission state to SV. Mark a pool as not
accepting new apps before maintenance or retirement; existing assignments remain
valid until separately migrated. Using Crossplane internally is an infra choice,
not an API capability the SV web process needs.

**SV:** consume the approved registry, observe readiness/capacity, select a pool
and atomically reserve an assignment during app creation, then provision the app's
SQL database/role there. Keep that binding for normal app database lifecycle and
routing. Imports, forks and creation retries follow the same contract. Existing
apps are not automatically moved or reassigned when capacity observations change.
The platform has no pool-lifecycle mutation permissions in the final design.

Expose read-only pool capacity and actionable warnings in the admin surface:

- Near the configurable safe-capacity threshold: warn operators while continuing
  to place apps on pools that still meet admission requirements. Show the limiting
  resource, observation age, reserved demand and affected pool.
- No eligible capacity: keep the new app in an explicit waiting/blocked state;
  do not start database provisioning, overload a pool or silently use central.
  Report whether the cause is saturation, unavailable pools or stale telemetry.
- Capacity restored or a new pool registered: retry allocation through the same
  idempotent app-creation path. A partially provisioned app keeps its assignment;
  it must not be allocated elsewhere simply because another pool became available.

Warnings request operator action; they do not create infrastructure. Suggested
capacity actions distinguish enlarging a pool or adding another writable pool
from adding standby replicas. A standby is another copy of the same pool, not an
additional independent writer for new-app placement. New capacity increases
headroom for new apps; redistributing existing demand requires a separately planned
migration and is not triggered by an alert.

Staging now has read-only pool controls, an operator-local provisioning CLI and
no SV pool-creation permissions. The prototype provisioning Deployment is stopped;
its identity and existing pool resources are retained. Crossplane continues managing
operator-created composites. Other environments retain their existing opt-in defaults.

## Reproducibility and reuse

Pool setup must be declarative and reusable. Keep approved pool profiles and
fleet definitions in infra, with environment-specific values for names, storage,
resources, replica counts and secret references. Operators apply those declarations
and publish an approved pool registry to SV; reproducing an environment must not
require manually clicking through pool creation. Infra reconciliation must reuse
matching managed resources and reject conflicting identities rather than adopt
arbitrary databases by name.

Keep logical pool IDs, app assignments, reservations and migration checkpoints
as durable environment intent. The active intent records have one authority;
versioned exports/backups outside the workload cluster are recovery copies, not
an independent competing writer. Kubernetes Jobs and local workstation files
must not be the only records. Before production source deletion, the completed
assignment/checkpoint must be durably recoverable outside that cluster. Export
secret references, never plaintext credentials. This metadata recovery requirement
is part of the deferred backup/restore workstream and must be tested before the
production migration.

Separate these cases explicitly:

- **Register existing apps:** inventory their existing SQL databases and attach
  verified bindings. Do not recreate databases, reseed schemas, or rotate working
  credentials simply to bring an app under placement management.
- **Reapply pool configuration or redeploy SV:** reconcile the existing pool and
  app identities. Existing assignments win; do not rerun the allocation heuristic
  or issue fresh database creation for already provisioned apps.
- **Retry a migration batch:** load its frozen mapping and checkpoints. Skip fully
  completed apps, retry only outstanding cleanup for cleanup-pending apps, and
  resume the interrupted move. Reuse a destination only when its recorded identity,
  ownership and copy state match. A same-named unrelated database is a conflict.
  Incomplete logical imports may need to be restarted in the operation-owned
  destination; never append blindly to a partially restored schema or live DB.
- **Move to a different pool or environment:** reuse destination pools that already
  exist. A moved app still needs a destination database containing its data: create
  it once if absent, or continue the verified operation-owned copy. PostgreSQL
  databases cannot be reassigned between servers by changing a binding alone.
- **Rebuild after storage/cluster loss:** restore persistent app data from backups
  and restore its assignments. Desired-state configuration alone cannot recreate
  the data. Changed Kubernetes/SQL identities require an explicit recovery binding
  step before reconcilers resume; never silently replace a persistent pool with an
  empty cluster. Only disposable previews may be rebuilt empty automatically.

The batch plan therefore describes how to move the existing inventory, not how to
recreate every app from its starter template. Reusable fleet configuration and
idempotent reconciliation are separate from restoring actual database contents.

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

1. Operator-owned declarative fleet/profile setup and an approved pool registry.
   Replace SV pool-create controls with read-only inventory/capacity warnings and
   remove its unused infrastructure-provisioning privileges safely.
2. Durable capacity reservations and placement decisions, then opt-in new-app
   provisioning on shared pools. Generalize the current static binding allowlist
   and central-origin assumptions before enabling it.
3. Reviewed bulk planner and resumable batch execution with verified source cleanup.
4. Staging tests covering unequal pool sizes, insufficient/stale capacity,
   concurrent creates, retries, partial provisioning, worker restarts during a
   batch and during cleanup, repeated fleet configuration with no duplicate pools
   or databases, existing-app registration without SQL creation, warning/admission
   thresholds, operator-added capacity, absence of SV pool-lifecycle privileges,
   and preserving the platform DB.
5. Backup/restore of data plus intent/checkpoints, explicit identity recovery and
   a reconstruction test, then the separately scheduled production migration.

Staging now enables opt-in new-app placement through durable SQL reservations.
Existing apps keep their assignments; single-app moves still retain their sources.
The bulk-run API and automatic source cleanup remain outstanding. The one-off cleanup recorded in infra removes existing retired
copies; automatic post-verification deletion is part of the next executor change.
