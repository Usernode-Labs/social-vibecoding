/** Device preference only. Basic's presentation will be built in later changes. */
export type InterfaceMode = 'basic' | 'advanced';
export const INTERFACE_MODE_KEY = 'homeroom:interface-mode';
type ModeStorage = Pick<Storage, 'getItem' | 'setItem'>;

function deviceStorage(): ModeStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; }
  catch { return null; }
}

export function readInterfaceMode(storage = deviceStorage()): InterfaceMode {
  try { return storage?.getItem(INTERFACE_MODE_KEY) === 'basic' ? 'basic' : 'advanced'; }
  catch { return 'advanced'; }
}

/** A refused save leaves the current selection intact. */
export function saveInterfaceMode(mode: InterfaceMode, storage = deviceStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(INTERFACE_MODE_KEY, mode);
    // On <html> too, where the page's boot script put it (head.html), so a
    // look that keeps a detail for Advanced follows the switch at once.
    try { if (typeof document !== 'undefined') document.documentElement.setAttribute('data-interface-mode', mode); } catch { /* no document */ }
    return true;
  } catch { return false; }
}
