import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Keyboard behaviour for the shell's small React menus (QA 2026-09-24 Q18).
 *
 * The Messages "+", the conversation's ⋯, the Workshop's "Which project?"
 * panel and the Homeroom menu each opened fine from the keyboard and then
 * left focus on the button that opened them, so the rows were a Tab-hunt
 * away (or, for a menu portalled to the end of <body>, past the whole page).
 * This is the menu-button pattern, once:
 *
 *   - opening moves focus to the first row;
 *   - ArrowDown / ArrowUp move between rows and wrap, Home / End jump;
 *   - Escape closes and puts focus back on the trigger;
 *   - Tab closes too, from the trigger, so the browser's own Tab carries on
 *     from where the menu hangs rather than from the end of the document.
 *
 * These are the pieces; the Menu (./menu.ts `useMenu`) puts them together
 * with what closes a menu (an outside press, Escape, Back, a scroll or a
 * resize) for every menu the shell draws itself. The hook that paired the
 * keys with a caller's own dismissal (`useMenuKeyboard`) went when its last
 * callers, Messages' menus, moved onto the Menu. The native kit's own menus
 * (usernode-native `menu()` / `popover()`) already behave this way.
 */

/** Rows a menu offers: its menu items, or any button/link when it has none. */
export const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])';

function isShown(el: HTMLElement): boolean {
  return el.getClientRects().length > 0;
}

/** The enabled, rendered rows of `root`, in document order. */
export function menuItems(root: HTMLElement | null, selector: string = MENU_ITEM_SELECTOR): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(isShown);
}

/** Focus the first row of `root`. Returns whether anything took focus. */
export function focusFirstItem(root: HTMLElement | null, selector: string = MENU_ITEM_SELECTOR): boolean {
  const first = menuItems(root, selector)[0];
  if (!first) return false;
  first.focus({ preventScroll: true });
  return document.activeElement === first;
}

/**
 * Arrow keys, Home and End between the rows of `root`. Returns true when the
 * key was a navigation key and was handled (its default is then prevented).
 */
export function roveMenuFocus(
  event: KeyboardEvent | ReactKeyboardEvent,
  root: HTMLElement | null,
  selector: string = MENU_ITEM_SELECTOR,
): boolean {
  const { key } = event;
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return false;
  const items = menuItems(root, selector);
  if (!items.length) return false;
  const idx = items.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement;
  if (key === 'Home') next = items[0];
  else if (key === 'End') next = items[items.length - 1];
  else if (key === 'ArrowDown') next = items[idx < 0 ? 0 : (idx + 1) % items.length];
  else next = items[idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length];
  event.preventDefault();
  next.focus({ preventScroll: true });
  return true;
}
