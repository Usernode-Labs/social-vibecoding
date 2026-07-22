# Local Social → Activity notification testing

This setup runs the real Social and Activity processes against separate PostgreSQL
databases. It is intended for manual end-to-end verification of publication, feed,
unread, read state, browser rendering, and websocket invalidation. The regular unit and
contract suites remain the faster regression checks.

## Prerequisites

- Docker Desktop with Compose.
- These repositories checked out as siblings:
  - `social-vibecoding/`
  - `usernode-activity/`
- A local Social `.env` (`cp .env.example .env`) with usable admin credentials and
  session/JWT secrets. The Activity overlay supplies its own fixed local-only secrets.

The native Usernode sidecar is not required for notification-only testing. Features
that depend on wallet or chain RPC still require the normal `make node-full` setup.

## Start the integration stack

Run from `social-vibecoding/`:

```bash
docker compose \
  -f docker-compose.dev.yml \
  -f docker-compose.activity.yml \
  up -d --build
```

The services are:

| Service | Host address | Purpose |
| --- | --- | --- |
| Social | `http://localhost:3000` | Browser and notification facade |
| Activity | `http://localhost:3100` | Direct health/debug access |
| Social PostgreSQL | `localhost:5440` | Social business data and delivery outbox |
| Activity PostgreSQL | `localhost:5441` | Activity inbox and read state |

Activity applies its embedded migrations at startup. Confirm readiness before testing:

```bash
curl -i http://localhost:3100/health/ready

docker compose \
  -f docker-compose.dev.yml \
  -f docker-compose.activity.yml \
  ps
```

Readiness should return HTTP `204`.

## First account binding

The overlay defaults Social's complete notification read path to Activity. Sign in at
`http://localhost:3000`; the first notification feed request makes Social exchange a
short-lived account assertion, and Activity creates or resolves that user's inbox
binding.

If a notification is created before its recipient has loaded the Activity-backed feed,
publication receives `recipient_not_bound`. This is retryable by design. Sign in as the
recipient to establish the binding; the Social outbox will retry the unchanged
occurrence and publish it.

For realistic notification creation, use two users in separate browser profiles so one
can mention, reply to, react to, or invite the other.

## Focused verification

1. Establish the recipient binding by loading Social while signed in as that user.
2. Create a notification from another user.
3. Confirm the recipient's badge, unread count, drawer row, and browser alert update
   after the generic websocket invalidation.
4. Create at least three notifications and read them out of order. Only the selected
   entries should become read; inbox sequence is an identifier/order, not a read cursor.
5. Exercise per-app mark-read and mark-all. Create another notification immediately
   afterward and confirm the watermark prevents the new entry from being cleared.
6. Keep the recipient open in two tabs and confirm a read in one tab refreshes the other.
7. Exercise a collaborator or approver invite and confirm the actionable invite section
   is refreshed from Social business data.

Completion alerts are intentionally not replayed for completion rows already present in
the first successful page-load response. Subsequent newly materialized completions
should alert once even when websocket invalidations overlap.

## Inspect delivery and read state

Tail both application logs:

```bash
docker compose \
  -f docker-compose.dev.yml \
  -f docker-compose.activity.yml \
  logs -f --tail=200 app activity
```

Inspect the latest Social outbox rows:

```bash
docker compose \
  -f docker-compose.dev.yml \
  -f docker-compose.activity.yml \
  exec db psql -U usernode -d usernode -c \
  "SELECT id, kind, activity_attempt_count, activity_published_at, activity_last_error FROM notifications ORDER BY id DESC LIMIT 10"
```

Inspect Activity inbox entries independently of read order:

```bash
docker compose \
  -f docker-compose.dev.yml \
  -f docker-compose.activity.yml \
  exec activity-db psql -U activity -d activity -c \
  "SELECT inbox_id, inbox_sequence, sync_sequence, read_at FROM inbox_entries ORDER BY created_at DESC LIMIT 10"
```

## Publication retry test

First establish the recipient's Activity binding. Then stop Activity, create a Social
notification, and restart Activity:

```bash
docker compose \
  -f docker-compose.dev.yml \
  -f docker-compose.activity.yml \
  stop activity

# Create the notification in Social, then:

docker compose \
  -f docker-compose.dev.yml \
  -f docker-compose.activity.yml \
  start activity
```

The Social outbox should record a transient failure and later set
`activity_published_at`. The recipient should then receive the invalidation and see the
notification without recreating the Social business action.

## Exercise the rollout fallback

The overlay defaults to Activity authority. Recreate only Social with the legacy whole
read path:

```bash
ACTIVITY_LOCAL_READ_PATH=legacy docker compose \
  -f docker-compose.dev.yml \
  -f docker-compose.activity.yml \
  up -d --no-deps --force-recreate app
```

Switch back by using `activity`:

```bash
ACTIVITY_LOCAL_READ_PATH=activity docker compose \
  -f docker-compose.dev.yml \
  -f docker-compose.activity.yml \
  up -d --no-deps --force-recreate app
```

The flag switches feed, unread count, and reads together. Do not expect legacy Social
history in Activity: the first rollout deliberately has no backfill.

## Stop or reset

Stop the complete integration stack while preserving both databases:

```bash
docker compose \
  -f docker-compose.dev.yml \
  -f docker-compose.activity.yml \
  down
```

For a completely fresh test, remove both database volumes:

```bash
docker compose \
  -f docker-compose.dev.yml \
  -f docker-compose.activity.yml \
  down -v
```

Resetting only Activity is not a valid clean-state test because Social rows already
marked as published are not historical backfill. Reset both sides together.
