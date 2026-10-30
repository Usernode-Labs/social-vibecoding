# Database identities

`databaseRoles.enabled` opts the Kubernetes release into PostgreSQL 16+
identities. It requires external PostgreSQL, the conductor and the migration
Job. Defaults remain compatible with local development and existing charts.

| Login | Purpose | Database authority |
| --- | --- | --- |
| `homeroom_web` | HTTP and WebSockets | Platform DML; no schema, database or role creation |
| `homeroom_conductor` | Workflow and maintenance scheduling | Platform DML; no schema, database or role creation |
| `homeroom_migrator` | Schema migrations and grants | Owns the platform database and its `public` and `credentials` objects; no cluster role/database creation |
| `homeroom_provisioner` | Tenant database lifecycle and copies | Non-superuser with CREATEDB, CREATEROLE and BYPASSRLS; delegated tenant ownership, no membership in the platform owner/runtime identities |

The conductor holds the provisioner URL separately from its normal pool.
The migration Job also holds the primary provisioner URL for tenant-role
repair and read-only capability setup. Web receives neither URL. The preview
server has a separate provisioner password and a maintenance-catalog reader
password; its reader cannot connect to tenant copies. Each primary login
keeps access to reserved connections within the existing platform budget.

BYPASSRLS is intentional for the trusted provisioner: a complete logical
source copy must include rows protected by forced row-level security. Restore
and redaction still authenticate as the copy's own unprivileged owner. This
split does not make the provisioner a tenant-isolated service or introduce
table-level separation between web and conductor.

## Release order

1. Sync only bootstrap/migrator input Secrets at wave -3. Keep the existing
   serving Secrets unchanged until the bootstrap succeeds, so an old Pod
   can still restart during a refused or failed bootstrap.
2. Run the bounded database bootstrap Sync hook at wave -2. It first checks
   tenant ownership on both servers before changing any login or schema.
   Unresolved legacy/restore ownership refuses cutover; complete the existing
   tenant ownership migration through the approved operator procedure first.
   Only this Job
   imports the bootstrap Secret containing the legacy cluster-admin URLs.
   It creates/updates logins, transfers platform object ownership, applies
   grants and default grants, and prepares empty extension templates.
3. Publish the shared/conductor runtime Secrets at wave -1, after successful
   bootstrap. Argo orders Secrets before the migration Job in that wave.
   Run ordinary migrations as the migrator. Read-only debug and
   SQL-console role DDL uses the provisioner; object grants use the migrator.
4. Start serving Deployments at wave 0. Startup checks both authenticated and
   active identities, attributes, schema authority and inherited authority.

The bootstrap is repeatable. Template preparation uses a unique attempt
name and publishes the complete, locked template by atomic rename. A killed
Job can leave an empty attempt, but the next retry can prepare a new one.
Ordinary failures remove only their own attempt. Obsolete templates and
interrupted empty attempts are retained for operator cleanup after draining;
unknown databases are never adopted or deleted. The bootstrap never
reassigns ownership cluster-wide.
Extension objects retain their operator ownership and ACLs. Only platform
objects in the two reviewed schemas change ownership; update
`PLATFORM_SCHEMAS` and the real-schema test when adding a platform schema.

Two bounded administrator-owned helpers remain. The maintenance database's
role-adoption function pins administrative catalog names, serializes callers,
is callable only by the provisioner login and can delegate only unprivileged tenant/read-only roles. It handles roles created
by an older conductor during a rollout. The platform and preview maintenance
databases' connection count functions expose aggregate counts, preserving connection-budget
diagnostics without granting access to other sessions' SQL text. Neither
function permits arbitrary SQL or accepts a caller-selected target.

Untrusted extensions are installed only by bootstrap in empty, locked
templates. Runtime copies select the template matching the source's required
extensions and the target server's default versions. Missing preparation
fails the copy; there is no superuser fallback. A source that gains a new
untrusted extension requires another bootstrap before it can be copied.
The managed statistics-extension combination is prepared in advance.

## Configuration and recovery

Set the six independent password values documented in `values.yaml` using
encrypted GitOps values. Keep existing administrator passwords available only
for the bootstrap Secret. Do not remove those encrypted values yet. With
`secrets.create=false`, supply distinct existing conductor, migrator and
bootstrap Secrets; the shared existing Secret must contain the web URL and
preview reader. External Secret publishers must preserve the same ordering:
leave active serving URLs unchanged until bootstrap succeeds, then publish
the new runtime URLs before ordinary migration/serving rollout. Never put
a bootstrap credential in any serving Secret.

The serving env explicitly masks retained legacy administrator fields. Helm
also replaces retained conductor URLs when the feature is disabled. Reverting
to a legacy chart/configuration restores its former credentials; treat that
as an explicit rollback, and do not delete the new roles or change passwords
while a release is draining. A failed bootstrap or migration stops the new
release before serving Pods start. Correct the failing stage and sync again;
do not bypass the hook or change the runtime login to an administrator.

Infra values, encrypted passwords and the narrow bootstrap network peers must
land before the companion app/chart release. Older charts ignore the new
values. An operator merges and verifies these changes; agents do not merge
or mutate production.

## Verification

`tests/database-role-split-postgres.test.js` uses two explicit disposable
PostgreSQL servers. It exercises real grants and default grants, startup
refusals, both-server ownership preflight, interrupted template publication,
concurrent adoption and temporary catalog-name isolation, read-only
capability setup, primary/preview connection counts, tenant copies with
forced RLS, a full platform preview, and a web export with a stale admin URL.
The existing PostgreSQL 17/18 CI job supplies those servers and matching client
tools. `tests/helm-database-roles.test.js` checks rendered effective identities,
Secret isolation, hook order, external Secrets and disabled-feature recovery.

Post-rollout checks are separate from local tests: confirm hook success and
the exact release; verify the effective web/conductor/migrator identities and
credential isolation, then verify a reader operation and normal workflow
operation. Production verification must follow the operator's access policy;
do not print passwords, database URLs or Secret contents.
