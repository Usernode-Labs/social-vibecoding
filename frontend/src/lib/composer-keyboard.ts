// The kit's keyboard avoidance, attached to one React-owned composer pane.
//
// The two Messages panes (an open conversation and an open reply thread) are
// React-owned and have no legacy screen controller, so nothing calls
// PlatformUI.attachScreenFx for them. `platform-kb-column` reserves the
// keyboard inset on the column, but on iOS Safari that reservation alone
// DOUBLE-COUNTS the keyboard: Safari has already panned the page up
// (visualViewport.offsetTop), and the column then lifts the box again by the
// published inset. The box lands near the top of the visible strip.
//
// `attachKeyboardAvoidance`'s settled pin cancels that pan with
// window.scrollTo(0, 0), but only while the document is the fixed shell — the
// same pin the group chat, the topic thread and the dev chat already get
// through attachScreenFx. It also adds `un-kb-avoid` to the scroller, which
// the existing `html.un-kb .platform-kb-column .un-kb-avoid` rule neutralises
// so the inset is still reserved exactly once, on the column.
//
// Attaching the kit DIRECTLY, rather than through PlatformUI.attachScreenFx,
// is deliberate: attachScreenFx keys its handles in one global map by string,
// and an app's discussion hosted in Messages already has an entry there
// through the group chat. A second attach under the same key would detach
// that pane's listeners. A direct attach gives each Messages pane its own
// handle and leaves the legacy surfaces alone.

import { useEffect, useRef } from 'react';

/** What the kit returns; only `detach` is ever called. */
export interface ComposerKeyboardHandle {
  detach?: () => void;
}

interface KeyboardKit {
  attachKeyboardAvoidance?: (
    el: Element,
    options: { topEl?: Element },
  ) => ComposerKeyboardHandle;
}

/** The ref shape both panes' `useRef` gives us. */
interface ElementRef {
  readonly current: HTMLElement | null;
}

/**
 * Attach the kit's keyboard avoidance to a composer pane's scroller.
 * Returns the kit's handle, or undefined when there is no element, no kit, or
 * no `attachKeyboardAvoidance`.
 */
export function attachComposerKeyboard(el: Element | null): ComposerKeyboardHandle | undefined {
  if (!el) return undefined;
  const kit = (window as Window & { unNative?: KeyboardKit }).unNative;
  if (!kit || typeof kit.attachKeyboardAvoidance !== 'function') return undefined;
  return kit.attachKeyboardAvoidance(el, {
    topEl: document.getElementById('platform-header') || undefined,
  });
}

/**
 * Keep the kit attached to whatever element `ref` currently holds.
 *
 * Attaches on mount (the ref has its element by the time an effect runs),
 * moves the handle if React replaces the element, and detaches on unmount.
 */
export function useComposerKeyboard(ref: ElementRef): void {
  const handle = useRef<ComposerKeyboardHandle | undefined>(undefined);
  const attached = useRef<Element | null>(null);

  // Every render: a new node under the ref is a new handle, and the old one
  // must go before it does. The comparison makes the common case (same node)
  // a no-op, so typing does not re-attach the kit mid-conversation.
  useEffect(() => {
    const el = ref.current;
    if (el === attached.current) return;
    handle.current?.detach?.();
    handle.current = undefined;
    attached.current = el;
    if (el) handle.current = attachComposerKeyboard(el);
  });

  // Unmount: the pane owns the last handle, so it goes with the pane.
  useEffect(() => () => {
    handle.current?.detach?.();
    handle.current = undefined;
    attached.current = null;
  }, []);
}
