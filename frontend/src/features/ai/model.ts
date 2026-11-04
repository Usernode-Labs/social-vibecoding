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
 *   Waiting     yours with nothing to do on the row: other people's votes, a
 *               free builder or slot, the clock. Each says which, and where
 *               a vote you owe would move it, says that too (30 Oct 2026:
 *               "Up next" read as yours to do next). #6160: In progress and
 *               Waiting are one card of their own on the page, work under
 *               way first, then what waits.
 *   Live        yours that went live this week.
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
  /**
   * Where the project's code is hosted (services/ai-work.js): true on
   * GitHub, where a change's pull request number is GitHub's own and reads
   * "PR 12"; false on Homeroom's git host, where requests and changes share
   * one counter and both read "#12". Absent from an older server.
   */
  changesOnGithub?: boolean;
}

export interface AiPrivate {
  rootId: number;
  title: string;
  kind: string;
  app: AiApp | null;
  at: string | null;
  /** 1 Nov 2026: what a thread opened from a request's or a change's page is about; its row carries the number. */
  about?: { kind: 'request' | 'change'; number: number } | null;
  /**
   * #6153: where it went: a design thread stays listed once it is filed as
   * a request, or posted on one as its plan (absent from an older server).
   */
  /** #6159: `done` once finished; a done thread is not listed. */
  state?: 'open' | 'filed' | 'posted' | 'dropped' | 'done';
  /** #6153: the number of the request it was filed as, or posted on. */
  resultRef?: number | null;
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
    | 'plan' | 'decide' | 'build_stopped'
    | 'going_live' | 'merging' | 'fixing' | 'revising' | 'building' | 'reading' | 'reading_reply'
    | 'vote' | 'checking' | 'decision' | 'fix_queued' | 'followup_queued' | 'build_queued' | 'held' | 'stalled' | 'queued' | 'on_hold'
    | 'not_picked_up' | 'needs_person' | 'nothing_to_build' | 'not_read' | 'operator' | 'awaiting_plan'
    | 'live';
  at: string | null;
  /**
   * #6233: on a Live row, when the change merged and its id, so the tab can
   * tell whether the build it loaded contains it (the "reload to get it"
   * wording). Absent on an older server.
   */
  mergedAt?: string | null;
  changeId?: number | null;
  quietDays?: number;
  /** #6158: its place in Homeroom bot's line, or among the project's builds held for a slot (1-based). */
  place?: number;
  /** #6158: Homeroom bot's reason, first line only, on a request it left for a person or found nothing to build in. */
  reason?: string | null;
  /** Up for a vote (a change's, or a decision's): how you voted, if you have. */
  myVote?: 'yes' | 'no' | null;
  /** Being made: by Homeroom bot, by you, or by someone else. */
  by?: 'bot' | 'you' | 'someone';
  /**
   * Held back: until a change up for a vote is decided, or for Homeroom
   * bot's turn among the project's builds (#6156: votes do not free it).
   */
  heldBy?: 'approvals' | 'turn';
  /** A request someone has claimed and has no change for yet: who. */
  claimedBy?: string | null;
  /** Held for a slot: how many of Homeroom bot's changes holding one wait on your vote (upNext). */
  yourVotes?: number;
  /**
   * #6153: the private thread its request was filed from (a design thread's
   * New request), which the row opens: the design and its story are there.
   */
  rootId?: number | null;
  /**
   * #6262: how many messages in the thread are new to the viewer (another
   * person's or Homeroom bot's, since they last opened it). Above zero, its
   * row gets a blue dot and a bold title. Absent from an older server, which
   * reads as 0.
   */
  unread?: number;
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
  /** A change for a request: the request it closes (absent from an older server). */
  request?: { number?: number | null; title?: string | null } | null;
  /** Who proposed it, by username: Homeroom bot's own changes hold its slots. */
  author?: string | null;
  /**
   * B17: the change is on a project that is just this person's, so their
   * yes alone approves it (workshop-overview.js approvedAlone). Its row says
   * Approve, as its card and the project's own Needs you do; Vote elsewhere.
   */
  approve?: boolean;
  /** #6262: the thread its page is, and how many messages in it are new. */
  threadId?: number | null;
  unread?: number;
}

/** Homeroom bot's account: its changes up for a vote hold a project's build slots. */
const BOT_USERNAME = 'homeroom_bot';

/** Pure: whether a Needs you card is a vote on one of Homeroom bot's changes, which holds a build slot until decided. */
function holdsSlot(item: NeedItem): boolean {
  return item.kind === 'proposal' && String(item.author || '').toLowerCase() === BOT_USERNAME;
}

/** Pure: the projects where a request of yours waits for one of those slots. */
function heldProjects(work: AiWork | null): Set<string> {
  const held = new Set<string>();
  for (const t of work?.waiting || []) {
    if (t.what === 'held' && t.heldBy !== 'turn' && t.app) held.add(t.app.slug);
  }
  return held;
}

/** Pure: the request or change number a Needs you card is about, as its page is addressed. */
function needNumber(item: NeedItem): number | null {
  if (item.kind === 'ballot') return item.ballot?.number || item.number || null;
  return item.number || null;
}

/**
 * Pure: the number a Needs you row shows. A change for a request goes by the
 * request's, as Homeroom bot names it in Main and as the request's own rows
 * here do (30 Oct 2026: the tab said #6032 where the bot said #6038).
 */
function shownNumber(item: NeedItem): number | null {
  if (item.kind === 'proposal' && item.request?.number) return item.request.number;
  return needNumber(item);
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
  /**
   * #6262: the thread whose page the row opens, where it has one (a private
   * thread has none: Main Chat's own "N new" covers it), and how many
   * messages in it are new. Above zero, the row draws a blue dot and a bold
   * title.
   */
  threadId: number | null;
  unread: number;
}

/**
 * How many rows each project shows in a section before its own Show more
 * (./lists.tsx groups every section's rows by project). Needs you shows the
 * most: it is what you came for. Waiting & in progress is ONE section of the
 * work under way and the work waiting, so it keeps the same three.
 */
export const GROUP_FIRST = { needs: 5, busy: 3, live: 3 } as const;

/** Pure: rows under their project, once each, in the order the projects first come. */
export function byProject<T extends { app: AiApp | null }>(rows: T[]): { app: AiApp | null; items: T[] }[] {
  const groups: { app: AiApp | null; items: T[] }[] = [];
  const at = new Map<string, number>();
  for (const row of rows) {
    const key = row.app?.slug || '';
    if (!at.has(key)) { at.set(key, groups.length); groups.push({ app: row.app, items: [] }); }
    groups[at.get(key)!].items.push(row);
  }
  return groups;
}

/**
 * Pure (#6245): the order a list was drawn in, kept while the person is
 * using it. Rows still present keep their drawn place; rows that arrived
 * since follow in their incoming order; rows that left drop out at once.
 * So a live refresh never slides a row out from under the pointer or the
 * keyboard, and the list settles into its new order when they move away.
 */
export function holdOrder<T extends { key: string }>(rows: T[], drawn: readonly string[]): T[] {
  const seen = new Set(drawn);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const kept = drawn.map((key) => byKey.get(key)).filter((row) => row !== undefined) as T[];
  return [...kept, ...rows.filter((row) => !seen.has(row.key))];
}

/**
 * Pure (#6245): a group's rows as it draws them. Folded, the row you are on
 * is lifted to just below the first few, so where you are is never hidden.
 * Opened, every row keeps its own place: pressing one past the fold no
 * longer slides it up under the pointer.
 *
 * #6262: a row with something new is never folded either. Show more is for
 * what you have already seen; hiding a new row behind it is what the dot was
 * meant to stop.
 */
export function groupRows<T extends { lit?: boolean; fresh?: boolean }>(items: T[], first: number, open: boolean): { items: T[]; shown: number; hidden: number } {
  const litAt = open ? -1 : items.findIndex((row) => row.lit);
  // Which rows past the first few must still be shown: the fresh ones and
  // the one you are on. They keep their order; the rest folds away.
  const lifted = new Set<number>();
  if (!open) {
    if (litAt >= first) lifted.add(litAt);
    items.forEach((row, i) => { if (row.fresh && i >= first) lifted.add(i); });
  }
  const rest = items.slice(first);
  const drawn = open
    ? items
    : [...items.slice(0, first), ...rest.filter((_, k) => lifted.has(first + k)), ...rest.filter((_, k) => !lifted.has(first + k))];
  const shown = open ? first : first + lifted.size;
  return { items: drawn, shown, hidden: Math.max(0, drawn.length - shown) };
}

// ── #6262: what is new in a thread ───────────────────────────────────────

/** Pure: rows with something new, for a heading's or the hero's count. */
export function freshCount(rows: { unread?: number }[]): number {
  return (rows || []).filter((row) => (Number(row.unread) || 0) > 0).length;
}

/** Pure: how many new rows each project has, by slug, for its chip. */
export function freshByProject(rows: { app: AiApp | null; unread?: number }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows || []) {
    if (!row.app || (Number(row.unread) || 0) <= 0) continue;
    counts[row.app.slug] = (counts[row.app.slug] || 0) + 1;
  }
  return counts;
}

/**
 * Pure: a group's rows with the new ones first (a stable sort: equally new
 * rows keep the order they came in), so Needs you opens on what changed.
 */
export function freshFirst<T extends { fresh?: boolean }>(lines: T[]): T[] {
  return [...(lines || [])].sort((a, b) => Number(!!b.fresh) - Number(!!a.fresh));
}

/** How many projects the filter shows as chips before its More (./lists.tsx). */
export const RAIL_PROJECTS = 3;

/** A project in any list, with how many of its rows each list holds: what the filter says about it. */
export interface ProjectTally {
  app: AiApp;
  needs: number;
  progress: number;
  waiting: number;
  live: number;
}

/**
 * Pure: the projects in any list, once each, the ones that need you most
 * first: by Needs you, then In progress, then Waiting, then name. The
 * filter's chips are the first few and its More lists them all (30 Oct 2026,
 * Evan: a chip a project, in the order they first came, was a rail nobody
 * could use with dozens of projects).
 */
export function rankProjects(rows: WorkRow[], progress: AiThread[], waiting: AiThread[], live: AiThread[]): ProjectTally[] {
  const at = new Map<string, ProjectTally>();
  const count = (app: AiApp | null, list: 'needs' | 'progress' | 'waiting' | 'live') => {
    if (!app) return;
    let tally = at.get(app.slug);
    if (!tally) { tally = { app, needs: 0, progress: 0, waiting: 0, live: 0 }; at.set(app.slug, tally); }
    tally[list] += 1;
  };
  rows.forEach((r) => count(r.app, 'needs'));
  progress.forEach((t) => count(t.app, 'progress'));
  waiting.forEach((t) => count(t.app, 'waiting'));
  live.forEach((t) => count(t.app, 'live'));
  const name = (p: ProjectTally) => p.app.name || p.app.slug;
  return [...at.values()].sort((a, b) => (b.needs - a.needs) || (b.progress - a.progress) || (b.waiting - a.waiting)
    || name(a).localeCompare(name(b)));
}

/**
 * Pure: the projects the rail shows as chips: any picked from More, then the
 * first few of the ranking. A pick from More comes first, beside All, so
 * what the lists are narrowed to is on screen even where a phone's rail
 * shows two chips; the first few keep their places, so a chip pressed there
 * does not move.
 */
export function railProjects(ranked: ProjectTally[], picked: string[]): AiApp[] {
  const past = ranked.slice(RAIL_PROJECTS).filter((p) => picked.includes(p.app.slug));
  return [...past, ...ranked.slice(0, RAIL_PROJECTS)].map((p) => p.app);
}

const PILLS: Record<string, string> = {
  proposal: 'messages:ai.pill.vote',
  governance: 'messages:ai.pill.vote',
  ballot: 'messages:ai.pill.pick',
  question: 'messages:ai.pill.answer',
  bot_question: 'messages:ai.pill.answer',
  plan: 'messages:ai.pill.buildIt',
  decide: 'messages:ai.pill.decide',
  build_stopped: 'messages:ai.pill.tryAgain',
};

/**
 * Pure: the page a Needs you card is decided on. A change built for a
 * request has no page of its own (one page per thread): its address lands on
 * the request's page, so a Vote row links there too, and the row it lights is
 * that page's (3 Nov 2026, #6227: the numbers can differ, so matching the
 * change's own route never lit it).
 */
export function needHref(item: NeedItem): string | null {
  if (item.href) return item.href;
  const slug = item.app?.slug;
  if (!slug) return null;
  const app = encodeURIComponent(slug);
  if (item.kind === 'governance') return `#app/${app}/dev/governance/${Number(item.id)}`;
  const closes = item.kind === 'proposal' ? Number(item.request?.number) : 0;
  if (closes > 0) return `#app/${app}/dev/issues/${closes}`;
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
    if (!item.app) continue;
    for (const number of [needNumber(item), shownNumber(item)]) {
      if (number) owed.add(`${item.app.slug}#${number}`);
    }
  }
  return owed;
}

/** Pure: whether a thread is one the feed already lists, by its request's number or its change's. */
function isOwed(owed: Set<string>, t: AiThread): boolean {
  if (!t.app) return false;
  return (!!t.number && owed.has(`${t.app.slug}#${t.number}`))
    || (!!t.change?.number && owed.has(`${t.app.slug}#${t.change.number}`));
}

/**
 * Pure (#6153): the request a private thread was filed as, or posted its
 * plan on, on a project, as `slug#number`; null for any other thread.
 */
export function filedKey(p: AiPrivate): string | null {
  if ((p.state !== 'filed' && p.state !== 'posted') || !p.app || !(Number(p.resultRef) > 0)) return null;
  return `${p.app.slug}#${Number(p.resultRef)}`;
}

/**
 * Pure (#6153): each request's private thread, by `slug#number`: the newest
 * thread filed as it or posted on it (the list comes newest first).
 */
function filedThreads(work: AiWork | null): Map<string, number> {
  const filed = new Map<string, number>();
  for (const p of work?.private || []) {
    if (p.state === 'done') continue;
    const key = filedKey(p);
    if (key && !filed.has(key)) filed.set(key, p.rootId);
  }
  return filed;
}

/** Pure (#6153): a request's row, carrying the private thread it was filed from, which it opens. */
function withThread(filed: Map<string, number>, t: AiThread): AiThread {
  const rootId = t.app && t.number ? filed.get(`${t.app.slug}#${t.number}`) : undefined;
  return rootId ? { ...t, rootId } : t;
}

/** Pure (#6153): every request with a row in any list, as `slug#number`. */
function listedKeys(needs: NeedItem[] | null, work: AiWork | null): Set<string> {
  const listed = owedKeys(needs);
  for (const t of [...(work?.needs || []), ...(work?.next || []), ...(work?.waiting || []), ...(work?.live || [])]) {
    if (t.app && t.number) listed.add(`${t.app.slug}#${t.number}`);
  }
  return listed;
}

/**
 * Pure: Needs you, in order: the feed's cards, the bot's plans waiting for
 * Build it, then your private threads. #6153: a design thread filed as a
 * request is that request's row once the request has one, in any list (in
 * In progress, Waiting or Live it opens the thread: inProgress, upNext,
 * liveThisWeek), never a second "Only you" row. One whose request is in no
 * list (closed, live long ago) is still listed here.
 */
export function needsYou(needs: NeedItem[] | null, work: AiWork | null): WorkRow[] {
  const rows: WorkRow[] = [];
  const owed = owedKeys(needs);
  const held = heldProjects(work);
  const filed = filedThreads(work);
  const listed = listedKeys(needs, work);
  for (const item of needs || []) {
    const app = item.app || null;
    rows.push({
      key: `need:${item.kind}:${item.id}`,
      title: (item.kind === 'ballot' && item.ballot?.title) || item.title || '',
      app,
      who: 'all',
      // A vote on a change of Homeroom bot's, where a request of yours waits
      // for one of its slots: deciding it lets that request be built.
      sub: app && held.has(app.slug) && holdsSlot(item)
        ? { id: 'messages:ai.row.voteFreesSlot', values: where(app, shownNumber(item)) }
        : whereLine(app, shownNumber(item)),
      pill: item.kind === 'proposal' && item.approve === true
        ? { id: 'messages:ai.pill.approve' }
        : { id: PILLS[item.kind] || 'messages:ai.pill.needsYou' },
      href: needHref(item),
      rootId: null,
      // #6262: a feed item's thread, and what is new in it.
      threadId: item.threadId ?? null,
      unread: Math.max(0, Number(item.unread) || 0),
    });
  }
  for (const t of work?.needs || []) {
    if (isOwed(owed, t)) continue;
    rows.push({
      key: `${t.what === 'decide' ? 'decide' : t.what === 'build_stopped' ? 'stopped' : 'plan'}:${t.threadId}`,
      title: t.title || '',
      app: t.app,
      who: 'all',
      // Homeroom bot read it and handed it back (its verdict "a person must
      // decide"): nothing moves until a person does, so it is Needs you's,
      // and says why rather than "Nobody is building it yet" (30 Oct 2026).
      // A build of Homeroom bot's that came to nothing waits on somebody
      // asking again, so it is here too, with Try again.
      sub: t.what === 'decide'
        ? { id: 'messages:ai.row.decide', values: where(t.app, t.number) }
        : t.what === 'build_stopped'
          ? { id: 'messages:ai.row.buildStopped', values: where(t.app, t.number) }
          : whereLine(t.app, t.number),
      pill: { id: PILLS[t.what] || 'messages:ai.pill.needsYou' },
      href: t.href,
      rootId: null,
      threadId: t.threadId,
      unread: Math.max(0, Number(t.unread) || 0),
    });
  }
  for (const p of work?.private || []) {
    // #6159: a done thread is finished (the server leaves it out too).
    if (p.state === 'done') continue;
    const key = filedKey(p);
    if (key && filed.get(key) === p.rootId && listed.has(key)) continue;
    // 1 Nov 2026: a thread about a request or a change is drawn by it, its
    // number before its title as a request's row is ("#18 Dark mode").
    const about = p.about && p.about.number > 0 && p.app ? p.about : null;
    rows.push({
      key: `private:${p.rootId}`,
      title: p.title,
      app: p.app,
      who: p.app ? 'me' : 'solo',
      sub: about
        ? {
          id: about.kind === 'change'
            ? (p.app?.changesOnGithub ? 'messages:ai.row.privateAboutChangePr' : 'messages:ai.row.privateAboutChange')
            : 'messages:ai.row.privateAbout',
          values: { project: p.app!.name || p.app!.slug, number: about.number },
        }
        : p.app
          ? { id: 'messages:ai.row.privateDraft', values: { project: p.app.name || p.app.slug } }
          : { id: 'messages:ai.row.privateIdea' },
      pill: null,
      href: null,
      rootId: p.rootId,
      // A private thread is not a `threads` row: Main Chat's "N new" counts it.
      threadId: null,
      unread: 0,
    });
  }
  return rows;
}

/** Pure: how many rows of Needs you ask something of you (a pill): the heading's and the hero's count. */
export function owedCount(rows: WorkRow[]): number {
  return rows.filter((row) => row.pill).length;
}

/** The phone's second line for a Needs you row, by the reason its tooltip gives. */
const WHY: Record<string, string> = {
  'messages:ai.row.decide': 'messages:ai.why.decide',
  'messages:ai.row.buildStopped': 'messages:ai.why.buildStopped',
  'messages:ai.row.voteFreesSlot': 'messages:ai.why.voteFreesSlot',
};

/**
 * Pure: a Needs you row's reason, where it is news: a phone shows it under
 * the title, where nothing hovers to show the tooltip. A plain vote or a
 * plan says nothing more than its pill does, so it has none.
 */
export function whyOf(row: WorkRow): Phrase | null {
  const id = WHY[row.sub.id];
  return id ? { id } : null;
}

/** Pure: the same for an In progress or Waiting row: a slot your votes can free. */
export function threadWhy(t: AiThread): Phrase | null {
  if (t.what === 'held' && t.yourVotes) return { id: 'messages:ai.why.heldYours', values: { count: t.yourVotes } };
  return null;
}

/**
 * Pure: In progress, less any thread the feed already lists. #6153: a
 * request filed from a private thread of yours carries that thread
 * (`rootId`), which its row opens.
 */
export function inProgress(needs: NeedItem[] | null, work: AiWork | null): AiThread[] {
  const owed = owedKeys(needs);
  const filed = filedThreads(work);
  return (work?.next || []).filter((t) => !isOwed(owed, t)).map((t) => withThread(filed, t));
}

/**
 * Pure: Waiting, less any thread the feed already lists. A request held for
 * one of Homeroom bot's slots counts the bot's changes on its project that
 * wait on your vote: those votes are what frees one. #6153: and a request
 * filed from a private thread carries it, as In progress does.
 */
export function upNext(needs: NeedItem[] | null, work: AiWork | null): AiThread[] {
  const owed = owedKeys(needs);
  const filed = filedThreads(work);
  return (work?.waiting || []).filter((t) => !isOwed(owed, t)).map((t) => {
    const row = withThread(filed, t);
    if (row.what !== 'held' || row.heldBy === 'turn' || !row.app) return row;
    const yourVotes = (needs || []).filter((item) => item.app?.slug === row.app!.slug && holdsSlot(item)).length;
    return yourVotes ? { ...row, yourVotes } : row;
  });
}

/** Pure: Live this week; #6153: a request filed from a private thread carries it, as In progress does. */
export function liveThisWeek(work: AiWork | null): AiThread[] {
  const filed = filedThreads(work);
  return (work?.live || []).map((t) => withThread(filed, t));
}

/** The words of an In progress or Waiting row's tooltip, by what it waits on. */
const THREAD_WORDS: Record<string, string> = {
  going_live: 'messages:ai.next.goingLive',
  merging: 'messages:ai.next.merging',
  fixing: 'messages:ai.next.fixing',
  revising: 'messages:ai.next.revising',
  building: 'messages:ai.next.building',
  reading: 'messages:ai.next.reading',
  reading_reply: 'messages:ai.next.readingReply',
  vote: 'messages:ai.up.vote',
  checking: 'messages:ai.up.checking',
  fix_queued: 'messages:ai.up.fixQueued',
  followup_queued: 'messages:ai.up.followUpQueued',
  build_queued: 'messages:ai.up.buildQueued',
  held: 'messages:ai.up.held',
  stalled: 'messages:ai.up.stalled',
  queued: 'messages:ai.up.queued',
  on_hold: 'messages:ai.up.onHold',
  not_picked_up: 'messages:ai.up.notPickedUp',
  // #6158: what a request nobody is moving waits on.
  needs_person: 'messages:ai.up.needsPerson',
  nothing_to_build: 'messages:ai.up.nothingToBuild',
  not_read: 'messages:ai.up.notRead',
  operator: 'messages:ai.up.operator',
  // 1 Nov 2026: their own request, which the bot waits to plan with them.
  awaiting_plan: 'messages:ai.up.awaitingPlan',
};

/**
 * The twin of a row's wording on a GitHub-hosted project, where a change's
 * number is written "PR 12" and never "#12" (lib/change-ref.ts). One literal
 * table, so every id stays a whole literal for the language inventory. A
 * count's twin keeps the runtime's `_one`/`_other` suffix (`quiet` ->
 * `quietPr`). Ids not in the table are unaffected.
 */
const PR_TWIN: Record<string, string> = {
  'messages:ai.next.goingLive': 'messages:ai.next.goingLivePr',
  'messages:ai.next.merging': 'messages:ai.next.mergingPr',
  'messages:ai.next.fixing': 'messages:ai.next.fixingPr',
  'messages:ai.next.revising': 'messages:ai.next.revisingPr',
  'messages:ai.next.reading': 'messages:ai.next.readingPr',
  'messages:ai.next.readingReply': 'messages:ai.next.readingReplyPr',
  'messages:ai.next.building': 'messages:ai.next.buildingPr',
  'messages:ai.next.botBuilding': 'messages:ai.next.botBuildingPr',
  'messages:ai.next.youBuilding': 'messages:ai.next.youBuildingPr',
  'messages:ai.next.claimed': 'messages:ai.next.claimedPr',
  'messages:ai.up.vote': 'messages:ai.up.votePr',
  'messages:ai.up.checking': 'messages:ai.up.checkingPr',
  'messages:ai.up.voteYes': 'messages:ai.up.voteYesPr',
  'messages:ai.up.voteNo': 'messages:ai.up.voteNoPr',
  'messages:ai.up.fixQueued': 'messages:ai.up.fixQueuedPr',
  'messages:ai.up.followUpQueued': 'messages:ai.up.followUpQueuedPr',
  'messages:ai.up.buildQueued': 'messages:ai.up.buildQueuedPr',
  'messages:ai.up.held': 'messages:ai.up.heldPr',
  'messages:ai.up.heldTurn': 'messages:ai.up.heldTurnPr',
  'messages:ai.up.heldYours': 'messages:ai.up.heldYoursPr',
  'messages:ai.up.stalled': 'messages:ai.up.stalledPr',
  'messages:ai.up.queued': 'messages:ai.up.queuedPr',
  'messages:ai.up.onHold': 'messages:ai.up.onHoldPr',
  'messages:ai.up.notPickedUp': 'messages:ai.up.notPickedUpPr',
  'messages:ai.up.quiet': 'messages:ai.up.quietPr',
  'messages:ai.up.inLine': 'messages:ai.up.inLinePr',
  'messages:ai.up.heldPlace': 'messages:ai.up.heldPlacePr',
  'messages:ai.up.needsPerson': 'messages:ai.up.needsPersonPr',
  'messages:ai.up.needsPersonWhy': 'messages:ai.up.needsPersonWhyPr',
  'messages:ai.up.nothingToBuild': 'messages:ai.up.nothingToBuildPr',
  'messages:ai.up.nothingToBuildWhy': 'messages:ai.up.nothingToBuildWhyPr',
  'messages:ai.up.notRead': 'messages:ai.up.notReadPr',
  'messages:ai.up.operator': 'messages:ai.up.operatorPr',
  'messages:ai.up.awaitingPlan': 'messages:ai.up.awaitingPlanPr',
  'messages:ai.live.row': 'messages:ai.live.rowPr',
};

/** Whether a row names a change on a project whose code is on GitHub. */
export function changeOnGithub(t: AiThread): boolean {
  return t.kind === 'change' && !!t.app?.changesOnGithub;
}

/** Pure: `id`'s twin where a change on GitHub is written "PR N", else `id`. */
export function prWord(id: string, onGithub: boolean): string {
  return onGithub ? (PR_TWIN[id] || id) : id;
}

/** Pure: one In progress or Waiting row's whole line (its tooltip): its project, and what it waits on. */
export function nextWords(t: AiThread): Phrase {
  const words = nextWordsBase(t);
  return changeOnGithub(t) ? { ...words, id: prWord(words.id, true) } : words;
}

function nextWordsBase(t: AiThread): Phrase {
  const values = where(t.app, t.number);
  if (t.what === 'not_picked_up') {
    if (!t.number) return { id: 'messages:ai.up.notPickedUpBare', values: { project: values.project } };
    if (t.quietDays) return { id: 'messages:ai.up.quiet', values: { ...values, count: t.quietDays } };
  }
  if (t.what === 'vote' && t.myVote === 'yes') return { id: 'messages:ai.up.voteYes', values };
  if (t.what === 'vote' && t.myVote === 'no') return { id: 'messages:ai.up.voteNo', values };
  // A decision has no number: its project, and that it waits for votes.
  if (t.what === 'decision') {
    const project = { project: values.project };
    if (t.myVote === 'yes') return { id: 'messages:ai.up.decisionYes', values: project };
    if (t.myVote === 'no') return { id: 'messages:ai.up.decisionNo', values: project };
    return { id: 'messages:ai.up.decision', values: project };
  }
  if (t.what === 'held' && t.yourVotes) return { id: 'messages:ai.up.heldYours', values: { ...values, count: t.yourVotes } };
  // #6158: its place in line, where the bot's records know it.
  if (t.what === 'queued' && t.place) return { id: 'messages:ai.up.inLine', values: { ...values, place: t.place } };
  if (t.what === 'held' && t.place) {
    return t.heldBy === 'turn'
      ? { id: 'messages:ai.up.inLine', values: { ...values, place: t.place } }
      : { id: 'messages:ai.up.heldPlace', values: { ...values, place: t.place } };
  }
  if (t.what === 'held' && t.heldBy === 'turn') return { id: 'messages:ai.up.heldTurn', values };
  // #6158: Homeroom bot's own reason, where it gave one.
  if (t.what === 'needs_person' && t.reason) return { id: 'messages:ai.up.needsPersonWhy', values: { ...values, reason: t.reason } };
  if (t.what === 'nothing_to_build' && t.reason) return { id: 'messages:ai.up.nothingToBuildWhy', values: { ...values, reason: t.reason } };
  if (t.what === 'building' && t.by === 'bot') return { id: 'messages:ai.next.botBuilding', values };
  if (t.what === 'building' && t.by === 'you') return { id: 'messages:ai.next.youBuilding', values };
  // Claimed, with no change yet: who has it, not "Nobody is building it yet".
  if (t.what === 'building' && t.claimedBy) return { id: 'messages:ai.next.claimed', values: { ...values, username: t.claimedBy } };
  return { id: THREAD_WORDS[t.what] || 'messages:ai.row.where', values };
}

/** The one word on the right of an In progress or Waiting row, by what it waits on. Whole ids, so the inventory finds them. */
const SHORT_WORDS: Record<string, string> = {
  going_live: 'messages:ai.short.goingLive',
  merging: 'messages:ai.short.merging',
  fixing: 'messages:ai.short.fixing',
  revising: 'messages:ai.short.revising',
  reading: 'messages:ai.short.reading',
  reading_reply: 'messages:ai.short.readingReply',
  building: 'messages:ai.short.building',
  vote: 'messages:ai.short.votes',
  checking: 'messages:ai.short.checks',
  decision: 'messages:ai.short.votes',
  fix_queued: 'messages:ai.short.builder',
  followup_queued: 'messages:ai.short.builder',
  queued: 'messages:ai.short.builder',
  build_queued: 'messages:ai.short.turn',
  held: 'messages:ai.short.slot',
  stalled: 'messages:ai.short.stalled',
  on_hold: 'messages:ai.short.monday',
  not_picked_up: 'messages:ai.short.nobody',
  // #6158: what a request nobody is moving waits on.
  needs_person: 'messages:ai.short.needsPerson',
  nothing_to_build: 'messages:ai.short.nothingToBuild',
  not_read: 'messages:ai.short.notRead',
  operator: 'messages:ai.short.operator',
  awaiting_plan: 'messages:ai.short.yourPlan',
};

/**
 * #6158: the Waiting rows nobody is moving, which the tab folds under one
 * "Not moving" head: open with no claim, or a person's to decide, or
 * nothing to build, not read yet, or an operator task.
 */
export const NOT_MOVING = new Set<string>(['not_picked_up', 'needs_person', 'nothing_to_build', 'not_read', 'operator']);

/**
 * Pure: the one word on the right of an In progress or Waiting row
 * (./lists.tsx): who is at it, or what it waits on. The whole line
 * (nextWords) is its tooltip.
 */
export function shortWords(t: AiThread): Phrase {
  if (t.what === 'building' && t.by === 'bot') return { id: 'messages:ai.short.bot' };
  if (t.what === 'building' && t.by === 'you') return { id: 'messages:ai.short.you' };
  if (t.what === 'building' && t.claimedBy) return { id: 'messages:ai.short.claimed', values: { username: t.claimedBy } };
  // #6158: its place in line, where the bot's records know it.
  if (t.what === 'queued' && t.place) return { id: 'messages:ai.short.inLine', values: { place: t.place } };
  if (t.what === 'held' && t.place) {
    return t.heldBy === 'turn'
      ? { id: 'messages:ai.short.inLine', values: { place: t.place } }
      : { id: 'messages:ai.short.heldPlace', values: { place: t.place } };
  }
  if (t.what === 'not_picked_up' && t.quietDays) return { id: 'messages:ai.short.quiet', values: { count: t.quietDays } };
  if (t.what === 'held' && t.heldBy === 'turn') return { id: 'messages:ai.short.turn' };
  return { id: SHORT_WORDS[t.what] || 'messages:ai.short.waiting' };
}

/**
 * Pure: the hero's line under the bot's name: what needs you, what is in
 * progress. A zero says nothing (Y03, audit 2 Nov 2026): each half is said
 * only above zero, and with neither there is no line ("In progress: 0" was).
 * #6262: `fresh` is how many of those threads have something new, said
 * between the two, and only when there is any.
 */
export function heroWords(needs: number, next: number, fresh = 0): Phrase | null {
  const anyFresh = fresh > 0;
  if (needs > 0 && anyFresh && next > 0) return { id: 'messages:ai.hero.bothFresh', values: { needs, fresh, next, count: fresh } };
  if (needs > 0 && anyFresh) return { id: 'messages:ai.hero.needsFresh', values: { needs, fresh, count: fresh } };
  if (needs > 0 && next > 0) return { id: 'messages:ai.hero.both', values: { needs, next } };
  if (needs > 0) return { id: 'messages:ai.hero.needs', values: { needs } };
  if (next > 0) return { id: 'messages:ai.hero.next', values: { next } };
  return null;
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
