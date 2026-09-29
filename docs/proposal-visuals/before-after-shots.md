# Before & after shots

Every proposal that changes something people can see gets before & after
shots. The author declares each change in plain words, along with how to
reach it. Homeroom then builds private copies of the app from before and
after the change. A shots agent follows the declared steps on both builds
and saves what it sees: a still for each screen size and side, plus a short
clip of each side when the change is motion a still cannot show. People look
at the shots to judge the change. Nothing replays them and no model grades
them.

This replaced the earlier replay pipeline. There, the agent wrote a typed
browser program, the platform replayed it twice, and a run published only if
both replays matched pixel for pixel. In a production sweep of proposals
4400–4957, 16 of 125 finished runs were published. Most losses came from
that contract: the agent gave up or timed out writing the program, or the
program failed replay on a locator, an assertion, or a fingerprint.

## Vocabulary

| Word | Meaning | Stored as |
| --- | --- | --- |
| declared change | One visible change the author declares (up to three per proposal); changes that show on the same screen are one | `intent.stories[]` |
| before / after | The build without and with the proposal | `base` / `head` |
| shot | A PNG of the screen (`kind: "screen"`) or of one element (`kind: "element"`) | variant `context` / `focus` |
| clip | A WebM of one side, for a `motion` change | variant `animation`, side `base`/`head` |
| screen | A declared viewport (`desktop`, `mobile`, …) | `viewport` |
| skipped | A change the shots agent could not reach, with its reason | `hard_verdict.stories[].status` |
| shots agent | The hosted model that takes the shots (Claude Sonnet 5.5 for every proposal) | shots worker turn |
| visible changes | The author's declaration of the changes (`impact`, `rationale`, `stories`) | `visibleChanges` on the way in, `intent` once stored |
| preview | The running staging build of a proposal, and only that | |

On screen the feature is **Before & after**. In code, the API and storage,
the images are `shots`: tables `shot_runs`, `shot_artifacts` and
`shot_diagnostic_artifacts`, columns `chat_sessions.shots_*`, routes under
`/shots`, settings `SHOTS_*`. Stored sides stay `base`/`head`; the agent and
people only see *before* and *after*.

### Names from before the rename

Until 2026-09-29 all of this was called "visual evidence". The old names
still work, so nothing outside this repository breaks on the rename:

- `visualEvidence` on `submit_work` and the proposal-handoff routes, and
  `visual_evidence` on the CLI's `proposal_submit_build`, are read as
  `visibleChanges` (`visible-changes.declaredChanges`).
- `/api/apps/:slug/proposals/:sessionId/evidence…` is answered by the
  `/shots…` routes, for a tab still running the previous shell
  (`routes/shots.js`), and the worker's old
  `/api/internal/sessions/:id/visual-evidence-intent` by `/visible-changes`.
- Each `SHOTS_*` setting falls back to its `VISUAL_EVIDENCE_*` name
  (`VISUAL_EVIDENCE_V2_ENABLED` for `SHOTS_ENABLED`); the deploy workflow
  reads either repository variable. The Helm value is now
  `platform.shotsEnabled`; `platform.visualEvidenceV2Enabled` is no longer
  read.
- A pull request body's `usernode:visual-evidence` block is found and
  replaced by the `usernode:shots` one (`pr-metadata.js`).
- Failure codes and turn modes recorded under the old names are read as
  the new ones (`shots-state.currentCode`).
- A database that had the old tables renames them in place, and keeps a view
  under each old table name and synced `chat_sessions.visual_evidence_*`
  columns, so the previous release's pods keep working through a rolling
  update. `schema.sql` says when to drop them.

## Declaring a change

The implementing agent declares changes with `declare_visible_changes`
on a hosted build turn, or with `visibleChanges` on `submit_work` from an
external agent (`visible_changes` on the CLI's `proposal_submit_build`). The shape is unchanged from version 1:

```json
{
  "version": 1,
  "impact": "ui",
  "rationale": "The invite dialog now suggests members as you type.",
  "stories": [{
    "id": "invite-suggestions",
    "claim": "Typing a username shows suggestions beside the invite button.",
    "persona": "member",
    "viewports": [{ "name": "desktop", "width": 1280, "height": 800 }],
    "intent": {
      "startPath": "/lists/demo",
      "steps": ["Open Members", "Open Invite", "Type ma"],
      "checkpoint": "Suggestions and the Invite button are visible together",
      "focus": "Invite member dialog",
      "animation": "steps",
      "hints": {
        "setup": "Create a list from the + button first",
        "expectText": ["Suggestions"],
        "focusTarget": { "by": "role", "role": "dialog", "name": "Invite member" }
      }
    }
  }]
}
```

- `impact: "none"` with a specific `rationale` means nothing visible changed.
  No run starts and the proposal says so.
- `animation: "motion"` asks for clips as well as stills.
- `hints` are optional. They pass on what the author learned while building
  (data to create first, text that proves the state was reached, and the
  element to point at), so the shots agent can go straight there. They are
  guidance only and are never executed.
- `controlledFailurePath` still lets an error state be shot. The shots
  agent makes that exact API GET fail on both builds, and the shots are
  labelled as a controlled test.

An agent-written replay plan (`visualEvidencePlan` on `submit_work`) is
ignored, and `submit_visual_evidence_plan` no longer exists.

## A run, end to end

1. **Queued.** A run is created for the proposal's exact submitted commit
   (`planned`) when the declaration requires shots. It starts as soon as that
   commit's staging preview is up, beside the checks, when nothing holds the
   session (no turn open, the worker free); otherwise it starts once the
   checks settle. It never waits on the checks' verdict, and a proposal does
   not have to be up for a vote.
2. **Building before and after** (`provisioning`). Homeroom builds isolated
   copies of the exact base and head revisions. It resets both to the same
   fixture data and signs in each persona's browser.
3. **Taking the shots** (`exploring`). The shots agent gets one turn in a
   shots worker. It has three browsers, one per persona, and the "shots"
   tools:

   | Tool | What it does |
   | --- | --- |
   | `get_brief` | The declared changes, before/after addresses, which browser to use for whom, changed files and progress so far |
   | `save_shot` | Publishes PNGs the browser saved with `browser_take_screenshot`, several per call, each for a change, screen, side and kind; one screenshot can be listed for several changes |
   | `save_clip` | Publishes the clip that the change's browser recorded most recently |
   | `note_change` | Records what a change's shots leave out of its claim, shown beside them |
   | `skip_change` | Records why a change cannot be shown and withdraws anything saved for it (saving again takes the skip back); without a change id, it skips every change that is not ready |
   | `fail_request` | Blocks a declared `controlledFailurePath` on both builds |

   For each change and screen, the agent resizes the browser, follows the
   steps on the after address, waits for the finished state, hovers the
   changed element into view (the shell scrolls inside its own panes, so a
   `fullPage` screenshot shows no more than the screen), and saves a screen
   shot and an element shot. It does the same on the before address. Data a
   screen needs (`hints.setup`) is created on both addresses before either
   is shot. For a `motion` change it also records one clip per side.
   It calls `browser_close` to end the stills session, resizes again, and
   triggers only the motion. Then it calls `browser_close` again, which writes
   the recording, and `save_clip` publishes it.
4. **Saving** (`reviewing`). Each change is folded into one result. A change
   the agent skipped by name is **skipped**, even if shots were saved for it.
   Otherwise a change is **ready** when every screen has a before and an
   after screen shot, plus a before and an after clip if it is motion, and it
   carries the agent's note if it left one. Element shots are optional
   extras. Anything else is **skipped**, with the agent's reason or, failing
   that, a list of exactly what is missing. The files of ready changes are
   stored, fenced by a hash of the manifest, and the before/after builds are
   torn down.
5. **Shots ready** (`verified`). A run publishes if at least one change is
   ready, so one unreachable change never hides the others. If none is
   ready, the run fails with `shots_capture_incomplete` and each change's
   reason. If the agent itself failed and skipped nothing, it keeps the
   agent's error instead.

`hard_verdict` records the outcome:
`{ passed, mode: "shots", runs: 1, stories: [{ id, status, reason?, note? }] }`.
`plan_hash` holds the manifest hash, which names exactly the files
published.

A run that a platform restart interrupted is retried automatically, up to
twice per commit: a sweep every 30 seconds starts the same commit again once
the run has been marked interrupted for 30 seconds. Until then the card says
"Trying the shots again" rather than asking anyone to retry, and the view
carries `automaticRetryPending: true`. A person can take the shots again,
stop a running set, or (as an app manager) waive them.

## What the platform checks, and what it does not

The platform checks:

- every file came from this run's short-lived, run-scoped token;
- it is addressed to a declared change, one of that change's screens, and a
  side;
- a shot is one complete PNG under 6 MB and at most 8192 px on each edge;
- a clip is a WebM between 1 KB and 20 MB, only for a `motion` change;
- the bridge reads only a plain `.png` that is directly inside a persona's
  browser output directory, named by the agent. For a clip, it reads only the
  newest `.webm` in the change's persona directory. Taking a clip retires
  every older recording there, so a stale session can never be published
  later.

The browsers reach only the two addresses and the deployed apps the brief
lists, through the worker's egress proxy. Two routes mirror what the
production edge does: for a child app (and a hosted app), GET/HEAD of
`/usernode-bridge/`, `/usernode-native/` and `/usernode-tailwind/` is
answered by the platform, without the page's cookies, since the app's own
server would return its SPA fallback and leave the page unstyled; and a
child app still on the Tailwind CDN script may reach `cdn.tailwindcss.com`,
the one third-party host admitted. The platform's own proposals serve the
assets their revision carries.

It does **not** prove that a "before" shot was taken on the before address,
or that the shot shows the change. These are the shots agent's
observations, and people are the judges, which is also how the replay
pipeline ended: people still had to look. The builds are platform-made from
exact revisions with fixture data, so no author's local data or credentials
can appear in them.

## What people see

The proposal's card shows one screen per screen size that flips between
before and after: click it, or focus it and press Space. Each declared change
on it is outlined and numbered, red where it was and green where it is now; a
dashed line marks where something appears or goes, and a difference no
declared change accounts for is outlined dashed and grey. Changes whose before
screens are the same image share one screen. With more than one screen, one
shows at a time and the ‹ › arrows under it step through them (radios, so the
keyboard's arrow keys step them too). "Open full screen" shows the screen
larger, flipping the same way. Under the screens, the declared changes are
listed with those numbers:

- **Ready.** The change, its screen sizes and persona, and its steps. Motion
  changes also show a before and an after clip player. When the agent
  noted that its shots leave part of the claim out, the note is shown as
  "Not in these shots: …", so a partial pair is never mistaken for the
  whole change.

The outlines are worked out once, when the run saves its shots
(`src/services/shots-diff.js`), and stored in the verdict as `screens`. The
two screens are compared row by row first, the way a text diff compares
lines, so content that only moved (a sheet that grew upward) lines up instead
of counting as changed; rows that do not line up are compared pixel by pixel
for how wide the change is. Each area is tied to the declared change whose
element shot sits inside it, and widened to that element. A run from before
this has no `screens`: its card flips a screen per change and size, with
nothing outlined. The Workshop feed's picture still leads with the element
shot when it is big enough to read (at least 120×40 px on both sides).
- **Skipped.** The change, a "Skipped" badge and the reason.
- While running, the card shows its state ("Building before and after",
  "Taking the shots", "Saving the shots") and a Stop action. A failed run
  offers "Take the shots again", and so does a ready one (after better steps
  or hints, or to outline a run from before outlines were worked out).
- A change that is not up for a vote yet shows its shots the same way, on
  its page and in the Workshop feed, as soon as they are ready.

The public view model and the connector's `get_proposal` carry `shotResults`
(`[{ id, status: "ready" | "skipped", reason, note }]`) beside `claims` and
`artifacts`. Runs from before shots have no `shotResults`, and their older
paired clips still play.

## Configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `SHOTS_ENABLED` | `true` | The one kill switch: stops collecting declarations, taking shots and showing them |
| `SHOTS_MAX_AGENT_MS` | 480000 | The shots agent's turn budget |
| `SHOTS_MAX_RUN_MS` | 1440000 | Whole-run budget, also used by recovery |
| `SHOTS_AGENT_MODEL` | `claude-sonnet-5-5` | The shots agent's model, whatever model or backend the author's session used; any other `claude-…` id overrides it |

The shots agent is always Claude Code on this model, in a fresh thread
started from its brief, including for proposals built on Codex (OpenRouter).

Clips are recorded only for runs with a `motion` change
(`SHOTS_RECORD_CLIPS=1` in the worker adds `--save-video=1280x800` to each
browser). Each persona's browser saves files under
`SHOTS_DIR/<member|admin|full_admin>` via `--output-dir`.

## Where it lives

| Piece | File |
| --- | --- |
| Declaration schema (`parseIntent`, `declaredChanges`, `hints`, `needsClip`) | `src/services/visible-changes.js` |
| Declaring on a hosted turn (`declare_visible_changes`) | `worker/visible-changes-mcp.js`, `POST /api/internal/sessions/:id/visible-changes` |
| File checks and per-change results (`shotTarget`, `summarize`) | `src/services/shots-files.js` |
| Run-scoped control (`saveShot`, `skipChange`, `noteChange`, `summary`) | `src/services/shots-control.js` |
| Internal routes (`/context`, raw `/shot`, `/skip`, `/note`) | `src/routes/internal.js` |
| Run flow and the brief (`executeRun`, `shotsBrief`) | `src/services/shots-orchestrator.js` |
| Shots agent prompt and dispatch | `src/services/shots-agent.js` |
| Shots bridge (MCP server `shots`) | `worker/shots-mcp.js` |
| Browser servers (`--output-dir`, `--save-video`) | `worker/write-shots-mcp-config.js` |
| Egress proxy (origins, platform assets, controlled failures) | `worker/shots-origin-proxy.js` |
| Local dry run: the pair, then the shots | `scripts/shots-dry-run-pair.js`, `scripts/shots-dry-run.js` |
| States, storage, public summary | `src/services/shots-state.js`, `src/services/shots-view.js` |
| Where before and after differ, per screen (`screensFor`) | `src/services/shots-diff.js` |
| Public routes (summary, files, diagnostics, take again, stop, waive) | `src/routes/shots.js` |
| Tables, and the rename from `visual_evidence_*` | `src/db/schema.sql` (the "Renamed from visual_evidence_*" block) |
| Proposal card | `public/js/app-view.js` (`shotsHtml`) |

## Diagnosing a run

The proposal author and app managers can read
`GET /api/apps/:slug/proposals/:sessionId/shots/diagnostics` (add
`?runId=` for an earlier run). It carries the run's revisions, provenance,
`shotResults`, stored files (sizes and hashes, not bytes), the failure code
and reason, and a bounded trace:

- `trace.failure` gives the phase, code and message, plus the last refused
  tool call (`tool`, `toolCode`, `toolMessage`);
- `trace.control` gives the files saved, the changes skipped and noted, and
  whether everything was skipped;
- `trace.agentDispatches` and `trace.agentActivity` give the backend and
  model, fallback, tool counts, and pending browser and provider calls. See
  `shots-agent-diagnostics.md` for reading a timeout;
- `trace.agentActivity.firstAtMs` gives, from the run's start, when the
  agent was dispatched and when its startup first reached each step (worker
  ready, provider ready, first output, first tool, first browser call). The
  event list keeps only the last 128 events, so this is where startup time
  is read;
- `trace.agentFinalResponse(s)` holds the agent's own last words (private
  to this route).

## Dry run on local builds

`npm run shots:pair -- up --before SHA --after SHA` stands up those two
builds on the local stack the way a hosted reset does (exact images, one
data dump restored per side, the per-side fixtures, the three personas
signed in on both) and prints the next command.
`npm run shots:dry-run -- --intent FILE --before URL --after URL` then takes
the shots outside Homeroom, on the two running builds. Everything
between the agent and the saved files is the production code: the shots
agent's prompts, the shots bridge, the internal routes and the run control.
The browsers are Playwright MCP with the worker's flags, and the agent is
your local `claude` CLI (`--claude-bin` names another; Sonnet 5.5 needs
2.1.284 or later) on the hosted shots agent's model unless `--model` says
otherwise, with no built-in tools and only the shots and browser servers
allowed. Run from inside a Claude Code session, it starts the agent without
that session's environment. `--fixtures` passes the seeded fixtures into the
brief as a hosted reset does. `--state-dir` supplies each persona's signed-in
storage state; `--base-sha`/`--head-sha` fill in the brief's changed files
and diff. It writes an `index.html` with every change side by side, plus
`result.json`, the files, and the agent's stream, under `.shots-dry-run/`.
`--help` lists the rest. It uses no database and publishes nothing.
[dry-run-evaluation.md](dry-run-evaluation.md) is the plan for running it on
real proposals.

## What the first dry run found

On 2026-09-29 the dry run took the shots of five production proposals whose
replay had failed or was flaky (4832, 4842, 4844, 4885, 4922: eight declared
changes, member and read-only admin, desktop and phone) on Sonnet 5.5,
against the local dev database:

- Every change was ready, against one of the five proposals under replay.
  A proposal took 20–70 s and $0.09–$0.58 of agent time.
- Before the fixes above, 5 of 8 were right on both sides and 3 were partial
  but still marked ready: the claim sat below the fold, the data could not
  show part of it, or the author's steps could not reach it. The agent knew
  in two of the three and said so only in its private last words. No shot
  was wrong, and a person comparing claim and shots could see what was
  missing.
- With the fixes (a skip withdraws shots, notes, waiting, scrolling by
  hover, element shots, setup on both sides), 6 of 8 were right on both
  sides and the other 2 were ready with an accurate note on what they leave
  out. Element shots were saved for most changes.

Since then, a `motion` change (4885's model sheet, re-declared as motion)
was shot with clips by a model for the first time: the stills, then one
short recording per side, as the prompt describes. Clips are now recorded at
the motion screens' own size; at the old fixed 1280×800 a phone clip was a
phone in the corner of a grey frame.

Still open:

- An element shot is cut at the element's own box, so a badge drawn over a
  corner is half clipped. Crops too small to read (under 120×40 px) no
  longer lead the card; the screen shots do.
- Shots are 1×: Playwright MCP 0.0.41 saves screenshots at CSS scale.
  0.0.83 adds `scale: "device"`, but it also renames the binary
  (`playwright-mcp`), renames an element's `ref` to `target`, and replaces
  `--save-video` with `browser_start_video`/`browser_stop_video`; the same
  server is the coding agent's in-loop browser. Upgrading is its own change.
- The agent does not always call `browser_wait_for` before shooting.
- The hosted-app shots fixture (a child app beside the platform) was not
  part of the local runs, so the platform-asset route for child apps is
  covered by tests, not yet by a model run.
