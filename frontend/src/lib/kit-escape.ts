/**
 * Whether Escape should close a sheet the kit presents as a bottom sheet
 * (#5927 item 10). It was the Homeroom menu's alone; ./sheet.ts asks it for
 * every sheet the kit holds, the menu and Notifications among them.
 *
 * On a touch platform (a phone, or a tablet with a keyboard) such a sheet is
 * adopted into the kit's `presentSheet`, and that sheet answers a swipe and a
 * tap on its backdrop but not Escape: unlike a kit modal or panel it never
 * joins the kit's modal stack. So Escape is the Sheet's to handle there as
 * well, with three things standing it down:
 *
 *   - the key was already taken. A kit modal or alert opened above the sheet
 *     dismisses itself in the capture phase and calls preventDefault, and a
 *     kit popover stops the event outright;
 *   - an overlay marked `data-owns-escape` is open, the kit's own opt-out;
 *   - another kit surface is drawn above the sheet. A modal, an alert and a
 *     popover always are (native.css stacks them at 9992, the sheet at
 *     9991), whenever they opened, and that covers a non-dismissible alert,
 *     which takes the key without preventing it. A sheet, a panel and an
 *     action sheet share the sheet's layer, so there document order decides:
 *     the kit appends each to the body as it opens, and the last one must
 *     be the one holding this sheet.
 */

/** The kit's surfaces stacked above every sheet (z-index 9992). */
const KIT_ABOVE = '.un-modal, .un-alert, .un-popover';
/** The kit's surfaces on the sheet's own layer (9991), this one's included. */
const KIT_LEVEL = '.un-sheet, .un-panel, .un-action-sheet';

export function kitSheetTakesEscape(event: KeyboardEvent, doc: Document, panel: Element | null): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  if (doc.querySelector('[data-owns-escape]') || doc.querySelector(KIT_ABOVE)) return false;
  const level = doc.querySelectorAll(KIT_LEVEL);
  const top = level[level.length - 1];
  return !!top && !!panel && top.contains(panel);
}
