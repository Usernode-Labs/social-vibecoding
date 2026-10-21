/**
 * Comment mode's device setting (#4289 and its follow-ups), kept apart from
 * ../improve/suggest-shortcut.ts so a screen can read it without installing
 * the shortcut's listeners. On by default: "Suggest an improvement" opens
 * comment mode, and its form is one switch away. It used to be an
 * Experimental switch in Settings; that switch is gone.
 *
 * Kept on the DEVICE (localStorage), not the account: a keyboard shortcut
 * and a pointer to comment with belong to the computer in front of the
 * person.
 */

/** Where the setting is kept: `'0'` when a device has turned it off, absent (on) otherwise. */
export const SUGGEST_SHORTCUT_STORAGE_KEY = 'usernode:suggest-shortcut';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Whether this device opens comment mode. On unless it stored `'0'`, and on when storage is unreadable. */
export function suggestShortcutEnabled(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(SUGGEST_SHORTCUT_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setSuggestShortcutEnabled(
  on: boolean,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SUGGEST_SHORTCUT_STORAGE_KEY, on ? '1' : '0');
  } catch { /* private mode: the setting simply does not stick */ }
}
