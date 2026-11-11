/**
 * The time zone a person's times are shown in (request #6479).
 *
 * Every formatter used to build `Intl.DateTimeFormat` with no `timeZone`, so
 * times followed the device's zone and nothing else. A person whose device
 * zone is not the one they live by (a phone set to the wrong city, a laptop
 * that kept a holiday's zone) read every time an hour or more off, with no
 * way to say so. Settings › Language now has a Time zone list, saved to the
 * account (`users.timezone`, POST /api/me/timezone), and the shared
 * formatters read it from here:
 *
 *   lib/timestamp.ts                   messageStamp, agoStamp, shortDate
 *   features/leaderboard/activity-row  the activity list's times
 *   public/js/group-chat.js _stamp     through PlatformI18n.timeZone/zonedDay
 *   public/js/app-view.js relStamp     the same
 *
 * `undefined` is Auto: the formatters pass no `timeZone`, exactly as before,
 * so an account that never picks one sees nothing different.
 *
 * Import-free on purpose: the formatters' tests load it on its own and hand
 * the same instance to each of them.
 */

let zone: string | undefined;
const listeners = new Set<() => void>();

/** The canonical IANA name of `value`, or undefined when it is not one this engine knows. */
export function validTimeZone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  if (!clean || clean.length > 64) return undefined;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: clean }).resolvedOptions().timeZone || undefined;
  } catch {
    // An engine that does not know a zone the account saved elsewhere: the
    // device's zone is shown rather than an error in every render.
    return undefined;
  }
}

/** The device's own zone, for the Auto choice's label. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The account's zone, or undefined for Auto (the device's). */
export function getTimeZone(): string | undefined {
  return zone;
}

/**
 * `options` with the picked zone added, for a formatter that writes an
 * instant's time or day. Unchanged under Auto, so the device's zone stands.
 */
export function inZone<T extends Intl.DateTimeFormatOptions>(options: T): T {
  return zone ? { ...options, timeZone: zone } : options;
}

/** For useSyncExternalStore: a string that changes when the zone does. */
export function getTimeZoneSnapshot(): string {
  return zone || '';
}

/** Show times in `value` (an IANA name), or in the device's zone for null. */
export function setTimeZone(value: string | null | undefined): void {
  const next = validTimeZone(value);
  if (next === zone) return;
  zone = next;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* one listener never stops the rest */ }
  }
}

export function subscribeTimeZone(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** "Europe/Paris" → "Europe / Paris", "America/Los_Angeles" → "America / Los Angeles". */
export function timeZoneLabel(value: string): string {
  return value.split('/').map((part) => part.replace(/_/g, ' ')).join(' / ');
}

export interface ZonedDay { year: number; month: number; day: number }

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar day `date` falls on in the shown zone: what "today" and "this
 * year" are decided by. Without a picked zone it is the device's own getters,
 * as every formatter read them before.
 */
export function zonedDay(date: Date): ZonedDay {
  if (!zone) return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  let formatter = dayFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' });
    dayFormatters.set(zone, formatter);
  }
  const out: ZonedDay = { year: 0, month: 0, day: 0 };
  for (const part of formatter.formatToParts(date)) {
    if (part.type === 'year') out.year = Number(part.value);
    else if (part.type === 'month') out.month = Number(part.value);
    else if (part.type === 'day') out.day = Number(part.value);
  }
  return out;
}

type ShellApp = { user?: { timeZone?: string | null } | null };
declare const App: ShellApp | undefined;

/**
 * Saves the signed-in person's zone (POST /api/me/timezone) and shows times
 * in it at once. Rejects when it was not saved; the caller says so in its
 * own words (settings:timezone.saveFailed), since nothing a person can act on
 * differs between a lost connection and a refusal here.
 */
export async function saveAccountTimeZone(value: string | null): Promise<string | null> {
  const response = await fetch('/api/me/timezone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ timeZone: value || null }),
  });
  const body = await response.json().catch(() => ({})) as { timeZone?: string | null; error?: string };
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  const saved = body.timeZone || null;
  if (typeof App !== 'undefined' && App?.user) App.user.timeZone = saved;
  setTimeZone(saved);
  return saved;
}
