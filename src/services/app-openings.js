'use strict';

// A real app open has two clocks:
//   - occurredAt: captured when the browser starts the navigation;
//   - receivedAt: stamped here after any offline / transport retry.
//
// The occurrence clock is useful for ordered funnels, but it is still a
// browser clock. Accept it only inside a narrow, explicit window. An old or
// far-future value falls back to the server receipt time instead of letting a
// broken clock rewrite analytics history.

const events = require('./events');

const OPENING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_OCCURRENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

class OpeningValidationError extends Error {}

function parseOpening(body, now = new Date()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new OpeningValidationError('Body must be an object');
  }
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== 'occurredAt' || keys[1] !== 'openingId') {
    throw new OpeningValidationError('Body must contain only openingId and occurredAt');
  }
  if (typeof body.openingId !== 'string' || !OPENING_ID_RE.test(body.openingId)) {
    throw new OpeningValidationError('openingId must be a UUID');
  }
  if (typeof body.occurredAt !== 'string' || !RFC3339_RE.test(body.occurredAt)) {
    throw new OpeningValidationError('occurredAt must be an RFC 3339 timestamp');
  }

  const receivedMs = now.getTime();
  const clientMs = Date.parse(body.occurredAt);
  if (!Number.isFinite(receivedMs) || !Number.isFinite(clientMs)) {
    throw new OpeningValidationError('occurredAt must be an RFC 3339 timestamp');
  }
  const clientTimeAccepted = clientMs >= receivedMs - MAX_OCCURRENCE_AGE_MS
    && clientMs <= receivedMs + MAX_FUTURE_SKEW_MS;
  // Even an acceptably small fast-clock skew must not place the opening
  // after a later server-timestamped engagement. Clamp future values to the
  // receipt boundary; delayed past occurrences retain their actual order.
  const useClientTime = clientTimeAccepted && clientMs <= receivedMs;
  const occurredAt = new Date(useClientTime ? clientMs : receivedMs);

  return {
    openingId: body.openingId.toLowerCase(),
    occurredAt: occurredAt.toISOString(),
    receivedAt: now.toISOString(),
    timestampSource: useClientTime ? 'client' : 'received',
  };
}

async function record(pool, { userId, appId, opening }) {
  const metadata = {
    openingId: opening.openingId,
    source: 'app_tab',
    receivedAt: opening.receivedAt,
    timestampSource: opening.timestampSource,
  };
  const inserted = await pool.query(
    `INSERT INTO events (user_id, app_id, event_type, metadata, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
     ON CONFLICT (user_id, app_id, (metadata->>'openingId'))
       WHERE event_type = 'dapp_opened' AND metadata ? 'openingId'
     DO NOTHING
     RETURNING created_at, metadata`,
    [
      userId,
      appId,
      events.EVENT_TYPES.DAPP_OPENED,
      JSON.stringify(metadata),
      opening.occurredAt,
    ]
  );
  if (inserted.rows[0]) {
    return {
      duplicate: false,
      openedAt: inserted.rows[0].created_at,
      receivedAt: inserted.rows[0].metadata.receivedAt,
      timestampSource: inserted.rows[0].metadata.timestampSource,
    };
  }

  // The unique index means the only no-row outcome is a replay. Read back
  // the original timestamps so a lost 201 and its retry answer identically.
  const existing = await pool.query(
    `SELECT created_at, metadata
       FROM events
      WHERE user_id = $1 AND app_id = $2
        AND event_type = 'dapp_opened'
        AND metadata->>'openingId' = $3
      LIMIT 1`,
    [userId, appId, opening.openingId]
  );
  if (!existing.rows[0]) {
    throw new Error('dapp_opened idempotency conflict did not resolve to an event');
  }
  return {
    duplicate: true,
    openedAt: existing.rows[0].created_at,
    receivedAt: existing.rows[0].metadata.receivedAt,
    timestampSource: existing.rows[0].metadata.timestampSource,
  };
}

module.exports = {
  MAX_FUTURE_SKEW_MS,
  MAX_OCCURRENCE_AGE_MS,
  OPENING_ID_RE,
  OpeningValidationError,
  parseOpening,
  record,
};
