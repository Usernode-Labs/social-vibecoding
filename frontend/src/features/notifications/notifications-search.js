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
 * What counts as found is the shell's one rule (lib/search-rank.js): inside
 * the text, in any case and with Latin accents set aside, so "cafe" finds a
 * project called Café here as it does on Home.
 */
import { matchesSearch, searchKey } from '../../lib/search-rank.js';

/** Trim, case-fold and set accents aside; whitespace-only becomes ''. */
export function normalizeNotificationQuery(q) {
  return searchKey(q);
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
    return matchesSearch(needle, joined([session.title, session.appName]));
  }
  const view = entry.view || {};
  const parts = [view.appLine, view.label];
  for (const segment of view.segments || []) {
    if (segment && typeof segment.v === 'string') parts.push(segment.v);
  }
  return matchesSearch(needle, joined(parts));
}

/** The texts a row prints, as one line, so a query may span two of them. */
function joined(parts) {
  return parts.filter((part) => typeof part === 'string' && part).join(' ');
}