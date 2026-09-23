# Database control plane

The database worker is a separate Deployment using the platform image. The
existing admin console exposes **Platform → Database clusters**. The web
process creates durable `DatabaseClusterRequest` objects; the worker creates
an approved Crossplane `AppDatabaseCluster`. Crossplane manages the CNPG
Cluster. The worker uses Kubernetes optimistic concurrency and deterministic
names, so duplicate requests and process restarts converge on one resource.

## First increment

Implemented:

- Opt-in admin inventory and create requests, with existing admin read/write
  permissions. Only configured target IDs are accepted, not Kubernetes manifests.
- Immutable request specs, destination reservations, observed composite identity,
  progress and conflict/recovery states. Status contains no database credentials.
- A separate worker entrypoint, ServiceAccount, resource limits, probes and
  API-only network access. It receives neither platform secrets nor `DB_ADMIN_URL`.
- An approved single-instance **preview** profile, supplied by infra.
- Explicit URL construction via `await dbManager.connectionUrl(name, password, binding)`.
  A supplied binding must match the database and supplies its own endpoint/owner;
  it never falls back to platform administration credentials.

The opt-in central binding increment records only selected applications. Infra's
`bindingTargets` allowlist names the app, primary database and observed CNPG
cluster UID. An operator registers an immutable `AppDatabaseBinding` once, then
enables `databaseControlPlane.bindingsEnabled` in the SV release. Neither Argo
nor the worker recreates missing bindings. Absence, deletion, mismatched identity,
API failure, changed cluster UID or external placement blocks selected operations.
Unselected apps make no binding API requests and retain legacy central placement.

A record identifies the production environment, database/owner, central endpoint,
cluster reference and `platform-app` credential reference (app ID); it contains no
password. The selected runtime URL uses its endpoint and owner after checking
that they still match the central adapter. Existing TLS options and per-app
passwords are preserved. No credential rotation or database move is implied.

The public database-manager boundary validates creation, role repair, clones
(both sides), templates/evidence, cleanup, accounting and runtime URLs. Queued
template refresh and exports are also guarded. The migrator has only named
binding/cluster read permissions and validates startup role repair. Primary
retirement/replacement and destructive scrubbing of bound production databases
are blocked; selected app deletion stops before runtime teardown. Disposable
clone cleanup remains supported. A binding outage pauses the central accounting
pass rather than measuring an assumed location.

The admin cluster inventory additionally returns validated `bindings` when
binding enforcement is enabled. This first record covers the selected app's
existing central lifecycle; previews are still on central and do not yet have
independent bindings. There is no destination editing API or external adapter.
No databases move in this release.

The retained staging profile provisions a separate single-instance cluster.
It uses a separate `RetainedAppDatabaseCluster` composite with a fixed
`sv-retained-cluster` composition. The worker observes the CNPG child UID and
its ownership before reporting Ready. Once observed, that identity cannot be
cleared or replaced in request status. Missing/replaced/deleting children require
recovery; the worker never silently adopts a replacement.

Kubernetes admission uses the durable request as a one-time bootstrap gate:
creation requires a reservation and no previously observed CNPG UID. It rejects
CNPG creation after observation, including when Crossplane tries to reconcile a
missing child. Separate admission rules reject deletion of the request,
composite, CNPG cluster, target namespace and PVCs. These rules are installed
before submitting a request; retirement/recovery must be an explicit operator
procedure. An unrestricted administrator can change these policies, so they
are accidental-deletion protection, not protection against cluster-admin access.

Retained means protected resource lifecycle, not HA or backups. Backups are
explicitly deferred by the operator. The first retained target has no app
binding or automatic placement; use only staging test data. Logical database
provisioning, placement budgets, backup/restore, data-copy Jobs and migrations
are not implemented yet. Do not store production data in the disposable preview cluster. Crossplane can recreate
its missing CNPG child as empty: that behavior is acceptable only for this profile.
If the composite itself disappears after observation, the request reports
`RecoveryRequired`; it does not silently recreate it.

## Ownership

| Owner | Resources |
| --- | --- |
| infra / Argo | Crossplane/CNPG installations, request CRD, XRD/composition, configured namespaces, budgets, networking, policy and RBAC |
| SV Helm release | Worker Deployment and ServiceAccount; platform configuration/mount |
| SV API | Request creation; reads for the admin screen |
| SV worker | Request status and creation of allowlisted composites |
| Crossplane / CNPG | Approved preview or retained Cluster / PostgreSQL pods, services and storage |

The existing Argo-owned platform database is absent from the target allowlist.
Web and worker identities cannot delete requests/composites through their new
roles. Namespace/CRD retention and absent delete UI do not protect against an
unrestricted Kubernetes administrator; deletion of production data needs an
explicit lifecycle design before any real production rollout. Retained staging deletion rules do not implement retirement.

## Installation order

1. From infra, install the pinned Crossplane release and the
   `social-database-control-plane` chart. Follow that chart's runbook. The policy
   ConfigMap and RBAC must exist before enabling the SV feature.
2. Publish an SV image/chart containing this change. Set
   `databaseControlPlane.enabled: true` in the platform Helm values. The worker
   uses `platform.image`, including its immutable digest and source revision.
3. Verify worker readiness, then open Database clusters and create the configured
   preview target. A Ready result means Crossplane reports the cluster ready;
   it does not mean any app has been moved there.

Chart defaults keep the feature off. Starting the worker manually uses
`npm run start:database-worker`, requires in-cluster Kubernetes credentials,
`SV_DATABASE_CONTROL_PLANE_ENABLED=true` and `SV_DATABASE_POLICY_FILE`.

The policy file is supplied by an infra-owned ConfigMap. The API reads it per
request; the worker reads it each poll, including projected ConfigMap updates.
Changing the destination of an existing request produces `DestinationChanged`,
not an implicit migration. Add a new target for a new destination.

## API

- `GET /api/admin/database-clusters`: enabled state, configured targets and
  bounded request summaries. Available to view-only admins too.
- `POST /api/admin/database-clusters`: JSON `{ "target": "previews" }`, full
  admins only. Returns HTTP 202 and the durable request ID. Repeating the same
  target returns the existing request; it does not create another cluster or
  overwrite its original requester.

`Pending` → `Provisioning` → `Ready` is the ordinary path. `Blocked` identifies
policy/ownership conflicts. `RecoveryRequired` identifies deletion/loss of a
previously observed composite. API failures are retried by the worker and logged
without response bodies. A failed status write cannot erase a reservation because
updates carry `resourceVersion`.

The worker polls every five seconds with 15-second API deadlines and processes
requests sequentially. Start one replica. There are no destructive operations
in this increment, so overlapping workers converge through name uniqueness and
optimistic concurrency. Migration Jobs will additionally need per-app operation
locking/fencing; this create-only loop is not that migration engine.

Disabling the Helm flag stops this management path without deleting requests,
composites or PostgreSQL workloads. It does not alter existing app routing.

## Validation

Run the focused tests with:

```sh
node --test tests/database-control-plane.test.js tests/helm-database-worker.test.js
node --test tests/db-manager-*.test.js tests/helm-preview-placement.test.js tests/admin-ui-registry.test.js
npm run ensure:shell
```

The infra chart has schema/permission tests and a separate local Kubernetes
integration runbook. Validate actual Crossplane readiness as well as rendered
YAML; rendering alone does not exercise operator behavior.

## Binding activation order

1. Install the binding CRD and narrowly scoped reader RBAC through infra/Argo.
2. Verify the live app ID/slug, database ownership and central cluster UID against
   the allowlisted registration manifest. Use `kubectl create` once; do not put
   the instance under automatic recreation or overwrite an existing record.
3. Publish the candidate release, then enable `databaseControlPlane.bindingsEnabled`
   only in staging. The migration Job needs its projected policy, API token and
   Cilium API egress before its hook runs.
4. Verify authenticated inventory, real app-role connection, disposable cloning
   and cleanup, and preservation of the original database and app Deployment.

Missing metadata requires investigation and explicit restoration from the saved
record. Turning the flag off is safe only while all selected databases remain
central; it is not a rollback strategy once external placements are implemented.
Do not mistake binding reconstruction for data recovery.

Targets may have an optional `displayName` (up to 80 characters) for the admin
screen. It is presentation only: requests still use the immutable target ID,
and changing the label does not change placement, Kubernetes names or identity.
