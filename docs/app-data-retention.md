# App data retention (#5121)

What happens to an app's data when the app is deleted, how long it survives
in backups, and what happens to apps nobody uses. The platform does the parts
it can reach from its own code; the rest is operator work on the cluster and
the backup stores, written out below as steps.

## Deleting an app

`DELETE /api/apps/:slug` (and retiring a test account, which removes that
account's apps) runs `services/app-teardown.js`. After the app's previews are
retired and the row is marked (`apps.teardown_started_at`), it removes:

| What | Where | How |
| --- | --- | --- |
| Runtime | Kubernetes Deployment, Service, Ingress, `<name>-env` Secret (the app's secrets as env), kpack Builds; or the Docker container | `application-runtime.remove` |
| Custom domain edge | its Ingress and certificate Secret | `app-domains.teardownEdge` |
| Database | `app_<slug>` and its owner role `app_<slug>_owner` | `db-manager.dropDatabase` |
| Staging template | `app_<slug>_stgtmpl`, `_stgtmpl_next` and role `app_<slug>_stgtmpl_owner`, on every server that may hold one | `db-manager.dropStagingTemplates` (new in #5121) |
| Stored files | object store keys under `app/<id>/` | `store.removeAppPrefix` |
| Platform rows | the `apps` row and everything that cascades from it (sessions, chat, secrets, files metadata, activity) | `DELETE FROM apps` |

Preview databases (`app_<slug>_staging_s<id>_<sha>`) go with the previews'
retirement, and any left are dropped by the orphan staging-database sweep
once their session rows are gone.

Before #5121 the staging template was never dropped: a redacted copy of a
deleted app's database stayed on the server indefinitely. And every step was
silent on failure: a database that could not be dropped (a connection held
open, a role still owning objects) was left with nothing recording it.

### The purge receipt

The teardown now writes one row in `deleted_app_purges` before it removes
anything, and stamps each step as it finishes:

- `runtime_removed_at`, `database_dropped_at`, `template_dropped_at`,
  `files_removed_at`: set once that step is done;
- `errors`: the last failure of each step that has not succeeded, by step;
- `attempts`, `last_attempt_at`: how often it has been tried.

The receipt has no foreign key and outlives the `apps` row. It holds an app
id, its slug and its storage names, nothing personal.

The `app-data-purges` clock (`src/workflow/clock/services.ts`, every six
hours) retries every receipt with a data step undone and its last attempt
more than an hour old, up to 10 a pass. A step already done is not repeated.
After 20 attempts a receipt is left for an operator (`needs_operator` in the
report).

While a receipt's database or template step is undone, its database name is
reserved: the `apps` trigger `reserve_purged_app_name` refuses any insert or
slug change that would give an app the same name (`app_` plus the slug with
every character outside `[a-z0-9_]` made `_`), with SQLSTATE `UP121`, which
create and remix answer as a 409: "This name is still being cleaned up; try
again later or pick another name". The trigger and each drop take the same
transaction-scoped advisory lock on the name (`APP_NAME_PURGE_LOCK`, 991019),
and the drop re-checks under it, immediately before dropping, that no other
app holds the name. A receipt whose name a live app does hold (one made
before the receipt existed) never has its database or template dropped: that
would drop the live app's. It is marked for an operator instead.

To free a reserved name by hand once the database and template are confirmed
gone: `UPDATE deleted_app_purges SET database_dropped_at = NOW(),
template_dropped_at = NOW() WHERE db_name = '<db_name>';`.

Not removed by the teardown, and not personal data the platform holds about
the app's users:

- the app's GitHub repository (its code and history);
- built images in the container registry (registry retention applies);
- `events` analytics rows (their `app_id` becomes NULL);
- platform and infrastructure logs (their own retention).

## Backups

Backups are physical, so one app's data cannot be cut out of them. A deleted
app's data leaves backups when the last backup taken before the deletion
expires. With a 30-day retention that is at most about 31 days after the
delete (30 days, plus the gap to the next base backup).

The backup configuration is not in this repository. Production runs on
CloudNativePG with the barman-cloud plugin, configured in the
`Usernode-Labs/infra` repository; the occasional `pg_dump` runs to the
storage box are manual. The steps below are for an operator with access to
those.

### 1. CloudNativePG base backups and WAL (barman-cloud)

1. In the infra repository, on the plugin's `ObjectStore` resource that the
   production cluster archives to, set:

   ```yaml
   spec:
     retentionPolicy: "30d"
   ```

   This is a recovery window: barman keeps the base backups and WAL needed
   to recover to any point in the last 30 days and deletes the rest.
2. Sync it, then confirm it took:

   ```sh
   kubectl -n social-refresh get objectstores.barmancloud.cnpg.io -o yaml | grep retentionPolicy
   kubectl -n social-refresh get backups --sort-by=.metadata.creationTimestamp
   ```

   The oldest completed backup should be no older than about 31 days once a
   day of new backups has run. The plugin's retention cleanup logs to the
   `plugin-barman-cloud` container of the instance pods.
3. Do not add a bucket lifecycle rule that deletes backup objects by age.
   Deleting WAL or a base backup that barman still counts on breaks recovery
   inside the window; barman's own retention is the one that deletes.

### 2. Manual pg_dump runs on the storage box

The dumps are one file per database (`<run>/<db_name>.sql.gz`), so a deleted
app can be removed from them directly:

1. List the deleted apps' databases (from the admin report below, or SQL):

   ```sql
   SELECT db_name FROM deleted_app_purges ORDER BY deleted_at;
   ```

2. On the storage box, remove each one's dumps from every run, including the
   staging copies (`<db_name>_staging_*`, `<db_name>_stgtmpl*`):

   ```sh
   for db in $(cat deleted-dbs.txt); do
     find ~/backups/usernode-db -name "${db}.sql.gz" -o -name "${db}_staging_*.sql.gz" -o -name "${db}_stgtmpl*.sql.gz" | xargs -r rm -v
   done
   ```

   Regenerate `SHA256SUMS` and `LISTING.txt` in each run touched.
3. Expire whole runs after 30 days:

   ```sh
   find ~/backups/usernode-db -mindepth 1 -maxdepth 1 -type d -mtime +30 -print -exec rm -rf {} +
   ```

   The platform's own database dump (`app_usernode_2d5619` on the current
   cluster) still holds the deleted app's platform rows (chat, proposals);
   those leave with the run.

### 3. Object store (app files)

`removeAppPrefix` deletes the current objects. If the bucket has versioning
on, deleted objects stay as noncurrent versions:

```sh
mc version info <alias>/<bucket>
# if Enabled or Suspended:
mc ilm rule add --noncurrent-expire-days 30 --expire-delete-marker <alias>/<bucket>
```

A host-level backup of the MinIO volume (self-hosted Docker,
SELF-HOSTING.md) follows the same 30-day expiry as the database backups.

### 4. Restoring a backup

A restore brings deleted apps back: their `apps` rows, databases and files
as they were. Before serving a restored database:

1. Export the receipts from the database being replaced, before it is
   replaced (the restored copy has an older list):

   ```sh
   psql "$DATABASE_URL" -c "\copy (SELECT app_id, slug, db_name, storage_prefix, deleted_at FROM deleted_app_purges) TO 'purges.csv' CSV HEADER"
   ```

2. After the restore, for each receipt: delete the resurrected app through
   the platform as an admin (`DELETE /api/apps/<slug>` with its name), which
   writes a new receipt and removes the runtime, database, template and
   files. Where the row did not come back but the database did, drop it by
   hand:

   ```sql
   DROP DATABASE IF EXISTS <db_name> WITH (FORCE);
   DROP ROLE IF EXISTS <db_name>_owner;
   DROP DATABASE IF EXISTS <db_name>_stgtmpl WITH (FORCE);
   DROP ROLE IF EXISTS <db_name>_stgtmpl_owner;
   ```

3. Re-insert the exported receipts the restored copy lacks, so they keep
   counting (`\copy deleted_app_purges (app_id, slug, db_name, storage_prefix, deleted_at) FROM 'purges.csv' CSV HEADER`,
   skipping ids already present).

The same rule as account deletion (docs/account-deletion-operations.md):
never put a restored database into service without this reconciliation.

## Inactive apps

The policy, and what the platform implements of it:

| Idle for | Stage | Who acts |
| --- | --- | --- |
| under 180 days | `active` | nobody |
| 180 days | `notify_owners` | an operator tells the app's creator and admins |
| 210 days (30 more) | `stop_eligible` | an operator may stop the runtime |

"Idle" means none of these happened: anyone used the app (`app_activity`),
it was deployed or a change merged (`apps.last_deploy_at`,
`chat_sessions.merged_at`), or anyone worked on a proposal for it
(`chat_sessions.last_activity_at`). An app younger than 180 days is never
idle. The platform's own app is never listed.

Data is kept until somebody deletes the app. Stopping an app frees its
runtime only; its database and files stay, and it can be started again.
Nothing is deleted for inactivity.

### What is implemented

`GET /api/admin/app-retention` (any admin, read-only; `?days=` from 30 to
3650 moves the window, 180 by default) answers:

- `policy`: the window, the grace and the purge retry limit;
- `inactiveApps`: up to 500 apps idle past the window, oldest first, each
  with its last open, deploy, merge and proposal activity, `idle_days` and
  `stage`;
- `deletedApps`: up to 500 purge receipts, newest first, each with a
  `state` of `purged`, `pending` or `needs_operator`.

No screen draws it yet.

### Not implemented, and why

- **Notifying owners.** It needs a notification kind, its copy and a decision
  on who counts as an owner of a shared project; the report gives the list.
- **Stopping a runtime.** There is no "stopped" app state today. App
  delivery heals a running app whose runtime is missing (the app-health clock
  reports it, `services/app-heal.js`), so an app stopped by hand comes back
  within minutes. A stop needs a state the heal and the deploy path both
  respect, and a way to start it again; that is a product change of its own.
