# Homeroom bot: one model (steps 2–5)

Status: in progress, 5 Nov 2026. Step 1 (one turn engine) is #6354, merged.
Map of the bot as it was: https://claude.ai/artifact/FUxtxVsh5jYeRbYqFavVZB

Each thread has an instance of Homeroom bot: one turn engine, run with the
profile of that thread's kind, acting through one registry of tools (the
thread's and the platform's). Long work (triage, plan, build, follow-up,
look) runs as jobs. The jobs write one work state per request and per change,
and every surface draws that state. A thread's messages are only what was
said there.

Agreed with Evan on 5 Nov 2026:

1. One in-process tool registry, in the web connector's schema shape where a
   tool exists in both. Not an MCP server per thread.
2. Up to 3 cards per reply.
3. One store for new cards. The six old stores stay answerable until answered
   or 14 days old; a later cleanup drops them. No data migration.
4. One stage vocabulary everywhere (below).
5. The work state is stored, written when it changes; one push carries it.
6. In a request's thread the bot posts only: its question or plan; "built it,
   up for a vote"; a failure note; and "live" (and its answers when somebody
   speaks to it there). Nothing else is a message: no relays into Main Chat,
   no private-thread milestone lines, no channel chips. The first-version
   line in a project's channel stays. Amended by Evan, 11 Nov 2026: failure
   notes are never edited. A new failure is a new note, said only when its
   words differ from the last failure note in that place or somebody has
   replied since; a repeat posts nothing (the status card already shows
   it); a newer note retires the older note's buttons.
7. The bell is derived from stage changes: needs you, ready to vote, stopped,
   live.
8. Main Chat holds only the conversation.
9. When the bot speaks is unchanged: today's rules, as each thread kind's
   profile data.
10. Legacy request-card threads stay readable.
11. No switch back: the old code is replaced.

## Step 3: one work state

### Vocabulary

| Stage | Means | Whose move |
|---|---|---|
| `reading` | the bot is reading it, or it waits to be read | bot |
| `planning` | the bot is writing its plan | bot |
| `waiting_for_you` | the requester's move; always with a `why` | requester |
| `building` | the bot (or a person who claimed it) is building it | bot / builder |
| `checking` | its change's tests are running or failing | bot |
| `up_for_vote` | its change waits for votes | group |
| `going_live` | approved and merging, or merged and not yet live | nobody |
| `live` | its change is live (shown for 7 days) | nobody |
| `stopped` | the bot stopped; with a `reason`; a person can restart it | requester |
| `closed` | the request or change was closed | nobody |

`why` for `waiting_for_you`: `question`, `plan`, `decide`, `already_works`,
`needs_detail`.

`reason` for `stopped`: `build_failed`, `fix_stopped`, `look_failed`,
`change_closed`, `stalled`.

The second line (`line`, a code plus values) carries queue and hold reasons,
and detail: `queued` (place in line), `held_builds` (the project's build
slots), `held_waiting` (changes waiting for votes), `on_hold` (building time
used up, until Monday), `reply` (reading your reply), `retry_plan`,
`reviewing` (round n of m), `starting`, `proposing`, `fixing`, `revising`,
`update_queued`, `checks_failing` (n failing), `first_version`, `claimed`
(by whom), `planning_with_you` (a private thread holds it), `paused`.

### Mapping from the old deciders

| Old (`progress.stageOf` / `handedBack` / `outcomeOf`) | New stage · line |
|---|---|
| reading / reading (reply) | reading · `reply` when a reply |
| queued | reading · `queued`; with a failed plan: planning · `retry_plan` |
| on_hold | reading · `on_hold` |
| held (builds_per_app / waiting) | building · `held_builds` / `held_waiting` |
| build_queued / starting | building · `queued` / `starting` |
| stalled | stopped · `stalled` |
| planning | planning |
| reviewing / proposing / building | building · `reviewing` / `proposing` / no line |
| plan / awaiting plan (B6) | waiting_for_you · plan |
| question | waiting_for_you · question |
| decide (verdict person) | waiting_for_you · decide |
| already_works | waiting_for_you · already_works |
| verdict empty, a `blocked:` build | waiting_for_you · needs_detail |
| build_stopped | stopped · build_failed |
| fix_stopped | stopped · fix_stopped |
| fixing / revising | building · `fixing` / `revising` |
| fix_queued / followup_queued | up_for_vote · `update_queued` |
| checks / checks_failed | checking · `checks_failing` when failing |
| vote | up_for_vote; a first version: going_live · `first_version` |
| merging, merged not live | going_live |
| merged and live | live |
| change closed, request open | stopped · change_closed |
| look failed | stopped · look_failed |
| request closed, skipped | closed |

### Storage

`work_states` holds one row per item: `(app_id, item_kind 'request' |
'change', item_ref)` with `issue_number`, `session_id`, `stage`, `why`,
`reason`, `line` (jsonb), `whose_move`, `since`, `requester_id`,
`updated_at`.

`work-state.js` owns it:
- `derive(facts)` is pure: the one decider.
- `refresh(db, items)` reads the facts with the shared per-request query
  (`REQUEST_RECORD_COLUMNS` / `requestRecordJoinsSql`), derives each item,
  upserts the changed rows, and returns them.

Writers call `refresh` where an item's facts change:
- the workflow machines: bot-request, bot-build, bot-change and proposal,
  as a domain write in the transition's own transaction;
- the routes that change a request or change outside them: close, reopen,
  claim, vote.

One writer at a time per item (review B3, 19 Nov 2026): `refresh` takes
the item's lock (`pg_try_advisory_xact_lock`, `WORK_STATE_ITEM_LOCK`)
before it reads the item's facts, and holds it to the end of its
transaction, so no write puts an older reading of the facts over a row
derived from a newer one. It never waits for the lock: a writer that finds
an item taken leaves it to the holder (what it wrote marked the item; the
drain marks a skipped item again). A reader that makes a missing row
publishes it like any other write (`ensure`, `ensureChanges`). Which derive
wrote a row is its own column, `derive_version`, as well as `standing.v`
for the release before; a row whose only change is that, or its due time,
is stored quietly. A row whose `since` moved has changed.

### Push and the bell

Every changed row is pushed as `work_state` to everyone who can see the item.
Surfaces apply it in place. Their polls go.

A change of stage rings the requester's bell:
- into `waiting_for_you`: needs you;
- into `up_for_vote`: ready to vote;
- into `stopped`: stopped;
- into `live`: live.

Once per moment (review B3): the bell carries a key of its item, stage
(with its why or reason) and `since` (`notifications.bell_key`), and is not
rung again while a bell with that key is unread.

### Readers

These read `work_states`; their own deciders are deleted:
- the Homeroom bot tab (ai-work.js, model.ts)
- the chat's activity drawer (tray.js)
- the activity cards (activity.js)
- the request page's track card (track.js)
- project chat cards (homeroom-bot-chat.js)
- the bell (dm moments)
- the Workshop (needs-feed, waiting)

### Step 1, built 11 Nov 2026

The standing, finished on the server (the first commit of the one-model
proposal):

- Each row also stores its `standing` (its change: checks, votes this
  round, GitHub's hold, shots, an update on its way; what is asked of the
  requester: an open question, a plan, a vote to close it, a private
  thread holding it, open cards; the bot's newest post about it; a
  request's tries, why its build stopped, who shipped it), `vote_open` and,
  on a request, `lead_change_id`. A change has its own row even when it was
  built for a request; that row never rings the bell.
- `vote_open` is the change's stage being `up_for_vote`. `deriveChange`
  holds a vote for a first version, an update on its way (now `building`,
  `update_queued`, not `up_for_vote`), a merge GitHub holds, and shots
  still being taken, so a stage of `up_for_vote` is always a change open
  for votes. Needs you and the vote digest read `vote_open`.
- The words exist once: `phrasesOf(item)` maps an item to core catalog
  phrase ids and ships with every row and push as `words`; the server's
  English reads the same catalog (push-text.js). The hand-copied table is
  gone.
- The bot tab, the activity cards, project chat cards, a request's track,
  the request page's `standing` (with the viewer's `mine` and `voteOwed`),
  Homeroom bot's progress, my_work and request_detail, and the voice's
  facts read the rows. Gone: ai-work's fallback, the chat card's own
  derivation, progressFor, progressText, proposalFacts, botWorkByIssue,
  statusOf, and the track's own reads of holds, tries and who shipped it.
- Finished 19 Nov 2026 (what was left for later):
  - A first version's App tab steps (homeroom-bot-dm.js firstVersionStateOf,
    read by the App tab, the hub, the made screen and the Home tile) draw
    its request's stored row: `progress.firstVersionStageOf` names the work
    state in the steps' own vocabulary, and the shared per-request record
    gives only when each step began. Where the old decider disagreed, the
    row wins: a build that stalled (Building before), the bot stopping its
    fixes (no step), a failed look and a closed change (the starter app)
    say Stopped; a check being fixed for it (#6807, no step) is Testing;
    a question its look asked with none open in the chat is its maker's.
    A hand-back the steps have no line for (decide, already works, needs
    detail, a build skipped) is the app, as before.
  - The activity cards' catch-up (homeroom-bot-activity.js catchUpCards)
    finds the work under way from the person's rows (`busyNow`, less a
    follow-up on the change), keyed by the same records as before.
  - The "new proposal to vote on" ping is rung from the row
    (work-state.js `votePings`) when a change's row opens for votes, and
    reads `vote_open`; the machines (proposal, preview, merge queue) and
    rename-pr no longer ring it, and `voteReadySql` / `syncWaitSql` are
    gone. It no longer asks while shots, an update on its way, GitHub's
    hold or votes already in keep the change off Needs you.
  - The bot's own stopped build no longer reads as somebody building it:
    its session (paused, linking the request) is not the request's change
    (deriveFacts), so the bot page says Stopped too and its Try again
    stays.
  - Gone with no reader left: requestStates, progress.outcomeOf and what
    only they read (requestRows and its cap, attachAttempts,
    attemptOutcome, buildUnderWay, projectsBusy, queuedWait, buildWait,
    the first-version and plan holds' words, QUEUE_NEXT). Nothing of step
    1's list is left.

## Step 4: posting rules

The request thread keeps:
- the bot's question or plan;
- "built it, up for a vote";
- a failure note, never edited (decision 6 as amended, 11 Nov 2026): a new
  failure is a new note only when its words differ from the last failure
  note there or somebody has replied since; a repeat posts nothing; a newer
  note retires the older one's buttons;
- "live";
- its answers when somebody speaks to it there.

These go:
- DM relays of request news (`relayIssuePost`);
- milestone lines in private threads (`noteMilestone`);
- request news in Main Chat;
- channel status chips;
- duplicate change-thread copies.

The first-version line in a project's channel stays.

### Step 4, built 11 Nov 2026

One posting function, append-only (`src/services/bot-post.js`, migration
`bot-posts`):

- Every word the bot says to people is one post, keyed by what it is:
  `kind:subject:version` (`build_failed:request:3-12:run-40`,
  `checks_retry:change:6564:look-3`, `reply:place:3:issue:12:turn-<key>`,
  `going_ahead:request:3-75:mention-4242`). The key is claimed in
  `bot_posts` (`said_key` unique) before anything is sent, so a post asked
  for twice (a retry, a restart, two passes at once) is said once; one a
  restart caught going out is `pending`, and the retry sends only what its
  row has not recorded. The ask that claims a post holds the claim while it
  says it (migration `bot-posts-claims`: `claimed_at`, `claimed_by`); a
  second ask meanwhile says nothing (`busy`), and a pending post is taken
  over only once its claim has lapsed, by one conditional UPDATE (a durable
  work's own post, keyed by its run, look or turn, is taken over at once by
  that work's next attempt after a crash, as before claims). A send
  that fails throws, its claim let go, so the caller's retry says it (the
  voice's replies, a "tell me when"); only best-effort callers (the
  change's notes, `live.post`'s copy on a change) pass `soft`. The message
  is written with its record (`ws.sendBotMessage` / `sendSystemMessage`
  `onInsert`, and `sendDm`'s `afterInsert`). Outcomes: `said`, `refused`,
  `repeat`, `pending`. `homeroom_bot_posts` stays as the request's
  projection its readers use, written once a post is said.
- One rule table per place (`RULES`) replaces THREAD_KINDS, with no bypass:
  `live.post`, the thread notes (`postThreadNote`), the change's notes
  (`live.postOnProposal`), the voice's replies and its pointer to another
  request, a held request's answer, a newer plan taken up, a person's change
  claiming a request, a "tell me when" kept, the plan card on a change,
  the bot's own version of a change, and the move's lines all say through
  it. What a place does not hear is recorded as `refused`. A request's
  thread hears the families above; a build's note on another change it
  builds beside or on top of (#6423, #6428) is part of its plan. A person's
  chat with the bot records each message through its transport
  (`homeroom-bot-dm.js sendDm`, keyed by its idempotency key), and refuses
  request news, recorded.
- Failure notes as amended: the same words as the place's last failure
  note (its newest by message), with nobody writing since (there, or in a
  reply thread under a message there since) and nothing else said there
  since, are a `repeat` (no message, no GitHub comment, no DM, no
  mention); anything new is a new note, and the older note's buttons retire
  (`bot-cards.js retireFor` `messageIds`). A change's notes on its checks
  are failure notes in its thread.
- Words shown never change: a plan's row keeps its words and only its
  status moves (`notePlanRows`, the boot backfill); no bot UPDATE of a
  message's content remains (`tests/bot-post.test.js` pins it). Nothing
  streams an answer's words: the working card names the step, and the
  answer appears once, whole.
- Gone: `updateRepeatedBuildFailure`, `replaceFailurePost`,
  `FAILURE_TRIES_MARK` and the "(Tried N times.)" rewrite, THREAD_KINDS,
  `saidInThread`, `threadMessageOf`, `takeUpPending` and the pending
  projection rows (the held answer is claimed in `bot_posts`), `runPosted`,
  `postOnce`, the looks' once for notes and waits, the voice's reply found
  by scanning for its turn mark, the step 5 hand-off and checks-note repeat
  reads (the failure rule says it), `PLAN_ROW_ENDINGS`, and the dead
  streaming code (`draftTail`, `MAX_DRAFT_*`, the typing event's words,
  `botDraftText`, the working card's draft and its stitching).
- `duplicateNotes(pool, { since })`: the notes on requests said or asked
  for more than once (per request and kind, past the first, and every ask
  for a key already said), the admin's re-read numbers' "Notes said twice".

## Step 2: one tool registry, one card store, one change-ask queue

### What there is today (5 Nov 2026 map)

- Four surfaces build their own tool arrays and dispatch: Main and private
  threads (`homeroom-bot-mayor.js`, ~25 tools plus the thread tools and ten
  platform reads), the voice on request, change, channel, topic and reply
  threads (`homeroom-bot-voice.js`, ~20), design threads (`design-bot.js`,
  ~14) and the already-done check (`homeroom-bot-already-done.js`, 2).
- The same tool is declared up to five times with different schemas:
  `list_source` / `read_source` four times, `reply` five, `tell_me_when`
  twice with different arguments, `offer_close_request` three shapes.
- Main's platform reads take the web connector's schemas (`mcp-tools.js`,
  through the mayor shim); the voice and the design bot hand-write smaller
  copies of the same reads. The admin thread tools build theirs from the
  connector's registry already.
- Offers and cards live in seven places: `homeroom_bot_dm_actions`,
  `homeroom_bot_voice_offers`, `chat_bot_requests`,
  `homeroom_bot_admin_actions`, `metadata.homeroomBot.card`,
  `metadata.homeroomBot.actions`, and `private_threads`. Each has its own tap
  route. Nothing expires but the admin confirm (15 minutes).
- "Change my change" reaches `homeroom_bot_change_asks` from the voice's
  `update_change` at once, and from Main's `revise_proposal`, a No vote with a
  line, a missed build note and project-chat revise only after they post on
  the change, and only while the voice is on for changes. With the change
  voice off, `update_change` still writes an ask nobody takes.

### The registry: `src/services/bot-tools/`

- `registry.js`: `define({ name, description, parameters, scopes, run })`;
  `toolsFor(names, ctx)` gives the model's tool array for a profile, with a
  schema that may narrow by scope (a request's thread knows its project, so
  `list_source` takes no `project` there); `run(name, args, ctx)` dispatches.
- One module per family: `source.js` (list_source, read_source), `say.js`
  (reply, stay_quiet), `platform.js` (get_change, get_discussion,
  list_requests, get_request, get_message and the other reads, their schemas
  taken from `mcp-tools.js`), `follow-up.js` (tell_me_when), and the rest
  registered from where their handlers live today.
- Tool names the model already uses stay, so prompts and the behaviour they
  teach do not move. Where two surfaces declared one tool differently, the
  one definition takes the union of their arguments, each optional where a
  scope fills it.
- Profiles list names; a surface builds its array with `toolsFor` and runs a
  call with `run`. A tool is in exactly one module.

### The card store: `bot_cards`

Built 5 Nov 2026 (migration `bot-cards`, `src/services/bot-cards.js`):

- The chat's offer table is the store, renamed to `bot_cards`, so its rows,
  open or decided, carry on as they were and nothing is copied. `place` says
  where a card was said: `dm` (a conversation message, `message_id`) or
  `thread` (a project thread's chat message, `chat_message_id`).
- A thread's new offers (file a request, file on many, withdraw, close,
  copy, move, try again) are cards too. Those said before stay answerable in
  `homeroom_bot_voice_offers` until answered or 14 days old: the voice reads
  both (`OFFERS_SQL`), and every card's id is above every older offer's, so
  an id names one row. A later cleanup drops that table.
- The old name `homeroom_bot_dm_actions` is a view of the chat's cards for
  one release, so a pod of the build before reads and writes the same rows
  while this one starts; the cleanup drops it.
- A card is open 14 days (`expires_at`); a tap after that is refused (410)
  and its buttons go, in the chat (`decideOfferTap`) and in a thread
  (`decideOffer`).
- Up to 3 offers under one reply in Main (`MAX_OFFERS`): the first rides on
  the reply, the others follow as cards of their own, and the same offer
  twice is one. The voice still makes one offer per reply.
- Taps keep their durable paths: the person's bot-dm machine for a chat
  card, the place's bot-voice machine for a thread's.
- Not moved: admin confirm cards (their own 15-minute store), the cards a
  thread tool draws in message metadata, suggestion prompts, and private
  threads' File it / Post it, which are not offers of the bot's.

### Step 3, built 11 Nov 2026

One offer store, written with its message (migration `bot-cards-retired`):

- A card is written in the same transaction as the message that shows its
  buttons, and the message's id is set there too: `ws.sendBotMessage` and
  `homeroom-bot-dm.js sendDm` take a `card` (what it is: kind, args, who it
  is for; `onInsert` for the caller's own write in that transaction). The
  callers pass that and nothing more: the voice's replies, an "already
  works" note's Propose to close, a note about Homeroom itself, a stop's Let
  it try again (inside the post the look says once, so a retried hand-off
  writes no second card), an overlap question, Main's offers, a design's
  plan, a first version's plan, a folded offer and the bring-a-friend
  nudge. Gone: `newOffer`, `tieOffer`, `threadOffer`, `tieThreadOffer`,
  `dropThreadOffer`, `settleThreadOffer`, live.post's re-link (#6582) and
  every link written after the message. A thread card from before whose
  link was lost is linked by the migration, from the id its message names.
- A tap names its card: the thread's buttons send `offerId` (from
  `metadata.homeroomBot.offer.id`), and `decideOffer` takes the card by id
  and project, then checks it is the tapped message's (`not_this_message`).
  A client that sends no id is answered from the id its message names; an
  offer from before the card store, by its message. A card whose buttons
  are on screen is always found.
- Buttons retire from the standing (`bot-cards.js retireFor`, one table,
  `STILL_WORTH`): Propose to close while the request is open and no vote on
  closing it is; Let it try again while it is stopped; an overlap, a copy,
  a move or a request to file while nobody is building it; a plan's Build
  it while the plan waits; Withdraw it while the change can be withdrawn.
  Work-state's refresh calls it when a row moves (its stage, why or reason
  changed, or a vote on closing it opened), so a card made a moment before
  its request's stage catches up is never taken back. It marks the card
  `retired` with why (`close_vote`, `closed`, `building`, `moved_on`,
  `superseded`) and empties the buttons on its message, whose words never
  change. `keep` (card ids) is the posting function's: a newer card of the
  same kind supersedes the older one. Gone: `retireOverlapOffers` and the
  plan card updates it covers (a newer plan, a plan that stopped waiting).
- A refused tap says why in place: the routes answer `{ error, code,
  reason? }`; the thread's line under an offer (`transcript.tsx
  BotOfferStatus`, the side panel's too) is drawn from its state and the
  refusal GroupChat keeps for the message, so it outlives the buttons; in
  Messages, a line after `.messages-bot-answers` (`bot-question.tsx`,
  `bot-plan.tsx`), and a retired card's line says why.

### One change-ask queue

- Every "change my change" records its ask in `homeroom_bot_change_asks`
  (`voice.recordAsk`), whichever way it came: Main's `revise_proposal`, a No
  vote with a line, a missed build note, project-chat revise, the voice's
  `update_change`. That is so while the change voice is on, its default.
  With it off, posted words are read as replies, as before, and only
  `update_change` records an ask (its words are not posted, so nothing is
  read twice).
- The follow-up takes, re-queues and sweeps asks whether or not the voice
  is on for changes, so none is stranded (done 5 Nov 2026).

## Step 5: threads as the unit

- **Thread kinds:** `private` (ask, draft, idea), `request`, `change`,
  `channel` (a project's chat and its topics), `reply`. Amended 19 Nov 2026
  (step 6): `main` went with Main Chat (14 Nov 2026), and `design` and
  `draft` are no kinds any more: a design a private thread holds and a live
  draft open in it are capabilities of the private profile's one turn, not
  speakers of their own.
- **One entry:** `threadBot.answer(thread, message, deps)` in
  `src/services/thread-bot.js` decides the thread's kind and hands it to that
  kind's profile. A profile (`src/services/bot-profiles/`) is data plus a
  runner: its tool names, its limits (rounds, reads, tokens, timeouts, turns
  per hour, cards), its speaking rules, its prompt section, and the
  surface's turn function it runs on the turn engine.
- **Speaking rules unchanged:** the voice's `gate()` checks become each
  profile's `speaks` list, in today's order: the switch for the place, a
  person's plain message, the connector and loop guards, relayed text, the
  writer has the bot, words already queued as an ask, then the place's own
  rule (mention, reply, followed, the 30-minute continue window).
- The routes and machines that hear a message (`heardInDm`, `insertHeard`,
  project chat) call `threadBot.answer`; nothing else picks a surface.

Built 5 Nov 2026:

- `src/services/bot-profiles.js`: seven kinds and their profiles. A project
  thread's kind comes from its place type (issue, session, chat or
  category, message); a message in the chat is Main, private (a private
  thread, or a request card's thread from before) or design. Amended 19 Nov
  2026 (step 6): a message in the chat is always private.
- The surfaces read their limits from their profile (the values did not
  change), and no surface offers a tool its profile does not list
  (`tests/bot-profiles.test.js`).
- The voice's `gate()` runs each kind's `speaks` rules in order
  (`SPEAK_RULES`), the common checks first, so the rules are data.
- `src/services/thread-bot.js answer`: the chat's routing (after what needs
  no model) and the bot-voice machine's turn call it; it runs the kind on
  its surface.

## Step 6: one agent per private thread

Built 19 Nov 2026 (request #6864, widened to every private thread).

### Why

A private thread still had three speakers after step 5, and which one
answered was decided by the thread's state before any model read the
message (`homeroom-bot-dm.js answerUserMessage`):

1. a thread whose live draft was open sent every message to the draft bot
   (`live-draft-bot.js answer`), whose only tools changed the draft's code:
   it could not offer or file a request, ask a question card, read a request
   or say where someone's work stood, and its replies were the only ones no
   reply check read (`reply-claims.js`);
2. a pinned comment on a design's preview, or a reply to one of its
   versions (`designDirect`), went to the designer (`design-bot.js answer`);
3. any non-quoting message in a request's thread with an open bot question
   was drafted as the answer to it (`answerOnRequest`), with no model;
4. any non-quoting message in a request's thread with a plan waiting for
   Build it was a change to the plan (`changePlan`), which read the request
   again first in line: "what does step 3 mean?" was planned again, never
   answered;
5. everything else was the chat's turn, which handed drawing to the designer
   (`draw_screen`: "call it alone, do not reply: the designer answers them")
   and handed an opened live draft to the draft bot.

Evan's thread 58922 (19 Nov 2026, 15 messages, 11 bot turns) showed what
that costs. "Nice, yeah lgtm. Can you implement?" went to the chat's turn,
which had only `offer_request` (the designer alone had `offer_plan`), so
#6863 was filed with no design: its body named "version 4" of a thread
nobody else can open, and its build ran from the words alone. "What would
the 2 earlier steps be?" was asked beside a change; the chat only handed
over and the designer only talked about the drawing, so nobody answered.
The version line was the designer's edit log, every `edit_design` note
joined with "; " and cut at 300 characters mid-word, and the designer,
told only that its edits make "the next version", called version 4 "version
3".

### What was built

- **One speaker.** Every message in a private thread is the chat's turn
  (`homeroom-bot-mayor.js runDmTurn`), its reply the one reply. Nothing hands
  a message to a designer or a draft bot: `draw_screen`, `ctx.drawScreen`,
  `design-bot.js answer` and `draw`, `live-draft-bot.js answer` and `opened`,
  `designDirect` and the `design` and `draft` thread kinds are gone.
- **Capabilities by thread state** (`bot-profiles.js CAPABILITIES`). The
  private profile gains the design capability in a thread that holds a
  design (`homeroom-bot-dm.js capabilityDeps`: `threadDesign`), or once a
  turn starts one (`start_design`, about the size of the `draw_screen` it
  replaces, so an ordinary chat's prompt does not grow), and the draft
  capability while a live draft is open (`threadLiveDraft`) or once a turn
  opens one (`open_app_preview`, which no longer ends the turn). A
  capability is a session the turn holds (`design-bot.js openSession`,
  `live-draft-bot.js openSession`): its prompt section (the design's rules,
  its HTML, size, pins, pictures and layout widths; the draft's files, notes
  and saved edits), its tools, and their handlers, which are the ones the
  two bots ran (edit application, the capture, the style check and the look
  at a version, the plan card; read, edit, apply and restart, rollback).
  Only the routing moved. Each section loads only in those threads; the
  turn's rounds, output room and request clock grow to the capability's
  limits (`turnLimits`) only while its tools are loaded, its rounds counted
  from where it opened.
- **The reply in a design thread** answers any question in their message
  first, then says "Version N: <summary>". N is the version the turn saved
  (`write_screen` and `edit_design` return it, and the prompt says it); the
  summary is the reply's own `summary`, written once for the version and
  stored as its note, never joined from per-edit notes (`edit_design` and
  `write_screen` lost `note`), and `design-threads.js versionLine` shortens
  it at a word (`clipWords`), never mid-word. The message carries the version
  card (`metadata.kind = 'design_version'`, Open preview) as the designer's
  did.
- **Approval files the design.** In a design thread the prompt says that
  lgtm, looks good, build, implement, file or post it is `offer_plan`, whose
  New request files the request with the design as its plan, and that
  `offer_request` is only for something that is not this design. An
  `offer_request` on the design's own project is refused with a pointer to
  `offer_plan` unless it says `notTheDesign`.
- **Request threads stop routing by state.** Decided before any model reads
  it: a suggested answer tapped under the question (`isSuggestedAnswer`),
  Build it said under a waiting plan (`isPlanGoWord`, the button's words),
  and a reply quoting the question or the plan card. Everything else is the
  turn's, which drafts their words as the answer (`answer_question`, Post it,
  as before) or plans the request again (`change_plan`: the old `changePlan`
  path, run as a tool, `asTool`) when that is what they meant, and otherwise
  answers. With the model switched off, the thread decides by state as it
  did.
- **One reply check, Stop and working card for the whole turn.** The draft's
  replies go through `reply-claims.js` (`draft_done`: a change said with none
  saved this turn); the design's claims are the same `drawing`,
  `design_done` and `not_built`. Stop covers every round (`apply_changes` is
  what lasts of a draft; no version is saved from a stopped turn), and the
  working card says "Drawing version 4" and "Changing the draft".
- **Asking says why.** The chat's prompt tells it to say, in one clause,
  what it found that makes a question necessary before asking it.

### What it costs

An ordinary private thread's turn is what it was: no design or draft
section, and `start_design` in `draw_screen`'s place. A design turn runs its
drawing rounds with the chat's prompt on top, about 400k input tokens where
the two turns took about 200k (the designer's 170k to 250k plus the chat's
27k hand-off), about a cent more on DeepSeek V4.1 Flash. One turn is recorded
and counted per message, not two.


## Step 7: the architecture pass (19 Nov 2026)

### Why

After step 6, a read-only pass of the bot looked at three things on every
surface: where its words come from, who decides each state a person sees,
and what happens when something fails. The surfaces that read the stored
work state agreed with one another. What went wrong came from places that
still decided for themselves:

- the push's own mappings;
- the first-version relay;
- the plan card;
- the change page's timeline and pill;
- the Workshop list;
- bot-change's own readiness check;
- the request machine, which dropped the bot's own retries.

Two fixes merged that day did not do their main job. #6859's plan retry
never ran, and #6868's credit wait never resumed: `bot-request owed()`
dropped any debt above priority 0 while the request was `building`. Request
#6864's plan failed at 12:03 UTC, after #6859 merged, and no retry came.

### What was built

**The bot's own retries and credit.**
- `plan_retry` and `credit_wait` are kept while a look or build runs, and
  taken when it ends after their own wait.
- A run stopped for credit no longer blocks reads.
- A build's 402 pauses the lane.
- One out-of-credit classifier (`openrouter-credit.js creditOut`, which
  reads the status, the body, the runner's error code and the runtime's own
  line) is used by every turn: read, plan, build, revise, checks fix, the
  chat, the voice and look_into. Each says one first-person line, keeps or
  refunds its work, and calls `noteOutage`.
- Admins are told at once.
- With no balance to read, a timed one-token probe lifts the pause, and a
  pause older than `homeroom_bot_credit_stale_hours` (6) raises an incident.
- A chat message the outage held is answered once when credit is back
  (bot-dm `CreditBack`, version 2).

**One stored state for every screen.**
- A closed bot change (stored `archived`) reads Stopped, not "Not started",
  and no longer hides a person's change.
- A credit wait reads "Waiting for building credit", and a retried plan
  reads "Trying the plan again".
- These now read the stored row instead of deciding for themselves:
  - the change page's timeline and pill;
  - the plan card;
  - the Workshop list;
  - the vote card;
  - Needs you questions;
  - a first version's Testing versus Going live.
- "Ready to try" bells and the ready-to-vote follow-ups ring when the
  change's row opens for votes (`votePings`), and are deduped against
  `pr_proposed`.
- The sweep is driven by due times (`standing.dueAt`), not a fixed 100 rows
  a minute.
- A project's queued requests are marked when the line moves.
- Each refresh runs with its pushes as one unit, and a mark that keeps
  failing is parked after three tries.

**The bot's words from stored causes.**
- One stop decoder (`bot-stop-cause.js`) is read by the note, the track
  line, `standing.cause`, the stage and the push.
- The push names the action the page really offers.
- A person's Stop says "Stopped by @x".
- A "person decides" verdict says who decides, or what kind of hand-back it
  is (setup outside the app, stored data, Homeroom itself, another project,
  the wrong project, close it).
- A blocked build is no longer "nothing to build".
- A failed build's note carries a Try again card that restarts it without a
  model.
- "I built this" says the vote opens once its tests and screenshots are
  done; this was agreed with Evan.

**Failures that told nobody.**
- A merge whose answer was lost is recorded as merged.
- A provider error in a sync's conflict turn backs off, instead of reading
  as an unresolvable conflict.
- An unresolvable conflict on the bot's change, an approved change stuck on
  GitHub's checks (capped at 15 tries a head), a checks fix lost twice and a
  failed deploy each reach the requester and, where it fits, an incident.
- A held voice answer whose post ran out of tries is decided again.
- The chat's fallback after a Stop says what the turn did.
- A verdict that could not be acted on is retried.
- A change whose review failed says so in its description.
- Out-of-memory and provider-code reads are counted as infra, not as model
  failures.

### Left for later

- **Before and after shots.** Most of the step's screens show only bot
  states, which a fresh staging copy cannot reach (the bot is off there).
  A person's change in shots, syncing or stuck on GitHub could be seeded,
  which would let those states be shot.
- **Voice and look_into.** These still ask to be asked again once credit is
  back; only the chat resumes by itself.
- **The live `updateComingSql` check in Needs you stays.** The row can lag
  a turn's start by the 3-second drain.
