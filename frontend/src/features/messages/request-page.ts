/*
 * A request's story is its own page (31 Oct 2026, from the review of how
 * threads show). In the chat with Homeroom bot, the bot's news about a
 * request used to open a thread of the chat's own beside it: the request's
 * card again, its updates, and a box to "Reply about this request…". That
 * was a second view of a thread that already has one, the request's public
 * page, and it was reachable from nowhere else: not the bot page's list of
 * threads. So a thread in this chat is only one the person started (or one
 * the bot opened for them, which the list shows with a lock), and
 * everything about a request opens the request's page: beside the bot page
 * on a desktop, in its column (the side panel, as the list's rows do), else
 * the page itself.
 *
 * A project's first version is not a request's story (15 Nov 2026). Its
 * news used to stand for the project's hub here, which was right while that
 * news was a line of Main Chat. Since 14 Nov 2026 it is the first message of
 * a thread the bot page lists ("Plant Pal, first version"): the one a
 * person's old Main Chat messages were listed as (services/earlier-chat.js),
 * or the one a first version's own notice opens (homeroom-bot-dm.js
 * placeFor). Standing for the hub, that thread closed as it opened and the
 * project's hub came up in its place, so it could never be read. It stands
 * for no page, as the server has it (conversations.js isRequestNewsMeta: a
 * first version "has no request page yet").
 */

import { t } from '../../lib/i18n/runtime';
import type { ConversationMessage } from './types';

export interface RequestPage {
  /** The page's address, without its '#'. */
  route: string;
  /** What the page is called over it beside the bot page. */
  label: string;
  /** Its project, as the side panel's header names it. */
  place: { slug: string; name: string };
  /** The request's number. */
  issueNumber: number;
}

/** What a request is known by: a bot message's metadata, or a tray job. */
export interface RequestAbout {
  appSlug?: string | null;
  appName?: string | null;
  issueNumber?: number | null;
  firstVersion?: boolean | null;
  title?: string | null;
}

/**
 * Pure: the page a request's story opens on, the request's own. Null when it
 * names no request, and for a project's first version: its number (1, under
 * its own project) is not a request's, and its story is its thread.
 */
export function requestPage(about: RequestAbout | null | undefined): RequestPage | null {
  const slug = String(about?.appSlug || '').trim();
  if (!slug) return null;
  const name = String(about?.appName || '').trim() || slug;
  const app = encodeURIComponent(slug);
  if (about?.firstVersion) return null;
  const number = Number(about?.issueNumber);
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    route: `app/${app}/dev/issues/${number}`,
    label: String(about?.title || '').trim() || t('messages:bot.activity.requestNumber', { number: String(number) }),
    place: { slug, name },
    issueNumber: number,
  };
}

/**
 * Pure: the page a bot message about a request stands for, or null for
 * anything else. The bot's own private threads (a draft it opened for the
 * person, a design thread) start on a message of the bot's too: those are
 * the person's threads, listed on the bot page, and stay threads. So does a
 * first version's, whatever its first message is.
 */
export function requestPageOf(message: ConversationMessage | null | undefined): RequestPage | null {
  if (!message?.sender?.bot) return null;
  const meta = message.metadata?.homeroomBot;
  if (!meta || typeof meta !== 'object' || String(meta.kind || '').startsWith('opened_')) return null;
  return requestPage({
    appSlug: meta.appSlug,
    appName: meta.appName,
    issueNumber: meta.issueNumber,
    firstVersion: meta.firstVersion,
    title: meta.requestTitle || meta.issueTitle || null,
  });
}

/**
 * Open a request's page from the chat with the bot. Beside the bot page on a
 * desktop the side panel takes it, in the page's column (as the list's rows
 * do: features/ai/); anywhere else the page itself, which goes back to where
 * it was opened from.
 */
export function openRequestPage(page: RequestPage): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  try {
    if (w.UsernodeReact?.sidePanel?.take?.(page.route, { place: page.place, label: page.label })) return;
  } catch {
    /* the page instead */
  }
  try {
    w.Improve?.enterTopicFrom?.(window.location.hash || '#homeroom-bot');
  } catch {
    /* the page opens all the same */
  }
  window.location.hash = page.route;
}
