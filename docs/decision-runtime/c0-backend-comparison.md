# C0: execution-backend decision

**Recommendation: use Temporal for durable preparation/check orchestration. Keep
PostgreSQL, the B2 action API, and the resource adapters authoritative for domain
state and resource safety.** This selects an execution direction; it does not
approve a production Temporal deployment or expand the preview experiment.

The bounded PostgreSQL alternative works for the fixed sequence tested here.
Temporal is preferable for the planned system because it supplies durable
sequencing, waits, retries and execution history that we would otherwise maintain
across preview, checks and subsequent workflows. It does not remove most of the
work required to make today's combined operations safely resumable. Its additional
service, storage, security and deployment requirements are a real cost.

## What was compared

[Runnable experiment](../../experiments/c0/README.md), 30 September 2026. Both
lanes admit the same candidate-preview action, reserve the same attempt-specific
resources, prepare a clone, build, check and separately activate. They use the
actual B2 transaction runtime and preview/review machines. Both execute outside
the HTTP process and retain the existing PostgreSQL resource/retention guard.

The bounded lane stores a fixed phase, due time, claim token and lease in a
scratch PostgreSQL table. Temporal stores workflow progress in a real local
service: SDK **1.24.0**, CLI **1.9.1**, server **1.32.0**, persistent dev-server
SQLite. PostgreSQL **15.10** stores domain state and the handoff in both lanes.
The shared [steps adapter](../../experiments/c0/steps.js) uses a separate controlled
resource service whose durable objects and accepted creates outlive killed workers.
Kubernetes transport, clone contents and health are simulated. This is a backend
failure comparison, **not live Docker/Kubernetes or production rollout validation**.

Check-result storage uses the real `storeChecks` mapping with an experimental
current-flow guard under B2's aggregate transaction. It does not migrate the
production check action API or execute full harvest/history/gate settlement.

The branch checkpoint is `efe14317eef13cd9283de9a8082963a6f0b1c0ed`.
Canonical main checked at `07b72f0afa151939b35edc3eef4dfb341c9ec2f9` is ahead.
The authorized branch was not rebased. Upstream #3496 changes shots recovery and
Kubernetes execution-user handling; reconcile those before migration. Infra was
read at `c71df290eeef0ae576cc7766a83f82a4dd8c1722`.

## Same failure scenarios, different recovery machinery

The suite asserts outcomes and resource identities, rather than only that a
worker restarts. See [the assertions](../../experiments/c0/comparison.test.js).
Final comparison: **33 passed, zero failures/skips**; accepted preview/B2
PostgreSQL contract rerun: **287 passed, zero failures/skips**. The comparison
includes 15 scenarios per lane plus the lane/root test groups. It exports
correlated traces to ignored `experiments/c0/.artifacts/*-trace.json`.

| Scenario | Both lanes demonstrate | Backend difference |
| --- | --- | --- |
| Commit work; stop/restart web before execution; repeat request | Original flow/work identity survives; one admission; execution completes | Local worker discovers the PostgreSQL row; dispatcher starts a stable Temporal workflow ID |
| Execution unavailable after commit | Accepted obligation remains pending and resumes | Local lane stops its worker. Temporal additionally stops/restarts its service using the same SQLite store; delivery errors retry. PostgreSQL outage/failover is not tested |
| Duplicate Temporal start / lost start acknowledgment | Stable start identity prevents duplicate workflow creation; handoff acknowledgment eventually settles | Temporal service deduplicates starts within history retention; PostgreSQL delivery tracking remains ours |
| Retryable I/O versus failing test | I/O retries; a failing verdict is stored once and preparation proceeds; the test is not rerun as an infrastructure failure | Local retry/due-time code versus Temporal activity retry |
| Clone created, response lost | Same clone identity and encrypted credential are recovered; completed marker permits reuse | Neither backend supplies clone inspection or completion markers |
| Partial clone | Abandoned and cleaned; never attached or activated | Partial-preparation policy stays in adapters/domain, not scheduler |
| Worker killed during surviving build | Existing Job UID is adopted; currently serving preview remains unchanged until activation | Local expired lease/checkpoint versus Temporal task timeout/history replay |
| Resource-lock connection lost during creation | Worker exits; web remains available; successor worker adopts the created Deployment | The retained guard causes fail-stop in both; the backend does not fence external I/O |
| Lease/heartbeat expires while old worker is suspended | Peer receives a busy result from the still-held resource lock; after resumption, one resource and one activation | Claim/timeout expiry alone cannot transfer external ownership |
| Supersession while old completion is in flight | Old prepared report is rejected in the decision journal; cleanup preserves successor | Same aggregate/generation guard in both |
| New head or same-SHA successor | Old flow cannot publish; historical cleanup does not delete successor | Identity includes generation/attempt, not only SHA |
| Cancellation; accepted create completes after cleanup observed absence | Retirement stays discoverable; later creation is removed; subsequent preview survives | Local cleanup checkpoint loop versus Temporal cancellation/non-cancellable retirement loop |
| Activation applied, acknowledgment lost | Observed route settles the authorized intent; route version advances once | Conditional route operation/readback remains identical |
| Oldest 25 repeatedly failing or holding real resource locks; six later items and a new arrival | Eligible items finish; blocked obligations receive attempts and stay pending; all recover after faults/locks are released | Local rotating queue versus configured Temporal fairness, activity backoff and durable sleeps |
| Changed orchestration with old execution active | New version completes; old execution remains resumable on its original version | Both use explicit version lanes; Temporal also replays history and rejects incompatible replacement code |
| Trace correlation | Execution identity joins to durable domain decisions by flow ID | Local claim token/attempt versus Temporal workflow/run/activity/attempt plus service history |

Fairness is conditional on healthy storage/workers, finite activity timeouts,
available capacity and eventually releasable resource conflicts. This finite
regression proves the observed non-starvation sequence, not a universal latency
bound or completion despite permanently unavailable resources. Local claims
rotate before I/O; retries rotate again and expire after interruption. Temporal
uses equal session fairness keys with `matching.enableFairness=true`, five
activity slots, bounded activities and backoff. Production fairness configuration
and admission/resource budgets remain required. [Temporal fairness semantics](https://docs.temporal.io/develop/task-queue-priority-fairness).

The suite caught a handoff race in its own dispatcher: excluding finished work
could leave a lost start acknowledgment unresolved. Delivery now retries until
acknowledged independently of completion. These are separate facts. Stable IDs
also do not provide permanent deduplication after Temporal history expires; keep
completion/delivery receipts and reconcile before redispatch beyond retention.

## Responsibilities removed, adapted and retained

| Responsibility / current code | With Temporal | With bounded PostgreSQL execution |
| --- | --- | --- |
| Aggregate locks, validated actions, enabling conditions, reducers, receipts and decision traces: [B2 runtime](../../src/services/decision-runtime/index.js) | Keep unchanged; activities submit facts/requests | Keep unchanged |
| Atomic domain decision and execution request | Implement a PostgreSQL outbox; retry stable-ID delivery; reconcile ambiguous outcomes | Implement atomic work admission using the same transaction; no second-store delivery boundary |
| Due-work discovery, progress, claims, retries, timeouts and waits | Temporal owns scheduling/history; configure policies and capacity | Maintain queue rotation, leases, heartbeat, token-checked checkpoints, retry policy and recovery ourselves |
| Check owner heartbeat/orphan discovery: [check-runs.js](../../src/services/check-runs.js), [check-harvest.js](../../src/services/check-harvest.js), [server boot/timer registration](../../server.js) | Remove `startHeartbeat`, `listOrphans`, `claim`, harvester scheduling and process-owner seats **only for enrolled runs**, after proving worker recovery | Replace/adapt those mechanisms into one bounded executor; avoid two independent claim/heartbeat systems |
| Check manifest and Job adoption; harvest parsing/settlement | Retain immutable input/Job identity and adapt `adopt`, Kubernetes/unit-suite readers, `settleCaptureRun`, shots/gate/history handoffs | Same; a phase checkpoint does not know how to inspect an existing Job |
| Combined [staging build](../../src/services/staging.js) / [candidate runner](../../src/services/preview-flow/candidate-native.js) | Split into reserve, inspect/create, observe and report activities; do not retry the opaque whole call | Same split before checkpointed retries are safe |
| [Cleanup sweep](../../src/services/preview-flow/cleanup.js) and [activation recovery](../../src/services/preview-flow/activation.js) | Replace enrolled-flow timer/due-work scheduling with workflow execution; keep census/discovery for missing or late obligations and all adapter checks | Use bounded due-work scheduling; keep census/discovery and all adapter checks |
| Stable binding, desired/observed state, UID/label checks, clone consumers and retirement tombstones | Keep. Neither timeout nor cancellation proves a creator/consumer stopped | Keep; expiring SQL claims are equally insufficient |
| [Build/resource guard](../../src/services/build-retention-guard.js) | Retain initially in worker; later separate resource exclusion from kpack retention only after replacement tests | Same |
| Debugging / compatible deployment | Service history/replay replaces custom execution replay; keep causal domain journals and external observations | Maintain execution journal/checkpoint atomicity and version dispatch; no automatic history replay |

This inventory concerns the migrated lane. Legacy runs retain their current owners
until drained. Existing best-effort `checkRuns.record()` permits work without a
recoverable manifest; the new lane must refuse to launch until required intent
and identifiers are persisted. Temporal does not make that launch policy strict.

## Contract and remaining implementation work

**Authority and identity.** PostgreSQL remains the source of lifecycle permission.
One flow/attempt identifies domain work and mutable resources; Temporal workflow
ID is `c0-<flowId>` in this experiment, with service run/activity/attempt IDs used
only for execution tracing. B2 prevents caught mapping failures from committing.
An activity retry cannot grant itself a new head, activation or cleanup permission.
Workflow state must not become a second authoritative proposal status machine.

**External safety.** Both implementations provide retryable execution, not
exactly-once external creation. Persist intent before I/O, adopt by identity,
conditionally mutate shared bindings, report through the domain guard, and retain
uncertain cleanup obligations. Cancellation first revokes permission through a
domain action, then requests execution cancellation. The fixture exercises a
creator that outlives its worker; neither backend forcibly terminates that creator.
Activity cancellation needs explicit cooperation from adapters. [Temporal heartbeat and cancellation](https://docs.temporal.io/develop/typescript/activities/timeouts).

**Clones and capture.** The fixture proves encrypted credential recovery and a
complete/partial marker protocol; actual role ownership, redaction, fixtures,
consumer termination and clone retry safety remain to implement/test. Capture
must name the flow, generation, SHA, immutable image, exact candidate/clone and
check run, plus the applicable edge configuration. An attempt-specific capture
route/proxy must keep the original host/origin, platform asset paths, access gate,
cookies and WebSockets while pinning the candidate. Self-app assets come from its
revision. Separately label backend and public-edge results if they use different
routes; a direct-backend pass does not validate the public edge. The experiment
records candidate/SHA/attempt/host on its fake check Job, but does not test these
HTTP/TLS/access properties. Live Docker and Kubernetes validation remains C/D.

**Execution policy and retention.** Short test timing is not production policy:
local lease 800ms/heartbeat 100ms, retry 300ms, phase delay 100ms; Temporal activity
6s/heartbeat timeout 1s, retry 100ms–1s, sticky fallback 500ms, pending/retirement
sleep 100ms. Temporal crash cases sometimes took roughly 12 seconds despite the
one-second activity heartbeat timeout; these settings are not an end-to-end
recovery deadline. Workflow task recovery, worker capacity and cache handling
also need operational tuning. Both prototypes retain retirement indefinitely
and retry without a cap. Production needs transient/permanent error classification, observable blocked
states, escalation, sensible backoff, orphan census, retained manifests and
consumer/creator termination evidence. Temporal retirement requires bounded
history (for example Continue-As-New) and compatible version handling. Never
compact on absence alone or silently abandon an unresolved obligation at a retry
limit. The bounded prototype's checkpoint/event writes are separate; it does not
prove an atomic complete execution journal. Temporal history also does not replace
application-specific resource observations or atomic domain journals.

**Deployment.** The test uses explicit v1/v2 queues/workflow types and a real
history replay; it does not test Temporal Worker Deployment Versioning. Choose a
supported pinning/patching strategy and replay representative active histories
before changing orchestration. Keep compatible activity input/output mappings and
old workers until their obligations drain. The bounded option needs the same
version-dispatch discipline. [Temporal versioning](https://docs.temporal.io/develop/typescript/workflows/versioning).

## Contained adoption plan

1. Reconcile canonical main, preserve its shots/retry changes, and implement real
   inspect/adopt service steps plus strict PostgreSQL outbox admission. Keep B2's
   reusable decision foundation and second workflow; neither is replaced by C0.
2. Select managed or self-hosted Temporal operation explicitly. Define namespace,
   authenticated/TLS connections, execution-store availability/backup/retention,
   workflow payload protection, monitoring and compatible worker deployment.
   Dev-server SQLite is evidence storage, not the production backend. A separate
   storage/availability dependency is the largest cost compared with the local
   alternative; production service failover/load/cost are not demonstrated here.
3. Add a separately supervised execution Deployment/entry point in
   `deploy/helm/social-vibecoding-platform/`. Current chart deploys the HTTP platform
   with `social-platform-runtime`; infra's foundation chart binds that account to
   builds/apps/workers privileges. Give the execution worker a deliberate account
   with required build/Job/runtime/Ingress read-mutate-delete permissions, database
   clone privileges, encrypted-credential key, registry access and appropriate
   network/storage access. Keep build and generated-app identities separate. Update
   infra RoleBindings/values, network policies, resource/connection budgets,
   readiness/drain/rollout and Temporal credentials together; none changed here.
4. Enroll one native-preview lane using a persisted backend/contract version.
   Atomically create its work handoff; exclude enrolled identities from legacy
   launcher, harvester and cleanup scheduling. One execution/adoption/cleanup
   authority may reconcile a flow. A census can discover/submit an obligation,
   but must not concurrently execute it outside that owner. Drain legacy work;
   rollback preserves enrolled work with its worker rather than giving it to
   an incompatible owner. Keep the resource guard until live replacement proofs.
5. Repeat failure-path tests against actual clones, Kubernetes Jobs and Docker
   runtimes, public capture routes and worker rollouts. Then demonstrate shared
   fair execution/retry across a distinct workflow before broader migration.

**Decision boundary:** C0 supports selecting Temporal for the next contained
implementation. It does not establish production external fencing, full check
settlement atomicity, a live capture contract or shared execution across multiple
workflows. Those remain explicit C/D/E gates, with existing protections retained.
