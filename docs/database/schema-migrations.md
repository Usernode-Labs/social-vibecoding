# Schema migrations

`src/db/migrations/` is the SQL source of truth: one immutable baseline plus
numbered, append-only deltas. `src/db/reference-data.js` owns the insert-only
reference/default rows shared by fresh initialization and every boot.
There is no hand-maintained second copy of the schema.

`src/db/schema.sql` is an ignored generated input for tools that need a file.
`npm run build:schema` validates the manifest and concatenates migrations in
order, then appends the shared reference inserts. The renderer preserves
query boundaries even when a file omits its last semicolon or ends with a
line comment. This is ordered initialization SQL, including historical data
transformations, rather than a pg_dump of the final catalog.

Npm test/start/dev, direct test preloads and both application image builds
materialize the file. Generation is atomic and does not write an already
current artifact, so an immutable image only reads it. Runtime consumers
and standalone SQL tools use the same validated renderer directly; stale or
hand-edited generated SQL cannot become the runtime source of truth. The
changed-test mapper treats migrations, seeds and renderer changes as changes
to schema.sql, preserving the existing structural guards.

Deployments apply only unapplied migrations. Each SQL file and its receipt
commit in one transaction. A failed file rolls back; the next attempt
resumes at that file, preserving earlier successful files. One database
advisory lock serializes migration jobs and local/preview startup on the
same connection as the DDL. An unchanged deployment executes no table DDL.

Both new and legacy untracked databases apply the baseline once and then
pending deltas. Adoption still needs the old baseline's locks once; later
unchanged releases do not. Required reference rows are inserted after the
migration chain, and again at boot when a sanitized copy needs them.
Historical backfills and their completion markers stay in the baseline.

To change the schema:

1. Add the next consecutive SQL file, for example
   `src/db/migrations/0002-example-change.sql`, containing only the change
   from the preceding schema. Include transformations needed on existing
   databases; keep independent changes in separate files.
2. Run `node scripts/record-schema-migration.js 0002-example-change` to append
   its SQL and history-prefix checksums and regenerate the ignored input.
   It refuses edited historical files. Commit the delta and manifest only;
   never edit or commit schema.sql.
3. If changing a reference default, update its single definition in
   reference-data.js too. A fresh database has no old reference rows for a
   historical UPDATE to transform; an existing database does. Add a delta
   when existing rows need a deliberate transition, preserving operator
   choices where required. Test both fresh and skipped-release upgrades.
4. Run `npm run test:changed -- --base <exact-base-sha>`. Set
   `TEST_DATABASE_URL` to a disposable PostgreSQL server for the selected
   migration regressions. CI also validates SQL and the strict preview
   schema policy. Review that policy when the catalog changes; approving a
   schema never approves exporting new data.

Never edit, reorder or delete an applied migration. Correct it in a new file.
The manifest's schemaSha256 is the digest of its ordered migration prefix,
not of generated output or mutable reference defaults. A build older than
recorded history or with different checksums refuses schema startup. Roll
forward with compatible reader/writer releases; an old image is not a
schema down-migration. Existing marker-guarded boot repairs and fixtures
continue through migrate.js.

Files cannot commit/roll back themselves. CREATE INDEX CONCURRENTLY needs a
separately designed maintenance operation because it cannot share the
transaction. For large constraints, use separate ADD CONSTRAINT ... NOT VALID
and VALIDATE CONSTRAINT migrations where PostgreSQL supports them. A
10-second lock acquisition timeout and bounded retries still apply; that
timeout does not cut off slow statement execution.

During lock waits one bounded, short-lived observer connection samples
actual blocking PIDs and waiting relations. Logs contain identity/lock
metadata, never SQL text or user data. Other roles' state/age may be null
without pg_read_all_stats; PID/application identity remains visible. Failed
diagnostics cannot fail a migration. No sessions are cancelled or terminated
and no monitoring privileges are added. Serving/provisioning logins can
read receipts for existing database exports but cannot modify them.

The preview builder materializes the deployed generated schema, sanitizes
all imported rows and discards production receipts, then generates trusted
local receipts from its manifest. Direct and template copies therefore do
not replay old migrations over an already-current schema. Proposed code
runs only its pending deltas, then boot reference inserts and fixtures.
Generated SQL, including reference defaults, contributes to preview-policy
invalidation. The policy accepts the journal's exact optional shape across
the cutover without broadening production exports.
