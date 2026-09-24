# Operator-managed database pools

The staging implementation provides operator-local pool lifecycle and opt-in
new-app allocation. Bulk migrations remain a separate next stage.

## Ownership and provisioning

Infra sets `operatorManaged: true` in the database control-plane policy. SV's
cluster-creation API then rejects writes, and its provisioning loop performs no
reconciliation. Set the platform chart's `databaseControlPlane.provisioningEnabled`
to `false` to keep that Deployment at zero replicas. Infra removes create/update
permissions from its web/request and provisioning identities. Existing request,
composite, CNPG and PVC resources remain intact. Crossplane still reconciles the
operator-created composites; CNPG still manages PostgreSQL.

Define a target with an approved profile in infra first, then sync its scoped
namespace, budgets, network and admission rules. From this repository run:

```sh
node tools/database-pools.js plan \
  --kubeconfig "$STAGING_KUBECONFIG" \
  --expected-cluster-uid 4cfec647-ed85-4c37-8453-fc99606a1619 \
  --target shared-b

node tools/database-pools.js reconcile \
  --kubeconfig "$STAGING_KUBECONFIG" \
  --expected-cluster-uid 4cfec647-ed85-4c37-8453-fc99606a1619 \
  --target shared-b
```

`STAGING_KUBECONFIG` is the explicit local staging kubeconfig path. These commands
use the operator's credentials, never the SV ServiceAccount. `plan` reads only;
`reconcile` creates the approved request if missing and advances the same durable
state machine used by the prototype. It checks the Kubernetes cluster UID before
any provisioning. Repeat the command to continue a pending operation or verify an
existing pool. Matching resources are reused; replaced/missing persistent resources
require explicit recovery and are never silently recreated empty.

After Ready, add the observed CNPG UID to infra's `pools` registry. Set
`acceptingNewApps: false` until runtime credentials, routing and the placement
workflow are ready. Registering a pool for observation does not enable app placement
or make it an eligible migration destination. Those permissions remain explicit.

## Capacity observations

The admin Database pools section shows registered identities and read-only capacity.
Only configured retained targets can enter the registry. A different CNPG UID or
an unavailable cluster is never treated as the expected pool.

Observations come from the configured internal Prometheus service:

- CPU: five-minute CPU rate against the CPU request of an instance.
- Memory: five-minute average working set against its memory request.
- Storage: used bytes against filesystem capacity for each instance's data PVC.
- The displayed ratio is the highest across instances for each resource.
- Every expected instance must have complete, fresh samples. Missing/stale data,
  unsupported WAL/tablespace layouts and failed queries produce Unknown.

Staging warns at 75% and reports capacity reached at 90% of these observation
budgets. Samples older than 180 seconds are rejected. These are initial diagnostic
thresholds, not enforced admission quotas or a complete measure of failover/node
headroom. Live SQL connection pressure, storage growth, disk latency and pending
app reservations are not included yet. Admission adds the durable reservations to these observations and applies the
configured admissionRatio. Completed reservations remain counted: this deliberately
overestimates demand until a later measured reconciliation policy is introduced.

## Verified staging rollout

Release `0.0.942001-feat-k8s` enables operator-managed observation. Operators created
`staging-apps-b` (`shared-b` in `sv-db-shared-b`) with one PostgreSQL instance and a
10 GiB thick volume. Repeating reconciliation preserved the cluster UID/generation,
PVC UID and volume. Existing platform, Stockroom and preview cluster identities
and generations were unchanged. Stockroom remains external at revision 7.

The initial allocation rollout below supersedes the observation-only release.
The [shared-pool plan](database-pool-placement.md) records bulk migration, cleanup
and recovery requirements separately.

## Initial app placement

`placement.registry: true` enables durable SQL routing. `placement.enabled` controls
new reservations only; keep registry enabled when pausing admission so existing
apps keep their endpoints. `newAppsAfterId` fixes the rollout boundary; legacy apps
are registered/migrated separately. App creation, imports and forks share the same
provisioning entry point. Failed creation keeps its assignment and Retry continues
it; capacity shortage records Waiting and displays an actionable creation error.

`app_database_allocations` in the platform database stores the assignment, observed
cluster UID, phase, initial resource estimate and placement decision. A global SQL
transaction lock serializes admission; a session lock serializes provisioning for
one app. Assignments and the app credential commit before remote SQL. The app
database role carries an allocation UUID comment; unrelated names are never adopted.
A Ready database missing on retry requires recovery, not empty recreation.

Forks copy into their unpublished, reserved database using the existing logical
copy and privacy scrub. Retry can reset only this operation-owned incomplete copy.
Completed forks reuse their database. Normal routing rejects incomplete assignments;
preview/template/evidence databases inherit their app family's endpoint.

Starter budgets cover an app family, including previews. Staging initially reserves
25m CPU, 64 MiB memory and 512 MiB storage per family with an 80% admission ceiling.
These are conservative admission estimates, not PostgreSQL per-database limits or
a guarantee of worker failover headroom. Reservations are not automatically released;
retirement and bulk migration need their own verified cleanup flow. Do not manually
delete an allocation to force a retry or revert registry to false.

After registering runtimeTargets and their observed UIDs, the operator projects
credentials directly from each verified CNPG-owned Secret (no plaintext files):

```sh
node tools/database-pools.js project-runtime \
  --kubeconfig "$STAGING_KUBECONFIG" \
  --expected-cluster-uid 4cfec647-ed85-4c37-8453-fc99606a1619
```

This regenerates `social-database-runtime-targets`, copying public CA certificates
and administrative connection strings; it never copies CA private keys. Existing
SV mounts consume it; restart/roll out the platform after projection. Intent backup
and data recovery remain the deferred backup workstream, required before production.

The real PostgreSQL regression test requires a fresh disposable PostgreSQL instance
with a database named `sv_allocation_test`, listening on 127.0.0.1. Set
`TEST_DATABASE_ALLOCATION_URL` and run `node --test tests/database-allocation-postgres.test.js`.
It creates fixture databases/roles and must never target a shared database server.

## Staging verification of allocation

Release `0.0.947001-feat-k8s`, source `09fafe5aa031230ef6f5ddf52abb8d8b6b0a3568`.

Created private test app `pool-placement-probe-b3e4e9` (app17) through the normal
API: it was assigned to `shared-b` / staging-apps-b. Its normal fork
`pool-placement-fork-58b33f` (app18) was assigned to `stockroom-retained` / staging-apps.
Both reached Running. Tests wrote a public fixture row and a private fixture row
on the source; the fork preserved the public row and sequence, scrubbed private
data, and accepted a new write. Both app Pods read the expected destination data. A disposable preview clone
inherited its source pool, scrubbed private data and was removed after verification.

Repeating provisioning before and after a staging platform restart preserved both
allocation UUIDs, database/role OIDs, credentials and data. Stockroom remains Ready
at revision7. These two private fixture apps are retained for later migration tests.
Local disposable PostgreSQL tests additionally covered concurrent admission up to
capacity, four Waiting apps, retry after added capacity, interrupted unpublished
fork copying and refusal to recreate a missing Ready database.

The current migration UI still covers explicitly registered legacy bindings. New
SQL allocations are not yet eligible for those moves; integrating them into the
bulk migration and verified retirement workflow is next. Never roll back to a
platform image predating SQL allocation routing after enabling this cohort.
Admission can be paused with placement.enabled=false while routing remains active.

## Reviewed bulk moves (staging)

The database admin page can review a fixed distribution of selected apps across
operator-created, registered pools. It scores fresh pool capacity plus durable
reservations using the new-app allocator. Planning creates no PostgreSQL objects.
The administrator confirms the batch ID to accept one platform maintenance pause
and deletion of verified source copies. Apps move sequentially.

`app_database_batches` persists the mapping, policy checksum and child checkpoints.
The separate migration deployment survives the web platform pause. Restarted or
failed work enters `NeedsAttention`; use **Resume batch** or **Cancel remaining
moves** on the maintenance page. Completed children are skipped. Before cutover,
cancellation restores the current source; after cutover it finishes forward and
cleans the source. It never rolls a written destination back to stale data.

SQL allocations preserve their allocation UUID and advance their revision/target
using a compare-and-swap. Legacy Kubernetes bindings remain authoritative for
previously registered apps; their reservations are recorded separately. New-app
admission is blocked while a batch is active. Reapplying fleet configuration or
retrying a batch does not create fresh databases for completed assignments.

Source cleanup verifies the destination identity, writable owner connection,
healthy app and active credential route, then records deletion intent. It checks
source OIDs, ownership, fencing and absence of declarative managers before dropping
the source database and owner. A cleanup interruption retains the active target
and resumes deletion from the recorded intent; it cannot mark a partial cleanup
complete. Ordinary new single-app moves use the same cleanup step.

Current limits: explicit staging cohort (Stockroom and allocation test apps 17/18),
20 apps per plan, 256 MiB per copied database, sequential offline copies, and one
active batch. Retire active previews first. Existing historical moves keep their
original recorded retention policy. Completed Jobs remain checkpoint records;
Pod retention is separate. Backup/reconstruction testing remains deferred.

Cancellation does not automatically remove an unfinished destination copy. It
fences that copy for operator inspection; a later successful move to that pool
can archive and clean it through the same identity checks. Keep one executor
replica with `Recreate`; concurrent operator execution is unsupported. A platform
release or pool identity change invalidates a reviewed plan and requires a fresh
review before any new child is started.

### Staging validation, 2026-09-24

Release `0.0.951001-feat-k8s` pins source
`c06a1ba8dea45bebd76f7fd4aae3333bf48d7e7f`.

- Batch `sv-batch-20260924-16a1b6a7` was reviewed and started through the live UI;
  it kept app 17 in place and moved app 18 to the other shared pool.
- Batch `sv-batch-20260924-1a0341d9` moved both test apps back. An operator fault
  checkpoint stopped after the first child's cleanup. Restarting the executor
  produced `NeedsAttention`; the live maintenance UI resumed attempt 2 and skipped
  the completed child without changing its database or role OIDs.
- Batch `sv-batch-20260924-67d81067` allowed both pools. Capacity-aware planning kept
  app 18 on `staging-apps` and moved app 17 to `staging-apps-b`. Both finish at
  allocation revision 2, with their original allocation UUIDs and credentials.
- Public/private fixture rows, sequence values, owner writes and idempotent
  provisioning retries passed. Old source databases and roles are absent. The
  platform DB and all CNPG UIDs are unchanged; Stockroom remains revision 7 and
  passes a real app-pod write/read/sequence check.
- Final mapped SV checks: 2,477 passed, 31 skipped. The disposable PostgreSQL
  integration test, 2,275-statement SQL validation, frontend build, 57 infra tests,
  Helm checks and live UI confirmation/recovery checks passed. Cancellation and
  interruption between database/role deletion are covered by local tests, not a
  live destructive fault test. The full SV suite and backup/restore were not run.

All 16 staging Argo applications are Healthy/Synced. These results do not authorize
or certify a production migration.
