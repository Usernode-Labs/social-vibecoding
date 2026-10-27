# Web and conductor processes

Every platform Pod used to do everything: serve people's requests and
WebSockets, and stand for the leader lock, whose holder runs the platform's
own work (the workflow loops, the timers and sweeps, the merge queue, the
Homeroom bot, recovery). A release replaced the Pod, and with
it the leader: the replaced Pod resigned and the new one took over
(docs/plans/draining-releases.md). Since the turn machine there is no leader
at all: what it ran is workflow work or a clock, and a person's turn is the
`turn` machine's work item (docs/workflows.md).

Now the two jobs can run apart (`platform.conductor.enabled` in the chart):

- **web** Pods (`PROCESS_ROLE=web`) serve requests and WebSockets and decide
  nothing. A route asks for what it always started (a turn, a preview build,
  a checks capture, a shots run) as an event to its machine, whose work runs
  on a conductor, and follows it from Postgres.
- **the conductor** (`PROCESS_ROLE=conductor`, a Deployment of its own, two
  replicas in production) runs the workflow (docs/workflows.md) on every
  replica; nothing is elected. It listens on HTTP too, for its own loopback calls (the
  bot's platform tools) and probes, but no Service sends it people's
  requests, and it starts none of the caches they read.
- **all** (no `PROCESS_ROLE`) is both, as before: docker-compose, local
  development, tests, staging previews, and the chart with the switch off.

`src/services/process-role.js` reads the role; an unknown value fails boot.

## What changed for a web process

A web process ran as a follower before, for the seconds of a rollout. Since
the split it is one for its whole life (and since the turn machine every
process is), so what a follower could not do had to move:

- **Its own duties run on every process** (`server.js startProcessDuties`):
  the shots checkouts a run left in its own temporary directory. A worker is
  its session's (`session_workers`: which run uses it, when it was last
  used), and the `worker-eviction` clock evicts what is idle past the window,
  whichever process ran it.
- **The read-only database roles** are set up once per release with the
  schema, by the migration Job (in compose, by boot's own migration under its
  lock: `services/db-roles.js`), and recorded for every process
  (`platform_db_roles`). The prod-debug role's password is stored encrypted
  with the data key, as app secrets are, and denied to both roles; a process
  reads it on first use and again when Postgres refuses it (the next release
  rotated it). The SQL console's role has no password: a process takes the
  record's word that it was set up.
- **Nothing an admin screen reads is kept in a leader's memory**: what the
  leader published for the others (`services/leader-status.js`, table
  `leader_status`) is gone with its last status, the bench lane's. The bot's
  loop, the bench lane, the shots evals, the custom-domain sweep and the
  storage cap are workflow instances, read from Postgres wherever they run
  (docs/workflows.md).
- **No loop needs a wake over the bus**: a launch appends its machine's event
  in whatever process it lands (the bench lane's `Look`, the shots evals'
  `Look`).
- **What one process learns about a repo's issues, the others hear**
  (`issues_cache`): a close, a reopen or an invalidation leaves every
  process's open-issues copy, so a list a web process serves is as fresh as
  the merge or the heal the conductor made. An issue the platform files
  reaches every copy too (15 Oct 2026), so the conductor's bot reads a
  request a web process filed, a project's first version among them, at
  once rather than once GitHub's own list has it.
- **A DM answer the bot owes** is the person's DM machine's (`bot-dm`, docs/workflows.md):
  the message is heard in its own transaction on the web Pod, and the answer, and any
  later try, are its work, wherever the workflow loops run.
- **A heal or a drift rebuild** is app delivery's (`src/workflow/app-delivery/`):
  the error page on a web process and the conductor's clocks only report, and
  the machine runs one heal or deploy of an app at a time, its backoff in the
  instance rather than any process's memory.
- **An app's merges are its merge-queue machine's** (`app:<id>`,
  docs/workflows.md): one at a time across processes, whichever process heard
  the vote.
- **Sweeps that check a session is not mid-turn** before acting on it (the
  imported-PR head sync, the proposal measurement) read who works on it from
  Postgres (`session-work.ts workedOnSql`), for every process.
- **A conductor does not say a release is live**: only a process that serves
  requests records the merges it carries as running.
- **A web process decides nothing** (docs/workflows.md, "Running it"): it runs
  no pipeline slot, and a route waits for a conductor's outcome.

What makes the split safe (docs/plans/draining-releases.md): who works on
what is in Postgres (the workflow's records), a Stop is an event to the
machine whose work runs the turn, and a worker's callbacks (the model proxy,
BYOK spend, a shots eval's bill) read a turn that is not in their process
from the database.

Worker push callbacks use the `worker-push` machine
(`src/workflow/worker-push/`). The HTTP handler authenticates the worker and
reads its stored branch, then waits for a separate request instance. The
conductor rechecks the session, account, app, branch, repository and public
visibility before exporting Git objects and running authenticated Git in the
trusted pusher. No JWT, Git credential or Git bundle enters the event or work
input. A request not started within 80 seconds expires; an HTTP wait that
times out returns a retryable 503. There is no direct web-side push fallback.
The handler has its own work kind and concurrency, so a turn waiting for its
worker's callback does not occupy the push queue. Local `all` processes run
the same machine and handler.

Agent-context reset and a promoted proposal's Pause queue `worker-release`
requests (`src/workflow/worker-release/`). Reset writes its release intent in
the same transaction as the model/context change and transcript message;
Pause leaves the proposal up for voting. The conductor checks the current
owner, account, configuration, turn and last use, takes the worker eviction
lock shared with startup, then deletes only captured runtime identities and
waits for them to be gone. A later use or context reset makes stale work skip.
Pause still releases an idle worker when its captured turn has just finished;
a different running turn is spared. A later turn that also finishes before
Pause executes can lose its warm worker.
The work lease and session lock are checked before deletion. An unpushed commit
is recorded durably in `session_workers` before the turn is released, so
another conductor or a restarted process can rescue it. Worker preparation
rescues it under the eviction lock on every image, and the dispatch guard
checks again before any runner can reset the checkout. A caller whose own
attempt is already registered supplies its `turnId`; only that matching
`dispatch_pending` attempt may see through the active-turn guard. A different
running turn is left alone. A new turn never supersedes an unpushed commit.
Failed rescue or a failed database read prevents a new turn, agent-reset or
promoted-Pause removal, idle eviction and stale-worker replacement. A refused
turn starts no agent, charges no coding turn, and releases only its own
pending record. The refusal names the commit, branch and push failure;
permanent failures are passed through to the Mayor and agent dispatch.
On a GitHub-hosted app during the GitHub pause, a build whose push failed
blocks further builds in that session until its commit can be pushed.
Failed record writes retain the turn and journal for recovery.
The context volume stays. Agent dispatch records an operation immediately
after switching agents, so its reset release will often skip; reusing that
warm worker is safe because its setup does not depend on the agent backend.
A separate machine lets older conductors leave these intents for the new
build during rollout. The idempotent schema migration adds nullable
`unpushed_sha` and `unpushed_branch_name` columns to the private table;
no new runtime configuration is needed. Existing unpushed commits held only
in an older conductor's memory are not backfilled by this migration.

Force-stop fallback uses `worker-stop` requests (`src/workflow/worker-stop/`).
The web captures the actor, app, owner, configuration and running job, then
waits for the conductor to confirm termination. The conductor rechecks current
authority and job identity under the worker eviction lock. It hard-kills only
the captured journal; if that cannot confirm termination, it rescues any saved
commit and removes only captured runtime identities, retaining the volume.
A missing journal on an unchanged executing record also uses fenced removal,
so both Force stop and last-attempt recovery can end that stranded record.
A newer job or a worker used after an orphan-stop request is spared. Ledger
settlement failure retains the stopped turn for recovery. Announcements and
durable cleanup run on the conductor; the web releases only its captured local
handle and hold. Last-attempt turn recovery uses that same conductor I/O core.
Older conductors leave the separate machine's requests pending during rollout;
unavailable or unconfirmed stops return a retryable 503 with no web-side runtime
fallback. Work not started within 30 seconds expires; journal-kill and removal
waits use only the remaining request budget, with expiry rechecked after commit
rescue before deletion. The HTTP wait allows five extra seconds for settlement
and the workflow result. A captured job that already ended succeeds without
queueing; agent-stop HTTP responses preserve typed 404/409/503 refusals.
No schema or runtime configuration change is needed.

Ordinary Stop queues the separate `worker-interrupt` machine in the same
package. It acknowledges admission without waiting for confirmation, keeping
the existing HTTP responses and local stream cancellation. The originating
process stamps stop intent and disarms completion notifications before aborting,
without waiting for conductor admission. A local CLI turn needs no container
command, and final wrap-up stays protected.
The conductor retains the TERM/grace/KILL signal, two-second probe cadence,
three-signal cap and 30-second budget. Timers and attempts are in PostgreSQL;
an actor's duplicate clicks share an active confirmation, and another conductor can finish
it; repeat requests acknowledge that pending confirmation. After a confirmation
ends, a new click can try again. Every work step rechecks current authority,
configuration and job. Ordinary confirmation never
clears the owning turn's record or escalates into force-stop deletion.
The local pending flag gates spin-up. If Stop crosses an exec already in flight,
its dispatcher signals and appends bounded confirmation for that exact new
record, without waiting for another work item's result. This backstop has a
dedicated system source and a null actor, independently of human-click coalescing;
it checks the active turn id and journal and does not depend on the owner's
account state. The pending flag carries the real stopper's name when known;
otherwise the durable stamp has no stopper. A locally applied Stop
still succeeds when admission finds a changed job; it never retargets that job.
Old records with neither turn id nor journal are fenced by a fingerprint of
their stored contents and signalled without writing a conductor-local registry.
The legacy whole-worker fallback uses captured runtime identities and rescues
saved commits before stopping: Kubernetes removes its Deployment while Docker
keeps its stopped container, registry entry and sweeper row; both retain the
context volume. A skipped removal reports the authority, job, completion or
expiry check that declined it. Retry-time idle waiting performs I/O only on a
conductor and returns false without I/O when called on the web. The route-side
polling loop, local `confirming` flag and name-based stop shim are removed.
Older conductors leave this separate machine pending, so rollout can temporarily
return retryable 503s, with no web-side runtime fallback. This needs no schema
or runtime configuration change.

These move web dependencies behind durable commands. Web Pods still need
their current Kubernetes and database permissions for other callers, including
volume copies, repository operations and startup work. Moving
those callers, then splitting service accounts, Secret inputs and actual
database login privileges, remains SEC-09 work. The event's source metadata
also remains a convention among trusted processes; it does not authenticate
a compromised producer.

## Successors

A release replaces a process with one that can do what it did
(`processRole.successorRoles`): a conductor with a conductor or an 'all', a
web process with a web one or an 'all', an 'all' with an 'all' or a
conductor. The drain waits for one (up to `SUCCESSOR_WAIT_MS`) before it
finishes its work, and counts its fellow drainers the same way. So the split
is switched on and off by a release of its own: the old Pods drain beside the
new ones, whichever way it goes.

## Chart

`platform.conductor.enabled` (on by default) adds `<fullname>-conductor`,
the platform's own Pod run as the conductor, and runs the platform Deployment
as web; off, one Deployment does both, as before. The conductor's Pods keep
the platform's `component` label, so the network policies that admit the
platform admit them, in the chart and outside it; the Service and the
PodDisruptionBudget select `social.usernode.io/serves-requests: "true"`, which
only the serving Pods carry; the conductor has a budget of its own
(`maxUnavailable: 1`), spreads its replicas across nodes, and serves the
workflow's metrics to the chart's PodMonitor (docs/kubernetes-operations.md,
"Workflow alerts"). The Service is in Argo CD sync wave 1: its
selector changes only after the Deployments are healthy, so the release that
first requires the label never leaves it with no labelled Pod Ready. (Applied
without Argo, all at once, that first release would.) The platform
Deployment's selector (immutable) also matches the conductor's Pods:
ownership keeps them apart, but `kubectl logs deploy/<fullname>` may pick a
conductor Pod; select by `social.usernode.io/process-role`.

The first release with the split replaces Pods of a build from before it.
Their registry counts only an 'all' as a successor, so they find none and
hand over with the minute's cutover (docs/plans/draining-releases.md), once;
every release after that drains.

## Still per process

What a web process shows of work the conductor runs, and the other way
round, is less detailed than what it shows of its own:

- the GitHub budget page counts the requests of the process that answered;
- a turn's live phase and estimate show on the process that runs it
  (elsewhere it is busy, from Postgres, without them); its events and its
  spend are Postgres's (`stream_events`, `turn_spend`), so every process's
  tabs replay them;
- an admin's preview sweep and the automatic one keep their own job records.

## Not in this change

- Rolling the conductor only when its own code changes. Every release builds
  one image and rolls both Deployments; the release pipeline decides that,
  not the chart. With the drain, a conductor release no longer cuts the work
  it was doing, so the gain is smaller than it was.
- Migrating all remaining infrastructure calls from routes. The push
  callback above now queues conductor work; other web-side calls still
  finish in their own process and need to move before privileges are split.
