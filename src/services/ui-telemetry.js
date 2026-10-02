'use strict';

const crypto = require('node:crypto');
const events = require('./events');
const usernames = require('./usernames');

const MAX_BATCH_EVENTS = 25;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_DURATION_MS = 30 * 60 * 1000;
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ID_RE = /^[a-z0-9][a-z0-9-]{15,79}$/;
const APP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const BUILD_RE = /^(?:[0-9a-f]{7,40}|dev)$/;

// The seven representative journeys #3553 instruments for its failure
// report. That report (aggregate below) reads only these, so the navigation
// codes added for the admin Journey page (#3369) never change its numbers.
const JOURNEY_SCREENS = Object.freeze(new Set([
  'shell_boot', 'app_detail', 'app_discussion', 'feedback_dialog',
  'report_dialog', 'change_workspace', 'preview',
]));
// Navigation (#3369): one code per screen root the shell reveals, so a
// person's path can be read in the order they took it. `app` is the running
// app; `project` is the platform's own surface about one app (its hub,
// Workshop, discussion, a change). Named roots only: never an address, a
// conversation or anything inside an app.
const NAV_SCREENS = Object.freeze(new Set([
  'home', 'discover', 'communities', 'challenges', 'profile', 'my_proposals',
  'settings', 'messages', 'assistant', 'agent_session', 'app', 'project',
]));
const SCREENS = Object.freeze(new Set([...JOURNEY_SCREENS, ...NAV_SCREENS]));
// How a person arrived at a navigation screen. `returned` marks the screen
// re-reported when the app comes back to the foreground after a long break:
// the phone app keeps one page open for days, so without it two days of use
// would read as one visit.
const VIAS = Object.freeze(new Set(['own', 'nudged', 'handed', 'address', 'back', 'returned']));
const SCHEMA_VERSIONS = Object.freeze(new Set([1, 2]));
const ACTIONS = Object.freeze(new Set([
  'shell_boot', 'app_detail_load', 'app_discussion_load',
  'feedback_submit', 'content_report_submit', 'change_create', 'preview_open',
]));
const KINDS = Object.freeze(new Set([
  'screen_visit', 'action_attempt', 'action_outcome', 'repeated_action',
  'loading_timeout', 'navigation_abandonment', 'recovery', 'boot_failure',
  // The page was hidden or closed while a navigation screen was showing: the
  // end of the last screen of a visit, so time on it is known.
  'screen_hidden',
]));
const OUTCOMES = Object.freeze(new Set(['success', 'failure', 'cancelled']));
const ERROR_CODES = Object.freeze(new Set([
  'access_denied', 'app_blocked', 'boot_incomplete', 'boot_rejection',
  'boot_resource_failed', 'boot_script_error', 'boot_step_failed',
  'conflict', 'invalid_response', 'network', 'not_found', 'offline',
  'rate_limited', 'server_error', 'target_unavailable', 'unavailable',
  'unknown',
]));
const EVENT_KEYS = Object.freeze([
  'id', 'visitId', 'attemptId', 'kind', 'screen', 'action', 'outcome',
  'errorCode', 'durationMs', 'appSlug', 'build', 'occurredAt', 'sequence',
  'via',
]);

class TelemetryValidationError extends Error {}

// Browser checks use real authenticated sessions so protected screens can be
// exercised. Their fixed handles are the authoritative boundary: role is not
// one, because human full/view admins still produce useful journey evidence.
function isEligibleUser(user) {
  return !!user?.id && !usernames.isServiceIdentity(user.username);
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new TelemetryValidationError(`${label} must be an object`);
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new TelemetryValidationError(`${label} contains unsupported field: ${extra}`);
}

function opaqueId(value, label, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new TelemetryValidationError(`${label} must be an opaque id`);
  }
  return value;
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TelemetryValidationError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function oneOf(value, allowed, label, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new TelemetryValidationError(`${label} is not allowlisted`);
  }
  return value;
}

function eventTimestamp(value, nowMs) {
  if (typeof value !== 'string' || value.length > 32) {
    throw new TelemetryValidationError('event.occurredAt must be an RFC3339 timestamp');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)
      || ms < nowMs - MAX_EVENT_AGE_MS
      || ms > nowMs + MAX_FUTURE_SKEW_MS) {
    throw new TelemetryValidationError('event.occurredAt is outside the accepted window');
  }
  return new Date(ms).toISOString();
}

function parseEvent(value, index, nowMs) {
  exactKeys(value, EVENT_KEYS, `events[${index}]`);
  const kind = oneOf(value.kind, KINDS, `events[${index}].kind`);
  const screen = oneOf(value.screen, SCREENS, `events[${index}].screen`);
  const action = oneOf(value.action, ACTIONS, `events[${index}].action`, true);
  const outcome = oneOf(value.outcome, OUTCOMES, `events[${index}].outcome`, true);
  const errorCode = oneOf(value.errorCode, ERROR_CODES, `events[${index}].errorCode`, true);
  const attemptId = opaqueId(value.attemptId, `events[${index}].attemptId`, true);
  const via = oneOf(value.via, VIAS, `events[${index}].via`, true);
  if (via && !(kind === 'screen_visit' && NAV_SCREENS.has(screen))) {
    throw new TelemetryValidationError('via is only valid on a navigation screen_visit');
  }
  if (kind === 'screen_hidden' && (!NAV_SCREENS.has(screen) || attemptId || action || outcome
      || errorCode || value.durationMs != null)) {
    throw new TelemetryValidationError('screen_hidden is a bare mark on a navigation screen');
  }

  if (kind === 'action_attempt' && (!action || !attemptId)) {
    throw new TelemetryValidationError('action_attempt requires action and attemptId');
  }
  if (['action_outcome', 'loading_timeout', 'navigation_abandonment', 'recovery', 'repeated_action']
    .includes(kind) && (!action || !attemptId)) {
    throw new TelemetryValidationError(`${kind} requires action and attemptId`);
  }
  if (kind === 'action_outcome' && !outcome) {
    throw new TelemetryValidationError('action_outcome requires outcome');
  }
  if (kind !== 'action_outcome' && outcome) {
    throw new TelemetryValidationError('outcome is only valid for action_outcome');
  }
  if (kind === 'boot_failure' && (!errorCode || screen !== 'shell_boot')) {
    throw new TelemetryValidationError('boot_failure requires a safe errorCode on shell_boot');
  }
  if (errorCode && kind !== 'boot_failure'
      && !(kind === 'action_outcome' && outcome === 'failure')) {
    throw new TelemetryValidationError('errorCode is only valid for failures');
  }

  let appSlug = null;
  if (value.appSlug != null) {
    if (typeof value.appSlug !== 'string' || !APP_SLUG_RE.test(value.appSlug)) {
      throw new TelemetryValidationError(`events[${index}].appSlug is invalid`);
    }
    appSlug = value.appSlug;
  }
  let build = null;
  if (value.build != null) {
    if (typeof value.build !== 'string' || !BUILD_RE.test(value.build)) {
      throw new TelemetryValidationError(`events[${index}].build is invalid`);
    }
    build = value.build;
  }
  const durationMs = value.durationMs == null ? null
    : integer(value.durationMs, `events[${index}].durationMs`, 0, MAX_DURATION_MS);
  if (kind === 'screen_visit' && (attemptId || action || outcome || errorCode || durationMs != null)) {
    throw new TelemetryValidationError('screen_visit cannot carry action details');
  }
  if (kind === 'action_attempt' && (outcome || errorCode || durationMs != null)) {
    throw new TelemetryValidationError('action_attempt cannot carry an outcome');
  }
  if (kind === 'action_outcome' && durationMs == null) {
    throw new TelemetryValidationError('action_outcome requires durationMs');
  }
  if (kind === 'action_outcome' && outcome === 'failure' && !errorCode) {
    throw new TelemetryValidationError('failed action_outcome requires a safe errorCode');
  }
  if (['loading_timeout', 'navigation_abandonment', 'recovery'].includes(kind)
      && durationMs == null) {
    throw new TelemetryValidationError(`${kind} requires durationMs`);
  }
  if (kind === 'repeated_action' && durationMs != null) {
    throw new TelemetryValidationError('repeated_action cannot carry durationMs');
  }
  if (kind === 'boot_failure' && (action !== 'shell_boot' || !attemptId || durationMs != null)) {
    throw new TelemetryValidationError('boot_failure requires the shell_boot attempt');
  }
  return {
    eventId: opaqueId(value.id, `events[${index}].id`),
    visitId: opaqueId(value.visitId, `events[${index}].visitId`),
    attemptId,
    kind,
    screen,
    action,
    outcome,
    errorCode,
    durationMs,
    appSlug,
    build,
    occurredAt: eventTimestamp(value.occurredAt, nowMs),
    sequence: integer(value.sequence, `events[${index}].sequence`, 1, 1_000_000),
    via,
  };
}

function parseBatch(body, { nowMs = Date.now() } = {}) {
  if (Buffer.byteLength(JSON.stringify(body || {}), 'utf8') > MAX_BODY_BYTES) {
    throw new TelemetryValidationError('batch is too large');
  }
  exactKeys(body, ['schemaVersion', 'batchId', 'events', 'delivery'], 'body');
  // Version 2 adds navigation (#3369). Version 1 stays accepted: a shell
  // cached before it shipped keeps reporting its failures, and the Journey
  // page reads a person with no navigation rows as "no navigation data".
  if (!SCHEMA_VERSIONS.has(body.schemaVersion)) {
    throw new TelemetryValidationError('schemaVersion must be 1 or 2');
  }
  const batchId = opaqueId(body.batchId, 'batchId');
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > MAX_BATCH_EVENTS) {
    throw new TelemetryValidationError(`events must contain 1-${MAX_BATCH_EVENTS} records`);
  }
  exactKeys(body.delivery, ['failedBatches', 'droppedEvents'], 'delivery');
  const delivery = {
    failedBatches: integer(body.delivery.failedBatches, 'delivery.failedBatches', 0, 10_000),
    droppedEvents: integer(body.delivery.droppedEvents, 'delivery.droppedEvents', 0, 10_000),
  };
  const parsed = body.events.map((value, index) => parseEvent(value, index, nowMs));
  const ids = new Set(parsed.map((event) => event.eventId));
  if (ids.size !== parsed.length) throw new TelemetryValidationError('event ids must be unique within a batch');
  return { batchId, events: parsed, delivery };
}

function eventMetadata(event) {
  const metadata = {
    eventId: event.eventId,
    visitId: event.visitId,
    kind: event.kind,
    screen: event.screen,
    sequence: event.sequence,
  };
  for (const key of ['attemptId', 'action', 'outcome', 'errorCode', 'durationMs', 'build', 'via']) {
    if (event[key] != null) metadata[key] = event[key];
  }
  return metadata;
}

async function insertBatch(pool, userId, batch) {
  const client = await pool.connect();
  let accepted = 0;
  try {
    await client.query('BEGIN');
    for (const event of batch.events) {
      const result = await client.query(
        `INSERT INTO events (user_id, app_id, event_type, metadata, created_at)
         VALUES ($1, (SELECT id FROM apps WHERE slug = $2), $3, $4::jsonb, $5::timestamptz)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [userId, event.appSlug, events.EVENT_TYPES.UI_EXPERIENCE,
          JSON.stringify(eventMetadata(event)), event.occurredAt]
      );
      accepted += result.rowCount || 0;
    }
    const receipt = await client.query(
      `INSERT INTO events (user_id, event_type, metadata)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [userId, events.EVENT_TYPES.UI_TELEMETRY_DELIVERY, JSON.stringify({
        batchId: batch.batchId,
        submitted: batch.events.length,
        accepted,
        failedBatches: batch.delivery.failedBatches,
        droppedEvents: batch.delivery.droppedEvents,
      })]
    );
    if (!receipt.rowCount) {
      // A lost success response makes the client retry the same batch with
      // increased loss counters. Preserve the original accepted count while
      // letting that later delivery evidence reach the coverage report.
      await client.query(
        `UPDATE events SET metadata = metadata || jsonb_build_object(
           'failedBatches', GREATEST(COALESCE((metadata->>'failedBatches')::int, 0), $4::int),
           'droppedEvents', GREATEST(COALESCE((metadata->>'droppedEvents')::int, 0), $5::int)
         )
         WHERE user_id = $1 AND event_type = $2 AND metadata->>'batchId' = $3`,
        [userId, events.EVENT_TYPES.UI_TELEMETRY_DELIVERY, batch.batchId,
          batch.delivery.failedBatches, batch.delivery.droppedEvents]
      );
    }
    await client.query('COMMIT');
    return { accepted, duplicate: accepted === 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function safeServerError(status, message) {
  if (status === 429) return 'rate_limited';
  if (status === 403 || status === 401) return 'access_denied';
  if (status === 404 && /target unavailable/i.test(String(message || ''))) return 'target_unavailable';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'server_error';
  return 'unknown';
}

function requestOpaqueId(req, header) {
  const value = req && typeof req.get === 'function' ? req.get(header) : null;
  return typeof value === 'string' && ID_RE.test(value) ? value : null;
}

function recordServerFailure(pool, req, { screen, action, status, message }) {
  if (!isEligibleUser(req?.user) || !SCREENS.has(screen) || !ACTIONS.has(action)) {
    return Promise.resolve();
  }
  const metadata = {
    eventId: crypto.randomUUID(),
    visitId: requestOpaqueId(req, 'x-ui-visit-id') || crypto.randomUUID(),
    attemptId: requestOpaqueId(req, 'x-ui-attempt-id'),
    kind: 'server_failure',
    screen,
    action,
    errorCode: safeServerError(status, message),
    source: 'server',
  };
  if (!metadata.attemptId) delete metadata.attemptId;
  return events.record(pool, {
    type: events.EVENT_TYPES.UI_EXPERIENCE,
    userId: req.user.id,
    metadata,
  });
}

function daysWindow(raw) {
  const value = Number(raw || 14);
  return [1, 7, 14, 30, 90].includes(value) ? value : 14;
}

async function aggregate(pool, { days = 14, includeAdmins = false } = {}) {
  const adminClause = includeAdmins ? '' : 'AND NOT u.is_admin';
  const params = [days, [...usernames.SERVICE_IDENTITIES]];
  const base = `e.created_at >= NOW() - ($1::int * INTERVAL '1 day') ${adminClause}
    AND NOT (LOWER(u.username) = ANY($2::text[]))`;
  // Observations are read for the seven journeys only. Navigation rows share
  // the event type (#3369) and would otherwise inflate visits, reporting
  // users and the screen list. Delivery receipts cannot be split by screen,
  // so they count every record a client sent.
  const uiParams = [...params, [...JOURNEY_SCREENS]];
  const uiBase = `${base} AND e.metadata->>'screen' = ANY($3::text[])`;
  const [overall, journeys, screens, contexts, errors, delivery] = await Promise.all([
    pool.query(
      `WITH ui AS (
         SELECT e.id AS row_id, e.user_id, e.metadata
           FROM events e JOIN users u ON u.id = e.user_id
          WHERE e.event_type = 'ui_experience' AND ${uiBase}
       ), attempts AS (
         SELECT user_id, metadata->>'attemptId' AS id
           FROM ui WHERE metadata->>'kind' IN ('action_attempt','server_failure')
             AND metadata ? 'attemptId'
           GROUP BY user_id, metadata->>'attemptId'
       ), terminals AS (
         SELECT user_id, metadata->>'attemptId' AS id,
           BOOL_OR(metadata->>'outcome' = 'success') AS succeeded,
           BOOL_OR(metadata->>'outcome' = 'failure') AS failed,
           BOOL_OR(metadata->>'outcome' = 'cancelled') AS cancelled
           FROM ui WHERE metadata->>'kind' = 'action_outcome' AND metadata ? 'attemptId'
           GROUP BY user_id, metadata->>'attemptId'
       ), signals AS (
         SELECT user_id, metadata->>'attemptId' AS id,
           BOOL_OR(metadata->>'kind' = 'server_failure') AS server_failed,
           BOOL_OR(metadata->>'kind' = 'loading_timeout') AS timed_out,
           BOOL_OR(metadata->>'kind' = 'navigation_abandonment') AS abandoned,
           BOOL_OR(metadata->>'kind' = 'repeated_action') AS repeated,
           BOOL_OR(metadata->>'kind' = 'recovery') AS recovered
           FROM ui WHERE metadata ? 'attemptId'
           GROUP BY user_id, metadata->>'attemptId'
       ), cohort AS (
         SELECT a.user_id, a.id, t.id IS NOT NULL AS has_client_terminal,
           COALESCE(t.succeeded, FALSE) AND NOT COALESCE(t.failed, FALSE)
             AND NOT COALESCE(s.server_failed, FALSE) AS succeeded,
           COALESCE(t.failed, FALSE) OR COALESCE(s.server_failed, FALSE) AS failed,
           COALESCE(t.cancelled, FALSE) AS cancelled,
           COALESCE(s.server_failed, FALSE) AS server_failed,
           COALESCE(s.timed_out, FALSE) AS timed_out,
           COALESCE(s.abandoned, FALSE) AS abandoned,
           COALESCE(s.repeated, FALSE) AS repeated,
           COALESCE(s.recovered, FALSE) AS recovered
           FROM attempts a
           LEFT JOIN terminals t ON t.user_id = a.user_id AND t.id = a.id
           LEFT JOIN signals s ON s.user_id = a.user_id AND s.id = a.id
       )
       SELECT
         (SELECT COUNT(*) FROM ui
           WHERE metadata->>'kind' = 'screen_visit')::int AS visits,
         (SELECT COUNT(DISTINCT user_id) FROM ui)::int AS reporting_users,
         COUNT(*)::int AS attempts,
         COUNT(*) FILTER (WHERE has_client_terminal OR server_failed)::int AS terminal_attempts,
         COUNT(*) FILTER (WHERE NOT has_client_terminal AND NOT server_failed)::int AS unresolved_attempts,
         (SELECT COUNT(*) FROM terminals t WHERE NOT EXISTS (
           SELECT 1 FROM attempts a WHERE a.user_id = t.user_id AND a.id = t.id))::int AS orphan_terminal_attempts,
         COUNT(*) FILTER (WHERE failed)::int AS failures,
         COUNT(*) FILTER (WHERE cancelled AND NOT failed AND NOT succeeded)::int AS cancellations,
         COUNT(*) FILTER (WHERE timed_out)::int AS timeouts,
         COUNT(*) FILTER (WHERE abandoned)::int AS abandonments,
         COUNT(*) FILTER (WHERE repeated)::int AS repeats,
         COUNT(*) FILTER (WHERE recovered)::int AS recoveries,
         (SELECT COUNT(*) FROM ui WHERE metadata->>'kind' = 'server_failure')::int AS server_failures,
         (SELECT COUNT(DISTINCT user_id) FROM ui WHERE
           (metadata->>'kind' = 'action_outcome' AND metadata->>'outcome' = 'failure')
           OR metadata->>'kind' IN ('boot_failure','loading_timeout','navigation_abandonment','server_failure'))::int AS affected_users
       FROM cohort`, uiParams),
    pool.query(
      `WITH ui AS (
         SELECT e.user_id, e.metadata FROM events e JOIN users u ON u.id = e.user_id
          WHERE e.event_type = 'ui_experience' AND ${uiBase}
       ), attempts AS (
         SELECT user_id, metadata->>'attemptId' AS id,
           COALESCE(MIN(metadata->>'action') FILTER (WHERE metadata->>'kind' = 'action_attempt'),
             MIN(metadata->>'action')) AS action
           FROM ui WHERE metadata->>'kind' IN ('action_attempt','server_failure')
             AND metadata ? 'attemptId' AND metadata ? 'action'
           GROUP BY user_id, metadata->>'attemptId'
       ), outcomes AS (
         SELECT user_id, metadata->>'attemptId' AS id,
           BOOL_OR(metadata->>'outcome' = 'success') AS succeeded,
           BOOL_OR(metadata->>'outcome' = 'failure') AS client_failed,
           BOOL_OR(metadata->>'outcome' = 'cancelled') AS cancelled,
           MAX((metadata->>'durationMs')::int) FILTER
             (WHERE metadata->>'outcome' IN ('success','failure') AND metadata ? 'durationMs') AS duration_ms
           FROM ui WHERE metadata->>'kind' = 'action_outcome' AND metadata ? 'attemptId'
           GROUP BY user_id, metadata->>'attemptId'
       ), signals AS (
         SELECT user_id, metadata->>'attemptId' AS id,
           BOOL_OR(metadata->>'kind' = 'server_failure') AS server_failed,
           BOOL_OR(metadata->>'kind' = 'loading_timeout') AS timed_out,
           BOOL_OR(metadata->>'kind' = 'navigation_abandonment') AS abandoned,
           BOOL_OR(metadata->>'kind' = 'repeated_action') AS repeated,
           BOOL_OR(metadata->>'kind' = 'recovery') AS recovered
           FROM ui WHERE metadata ? 'attemptId'
           GROUP BY user_id, metadata->>'attemptId'
       ), cohort AS (
         SELECT a.user_id, a.action, o.id IS NOT NULL AS has_client_terminal,
           COALESCE(o.succeeded, FALSE) AND NOT COALESCE(s.server_failed, FALSE) AS succeeded,
           COALESCE(o.client_failed, FALSE) OR COALESCE(s.server_failed, FALSE) AS failed,
           COALESCE(o.cancelled, FALSE) AS cancelled, o.duration_ms,
           COALESCE(s.server_failed, FALSE) AS server_failed,
           COALESCE(s.timed_out, FALSE) AS timed_out,
           COALESCE(s.abandoned, FALSE) AS abandoned,
           COALESCE(s.repeated, FALSE) AS repeated,
           COALESCE(s.recovered, FALSE) AS recovered
           FROM attempts a
           LEFT JOIN outcomes o ON o.user_id = a.user_id AND o.id = a.id
           LEFT JOIN signals s ON s.user_id = a.user_id AND s.id = a.id
       ), actions AS (
         SELECT action, COUNT(*)::int AS attempts,
           COUNT(*) FILTER (WHERE has_client_terminal OR server_failed)::int AS terminal_attempts,
           COUNT(*) FILTER (WHERE succeeded)::int AS successes,
           COUNT(*) FILTER (WHERE failed)::int AS failures,
           COUNT(*) FILTER (WHERE cancelled AND NOT failed AND NOT succeeded)::int AS cancellations,
           COUNT(*) FILTER (WHERE timed_out)::int AS timeouts,
           COUNT(*) FILTER (WHERE abandoned)::int AS abandonments,
           COUNT(*) FILTER (WHERE repeated)::int AS repeats,
           COUNT(*) FILTER (WHERE recovered)::int AS recoveries,
           COUNT(DISTINCT user_id) FILTER (WHERE failed OR timed_out OR abandoned)::int AS affected_users,
           ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
             FILTER (WHERE (succeeded OR failed) AND duration_ms IS NOT NULL))::int AS p50_ms,
           ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
             FILTER (WHERE (succeeded OR failed) AND duration_ms IS NOT NULL))::int AS p95_ms
           FROM cohort GROUP BY action
       )
       SELECT *, (successes + failures)::int AS failure_denominator,
         CASE WHEN successes + failures > 0
           THEN ROUND(100.0 * failures / (successes + failures), 1)::float ELSE NULL END AS failure_rate
       FROM actions ORDER BY failures DESC, timeouts DESC, attempts DESC, action ASC`, uiParams),
    pool.query(
      `SELECT e.metadata->>'screen' AS screen,
         COUNT(*)::int AS visits,
         COUNT(DISTINCT e.user_id)::int AS users
       FROM events e JOIN users u ON u.id = e.user_id
       WHERE e.event_type = 'ui_experience' AND ${uiBase}
         AND e.metadata->>'kind' = 'screen_visit'
       GROUP BY e.metadata->>'screen' ORDER BY visits DESC, screen ASC`, uiParams),
    pool.query(
      `WITH ui AS (
         SELECT e.id AS row_id, e.user_id, e.app_id, e.metadata
           FROM events e JOIN users u ON u.id = e.user_id
           WHERE e.event_type = 'ui_experience' AND ${uiBase}
       ), per_attempt AS (
         SELECT user_id,
           COALESCE(metadata->>'attemptId', 'event-' || row_id::text) AS identity,
           MAX(app_id) AS app_id, MAX(metadata->>'build') AS build,
           BOOL_OR(metadata->>'kind' = 'action_attempt') AS attempted,
           BOOL_OR(metadata->>'kind' = 'action_outcome' AND metadata->>'outcome' = 'success') AS succeeded,
           BOOL_OR((metadata->>'kind' = 'action_outcome' AND metadata->>'outcome' = 'failure')
             OR metadata->>'kind' = 'server_failure') AS failed,
           BOOL_OR(metadata->>'kind' = 'loading_timeout') AS timed_out,
           BOOL_OR(metadata->>'kind' = 'navigation_abandonment') AS abandoned
           FROM ui GROUP BY user_id, COALESCE(metadata->>'attemptId', 'event-' || row_id::text)
       )
       SELECT a.slug AS app_slug, p.build,
         COUNT(*) FILTER (WHERE p.attempted)::int AS attempts,
         COUNT(*) FILTER (WHERE p.succeeded AND NOT p.failed)::int AS successes,
         COUNT(*) FILTER (WHERE p.failed)::int AS failures,
         COUNT(*) FILTER (WHERE p.timed_out)::int AS timeouts,
         COUNT(*) FILTER (WHERE p.abandoned)::int AS abandonments,
         COUNT(DISTINCT p.user_id) FILTER (WHERE p.failed OR p.timed_out OR p.abandoned)::int AS affected_users
       FROM per_attempt p LEFT JOIN apps a ON a.id = p.app_id
       GROUP BY a.slug, p.build
       HAVING COUNT(*) FILTER (WHERE p.failed OR p.timed_out OR p.abandoned) > 0
       ORDER BY failures DESC, timeouts DESC, abandonments DESC, affected_users DESC
       LIMIT 20`, uiParams),
    pool.query(
      `WITH coded AS (
         SELECT e.id, e.user_id, e.metadata, e.created_at,
           CASE WHEN e.metadata->>'kind' IN ('action_outcome','server_failure')
                  AND e.metadata ? 'attemptId'
             THEN 'attempt-' || e.user_id::text || '-' || (e.metadata->>'attemptId')
             ELSE 'event-' || e.id::text END AS identity,
           ROW_NUMBER() OVER (
             PARTITION BY CASE WHEN e.metadata->>'kind' IN ('action_outcome','server_failure')
                    AND e.metadata ? 'attemptId'
               THEN 'attempt-' || e.user_id::text || '-' || (e.metadata->>'attemptId')
               ELSE 'event-' || e.id::text END
             ORDER BY (e.metadata->>'kind' = 'server_failure') DESC, e.created_at DESC
           ) AS rank
         FROM events e JOIN users u ON u.id = e.user_id
         WHERE e.event_type = 'ui_experience' AND ${uiBase} AND e.metadata ? 'errorCode'
       )
       SELECT metadata->>'errorCode' AS error_code,
         COUNT(*)::int AS count, COUNT(DISTINCT user_id)::int AS affected_users
       FROM coded WHERE rank = 1
       GROUP BY metadata->>'errorCode' ORDER BY count DESC, error_code ASC LIMIT 12`, uiParams),
    pool.query(
      `SELECT COUNT(*)::int AS receipts, COUNT(DISTINCT e.user_id)::int AS reporting_users,
         COALESCE(SUM((e.metadata->>'submitted')::int), 0)::int AS submitted,
         COALESCE(SUM((e.metadata->>'accepted')::int), 0)::int AS accepted,
         COALESCE(SUM((e.metadata->>'failedBatches')::int), 0)::int AS failed_batches,
         COALESCE(SUM((e.metadata->>'droppedEvents')::int), 0)::int AS dropped_events,
         MIN(e.created_at) AS first_receipt_at, MAX(e.created_at) AS latest_receipt_at
       FROM events e JOIN users u ON u.id = e.user_id
       WHERE e.event_type = 'ui_telemetry_delivery' AND ${base}`, params),
  ]);
  const d = delivery.rows[0] || {};
  const receipts = Number(d.receipts || 0);
  const dropped = Number(d.dropped_events || 0);
  const failed = Number(d.failed_batches || 0);
  return {
    windowDays: days,
    generatedAt: new Date().toISOString(),
    coverage: {
      state: receipts === 0 ? 'none' : (dropped > 0 || failed > 0 ? 'loss_observed' : 'reporting'),
      receipts,
      reportingUsers: Number(d.reporting_users || 0),
      submittedRecords: Number(d.submitted || 0),
      acceptedRecords: Number(d.accepted || 0),
      failedBatchesRecovered: failed,
      droppedRecordsReported: dropped,
      firstReceiptAt: d.first_receipt_at || null,
      latestReceiptAt: d.latest_receipt_at || null,
      limitation: 'Client delivery can be absent. No receipts means no observed coverage, not zero failures.',
    },
    overview: overall.rows[0] || {},
    journeys: journeys.rows,
    screens: screens.rows,
    contexts: contexts.rows,
    errors: errors.rows,
  };
}

module.exports = {
  ACTIONS,
  JOURNEY_SCREENS,
  NAV_SCREENS,
  VIAS,
  ERROR_CODES,
  KINDS,
  MAX_BATCH_EVENTS,
  MAX_BODY_BYTES,
  OUTCOMES,
  SCREENS,
  TelemetryValidationError,
  aggregate,
  daysWindow,
  insertBatch,
  isEligibleUser,
  parseBatch,
  recordServerFailure,
  safeServerError,
};
