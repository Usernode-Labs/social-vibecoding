/**
 * Ctrl+K (⌘K on a Mac) or / puts the cursor in Settings' "Find a setting"
 * box and selects what is in it (#5996).
 *
 * ── Only while Settings is on screen ──────────────────────────────────
 *
 * Everywhere else ⌘K is "Your communities" (../workshop/community-shortcut.ts),
 * and it stays so. This listens on `document` in the bubble phase, which runs
 * after any element's own handler (so `defaultPrevented` is real) and BEFORE
 * the community shortcut's listener on `window`; when it answers it prevents
 * the default, and the community shortcut stands down on `defaultPrevented`.
 * When Your communities is already open it is a dialog, so this stands down
 * and ⌘K still closes it.
 *
 * ── Never while somebody is typing ────────────────────────────────────
 *
 * / is a character people type, so it never fires from a field (an input, a
 * textarea, a select, an editable element: the rule the C shortcut reads,
 * ../improve/suggest-shortcut.ts). ⌘K is not typed, so it works from another
 * settings field too. Neither fires while a dialog or sheet is up, while
 * comment mode (C) is on, for a held key's repeats or mid-composition. Inside
 * a running app the app's document has the keyboard, so neither key reaches
 * this listener there.
 */

import { dialogShowing, isTypingTarget } from '../improve/suggest-shortcut';

/** What a screen reader announces for the shortcut, on the search box. */
export const FILTER_SHORTCUT_KEYS = 'Control+K Meta+K /';

/** comment-pin.tsx's host: in the document exactly while comment mode is on. */
const COMMENT_HOST_ID = 'comment-pin-host';

export interface FilterShortcutKey {
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
export function filterShortcutKind(e: FilterShortcutKey | null | undefined): 'k' | 'slash' | null {
  if (!e || e.repeat || e.isComposing) return null;
  if (e.key === 'k' || e.key === 'K') {
    return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey ? 'k' : null;
  }
  if (e.key === '/') return e.metaKey || e.ctrlKey || e.altKey ? null : 'slash';
  return null;
}

export interface FilterShortcutContext {
  /** The Settings screen is showing. */
  settingsShowing: boolean;
  /** A "Find a setting" box is on screen. */
  hasField: boolean;
  /** A dialog, sheet or menu is in front of the person. */
  dialog: boolean;
  /** Comment mode (C) is on. */
  commentMode: boolean;
  /** The key was pressed in a field (or with focus in one). */
  typing: boolean;
}

/** 'focus' when the key should go to the box, else null (the key is left alone). Pure. */
export function filterShortcutAnswer(e: FilterShortcutKey | null | undefined, ctx: FilterShortcutContext): 'focus' | null {
  const kind = filterShortcutKind(e);
  if (!kind || e?.defaultPrevented) return null;
  if (!ctx.settingsShowing || !ctx.hasField || ctx.dialog || ctx.commentMode) return null;
  if (kind === 'slash' && ctx.typing) return null;
  return 'focus';
}

interface FieldLike {
  focus: () => void;
  select?: () => void;
  getClientRects?: () => { length: number };
}

interface DocLike {
  activeElement?: unknown;
  documentElement?: { classList?: { contains(name: string): boolean } } | null;
  getElementById(id: string): unknown;
  querySelectorAll(selector: string): ArrayLike<unknown>;
  addEventListener(type: string, fn: (e: any) => void): void;
  removeEventListener(type: string, fn: (e: any) => void): void;
}

interface KeyEvent extends FilterShortcutKey {
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

function laidOut(el: FieldLike | null): boolean {
  try {
    return !!el && typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
  } catch {
    return false;
  }
}

/** The box on screen: the sidebar's on a wide window, the phone menu's on a narrow one. */
function visibleField(doc: DocLike): FieldLike | null {
  for (const id of ['settings-filter-desktop', 'settings-filter-mobile']) {
    const el = doc.getElementById(id) as FieldLike | null;
    if (laidOut(el)) return el;
  }
  return null;
}

function settingsShowing(doc: DocLike): boolean {
  const screen = doc.getElementById('settings-screen') as { classList?: { contains(name: string): boolean } } | null;
  try {
    return !!screen && !screen.classList?.contains('hidden');
  } catch {
    return false;
  }
}

/** Listen for the keys on the shell's document. Returns the uninstall. */
export function installFilterShortcut({ doc }: { doc: DocLike }): () => void {
  const onKey = (e: KeyEvent) => {
    if (!filterShortcutKind(e)) return;
    const field = visibleField(doc);
    const answer = filterShortcutAnswer(e, {
      settingsShowing: settingsShowing(doc),
      hasField: !!field,
      dialog: dialogShowing(doc),
      commentMode: !!doc.getElementById(COMMENT_HOST_ID),
      typing: isTypingTarget(realTarget(e)) || isTypingTarget(doc.activeElement),
    });
    if (answer !== 'focus' || !field) return;
    e.preventDefault();
    field.focus();
    try { field.select?.(); } catch { /* nothing to select */ }
  };
  doc.addEventListener('keydown', onKey);
  return () => doc.removeEventListener('keydown', onKey);
}
