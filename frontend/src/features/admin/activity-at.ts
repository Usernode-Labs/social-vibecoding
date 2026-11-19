'use strict';

// When a challenge activity happened, for the admin console (request 6713).
//
// An activity saved with a calendar date and no time of day is stored at noon
// UTC and marked 'day' (src/services/topochain/activity-time.js). Members see
// the date alone for it. The console printed that noon as a clock time in the
// admin's own zone, which reads as a time somebody acted at. The admin reads
// carry `activity_time_precision`; a 'day' row is drawn as its calendar date,
// read in UTC so it is the day that was saved wherever the admin sits.
//
// Anything else (a real instant, or a response with no precision) goes to the
// screen's own formatter, so each screen keeps its date and time format.
// Import-free on purpose: the console and the programme screens both use it.

export type ActivityTimePrecision = 'day' | 'instant';

export function fmtActivityAt(
  value: string | null | undefined,
  precision: ActivityTimePrecision | null | undefined,
  fmtInstant: (value?: string | null) => string,
  locale?: string,
): string {
  if (precision !== 'day' || !value) return fmtInstant(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fmtInstant(value);
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
