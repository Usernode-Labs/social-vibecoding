# Packaged CLI web/worker proof

Canonical revision is explicitly pinned to `d9cf30cd73a0810be72b199f8b2a194f8c56b793`,
merged into accepted `3f51e2b3f` at `6730b091306c0dcbcf22579548dc2dd273b2f1f7`.
Admission remains default-off outside the disposable fixture. No historical
handler/replay removal, caller expansion, push or deployment belongs to this slice.

## Contract before the proof

Build `Dockerfile.kubernetes` with the integrated revision. Run its default
`node server.js` command and `node scripts/preview-preparation-worker.js` as separate
non-root containers. Use the normal config loader, database pool, HTTP middleware,
CLI build route and worker polling. Apply the shipped schema through the packaged
migration entry point before starting the worker. All destinations and credentials
are generated for a fresh, ownership-verified local fixture.

A test-only preload may substitute external GitHub responses/policy invocation,
network transport to the disposable cluster and unrelated fleet duties. It must
not substitute successful clone/build/runtime observations, admission, activation,
settlement, claim/transaction persistence or continuation delivery. Pause hooks
run after real persistence/external operations, then the parent kills the actual
entry-point process. Restart must inspect and adopt those outcomes.

- Kill web after admission commits and before its HTTP reply. Retrying the same
  authenticated request returns the same preparation identity. Required work
  survives without a web promise or worker already running.
- Kill worker after candidate completion commits. Its durable continuation must
  exist; preparation must preserve the currently serving runtime and binding.
- Kill worker after real stable-binding activation, before observation completes.
  Recovery adopts the same binding/resource UIDs and never prepares another candidate.
- Kill worker after the verdict/receipt/history/gate transaction commits, before
  acknowledging it. Recovery adopts that verdict, retires the original check run
  and delivers the same required gate without recounting history or recording an error.
- Restart web alongside these boundaries, and recover with new admission disabled.
  Database OID, Build UID/digest, Secret/Service/Deployment UIDs and check run/Job
  identities stay stable where adoption is required. Authentication and ownership
  exclusions remain active.

Inspect exact fixture ownership before every process admission or cleanup. Missing
or mismatched destinations fail closed. Never mount the default kubeconfig, Docker
socket, host credentials or production configuration into the backend containers.
Generated container kubeconfig points only to the recorded local node; database
URLs point only to the recorded disposable PostgreSQL container. Capture/build
outputs use the dedicated fixture registry. Keep all unresolved late-creation
obligations; process exit or observed absence does not prove creator closure.

## Evidence boundary

This proves packaged entry-point coordination for the existing native CLI cohort.
GitHub branch/content/policy responses, local transport, tiny pinned source/template
and injected loss points must be recorded precisely. It does not prove actual GitHub
merges, production permissions, public TLS/private-user access or arbitrary mixed
backend/capture versions. Historical formats stay until an explicit supported-store/
export decision and its inventory/archive are demonstrated.

## Demonstrated local evidence

One actual packaged matrix passed with no failures/skips in fresh fixture
`3ad3c190-8e56-4ce2-ae58-0dbd8a987148`. The product base is integrated `6730b0913`;
this checkpoint's test driver/preload is additional harness code. The shipped
production owners, Dockerfile and dependency locks have no changes after that merge.
Proof input checksums are retained in `packaged/source-sha256.json`.
Owned teardown is complete for all five attempted fixtures and the PostgreSQL-only
fixture; generated configuration and logs remain private. Backend image ID is
`sha256:bdb5fa6aa369ae307a636eda154132aef25cab436539052d80a7015a5561e8d0`.
The private fixture `packaged/result.json` records the full source/image tuple,
fresh-store counts, work/run identities, observed OID and UIDs. No generated
credential/configuration is committed.

- Lost HTTP admission reply rejoins preparation
  `14ca5e1f-560b-4e0a-b485-f9a3d5823067`; only one preparation request exists.
- Candidate completion commits continuation
  `12423b60-f122-42ad-b1b0-15b12dd5ffc0` before activation. The real sentinel
  remains healthy and serving until the separately authorized binding update.
- Activation reply loss adopts the same Ingress and candidate. Database OID
  **22461**, Build UID `91653131-ea63-437b-bd7b-69cde025773a`, image digest
  `sha256:05aee89c0ebf6e963451db3ea1e5885b896f74860ee7475672d8ee8b3a5e9423`
  and all three runtime UIDs remain unchanged through subsequent restarts.
- Real browser/unit Jobs share run `2ee759ac-38f2-47c6-addb-d36670f23e1b`.
  Exactly two Jobs are created. The unit suite passes; the sample's favicon 404
  makes the browser verdict **failing**. Restart preserves that verdict, its
  accepted receipt and history exactly; original Jobs/inputs retire and the
  manifest/lifecycle obligation closes. Recovery uses the normal checks orphan
  heartbeat window, without accelerating that heartbeat.
- Required bot gate `a29aa4c2-3e9b-4d3a-9800-4050fedef7c0` reaches
  `gate_delivered` after one substituted policy invocation; continuation succeeds.
  This actual-resource run does not prove merge delivery. Fresh-process and
  disposable PostgreSQL merge-dependency/delivery regressions remain separate evidence.
- Recovery works with admission disabled; HTTP new-head admission is refused.
  Invalid bearer credentials are rejected. The serving sentinel remains healthy.

Earlier failed runs exposed harness errors: missing private BuildKit client,
incorrect sentinel app identity, callback-only/PID-1 signal pause hooks, and
queries using noncanonical column/table names. Correct those without changing
product guards or substituting successful observations. A synchronous event-loop
barrier fixes the process-loss hook; preserve the actual browser failure rather
than treating it as an infrastructure error. Fresh owned fixtures were used after
admitted runs failed; teardown retains their evidence.

Focused CI: **1,003 passed**, zero failures/skips. New isolation/fixture/CI checks:
**18 passed**. Mapped local guards: **103 passed**, two opt-in integration skips;
the actual packaged case above ran separately. Integrated SQL/writer/canonical
and actual destructive-retirement evidence is in the [integration record](canonical-integration.md).
No old platform handler, reducer, lock or recovery owner is removed by this proof.

## Fixture substitutions and limits

| Boundary | Actual work / substitution |
| --- | --- |
| Package and bootstrap | Build the shipped Dockerfile with the pinned integrated product code; default web CMD, standalone worker `main`, migration, config loader, pool and SDK construction are real. Containers run as UID/GID 1000. Generated local SDK keys make no real GitHub requests. |
| Admission | Real bearer authentication, authorization, HTTP route and atomic enrollment. Seed one CLI token/user/session and its managed uploaded head; commit upload, login/device authorization and voting are outside this proof. |
| Source and clone | Git prepares the pinned small public health-source revision. GitHub branch/content/ancestry responses are supplied fixture metadata. Preseed a disabled template with an evidence row; actual clone creation/sanitization and persisted OID are observed. Template refresh is not exercised. |
| Build/runtime/binding | Actual kpack Build, digest and Secret/Service/Deployment/Ingress operations in the verified disposable cluster/registry. A separate real sentinel runtime represents the serving preview. No successful observation is substituted. Health uses the real Kubernetes Service proxy instead of the public edge. |
| Checks | Real digest-pinned Chromium and companion unit Jobs, input Secrets, output harvesting, retirement and settlement. Tiny unit source runs two real assertions. The health sample can emit a favicon 404 console failure; preserve its actual verdict and corresponding required gate, rather than fabricate a passing result. Content review can remain advisory/unreviewed. |
| Gate and optional duties | Seed promoted/reviewed status to exercise required delivery, not a voting/PR lifecycle. Substitute `merge-queue.enqueue` and `homeroom-bot.noteProposalChecks`; require the appropriate invocation after restart. External merge/bot effects are not proved. Certificate warming/notifications are no-ops; unrelated fleet maintenance is disabled for this request-serving web follower. |
| Interruption and time | Test-only preload writes a boundary marker, synchronously blocks that process's event loop, then the parent sends SIGKILL. On stop, only this fixture's existing running claims become due/expired immediately. Real claim/decision/ownership checks still execute; elapsed production lease timing is not measured. |
| Network and privileges | Backend database and Kubernetes physical identities are rechecked inside packaged processes. Mutation wrappers restrict the fixture namespace; HTTP guards forbid external destinations. Dedicated cluster-admin fixture credentials prove operation, not least-privilege worker RBAC. Public HTTPS becomes internal Service HTTP for capture. No TLS, Secure-cookie/private-user or production network policy proof. |

The driver owns all test containers/images through a durable local journal written
before creation. Lost Docker replies can be reconciled by immutable request/name/
image identity; mismatches fail closed. Teardown verifies ownership before removal.
This is test-fixture cleanup, not another platform executor.

Run explicitly in a newly provisioned fixture:

```sh
node scripts/kpack-local-fixture.js test-packaged <dedicated-fixture-directory>
```

Its prerequisite is full `setup` and `setup-unit-checks` preflight. An isolated
flag or URL alone fails before mutations. The fresh-store scan covers work,
resources, check runs and all four decision journals before admission. Its zero
counts say nothing about other developer stores, backups or historical exports.


## Subsequent HTTPS/private-capture proof

[The HTTPS contract](https-private-capture-contract.md) records a fresh packaged
matrix using unchanged HTTPS URLs, fixture-scoped browser trust, real edge/session
exchange and separate screenshot/assertion permissions. It also interrupts the
worker while original Jobs run and after verdict persistence; continuation and
required substituted merge delivery recover without competing Jobs. The internal
HTTP transport above remains historical evidence for that earlier matrix. The
new proof's TLS installation, tiny auth surface and explicit private membership
are substitutions; production installation and ordinary private-project permission
provisioning remain unproved. Repeated-use/published-predecessor retirement is the
following essential gate, not another workflow expansion.
