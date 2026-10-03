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

## Pinned reconciliation after the supported-contract review

Accepted `3f51e2b3f88b6261e046466ab6d1cbd7b78e0420` is reconciled with explicitly
pinned canonical `d9cf30cd73a0810be72b199f8b2a194f8c56b793` at local merge
`6730b091306c0dcbcf22579548dc2dd273b2f1f7`. All 15 newer canonical commits merge
without content conflicts. This is a verified ancestry claim against that pin,
not a promise to track a moving branch tip during the experiment.

Preserved relevant newer behavior: benchmark orphan restart/adoption
(`a3ebbf92c`), fresh live approval display and ledger (`c1c0a2e8e`), and sealed
checkout/own-PR-diff benchmark validity (`d9cf30cd7`). Experiment operation
identities, desired specifications, legacy ownership exclusions, conditional
activation and retirement guards are unchanged. No schema, work contract or
reducer version is introduced by this reconciliation.

Current local evidence on the integrated product code:

- Focused runner: **1,003 passed**, zero failures/skips, using verified disposable
  PostgreSQL. Includes standalone dependency initialization, atomic settlement,
  unknown outcomes, discovery fairness, ownership and retirement regressions.
- SQL: **3,250 unique statements / 4,153 static variants** checked against the
  shipped schema in disposable PostgreSQL.
- Writer inventory: **16** explicit legacy statements remain, with unchanged
  fingerprints; no new projection writer is allowed.
- Actual checks/retirement: **15 passed**, zero failures/skips, in a fresh disposable
  Kubernetes/PostgreSQL/registry fixture. Chromium, unit Jobs and destructive
  retirement steps run; external GitHub and selected inputs remain substituted
  as documented in their contracts.
- New isolation/fixture/CI checks: **18 passed**. Direct invocation fails closed;
  persisted test-container identity allows recovery after a lost creation reply
  and rejects a successor identity (these two cleanup cases use injected Docker
  inspection responses).
- Canonical sealed-checkout regressions: **9 passed** after allowing their local
  loopback test adapter. The first sandboxed invocation could not bind its local
  adapter; no product correction was needed.

The [packaged HTTP/web/worker proof](packaged-cli-entrypoints-contract.md) records
its own actual evidence and substitutions. The fixture driver now exposes
`test-packaged`; its container/image journal supports owned teardown after test
interruption. New test isolation coverage joins focused CI; actual-resource
execution remains explicit and local. GitHub CI was not run or authorized.

No production timer, lock, handler or compatibility branch was removed by that
reconciliation. Its remaining-work statements are historical: subsequent accepted
work completes retention/archive removal, settlement, packaged entry points and
disposable TLS/identity/repeated-use proofs. Least-privilege installation,
supervision and production builder compatibility remain separate verification
gates. See the [current roadmap](roadmap.md).


## Reconciliation after strict unit-source inspection

On 2 October 2026, source correction `ed13ea6fa128a11a61cd8fa67b3e8e47ea2cc4da`
is followed by local merge `6cab97bb7c882b0767872707bb6be52a7df22970`, containing
explicit canonical pin `74276a2fb7002da251e1b3975ae22b81dbc765e3`. No textual
conflict. This is the reviewed pin, not an automatically advancing branch tip.

Canonical issue-comment IDs, bot discussion/tray/scheduling/typing behavior and
shots-worker hold/retirement are preserved. The latter remains the canonical
in-process optional-shots contract; it is not a new cross-process durability
claim. Pilot GitHub dependency initialization, required bot-delivery error
propagation, persisted operation identities/specifications, CLI exclusions,
conditional activation and consumer/late-creation retirement protections remain.
The dynamic SQL inventory merges and validates without a blanket baseline refresh.
No new work format, reducer, workflow or caller is introduced.

Verified on this reconciled code:

- Actual GitHub/unit-helper regressions: **59 passed** with Octokit transport
  substituted, covering inaccessible 404 versus genuine absence and unverifiable
  source/metadata. No actual GitHub access is claimed.
- Focused runner: **1,030 passed**, no failures/skips, against physically verified
  disposable PostgreSQL. Includes atomicity, recovery, fair scheduling, checks,
  settlement and retirement regressions.
- SQL: **3,268 unique statements / 4,171 static variants** validated; writer audit
  retains **16** explicitly recorded legacy statements; archived replay **153** pass.
- Affected mapping after `npm run ensure:shell`: **16,737 passed / one failure /
  13 fixture/platform skips**. Generated shell outputs are ignored and uncommitted.
  Its only failure is pinned main's unchanged occupied-front-port test on macOS:
  the test holder inherits the IPv4 preload, its spawned launcher does not and
  can bind IPv6 separately. All **12** launcher cases pass when the child inherits
  the same test-only loopback preload. No product change or hidden skip.
- First broad invocation also had two stale-shell assertions and a canonical DM
  typing-order failure. Regeneration resolves the shell assertions; all **19** DM
  cases pass alone and the post-generation broad run passes that case. DM and
  launcher owners/tests are byte-identical to pinned main. Record the intermittent
  ordering and platform test limitations rather than expanding the pilot.

Counts overlap. Normal GitHub/Linux CI remains required; local checks do not claim
it has run. The ownership-verified disposable database was retired after testing.
No new actual Kubernetes fixture was provisioned: accepted packaged/preparation/
HTTPS/repeated-use proofs retain their original revisions and explicit injections.
No legacy production safeguard, timer, lock, compatibility handler or resource
owner is removed by this reconciliation. Default-off containment remains; no push,
production access or deployment.
