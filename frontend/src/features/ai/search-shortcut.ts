/**
 * Ctrl+K (⌘K on a Mac) puts the cursor in the Homeroom bot tab's search
 * field while the tab is on screen (24 Nov 2026: the field is always there,
 * and names the shortcut at its end on a computer: ./lists.tsx, ./index.tsx).
 *
 * ── Only while the tab is showing ─────────────────────────────────────
 *
 * Everywhere else ⌘K is "Your communities" (../workshop/community-shortcut.ts)
 * and it stays so, as it does on Home and Settings, which take it on their
 * own screens the same way (../home/search-shortcut.ts,
 * ../settings/filter-shortcut.ts). This listens on `document` in the bubble
 * phase, which runs before the community shortcut's listener on `window`;
 * when it answers it prevents the default, and that shortcut stands down on
 * `defaultPrevented`. / is Home's, from any screen, and is left to it.
 *
 * ── From a field too, as Settings' does ────────────────────────────────
 *
 * ⌘K is not typed, so it works from a field: beside the list the docked New
 * chat's message box has the cursor at rest, and a shortcut that stood down
 * there would never answer on a computer. Nothing in the shell's message
 * boxes reads ⌘K. It stands down while a dialog, sheet or menu is up, while
 * comment mode (C) is on, for a held key's repeats and mid-composition.
 */

import { dialogShowing } from '../improve/suggest-shortcut';

/** What a screen reader announces for the shortcut, on the field. */
export const BOT_SEARCH_SHORTCUT_KEYS = 'Control+K Meta+K';

/** comment-pin.tsx's host: in the document exactly while comment mode is on. */
const COMMENT_HOST_ID = 'comment-pin-host';

export interface BotSearchKey {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/** Pure: whether the key is Ctrl+K or ⌘K, with no Shift or Alt, pressed once. */
export function isBotSearchKey(e: BotSearchKey | null | undefined): boolean {
  if (!e || e.repeat || e.isComposing || e.defaultPrevented) return false;
  if (e.key !== 'k' && e.key !== 'K') return false;
  return !!(e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
}

/** Pure: 'focus' when the key should go to the tab's field, else null (the key is left alone). */
export function botSearchAnswer(e: BotSearchKey | null | undefined, ctx: {
  showing: boolean; dialog: boolean; commentMode: boolean;
}): 'focus' | null {
  if (!isBotSearchKey(e)) return null;
  if (!ctx.showing || ctx.dialog || ctx.commentMode) return null;
  return 'focus';
}

interface KeyEvent extends BotSearchKey {
  preventDefault: () => void;
}

/**
 * Listen for the key on the shell's document while `field()` answers the
 * tab's own field (null while the tab is hidden). Returns the uninstall.
 */
export function installBotSearchShortcut(field: () => HTMLInputElement | null): () => void {
  const onKey = (e: KeyEvent) => {
    if (!isBotSearchKey(e)) return;
    const el = field();
    const answer = botSearchAnswer(e, {
      showing: !!el && el.getClientRects().length > 0,
      dialog: dialogShowing(document),
      commentMode: !!document.getElementById(COMMENT_HOST_ID),
    });
    if (answer !== 'focus' || !el) return;
    e.preventDefault();
    el.focus();
    try { el.select(); } catch { /* nothing to select */ }
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
