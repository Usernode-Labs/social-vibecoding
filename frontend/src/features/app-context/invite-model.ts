/**
 * The invite pane's arithmetic (./invite-pane.tsx), kept pure so the words it
 * produces can be tested without rendering the sheet.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until `iso`, rounded up; 0 once it has passed. */
export function daysUntil(iso: string, now = Date.now()): number {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((at - now) / DAY_MS));
}
