/*
 * Who a change Homeroom bot built still needs approval from, in words. One
 * wording for both places that say it: the ready card in a person's chat
 * with the bot (./bot-ready.tsx waitingLine and approvedLine) and the card
 * under the project chat message the change was asked in
 * (../group-chat/bot-request.tsx approvalWords). The server sends the names
 * and the counts (services/homeroom-bot-dm.js approvalState, needsYesFrom).
 *
 * First-session run-through, 5 Oct 2026: Page Turners has three members and
 * a change there needs two of them to approve (its change page said "1/2"
 * once one had). The maker's card said "Waiting for approval from you,
 * @priya_t1006 and @mo_t1006", which reads as if all three must. When fewer
 * approvals are needed than the people listed, the line says how many, and
 * "or" says any of them will do: "Needs 2 approvals from you, @priya_t1006
 * or @mo_t1006", then, with one in, "Needs one more approval from
 * @priya_t1006 or @mo_t1006". When everybody listed is needed it still says
 * "Waiting for approval from you and @ada".
 */

export interface ApprovalNeed {
  /** The reader's own approval counts and is not in yet: listed as "you". */
  you?: boolean;
  /** Up to three others whose approval counts and is not in yet. */
  names: string[];
  /** How many more such people besides those named. */
  more?: number;
  /**
   * How many more approvals it needs (0 once it has them). Unknown on a card
   * sent before cards carried it, which reads as everybody listed.
   */
  missing?: number | null;
  /** How many approvals it needs in all, so the line says "more" once some are in. */
  needed?: number | null;
}

/** Pure: a count the server sent, or null for none (or not a count). */
export function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Pure: "a", "a and b", "a, b and c". */
export function andWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Pure: "a", "a or b", "a, b or c". */
export function orWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** Pure: "one approval", "2 approvals", or with `again` "one more approval", "2 more approvals". */
export function approvalsWords(count: number, again = false): string {
  const more = again ? ' more' : '';
  return count === 1 ? `one${more} approval` : `${count}${more} approvals`;
}

/** Pure: whoever is named, then the rest as "2 others" (with "or") or "2 more" (with "and"). */
function people(names: string[], more: number, joiner: 'and' | 'or'): string {
  const rest = joiner === 'or' ? `${more} ${more === 1 ? 'other' : 'others'}` : `${more} more`;
  const all = [...names, ...(more ? [rest] : [])];
  return joiner === 'or' ? orWords(all) : andWords(all);
}

/**
 * Pure: "Needs 2 approvals from you, @priya or @mo" when fewer are needed
 * than the people listed, "Waiting for approval from you and @ada" when
 * every one of them is. Null when nobody is listed, or when no approval is
 * missing any more.
 */
export function waitingWords(need: ApprovalNeed): string | null {
  const missing = countOf(need.missing);
  if (missing === 0) return null;
  const named = [...(need.you ? ['you'] : []), ...(need.names || []).map((name) => `@${name}`)];
  const more = Math.max(Math.floor(Number(need.more) || 0), 0);
  const listed = named.length + more;
  if (!listed) return null;
  if (missing !== null && missing < listed) {
    const needed = countOf(need.needed);
    return `Needs ${approvalsWords(missing, needed !== null && missing < needed)} from ${people(named, more, 'or')}`;
  }
  return `Waiting for approval from ${people(named, more, 'and')}`;
}

/**
 * Pure: whose approval it still needs once the reader's is in, worded to
 * follow "It goes live": "when @ada approves too" when every one of them is
 * needed, "after one more approval from @priya or @mo" when fewer are,
 * "when one more person approves" when nobody is named.
 */
export function afterYesWords({ missing, names, more = 0 }: { missing: number; names: string[]; more?: number }): string {
  const named = names.map((name) => `@${name}`);
  const listed = named.length + more;
  if (named.length && listed === missing) {
    return `when ${people(named, more, 'and')} ${missing === 1 ? 'approves' : 'approve'} too`;
  }
  if (named.length && listed > missing) return `after ${approvalsWords(missing, true)} from ${people(named, more, 'or')}`;
  return missing === 1 ? 'when one more person approves' : `when ${missing} more people approve`;
}
