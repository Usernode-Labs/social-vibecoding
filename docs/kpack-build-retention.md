# Successful kpack Build retention

The platform creates standalone kpack Builds. Their completed Pods previously
remained until app deletion; the Job TTL used by checks does not apply to them.

The leader now previews eligible Builds at startup without deleting anything.
An hourly sweep then deletes at most 20 unreferenced successful Builds per pass,
oldest completion first. `KPACK_SUCCESS_RETENTION_HOURS` defaults to `48` and
must be a finite number of at least `1`. Age is measured from the successful
condition's `lastTransitionTime`, never from creation time.

The sweep preserves:

- All `apps.build_ref` and `chat_sessions.staging_build_ref` references,
  regardless of app or session status.
- Builds whose `status.latestImage` matches `apps.image_ref` or
  `chat_sessions.staging_image_ref`, including migrated apps without `build_ref`.
- Pending, running, failed, recently completed, and already deleting Builds.
- Objects outside the configured build namespace, objects without platform
  ownership labels, and Builds controlled by another object (such as kpack Images).
- Objects without a known completion time, image, UID, or resource version.

Deletion targets the parent Build with background cascading deletion and UID
and resource-version preconditions. Kubernetes garbage collection removes its
owned Pod; registry images and registry build caches are untouched. Pod logs
disappear with the Pod, so collect any needed build diagnostics before expiry.
Existing failed-Build cleanup remains separate and unchanged.

## Coordination and failure handling

Preview builds, production rebuilds and app creation hold a PostgreSQL shared
advisory lock through deployment and reference persistence. Overlapping builds
share one dedicated connection per platform process, avoiding exhaustion of
the application connection pool. This also protects builds served by a follower
during a platform rollout. As with leader election, losing that lock's connection
during deployment restarts the process so it cannot continue unprotected.

Cleanup tries the exclusive lock per candidate and skips the remainder of a
pass if a deployment is active. It rechecks the Build and database references
under that lock. Inventory/database failures stop cleanup; changed or missing
Builds are skipped. API deletion failures stop the remaining pass and are logged.
Busy periods can delay cleanup beyond the configured retention time.

## Rollout and inspection

Run `node scripts/preview-build-retention.js` in the platform environment to
print the next batch of candidates without making changes. The startup log
`kpack retention preview` provides the same read-only preview. Actual sweeps
begin one hour after leader startup and log every deletion.

On the first rollout, drain older platform versions before the first scheduled
deletion: those versions do not participate in the deployment lock. A preview
is a snapshot; the actual sweep rechecks eligibility before deleting.

Only `social-vibecoding` changes are needed. The existing `infra` build-manager
Role already grants `list`, `get`, and `delete` on `kpack.io/builds`. No schema
migration, Pod-delete grant, new CronJob, or infrastructure configuration is needed
for the defaults. Setting a non-default retention period through GitOps would
be a separate environment-configuration change.
