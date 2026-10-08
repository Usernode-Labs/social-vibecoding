# Workflows

Homeroom runs a number of long-lived processes: a governance proposal waits for votes and
then applies, a preview builds and runs its checks, a merge sets off a list of follow-ups.
`src/workflow/` runs them as **persistent state machines on PostgreSQL**. Each process
(an *instance*) has one row holding its state, one ordered stream of events that change
it, and one code path that applies those events. Everything it does to the outside world
is a durable work item whose result comes back as another event.

Governance proposals are the first machine (behind `WF_GOVERNANCE_ENABLED`) and merge
follow-ups the second (behind `WF_MERGE_FOLLOWUPS_ENABLED`). The others move over one at a
time.

## What it solves

Before this, each of these processes was spread over several places that each decided a
little: the route that took the vote, a 60-second ticker, an hourly sweeper, in-memory
timers, and fire-and-forget calls after a commit. Governance proposals showed the
typical problems:

- **Decisions made outside the lock.** The vote gate was computed, then the row was
  locked and written. A vote, the ticker and an admin could race on the same proposal.
- **Side effects lost on a crash.** The GitHub close, the comment and the chat line ran
  after the commit. A restart in between dropped them, with no record that they were
  owed.
- **States nobody owns.** A proposal that could not be applied (its image gone, its key
  unwritable) stayed open forever, retried by every sweep.
- **No history.** There was no record of why a proposal was in its state, or what had
  been tried.

The workflow kernel answers each one with a rule:

| Problem | Rule |
|---|---|
| Decisions made outside the lock | One code path changes state, one event at a time, under the instance's row lock. |
| Side effects lost on a crash | External calls are durable work items, committed with the decision that asked for them. |
| States nobody owns | Every state is declared, and every (state, event) pair is either handled or explicitly ignored. |
| No history | Every event stays in the stream with its result, its reason and the state before and after. Admin → Workflows shows it. |

## The model

```
 routes ──────────┐  append an event (and wait briefly for its outcome)
 services ────────┤  append work results
 timers, messages ┤
                  ▼
            ┌───────────┐     ┌──────────────────────────────────────────────┐
            │ wf_events │ ──▶ │ pipeline slots (any number, any process)     │
            │ (stream)  │     │ one event per transaction, under the         │
            └───────────┘     │ instance's row lock:                         │
                  ▲           │ replay check → facts → authorise → guard →   │
                  │           │ transition → persist                         │
                  │           └───────────────┬──────────────────────────────┘
                  │                           │ work items
                  │                     ┌─────▼─────┐     ┌───────────────────────┐
                  └──── result events ──│  wf_work  │ ──▶ │ services: GitHub,     │
                                        └───────────┘     │ rebuilds, … (all I/O) │
                                                          └───────────────────────┘
```

- **Only the pipeline changes machine state.** Routes, services, timers and other
  instances *append* events to `wf_events`. Nothing else writes `wf_instances` or the
  legacy columns a machine owns, and the database enforces it (see
  [Ownership](#storage-projections-and-ownership)).
- **Serial within an instance, concurrent across instances.** A slot locks one instance
  row (`FOR UPDATE SKIP LOCKED`) and applies its oldest pending event. Other slots, in
  this process or another, skip that instance and take others. Correctness comes from the
  row lock, not from which process is the leader.
- **Transitions never wait on the outside world.** They read the database, decide, and
  write the database. Each transaction runs with a 2 s lock timeout and a 5 s statement
  timeout.
- **Everything commits together.** The new state, the domain writes (a vote row, an app's
  new name), the legacy projection, the receipt, the work items, the messages and the
  event's own result commit in one transaction, or none of them do.
- **One instance per transaction.** An effect on another instance is a *message*: an
  event appended in the same transaction and applied later, in that instance's own
  transaction. State that must change together belongs to one machine.

### Vocabulary

| Term | Meaning |
|---|---|
| **Machine** | The code for one kind of workflow, such as `governance-proposal`: states, events, transitions, writes, projection. |
| **Instance** | One occurrence, such as `governance-proposal` / `issue:42`. One row in `wf_instances`, with its state, data, version and at most one deadline. |
| **Event** | A data-only request to change an instance (`VoteCast`, `Withdraw`). It has a type, a payload, a source, an actor and a request key. |
| **Source** | Who produced the event: `route`, `service`, `timer`, `message`, `admin` or `system`. |
| **Request key** | Identifies the request behind an event, so a retry is recognised as the same request. |
| **Facts** | What a transition reads from the database inside its transaction: the issue row, vote counts, settings. |
| **Guard** | A pure check that accepts the event or rejects it with a reason, such as `not_open` or `reason_required`. |
| **Outcome** | What a transition returns: the next state, plus writes, work, messages, a timer and notifications. |
| **Work item** | A durable request for I/O, run by a service. Its result returns as an event. |
| **Projection** | The legacy columns (`issues.status`, audit fields in `issues.payload`) written from the machine's state in the same transaction, so existing readers keep working. |

## The life of an event

**Producing.** `runtime.append(machine, key, { type, payload }, { requestKey, source,
actor, appId })` decodes the payload against the machine's declared events, inserts one
row into `wf_events` and notifies the slots. An undeclared type is refused right there
(`unknown_event`). A route that needs an answer calls `appendAndWait`, which waits up to
3 s for the outcome. If the outcome is not there yet, the route answers `202` with the
request key, and a retry with the same key returns the original result once it exists.

**Answers.** A route answers from the outcome's `reply`, never by reading the tables
afterwards. A machine that answers routes defines `reply(tx, event, after, ctx, facts)`:
- **When it runs.** In the event's transaction, after the writes and the projection. It
  gets the facts the transition decided on, so an answer they already hold needs no
  query.
- **Where it is stored.** With the event and its receipt.
- **On a replay.** A replayed request returns the stored reply. A route that reads the
  tables later would describe today's state instead (a vote since retracted, counts
  that moved on).

**Consuming.** A free slot:

1. picks the oldest pending event that is its instance's head (the instance's oldest
   pending event), not in backoff, of an instance that is not faulted;
2. locks the event, skipping any another slot holds (`SKIP LOCKED`), then its instance's
   row, which is what keeps two slots from processing one instance at once. An event
   appended in a caller's transaction can commit after a later one, so two slots can
   hold two events of one instance; the second waits for the first's row lock, then
   reads the receipt again. An instance with no row yet first gets a placeholder row in
   the pseudo-state `(none)`, so its first events are serialised the same way;
3. leaves it alone if a newer machine version last wrote the instance (old and new code
   overlap during a deploy);
4. runs one transaction for that event:
   1. **Replay check.** If a receipt exists for this request key with the same payload, the
      event is `replayed` with the original outcome. Nothing else is evaluated. A
      different payload under the same key is `rejected: request_key_conflict`.
   2. **Facts.** The machine's read-only queries.
   3. **Authorise, then guard.** A rejection marks the event `rejected` with its reason
      and writes **no receipt**, so a later retry with the same key can still succeed.
   4. **Transition.** It returns the outcome, and the next state must be declared.
   5. **Persist,** in this order: domain writes, projection, the machine's reply, work
      items, messages, then the instance row, receipt and the event's own result in one
      statement. A placeholder row whose event is rejected is deleted again.
5. commits, then wakes whoever waits for the outcome and runs the notifications (WebSocket
   pushes, which may be lost in a crash because the next read refreshes the client).

**Round trips.** A producer waits on every query of the transaction, so the kernel keeps
its own to three: one batch opens the transaction and picks (`BEGIN`, the writer marker,
the timeouts, the pick with its receipt and the clock), one statement records the
outcome, then `COMMIT`. A route registers for the outcome's notification before it
appends, so it reads the outcome once, when it is there. The rest is the machine's: keep
its facts to as few queries as the rules allow, and fold a write and what goes with it
into one statement. `tests/workflow-query-budget-postgres.test.js` counts the queries of
a governance vote and fails above its budget.

A failed event (a timeout or a throw) rolls back whole. Its failure is recorded in a
transaction of its own, after locking the event again and checking it is still the one
the slot saw.

Every event ends with one of these results: `accepted`, `rejected` (with a reason),
`replayed` or `faulted` (with the error).

## Work items and services

A transition asks for I/O as data, for example
`{ kind: 'github.closeIssue', key: 'close', input: { owner, repo, number, comment } }`.
The work row commits with the decision. Re-emitting the same `key` on the same instance
creates nothing new.

A service is a `WorkHandler` registered for a kind:

```ts
'github.closeIssue': {
  maxAttempts: 5,                        // default 5; an error with `permanent: true` is not retried
  async run({ input, resumeFrom, checkpoint, signal }) {
    if (!resumeFrom?.closed) { await closeIssue(input); await checkpoint({ closed: true }); }
    await comment(input);                // a retry after the checkpoint never closes twice
    return { closed: true };
  },
}
```

- **Claim.** A service loop claims work with `FOR UPDATE SKIP LOCKED` and a lease (60 s by
  default, renewed while it runs). If the lease is lost, the handler's `signal` aborts and
  the attempt reports nothing. The next claim resumes from the last checkpoint.
- **Report.** The service appends a result event to the owning instance, with `workId`,
  `kind`, `workKey`, `attempt` and the result or error:
  - `WorkSucceeded` when the handler returns;
  - `WorkFailed` at once for an error marked `permanent: true`;
  - `WorkExhausted` when the attempts run out. Until then, any other error is retried
    with backoff.

  The instance decides what each result means.
- **Settle.** The pipeline settles the work row in the same transaction that applies the
  result. A result the instance no longer expects is rejected (`stale_result`) and still
  settled.
- **A lease does not fence the outside world.** An earlier attempt may still be running,
  so handlers checkpoint before creating anything and treat "already done" (a 404 or 410
  on a close) as success.
- **A retry the machine asks for keeps the progress.** A work request may name an earlier
  item of the same kind with `continues: '<work key>'`. The new item then starts from that
  item's last checkpoint, so a manual retry of a close that already commented does not
  comment again. Without `continues`, a new key starts fresh.

## Timers and messages

- **Timers.** An instance has at most one deadline. An outcome sets it
  (`timer: { at, event }`), clears it (`null`) or leaves it alone (`undefined`). A timer
  loop appends the stored event when the deadline passes, with request key
  `timer:<version>`, so a deadline fires at most once per instance version. The
  governance machine uses it for the vote window and for a 10-minute backstop that
  catches changes no event announces, such as the electorate shrinking.
- **Messages.** `messages: [{ to: { machine, key }, event }]` appends events for other
  instances in the same transaction, with `caused_by` pointing at the cause. They cannot
  be lost and cannot deadlock. They arrive in order per target, and a rejection shows on
  both timelines.

## Failures

| What happens | Where it shows | What to do |
|---|---|---|
| **Lock or statement timeout, serialisation failure, deadlock** | The event goes back to pending with a backoff. After 5 in a row the instance is flagged `stalled`. | Usually nothing: it clears when the contention does. |
| **The transition throws** (a bug, a broken invariant) | The event is `faulted` with the error, the instance is flagged `faulted`, and its later events are `held`. Every other instance keeps going. | Fix the cause, then in Admin → Workflows **release** the instance: *retry* the faulted event, or *skip* it. |
| **Work exhausts its attempts** | The instance receives `WorkExhausted`. The problems panel lists it. | The machine decides. For governance, an admin can retry a follow-up. |

Machine code gets a query-only transaction handle. It cannot `BEGIN`, `COMMIT` or
`ROLLBACK`, and a query error that the machine code catches and ignores still fails the
event.

## Admin → Workflows

`#admin/workflows` (`frontend/src/features/admin/admin-workflows.tsx`, backed by
`src/routes/admin-workflow.js`) shows:

- **Problems first:**
  - faulted or stalled instances, with their held events;
  - work that is exhausted or overdue.
- **Counts per machine and state.**
- **An instance list,** which can be filtered.
- **One instance's timeline:** every event with its source, actor, result, reason, the
  transition it made, its cause and what it emitted, plus its work items and the state
  data.
- **Actions** (full admins, runtime running). The admin view never edits rows. Each
  action is an event on the timeline, like any other:
  - release a faulted instance;
  - "Re-check now" (`Evaluate`);
  - "Apply" (`AdminApply`);
  - "Retry follow-up".

## Storage, projections and ownership

All of it is in `src/db/schema.sql`. The tables are `staging:private`.

| Table | Holds |
|---|---|
| `wf_instances` | One row per instance: `state`, `data`, `version`, `machine_version`, the deadline, the `faulted` / `stalled` flag. |
| `wf_events` | The stream and, once processed, each instance's history. |
| `wf_receipts` | Outcomes of accepted requests, for replay. |
| `wf_work`, `wf_work_attempts` | Work items and each attempt at them. |
| `wf_settings` | Settings the triggers read: `ownership_mode`, `enabled:<machine>`. |
| `wf_ownership_violations` | Writes to owned columns that `log` mode let through. |

**Retention.** The pipeline purges every hour:
- processed events after 90 days;
- settled work after 90 days;
- receipts 30 days after their instance ends.

Instances keep their latest state indefinitely.

**Projections.** Existing readers (API, frontend, `dapp.json` checks) keep reading the
legacy columns. The machine's `project` writes them in the transition's transaction, so
they cannot drift from the instance.

**Ownership.** Every pipeline transaction runs `SET LOCAL app.wf_writer = 'transition'`.

- **Kernel tables.** Triggers refuse writes to them made without that marker.
- **Legacy columns.** A machine claims the legacy columns it owns with
  `wf_guard_owned_columns()`, for example on `issues`:

  ```sql
  CREATE TRIGGER issues_wf_governance_owned BEFORE UPDATE ON issues FOR EACH ROW
    WHEN (OLD.kind IN ('secret_change', 'rename', ...))
    EXECUTE FUNCTION wf_guard_owned_columns('@enrolled=governance-proposal/issue:', 'status',
      'payload.appliedAt', 'payload.appliedBy', 'payload.withdrawnAt', 'payload.supersededAt');
  ```

  - The `@enrolled=` argument limits the guard to rows that have an instance, and only
    while `wf_settings` has `enabled:<machine>`.
  - The `@enabled=<machine>` argument guards every row the trigger's `WHEN` selects, only
    while the machine is on, enrolled or not. merge-followups uses it for the move of a
    proposal into `merged`, which is what enrolls the row:

    ```sql
    CREATE TRIGGER chat_sessions_wf_merged BEFORE UPDATE ON chat_sessions FOR EACH ROW
      WHEN (OLD.status IS DISTINCT FROM 'merged' AND NEW.status = 'merged')
      EXECUTE FUNCTION wf_guard_owned_columns('@enabled=merge-followups', 'status');
    ```
  - In `raise` mode, a write from anywhere else is refused. That is the default outside
    production, so a forgotten legacy writer fails a test.
  - In `log` mode, the write is allowed and recorded in `wf_ownership_violations`. That is
    the production default until the machine's old paths are deleted.

## Writing a machine

A machine is a folder under `src/workflow/<machine>/`:

| File | Holds |
|---|---|
| `machine.ts` | The definition. |
| `facts.ts` | Its reads. |
| `services.ts` | Its work handlers. |

`src/workflow/governance-proposal/` is the reference. The definition is a plain object
that `defineMachine` validates once and turns into `Map`s:

```ts
defineMachine<State, Facts>({
  name: 'governance-proposal',
  version: 1,                         // bump when the shape of `data` changes
  events: { Filed: decodeFiled, VoteCast: decodeVote, ... },   // decoder per event type
  create: ['Filed'],                  // events that may create the instance
  terminal: ['applied', 'refused', 'withdrawn', 'superseded'],
  decode: (row) => ({ name: row.state, data: row.data }),
  facts: (tx, state, event, ctx) => readFacts(tx, ...),
  authorize: { VoteCast: (e) => (e.source.kind === 'route' ? ok() : reject('not_the_voter')), ... },
  transitions: {
    '(none)': { Filed: { guard, to } },                 // the instance does not exist yet
    open: { VoteCast: { guard, to }, Filed: { ignore: 'already_filed' }, ... },
    applied: { '*': { ignore: 'not_open' }, WorkSucceeded: { guard, to }, ... },
  },
  writes: { vote: writeVote, chat: writeChat, apply: applyKind },   // named domain writes
  project: async (tx, before, after) => { /* UPDATE issues ... */ },
  reply: async (tx, event, after) => ({ result: ... }),   // the routes' answer, replayed as recorded
  notifiers: { issueUpdate, ... },    // post-commit pushes
});
```

`defineMachine` refuses a definition where:
- a state neither handles nor ignores one of the machine's events (`'*'` ignores the
  rest);
- an event has no `authorize` rule;
- a table names an undeclared event;
- a terminal state or a creating event is not declared.

A type the machine does not declare, including inherited names such as `toString`, is
always `unknown_event`.

**Rules:**

1. **Transitions are pure.** They take `(state, event, facts, ctx)` and return an outcome.
   They make no I/O and do not read the clock: use `ctx.now`, the transaction's time.
2. **Facts are cheap, bounded, indexed queries.** Lock a row with `FOR UPDATE` when
   something outside the machine can still decide it (the governance machine locks its
   issue row).
3. **External I/O is work, and its result is an event.** Anything a person or another
   system relies on (a GitHub call, an email) is work. Only WebSocket refreshes are
   notifications.
4. **States are phases a person would recognise.** I/O progress belongs in the work
   item's checkpoint, not in more states.
5. **Rejection reasons are stable snake_case codes.** They appear in the admin view and in
   API answers.
6. **Terminal states still accept work results,** so follow-ups can report after the
   instance has finished.
7. **One instance per transaction.** Reach other instances with messages.
8. **A machine replaces its old paths.** Once its flag is the default, the old code is
   deleted.

**Wiring it in.** `src/workflow/platform.ts` owns the process's runtime: its own pool,
the machines, the services and the boot backfill. It also exports the helpers routes
call (`voteOnProposal`, `withdrawProposal`, …), which map outcomes and rejection reasons
to HTTP answers. Routes keep their request checks (session, membership, input), then
append and answer with the outcome.

## Running it

**Where it runs.** The runtime has two parts, which can run in different processes:
the **pipeline slots**, which decide (apply events, write projections, run the
post-commit notifiers), and the **loops**, which act (timers, retention, service loops
that run work items, and the boot backfill).

- **Every web process** records its flags in `wf_settings` at boot (`startWorkflow` in
  `server.js`). With a flag on, it also starts the runtime on its own pool
  (`application_name` `homeroom-workflow`), listens for outcomes so routes can wait for
  them, and runs pipeline slots. A Pod that is not the leader (the new one, during a
  rollout) therefore applies its own events at once instead of answering `202`. With
  every flag off, nothing else starts.
- **The loops** run in one of two places, chosen by `WF_LOOPS`:
  - `leader` (the default): the web Pod holding the leader lock runs them
    (`startWorkflowLoops` in `becomeLeader`). A staging preview, which never stands for
    election, runs them itself.
  - `worker`: the **workflow worker** runs them (`workflow-worker.js`, the chart's
    `workflow.worker.enabled`), and no web Pod does.
- **The backfill** enrolls open rows the machine does not hold yet. A route that meets
  an open row the machine does not hold enrolls it itself.
- **Waking.** Each `wf_events` notification wakes one slot in each process. Idle loops
  sleep until a notification, the next thing they know is due (an event's backoff, a
  deadline, a work item), or a 30-second fallback; nothing polls every second. A
  transition that sets a deadline announces it on `wf_timer` with the time, in the
  statement that ends the event. The timer loop wakes only for a deadline earlier than
  the one it sleeps until, so a vote that re-arms the 10-minute backstop costs it
  nothing. The fallback only covers a lost notification.
- **A staging preview** has no GitHub credentials and no app fleet, so its work items
  fail and show in Admin → Workflows, where [main]'s inline calls only failed in the
  logs.

Correctness does not depend on where any of this runs: instance row locks decide who
applies an event, and work claims are leased row locks.

**The workflow worker** (`workflow-worker.js`) is a process with no HTTP app. It runs
the shared bootstrap the web process runs (`src/services/process-bootstrap.js`: phone
push, GitHub, the LLM, and the module-level hooks), then the runtime with its loops and
no slots (`startWorkflow(config, { loops: true, worker: true })`), and serves only
`/health` on 8081. What it means for the code:

- **Results are decided on the web Pods.** A work result the worker appends is applied
  by a web Pod's slot, within one wake-up. Notifiers run there too, beside the process
  state some of them use (the merge queue's kick, Workshop placement, a campaign
  start). The worker never applies an event.
- **Browser pushes go over the bus.** The worker starts the WebSocket bus as a
  publisher only (`ws.startPublisher`): every `broadcast*`, `pushToUser` and session
  event it makes is published on `usernode_ws` for the web Pods to deliver. It
  subscribes to nothing.
- **No handler may rely on another process's memory.** What used to be per-process and
  is reached from work handlers now travels the bus or is read from the database:
  - GitHub's open-issues cache and closed-issue suppressions (`noteIssuesClosed`,
    `unsuppressIssues`, `invalidateIssuesCache` publish `github_issues`);
  - a turn's pending stop (`worker.stopTurn` publishes `worker_stop`, and the process
    running the turn records it);
  - whether a shots run holds a proposal's worker (`worker.retire` reads `shot_runs`
    and waits for the run);
  - whether an included change is busy (`included.find` pins the head it found, and the
    `Included` guard refuses a change whose head moved, `head_moved`).
  A new handler follows the same rule: state it needs from a web process goes through
  the database or the bus.
- **It records no booted build.** `apps.booted_shas` is what served; the worker serves
  nothing, and a worker rolled out ahead of the web Pods would otherwise make a platform
  release read live early.

### In production (Kubernetes)

- **The workloads.** Production is the `social-vibecoding-platform` Deployment, deployed
  by Argo CD from the Helm chart in `deploy/helm/` with values from the infra repository.
  It runs one replica (`platform.replicas`).
- **During a rollout.** Old and new Pods serve together for a short time
  (`maxSurge: 1`). `PLATFORM_LEADER_LOCK` lets only the Pod holding the Postgres advisory
  lock run background work, the workflow loops included unless the workflow worker
  runs them (`workflow.worker.enabled`, `docs/kubernetes-operations.md`).
- **Schema.** The `wf_*` tables and triggers come from `schema.sql`. The chart's
  migration Job applies it before the Deployment rolls.
- **Connections.** The runtime's pool adds `WF_POOL_MAX` connections per Pod while a
  flag is on, beside the main pool's `DB_POOL_MAX`. The workflow worker has both too,
  its `DB_POOL_MAX` set by `workflow.worker.dbPoolMax` (10).

| Variable | Default | Set in production by | Meaning |
|---|---|---|---|
| `WF_GOVERNANCE_ENABLED` | `false` | Helm value `platform.workflowGovernanceEnabled` | The governance-proposal machine decides governance proposals. The ticker and the sweeper's Pass 0b leave them alone. |
| `WF_MERGE_FOLLOWUPS_ENABLED` | `false` | Helm value `platform.workflowMergeFollowupsEnabled` | The merge-followups machine runs what follows a merge. The follow-up recovery sweep stands down, and a change reads live only once production runs it. |
| `WF_SLOTS` | 4 (1 on a staging preview) | the default | Pipeline slots in each process. |
| `WF_POOL_MAX` | 6 (2 on a staging preview) | the default | Connections in the runtime's own pool, the outcome listener's included. Keep it above `WF_SLOTS`. |
| `WF_OWNERSHIP_MODE` | `log` in production, `raise` elsewhere | the default | What a write to an owned column from outside the machine does. |
| `WF_LOOPS` | `leader` | the chart: `worker` on the web Pods while `workflow.worker.enabled` (on by default) | Where the loops run: the leader web Pod, or the workflow worker. |

**Where the variables are set.**
- **The Helm chart.** A Kubernetes Pod gets only the variables the chart lists, so a
  variable an operator needs to change is a chart value.
- **`platform_env`.** All six are also declared in `dapp.json`'s `platform_env`, as
  the platform requires of every variable it reads. Values stored through the Platform
  variables panel only ever reached the retired VPS deploy.

**Turning a machine on or off.** Change its chart value in the infra repository; Argo CD
rolls the Deployment. `docs/kubernetes-operations.md` has the procedure for the
governance machine.
- **The settings.** The flag a process records in `wf_settings` at boot arms the
  ownership trigger.
- **The rolling deploy.** While old and new Pods overlap, an old one may still decide a
  row the machine also decides. Both sides lock the row, so whichever commits first wins
  and the other stands down. The machine ends such an instance `superseded`
  (`closed_outside`). Until the new Pod becomes leader, its routes answer `202` with the
  request key: the event is recorded and applied once the loops start.
- **Turning it off and on again** is safe:
  - a row decided or deleted while the flag was off ends its instance without being
    applied twice;
  - the trigger guards only while the flag is on.

## TypeScript

`src/workflow` is plain TypeScript run directly by Node's type stripping (Node 22.18+ or
24). There is no build step and there are no generated `.js` files.

- **Module format.** The folder is ESM (`src/workflow/package.json`), and imports name
  their `.ts` extension.
- **Allowed syntax.** Only erasable syntax: no enums, no namespaces, no parameter
  properties.
- **CommonJS interop.** CommonJS code loads it with `require('./src/workflow/platform.ts')`.
  In the other direction, workflow code reaches CommonJS services through
  `legacy('services/…')` (`src/workflow/legacy.ts`).
- **Checks.** `npm run check:types` type-checks it against `tsconfig.server.json`.
  `tests/workflow-types.test.js` pins the setup, including the Node version of every
  Docker stage.
- **Collections.** Lookup tables are `Map`s and `Set`s, never plain objects indexed by
  string. A plain object is fine as authoring syntax (converted once, as `defineMachine`
  does) and for JSON data.

## Testing

| Suite | Covers |
|---|---|
| `tests/workflow-kernel-postgres.test.js` | The kernel's guarantees (K1–K17) against real PostgreSQL. |
| `tests/workflow-kernel-machine.test.js` | Definition validation. |
| `tests/workflow-governance-postgres.test.js` | The governance machine, one subtest per guarantee (G1–G13), plus the rollout cases. |
| `tests/workflow-governance-routes-postgres.test.js` | The routes with the runtime on. |
| `tests/workflow-governance-services.test.js` | The governance work handlers. |
| `tests/admin-workflows.test.js` | The admin section. |

The kernel guarantees cover:
- replay;
- no partial commit;
- fault isolation;
- timeouts;
- leases;
- bounded retries;
- message order;
- timers;
- two processes running at once;
- the mixed-version rule;
- ownership.

The PostgreSQL suites create a throwaway database. Set
`TEST_DATABASE_URL=postgres://…` to run them; without it they skip.

A new machine brings the same two layers:

- **One subtest per guarantee** it promises, against real PostgreSQL.
- **A route test** that goes through the running runtime.

## Machines

| Machine | Instance | States | Status |
|---|---|---|---|
| `governance-proposal` | `issue:<id>`, for the five governance kinds (rename, secret change, close issue, maintenance campaign, featured illustration) | `open` → `applied` / `refused` / `withdrawn` / `superseded` | Behind `WF_GOVERNANCE_ENABLED` |
| `merge-followups` | `session:<id>`, for each merged proposal and each change that went live inside one | `delivering` → `live`, or `deploy_failed` → `live` | Behind `WF_MERGE_FOLLOWUPS_ENABLED` |

### merge-followups

What a merged pull request still has to do once GitHub has merged it
(`src/workflow/merge-followups/`).

- **Created by `Merged`.** `checkAndMerge` appends it right after GitHub's merge, and
  `recoverStuckMerges` appends the same event when it finds on GitHub a merge whose own
  report was lost. Either way the merge gets every follow-up.
- **One transaction with the merge:**
  - the move into `merged` (with `merge_commit_sha` and the vote snapshot);
  - the secret values the proposal declared;
  - `PR_MERGED`;
  - the bounties, with their events and lines.
- **Durable work for the rest:**
  - `app.deliver`: the production rebuild, for a child app;
  - `preview.teardown` and `worker.retire`;
  - `included.find`, then an `Included` message to each change it carried, which gets
    its own instance;
  - `issues.closeAfterMerge`: the issue-close watcher;
  - `main.check`: the unit suite on the merge commit;
  - `bot.requestMerged`.
- **Merged, then live.** The change is `live` once production runs a build that contains
  it: its own delivery, or a `Deployed` report checked against GitHub
  (`delivery.verify`). Every successful `rebuildProduction` reports one, and so does the
  platform's own release, at boot.
  - Only then are these written: `chat_sessions.live_at`, the "is live" line, the
    author's notification, the requester's DM and the journey record.
  - Until then the change reads merged and going live.
- **A failed deploy** ends in `deploy_failed`, said in the thread. Any later deploy that
  contains the change makes it live, and so does **Retry delivery** in Admin → Workflows.

**Planned order:**
1. **Previews and required checks.**
2. **Before/after shots.**
3. **The proposal lifecycle.**
4. **The merge itself:** the attempt, the queue, production delivery and conflicts.
5. **Fleet campaigns.**

Each one deletes the old paths it replaces once its flag is the default.
