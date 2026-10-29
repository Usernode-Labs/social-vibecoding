/**
 * The AI tab's main view (#6019 follow-up), its pure part: what each list
 * holds and what each row says. ./index.tsx draws it.
 *
 *   Needs you   what waits on you: the Needs you feed for the threads you
 *               are in (GET /api/workshop/needs-feed?in=threads), each with
 *               one pill for what you owe; then Homeroom bot's plans waiting
 *               for your Build it; then your private threads, with a lock on
 *               the tile.
 *   In progress yours being worked on, soonest first: the bot reading it, a
 *               change being made or fixed, merging, going live.
 *   Up next     yours waiting on someone else: other people's votes, a free
 *               builder, or somebody to pick it up. Each says which.
 *   Live        yours that went live this week, folded.
 *
 * The last four are GET /api/ai/work's, and where Homeroom bot works on a
 * request for you, its list is the bot's own word on it (services/ai-work.js
 * botStages), so this page and the bot's answer in Main agree (29 Oct 2026).
 *
 * A row's words are phrases (an id and its values), translated where they
 * are drawn, so this module needs no i18n runtime and its tests read it bare.
 */

export interface AiApp {
  slug: string;
  name: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
}

export interface AiPrivate {
  rootId: number;
  title: string;
  kind: string;
  app: AiApp | null;
  at: string | null;
}

export interface AiThread {
  threadId: number;
  number: number | null;
  kind: string;
  title: string | null;
  app: AiApp | null;
  change: { id: number; number: number | null } | null;
  href: string;
  group: 'needs' | 'next' | 'waiting' | 'live';
  what:
    | 'plan'
    | 'going_live' | 'merging' | 'fixing' | 'revising' | 'building' | 'reading'
    | 'vote' | 'fix_queued' | 'followup_queued' | 'build_queued' | 'held' | 'stalled' | 'queued' | 'on_hold'
    | 'not_picked_up'
    | 'live';
  at: string | null;
  quietDays?: number;
  /** Up for a vote: how you voted, if you have. */
  myVote?: 'yes' | 'no' | null;
  /** Being made: by Homeroom bot, by you, or by someone else. */
  by?: 'bot' | 'you' | 'someone';
  /** Held back: until a change up for a vote is decided, or by the day's limit. */
  heldBy?: 'approvals' | 'daily';
}

export interface AiWork {
  private: AiPrivate[];
  /** The bot's plans waiting for your Build it (absent from an older server). */
  needs?: AiThread[];
  next: AiThread[];
  waiting: AiThread[];
  live: AiThread[];
}

/** One card of the Needs you feed, as much of it as a row needs. */
export interface NeedItem {
  kind: string;
  id: number;
  number?: number | null;
  title?: string | null;
  app?: AiApp | null;
  href?: string | null;
  /** A pick between competing changes: the request they compete for. */
  ballot?: { number?: number | null; title?: string | null } | null;
}

/** Pure: the request or change number a Needs you card is about. */
function needNumber(item: NeedItem): number | null {
  if (item.kind === 'ballot') return item.ballot?.number || item.number || null;
  return item.number || null;
}

export interface Phrase {
  id: string;
  values?: Record<string, string | number>;
}

/** Who is in a thread, drawn on its tile: everyone in its community, only you inside one, or only you. */
export type Who = 'all' | 'me' | 'solo';

export interface WorkRow {
  key: string;
  title: string;
  app: AiApp | null;
  who: Who;
  sub: Phrase;
  /** What you owe, on the row's one pill. */
  pill: Phrase | null;
  /** Where the row goes: a page, or a private thread of Main. */
  href: string | null;
  rootId: number | null;
}

/** How many rows of Needs you, and of In progress and Up next, show before Show more. */
export const WORK_FIRST = 8;
export const NEXT_FIRST = 4;
/**
 * How many of the feed's cards show before Show more. The heading counts the
 * rest, so a long queue of votes never buries your plans and private threads
 * under it.
 */
export const NEEDS_FIRST = 3;

/** Pure: Needs you before Show more: the first NEEDS_FIRST of the feed's cards, then the rest in order, WORK_FIRST rows in all. */
export function foldWork(rows: WorkRow[]): WorkRow[] {
  let needs = 0;
  return rows.filter((row) => !row.key.startsWith('need:') || ++needs <= NEEDS_FIRST).slice(0, WORK_FIRST);
}

const PILLS: Record<string, string> = {
  proposal: 'messages:ai.pill.vote',
  governance: 'messages:ai.pill.vote',
  ballot: 'messages:ai.pill.pick',
  question: 'messages:ai.pill.answer',
  bot_question: 'messages:ai.pill.answer',
  plan: 'messages:ai.pill.buildIt',
};

/** Pure: the page a Needs you card is decided on. */
export function needHref(item: NeedItem): string | null {
  if (item.href) return item.href;
  const slug = item.app?.slug;
  if (!slug) return null;
  const app = encodeURIComponent(slug);
  if (item.kind === 'governance') return `#app/${app}/dev/governance/${Number(item.id)}`;
  const number = needNumber(item);
  if (number) {
    // A ballot is decided on its request's page, where its changes are.
    return item.kind === 'proposal'
      ? `#app/${app}/dev/changes/${number}`
      : `#app/${app}/dev/issues/${number}`;
  }
  return `#app/${app}/workshop`;
}

function where(app: AiApp | null, number: number | null | undefined): Record<string, string | number> {
  return { project: app?.name || app?.slug || '', number: number || '' };
}

/** Pure: a row's project and number, or its project alone when it has none (a decision). */
function whereLine(app: AiApp | null, number: number | null | undefined): Phrase {
  return number
    ? { id: 'messages:ai.row.where', values: where(app, number) }
    : { id: 'messages:ai.row.project', values: where(app, null) };
}

/** Pure: what the feed's cards are about, as `slug#number`, so a thread already owed there is not listed twice. */
export function owedKeys(needs: NeedItem[] | null): Set<string> {
  const owed = new Set<string>();
  for (const item of needs || []) {
    const number = needNumber(item);
    if (item.app && number) owed.add(`${item.app.slug}#${number}`);
  }
  return owed;
}

/** Pure: whether a thread is one the feed already lists, by its request's number or its change's. */
function isOwed(owed: Set<string>, t: AiThread): boolean {
  if (!t.app) return false;
  return (!!t.number && owed.has(`${t.app.slug}#${t.number}`))
    || (!!t.change?.number && owed.has(`${t.app.slug}#${t.change.number}`));
}

/** Pure: Needs you, in order: the feed's cards, the bot's plans waiting for Build it, then your private threads. */
export function needsYou(needs: NeedItem[] | null, work: AiWork | null): WorkRow[] {
  const rows: WorkRow[] = [];
  const owed = owedKeys(needs);
  for (const item of needs || []) {
    const app = item.app || null;
    rows.push({
      key: `need:${item.kind}:${item.id}`,
      title: (item.kind === 'ballot' && item.ballot?.title) || item.title || '',
      app,
      who: 'all',
      sub: whereLine(app, needNumber(item)),
      pill: { id: PILLS[item.kind] || 'messages:ai.pill.needsYou' },
      href: needHref(item),
      rootId: null,
    });
  }
  for (const t of work?.needs || []) {
    if (isOwed(owed, t)) continue;
    rows.push({
      key: `plan:${t.threadId}`,
      title: t.title || '',
      app: t.app,
      who: 'all',
      sub: whereLine(t.app, t.number),
      pill: { id: PILLS[t.what] || 'messages:ai.pill.needsYou' },
      href: t.href,
      rootId: null,
    });
  }
  for (const p of work?.private || []) {
    rows.push({
      key: `private:${p.rootId}`,
      title: p.title,
      app: p.app,
      who: p.app ? 'me' : 'solo',
      sub: p.app
        ? { id: 'messages:ai.row.privateDraft', values: { project: p.app.name || p.app.slug } }
        : { id: 'messages:ai.row.privateIdea' },
      pill: null,
      href: null,
      rootId: p.rootId,
    });
  }
  return rows;
}

/** Pure: how many rows of Needs you ask something of you (a pill): the heading's and the hero's count. */
export function owedCount(rows: WorkRow[]): number {
  return rows.filter((row) => row.pill).length;
}

/** Pure: In progress, less any thread the feed already lists. */
export function inProgress(needs: NeedItem[] | null, work: AiWork | null): AiThread[] {
  const owed = owedKeys(needs);
  return (work?.next || []).filter((t) => !isOwed(owed, t));
}

/** Pure: Up next, less any thread the feed already lists. */
export function upNext(needs: NeedItem[] | null, work: AiWork | null): AiThread[] {
  const owed = owedKeys(needs);
  return (work?.waiting || []).filter((t) => !isOwed(owed, t));
}

/** The words of an In progress or Up next row's second line, by what it waits on. */
const THREAD_WORDS: Record<string, string> = {
  going_live: 'messages:ai.next.goingLive',
  merging: 'messages:ai.next.merging',
  fixing: 'messages:ai.next.fixing',
  revising: 'messages:ai.next.revising',
  building: 'messages:ai.next.building',
  reading: 'messages:ai.next.reading',
  vote: 'messages:ai.up.vote',
  fix_queued: 'messages:ai.up.fixQueued',
  followup_queued: 'messages:ai.up.followUpQueued',
  build_queued: 'messages:ai.up.buildQueued',
  held: 'messages:ai.up.held',
  stalled: 'messages:ai.up.stalled',
  queued: 'messages:ai.up.queued',
  on_hold: 'messages:ai.up.onHold',
  not_picked_up: 'messages:ai.up.notPickedUp',
};

/** Pure: one In progress or Up next row's second line: its project, and what it waits on. */
export function nextWords(t: AiThread): Phrase {
  const values = where(t.app, t.number);
  if (t.what === 'not_picked_up') {
    if (!t.number) return { id: 'messages:ai.up.notPickedUpBare', values: { project: values.project } };
    if (t.quietDays) return { id: 'messages:ai.up.quiet', values: { ...values, count: t.quietDays } };
  }
  if (t.what === 'vote' && t.myVote === 'yes') return { id: 'messages:ai.up.voteYes', values };
  if (t.what === 'vote' && t.myVote === 'no') return { id: 'messages:ai.up.voteNo', values };
  if (t.what === 'held' && t.heldBy === 'daily') return { id: 'messages:ai.up.heldDaily', values };
  if (t.what === 'building' && t.by === 'bot') return { id: 'messages:ai.next.botBuilding', values };
  if (t.what === 'building' && t.by === 'you') return { id: 'messages:ai.next.youBuilding', values };
  return { id: THREAD_WORDS[t.what] || 'messages:ai.row.where', values };
}

/** Pure: the hero's line under the bot's name: what needs you, what is in progress. */
export function heroWords(needs: number, next: number): Phrase {
  if (needs > 0) return { id: 'messages:ai.hero.both', values: { needs, next } };
  return { id: 'messages:ai.hero.next', values: { next } };
}

/**
 * Pure: whether `href` opens a topic page (a request, a change, a decision),
 * whose back chip can name this page as where it was opened from
 * (Improve.enterTopicFrom). A Workshop address is not one: the origin would
 * wait there for the next topic opened from anywhere.
 */
export function isTopicHref(href: string | null | undefined): boolean {
  return /^#?app\/[^/]+\/dev\/(issues|changes|proposals|governance|shared)\/\d+$/.test(String(href || ''));
}
