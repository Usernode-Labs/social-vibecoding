/**
 * #6426: "Welcome back" in Main Chat.
 *
 * After eight hours away, the first time somebody opens Main Chat a small
 * card sits just above the message box. It says what changed since their last
 * visit and offers four questions to tap, so the bot's own abilities are in
 * reach without remembering how to ask for them:
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │ Welcome back                                    × │
 *   │ Since Tuesday: 3 changes went live · 2 wait for   │
 *   │ your vote · 1 plan waits for your Build it        │
 *   │ [What's waiting on me?] [What went live …] …      │
 *   └──────────────────────────────────────────────────┘
 *   ┌──────────────────────────────────────────────────┐
 *   │ Message Homeroom bot                              │
 *   └──────────────────────────────────────────────────┘
 *
 * WHAT IT KNOWS. The last visit is the account's read state, recorded by
 * services/conversations.js markRead and carried on the conversation
 * (`lastVisitAt`). It is taken ONCE when the card mounts: marking Main Chat
 * read during this visit moves the server's value on, and the card must not
 * vanish because of it. The counts are the same two reads the Homeroom bot
 * page already makes (../ai/desk.ts): what went live, what waits for a vote,
 * and a plan waiting for Build it, each filtered to things newer than that
 * visit. The project chip names the project with the most of that activity,
 * falling back to the last project used (the switcher's Recent order).
 *
 * ONE SET OF SUGGESTIONS AT A TIME (#4046): while the card shows, the bot's
 * leftover suggested replies under its last message give way to it. It stays
 * away entirely when that message still asks something open, because the
 * question is what the person should see.
 *
 * A TAP is an ordinary message: the chip's own words go through the store's
 * send() as the person's, then the card closes for this return. So does ×.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { getDateLocale } from '../../lib/i18n/runtime';
import { useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { readDesk } from '../ai/desk';
import type { AiWork, NeedItem } from '../ai/model';
import { pinnedAppsStore } from '../nav/pinned-apps-store';
import { navStore } from '../nav/nav-store.js';
import { readKept } from '../nav/rail-communities';
import { communityScopeStore, loadCommunities } from '../workshop/community-scope';
import { switcherRecent } from '../workshop/community-switcher';
import { asksInChat } from './bot-news-line';
import { send, useMessagesSnapshot } from './store';
import { dayNumber, inZone, zonedHour } from '../../lib/time-zone';

const HOUR_MS = 60 * 60 * 1000;
/** "About 8 hours", read as exactly eight. */
export const AWAY_MS = 8 * HOUR_MS;

/** The Needs you kinds that are a vote owed by the viewer. */
const VOTE_KINDS: ReadonlySet<string> = new Set(['proposal', 'ballot', 'governance']);

export interface WelcomeCounts {
  live: number;
  votes: number;
  build: number;
}

type Translate = (id: string, values?: Record<string, unknown>) => string;

/** Pure: has it been eight hours (or more) since `lastVisitAt`? Null gives false. */
export function welcomeDue(lastVisitAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastVisitAt) return false;
  const at = Date.parse(lastVisitAt);
  return Number.isFinite(at) && now - at >= AWAY_MS;
}

function after(value: string | null | undefined, since: string | number | Date): boolean {
  if (!value) return false;
  const at = Date.parse(value);
  const from = since instanceof Date ? since.getTime() : typeof since === 'number' ? since : Date.parse(since);
  return Number.isFinite(at) && Number.isFinite(from) && at > from;
}

/** Pure: what happened since `since`, in the AI page's own three buckets. */
export function welcomeCounts(
  work: AiWork | null,
  needs: NeedItem[] | null,
  since: string | number | Date,
): WelcomeCounts {
  const live = (work?.live || []).filter((row) => after(row.mergedAt ?? row.at, since)).length;
  const votes = (needs || []).filter((item) => VOTE_KINDS.has(item.kind)
    && !(item.waitingOn && item.waitingOn.length)
    && after(item.at, since)).length;
  const build = (work?.needs || []).filter((row) => after(row.at, since)).length;
  return { live, votes, build };
}

/**
 * Pure: the project with the most activity since `since`, by its name. Votes,
 * a plan waiting for Build it and what went live are the card's counts; Next,
 * Waiting and private threads count only toward "busiest". Ties go to the
 * order of `recent` (the switcher's Recent). With no activity, the project
 * used last: the first of `recent` whose name is known. Null leaves the chip
 * out.
 */
export function busiestProject(
  work: AiWork | null,
  needs: NeedItem[] | null,
  since: string | number | Date,
  recent: readonly string[],
  names: Record<string, string> = {},
): string | null {
  const known = new Map<string, string>(Object.entries(names));
  const remember = (row: { app?: { slug: string; name: string } | null } | null | undefined) => {
    if (row?.app) known.set(row.app.slug, row.app.name);
  };
  for (const row of [...(work?.live || []), ...(work?.needs || []), ...(work?.next || []), ...(work?.waiting || []), ...(work?.private || [])]) remember(row);
  for (const item of needs || []) remember(item);

  const counts = new Map<string, number>();
  const count = (slug: string | null | undefined, at: string | null | undefined) => {
    if (!slug || !after(at, since)) return;
    counts.set(slug, (counts.get(slug) || 0) + 1);
  };
  for (const row of work?.live || []) count(row.app?.slug, row.mergedAt ?? row.at);
  for (const item of needs || []) {
    if (VOTE_KINDS.has(item.kind) && !(item.waitingOn && item.waitingOn.length)) count(item.app?.slug, item.at);
  }
  for (const row of work?.needs || []) count(row.app?.slug, row.at);
  for (const row of [...(work?.next || []), ...(work?.waiting || [])]) count(row.app?.slug, row.at);

  const rank = (slug: string) => {
    const at = recent.indexOf(slug);
    return at === -1 ? Number.POSITIVE_INFINITY : at;
  };
  let best: string | null = null;
  let bestCount = 0;
  for (const [slug, seen] of counts) {
    if (seen > bestCount || (seen === bestCount && best !== null && rank(slug) < rank(best))) {
      best = slug;
      bestCount = seen;
    }
  }
  if (best) return known.get(best) || best;

  const last = recent.find((slug) => known.has(slug));
  return last ? known.get(last) || null : null;
}

export type VisitDay =
  | { kind: 'thisMorning' }
  | { kind: 'earlierToday' }
  | { kind: 'yesterday' }
  | { kind: 'weekday'; weekday: string }
  | { kind: 'date'; date: string };

/**
 * Pure: the day of the last visit, as the line and the live chip name it.
 * Same day before noon is "this morning", the rest of today "earlier today",
 * the day before "yesterday", within the week its weekday, else a short date.
 */
export function visitDay(
  since: string | number | Date,
  now: Date = new Date(),
  locale?: string,
): VisitDay | null {
  const when = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(when.getTime())) return null;
  // #6479: calendar days, the hour and the words in the zone picked in
  // Settings › Language, else the device's.
  const days = dayNumber(now) - dayNumber(when);
  if (days <= 0) return zonedHour(when) < 12 ? { kind: 'thisMorning' } : { kind: 'earlierToday' };
  if (days === 1) return { kind: 'yesterday' };
  if (days < 7) return { kind: 'weekday', weekday: new Intl.DateTimeFormat(locale, inZone({ weekday: 'long' })).format(when) };
  return { kind: 'date', date: new Intl.DateTimeFormat(locale, inZone({ month: 'short', day: 'numeric' })).format(when) };
}

/** Pure: the day's words, from the catalog or the formatter above. */
export function visitDayText(day: VisitDay, t: Translate): string {
  if (day.kind === 'weekday') return day.weekday;
  if (day.kind === 'date') return day.date;
  const id = day.kind === 'thisMorning' ? 'welcome.day.thisMorning'
    : day.kind === 'earlierToday' ? 'welcome.day.earlierToday' : 'welcome.day.yesterday';
  return t(`messages:${id}`);
}

/** Pure: the non-zero parts of the line, in the order the spec lists them. */
export function welcomeParts(counts: WelcomeCounts, t: Translate): string[] {
  const parts: string[] = [];
  if (counts.live > 0) parts.push(t('messages:welcome.live', { count: counts.live }));
  if (counts.votes > 0) parts.push(t('messages:welcome.votes', { count: counts.votes }));
  if (counts.build > 0) parts.push(t('messages:welcome.build', { count: counts.build }));
  return parts;
}

/** Pure: the line under "Welcome back", naming the day. */
export function welcomeLine(day: string, counts: WelcomeCounts, t: Translate): string {
  const parts = welcomeParts(counts, t);
  // The catalog holds the dot itself, never a fragment with spaces around it
  // (scripts/language-packs.js); the spaces between the parts are the join's.
  const dot = t('messages:welcome.separator');
  return parts.length
    ? t('messages:welcome.since', { day, news: parts.join(` ${dot} `) })
    : t('messages:welcome.quiet', { day });
}

export interface WelcomeChip { id: string; text: string }

/** Pure: the four chips, in their one order; the project's left out when none. */
export function welcomeChips(day: string, project: string | null, t: Translate): WelcomeChip[] {
  return [
    { id: 'waiting', text: t('messages:welcome.chip.waiting') },
    { id: 'live', text: t('messages:welcome.chip.live', { day }) },
    ...(project ? [{ id: 'project', text: t('messages:welcome.chip.project', { project }) }] : []),
    { id: 'newProject', text: t('messages:welcome.chip.newProject') },
  ];
}

/**
 * The card's markup alone, from what the component below worked out: what it
 * says, its chips in order, and the two ways out. Exported so a test can
 * render it without a store or effects.
 */
export function WelcomeBackView({ day, counts, project, onChip, onDismiss }: {
  day: string;
  counts: WelcomeCounts;
  project: string | null;
  onChip: (text: string) => void;
  onDismiss: () => void;
}) {
  const t = useMessages('messages');
  const chips = welcomeChips(day, project, t);
  return (
    <div className="messages-welcome" data-welcome-back="">
      <p className="messages-welcome-title">{t('messages:welcome.title')}</p>
      <p className="messages-welcome-line">{welcomeLine(day, counts, t)}</p>
      <div className="messages-welcome-chips" role="group" aria-label={t('messages:welcome.title')}>
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            data-welcome-chip={chip.id}
            onClick={() => onChip(chip.text)}
          >{chip.text}</button>
        ))}
      </div>
      <button
        type="button"
        className="messages-welcome-dismiss"
        aria-label={t('messages:welcome.dismiss')}
        title={t('messages:welcome.dismiss')}
        onClick={onDismiss}
      >×</button>
    </div>
  );
}

/**
 * The card itself. It renders only where Main Chat owns the chat with the
 * bot (index.tsx asks for it), and reports whether it is up so the bot's
 * last message can give its leftover suggestions way.
 */
export function WelcomeBack({ conversationId, onShown }: {
  conversationId: number;
  onShown?: (shown: boolean) => void;
}) {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  // The visit the card is for, taken once: the store's markRead moves the
  // server's value on as this very visit is read.
  const startRef = useRef<string | null>(null);
  const [start, setStart] = useState<string | null>(null);
  useEffect(() => {
    if (startRef.current) return;
    const at = snap.active?.lastVisitAt;
    if (!at) return;
    startRef.current = at;
    setStart(at);
  }, [snap.active?.lastVisitAt]);
  const [dismissed, setDismissed] = useState(false);
  const [desk, setDesk] = useState<{ work: AiWork | null; needs: NeedItem[] | null } | null>(null);

  const scope = useStoreState(communityScopeStore);
  const { apps: pins } = useStoreState(pinnedAppsStore);
  const { viewer } = useStoreState(navStore);
  const kept = useMemo(() => readKept(viewer), [viewer]);
  const recent = useMemo(
    () => switcherRecent(pins.map((app: { slug: string }) => app.slug), kept, scope.list),
    [pins, kept, scope.list],
  );
  const names = useMemo(() => {
    const out: Record<string, string> = {};
    for (const info of Object.values(scope.info)) out[info.slug] = info.name;
    return out;
  }, [scope.info]);

  // The bot's newest main-stream message: the card gives way to a question it
  // still asks, and its leftover suggestions give way to the card.
  const newestBot = useMemo(() => {
    for (let index = snap.messages.length - 1; index >= 0; index -= 1) {
      const message = snap.messages[index];
      if (message.sender.bot && !message.threadRootId) return message;
    }
    return null;
  }, [snap.messages]);

  const locale = getDateLocale();
  const day = start ? visitDay(start, new Date(), locale) : null;
  const shown = !!start && !!day && !dismissed && welcomeDue(start)
    && snap.active?.id === conversationId && !(newestBot && asksInChat(newestBot));

  // Reported before paint, so the bot's suggestions never show beside it.
  useIsomorphicLayoutEffect(() => { onShown?.(shown); }, [shown, onShown]);

  useEffect(() => {
    if (!shown || !start) return undefined;
    let live = true;
    void loadCommunities();
    // A null read (offline, an error) leaves the counts at zero, so the card
    // shows the quiet-day line and its four chips as the spec asks.
    void readDesk().then((read) => { if (live) setDesk(read); });
    return () => { live = false; };
  }, [shown, start]);

  if (!shown || !day) return null;
  const dayText = visitDayText(day, t);
  const counts = welcomeCounts(desk?.work ?? null, desk?.needs ?? null, start!);
  const project = busiestProject(desk?.work ?? null, desk?.needs ?? null, start!, recent, names);

  return (
    <WelcomeBackView
      day={dayText}
      counts={counts}
      project={project}
      onChip={(text) => { setDismissed(true); void send({ content: text }); }}
      onDismiss={() => setDismissed(true)}
    />
  );
}
