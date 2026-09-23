/**
 * The desktop rail's Recents, as one list (#2802).
 *
 * "What was I just doing" has two kinds of answer on this platform: an app
 * you stepped out of, and a conversation — a DM, a group chat, a channel or
 * an agent chat. The rail used to answer the first with a single Resume strip
 * at its foot and left the second to the Messages tab. This merges both onto
 * ONE clock, newest first, and keeps the first few.
 *
 * NOT ../messages/inbox.ts's order. The inbox puts channels in a section of
 * their own after the chats (#2783), because a channel is a room you visit
 * rather than a thread waiting on you. A recents list is a history, so a
 * channel you were just in sits exactly where its clock says.
 *
 * PURE ON PURPOSE, for the reason inbox.ts is: the order and the cut are the
 * whole argument, and a test should drive them with plain arrays.
 */

import type { AgentChat, AppDiscussion } from '../messages/inbox';

/** An app you left, as ./recent-apps-store.js keeps it. */
export interface RecentApp {
  slug: string;
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  at: string;
}

export type RecentKind = 'app' | 'direct' | 'group' | 'channel' | 'agent';

export interface RecentItem {
  /** Unique across kinds: the kind is part of it. */
  key: string;
  kind: RecentKind;
  label: string;
  /** Where the row goes. Apps resume through the router instead, but keep a
   *  real address so a modified click opens a tab. */
  href: string;
  /** ISO, or null when the source has no clock. */
  at: string | null;
  unread: boolean;
  /** Only for `app`: what the tile draws and what resuming opens. */
  app?: { slug: string; name: string; iconUrl: string | null; iconEmoji: string | null };
}

/** The part of a conversation summary the merge reads. */
export interface RecentConversation {
  id: number;
  kind: 'direct' | 'group' | 'channel';
  title: string;
  lastActivityAt: string;
  unreadCount: number;
  archived?: boolean;
  channelKey?: string | null;
  peer?: { id: number; username: string } | null;
  members?: Array<{ id: number; username: string }>;
}

/** How many rows the rail shows. */
export const RECENTS_LIMIT = 8;

function stamp(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

function directLabel(item: RecentConversation, viewerId: number | null): string {
  const peer = item.peer
    || (item.members || []).find((member) => Number(member.id) !== viewerId)
    || null;
  return peer?.username ? `@${peer.username}` : item.title;
}

export function buildRecents(input: {
  apps: RecentApp[];
  conversations: RecentConversation[];
  discussions: AppDiscussion[];
  agents: AgentChat[];
  viewerId?: number | null;
  limit?: number;
}): RecentItem[] {
  const viewerId = input.viewerId ?? null;
  const items: RecentItem[] = [];
  for (const app of input.apps) {
    items.push({
      key: `app:${app.slug}`,
      kind: 'app',
      label: app.name,
      href: `/app/${encodeURIComponent(app.slug)}`,
      at: app.at || null,
      unread: false,
      app: { slug: app.slug, name: app.name, iconUrl: app.iconUrl, iconEmoji: app.iconEmoji },
    });
  }
  for (const item of input.conversations) {
    // An archived conversation is one the viewer put away; it is not recent
    // in any sense they would recognise.
    if (item.archived) continue;
    const kind: RecentKind = item.kind === 'channel' ? 'channel' : item.kind === 'group' ? 'group' : 'direct';
    items.push({
      key: `conversation:${item.id}`,
      kind,
      label: kind === 'channel'
        ? `#${item.channelKey || item.title}`
        : kind === 'direct' ? directLabel(item, viewerId) : item.title,
      href: `#messages/${item.id}`,
      at: item.lastActivityAt || null,
      unread: item.unreadCount > 0,
    });
  }
  // An app's channel carries no unread count: `chat_messages` has no
  // per-viewer read cursor (../messages/index.tsx, AppChannelRow). A channel
  // nobody has spoken in has no clock, so nothing happened there recently
  // and it is left out rather than padding the list.
  for (const item of input.discussions) {
    if (!item.lastAt) continue;
    items.push({
      key: `discussion:${item.slug}`,
      kind: 'channel',
      label: `#${item.channel || item.slug}`,
      href: `#messages/app/${encodeURIComponent(item.slug)}`,
      at: item.lastAt,
      unread: false,
    });
  }
  for (const item of input.agents) {
    items.push({
      key: `agent:${item.id}`,
      kind: 'agent',
      label: item.title || 'Untitled chat',
      href: `#chat/${encodeURIComponent(item.id)}`,
      at: item.updatedAt || item.createdAt || null,
      unread: false,
    });
  }
  return pick(items, input.limit);
}

/** Newest first, a row with no clock last, stable within a timestamp. */
function pick(items: RecentItem[], limit = RECENTS_LIMIT): RecentItem[] {
  return items
    .slice()
    .sort((a, b) => {
      const diff = stamp(b.at) - stamp(a.at);
      return Number.isNaN(diff) ? 0 : diff;
    })
    .slice(0, limit);
}
