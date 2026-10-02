/**
 * Per-viewer "which apps did I open last", for the header chip's app strip.
 *
 * ── Why this is localStorage and not a column ──────────────────────────
 *
 * The server now records exact `events.dapp_opened` timestamps (see
 * ./app-openings.ts), but this strip deliberately keeps answering a different
 * question: which apps this person reaches for on THIS device.
 *
 *   - `app_activity` (src/db/schema.sql) is UNIQUE(app_id, user_id, date) with
 *     a DATE, not a timestamp. It cannot rank two apps opened the same day,
 *     which is exactly the case the strip has to get right.
 *   - `events.dapp_opened` is durable cross-device analytics history. Using it
 *     here would merge phone and laptop habits and add a hot-path server join
 *     to a device shortcut.
 *
 * "Which apps do I reach for on THIS device" is genuinely local — the ordering
 * people want on a phone is not the one they want on a laptop — so the
 * device-scoped store remains the more faithful answer.
 *
 * ── The read is deliberately post-mount ────────────────────────────────
 *
 * Nothing here may be called during an initial render. The prerendered shell
 * (frontend/scripts/build-shell.mjs) ships the strip empty and the sheet only
 * fetches its apps on first open, so every caller is already past hydration —
 * but a localStorage read during a first render is a hydration mismatch, and a
 * console error on any route fails proposal checks. Keep it that way.
 */

import { isEmbeddedPanel } from '../../lib/side-panel-mode';

const KEY = 'usernode_app_mru_v1';

// Long enough that a heavy account's strip is fully ordered, short enough that
// the entry never becomes a place slugs go to die. Apps beyond this fall back
// to the server's ordering, which is the same thing that happens to an app the
// viewer has never opened.
const CAP = 50;

/** The stored slug list, most recent first. Never throws. */
function read(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && !!s);
  } catch {
    // Private mode, disabled site data, a corrupt entry: an unordered strip is
    // the pre-existing behaviour, so there is nothing to report.
    return [];
  }
}

/**
 * Record that the viewer is now in `slug`.
 *
 * Called from the sheet on every change of the open app rather than from the
 * tile's click handler, so it counts every way into an app — a home tile, a
 * /app/<slug> deep link, a notification tap — not just the two entries that
 * happen to go through this menu.
 */
export function recordAppUse(slug: string): void {
  // Not from the side panel's document (`?panel=1`): showing an app's Workshop
  // beside another app is not opening it, and this list is the TOP window's
  // record of which apps this device opens.
  if (!slug || isEmbeddedPanel()) return;
  try {
    const next = [slug, ...read().filter((s) => s !== slug)].slice(0, CAP);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A strip that does not reorder is strictly better than a throw here.
  }
}

/**
 * Reorder `apps` most-recently-used first, keeping the caller's order for
 * everything the viewer has not opened on this device.
 *
 * The incoming order is Home.partitionApps()'s — manual favourites first, then
 * the server's 7-day activity ranking, with the newest-created app hoisted.
 * That stays the tail-end answer: recency only speaks for apps it actually
 * knows about, so a fresh device's strip looks exactly as it does today and
 * earns its ordering as the viewer uses it.
 */
export function sortByRecency<T extends { slug?: string }>(apps: T[]): T[] {
  const order = read();
  if (!order.length) return apps;
  const rank = new Map(order.map((slug, i) => [slug, i]));
  // Index-carrying decorate/sort/undecorate: Array#sort is stable in every
  // engine this ships to, but the fallback comparison has to be the original
  // position or two never-opened apps would compare equal to each other AND to
  // their neighbours, which is how a "stable" sort still shuffles in practice.
  return apps
    .map((app, i) => ({ app, i, r: rank.get(app.slug || '') ?? Infinity }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map((entry) => entry.app);
}
