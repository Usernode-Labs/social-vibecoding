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
