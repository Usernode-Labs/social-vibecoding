# Platform media storage

The implementation is in `src/services/media-store.js`. It shares the S3
transport in `app-files.js`, with separate configuration:

- `MEDIA_STORAGE_ENDPOINT`: scheme and host, such as `http://usernode-minio:9000`.
- `MEDIA_STORAGE_BUCKET`: the provisioned media bucket.
- `MEDIA_STORAGE_ACCESS_KEY` and `MEDIA_STORAGE_SECRET_KEY`: that bucket's keys.

There is no fallback to app-file settings or to writing bytes in Postgres.
The media bucket must already exist. Production provisioning also enables
versioning and seven-day expiry of noncurrent versions; the application
does not silently recreate an absent bucket without those protections.

## Upload and reference

Objects use the shared `media/sha256/<hex>` layout. Call
`put(tx, store, buffer, contentType)` inside the **same transaction** as the
row that will reference its returned key. `tx` is a checked-out database
client, not a pool. Do not commit between the upload and the reference.
Upload failure aborts the transaction. Retrying an existing object does not
rewrite it or create another billable version.

Storage I/O inside a transaction sends a serialized database heartbeat every
10 seconds, keeping the registry lock alive under the production idle guard.
Each storage wait has a two-minute deadline that aborts its MinIO HTTP requests.
A checked-out client disconnect rejects that operation instead of becoming an
unhandled process error; the caller rolls back and workflow work can retry.
The same guard covers cleanup's storage calls. Global database timeouts stay
unchanged, and a stalled upload never clears the row's original bytes.

Every key column must have an immediate foreign key to
`media_objects(object_key)`, with the ordinary restrictive delete behavior.
Index that referencing column so the cleanup foreign-key check is bounded.
This small registry stores no bytes; it is the lock that protects an upload
or a new reference from concurrent cleanup, across all migrated tables.

During backfill, `bytes(store, row)` reads the object if `object_key` is set,
otherwise the old `data` column. A storage failure for a keyed row propagates;
it never falls back. HTTP readers can use `stream(store, key, range)` to pass
an already-validated inclusive byte range to S3 without reading the whole
object. Routes retain their own access checks, ETags, and cache headers.

## Cleanup

The workflow clock's `media-gc` job runs one bounded listing page every five
minutes. Its result keeps the cursor for the next run. It examines only this
store's prefix and only objects more than a day old, including uploads whose
database transaction rolled back.

For each candidate it locks the registry key, rechecks the object's age,
and attempts to delete the registry row. A foreign-key refusal means some
table still references the object: the object is left alone. Otherwise it
deletes the object before committing the registry deletion. A provider
failure rolls back that deletion and fails the work, so the clock retries.
An upload arriving behind cleanup waits for the lock and recreates the
object before it commits any reference.
An ordinary reference lookup avoids locking an owner's row during cleanup;
retakes and backfill take source-row locks before registry-key locks. This
keeps a retake of the same bytes from deadlocking with either job.

## Local checks

`tests/lib/media-store.js` supplies the in-memory store for ordinary unit
tests. `tests/media-store-postgres.test.js` exercises real transaction races
in its own temporary database; set `TEST_DATABASE_URL` to a local disposable
Postgres server to require it.

`tests/media-store-minio.test.js` makes and removes a temporary versioned
bucket on the existing `usernode-minio` service (or a disposable instance):
set `TEST_MEDIA_STORAGE_ENDPOINT` to its local endpoint, plus
`TEST_MEDIA_STORAGE_ACCESS_KEY` and `TEST_MEDIA_STORAGE_SECRET_KEY` to local
test credentials. It checks ranged reads and that retries create one version.
These test variables are separate from production settings.

Run the suites covering a branch with:

```sh
npm run test:changed -- --base <exact-base-sha>
```

## Two-release rollout

Shots and check visuals ship together in two releases, with no feature flag:

1. [#6050](https://github.com/Usernode-Labs/social-vibecoding/pull/6050),
   `codex/media-storage-readers`: expand the schema for all six media tables,
   add the shared registry and orphan cleanup, and teach every media reader
   and publication path about object keys. Capture saves continue writing
   bytes; legacy shot retakes clear old keys when replacing bytes. Neither
   backfill runs and neither capture writer creates object keys in this
   release. Wait until all web and conductor processes, including draining
   workers, run this release or later.
2. [#6051](https://github.com/Usernode-Labs/social-vibecoding/pull/6051),
   `codex/media-storage-shots`: switch both capture writers to immutable
   objects and run both workflow backfills. A remaining process from the
   reader release can read keys or safely write a transitional byte row;
   the backfills catch those rows. The existing branch name covers both
   media families after consolidation.

The bucket and credentials from infra #56 must be live before release 2.
After #6050 merges, refresh #6051 against its actual merged SHA and require
passing checks. A squash merge can change ancestry. Do not merge both PRs
before release 1 has fully rolled out: an original process cannot read the
keyed rows that release 2 starts writing and backfilling.

After the first key is written, rollback must preserve #6050's key-aware
readers for both media families. The per-row byte read remains only while a
row has not been backfilled. No dual byte/object write path is introduced.
The former check-visual PRs #6052 and #6053 are superseded by these two PRs.

Dropping byte columns and the compatibility read branch waits for both
backfills to reach zero, older byte writers to be gone, and staging fixture
seeds to be converted. That is a separate roadmap step 4 PR. Bruno schedules
VACUUM FULL afterwards at a quiet time. These notes authorize no merge,
deployment or maintenance action.

## Shots

The shots integration includes both densities in `shot_run_files` and
`shot_artifacts`, plus `shots_eval_artifacts` and `shot_diagnostic_artifacts`.
New saves upload first and write keys with no bytes in their existing
transaction. Publication copies keys; eval publication does the same, with
an upload only for a source row not yet backfilled.

The `media-shots-backfill` workflow clock processes bounded, round-robin
batches. It verifies each legacy row's checksum, uploads it under a row
lock, and commits its keys and byte clearing together. It reports remaining
row counts for each table and `done` only at zero. A restart resumes from
those committed rows. The clock keeps checking for byte rows an older,
compatible release wrote during a rollout. Density and retention behavior
are unchanged; dense originals are retained as Bruno approved on 30 Oct.

## Check visuals

Check-visual readers and preview publication are in release 1; their keyed
writer and workflow backfill are in release 2, alongside the shots changes.

`check_run_media` holds a run's media until the preview machine publishes it
to `session_visuals`. Both tables gain an indexed restrictive registry FK,
SHA-256, size and the old full-response ETag. Publication copies the key and
metadata, preserving the artifact ID and its `/visuals/:id` URL. The GC's
ordinary reference lookup covers both tables, so it never takes a row lock
on a visual while its replacement waits for that key.

Unlike the shots endpoint, `/visuals/:id` used Express weak SHA-1 ETags, not
SHA-256. Full responses retain that exact validator and stream from storage;
matching conditional requests and HEAD need no object read. Range requests
pass their offsets to S3 and buffer **only the requested range** to retain
Express's old ETag of the sliced body (artifacts are capped at 8 MB). This
preserves status, headers, malformed-range behavior and conditional 304s
without downloading a whole video for a small range. SHA-256 remains the
shared object identity. The anonymous GitHub camo route stays on Homeroom.

Bruno approved retaining merged check visuals indefinitely on 30 Oct.
They remain referenced by their published rows and have no age-based media
expiry. Existing explicit row replacement and parent-deletion behavior is
unchanged; moving bytes does not introduce a new retention policy.

The writer release uploads every kept capture before committing its key,
hash, size and full-response validator. Its existing replacement transaction
locks the session and old rows before registry keys. Upload or insert failure
rolls back the replacement; any orphaned upload is left to `media-gc`.

`media-check-visuals-backfill` runs through the workflow clock in bounded,
round-robin batches over both tables. It reports `remaining.check_run_media`,
`remaining.session_visuals` and `done`. Each row's committed key is the
checkpoint across retries and process restarts. A missing store is never a
completed backfill. Existing ids, timestamps, capture provenance, merged
history and the old full-body ETag survive the migration.
