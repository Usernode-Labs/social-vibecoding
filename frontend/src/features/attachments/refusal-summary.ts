/**
 * The line a composer shows when a drop or a pick left files out (#4065): the
 * first reason, in the composer's own words, then how many others went with
 * it. "Images max 4 MB. 2 more files weren’t attached." It used to be
 * whichever reason came last, and files past the fourth were sometimes left
 * out without a word.
 */
export function refusalSummary(firstReason: string, moreCount: number): string {
  if (!moreCount || moreCount < 1) return firstReason;
  const more = moreCount === 1 ? '1 more file wasn’t attached.' : `${moreCount} more files weren’t attached.`;
  return `${firstReason} ${more}`;
}
