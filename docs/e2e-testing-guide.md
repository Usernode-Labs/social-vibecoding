# Running an end-to-end sweep with a coding agent

How to reproduce the full product walkthrough that produced
[`e2e-use-cases.md`](./e2e-use-cases.md) and the **Admin → Insights → E2E
coverage** section. Written for the next LLM-driven run, because almost
everything expensive about the first one was *discovering the mechanics*,
not doing the testing.

The unit suite and the 365 declared dapp tests answer "does this component
still behave?". This answers "can a person actually get through the
product, on production, today?" — which is a different question, and the
only one that catches a gate that never fires or a screen that freezes
after a successful write.

---

## 1. The shape of a run

1. **Enumerate** every user-facing flow into a catalogue, one row per case,
   each tagged with what it needs (`guest` / `user` / `admin` / two
   accounts / a device) and how it can be driven (browser automation, API,
   phone-in-loop, human-only).
2. **Drive** everything drivable, recording evidence per case, not just a
   verdict.
3. **Hand the rest to a human** with exact steps, and verify their result
   server-side while they act.
4. **Regenerate** the outputs — the doc, the dataset, the admin section —
   from one table, so nothing can drift.

Statuses mean specific things and should not be blurred: `pass` (exercised
and watched to work), `fail` (exercised and broke), `blocked` (something
else is down), `pending` (needs a human and hasn't been done), `skipped`
(deliberately not run, reason recorded).

**Record the evidence, not the conclusion.** "Delivery `sent` at 14:55:44
after a deliberate boot failure" survives review; "push works" does not.

---

## 2. Single source of truth

Keep one table of cases and generate every artefact from it. The first run
used a small Node script holding `AREAS` + `CASES` and emitting three
outputs:

| Output | Path | Audience |
| --- | --- | --- |
| Markdown catalogue | `docs/e2e-use-cases.md` | the repo / review |
| Admin dataset | `frontend/src/features/admin/e2e-results-data.js` | the product |
| Shareable page | an artifact | the group |

`e2e-results-data.js` is **generated — never hand-edit it**. Patching one
output by hand is how the doc and the console start disagreeing, which is
worse than having neither.

---

## 3. What an agent can and cannot drive

**Drivable unattended** (~80% of cases): every authenticated web flow via
browser automation against production, every read-only API shape, the full
dev loop (issue → session → PR → staging → checks → vote → merge → deploy),
app lifecycle, admin console, and most push *triggers*.

**Needs a human, always:**

- Anything requiring a **password** to be typed.
- Third-party **OAuth consent** screens (GitHub, X).
- **Physical device** surfaces — the Flutter app's own screens, NFC.
- Deliberately **breaking a build** — the safety classifier reads
  "make `server.js` throw" as sabotage and refuses, correctly. The user
  must author that turn; the agent then verifies the consequence.

Plan for these up front rather than discovering them mid-run: batch the
human steps so the person does one uninterrupted pass.

**Ordering constraint that bites:** signing out to test guest or password
flows *ends the agent's admin session*, and with it the ability to read the
diagnostics used to verify everything else. Do sign-out-dependent cases
**last**.

---

## 4. Verification seams

Prefer server-side evidence over screenshots. The useful seams:

| Question | Where to look |
| --- | --- |
| Did a push actually deliver? | `GET /api/admin/mobile-push/diagnostics?user=<name>` — per-user data is under `notifications[].deliveries`, **not** the top-level `deliveries` key |
| Did the phone reach production at all? | `events` rows of type `app_version_checked` (every cold start writes one, unauthenticated) |
| Did a mobile sign-in happen? | a new `mobile_auth_tokens` row with `ability='session'` |
| Did mail go out? | `mail_deliveries`, or Admin → Email delivery |
| Arbitrary state | Admin SQL console: `POST /api/v4/admin/sql-query/execute` (browser session) |

The SQL console **rejects the `DELETE` keyword anywhere in the string** —
including inside a `WHERE … = 'delete'` literal — and rejects bare
`SELECT *`. List columns explicitly and avoid the word.

A sensitive-value filter masks things that look like tokens, SHAs or
session ids in tool output. Ask for counts, timestamps and booleans rather
than raw identifiers, or the answer comes back `[BLOCKED]`.

---

## 5. Accounts and fixtures

- **Two accounts are mandatory.** Self-actions never notify — a mention,
  reply, reaction or kudos from your own account is a no-op. Keep a second
  released account for the other side of every social case.
- **Fresh email alias per run**: `snaitmouloud+<tag>@gmail.com`. The
  waitlist join mail is limited to one per day per recipient.
- The waitlist **IP limiter (5 / 15 min) is shared** across join + survey +
  confirm, so one full journey can trip it.
- OTP has a **60-second** re-request gap, and the `set_password_token`
  minted at code-verify lives **10 minutes** — an expired one surfaces as a
  bare `Unauthenticated.`, not as "your code expired".
- Prefer a **throwaway app** for anything destructive (breaking a build,
  delete flows). Create it, use it, delete it inside the run.

---

## 6. Mobile push — the part that ate a day

Push has three independent failure points, and the symptom is identical
for all three: nothing arrives.

1. **Registration is a LOCAL opt-in that defaults OFF.** On launch the app
   reconciles the flag and, when off, *actively unregisters* from the
   server. Signing in does **not** register — the in-app notifications
   toggle does. Check this first, always.
2. **FCM tokens go stale silently.** Firebase answers
   `messaging/registration-token-not-registered`, the worker deletes the
   registration (correct self-healing), and nothing tells the user their
   device stopped receiving. Relaunching the app re-registers.
3. **Registration follows the signed-in account.** One device maps to one
   user at a time. If the phone is signed in as someone else, pushes to
   your account have nowhere to go — and the ledger will show a
   registration for the *other* user at exactly the timestamp you launched
   the app.

Before any push case: hit the diagnostics endpoint and confirm
`registration_active`. It is one call and it saves an hour.

Kind-specific notes:

- `reply` and `reaction` are **WebSocket-only** — the quote/reply control
  must be clicked; a plain message does not fire them.
- `check_failed` fires only on a staging **boot** failure (crash-loop), not
  on failing dapp tests, and lands ~4 minutes after the crash.
- `spec_shared` is de-duplicated: re-sharing the same
  `(session, version, recipient)` returns `alreadyShared: true` and creates
  **no** notification. Use a fresh session for a repeat test.
- `stale_pr` is a days-scale sweeper — not force-testable; leave it to its
  unit coverage.
- Invite kinds land on the **invitee's** device, so testing them needs a
  second registered phone; the `_accepted` variants cover the same
  transport from the inviter's side.

---

## 7. Cost and blast radius

Running the real dev loop spends real AI budget (~$5 for one coding turn
plus staging build) and creates real production state. Check
`GET /api/budget` before starting; the daily allowance resets at 00:00 UTC.

Everything created during a run should be **labelled and cleaned up**:
throwaway apps deleted, sessions archived, governance proposals withdrawn,
test conversations left, kudos retracted. Anything that cannot be undone —
a merged change, an issue — should be a deliberate decision, stated to the
user, not a side effect.

---

## 8. Findings worth re-checking next time

The first run's failures and oddities, so a future run knows what to
watch:

- Mobile **terms gate does not block entry** — appears only after an app
  restart (issue #1328).
- Mobile **white-screen freeze** accepting an invitation from in-app
  notifications; the mutation commits and only the client dies (#1329).
- **X / social identity linking fails**: the provider reports
  `credentialSource: waitlist` with `sameAppAsWaitlist: false`, i.e. it
  borrows the waitlist OAuth app whose registered callback does not include
  `/api/me/x/callback`. GitHub, which has a dedicated app, links fine.
- The waitlist **confirm link gives no visible feedback** — it lands on the
  stage-2 survey with no "confirmed" state.
- A spec re-share shows the same **"sent" success state** even when the
  server said `alreadyShared` and sent nothing.
- `/api/v4/mobile/logs` looks **effectively unused** (a handful of rows,
  all months old) despite `accept_logs` being true.
- `POST /api/apps/:slug/fork` immediately after creating the parent can
  fail with `lastFailure: null` — a race on repo provisioning, with no
  diagnostic recorded. A retry recovers it.

Rename and visibility changes are **not** instant metadata — both open a
governance PR and go to a vote. Expect that, and withdraw the proposal when
the test is done.
