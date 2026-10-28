'use strict';

function activityTimePrecision(row) {
  const metadata = row.metadata || {};
  if (metadata.timestamp_precision === 'day' || metadata.timestamp_precision === 'instant') {
    return metadata.timestamp_precision;
  }
  // Credits written by the old date-grained app-use scorer are identifiable
  // by their measure, rather than by guessing from the hour of a timestamp.
  return ['TRY_APPS', 'USE_APPS_MINUTES'].includes(metadata.measure) ? 'day' : 'instant';
}

// A calendar date with no time of day, as a partner, the identity check or
// an admin can send it ("2026-10-20").
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Parse an inbound `activity_at` (or `completed_at`) into the instant to
// store and the precision to mark it with.
//
// `new Date('2026-10-20')` is 00:00:00.000 UTC: midnight, which is not what
// "some time that day" means. Stored that way the Activities list prints
// "12:00 AM" (or the evening before, west of UTC) for something done in the
// afternoon. A bare date is instead pinned to noon UTC — the same anchor the
// scorer's `dateToIso` and the renderer's date-only fallback use — and marked
// 'day', which the list draws as the date alone. Anything else keeps today's
// behaviour: that exact instant, marked 'instant'.
//
// Returns null for anything absent or unparsable, so callers keep their own
// required/invalid messages.
function parseActivityAt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && BARE_DATE.test(value)) {
    const at = new Date(`${value}T12:00:00Z`);
    // Reject a date that does not exist ("2026-02-30") rather than letting
    // it roll forward into March.
    if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value) return null;
    return { at, precision: 'day' };
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return { at, precision: 'instant' };
}

module.exports = { activityTimePrecision, parseActivityAt };
