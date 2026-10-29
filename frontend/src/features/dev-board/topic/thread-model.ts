/**
 * #6019 (threads, stage 3): what a request's or a change's page says about
 * the thread it is in. Pure, so tests read it without a DOM; drawn by
 * ./thread-items.tsx.
 *
 * A thread is one piece of work: its requests, the changes built for them,
 * a vote to close, a decision (src/services/threads.js `threadPage`, read
 * from GET /api/apps/:slug/threads/:number). The page is one of those items;
 * this lists the others, oldest first, each with what it is and where it
 * stands in words, and the newest replies folded under a change's or a
 * vote's row. It also says which way the viewer's Notify me / Mute button
 * goes next.
 */

export type ThreadItemType = 'request' | 'change' | 'close' | 'decision';

export interface FoldedReply {
  id: number;
  username: string;
  bot?: boolean;
  text: string;
  at?: string | null;
}

export interface ThreadItem {
  type: ThreadItemType;
  id: number;
  number: number | null;
  title: string | null;
  status: string;
  /** A change's place in its life (issue-proposal-ref.js `stateOf`). */
  state?: 'underway' | 'review' | 'merged';
  at?: string | null;
  replies: number;
  folded?: FoldedReply[];
  /** Stage 6, a change: the approval epoch a vote is cast under, and the viewer's vote on it. */
  epoch?: number | null;
  myVote?: 'yes' | 'no' | null;
}

export interface ThreadFollow {
  state: 'following' | 'muted' | 'none';
  chosen: boolean;
}

export interface ThreadPayload {
  thread: {
    id: number;
    number: number | null;
    kind: 'work' | 'decision';
    lead: 'request' | 'change' | 'decision';
    title: string | null;
    state: 'open' | 'closed';
  };
  items: ThreadItem[];
  /** Null signed out: there is no one to notify. */
  follow: ThreadFollow | null;
  /** Stage 6: a merge or split waiting on this thread (services/thread-moves.js). */
  moves?: ThreadMove[];
}

export interface ThreadMove {
  id: number;
  kind: 'merge' | 'split';
  state: 'pending' | 'voting' | 'applied' | 'refused';
  input: { into?: number; intoNumber?: number | null; items?: Array<{ type: ThreadItemType; number?: number; id?: number }> };
  deadline: string;
  agreed: number[];
  governanceId: number | null;
}

/** The page the list is drawn on: a request by its number, the rest by id. */
export interface ThreadHere {
  type: ThreadItemType;
  id: number;
}

/** One message id and what it is read with. */
export interface Phrase {
  id: string;
  values?: Record<string, string | number>;
}

export interface ThreadRowView {
  key: string;
  type: ThreadItemType;
  /** The row's subject: the item's own title, else what it is. */
  title: Phrase | string;
  /** What it is, where it stands, and its replies, joined with " · ". */
  facts: Phrase[];
  /** Where a tap goes, as AppView.openTopic takes it. */
  open: { kind: 'issue' | 'proposal' | 'gov'; id: number };
  folded: FoldedReply[];
}

/** Whether `item` is the page this list is drawn on. */
function isHere(item: ThreadItem, here: ThreadHere | null): boolean {
  if (!here || here.type !== item.type) return false;
  return item.type === 'request' ? item.number === here.id : item.id === here.id;
}

function what(item: ThreadItem): Phrase {
  if (item.type === 'request') return { id: 'project:topic.thread.item.request', values: { number: item.number ?? 0 } };
  if (item.type === 'change') {
    return item.number
      ? { id: 'project:topic.thread.item.change', values: { number: item.number } }
      : { id: 'project:topic.thread.item.changeUnnumbered' };
  }
  if (item.type === 'close') return { id: 'project:topic.thread.item.close' };
  return { id: 'project:topic.thread.item.decision' };
}

function standing(item: ThreadItem): Phrase | null {
  if (item.type === 'request') {
    return { id: item.status === 'closed' ? 'project:topic.thread.state.closed' : 'project:topic.thread.state.open' };
  }
  if (item.type === 'change') {
    return item.state === 'merged' ? { id: 'project:topic.thread.state.live' }
      : item.state === 'review' ? { id: 'project:topic.thread.state.voting' }
        : { id: 'project:topic.thread.state.underway' };
  }
  return { id: item.status === 'open' ? 'project:topic.thread.state.voting' : 'project:topic.thread.state.settled' };
}

/** The other items in the thread, oldest first. */
export function threadRows(payload: ThreadPayload | null, here: ThreadHere | null): ThreadRowView[] {
  if (!payload || !Array.isArray(payload.items)) return [];
  return payload.items
    .filter((item) => !isHere(item, here))
    .map((item) => {
      const facts: Phrase[] = [what(item)];
      const stands = standing(item);
      if (stands) facts.push(stands);
      // Zero says nothing.
      if (item.replies > 0) facts.push({ id: 'project:topic.thread.replies', values: { count: item.replies } });
      const open = item.type === 'request'
        ? { kind: 'issue' as const, id: item.number ?? 0 }
        : item.type === 'change'
          ? { kind: 'proposal' as const, id: item.id }
          : { kind: 'gov' as const, id: item.id };
      return {
        key: `${item.type}:${item.id}`,
        type: item.type,
        title: item.title || what(item),
        facts,
        open,
        folded: item.type === 'request' ? [] : (item.folded || []),
      };
    });
}

export interface FollowButtonView {
  label: string;
  hint: string;
  /** Muted is the pressed state, as a channel's Mute is. */
  pressed: boolean;
  /** What a press sends: Notify me (true), Mute (false), back to the rule (null). */
  next: boolean | null;
}

/**
 * The viewer's one button. Not following: Notify me. Following, for any
 * reason: Mute. Muted: pressing it again goes back to the rule, which
 * follows whoever asked, built, voted or posted.
 */
export function followButton(follow: ThreadFollow | null): FollowButtonView | null {
  if (!follow) return null;
  if (follow.state === 'muted') {
    return { label: 'project:topic.thread.follow.muted', hint: 'project:topic.thread.follow.mutedHint', pressed: true, next: null };
  }
  if (follow.state === 'following') {
    return { label: 'project:topic.thread.follow.mute', hint: 'project:topic.thread.follow.muteHint', pressed: false, next: false };
  }
  return { label: 'project:topic.thread.follow.notifyMe', hint: 'project:topic.thread.follow.notifyMeHint', pressed: false, next: true };
}

/**
 * Stage 6: what a waiting move says, in two phrases: what it would do, and
 * when it happens or why it waits. `now` is a clock in ms.
 */
export function moveLines(move: ThreadMove, now: number = Date.now()): { what: Phrase; when: Phrase } {
  const items = move.input.items || [];
  const what: Phrase = move.kind === 'merge'
    ? { id: 'project:topic.thread.move.merge', values: { number: move.input.intoNumber ?? '?' } }
    : {
      id: 'project:topic.thread.move.split',
      values: { what: items.map((i) => (i.type === 'request' ? `#${i.number}` : i.type)).join(', ') },
    };
  if (move.state === 'voting') return { what, when: { id: 'project:topic.thread.move.voting' } };
  const hours = Math.max(1, Math.ceil((Date.parse(move.deadline) - now) / 3600000));
  return { what, when: { id: 'project:topic.thread.move.pending', values: { count: Number.isFinite(hours) ? hours : 24 } } };
}

/** Stage 6: the items a split may take, every one but the thread's lead. Pure. */
export function splittable(payload: ThreadPayload | null): ThreadItem[] {
  if (!payload) return [];
  const lead = payload.thread.number;
  return payload.items.filter((i) => !(lead != null && i.number === lead && (i.type === 'request' || i.type === 'change')));
}

/**
 * Stage 6: competing changes. Two or more changes in one thread up for a
 * vote read as one ballot: pick one, or Neither. Underneath each keeps its
 * own vote, pinned to its own revision (a push clears only that change's),
 * and the first to pass goes live and closes the rest. The viewer's pick is
 * read off those votes: Yes on one is that one, No on every one is
 * Neither. Null when there is no ballot. Pure.
 */
export interface Ballot {
  options: ThreadItem[];
  pick: number | 'neither' | null;
}

export function ballotOf(payload: ThreadPayload | null): Ballot | null {
  if (!payload) return null;
  const options = payload.items.filter((i) => i.type === 'change' && i.state === 'review');
  if (options.length < 2) return null;
  const yes = options.filter((o) => o.myVote === 'yes');
  const pick = yes.length === 1 ? yes[0].id
    : options.every((o) => o.myVote === 'no') ? 'neither' : null;
  return { options, pick };
}

/**
 * The votes a pick casts: Yes on the picked change and its Yes taken back
 * from every other (a No would count against it), or No on every one for
 * Neither. Only what changes is cast. Pure.
 */
export function ballotVotes(ballot: Ballot, pick: number | 'neither'): Array<{ sessionId: number; vote: 'yes' | 'no' | null; epoch: number | null }> {
  const out: Array<{ sessionId: number; vote: 'yes' | 'no' | null; epoch: number | null }> = [];
  for (const o of ballot.options) {
    const want = pick === 'neither' ? 'no' : o.id === pick ? 'yes' : (o.myVote === 'yes' ? null : o.myVote ?? null);
    if (want !== (o.myVote ?? null)) out.push({ sessionId: o.id, vote: want, epoch: o.epoch ?? null });
  }
  return out;
}
