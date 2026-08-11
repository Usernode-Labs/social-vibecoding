/**
 * The Dev session sub-view's outer shell, converted from
 * `AppView.renderDevView()`'s `sessions` branch (#1084 chunk G).
 *
 * Two nested divs and nothing else: `#dev-section` is the mount point
 * `AppView._devContainer()` resolves to, and `AppView.renderDevChatTab(ref)`
 * writes the whole session UI into it. So React owns the shell and never looks
 * inside the host — the same split as ./board-frame.tsx's `#dev-body`, with the
 * simplification that this host ships EMPTY, so it needs no constant
 * `dangerouslySetInnerHTML` to keep React out of it.
 *
 * The inline `overflow:hidden` is preserved as a style prop rather than folded
 * into a utility class: the conversion is like-for-like, and `style` is what the
 * template emitted.
 */

export function DevSessionShell() {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        id="dev-section"
        className="flex-1 min-h-0 flex flex-col"
        style={{ overflow: 'hidden' }}
      ></div>
    </div>
  );
}
