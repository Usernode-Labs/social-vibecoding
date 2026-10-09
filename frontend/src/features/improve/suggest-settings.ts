/**
 * The experimental switch for comment mode (#4289 and its follow-ups),
 * Settings, Experimental's "Press C to comment on the page", kept apart from
 * ../improve/suggest-shortcut.ts so a screen can read it without installing
 * the shortcut's listeners. Off by default. While it is on, "Suggest an
 * improvement" opens comment mode, and its form is one switch away.
 *
 * Kept on the DEVICE (localStorage), not the account: a keyboard shortcut
 * and a pointer to comment with belong to the computer in front of the
 * person.
 */

/** Where the switch is kept: `'1'` when on, absent when off (the default). */
export const SUGGEST_SHORTCUT_STORAGE_KEY = 'usernode:suggest-shortcut';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Whether this device has the shortcut turned on. Off when storage is unreadable. */
export function suggestShortcutEnabled(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return !!storage && storage.getItem(SUGGEST_SHORTCUT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSuggestShortcutEnabled(
  on: boolean,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    if (on) storage.setItem(SUGGEST_SHORTCUT_STORAGE_KEY, '1');
    else storage.removeItem(SUGGEST_SHORTCUT_STORAGE_KEY);
  } catch { /* private mode: the switch simply does not stick */ }
}
