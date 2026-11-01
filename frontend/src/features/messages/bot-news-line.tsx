import { useEffect, useRef, useState } from 'react';

import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { isBotNews, requestKey } from './bot-request';
import { newsIcon } from './bot-shared';
import { endedWords, OpenState, ProjectTile, RequestTag, SettledLine, trayEnded, trayNow, type StripRow } from './bot-strip';
import { tracksByKey } from './bot-track';
import { useBotWork } from './bot-work';
import { openRequestPage, requestPageOf } from './request-page';
import { openThreadAt } from './store';
import type { ConversationMessage, HomeroomBotMeta, HomeroomBotWork } from './types';

/*
 * One request, one story: the bot's news in the main chat, ONE short line
 * each. In the chat with Homeroom bot every message about a request (its
 * card, the moments that ring and are also shown in the main chat, and the
 * big cards from before threads) is drawn as
 *
 *     [tile] #18 Dark mode                                  >
 *            Needs your answer · 3 updates
 *
 * the project's tile, the request's number and title and where it stands.
 * Every row opens the same way: a tap opens the request's own page, its
 * public thread (31 Oct 2026, ./request-page.ts): beside the bot page on a
 * desktop, else the page. It used to open a thread of this chat's own
 * beside it, a second view of the same request that nothing else listed.
 *
 * What still asks something here (a question and its answers, a plan and
 * its Build it, a button to press) is not folded into a line: it is drawn
 * whole where it was said (asksInChat), so it is answered in the chat.
 *
 * A row says at a glance whether it is still open. One the tray holds open
 * is two lines with a full tile, and a badge in amber while it waits on the
 * person (the words under the title stay grey: amber words read as an
 * error). One
 * that is done, or that the tray no longer holds, is SETTLED: one line, a
 * small tile, and how it ended (a green check when it went live).
 *
 * The bot's conversational replies, its offers (File it / Not now), its
 * hellos and anything about no request stay ordinary messages
 * (isBotNews false). The line keeps the message's article id and
 * data-message-id, so a link to it and the "New" line still find it.
 */

function metaOf(message: ConversationMessage): HomeroomBotMeta | null {
  if (!message.sender.bot) return null;
  const meta = message.metadata?.homeroomBot;
  return meta && typeof meta === 'object' ? meta : null;
}

export { isBotNews };

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
  held_proposals_per_app: { key: 'messages:bot.news.slots', need: false },
  held_proposals_total: { key: 'messages:bot.news.slots', need: false },
  merged: { key: 'messages:bot.news.live', need: false },
  request_closed: { key: 'messages:bot.news.doneElsewhere', need: false },
  request_taken: { key: 'messages:bot.news.taken', need: false },
};

/** The moments that ring, by their variant where it matters (services/homeroom-bot-dm.js `said`). */
function momentWords(moment: string, said: string): NewsWords | null {
  switch (moment) {
    case 'needs_you':
      if (said === 'plan' || said === 'plan_first') return KIND_WORDS.plan;
      if (said === 'decide' || said === 'decide_others' || said === 'done' || said === 'platform') return KIND_WORDS.person;
      if (said === 'blocked' || said === 'empty') return KIND_WORDS.blocked;
      return KIND_WORDS.question;
    case 'ready': return KIND_WORDS.proposal;
    case 'stopped': return KIND_WORDS.build_failed;
    case 'on_hold':
      if (said === 'taken') return KIND_WORDS.request_taken;
      return said === 'slots' ? KIND_WORDS.held_proposals_per_app : KIND_WORDS.allowance;
    case 'live': return KIND_WORDS.merged;
    case 'done_elsewhere': return KIND_WORDS.request_closed;
    default: return null;
  }
}

/** Pure: what a line says after the request's title, from the moment it rang as, else its kind. */
export function newsWords(meta: Pick<HomeroomBotMeta, 'kind' | 'moment' | 'said'>): NewsWords {
  return (meta.moment ? momentWords(meta.moment, meta.said || '') : null)
    || KIND_WORDS[meta.kind]
    || { key: 'messages:bot.news.update', need: false };
}

/**
 * One request, one row: in the chat's main stream the newest news about each
 * request is drawn, and the news before it folds into that row, so a request
 * is one row however often the bot spoke about it. Its thread (or, for news
 * from before threads, the row opened in place) still holds every piece.
 * `skip` is what the stream draws nowhere (a moved card, a card its plan
 * carries), so a folded row is never one that is not drawn.
 */
export interface NewsFold {
  /** News drawn inside a newer row about the same request. */
  hidden: Set<number>;
  /** By the row drawn: the news folded into it, oldest first. */
  earlier: Map<number, ConversationMessage[]>;
}
export function foldBotNews(messages: ConversationMessage[], skip: (message: ConversationMessage) => boolean = () => false): NewsFold {
  const byRequest = new Map<string, ConversationMessage[]>();
  for (const message of messages) {
    if (skip(message) || !isBotNews(message)) continue;
    const meta = metaOf(message);
    const key = meta ? requestKey(meta) : null;
    if (!key) continue;
    const list = byRequest.get(key);
    if (list) list.push(message);
    else byRequest.set(key, [message]);
  }
  const fold: NewsFold = { hidden: new Set(), earlier: new Map() };
  for (const list of byRequest.values()) {
    if (list.length < 2) continue;
    const newest = list[list.length - 1];
    fold.earlier.set(newest.id, list.slice(0, -1));
    for (const message of list.slice(0, -1)) fold.hidden.add(message.id);
  }
  return fold;
}

/** Where a row's request stands: its words, and how it is drawn. */
export interface NewsStatus {
  text: string;
  /** Waits on the person: the need colour. */
  need: boolean;
  /** Asks nothing any more: one line, with how it ended. */
  settled: boolean;
  /** How it ended, in the activity cards' words ('live', 'closed', …), when known. */
  ended: string | null;
  /** The tray's row for it while it is open: what its badge shows. */
  row: StripRow | null;
}

/** What a request ended as, read from the last news about it when the tray has no record of it. */
const KIND_ENDINGS: Record<string, string> = {
  merged: 'live', request_closed: 'done_elsewhere',
  build_failed: 'build_failed', first_version_failed: 'build_failed', preview_failed: 'build_failed', followup_failed: 'build_failed',
};

/**
 * Pure: a row's second line, and how it is drawn. A request the tray still
 * holds says where it stands NOW, in the drawer's own words, in amber only
 * while it waits on the person; done today, it is settled. One the tray no
 * longer holds is settled too, and keeps its message's words, an ask among
 * them told in the past ("Asked you a question"): whatever it asked has moved
 * on. Before the tray's first read, the message's words as they rang, and
 * nothing is settled yet.
 */
export function newsStatus(meta: HomeroomBotMeta, now: Map<string, StripRow> | null, ended: Map<string, string> | null = null): NewsStatus {
  const words = newsWords(meta);
  if (!now) return { text: translate(words.key), need: words.need, settled: false, ended: null, row: null };
  const key = requestKey(meta);
  const row = key ? now.get(key) : undefined;
  if (row && row.group !== 'done') return { text: row.state, need: row.group === 'needs', settled: false, ended: null, row };
  const outcome = (key && ended?.get(key)) || (meta.moment === 'live' ? 'live' : KIND_ENDINGS[meta.kind]) || null;
  return { text: row ? row.state : translate(PAST_WORDS[words.key] || words.key), need: false, settled: true, ended: outcome, row: null };
}

/** What an ask says once it no longer waits on the person: what it was, in the past. */
const PAST_WORDS: Record<string, string> = {
  'messages:bot.news.answer': 'messages:bot.news.past.answer',
  'messages:bot.news.plan': 'messages:bot.news.past.plan',
  'messages:bot.news.decision': 'messages:bot.news.past.decision',
  'messages:bot.news.detail': 'messages:bot.news.past.detail',
  'messages:bot.news.ready': 'messages:bot.news.past.ready',
};

/** Pure: the request's name on a line: its title, "Plant Pal, first version", or "Request #12". */
export function newsTitle(meta: HomeroomBotMeta): string {
  const project = meta.appName || meta.appSlug || translate('messages:bot.job.unnamedProject');
  if (meta.firstVersion) return translate('messages:bot.strip.firstVersion', { project });
  const title = meta.requestTitle || meta.issueTitle;
  if (title) return title;
  return meta.issueNumber ? translate('messages:bot.strip.requestNumber', { number: String(meta.issueNumber) }) : project;
}

/**
 * Pure: whether a piece of news still asks something the chat answers: a
 * question with its answers, two at once, a plan to build, buttons to
 * press. Such a message is drawn whole in the main chat rather than folded
 * into its request's line, for as long as it is open. What it asks once the
 * tray no longer holds its request is the caller's to read (newsStatusOf):
 * that has moved on, and is a line again.
 */
export function asksInChat(message: ConversationMessage): boolean {
  const meta = metaOf(message);
  if (!meta || message.deleted || meta.status !== 'open' || meta.replaced) return false;
  return !!(meta.question || meta.questions?.length || meta.actions?.length || (meta.kind === 'plan' && meta.plan));
}

/** Pure: the thread a line opens, or null for a message from before threads (its story opens on its oldest piece). */
export function newsThread(message: ConversationMessage): number | null {
  if (message.threadRootId) return message.threadRootId;
  const meta = metaOf(message);
  return meta?.kind === 'activity' && message.thread ? message.id : null;
}

/** The project's icon as the strip has it (./bot-shared.ts, where the head card reads it too). */
export { newsIcon };

/** Pure: where a news message's request stands, from one read of the tray (null for a message that is not news). */
export function newsStatusOf(message: ConversationMessage, work: HomeroomBotWork | null): NewsStatus | null {
  const meta = metaOf(message);
  return meta ? newsStatus(meta, trayNow(work), trayEnded(work)) : null;
}


export function BotNewsLine({ message, focused = false, earlier = [], updates: updatesIn = null, nested = false }: {
  message: ConversationMessage;
  /** Drawn with no padding of its own and no tile column, inside another row's box. */
  nested?: boolean;
  /** The message a link pointed at: flashed once. */
  focused?: boolean;
  /** The news about the same request folded into this row (foldBotNews). */
  earlier?: ConversationMessage[];
  /** How many updates the request's story holds, when the stream counted them. */
  updates?: number | null;
}) {
  const t = useMessages('messages');
  const { work } = useBotWork();
  const meta = metaOf(message);
  if (!meta) return null;
  const status = newsStatus(meta, trayNow(work), trayEnded(work));
  const key = requestKey(meta);
  const icon = newsIcon(work, meta.appSlug, meta.appName);
  const updates = updatesIn ?? (meta.kind === 'activity' && message.thread ? message.thread.replyCount : 0);
  // Its story: the request's own page. News that names no project's page
  // (sent before the bot's news named its project) opens where it is told,
  // its thread or, from before threads, its oldest piece.
  const page = requestPageOf(message);
  const rootId = newsThread(message) ?? (earlier[0]?.id || message.id);
  function tap() {
    if (page) openRequestPage(page, message.conversationId);
    else openThreadAt(rootId, rootId === message.id ? null : message.id);
  }

  return (
    <article
      id={`messages-message-${message.id}`}
      data-message-id={message.id}
      className={`messages-bot-news ${nested ? 'py-0' : 'px-4 py-1'}${focused ? ' messages-message-focus' : ''}`}
      data-bot-news={meta.kind}
    >
      {/* Links to the news folded in here land on this row. */}
      {earlier.map((item) => <span key={item.id} id={`messages-message-${item.id}`} aria-hidden="true" />)}
      {/* B5: the bot's hello still leads the first card it sends somebody. */}
      {meta.hello ? <p className="messages-bot-hello">{meta.hello}</p> : null}
      {status.settled ? (
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 rounded-xl py-1 pr-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
          data-bot-news-open="thread"
          data-bot-news-state="settled"
          onClick={tap}
        >
          <SettledLine
            name={meta.appName || meta.appSlug || ''} slug={meta.appSlug || null} iconUrl={icon.iconUrl} emoji={meta.appEmoji || icon.iconEmoji}
            number={meta.firstVersion ? null : meta.issueNumber} title={newsTitle(meta)} outcome={status.ended} fallback={status.text}
            words={endedWords(status.ended, key ? tracksByKey(work)?.get(key) || null : null, status.text)}
            nested={nested}
          />
          <ChevronRightIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
        </button>
      ) : (
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 rounded-xl py-1.5 pr-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
          data-bot-news-open="thread"
          data-bot-news-state={status.need ? 'needs' : 'open'}
          onClick={tap}
        >
          <ProjectTile name={meta.appName || meta.appSlug || ''} slug={meta.appSlug || null} iconUrl={icon.iconUrl} emoji={meta.appEmoji || icon.iconEmoji} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              {status.row ? <OpenState row={status.row} /> : null}
              {meta.firstVersion ? null : <RequestTag number={meta.issueNumber} size="line" />}
              <strong className="truncate text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{newsTitle(meta)}</strong>
            </span>
            {/* Grey whatever it says: the badge carries the need colour, and the words in it read as trouble. */}
            <span className="truncate text-[13px] leading-[18px] text-zinc-500 first-letter:uppercase dark:text-zinc-400" data-bot-news-words="">
              {status.text}
              {updates ? <span className="text-zinc-400 dark:text-zinc-500" data-bot-thread-link={message.id}>{` ${t('messages:bot.news.updates', { count: updates })}`}</span> : null}
            </span>
          </span>
          <ChevronRightIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
        </button>
      )}
    </article>
  );
}

/** One row of a folded run: what BotNewsLine is drawn with. */
export interface SettledRunItem {
  message: ConversationMessage;
  earlier: ConversationMessage[];
  updates: number | null;
  focused: boolean;
}

/**
 * Settled rows in a row fold into one line of words (one request, one
 * story): two or more finished requests with nothing between them on the
 * same day are
 *
 *     [✓] 12 finished · 1 couldn't build ⌄
 *
 * a row of its own (16 Oct 2026): its own tile in the tile column, so it
 * never reads as part of the row above it (it sat indented under that row's
 * title, under "3 updates", and read as those updates finishing). #5392:
 * the parts are words, each with what it counts, and no strip of small
 * squares that runs off the edge; "couldn't build" counts the builds that
 * went wrong, "finished" every other ending, and zero parts are left out.
 * Pressed, it opens the same rows, in place, that the drawer's Finished
 * today list draws, each saying how it ended in words. Open requests are
 * never folded, so what still asks something is what the eye meets. A link
 * to a folded row lands on the line (each row's id is an anchor on it) and
 * opens it.
 *
 * Pressed, the line stays where it is on the screen: the rows open below
 * it, and `holdPlace` (the transcript's) stops it following the newest line
 * for that press and puts it back where it was once they are drawn.
 */
export function SettledRun({ items, holdPlace }: {
  items: SettledRunItem[];
  /** Keep an element where it is on screen across the next draw: returns what puts it back. */
  holdPlace?: (el: HTMLElement) => () => void;
}) {
  const t = useMessages('messages');
  const { work } = useBotWork();
  const focused = items.some((item) => item.focused);
  const [open, setOpen] = useState(focused);
  useEffect(() => { if (focused) setOpen(true); }, [focused]);
  const count = useRef<HTMLButtonElement>(null);
  const putBack = useRef<(() => void) | null>(null);
  useIsomorphicLayoutEffect(() => {
    putBack.current?.();
    putBack.current = null;
  }, [open]);
  const statuses = items.map((item) => newsStatusOf(item.message, work));
  const failed = statuses.filter((status) => status?.ended === 'build_failed' || status?.ended === 'failed').length;
  const finished = items.length - failed;
  const toggle = () => {
    if (count.current && holdPlace) putBack.current = holdPlace(count.current);
    setOpen(!open);
  };
  return (
    <div className="messages-bot-news messages-bot-settled-run pb-1 pt-2" data-bot-settled-run={items.length} data-bot-settled-first={items[0]?.message.id}>
      {open ? null : items.flatMap((item) => [item.message, ...item.earlier]).map((m) => <span key={m.id} id={`messages-message-${m.id}`} aria-hidden="true" />)}
      <div className="flex min-w-0 items-center gap-2 px-4">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-zinc-200/80 text-emerald-600 dark:bg-zinc-700/70 dark:text-emerald-400"
          aria-hidden="true"
          data-bot-settled-tile=""
        >
          <CheckIcon aria-hidden="true" className="h-4 w-4" strokeWidth="2.5" />
        </span>
        <button
          ref={count}
          type="button"
          className="flex h-[30px] shrink-0 items-center gap-1 rounded-lg text-left text-[14px] font-semibold leading-5 text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
          aria-expanded={open}
          data-bot-settled-toggle=""
          onClick={toggle}
        >
          {finished ? <span data-bot-settled-count="finished">{t('messages:bot.news.run.finished', { count: finished })}</span> : null}
          {finished && failed ? <span aria-hidden="true"> · </span> : null}
          {failed ? <span data-bot-settled-count="failed">{t('messages:bot.news.run.failed', { count: failed })}</span> : null}
          <ChevronDownIcon aria-hidden="true" className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform dark:text-zinc-500 ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open ? (
        <div className="mt-1 flex flex-col" data-bot-settled-rows="">
          {items.map((item) => (
            <BotNewsLine key={item.message.clientKey || item.message.id} message={item.message} earlier={item.earlier} updates={item.updates} focused={item.focused} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
