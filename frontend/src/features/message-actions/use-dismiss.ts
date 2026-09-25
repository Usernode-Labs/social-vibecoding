import { useEffect, useRef, type RefObject } from 'react';

/**
 * Close a popover on a press outside it or on Escape (#2387).
 *
 * Not ../../lib/popover-dismiss's `useAnchoredDismiss`: that one also closes
 * on ANY scroll in the document, which is right for a menu positioned against
 * the viewport and wrong for the emoji picker, whose own grid scrolls. These
 * popovers live inside their row and move with it, so a scroll never strands
 * them.
 */
export function useDismiss(
  open: boolean,
  inside: ReadonlyArray<RefObject<HTMLElement | null>>,
  close: () => void,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const insideRef = useRef(inside);
  insideRef.current = inside;
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: Event) => {
      const target = event.target as Node | null;
      if (target && insideRef.current.some((ref) => ref.current?.contains(target))) return;
      closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
}
