/**
 * One cap for every count the shell spells out in a small space: a badge, a
 * pill, a tab's number, a browser tab's title. Past 99 it reads "99+".
 *
 * The rule used to be written out wherever a count was drawn — the bell, the
 * tab bar, the sidebar's vote counts, a community tile, a project's places,
 * the hub's channel cards, the vote sheet, the dev console — eleven copies of
 * one ternary, any of which could drift to "9+" or "999+" on its own. This is
 * the one place it is said. The bell (features/notifications/notifications.js,
 * which tests evaluate as a classic script) reads it through PlatformI18n,
 * where lib/i18n/runtime.ts publishes it.
 *
 * Only the number shown is capped. A count's plural form and what a screen
 * reader hears still follow the real count, so callers keep the number for
 * those and pass this text as the shown one ("99+ unread").
 */

/** The largest count spelled out in full; past it, `${COUNT_CAP}+`. */
export const COUNT_CAP = 99;

/** A count as a badge or pill shows it: "7", or "99+" past 99. */
export function capCount(count: number): string {
  return count > COUNT_CAP ? `${COUNT_CAP}+` : String(count);
}
