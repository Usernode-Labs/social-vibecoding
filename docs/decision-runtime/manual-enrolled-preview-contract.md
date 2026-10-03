# Manual requests for an enrolled preview

2 October 2026 · bounded caller cutover, not migration completion.

`deploy-staging`, `ensure-staging` and `recheck` retain their existing route authentication,
collaboration, owner/admin, status and headless policies. For persisted CLI
preview enrollment they use the accepted exact head and existing preparation/
continuation owner. They do not resolve `latest`, change the checks pin, publish
runtime fields, or start web-owned build/capture promises. Unenrolled callers keep
their current behavior until their own cutover.

Manual deployment joins unfinished work. Once that work has completed, it requests
a new attempt through the existing head/preparation actions, provided admission is
still enabled and the accepted head and serving runtime match the request's
snapshot. Preparation preserves the serving preview; activation remains separately
authorized. A stale request must not initiate repair of a successor. Disabled
admission permits recovery of retained work, not fresh preparation.

Manual recheck joins unfinished/blocked work. After prior checks and consumers
finish, the existing forced-check action atomically resets the verdict and queues
continuation. A route-local pending write must not erase a committed verdict before
that decision. Unknown check outcomes retain their harvester reconciliation owner.
Normal waiting returns progress, and blocked/unavailable recovery is explicit;
neither is logged or settled as a build failure.

Work/flow/action identities are persisted by the existing foundation. Concurrent
clicks and retries after response loss join the pending work, including after web
restart. A later deliberate request after completion can start another check or
repair; this API does not yet provide a client-supplied idempotency key covering
arbitrarily delayed retries after the entire operation completes. The full migration
checklist retains stable request identity as a remaining API/caller requirement.

Verification uses real HTTP routes and ownership-verified disposable PostgreSQL.
Preparation, runtime health inspection, activation, checks and GitHub are injected
in these focused tests;
existing actual-resource proofs are prior evidence, not a rerun of this cutover.
No new executor, work kind, capability flag or reducer format. Direct legacy SQL
and process sets remain for unenrolled callers; their removal is still mandatory
in the original migration.

The stale manual observation is carried into the existing head/check actions.
Reducers reject changed serving identity or head; rejected decisions remain visible
in traces. No additional lifecycle policy is added to an execution handler.
The unused chat-file Docker builder/parser is also removed after repository-wide
caller/export inspection; it owned no retained resources or supported invocation.

Evidence: seven route/recovery regressions plus existing contracts in an owned
PostgreSQL fixture; focused runner 1,065 pass, no skips. Caller-mapped suites run
serially: 4,931 pass, two actual-resource opt-in skips. SQL and offline replay pass.
The legacy unit harness now substitutes capture explicitly; the deleted generator's
environment inventory is updated without relaxing key-leak guards. The prior
canonical launcher limitation remains recorded in the internal review.
