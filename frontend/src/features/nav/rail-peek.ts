/**
 * The rail's peek, shared by every element that can summon it.
 *
 * Moved out of ./tab-bar.tsx when #sidebar-toggle became a second way in
 * (#2764): with the rail folded, pointing at the toggle fades the rail in over
 * the page exactly as pointing at the window's left edge does. The toggle sits
 * in the header's left corner, directly above where the rail appears, so it
 * is where the pointer already is when the reader goes looking for the
 * navigation they folded away.
 *
 * ── Why the grace timer is module state ───────────────────────────────
 *
 * The pointer has to cross a gap to get from whatever summoned the rail onto
 * the rail itself, and on the way back out it crosses the same gap. Un-peeking
 * the moment either element is left makes the rail flicker away under a
 * pointer that is on its way to it, so leaving starts a short delay that
 * entering ANY peek target cancels. With two components involved that
 * delay has to be ONE timer: the toggle's leave and the rail's enter are
 * different components, and a per-component timer would let the toggle's fire
 * after the pointer was already on the rail.
 */
import { navStore } from './nav-store.js';

export const PEEK_GRACE_MS = 280;

let timer: ReturnType<typeof setTimeout> | null = null;

export function clearPeekTimer(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}

/** The pointer is on something that shows the rail: show it now. */
export function enterPeek(): void {
  clearPeekTimer();
  if (!navStore.get().peek) navStore.set({ peek: true });
}

/** The pointer left one: put the rail away unless it arrives at another. */
export function leavePeek(): void {
  clearPeekTimer();
  timer = setTimeout(() => {
    timer = null;
    navStore.set({ peek: false });
  }, PEEK_GRACE_MS);
}
