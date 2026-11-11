/**
 * / on any screen, or Ctrl+K (⌘K) on Home, puts the cursor in Home's search
 * box (#6462).
 *
 * ── Two keys, two scopes ──────────────────────────────────────────────
 *
 * / works from anywhere in the Homeroom window: from another screen it opens
 * Home first, then focuses the field (`Home.focusSearch`). Ctrl+K already
 * means "Your communities" everywhere else (../workshop/community-shortcut.ts)
 * and "Find a setting" on Settings (../settings/filter-shortcut.ts), and both
 * keep it; here it answers only while Home is showing, and / stands down on
 * Settings so "Find a setting" keeps it.
 *
 * This listens on `document` in the bubble phase, beside the Settings
 * listener, which runs before the community shortcut's on `window`; when it
 * answers it prevents the default, and that shortcut stands down on
 * `defaultPrevented`.
 *
 * ── Never in the way of typing ────────────────────────────────────────
 *
 * Neither key does anything while somebody is typing in a field (an input, a
 * textarea, a select, an editable element: the rule the C shortcut reads,
 * ../improve/suggest-shortcut.ts), while a dialog, sheet or menu is up, while
 * comment mode (C) is on, in the side panel (`?panel=1`), for a held key's
 * repeats or mid-composition. Inside an app's frame the app's document has
 * the keyboard, so neither key reaches this listener there.
 */

import { EMBEDDED_PANEL_CLASS } from '../../lib/side-panel-mode';
import { dialogShowing, isTypingTarget } from '../improve/suggest-shortcut';

/** What a screen reader announces for the shortcut, on the search box. */
export const HOME_SEARCH_SHORTCUT_KEYS = 'Control+K Meta+K /';

/** comment-pin.tsx's host: in the document exactly while comment mode is on. */
const COMMENT_HOST_ID = 'comment-pin-host';

export interface HomeSearchShortcutKey {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/**
 * 'k' for K with Ctrl or Cmd and no Shift or Alt; 'slash' for / with no Ctrl,
 * Cmd or Alt (Shift is allowed: some keyboards need it for /). Pure.
 */
export function homeSearchShortcutKind(e: HomeSearchShortcutKey | null | undefined): 'k' | 'slash' | null {
  if (!e || e.repeat || e.isComposing) return null;
  if (e.key === 'k' || e.key === 'K') {
    return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey ? 'k' : null;
  }
  if (e.key === '/') return e.metaKey || e.ctrlKey || e.altKey ? null : 'slash';
  return null;
}

export interface HomeSearchShortcutContext {
  /** The Home screen is showing. */
  homeShowing: boolean;
  /** The Settings screen is showing. */
  settingsShowing: boolean;
  /** A dialog, sheet or menu is in front of the person. */
  dialog: boolean;
  /** Comment mode (C) is on. */
  commentMode: boolean;
  /** The key was pressed in a field (or with focus in one). */
  typing: boolean;
  /** The side panel (`?panel=1`). */
  embedded: boolean;
}

/** 'focus' when the key should go to Home's box, else null (the key is left alone). Pure. */
export function homeSearchShortcutAnswer(
  e: HomeSearchShortcutKey | null | undefined,
  ctx: HomeSearchShortcutContext,
): 'focus' | null {
  const kind = homeSearchShortcutKind(e);
  if (!kind || e?.defaultPrevented) return null;
  if (ctx.dialog || ctx.commentMode || ctx.embedded || ctx.typing) return null;
  if (kind === 'k') return ctx.homeShowing ? 'focus' : null;
  return ctx.settingsShowing ? null : 'focus';
}

interface DocLike {
  activeElement?: unknown;
  documentElement?: { classList?: { contains(name: string): boolean } } | null;
  getElementById(id: string): unknown;
  querySelectorAll(selector: string): ArrayLike<unknown>;
  addEventListener(type: string, fn: (e: any) => void): void;
  removeEventListener(type: string, fn: (e: any) => void): void;
}

interface KeyEvent extends HomeSearchShortcutKey {
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

function screenShowing(doc: DocLike, id: string): boolean {
  const screen = doc.getElementById(id) as { classList?: { contains(name: string): boolean } } | null;
  try {
    return !!screen && !screen.classList?.contains('hidden');
  } catch {
    return false;
  }
}

/** Listen for the keys on the shell's document. Returns the uninstall. */
export function installHomeSearchShortcut({
  doc,
  open,
}: {
  doc: DocLike;
  /** Put the cursor in Home's box; `homeShowing` says whether Home was already up. */
  open: (homeShowing: boolean) => void;
}): () => void {
  const onKey = (e: KeyEvent) => {
    if (!homeSearchShortcutKind(e)) return;
    let embedded = false;
    try {
      embedded = !!doc.documentElement?.classList?.contains(EMBEDDED_PANEL_CLASS);
    } catch { /* no root to ask: not the panel */ }
    const homeShowing = screenShowing(doc, 'home-screen');
    const answer = homeSearchShortcutAnswer(e, {
      homeShowing,
      settingsShowing: screenShowing(doc, 'settings-screen'),
      dialog: dialogShowing(doc),
      commentMode: !!doc.getElementById(COMMENT_HOST_ID),
      typing: isTypingTarget(realTarget(e)) || isTypingTarget(doc.activeElement),
      embedded,
    });
    if (answer !== 'focus') return;
    e.preventDefault();
    open(homeShowing);
  };
  doc.addEventListener('keydown', onKey);
  return () => doc.removeEventListener('keydown', onKey);
}
