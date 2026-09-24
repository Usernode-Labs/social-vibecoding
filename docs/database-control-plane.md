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

## Full-data copy rehearsal

`scripts/copy-app-database.js` is an operator-created Job entrypoint. It is not
wired to app placement or the migration worker yet. Unlike preview cloning, it
preserves private rows and schema comments. The infra staging adapter creates a
new `app_copy_*` scratch database using native CNPG Database/DatabaseRole objects
and app-owner credentials; the Job has no Kubernetes token or PostgreSQL admin
credential. Source and destination connections require their CNPG CA and hostname
verification. Credentials enter through a temporary Secret, not arguments/logs.

The copy uses one exported read-only snapshot, streams pg_dump into a transactional
pg_restore, then compares schema, per-table row hashes and sequence state. A failed
or interrupted restore cannot be reported as verified; a populated destination
cannot be retried blindly. Role ownership is mapped to the destination app owner;
existing ACLs and tablespace assignments are deliberately not imported.

This increment supports databases up to 256 MiB and 100,000 rows per table on the
same PostgreSQL major version, encoding and collation. Extensions beyond plpgsql,
RLS, large objects, foreign tables and logical replication are rejected. Database
settings/global objects and external writers need separate handling before real
cutover. Sequence changes during copying fail verification. This is a snapshot
rehearsal while the app remains live, not a claim that later writes were migrated.

Run `npm run test:changed -- --base <pre-change-sha>` for focused tests. The infra
runbook covers the synthetic private-data fixture, live Stockroom rehearsal,
terminal-result collection and scratch cleanup. Backups, source fencing, durable
migration state transitions and placement cutover remain separate work.

## Controlled external placement (staging)

The binding's immutable `spec` records its original central identity. Its status
holds `phase`, `operation` and `current: {targetId, revision}`. An operator starts
with `Moving` at central revision zero; all selected database operations fail
closed in that phase. Switching to another target requires `Moving` → `Ready`,
the same operation ID and the next revision. Status cannot be cleared. Runtime
resolves the target against infra's explicit `runtimeTargets` and verifies the
live CNPG UID. This status is routing intent, not database contents or a backup.

Every app database family follows current placement, including preview/evidence
clones and reusable templates. Operation-local connections keep simultaneous
app operations separate. Logical copies can cross servers; PostgreSQL physical
template copies require the same server. Catalog accounting excludes old retained
copies and queries each active target. Primary retirement remains blocked.

The optional `databaseControlPlane.runtimeSecret` projects `targets.json` and CA
certificates into the platform and startup migrator. Each registry entry has
`id`, `clusterUid`, and an administrative PostgreSQL URL using `sslmode=verify-full`
and `/etc/sv-database-targets/<targetId>.crt`. Endpoints must match configured
service names. Existing app URLs retain their original connection options while
changing endpoint; this does not add CA projection to generated apps. The legacy
DB manager requires administrative SQL on the destination, so staging explicitly
enables CNPG superuser access for that target. The separate provisioning worker
still has no credentials/Secret reads. Do not enable this globally by default.

The infra operator adapter initially supports only Stockroom's first central to
`staging-apps` move. It briefly pauses the staging platform to drain pre-existing
administrative operations and pauses Stockroom, discards disposable templates,
rotates the source app password and terminates old sessions. The copy Job alone
has the temporary password. After verification it disables source connections,
commits current placement, updates Stockroom's environment Secret and resumes both
Deployments. The source remains retained and fenced. Native Job metadata, Secrets
and binding status permit a fresh operator process to resume. Before cutover an
explicit abort may restore the source; after cutover recovery must move forward.
Do not disable binding routing or restore the old URL after destination writes.

The admin interface still manages clusters; migration initiation is operator-only.
General app selection, move-back/demotion and worker-driven orchestration remain
future increments. Backups remain deferred by the staging operator.

## Admin migrations (staging opt-in)

`databaseControlPlane.migrationsEnabled` enables a separate Deployment using the
platform image, `src/workers/database-migrations.js`. It serves authenticated
`/api/admin/database-migrations` and `/database-maintenance` on the platform host.
The ordinary platform can be paused by the migration without taking these routes
down. The maintenance page reuses the React migration panel and existing session
cookie; it also works after reloading during maintenance. Login itself remains
on the platform, so sign in before starting maintenance.

The panel lists selected app bindings/current revisions and configured retained
destinations. Review runs the operator's read-only preflight; Start requires typing
the app slug and records an immutable `AppDatabaseMigration` intent. Only full
admins may plan/start/recover, with same-origin JSON required for mutations.
View-only admins can inspect status. Requests contain no credentials.

One Recreate worker processes requests sequentially using the infra-packaged,
staging-guarded Python operator. Running attempts become NeedsAttention after
worker loss; Resume/Abort are explicit and retain the operator's revision/UID/
copy-Job guards. Abort is rejected after cutover or while copy Pods are running.
The request stores the requester, attempt and public result. Runtime errors never
return child-process output or credential-bearing diagnostics.

The migration identity is distinct from the web and provisioning identities. It
needs scoped SQL exec on the selected CNPG Pods, copy Jobs/Secrets in their target
namespace, selected binding status updates and selected workload scaling/Secret
updates. It cannot delete CNPG Clusters/PVCs/namespaces. Only DATABASE_URL is
projected for session authentication; GitHub, model and signing keys are not mounted.
Infra supplies CRD/RBAC/scripts separately. Existing deployments default disabled.
