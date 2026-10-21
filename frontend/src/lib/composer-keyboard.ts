/**
 * The settled pin for a React-owned composer column (#3571).
 *
 * Every chat screen holds its composer the same way (#1937): a flex column
 * with a `flex: 1` scroller and the typing slot and composer pinned below it
 * as siblings. The column wears `platform-kb-column`, and app.css gives it
 * `padding-bottom: var(--un-kb-inset)` while the keyboard is up, so the
 * composer sits on the keyboard line of the LAYOUT viewport.
 *
 * On iOS Safari that is only half the story. Before any keyboard inset
 * exists, Safari PANS the page to reveal the tapped field, by the full
 * keyboard height. The column then lifts the composer by the inset inside a
 * page already moved up: the two movements add, and the composer ends above
 * the top of the screen with only its bottom edge left.
 *
 * The other half is the kit's settled pin: once the burst of viewport events
 * goes quiet, `attachKeyboardAvoidance` sees a fixed shell and calls
 * `window.scrollTo(0, 0)`, putting Safari's pan back. The screens whose
 * composer already stayed put get that pin through
 * `PlatformUI.attachScreenFx`; Messages' `ConversationThread` and
 * `ReplyThreadPanel` are React's, mounted by no controller, so nothing
 * attached it there and the pan stayed.
 *
 * This module attaches it directly. It deliberately does not go through
 * `attachScreenFx`: that registry keeps ONE handle per key, and the Messages
 * screen and a project page's embedded #general draw the same
 * `ConversationThread` — a closing copy would detach the copy that just
 * opened.
 */

import { useEffect, useRef, type RefObject } from 'react';

export interface ComposerKeyboardHandle {
  detach(): void;
}

type KeyboardAvoidanceKit = {
  attachKeyboardAvoidance?: (
    el: Element,
    options?: { topEl?: Element },
  ) => { detach?: () => void } | null | undefined;
};

type KitWindow = {
  unNative?: KeyboardAvoidanceKit | null;
};

type KitDocument = Pick<Document, 'getElementById'>;

const NOOP: ComposerKeyboardHandle = { detach() {} };

/**
 * Attach the kit's keyboard avoidance (which carries the settled pin) to a
 * composer column's scroller. Never throws: a missing kit, a missing element
 * or a kit that refuses the element all leave the screen exactly as it was.
 * The returned detach is idempotent and swallows teardown errors.
 */
export function attachComposerKeyboard(
  el: Element | null | undefined,
  win: KitWindow | null | undefined = typeof window === 'undefined'
    ? undefined
    : (window as unknown as KitWindow),
  doc: KitDocument | null | undefined = typeof document === 'undefined' ? undefined : document,
): ComposerKeyboardHandle {
  const kit = win?.unNative;
  if (!el || !kit || typeof kit.attachKeyboardAvoidance !== 'function') return NOOP;
  // The shared header is the line the reveal maths must stay below. A page
  // without one (an embedded pane) still gets the pin, just not the anchor.
  const topEl = doc?.getElementById('platform-header') || undefined;
  let handle: { detach?: () => void } | null | undefined;
  try {
    handle = kit.attachKeyboardAvoidance(el, topEl ? { topEl } : undefined);
  } catch {
    return NOOP;
  }
  let detached = false;
  return {
    detach() {
      if (detached) return;
      detached = true;
      try {
        handle?.detach?.();
      } catch {
        /* the kit's teardown is not ours to report */
      }
    },
  };
}

/**
 * Keep the pin on whatever node the ref currently holds. Runs after every
 * commit, so a pane that renders its scroller only on some branches attaches
 * as soon as the node appears; a replaced node is detached before the new one
 * attaches. A separate effect detaches on unmount.
 *
 * The scroller's class string must stay constant: the kit ADDS
 * `un-kb-avoid` at runtime, and React rewriting `className` would silently
 * drop it. app.css zeroes the padding that class would add inside a
 * reserving column, so the inset is still reserved exactly once.
 */
export function useComposerKeyboard(ref: RefObject<Element | null>): void {
  const attached = useRef<{ el: Element; handle: ComposerKeyboardHandle } | null>(null);

  useEffect(() => {
    const el = ref.current;
    const current = attached.current;
    if (current && current.el === el) return;
    if (current) {
      current.handle.detach();
      attached.current = null;
    }
    if (el) attached.current = { el, handle: attachComposerKeyboard(el) };
  });

  useEffect(() => () => {
    const current = attached.current;
    attached.current = null;
    if (current) current.handle.detach();
  }, []);
}
