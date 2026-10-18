/**
 * Client-side search for the notifications sheet (#5405).
 *
 * The sheet already fetches and partitions every row it shows, so a query
 * narrows what is IN HAND — no server call, no second copy of the list. A
 * notif entry matches on the three things a row is read by (where it came
 from, what kind it is, its subject); a session entry on its title and
 * project. It deliberately does NOT match the time or the "by @someone"
 * attribution on the meta line: a person is found when they are the
 * subject, as they are on a message notification.
 *
 * Import-free, like the rest of this directory's logic modules — the tests
 * extract the two functions from this source and run them against stubs, so
 * they cannot drift from what the sheet actually calls.
 */

/** Trim and case-fold what was typed; whitespace-only becomes ''. */
export function normalizeNotificationQuery(q) {
  return String(q == null ? '' : q).trim().toLowerCase();
}

/**
 * Does one sheet entry match the (already normalized) query?
 *
 * `entry` is a MessagesEntry from notifications-sheet.tsx: a `notif` slot
 * carrying the row's `view` (its `appLine`, `label` and `segments` are what
 * the row prints) or a `session` slot carrying the SessionRowView.
 */
export function matchesNotificationQuery(entry, needle) {
  if (!needle) return true;
  if (!entry) return false;
  if (entry.type === 'session') {
    const session = entry.session || {};
    const haystack = [session.title, session.appName]
      .filter((part) => typeof part === 'string' && part)
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  }
  const view = entry.view || {};
  const parts = [view.appLine, view.label];
  for (const segment of view.segments || []) {
    if (segment && typeof segment.v === 'string') parts.push(segment.v);
  }
  const haystack = parts
    .filter((part) => typeof part === 'string' && part)
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}