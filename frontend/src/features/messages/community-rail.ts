/**
 * THE RAIL BESIDE MESSAGES (#6992).
 *
 * Messages lists people. It also knows, already, which communities the viewer
 * is in: `GET /api/messages/app-discussions` fills `snap.discussions`
 * (./inbox.ts, store.ts), and #general is a `channel` conversation in
 * `snap.conversations`. This module turns those two lists into the rail down
 * the screen's left side and, from a picked community, into the channels its
 * drawer lists.
 *
 * ── What it does NOT change ───────────────────────────────────────────
 *
 * A channel still lives where it lived: #general is a conversation on this
 * screen, and each topic is a place on its project's page (places.ts
 * `channelPlace`, `placeHref`). Opening a topic from the drawer follows the
 * same address the Hub follows. No new server route and no new storage.
 *
 * Pure, so the test drives it with arrays rather than a store.
 */

import type { PlacesPayload } from '../dev-board/workshop/community-card';
import { channelPlace, liveTopics, placeHref } from '../dev-board/workshop/places';
import type { AppDiscussion } from './inbox';
import type { ConversationSummary } from './types';

/** The device's remembered pick, the way `usernode:messages-query` is remembered. */
export const RAIL_KEY = 'usernode:messages-rail';

/** Longest key this module accepts back out of storage. */
const KEY_MAX = 160;

export interface RailEntry {
  /** `dm`, `homeroom`, or `app:<slug>`. */
  key: string;
  kind: 'dm' | 'homeroom' | 'app';
  /** The community's slug; absent for Direct messages. */
  slug?: string;
  /** The community's name; empty for Direct messages, which the screen words. */
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  /**
   * #general's address on this screen, the last thing said there and what is
   * new. Null only for Direct messages.
   */
  general: { target: string; preview: string; unread: number } | null;
  /** Everything new in this community: what its badge shows. */
  unread: number;
}

export interface ChannelRow {
  key: string;
  kind: 'general' | 'topic';
  handle: string;
  name: string;
  /** The `#` tile's glyph: `#`, or the topic's own icon. */
  icon: string;
  /** The row's second line. */
  preview: string;
  unread: number;
  /** The address pressing the row follows. */
  target: string;
}

const count = (n: unknown): number => {
  const value = Number(n);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
};

/** `/app/<slug>/...` from places.ts, as an address this hash router follows. */
function hashHref(path: string): string {
  return `#${String(path || '').replace(/^\/+/, '')}`;
}

/**
 * The rail's buttons: Direct messages first, then Homeroom, then every
 * community in the order the server sent them (the viewer's own projects
 * first). A discussion for the platform's own project is skipped: Homeroom's
 * entry is the `channel` conversation, which is the room #general actually
 * is on this screen.
 */
export function railEntries(input: {
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'kind' | 'homeroomBot' | 'title' | 'unreadCount' | 'latestSummary'>>;
  discussions: ReadonlyArray<AppDiscussion>;
  platformSlug: string | null;
}): RailEntry[] {
  const out: RailEntry[] = [
    { key: 'dm', kind: 'dm', name: '', iconUrl: null, iconEmoji: null, general: null, unread: 0 },
  ];
  const general = input.conversations.find((item) => item.kind === 'channel');
  const platform = input.platformSlug || null;
  if (general && platform) {
    const unread = count(general.unreadCount);
    out.push({
      key: 'homeroom',
      kind: 'homeroom',
      slug: platform,
      name: 'Homeroom',
      iconUrl: null,
      iconEmoji: null,
      general: {
        target: `#messages/${general.id}`,
        preview: general.latestSummary || '',
        unread,
      },
      unread,
    });
  }
  for (const item of input.discussions) {
    if (!item.slug || item.slug === platform) continue;
    const unread = count(item.unreadCount);
    out.push({
      key: `app:${item.slug}`,
      kind: 'app',
      slug: item.slug,
      name: item.name || item.slug,
      iconUrl: item.iconUrl || null,
      iconEmoji: item.iconEmoji || null,
      general: {
        target: `#messages/app/${encodeURIComponent(item.slug)}`,
        preview: item.lastMessage || '',
        unread,
      },
      unread,
    });
  }
  return out;
}

/**
 * The channels one community's drawer lists: #general first, then its live
 * topics in dapp.json's order. A muted channel says nothing new, so it shows
 * no count; retired topics are not listed at all (they stay readable on the
 * project's page). `query` narrows by name or handle, case-insensitively.
 */
export function channelRows(
  entry: Pick<RailEntry, 'key' | 'slug' | 'general'>,
  places: PlacesPayload | null | undefined,
  query = '',
): ChannelRow[] {
  const rows: ChannelRow[] = [];
  if (entry.general) {
    rows.push({
      key: `${entry.key}:general`,
      kind: 'general',
      handle: 'general',
      name: 'general',
      icon: '#',
      preview: entry.general.preview,
      unread: count(entry.general.unread),
      target: entry.general.target,
    });
  }
  if (entry.slug) {
    for (const topic of liveTopics(places)) {
      if (!topic.handle || topic.handle === 'general') continue;
      rows.push({
        key: `${entry.key}:${topic.handle}`,
        kind: 'topic',
        handle: topic.handle,
        name: topic.name || topic.handle,
        icon: topic.icon || '#',
        preview: `#${topic.handle}`,
        unread: topic.muted ? 0 : count(topic.unread),
        target: hashHref(placeHref(entry.slug, channelPlace(topic.handle))),
      });
    }
  }
  const q = String(query || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => row.name.toLowerCase().includes(q) || row.handle.toLowerCase().includes(q));
}

/**
 * The remembered pick, when the rail still has a button for it. A project the
 * person has left leaves a key nothing answers to, and that is rejected so
 * the default applies instead of a dead selection.
 */
export function savedRailPick(
  raw: string | null | undefined,
  entries: ReadonlyArray<{ key: string }>,
): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > KEY_MAX) return null;
  return entries.some((entry) => entry.key === raw) ? raw : null;
}

/**
 * Where Messages opens with nothing remembered: Direct messages when there is
 * someone to read, and otherwise Homeroom's channels — an empty "No messages
 * yet" card is not a place to land when the product's own room is one tap
 * away.
 */
export function defaultRailPick(
  peopleCount: number,
  entries: ReadonlyArray<{ key: string; kind: string }>,
): string {
  if (count(peopleCount) > 0) return 'dm';
  const homeroom = entries.find((entry) => entry.kind === 'homeroom');
  return homeroom ? homeroom.key : 'dm';
}

/** What a badge says: nothing at zero, `99+` past ninety-nine. */
export function railUnreadShown(n: number): string {
  const value = count(n);
  if (!value) return '';
  return value > 99 ? '99+' : String(value);
}
