/**
 * Runs of cards in a transcript (#2884).
 *
 * A channel that nobody is talking in fills with cards — a proposal put up
 * for a vote, another merged, a third put up — and a screen of them in a row
 * says less than the first one and a count. So a transcript draws a run of
 * `CARD_RUN_MIN` or more consecutive cards as its first card and a
 * "… N more" row, which expands the rest in place.
 *
 * WHAT IS A CARD is the caller's to say (`isCard`): an app channel's proposal
 * events, a conversation's shared-item-only messages. Anything else breaks
 * the run — a person saying something between two cards is the conversation
 * the cards are about, and folding across it would hide it. `joins` lets the
 * caller break a run on something that is not a row at all, such as a day
 * divider the transcript draws between two rows.
 *
 * Pure, so both transcripts share one rule and a test can hold it without a
 * browser.
 */

/** The shortest run that folds. Two cards in a row are just two cards. */
export const CARD_RUN_MIN = 3;

/**
 * The runs worth folding, as start index → run length. Every run in the map
 * is at least `CARD_RUN_MIN` long; an index absent from it is drawn as usual.
 */
export function cardRunStarts<T>(
  items: readonly T[],
  isCard: (item: T) => boolean,
  joins: (previous: T, item: T) => boolean = () => true,
): Map<number, number> {
  const runs = new Map<number, number>();
  let start = -1;
  const close = (end: number) => {
    if (start >= 0 && end - start >= CARD_RUN_MIN) runs.set(start, end - start);
    start = -1;
  };
  items.forEach((item, i) => {
    if (!isCard(item)) { close(i); return; }
    if (start >= 0 && !joins(items[i - 1], item)) close(i);
    if (start < 0) start = i;
  });
  close(items.length);
  return runs;
}

/** "… 4 more", the folded row's words. */
export function cardRunLabel(hidden: number): string {
  return `… ${hidden} more`;
}
