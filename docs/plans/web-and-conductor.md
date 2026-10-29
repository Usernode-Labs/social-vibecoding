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
- **Issue lists come from the current provider**: the old process-local issue
  cache and its cache-only bus messages are removed. Actual issue updates
  still notify connected browsers through `issue_update`.
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
- **Preview security retirement runs on conductors.** Before starting any
  workflow work, a conductor (or `all`) still retires unsafe platform previews.
  A web process performs no Docker/Kubernetes retirement and does not warm
  worker images. It waits before listening for a successful result of the
  existing `preview-data-policy` clock, whose scan started within the last
  three minutes, using database time. The result must match the data-policy
  digest, runtime mode/namespace, release and receipt key. Recent matching
  proof lets web restart during a short conductor outage. An old-format,
  mismatched, expired or failed latest result cannot open the barrier; database
  failure or a three-minute timeout fails boot with no privileged fallback.
  Staging keeps its existing skip.

The security clock is armed before release-adoption work, so unrelated adoption
retries cannot delay web startup. Its first run is due immediately; an existing
clock keeps its minute interval. A conductor passes its successful boot scan
as an immutable startup dependency to that clock: its first run can record
that result without a second inventory. A later clock result, including a
failure, or an expired/mismatched boot result requires a fresh scan. Missing
receipt keys prevent readiness proof only after retirement has run.
On boot, a scope failure is logged and the conductor continues without a
proof; periodic clock runs still fail, and web startup stays closed. An actual
retirement failure still fails conductor boot.
Web waits long enough for an older conductor's skipped tick, the next tick
and retirement, and its Kubernetes startup probe allows five minutes for that
wait plus ordinary boot work. `all` keeps its direct pre-work check and does
not wait on itself.
The durable clock result replaces duplicate web execution; no new machine,
receipt table or preview-policy epoch is needed. This removes a dependency on
web runtime-write authority; separate service accounts, Secret inputs and
database logins remain required to enforce the wider privilege boundary. The
scope tag binds configuration, not an authenticated producer identity.

What makes the split safe (docs/plans/draining-releases.md): who works on
what is in Postgres (the workflow's records), a Stop is an event to the
machine whose work runs the turn, and a worker's callbacks (the model proxy,
BYOK spend, a shots eval's bill) read a turn that is not in their process
from the database.

Coding runners commit and journal their result. Both live completion
(`worker.execInWorker`) and journal recovery (`worker.resumeTurnFromJournal`)
pass through `turn-publication.js` before returning to their caller. This
covers Claude Code, both OpenRouter harnesses, builds and sync, including a
sync fast-forward with no commits ahead of main. Failed/discarded or stopped
runners without a commit are not published; the first-version partial-work
rescue remains an explicit separate policy.

A new dispatch record and its publication target are captured in one
transaction. Capture failure rolls it back and releases only the exact
undispatched physical attempt, including a pre-registered OpenRouter attempt.

Publication uses the existing `turn_effects` receipt table. Its pending intent
binds the app, owner, repository, branch and exact commit before Git I/O. The
conductor rechecks current authority and public visibility and uses the existing
trusted Git pusher, which imports objects into its own isolated repository and
never gives credentials to worker code. The export must match the saved SHA;
pushes never force. Transient errors retry publication up to five times, with
backoff; permanent or exhausted failures are recorded and returned through the
existing `pushOk`/failure result. PR creation and checks require success.

A restart before publication or an uncertain push replays the journal and only
retries that exact publication. A completed receipt is replayed without Git I/O.
Database failures leave the turn and journal retained. The worker's saved commit
is durable before publication and stays until it is published or explicitly
rescued. Worker preparation rescues saved work before any runner can reset its
checkout; failed rescue prevents startup, eviction or stale-image replacement.
An inactive session cannot authorize new publication; rescue may still publish
its exact durable saved commit before eviction. A new turn never supersedes
saved work. Partial-work rescue also records its
commit before pushing it. A push failure never dispatches a second paid turn.

The worker push callback, push-specific capability, HTTP retry loop and separate
`worker-push` machine are removed. Old worker images get a permanent 410 from
the retired endpoint and return their result; completion reconciles both old
`push_ok` values and the new commit-only result. OpenRouter build workers keep
a declaration-only capability for before/after-shot intent, with no Git write
authority. For one release, the declaration routes also verify old `worker:push`
tokens held by in-flight builds; new code never mints them, and they cannot
reach other purposes. The worker-callable PR endpoint also returns permanent 410, with
no authentication, database, Git or proposal side effects; conductor
finalization remains the supported creation path. New worker images require
the conductor completion path for sync; normal releases pin each conductor's
worker image alongside its code.

A context reset keeps the warm worker. It clears both resume ids, increments
the configuration version under the existing row lock, and records the reset
in the transcript. Backend, model and resume values are supplied on each exec;
worker replacement is not what makes model context fresh. Dispatch still
refuses stale configuration, and startup rescue still protects saved commits.

A promoted proposal's Pause queues `worker-release` work. The conductor checks
current owner, account, configuration, turn and last use under the shared worker
eviction lock, then removes only captured runtime identities and waits for them
to disappear. A captured turn that just ended can be released; a different
running turn is spared. A saved commit, including pending publication, prevents
removal until rescue is safe and succeeds. A captured running turn without a
saved commit retains its existing release behavior. The context volume stays.

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
Ordinary Stop refuses an active record without a journal, even if it has a
turn id, with 409 and no signal. Current turn producers always supply both;
such leftovers require investigation. Stop keys retain their format across
rolling deploys. Force-stop can still remove a captured worker for a record
with a turn id but no journal, with current-turn fencing and saved-work rescue.
A current turn whose journal file has vanished still uses the force-stop
recovery that removes its captured worker identity.
Ordinary Stop has no whole-worker strategy. Force-stop remains the separate,
identity-fenced fallback. Retry-time idle waiting performs I/O only on a
conductor and returns false without I/O when called on the web. The route-side
polling loop, local `confirming` flag and name-based stop shim are removed.
Older conductors leave this separate machine pending, so rollout can temporarily
return retryable 503s, with no web-side runtime fallback. This needs no schema
or runtime configuration change.

The hosted connector's headless-build handoff keeps the pushed branch, chat
and spec history, but no longer copies agent memory. The clone leaves
`cc_session_id` unset and creates no worker or memory-copy Job; submission
promotes it directly. The Docker and Kubernetes copy helpers are removed.

Code-host writes a person asks for over HTTP are **privileged operations**
(`src/workflow/platform-operation/`, `services/platform-operations.js`): one
machine for every typed operation, not one machine per write. The route keeps
the validation, checks and refusals it always had, then appends the operation
with the requester as its actor. Admission refuses a request that is not this
instance's, from another producer, or for an erased account or a missing
project. The conductor's work loads the requester as the auth middleware
would and reads its current authority and target again on every attempt,
before any write it still has to make; a check its own progress would trip
tells its own proposal or claim, as its steps record them, from a competing
one. A request refused part way, by its authority or its account, gives back
what it holds (an Undo claim it never linked). Each write is kept as a step
in the work item's checkpoint. A
retry or another conductor after a restart carries on from the last finished
step: a request's branch name is kept, its branch or PR found already made is
used, and its session or announcement is never made twice. A refusal is an
answer (`{ ok: false, status }`), never a retry. Other failures retry four
times within about twenty seconds, except a branch the host refuses, which is
answered at once with the host's reason (as these routes always answered), so
the same request asked again makes the same branch. A route waits up to a minute; an event
no conductor admits within five seconds is refused so it never runs later
(503), and one still running past the wait answers 503 `operation_pending`,
never a success, and finishes. Each operation is its own work kind, so a
conductor claims only the operations its build knows, and the machine admits
any well-formed `area.verb` name: during a rollout a conductor that knows an
operation's name leaves one newer than it queued for a newer conductor. A
build from before that rule refuses a name it does not know, so a release
that adds operations can see them refused while such a conductor still runs:
the caller answers 503 and gives back what it claimed. The operations are:

- `manifest.propose`: every settings proposal that edits dapp.json (rename,
  visibility, who decides, admins, governance, a secret declaration, topics),
  rechecked for its flavor's access, the self-app rule, a verified owner when
  it makes a project public, the repository the route saw and the open
  proposal it would duplicate. A secret declaration's value travels with it,
  encrypted with the data key as `pending_secret_declarations` keeps it, and
  is applied (a full admin's) or held for the merge on the conductor once the
  PR exists, so a proposal still opening when its route answers keeps it.
- `branch.ensure`: a native proposal start's `dev/cli-u<id>-…` branch at its
  exact base (a different existing ref is a 409 conflict), an issue's
  headless run, a clone of that run (off the source run's branch as the
  conductor reads it, else main), and a change's first-turn branch asked by a
  web process. A conductor's own work keeps making the first-turn branch
  itself, so no work item waits on another. Only `dev/` names are made.
- `fork.update` and `work.share`: a proposal revision or the first shared
  session, with current collab access, membership where required, ownership,
  linked login and capacity checked again. Pushes, PR metadata and revision
  tails are durable steps, fenced to the original repository, branch and
  pushed head. A share adopts its own inserted session after a lost reply.
- `work.submit` and `work.discard`: a new submission's patch or fork branch
  and PR, and a task's unused branch removal. The task holds its submission
  request until the web side imports its PR; HTTP retries adopt that request
  while the conductor continues; its completed answer is retained on the task
  beyond workflow receipt retention. Finished payload operations checkpoint their
  answer before deleting their input, so a lost acknowledgement cannot turn
  a completed submission into an expired one.
- `proposal.commit`: a local agent's tested commit rebuilt on its change's
  branch, from a CLI hand-off's upload (POST
  /api/sessions/:id/proposal-handoff/commits) or a local agent's build turn
  (POST /api/cli/agent/turns/:id/commit). Its message and files are the
  request's payload. The conductor reads again that the change is the
  requester's and open, a hand-off's collab access and that nothing else
  works on it, a turn's live lease and build turn, and the head the route
  expected, under the proposal lock for a hand-off; then the commit (the
  tested tree, moved only from that head), its record (the hand-off's
  upload, or the turn's head) and a hand-off's draft PR, each a step. A
  client asking again after its answer was lost finds its own commit on the
  branch and is answered 200 with that head. On the git host the commit is
  built in a scratch repository through `services/git-child.js`. A build
  submission no longer moves the branch: it reads it, and a branch elsewhere
  is a 409.
- `revert.open`: an Undo. The route records the request before it answers,
  and answers at once, as before; the conductor makes the revert branch, PR,
  promoted session and announcement, then refreshes the vote panel. A host
  failure is tried again from the last finished step; a conflict, or the last
  try, gives the claim back and says so in the thread. One Undo of a change
  runs at a time: its instance is keyed by the change, so a second click
  while one is under way is the same request, and a new one starts once it
  has finished. So a claim a try began but could not record before its
  process went is the retry's own, and adopted.
- `domain.check` and `domain.teardown`: a custom domain's check (DNS, the
  certificate probe and its Ingress) and the removal of its Ingress and
  certificate Secret, asked by the domain routes for a person who must still
  manage the project or be a full admin. The domain sweep and a teardown on a
  conductor write the edge themselves. A domain whose edge could not be taken
  down keeps its row and status (503, ask again), so a hostname is never
  released, nor a disabled one left routed, while its Ingress remains.
- `app.remove`: an app's whole teardown (previews, runtime, domain edge,
  database and files, then its row), asked by DELETE /api/apps/:slug and a
  test account's retirement after their gates and confirmations; the
  conductor checks again that the requester may delete it. A preview still
  retiring is answered as before (409, ask again in a minute).

- `openrouter.provision`, `openrouter.sync`, `openrouter.disable` and
  `openrouter.remove`: a company-funded OpenRouter key created, brought in
  line with its account's weekly allowance, disabled or deleted, with the
  management key. Web callers keep calling `openrouter-managed-keys.js`,
  which asks a conductor from a web process and acts itself on a workflow
  process; its one-key-per-account reservation, allowance and needs-review
  rules decide what is made, and its refusals are answers, so a provider call
  is never repeated. An account may ask for its own key and sync before it
  has platform access (a key is made as the account is created); disabling,
  deleting or syncing another account's key needs a full admin. A web read
  asks for a sync only when the key is out of line with the allowance. A
  provisioning retried after its key was issued and saved, but before its
  result was recorded, answers with that key rather than the refusal its
  reservation would give. Whether included keys are offered is the
  non-secret `OPENROUTER_MANAGED_KEYS_ENABLED` where the key is absent (unset,
  the key's presence answers), so a web process can run without the key.
- `pr.sync` (PR metadata): a change's pull-request title, body and linked
  issues written to GitHub, and its missing pull request opened, for the
  platform repository only. A git-host pull request is a row
  (`native-pulls.js`) and GitHub refuses every other owner before a request
  is sent, so those writes stay on web and need no credential. The
  description, linked-issues and title routes keep their checks and database
  writes (the first two under the proposal's lock, which they let go before
  asking: the conductor takes it itself), then wait for the write and answer
  the status it reports as before (one no conductor takes reads as GitHub
  unavailable, and asking again makes it). A Preview click's recovery on a
  web process and a clone of an unattended run append the create; it rechecks
  that the change is still open and the requester's, adopts a pull request
  already open for the branch, and is tried again while GitHub opens nothing,
  so a retry never opens a second one.

The git-host flows (services/git-host-flows.js) are the code-host writes the
routes of versions, the App bench studio and demo mode made themselves. Each
route keeps its doors and checks and answers as before; a patch or a text it
was sent travels as the request's payload:

- `suggestBack.open`: a version's changes sent to its original
  (services/suggest-back-operation.js), rechecked for the version's owner
  and membership, collab and membership on the original, the promoted cap
  and the one open suggestion; the patch is built and pushed, the PR opened
  and the proposal filed as steps, and a retry finds a proposal row its lost
  reply wrote.
- `upstream.open` and `upstream.skip`: a member's press on a version's
  update (services/upstream-operation.js), rechecked for view access and
  membership, then the clock's own `openUpdate` (and `skipUpdate`), whose
  plan and pushes, PR, row, promote and members told are steps.
- `bench.scaffold` and `bench.reference`: a studio reference build's first
  commit, asked for by its reference order with nobody waiting and claimed
  as the request's own, and a reference handed in (its trial, the patch's
  push or the branch's copy, its branch), both a full admin's
  (services/bench-reference-operation.js).
- `demo.propose` and `demo.reset`: demo mode's proposal (the patch's push,
  its PR, the partner's proposal and promote) and its reset (the PRs closed,
  the rows deleted, main forced back once, the deploy asked), rechecked
  against demo mode's fences (services/demo-operation.js). A reset's
  previews are retired by its route first, as before.

An account deletion's provider, worker and stored-file cleanups are the
`account-deletion` clock's alone, every minute on a conductor; the routes that
queue them no longer start a sweep of their own. With these, a web process
makes no Kubernetes write in production: its runtime calls are reads
(status, deployment state, logs, quotas, a preview's state).

Projects made inside a platform preview (services/preview-projects.js) are
operations too (`previewProject.create`, `.build`, `.deploy`, `.restart`,
`.remove`, services/preview-project-operation.js). Their routes still take the
preview's credential, check each request and claim the project's row; the
database, the source push, the build, the run, a restart and a removal are
the conductor's. A build's files and a deploy's env are kept beside the row
(`preview_project_inputs`), written in the transaction that claims it and
appends the request, since they weigh more than an operation's input; a
conductor must then take the request within five seconds, or it is refused
for good and the claim given back. The
requester is the session's author (any account): the preview's credential is
the authority, and the conductor reads again, before every step, that the
session is still a platform preview holding a live one. A step it refuses
ends as failed, so the preview stops waiting. So a web Pod can run as an
account with reads only (the chart's `platform.web.serviceAccountName`).

These move web dependencies behind durable commands. Web Pods need no
Kubernetes write and no OpenRouter management key: they can run as an account
with reads only, and the chart keeps the key in a Secret only the conductor
imports. Code-host write entry points and transports refuse web with
`workflow_role_required`, before credential lookup or outside I/O; native
pull-request metadata remains a database write. Git children use the isolated
`git-child` environment, including hosted-git mirror plumbing. Web still holds
code-host credentials for reads with write-capable tokens and the database's
admin login. Restricted read credentials and the role-specific Secret split,
then separate database logins, remain SEC-09 work. The event's source metadata
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
- Migrating all remaining infrastructure calls from routes. Turn publication
  runs on the conductor; other web-side calls still finish in their own process
  and need to move before privileges are split.
