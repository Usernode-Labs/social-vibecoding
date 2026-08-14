# Mobile push notification testing playbook

End-to-end procedure for verifying that every mobile push notification kind
reaches a real phone with the right copy. Written after the full 2026-08-13
verification run of the pre-Messages registry, then extended for platform
conversations. Intended for humans *and* coding agents: every trigger is an
exact API call, and the pitfalls that cost time on the first run are called
out inline.

## Architecture (what you are testing)

One pipeline serves every kind:

```
event → INSERT INTO notifications            (src/services/notifications.js)
      → DB trigger enqueue_mobile_push_deliveries   (src/db/schema.sql)
          gates: notification unread, category enabled for the user
                 (mobile_push_preferences), registration alive
                 (session_expires_at > NOW(), permission authorized/provisional),
                 deployment send_enabled + send_not_before
      → mobile_push_deliveries row (status 'pending')
      → worker sends via Firebase               (src/services/mobile-push-worker.js)
      → status 'sent' (or 'dead' + last_error_code)
```

Delivery normally happens **2–6 seconds** after the triggering event.
Title/body copy per kind: `buildCopy` in `src/services/mobile-push-policy.js`.
Kind → preference category: `src/services/mobile-push-preferences.js`
(closed registry — a kind absent there is push-ineligible by design).

## Prerequisites

1. **Receiving phone** logged into the mobile app as the *recipient* account,
   notifications permitted. Verify registration exists before anything else
   (see Verification below): `registrations` non-empty, `delivery_eligible: true`.
2. **All seven preference categories enabled** for the recipient
   (`lightweight_activity` — reactions/kudos — is **off by default**).
   The seventh category, `messages`, is on by default and covers all five
   `conversation_*` kinds. Confirm it with
   `GET /api/me/mobile-push-preferences`; if needed, recipient:
   `PATCH /api/me/mobile-push-preferences`
   `{"preferences":{"messages":true}}`. Re-enabling is prospective — it does
   not enqueue pushes for notification rows that already exist.
3. **Two accounts.** Self-actions are hard no-ops (self-reply, self-reaction,
   self-mention create no notification), and several kinds only fire on the
   *other* member. One account holds the phone ("recipient"); the other acts
   ("actor").
4. **A private-collab test app owned by the recipient** where the actor can be
   invited, plus **an app owned by the actor** (for the two invite kinds where
   the recipient must be the invitee). A throwaway actor-owned app is fine —
   it never needs to build.
5. **Account plumbing for an agent driving the test:**
   - The platform CLI stores **one credential per server origin, not per
     profile** (`src/cli/state.js`, `credentials.json` keyed by origin). Two
     profiles pointing at production share one login — you *cannot* hold both
     accounts in the CLI simultaneously. Swap with
     `node ./tools/social-vibecoding logout --profile <p>` then
     `login --profile <p> --no-browser`; the human approves the printed
     link/code in a browser logged into the target account (incognito for the
     actor account keeps the main session intact).
   - Cover the second account through a **logged-in browser session**
     (same-origin `fetch` with `credentials:'include'`) — also the only way to
     reach admin diagnostics, which the CLI token is denied
     (`/api/admin` is a denied prefix in `src/services/cli-api-policy.js`).

## Verification (server side)

`GET /api/admin/mobile-push/diagnostics?user=<recipient>` — **admin browser
session only.**

- Per-notification results are under the **`notifications`** key, each row
  carrying its `deliveries` array (`status`, `sentAt`, `errorCode`).
- ⚠️ The response also has a top-level `deliveries` key that is typically
  empty — do not conclude "no deliveries" from it. (First-run mistake.)
- `registrations` + `preferences` in the same payload cover prerequisites 1–2.
- Platform-wide state (Firebase project, `send_enabled`, last-24h send/dead
  counts) is under `overview`.
- Conversation deliveries are re-authorized immediately before send. An
  invitation permits membership status `invited`; the other four kinds
  require `member`. A read notification, a removed/left member, an archived
  conversation, or either user blocking the other in a direct conversation
  cancels the queued send (look for `notification_read` or
  `conversation_access_revoked`). Opening an active conversation marks its
  notifications read, so keep Messages closed until each expected push has
  reached `sent`.

Server `sent` means "handed to APNs/FCM". Final on-screen rendering can only
be confirmed by the human holding the phone — always ask.

## Per-kind triggers

All paths relative to the platform origin. "CLI" = the actor's credential via
`node ./tools/social-vibecoding api <METHOD> <path> --profile <p> --data '<json>'`;
"browser" = recipient's session. Lock the phone before each trigger (a
foregrounded app may swallow the banner).

| # | Kind | Trigger |
|---|------|---------|
| 1 | `mention` | Actor: `POST /api/apps/:slug/messages` `{"content":"@<recipient> …"}` (REST works) |
| 2 | `reply` | Actor: **quote-reply in the real browser UI.** WebSocket-only — the REST messages route drops the `quote` field, and a plain message does NOT fire it. Must use the reply control on a specific message and see the quoted block render. |
| 3 | `reaction` | Actor: react to the recipient's message **in the browser UI** (also WS-only). |
| 4 | `kudos` | Actor: `POST /api/sessions/:id/kudos` `{}` on a recipient-owned session in status promoted/merging/merged. |
| 5 | `collab_invite` | Actor (on an app the actor admins, collab_visibility private): `POST /api/apps/:slug/invites` `{"username":"<recipient>"}` |
| 6 | `collab_invite_accepted` | Recipient invites actor; actor: `POST /api/invites/:appId/accept` `{}` |
| 7 | `approver_invite` | Recipient must already be a member of the actor's app, then actor: `POST /api/apps/:slug/approver-invites` `{"username":"<recipient>"}` |
| 8 | `approver_invite_accepted` | Recipient invites actor as approver; actor: `POST /api/approver-invites/:appId/accept` `{}` |
| 9 | `spec_shared` | Actor needs a session with a spec version. Cheapest: `proposal_start` (MCP/CLI handoff) writes spec v1 without any LLM turn → `POST /api/sessions/:sid/specs/1/share-user` `{"username":"<recipient>"}` |
| 10 | `session_done` | Recipient: create a session (`POST /api/apps/:slug/sessions` `{}`), then one trivial turn (`POST /api/sessions/:id/chat` `{"message":"Do not change any files. Answer in one sentence: what does this app do?"}`). Fires on **every** interactive turn completion. |
| 11 | `auto_solve_done` | Recipient: file an issue (`POST /api/apps/:slug/issues`), then `POST /api/apps/:slug/issues/:number/headless-session` `{}`. Fires at the runner's terminal state. The `question`/`failed` body variants are hard to force deliberately; the "finished" variant is the reliable one. |
| 12 | `pr_proposed` | Actor promotes a proposal on a shared app (recipient receives as "other member"). Full path: `proposal_start` → local commit → `proposal push` (CLI) → `proposal_submit_build` → poll `GET /api/sessions/:id/proposal-handoff` until `"state":"ready"` → `proposal_promote`. ⚠️ Idle handoff sessions **auto-pause**; `POST /api/sessions/:id/resume` first or promote returns "not ready". |
| 13 | `check_failed` | ⚠️ Fires **only on staging boot failure** (`src/services/staging-recovery.js`), *not* on failing dapp tests. Recipient-owned proposal whose `server.js` throws at import (`throw new Error(...)` as line 1) → submit build → container crashloops → push in ~4 min. **Archive the session immediately after** (`POST /api/sessions/:id/archive`). One notification per failure streak (`check_error_notified_at`). |
| 14 | `stale_pr` | **Not force-testable.** Background sweeper, fires after days of a promoted proposal receiving no votes. Copy is pinned by `tests/mobile-push-policy.test.js`. |
| 15 | `conversation_invite` | Actor creates the disposable group described below: `POST /api/conversations` `{"kind":"group","title":"Mobile push <run>","member_ids":[<recipientId>]}`. Wait for this push before accepting. |
| 16 | `conversation_message` | After acceptance, actor: `POST /api/conversations/:id/messages` `{"content":"ordinary push test","idempotency_key":"push-message-<run>"}`. Do not include the recipient's handle or `reply_to_id`. |
| 17 | `conversation_mention` | Actor: `POST /api/conversations/:id/messages` `{"content":"@<recipientUsername> mention push test","idempotency_key":"push-mention-<run>"}`. The handle must be the recipient's exact active-member username. |
| 18 | `conversation_reply` | Recipient first creates the setup message below; actor replies with `POST /api/conversations/:id/messages` `{"content":"reply push test","reply_to_id":<recipientMessageId>,"idempotency_key":"push-reply-<run>"}`. Conversation replies are REST-capable (unlike legacy app-chat replies). |
| 19 | `conversation_reaction` | Actor: `POST /api/conversations/:id/messages/:recipientMessageId/reactions` `{"emoji":"👍"}`. This endpoint toggles, so the first call for that actor/message/emoji must add the reaction; a second call removes it and its notification. |

### Messages sequence (kinds 15–19)

Use a new group for each run so direct-message consent history and an old
reaction toggle cannot affect the result. Substitute a short alphanumeric
timestamp for `<run>`; idempotency keys must be unique, 8–64 characters, and
contain only letters, digits, `.`, `_`, `:`, or `-`.

1. Actor: `GET /api/users/search?q=<recipientUsername>&scope=messages`; take
   the `id` from the exact username match as `<recipientId>`. Create the group
   with trigger 15 and retain `conversation.id` from the response.
2. Lock the phone and wait for the nested diagnostic row for
   `conversation_invite` to show delivery `sent`, then confirm the phone says
   `@actor invited you to a conversation · Mobile push <run>` and
   `Open Messages to accept or decline`. **Do not accept early:** acceptance
   marks the invite notification read and can cancel an in-flight delivery.
3. Recipient (logged-in browser):
   `POST /api/conversations/:id/respond` `{"action":"accept"}`. Keep the
   Messages screen closed after this call.
4. Run triggers 16 and 17 separately, waiting for `sent` and on-device
   confirmation after each. The body should be the sent content; the title
   should say the actor sent a message or mentioned the recipient and include
   the group title.
5. Recipient (browser): `POST /api/conversations/:id/messages`
   `{"content":"recipient setup message","idempotency_key":"push-source-<run>"}`;
   retain the returned `message.id` as `<recipientMessageId>`. This may notify
   the actor, but it is only setup for the recipient-facing kinds.
6. Run trigger 18, wait for `sent`, and confirm the reply body is
   `reply push test`. Then run trigger 19, wait for `sent`, and confirm the
   title includes `reacted 👍` while the body says
   `You said: recipient setup message`.

For every step, find the expected kind under diagnostics `notifications`,
inspect that row's nested `deliveries`, and only then ask the human to confirm
the banner. A top-level empty `deliveries` array is still not evidence of
failure. Server `sent` remains provider hand-off, not proof of rendering.

Suggested order: Messages sequence 15–19 → 6 → 1 → 2 → 3 → 4 → 8 → 10 → 11 → 9 → 12 → 5 → 7 → 13.
Steps 6/8 make the actor a member+approver of the shared app first; 5/7 need
the actor-owned app; 13 last because it involves the CLI credential swap back
to the recipient.

## Cleanup checklist

- Archive the deliberately-broken `check_failed` session (immediately).
- Decide the fate of the two real proposals created (the actor's promoted PR
  and the auto-solve result): vote/merge or withdraw+archive.
- Close or resolve the test issue.
- Delete or keep the actor-owned throwaway app.
- After capturing conversation diagnostics, actor removes the recipient with
  `DELETE /api/conversations/:id/members/:recipientId`, then actor archives
  the now-empty group with `POST /api/conversations/:id/leave` `{}`. Removing
  the recipient deletes their conversation notification evidence, so do this
  only after all five deliveries and phone banners are recorded.
- Restore the CLI credential to the normal account (`logout` + device login).
- Optionally clean test messages from the shared app's group chat.

## Baseline run (2026-08-13)

The force-testable pre-Messages kinds `sent` within 2–6s of the trigger and
rendered correctly on iOS (production Firebase project `usernode-7f4a2`).
Copy matched `buildCopy`, including app-name suffixes and session-title
embedding. The five conversation kinds are additional coverage and should be
recorded as their own run. Re-run this playbook after any change to
`mobile-push-policy.js` copy (e.g. PR #1175), the preferences registry, the
enqueue trigger, or the worker/provider layer.
