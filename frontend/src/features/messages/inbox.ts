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
 *
 * ── Two sections, Discord's (#2783) ────────────────────────────────────
 *
 * The clock still orders the TOP of the list — direct messages, group chats
 * and agents, which are the threads a person is IN — but the channels come
 * after them as their own section: #general first, which every user is in,
 * then one channel per app the viewer is a member of. A channel is a room
 * you visit, not a conversation waiting on you, so it does not jump over a
 * DM because somebody said something in it. Within the section the clock
 * orders the app channels, and one nobody has spoken in sits at the end.
 *
 * ── Your apps, then "Show more" (#2967) ────────────────────────────────
 *
 * A member of many apps had a channel for each, all at one weight. The app
 * channels now split in two: the ones in the viewer's "Your apps" (Home's
 * section, decided by the server — see src/routes/messages-overview.js
 * `yours`) first, then the rest, which `collapseChannels` folds under a
 * "Show more (N)" toggle. #general is not an app and stays where it was, at
 * the head of the section.
 */

// `mayor` is an agent session (#2779): a conversation with the Mayor that
// works on any app, as opposed to `agent` (a Global Chat thread) and
// `session` (one change's classic dev chat).
export type InboxKind = 'person' | 'channel' | 'app' | 'agent' | 'session' | 'mayor';

/** Which part of the list an entry is drawn in. */
export type InboxSection = 'chats' | 'channels';

export interface InboxEntry {
  /** Unique within the merged list; the kind is part of it because a
   *  conversation id and an app slug live in different namespaces. */
  key: string;
  kind: InboxKind;
  section: InboxSection;
  /** ISO, or null when the source has no clock (see the header). */
  at: string | null;
  /** An app channel's half of the section (#2967): in Your apps, or not. */
  group?: ChannelGroup;
}

export type ChannelGroup = 'yours' | 'more';

/**
 * An app's channel — its general discussion, `chat_messages` with a null
 * thread type. `channel` is its `#handle` (src/routes/messages-overview.js),
 * optional only because an older server did not send one.
 */
export interface AppDiscussion {
  slug: string;
  name: string;
  channel?: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  lastMessage: string;
  lastAt: string | null;
  lastBy: string | null;
  /**
   * In the viewer's "Your apps" (#2967). Optional: an older server did not
   * send it, and a member app is one of theirs unless they said otherwise.
   */
  yours?: boolean;
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

export type InboxFilter = 'all' | 'people' | 'channels' | 'agents';

/** The filter row, in order. Exported so the view and its test share one list. */
export const INBOX_FILTERS: ReadonlyArray<readonly [InboxFilter, string]> = [
  ['all', 'All'],
  ['people', 'People'],
  ['channels', 'Channels'],
  ['agents', 'Agents'],
];

/** Which kinds a filter admits. `all` admits every one. */
export function admits(filter: InboxFilter, kind: InboxKind): boolean {
  if (filter === 'all') return true;
  if (filter === 'people') return kind === 'person';
  // #general and the app channels are one section, and one filter (#2783).
  if (filter === 'channels') return kind === 'channel' || kind === 'app';
  // A session is an agent conversation (#2770), and so is a conversation
  // with the Mayor (#2779): Agents admits all three.
  return kind === 'agent' || kind === 'session' || kind === 'mayor';
}

function stamp(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/** Newest first; a row with no clock last. Stable within a timestamp. */
function byClock(a: InboxEntry, b: InboxEntry): number {
  const diff = stamp(b.at) - stamp(a.at);
  return Number.isNaN(diff) ? 0 : diff;
}

/**
 * Merge the lists into one, filtered: the chats newest first, then the
 * channels — #general, then the app channels newest first.
 *
 * The caller keeps its own arrays — this returns descriptors, not rows, so
 * each kind is still drawn by the component that knows how, and each entry
 * says which section it belongs to so the view can head them.
 *
 * A conversation whose kind is `channel` (#general) is a channel, not a
 * person, however it arrived.
 */
export function buildInbox(input: {
  conversations: Array<{ id: number; lastActivityAt: string; kind?: string }>;
  discussions: AppDiscussion[];
  agents: AgentChat[];
  /** Optional so a caller with no Improve store still merges three kinds. */
  sessions?: AgentSession[];
  /** Agent sessions (#2779), newest activity first like everything else. */
  mayors?: Array<{ id: number; lastActivityAt: string | null }>;
  filter: InboxFilter;
}): InboxEntry[] {
  const chats: InboxEntry[] = [];
  const rooms: InboxEntry[] = [];
  const apps: InboxEntry[] = [];
  for (const item of input.conversations) {
    if (item.kind === 'channel') {
      if (admits(input.filter, 'channel')) {
        rooms.push({ key: `channel:${item.id}`, kind: 'channel', section: 'channels', at: item.lastActivityAt });
      }
    } else if (admits(input.filter, 'person')) {
      chats.push({ key: `person:${item.id}`, kind: 'person', section: 'chats', at: item.lastActivityAt });
    }
  }
  if (admits(input.filter, 'app')) {
    for (const item of input.discussions) {
      apps.push({
        key: `app:${item.slug}`,
        kind: 'app',
        section: 'channels',
        at: item.lastAt,
        group: item.yours === false ? 'more' : 'yours',
      });
    }
  }
  if (admits(input.filter, 'agent')) {
    for (const item of input.agents) {
      chats.push({
        key: `agent:${item.id}`,
        kind: 'agent',
        section: 'chats',
        at: item.updatedAt || item.createdAt || null,
      });
    }
  }
  if (admits(input.filter, 'session')) {
    for (const item of input.sessions || []) {
      chats.push({ key: `session:${item.key}`, kind: 'session', section: 'chats', at: item.lastActivityAt || null });
    }
  }
  if (admits(input.filter, 'mayor')) {
    for (const item of input.mayors || []) {
      chats.push({ key: `mayor:${item.id}`, kind: 'mayor', section: 'chats', at: item.lastActivityAt || null });
    }
  }
  // Stable within a timestamp: `sort` is stable in every engine this ships
  // to, so two rows that happened in the same second keep the order their
  // own source gave them — which for conversations is the server's.
  apps.sort(byClock);
  return [
    ...chats.sort(byClock),
    ...rooms,
    ...apps.filter((e) => e.group === 'yours'),
    ...apps.filter((e) => e.group === 'more'),
  ];
}

/**
 * Fold the app channels outside Your apps under a toggle (#2967).
 *
 * Returns the entries to DRAW, the key of the row the toggle follows (null:
 * no toggle), and how many rows it holds. Nothing folds when:
 *
 *   - there are no other channels, or no channels of the viewer's own: a
 *     list that is ALL "other" is drawn as it is, because hiding every
 *     channel behind a toggle would leave a heading over nothing;
 *   - a search is running: a match hidden behind a toggle is a match the
 *     reader was told does not exist.
 *
 * The open channel is never hidden. Collapsed, a folded channel that is the
 * one on screen is LIFTED to sit after the viewer's own, rather than the
 * whole group auto-expanding: the toggle keeps meaning what it says, and the
 * row the reader is in stays under their finger. (App channels carry no
 * unread count — chat_messages has no read cursor — and #general, which does,
 * never folds, so "open" is the only thing that can need lifting.)
 */
export function collapseChannels(
  entries: InboxEntry[],
  opts: { expanded: boolean; keep?: string | null; searching?: boolean },
): { entries: InboxEntry[]; toggleAfter: string | null; hidden: number } {
  const more = entries.filter((e) => e.group === 'more');
  let lastYours: InboxEntry | null = null;
  for (const e of entries) if (e.group === 'yours') lastYours = e;
  if (!more.length || !lastYours || opts.searching) return { entries, toggleAfter: null, hidden: 0 };
  if (opts.expanded) return { entries, toggleAfter: lastYours.key, hidden: more.length };
  const lifted = more.find((e) => e.key === opts.keep) || null;
  const hidden = more.length - (lifted ? 1 : 0);
  return {
    entries: entries.filter((e) => e.group !== 'more' || e === lifted),
    toggleAfter: hidden ? (lifted || lastYours).key : null,
    hidden,
  };
}
