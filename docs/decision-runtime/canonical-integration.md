# Canonical integration and focused CI

2 October 2026. Integrate canonical main
`d600eb4308b0d283ba050addf4c19c915078086c` into accepted local checkpoint
`2bf702dbd8651f9877d492f0d21645c24a444668`. Admission remains default-off;
no rollout, caller migration, push, deployment or production mutation.

## Reconciliation

- Resolve six conflicts by retaining both contracts: canonical schema additions
  and private decision/execution tables; user overrides plus create-only deployment;
  node reporting; guarded staging progress; lifecycle recovery plus bot verdict
  notifications; all credential-hash audit exceptions.
- Preserve automatically merged imported fresh-head reconciliation, proposal-
  description updates, bot/benchmark recovery exclusions, cleanup/activation owner
  exclusions and legacy resource/retention protections.
- New candidate selection snapshots canonical database zone/host placement.
  Retained desired specs keep host-only placement, spec labels and resource UIDs;
  recovery does not apply current configuration to a saved specification. No
  operation identity, work kind/version or reducer version changed.
- The writer audit adds one fixed shots-demo preview fixture exception. All
  15 existing statement fingerprints/counts remain unchanged. Real publishers
  remain restricted; the legacy reaper explicitly excludes attempt-specific
  candidates, whose persisted owner retains cleanup.
- Complete the Underway route's PostgreSQL test schema with the enrollment table
  its shared preview snapshot reads. This fixes a test-fixture omission, not a
  production transition or authorization rule.

## CI boundary

The [focused runner](../../scripts/test-preview-flow.js) covers shared decisions,
execution/discovery, second-workflow reuse, complete preparation, CLI admission,
checks/retirement, isolation and relevant canonical adapters. Path filters follow
those owners and test helpers. A coverage test checks that the selected suites
exist and their changes trigger the job.

Admission/CLI tests support PostgreSQL-only mode with every external operation
injected. The initial explicit-URL-only service boundary had an ownership gap;
the [ownership correction](postgres-test-isolation.md) now requires verified
disposable container and PostgreSQL identity in the runner and direct suites.
CI provisions that owned database instead of skipping for lack of Kubernetes. The runner refuses a general
SQL fallback; it supplies one explicit database to its suites. Actual-resource
tests retain their full dedicated kubeconfig/cluster/database/registry preflight.
No production admission switch or resource-preflight bypass was added.

The command is demonstrated locally. GitHub job execution, Linux runner setup and
installation compatibility remain unverified because this branch has not been pushed.

## Evidence on the integrated implementation

| Check | Result and scope |
| --- | --- |
| Focused CI command | 898 passed; zero failures/skips. Real PostgreSQL decisions and injected external operations; existing isolation safeguards also run. |
| SQL/schema | 3,214 unique statements / 4,109 static variants validated against disposable PostgreSQL. Canonical and experiment schema/dynamic inventories coexist; no blanket baseline regeneration. |
| Build recovery | 3 actual kpack/PG cases: interruption/lost reply adoption, terminal failure, delayed creation and successor-preserving retirement. Clone/runtime observations remain injected in this narrow suite. |
| Runtime recovery | 6 actual Kubernetes/PG cases: partial creation, healthy adoption, lost replies, delayed resources, ownership conflict and safe retirement. Build/clone inputs are fixture facts. |
| Dependency release | 6 actual PostgreSQL/Kubernetes cases: worker/reply loss after retirement/drop, existing connections and late Pods, prepared-transaction blocker and missing clone identity. |
| Complete preparation | One actual source → clone → kpack → runtime matrix, with phase-boundary loss and predecessor retirement; OID, Build UID/digest and runtime UIDs preserved on adoption. |
| CLI handoff | 15 passed: one actual preparation/conditional-Ingress process-loss matrix and 14 PostgreSQL/injected-operation regressions. Checks/auth/GitHub transport remain substituted here. |
| Checks and retirement | 15 passed: actual Chromium capture, companion unit Jobs and destructive cleanup; includes 12 harvester/live-error loss boundaries after Job deletion, consumer-stop confirmation and input deletion. |
| Mapped affected suites | 10,198 passed, 19 skipped, one existing occupied-port launcher failure. The same status-0-versus-2 failure reproduces from exact canonical files; those paths are unchanged. |

Actual runs use a newly provisioned, dedicated local fixture. Pinned small source/
builder/runtime/unit fixtures, internal unauthenticated origin transport, selected
manifest/verdict metadata and injected SIGKILL/reply-loss/delayed-delivery boundaries
remain substitutions. The operation contracts describe them precisely. No public
edge/TLS/private-user or production builder compatibility is established.

Private fixture logs and source hashes are recorded in the local implementation
ledger. Ownership-verified teardown retains evidence and removes disposable resources.

## Remaining work and removals

No runtime owner, lock, timer, handler or replay version was removed. CI's outdated
partial suite selection and implicit SQL-destination fallback are replaced; its
PostgreSQL-only tests do not introduce another production owner.

The [roadmap](roadmap.md) still requires an explicit retained-store/trace policy,
unknown checks outcome resolution, idempotent gating settlement and supported
capture/worker boundary verification. Conservative late-creation retention remains.
The first supported CLI gate and the full migration are not complete.
