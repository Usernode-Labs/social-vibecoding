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

## Previous-image reuse

New Builds look up the newest compatible successful managed Build for the same
app and pass its immutable image digest in `spec.lastBuild.image`. kpack then
supplies the lifecycle analyzer with `-previous-image`, enabling launch-layer
reuse alongside the existing registry dependency cache. Output tags and source
revisions still identify the requested commit; cache selection does not change
the output recipe fingerprint or bypass a build.

Compatibility requires the same pinned builder digest, source repository,
service account and build environment (excluding the two Git identity stamps).
Foreign, failed, running, terminating or externally owned Builds are excluded,
as are mutable image references and different subpaths/bindings/descriptors.
The list is paginated and scoped by app. An empty or failed lookup falls back
to the ordinary build. Mutable builder tags skip this optimization.

The previous Build is not made an owner of the new Build, and the existing
shared deployment lock continues to coordinate with cleanup. Once its image
digest is selected, deleting the old Build/Pod does not remove the registry
image. Retention therefore needs no permanent chain of protected Build objects.
The per-app registry cache tag is unchanged; no new mutable image alias or
database reference is created. If history has expired, the next build can run
without previous-image reuse and seed fresh history.

Run `node --test tests/kubernetes-build-reuse.test.js tests/kubernetes-runtime.test.js tests/build-retention.test.js`.
After deployment, inspect a new Build's `spec.lastBuild.image`, analyzer argv
and lifecycle logs, then compare build/export durations for repeat builds of
the same app. API validation and mocked tests do not measure runtime savings.
No new infrastructure permissions or schema migration is required.

## Completed-image reuse across sessions

When a retained, successful managed Build for the same app has the exact Git
revision, immutable builder, source repository, service account and complete
build environment, the runtime returns its immutable output image directly.
A second session does not create a new Build just to produce the same image.
The returned build reference points to the original Build; its labels and
ownership stay unchanged. Concurrent callers can read the same completed
artifact without sharing cancellation of an in-progress job.

Different revisions still use previous-image layer reuse. Missing/pruned
history, incompatible settings or an unavailable inventory fall back to a
normal build. This does not search registry tags or trust mutable builders.
Registry image retention must continue to cover images from retained Builds.
