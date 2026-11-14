/**
 * Where the More projects menu sits on a wide window (./project-picker.tsx):
 * 8px under the More chip, and inside the window on both sides.
 *
 * Its right edge lines up with the chip's when there is room. When the list
 * column is narrow the chip's right edge is less than the menu's width from
 * the window's left edge, so the menu slides right until it is 8px in,
 * rather than running off screen as it did (#6675). A window narrower than
 * the menu narrows it, as New chat's project menu does
 * (features/messages/project-picker.tsx).
 *
 * Pure: no React, no DOM, so tests/ai-screen.test.js loads it with loadTsx.
 */

export interface PickerMenuBox {
  top: number;
  left: number;
  width: number;
}

export const PICKER_MENU_WIDTH = 360;
/** The gap from either window edge, as every menu on the shell keeps. */
export const PICKER_MENU_GAP = 8;

export function pickerMenuBox(
  anchor: { right: number; bottom: number },
  viewportWidth: number,
): PickerMenuBox {
  const width = Math.min(PICKER_MENU_WIDTH, viewportWidth - PICKER_MENU_GAP * 2);
  const left = Math.round(Math.max(
    PICKER_MENU_GAP,
    Math.min(anchor.right - width, viewportWidth - width - PICKER_MENU_GAP),
  ));
  return { top: Math.round(anchor.bottom + PICKER_MENU_GAP), left, width };
}
