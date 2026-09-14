# Preview preparation performance

After source checkout and manifest/secret validation, image building and database
cloning run concurrently when the target clone database is confirmed absent.
Both must succeed before deployment. Failures wait for both operations to settle
before dropping the new clone and releasing the session build guard. Cleanup
failure is logged without replacing the original error. The orphan sweep remains
the backstop for interrupted processes or failed cleanup.

An existing target database (including same-commit rebuilds), or a failed
existence lookup, retains image-before-clone ordering so an image build failure
cannot destroy an existing preview database. This preserves deterministic clone
names and the existing teardown contract on both Docker and Kubernetes.

Image and clone durations measure each operation's wall time independently;
because they can overlap, their sum is not total preview preparation time.
The reported total remains actual elapsed time. Progress shows image building
until that finishes, then cloning if the clone is still running.

Completed Kubernetes images can also be reused across sessions; see
[kpack image reuse](kpack-build-retention.md#completed-image-reuse-across-sessions).

## Startup fixture batching

The self-app's staging seed order stays sequential, including dependency guards
and completion before the HTTP listener opens. Five routines now insert sets of
rows instead of issuing one query per row: topic-scroll threads, home layouts,
LLM usage, analytics charts, and spend distribution. Parameters remain bound;
no data is interpolated into SQL. Explicit row ordering retains generated IDs
where the old loops determined insertion order.

A disposable PostgreSQL 17 comparison against the previous implementation
produced identical rows in all six affected tables and reduced these routines
from 277 to 17 queries with the test fixture's users and anchors. This is a
query-count comparison, not an end-to-end startup speed measurement. Fewer
network round trips particularly help previews placed far from their database.
Other seed routines continue to run as before.

Run the database integration test against a disposable local PostgreSQL server
by setting `FIXTURE_BATCH_TEST_URL` and running
`node --test tests/staging-fixture-batching.test.js`. The test creates and removes
its own database, loads the real schema, and checks row contents, message order,
repeated boots, partial threads, absent anchors/apps, and custom-layout retention.
