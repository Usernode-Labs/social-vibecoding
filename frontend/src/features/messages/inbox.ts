/**
 * One inbox out of three lists (#2718).
 *
 * ── What changed, and why here ────────────────────────────────────────
 *
 * Messages was the `conversations` domain and nothing else: people talking
 * to people. Two other kinds of thread existed and were reachable only from
 * inside the thing they belonged to — an app's own discussion, which lived
 * on that app's board, and an agent chat, which lived in the Improve panel's
 * list. Neither was findable from a screen called Messages, which is the one
 * screen somebody looking for "what was said to me" opens.
 *
 * The navigation change makes Messages the platform's one inbox, which is
 * what every host in the study does: Slack and Teams put a channel, a DM and
 * a bot thread in one sidebar and tell them apart with a mark rather than
 * with three sidebars.
 *
 * THIS MODULE IS THE MERGE, and it is pure on purpose. The ordering and the
 * filtering are the argument the screen makes, and a test should be able to
 * drive them with three arrays rather than three fetches and a database.
 *
 * ── Ordered by when something last happened ───────────────────────────
 *
 * One clock for all three, because an inbox sorted per-kind is three lists
 * stacked rather than one list. A row with no timestamp at all sorts last
 * rather than first: "we do not know when" is not "just now", and an agent
 * chat that has never been opened would otherwise lead the inbox.
 */

export type InboxKind = 'person' | 'app' | 'agent' | 'session';

export interface InboxEntry {
  /** Unique within the merged list; the kind is part of it because a
   *  conversation id and an app slug live in different namespaces. */
  key: string;
  kind: InboxKind;
  /** ISO, or null when the source has no clock (see the header). */
  at: string | null;
}

export interface AppDiscussion {
  slug: string;
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  lastMessage: string;
  lastAt: string | null;
  lastBy: string | null;
}

export interface AgentChat {
  id: string;
  title: string;
  busy?: boolean;
  summary?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
}

/**
 * A change in flight — a dev session, or a work order handed to an agent
 * elsewhere (#2770).
 *
 * A CHANGE IS AN AGENT CONVERSATION: the viewer talks to the agent that
 * builds, the same as in an agent chat, so it is listed under Agents beside
 * them. The row is ../improve/session-row.tsx's, drawn from the Improve
 * store's own list, so this shape is only the part the merge needs — the
 * view carries the rest through untouched.
 */
export interface AgentSession {
  key: string;
  lastActivityAt?: string | null;
}

export type InboxFilter = 'all' | 'people' | 'apps' | 'agents';

/** The filter row, in order. Exported so the view and its test share one list. */
export const INBOX_FILTERS: ReadonlyArray<readonly [InboxFilter, string]> = [
  ['all', 'All'],
  ['people', 'People'],
  ['apps', 'Apps'],
  ['agents', 'Agents'],
];

/** Which kinds a filter admits. `all` admits every one. */
export function admits(filter: InboxFilter, kind: InboxKind): boolean {
  if (filter === 'all') return true;
  if (filter === 'people') return kind === 'person';
  if (filter === 'apps') return kind === 'app';
  // A session is an agent conversation (#2770), so Agents admits both.
  return kind === 'agent' || kind === 'session';
}

function stamp(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * Merge the three lists into one, newest first, filtered.
 *
 * The caller keeps its own three arrays — this returns descriptors, not
 * rows, so each kind is still drawn by the component that knows how. That
 * is what keeps a conversation row byte-identical to the one this screen
 * has always drawn while the list it sits in grew two more kinds.
 */
export function buildInbox(input: {
  conversations: Array<{ id: number; lastActivityAt: string }>;
  discussions: AppDiscussion[];
  agents: AgentChat[];
  /** Optional so a caller with no Improve store still merges three kinds. */
  sessions?: AgentSession[];
  filter: InboxFilter;
}): InboxEntry[] {
  const entries: InboxEntry[] = [];
  if (admits(input.filter, 'person')) {
    for (const item of input.conversations) {
      entries.push({ key: `person:${item.id}`, kind: 'person', at: item.lastActivityAt });
    }
  }
  if (admits(input.filter, 'app')) {
    for (const item of input.discussions) {
      entries.push({ key: `app:${item.slug}`, kind: 'app', at: item.lastAt });
    }
  }
  if (admits(input.filter, 'agent')) {
    for (const item of input.agents) {
      entries.push({
        key: `agent:${item.id}`,
        kind: 'agent',
        at: item.updatedAt || item.createdAt || null,
      });
    }
  }
  if (admits(input.filter, 'session')) {
    for (const item of input.sessions || []) {
      entries.push({ key: `session:${item.key}`, kind: 'session', at: item.lastActivityAt || null });
    }
  }
  // Stable within a timestamp: `sort` is stable in every engine this ships
  // to, so two rows that happened in the same second keep the order their
  // own source gave them — which for conversations is the server's.
  return entries.sort((a, b) => stamp(b.at) - stamp(a.at));
}
