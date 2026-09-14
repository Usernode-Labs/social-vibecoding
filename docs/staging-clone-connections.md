# Template clone connections

Preview template clones reuse two short-lived PostgreSQL connections: one to
the maintenance database for cleanup, role creation and database creation, then
one to the clone for ownership transfer and both privacy-redaction passes.
Previously, each statement launched psql and opened a fresh connection. An app
with many private tables or columns repeatedly paid process, DNS and login costs.

The clone still truncates every private table with identity reset and scrubs
every private column. Statements run sequentially in autocommit; errors remain
fatal to the redaction pass. Cleanup must succeed before role/database creation.
Connection, statement and client query timeouts are 30 seconds. Connections
close on success and failure, before the caller can attempt direct-copy fallback
or delete the clone. No administrative connection is returned to a shared pool.

Template refresh, the direct pg_dump/pg_restore fallback and ordinary database
administration retain their existing one-shot executors. This change requires
no database migration, credentials change, DNS override or new dependency.

## Validation

Run the focused tests:

```sh
node --test tests/staging-db-template.test.js tests/db-manager-scrub.test.js tests/db-manager-dump-restore.test.js
```

The optional PostgreSQL integration test requires a **disposable local** server
with a `usernode` maintenance database, an administrative role and psql on PATH.
Set `DB_CLONE_TEST_URL` to that local test database and run:

```sh
node --test tests/db-clone-connection.integration.test.js
```

The test creates uniquely named template/clone databases and roles, verifies
private data removal, unique redacted tokens, sequence reset, ownership and
closed sessions, then removes its fixtures. Without the variable it skips.
Never point it at a platform database or run it against production.

After normal deployment, compare `Database cloned from staging template`
duration and the preview's clone timing for the same app/template. Local tests
verify correctness, not production latency. Rolling back the application
restores the previous connection behavior; no data-format rollback is needed.
