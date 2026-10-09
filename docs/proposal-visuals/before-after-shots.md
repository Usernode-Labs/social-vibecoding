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
| failed | A change the shots agent tried on the after build, where the app itself broke (a server error, an error on screen, the effect never appearing) | `hard_verdict.stories[].status` |
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
- `persona` is who is signed in: `member`, `read_only_admin`, `full_admin`
  (Homeroom controls hidden from read-only admins), or `guest`, a visitor who
  is not signed in. Use `guest` for what signed-out people see: Homeroom's
  landing and sign-in pages, or a public app's guest view. A hosted build
  turn's `declare_visible_changes` answers with `warnings` when the persona
  cannot show the change: a `guest` change on an app whose guests are shown
  nothing of it (private, or guests unavailable), or a claim about
  signed-out visitors declared for a signed-in persona
  (`shots-identities.personaWarnings`). They are warnings, not refusals: a
  change to the sign-in page itself is a real guest change.
- On an app built on Homeroom, no persona is the app's creator or one of
  its admins (see "Roles in an app built on Homeroom" below). The same
  response warns about a change declared there for `read_only_admin` or
  `full_admin`, and about one whose claim, path, focus or checkpoint names
  a creator, owner or admin screen with no `hints.setup`.
- `hints` are optional. They pass on what the author learned while building
  (data to create first, text that proves the state was reached, and the
  element to point at), so the shots agent can go straight there. They are
  guidance only and are never executed.
- `controlledFailurePath` still lets an error state be shot. The shots
  agent makes that exact API GET fail on both builds, and the shots are
  labelled as a controlled test.
- A change that only shows at certain times declares a preview moment in
  its testing guidance (`<!-- usernode:preview-at 2026-10-08T19:00
  Europe/London -->`, read by `src/services/preview-clock.js`). The brief
  then carries `previewAt` (`at`, `label`, `zone`, `param`), and the agent
  opens both copies with `?un-now=<at>` on the start path. Both copies run
  as staging, so an app that reads "now" through `req.now` and
  `usernode.now()` shows that moment on both sides; the before side simply
  lacks the change. See "Time-dependent features" in
  `src/prompts/app-conventions.md`.

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
   fixture data and signs in each persona's browser, except the guest's,
   which stays signed out (see "The guest browser" below).

   For Homeroom's own proposals it then writes demo states the copies cannot
   reach by themselves (`src/services/shots-demo-states.js`). The copies have
   no model key and run nothing in the background, and most staging fixtures
   belong to the read-only admin. The demo states include:
   - for the member: an agent run in progress and one asked to stop, a change
     with a deployed preview, and enough agent sessions for "Show more";
   - a proposal with a vote of the member's on an earlier version, and a
     threshold that moved since voting opened;
   - a proposal of the member's to make the app private, flagged for
     explicit approval, with only the member's own Yes;
   - for the admins: a live Homeroom bot verdict with its build;
   - for every persona: the season's finished First challenges and an Always
     open challenge with its next count;
   - for every persona: a "This week" group of weekly challenges, and a
     weekly challenge scored on sending a proposal (`PROPOSAL_SENT`),
     switched on, open and counted hourly, with its own page;
   - for the member: their standing in the season, and a friend request;
   - for the member: a remix they made of another app, whose ⋯ offers
     "Suggest this back";
   - for the member: their chat with the Homeroom bot, with an activity card
     whose build waits its turn (working) and a newer card on the same
     request.

   Each state goes into both copies or neither. A state the base or head
   revision cannot hold is left out of the run, as is one that fails to
   write on either side; neither fails the run. Every row is an obviously
   fake `[shots fixture]` row in a reserved id block (990840 to 990895). The
   brief's `availableFixtures` tells the agent each state's persona, what it
   shows and its path.

   The demo states are written by the deployed platform's own code, not by
   either revision under test. So a proposal cannot use a demo state it adds
   itself: the state reaches shots only once the proposal has merged. Data a
   proposal needs for its own shots belongs in that revision's staging seeds
   (`src/db/migrate.js`), which each side runs for its own revision: the
   after side has it, and the before side has what the base revision
   already seeded.
3. **Taking the shots** (`exploring`). The shots agent gets one turn in a
   shots worker. It has four browsers, one per persona (the guest's is not
   signed in), and the "shots" tools:

   | Tool | What it does |
   | --- | --- |
   | `get_brief` | The declared changes, before/after addresses, which browser to use for whom, changed files and progress so far |
   | `save_shot` | Publishes PNGs the browser saved with `browser_take_screenshot`, several per call, each for a change, screen, side and kind; one screenshot can be listed for several changes |
   | `save_clip` | Publishes the clip that the change's browser recorded most recently |
   | `note_change` | Records what a change's shots leave out of its claim, shown beside them |
   | `skip_change` | Records why a change cannot be shown and withdraws anything saved for it (saving again takes the skip back); without a change id, it skips every change that is not ready. `outcome: "failed"` says the agent did the steps on the after address and the app broke, rather than that these copies cannot reach the state |
   | `fail_request` | Blocks a declared `controlledFailurePath` on both builds |

   For each change and screen, the agent resizes the browser and opens the
   start path again (an app that picks its layout at load keeps a desktop
   layout in a phone screen otherwise), follows the steps on the after
   address, waits for the finished state and for anything still moving to
   settle, hovers the changed element into view (the shell scrolls inside
   its own panes, so a `fullPage` screenshot shows no more than the screen),
   moves the pointer off it so hover-only controls do not cover the change,
   and saves a screen shot and an element shot. It does the same on the
   before address, framed the same way. Data a
   screen needs (`hints.setup`) is created on both addresses before either
   is shot. For a `motion` change it also records one clip per side.
   It calls `browser_close` to end the stills session, resizes again, and
   triggers only the motion. Then it calls `browser_close` again, which writes
   the recording, and `save_clip` publishes it.
4. **Saving** (`reviewing`). Each change is folded into one result. A change
   the agent skipped by name is **skipped**, even if shots were saved for it,
   or **failed** when it skipped it with `outcome: "failed"`.
   Otherwise a change is **ready** when every screen has a before and an
   after screen shot, plus a before and an after clip if it is motion, and it
   carries the agent's note if it left one. Element shots are optional
   extras. A ready change whose before and after screens came out the same
   (the same image on every screen size, or, once the screens are compared,
   no area that differs) is still published, marked `unchanged`, with a note
   saying so ("Not in these shots: any visible difference…"): people judge
   the shots, and two copies of one screen must not pass for the change.
   `save_shot` already warns the agent (`sameAsOtherSide`) when it saves the
   same image on both sides, while it can still retake them. Anything else is **skipped**, with the agent's reason or, failing
   that, a list of exactly what is missing. The files of ready changes are
   stored, fenced by a hash of the manifest, and the before/after builds are
   torn down.
5. **Shots ready** (`verified`). A run publishes if at least one change is
   ready, so one unreachable change never hides the others. If none is
   ready, the run fails with `shots_capture_incomplete` and each change's
   reason, or with `shots_change_failed` when a change failed: then it keeps
   its verdict, so every reader can say which change failed. If the agent
   itself failed and skipped nothing, it keeps the agent's error instead.

`hard_verdict` records the outcome:
`{ passed, mode: "shots", runs: 1, stories: [{ id, status, reason?, note? }] }`.
`plan_hash` holds the manifest hash, which names exactly the files
published.

Within a run, a shots agent whose process died under it (`exitCause`
`oom_killed`, `container_gone` or `turn_process_gone`, see
`shots-agent-diagnostics.md`) is dispatched once more on the same copies,
when at least a minute of its budget is left; what it saved stays saved.

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
- an element shot fits its screen: no wider than the screen (scaled by the
  same side's screen shot when the browser shot at 2x) and at most two
  screens tall. A wider one means the page was laid out at another size; a
  taller one is a tiled capture nobody can read (`element_shot_too_wide`,
  `element_shot_too_tall`);
- a clip is a WebM between 1 KB and 20 MB, only for a `motion` change;
- the bridge reads only a plain `.png` that is directly inside a persona's
  browser output directory, named by the agent. For a clip, it reads only the
  newest `.webm` in the change's persona directory. Taking a clip retires
  every older recording there, so a stale session can never be published
  later;
- a shot was taken on its own side's address: a "before" on the before
  address, an "after" on the after address. The browser observer stamps each
  screenshot with the site of the page Playwright last reported, and each
  closed recording session with every site it showed. The bridge publishes a
  still only when its stamp names that address and the image is still the
  one stamped, and a clip only when the record written as its session closed
  names that address alone (`worker/shots-boundary.js`). Anything else is
  refused with `shot_not_on_app`.

The browsers reach the public internet, through the worker's egress proxy,
so a page that loads a CDN script, a font or map tiles renders as it does in
production. The two addresses and the deployed apps the brief lists are
reached by name, as before. Any other destination is reached only on port 80
or 443, only when every address its name resolves to is public, and at the
address that was checked, so a second lookup cannot move it inside: the
network the worker runs in (cluster services, the cloud metadata endpoint,
private and link-local ranges) is never reachable, and each refusal is
counted in the trace as `egress_blocked` with its reason (`private_address`,
`port` or `dns`), never the destination. The persona identity goes only to a
child-app pair's own two addresses. Two routes mirror what the production
edge does: for a child app (and a hosted app), GET/HEAD of
`/usernode-bridge/`, `/usernode-native/` and `/usernode-tailwind/` is
answered by the platform, without the page's cookies, since the app's own
server would return its SPA fallback and leave the page unstyled. A child
app still on the Tailwind CDN script reaches `cdn.tailwindcss.com` like any
public host, and that use is still counted (`legacy_tailwind_cdn`). The
platform's own proposals serve the assets their revision carries.

One path is the shots' own. The app's tile on Homeroom's home screen is
not on a pair's addresses, so a change to an app's icon, name or colour in
`dapp.json` had nothing to shoot. GET/HEAD of `/__shots/home-tile` on
either address is answered with that side's tile, which the platform draws
from the side's own `dapp.json` the way the home screen does (a committed
image, else the emoji, else the first letter; light and dark, at the home
screen's size and three times larger). The proxy fetches it with the run's
shots token, which never reaches the page, and counts each answer as
`home_tile`. The brief's `homeTile` names the path, what each side shows
and whether they differ (`services/shots-home-tile.js`).

It does **not** prove that a shot shows the change, or what a page drew on
its own address. The address check guards against the agent's mistakes and
steering, not against the page: a proposal's own page can already show
anything there. What the shots show is the shots agent's observation, and
people are the judges, which is also how the replay pipeline ended: people
still had to look. The builds are platform-made from exact revisions with
fixture data, so no author's local data or credentials can appear in them.

## The guest browser

The `guest` persona is a browser that is not signed in: the bootstrap writes
it an empty storage state (`guest.json`) instead of exchanging a token, and
the agent is told not to sign it in. What a signed-out visitor sees depends
on the app:

- **Homeroom's own copies** have no edge in front of them, so a browser with
  no session already gets the signed-out landing and sign-in pages (the SPA
  document loads, `/api/*` answers 401). The guest carries nothing.
- **A view-public child app** shows a visitor with no account its guest view
  only when the request carries a guest token, which the production edge adds
  at the app's own address (`services/edge-gate.js`). The shots copies have no
  edge, so the platform mints the same token
  (`shots-identities.shotsGuestIdentity`, `platform-jwt.signGuestToken`, the
  fixture tokens' 15 minutes) and the shots proxy adds it as
  `x-usernode-token` on the guest's own listener, only to the pair's two
  addresses (`SHOTS_GUEST_TOKEN`, optional). It is minted only where the edge
  would give one: the app is view-public by the edge's own lookup
  (`app-access.getHostVisibility`) and not suspended, app-host sign-in is on,
  and the platform has a guest signer (`EDGE_JWT_SECRET`).
- **A private child app**, or one where guests are unavailable, gets no
  token: the guest is a visitor outside Homeroom, which the scaffold sends to
  the production platform, away from the pair. The brief says so in
  `browsers.guest.who`, and the agent skips such a change with its reason.

No gate is loosened for this: the guest gets only what a signed-out request
already gets, and a preview still never admits guests. The guest token is
masked with the other tokens and never enters the brief or the trace.

## Roles in an app built on Homeroom

Homeroom tells an app who is signed in, never their role in it. The identity
token carries `{ id, username, usernode_pubkey, locale }` and nothing else
(`platform-jwt.signAppIdentityToken`); there is no creator or admin claim,
and no bridge call or app-platform route answers "is this the owner?". The
member list (`GET /members`) puts the creator first, but it answers only a
project's members and leaves out the platform's own `usernode-*` accounts.
`dapp.json`'s `admins` roster and `apps.created_by` decide what someone may
do on Homeroom (`app-admins.canManageApp`), and the app is not told either.
The shots copies are signed in as fixture accounts (`usernode-capture`,
`usernode-capture-admin`, and `usernode-shots-full-admin`, which exists only
in the copies). To the app all three are ordinary signed-in people.

So a screen an app keeps for particular accounts (its creator's username
written into the code, an allowlist, "private to this account") refuses every
browser on the copies. Three runs on one app's Creator Studio (QuestVerse's
PRs 7 to 9) ended that way, each after the agent had tried all three browsers.
Nothing is loosened for it, and no real person's identity is ever lent to a
persona: minting a token for the app's real creator would put that person's
account, and whatever the app shows only them, into the copies and the
shots. Instead:

- the brief describes each signed-in browser as the app sees it, and its
  `appRoles` says that no browser holds a role in the app and that such a
  refusal means skipping the change at once, with the default outcome,
  without trying the other browsers (`shots-orchestrator.shotsBrief`);
- declaring warns the author, as above;
- `src/prompts/app-conventions.md` ("Who the before & after shots see")
  tells app authors not to hard-code people into a screen the project
  works on, and to gate it on something a signed-in person can reach
  through the app's own UI, named in `hints.setup`.

A role the app grants through its own UI (whoever creates a group manages
it) is reachable as before, through `hints.setup`. Homeroom's own copies are
unaffected: there the two administrator personas are its administrators.

## What people see

The proposal's card shows one screen at a time in a frame that keeps its
size. Every screen sits in the same 16:10 stage, a phone screen in the middle
at the same zoom as a desktop one, so moving between screens never resizes the
card. A toolbar above the screen switches between Before and After (clicking
the screen flips it too) and between Desktop and Phone when the run has both.
When one size has more than one screen, ‹ › arrows at the toolbar's right end
step through that size's screens; the toolbar is the same on every screen, so
they never move. It is radios and labels, so it needs no script, and the
keyboard's arrow keys step them too. Each declared change on the screen is
outlined and numbered, red where it was and green where it is now; a dashed
line marks where something appears or goes, and a difference no declared
change accounts for is outlined dashed and grey. Changes whose before screens
are the same image share one screen. Under the screen are only the changes on
it, with those numbers (pointing at one picks out its outline), a key for any
dashed shape, and the screen size and persona. The screens share one grid
cell, so the card is as tall as its longest description on every screen.

- **Ready.** The change and its steps. Motion changes also show a before and
  an after clip player. When the agent noted that its shots leave part of the
  claim out, the note is shown as "Not in these shots: …", so a partial pair
  is never mistaken for the whole change. A change with no screen of its own
  is listed below the viewer instead.

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
- **Failed.** The change, a red "Didn’t work" badge and what the agent saw.
  A run whose only changes failed reads "Something didn’t work". The change
  page's Tested line reads "Tested · One thing isn’t working" instead of
  "All checks passed" while the shots on its commit show a change failing.
- While running, the card shows its state ("Building before and after",
  "Taking the shots", "Saving the shots") and a Stop action. A failed run
  offers "Take the shots again", and so does a ready one (after better steps
  or hints, or to outline a run from before outlines were worked out).
- A change that is not up for a vote yet shows its shots the same way, on
  its page and in the Workshop feed, as soon as they are ready.
- A proposal declared with nothing visible reads "No before & after needed"
  and "This proposal has no visual changes." The author's `rationale` stays
  with the declaration, for whoever reviews it.

The public view model and the connector's `get_proposal` carry `shotResults`
(`[{ id, status: "ready" | "skipped" | "failed", reason, note }]`) beside `claims` and
`artifacts`. Runs from before shots have no `shotResults`, and their older
paired clips still play.

## A change of the Homeroom bot's

The bot offers a change of its own as ready to try only once its shots on
that exact head have settled (`shots-state.holdsReady`, read by
`homeroom-bot-dm.changeReadiness`), for at most 45 minutes after its checks
verdict. Every way the shots slot settles (a terminal transition, a waiver,
a run that will not start) calls `homeroom-bot-dm.noteShotsSettled`, and the
bot's refresh sends anything held past the limit. When the shots show a
declared change failing, the change goes back to the bot in the round a
failing check gets (`homeroom-bot-followup.checksDue`'s `broken`, once per
head and within its revisions) before anybody is told it is ready. Once that
round is spent, the card says plainly what does not work ("Flat 4B Chores is
built, but not everything works yet", "One thing isn’t working yet: …"), and
nobody else is asked to approve it.

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
`SHOTS_DIR/<member|admin|full_admin|guest>` via `--output-dir`.

## Where it lives

| Piece | File |
| --- | --- |
| Declaration schema (`parseIntent`, `declaredChanges`, `hints`, `needsClip`) | `src/services/visible-changes.js` |
| Declaring on a hosted turn (`declare_visible_changes`) | `worker/visible-changes-mcp.js`, `POST /api/internal/sessions/:id/visible-changes` |
| File checks and per-change results (`shotTarget`, `summarize`) | `src/services/shots-files.js` |
| Run-scoped control (`saveShot`, `skipChange`, `noteChange`, `summary`) | `src/services/shots-control.js` |
| Internal routes (`/context`, raw `/shot`, `/skip`, `/note`, `/home-tile/:side`) | `src/routes/internal.js` |
| The app's home-screen tile on each side (`/__shots/home-tile`) | `src/services/shots-home-tile.js` |
| Run flow and the brief (`executeRun`, `shotsBrief`) | `src/services/shots-orchestrator.js` |
| Shots agent prompt and dispatch | `src/services/shots-agent.js` |
| Shots bridge (MCP server `shots`) | `worker/shots-mcp.js` |
| Fixture identities and session copies; demo states for the personas | `src/services/shots-fixtures.js`, `src/services/shots-demo-states.js` |
| Persona tokens and the guest's, and the warnings on declaring (`mintShotsAuthTokens`, `shotsGuestIdentity`, `personaWarnings`) | `src/services/shots-identities.js` |
| Browser servers (`--output-dir`, `--save-video`) | `worker/write-shots-mcp-config.js` |
| Egress proxy (origins, public-only egress, platform assets, controlled failures) | `worker/shots-origin-proxy.js` |
| Where the browser may go, and which shots may be published | `worker/shots-boundary.js` |
| Local dry run: the pair, then the shots | `scripts/shots-dry-run-pair.js`, `scripts/shots-dry-run.js` |
| States, storage, public summary | `src/services/shots-state.js`, `src/services/shots-view.js` |
| Where before and after differ, per screen (`screensFor`) | `src/services/shots-diff.js` |
| Public routes (summary, files, diagnostics, take again, stop, waive) | `src/routes/shots.js` |
| Tables, and the rename from `visual_evidence_*` | `src/db/schema.sql` (the "Renamed from visual_evidence_*" block) |
| Proposal card | `public/js/app-view.js` (`shotsHtml`; the viewer frame is `_shotsViewerHtml`, which an HTML spec's drawn screens share, #3699) |

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
data dump restored per side, the per-side fixtures, the three signed-in
personas signed in on both; the guest needs nothing) and prints the next
command.
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
storage state (the guest's browser always starts signed out); `--base-sha`/`--head-sha` fill in the brief's changed files
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
