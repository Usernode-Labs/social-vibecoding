# Production Social → Activity notification rollout

One configuration value chooses the complete notification authority:

- `legacy`: Social commits its existing notification rows and owns feed, unread, and
  read state. Activity enqueueing and publication are disabled.
- `activity`: Social uses an existing notification row only as uncommitted staging
  while it allocates the occurrence ID and freezes renderer facts. In the same
  transaction it writes a dedicated `activity_notification_outbox` row, deletes the
  staged notification row, and commits. Activity is the only durable notification
  store and owns feed, unread, and read state.

There is no shadow-publication mode and no historical backfill in the first rollout.
The outbox is delivery infrastructure, not a second notification feed. It has no
foreign keys to mutable Social domain rows and is deleted after Activity returns
`200 replayed` or `201 accepted`.
Social continues owning apps, messages, sessions, invitations, kudos, and other
business records; Activity stores the immutable renderer snapshot for the accepted
notification occurrence, not a replica of those mutable domain models.

## Before cutover

Confirm all of the following:

1. Every serving Activity instance runs the compatible generic Social notification
   contract. No deployed producer still sends the superseded
   `social.dev_run.transition.v1` contract.
2. Activity uses a fresh production ledger/database, or the existing ledger contains
   no entries from the abandoned Social architecture.
3. `ACTIVITY_LEDGER_ID` is stable, and the producer token and 32-byte unpadded-base64url
   assertion key match in both services.
4. Social can reach `ACTIVITY_BASE_URL` over a trusted private network or HTTPS.
5. The registered Social producer and assertion issuer identities are intentionally
   chosen and agree across both releases.
6. The Activity database has a recoverable backup and readiness/error monitoring.

Configure these Social GitHub Actions values:

| Kind | Name |
| --- | --- |
| Variable | `ACTIVITY_BASE_URL` |
| Variable | `ACTIVITY_LEDGER_ID` |
| Variable | `ACTIVITY_NOTIFICATIONS_READ_PATH` |
| Secret | `ACTIVITY_PRODUCER_TOKEN` |
| Secret | `ACTIVITY_SOCIAL_ASSERTION_KEY` |

Leave the read path on `legacy` until all values and the Activity deployment are ready.
Legacy mode does not accumulate an Activity backlog, even when the other values are
already configured.

## Cutover

1. Deploy Activity and wait for `/health/ready`.
2. Set `ACTIVITY_NOTIFICATIONS_READ_PATH=activity`.
3. Run the Social **Deploy** workflow. It validates all required settings, builds the
   Social image, probes Activity from a one-off container on the same production
   network, replaces Social, and waits for Social health.
4. With two production test accounts, establish the recipient binding, create one real
   notification, and verify feed, unread count, individual read, and scoped read.
5. Inspect the outbox immediately after the smoke test and again after normal traffic.

Recipient binding is lazy. An occurrence created before its recipient first loads the
Activity-backed feed can receive `422 recipient_not_bound`; the outbox retries it
without changing its identity.

Published occurrences are append-only in this release. Deleting or retracting the
underlying Social record does not remove an already published Activity item.
This includes kudos: removing a kudos does not retract its Activity occurrence.
Likewise, each genuine `pr_proposed` re-promotion is a fresh Activity occurrence; the
Activity path does not retain Social notification rows merely to reproduce the legacy
per-session suppression behavior.

The boundary between an upstream Social business mutation and notification creation
remains best effort where existing handlers already treat it that way. A successful
business action is not rolled back solely because notification creation fails. Once
the Activity-mode notification transaction commits its frozen outbox row, however,
publication is durable and retried independently of later changes or deletion in
Social's business tables.

Action-triggered automatic dismissal is also best effort and bounded by the Activity
watermark visible when Social issues the scope read. If the matching occurrence is
still pending in Social's outbox, that read can change zero entries and the later
Activity item may arrive unread. Direct user reads are unaffected. Eliminating this
race would require durable read commands or tombstones and is outside this rollout.

## Outbox inspection

Run these against Social's production database
(`app_usernode_2d5619` in the standalone Compose deployment).

Summarize unpublished work:

```sql
SELECT
  count(*) FILTER (
    WHERE next_attempt_at IS NOT NULL
  ) AS retryable_count,
  min(enqueued_at) FILTER (
    WHERE next_attempt_at IS NOT NULL
  ) AS oldest_retryable_enqueued_at,
  count(*) FILTER (
    WHERE next_attempt_at IS NULL
      AND last_error IS NOT NULL
  ) AS parked_count
FROM activity_notification_outbox;
```

Inspect retryable and parked rows:

```sql
SELECT
  notification_id,
  recipient_user_id,
  event->'facts'->>'kind' AS kind,
  attempt_count,
  enqueued_at,
  next_attempt_at,
  last_error
FROM activity_notification_outbox
ORDER BY enqueued_at, notification_id;
```

Network failures, `429`, `5xx`, and the exact
`422 recipient_not_bound` response retry automatically. Other non-success HTTP
responses are parked by setting `next_attempt_at` to `NULL`.

After fixing the underlying credential, routing, identity, or contract problem,
requeue only reviewed notification IDs:

```sql
UPDATE activity_notification_outbox
SET next_attempt_at = NOW()
WHERE notification_id IN (123, 456)
  AND next_attempt_at IS NULL
  AND last_error IS NOT NULL
RETURNING notification_id, attempt_count, last_error;
```

Do not reset `attempt_count` or clear `last_error` manually. Successful publication
deletes the outbox row. Avoid bulk requeueing until the parked rows have been
classified and their common cause is fixed.

## Availability fallback

For an Activity outage that cannot be resolved promptly, set
`ACTIVITY_NOTIFICATIONS_READ_PATH=legacy` and re-run the Social deployment. Keep the
integrated Social binary deployed; do not independently roll Activity back to an
incompatible contract.

The fallback is deliberately not seamless:

- The legacy feed contains Social rows created before cutover plus rows created while
  fallback is active. It contains no Activity-era notification history.
- Notifications created during the fallback stay local and are not automatically
  transferred when Activity authority returns.
- Activity occurrences still pending in `activity_notification_outbox` pause while
  legacy mode is active and resume unchanged when Activity mode returns.

Return to Activity with the normal cutover and smoke checks. Any later history
migration is a separate, explicitly reviewed operation.
