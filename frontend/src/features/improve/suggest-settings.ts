/**
 * What this device remembers about suggesting an improvement (#4289 and its
 * follow-ups), kept apart from ../improve/suggest-shortcut.ts so a screen can
 * read it without installing the shortcut's listeners.
 *
 *   - The experimental switch, Settings, Experimental's "Press C to comment
 *     on the page". Off by default.
 *   - Which way the person suggested last: comment mode (a pin on the page)
 *     or the detailed form. "Suggest an improvement" opens that one next
 *     time, while the switch is on. The form until they have used comment
 *     mode.
 *
 * Both are kept on the DEVICE (localStorage), not the account: a keyboard
 * shortcut and a pointer to comment with belong to the computer in front of
 * the person.
 */

/** Where the switch is kept: `'1'` when on, absent when off (the default). */
export const SUGGEST_SHORTCUT_STORAGE_KEY = 'usernode:suggest-shortcut';

/** Where the last way of suggesting is kept: `'comment'`, or absent for the form. */
export const SUGGEST_MODE_STORAGE_KEY = 'usernode:suggest-mode';

export type SuggestMode = 'comment' | 'form';

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

/** The way this device suggested last. The form when nothing says otherwise. */
export function suggestMode(storage: StorageLike | null = defaultStorage()): SuggestMode {
  try {
    return !!storage && storage.getItem(SUGGEST_MODE_STORAGE_KEY) === 'comment' ? 'comment' : 'form';
  } catch {
    return 'form';
  }
}

export function setSuggestMode(mode: SuggestMode, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    if (mode === 'comment') storage.setItem(SUGGEST_MODE_STORAGE_KEY, 'comment');
    else storage.removeItem(SUGGEST_MODE_STORAGE_KEY);
  } catch { /* private mode: the form stays the default */ }
}
