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
 * A conversation with people. Not a channel, which belongs to its
 * community; or a reply thread, which is a level over its conversation with
 * its own header. Those keep the screen as it was.
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
  /** The drawer holds the route: a phone, and the list or a conversation. */
  on: boolean;
  /** 0, the list; 1, a conversation. */
  level: 0 | 1;
  /** The conversation the header names on level 1. */
  title: string;
  /** Who it is with, under its name. */
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
  threadRootId: number | null | undefined;
  embedded?: boolean;
  /** The open conversation's kind, once it is known. */
  activeKind?: string | null;
  /** #6019: the open conversation is the chat with Homeroom bot, the AI tab's Main. */
  bot?: boolean;
}): boolean {
  if (!at.phone || !at.open || at.embedded) return false;
  if (at.appSlug || at.threadRootId) return false;
  if (at.conversationId && at.activeKind === 'channel') return false;
  // Main is the AI tab's, a level under its own page, not one of the inbox's
  // conversations: its way back is the AI tab, not a pan to the inbox.
  if (at.conversationId && at.bot) return false;
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

/**
 * THE CONVERSATION'S DISCS IN THE BAR (phone review #131, 23 Nov 2026).
 * In a conversation on the drawer the bar names it, and its members and ⋯
 * discs sit in the bar beside the bell instead of floating over the first
 * message (header-drawer.tsx ChatBarSlot renders the host, the thread's
 * header portals its discs into it). Null whenever no conversation is open
 * on the drawer, and so in the prerender.
 */
export const chatBarStore = createStore<{ host: HTMLElement | null }>({ host: null });

export function publishChatBarHost(host: HTMLElement | null): void {
  if (chatBarStore.get().host === host) return;
  chatBarStore.set({ host });
}
