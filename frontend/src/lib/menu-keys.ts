import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

/**
 * Keyboard behaviour for the shell's small React menus (QA 2026-09-24 Q18).
 *
 * The Messages "+", the conversation's ⋯, the Workshop's "Which workshop?"
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
 * What closes a menu on an outside press, a scroll or a resize stays with
 * each caller (./popover-dismiss.ts, message-actions/use-dismiss.ts), because
 * those differ by how the menu is placed. The native kit's own menus
 * (usernode-native `menu()` / `popover()`) already behave this way; this is
 * the same contract for the menus the shell draws itself.
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

/**
 * The menu-button contract for an open/close flag the caller owns.
 *
 * While `open`: focus moves to the first row once the menu has rendered, and
 * the returned `onKeyDown` (put it on the menu's root) handles the arrows,
 * Escape and Tab. `close` is read through a ref, so it may change identity on
 * every render.
 */
export function useMenuKeyboard(
  open: boolean,
  menuRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  close: () => void,
  selector: string = MENU_ITEM_SELECTOR,
): { onKeyDown: (event: ReactKeyboardEvent) => void } {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    focusFirstItem(menuRef.current, selector);
    // Only on the opening edge: a re-render while open must not pull focus
    // back to the first row from wherever the arrows have taken it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'Tab') {
      // No preventDefault: focus goes back to the trigger first, and the
      // browser's Tab then moves on from there.
      closeRef.current();
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    roveMenuFocus(event, menuRef.current, selector);
  };

  return { onKeyDown };
}
