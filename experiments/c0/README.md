# C0 execution-backend comparison

This directory is an isolated experiment, not a production executor. Neither
backend is imported by the web server. The root package, production schema,
caller migration and preview feature flags are unchanged.

See [the decision and evidence](../../docs/decision-runtime/c0-backend-comparison.md).

## Run

Prerequisites: the repository's installed dependencies, a **disposable**
PostgreSQL database, Node 24, and Temporal CLI **1.9.1** (server **1.32.0**).
The experiment's SDK dependencies are pinned to **1.24.0**.

```sh
npm ci --prefix experiments/c0
C0_DATABASE_URL=postgres://postgres@127.0.0.1:55439/postgres \
C0_TEMPORAL_CLI=/absolute/path/to/temporal \
node --test --test-timeout=240000 experiments/c0/comparison.test.js
```

Both environment variables are required; absence fails the test instead of
silently skipping. The fixture creates/drops its own schema. Run comparisons
sequentially, away from production: PostgreSQL advisory locks are database-wide,
even when tables use distinct schemas. The lock-loss test deliberately terminates
its own worker's PostgreSQL backend.

The harness starts a real Temporal dev server with a unique SQLite file, loopback
HTTP ingress, independent execution/dispatch child processes, and a controlled
external-resource server. It deliberately kills and suspends children. Teardown
stops the children and Temporal service and drops the scratch schema. Ignored
`.artifacts/` retains child logs, Temporal SQLite/history storage and trace examples.
No credentials from the environment or running platform are used; the encryption
key and credentials belong only to this fixture. Interrupting the harness itself
can leave a disposable schema, so use a database that can be discarded.

## Boundaries

- `web.js`: actual preview admission plus a work record in the B2 transaction.
- `steps.js`: shared operation sequence adapters for both backends; actual domain,
  activation, cleanup and resource-lock code, with child-local transport shims.
- `resources.js`: controlled durable objects outside worker/web process lifetime.
  This substitutes for Kubernetes APIs, clone preparation and health probing;
  it does **not** validate a cluster, PostgreSQL redaction, image builds or routing.
- `bounded.js`: fixed stages, rotating due-work selection, expiring claims,
  heartbeat, fenced checkpoints and retry scheduling in PostgreSQL.
- `dispatch.js`: retryable PostgreSQL handoff to stable Temporal workflow IDs.
- `workflows.js` / `temporal-worker.js`: Temporal orchestration and activity worker;
  no production lifecycle policy is implemented in workflow code.
- `comparison.test.js`: identical failure cases for both lanes, plus Temporal
  service-outage/start-delivery and history-replay checks.
- `incompatible-workflows.js`: deliberately invalid replacement for replay testing.

The table names, short timeouts, perpetual retirement loops and monkey-patched
transports are comparison fixtures. Do not extract them into production. Keep the
accepted B2 foundation and existing preview protections; stage C requires actual
recoverable service steps and a deliberate execution-owner cutover.
