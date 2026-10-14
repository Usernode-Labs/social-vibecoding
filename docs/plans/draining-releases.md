# Releases let work finish

A release replaces the platform's Pod. Until now the Pod being replaced had
about a minute: it stopped taking requests, waited five seconds for busy
workers and shots runs and sixty for the rest, marked what was left
interrupted and exited, and only then did the new Pod become leader and
recover what it could. A coding turn, its tail (push, pull request, preview
build, checks, shots), a merge, an app being created: whatever was under way
was cut, and recovered afterwards if it could be.

Now the Pod being replaced keeps working. It hands leadership to the new Pod
at once, refuses anything new, finishes what it had started, and exits when
it holds nothing, or at a deadline. Work started under the old release
finishes there; new work goes to the new one. Releases come every few
minutes, so several Pods may be finishing at once, each with its own work.

This needs one thing the platform did not have: a way for one process to
know what another is doing. The old Pod and the new one each run live work
for as long as the old one drains, and every "is this session busy", "is a
build in flight" or "stop this turn" used to read this process's memory only.

## Processes and what they hold

`src/services/processes.js`, two tables (`platform_processes`,
`process_holds`, both private to staging clones):

- Every platform process registers at boot (`serving`), beats every
  `HEARTBEAT_MS`, says when it starts draining (`draining`, with its
  deadline) and deletes its row as it exits. A process whose beat is older
  than `LIVE_SECONDS` is gone, whatever its row says; the leader deletes such
  rows (their holds go with them).
- A HOLD is a thing a process is doing that nothing elsewhere may adopt,
  tear down, duplicate or call idle: `hold(kind, ref)` returns its release,
  counted per process, written to `process_holds` on the first hold and
  removed on the last release. The registries that already said this for one
  process write through to it: a session with a turn or an operation under
  way (`active-workers.js`), a preview build (`staging.js`), a checks
  capture (`visuals.js`), a sync, a hand-off pipeline, a shots run, a
  teardown, a production deploy. Their readers (`isSessionBusy`,
  `hasInFlightBuild`, `hasInFlightCapture`, ...) answer for every live
  process: their own memory, then a copy of the other processes' holds that
  each process refreshes every `MIRROR_MS`. Recovery that would adopt or
  redo something reads the holders exactly, from the database
  (`holders(kind, ref)`).
- What a process holds is also what its drain waits for: `localCount()`.

A stop for something another process runs travels to it over the WebSocket
bus (`ws-bus.js`), and the holder does exactly what a stop in its own process
does: a turn (`session_stop`), a shots run (`shots_stop`), a bench trial or
run (`bench_cancel`). What a worker turn calls back (the Anthropic proxy, its
BYOK spend, a shots eval's bill) reaches whichever Pod the Service picks, so
those read the turn from the database when it is not in this process.

## Draining

On SIGTERM, on the platform's own Kubernetes Pods (`server.js cleanup`),
once another process of its role is serving and writes what it holds
(`processes.servingOthers`, waited for up to `SUCCESSOR_WAIT_MS`): a release
from before the registry would adopt this process's live turns as orphans the
moment it led (a rollback across this change), and a Pod evicted before its
replacement is up would leave nobody leading. Without one, the cutover it
always had: a minute's drain, the lock released last.

1. Refuse new work (`lifecycle.setShuttingDown`: the drain-guarded routes
   answer 503, leader timers start nothing, the loops claim nothing) and say
   so (`processes.markDraining`).
2. Stop being leader: the Homeroom bot's loops, the bench lane, the shots
   eval runner, the sweepers and timers stop starting things; the workflow
   runtime stops its loops (`quiesceWorkflow`: no slot, timer or claim) but
   not its running work; the timer ticks under way finish (bounded); then the
   leader lock is released (`leadership.resign`). The new Pod is promoted
   within a poll and starts its leader work.
3. Tell open tabs where traffic went and close their sockets, so they
   reconnect to the new Pod. The listener stays open: Kubernetes has already
   taken this Pod out of the Service, and a shots worker calls the Pod that
   runs its run by its own address.
4. Wait until this process holds nothing, has no background work registered
   (`inflight-work.js`), no running workflow work and no request still
   answering; or until the drain deadline (`PLATFORM_DRAIN_TIMEOUT_MS`,
   default `KUBERNETES_DRAIN_DEFAULT_MS`); or until `PLATFORM_DRAINING_MAX`
   newer processes are draining too (releases faster than work finishes:
   the oldest hands its work over rather than pile up Pods).
5. Then what shutdown always did: close the listener, end the Mayor's turns,
   stop the workflow runtime (its work items given up to the next claim),
   mark what is left interrupted, hand back checks runs, close the pool,
   delete this process's row, exit.

`terminationGracePeriodSeconds` comes from `platform.drainMinutes`, with
room for the steps after the drain (`tests/server-graceful-shutdown.test.js`
pins it). A staging preview and a docker-compose color keep the short drain:
neither has a grace to spend. A node drain (`kubectl drain`) now waits for a
platform Pod's drain too; pass `--grace-period` to cut it short.

## The new leader, while the old Pod drains

Recovery used to run against a process that had already exited. Now it runs
while the old Pod still works, so each path that adopts, redoes or tears down
leaves what a live process holds:

- worker adoption (`adoptOrphanWorker`), headless runs, pending turn
  cleanups, missing previews: skipped while a live process holds the session;
- the session sweeper (auto-pause, stale-turn watchdog, preview heal), the
  stuck-checks reconcile, the preview reaper, the heal: `isSessionBusy` and
  friends already answer for every process;
- what is handed over later (the old Pod's drain deadline, or a crash) is
  adopted by a leader sweep that runs every `ORPHAN_SWEEP_MS`, not only at
  election: a turn whose session nobody live holds and whose worker is still
  there.

Leases and heartbeats already decided the rest (checks runs, shots runs,
local-agent turns, the Mayor's agent turns, app creation, owed redeploys,
fleet campaigns, workflow work).

## Not in this change

The web and conductor split (piece 1 of the review) builds on this: with the
registry, a route on a web Pod sees the conductor's work and the other way
round. It is a separate change.
