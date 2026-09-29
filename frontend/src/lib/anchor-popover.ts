/**
 * Where a popover goes when it hangs off the button that opened it.
 *
 * Two surfaces place themselves this way: the dev board's vote popover
 * (features/dev-board/card/dev-card.tsx) and, on desktop, the Homeroom
 * mark's menu (features/app-context/index.tsx, #2784). They used to be one
 * inline copy and one panel centred under the header; the menu moved under
 * its trigger to read like the vote popover, and sharing the arithmetic is
 * what keeps the two reading alike.
 *
 * The shape: right edges aligned, `gap` below the button, clamped `margin`
 * inside the viewport on both sides. With `flip` it goes above the button
 * when there is no room below — right for a card in the middle of a board,
 * wrong for a control in the header, where "above" is off the screen; a
 * menu that does not flip caps its own height instead and scrolls.
 *
 * Pure, so tests/anchor-popover.test.js can pin it without a DOM.
 */

export interface AnchorRect {
  top: number;
  bottom: number;
  right: number;
}

export interface PopoverPlacement {
  top: number;
  left: number;
}

export function placeUnderAnchor(
  rect: AnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  { gap = 6, margin = 8, flip = true }: { gap?: number; margin?: number; flip?: boolean } = {},
): PopoverPlacement {
  const left = Math.min(Math.max(margin, rect.right - size.width), viewport.width - size.width - margin);
  let top = rect.bottom + gap;
  if (flip && top + size.height > viewport.height - margin) {
    top = Math.max(margin, rect.top - size.height - gap);
  }
  return { top: Math.round(top), left: Math.round(left) };
}
