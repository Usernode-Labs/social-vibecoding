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
`cleanup()` reads the Deployment's target revision through
`services/deploy-status.js` and, if it is another build, pushes
`platform_version` to every open `/ws/events` socket
(`ws.pushPlatformVersion`), then closes the sockets so the tabs reconnect to
the new Pod. The replaced Pod then finishes the work it started before it
exits: see "Releases let work finish" below. Every events handshake carries the same message
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

## Releases let work finish

A platform Pod a release replaces keeps finishing the work it started rather
than cutting it (`docs/plans/draining-releases.md`), once another platform
process that records what it holds is serving (it waits up to a minute for
one; without one, as after a rollback to a release from before this, it cuts
over as it always did). On `SIGTERM` it:

1. refuses anything new and marks its row in `platform_processes` `draining`;
2. stops its leader work (the bot's loops, the bench lane, the eval runner,
   every sweeper and timer), quiesces the workflow runtime (no slot, timer or
   claim; its running work goes on) and resigns the leader lock, so the new
   Pod is promoted within a poll;
3. announces the new build to its tabs and closes their sockets;
4. keeps its listener open (a shots worker calls the Pod that runs its run by
   `POD_IP`) and waits until it holds nothing (`process_holds`), has no
   registered background work, no running workflow work and no request still
   answering;
5. then does what shutdown always did: closes the listener, ends the Mayor's
   turns still running, stops the workflow runtime (its work items are given
   up to the next claim), marks what is left interrupted, hands back checks
   runs, deletes its row and exits.

It waits at most `platform.drainMinutes` (`PLATFORM_DRAIN_TIMEOUT_MS`), and
ends early when `platform.drainingMax` (`PLATFORM_DRAINING_MAX`) newer Pods are
draining too. The log says what it is still finishing every minute
(`Still finishing work before exiting`), and how it ended: `Finished this
process's work`, or `Drain deadline passed` / `Newer processes are draining
too`, with what it handed over. What it hands over is adopted by the leader's
`orphan-turn-sweep` and `orphan-headless-sweep` within a minute or two, and by
the existing heartbeat sweeps for checks, shots runs, local-agent turns, the
Mayor's turns, app creation and owed redeploys.

The live processes and what each holds:

```sql
SELECT p.id, p.release, p.state, p.drain_deadline_at, h.kind, h.ref
  FROM platform_processes p LEFT JOIN process_holds h ON h.process_id = p.id
 WHERE p.heartbeat_at > NOW() - interval '45 seconds'
 ORDER BY p.started_at, h.kind, h.ref;
```

A schema change has to stay compatible with the code of the release before it
for as long as such a Pod drains, not only for the seconds of the overlap: the
migration Job applies the new schema while it still runs. A node drain
(`kubectl drain`) waits for a platform Pod's drain as well; pass
`--grace-period` to cut it short. Each draining Pod keeps its database pools
open until it exits, so with `drainingMax` 2 up to three Pods' pools are open
at once.

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

## Custom domains

A project's manager can serve it at a web address they own (#4405,
`services/app-domains.js`): they add a CNAME from `app.example.com` to
`<slug>.USERNODE_APPS_DOMAIN` and a TXT record `_homeroom.app.example.com`
carrying the claim's token, and the leader's sweep verifies both against
public resolvers every minute. Once verified, `deployCustomDomain`
(`services/kubernetes.js`) writes a second Ingress, `sv-domain-<id>`, beside
the app's own: the same asset prefixes and gate routing, the custom host, and
a `cert-manager.io/cluster-issuer` annotation naming `CLUSTER_ISSUER`
(default `letsencrypt-public`), the one place an app Ingress asks for a
certificate of its own. The certificate lands in `sv-domain-<id>-tls` in
`APP_NAMESPACE` and goes with the Ingress when the domain is removed,
disabled or the app is deleted.

Prerequisites: the ClusterIssuer must have an HTTP-01 solver for the apps'
ingress class (the platform host's own certificate is issued the same way),
port 80 must reach the ingress for the challenge, and the app namespace's
policy must let ingress-controller traffic reach cert-manager's solver pods
there. The app's own Ingress and the shared wildcard Secret are never touched
(`tests/kubernetes-app-tls.test.js`).

To take a domain out of service without touching the project, use Disable in
the admin console's Domains section (`#admin/domains`), which deletes the
Ingress and its Secret; Enable verifies the claim again from the start.

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

## Coordinated preview lifecycle (retired)

`PREVIEW_LIFECYCLE_ENABLED` and its per-session advisory lock are gone: the
preview machine (below) owns every build, checks run and teardown, one at a time
per session, as durable work. Its `preview_operations` table is dropped (a
rollback past the preview machine's deletion recreates it empty).

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

## A separate server for preview databases

By default one PostgreSQL server holds everything: the platform's database,
every app's production database, and every database a preview needs (each
app's redacted staging template, each preview's copy of it, and the copies
before & after shots are taken on). `STAGING_DB_ADMIN_URL` names a second
server for the preview side, so that the copies, the template rebuilds and
whatever previews write stop going through production's WAL, replicas and
archive. It is off unless set, and with it unset nothing changes.

What moves and what stays (`src/services/db-manager.js`, "Two servers"):

- On the preview server: staging templates (`app_<slug>_stgtmpl`), preview
  copies (`app_<slug>_staging_s<session>_<commit>`), shots copies and their
  frozen source (`…_shots_…`, `…_evsrc_…`), and the roles of all of them.
- On the main server, always: the platform's database, every app's production
  database, app forks, and the advisory locks. The redacted dump is still
  read from the main server; it is restored on the preview server, and both
  redaction passes run there and fail the build if they cannot finish.
- No table records which server a preview database is on. A drop runs on
  both servers by the database's exact name, and the sweeps list both. A
  preview built before the switch keeps working and is cleaned up on the main
  server. A preview connects with the address its container was given when it
  was built, and its runtime carries two labels written at deploy
  (`usernode.db.id`, `usernode.db.server`): a digest of the database it was
  given, as Postgres stores the name (its first 63 bytes), and the server it
  was made on. Those labels, not the session's number, are what the heal
  pass, the connection-pressure pass and the drain status judge by, because
  one proposal can have older copies on the other server.
- There is no fallback to the main server. If the preview server is down,
  preview builds fail as a platform fault and retry on the checks' own
  schedule; they do not move their full copies onto production.

### What the cluster has to provide

The chart does not create the server. It needs:

- **A PostgreSQL server that holds nothing else, with one instance.** No
  replicas and no backups or WAL archive: everything on it can be rebuilt
  from the main server.
- **PostgreSQL 18 or later** for shared-block copies. An older server works;
  it gets the plain copy, and the platform logs that once. The platform image's
  `pg_dump` and `pg_restore` (`postgresql-client` in `Dockerfile.kubernetes`,
  18 at the time of writing) must not be older than either server.
- **A data volume on a filesystem with reflink**: XFS made with `reflink=1`
  (check with `xfs_info <mount>`), or Btrfs. On Linux a copy on a filesystem
  without reflink does not fail: the kernel copies the files instead. The
  copy still skips the WAL but shares no blocks, and nothing the platform can
  query says which happened, so check the volume rather than the logs.
- **A superuser credential for the platform**, as `DB_ADMIN_URL` is on the
  main server: it creates and drops databases and roles, takes ownership of
  restored objects and ends sessions on its own disposable databases.
- **A maintenance database that exists**, named in the URL's path
  (`postgres` if the path is empty).
- **The same encoding, locale and collation provider as the main server.**
  This is yours to ensure: each copy is created from the preview server's own
  `template0`, nothing compares the two servers' settings, and a restore that
  succeeds proves nothing about them. A mismatch can change sort order and
  text comparison in previews without any error.
- **Every extension an app's database uses.** A missing one fails the
  restore, and with it that app's builds.
- **Network reach from two places.** From the platform Pods: the chart adds
  that egress rule (`previewPostgresql.namespace`, `podSelector`, `port`),
  and the server's own ingress policy has to admit them. From preview and
  shots Pods in the app namespace (`APP_NAMESPACE`): that namespace's egress
  policy is in the foundation, not in this repository, and the server's
  ingress has to admit Pods labelled
  `app.kubernetes.io/managed-by: social-vibecoding-runtime` from it. Until
  both are in place a preview builds and then cannot reach its database.
- **One address that resolves the same from both places.** A preview is
  handed the URL's host and port with its own role and password, so use the
  server's fully qualified Service name, not a Pod address. The URL it
  receives ends in `?sslmode=disable`: it connects without TLS, whatever its
  client's own default would have been.
- **Enough `max_connections` for the previews.** Each preview database is
  capped at `STAGING_DB_CONNECTION_LIMIT` (12). The connection-pressure pass
  reads the preview server's own budget and reclaims idle previews there at
  90% of it.

Lighter write settings are reasonable on a server whose contents can be
rebuilt: `synchronous_commit = off`, and `wal_level = minimal` with
`max_wal_senders = 0`, which CloudNativePG accepts only for a one-instance
cluster with archiving off. Whether the operator lets `fsync` be turned off
was not confirmed, and nothing here depends on it. The file-copy strategy
forces a checkpoint before and after every copy, which is why it is never
used on the main server.

With PostgreSQL 18 on the preview server and 17 on the main one, previews
and their checks run on a newer PostgreSQL than production does. That is a
known cost of the shared-block copy.

### Switching it on

1. Create the server and its credential, and open the two network paths.
2. Add `STAGING_DB_ADMIN_URL` to the platform Secret
   (`postgres://<user>:<password>@<host>:<port>/<maintenance database>`). It
   carries a password: keep it in the Secret, never in plaintext values.
   The host, port, user, password and database go in the address. The only
   query parameter accepted is `sslmode`; a
   URL with any other parameter (`?host=`, `?port=`, `?user=`, `?password=`,
   `?options=` and so on) is refused as a whole and preview builds fail until
   it is corrected, because the platform's two database clients would read
   such a URL as two different servers. **`sslmode` may only be `disable`
   (or left out): the preview server is reached without TLS**, by the
   platform, by its `psql`, `pg_dump` and `pg_restore` processes and by each
   preview, which is how the main server is reached today. Each is told so
   outright: the child processes get `PGSSLMODE=disable`, the platform's own
   client is given `ssl: false`, and every database URL handed to a preview,
   a shots runtime or the shots fixtures ends in `?sslmode=disable`,
   whichever of the two accepted forms the setting took. Every other mode
   is refused by name. The reason is that the three clients do not agree on
   what a mode means (node-postgres verifies the certificate for `require`
   where libpq does not) or on where the certificate authority comes from,
   and a server only one of them could reach produced previews that could
   not open their database. The server must therefore accept plain
   connections from the platform and the app namespace; one that takes TLS
   only fails every build, before production is read. TLS with a shared
   certificate authority for all three clients is a follow-up. For the same reason the address names
   exactly one host, as a DNS name or an IPv4 address (no host list, no IPv6
   literal, no socket path), and the user is made of letters, digits and
   underscores: restored objects are handed from that user to each preview's
   role by name. The platform's own `PG*` environment variables (`PGSERVICE`,
   `PGHOSTADDR` and the rest) are not passed to the `psql`, `pg_dump` and
   `pg_restore` processes that talk to the preview server; the URL is their
   whole connection. Point it at the server itself, not at a pooler that
   hands each statement to a different backend: the shared-block copy relies
   on one session staying on one server.
   With `secrets.create=true` the chart writes it from `previewPostgresql.*`
   and `secrets.previewDatabasePassword`.
3. Set `previewPostgresql.enabled: true` with `namespace`, `podSelector` and
   `port`, and sync. While `enabled` is false the chart sets the variable to
   an empty value on the platform, which overrides the key in the Secret, so
   this is the switch.

From the next platform Pod on, new previews are made on the preview server.
Each app's template is rebuilt there on its first build, and its old template
on the main server is dropped by that build. Templates of apps that do not
build again are dropped by the orphan database pass, which runs every six
hours, takes at most 50 apps a pass and skips what it cannot drop, so a large
fleet takes several passes and nothing promises a deadline. A template left
behind costs disk and nothing else. Previews that already exist stay on the main server
until they are rebuilt or torn down. `Staging template refreshed` log lines
carry `server: preview`; `refused a shared-block copy` and `older than
PostgreSQL 18` say why a server gets plain copies. `STAGING_DB_FILE_CLONE=0`
turns the shared-block attempt off without moving anything.

### Switching it off

1. Set `previewPostgresql.drain: true` (`STAGING_DB_SERVER_DRAIN=1`) and
   sync. New previews are made on the main server again. Previews still on
   the preview server keep working and are still cleaned up there; a preview
   backing a live vote is rebuilt onto the main server by the heal pass, a
   few per sweep, and any other is rebuilt the next time somebody opens it.
   Until then such a preview is reported as needing a rebuild. Builds on the
   main server do not need the preview server to answer: an old database of
   the same name there is left for the sweep if it cannot be dropped.
2. Wait until nothing depends on the preview server. This takes three
   things, and the log line is only one of them:
   - **The rollout that set the drain has finished**: every platform Pod now
     running was started with it. A Pod from before still makes previews on
     the preview server, and nothing in the line below can see what it is
     about to start.
   - **The platform's own count is empty, twice in a row.** Every ten minutes
     while draining it logs `Preview database server drain: still in use`
     with what it counted, or `Preview database server drain: no dependent
     preview, build or shots run found`. It counts every preview runtime
     that exists, in any state (running, starting, restarting, stopped),
     whose labels say its database is there; every runtime it could not
     read; the builds it can see (sessions whose checks are pending in their
     build phase, on any platform Pod, and this Pod's own builds); every
     unfinished before & after shots run; and every shots database still on
     the server. It does not see every build: a rebuild another Pod starts
     from recovery, for a proposal whose checks commit is already recorded,
     is in neither count. That is why the rollout comes first (a Pod with the
     drain setting builds on the main server, so an unseen build adds nothing
     here) and why one empty line is not enough (a build that was under way
     shows up as a runtime on the next pass). Wait for the second line on two
     consecutive passes after the rollout finished.
   - **A look at the server itself**: `pg_stat_activity` there shows no
     client on an `app_…` database. This is supporting evidence only. A
     preview holds no connection between requests or after its pool's idle
     timeout and still breaks when the server goes.
3. Then set `previewPostgresql.enabled: false` and sync, and remove the key
   from the Secret and the server. Do it in that order and without a long
   gap: once the setting is off the platform no longer looks at that server
   at all, so a preview built there in the meantime would not be noticed.

Removing the setting at once, without draining, is safe for everything on
the main server and for building: the platform is back to one server. What
it leaves behind is on the preview server: previews there keep running for as
long as the server exists, nothing cleans them up, nothing checks whether
their database is still there, and once the server is deleted each of them
answers errors until its next rebuild.

### If the preview server is wiped

Nothing has to be done by hand. The next build of each app finds no template
and rebuilds it. A preview whose database is gone is detected by looking for
the exact database its runtime was given, on the server it was made on
(at the next look, or up to a minute later while an earlier "it is there"
is still believed, and only when that server answers); the heal pass
rebuilds the ones backing a live vote,
a re-run of the checks rebuilds first, and any other is rebuilt when it is
opened. A preview built before the setting was turned on carries no labels; it
is on the main server and is not checked. If the server comes back on another version, the next copy sees it:
the version is read on the connection that makes each copy.

A failed build on the preview server is stored as a platform fault, so it
keeps being retried on the checks' platform-fault schedule (for up to a day,
two to thirty minutes apart). What people see has not changed with that: the
proposal's checks read "Couldn't finish" and the step is shown as the
author's, as for any checks error, although nothing is asked of them.

## Check runs across platform rollouts

Every merge to the self-app rolls the platform Deployment, and every checks
run in flight at that moment loses the process that was streaming its capture
and unit-suite Jobs. The Jobs themselves belong to the cluster and finish
regardless, and they are read rather than started over.

A preview checks run is the preview machine's `checks.run` work item. Each run
writes a manifest row to `check_runs` (session, commit, launch context, the
work item's key) before its Jobs are created and heartbeats it every
`CHECK_RUN_HEARTBEAT_MS` (15s). When the item's claim is lost (its process
died, or its lease ran out), the retry of the same item collects the Jobs the
manifest names (`check-harvest.collectForWorkflow`): a finished Job's log is
read, a running one is waited on, and the output goes through the same
settlement a live run ends with. It runs the checks again only when there is
nothing to read, and never settles without a unit suite that blocks merges.
A run that starts stops the still-running Jobs of the session's runs for other
commits (background deletion; their input Secrets go with them).

The repo's unit suite usually starts with the preview build: the machine's
`checks.unitEarly` launches it under an id derived from the attempt
(`sv-unit-early-…` Jobs), and the checks run against that attempt reads it,
from its own process or after a restart. It does not start for a head whose
last checks errored, or while the cluster already runs as many unit suites as
the checks queue admits (`EARLY_UNIT_SUITE=0` turns it off). The attempt's
retirement deletes its Jobs.

The main-watch suite after a direct merge keeps its own hand-over: a platform
process that shuts down stamps its `check_runs` rows' heartbeat as long past,
so the next leader adopts them at once instead of a minute later.

Every capture rechecks the exact deployed revision, image, environment
fingerprint, completed rollout, application health and public edge before
starting. Newer revisions cannot publish older output. Kubernetes rebuilds
reconcile the existing Ingress and Service instead of deleting them first,
which removes the missing-host TLS routing window; it does not promise
uninterrupted interactive previews during application/database replacement.

## Check Jobs, their input Secrets and the worker quota

A checks run creates a capture Job and a unit-suite Job in the worker namespace,
each with an input Secret the Job owns. Once the run's verdict is stored and
its `check_runs` manifest cleared, the run deletes its finished Jobs with
background propagation, which takes their Pods and Secrets too; a run
collected after a lost claim does the same once it settles. The Jobs' `ttlSecondsAfterFinished`
(3600 s) covers everything else: superseded or failed runs, the main-watch
suite, and whatever a crash leaves. Keep it at least that long, because it is
how late a retry can still read a run after a slow leader handover.

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

The governance-proposal machine in `src/workflow/` decides every governance proposal.
It has no flag: its old paths (the governance-apply ticker, the stale sweeper's
Pass 0b, the apply functions in `routes/issues.js`) are deleted.
`docs/workflows.md` explains the machine and where it runs.

- **Where it runs.** The machine runs inside the platform Pods; there is no extra
  workload. Every Pod listens for outcomes and runs pipeline slots, so it applies its
  own votes; only the leader runs the timer and service loops and the boot backfill.
- **A runtime that fails to start ends the process.** With no other path for a
  governance proposal, a Pod without the workflow runtime exits at boot and
  Kubernetes restarts it, rather than serving without it.
- **A leader whose workflow loops fail to start stops itself** (through its drain, as on
  SIGTERM), so another process leads: the timers and work of every governance proposal
  run only there.
- **Ownership is enforced.** A write to an enrolled governance proposal's status or audit
  keys from outside the machine is refused (`WF_OWNERSHIP_VIOLATION`). A row is enrolled
  when it is filed, or
  by the leader's boot backfill if filing failed.
- **Rolling back past this release.** Code from before it still reads
  `WF_GOVERNANCE_ENABLED`, and without it its old paths would try to decide proposals the
  guard now refuses to let them write, so every enrolled proposal would stall. Keep
  `platform.workflowGovernanceEnabled: true` in the infra values (this chart no longer
  reads it) until no rollback target predates this release.
- **Verify after a release.** The Pod's log shows `Workflow runtime started` and, on
  the leader, `Enrolled open governance proposals` when there were any; Admin →
  Workflows lists the enrolled proposals and its problems panel is empty.

## Workflow merge-followups machine

The merge-followups machine in `src/workflow/merge-followups/` runs what follows a merge
(the production deploy, preview teardown, included changes, closing requests, the
announcements) as durable work, and a change reads live only once production runs it. It
has no flag: the old merge tail (`finalizeMerge` and its follow-ups), the
`merge-followup-recovery` sweep and the boot resume of issue-close watches are deleted.
`docs/workflows.md` explains the machine.

- **A merge is only reported.** The proposal machine's merge attempt (`merge.attempt`)
  tells merge-followups `Merged` in the transition that records GitHub's answer. An
  answer that never came leaves the proposal `merging` (`unconfirmed`), and it asks
  GitHub again until GitHub says; each boot also looks on GitHub for merges of promoted
  rows (`observeMergedOnGithub`).
- **Ownership is enforced.** Only the machine moves a proposal into `merged`, and a write
  to a merged row's `merged_at`, `merge_commit_sha`, `included_in_session_id` or `live_at`
  from outside it is refused (`WF_OWNERSHIP_VIOLATION`).
- **Rolling back past this release.** Code from before it still reads
  `WF_MERGE_FOLLOWUPS_ENABLED`; with it off, its old merge tail would move rows into
  `merged` itself. Keep `platform.workflowMergeFollowupsEnabled: true` in the infra values
  (this chart no longer reads it) until no rollback target predates this release. The
  instances this release writes are version 5, which older code leaves alone: such a
  merge finishes once the release comes back.
- **Verify after a release.** The Pod's log shows `Workflow runtime started` with
  `merge-followups`; the next merge appears in Admin → Workflows as
  `merge-followups / session:<id>` and reaches `live`, and the proposal's thread says "is
  live" after the deploy, not before.

## Workflow app-delivery machine

The app-delivery machine in `src/workflow/app-delivery/` runs every production deploy of
an app, one at a time per app and at most four at a time in the leading process, for everyone who
asks (a merge, a secret change, the drift poller, Check for updates, Redeploy, heal, a
rollover whose image is gone, a demo reset). It has no flag: each caller used to deploy
itself, in its own process, with "deploying" in that process's memory; now it records a
request and the machine deploys. `docs/workflows.md` explains the machine.

- **Where the deploys run.** `app.deploy` is a work item, which only the leader runs:
  with the web and conductor split, the conductor Pod. Each deploy clones the app into
  that Pod's `/tmp` and builds there, as previews do.
- **"Deploying" is durable.** It is `apps.deploy_state`, read by every Pod and after a
  restart; a deploy whose process died is retried after its lease. A deploy that never
  answers (a hung build or lock) is ended by an admin in Admin → Workflows (`EndDeploy`).
- **Ownership is enforced.** A write to `apps.deploy_state`, `deploy_started_at` or
  `deploy_from_sha` from outside the machine is refused (`WF_OWNERSHIP_VIOLATION`).
- **During the rollout that brings it.** An old Pod still deploys the old way; the
  cross-process build lock keeps its deploy and the machine's from running on one app at
  once, and each reads the other's "deploying".
- **Rolling back past this release.** Older code deploys in each caller again. It still
  runs a deploy app delivery had under way (it registers the machine while one is), but a
  request left open after a failed deploy waits: the merge or secret change that asked is
  version 5, which older code leaves alone, so it is answered once the release comes back.
  Nothing in the infra values needs keeping for it (`workflowAppDeliveryEnabled` stays as
  it is until the values are cleaned up).
- **Verify after a release.** The Pod's log shows `Workflow runtime started` with
  `app-delivery`; the next deploy appears in Admin → Workflows as
  `app-delivery / app:<id>`, `deploying`, then `idle`, and the version pill spins during
  the deploy after a page reload, too.

## Workflow preview machine

The preview machine in `src/workflow/preview/` builds, checks and retires every
proposal's preview, and the App bench studio's previews, as durable work, and records
who is working on a session. It has no flag: its old paths (the per-process build queue,
the preview lifecycle, the check harvest's sweep, the in-memory capture seat, the early
unit suite's module, the turn tails' own builds) are deleted. `docs/workflows.md`
explains the machine.

- **Where the work runs.** Its builds and checks runs are work items, which only the
  leader runs: with the web and conductor split, the conductor Pod. Each build clones the
  proposal into that Pod's `/tmp` and follows its rollout there, so size
  `platform.conductor.resources` for the previews built at once.
- **On the cluster.** A preview keeps its per-session Deployment, Service and Ingress
  (`sv-preview-<appId>-s<sessionId>`). Each attempt has its own env Secret
  (`<name>-env-a<n>`) and database (one per claim of its build, should a build be claimed
  again after a crash), and the Deployment carries the annotation
  `social.usernode.io/preview-attempt`: the newest attempt that wrote it and which claim
  of its build, as `n.k` (a bare `n` is claim 0). The attempt's Secret carries the same
  annotation, so an older claim never writes its database back into it. A failed rollout
  restores the template that served, so the older revision keeps serving. Each platform
  process also holds one more database connection, for its presence lock.
- **The sweeps only observe.** The boot heal and the sweeper's heal report a runtime
  that is gone or stale to the machine, the stuck-checks sweep hands it a row with no
  verdict, and the reapers ask it to retire; each leaves a session it is building,
  checking or retrying alone. The orphan-database sweep keeps every database of a
  session it holds.
- **Ownership is enforced.** A write to a held session's preview or checks columns from
  outside the machine is refused (`WF_OWNERSHIP_VIOLATION`). The staging seeds in
  `migrate.js` leave a row it holds alone.
- **Rolling back past this release.** Code from before it still reads
  `WF_PREVIEWS_ENABLED` and `PREVIEW_LIFECYCLE_ENABLED`; with the first off it would hand
  every session back to paths the guard now refuses. Keep
  `platform.workflowPreviewsEnabled: true` in the infra values (this chart no longer reads
  it) until no rollback target predates this release.
- **Verify after a release.** The Pod's log shows `Workflow runtime started` listing
  `preview`; Admin → Workflows shows each new revision as `preview / session:<id>` going
  through `preparing` and `checking` to `settled`, with an empty problems panel; and
  `kubectl -n social-apps get secrets` shows `-env-a<n>` Secrets only for attempts that
  serve or are being prepared.

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

`CHECKS_MAX_CONCURRENT_RUNS` (default 4, chart `config.checksMaxConcurrentRuns`)
bounds how many proposal checks runs have Jobs in the worker namespace at once;
main-watch's run of main has one slot besides them. A run waits for its slot
after its preview is built and before it creates a Job, so the namespace
quota no longer queues Pods whose deadlines are already running. The slots are
the live `check_runs` rows: `admitted_at IS NULL` is a run waiting,
`queued_at` its place in line. Red check runs track check-Job CPU across the
cluster (9% under 10 cores, 24 to 29% above, October 2026), because every
preview under test loads the one shared Postgres primary; lower the cap
before raising quotas when proposals' checks go red together.

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

`CHECK_NODE_POOL` (default empty, chart `config.checkNodePool`) replaces that
spread with a preference for a dedicated node pool, given as the pool nodes'
label `key=value`. The pool's nodes carry the label and the same pair as a
`NoSchedule` taint; check Pods tolerate the taint and prefer the label, and
fall back to the other nodes when the pool is full or down. The worker
namespace's CPU-request quota still bounds them wherever they run, so raise it
with the pool's capacity. To see where checks ran:
`kubectl -n social-workers get pods -l social.usernode.io/workload=check -o wide`.

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
