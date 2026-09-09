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
 * ── The second form ───────────────────────────────────────────────────
 *
 * `agoStamp` is the same guarantee at a different density. Cards, lists,
 * feeds and notification rows spend one segment of a crowded line on the
 * stamp, and there recency is the thing being said — "3d ago" beats
 * "Jun 13, 02:41 PM" when the reader is scanning for what just happened.
 * But a relative age that never stops being relative says nothing at all:
 * the notification rows read "412d ago", which is a duration and not
 * information. So the relative form has a floor:
 *
 *   under a minute   just now
 *   under an hour    12m ago
 *   under a day      5h ago
 *   under a week     3d ago
 *   a week or more   Jun 16 — or Jun 16, 2025 in an earlier year
 *
 * SEVEN DAYS everywhere. The product used to switch at seven days in one
 * place, thirty in another and never in five more; "6d ago" is a useful
 * thing to read and "23d ago" is not.
 *
 * Past the floor `agoStamp` prints EXACTLY the date part `messageStamp`
 * prints, from the same helper, so the two forms cannot drift in their
 * absolute spellings. `title` is the same unelided stamp in both.
 *
 * ── Where the copies are ──────────────────────────────────────────────
 *
 * Three implementations, down from roughly ten, because two legacy classic
 * scripts sit outside this bundle and cannot import from here:
 *
 *   frontend/src/lib/timestamp.ts   both forms, for everything in the bundle
 *   public/js/group-chat.js         `GroupChat._stamp`  — form A
 *   public/js/app-view.js           `relStamp`          — form B
 *
 * They are kept in step by hand and pinned together by
 * tests/message-timestamp.test.js, which does not grep them — it EXECUTES
 * all of them against one table of instants and asserts they answer
 * identically. Same arrangement, and the same reason, as `swatchFor` in
 * features/messages/format.tsx.
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

/**
 * The day, with the year dropped inside the current one.
 *
 * Shared by both forms on purpose: this is the one spelling of "which day"
 * the product uses, and the elided year is dropped for the same reason the
 * date is dropped inside today — it is the same for almost every row on
 * screen.
 */
function datePart(date: Date, now: Date): string {
  return date.toLocaleDateString(undefined, date.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Parse once, for both forms.
 *
 * An optimistic row reaches here before the server has stamped it, and
 * neither "Invalid Date" nor a 1970 date belongs in front of a reader —
 * `new Date(null)` is the epoch rather than an invalid date, so the nullish
 * case is turned away before parsing.
 */
function parse(value: string | number | Date | null | undefined): Date | null {
  const date = value instanceof Date ? value : new Date(value ?? NaN);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function messageStamp(
  value: string | number | Date | null | undefined,
  opts: { now?: Date; hour?: 'numeric' | '2-digit' } = {},
): Stamp {
  const date = parse(value);
  if (!date) return { text: '', title: '' };

  const now = opts.now ?? new Date();
  const time = date.toLocaleTimeString(undefined, { hour: opts.hour ?? '2-digit', minute: '2-digit' });
  const title = date.toLocaleString(undefined, FULL);
  if (sameDay(date, now)) return { text: time, title };
  return { text: `${datePart(date, now)}, ${time}`, title };
}

/** The floor under the relative form, in milliseconds. See the header. */
const RELATIVE_FLOOR_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Form B: the age for a card, list, feed or notification row.
 *
 * Never relative at or past a week — that boundary IS the fix for #1808 on
 * these surfaces, and tests/message-timestamp.test.js asserts it directly.
 *
 * A future instant (a clock skew between the server's stamp and the
 * reader's browser, which happens) clamps to "just now" rather than
 * printing a negative age.
 */
export function agoStamp(
  value: string | number | Date | null | undefined,
  opts: { now?: Date } = {},
): Stamp {
  const date = parse(value);
  if (!date) return { text: '', title: '' };

  const now = opts.now ?? new Date();
  const title = date.toLocaleString(undefined, FULL);
  const elapsed = now.getTime() - date.getTime();
  if (elapsed >= RELATIVE_FLOOR_MS) return { text: datePart(date, now), title };

  const seconds = Math.max(0, Math.floor(elapsed / 1000));
  if (seconds < 60) return { text: 'just now', title };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { text: `${minutes}m ago`, title };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { text: `${hours}h ago`, title };
  return { text: `${Math.floor(hours / 24)}d ago`, title };
}
