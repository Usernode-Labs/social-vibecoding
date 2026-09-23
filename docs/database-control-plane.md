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
- Explicit URL construction via `dbManager.connectionUrl(name, password, binding)`.
  A supplied binding must match the database and supplies its own endpoint/owner;
  it never falls back to platform administration credentials.

Existing app creation, previews, exports, SQL administration and runtime URLs
still use their current placement. The optional URL argument is an integration
seam, not activation of multi-cluster routing. Durable app bindings and conversion
of every lifecycle path remain the next increment. No databases move in this release.

Production/dedicated profiles, logical database provisioning, placement budgets,
backup/restore, data-copy Jobs and migrations are not implemented yet. Both the
worker allowlist and the Crossplane schema reject production profiles. Do not
store production data in the disposable preview cluster. Crossplane can recreate
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
| Crossplane / CNPG | Preview Cluster / PostgreSQL pods, services and storage |

The existing Argo-owned platform database is absent from the target allowlist.
Web and worker identities cannot delete requests/composites through their new
roles. Namespace/CRD retention and absent delete UI do not protect against an
unrestricted Kubernetes administrator; deletion of production data needs an
explicit lifecycle design before production profiles are enabled.

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
