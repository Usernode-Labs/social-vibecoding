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
| reviewing / proposing / building | building · `reviewing` / `proposing` / — |
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

- **`bot-tools/`**: each tool once (name, schema, scope, handler). The chat,
  voice, design and already-done profiles list tool names. Tools that exist
  in the web connector (`mcp-tools.js`) take its schema.
- **`bot_cards`**: one store for new offers and cards (file a request, close,
  withdraw, move, copy, post a plan, project, admin confirm), one tap handler,
  up to 3 per reply.
- **One change-ask queue:** every "change my change" (chat `revise_proposal`,
  voice `update_change`, project chat revise) goes to
  `homeroom_bot_change_asks`.

## Step 5: threads as the unit

- **Thread kinds:** `main`, `private` (ask, draft, idea), `design`, `request`,
  `change`, `channel`, `reply`.
- **One entry:** `threadBot.answer(thread, message)` picks the kind's profile
  (tools, limits, speaking rules, prompt section) and runs it on the turn
  engine.
- **Speaking rules unchanged:** the voice's `gate()` rules become profile
  data.
