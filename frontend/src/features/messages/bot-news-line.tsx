import { useState, type ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { ProjectTile } from './bot-strip';
import { openThreadAt } from './store';
import type { ConversationMessage, HomeroomBotMeta } from './types';

/*
 * One request, one story: the bot's news in the main chat, ONE short line
 * each. In the chat with Homeroom bot every message about a request (its
 * card, the moments that ring and are also shown in the main chat, and the
 * big cards from before threads) is drawn as
 *
 *     [tile] Dark mode needs your answer
 *
 * the project's tile, the request's title in bold and a few words. A tap
 * opens the request's thread (its root: the message's `threadRootId`, or the
 * card itself), at the message. A message from before threads, which has no
 * thread, opens in place instead: the whole message as it was drawn
 * (./message-row.tsx). Inside the thread everything stays whole.
 *
 * The bot's conversational replies, its offers (File it / Not now), its
 * hellos and anything about no request stay ordinary messages
 * (isBotNews false). The line keeps the message's article id and
 * data-message-id, so a link to it and the "New" line still find it.
 */

/** The bot's own messages that are conversation, never news: they stay messages. */
const CONVERSATION_KINDS = new Set([
  'chat', 'ack', 'reply', 'confirm', 'hello', 'welcome', 'tour', 'joiner', 'maker', 'member', 'general',
  'hello_welcome', 'hello_tour', 'hello_joiner', 'filed', 'withdraw_proposal', 'close_request', 'move_request', 'unknown',
]);

function metaOf(message: ConversationMessage): HomeroomBotMeta | null {
  if (!message.sender.bot) return null;
  const meta = message.metadata?.homeroomBot;
  return meta && typeof meta === 'object' ? meta : null;
}

/** Pure: whether a message in the chat with the bot is news about a request, drawn as one line. */
export function isBotNews(message: ConversationMessage): boolean {
  const meta = metaOf(message);
  if (!meta || message.deleted || !(message.id > 0)) return false;
  if (meta.moment === 'reply' || CONVERSATION_KINDS.has(meta.kind)) return false;
  return (Number(meta.issueNumber) > 0) || !!meta.firstVersion || meta.kind === 'activity';
}

/** Which words a line says: a message id, and whether it waits on the person. */
export interface NewsWords { key: string; need: boolean }

const KIND_WORDS: Record<string, NewsWords> = {
  activity: { key: 'messages:bot.news.started', need: false },
  question: { key: 'messages:bot.news.answer', need: true },
  followup_ask: { key: 'messages:bot.news.answer', need: true },
  plan: { key: 'messages:bot.news.plan', need: true },
  person: { key: 'messages:bot.news.decision', need: true },
  blocked: { key: 'messages:bot.news.detail', need: true },
  empty: { key: 'messages:bot.news.detail', need: true },
  proposal: { key: 'messages:bot.news.ready', need: false },
  build_failed: { key: 'messages:bot.news.stopped', need: true },
  checks: { key: 'messages:bot.news.stopped', need: true },
  needs_look: { key: 'messages:bot.news.stopped', need: true },
  followup_failed: { key: 'messages:bot.news.stopped', need: true },
  followup_person: { key: 'messages:bot.news.stopped', need: true },
  first_version_failed: { key: 'messages:bot.news.stopped', need: true },
  preview_failed: { key: 'messages:bot.news.stopped', need: true },
  allowance: { key: 'messages:bot.news.onHold', need: false },
  paused: { key: 'messages:bot.news.onHold', need: false },
  merged: { key: 'messages:bot.news.live', need: false },
};

/** The four moments that ring, by their variant where it matters (services/homeroom-bot-dm.js `said`). */
function momentWords(moment: string, said: string): NewsWords | null {
  switch (moment) {
    case 'needs_you':
      if (said === 'plan' || said === 'plan_first') return KIND_WORDS.plan;
      if (said === 'decide' || said === 'decide_others' || said === 'done' || said === 'platform') return KIND_WORDS.person;
      if (said === 'blocked' || said === 'empty') return KIND_WORDS.blocked;
      return KIND_WORDS.question;
    case 'ready': return KIND_WORDS.proposal;
    case 'stopped': return KIND_WORDS.build_failed;
    case 'on_hold': return KIND_WORDS.allowance;
    case 'live': return KIND_WORDS.merged;
    default: return null;
  }
}

/** Pure: what a line says after the request's title, from the moment it rang as, else its kind. */
export function newsWords(meta: Pick<HomeroomBotMeta, 'kind' | 'moment' | 'said'>): NewsWords {
  return (meta.moment ? momentWords(meta.moment, meta.said || '') : null)
    || KIND_WORDS[meta.kind]
    || { key: 'messages:bot.news.update', need: false };
}

/** Pure: the request's name on a line: its title, "Plant Pal, first version", or "Request #12". */
export function newsTitle(meta: HomeroomBotMeta): string {
  const project = meta.appName || meta.appSlug || translate('messages:bot.job.unnamedProject');
  if (meta.firstVersion) return translate('messages:bot.strip.firstVersion', { project });
  const title = meta.requestTitle || meta.issueTitle;
  if (title) return title;
  return meta.issueNumber ? translate('messages:bot.strip.requestNumber', { number: String(meta.issueNumber) }) : project;
}

/** Pure: the thread a line opens, or null for a message from before threads (it opens in place). */
export function newsThread(message: ConversationMessage): number | null {
  if (message.threadRootId) return message.threadRootId;
  const meta = metaOf(message);
  return meta?.kind === 'activity' && message.thread ? message.id : null;
}

const NEED_INK = 'text-amber-700 dark:text-amber-400';

export function BotNewsLine({ message, focused = false, full }: {
  message: ConversationMessage;
  /** The message a link pointed at: flashed once. */
  focused?: boolean;
  /** The whole message, for one from before threads opened in place. */
  full: () => ReactNode;
}) {
  const t = useMessages('messages');
  const [open, setOpen] = useState(false);
  const meta = metaOf(message);
  if (!meta) return null;
  if (open) return <>{full()}</>;
  const words = newsWords(meta);
  const rootId = newsThread(message);
  const updates = meta.kind === 'activity' && message.thread ? message.thread.replyCount : 0;
  function tap() {
    if (rootId) openThreadAt(rootId, message.threadRootId ? message.id : null);
    else setOpen(true);
  }
  return (
    <article
      id={`messages-message-${message.id}`}
      data-message-id={message.id}
      className={`messages-bot-news px-4 py-1${focused ? ' messages-message-focus' : ''}`}
      data-bot-news={meta.kind}
    >
      {/* B5: the bot's hello still leads the first card it sends somebody. */}
      {meta.hello ? <p className="messages-bot-hello">{meta.hello}</p> : null}
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2.5 rounded-xl py-1 text-left text-[15px] leading-5 hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
        aria-expanded={rootId ? undefined : false}
        data-bot-news-open={rootId ? 'thread' : 'inline'}
        onClick={tap}
      >
        <ProjectTile name={meta.appName || meta.appSlug || ''} slug={meta.appSlug || null} emoji={meta.appEmoji || null} size="line" />
        <span className="min-w-0 flex-1 truncate">
          <strong className="font-[650] text-zinc-900 dark:text-zinc-100">{newsTitle(meta)}</strong>
          {' '}
          <span className={words.need ? NEED_INK : 'text-zinc-600 dark:text-zinc-300'} data-bot-news-words="">{t(words.key)}</span>
          {updates ? <>{' '}<span className="text-violet-700 dark:text-violet-300" data-bot-thread-link={message.id}>{t('messages:bot.news.updates', { count: updates })}</span></> : null}
        </span>
      </button>
    </article>
  );
}
