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
 * after them as their own section. A channel is a room you visit, not a
 * conversation waiting on you, so it does not jump over a DM because
 * somebody said something in it.
 *
 * ── App channels live on their project's page now (communities) ───────
 *
 * The section holds #general and nothing else. An app's channel is its
 * community's room, so it moved to where the community is — the community
 * card on that project's Workshop page
 * (features/dev-board/workshop/community-card.tsx), reached from the
 * Workshop tab's list of your communities — and Messages is people and
 * agents. The channel's own address, `#messages/app/<slug>`, still opens
 * here; it is the LIST that no longer carries a row per app. The discussions
 * are still loaded (channels.ts builds the #mention directory from them, and
 * the new-agent dialog picks its app from them); they are not merged here.
 *
 * The #2967 split of app channels into Your apps and "Show more" went with
 * them.
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
}

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
  /** #2967: one of Your apps, or another app the viewer has been active in. */
  section?: 'yours' | 'more';
  /** #2387: general-chat messages from others since the viewer last read it. */
  unreadCount?: number;
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
  // #general is the channels section (#2783). `app` stays admitted for the
  // one app channel a deep link has open (`openApp` in buildInbox).
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
 * channels — #general (see the header for where the app channels went).
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
  /**
   * The app channel open at `#messages/app/<slug>`, if one is. It is listed
   * under #general while it is open, so the list beside the thread still
   * says where you are; closing it takes the row away again.
   */
  openApp?: AppDiscussion | null;
  agents: AgentChat[];
  /** Optional so a caller with no Improve store still merges three kinds. */
  sessions?: AgentSession[];
  /** Agent sessions (#2779), newest activity first like everything else. */
  mayors?: Array<{ id: number; lastActivityAt: string | null }>;
  filter: InboxFilter;
}): InboxEntry[] {
  const chats: InboxEntry[] = [];
  const rooms: InboxEntry[] = [];
  for (const item of input.conversations) {
    if (item.kind === 'channel') {
      if (admits(input.filter, 'channel')) {
        rooms.push({ key: `channel:${item.id}`, kind: 'channel', section: 'channels', at: item.lastActivityAt });
      }
    } else if (admits(input.filter, 'person')) {
      chats.push({ key: `person:${item.id}`, kind: 'person', section: 'chats', at: item.lastActivityAt });
    }
  }
  if (input.openApp && admits(input.filter, 'app')) {
    rooms.push({ key: `app:${input.openApp.slug}`, kind: 'app', section: 'channels', at: input.openApp.lastAt });
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
  return [...chats.sort(byClock), ...rooms];
}
