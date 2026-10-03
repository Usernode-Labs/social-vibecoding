import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';

/*
 * #3757: a conversation stays on its newest line while the reader is there.
 *
 * "I'm at the bottom of my chat with the Homeroom bot, I send a message, and
 * I don't realize it has a new message because it doesn't autoscroll down."
 * The thread used to decide whether to follow a new message by measuring how
 * far it was from the bottom AFTER that message had been drawn. A short line
 * passed; a bot reply of a few paragraphs is taller than the old 180px
 * allowance on its own, so the reader who was exactly at the bottom counted
 * as scrolled up and was left there. And nothing followed what grew after
 * the draw: an image or a link card loading, the bot's activity cards
 * updating in place, the composer or the keyboard taking height from the
 * scroller.
 *
 * So whether the reader is at the bottom is taken from where THEY last put
 * the scroller (its scroll events), before anything new arrives, and kept in
 * `pinned`. While it holds, a new message, and any later change of size of
 * the rows or of the scroller itself, puts the scroller back at the bottom.
 * A reader who scrolled up to read history is never moved.
 */

/** How far from the bottom still counts as at the bottom: about two lines. */
export const STICK_SLACK_PX = 120;

export interface ScrollBox {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** Whether a scroller is at, or within `slack` of, the bottom of its content. */
export function isNearBottom(el: ScrollBox, slack: number = STICK_SLACK_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

type Observer = { observe(target: Element, options?: { box: 'border-box' }): void; unobserve(target: Element): void; disconnect(): void };
type MutationLike = { observe(target: Node, options: { childList: boolean }): void; disconnect(): void };
type MutationRecordLike = { addedNodes: ArrayLike<Node>; removedNodes: ArrayLike<Node> };
const BORDER_BOX = { box: 'border-box' } as const;

export interface ObserverEnv {
  ResizeObserver?: new (callback: () => void) => Observer;
  MutationObserver?: new (callback: (records: MutationRecordLike[]) => void) => MutationLike;
}

/**
 * Keep `el` on its newest line while `pinned` holds, and keep `pinned` in
 * step with where the reader scrolls. `atPresent` says whether the bottom of
 * what is drawn is the newest message: at the bottom of a window a message
 * link opened part-way back (#2387), the reader is not following anything,
 * and "Load newer messages" must not jump past what it just loaded.
 * Returns the detach.
 */
export function attachStickToBottom(
  el: HTMLElement,
  pinned: { current: boolean },
  atPresent: { current: boolean } = { current: true },
  env: ObserverEnv = globalThis as unknown as ObserverEnv,
): () => void {
  const onScroll = () => { pinned.current = atPresent.current && isNearBottom(el); };
  const follow = () => { if (pinned.current) el.scrollTop = el.scrollHeight; };
  el.addEventListener('scroll', onScroll, { passive: true });
  const Sizes = env.ResizeObserver;
  const Rows = env.MutationObserver;
  // The scroller's own box (the composer growing, the keyboard), and every
  // row in it: the scroller's content height is the sum of its rows. Their
  // border boxes, so a row's padding or border changing counts as well.
  const sizes = typeof Sizes === 'function' ? new Sizes(follow) : null;
  let rows: MutationLike | null = null;
  if (sizes) {
    const watch = (target: Element) => sizes.observe(target, BORDER_BOX);
    watch(el);
    for (const child of Array.from(el.children)) watch(child);
    if (typeof Rows === 'function') {
      rows = new Rows((records) => {
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) if (node.nodeType === 1) watch(node as Element);
          for (const node of Array.from(record.removedNodes)) if (node.nodeType === 1) sizes.unobserve(node as Element);
        }
      });
      rows.observe(el, { childList: true });
    }
  }
  return () => {
    el.removeEventListener('scroll', onScroll);
    rows?.disconnect();
    sizes?.disconnect();
  };
}

/**
 * attachStickToBottom on whatever element `ref` holds, re-attached when the
 * pane draws a different scroller (a conversation, not the empty state).
 * Returns `pinned`, which the caller reads before scrolling for new messages
 * and sets when it moves the reader itself.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, atPresent: boolean): MutableRefObject<boolean> {
  const pinned = useRef(true);
  const present = useRef(atPresent);
  const attached = useRef<{ el: HTMLElement; detach: () => void } | null>(null);
  useIsomorphicLayoutEffect(() => {
    present.current = atPresent;
    const el = ref.current;
    if ((attached.current?.el || null) === el) return;
    attached.current?.detach();
    attached.current = el ? { el, detach: attachStickToBottom(el, pinned, present) } : null;
  });
  useEffect(() => () => {
    attached.current?.detach();
    attached.current = null;
  }, []);
  return pinned;
}
