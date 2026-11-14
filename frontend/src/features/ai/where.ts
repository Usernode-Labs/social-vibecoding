/**
 * WHICH THREAD (14 Nov 2026). Every conversation with Homeroom bot is a
 * thread, and Main Chat, the one mixed stream the chat opened on, is gone.
 * Some doors still know only a message, a project's first version, or the
 * old Main Chat address. The server says which thread each of those is:
 *
 *   GET /api/ai/where                              { rootId: null, earlierRootId }
 *   GET /api/ai/where?message=<id>                 the thread that message is in
 *   GET /api/ai/where?project=<slug>&firstVersion=1  that project's first-version thread
 *
 * `earlierRootId` is always the person's "Earlier chat": the thread their
 * old Main Chat messages were moved under, or null when they had none.
 *
 * The doors here use it:
 *
 *   openOldMain      the router's half for `#homeroom-bot/main`,
 *                    `#homeroom-bot/main/m/<id>` and `#homeroom-bot/m/<id>`.
 *                    The old Main Chat opens Earlier chat, or a new chat
 *                    when there is none; a message opens the thread it is in,
 *                    at it, or the page itself when it is in none. The
 *                    address is rewritten in place (no step for Back), and
 *                    only while it is still the one that was asked.
 *   openBotMessage   the same for a message, from a door that is not an
 *                    address (a card's button).
 *   openFirstVersion a project's first-version thread, or the Homeroom bot
 *                    page when it has none.
 *
 * A read that fails, or a server from before the route, answers nulls: the
 * door falls back to the page, never to an error.
 */

import {
  BOT_TAB, askBotNew, askBotTab, botTabAddress, botTabAt, goBotAddress, type BotAt,
} from './door';

/** The server's answer: the thread asked for, and the person's Earlier chat. */
export interface BotWhere {
  rootId: number | null;
  earlierRootId: number | null;
}

/** What to ask about: a message, or a project's first version; nothing asks only for Earlier chat. */
export interface WhereQuery {
  message?: number | null;
  project?: string | null;
  firstVersion?: boolean;
}

const NOWHERE: BotWhere = { rootId: null, earlierRootId: null };

function id(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,254}$/;

/** Pure: the read for a question. */
export function wherePath(query: WhereQuery | null | undefined, demo = false): string {
  const said = new URLSearchParams();
  const message = id(query?.message);
  const project = typeof query?.project === 'string' && SLUG.test(query.project) ? query.project : null;
  if (message) said.set('message', String(message));
  else if (project && query?.firstVersion) {
    said.set('project', project);
    said.set('firstVersion', '1');
  }
  if (demo) said.set('demo', '1');
  const qs = said.toString();
  return qs ? `/api/ai/where?${qs}` : '/api/ai/where';
}

/** Pure: the server's answer, with anything that is not a thread taken out. */
export function cleanWhere(body: unknown): BotWhere {
  const said = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  return { rootId: id(said.rootId), earlierRootId: id(said.earlierRootId) };
}

function demo(): boolean {
  if (typeof window === 'undefined') return false;
  try { return new URLSearchParams(window.location.search).get('demo') === '1'; } catch { return false; }
}

/** Ask the server. Never throws: a read that fails answers nulls. */
export async function readWhere(query: WhereQuery | null = null): Promise<BotWhere> {
  if (typeof fetch !== 'function') return NOWHERE;
  try {
    const res = await fetch(wherePath(query, demo()), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    return res.ok ? cleanWhere(await res.json()) : NOWHERE;
  } catch {
    return NOWHERE;
  }
}

/**
 * Pure: where an old address lands, given the server's answer. A thread (at
 * the message, when the address named one), a new chat, or the page itself.
 */
export function oldMainLanding(at: BotAt, where: BotWhere): { thread: BotAt } | { fresh: true } | { page: true } {
  if (at.threadRootId) return { thread: at };
  if (at.focusMessageId) {
    return where.rootId
      ? { thread: { threadRootId: where.rootId, focusMessageId: where.rootId === at.focusMessageId ? null : at.focusMessageId } }
      : { page: true };
  }
  return where.earlierRootId ? { thread: { threadRootId: where.earlierRootId, focusMessageId: null } } : { fresh: true };
}

/** The address in the bar becomes `href`, keeping its query, with no step for Back. */
function rewrite(href: string, asked: string): void {
  const at = asked.indexOf('?');
  const next = at === -1 ? href : `${href}${asked.slice(at)}`;
  try {
    history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${next}`);
  } catch { /* the place is shown all the same */ }
}

/**
 * The router's half for an address from before: Main Chat, or a message
 * named without its thread. Taken once per call; the answer is dropped when
 * the reader has moved on to another address.
 */
export function openOldMain(hash: string): void {
  if (typeof window === 'undefined') return;
  const at = botTabAt(hash);
  if (!at) return;
  if (at.threadRootId) { askBotTab(at); return; }
  const asked = window.location.hash;
  void readWhere(at.focusMessageId ? { message: at.focusMessageId } : null).then((where) => {
    if (window.location.hash !== asked) return;
    const landing = oldMainLanding(at, where);
    if ('thread' in landing) {
      rewrite(botTabAddress(landing.thread), asked);
      askBotTab(landing.thread);
    } else if ('fresh' in landing) {
      // A new chat is the page's own address (./column.ts columnAddress).
      rewrite(BOT_TAB, asked);
      askBotNew(null);
    } else {
      rewrite(BOT_TAB, asked);
    }
  });
}

/** A message of the bot's chat, in the thread it is in; the page itself when it is in none. */
export async function openBotMessage(messageId: number | null | undefined): Promise<void> {
  const message = id(messageId);
  if (!message) { goBotAddress(BOT_TAB); return; }
  const where = await readWhere({ message });
  const landing = oldMainLanding({ threadRootId: null, focusMessageId: message }, where);
  goBotAddress('thread' in landing ? botTabAddress(landing.thread) : BOT_TAB);
}

/** A project's first-version thread; the Homeroom bot page when it has none (or the read fails). */
export async function openFirstVersion(slug: string | null | undefined): Promise<void> {
  const where = slug ? await readWhere({ project: slug, firstVersion: true }) : NOWHERE;
  goBotAddress(where.rootId ? botTabAddress({ threadRootId: where.rootId }) : BOT_TAB);
}

if (typeof window !== 'undefined') {
  const host = ((window as any).UsernodeReact ||= {});
  host.ai = { ...(host.ai || {}), openOld: openOldMain, openMessage: (messageId: number) => { void openBotMessage(messageId); }, openFirstVersion: (slug: string) => { void openFirstVersion(slug); } };
}
