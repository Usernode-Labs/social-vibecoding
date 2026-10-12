import type { ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';

/**
 * One points activity, with when it happened (#3648), for the activity lists in the
 * profile overlay (./challenges-pane.tsx) and the standings drill-down
 * (./topochain-standings.tsx).
 *
 * Both lists showed only what was done and the points, so nobody could tell
 * which day a credit belonged to or check it against what they remember
 * doing. Every activity the API returns carries `activity_at`; this turns it
 * into one compact line in the viewer's own locale and timezone:
 *
 *   this year        Fri, Oct 2 · 04:32 PM
 *   an earlier year  Fri, Oct 2, 2025 · 04:32 PM
 *
 * Some credits have a day and no time. The challenge scorer reads a few
 * measures off `date` columns and pins each to NOON UTC (`dateToIso` in
 * src/services/topochain/challenge-scorer.js) so the credit stays inside its
 * own day everywhere. Printing that as "02:00 PM" in Berlin would be a time
 * nobody did anything at, so a noon-UTC instant shows its date alone, read
 * in UTC: that is the calendar day the column held.
 *
 * Kept out of ../topochain-challenges.js and ../topochain-leaderboard.js on
 * purpose: those view modules must stay import-free (tests evaluate them in a
 * bare vm), so they pass `activity_at` through and the renderers format it.
 */

export interface ActivityWhen {
  /** What the row shows. */
  text: string;
  /** The unelided form, for `title`. */
  title: string;
  /** The instant, for `<time dateTime>`. */
  iso: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function format(date: Date, key: string, options: Intl.DateTimeFormatOptions): string {
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, options);
    formatters.set(key, formatter);
  }
  return formatter.format(date);
}

/** A date-only credit: exactly 12:00:00.000 UTC, as the scorer pins them. */
export function isDateOnly(date: Date): boolean {
  return date.getUTCHours() === 12 && date.getUTCMinutes() === 0
    && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
}

export function activityWhen(
  value: string | null | undefined,
  opts: { now?: Date } = {},
): ActivityWhen | null {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const now = opts.now || new Date(Date.now());
  const dateOnly = isDateOnly(date);
  // The date-only case reads the calendar day in UTC, so the year test does too.
  const year = dateOnly ? date.getUTCFullYear() : date.getFullYear();
  const zone: Intl.DateTimeFormatOptions = dateOnly ? { timeZone: 'UTC' } : {};
  const z = dateOnly ? 'utc' : 'local';
  const day = year === now.getFullYear()
    ? format(date, `day-${z}`, { ...zone, weekday: 'short', month: 'short', day: 'numeric' })
    : format(date, `day-year-${z}`, { ...zone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const fullDay = format(date, `full-${z}`, { ...zone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (dateOnly) return { text: day, title: fullDay, iso: date.toISOString() };
  const time = format(date, 'time', { hour: '2-digit', minute: '2-digit' });
  return {
    text: translate('leaderboard:activity.dayTime', { day, time }),
    title: translate('leaderboard:activity.dayTimeFull', { day: fullDay, time }),
    iso: date.toISOString(),
  };
}

/**
 * The row both lists draw: what was done, when, and the points. The date is
 * a second, smaller line under the reason, so a long reason still wraps
 * beside the points rather than pushing them off the row.
 */
export function ActivityRow({ text, points, at }: { text: string; points: string; at?: string | null }): ReactNode {
  // Subscribed: the date line's separator is read by activityWhen.
  useMessages('leaderboard');
  const when = activityWhen(at);
  return (
    <li className="flex items-start justify-between gap-3 text-xs">
      <span className="min-w-0">
        <span className="block text-zinc-600 dark:text-zinc-300">{text}</span>
        {when ? (
          <time
            className="block text-[0.6875rem] text-zinc-500 dark:text-zinc-400"
            dateTime={when.iso}
            title={when.title}
            data-activity-when=""
          >
            {when.text}
          </time>
        ) : null}
      </span>
      <span className="shrink-0 font-mono text-zinc-500 dark:text-zinc-400">{points}</span>
    </li>
  );
}
