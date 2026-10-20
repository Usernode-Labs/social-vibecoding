/**
 * The device setting for comment mode (#4289 and its follow-ups): on by
 * default, and kept per device. It used to be Settings, Experimental's
 * "Comment on the page" switch; comment mode is how "Suggest an improvement"
 * opens now, so the switch is gone and only a device that turned it off says
 * so. Kept apart from ../improve/suggest-shortcut.ts so a screen can read it
 * without installing the shortcut's listeners. While it is on, "Suggest an
 * improvement" opens comment mode, and its form is one switch away.
 *
 * Kept on the DEVICE (localStorage), not the account: a keyboard shortcut
 * and a pointer to comment with belong to the computer in front of the
 * person.
 */

/** Where the setting is kept: `'0'` when this device turned it off; absent (the default) is on. */
export const SUGGEST_SHORTCUT_STORAGE_KEY = 'usernode:suggest-shortcut';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Whether comment mode is on for this device. On unless this device stored `'0'`; on when storage is unreadable. */
export function suggestShortcutEnabled(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return !storage || storage.getItem(SUGGEST_SHORTCUT_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Stores the choice: `'1'` for on, `'0'` for off. */
export function setSuggestShortcutEnabled(
  on: boolean,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SUGGEST_SHORTCUT_STORAGE_KEY, on ? '1' : '0');
  } catch { /* private mode: the setting simply does not stick */ }
}
