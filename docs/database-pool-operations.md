# Operator-managed database pools

The staging implementation provides operator-local creation and a read-only SV
pool inventory. It does not yet allocate new apps, reserve capacity, or run bulk
migration batches. Keep automatic placement disabled until those contracts are
implemented and exercised together.

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
app reservations are not included yet. The UI explicitly states that automatic
placement is disabled; new-app creation retains its existing central default.

## Verified staging rollout

Release `0.0.942001-feat-k8s` enables operator-managed observation. Operators created
`staging-apps-b` (`shared-b` in `sv-db-shared-b`) with one PostgreSQL instance and a
10 GiB thick volume. Repeating reconciliation preserved the cluster UID/generation,
PVC UID and volume. Existing platform, Stockroom and preview cluster identities
and generations were unchanged. Stockroom remains external at revision 7.

The next increment is durable capacity reservation and initial app bindings,
including imports/forks/retries. The [shared-pool plan](database-pool-placement.md)
records bulk migration, cleanup and recovery requirements separately.
