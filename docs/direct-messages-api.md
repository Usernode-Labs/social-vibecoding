# App-scoped direct messages

This is the first, privacy-first direct-message slice for issue #583. Existing
general app chat and issue/session/governance threads remain the platform's
channel model. Direct messages are one-to-one, scoped to one app, text-only,
and require consent. They do not claim end-to-end encryption and do not emit
message content through WebSockets or notifications.

All routes require an authenticated Usernode session or CLI API bearer. App
routes also require current collaboration access. A missing app, another
app's object, a non-participant object, an ineligible recipient, and a blocked
pair deliberately return the same generic not-found response where relevant.
Responses carry `Cache-Control: private, no-store` and
`X-Content-Type-Options: nosniff`.

## Conversation lifecycle

- `POST /api/apps/:slug/direct-conversations` with
  `{ "username": "exact_name" }` creates a pending request. A reciprocal
  request is explicit consent and accepts it.
- `GET /api/apps/:slug/direct-conversations?before=<id>&limit=<1..100>` lists
  only the caller's conversations.
- `POST /api/apps/:slug/direct-conversations/:id/respond` with
  `{ "action": "accept" }` or `{ "action": "decline" }` is available only
  to the request recipient. Decline closes that pair against repeated request
  spam; blocking is available for stronger safety semantics.

## Messages

- `POST /api/apps/:slug/direct-conversations/:id/messages` with
  `{ "content": "..." }` sends 1–2,000 characters after acceptance.
- `GET /api/apps/:slug/direct-conversations/:id/messages?before=<id>&limit=<1..100>`
  returns an oldest-to-newest page and an opaque `nextBefore` cursor.
- `DELETE /api/apps/:slug/direct-conversations/:id/messages/:messageId`
  lets only the author permanently scrub the body. History retains a
  timestamped tombstone; there is no edit endpoint in this slice.

Messages are plain JSON string data. A client must render them through its
normal escaped-text/markdown-safe path and must never assign them directly to
`innerHTML`.

## Safety controls

- `POST /api/apps/:slug/direct-blocks` with `{ "username": "exact_name" }`
  blocks requests, acceptance, and sends in either direction without telling
  the other participant who blocked whom. It is idempotent and always returns
  204 for absent/ineligible targets.
- `DELETE /api/apps/:slug/direct-blocks/:username` removes the caller's block
  and is also idempotent.
- `POST /api/apps/:slug/direct-conversations/:id/reports` accepts
  `{ "reason": "...", "messageId": 123 }`; `messageId` is optional for a
  conversation-level report. A message report snapshots evidence before a
  later author deletion.
- Full write-admins review reports through
  `GET /api/admin/direct-message-reports` and resolve them with
  `PATCH /api/admin/direct-message-reports/:id` using status `resolved` or
  `dismissed`.

Request/safety mutations are limited to 20 per user per hour, including
failed attempts; sends are limited to 30 per user per minute. Pair mutations
serialize with a transaction advisory lock and re-read app visibility,
membership, consent, and block state before committing.

## Deferred by design

Groups, a second channel model, cross-app DMs, fuzzy discovery, attachments,
cards, search, push copy, WebSocket delivery, presence, typing, read receipts,
editing, and UI placement require separate product decisions. The absence of
those features must not be presented to users as an end-to-end encryption or
delivery-guarantee claim.
