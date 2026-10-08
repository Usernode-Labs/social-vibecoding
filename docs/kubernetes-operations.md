# Kubernetes runtime operations

Use this runbook when `APP_RUNTIME=kubernetes`. The standalone Compose and
host-deployer instructions in `README.md` and `SELF-HOSTING.md` describe the
Docker installation. Kubernetes platform, worker, and capture images have no
Docker daemon or socket. Talos workloads are observed through Kubernetes APIs.

## Ownership and releases

The `Build Kubernetes images` workflow resolves the current Claude Code
version once, builds the platform Dockerfile in CI, builds or reuses
worker/capture images by their tracked build inputs, and publishes one OCI
Helm chart containing all three image digests. `main` produces the stable
`0.1.*` releases tracked by Argo CD. The platform's own release uses this
workflow; generated child apps use kpack and Paketo from exact Git revisions.
Child-app Dockerfiles are not executed by kpack.

The platform image build receives the exact `GIT_SHA` that the chart supplies
at runtime. Before packaging a chart, CI runs the immutable platform image's
shell-release validator with that revision and `NODE_ENV=production`, without
network access or application startup. Missing or inconsistent generated shell
artifacts block the release, including scheduled releases that reuse an image.
An image built with the default `dev` stamp cannot pass this check; rebuild it
with the intended commit SHA rather than changing the runtime revision.

The daily dependency check is intentionally cheaper than a source release. It
looks up the exact worker input key for the current npm version and exits after
the planning job when that artifact already exists: no image jobs run and no
new chart is published. When the version changes, it reuses the platform image
for the exact current `main` revision and the capture image for its tracked
inputs, builds only the worker, and packages those three immutable digests into
a new atomic release. Missing platform or capture artifacts fail closed and
require the normal `main` workflow; the scheduled path never rebuilds them as
an incidental side effect.

Every stable release restarts the platform, and each restart re-runs the
checks of every proposal in flight and interrupts the bot's builds. The
workflow runs one push to `main` at a time, and its "Check branch tip before
publishing" step decides which runs publish:

- **Spacing.** A stable release goes out no sooner than
  `RELEASE_MIN_GAP_MINUTES` (10) after the previous one. The gap is timed
  from the end of the run that published the previous release, which is when
  Argo CD was asked to roll it out.
- **The tip run waits.** The run for `main`'s tip waits inside that step for
  the rest of the gap, then publishes. A newer merge landing during the wait
  ends it: the waiting run skips, and the newer merge's run, queued behind it,
  publishes once built. The newest merge is always released.
- **Runs behind the tip** publish only when the newest release's revision
  merged at least `RELEASE_EVERY_MINUTES` (15) before theirs, and they skip
  inside the gap.

On 7 October 2026 the platform rolled out four times in sixteen minutes
(21:41:57 to 21:57:49 UTC) while approved proposals merged one after another;
that is what the gap prevents.

If the age of the previous release cannot be read, the run publishes as it
did before the gap existed. Feature-branch candidates never wait.

**To release at once, for example an urgent fix,** run the workflow on
`main` by hand:

```bash
gh workflow run build-kubernetes-images.yml --ref main
```

A dispatched run never waits. A run that is waiting when the dispatched run
is queued behind it skips in its favour, so `main` goes out as soon as the
dispatched run has built, with one restart.

Argo owns the platform Deployment, database, namespaces, service accounts and
runtime permissions. The platform owns generated apps, previews, workers and
check Jobs. Keep each change with its owner; source commits do not themselves
change the cluster. Review the normal release/GitOps diff before deployment.

Argo notices a published chart by re-reading the registry's tag list on its
reconcile interval, up to three minutes after the push. When the repository
secret `ARGOCD_REFRESH_TOKEN` is set, the release job's "Ask Argo CD to pick up
the release now" step follows a stable `helm push` with
`GET /api/v1/applications/social-vibecoding-platform?refresh=hard`, so the
comparison — and the automated sync behind it — starts at once. The token is
an Argo CD project-role token that can only `get` that one Application; the
role, the mint procedure and rotation live in the infra repository's
`docs/22-social-vibecoding-runtime-operations.md`. The step is best effort:
unset, it skips; a rejected or timed-out call posts a warning on the run and
the release lands on the periodic reconcile as before. It cannot fail the run,
because `release-watch` reads the run's conclusion and would otherwise report
a healthy release as stalled.

A merged platform PR is therefore "merged" on its card before it is running,
and nothing in that chain reports back to the platform when a link fails. The
platform watches the gap itself: `services/release-watch.js` compares the
self-hosted app row's `main_sha` (the running build) with GitHub's `main` on the
drift poller's cadence, reads the `Build Kubernetes images` run for the merged
commit, and once (per commit and verdict) records the stall on
`apps.release_stall`, posts to the app's group chat, and notifies the app's
admins. The Dev board shows an amber banner with the workflow run linked until
the running build catches up. A red run is reported at once; a run still going,
a run that succeeded without a rollout, or no run at all is reported after
`RELEASE_GRACE_MS` (default ten minutes). The workflow runs one push at a time,
so after a burst of merges the newest one's run waits for the others. The
tip's run may also wait out the release gap above. So a run that has not
finished is reported only once no run of the workflow on `main` has finished
for the grace plus `RELEASE_MIN_GAP_MINUTES`. A run that succeeded gives the
rollout its own grace from when it finished. Re-running the failed workflow
jobs, or the next merge, releases the commit; a build that already carries the recorded commit
reads as resolved at once, and the poller clears the record on the new build's
first tick at `main`. A token without `actions:read` degrades to the time-based
verdict rather than failing.

Nothing in that chain tells open browser tabs about the new build either; the
Pod being replaced does. The rolling update terminates the old Pod only after
the new one has been Ready for `minReadySeconds`, and the `preStop` sleep has
taken it out of the Service before `SIGTERM` arrives. On `SIGTERM`, `server.js`
`cleanup()` closes the listener, then reads the Deployment's target revision
through `services/deploy-status.js` and, if it is another build, pushes
`platform_version` to every open `/ws/events` socket
(`ws.pushPlatformVersion`). Every events handshake carries the same message
with the build the socket landed on. A tab prefetches the announced build into
its service-worker cache and turns the Settings version row into the reload
button (`handlePlatformVersion` in `public/js/app.js`); it never reloads
itself — the user does, from that button or a pull-to-refresh. The 10s
`/api/version` poll paints the rollout in progress and remains the fallback. A
`SIGTERM` for any other reason finds the target equal to the running build and
announces nothing.

When a stable release changes `KUBERNETES_WORKER_IMAGE`, an existing warm
worker is compared with that immutable digest before its next dispatch. An
idle worker on the old digest is recreated while its per-session PVC is kept,
so Claude's on-disk session state survives. An in-flight turn is never
interrupted for an image refresh; replacement is deferred until a later safe
dispatch. This makes the new worker image effective without a manual fleet
restart, while avoiding a rollout that kills paid work already in progress.

See the [platform chart](../deploy/helm/social-vibecoding-platform/README.md)
for configuration and the `infra/prototype/bare-metal-platform` runbooks for
cluster foundation and database operations. Read the installed image and Argo
revision when comparing source behavior with a live failure.

## Shared app and preview TLS

Generated apps and previews share the installation-owned TLS Secret named by
`APP_TLS_SECRET_NAME` (default `social-apps-wildcard-tls`) in `APP_NAMESPACE`.
Provision a trusted wildcard covering `*.USERNODE_APPS_DOMAIN` before deploying
this runtime version. The foundation chart owns its Certificate and DNS-01
renewal. App Ingresses have no certificate issuer annotation; ordinary preview
rebuilds, failed-start cleanup and idle teardown neither request certificates
nor delete TLS Secrets. An installation can also supply an existing wildcard
Secret with the same ownership and coverage contract.

This is a rollout prerequisite, not an optional per-host fallback. Deploying
the runtime before the Secret is ready can leave new/rebuilt previews without
working HTTPS even when their Pods are Ready. Existing Ingresses keep their old
TLS references until reconciled or migrated. The infra runbook
`docs/23-social-vibecoding-shared-tls.md` includes a read-only migration planner,
issuance-limit recovery and explicit retirement of legacy Certificates.

## Before/after shots cleanup

Shots recovery retries resource cleanup for every terminal run outcome, including
superseded cancellations and stale runs. It removes current and legacy base/head
environments, their disposable databases, and hosted screenshot fixture apps.
The two-minute recovery poll handles at most 20 terminal cleanup retries, after
a five-minute grace period. Failed attempts remain pending and move behind runs
that have not been attempted, so an API outage cannot strand the rest of the queue.

`trace_summary.cleanupComplete` is trusted only with the current
`cleanupVersion` (2). Earlier versions omitted hosted fixture runtimes; these rows
are rechecked automatically. Run metadata is retained until cleanup succeeds.
A successful capture can still publish its shots with cleanup pending.

At startup and every six hours, the retention sweep also checks Kubernetes
Deployments against their shots/evidence run labels, exact runtime names and run
state. It removes up to 100 abandoned runtimes per pass, including those whose run
rows disappeared with a deleted session. It leaves nonterminal runs and resources
younger than 45 minutes alone. Ordinary apps and proposal previews are excluded.
The synthetic hosted fixture app id is `2147482999`; its `production` environment
label does not mean that it is a user's deployed app.

Recovery logs report `cleanupRetried`; retention logs additionally report
`orphanRuntimesExamined`, `orphanRuntimesRemoved` and `orphanRuntimeFailures`.
Kubernetes or database read failures abort inventory cleanup without deletion.
No separate manual cleanup is required for the historical fixture backlog after
deploying this change; use the normal platform image/chart release path.

## HTTP keep-alive ordering

The platform server (including self-previews) and newly scaffolded Node apps
set `server.keepAliveTimeout` to 75 seconds. This gives the ingress's 60-second
upstream idle timeout a 15-second margin to retire unused connections before
Node closes them. Preserve this ordering if the ingress timeout changes.
Node's default keep-alive buffer remains in effect; request and header timeouts
are separate and unchanged.

The platform setting takes effect when the updated server is deployed. Existing
child-app repositories and previews built from older commits retain their own
server code; changing the scaffold does not retrofit them.

## Coordinated preview lifecycle

`platform.previewLifecycleEnabled` (default `false`) sets
`PREVIEW_LIFECYCLE_ENABLED`. With it enabled, builds, captures and teardown share
one PostgreSQL advisory lock per session, across platform Pods. A durable
`preview_operations` row records the desired revision, run UUID, phase and
outcome. Advancing the session's checks/imported head cancels the old owner;
the successor waits for its capture and unit-suite consumers to stop before
changing the preview. Cancellation is not an app test failure.

Capture and unit-suite Jobs carry `social.usernode.io/preview-run-id`. The owner
requests foreground deletion and confirms Job/Pod termination. API errors keep
replacement blocked; a DELETE acknowledgement alone does not establish that
the browser stopped. After a platform restart, a successor for a NEWER revision
stops orphaned check Jobs before using the preview; a run for the revision the
session is still waiting on is harvested instead (below).

## Preview cleanup

Merge, archive and the idle reclaim (`STAGING_IDLE_TEARDOWN_MS`) tear a preview
down through its session row. Anything those paths leave behind is found by the
stale-preview sweep (`services/staging-reap.js`), which lists the
`sv-preview-<appId>-s<sessionId>` Deployments in the app namespace and joins
them back to `chat_sessions`. Every `STAGING_STALE_SWEEP_INTERVAL_MS` (15 min)
it tears down at most `STAGING_STALE_SWEEP_LIMIT` (10) previews whose session
merged, was archived or no longer exists, or whose `usernode.env.fp` label is
out of date. It never takes a preview backing a live vote (`promoted` or
`merging`); the heal pass rebuilds those in place when they go out of date.
Admin → Stale previews takes the same selection without the per-pass limit. A
preview whose row no longer names it keeps its staging database until the
orphan database pass (`STAGING_ORPHAN_DB_SWEEP_INTERVAL_MS`, 6 h) finds nothing
connected to it.

## Harvesting check runs across platform rollouts

Every merge to the self-app rolls the platform Deployment, and every checks
run in flight at that moment loses the process that was streaming its capture
and unit-suite Jobs. The Jobs themselves belong to the cluster and finish
regardless. `services/check-harvest.js` reads them rather than starting over.

Each run writes a manifest row to `check_runs` (session, commit, owner
`hostname:pid`, launch context) before its Jobs are created and heartbeats it
every `CHECK_RUN_HEARTBEAT_MS` (15s). A row with no heartbeat for
`CHECK_RUN_ORPHAN_MS` (60s) is an orphan. The leader sweeps once at boot —
before the stuck-checks reconcile, so a harvestable run is never re-driven as
stuck — and every `CHECK_HARVEST_SWEEP_MS` (30s) after, at most
`CHECK_HARVEST_CONCURRENCY` (3) adoptions at a time. An orphan is:

- **settled** when its Jobs are found by the `preview-run-id` label: a finished
  Job's log is read, a running one is waited on with progress re-published to
  the proposal card, and the output goes through the same settlement a live
  run ends with (same parse, verdict, stores, commit guards, broadcasts);
- **re-driven immediately** when there is nothing to read — the process died
  before creating the Jobs, or the Jobs are gone (TTL, or cancelled);
- **moot** when the session no longer wants the run — decided meanwhile, head
  moved, session closed, or (under the preview lifecycle) a newer run owns it.

A platform process that shuts down hands its rows over first: it stamps
their heartbeat as long past, so the next leader's boot sweep seats them at
once instead of a minute later. A run whose process died without doing so is
still covered: before the stale sweep starts a session over, it looks for that
session's current run on the cluster. If the capture Job is still running, or
the run finished less than `CHECKS_STALE_MS` ago, the harvest settles it
instead. A run that starts stops the still-running Jobs of the session's runs
for other commits (background deletion; their input Secrets go with them).
Runs for the same commit are left to finish, because their verdict still
counts.

The paths that start a run ask the same question first (`runToCollect`): a
manual "Re-run checks" (or `recheck_change`), a promote or vote-time kick, a
recheck that would rebuild the preview, the sweeper's preview heal, boot
recovery, and every capture under the preview lifecycle. While the session
still waits on that commit's verdict and its run is on the cluster, nothing new
starts; the button and the tool say the run is still going. Once the verdict is
stored the manifest is gone and a re-run starts fresh. Only a run whose inputs
changed (new capture routes or shots for the same commit) replaces it.

Under `PREVIEW_LIFECYCLE_ENABLED` the harvester adopts the run's
`preview_operations` row first and writes through the same ownership check a
live run does; a request for a newer revision aborts the harvest. A capture
for the same revision finds the run under the lifecycle lock and leaves it:
it cancels only other commits' check Jobs and does not take the row. A build,
or a forced capture, still cancels every check Job of the session. Outside the
Kubernetes capture runtime the harvester is a no-op. The stale sweep
(`CHECKS_STALE_MS`) remains the backstop for rows with no manifest at all.

Every capture rechecks the exact deployed revision, image, environment
fingerprint, completed rollout, application health and public edge before
starting. Check results and screenshot transactions verify the current run and
revision under a session row lock. Newer revisions cannot publish older output;
same-commit recovery after a rebuild can replace an infrastructure-error verdict.
Manual reruns, unit checks, browser checks, screenshots, PR visuals, progress and
automatic merging remain supported. Docker retains its existing lifecycle.

Kubernetes rebuilds reconcile the existing Ingress and Service instead of
deleting them first. This removes the missing-host TLS routing window, but does
not promise uninterrupted interactive previews during application/database
replacement. Already-started image builds and database preparation settle before
ownership passes; obsolete captures are cancelled explicitly. Build artifacts
remain subject to normal retention. This change does not add Envoy retries.

### Activation and rollback

Apply the additive schema migration with the release. **Do not use an ordinary
rolling flag change:** a flag-off Pod can bypass the coordinator even if it runs
the new binary. The chart defaults off to make this transition explicit.

1. Schedule a brief platform maintenance window and pause proposal mutations.
   Through the installation's GitOps owner, scale the platform to zero and
   confirm all platform Pods have terminated. Keep app previews and PostgreSQL
   running; do not delete the preview Ingresses.
2. With platform replicas still zero, set `platform.previewLifecycleEnabled: true`
   and select the coordinator-capable release. Confirm the schema hook succeeded.
3. Restore the normal replica count and resume mutations. Verify a new revision
   supersedes an active capture, both old check Jobs stop, and the new run
   produces checks/screenshots for its own revision. Further releases may roll
   normally while every participating Pod keeps coordination enabled.

Rollback across this boundary uses the same stop-all-platform-Pods procedure.
Before starting a flag-off/older release, terminate outstanding capture and
unit-suite Jobs and confirm their Pods have stopped. Retain the additive table.
The mixed-mode restriction also applies to manually started platform processes.

For local validation, `tests/preview-lifecycle.test.js` uses independent real
PostgreSQL connections and an isolated temporary schema. Set
`PREVIEW_LIFECYCLE_TEST_DATABASE_URL` to a disposable test database, or use the
existing `SQL_CHECK_CONNECTION_URL` supplied by the unit runner. It never falls
back to the application's `DATABASE_URL`. Kubernetes termination and cancellation
are covered by `tests/kubernetes-preview-cancellation.test.js` with API doubles.

## Check Jobs, their input Secrets and the worker quota

A checks run creates a capture Job and a unit-suite Job in the worker namespace,
each with an input Secret the Job owns. Once the run's verdict is stored and
its `check_runs` manifest cleared, the run deletes its finished Jobs with
background propagation, which takes their Pods and Secrets too; the harvester
does the same after settling an orphan. The Jobs' `ttlSecondsAfterFinished`
(3600 s) covers everything else: superseded or failed runs, the main-watch
suite, and whatever a crash leaves. Keep it at least that long, because it is
how late a harvest can still read a run after a slow leader handover.

`services/check-retention.js` removes what no owner will. On the leader, every
15 minutes and at most 50 deletions a pass, it deletes:

- check input Secrets (`sv-capture-…-input`, `sv-unit-suite-…-input`) with no
  owner, older than two hours, that no Pod or Job in the namespace names;
- finished check Pods whose Job is gone, finished at least the Job TTL ago.

It never touches a worker's `-env` Secret or anything with an owner. It needs
`list` on Secrets and `delete` on Pods in the worker namespace, which nothing
else in the platform uses; the foundation owns those grants. Without them each
pass logs `Check leftover sweep stopped` and deletes nothing.

The namespace's ResourceQuota counts Secrets and Jobs as well as CPU. Size
`secrets` and `count/jobs.batch` for bursts of concurrent runs on top of the
worker env Secrets; they are object counts, so headroom costs nothing.

## Workflow governance machine

`platform.workflowGovernanceEnabled` (default `false`) becomes `WF_GOVERNANCE_ENABLED`.
When it is on, the governance-proposal machine in `src/workflow/` decides governance
proposals. The governance-apply ticker and the stale sweeper's Pass 0b then leave those
proposals alone. `docs/workflows.md` explains the machine and where it runs.

- **Where it runs.** The machine's decisions run inside the platform Pods: every Pod
  listens for outcomes and runs pipeline slots, so it applies its own votes. The
  timer and service loops and the boot backfill run on the advisory-lock leader, or
  in the workflow worker when it is deployed (see "Workflow worker" below).
- **Schema.** The schema it needs (`wf_*` tables and triggers) is additive and ships
  with every release, whether the flag is on or off.

### Activation and rollback

Unlike the coordinated preview lifecycle, an ordinary rolling change is safe in both
directions. No maintenance window or scale-to-zero is needed.

1. **Set the value.** Set `platform.workflowGovernanceEnabled: true` in the platform's
   values in the infra repository. Argo CD rolls the Deployment with the same image.
2. **During the rollout overlap.**
   - The old Pod may still be the leader and apply proposals the old way.
   - The machine and the old apply functions both lock the proposal's row, so
     whichever commits first applies it. The machine ends the other's instance
     `superseded` (`closed_outside`).
   - The new Pod applies its own votes and withdrawals at once: its pipeline slots run
     before it is leader. Only what the leader's loops do (timers, follow-up work, and
     enrolling proposals opened before the flag) waits until it is elected. A route on
     a proposal not enrolled yet enrolls it itself.
3. **Verify.**
   - **The new Pod's log.** It shows `Workflow runtime started` and, on the leader,
     `Enrolled open governance proposals` with a count.
   - **Admin → Workflows.** It lists the enrolled proposals, and its problems panel
     is empty.
   - **Votes.** A vote on a test proposal answers at once.
4. **Watch for old writers.** In production the ownership trigger logs instead of
   refusing (`WF_OWNERSHIP_MODE` defaults to `log`). Over the following days, the
   problems panel in Admin → Workflows should show no "written outside its machine"
   line. One lists the column, how often, and its latest writes: the row, the
   connection's `application_name` and the statement, which name the code path that
   still writes a governance proposal outside the machine (`wf_ownership_violations`).

**Rollback.** Set the value back to `false` and let Argo CD roll the Deployment.
- **What happens to the proposals.** The old paths decide them again. The trigger
  stops guarding them as soon as the new Pods record the flag off.
- **Turning it on again later is safe.** A proposal decided or deleted in the
  meantime ends its instance without being applied twice.

## Workflow merge-followups machine

`platform.workflowMergeFollowupsEnabled` (default `false`) becomes
`WF_MERGE_FOLLOWUPS_ENABLED`. When it is on, what follows a merge (production delivery,
preview teardown, included changes, closing requests, the announcements) is durable work
of the merge-followups machine, and a change reads live only once production runs it.
`merge-followup-recovery` and the boot resume of issue-close watches stand down.
`docs/workflows.md` explains the machine.

### Activation and rollback

An ordinary rolling change, safe in both directions.

1. **Set the value.** Set `platform.workflowMergeFollowupsEnabled: true` in the
   platform's values in the infra repository. Argo CD rolls the Deployment.
2. **During the rollout overlap.**
   - An old Pod may still merge the old way. Once a new Pod has recorded the flag, the
     ownership trigger logs such an old merge in `wf_ownership_violations`, which is
     `log` mode in production. The old merge tail then runs as before.
   - A merge on a new Pod is reported to the machine and finished by the leader's loops.
3. **Verify.**
   - **The new Pod's log.** It shows `Workflow runtime started` with `merge-followups`.
   - **Admin → Workflows.** The next merge appears as `merge-followups / session:<id>`
     and reaches `live`, and its problems panel is empty.
   - **The proposal's thread.** It says "is live" after the deploy, not before.

**Rollback.** Set the value back to `false`.
- **New merges** take the old tail again.
- **Merges the machine already accepted** still finish: the runtime keeps running while
  they have work left, and stops on a later boot once nothing is left.

## Workflow worker

`workflow.worker.enabled` (default `false`) deploys `social-vibecoding-workflow`: the
platform image running `node workflow-worker.js`. It runs the workflow runtime's work
items (deploys, GitHub calls, retirements) and timers, so they no longer share the web
Pod's memory, CPU and `/tmp`. The web Pods get `WF_LOOPS=worker` and keep the pipeline
slots, so decisions, projections and the post-commit pushes stay where they were.
`docs/workflows.md` ("Running it") explains the split.

- **What it shares.** The platform's image, environment, ServiceAccount
  (`social-platform-runtime`, so the CNPG client policy admits it) and network
  policies. It has no Service and no readiness probe; `/health` on 8081 is for the
  kubelet.
- **What is its own.** `workflow.worker.resources` (requests 500m and 1Gi, limits 2 CPU
  and 3Gi), `tmpSizeLimit` (4Gi) and `dbPoolMax` (10, beside its `WF_POOL_MAX` pool).
- **Quota.** During its own rollout it adds 1 CPU of requests (two Pods at 500m) to
  the platform namespace, beside two platform Pods at 2 CPUs and the migration Job.
  Check the namespace's `requests.cpu` headroom (`kubectl -n social-platform describe
  resourcequota`) before turning it on.
- **It does nothing until a workflow flag is on.** With every flag off it starts,
  reports healthy and idles.

### Activation and rollback

An ordinary rolling change, safe in both directions.

1. **Set the value.** Set `workflow.worker.enabled: true` in the platform's values in
   the infra repository. Argo CD creates the worker and rolls the web Pods.
2. **During the rollout overlap.** The old leader may still run the loops while the
   worker runs its own. Both claim work safely (leased row locks); the same item never
   runs twice at once.
3. **Verify.**
   - **The worker's log.** It shows `Workflow worker started` (and `Workflow runtime
     started` while a flag is on).
   - **The web Pods' logs.** No `Enrolled open governance proposals` from them after
     the rollout: the worker enrolls.
   - **Admin → Workflows.** New work attempts name the worker's Pod as their service,
     and the problems panel lists no overdue work.
4. **Watch it.** If the worker stops while the web Pods are healthy, votes and merges
   are still recorded and decided, but their follow-up work and timers wait. Alert on
   the worker's restarts and on work overdue by more than a few minutes.

**Rollback.** Set the value back to `false`. The worker is deleted and the web Pods
lose `WF_LOOPS=worker`, so the leader runs the loops again. Work the worker was running
is resumed from its checkpoint once its lease lapses.

## Read-only inventory and logs

These examples use the organization namespace and Deployment names. Substitute
the configured names for another installation. Resource names come from API
inventory; a Docker container ID or old single-server name is not a Pod name.

```sh
kubectl -n social-platform get deployment social-vibecoding
kubectl -n social-platform logs deployment/social-vibecoding -c platform --tail=200
kubectl -n social-apps get deployments,pods,services,ingresses
kubectl -n social-workers get deployments,pods,jobs,pvc
kubectl -n social-builds get builds.kpack.io,pods
kubectl -n social-builds get resourcequota
```

For one preview or worker, select `social.usernode.io/session-id=<session id>`.
For one application, select `social.usernode.io/app-id=<app id>`. For example:

```sh
kubectl -n social-workers get pods -l social.usernode.io/session-id=42
kubectl -n social-apps get pods -l social.usernode.io/session-id=42
```

Once the inventory gives the actual Pod name:

```sh
kubectl -n social-apps logs POD_NAME -c app --tail=200
kubectl -n social-apps logs POD_NAME -c app --previous --tail=200
kubectl -n social-workers logs WORKER_POD_NAME -c worker --tail=200
kubectl -n social-workers describe pod WORKER_POD_NAME
```

`--previous` reads the preceding container incarnation in that Pod; it cannot
recover an already deleted Pod. Inspect current and previous termination
reasons, restart counts, scheduling conditions and readiness together. An old
ready replica can still serve while the desired image is failing to start.
ResourceQuota reports reservations and object counts, not measured CPU or
memory consumption. Do not substitute Docker host statistics for cluster usage.

Capture Jobs default to an 8-CPU / 6Gi limit for sixteen concurrent browser
groups, with 4 CPUs / 3Gi requested. The foundation worker LimitRange must allow
at least 8 CPUs and 6Gi per container. `CAPTURE_CPUS`, `CAPTURE_MEMORY` and
`TEST_CONCURRENCY` override these settings on the platform. Memory is the bound
on the pool — budget roughly 150 MiB per concurrent page plus 1 GiB for the
browser — since the capture browser composites in software (Skia, not a
SwiftShader GPU process) and a page load costs well under a CPU-second. CPU
requests are scheduling reservations, so the larger limit allows bursts but
does not guarantee eight idle cores. Check historical CPU throttling as well as
completion: a successful Job can still produce timing-sensitive assertion
failures under CPU contention. Unit-suite Jobs default to 8 CPUs / 4Gi (the CPU
quota sets `node --test`'s process-pool size), requesting 4 CPUs / 1Gi.
Evidence replays share the capture reservation. A smaller explicit CPU limit
also caps the request; coding-worker resource settings are independent.

All three check kinds carry `social.usernode.io/workload=check`. A hostname
topology-spread preference counts that group across sessions in the worker
namespace, honoring node affinity and taints. It favors an even distribution
but permits imbalance when available node capacity requires it. CPU requests
control admission and CPU share under contention; burst limits are unchanged.
Existing Jobs keep their requests and placement until completion. Raise the
worker namespace CPU-request quota before deploying this runtime if its old
budget would prevent the intended check concurrency. Reserve platform CPU
separately through the installation's `platform.resources.requests.cpu`, with
namespace quota headroom for rolling-update overlap and migration.

Self-app previews (`USERNODE_ENV=staging`) do not build worker images, inspect
Docker or Kubernetes workloads, or read the parent's deployment status. Their
status API reports `runtimeKind: preview` and `runtimeAvailable: false`; fleet
counters are null and the UI labels runtime status unavailable. Cloned app and
session rows do not establish live workload readiness. Preview isolation does
not require forwarding runtime credentials or a Kubernetes service-account token.

The authorized `usernode-debug containers` and `usernode-debug logs <name>`
interfaces accept managed runtime names such as `sv-worker-s42` and
`sv-preview-7-s42`. Their inventory includes readiness but leaves CPU/memory
usage null when measured usage is unavailable.

## Build and startup failures

Find the kpack lifecycle Pod through the Build's `status.podName`, then inspect
the init-container names and logs for the failing phase:

```sh
kubectl -n social-builds get build BUILD_NAME -o jsonpath='{.status.podName}{"\n"}'
kubectl -n social-builds get pod BUILD_POD_NAME -o jsonpath='{.spec.initContainers[*].name}{"\n"}'
kubectl -n social-builds logs BUILD_POD_NAME -c build --tail=200
```

The runtime captures bounded, redacted build and preview failure logs before
cleanup. Once the Pod is deleted, use the persisted build/check failure and
platform diagnostic log. Retention and its read-only preview are documented in
[kpack Build retention](kpack-build-retention.md). Build diagnostics need `get`
on `pods` and `pods/log` in `social-builds`; the foundation owns those grants.

Worker setup reports clone/checkout phases before readiness. A fatal setup
marker, scheduling problem or admission failure is a bootstrap failure, before
agent dispatch. Worker readiness requires the container-local bootstrap marker;
Deployment availability by itself is not enough. Turn OOM attribution uses Pod
termination evidence from the current turn, including a container restart.

Database connection exhaustion is an infrastructure error, not a failing app
diff. Check the configured database Service and namespace. The cluster runtime
uses networked PostgreSQL clients; do not run `docker exec usernode-db` on a
cluster node or assume the historical standby is the active writer.

## Platform deployment reporting

`/api/version` and admin status observe the platform Deployment. The chart
grants only `get` on that Deployment. Rollout, failed, paused and unavailable
states are distinct; API failure is not reported as an idle, healthy rollout.
The response's `scope: rollout` excludes image build and chart publication.
Use the source repository's `Build Kubernetes images` workflow for those stages
and Argo CD for chart sync/migration-hook failures before a Deployment update.

Self-app merges trigger the normal GitHub workflow. The cluster does not use
the host's `deploy-status.json`, deploy-nudge file, systemd poller, Caddy reload
or Compose blue/green scripts. Rollback is a reviewed GitOps/image revision
change; the single-server `rollback.sh` is not a cluster rollback mechanism.

## App-host gate

Cilium's Envoy has no forward-auth hook, so on this runtime nothing
platform-owned sat in front of app and preview hosts: a view-private app was
gated only by its own code, and an app opened at its own address could not
sign anyone in. `APP_GATE=on` (chart `config.appGate`) puts a small proxy in
front of every managed app and preview Ingress: the `usernode-app-gate`
Deployment in the app namespace (two replicas, `maxUnavailable: 0`, the
platform's own image running `scripts/app-gate.js`). It asks the platform's
`/__caddy/access` about each request, exactly as Caddy does on the standalone
deployment, and proxies what is allowed to the app's Service. The three asset
prefixes keep going straight to `usernode-platform-assets`.

The gate holds no keys and reads no database. It fails closed: if the platform
cannot be asked for 15 seconds, the visitor gets 503.

Before turning it on:

1. The app namespace's network policy (foundation repository) must allow the
   ingress controller to reach pods labelled
   `app.kubernetes.io/name=usernode-app-gate` on 3000, those pods to reach
   generated app and preview pods on 3000, and those pods to reach the
   platform Service (`PLATFORM_INTERNAL_URL`). The platform's own policy
   already admits the app namespace (`networkPolicy.internalCallerNamespaces`).
2. `PLATFORM_INTERNAL_URL` must be set (the chart sets it from
   `config.internalUrl`).

Turning it on: set `config.appGate: "on"` and sync. The platform leader brings
the gate up, waits for it to be ready, and only then repoints every managed
Ingress's catch-all path at it. If the gate does not come up, no Ingress is
touched. New deploys follow the same rule.

Check: `kubectl -n social-apps get deploy usernode-app-gate`, then open a
private app's own address signed out (expect the platform's view of the app)
and signed in (expect the app, signed in).

Turning it off, the fallback: set `config.appGate: "off"` and sync. The
leader repoints every Ingress straight back to its own Service on boot. In an
incident, without waiting for a sync:

```sh
kubectl -n social-platform exec deploy/social-vibecoding -- node scripts/app-gate-switch.js off
```

This applies at once. Then set `config.appGate: "off"` too, or the next boot
or app deploy routes through the gate again. `config.appHostSignin: "off"`
(`APP_HOST_SIGNIN`) separately turns off signing people in at an app's own
address, on both runtimes; the gate still keeps private apps members-only.
