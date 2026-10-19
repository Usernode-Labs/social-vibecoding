/*
 * THE HOMEROOM BOT'S CHAT OPENS AT ITS FINAL SHAPE (iPhone app and desktop,
 * 19 October 2026). Opening it drew about six layouts in 350 ms:
 *
 *   1. the first page, before the bot's tray had answered: nothing could
 *      count as settled, so every request was a two-line row with a letter
 *      for its project's tile (./bot-news-line.tsx, `newsStatusOf` and
 *      `newsIcon` with no tray);
 *   2. the tray landing: the settled rows folded into "N finished", which
 *      left the screen nearly empty;
 *   3. and so the transcript read older pages in, one after another, until
 *      the screen filled (`needsMoreHistory`). Each page added days above,
 *      changed the counts of the oldest day drawn (a day split across two
 *      pages), and pushed the newest row down the screen.
 *
 * So the bot's chat keeps its spinner up until it can draw what it will
 * stay as: its tray has answered (or failed), and the screen is full or
 * there is nothing older to read. Its rows are laid out underneath all the
 * while, hidden, because "is the screen full" is a measurement of them.
 * Once shown, it is never hidden again: scrolling up for older pages, a
 * refresh, a new message all draw in place as before.
 *
 * And never for longer than OPEN_HOLD_MS. A tray or a page that does not
 * answer shows the transcript as it stands, as every other chat would.
 */

/** The longest the bot's chat waits to draw its final shape. */
export const OPEN_HOLD_MS = 2500;

export interface OpenHold {
  /** The bot's tray has answered, or its read failed. */
  trayRead: boolean;
  /** There is an older page to read. */
  hasOlder: boolean;
  /** An older page is being read now. */
  loadingOlder: boolean;
  /** Reading an older page failed: no more will be read without a tap. */
  olderFailed: boolean;
  /** What is drawn is shorter than the scroller (stick-to-bottom.ts `needsMoreHistory`). */
  short: boolean;
  /** OPEN_HOLD_MS has passed since the first page was drawn. */
  expired: boolean;
}

/** Pure: whether the bot's chat, opening, can be shown now. */
export function openHoldDone(hold: OpenHold): boolean {
  if (hold.expired) return true;
  if (!hold.trayRead) return false;
  if (hold.loadingOlder) return false;
  return !hold.hasOlder || hold.olderFailed || !hold.short;
}
