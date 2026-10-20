# Shots evals: trying the shots agent on merged proposals

A shots eval reruns the shots agent on proposals that have already merged,
once with the live agent and once with each configuration being tried. You
then compare the two sets of shots for the same proposals, the way you can
compare the Homeroom bot's configurations on first versions. It is driven
from the admin connector. Nothing in it touches a proposal's own shots, and
it never spends a proposal author's allowance.

- Service: `src/services/shots-eval.js` (configurations, launch, results,
  blind pairs).
- Trials: the `shots-eval` machine (`src/workflow/shots-eval/`), which
  grants them and runs each one's phases as workflow work, in any process.
- Routes: `src/routes/shots-evals.js` (`/api/shots-evals`, the connector's
  doors).
- Tables: `shots_eval_configs`, `shots_eval_runs`, `shots_eval_trials`,
  `shots_eval_artifacts` and `shots_eval_pairs` (`src/db/schema.sql`).

## The pieces

- **The live agent** is what every proposal's shots are taken with now: the
  model from `SHOTS_AGENT_MODEL`, the time budget from `SHOTS_MAX_AGENT_MS`,
  and the prompts in `shots-agent.js`. It has no row in the tables. Every
  eval runs it as its **control**.
- **A configuration** is one immutable version of a recipe that changes some
  of those settings:
  - `model`: a Claude model id.
  - `systemPrompt`: the whole system prompt, used instead of the live one.
  - `guidance`: text added after the system prompt.
  - `taskPrompt`.
  - `agentMinutes`: 2 to 20.

  Saving again under the same key makes the next version. A configuration
  runs only in an eval. Changing what the live agent does is still a code
  change.
- **An eval** is a batch of merged proposals (at most 25). Each one is shot
  by the control and by each configuration (at most 4), `repeats` times (1
  to 3), at most 75 trials, within a cap.
  - Each proposal's revisions and declared changes are frozen at launch from
    its own published run, so every arm shoots the same thing.
  - The copies are made from today's data, not the data the published shots
    saw. That is why the control runs again in the same batch: a
    configuration is compared with that control. The published shots are
    kept as a reference only.
- **A trial** is one proposal shot once by one arm.
- **A blind pair** puts a configuration's trial beside the control's trial
  of the same proposal and repetition, in a random order.

## How a trial runs

The machine starts at most `SHOTS_EVAL_CONCURRENCY` trials at once (default
2, at most 4), whichever processes run the workflow. It never runs two trials
on one proposal at the same time, and never runs one beside the proposal's own
shots run.

A trial runs the steps of the real pipeline, each a work item of the machine:
the two exact revisions are built and the data copied (`eval.copies`), the
shots agent runs in the proposal's temporary worker (`eval.agent`), where the
screens differ is worked out and the files kept (`eval.compare`), and,
however it ends, everything it made is removed (`eval.cleanup`, tried again
until it is all gone). Each step has its own time limit. Three things are
swapped:

- **State.** It lives on the trial's row, written by the machine. The
  proposal's shots slot is never read or written, and nobody watching the
  proposal is told anything.
- **Files.** Its files go to `shots_eval_artifacts`. They are pruned
  `shots-gc.EVAL_ARTIFACT_DAYS` (30) days after the trial ends; the trial
  keeps its results.
- **Agent.** The agent runs with the arm's model, prompts and time budget.
- **Bill.** A trial's shots turn is owned by the machine's agent work, and
  that is how the Anthropic proxy knows it (`shots-eval.billFor`, reading the
  session's turn record, in any process): it sends the calls on the
  platform's key, gated only by the eval's cap, never by the author's
  allowance and never by the system budget that sync turns draw on. Each call
  is added to the trial. A call that would take the eval past its cap is
  refused, or cut off mid-stream. A person's own shots rerun of the same
  proposal is never billed to an eval.

What a trial costs is the larger of two figures: the proxy's count, and what
Claude Code itself reported. That cost goes on the trial and on its eval's
spend, once, when the trial's cleanup is done. It is not written to the author's
usage, the change's agent-cost ledger or the system budget.

The cap is checked before each trial starts, against what is spent plus, for
each trial still running, what it has spent so far or an estimate, whichever
is more: the 90th percentile of recent trials,
or $3 before there are enough of them. Trials already running when the cap
is reached are allowed to finish. Builds and database copies are the
platform's own and are not counted.

A cancel stops what runs (its work cancelled, its agent's turn stopped) and
cleans the trial up. A trial an older build's runner left during a release
(its heartbeat quiet for five minutes) is cleaned up and queued once more
under a fresh attempt id; after that it fails with `shots_eval_interrupted`. The GC's orphan sweeps
(checkouts and runtimes) and the preview database server's drain count a
running trial the way they count a running shots run.

## What counts

A trial counts in its arm's numbers when either:

- it is verified, or
- it failed because of what the arm did: no change was shot, a change was
  found broken, or the agent ran out of time
  (`shots-eval.COUNTED_FAILURES`).

Any other failure is the platform's (a build, a database copy, the worker
dying). It is counted apart on every arm alike, and a pair with such a side
is excluded. A pair where neither side has a ready change is excluded too.

`get_shots_eval` reports each arm's numbers:

- how its declared changes came out, and its ready rate with a 95% Wilson
  interval;
- cost, agent minutes and tool calls;
- from picked pairs:
  - its marks: does each ready change show its claim, and is it misleading;
  - for a configuration, its win rate against the control, with ties
    counted half.

## The connector procedure

The charter's `shots-evals` section is what a session follows:

1. Choose merged proposals with `list_recent_shots`.
2. Read the live prompts with `list_shots_configs` (`prompts: true`).
3. Save variants with `save_shots_config`.
4. Launch with `launch_shots_eval`. Ask the person first and say the cap.
   Over $100 needs `confirmLargeCap`.
5. Watch with `get_shots_eval`.
6. Pick the blind pairs with `get_shots_eval_pair` and
   `submit_shots_eval_pick`, before reading the labelled numbers.
7. Compare with `get_shots_eval` and `get_shots_eval_shots`. The latter
   shows one proposal's shots for every arm side by side, with the published
   shots first.
8. Iterate with `sameProposalsAs`.

For a run with no platform at all, see "Dry run on local builds" in
[before-after-shots.md](before-after-shots.md).
