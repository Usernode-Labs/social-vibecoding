/**
 * ⌘K (Ctrl+K off a Mac): search your communities, from anywhere in the
 * signed-in shell (#5290).
 *
 * It opens "Your communities" (./community-switcher.tsx) with its search
 * box focused: a menu in the middle of a wide window, the sheet from the
 * floor on a phone's width. Pressed again while the switcher is open, it
 * closes it, as Escape does.
 *
 * ── Only a ⌘K nobody else used ────────────────────────────────────────
 *
 * Nothing in the shell answered ⌘K or Ctrl+K before this, and the browser
 * keeps its own (Chrome and Firefox put the caret in their search field)
 * wherever this does not answer: the key's default is prevented only when
 * the switcher opens or closes. It does nothing while the person is typing
 * (an input, a textarea, a select, an editable element: the same rule the C
 * shortcut reads, ../improve/suggest-shortcut.ts), while another dialog,
 * sheet or menu is up, when a handler already claimed the key
 * (`defaultPrevented`), with Shift or Alt held (Ctrl+Shift+K is Firefox's
 * console), for a held key's repeats, when nobody is signed in, and in the
 * side panel (`?panel=1`), which is the platform framed beside an app.
 *
 * Inside a running app the app's document has the keyboard, so the key is
 * the app's own there.
 */

import { EMBEDDED_PANEL_CLASS } from '../../lib/side-panel-mode';
import { dialogShowing, isTypingTarget } from '../improve/suggest-shortcut';

/** What a screen reader announces for the shortcut, on the search box. */
export const COMMUNITY_SHORTCUT_KEYS = 'Meta+K Control+K';

export interface ShortcutKey {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/** ⌘K or Ctrl+K: the letter K with Cmd or Ctrl, and no Shift or Alt. Pure. */
export function isCommunityShortcut(e: ShortcutKey | null | undefined): boolean {
  if (!e || (e.key !== 'k' && e.key !== 'K')) return false;
  if (!(e.metaKey || e.ctrlKey)) return false;
  return !(e.altKey || e.shiftKey || e.repeat || e.isComposing);
}

export interface ShortcutContext {
  /** The switcher is open now. */
  switcherOpen: boolean;
  /** The key was pressed in a field (or with focus in one). */
  typing: boolean;
  /** Another dialog, sheet or menu is in front of the person. */
  dialog: boolean;
  signedIn: boolean;
  /** The side panel (`?panel=1`). */
  embedded: boolean;
}

/**
 * What a key does: open the switcher's search, close the switcher, or
 * nothing (null, and the key is left to the browser). Pure.
 */
export function communityShortcutAnswer(e: ShortcutKey | null | undefined, ctx: ShortcutContext): 'open' | 'close' | null {
  if (!isCommunityShortcut(e) || e?.defaultPrevented) return null;
  if (ctx.switcherOpen) return 'close';
  if (!ctx.signedIn || ctx.embedded || ctx.typing || ctx.dialog) return null;
  return 'open';
}

interface KeyEvent extends ShortcutKey {
  target?: unknown;
  composedPath?: () => unknown[];
  preventDefault: () => void;
}

/** The key's real target: inside a shadow root, the node itself. */
function realTarget(e: KeyEvent): unknown {
  try {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.length) return path[0];
  } catch { /* the retargeted target */ }
  return e.target;
}

export interface CommunityShortcutDeps {
  win: { addEventListener(type: string, fn: (e: any) => void): void; removeEventListener(type: string, fn: (e: any) => void): void };
  doc: Parameters<typeof dialogShowing>[0] & { activeElement?: unknown };
  isOpen: () => boolean;
  open: () => void;
  close: () => void;
  signedIn: () => boolean;
}

/** Listen for ⌘K on the shell's window. Returns the uninstall. */
export function installCommunityShortcut(deps: CommunityShortcutDeps): () => void {
  const { win, doc } = deps;
  const onKey = (e: KeyEvent) => {
    if (!isCommunityShortcut(e)) return;
    let embedded = false;
    try { embedded = !!doc.documentElement?.classList?.contains(EMBEDDED_PANEL_CLASS); } catch { /* not the panel */ }
    const switcherOpen = deps.isOpen();
    const answer = communityShortcutAnswer(e, {
      switcherOpen,
      typing: isTypingTarget(realTarget(e)) || isTypingTarget(doc.activeElement),
      // The switcher is a dialog too; it is answered above.
      dialog: !switcherOpen && dialogShowing(doc),
      signedIn: deps.signedIn(),
      embedded,
    });
    if (!answer) return;
    e.preventDefault();
    if (answer === 'open') deps.open();
    else deps.close();
  };
  win.addEventListener('keydown', onKey);
  return () => win.removeEventListener('keydown', onKey);
}
