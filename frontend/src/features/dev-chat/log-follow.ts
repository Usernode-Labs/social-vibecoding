/**
 * The coding-run card's log follows the run (#1944).
 *
 * The card's `<pre>` is capped at 240px and scrolls on its own. Before the
 * transcript became React, `_patchProgressDom` wrote each new line into that
 * `<pre>` and scrolled it to the end; the conversion dropped the scroll on
 * the grounds that the transcript's MutationObserver "already follows the
 * transcript to the bottom". It follows the OUTER container. The inner panel
 * stayed at its top, so an open card showed the first dozen lines of a run
 * that was two hundred lines further on, and nothing the reader did short
 * of dragging the panel by hand caught it up.
 *
 * This is the rule the outer container already lives by, applied to the
 * panel: follow while the reader is at the end, stop the moment they scroll
 * up to read something, resume when they come back. Opening the card counts
 * as "show me where it is now", so an open jumps to the latest line whatever
 * the reader had done before closing it.
 *
 * Pure over a scroll box so tests can drive it without a DOM; the component
 * wires it to the real element.
 */

/** The three numbers a scroll box is, from a DOM element or a test fake. */
export interface ScrollBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * How far from the end still counts as "at the end". A line and a half of
 * the 11px/1.5 log, so a reader who is one wrapped line short of the bottom
 * is not treated as having scrolled away.
 */
export const FOLLOW_SLACK_PX = 24;

export function isAtEnd(box: ScrollBox, slack: number = FOLLOW_SLACK_PX): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= slack;
}

export function scrollToEnd(box: ScrollBox): void {
  box.scrollTop = box.scrollHeight;
}

export interface LogFollower {
  /** Whether the next growth will be followed. Starts true. */
  readonly pinned: boolean;
  /** The reader scrolled the panel: re-derive whether they are at the end. */
  noteScroll(box: ScrollBox): void;
  /** Lines were appended: follow them if the reader was at the end. */
  noteGrowth(box: ScrollBox): void;
  /** The card was opened: show the latest line, whatever came before. */
  noteOpened(box: ScrollBox): void;
}

export function createLogFollower(): LogFollower {
  let pinned = true;
  return {
    get pinned() { return pinned; },
    noteScroll(box) { pinned = isAtEnd(box); },
    noteGrowth(box) { if (pinned) scrollToEnd(box); },
    noteOpened(box) { pinned = true; scrollToEnd(box); },
  };
}

/**
 * Bring an opened card into view without leaving it.
 *
 * `block: 'nearest'` scrolls the least that makes the card visible: a card
 * that fits comes up until its bottom edge is on screen, a card taller than
 * the pane aligns its head to the top so the toggle the reader just pressed
 * stays where they pressed it. A card already fully on screen moves nothing.
 *
 * Animated, and SAID so here: the reader asked for this movement, so it
 * glides. It used to inherit that from `.dc-messages-container`'s
 * `scroll-behavior: smooth`, which also animated every follow-to-bottom a
 * streaming turn asked for — the rule that made those stutter. Following new
 * content is instant now (`DevChat._jumpToBottom`), and the one deliberate
 * jump keeps its animation by asking for it.
 */
export function revealDisclosure(el: { scrollIntoView?: (opts: ScrollIntoViewOptions) => void } | null): void {
  if (el && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}
