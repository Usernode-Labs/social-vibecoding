/**
 * THE MENU: one way for a small panel to hang off what opened it.
 *
 * The shell's React menus each wrote their own: a capture-phase pointerdown
 * that closed on a press outside, a keydown for Escape (some in the capture
 * phase so a column's own Escape did not take the column down with them,
 * some not), a focus on open, sometimes focus back to the opener, and none of
 * them answered the device's Back. The pieces they had in common were already
 * here: where a panel goes (./anchor-popover.ts), what makes it go away
 * (./popover-dismiss.ts) and the menu-button keys (./menu-keys.ts). `useMenu`
 * is those pieces, put together once, with what was missing added:
 *
 *   - a press outside closes it, as ./popover-dismiss.ts decides: the press
 *     must begin and end outside, a finger's width from the edge is inside,
 *     and `inside` adds an opener that toggles on its own. `move` closes it
 *     on a resize or a scroll that moved its trigger, for a menu placed from a
 *     rect it does not follow;
 *   - Escape closes it, in the capture phase and stopped there, so a sheet or
 *     a column under it keeps its own Escape; its panel is marked
 *     `data-owns-escape` (put `panelProps` on it), so the native kit's modal
 *     Escape stands aside while it is up, as it does for an overlay;
 *   - the device's Back closes it (./back-stack.ts), handed back as a
 *     navigating release, so a row that opens a page is never undone;
 *   - focus moves in when it opens (`initialFocus`, else the first row) and
 *     comes back to the trigger when it closes, unless something else took
 *     it on the way (a field pressed outside it);
 *   - with `keys: 'menu'`, the menu-button keys: the arrows, Home and End
 *     between rows, and Tab closes it from the trigger (./menu-keys.ts). A
 *     panel with a search in it (`keys: 'panel'`) keeps Tab and its own
 *     arrows.
 *
 * Where it goes stays each caller's, because that differs by what it hangs
 * from (a chip near the foot of the window, the header's name, the middle of
 * the window for ⌘K).
 */

import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

import { pushDismissible } from './back-stack';
import { MENU_ITEM_SELECTOR, focusFirstItem, roveMenuFocus } from './menu-keys';
import { useAnchoredDismiss } from './popover-dismiss';

export interface MenuOptions {
  /**
   * What opened it: a press on it is not outside, and focus comes back to it.
   * Without one, focus goes back to whatever had it when the menu opened.
   */
  trigger?: RefObject<HTMLElement | null> | null;
  /** The menu itself. */
  panel: RefObject<HTMLElement | null>;
  /** Every way out ends here. It must close the menu. */
  onClose: () => void;
  /** More of the page that counts as inside: an opener elsewhere that toggles it. */
  inside?: (target: Element) => boolean;
  /** Where focus goes on open. Default: the first row. */
  initialFocus?: (panel: HTMLElement) => HTMLElement | null | undefined;
  /** Close on a resize, or a scroll that moved the trigger (default false). */
  move?: boolean;
  /** 'menu' (default): rows rove on the arrows and Tab closes. 'panel': neither. */
  keys?: 'menu' | 'panel';
  /** The rows the arrows move between, for `keys: 'menu'`. */
  rows?: string;
}

export interface MenuResult {
  /** Spread on the menu's root: the keys, and the mark the kit's Escape reads. */
  panelProps: {
    onKeyDown: (event: ReactKeyboardEvent) => void;
    'data-owns-escape': '';
  };
}

const NO_TRIGGER: RefObject<HTMLElement | null> = { current: null };

/** Whether nothing in particular has focus: a press on the page drops it on <body>. */
function focusLost(active: Element | null): boolean {
  return !active || active === document.body || active === document.documentElement;
}

/**
 * Hang a menu off its trigger while `open`. See the header for everything it
 * owns; the caller keeps the open flag, the rows and where the panel goes.
 */
export function useMenu(open: boolean, options: MenuOptions): MenuResult {
  const opts = useRef(options);
  opts.current = options;
  const trigger = options.trigger || NO_TRIGGER;
  const close = useMemo(() => () => opts.current.onClose(), []);

  // A press outside, and (with `move`) the page moving under it.
  useAnchoredDismiss(open, [trigger, options.panel], close, {
    escape: false,
    move: !!options.move,
    also: (target) => !!opts.current.inside?.(target),
  });

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement as HTMLElement | null;
    const focusIn = (): boolean => {
      const { panel, initialFocus, keys = 'menu', rows = MENU_ITEM_SELECTOR } = opts.current;
      const el = panel.current;
      if (!el) return false;
      const target = initialFocus?.(el);
      if (target) target.focus({ preventScroll: true });
      else if (keys === 'menu') focusFirstItem(el, rows);
      return true;
    };
    // A menu placed from a measurement renders a frame after it opens.
    const frame = focusIn() ? 0 : requestAnimationFrame(() => { focusIn(); });

    // Escape, before anything under it hears the key.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKey, true);

    // The device's Back closes it; closed any other way, the claim goes back.
    let backed = false;
    const release = pushDismissible(() => {
      backed = true;
      close();
      return true;
    });

    const el = opts.current.panel.current;
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey, true);
      if (!backed) release({ navigating: true });
      // Back to the trigger, unless focus went somewhere on purpose.
      const active = document.activeElement;
      const back = opts.current.trigger?.current || (focusLost(opener) ? null : opener);
      const panelEl = el || opts.current.panel.current;
      if (back && back.isConnected && (focusLost(active) || !!panelEl?.contains(active))) {
        back.focus({ preventScroll: true });
      }
    };
  }, [open, close]);

  const panelProps = useMemo(() => ({
    onKeyDown: (event: ReactKeyboardEvent) => {
      const { keys = 'menu', panel, rows = MENU_ITEM_SELECTOR } = opts.current;
      if (keys !== 'menu') return;
      if (event.key === 'Tab') {
        // No preventDefault: focus goes back to the trigger as it closes, and
        // the browser's Tab then moves on from there.
        close();
        opts.current.trigger?.current?.focus({ preventScroll: true });
        return;
      }
      roveMenuFocus(event, panel.current, rows);
    },
    'data-owns-escape': '' as const,
  }), [close]);

  return { panelProps };
}
