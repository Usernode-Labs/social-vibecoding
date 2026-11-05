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
   up for a vote"; one failure post, updated in place; and "live". Nothing
   else is a message: no relays into Main Chat, no private-thread milestone
   lines, no channel chips. The first-version line in a project's channel
   stays.
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

### Push and the bell

Every changed row is pushed as `work_state` to everyone who can see the item.
Surfaces apply it in place. Their polls go.

A change of stage rings the requester's bell:
- into `waiting_for_you`: needs you;
- into `up_for_vote`: ready to vote;
- into `stopped`: stopped;
- into `live`: live.

### Readers

These read `work_states`; their own deciders are deleted:
- the Homeroom bot tab (ai-work.js, model.ts)
- the chat's activity drawer (tray.js)
- the activity cards (activity.js)
- the request page's track card (track.js)
- project chat cards (homeroom-bot-chat.js)
- the bell (dm moments)
- the Workshop (needs-feed, waiting)

## Step 4: posting rules

The request thread keeps:
- the bot's question or plan;
- "built it, up for a vote";
- one failure post, edited in place;
- "live".

These go:
- DM relays of request news (`relayIssuePost`);
- milestone lines in private threads (`noteMilestone`);
- request news in Main Chat;
- channel status chips;
- duplicate change-thread copies.

The first-version line in a project's channel stays.

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

- **Thread kinds:** `main`, `private` (ask, draft, idea), `design`,
  `request`, `change`, `channel` (a project's chat and its topics), `reply`.
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
