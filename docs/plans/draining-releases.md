# Releases let work finish

A release replaces the platform's Pod. Until now the Pod being replaced had
about a minute: it stopped taking requests, waited five seconds for busy
workers and shots runs and sixty for the rest, marked what was left
interrupted and exited, and only then did the new Pod become leader and
recover what it could. A coding turn, its tail (push, pull request, preview
build, checks, shots), a merge, an app being created: whatever was under way
was cut, and recovered afterwards if it could be.

Now the Pod being replaced keeps working. It refuses anything new, finishes
what it had started, and exits when it is idle, or at a deadline. Work
started under the old release finishes there; new work goes to the new one.
Releases come every few minutes, so several Pods may be finishing at once,
each with its own work.

The old Pod and the new one each run live work for as long as the old one
drains, so nothing may answer "is this session busy", "is a build in flight"
or "stop this turn" from one process's memory. It is answered from Postgres:
the work is the workflow's (docs/workflows.md), and no process leads.

## Processes, and who works on what

`src/services/processes.js` keeps the roster, `platform_processes` (private
to staging clones):

- Every platform process registers at boot (`serving`), beats every
  `HEARTBEAT_MS`, says when it starts draining (`draining`, with its
  deadline) and deletes its row as it exits. A process whose beat is older
  than `LIVE_SECONDS` is gone, whatever its row says; the `process-reap`
  clock deletes such rows. In a Kubernetes Pod a process starting deletes
  the rows of its Pod's previous process: the container restarted. The
  roster says which build serves, which processes run the workflow, and
  whether a draining process has a successor.
- A HOLD (`hold(kind, ref)`, the `heldMap`/`heldSet` registries) is a thing
  this process is doing, kept in its memory: what its drain waits for
  (`localCount()`). No process reads another's.
- Who works on a session, for every process, is read from durable records
  (`src/workflow/session-work.ts` `workedOnSql`): a turn's record (named by
  its owner, a work item), a running `turn` instance, a local agent's turn, a
  shots run, a live operation on the preview instance (a hand-off pipeline,
  an upload: its record names the process, counted while that process holds
  its presence lock), a build, a sync, the bot's look. `isSessionBusyAnywhere`
  and `busySessionsAnywhere` (`active-workers.js`) read this process's memory,
  then those records.

A person's Stop is an event to the machine whose work runs the turn
(`StopRequested`), which stops it wherever its work item runs; a coding run
is killed by its journal. Nothing is forwarded over the WebSocket bus. What a
worker turn calls back (the Anthropic proxy, its BYOK spend, a shots eval's
bill, a shots agent's tool calls) reaches whichever Pod the Service picks,
so those read the turn from the database when it is not in this process.

## Draining

On SIGTERM, on the platform's own Kubernetes Pods (`server.js cleanup`),
once another process of its role is serving (`processes.servingOthers`,
waited for up to `SUCCESSOR_WAIT_MS`). With none (a scale to zero, every
replica restarting), the platform is going down, and its work items are the
next process's to carry on whenever one starts: the cutover it always had,
a minute's drain.

1. Refuse new work (`lifecycle.setShuttingDown`: the drain-guarded routes
   answer 503, the workflow's loops claim nothing) and say so
   (`processes.markDraining`). A step of work the process already holds is
   not new: the Homeroom bot's build proposes in-process (`promoteAsBot`),
   and that request carries `lifecycle.OWN_WORK`, which the drain guard lets
   through. On 14 Oct 2026 a first version built to the end in a draining
   Pod was refused its own promote and stopped. A request over HTTP never
   carries the mark.
2. Quiesce the workflow runtime (`quiesceWorkflow`: no slot, timer or
   claim), not its running work: a person's turn, a build, a merge under way
   goes on to its end here.
3. Tell open tabs where traffic went and close their sockets, so they
   reconnect to the new Pod. The listener stays open: Kubernetes has already
   taken this Pod out of the Service, and a request it still answers
   finishes. (A shots agent calls the Service: its run's control plane is in
   Postgres, `services/shots-control.js`.)
4. Wait until this process holds nothing, has no background work registered
   (`inflight-work.js`), no running workflow work and no request still
   answering; or until the drain deadline (`PLATFORM_DRAIN_TIMEOUT_MS`,
   default `KUBERNETES_DRAIN_DEFAULT_MS`); or until `PLATFORM_DRAINING_MAX`
   newer processes are draining too (releases faster than work finishes:
   the oldest hands its work over rather than pile up Pods); or until no
   successor is serving any more.
5. Then what shutdown always did: close the listener, stop the workflow
   runtime (its work items given up to the next claim, which carries each
   turn on from its saved step: `services/turns.js`), hand back checks runs,
   close the pool, delete this process's row, exit.

`terminationGracePeriodSeconds` comes from `platform.drainMinutes`, with
room for the steps after the drain (`tests/server-graceful-shutdown.test.js`
pins it). A staging preview and a docker-compose color keep the short drain:
neither has a grace to spend. A node drain (`kubectl drain`) now waits for a
platform Pod's drain too; pass `--grace-period` to cut it short.

## What a process leaves

Nothing recovers work at an election: there is none. A work item whose
process went (its drain deadline passed, or it died) is claimed again once
its lease lapses, and carried on from what it saved (a person's turn follows
its coding run's journal to its end: docs/workflows.md, `turn`). A coding
record whose item settled without releasing it is taken to an end by the
`turn-leftovers` clock. Leases and heartbeats decide the rest (checks runs,
shots runs, local-agent turns, app creation, owed redeploys, fleet
campaigns).

## Beside a release from before the turn machine (rollout-only)

That release still has a leader, renews its conversations' claims and reads
`process_holds`. Until no such release can run, this one writes its holds
there, renews a running conversation's claim, holds a headless run's
session, answers its forwarded Stop through the turn's machine, keeps
`leader_sweeps`, and leaves what that release left to its leader while one of
its processes serves (`services/turn-leftovers.js`, whose header lists what to
delete).
