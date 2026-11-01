/*
 * A request's story is its own page (31 Oct 2026, from the review of how
 * threads show). In the chat with Homeroom bot, the bot's news about a
 * request used to open a thread of the chat's own beside it: the request's
 * card again, its updates, and a box to "Reply about this request…". That
 * was a second view of a thread that already has one, the request's public
 * page, and it was reachable from nowhere else: not Main Chat, and not the
 * bot page's list of threads. So a thread in this chat is now only one the
 * person started (or a draft the bot opened for them, which the list shows
 * with a lock), and everything about a request opens the request's page:
 * beside the bot page on a desktop, in Main Chat's place (the side panel,
 * as the list's rows do), else the page itself.
 *
 * What still waits on the person in the chat (a question to answer, a plan
 * to build, a button to press) is drawn whole in Main Chat, where they answer
 * it (./bot-news-line.tsx asksInChat), so nothing is left only in a thread.
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
  /** The request, as Main Chat's composer can carry it. Null for a first version. */
  issueNumber: number | null;
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
 * Pure: the page a request's story opens on: the request's own, or for a
 * project's first version (which has no request) the project's hub. Null
 * when it names neither.
 */
export function requestPage(about: RequestAbout | null | undefined): RequestPage | null {
  const slug = String(about?.appSlug || '').trim();
  if (!slug) return null;
  const name = String(about?.appName || '').trim() || slug;
  const app = encodeURIComponent(slug);
  if (about?.firstVersion) return { route: `app/${app}/dev`, label: name, place: { slug, name }, issueNumber: null };
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
 * the person's threads, listed on the bot page, and stay threads.
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
    title: meta.firstVersion ? null : (meta.requestTitle || meta.issueTitle || null),
  });
}

/**
 * Open a request's page from the chat with the bot. Beside the bot page on a
 * desktop the side panel takes it, in Main Chat's place, and Main Chat's
 * composer carries the request (as the list's rows do: features/ai/); anywhere
 * else the page itself, which goes back to where it was opened from.
 */
export function openRequestPage(page: RequestPage, conversationId: number | null = null): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  try {
    if (w.UsernodeReact?.sidePanel?.take?.(page.route, { place: page.place, label: page.label })) {
      if (conversationId && page.issueNumber) {
        window.dispatchEvent(new CustomEvent('usernode:messages-object-selected', {
          detail: { type: 'issue', appSlug: page.place.slug, issueNumber: page.issueNumber, title: page.label, conversationId },
        }));
      }
      return;
    }
  } catch {
    /* the page instead */
  }
  try {
    if (page.issueNumber) w.Improve?.enterTopicFrom?.(window.location.hash || '#homeroom-bot');
    else w.AppView?._landOnHub?.(page.place.slug);
  } catch {
    /* the page opens all the same */
  }
  window.location.hash = page.route;
}
