/**
 * Fixed-shell keyboard avoidance for the React Messages panes' composers.
 *
 * Every chat screen holds its composer the same way: a column with a
 * scroller and the composer pinned below it, and `html.un-kb
 * .platform-kb-column` (app.css) reserves the native kit's `--un-kb-inset`
 * as the column's bottom padding, so the composer sits on the keyboard line
 * of the layout viewport. iOS also pans the page up on the tap, before the
 * inset publishes, by up to the keyboard's height — the kit measured 337px
 * of pan under a 337px inset on iPhone Safari (its issue #1938 history).
 * The column then lifts the composer by the inset inside the already panned
 * page, and the box ends some 40px below the visible band's top: off
 * screen, as reported here.
 *
 * The kit's `unNative.attachKeyboardAvoidance(scrollEl, { topEl })` puts the
 * pan back: its settled pin waits out a 120ms quiet period after the last
 * visualViewport event, then `window.scrollTo(0, 0)` when the page is a
 * fixed shell — so the box may ride up briefly with the keys and then
 * settles above them, exactly how the legacy-mounted chats already behave
 * (app-view.js's general chat and group-chat.js's topic thread, through
 * `PlatformUI.attachScreenFx`). The Messages conversation and its reply
 * thread are React screens mounted by no controller, so nothing attached it
 * there; this hook does.
 *
 * It calls the kit directly rather than through `attachScreenFx`, whose
 * one-handle-per-key registry would let a closing pane detach the copy that
 * just opened: the same `ConversationThread` draws both the Messages screen
 * and a page's embedded #general. The kit adds its own `un-kb-avoid` class
 * to the scroller at runtime — each scroller's className stays a constant
 * literal so React never strips it, and the existing
 * `html.un-kb .platform-kb-column .un-kb-avoid { padding-bottom: 0 }` rule
 * keeps the inset from being reserved twice. Everything the kit does is a
 * structural no-op on desktop and without `window.visualViewport`, where it
 * attaches nothing.
 */

import { useEffect, type RefObject } from 'react';

/** The slice of `window.unNative` this module needs. */
interface UnNativeKit {
  attachKeyboardAvoidance(
    scrollEl: Element,
    options?: { topEl?: Element | undefined },
  ): { detach(): void } | undefined;
}

function kit(): UnNativeKit | null {
  const un = (window as unknown as { unNative?: Partial<UnNativeKit> }).unNative;
  return un && typeof un.attachKeyboardAvoidance === 'function' ? (un as UnNativeKit) : null;
}

/**
 * Attach the kit's keyboard avoidance to a chat column's scroller, handed
 * the platform header as the screen's top bar (as `attachScreenFx` does with
 * `navBar: false` — the header is shared, so the hairline treatment is not
 * this screen's to add). Returns a detach that never throws; a no-op
 * without an element or without the kit.
 */
export function attachComposerKeyboard(scroller: Element | null | undefined): () => void {
  if (!scroller) return () => {};
  const un = kit();
  if (!un) return () => {};
  try {
    const handle = un.attachKeyboardAvoidance(scroller, {
      topEl: document.getElementById('platform-header') || undefined,
    });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      try {
        handle?.detach();
      } catch {}
    };
  } catch {
    return () => {};
  }
}

/**
 * Keep that attachment on whatever element the ref holds: attaching when
 * the scroller mounts, re-attaching if React hands it a new node, detaching
 * when it unmounts. Call it before any early return, so the hook order
 * holds.
 */
export function useComposerKeyboard(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => attachComposerKeyboard(ref.current), [ref]);
}