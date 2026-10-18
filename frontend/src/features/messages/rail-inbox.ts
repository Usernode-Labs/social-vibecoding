/**
 * THE CONVERSATIONS UNDER MESSAGES, in the desktop's sidebar of rows (v3,
 * 18 Oct 2026; ../nav/rail-conversations.tsx draws them).
 *
 * From 1024px the conversation list does not stand beside the conversation:
 * the sidebar nests the five most recent under the Messages row, under the
 * inbox's own two headings (Agents, People), then All messages, which is the
 * full list with its search and previews (the list pane, drawn as the page).
 *
 * WHICH FIVE. The Homeroom bot's chat first, as the inbox pins it, then the
 * four most recently active across both sections, so a busy week of agent
 * chats cannot push every person out. The one you have open stays while it
 * is open, a sixth row if it is not among them, so the row you are on is
 * always in the sidebar. Grouped back into the inbox's order to be drawn.
 *
 * The list's own module works the rows out (./index.tsx ConversationList,
 * which already holds every source the inbox merges) and publishes them
 * here, so the sidebar draws plain data and nothing is fetched twice.
 */

import type { ReactNode } from 'react';

import { createStore } from '../../lib/plain-store.js';
import { INBOX_SECTIONS, type InboxSection } from './inbox';

/** How many conversations the sidebar nests under Messages. */
export const RAIL_CONVERSATIONS = 5;

export interface RailConversation {
  key: string;
  section: InboxSection;
  href: string;
  name: string;
  /** Unread messages from people, which the row counts. */
  unread: number;
  /** The face or tile the row leads with, drawn by the list's own module. */
  lead: ReactNode;
  /** A press on the row while its address is already the page's. */
  reselect?: () => void;
}

export interface RailInbox {
  rows: RailConversation[];
  /** The row open on screen, if it is one of them. */
  openKey: string | null;
  /** Nothing is open: the list is the page, and All messages is lit. */
  page: boolean;
}

export const railInboxStore = createStore<RailInbox>({ rows: [], openKey: null, page: true });

/**
 * The rows the sidebar nests, in the order it draws them. `entries` is the
 * inbox's merge (./inbox.ts buildInbox: each with its section, its clock and
 * the bot's pin). Pure.
 */
export function railConversations<T extends { key: string; section: InboxSection; at: string | null; pinned?: boolean }>(
  entries: readonly T[],
  openKey: string | null,
  limit = RAIL_CONVERSATIONS,
): T[] {
  const time = (entry: T) => {
    const at = entry.at ? Date.parse(entry.at) : NaN;
    return Number.isFinite(at) ? at : -Infinity;
  };
  const pinned = entries.filter((entry) => entry.pinned);
  const rest = entries.filter((entry) => !entry.pinned).sort((a, b) => time(b) - time(a));
  const picked = [...pinned, ...rest].slice(0, limit);
  const open = openKey ? entries.find((entry) => entry.key === openKey) : undefined;
  if (open && !picked.includes(open)) picked.push(open);
  // Back in the inbox's own order: its sections, and within one its clock.
  return INBOX_SECTIONS.flatMap((section) => entries.filter((entry) => entry.section === section && picked.includes(entry)));
}

/** The list's module says what the sidebar draws, when it changes. */
export function publishRailInbox(next: RailInbox): void {
  const was = railInboxStore.get();
  const same = was.openKey === next.openKey && was.page === next.page
    && was.rows.length === next.rows.length
    && was.rows.every((row, i) => {
      const other = next.rows[i];
      return row.key === other.key && row.name === other.name && row.unread === other.unread && row.href === other.href;
    });
  if (!same) railInboxStore.set(next);
}
