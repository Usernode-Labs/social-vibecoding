# Evaluating before/after shots on real proposals (local dry run)

Goal: find out whether the preview agent, given only a proposal's declared
changes, reaches each change on real builds and saves shots a person would
accept, before this replaces replay in production. The shots code has only
been exercised with scripted tool calls; this is its first run with a model.

This plan runs on a developer machine with Docker, the local Homeroom stack
and a logged-in `claude` CLI. It uses `scripts/shots-dry-run.js`, which runs
the production preview-agent prompts, shots bridge, internal routes and run
control against two builds you start, and writes a contact sheet to judge.

## 0. Ground rules

- Work on branch `claude/inspiring-sagan-xzhaw9` of `es92/social-vibecoding`.
  It was cut from `883818738f0bbba0238342d6a92f5372ca4716f6` and merged with
  upstream main on 2026-09-29; a "behind canonical main" notice only means
  main has moved on again. Do not open a PR or submit a proposal from it.
- Nothing here touches production. Read proposal data through the Homeroom
  connector or API only.
- You may fix `scripts/shots-dry-run.js` and add throwaway helpers under
  `.shots-dry-run/` (ignored). Write down, rather than fix, anything that
  looks wrong in the platform's shots code, with the proposal and evidence.

## 1. Pick 4–5 proposals

Candidates are recent `usernode-2d5619` proposals whose replay run failed
with real declared changes: 4781, 4832, 4842, 4844, 4854, 4868, 4885, 4907,
4908, 4909, 4911, 4913, 4922, 4935, 4937, 4946, 4947. With `get_proposal`,
keep those whose `visualEvidence.claims` is non-empty, and choose a mix: a
plain member flow, a `read_only_admin` or `full_admin` change, a `mobile`
viewport, and anything with `animation: "motion"`. Record each one's old
`failureCode` / `failureReason` for comparison.

For each, you need `baseSha`, `branch.headSha`, and the full version-1
declaration. `get_proposal` omits `startPath`, viewport sizes, `checkpoint`
and `focus`. Get them from the owner-only diagnostics
(`GET /api/apps/usernode-2d5619/proposals/<id>/evidence/diagnostics`, via the
`usernode-api` skill): production still runs replay, so an accepted run's
`replayPlan.stories[]` carries the full intent. Where no plan exists,
reconstruct the missing fields from the claim, its steps and the PR diff,
and mark that change "reconstructed" in your results. Do not add `hints`
on the first pass; the author did not have that option.

## 2. Stand up before and after, and sign the personas in

With the local stack running (`make up`), one command does both:

```sh
npm run shots:pair -- up --before <baseSha> --after <headSha> --label <id>
```

It builds each exact revision's image once (from a detached worktree),
restores one dump of the local dev database into two evidence databases,
runs both images on
`usernode-net` with a credential-free env (fresh secrets, its own iframe key
pair; it never reads your `.env`), applies the per-side fixtures a hosted
reset applies (full-admin identity, member agent-session copy, no app cap),
mints the three persona tokens and exchanges each for a session on both
origins with `bootstrapInternalSession`, exactly as the worker does. Before
is served at `http://127.0.0.1:4101` and after at `http://localhost:4102`:
cookies are scoped by host, not port, so the two must not share one. It
prints the `npm run shots:dry-run` command for the pair. Add
`--executable-path` when Playwright's Chromium is not installed (for
example your Chrome). `npm run shots:pair -- down` stops every pair. A
`motion` change's clips also need Playwright's ffmpeg once:
`.shots-dry-run/pw/node_modules/.bin/playwright install ffmpeg`.

Only one pair runs at a time; `up` stops the previous one and resets the
data, so one proposal's writes never reach the next.

## 3. What differs from a hosted run

The data is your local dev database rather than a redacted production
clone, so a change that needs richer data (a member in several apps, say)
may only be shown in part; the agent says so in its note. The hosted-app
fixture (a child app beside the platform) is not installed, and the
browser has no egress proxy (`--allowed-origins` only).

## 4. Take the shots

For each proposal:

```sh
npm run shots:dry-run -- \
  --intent .shots-dry-run/<id>/intent.json \
  --before http://127.0.0.1:4101 --after http://localhost:4102 \
  --state-dir .shots-dry-run/state \
  --base-sha <baseSha> --head-sha <headSha> \
  --head-checkout <head worktree> --title "<PR title>" \
  --claude-bin <claude 2.1.284+> \
  --out .shots-dry-run/<id>/run-1
```

The preview agent's model is `claude-sonnet-5-5` in production
(`VISUAL_EVIDENCE_AGENT_MODEL`), and the dry run uses the same unless
`--model` says otherwise; it needs `claude` 2.1.284 or later
(`--claude-bin`). Add `--executable-path` if Playwright's Chromium is not
installed, `--fixtures` with the descriptors the per-side fixtures returned,
or `--claude-args --bare` to skip your own hooks and CLAUDE.md (needs
`ANTHROPIC_API_KEY`). Run from inside a Claude Code session, the harness
starts the agent without that session's environment. Restart both builds from the dump before each
proposal, so one run's writes never reach the next.

Optional second pass: add the `hints` the implementing agent would have
known (setup data, expected text, the focus element) and rerun as
`run-2`, to see what hints buy.

## 5. Judge and record

Open each `index.html`. For every declared change, record:

| Field | Values |
| --- | --- |
| proposal / change id | |
| declaration | original / reconstructed |
| result | ready / skipped (reason) |
| skip reason accurate? | yes / no / n/a |
| after shows the change? | yes / partly / no |
| before shows the same place without it? | yes / partly / no |
| clip needed / present / shows the motion? | |
| agent seconds, tool calls (from `result.json`) | |
| old replay outcome | failure code |
| notes | what went wrong, what the agent did |

Put the table in `.shots-dry-run/RESULTS.md` and finish with:

- ready rate, and the share of ready changes judged "yes" on both sides;
- the most common reasons for skips and wrong shots;
- whether any published shot is misleading (published but wrong). That is
  the one new failure this design allows, so count it separately;
- any bug found in the shots code, with reproduction.

A reasonable bar for going ahead: about 80% of declared changes ready and
judged right, and no misleading shot that a reader would not catch.
