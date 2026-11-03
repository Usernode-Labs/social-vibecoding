/**
 * THE HOMEROOM BOT TAB'S HEADER ON A PHONE (Evan, 3 Nov 2026: "simplify on
 * mobile").
 *
 * Under 768px the bot tab is two levels (../ai/phone-drawer.tsx): the list,
 * the whole screen, then Main Chat, the whole screen to its right. Main Chat
 * drew a bar of its own under the platform's ("Homeroom bot" over "‹ Main
 * Chat"), two headers for one screen. Now the platform's header draws it,
 * as it draws a Messages conversation (./messages-drawer.ts): on the list
 * "Homeroom bot", on Main Chat the arrow and "Main Chat" over "Only you can
 * see this chat", moving with the strip.
 *
 * The bot screen publishes here while it is on show on a phone with Main
 * Chat's column (a private thread draws its own head, with its own arrow,
 * and keeps the platform's title). No colour: the tab is not a community's.
 */

import { createStore } from '../../lib/plain-store.js';
import { createDepthChannel } from './drawer-store';

export interface BotDrawerState {
  /** The header is the bot tab's: a phone, the tab on show, Main Chat's column. */
  on: boolean;
  /** 0, the list; 1, Main Chat. */
  level: 0 | 1;
  /** What the header names on level 1, and the line under it. */
  title: string;
  sub: string;
}

export const botDrawerStore = createStore<BotDrawerState>({ on: false, level: 0, title: '', sub: '' });

/** The header's depth: 0 on the list, 1 on Main Chat. */
export const botDepth = createDepthChannel(0, 1);

let goBack: (() => void) | null = null;

/** The bot screen says how its arrow goes back, while it is mounted. Returns the undo. */
export function registerBotBack(fn: () => void): () => void {
  goBack = fn;
  return () => { if (goBack === fn) goBack = null; };
}

/** The header's arrow on Main Chat: back to the list. */
export function botBack(): void {
  goBack?.();
}

export function publishBotDrawer(next: BotDrawerState): void {
  const was = botDrawerStore.get();
  if (was.on === next.on && was.level === next.level && was.title === next.title && was.sub === next.sub) return;
  botDrawerStore.set(next);
}
