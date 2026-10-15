// What is said about a change that went live inside another one (an
// included change, services/included-changes.js): its pull request's
// closing comment, its thread's lines and its author's notification. The
// merge-followups machine writes them; included-changes.js re-exports them.

export interface PrRow { id?: number; pr_number?: number | null; pr_title?: string | null }

/** "PR #3: First version of Flat 4B Chores", or "PR #3" untitled. */
export function prLabel(row: PrRow | null | undefined): string {
  const ref = row?.pr_number ? `PR #${row.pr_number}` : `Change ${row?.id}`;
  return row?.pr_title ? `${ref}: ${row.pr_title}` : ref;
}

/** The line its pull request is closed with. */
// `live: false`: the carrier is merged but not live yet (the merge-followups
// workflow machine says so later, in the thread: liveLine).
export function closingComment(carrier: PrRow, { live = true }: { live?: boolean } = {}): string {
  return live ? `Included in #${carrier.pr_number}, which went live.` : `Included in #${carrier.pr_number}, which merged.`;
}

/** The line in its own thread. */
export function threadLine(row: PrRow, carrier: PrRow, { live = true }: { live?: boolean } = {}): string {
  return live
    ? `${prLabel(row)} went live as part of ${prLabel(carrier)}, which was built on it. Its own vote is closed.`
    : `${prLabel(row)} was merged as part of ${prLabel(carrier)}, which was built on it, and goes live with it. Its own vote is closed.`;
}

/** The line in its own thread once its carrier is live (after threadLine's `live: false`). */
export function liveLine(row: PrRow, carrier: PrRow): string {
  return `${prLabel(row)} is live, as part of ${prLabel(carrier)}.`;
}

/** The author's notification, under "Live". */
export function authorLine(carrier: PrRow): string {
  return `Included in #${carrier.pr_number}, which went live.`;
}
