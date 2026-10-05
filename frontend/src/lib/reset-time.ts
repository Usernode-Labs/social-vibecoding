import { t as tr, getLanguage } from "./i18n/runtime";
/**
 * When an allowance comes back, in the reader's own clock (#3230).
 *
 * The server keeps its allowances on UTC boundaries: the weekly AI credits
 * and kudos reset on Monday 00:00 UTC, the shared daily budget at midnight
 * UTC. The copy used to say exactly that, which left everyone not on UTC to
 * do the arithmetic. So the words now name the reader's local moment —
 * "Resets Sunday at 8:00 PM", "They reset at 9:00 AM" — and the exact UTC
 * instant goes on `title`, one hover from certain.
 *
 *   resetWhen('weekly')   "Sunday at 8:00 PM"   (New York)
 *   resetWhen('daily')    "at 9:00 AM"          (Tokyo)
 *   resetUtc('weekly')    "Mon, Oct 5, 00:00 UTC"
 *
 * Both take the instant from the server's `resetsAt` when a caller has one,
 * and otherwise compute the next boundary from `now`.
 *
 * Classic scripts under public/js cannot import from this bundle, so the
 * module also publishes itself as `window.ResetTime`, and they read it at
 * call time (long after this bundle has evaluated). Called during a render,
 * these read the viewer's clock and time zone, which the prerender does not
 * have: a React component calls them from an effect, never in its first
 * render.
 */

export type ResetCadence = 'weekly' | 'daily';

export interface ResetOptions {
  /** The server's own reset instant, when the caller has one. */
  at?: Date | string | number | null;
  /** Injectable clock, for the tests. */
  now?: number;
  /** Injectable locale, for the tests. The browser's otherwise. */
  locale?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The next Monday 00:00 UTC (weekly) or 00:00 UTC (daily) after `now`. */
export function nextReset(cadence: ResetCadence, now: number = Date.now()): Date {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (cadence !== 'weekly') return new Date(midnight + DAY_MS);
  // getUTCDay: Sunday 0 … Saturday 6. Days until the NEXT Monday, 7 on a
  // Monday itself, because that Monday's midnight has already passed.
  const days = ((8 - d.getUTCDay()) % 7) || 7;
  return new Date(midnight + days * DAY_MS);
}

function resolve(cadence: ResetCadence, opts: ResetOptions = {}): Date {
  if (opts.at != null) {
    const at = new Date(opts.at);
    if (Number.isFinite(at.getTime())) return at;
  }
  return nextReset(cadence, opts.now == null ? Date.now() : opts.now);
}

/**
 * The local moment, worded to follow "Resets …": "Sunday at 8:00 PM" for a
 * weekly reset, "at 8:00 PM" for a daily one.
 */
export function resetWhen(cadence: ResetCadence, opts: ResetOptions = {}): string {
  const at = resolve(cadence, opts);
  const time = new Intl.DateTimeFormat(opts.locale || getLanguage(), { hour: 'numeric', minute: '2-digit' }).format(at);
  if (cadence !== 'weekly') return tr("core:at_value1_e995934a", { value1: time });
  const day = new Intl.DateTimeFormat(opts.locale || getLanguage(), { weekday: 'long' }).format(at);
  return tr("core:value1_at_value2_cb704c30", { value1: day, value2: time });
}

/** The same instant in UTC, for `title`: "Mon, Oct 5, 00:00 UTC". */
export function resetUtc(cadence: ResetCadence, opts: ResetOptions = {}): string {
  const at = resolve(cadence, opts);
  return new Intl.DateTimeFormat(opts.locale || getLanguage(), {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(at) + ' UTC';
}

/**
 * Server sentences ("Weekly limit reached ($50.00). Resets Monday 00:00
 * UTC.") name the UTC boundary too, and some surfaces print them verbatim.
 * This rewrites the three spellings the server uses into the local moment,
 * and leaves anything else untouched.
 */
export function localizeResetText(text: string, opts: Omit<ResetOptions, 'at'> = {}): string {
  if (!text) return text;
  return String(text)
    .replace(/Monday 00:00 UTC/g, () => resetWhen('weekly', opts))
    .replace(/the midnight UTC reset/g, () => tr("core:the_daily_reset_value1_0d9b8486", { value1: resetWhen('daily', opts) }))
    .replace(/at midnight UTC/g, () => resetWhen('daily', opts));
}

const ResetTime = { nextReset, resetWhen, resetUtc, localizeResetText };

if (typeof window !== 'undefined') {
  (window as unknown as { ResetTime?: typeof ResetTime }).ResetTime = ResetTime;
}

export default ResetTime;
