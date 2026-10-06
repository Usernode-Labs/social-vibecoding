import { MessageMarkdown, ObjectCard } from './format';
import { pageOf, sameItem, type HomeroomLink } from './homeroom-links';
import { useLinkCards } from './link-cards';
import type { HomeroomBotMeta, SharedObjectCard } from './types';

/*
 * #4097: the request a Homeroom bot message is about, as its card.
 *
 * The bot's news about a request opens with a line naming it, then a blank
 * line and what it has to say: "**Todo List** · request #93: Only close
 * category when last item is checked" (services/homeroom-bot-dm.js
 * requestLine). In the transcript that line was a bold name and a `#93` chip,
 * a number to decode rather than the request. The row now draws the
 * request's own card in its place, the card a shared request is
 * (./format.tsx ObjectCard), and the words after it.
 *
 * THE MESSAGE IS UNCHANGED. Its text still carries the line, so the inbox
 * preview, the bell, a push, a quote and Copy text still name the request in
 * words; only the transcript draws it as a card, and so every message the
 * bot already sent reads the new way too.
 *
 * WHERE THE CARD COMES FROM, best first: the request's card the message
 * already carries (the bot attaches it when no activity card shows the
 * request, and it is drawn here instead of again under the words); the
 * server's reading of it for this reader, the one a pasted link to it gets
 * (./link-cards.tsx); and, until that answers or when it cannot, the card the
 * line itself describes. That last one says nothing the line did not, and
 * the `#N` chip it replaces opened the same page.
 *
 * NO "BY" AND NO STATUS on any of them. On a request the platform filed,
 * GitHub's author is its own account, and the line never said who filed it.
 * The status is GitHub's: a request whose change went live is "closed", so
 * "It's live now" sat under a card reading "Todo List · closed", which reads
 * as turned down. The message's own words say where the request stands.
 */

export interface RequestHead {
  /** The request's page, or null for a message that names no project slug (a staging demo). */
  link: HomeroomLink | null;
  /** The project the message names, for the words' `#N` chips (#3770). */
  appSlug: string | null;
  appName: string;
  issueNumber: number;
  /** The request's title as the bot knew it: its metadata's, else the line's (clipped at 140). */
  title: string | null;
  /** The words after the line; '' when the line was all there was. */
  rest: string;
}

// requestLine's shape: "**<app>** · request #<n>" and, with a title, ": <title>".
const LINE = /^\*\*(.+?)\*\* · request #(\d+)(?:: (.+))?$/;

/**
 * Pure: the request line `content` opens with, when it is the one the bot
 * writes about the request its metadata names, split from the words after it.
 * Null for anything else: a person's message, a first version (which has no
 * request line), a line about another request, or words that only look like
 * one further down.
 */
export function requestHead(content: string, meta: HomeroomBotMeta | null): RequestHead | null {
  const issueNumber = Number(meta?.issueNumber);
  if (!meta || meta.firstVersion || !Number.isInteger(issueNumber) || issueNumber <= 0) return null;
  const text = String(content || '');
  const end = text.indexOf('\n\n');
  const match = LINE.exec((end < 0 ? text : text.slice(0, end)).trim());
  if (!match || Number(match[2]) !== issueNumber) return null;
  const link = meta.appSlug ? pageOf(`app/${meta.appSlug}/dev/issues/${issueNumber}`) : null;
  return {
    link,
    appSlug: meta.appSlug || null,
    appName: meta.appName || match[1],
    issueNumber,
    title: meta.issueTitle || match[3] || null,
    rest: end < 0 ? '' : text.slice(end + 2).trim(),
  };
}

/** Whether a card on the message is the one `head` draws, so it is not drawn twice. */
export function isHeadCard(head: RequestHead | null, object: SharedObjectCard): boolean {
  return !!head?.link && sameItem(head.link, object);
}

const NO_LINKS: readonly HomeroomLink[] = [];

/** The request's card, from the best of the three sources above. */
export function RequestHeadCard({ head, objects }: { head: RequestHead; objects: readonly SharedObjectCard[] }) {
  const carried = objects.find((object) => object.available && isHeadCard(head, object)) || null;
  const [read] = useLinkCards(carried || !head.link ? NO_LINKS : [head.link]);
  const card: SharedObjectCard = carried || read?.card || {
    type: 'issue', available: true, appSlug: head.appSlug || undefined, issueNumber: head.issueNumber,
    title: head.title || `Request #${head.issueNumber}`, subtitle: head.appName,
  };
  return (
    <div className="mb-1.5 mt-1 max-w-[480px]" data-bot-request-card={head.issueNumber}>
      <ObjectCard object={{ ...card, author: null, state: null, href: head.link?.href || null }} />
    </div>
  );
}

/** The request's card, then the words after its line. */
export function RequestHeadWords({ head, objects, channels }: {
  head: RequestHead;
  objects: readonly SharedObjectCard[];
  channels?: ReadonlySet<string>;
}) {
  return (
    <>
      <RequestHeadCard head={head} objects={objects} />
      {head.rest ? <MessageMarkdown content={head.rest} channels={channels} appSlug={head.appSlug} /> : null}
    </>
  );
}
