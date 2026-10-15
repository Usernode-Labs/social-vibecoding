'use strict';

const crypto = require('crypto');
const appAccess = require('./app-access');
const log = require('./logger');

const ACTIVITY_MAX_PER_POST = 3600;
const ACTIVITY_MAX_PER_DAY = 86400;
// The current UTC day plus the previous seven UTC dates are accepted. Client
// queues expire at seven elapsed days; the extra calendar edge avoids dropping
// a legitimate slice solely because its local retry crossed midnight.
const ACTIVITY_MAX_AGE_DAYS = 7;
const ACTIVITY_MAX_ENTRIES = 8;
const ACTIVITY_MAX_INTERVALS = 64;
const ACTIVITY_CLOCK_SKEW_MS = 60_000;
const ACTIVITY_RECEIPT_RETENTION_DAYS = 30;
const ACTIVITY_RECEIPT_CLEANUP_MS = 6 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let nextReceiptCleanupAt = 0;
let receiptCleanup = null;

function activitySeconds(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const rounded = Math.round(raw);
  if (rounded <= 0) return null;
  return Math.min(rounded, ACTIVITY_MAX_PER_POST);
}

function utcDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || utcDay(ms) !== value) return null;
  return ms;
}

/**
 * Parse either the legacy `{ seconds }` heartbeat or a receipt-backed batch.
 * New batches are intentionally strict: the stable receipt represents exact
 * immutable content, so a malformed or over-limit batch is refused wholesale.
 */
function parseActivityRequest(body, now = new Date()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!Object.prototype.hasOwnProperty.call(body, 'batchId')) {
    const seconds = activitySeconds(body.seconds);
    return seconds === null ? null : { legacy: true, seconds };
  }
  if (![1, 2].includes(body.version) || typeof body.batchId !== 'string' || !UUID_RE.test(body.batchId)) {
    return null;
  }
  if (!Array.isArray(body.entries) || body.entries.length < 1
      || body.entries.length > ACTIVITY_MAX_ENTRIES) return null;

  const today = parseDay(utcDay(now));
  const earliest = today - ACTIVITY_MAX_AGE_DAYS * 86_400_000;
  const seen = new Set();
  const entries = [];
  let total = 0;
  let intervalCount = 0;
  for (const raw of body.entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const at = parseDay(raw.date);
    if (at === null || at < earliest || at > today || seen.has(raw.date)) return null;
    if (typeof raw.seconds !== 'number' || !Number.isSafeInteger(raw.seconds)
        || raw.seconds <= 0) return null;
    total += raw.seconds;
    if (total > ACTIVITY_MAX_PER_POST) return null;
    seen.add(raw.date);
    const entry = { date: raw.date, seconds: raw.seconds };
    if (body.version === 2) {
      if (!Array.isArray(raw.intervals) || !raw.intervals.length) return null;
      entry.intervals = [];
      let milliseconds = 0;
      let previousEnd = at;
      for (const interval of raw.intervals) {
        if (++intervalCount > ACTIVITY_MAX_INTERVALS || !interval) return null;
        if (typeof interval.startedAt !== 'string' || typeof interval.endedAt !== 'string') return null;
        const start = Date.parse(interval.startedAt);
        const end = Date.parse(interval.endedAt);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start
            || new Date(start).toISOString() !== interval.startedAt
            || new Date(end).toISOString() !== interval.endedAt
            || start < previousEnd || utcDay(start) !== raw.date
            || utcDay(end - 1) !== raw.date || end > now.getTime() + ACTIVITY_CLOCK_SKEW_MS) return null;
        milliseconds += end - start;
        previousEnd = end;
        entry.intervals.push({ startedAt: interval.startedAt, endedAt: interval.endedAt });
      }
      if (milliseconds !== raw.seconds * 1_000) return null;
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return {
    legacy: false,
    batchId: body.batchId.toLowerCase(),
    entries,
    payloadHash: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  };
}

class ActivityRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function uncoveredIntervals(interval, stored) {
  let cursor = Date.parse(interval.startedAt);
  const end = Date.parse(interval.endedAt);
  const out = [];
  for (const row of stored) {
    const from = new Date(row.started_at).getTime();
    const to = new Date(row.ended_at).getTime();
    if (from > cursor) out.push({ start: cursor, end: Math.min(from, end) });
    cursor = Math.max(cursor, to);
    if (cursor >= end) break;
  }
  if (cursor < end) out.push({ start: cursor, end });
  return out;
}

async function purgeActivityReceipts(pool) {
  const result = await pool.query(
    `DELETE FROM app_activity_receipts
      WHERE received_at < NOW() - ($1 || ' days')::interval`,
    [String(ACTIVITY_RECEIPT_RETENTION_DAYS)]
  );
  return result.rowCount || 0;
}

function maybePurgeActivityReceipts(pool, now = Date.now()) {
  if (receiptCleanup || now < nextReceiptCleanupAt) return receiptCleanup || Promise.resolve(0);
  nextReceiptCleanupAt = now + ACTIVITY_RECEIPT_CLEANUP_MS;
  receiptCleanup = purgeActivityReceipts(pool).catch((error) => {
    log.debug('apps', 'Activity receipt cleanup failed', { message: error.message });
    return 0;
  }).finally(() => { receiptCleanup = null; });
  return receiptCleanup;
}

// The cleanup a commit starts is not awaited: it runs on another pooled
// connection and can finish at any later point. A test awaits it before it
// ages a receipt that it expects its own purge call to delete.
function _awaitReceiptCleanupForTests() {
  return receiptCleanup || Promise.resolve(0);
}

/**
 * Store one parsed modern batch. Receipt, day totals and first-day events are
 * one transaction, so retrying after a committed response was lost is a no-op.
 */
async function recordActivityBatch(pool, { slug, user, request }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const app = await appAccess.getAppForUser(
      client, slug, user, 'view', appAccess.ACCESS_COLUMNS
    );
    if (!app) throw new ActivityRequestError('not_found', 'App not found');

    const receipt = await client.query(
      `INSERT INTO app_activity_receipts
         (user_id, app_id, batch_id, payload_sha256)
       VALUES ($1, $2, $3::uuid, $4)
       ON CONFLICT (user_id, batch_id) DO NOTHING
       RETURNING batch_id`,
      [user.id, app.id, request.batchId, request.payloadHash]
    );
    if (!receipt.rowCount) {
      const prior = await client.query(
        `SELECT app_id, payload_sha256
           FROM app_activity_receipts
          WHERE user_id = $1 AND batch_id = $2::uuid`,
        [user.id, request.batchId]
      );
      const same = prior.rows[0]
        && Number(prior.rows[0].app_id) === Number(app.id)
        && prior.rows[0].payload_sha256 === request.payloadHash;
      if (!same) throw new ActivityRequestError('batch_id_reused', 'Batch ID was reused');
      await client.query('COMMIT');
      void maybePurgeActivityReceipts(pool);
      return { duplicate: true };
    }

    const precise = request.entries.some((entry) => entry.intervals);
    // Serialize different receipts for the same person before checking their
    // intervals. Concurrent tabs cannot credit the same elapsed time twice.
    // Receipt foreign keys already hold KEY SHARE here. NO KEY UPDATE
    // serializes usage writers without deadlocking those concurrent checks.
    if (precise) await client.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [user.id]);
    let intervalIndex = 0;
    const scoring = { appId: app.id, userId: user.id, seconds: 0, daySeconds: 0 };
    for (const entry of request.entries) {
      let freshMilliseconds = 0;
      for (const interval of entry.intervals || []) {
        const { rows: stored } = await client.query(
          `SELECT id, started_at, ended_at FROM app_usage_intervals
            WHERE user_id = $1 AND app_id = $2
              AND started_at <= $4::timestamptz AND ended_at >= $3::timestamptz
              AND date = $5::date
            ORDER BY started_at, id`,
          [user.id, app.id, interval.startedAt, interval.endedAt, entry.date]
        );
        for (const piece of uncoveredIntervals(interval, stored)) {
          freshMilliseconds += piece.end - piece.start;
          // Continuous use is one interval, even across many upload receipts.
          // Pauses stay separate and cannot be counted as elapsed engagement.
          const adjacent = stored.find((r) => new Date(r.ended_at).getTime() === piece.start
            && utcDay(new Date(r.started_at).getTime()) === entry.date);
          if (adjacent) {
            await client.query('UPDATE app_usage_intervals SET ended_at = $2::timestamptz WHERE id = $1',
              [adjacent.id, new Date(piece.end).toISOString()]);
          } else {
            await client.query(
              `INSERT INTO app_usage_intervals
                 (user_id, app_id, batch_id, interval_index, date, started_at, ended_at)
               VALUES ($1, $2, $3::uuid, $4, $5::date, $6::timestamptz, $7::timestamptz)`,
              [user.id, app.id, request.batchId, intervalIndex++, entry.date,
                new Date(piece.start).toISOString(), new Date(piece.end).toISOString()]
            );
          }
        }
      }
      const activity = entry.intervals ? await client.query(
        `INSERT INTO app_activity (app_id, user_id, seconds_spent, date, precise_milliseconds)
         VALUES ($1, $2, FLOOR($5::numeric / 1000), $3::date, $5)
         ON CONFLICT (app_id, user_id, date)
         DO UPDATE SET seconds_spent = LEAST(app_activity.seconds_spent
           + FLOOR((app_activity.precise_milliseconds + EXCLUDED.precise_milliseconds)::numeric / 1000)
           - FLOOR(app_activity.precise_milliseconds::numeric / 1000), $4),
           precise_milliseconds = app_activity.precise_milliseconds + EXCLUDED.precise_milliseconds
         RETURNING (xmax = 0) AS inserted, seconds_spent,
           FLOOR(precise_milliseconds::numeric / 1000)
           - FLOOR((precise_milliseconds - $5)::numeric / 1000) AS added_seconds`,
        [app.id, user.id, entry.date, ACTIVITY_MAX_PER_DAY, freshMilliseconds]
      ) : await client.query(
        `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
         VALUES ($1, $2, $3, $4::date)
         ON CONFLICT (app_id, user_id, date)
         DO UPDATE SET seconds_spent = LEAST(
           app_activity.seconds_spent + EXCLUDED.seconds_spent, $5)
         RETURNING (xmax = 0) AS inserted, seconds_spent`,
        [app.id, user.id, entry.seconds, entry.date, ACTIVITY_MAX_PER_DAY]
      );
      // All occurrence days commit together. Pass their combined increment
      // and totals to the crossing guard once, after the transaction commits.
      scoring.seconds += entry.intervals ? Number(activity.rows[0]?.added_seconds) || 0 : entry.seconds;
      scoring.daySeconds += Number(activity.rows[0]?.seconds_spent) || 0;
      if (activity.rows[0]?.inserted) {
        await client.query(
          `INSERT INTO events (user_id, app_id, event_type, metadata, created_at)
           VALUES ($1, $2, 'dapp_active_day', $3::jsonb,
             $4::timestamptz)`,
          [user.id, app.id, JSON.stringify({
            batchId: request.batchId,
            source: 'engaged_usage',
            timestampPrecision: entry.intervals ? 'instant' : 'day',
          }), entry.intervals ? entry.intervals[0].startedAt : `${entry.date}T00:00:00.000Z`]
        );
      }
    }
    await client.query('COMMIT');
    void maybePurgeActivityReceipts(pool);
    return { duplicate: false, scoring };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ACTIVITY_MAX_AGE_DAYS,
  ACTIVITY_MAX_ENTRIES,
  ACTIVITY_MAX_INTERVALS,
  ACTIVITY_MAX_PER_DAY,
  ACTIVITY_MAX_PER_POST,
  ACTIVITY_RECEIPT_RETENTION_DAYS,
  ActivityRequestError,
  activitySeconds,
  parseActivityRequest,
  purgeActivityReceipts,
  recordActivityBatch,
  _awaitReceiptCleanupForTests,
};
