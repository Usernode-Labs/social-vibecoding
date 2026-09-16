# Challenge scoring: automatic credits for the Season 2 challenges

Date: 2026-09-16
Status: Implemented (owner decisions 1-4 confirmed 2026-09-16)

## Problem

Nine challenges are live for the Pre Season 2 test week (templates 23–31 on
event 10). A person's progress on each is read from the points ledger
(`user_activities`) and, for blocks, from the newest leaderboard snapshot.
Today only two of the nine ever get ledger rows without an admin typing them:

- "Prove you're one real human" writes its own row from the ZKPassport
  completion endpoint.
- "Help run the network" is computed by the snapshot builder, but only when an
  admin calls `POST /api/v4/admin/leaderboard/aggregate` by hand.

The other seven are scored by nobody. Topochain used to do this with Laravel
"agents" ticked by cron (a Claude tool-use run or a JSON step-DAG per
challenge, admin-authored, emitting a points matrix). None of that was ported
and none of it is needed: the platform already holds every signal the nine
challenges depend on. This spec rebuilds the smallest thing that scores them.

## Goal and scope

One background job on the platform that, every few minutes, turns platform
activity into ledger rows for the challenges that are running, with the two
"graded on usefulness" challenges scored by a fixed Claude rubric.

Setup is a rule an admin creates on the programme console's Challenge
scoring screen: a name, one **measure** from the list the platform
implements, and the challenge it pays into. Target and points are left blank
unless the challenge's own numbers cannot be used.

What an admin composes is the CONFIGURATION of a measure, never its body.
That is the deliberate difference from the Laravel agents this replaces,
where a run was an LLM session or a JSON step-DAG an admin had authored:
those could not be reviewed or tested before a season, and two runs of the
same agent could pay differently.

First scope is exactly the nine current challenges. Anything the nine do not
need is out (see "Out of scope").

## What each challenge is scored from

All nine templates already carry `metric_target` (the count) and `reward`
(the points, as "500 pts" / "Up to 1,000 pts"), and a rule reads both unless
its own Target and Points override them. The measure names below are the
fixed list the platform implements; they are not stored on the template.

`metric_target` doing double duty is worth stating plainly, because
`metric_type` drives the progress rail and the two are different questions.
"Use apps for 10 minutes" wants a yes/no rail but the scorer still needs to
know that ten is the number, so that rule carries Target 10.

| Template | Measure | Signal on the platform | Rule | Ledger rows written | Points |
|---|---|---|---|---|---|
| 23 Try 3 apps | `TRY_APPS` | `app_activity` (seconds per user, app, day; the web shell flushes every 30 s of visible use) | An app counts once its summed seconds reach 30, from the challenge window start onward. Apps the person created are excluded. | One unit row per app, `source_key = app:<id>` | 0 on the first two, the full reward on the third |
| 24 Propose an app change | `PROPOSAL_SENT` | `chat_sessions.promoted_at` (set only by the human promote route in `src/routes/votes.js`) | First session of the person promoted at or after the window start | One completion row, `source_key = session:<id>` | Full reward |
| 25 Turn on block production | `BLOCK_PRODUCTION_ON` | `users.bp_requested_at`, `users.bp_released_at`, `epoch_stats` rows with the person's `user_id` | Any of: access requested, access released, or at least one epoch with won slots | One completion row, `source_key = block-production` | Full reward |
| 26 Connect X and GitHub | `CONNECT_ACCOUNTS` | `user_social_identities` (provider `github` or `x`) | One credit per provider linked | One unit row per provider, `source_key = provider:<name>` | reward ÷ target per row (250 each) |
| 27 Prove you're one real human | none (self-recorded) | Self-recorded by the ZKPassport endpoint | Scorer skips this kind | none | unchanged |
| 28 Help run the network | none (snapshot builder) | Snapshot builder | Scorer does not credit it; it triggers the aggregate on a cadence (below) | none | unchanged |
| 29 Use apps for 10 minutes | `USE_APPS_MINUTES` | `app_activity` | Summed seconds on dates inside the window reach 600, own apps excluded | One completion row, `source_key = window` | Full reward |
| 30 Get a proposal accepted | `PROPOSAL_ACCEPTED` | `events` rows of type `pr_merged` with `metadata.forced = false`, attributed to the PR author, created inside the window | Each merged proposal is graded 1..unit max; the first `target` in the window are credited | One unit row per merged proposal, `source_key = merged:<event id>` | Graded, unit max = reward ÷ target (500) |
| 31 Send useful feedback | `USEFUL_FEEDBACK` | `feedback_reports` (new table, written by `POST /api/feedback`) | Each report is graded 1..unit max after a junk pre-filter; the first `target` in the window are credited | One unit row per report, `source_key = feedback:<id>` | Graded, unit max = reward ÷ target (250) |

Why `events` for accepted proposals and `chat_sessions` for sent ones: the
merge event is the only place that records whether the merge was forced by an
admin, and it is attributed to the author. `promoted_at` is written by the
human promote route only, so automated promotions (rename PRs, fleet
maintenance) never count as someone's first proposal.

Why a new table for feedback: the feedback dialog files a GitHub issue and
keeps nothing locally except the screenshot link. The scorer needs the author,
the text and the time. Recording them at filing time is one insert, and the
table is useful on its own.

## How the scorer works

New module `src/services/topochain/challenge-scorer.js`, started from
`becomeLeader` in `server.js` next to build retention, so it runs in exactly
one process during a blue-green deploy. Each tick takes the advisory lock
`CHALLENGE_SCORER_LOCK` (next id in `src/services/advisory-locks.js`) and
skips if a previous tick still holds it.

Per tick:

1. **Load running challenges.** Same candidate events as the snapshot
   builder (`type = 'regular'`, event and season active). A challenge is
   scored when its rule is on, the challenge is enabled and not closed, and
   its window has started. Window = `COALESCE(challenge, template, event)`
   for start and end, the same precedence the progress code uses. A window
   that ended less than 24 hours ago is still scored, so a Sunday 23:55 action
   gets credited by the next tick.
2. **Take the measure.** Each measure is one SQL query over the platform's
   own tables plus a pure planning function in `challenge-rules.js`. It
   returns candidate credits: `{ userId, sourceKey, activityAt, description }`.
3. **Drop what is already credited.** One query per challenge for the
   existing `source_key`s. Counted measures also stop at the target per
   person; `TRY_APPS` pays the reward on the unit that reaches it.
4. **Grade what needs grading** (two measures, below). A unit whose grade fails
   is left for the next tick. Nothing is written with a guessed number.
5. **Insert** with `ON CONFLICT DO NOTHING` on the new unique index, inside
   one transaction per challenge.
6. **Aggregate.** If the last snapshot run is older than the aggregate
   cadence, call `buildSnapshots(pool)` so standings and the blocks rail move
   without an admin. Progress rails read the ledger directly, so credits show
   immediately; only totals wait for the aggregate.

Ledger row shape, matching what the ZKPassport route writes:

- `activity_type` = the template's category (ONBOARDING / WEEKLY / PERSISTENT),
  which is what the admin import accepts.
- `points` as above; `description` a short human line ("Tried Pixel Garden",
  "Feedback #212 graded 200/250").
- `metadata.kind` = `challenge_completion` for single-credit measures only
  (this is what the existing anti-replay index and the "done" rule key on);
  a counted measure must omit it, or its second credit would be refused
  for counted kinds; `metadata.source_key`; `metadata.grade = { score, reason,
  model }` when graded.
- `activity_at` = when the underlying action happened, not when it was scored,
  so a credit sits inside the week it belongs to.
- `source = 'challenge_scorer'`, `added_by = NULL`.

Idempotency lives in the database, not in memory:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS user_activities_source_key_unique
  ON user_activities (challenge_id, user_id, (metadata->>'source_key'))
  WHERE metadata->>'source_key' IS NOT NULL;
```

Same shape as the existing nullifier index, so no new column and the admin
tools keep working. Admins can still edit or delete a scorer row in the
User activities screen; a deleted row would be re-credited on the next tick
unless the challenge is disabled, which is the intended way to stop scoring.

Cadence and switches, all from the platform config:

- `CHALLENGE_SCORER_INTERVAL_MINUTES`, default 10; `0` disables the tick.
- `CHALLENGE_SCORER_AGGREGATE_HOURS`, default 6. The builder keeps only the
  ten newest snapshots per event, so an hourly aggregate would erase the
  history the standings chart shows; six hours keeps about two and a half
  days.
- Grading uses the platform's `ANTHROPIC_API_KEY` through the existing
  `createMessageWithTelemetry` helper. With no key, graded kinds are reported
  as "grading off" in the run summary and their units wait.

## Grading the two "useful" challenges

New module `src/services/topochain/challenge-grader.js`. One Haiku 4.5 call
per unit, structured output `{ score: integer, reason: string }` (the same
`output_config` pattern the progress estimator uses), fixed rubric per kind,
`max_tokens` small. Volume is a handful of calls a week, so cost is not a
factor.

- **Feedback** input: title, description, app name if any. Rubric: does it say
  what the person did, what happened, and what they expected; could a builder
  act on it without asking back. Full marks for all three, zero for empty,
  duplicate-looking, or abusive text.
- **Accepted proposal** input: PR title and body (read through `github.js`),
  app name. Rubric: how useful the change is to people using the app, from a
  typo fix to a new capability. Zero only for no-op changes.

The score and reason are stored on the row so an admin can see why 200 and not
250, and adjust in the User activities screen if they disagree.

## Admin surface

The smallest thing that lets an admin trust it:

A **Challenge scoring** screen of its own in the programme console, beside
Challenge templates, rather than a section inside Settings: it carries a
list, a form, a dry-run preview and a run history, which is more than a
settings card holds.

- The rules list, each row showing what it measures, what it pays into, and
  the reason it is or is not scoring right now. "Window has not started" and
  "no target" are the two mistakes that actually get made, and without
  saying so the screen would show only silence.
- A form: name, measure, binding (template or one challenge), target,
  points, notes, on/off.
- **Dry run** does every read and every calculation, spends no grading
  calls, writes nothing, and reports what Run now would pay. **Run now**
  performs it.
- A schedule card: the interval, how stale standings may get, and whether
  grading is configured at all. With no model key the two graded challenges
  wait rather than fail, and an operator has to be told that.

Routes, all under the existing admin gates (reads open to view-only admins,
every mutation behind the write gate): `GET /api/v4/admin/challenge-scoring`
returns the whole screen in one response; `POST|PUT|DELETE .../rules[/:id]`
is the CRUD; `POST .../run` takes `{ "dry_run": true|false }`.

Runs are recorded in `challenge_scorer_runs`
(`started_at, finished_at, trigger, dry_run, credits, summary jsonb, error`).
A dry run records what it would have written, which is what lets the preview
and the history share one shape.

## Schema changes

All in `src/db/schema.sql`, idempotent as the file requires:

1. `challenge_scoring_rules` (name, measure, one binding, optional target and
   points, enabled, notes), with a CHECK enforcing exactly one binding and a
   partial unique index per binding so two rules cannot both pay one
   challenge. Deliberately NOT `challenges.kind`: that column already tells
   the phone app which behaviour a card gets and drives the illustration
   picker, and overloading it would tie "how this is scored" to "how this is
   drawn".
2. `user_activities_source_key_unique` (above).
3. `feedback_reports (id, user_id, target, app_id, issue_owner, issue_repo,
   issue_number, title, description, created_at)`, written by
   `POST /api/feedback` after the issue is filed. Marked `staging:private`
   like the other user-text tables.
4. `challenge_scorer_runs` (above).

## Decisions to confirm

Recommendation first in each.

1. **Own apps.** Exclude apps the person created from "Try 3 apps" and
   "Use apps for 10 minutes". Simplest anti-gaming rule and matches the copy
   ("built by people like you"). CONFIRMED.
2. **Lookback for the two onboarding steps.** Count actions from the
   challenge window start, not all time. Otherwise everyone who ever promoted
   a session is credited the moment the season opens. CONFIRMED.

   The implementation splits this explicitly: five measures score ACTIONS and
   filter by window; two score a STATE ("is your GitHub linked", "is block
   production on") and deliberately do not, because somebody who linked their
   account last month still has it linked.
3. **Which graded units get the weekly slots.** The first `target` units, in
   arrival order. CONFIRMED.

   DEVIATION from the draft: the grader's floor is 1, not 0. A zero would mean
   writing no row, which would mean re-grading the same text on every tick for
   the rest of the week. Junk is kept out by a deterministic pre-filter (too
   short to act on, or a duplicate of something the same person already sent)
   that costs no model call, so every graded unit is non-zero by construction
   and "the first N non-zero grades" and "the first N units" are the same set.
4. **Aggregate cadence.** Six hours, with the admin button for anything
   urgent. Raising `KEEP_SNAPSHOTS` instead is a separate decision.
5. **Enrollment.** Not required. Admin credits and the home progress rules
   do not check it, and Season 2 challenges are for every signed-in person.
6. **Windows on persistent and onboarding rows.** For the real launch these
   rows should carry no end date (or the season's end) so they keep scoring;
   the Sunday end set for this test week would stop them after the 24-hour
   grace.
7. **Weekly reuse.** Each week is a new challenge row from the template, not
   the same row re-dated. Caps and completions are per row, so re-dating
   would carry last week's credits into this week. CONFIRMED.

   This is why a rule binds to a TEMPLATE by default: a rule bound to one
   challenge would stop working at the week boundary, while a template
   binding covers next week's row too.

## Out of scope

- A generic rule or script language, prompts written by admins, Discord
  recaps, Top-3 bonuses. All were topochain agent features; none of the nine
  needs them.
- Revoking credits when an account is unlinked or a PR is reverted. The
  ledger is append-only; an admin deletes the row if it matters.
- Changes to the mobile app or to the web challenge screens. They read
  progress from the ledger already.
- Scoring anything before a challenge's window start.

## Work breakdown

One platform proposal on the current main. Roughly in this order:

1. Schema: kinds seed, source-key index, `feedback_reports`,
   `challenge_scorer_runs`. Move `parseRewardPoints` from
   `src/routes/home-panels.js` into a shared topochain helper so Home and the
   scorer parse rewards the same way.
2. `POST /api/feedback` writes the `feedback_reports` row after the issue is
   created (both platform and app targets).
3. `challenge-rules.js` (pure: measures, windows, payout, the cap) and
   `challenge-scorer.js` (the queries, the tick, dry-run mode, run records,
   aggregate trigger), plus the leader start and stop wiring in `server.js`
   and the advisory lock id.
4. `challenge-grader.js` with the two rubrics, over a new
   `llm.gradeChallengeUnit` transport helper.
5. Admin routes and the Challenge scoring screen, with the console section,
   nav icon, ownership audit entry and a `dapp.json` declared check.

Tests, all `node:test` like the neighbours:

- Rules over plain rows (window edges, own-app exclusion, target caps,
  first-non-zero slot rule, TRY_APPS paying on the third unit).
- The tick against the mock pool pattern used by
  `tests/topochain-snapshot-builder.test.js`: idempotent second run, dry run
  writes nothing, a failed grade leaves the unit for later, disabled kind
  skipped.
- Grader with a stubbed client: schema-conforming output, refusal, no key.
- Feedback route writes the report row; admin routes gated and shaped.
- Keep green: `challenge-onboarding`, `home-panels-*`, `topochain-admin-*`,
  `sql-validation` (the new SQL goes through `scripts/check-sql.js`).

## Rollout

1. Merge the proposal; the tick starts on the next deploy with the default
   cadence.
2. On the Challenge scoring screen, add one rule per challenge, bound to the
   template: Try 3 apps, Propose an app change, Turn on block production,
   Connect X and GitHub, Use apps for 10 minutes (target 10), Get a proposal
   accepted, Send useful feedback. Templates 27 and 28 need no rule.
3. Dry run, read the per-challenge list, then Run now.
4. Check the Challenges tab for a test account: rails move for tried apps,
   connected accounts and block production within one tick.
5. Before the real launch, apply decisions 6 and 7 to the rows.
