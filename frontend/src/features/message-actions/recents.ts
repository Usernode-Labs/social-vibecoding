import { useSyncExternalStore } from 'react';

/**
 * The reactions this device reaches for (#2387).
 *
 * The hover bar leads with the first THREE; the picker's "Recently used" row
 * shows up to eight. Stored per device in localStorage, like the composer's
 * drafts: which emoji someone uses is a habit of the hand on this keyboard,
 * not account state worth a table.
 *
 * ── Only the picker writes it ─────────────────────────────────────────
 *
 * A pick from the full picker moves that emoji to the front. A tap on one of
 * the bar's three does NOT: reordering the bar under the pointer that just
 * used it would move the next emoji out from under a second tap.
 *
 * ── Rendered after mount only ─────────────────────────────────────────
 *
 * The bar exists only once a row is hovered or pressed, so it never renders
 * into the prerendered shell — reading storage here cannot cause a hydration
 * mismatch. The server snapshot is the defaults all the same, so a caller
 * that does render early gets the markup the prerender would have.
 */

export const DEFAULT_RECENTS: readonly string[] = ['👍', '❤️', '🙏'];
const KEY = 'usernode:recent-reactions';
const KEEP = 16;

type Listener = () => void;
const listeners = new Set<Listener>();
let current: readonly string[] | null = null;

function load(): readonly string[] {
  if (current) return current;
  let stored: unknown = null;
  try { stored = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { stored = null; }
  const list = Array.isArray(stored)
    ? stored.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 16)
    : [];
  current = withDefaults(list);
  return current;
}

/** The stored list, topped up from the defaults so the bar always has three. */
function withDefaults(list: readonly string[]): readonly string[] {
  const out = [...new Set(list)].slice(0, KEEP);
  for (const emoji of DEFAULT_RECENTS) {
    if (out.length >= 3) break;
    if (!out.includes(emoji)) out.push(emoji);
  }
  return out;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function serverSnapshot(): readonly string[] {
  return DEFAULT_RECENTS;
}

/** Every recent reaction, most recent first (at least three). */
export function useRecentReactions(): readonly string[] {
  return useSyncExternalStore(subscribe, load, serverSnapshot);
}

/** A pick from the picker: that emoji goes to the front. */
export function rememberReaction(emoji: string): void {
  if (!emoji) return;
  const next = withDefaults([emoji, ...load().filter((item) => item !== emoji)]);
  current = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  for (const listener of [...listeners]) listener();
}

/** For tests: forget what was loaded, so the next read goes to storage. */
export function resetRecentReactionsForTest(): void {
  current = null;
}
