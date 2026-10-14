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

import { t } from '../../lib/i18n/runtime';

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
  return t('messages:approval.list.and', { first: commaWords(items.slice(0, -1)), last: items[items.length - 1] });
}

/** Everyone before the last, as the language on screen separates them. */
function commaWords(items: string[]): string {
  return items.reduce((first, second) => t('messages:approval.list.comma', { first, second }));
}

/** Pure: "a", "a or b", "a, b or c". */
export function orWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return t('messages:approval.list.or', { first: commaWords(items.slice(0, -1)), last: items[items.length - 1] });
}

/**
 * The same three lines in the two places that say them: a status line under
 * the ready card (no full stop), and a sentence in the project chat's card
 * (with one). Two wordings are two messages, so the full stop is never added
 * to a finished line.
 */
export type ApprovalLineForm = 'status' | 'sentence';
const LINE_IDS = {
  status: {
    needs: 'messages:approval.needs',
    needsMore: 'messages:approval.needsMore',
    waiting: 'messages:approval.waiting',
    waitingYou: 'messages:approval.waitingYou',
  },
  sentence: {
    needs: 'chat:group.botCard.approval.needs',
    needsMore: 'chat:group.botCard.approval.needsMore',
    waiting: 'chat:group.botCard.approval.waitingFrom',
    waitingYou: 'chat:group.botCard.approval.waitingFromYou',
  },
} as const;

/** Pure: "Needs one approval from …", "Needs 2 approvals from …", or with `again` "… one more approval …". */
export function approvalsWords(count: number, people: string, again = false, form: ApprovalLineForm = 'status'): string {
  return again
    ? t(LINE_IDS[form].needsMore, { count, people })
    : t(LINE_IDS[form].needs, { count, people });
}

/**
 * Where a list of people stands in its sentence. The words in the list that
 * are not account names (the reader, and "2 more" for people not named) are
 * worded for ONE such place each, because a language with cases needs a
 * different form after "approval from" than as the subject of "approve":
 *   from     "Waiting for approval from …", "Needs 2 approvals from …"
 *   subject  "It goes live when … approve too."
 */
type ListPlace = 'fromAll' | 'fromAny' | 'subjectAll';

/** The unnamed rest of a list, in the form its place needs, and how the list is joined. */
const LIST = {
  fromAll: { rest: 'messages:approval.list.from.more', joiner: 'and' },
  fromAny: { rest: 'messages:approval.list.from.others', joiner: 'or' },
  subjectAll: { rest: 'messages:approval.list.subject.more', joiner: 'and' },
} as const;

/** Pure: whoever is named, then the rest as "2 others" (with "or") or "2 more" (with "and"). */
function people(names: string[], more: number, place: ListPlace): string {
  const all = [...names, ...(more ? [t(LIST[place].rest, { count: more })] : [])];
  return LIST[place].joiner === 'or' ? orWords(all) : andWords(all);
}

/**
 * Pure: "Needs 2 approvals from you, @priya or @mo" when fewer are needed
 * than the people listed, "Waiting for approval from you and @ada" when
 * every one of them is. Null when nobody is listed, or when no approval is
 * missing any more. `form` picks the status line or the sentence with its
 * full stop.
 */
export function waitingWords(need: ApprovalNeed, form: ApprovalLineForm = 'status'): string | null {
  const missing = countOf(need.missing);
  if (missing === 0) return null;
  const others = (need.names || []).map((name) => `@${name}`);
  // The reader, as an item of a list that follows "from".
  const named = [...(need.you ? [t('messages:approval.list.from.you')] : []), ...others];
  const more = Math.max(Math.floor(Number(need.more) || 0), 0);
  const listed = named.length + more;
  if (!listed) return null;
  if (missing !== null && missing < listed) {
    const needed = countOf(need.needed);
    return approvalsWords(missing, people(named, more, 'fromAny'), needed !== null && missing < needed, form);
  }
  // Only the reader is left: a whole sentence of its own, with no list in it.
  if (need.you && !others.length && !more) return t(LINE_IDS[form].waitingYou);
  return t(LINE_IDS[form].waiting, { people: people(named, more, 'fromAll') });
}

/**
 * Pure: whose approval it still needs once the reader's is in, worded to
 * follow "It goes live": "when @ada approves too" when every one of them is
 * needed, "after one more approval from @priya or @mo" when fewer are,
 * "when one more person approves" when nobody is named.
 */
/**
 * Which of the sentences after "It goes live" applies, and what goes in it.
 * The sentences themselves are whole catalog entries (./bot-ready.tsx
 * approvedLine), one per case and per day, so no language has to fit a
 * clause built here into a sentence built there.
 */
export interface AfterYes {
  who: 'person' | 'people' | 'approvals' | 'anyone';
  values: Record<string, string | number>;
}

export function afterYesWords({ missing, names, more = 0 }: { missing: number; names: string[]; more?: number }): AfterYes {
  const named = names.map((name) => `@${name}`);
  const listed = named.length + more;
  if (named.length && listed === missing) {
    return missing === 1
      ? { who: 'person', values: { username: names[0] } }
      // "… when {{people}} approve too": the list is the sentence's subject.
      : { who: 'people', values: { people: people(named, more, 'subjectAll') } };
  }
  // "… after one more approval from {{people}}": the list follows "from".
  if (named.length && listed > missing) return { who: 'approvals', values: { count: missing, people: people(named, more, 'fromAny') } };
  return { who: 'anyone', values: { count: missing } };
}
