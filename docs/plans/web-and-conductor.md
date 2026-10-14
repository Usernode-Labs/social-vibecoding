# Web and conductor processes

Every platform Pod used to do everything: serve people's requests and
WebSockets, and stand for the leader lock, whose holder runs the platform's
own work (the workflow loops, the timers and sweeps, the merge queue, the
Homeroom bot, the bench lane, recovery). A release replaced the Pod, and with
it the leader: the replaced Pod resigned and the new one took over
(docs/plans/draining-releases.md).

Now the two jobs can run apart (`platform.conductor.enabled` in the chart):

- **web** Pods (`PROCESS_ROLE=web`) serve requests and WebSockets and never
  stand for leader. A route still starts what it always started (a turn, a
  preview build, a checks capture, a shots run), and a web Pod a release
  replaces finishes that work as any Pod does.
- **the conductor** (`PROCESS_ROLE=conductor`, a Deployment of its own, one
  replica) stands for leader and runs the leader's work. It listens on HTTP
  too, for what is addressed to its own Pod (a shots worker calls the Pod
  that runs its run), but no Service sends it people's requests.
- **all** (no `PROCESS_ROLE`) is both, as before: docker-compose, local
  development, tests, staging previews, and the chart with the switch off.

`src/services/process-role.js` reads the role; an unknown value fails boot.

## What changes for a process that never leads

A web process ran as a follower before, for the seconds of a rollout. Now it
is one for its whole life, so what a follower could not do had to move:

- **Its own duties run on every process** (`server.js startProcessDuties`):
  the idle eviction of its own warm workers, which only the leader ran. A
  worker whose session is busy on another process is left alone: a session's
  turns land wherever the Service sends them.
- **The read-only database roles** the leader sets up at its election are
  recorded for the others (`platform_db_roles`). The prod-debug role's
  password, which only the leader's memory held, is stored encrypted with the
  data key, as app secrets are, and denied to both roles; a web process reads
  it on first use and again when Postgres refuses it (a newer leader rotated
  it). The SQL console's role has no password: a web process takes the
  leader's word that it was set up.
- **What the leader keeps in memory and an admin screen reads** is published
  for the web processes (see "Leader status" below).

What already worked across processes (docs/plans/draining-releases.md) is
what makes the split safe: every process registers what it holds, stops reach
the process that holds the work over the WebSocket bus, and a worker's
callbacks (the model proxy, BYOK spend, a shots eval's bill) read a turn that
is not in their process from the database.

## Successors

A release replaces a process with one that can do what it did
(`processRole.successorRoles`): a conductor with a conductor or an 'all', a
web process with a web one or an 'all', an 'all' with an 'all' or a
conductor. The drain waits for one (up to `SUCCESSOR_WAIT_MS`) before it
resigns and finishes its work, and counts its fellow drainers the same way.
So the split is switched on and off by a release of its own: switched on, the
old Pods resign to the new conductor; switched off, the old conductor resigns
to the new Pods.

## Chart

`platform.conductor.enabled` (off by default) adds `<fullname>-conductor`,
the platform's own Pod run as the conductor, and runs the platform Deployment
as web. The conductor's Pods keep the platform's `component` label, so the
network policies and the PodDisruptionBudget that admit the platform admit
them, in the chart and outside it; the Service selects
`social.usernode.io/serves-requests: "true"`, which only the serving Pods
carry. That label ships with this change; switch the split on in a later
release, or the Service drops the old Pods before the new ones are Ready.

## Not in this change

- Rolling the conductor only when its own code changes. Every release builds
  one image and rolls both Deployments; the release pipeline decides that,
  not the chart. With the drain, a conductor release no longer cuts the work
  it was doing, so the gain is smaller than it was.
- Routes recording work for the conductor instead of starting it in their
  own process. A web Pod finishes what it starts; nothing has to move for
  that.
