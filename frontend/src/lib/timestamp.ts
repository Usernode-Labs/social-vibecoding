/**
 * One rule for "when was this said" (#1808).
 *
 * Every transcript in the product stamped a bare time of day. A row read
 * "02:41 PM" whether it was posted ten minutes ago or in March, so a
 * discussion scrolled back through carried no answer to the question people
 * actually ask of it: when. The reporter hit it on the app discussions and
 * guessed, correctly, that it was not only there.
 *
 * The fix is deliberately not "print the date on every row". A live thread
 * of today's messages is easier to scan with the time alone, and a repeated
 * date is noise the eye learns to skip — which is how a stamp stops being
 * read at all. So the extra words are spent only where they carry
 * information:
 *
 *   today            02:41 PM
 *   earlier this year Jun 16, 02:41 PM
 *   an earlier year   Jun 16, 2025, 02:41 PM
 *
 * and `title` always carries the unambiguous form, so a row whose date is
 * elided is still one hover from certain.
 *
 * `now` is a parameter, not a `Date.now()` read inside the function, because
 * the whole behaviour IS the boundary between those three branches and a
 * test that cannot move "today" can only assert the middle of each.
 *
 * `public/js/group-chat.js` carries the same table as `GroupChat._stamp`:
 * that file is a legacy IIFE outside this bundle and cannot import from
 * here. The two are kept in step by hand and pinned together by
 * tests/message-timestamp.test.js — the same arrangement, and the same
 * reason, as `swatchFor` in features/messages/format.tsx.
 */

export interface Stamp {
  /** What the row shows: the time, preceded by the date when it is not today. */
  text: string;
  /** The full stamp, for `title`. Never elides anything. */
  title: string;
}

/** The full form, matching GroupChat._stamp's title exactly. */
const FULL: Intl.DateTimeFormatOptions = {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
};

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

export function messageStamp(
  value: string | number | Date | null | undefined,
  opts: { now?: Date; hour?: 'numeric' | '2-digit' } = {},
): Stamp {
  // An optimistic row reaches here before the server has stamped it, and
  // neither "Invalid Date" nor a 1970 date belongs in front of a reader —
  // `new Date(null)` is the epoch rather than an invalid date, so the
  // nullish case is turned away before parsing.
  const date = value instanceof Date ? value : new Date(value ?? NaN);
  if (Number.isNaN(date.getTime())) return { text: '', title: '' };

  const now = opts.now ?? new Date();
  const time = date.toLocaleTimeString(undefined, { hour: opts.hour ?? '2-digit', minute: '2-digit' });
  const title = date.toLocaleString(undefined, FULL);
  if (sameDay(date, now)) return { text: time, title };

  // The year is dropped inside the current one for the same reason the date
  // is dropped inside today: it is the same for almost every row on screen.
  const day = date.toLocaleDateString(undefined, date.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
  return { text: `${day}, ${time}`, title };
}
