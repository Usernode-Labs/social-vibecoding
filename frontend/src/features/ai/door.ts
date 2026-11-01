/**
 * THE WAY INTO HOMEROOM BOT'S CHAT (1 Nov 2026). The chat with the bot lives
 * on its tab only (./index.tsx): its list, and the column beside it with Main
 * Chat or one thread. It used to be a conversation of the Messages screen as
 * well, where a thread opened beside Main; that copy is gone. So every door
 * into the chat lands here and says where in it:
 *
 *   #homeroom-bot/main                  Main Chat
 *   #homeroom-bot/thread/<id>           a thread of it, alone in the column
 *   …either with /m/<id>                at that message
 *
 * The router (public/js/app.js) shows the tab and hands the place to
 * `askBotTab`, which the page takes once, in its column. A Messages address of
 * the bot's chat (`#messages/<id>`, with its `/thread/<id>` and `/m/<id>`
 * forms: a bell row, an email, a bookmark) is the same place, by its old
 * address: the router and the Messages store swap it for the tab's
 * (`botTabFromMessages`), in place.
 *
 * Which conversation is the bot's is noted here by whoever learns it first
 * (the tab, opening it; the Messages store, reading the list), so the router
 * and the side panel can tell it from any other chat without a store of
 * their own.
 *
 * Pure but for that small state; no React beyond one hook.
 */

import { useSyncExternalStore } from 'react';

/** A place in the chat: Main (no thread) or a thread, and a message in it to land on. */
export interface BotAt {
  threadRootId: number | null;
  focusMessageId: number | null;
}

/** The tab's own page: what its Homeroom bot tab links to. */
export const BOT_TAB = '#homeroom-bot';

function valid(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 2147483647;
}

/** Pure: a place with anything that is not a message id taken out. */
export function cleanAt(at: Partial<BotAt> | null | undefined): BotAt {
  const root = valid(at?.threadRootId) ? at!.threadRootId as number : null;
  const focus = valid(at?.focusMessageId) && at!.focusMessageId !== root ? at!.focusMessageId as number : null;
  return { threadRootId: root, focusMessageId: focus };
}

/** Pure: the tab's address for a place in the chat. */
export function botTabAddress(at: Partial<BotAt> | null | undefined): string {
  const { threadRootId, focusMessageId } = cleanAt(at);
  const base = threadRootId ? `${BOT_TAB}/thread/${threadRootId}` : `${BOT_TAB}/main`;
  return focusMessageId ? `${base}/m/${focusMessageId}` : base;
}

/**
 * Pure: the place a `#homeroom-bot/…` address names, or null for the page
 * itself (`#homeroom-bot`) and anything else.
 */
export function botTabAt(hash: string | null | undefined): BotAt | null {
  const parts = String(hash || '').replace(/^#/, '').split('?')[0].split('/');
  if (parts[0] !== 'homeroom-bot' && parts[0] !== 'ai') return null;
  const rest = parts[1] === 'main' ? parts.slice(2) : parts.slice(1);
  if (parts[1] !== 'main' && parts[1] !== 'thread' && parts[1] !== 'm') return null;
  const out: Partial<BotAt> = {};
  for (let i = 0; i + 1 < rest.length; i += 2) {
    const id = /^\d{1,10}$/.test(rest[i + 1]) ? Number(rest[i + 1]) : NaN;
    if (rest[i] === 'thread') out.threadRootId = id;
    else if (rest[i] === 'm') out.focusMessageId = id;
  }
  return cleanAt(out);
}

/**
 * Pure: the tab's address for a Messages address of the bot's chat `botId`
 * (`#messages/<id>`, `/thread/<root>`, `/m/<id>`, the two together), or null
 * for any other address, or while which chat is the bot's is not known.
 */
export function botTabFromMessages(href: string | null | undefined, botId: number | null | undefined): string | null {
  if (!valid(botId)) return null;
  const match = /^#?messages\/(\d{1,10})((?:\/(?:thread|m)\/\d{1,10})*)\/?(?:\?.*)?$/.exec(String(href || ''));
  if (!match || Number(match[1]) !== botId) return null;
  const at: Partial<BotAt> = {};
  const rest = match[2].split('/').filter(Boolean);
  for (let i = 0; i + 1 < rest.length; i += 2) {
    if (rest[i] === 'thread') at.threadRootId = Number(rest[i + 1]);
    else if (rest[i] === 'm') at.focusMessageId = Number(rest[i + 1]);
  }
  return botTabAddress(at);
}

// ── Which conversation is the bot's ─────────────────────────────────────

let botConversation: number | null = null;

/** Note the signed-in person's chat with the bot, once anything has read it. */
export function noteBotConversation(id: number | null | undefined): void {
  if (valid(id)) botConversation = id;
}

/** The person's chat with the bot, when something has said which it is. */
export function knownBotConversation(): number | null {
  return botConversation;
}

/** Pure: whether a side panel route (`messages/<id>…`) is the chat with the bot, which only its tab draws. */
export function isBotChatRoute(route: string | null | undefined, botId: number | null | undefined = botConversation): boolean {
  if (!valid(botId)) return false;
  const match = /^messages\/(\d{1,10})(?:[/?]|$)/.exec(String(route || ''));
  return !!match && Number(match[1]) === botId;
}

// ── Where the router asked the tab to go ────────────────────────────────

let asked: { at: BotAt; seq: number } | null = null;
let seq = 0;
const listeners = new Set<() => void>();

/** The router's half: show this place in the tab's column (the page takes it once). */
export function askBotTab(at: Partial<BotAt> | null | undefined): void {
  seq += 1;
  asked = { at: cleanAt(at), seq };
  listeners.forEach((fn) => fn());
}

/** What the router last asked, with its count, so a page takes each ask once. */
export function useBotTabAsk(): { at: BotAt; seq: number } | null {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => asked,
    () => null,
  );
}

/**
 * Go to the tab at `at`, by its address, through the router: when the
 * address is already the one in the bar the router runs on it again, so the
 * place is taken even then (as Messages' openAddress does).
 */
export function openBotTab(at: Partial<BotAt> | null | undefined): void {
  goBotAddress(botTabAddress(at));
}

/** The same, for one of the tab's addresses as it is (`#homeroom-bot`, or a place in its chat). */
export function goBotAddress(href: string): void {
  if (typeof window === 'undefined' || !/^#homeroom-bot(?:\/|$)/.test(href)) return;
  if (window.location.hash !== href) { window.location.hash = href; return; }
  (window as { App?: { restoreFromHash?: () => void } }).App?.restoreFromHash?.();
}

if (typeof window !== 'undefined') {
  const host = ((window as any).UsernodeReact ||= {});
  host.ai = { ...(host.ai || {}), openAt: askBotTab, botTabFromMessages: (href: string) => botTabFromMessages(href, botConversation) };
}
