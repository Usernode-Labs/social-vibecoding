/**
 * MESSAGES ON THE PHONE'S DRAWER (Evan's design, 18 Oct 2026).
 *
 * Under 768px the Messages tab is two levels of the same drawer as
 * Communities (./nav-drawer.tsx): the conversation list at 85% of the
 * screen, the last conversation you had open peeking in at its right, then
 * the conversation, the whole screen. Unlike Communities' levels these two
 * ARE addresses (`#messages` and `#messages/<id>`), so moving between them
 * is a navigation and the drawer follows the route: a row, the peek, the
 * header's arrow and a pan past a quarter of the way all go through
 * `open()` (../messages/store.ts), and the strip slides to wherever the
 * route lands.
 *
 * Only a conversation with people: an agent's chat or session opens on a
 * screen of its own on a phone, a channel belongs to its community, and a
 * reply thread is a level over its conversation with its own header. Those
 * keep the screen as it was.
 *
 * The header (./header-drawer.tsx) draws from this store and its depth: on
 * the list "Messages", in a conversation its name with who it is with under
 * it ("Direct message", "3 members"), the arrow arriving from the right, and
 * the conversation's page draws no name of its own. No colour: Messages is
 * not a community's.
 */

import { createStore } from '../../lib/plain-store.js';
import { createDepthChannel } from './drawer-store';

export interface MessagesDrawerState {
  /** The drawer holds the route: a phone, the list, or a conversation with people. */
  on: boolean;
  /** 0, the list; 1, a conversation. */
  level: 0 | 1;
  /** The conversation the header names on level 1. */
  title: string;
  /** Who it is with, or what the agent does, under its name. */
  sub: string;
}

export const messagesDrawerStore = createStore<MessagesDrawerState>({ on: false, level: 0, title: '', sub: '' });

/** The header's depth: 0 on the list, 1 in a conversation. */
export const messagesDepth = createDepthChannel(0, 1);

/** Whether the drawer holds this route. Pure. */
export function messagesDrawerApplies(at: {
  phone: boolean;
  open: boolean;
  conversationId: number | null | undefined;
  appSlug: string | null | undefined;
  agent: unknown;
  threadRootId: number | null | undefined;
  embedded?: boolean;
  /** The open conversation's kind, once it is known. */
  activeKind?: string | null;
}): boolean {
  if (!at.phone || !at.open || at.embedded) return false;
  if (at.appSlug || at.agent || at.threadRootId) return false;
  if (at.conversationId && at.activeKind === 'channel') return false;
  return true;
}

let goBack: (() => void) | null = null;

/** The Messages screen says how its arrow goes back, while it is mounted. Returns the undo. */
export function registerMessagesBack(fn: () => void): () => void {
  goBack = fn;
  return () => { if (goBack === fn) goBack = null; };
}

/** The header's arrow on a conversation: back to the list. */
export function messagesBack(): void {
  goBack?.();
}

export function publishMessagesDrawer(next: MessagesDrawerState): void {
  const was = messagesDrawerStore.get();
  if (was.on === next.on && was.level === next.level && was.title === next.title && was.sub === next.sub) return;
  messagesDrawerStore.set(next);
}
