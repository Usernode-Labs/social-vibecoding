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

The next increment is durable capacity reservation and initial app bindings,
including imports/forks/retries. The [shared-pool plan](database-pool-placement.md)
records bulk migration, cleanup and recovery requirements separately.

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
