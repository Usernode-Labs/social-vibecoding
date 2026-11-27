/**
 * One open panel at a time.
 *
 * The shell has four ways to put a panel over the page: the Homeroom menu and
 * Notifications (lib/sheet.ts, standing sheets), the dialogs (features/dialogs/
 * use-dialog.ts), the "Your feedback" card on the You page, and the welcome
 * tour's overlay. Each one closes itself perfectly well; none of them knew
 * about the others, so opening the bell while the menu was up left both on
 * screen, the shared backdrop then covered the menu's own button, and Escape
 * could close two of them at once — or the wrong one (#6981).
 *
 * Each surface claims a slot here when it opens. A claim first takes every
 * other entry out of the list and then runs that surface's own close, so a
 * panel that is still animating out is never closed twice: every surface
 * releases at the START of its close. Escape asks `isTopSurface` before it
 * closes anything.
 *
 * Two pairs are deliberately exempt:
 *
 *   - a dialog does not close another dialog. Dialogs hand off to one another
 *     (App settings to "Who can see & change it"), and that hand-off works as
 *     it did before.
 *   - the menu ('apps-switcher-sheet') and the tour never close each other.
 *     The tour's menu steps open the menu and point at its rows, so one
 *     shutting the other would end the arc midway.
 *
 * The module reads no DOM and imports nothing from `public/js/**`, so it is
 * safe to evaluate in the SSR/prerender pass.
 */

export type SurfaceKind = 'sheet' | 'dialog' | 'profile-card' | 'tour';

interface SurfaceEntry {
  key: string;
  kind: SurfaceKind;
  close: () => void;
}

/** The Homeroom menu's key — the sheet controller claims under its element id. */
const MENU_KEY = 'apps-switcher-sheet';
/** The welcome tour's key. */
const TOUR_KEY = 'tour';

/** Open claims, oldest first; the last entry is the top surface. */
const entries: SurfaceEntry[] = [];

/**
 * Whether a claim should close `other` on its way in.
 *
 * The two exemptions are named on purpose rather than inferred from z-index:
 * they are about the product's own flows, not about stacking order.
 */
function closesOnClaim(kind: SurfaceKind, key: string, other: SurfaceEntry): boolean {
  if (kind === 'dialog' && other.kind === 'dialog') return false;
  if ((key === MENU_KEY && other.kind === 'tour')
    || (kind === 'tour' && other.key === MENU_KEY)) return false;
  return true;
}

/**
 * Claim the one-at-a-time slot for a surface, closing every surface it does
 * not spare through that surface's own close path.
 *
 * Claiming an already-present key replaces its entry and moves it to the top.
 * The returned function releases the claim; it is idempotent, and lives
 * through a close that starts on the surface's own side.
 */
export function claimSurface(key: string, kind: SurfaceKind, close: () => void): () => void {
  // Replace a previous claim under the same key, so a reopened surface moves
  // back to the top instead of appearing twice.
  const previous = entries.findIndex((entry) => entry.key === key);
  if (previous !== -1) entries.splice(previous, 1);

  // Take the entries this claim closes out of the list FIRST, so their own
  // release finds nothing to do and a close that is still animating cannot
  // be asked to close twice.
  const closing = entries.filter((other) => closesOnClaim(kind, key, other));
  for (const other of closing) {
    const at = entries.indexOf(other);
    if (at !== -1) entries.splice(at, 1);
  }

  const entry: SurfaceEntry = { key, kind, close };
  entries.push(entry);

  for (const other of closing) {
    try {
      other.close();
    } catch {
      // One surface's close failing is not a reason to leave the others up.
    }
  }

  return () => {
    const at = entries.indexOf(entry);
    if (at !== -1) entries.splice(at, 1);
  };
}

/**
 * Is `key` the surface Escape should close?
 *
 * The tour's overlay is `z-[9993]`, above the menu's sheet, and the two may be
 * open together during the tour's menu steps. So while a tour entry is in the
 * list the tour is the top surface, even when the menu is the entry that
 * arrived last.
 */
export function isTopSurface(key: string): boolean {
  const last = entries[entries.length - 1];
  if (!last) return false;
  if (last.key === MENU_KEY && entries.some((entry) => entry.kind === 'tour')) {
    return key === TOUR_KEY;
  }
  return last.key === key;
}

/** The open claims' keys, oldest first. For tests and debugging. */
export function openSurfaceKeys(): string[] {
  return entries.map((entry) => entry.key);
}
