# Notification architecture

Status: **validated current-state record**, not approval of a future
multi-channel system.

This document records what the Social platform at issue #497 actually does.
It is intentionally narrower than a target architecture: the owner has not
selected new channels, reliability/SLO targets, preferences, or retention
policy. Any such selection changes this contract and needs its own migration
and acceptance criteria.

The executable companion is
`tests/notification-architecture.test.js`. When a topology or delivery
semantic changes, update this document and that test in the same proposal.

## Decision

Record the current architecture as the production baseline and retain its
topology instead of inventing a replacement, contingent on the #498 privacy
and integrity correction:

1. A row in PostgreSQL `notifications` is the canonical in-app record.
2. The authenticated HTTP feed is the convergence path.
3. WebSocket messages reduce latency but are not a delivery ledger.
4. Browser chimes/OS banners are local presentation of completion rows, not a
   closed-browser push channel.
5. Optional native mobile push is a separate, durable, opaque-ID delivery path
   for an explicit two-kind allowlist.

This topology is currently operable only as a **single Social application
process** with the limitations below. It is not an approval of exactly-once
event delivery, multi-instance fanout, new channels, or an indefinite
data-retention policy.

## Source map

| Responsibility | Authoritative implementation |
| --- | --- |
| Canonical schema and mobile outbox trigger | `src/db/schema.sql` |
| Recipient resolution, inserts, hydration, reads | `src/services/notifications.js` |
| Authenticated feed/exact/read routes | `src/routes/notifications.js` |
| Per-process realtime fanout | `src/services/ws.js` |
| Browser feed, grouping, routing, unread state | `public/js/notifications.js` |
| Reconnect reconciliation | `public/js/app.js` |
| Browser-local completion alerts | `public/js/dev-alerts.js` |
| Mobile allowlist and payload minimization | `src/services/mobile-push-policy.js` |
| Mobile registration, outbox worker and provider | `src/routes/topochain/mobile-push-registration.js`, `src/services/mobile-push*.js` |

## Topology and persistence boundaries

~~~text
domain mutation
    |
    | usually a later, best-effort producer call
    v
PostgreSQL notifications row  <----- authenticated HTTP list/exact/read
    |                                      ^
    | best-effort in-process WS            | startup / reconnect / invalidation
    +-------------------------------> browser state
    |
    | AFTER INSERT trigger, same DB transaction, allowlisted kinds only
    v
mobile_push_deliveries --> single in-process worker --> FCM generic opaque-id
~~~

The first arrow is important: most domain mutations commit before notification
creation and deliberately catch notification errors. The platform therefore
guarantees durability **once a notification row commits**, but does not
guarantee that every successful domain event creates a row. There is no
general domain-event outbox, replay scanner, or dead-letter queue for missing
in-app rows.

The mobile outbox has a stronger boundary. Its database trigger runs after an
allowlisted notification insert in the same transaction, so the canonical row
and the eligible delivery rows commit or roll back together.

## Supported kinds

The contract marker below is parsed by the conformance test.

<!-- notification-kinds: mention,reply,reaction,kudos,stale_pr,check_failed,pr_proposed,session_done,auto_solve_done,spec_shared,collab_invite,collab_invite_accepted,approver_invite,approver_invite_accepted -->

| Kind | Recipient/source | Reference and lifecycle |
| --- | --- | --- |
| `mention` | Resolved `@username` values; private-app candidates are filtered at creation | Chat message; posting in the app or clicking the message marks chat-actionable rows read |
| `reply` | Quoted message author, excluding self/system | New reply message; same chat-action lifecycle |
| `reaction` | Reacted-to author on add, excluding self/system | Reacted-to message plus emoji detail; removing the reaction does not itself remove history |
| `kudos` | Proposal author, excluding self | Session; retract performs best-effort deletion of the matching history row |
| `stale_pr` | Stale proposal owner | Session; voting marks it read |
| `check_failed` | Proposal owner | Session; intended as one unread row per user/session |
| `pr_proposed` | Active app users plus creator/favoriters, excluding proposer; the self-app uses opt-in stakeholders only | Session; intended as one lifetime row per user/session; voting marks it read |
| `session_done` | Interactive session owner | Session; intended as one unread row per user/session; opening the session marks it read |
| `auto_solve_done` | Headless-run owner | Session plus outcome detail; intended as one unread row per user/session; cloning marks it read |
| `spec_shared` | Explicit share recipient | Session plus version detail; source share uniqueness bounds repeats |
| `collab_invite` | Invite recipient | History/badge only; `app_collaborators` is authoritative for the actionable invite |
| `collab_invite_accepted` | Inviter | Informational history |
| `approver_invite` | Invite recipient | History/badge only; `app_approvers` is authoritative for the actionable invite |
| `approver_invite_accepted` | Inviter | Informational history |

There is no priority/severity column and no server-side per-kind preference,
quiet-hour, digest, mute, or mandatory-notification policy. The
`devchat_alerts_enabled` local browser preference controls only local
completion presentation. Mobile registration records the OS permission state;
it is not a general notification preference model.

## HTTP feed and lifecycle

- Every list, exact lookup, unread count, and read mutation is scoped to the
  authenticated user's ID. Exact lookup deliberately returns the same not-found
  result for a missing or foreign row.
- The first list page is capped at 100, includes the account unread aggregate
  and authoritative pending invites, and uses `(created_at, id)` as the
  newest-first keyset cursor. There is no global or causal ordering guarantee.
- `read_at` is the only general state. Read writes are idempotent and can be
  single-row, all, kind-scoped, app-scoped, message-scoped, or tied to a
  completed action.
- There is no general archive or user-delete-notification API.
- Canonical rows have no age-based retention job. They remain until a direct
  cleanup (currently kudos retract) or a foreign-key cascade deletes their
  user, app, message, or session. `source_user_id` becomes null when the
  source user is deleted.

## Realtime and browser behavior

`notification_new` and `notifications_changed` are sent to every matching
socket in the module-local `globalClients` set. There is no acknowledgement,
retry, persisted WebSocket cursor, or cross-process broker. A socket drop may
lose any number of realtime hints.

The durable row is the recovery mechanism: browser startup fetches the feed;
WebSocket reconnect calls `Notifications.refresh()`; and a
`notifications_changed` hint also refetches. A persisted row therefore
converges after a dropped realtime hint, subject to a later successful HTTP
request.

Browser Web Notifications and synthesized chimes are generated only for
`session_done` and `auto_solve_done` while a page is alive. There is no
service worker or web-push subscription. A hidden-but-running browser may show
an OS banner after local permission; a closed browser cannot.

## Native mobile delivery

Native mobile push is optional and fails closed unless its environment and
Firebase identity are complete. It is not a general channel:

- only `session_done` and `auto_solve_done` enter the outbox;
- the trigger copies no provider token and creates at most one row per
  notification/environment/installation;
- registrations are encrypted at rest; payloads contain a generic title/body,
  environment, opaque notification ID, and recipient binding, never app,
  message, session, or actor content;
- the authenticated Social session resolves the opaque ID on open;
- the worker revalidates unread state, kind, environment, deployment identity,
  installation, permission, session expiry, and recipient before send;
- transient provider failures retry with exponential backoff (5 seconds to a
  1-hour cap) until the delivery's 24-hour expiry; permanent payload errors
  become `dead`, invalid tokens are conditionally removed, and ineligible
  work becomes `cancelled`;
- expired registrations are removed in bounded maintenance batches; terminal
  delivery rows and orphan mutation fences are retained for 30 days, then
  removed in bounded batches.

Provider delivery is not exactly once. A provider may accept a send before the
process records `sent`; interruption recovery can retry it. Platform-specific
collapse identifiers reduce visible duplicates but are not a transactional
acknowledgement.

## Authorization and privacy

The baseline at commit
`58e2d8395885ad1769c8653fefd720aa138e907e` correctly scopes HTTP rows by
recipient, filters private-app candidates for some producers, authenticates
opaque-ID resolution, keeps push content generic, and encrypts registrations.
It does **not** consistently re-check current private-app access when reading
or freshly hydrating every stored row.

That is a known corrective dependency, not an accepted architecture property:
issue #498's ready, unpromoted session 3034 adds one current-access predicate
across history, count, exact lookup, live hydration and mobile pre-send;
database-enforced completion/proposal deduplication; duplicate browser-delivery
handling; and per-recipient/socket failure isolation. #497 does not duplicate
those edits. This contract may be described as fully privacy-valid only after
that proposal is merged (or an equivalent correction lands).

Notification previews can contain app names, usernames, message excerpts, PR
titles, branch names, and issue/session identifiers. They are application data,
not an analytics stream. Mobile delivery intentionally carries none of that
content.

## Availability, scaling and backpressure

The current deployment topology has one Social process:

- WebSocket rooms and user sockets exist only in that process's memory.
- The mobile worker assumes its passes do not overlap. Its recovery pass resets
  every `sending` row; a second active worker could reset work the first is
  currently sending and cause duplicate provider calls.
- Mobile work is claimed in batches of 20 and sent concurrently; polling is
  five seconds when idle and 100 ms while draining.
- HTTP list pages are capped at 100, but notification producers have no
  notification-specific per-user/global rate limit or queue backpressure.

Do not horizontally scale the Social process without adding both a
cross-instance fanout mechanism and a single-owner/distributed-lease design for
mobile delivery. No latency, throughput, availability, or queue-depth SLO is
currently committed.

## Observability and audit

Available evidence is operational, not a delivery audit:

- producer/hydration/WS errors are logged without failing the domain mutation;
- mobile delivery rows retain status, attempts, timestamps and a bounded error
  code until cleanup;
- provider errors are classified as retry, dead, or token invalidation;
- domain analytics events may record the underlying action, but there is no
  immutable per-notification delivery/read audit and no notification-specific
  metrics, alert thresholds, queue dashboard, or dead-letter operator flow.

## Explicit non-guarantees

The current architecture does **not** promise:

- exactly-once, at-least-once, or replayable domain-event-to-row creation;
- acknowledgement or retry for WebSocket fanout;
- exactly-once native provider display;
- ordering beyond per-feed `(created_at, id)` presentation order;
- multi-process WebSocket or mobile-worker safety;
- preferences, quiet hours, digests, server-side browser push, email, SMS, or
  webhook delivery;
- blocked/muted relationship semantics;
- canonical notification age retention, legal hold, export, or user erasure
  beyond the existing foreign-key lifecycle;
- notification-specific rate limits, SLOs, metrics, compliance classification,
  or immutable delivery audit.

## Decision gates for expansion

Before replacing or expanding this baseline, an owner must provide:

1. exact event/kind, recipient and authorization rules;
2. channel allowlist and opt-in/opt-out/mandatory defaults;
3. event-to-row and channel delivery semantics, deduplication keys, ordering,
   retry/dead-letter behavior and acceptable loss/duplicate policy;
4. canonical and per-channel retention/deletion/export requirements;
5. single- versus multi-instance topology, throughput and latency targets,
   backpressure/rate policy and provider-failure behavior;
6. required audit, metrics, alerts, privacy/consent/compliance controls;
7. migration, rollout, rollback and executable acceptance tests.

Until those decisions exist, a general outbox, queue, provider abstraction,
preference schema, or additional channel would encode invented requirements.
