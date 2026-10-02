/**
 * KEYBOARD AVOIDANCE FOR A REACT-OWNED COMPOSER (#3571).
 *
 * Every chat screen holds its composer the same way: a flex column whose
 * scroller is `flex-1` with the composer pinned below it as a `shrink-0`
 * sibling, and `.platform-kb-column` reserving the kit's `--un-kb-inset` as
 * the column's bottom padding so the composer sits on the keyboard line.
 *
 * That is only half the job on iOS Safari, which also PANS the page on the
 * tap — before the inset exists — to reveal the field, by as much as the
 * full keyboard height. The column then lifts the composer by the inset
 * *inside a page already moved up by the same amount*, leaving the box near
 * the top edge. The chats that worked were never doing the padding alone:
 * each is mounted by a legacy controller that calls
 * `PlatformUI.attachScreenFx` on its scroller, which attaches the kit's
 * `unNative.attachKeyboardAvoidance`. Its settled pin (`settledPin` in
 * native.js) puts the pan back with `window.scrollTo(0, 0)` once the
 * keyboard's burst of viewport events goes quiet.
 *
 * The Messages conversation and its reply thread are React-owned and mounted
 * by no such controller, so nothing attached the pin and the pan stayed.
 * This module attaches it.
 *
 * The kit gates its reveal paths on `scrollEl.contains(field)`, and the
 * composer is a SIBLING of the scroller, outside it — so no reveal is
 * computed for the composer field. What this attaches for is the pin: the
 * `visualViewport` listeners that run `settledPin` on every settled burst,
 * independent of which field was focused. All kit behaviour is a structural
 * no-op on desktop and without `visualViewport`.
 */

import { useEffect, useRef, type RefObject } from 'react';

interface KitKeyboardAvoidance {
  detach(): void;
}

interface KitLike {
  attachKeyboardAvoidance?: (
    scrollEl: HTMLElement,
    opts?: { topEl?: HTMLElement },
  ) => KitKeyboardAvoidance;
}

type KitGlobal = { unNative?: KitLike };
type DocLike = { getElementById(id: string): HTMLElement | null };

/**
 * Attach the kit's keyboard avoidance to a composer scroller, returning a
 * detach closure.
 *
 * It goes to the kit directly rather than through `PlatformUI.attachScreenFx`,
 * whose one-handle-per-key registry would let a closing copy of a pane detach
 * the copy that just opened (Messages and a page's embedded channel draw the
 * same component). A no-op when there is no element or no kit; a throwing kit
 * is swallowed so one surface cannot break its own unmount. Detach is
 * idempotent.
 */
export function attachComposerKeyboard(
  el: HTMLElement | null | undefined,
  win: KitGlobal | null = typeof window !== 'undefined' ? (window as unknown as KitGlobal) : null,
  doc: DocLike | null = typeof document !== 'undefined' ? (document as unknown as DocLike) : null,
): () => void {
  if (!el) return () => {};
  const un = win?.unNative;
  if (!un || typeof un.attachKeyboardAvoidance !== 'function') return () => {};
  let handle: KitKeyboardAvoidance | null = null;
  try {
    const topEl = doc?.getElementById('platform-header') || undefined;
    handle = un.attachKeyboardAvoidance(el, { topEl });
  } catch {
    return () => {};
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      handle?.detach?.();
    } catch {
      /* one surface must not break its own unmount */
    }
  };
}

/**
 * Attach the composer keyboard seam to whatever element `ref.current` holds,
 * comparing the ref on every commit: a pane that renders its scroller only on
 * some branches attaches the moment it appears, and re-attaches if React
 * hands it a new node. Detaches on unmount.
 */
export function useComposerKeyboard(ref: RefObject<HTMLElement | null>): void {
  const attached = useRef<{ el: HTMLElement; detach: () => void } | null>(null);

  // Every commit (no dependency array): the ref may change without a re-render
  // signal of its own, and a fresh node needs the kit re-attached.
  useEffect(() => {
    const el = ref.current;
    if (attached.current && attached.current.el !== el) {
      attached.current.detach();
      attached.current = null;
    }
    if (!el || attached.current) return;
    attached.current = { el, detach: attachComposerKeyboard(el) };
  });

  useEffect(() => () => {
    if (attached.current) {
      attached.current.detach();
      attached.current = null;
    }
  }, []);
}
