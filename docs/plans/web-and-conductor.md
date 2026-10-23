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
- Routes recording work for the conductor instead of starting it in their
  own process. A web Pod finishes what it starts; nothing has to move for
  that.
