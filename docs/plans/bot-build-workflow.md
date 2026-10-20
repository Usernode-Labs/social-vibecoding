# Bot builds on the workflow kernel

The Homeroom bot's builds and the App bench's trials run as one workflow
machine, `bot-build` (`src/workflow/bot-build/`). A restart no longer has
recovery code of its own to run for them: the build's work item outlives the
process, the next leader claims it, and the same code carries the build on
from the last step it saved. This replaces the checkpoint module
(`homeroom-bot-checkpoint.js`), the shutdown drain (`homeroom-bot-drain.js`),
the bot's and the bench's recovery paths (`completeRecoveredLive`,
`finishRecoveredLive`, `reviewRecoveredBuild`, `resumeStalledLiveBuilds`,
`finishInterruptedReviews`, `settleAbandonedLiveBuilds`; `handBackTrial`,
`goOnFromKept`, `settleCutShortReview`, `recoverStage`, …) and their branches in
`server.js` (`adoptBotOrphan`'s build paths, `adoptBenchOrphan`).

## Why

Coding turns already outlived a restart: they run detached in a worker, and
their journal is on the worker's volume. Everything between turns (moving to
the next step, captures, the reviewer, pushes, proposing) lived in the
leader's memory and was rebuilt after each restart from what had been saved,
by two copies of the recovery code, one for live builds and one for the
bench. Each restart bug of October 2026 was one of three shapes:

1. **Work that landed after the last save.** A detached turn kept going after
   the checkpoint (it pushed a fix, its journal grew), and recovery that
   re-established state from the checkpoint collided with it: it pinned a
   branch to the old commit (bench run 193), rolled a fix back (#4966),
   recorded "no change" (#4882).
2. **Two copies drifting.** Every resumable step was added to the live path
   and, days later, to the bench's (#4304, #5012, #5021).
3. **Tests that froze the world at the checkpoint.** No restart test had a
   worker that kept going after recovery read it.

## The model

```
 bot dispatch / bench-lane ─append Requested─▶ bot-build/run:<id> | trial:<id>
                                                    │ building
                                                    │ work: build.run (leased, resumable)
                                                    ▼
                               handler: the same pipeline, on a durable context
                                 once('session') once('spec') turn('spec')
                                 turn('build') once('landed') review… once('proposed')
                                                    │ WorkSucceeded / WorkFailed / WorkExhausted
                                                    ▼
                                            done | failed (build.lost records why)
```

- **One instance per build.** `run:<runId>` for a live build or a shadow
  build, `trial:<trialId>` for a bench trial. The state is a phase a person
  would recognise (`building`, `done`, `failed`); where the build is inside
  its pipeline is the work item's checkpoint, as the kernel's rules ask.
- **The work item is the build's owner.** It is claimed under a lease that
  is renewed while the pipeline runs. A restart ends the lease (the stopping
  process gives it up at once); the next leader claims it and runs the
  handler again with the last checkpoint. Nothing else adopts, holds or
  sweeps a build. Two processes can never both drive one build: the lease
  says who may, and every step after an abort is fenced.
- **Live and bench are one pipeline.** Both already ran `buildAndPropose`
  and the review loop; only their recovery differed. With recovery gone,
  the difference is what the target is: a live run proposes and posts, a
  shadow build and a bench trial never do, and a trial records itself on its
  row. The same steps resume the same way for all three.

## Durable steps (`src/services/durable-steps.js`)

The handler hands the pipeline a durable context over the work item's
checkpoint:

- `once(key, fn)`: a step that has run is not run again; its JSON result is
  saved and returned on the next attempt.
- `get` / `set`: state a step keeps as it goes (the review loop's state).
- `scope(prefix)`: a child context, for a first version's second try.
- `fence()`: throws once the lease is gone or the process is stopping, so a
  process that lost the build does nothing more for it.

Code that is not run by the kernel (tests, a person's dev chat) gets the
inert context, under which every step simply runs.

## Turns: attach or start (`src/services/durable-turn.js`)

A coding turn is the step that keeps going while nobody watches, so it is
the one that needs care:

1. Before it is dispatched, the step saves `{ started, deadlineAt }`.
2. The dispatch holds the worker's turn record (`holdTurnRecord`) and reports
   the record's identity as soon as it is written (`onTurnRecord`), which is
   saved too.
3. When the turn ends, its result is saved, and only then is the worker's
   turn record released (`worker.finishTurn`).

On the next attempt:

- a saved result is returned as it is (the record is released again, which
  does nothing if it already was);
- a turn record on the session that is this step's (its id, or any record
  of this step's mode when the restart came before the id was saved) is
  followed through its journal to its end, settled in the ledger, its clock
  re-armed from the saved deadline plus the restart allowance, and a push
  the restart caught re-pushed from the worker;
- no record: the outside world is read before anything is started again.
  A branch that moved past the commit the step started from means the turn
  landed and its record was lost, so its result is the branch tip. Only a
  branch that did not move is dispatched again.

A step never re-establishes the branch from saved state: the branch tip is
read, and what was saved is only a lower bound.

## Ownership outside the kernel

- A session a durable build opens carries `chat_sessions.workflow_owner`
  (`bot-build/<key>`). While that build is under way, `server.js` leaves the
  session's worker and its turn to it when it adopts workers at promotion,
  and the stale-turn watchdog passes it by. `worker.ensureWorker` keeps its
  worker on an older worker image until the build ends
  (`build-runs.holdsSession`): a replacement between two of its turns took
  a first version's workspace on 14 Oct 2026. A changed runtime contract or
  storage mode still replaces it.
- A step the platform refuses for now is not kept as its result. The
  proposal step tries a promote that answered 5xx again, then throws
  (`ProposalDeferred`) while the work item has a try left
  (`steps.triesLeft`), so the next try goes on from `prepared` and
  proposes; nothing is said meanwhile. On the last try it ends as it always
  did, built and not proposed.
- A turn this process is following itself (its worker registry, or the
  session busy here) is no orphan: a promoted follower no longer adopts the
  turns it started during a rollout's overlap.
- The lane's and the bot's sweeps leave a build's run or trial alone while a
  durable build owns it (`releaseStale` and `releaseOrphaned` in the lane,
  `releaseStaleBuilds` in the bot).

## Bench trials

The lane still decides which trials run (its caps and concurrency); a trial
it starts is a `trial:<id>@<claim>` instance, and `executeTrial` is the
handler's pipeline (`lane.runTrial`). Its stages run on the durable context
(`bench/runner.js`): the branch is cut once (`cutBranch`, never pinned again
on a later attempt, which is what bench run 193 got wrong), each session is
opened once and read back (`trialSession`), the triage, the spec, the build
and its review are steps, each turn is attached to or started, the screenshot
step runs detached and is harvested after a restart, a DM conversation keeps
each turn it finished, and the trial is recorded once. The lane holds the
slot of a trial whose build is under way wherever it runs
(`holdDurableTrials`). The checkpoint column now says only how often a
restart carried the trial on (`handBacks`, which the studio shows); the
hand-back, recovery and free-restart paths are gone. A trial that ran with no
workflow runtime is put back in the queue after a restart, as before.

## Verifying it

`tests/bot-build-crash-postgres.test.js` (with `tests/lib/bot-build-crash*.js`
and `tests/fixtures/bot-build-crash-fakes.js`) runs real builds in child
processes against the real schema and the real workflow runtime, with a
fake worker, GitHub, promotion and models whose state lives in the
database, so a turn under way keeps going (and pushes) after its process
is killed:

- a later change, a reviewed first version, a build from a kept plan, and
  a reviewed first-version bench trial each run once uninterrupted, and
  every durable save they make is numbered;
- each is run again and SIGKILLed before and after each save, at the
  fakes' own points (a turn registered, a turn under way, a comment made,
  a pull request opened, a first commit made) and with a clean stop at
  each turn; a new child takes the build over;
- the end is compared with the uninterrupted run: the same outcome and
  proposal, one pull request and one promotion, the same posts and
  comments, at most one debit, the branch at the same tip, the same turns
  per step, a trial recorded and charged once; and nothing is left running
  or held (no work item, turn record, ledger attempt or extra session).

Run 193's shape (a fix turn still running when the next process attaches),
a refused push re-sent from the worker, and two restarts in a row have
points of their own. Under `npm test` the suite stops starting points after
150 s; `BOT_BUILD_CRASH_BUDGET_MS` runs them all (367, about three and a
half minutes on four lanes). `tests/durable-steps.test.js`,
`tests/durable-turn.test.js`, `tests/build-runs.test.js` and
`tests/workflow-bot-build-platform-postgres.test.js` cover the pieces.

## What is not on the machine

The bot's reads (triage), its follow-ups and checks fixes on its own
proposals keep their own paths (its DMs and its voice are the `bot-dm` and
`bot-voice` machines, docs/workflows.md): a read that a restart cuts is
read again from the queue, and a follow-up finishes through its proposal's
tail as before.
