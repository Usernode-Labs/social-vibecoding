# Artifacts

Status: stages 0 to 3 built, stage 4 light; several artifacts in a thread (K) built (November 2026).
This replaces "design mode" as a separate thing: a design is one kind of
artifact.

## What an artifact is

An artifact is a self-contained page Homeroom bot writes with a person: HTML
with its own styles and, when it must do something, its own inline scripts.
It lives in one of the person's private threads with the bot, is shown in a
sandboxed frame, is changed in place, and keeps every version.

A thread holds up to 12 artifacts (`artifacts.js MAX_ARTIFACTS_PER_THREAD`), numbered
in the order they were made (see "Several artifacts in a thread" below). Each
has a **kind**, and one thread may hold both:

| Kind | What it is | Who works on it |
|---|---|---|
| `design` | A screen of a project (or of a project not made yet), drawn in that project's own look | the design kind's session, `src/services/design-bot.js openSession` |
| `page` | A page of its own: a comparison laid out as a table, a calculator, a checklist, a one-page summary | the plain kind's session, `src/services/artifact-session.js openPage` |

Artifacts have **no status words** of their own on any screen. Where the
thread stands (open, filed, posted, done) is the thread's own state, said by
the thread's own words (`private-threads.js`). If an artifact ever needs a
status, it comes from one place from the first day.

## The store

`src/services/artifacts.js` is the store's one writer and its reader by
thread. A thread's first artifact keeps the tables it had when only designs
were stored; its later ones have their own (K):

- `design_threads`: the thread's first artifact. `kind` (`design` or `page`, default
  `design`), `viewport` (`phone` or `desktop`, null on a row from before,
  read off its width), `place` (`thread`, the only place there is), its
  title, what it is of (`surface`, `route`) and the size it is drawn at.
- `design_versions`: its versions, whole each time, up to 80, 900 KB each.
- `thread_artifacts`: each later artifact, number 2 and up, with the same
  columns (and `pictures`).
- `thread_artifact_versions`: their versions, numbered from 1 per artifact,
  with the same limits.

Every read is the thread owner's alone. Nothing in the store publishes an
artifact. A chat message is at most 8,000 characters, so an artifact is never
in a message: a message points at a version (`metadata.designVersion`, the
name it had before pages).

**Rolling release.** Migration `artifact-store` only adds columns, each with a
default or nullable, so a build from before keeps inserting designs (naming
none of them) and reading them (naming its columns). To a build from before, a
page is a design of a project not made yet (`surface` `new`): it can still be
read and drawn there. The table names stay; renaming them is a later one-line
change once no build from before runs.

**A plan knows its design (stage 0).** A plan made from a design stores the
design's thread and the version it shows (`chat_session_specs.design_thread_id`,
`design_version`), written by `request-specs.js postRequestSpec` and read by
`personPlanOf`. The regular expression over the plan's own words is gone from
the code. Migration `plan-design-source` filled older plans once from their
words. A plan a build from before posts during a rollout (after the migration
ran) is filled at the next boot by `src/services/plan-design-source.js`:
idempotent, the last 7 days only, at most 200 rows a boot, a design's thread
only, and never failing a boot. Plans reached only through
`chat_sessions.linked_issues` are not looked for: `postRequestSpec` makes every
plan's record with `created_from_issue_number` set to its request and
`linked_issues` holding that one number, and nothing else writes one.

## Several artifacts in a thread (K, 20 Nov 2026)

Asked for something new, the bot once saved iOS list layouts as version 2 of
"Gym Tracker style directions": the store held one artifact per thread
(`design_threads` is keyed by its thread, `design_versions` unique on
thread and version). A thread now holds several, each with its own id and
its own versions.

**The id.** An artifact's id (`artifactId`) is its number in its thread, in
the order it was made: 1 is the first. A row, message, pin or plan from
before names none, and means the thread's first. Every address is under its
thread already (`/designs/:rootId`), so the number needs no other scope.

**The migration (`thread-artifacts`), additive only.**

- What is added: `thread_artifacts` (a thread's artifacts after its first:
  `number` 2 and up, unique per thread, with `design_threads`' columns and
  `pictures`) and `thread_artifact_versions` (unique on artifact and
  version), both `staging:private`; and `design_artifact_id`, nullable with
  no default, on `chat_session_specs` (a plan) and
  `homeroom_bot_first_versions` (a project made from a design).
- How old rows get there: they do not move. A thread's first artifact stays
  in `design_threads` and `design_versions`, numbered 1, so nothing is
  copied, nothing needs adopting, and both builds number its versions under
  the same lock (`addVersion` locks the thread's `private_threads` row, as
  the build from before does). A new thread's first artifact is written
  there too (`addArtifact`); only the second and later go to the new tables.
  This is simpler than copying every row into new tables and mirroring the
  first back: no doubled HTML, no row an older build writes mid-release to
  adopt, and no numbering race between two copies.
- What an old build still sees: every thread's first artifact, exactly as
  before, with every version either build wrote to it. It never names the new
  tables or columns, so a later artifact is invisible to it. Its writes
  during a release land on the first artifact, which is what it always wrote.
- How to undo: run the build from before. Nothing it reads changed. Later
  artifacts stay stored, unseen, until a migration drops the two tables and
  two columns (nothing else depends on them).

The list queries that join a thread's title or newest version
(`private-threads.js`, `ai-search.js`, `ai-history.js`, `ai-work.js`,
`homeroom-bot-dm.js`, `plan-design-source.js`) still name `design_threads`
and `design_versions` on purpose: they mean the thread's first artifact, its
row exists exactly when the thread holds any, and written out whole each one
is still read by the SQL check. Only `artifacts.js` names the new tables.

**Routes** (`src/routes/conversations.js`). Every read carries `artifactId` and
`artifacts: [{ artifactId, title, artifactKind, latest, viewport }]`, in
creation order. `GET .../designs/:rootId/artifacts/:artifactId`,
`.../artifacts/:artifactId/versions/:version` and `POST
.../artifacts/:artifactId/propose` take one; the old addresses answer with the
first.

**Messages, pins and plans.** A version's message carries
`metadata.homeroomBot.artifactId` beside `designVersion`. A pin may carry
`design_pin.artifactId`, checked by `pinFor` and kept as
`metadata.designPin.artifactId`. A plan stores `design_artifact_id` (null for
the first), and the request page's door gets `artifactId` for a later one. A
design offer's card carries it in `bot_cards.args.artifactId`, a make card in
`metadata.makeProject.artifactId`.

**The turn.** It opens the artifact the message is about
(`design-threads.js threadOf`): the one the client says the person has open
(`metadata.showing.artifactId`), else the one a pin is on, else the one whose
version the message replies to, else the one the bot wrote last. Its context
lists the thread's artifacts (title, kind, newest version) and which is open.
A tool call that names another (`artifact`) opens it first, with its whole
HTML and its kind's capability and limits (`homeroom-bot-mayor.js
switchArtifact`); `write_artifact` with no number while one is open writes a
new artifact of the open kind, and `start_design` a new screen. One artifact
changes per turn. The version line names the artifact once the thread holds
more than one: "Layouts, version 2: ...".

**Shots.** `db/migrate.js seedStagingArtifactsThread` gives the shots member
(`usernode-capture`) one thread holding two pages: "Staging demo: style
directions" at version 2 and "Staging demo: list layouts" at version 1.

## One policy, three frame modes

`src/services/artifact-policy.json` holds the policy text. The server reads it
through `src/services/artifact-policy.js`, the shell through
`frontend/src/features/artifact/policy.ts` (both Dockerfiles copy the JSON
into the shell's build). `tests/artifact-policy.test.js` pins every mode's
sandbox and policy, whole, and holds the two modules to the same text.

| Mode | Sandbox | Scripts | Used by |
|---|---|---|---|
| `run` | `allow-scripts` | the page's own inline scripts | a design or a page, for its author: the pane, the version card, the comparison |
| `static` | `""` | none | a plan's screens (all three places), a first look's drawn screen (served by its route with the same policy as a header), a change's email pictures (the thumbnail), a comparison the bot lays out in a thread, anyone but the author until they choose |
| `helper` | `allow-scripts` | Homeroom's helper only, by a nonce made new for each frame (`script-src 'nonce-...'`) | the bot's laid-out answers, which must tell the chat their height and where their links are; an opened email, which must tell the viewer its height |

Every mode: `default-src 'none'`, `connect-src 'none'` (no fetch, socket or
beacon), `form-action 'none'`, `frame-src 'none'`, `base-uri 'none'`. A design
loads this site's stylesheets, pictures and fonts (`{site}`); a page names no
origin at all and loads nothing. **No frame ever has both scripts and
`allow-same-origin`; no sandbox in the policy names `allow-same-origin`.** The
bot's laid-out answers used `allow-same-origin` so the chat could measure them;
the helper now says their size and the boxes of their links by message, and a
link opens in the same tick as the press.

The HTML attachment Preview keeps its own route and shares the constant
(`ATTACHMENT_VIEW_CSP`). Live drafts are real app code on a preview host and
are not artifacts.

One way out no policy closes: a running script can navigate its own frame. The
pane draws the version again whenever its frame loads a second time.

## The one frame, and the viewer rule

`frontend/src/features/artifact/frame.tsx` (`ArtifactFrame`) is the only frame
any of these surfaces draws; `frame-doc.ts` builds its document (the policy
first in its head, the helper, no `<base>`). The helper inside the frame is
generic: pins, the frame's own picture for a comment, its size and its links.
Pins work on any artifact.

The viewer rule lives in the frame, with a test (`frameModeFor`):

- A page asked for in `run` mode runs only for its **author**. `viewer`
  defaults to `other`, so a caller that forgets gets the safe side.
- Anyone else sees the static version (scripts and handlers taken out) until
  they choose to run it, and then in a plain box that says whose page it is and
  that it is not part of Homeroom: no card, header or button of the shell's
  around or over a running page.
- A caller cannot hand a prebuilt or served document to a running frame.

Today every running page is read from its author's own private thread.

The last two surfaces are on it too (20 Nov 2026): a change's email pictures,
the thumbnail static and the opened email in the helper mode (the per-frame
nonce helper reports its height by message, so no frame is same-origin), and a
comparison the thread voice lays out, drawn in the project thread in static
mode instead of posted as an HTML file. The admin's email template editor is
the one frame kept: it edits a template in place, shows no HTML the bot wrote,
and needs to read its own document.

## The capability

Step 6 of `bot-one-model.md` made one agent answer every private thread, with
capabilities added by the thread's state (`bot-profiles.js CAPABILITIES`). A
thread's artifact is opened by its kind (`artifact-session.js open`): the
design kind's session or the plain kind's. `capabilitiesInChat` picks the
capability by `artifactKind`.

- `write_artifact` (the chat's own tool, `src/services/bot-tools/artifact.js`):
  writes a page in one step and loads the `artifact` capability for the rest of
  the turn. With an artifact open it is the open kind's own tool: with no
  `artifact` number it writes a NEW artifact, with one it writes that one again
  whole (K, F).
- `edit_artifact`, `show_artifact`, `compare_artifacts`: the plain kind's
  session's tools. Edits are exact find-and-replace pairs (one `applyEdits`
  for every kind), because a step writes about 16,000 output tokens.
- **Cost.** A chat with no artifact pays for one tool's description. An
  artifact is put in the prompt only while one is open in the thread, a page's
  section reads no project and inlines no stylesheet, and its limits are lower
  than a design's (`ARTIFACT_LIMITS`: 8 rounds against a design's 12). The
  model is shown, and may edit, a version of at most 120,000 characters.
- **Private threads only.** None of these tools is offered in a project's
  thread. Nothing publishes an artifact to a project or to another person.

### What only a design may do

A design is the one kind that leaves its thread, and only by its author's own
tap: as a plan (`design-threads.js postDesignPlan`, the pane's Request it,
`proposeDesign`), or as a new project's first screen (`POST /api/apps` with
`design`, a first version's early plan and its plan). Each of these refuses a
page with `not_a_design` (`design-threads.js isDesign`), and so does the
thread's New project door (`private-threads.js stateOf`, the reply check's
`newProjectDoorShown`), and the chat's `offer_new_project` in a page's thread
(`artifact-session.js holdsPage`). Since K, `start_design` in a page's thread
draws a new artifact beside the page. A page's words are its
own: "Page preview", "Version N of the page", "Writing" on the working card,
"I'm writing ... in a new thread", and its own reply check (`page_done`).

The abilities that make a design accurate stay the design kind's tools: the
project's stylesheets inlined, hosted Tailwind compiled on the server, the
style check, the rendered look, `capture_page`, phone and desktop sizes,
pictures, `read_plan`, `offer_plan`, `offer_project`, and the rule that a
design's static markup must carry the screen (`planGap`), because the plan
drops its scripts.

### Design as a kind with a skill (stage 3)

- **The skill.** What a turn is told while a thread's design is open is the
  design kind's skill, `src/prompts/artifact-design.md`, read once and loaded
  only then (`design-bot.js designSkill`, filled in by `designPrompt` with the
  stylesheets, the version it saves, today's calendar and the pages it can
  copy). It is written against the chat's own rules, not beside them: a
  question says first what makes it necessary and what its answer changes
  (it was "ask one short question"), and nothing promises anything later.
  What is the design's own (what it was asked, its pictures, the app's screen
  now, its current version) is still added by code.
- **The generic write and edit.** A design is drawn with `write_artifact` and
  changed with `edit_artifact`, defined once in `bot-tools/artifact.js` with a
  description per scope (the `design` scope's says it draws a screen in the
  project's look). The names they had while design was a mode,
  `write_screen` and `edit_design`, are owned and run by the design's session
  for one release (`design-bot.js OLD_NAMES`), for a thread whose history
  calls them, and are never offered.
- **The kind's limits.** `artifacts.js KINDS` gives each kind its limits (the
  design's 12 rounds, the page's 8), the same objects its capability's turn
  grows to (`bot-profiles.js CAPABILITIES`).
- **Kept, on purpose.** `start_design` stays: it is how a thread starts a
  design, and a design must load its skill (the project's stylesheets, its
  entry page and the markup its scripts build) before it draws, so it cannot be
  the one-step write a page is. The design's session (`openSession`) is the
  design kind's, beside the page kind's (`openPage`), behind one dispatch
  (`artifact-session.js open`). The reply tool with a version's summary
  (`DESIGN_REPLY_TOOL`) serves both kinds. The `offer_request` variant that
  refuses the design's own project stays the design kind's.

### Drafts get the same treatment (#6915)

- **The skill.** A live draft's instructions are its own skill,
  `src/prompts/artifact-draft.md`, read once and loaded only while a draft is
  open (`live-draft-bot.js draftSkill`). It is written against the chat's own
  rules: a question says first what makes it necessary and what its answer
  changes (the prompt used to say "ask back when what they want is unclear"),
  and nothing promises anything later. It says what the preview really runs
  on, its own copy of the app's data. What is the draft's own (its files,
  what has been saved, the app's notes, the opening note) is still added by
  code.
- **One edit function.** A draft's file edit runs `artifact-session.js
  applyEdits`, as a design and a page do, at the draft's own
  `DRAFT_LIMITS.editsPerCall` and with its own error sentences.
- **Honest failures.** A failure on Homeroom's side (the preview, its
  supervisor, or the platform under it) is said as Homeroom's, spends none of
  the turn's applies and asks for no code change. An app that stopped after
  an edit is the app's own failure, fixed or put back in the same turn. A
  change that needs a full rebuild says so and how long it takes, and a
  preview that never started leaves the draft's bar saying how to retry.

## The plan stays a document

**Decided against: a plan as a free page with scripts.** Ten readers take
things out of a plan: the builder's prompt, a first version's starting screens
(which become the app's first code), the before and after screenshots (which
need the plan's steps as data), the plan card, the proposal's title and
description, the blocking-questions gate, the plan-match check, triage, the
review rounds and the connector. A free page with scripts would need a second,
machine-readable manifest beside it, and its rules would have to say
everything the `data-spec` contract (`prompts.js specHtmlContract`) says now:
that is the current format with another layer. So plan storage, the contract
and every reader stay exactly as they are. A plan points at a design by id
and version; it is never an artifact with scripts.

Plans are drawn by the same frame in `static` mode. A plan made from a design
shows its author a door to the interactive design at the version the plan
shows (stage 4, light): the request page's link back to the author's thread
(`design-threads.js threadForRequest`, read for the viewer alone) carries the
version their plan stored, and "Open the design, version N" opens the design
beside its thread, running, as its author's always does. Nobody else's read
carries it; everyone else sees the plan's own static screens; and no server
path serves an artifact to anyone but its author.

## Stages

| Stage | What | State |
|---|---|---|
| 0 | A plan stores the design it came from | built |
| 1 | One store, one frame, one policy; surfaces moved | built |
| 2 | The artifact capability and its tools, private threads only | built |
| 3 | Design as a kind with a skill | built, with what is kept above |
| 4 | Plans drawn by the same frame; the author's door to the design | light: built |
| K | Several artifacts in a thread | built |

## What is left

- After one release: stop running `write_screen` and `edit_design`
  (`design-bot.js OLD_NAMES`).
- The rest of the design kind's own words still live in `design-bot.js`: the
  descriptions of its other tools and its nudge notes (the checks that send a
  turn back to draw). They could move into the skill text too.
- Renaming `design_threads` and `design_versions` to the store's own names,
  once no build from before runs. Dropping nothing before that. K's later
  artifacts could then move in beside the first, into one table each.
- Showing an artifact to anyone but its author: decided against for now. If it
  is ever wanted, it needs a route with a header policy on the separate site
  `browser-site-isolation.md` describes (built, switched off), and the viewer
  rule above.

