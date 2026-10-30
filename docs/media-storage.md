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

## Shots and the first rollout

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

This change requires two releases, with no feature flag:

1. Release `codex/media-storage-readers` first: expand the schema, teach all
   readers and publication about keys, and make the legacy retake writer
   clear old keys when it writes bytes. It creates no shot object keys and
   runs no shots backfill. Wait until every serving or draining process
   runs that release or later; original readers cannot read keyed rows.
2. Release `codex/media-storage-shots`: new saves use keys and the workflow
   backfill runs. A remaining process from the reader release can still
   read new keys or write a legacy byte row safely. The backfill catches it.

The media bucket and credentials (#56) must be live before release 2.
After the first key is written, rollback must preserve the reader release's
key support. Rolling back to code from before release 1 would serve empty
bytes for keyed rows. Both branches stay local until Bruno authorizes PRs;
this document is not an instruction to merge or deploy automatically.

Removing the byte columns and compatibility branch waits for both the shots
and check-visual backfills and is roadmap step 4. VACUUM FULL is a later
operator maintenance action. The fixture seeds that still use byte rows
also need conversion before that removal.
