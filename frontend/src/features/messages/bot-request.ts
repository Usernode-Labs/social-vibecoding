/*
 * One request, one story: which request a piece of the bot's news or a tray
 * entry is about, and the colour its number wears. Shared by the activity
 * drawer (./bot-strip.tsx), the chat's news rows (./bot-news-line.tsx) and
 * the bot's own words (./format.tsx), with no imports but types, so any of
 * them can read it.
 */

import type { ConversationMessage } from './types';

/**
 * The hue a request's number wears: eight picked to tell apart at a glance,
 * in an order where each is far from the next, so any eight requests in a row
 * all differ and neighbours contrast. Amber (the need colour) and blue
 * (actions) are not among them, so a tag never reads as either.
 */
const TAG_HUES = [350, 145, 265, 85, 322, 180, 20, 295];
export function requestHue(number: number): number {
  return TAG_HUES[((Math.trunc(number) % TAG_HUES.length) + TAG_HUES.length) % TAG_HUES.length];
}

/**
 * Which request something is about, as one key: its project, by the name the
 * person sees, and its number, or its first version. Null when it names no
 * request, and then nothing is folded or matched on it.
 */
export function requestKey(item: { appSlug?: string | null; appName?: string | null; issueNumber?: number | null; firstVersion?: boolean | null }): string | null {
  const project = String(item.appName || item.appSlug || '').trim().toLowerCase();
  if (!project) return null;
  if (item.firstVersion) return `${project}|first`;
  const n = Number(item.issueNumber);
  return Number.isInteger(n) && n > 0 ? `${project}|${n}` : null;
}

/** The bot's own messages that are conversation, never news: they stay messages. */
const CONVERSATION_KINDS = new Set([
  'chat', 'ack', 'reply', 'confirm', 'hello', 'welcome', 'tour', 'joiner', 'maker', 'member', 'general',
  'hello_welcome', 'hello_tour', 'hello_joiner', 'hello_maker', 'filed', 'withdraw_proposal', 'close_request', 'move_request', 'unknown',
]);

/** Pure: whether a message in the chat with the bot is news about a request, drawn as one line. */
export function isBotNews(message: ConversationMessage): boolean {
  const meta = message.sender.bot ? message.metadata?.homeroomBot : null;
  if (!meta || typeof meta !== 'object' || message.deleted || !(message.id > 0)) return false;
  if (meta.moment === 'reply' || CONVERSATION_KINDS.has(meta.kind)) return false;
  return (Number(meta.issueNumber) > 0) || !!meta.firstVersion || meta.kind === 'activity';
}

/**
 * Pure: the message a request's story opens on, read from the main stream:
 * its thread's root, else (news from before threads) its oldest piece, which
 * the story pane draws with the pieces after it. Null when the chat holds
 * nothing about it.
 */
export function storyRootIn(messages: readonly ConversationMessage[], key: string | null): number | null {
  if (!key) return null;
  let oldest: number | null = null;
  for (const message of messages) {
    if (!isBotNews(message)) continue;
    const meta = message.metadata?.homeroomBot;
    if (!meta || requestKey(meta) !== key) continue;
    if (message.threadRootId) return message.threadRootId;
    if (meta.kind === 'activity' && message.thread) return message.id;
    if (oldest === null) oldest = message.id;
  }
  return oldest;
}
