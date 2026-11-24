/**
 * The Homeroom bot tab's rows, built once for both of its faces (11 Nov
 * 2026): the standard list (./lists.tsx) and the list the looks draw
 * (./frame-list.tsx). A row is a `Line`: what it is, its project, the name
 * of its glyph, its number, its title, the one word on its right, its
 * tooltip, and its press. Which projects the chips offer, what is new, what
 * a search keeps, the counts over each list and the notes that stand in for
 * an empty one are decided here too, so the two faces cannot disagree.
 *
 * Nothing here draws: a glyph is a name (`Glyph`), and each face has its own
 * icon for it.
 */
import { dayNumber, inZone, zonedDay } from '../../lib/time-zone';
import { getDateLocale } from '../../lib/i18n/runtime';
import { useMessages } from '../../lib/i18n/react';
import { tabLacks, useTabBuild } from '../../lib/tab-build';
import { rowKey } from './column';
import { botTabAddress } from './door';
import type { HistoryKind } from './filter-address';
import { byMonth, historyGlyph, historyTooltip, historyWords, shortDay, type HistoryRow, type HistoryState } from './history';
import {
  changeOnGithub, freshByProject, freshCount, nextWords, notMoving, prWord, railProjects, rankProjects, shortWords, threadWhy, whyOf, withProjects,
  type AiApp, type AiThread, type Phrase, type WorkRow,
} from './model';
import { cleanQuery, foundDay, markParts, type Found, type MarkPart } from './search';

/** What a row's glyph shows, by name. */
export type Glyph =
  | 'chat' | 'play' | 'hand' | 'check' | 'again' | 'warning' | 'lock' | 'ballot'
  | 'upload' | 'eye' | 'cog' | 'reply' | 'code' | 'clock' | 'camera' | 'x' | 'bubble';

/**
 * The one thing at the end of a row on the standard list's three bands
 * (24 Nov 2026, ./lists.tsx): what the person does in Needs you (`act`, a
 * verb), where it stands in In progress (`state`), and in Done a tick for
 * what went live (`tick`, its text the spoken name) or the word History says
 * for how anything else ended (`word`).
 */
export interface LineEnd {
  kind: 'act' | 'state' | 'tick' | 'word';
  text: string;
}

export interface Line {
  key: string;
  /** What the row is, for the page's checks: need, plan, decide, … or a thread's `what`. */
  kind: string;
  app: AiApp | null;
  glyph: Glyph;
  number: number | null;
  /** The number names a change on GitHub: it reads "PR 12", never "#12". */
  pr?: boolean;
  title: string;
  /** #6421: how many requests the thread holds, for "· 10 requests" after the title. */
  requests?: number;
  right: string;
  tooltip: string;
  /** On a phone, a second line: the reason, where it is news. */
  why: string | null;
  /** Yours to do: the glyph and the word in the accent. */
  owe: boolean;
  /** Its chat is the one in the column beside the list: where you are. */
  lit?: boolean;
  /** #6262: someone has written in its thread since you last opened it. */
  fresh?: boolean;
  /** 18 Nov 2026: it moved while the page was up (./model.ts movedSince), so it is not folded. */
  moved?: boolean;
  open: () => void;
  /** #6159: a private thread's row: its ⋯ has Mark done. */
  done?: { rootId: number; mark: () => void } | null;
  /**
   * 24 Nov 2026 (mobile 04): a thread somebody named you in: its Dismiss,
   * beside Reply at the row's end, which waves the @ off.
   */
  dismiss?: (() => void) | null;
  /** Mobile 04: a thread you only wrote or were named in, which In progress draws below your own. */
  tookPart?: boolean;
  /** History: a row in a private community the person left (its project's name says so). */
  left?: boolean;
  /** When it started needing the viewer, for the day its row is grouped under. */
  at?: string | null;
  /*
   * The three bands' row (24 Nov 2026, ./lists.tsx). The look's list
   * (./frame-list.tsx) draws the fields above and never these.
   */
  /** The project's name, or Only you for a private thread in no project. */
  project?: string;
  /** Its number as the list writes it (#6277, PR 7077); Only you for a private thread; else ''. */
  ref?: string;
  /** The second line: its reason and its time, joined by a middle dot. */
  sub?: string;
  /** The one thing at the row's end. */
  end?: LineEnd;
  /** Done: which of History's kinds it is, for Done's kind chips (`thread` is All's alone). */
  past?: HistoryKind | 'thread';
}

/**
 * A message the search found (13 Nov 2026, ./search.ts): a link to it, its
 * snippet split at the words that matched, where it is (its thread's name,
 * or the chat itself), its day, and the whole of that as its name.
 */
export interface FoundLine {
  key: string;
  /** The tab's address of the message: its thread, or the chat, at it (./door.ts). */
  href: string;
  /** The message the row opens, so its words can be marked there (./search-mark.ts). */
  messageId: number;
  /** The query it was found by, as the search asked it (./search.ts cleanQuery). */
  q: string;
  /** It is in a thread; otherwise in the chat itself. */
  thread: boolean;
  parts: MarkPart[];
  place: string;
  date: string;
  /** The row's accessible name and tooltip: who wrote it, its words, where and when. */
  name: string;
}

/** Needs you's glyph, by what the row asks. */
function needGlyph(row: WorkRow): Glyph {
  const kind = row.key.startsWith('need:') ? row.key.split(':')[1] : row.key.split(':')[0];
  if (kind === 'question' || kind === 'bot_question') return 'chat';
  if (kind === 'plan') return 'play';
  if (kind === 'decide') return 'hand';
  // #6306: the ask is already there: nothing to decide, only to close.
  if (kind === 'works') return 'check';
  if (kind === 'stopped') return 'again';
  if (kind === 'fix_stopped') return 'again';
  if (kind === 'fix_yours') return 'warning';
  if (kind === 'bot_fix_failed') return 'warning';
  if (kind === 'private') return 'lock';
  // Mobile 04: somebody named you; you reply.
  if (kind === 'named') return 'reply';
  return 'ballot';
}
/** In progress's glyph, by its stage. */
function nextGlyph(t: AiThread): Glyph {
  const code = t.work.line?.code;
  if (t.work.stage === 'going_live') return 'upload';
  if (t.work.stage === 'reading' || t.work.stage === 'planning') return 'eye';
  if (code === 'fixing') return 'cog';
  // #6282: an update is the bot following up on it.
  if (code === 'revising') return 'reply';
  return 'code';
}
/**
 * Waiting's glyph: a clock, or a camera while the only thing its change
 * waits on is its before & after screenshots.
 */
export function waitGlyph(t: AiThread): Glyph {
  return t.work.stage === 'checking' && t.work.line?.code === 'shots' ? 'camera' : 'clock';
}
/** A finished item's glyph: what became of it (./history.ts historyGlyph). */
const HISTORY_GLYPH: Record<ReturnType<typeof historyGlyph>, Glyph> = { live: 'check', closed: 'x', request: 'bubble', vote: 'ballot', private: 'lock' };

type Say = (id: string, values?: Record<string, string | number>) => string;

/** A live row's day: today, yesterday, or the weekday. */
function dayOf(at: string | null, t: Say): string {
  if (!at) return '';
  const d = new Date(at);
  // #6479: calendar days in the zone picked in Settings > Language.
  const days = dayNumber(new Date(Date.now())) - dayNumber(d);
  if (days <= 0) return t('messages:ai.short.today');
  if (days === 1) return t('messages:ai.short.yesterday');
  return d.toLocaleDateString(undefined, inZone({ weekday: 'short' }));
}

/**
 * Pure (6 Nov 2026): which day a row's divider says, "Today", "Yesterday", or
 * the weekday and date ("Tuesday 3 November"), read in the interface's own
 * language and the reader's time zone.
 */
export function dayHeading(at: string | null | undefined, t: Say, locale: string | undefined): string {
  const d = new Date(String(at || ''));
  if (!Number.isFinite(d.getTime())) return '';
  const today = new Date(Date.now());
  // #6479: calendar days in the zone picked in Settings > Language, the same
  // zone ./model.ts dayKey groups by, so a heading names its group's day.
  const days = dayNumber(today) - dayNumber(d);
  if (days <= 0) return t('messages:ai.short.today');
  if (days === 1) return t('messages:ai.short.yesterday');
  // The year too, only when it is another one (as History's months say it).
  const other = zonedDay(d).year !== zonedDay(today).year;
  return d.toLocaleDateString(locale, inZone({ weekday: 'long', day: 'numeric', month: 'long', ...(other ? { year: 'numeric' } : {}) }));
}

/**
 * THE THREE BANDS' ROW (24 Nov 2026, Evan's review of the thread list). A
 * Needs you row ends in what the person does, said as a verb: the pill the
 * model gives it where that is one already, and these where it is not. The
 * look's list keeps the model's own words (`right`).
 */
const VERBS: Readonly<Record<string, string>> = {
  'messages:ai.pill.answer': 'messages:ai.pill.reply',
  'messages:ai.pill.decide': 'messages:ai.pill.reply',
  // #6389: your own change waits on your fix; its reason line says which.
  'messages:ai.pill.testsFailing': 'messages:ai.pill.fixIt',
  'messages:ai.pill.conflicts': 'messages:ai.pill.fixIt',
  // Mobile 04: somebody named you with @.
  'messages:ai.pill.named': 'messages:ai.pill.reply',
};

/** A Needs you row's verb: its pill's (VERBS where that is no verb), or Read for a private thread. */
export function verbOf(pill: Phrase | null): string {
  if (!pill) return 'messages:ai.pill.read';
  return VERBS[pill.id] || pill.id;
}

/**
 * A private thread's reason, the part of its line after "Only you · Garden
 * club", which its row's project column already says.
 */
const PRIVATE_REASON: Readonly<Record<string, string>> = {
  'messages:ai.row.privateDraft': 'messages:ai.reason.notPosted',
  'messages:ai.row.privateFiled': 'messages:ai.reason.filed',
  'messages:ai.row.privatePosted': 'messages:ai.reason.posted',
  'messages:ai.row.privatePutAway': 'messages:ai.reason.putAway',
  'messages:ai.row.privateIdea': 'messages:ai.reason.noCommunity',
  'messages:ai.row.privateAbout': 'messages:ai.reason.about',
  'messages:ai.row.privateAboutChange': 'messages:ai.reason.aboutChange',
  'messages:ai.row.privateAboutChangePr': 'messages:ai.reason.aboutChangePr',
};

/** The Needs you feed's kinds that are a vote, whose reason is "Up for a vote" where nothing else says one. */
const VOTE_KINDS = new Set(['proposal', 'governance', 'ballot']);

/**
 * Pure: a Needs you row's reason, from what it already says (never a new
 * summary): its second line where it has one (whyOf), a private thread's
 * state, or, for a vote with none, its stage's words.
 */
export function needReason(row: WorkRow): Phrase | null {
  const why = whyOf(row);
  if (why) return why;
  if (row.rootId) {
    const id = PRIVATE_REASON[row.sub.id];
    return id ? { id, values: row.sub.values } : null;
  }
  const kind = row.key.startsWith('need:') ? row.key.split(':')[1] : '';
  return VOTE_KINDS.has(kind) ? { id: 'core:work.stage.upForVote' } : null;
}

/**
 * Pure: a row's day, in the reader's zone and the interface's language:
 * today, yesterday, the weekday within the week, else the date ("Nov 3",
 * with the year when it is another one). `alone` starts a line ("Today");
 * otherwise it follows other words ("Went live today").
 */
export function dayWord(at: string | null | undefined, t: Say, locale: string | undefined, alone: boolean): string {
  const d = new Date(String(at || ''));
  if (!Number.isFinite(d.getTime())) return '';
  const today = new Date(Date.now());
  const days = dayNumber(today) - dayNumber(d);
  if (days <= 0) return t(alone ? 'messages:ai.short.today' : 'messages:ai.when.today');
  if (days === 1) return t(alone ? 'messages:ai.short.yesterday' : 'messages:ai.when.yesterday');
  if (days < 7) return d.toLocaleDateString(locale, inZone({ weekday: 'long' }));
  if (zonedDay(d).year !== zonedDay(today).year) {
    return d.toLocaleDateString(locale, inZone({ month: 'short', day: 'numeric', year: 'numeric' }));
  }
  return shortDay(at, locale);
}

/**
 * Pure (24 Nov 2026, mobile 04): your own threads first, then the ones you
 * only wrote or were named in (`tookPart`), each run in the order it came.
 */
export function ownFirst<T extends { tookPart?: boolean }>(rows: readonly T[]): T[] {
  return [...rows.filter((row) => !row.tookPart), ...rows.filter((row) => row.tookPart)];
}

/** Pure: rows newest first by `at`; a row with no readable time keeps its order after the rest. */
export function newestFirst<T extends { at?: string | null }>(rows: readonly T[]): T[] {
  return rows
    .map((row, i) => ({ row, i, at: new Date(String(row.at || '')).getTime() }))
    .sort((a, b) => {
      const ha = Number.isFinite(a.at);
      const hb = Number.isFinite(b.at);
      if (ha !== hb) return ha ? -1 : 1;
      return ha && hb && a.at !== b.at ? b.at - a.at : a.i - b.i;
    })
    .map(({ row }) => row);
}

/** How many rows each band shows before its Show more, and how many more Done's adds each time. */
export const BAND_FIRST = { needs: 6, busy: 5, done: 5 } as const;
export const DONE_STEP = 20;

/** What the page hands its list, whichever face draws it (./lists.tsx AiLists says each). */
export interface AiLinesInput {
  query?: string;
  lit?: string | null;
  ready: boolean;
  rows: WorkRow[];
  owed: number;
  progress: AiThread[];
  waiting: AiThread[];
  live: AiThread[];
  openRow: (row: WorkRow) => void;
  openThread: (t: AiThread) => void;
  onDone?: (rootId: number) => void;
  /** Mobile 04: Dismiss on a thread somebody named you in. */
  onDismiss?: (row: WorkRow) => void;
  picked?: readonly string[];
  onPick?: (slugs: string[]) => void;
  appFor?: (slug: string) => AiApp | null;
  history?: HistoryState | null;
  openHistory?: (row: HistoryRow) => void;
  /** Done's kind chip (History's): the three bands' Done keeps only that kind, this week's rows too. */
  historyKind?: HistoryKind | null;
  /**
   * What the search in messages answered (./search.ts useBotSearch): null
   * while the first answer is on its way. Left out by a caller that has no
   * such search, for which only the threads are searched.
   */
  found?: Found | null;
}

/**
 * #6744: which projects the chips show: any when none is picked, else only
 * a picked one. The lists and the hero under the bot's name both ask this,
 * so a saved project's counts cannot disagree with the list below them.
 */
export function showsPicked(picked: readonly string[]): (app: AiApp | null) => boolean {
  return (app) => !picked.length || (!!app && picked.includes(app.slug));
}

/**
 * The lists' rows and what is said around them, from what the page read. A
 * hook only because it reads the catalog and this tab's build (#6233).
 */
export function useAiLines({
  query = '', lit = null, ready, rows, owed, progress, waiting, live, openRow, openThread, onDone, onDismiss,
  picked: pickedIn = [], onPick, appFor, history = null, openHistory, historyKind = null, found,
}: AiLinesInput) {
  const t = useMessages('messages');
  const locale = getDateLocale();
  // The three bands' row (VERBS above): the project's name, its number as
  // the list writes it, and the second line, its reason then its time.
  const projectOf = (app: AiApp | null) => (app ? app.name || app.slug : t('messages:ai.short.private'));
  // A private thread in no project is Only you by its project's name already.
  const refOf = (number: number | null, pr: boolean, solo: boolean, app: AiApp | null = null) => (solo
    ? (app ? t('messages:ai.short.private') : '')
    : number ? t(pr ? 'messages:ai.live.numberPr' : 'messages:ai.live.number', { number }) : '');
  const lineOf = (reason: string | null, when: string, alone: string) => (reason
    ? (when ? t('messages:ai.row.reasonWhen', { reason, when }) : reason)
    : alone);
  const say = (p: Phrase | null): string | null => {
    if (!p) return null;
    // A stage's words inside a row's line are translated first.
    const nested = p.nested ? Object.fromEntries(Object.entries(p.nested).map(([k, q]) => [k, say(q) || ''])) : null;
    return t(p.id, nested ? { ...p.values, ...nested } : p.values);
  };
  // SEARCH (#6398, 6 Nov 2026): a row matches when its title, its number
  // ("6011" or "#6011") or its project's name or address contains what was
  // typed, in either case. It narrows the rows the chips already chose, so
  // the two apply together. History is searched as far as it has loaded.
  const q = query.trim().toLowerCase();
  const searching = !!q;
  function matches(line: Line): boolean {
    if (!searching) return true;
    const number = line.number == null ? '' : String(line.number);
    return [line.title, number, number ? `#${number}` : '', line.app?.name || '', line.app?.slug || '']
      .some((text) => text.toLowerCase().includes(q));
  }
  function kept<T extends Line>(lines: T[]): T[] {
    return searching ? lines.filter(matches) : lines;
  }
  // The projects in any list, the ones that need you most first; the ones
  // picked; the chips the rail shows; and More, open under its chip.
  // 5 Nov 2026: History's projects too, after the rest, and any project a
  // link picked that no list names (its chip is there, and the lists say
  // there is nothing of yours in it, rather than falling back to All).
  const ranked = withProjects(rankProjects(rows, progress, waiting, live), [
    ...(history?.rows || []).map((row) => row.app),
    ...pickedIn.map((slug) => appFor?.(slug) || null),
  ]);
  const picked = pickedIn.filter((slug) => ranked.some((p) => p.app.slug === slug));
  const setOnly = (slugs: string[]) => onPick?.(slugs);
  const rail = railProjects(ranked, picked);
  const past = ranked.length - rail.length;
  const shows = showsPicked(picked);
  const toggle = (slug: string) => setOnly(picked.includes(slug) ? picked.filter((x) => x !== slug) : [...picked, slug]);
  // #6262: what is new. The heading and the hero follow the chips (as the
  // owed count does); each chip carries its project's own count, and All the
  // whole page's.
  const freshAll = freshCount(rows);
  const freshByApp = freshByProject(rows);
  const needRowsShown = rows.filter((row) => shows(row.app));
  const freshShown = freshCount(needRowsShown);
  const freshProjects = freshByProject(needRowsShown);

  const needLines: Line[] = kept(needRowsShown.map((row) => {
    const number = Number(row.sub.values?.number) || null;
    const pr = row.sub.id === 'messages:ai.row.privateAboutChangePr' || /Pr$/.test(row.sub.id);
    return {
      key: row.key,
      kind: row.key.startsWith('need:') ? 'need' : row.key.split(':')[0],
      app: row.app,
      glyph: needGlyph(row),
      number,
      pr: row.sub.id === 'messages:ai.row.privateAboutChangePr',
      title: row.title,
      // B07 (audit 2 Nov 2026): a private idea in no project sits under the
      // Only you heading already, so its row does not say it again.
      right: row.pill ? say(row.pill)! : row.app ? t('messages:ai.short.private') : '',
      tooltip: say(row.sub)!,
      why: say(whyOf(row)),
      owe: !!row.pill,
      lit: !!lit && rowKey(row) === lit,
      fresh: row.unread > 0,
      open: () => openRow(row),
      done: row.rootId && onDone ? { rootId: row.rootId, mark: () => onDone(row.rootId!) } : null,
      dismiss: row.named && onDismiss ? () => onDismiss(row) : null,
      at: row.at,
      project: projectOf(row.app),
      // A private thread is Only you there, whatever it is about (its reason says that).
      ref: refOf(number, pr, !!row.rootId, row.app),
      sub: lineOf(say(needReason(row)), dayWord(row.at, t, locale, false), dayWord(row.at, t, locale, true)),
      end: { kind: 'act', text: t(verbOf(row.pill)) },
    };
  }));
  const threadLine = (glyph: (th: AiThread) => Glyph) => (th: AiThread): Line => {
    const still = notMoving(th);
    const day = dayWord(th.at, t, locale, false);
    return {
      key: String(th.threadId),
      kind: th.work.stage,
      app: th.app,
      glyph: glyph(th),
      number: th.number,
      pr: changeOnGithub(th),
      title: th.title || '',
      requests: th.requests || 0,
      right: say(shortWords(th))!,
      tooltip: say(nextWords(th))!,
      why: say(threadWhy(th)),
      owe: false,
      // #6153: a request filed from a private thread opens that thread, and
      // is where you are while it is in the column.
      lit: !!lit && rowKey(th) === lit,
      fresh: (th.unread || 0) > 0,
      moved: th.moved === true,
      tookPart: th.tookPart === true,
      open: () => openThread(th),
      at: th.at,
      project: projectOf(th.app),
      ref: refOf(th.number, changeOnGithub(th), false),
      // #6158: a thread nobody is moving stays in In progress, its state
      // Not moving; its reason then says where it stopped.
      sub: lineOf(
        say(threadWhy(th)) || (still ? say(shortWords(th)) : null),
        day ? t('messages:ai.when.since', { day }) : '',
        day ? t('messages:ai.when.sinceAlone', { day }) : '',
      ),
      end: { kind: 'state', text: still ? t('messages:ai.state.notMoving') : say(shortWords(th))! },
    };
  };
  const progressShown = progress.filter((x) => shows(x.app));
  const waitingShown = waiting.filter((x) => shows(x.app));
  // 2 Nov 2026 (#6160): under way and waiting are one card of their own, in
  // that order within a project so the rows read work first, then the wait.
  // #6158: what is moving leads; the waiting rows nobody is moving fold away
  // under one head.
  const movingShown = waitingShown.filter((th) => !notMoving(th));
  const stillShown = waitingShown.filter((th) => notMoving(th));
  const waitingLine = threadLine(waitGlyph);
  // #6398: while searching, the rows nobody is moving join the ones under
  // way in the one card, so a match is never hidden inside the fold; and
  // nothing matching is folded away either (first = Infinity below).
  const movingLines: Line[] = [
    ...progressShown.map(threadLine(nextGlyph)),
    ...movingShown.map(waitingLine),
  ];
  const stillLines: Line[] = searching ? [] : stillShown.map(waitingLine);
  const busyLines: Line[] = kept(searching ? [...movingLines, ...stillShown.map(waitingLine)] : movingLines);
  const tab = useTabBuild();
  const liveLines: Line[] = kept(live.filter((x) => shows(x.app)).map((th) => {
    if (th.kind === 'private' && th.work.stage === 'closed') {
      // #6271: a private thread marked done this week: a lock, its title, the
      // day it closed, and no number. It opens the thread, where Reopen is.
      // In Done it ends as History says a done thread ended.
      const ended = t('messages:ai.history.done');
      return {
        key: `closed:${th.rootId}`,
        kind: 'closed',
        app: th.app,
        glyph: 'lock',
        number: null,
        title: th.title || '',
        right: dayOf(th.at, t),
        tooltip: th.app
          ? t('messages:ai.live.closed', { project: th.app.name || th.app.slug })
          : t('messages:ai.live.closedSolo'),
        why: null,
        owe: false,
        lit: !!lit && rowKey(th) === lit,
        open: () => openThread(th),
        at: th.at,
        project: projectOf(th.app),
        ref: refOf(null, false, true, th.app),
        sub: lineOf(ended, dayWord(th.at, t, locale, false), ended),
        end: { kind: 'word', text: ended },
        past: 'solo',
      };
    }
    // #6233: Live, but this tab runs the build before it: the row asks for
    // the reload rather than a day the reader still cannot see. (The three
    // bands keep its tick: Done's line under its first rows asks for the
    // reload, once for every row this tab is older than.)
    const lacks = tabLacks({ liveAt: th.at, mergedAt: th.mergedAt, id: th.changeId, appSlug: th.app?.slug }, tab);
    return {
      ...threadLine(() => 'check')(th),
      right: lacks ? t('messages:ai.short.reload') : dayOf(th.at, t),
      owe: lacks,
      tooltip: t(prWord('messages:ai.live.row', changeOnGithub(th)), { project: th.app?.name || '', number: th.number || '' }),
      sub: t('messages:ai.done.wentLive', { day: dayWord(th.at, t, locale, false) }),
      end: { kind: 'tick', text: t('core:work.stage.live') },
      // This week's rows are filed as History will file them: a decision is
      // a vote, anything else that went live a change.
      past: th.kind === 'decision' ? 'vote' : 'change',
    };
  }));
  const liveBehind = liveLines.some((line) => line.owe);
  // A project picked with nothing of yours on any list: Needs you says so,
  // by its name, rather than the lists quietly showing every project.
  const onlyApp = picked.length === 1 ? ranked.find((p) => p.app.slug === picked[0])?.app || null : null;
  const nothingHere = !!onlyApp && !needLines.length && !busyLines.length && !stillLines.length && !liveLines.length;
  // HISTORY (5 Nov 2026, ./history.ts): what has finished, by month, then by
  // project, in the quiet rows Live this week draws. Narrowed by the chips
  // above, as every list is; its own chips pick a kind.
  const historyLines = kept((history?.rows || []).filter((row) => shows(row.app)).map((row): Line & { at: string | null } => {
    const glyph = historyGlyph(row);
    const pr = !!row.change && !!row.app?.changesOnGithub;
    // Done: what went live ends in a tick and says so; anything else ends
    // in the word History has always said for it, said again with its day.
    const wentLive = row.outcome === 'live' || row.outcome === 'shipped';
    const ended = say(historyWords(row, locale))!;
    const day = dayWord(row.at, t, locale, false);
    return {
      key: row.key,
      kind: `history-${row.kind}`,
      app: row.app,
      glyph: HISTORY_GLYPH[glyph],
      number: row.number,
      pr,
      title: row.title || '',
      right: ended,
      tooltip: say(historyTooltip(row))!,
      why: null,
      owe: false,
      lit: !!lit && rowKey({ rootId: row.rootId ?? null, href: row.href }) === lit,
      open: () => openHistory?.(row),
      left: !!row.left,
      at: row.at,
      project: projectOf(row.app),
      ref: refOf(row.number, pr, row.kind === 'solo', row.app),
      // A private community the person left says so, as its project's head did.
      sub: ((line: string) => (row.left ? t('messages:ai.row.left', { line }) : line))(
        wentLive ? t('messages:ai.done.wentLive', { day }) : lineOf(ended, day, ended),
      ),
      end: wentLive ? { kind: 'tick', text: t('core:work.stage.live') } : { kind: 'word', text: ended },
      past: row.kind,
    };
  }));
  const historyMonths = byMonth(historyLines);
  // THE THREE BANDS (24 Nov 2026, ./lists.tsx). Every thread is in one of
  // three places, newest first in each, with no project or day headings.
  // In progress is everything under way and everything waiting, the rows
  // nobody is moving among them, each saying so (`end`). 24 Nov 2026
  // (mobile 04): your own first, then the ones you only wrote or were named
  // in, so commenting widely never buries what you asked for or build.
  const progressLines: Line[] = ownFirst(newestFirst(kept([
    ...progressShown.map(threadLine(nextGlyph)),
    ...waitingShown.map(waitingLine),
  ])));
  // Done is the whole past: this week's rows (what went live, a private
  // thread marked done), then History's, each thread once, narrowed to the
  // kind its chips pick. History is read newest first and reads that kind
  // on its own; its rows are narrowed here too, so a page read before the
  // pick cannot show another kind while the next is on its way.
  const liveIds = new Set(live.map((th) => (th.kind === 'private' ? `root:${th.rootId}` : `thread:${th.threadId}`)));
  const pastIds = new Map((history?.rows || []).map((row) => [row.key, row.rootId ? `root:${row.rootId}` : `thread:${row.threadId}`]));
  const ofKind = (line: Line) => !historyKind || line.past === historyKind;
  const doneLines: Line[] = [
    ...newestFirst(liveLines).filter(ofKind),
    ...historyLines.filter((line) => !liveIds.has(pastIds.get(line.key) || '') && ofKind(line)),
  ];
  // The header's counts, as the bands' are when no search narrows them: what
  // the project filter shows. A search does not narrow them (#6744), so they
  // do not jump while you type.
  const needCount = needRowsShown.length;
  const progressCount = progressShown.length + waitingShown.length;
  // Done's aside: what finished this week, not the archive's size.
  const weekCount = liveLines.filter(ofKind).length;
  // #6398: the Needs you count over its rows is how many of them match; with
  // no project picked the heading still counts everything, unless a search
  // narrows it.
  const owedShown = picked.length || searching ? needLines.filter((line) => line.owe).length : owed;
  // One project picked: its chip names it, so its name is not said again over every section.
  const heads = picked.length !== 1;
  // MESSAGES (13 Nov 2026, ./search.ts): what was said in the chat with the
  // bot and its threads that matches, under the threads that do. The last
  // answer stays drawn while the next is read, so the list does not blink;
  // nothing is drawn with no search on.
  const asked = cleanQuery(query);
  const foundLines: FoundLine[] = searching && found && found.state === 'answered' ? found.rows.map((row) => {
    const place = row.rootId && row.threadTitle ? row.threadTitle : t('messages:ai.search.inChat');
    const date = foundDay(row.at, locale);
    return {
      key: `found:${row.messageId}`,
      href: botTabAddress({ threadRootId: row.rootId, focusMessageId: row.messageId }),
      messageId: row.messageId,
      q: found.q,
      thread: !!row.rootId,
      parts: markParts(row.snippet, row.ranges),
      place,
      date,
      name: t(row.mine ? 'messages:ai.search.rowYou' : 'messages:ai.search.rowBot', { snippet: row.snippet, place, date }),
    };
  }) : [];
  // The answer for what the box says now; an earlier query's is not it.
  const foundNow = searching && found && found.q === asked ? found : null;
  const foundMore = foundLines.length > 0 && !!found?.more;
  const foundFailed = foundNow?.state === 'failed';
  // Nothing on the page matches what was searched for: one short note says
  // so, in place of the rows (the Needs you warning, if there is one, stays).
  // It waits for the messages' answer, and says "messages" only when they
  // were searched: a query too short to ask, or a read that failed, is a
  // note about the threads alone.
  const noMatches = searching && ready
    && !needLines.length && !busyLines.length && !stillLines.length && !liveLines.length && !historyLines.length
    && !foundLines.length && (found === undefined || !!foundNow);
  const noneWords = foundNow?.state === 'answered'
    ? t('messages:ai.search.none', { query: query.trim() })
    : t('messages:ai.search.noneThreads', { query: query.trim() });

  return {
    say, searching, ranked, picked, rail, past, setOnly, toggle, freshAll, freshByApp, freshShown, freshProjects,
    needLines, busyLines, stillLines, liveLines, liveBehind, onlyApp, nothingHere, locale, historyLines, historyMonths,
    owedShown, heads, noMatches, noneWords, foundLines, foundMore, foundFailed,
    // #6744: the counts the project filter shows, for anything that summarises
    // the lists (the hero under the bot's name asks the same question).
    progressShown: progressShown.length,
    // The three bands (./lists.tsx).
    progressLines, doneLines, needCount, progressCount, weekCount,
  };
}

export type AiLines = ReturnType<typeof useAiLines>;
