import { useEffect, useRef, type RefObject } from 'react';

/**
 * A REACT COMPOSER COLUMN TAKES THE KIT'S KEYBOARD AVOIDANCE TOO (#3571).
 *
 * "Clicking the message field on mobile Safari to reply to a message sends
 * the message box off screen as the keyboard comes up."
 *
 * Every chat screen holds its composer the same way (#1937): a column with a
 * scroller and the composer pinned below it, and `.platform-kb-column`
 * (app.css) reserves the kit's `--un-kb-inset` as the column's bottom
 * padding, so the composer sits on the keyboard line OF THE LAYOUT VIEWPORT.
 * That is half of it. iOS also PANS the page to reveal the field the moment
 * it is tapped — the tap lands before the inset exists, when the composer is
 * still down behind where the keys will be — and it pans the most it can,
 * the full keyboard height (Safari measured 337px of pan under a 337px inset,
 * #1938). The column then lifts the composer by the inset INSIDE a page that
 * has already been moved up by the same amount: what is on screen is the
 * band from 337 to 714, and the composer now ends at 377 — 40px from the
 * top edge, its box above it. Off screen, exactly as reported.
 *
 * The screens where the composer stayed put — a project's channel, a
 * channel's reply thread, a dev session — were never doing that alone. Each
 * is mounted by a legacy controller that calls `PlatformUI.attachScreenFx`
 * on its scroller (app-view.js renderGroupChatTab, group-chat.js
 * mountThread, dev-chat.js), and that attaches the kit's
 * `unNative.attachKeyboardAvoidance`, whose settled pin (native.js
 * `settledPin`) puts a fixed shell's pan back with `window.scrollTo(0, 0)`
 * once the keyboard's burst of viewport events has gone quiet. Pan undone,
 * reservation kept: the header and the transcript stay on screen and the
 * composer sits on the keys. The Messages conversation and its reply thread
 * are React's, mounted by no controller, so nothing attached it there, and
 * the pan stayed.
 *
 * This is the same call, owned by the component: attached when the scroller
 * mounts, detached when it goes, re-attached if React hands it a new node.
 * It goes to the kit directly rather than through `attachScreenFx`, whose
 * one-handle-per-KEY registry would let a closing copy of a pane (Messages
 * and a page's embedded #general draw the same component) detach the copy
 * that just opened. `topEl` is the platform header, as attachScreenFx is
 * handed for the group chat. The kit's own class (`un-kb-avoid`) lands on the
 * scroller, as it does on `#gc-messages`, and app.css's
 * `html.un-kb .platform-kb-column .un-kb-avoid` already keeps it from
 * reserving the inset a second time; the scroller's `className` must stay
 * constant so React never strips it. Everything the kit does is a structural
 * no-op on desktop and without `visualViewport`.
 */

type KitHandle = { detach?: () => void } | null | undefined;
type KitLike = {
  attachKeyboardAvoidance?: (scrollEl: Element, opts?: { topEl?: Element }) => KitHandle;
};
type WinLike = { unNative?: KitLike | null };
type DocLike = { getElementById(id: string): Element | null };

const NOOP = () => {};

/** Attach the kit's keyboard avoidance to a composer column's scroller.
 *  Returns the detach; a no-op when there is no element or no kit. */
export function attachComposerKeyboard(
  el: Element | null | undefined,
  win: WinLike | undefined = typeof window !== 'undefined' ? (window as unknown as WinLike) : undefined,
  doc: DocLike | undefined = typeof document !== 'undefined' ? document : undefined,
): () => void {
  const kit = win?.unNative;
  if (!el || !kit || typeof kit.attachKeyboardAvoidance !== 'function') return NOOP;
  const topEl = doc?.getElementById('platform-header') || undefined;
  let handle: KitHandle;
  try {
    handle = kit.attachKeyboardAvoidance(el, topEl ? { topEl } : {});
  } catch {
    return NOOP;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try { handle?.detach?.(); } catch { /* one surface must not break the unmount */ }
  };
}

/**
 * Keep the kit's keyboard avoidance on whatever element `ref` holds. Runs
 * after every commit, so a pane that renders its scroller only on some
 * branches (a conversation, not the empty state) attaches the moment it
 * appears; a ref compare when nothing changed.
 */
export function useComposerKeyboard(ref: RefObject<Element | null>): void {
  const attached = useRef<{ el: Element; detach: () => void } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if ((attached.current?.el || null) === el) return;
    attached.current?.detach();
    attached.current = el ? { el, detach: attachComposerKeyboard(el) } : null;
  });
  useEffect(() => () => {
    attached.current?.detach();
    attached.current = null;
  }, []);
}
