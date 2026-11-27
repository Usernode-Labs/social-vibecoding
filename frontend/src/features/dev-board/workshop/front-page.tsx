/**
 * THE WORKSHOP'S FRONT PAGE (24 Nov 2026; the desktop polish's item 14).
 *
 * The Workshop tab opened with four totals, two strips of status and a long
 * log, the one block about the visitor last and off to the side: a wall of
 * numbers and lists with no clear first step. It is calm and graphical now,
 * one centred column of three parts, then a row for admins:
 *
 *   ┌ What should change in Garden club? ─────────────┐  ┌ Your work ───┐
 *   │ [ Tell Homeroom bot what to change…   🎙  (↑) ] │  │ ▫▫▫ peeking   │
 *   │ (Edit the app live) (Fix an issue) (Add…) (Ask…)│  │ 2 need you ›  │
 *   └─────────────────────────────────────────────────┘  └──────────────┘
 *   IN THE WORKSHOP NOW                                  Open the board ›
 *     ● Asked ───── ● Being built ───── ● Up for a vote ───── ● Live
 *     68 suggestions 5 right now         [6 need your vote]     127 this week
 *   ─ 🛡 A change goes live when its checks pass and evan or snait says yes.
 *   LATELY  4 new since you were last here    All of this week ›  │ LIVE BY WEEK
 *   ✓ three things that went live, title only                     │ ▇▇▇ ▅▅ ▆▆
 *   🔒 Private requests · only admins see these                              ›
 *
 * 1. THE HERO asks the page's one question, with a box to answer it: sending
 *    opens a new chat with Homeroom bot about the project with the words in
 *    its box, ready to send (../../messages/new-chat-carry.ts
 *    carryWordsToNewChat; no hub or Home box sends for the person, so this
 *    does not either). Four starts under it open a new chat with that start
 *    chosen, exactly as pressing it inside New chat does; Edit the app live
 *    (the live start, a live draft beside the chat) is first and the only
 *    tinted one, and is offered where New chat offers it (offersLive:
 *    a project of its own, Homeroom itself to its admins, #6961). Beside it,
 *    Your work: one door, the visitor's threads peeking out of it as blank
 *    cards with an icon each, or, with nothing of theirs here, a faint card
 *    that is not a door. It does the first-change card's job on this page,
 *    so that card is not drawn here (./your-work.tsx, kept for the brand
 *    look's tab).
 * 2. THE PATH, "In the workshop now": four stops a change travels, each a
 *    door to the place that lists exactly what it counts (#5369's rule: one
 *    predicate for the figure and its list). Asked and Up for a vote narrow
 *    the board (AppView._devCardInStage 'asked' and 'votes'); Being built is
 *    Homeroom bot's builds, the number its slots page says ("building 3 of
 *    5", ./bot-slots.tsx slotCounts), which the stop opens; Live is this
 *    week's merges, the number this week's page states. The visitor's own
 *    threads at a stop are marked over it, and the votes waiting on them are
 *    one black pill on the third stop, which opens Needs you. A zero says
 *    nothing: the stop's word alone. Under it, the approval rule's line.
 * 3. LATELY, the three last things that went live (title only), and LIVE BY
 *    WEEK, this week and the two before it as bars. The week-by-week log
 *    left this page: All of this week, a bar and Earlier weeks open it, with
 *    its unread rows and Mark all seen there (./week-pages.tsx).
 *
 * Nothing here is read in a first render that could differ
 * from the next: the page mounts client-side into the legacy host, and its
 * numbers fill in as their reads land, each part holding its height.
 */

import { useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

import {
  AppWindowIcon, ArrowUpIcon, BallotIcon, ChatIcon, CheckIcon, ChevronRightIcon, CodeIcon, DescriptionIcon, FlagIcon,
} from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { changeHref } from '../../../lib/change-href';
import { useDesk, type DeskGlyph, type DeskSummary } from '../../ai/desk';
import { botNewAddress, goBotAddress } from '../../ai/door';
import { projectTabAddress } from '../../ai/filter-address';
import type { Phrase } from '../../ai/model';
import { SpeakButton } from '../../dictation/speak-button';
import { platformSlug } from '../../messages/channel-hub';
import { BOT_AVATAR, swatchFor } from '../../messages/format';
import { carryWordsToNewChat } from '../../messages/new-chat-carry';
import { LIVE_START, NEW_THREAD_STARTS, offersLive } from '../../messages/new-thread';
import { callAppView } from '../card/fold';
import type { DevWorkshopView } from '../card/model';
import { slotCounts, useBotSlots } from './bot-slots';
import { ApprovalLine, ruleSentence, useCommunity } from './community-card';
import { PrivateRequestsDoor } from './private-requests';
import { weekFresh, weekName } from './week-pages';
import type { TopicRef } from './work-row';
import type { SinceWeek } from './workshop';

type Dash = NonNullable<DevWorkshopView['dashboard']>;
type RecentLive = NonNullable<DevWorkshopView['recentLive']>[number];

/** The board narrowings the path's stops set (AppView._kanbanStageValue). */
export type FrontStage = 'asked' | 'votes' | 'shipped';

/**
 * The four starts, in their order: each a start of New chat's own, by its
 * key, with a shorter label of this page's. Edit the app live is the live
 * start (LIVE_START), drawn only where New chat would offer it.
 */
export const FRONT_STARTS = [
  { key: LIVE_START.key, label: 'project:workshop.front.start.live', Icon: AppWindowIcon, live: true },
  { key: 'fix', label: 'project:workshop.front.start.fix', Icon: null, live: false },
  { key: 'add', label: 'project:workshop.front.start.add', Icon: null, live: false },
  { key: 'ask', label: 'project:workshop.front.start.ask', Icon: null, live: false },
] as const;

// Each of the three is one of New chat's own starts: a rename there is caught here.
for (const start of FRONT_STARTS) {
  if (!start.live && !NEW_THREAD_STARTS.some((one) => one.key === start.key)) throw new Error(`front page start ${start.key} is not a New chat start`);
}

/** Pure: the Your work door's second line, the counts in words ("2 need you · 1 in progress"); nothing for none. */
export function yoursWords(d: Pick<DeskSummary, 'ready' | 'needs' | 'progress' | 'waiting'>): Phrase | null {
  if (!d.ready) return null;
  if (d.needs > 0 && d.progress > 0) return { id: 'project:workshop.front.yours.both', values: { count: d.needs, progress: d.progress } };
  if (d.needs > 0) return { id: 'project:workshop.front.yours.needs', values: { count: d.needs } };
  if (d.progress > 0) return { id: 'project:workshop.front.yours.progress', values: { count: d.progress } };
  if (d.waiting > 0) return { id: 'project:workshop.front.yours.waiting', values: { count: d.waiting } };
  return null;
}

/** Pure: whether the project's approval rule is the reader's own yes alone (the sentence it says is "you say yes"). */
export function ruleIsYours(data: Parameters<typeof ruleSentence>[1] & { approval?: Parameters<typeof ruleSentence>[0] | null } | null, approvers: string[] | null): boolean {
  if (!data || !data.approval) return false;
  return ruleSentence(data.approval, data, approvers).long === 'project:communityCard.line.you';
}

/** One stop of the path, as it is drawn. */
export interface FrontStop {
  key: 'asked' | 'building' | 'votes' | 'live';
  /** Its number, or null while it is read or where there is none to state. */
  n: number | null;
  /** The number is a floor (a paged history). */
  atLeast?: boolean;
  /** How many of the visitor's threads are at it. */
  mine: number;
}

/**
 * Pure: the line under a stop's word ("68 suggestions"), or null: a zero, a
 * number not yet read, or the vote stop while its pill says the number.
 */
export function stopLine(stop: FrontStop, pill: boolean): Phrase | null {
  if (!stop.n || (stop.key === 'votes' && pill)) return null;
  if (stop.key === 'asked') return { id: 'project:workshop.front.path.asked.line', values: { count: stop.n } };
  if (stop.key === 'building') return { id: 'project:workshop.front.path.building.line', values: { count: stop.n } };
  if (stop.key === 'votes') return { id: 'project:workshop.front.path.votes.line', values: { count: stop.n } };
  return { id: stop.atLeast ? 'project:workshop.front.path.live.lineAtLeast' : 'project:workshop.front.path.live.line', values: { count: stop.n } };
}

/** Pure: the three weeks Live by week draws, newest first, each with its count where the server states one. */
export function weekBars(thisWeek: SinceWeek | null, past: SinceWeek[]): { week: SinceWeek; n: number | null; atLeast: boolean; now: boolean }[] {
  const three = (thisWeek ? [thisWeek, ...past.slice(0, 2)] : past.slice(0, 3));
  return three.map((week) => ({
    week,
    n: week.counts && Number.isFinite(week.counts.closed) ? week.counts.closed : null,
    atLeast: !!(week.counts && week.counts.partial),
    now: !!week.live,
  }));
}

const GLYPH: Record<DeskGlyph['glyph'], typeof ChatIcon> = {
  vote: BallotIcon, plan: DescriptionIcon, ask: ChatIcon, fix: FlagIcon, build: CodeIcon,
};

const NODE: Record<FrontStop['key'], typeof ChatIcon> = {
  asked: ChatIcon, building: CodeIcon, votes: BallotIcon, live: CheckIcon,
};

/** Each stop's word, the one thing it always says. */
const WORD: Record<FrontStop['key'], string> = {
  asked: 'project:workshop.front.path.asked.word',
  building: 'project:workshop.front.path.building.word',
  votes: 'project:workshop.front.path.votes.word',
  live: 'project:workshop.front.path.live.word',
};

interface Viewer { username: string; avatarUrl: string | null; isAdmin: boolean }

function useViewer(): Viewer | null {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  useEffect(() => {
    const user = (window as unknown as { App?: { user?: { username?: string; avatarUrl?: string | null; isAdmin?: boolean } | null } }).App?.user;
    setViewer(user && user.username ? { username: user.username, avatarUrl: user.avatarUrl || null, isAdmin: !!user.isAdmin } : null);
  }, []);
  return viewer;
}

export interface WorkshopFrontProps {
  slug: string;
  /** The project's name, for the heading. */
  name: string;
  /** The board is still being read: the page draws its words, and fills its numbers in. */
  loading: boolean;
  dash: Dash | null;
  /** The Done list is on its way: what went live is not known yet. */
  mergedPending: boolean;
  /** The votes waiting on the visitor (the place list's Needs you count). */
  owed: number;
  /** A signed-in visitor, who can have work here. */
  viewer: boolean;
  /** The project is self-hosted (Homeroom's own app among them): New chat's live start rule. */
  selfHosted: boolean;
  /** All items has a search or a filter on: the dot on Open the board. */
  filtered: boolean;
  /** A returning visit, with a last visit to be since. */
  since: boolean;
  thisWeek: SinceWeek | null;
  pastWeeks: SinceWeek[];
  recentLive: RecentLive[];
  openKey: string | null;
  onOpenItem: (event: ReactMouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
  onBoard: () => void;
  onStage: (stage: FrontStage) => void;
  onBuilds: () => void;
  onNeeds: () => void;
  onWeek: (week: SinceWeek) => void;
  onEarlier: () => void;
  onPrivate: () => void;
}

export function WorkshopFront(props: WorkshopFrontProps): ReactNode {
  // The viewer's threads on this project, which the path marks: asked for
  // once a project while this page is up (AppView._loadYours, the Yours
  // filter's list), never by every page the board's view is built for.
  const { slug, viewer } = props;
  useEffect(() => { if (slug && viewer) callAppView('_loadYours'); }, [slug, viewer]);
  return (
    <div className="dev-ws-front" data-ws-front-page="">
      <Hero {...props} />
      <Path {...props} />
      <Lately {...props} />
      <PrivateRequestsDoor slug={props.slug} onOpen={props.onPrivate} />
    </div>
  );
}

// ── 1. The hero ─────────────────────────────────────────────────────────

function Hero({ slug, name, viewer, selfHosted }: WorkshopFrontProps): ReactNode {
  const t = useMessages('project');
  useMessages('messages');
  const who = useViewer();
  const [words, setWords] = useState('');
  const [dictating, setDictating] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const live = offersLive(slug, { [slug]: { selfHosted } }, { platformSlug: platformSlug(), isAdmin: !!who?.isAdmin });
  const starts = FRONT_STARTS.filter((start) => !start.live || live);
  // The new chat about this project, carrying what was typed and the start, if any.
  const go = (start: string | null) => {
    carryWordsToNewChat(field.current ? field.current.value : words, start);
    goBotAddress(botNewAddress({ project: slug }));
  };
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!words.trim() || dictating) return;
    go(null);
  };
  return (
    <section className="dev-ws-front-hero" data-ws-front="hero">
      <div className="dev-ws-front-ask-side">
        <h2 className="dev-ws-front-title">{t('project:workshop.front.title', { project: name })}</h2>
        <form className="dev-ws-front-ask" data-ws-front-ask="" onSubmit={send}>
          <input
            ref={field}
            className="dev-ws-front-ask-input"
            type="text"
            dir="auto"
            enterKeyHint="send"
            maxLength={8000}
            value={words}
            onChange={(event) => setWords(event.currentTarget.value)}
            placeholder={t('project:workshop.front.ask.placeholder')}
            aria-label={t('project:workshop.front.ask.label', { project: name })}
          />
          <SpeakButton scope="project:workshop-ask" getText={() => field.current?.value || ''} onText={setWords} maxLength={8000} onBusyChange={setDictating} />
          <button
            type="submit"
            className="dev-ws-front-send"
            data-ws-front-send=""
            disabled={!words.trim() || dictating}
            aria-label={t('project:workshop.front.ask.send')}
            title={t('project:workshop.front.ask.send')}
          >
            <ArrowUpIcon aria-hidden="true" />
          </button>
        </form>
        <div className="dev-ws-front-starts" role="group" aria-label={t('project:workshop.front.start.label')} data-ws-front-starts="">
          {starts.map((start) => (
            <button
              key={start.key}
              type="button"
              className="dev-ws-front-start"
              data-ws-front-start={start.key}
              data-tone={start.live ? 'live' : undefined}
              onClick={() => go(start.key)}
            >
              {start.Icon ? <start.Icon aria-hidden="true" /> : null}
              <span>{t(start.label)}</span>
            </button>
          ))}
        </div>
      </div>
      <YoursDoor slug={slug} name={name} viewer={viewer} />
    </section>
  );
}

/**
 * Your work: one door, with up to three of the visitor's threads peeking out
 * of its top as blank cards (an icon each; the ones that need them in the
 * accent). Nothing of theirs here, or no account: a faint card that is not a
 * door. While their lists are read the faint card holds the place, the
 * same height, so nothing moves when the door arrives.
 */
function YoursDoor({ slug, name, viewer }: { slug: string; name: string; viewer: boolean }): ReactNode {
  const t = useMessages('project');
  const desk = useDesk(viewer ? slug : null);
  const words = yoursWords(desk);
  const top = (desk.top || []).slice(0, 3);
  if (!words) {
    const reading = viewer && !desk.settled;
    return (
      <div className="dev-ws-front-side" data-ws-desk="" data-ws-desk-empty={reading ? undefined : ''}>
        <div className="dev-ws-front-yours" data-ghost="">
          <span className="dev-ws-front-stack" aria-hidden="true">
            <span className="dev-ws-front-mini" data-ghost="" />
            <span className="dev-ws-front-mini" data-ghost="" />
          </span>
          <span className="dev-ws-front-yours-cap">
            <img src={BOT_AVATAR} alt="" loading="lazy" />
            <span className="dev-ws-front-yours-text">
              <b>{t('project:workshop.desk.title')}</b>
              <span>{reading ? ' ' : t('project:workshop.front.yours.empty')}</span>
            </span>
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="dev-ws-front-side" data-ws-desk="">
      <a
        className="dev-ws-front-yours"
        href={projectTabAddress(slug)}
        data-ws-desk-open=""
        data-ws-desk-ready=""
        title={t('project:workshop.desk.open', { project: name })}
      >
        <span className="dev-ws-front-stack" aria-hidden="true">
          {top.map((card, i) => {
            const Glyph = GLYPH[card.glyph];
            return (
              <span key={i} className="dev-ws-front-mini" data-hot={card.hot ? '' : undefined}>
                <span className="dev-ws-front-mini-glyph"><Glyph /></span>
              </span>
            );
          })}
        </span>
        <span className="dev-ws-front-yours-cap">
          <img src={BOT_AVATAR} alt="" loading="lazy" />
          <span className="dev-ws-front-yours-text">
            <b>{t('project:workshop.desk.title')}</b>
            <span data-ws-desk-count="">
              <RichMessage id={words.id} values={words.values} components={[<strong className="dev-ws-front-ask-n" />]} />
            </span>
          </span>
          <ChevronRightIcon className="dev-ws-front-chev" aria-hidden="true" />
        </span>
      </a>
    </div>
  );
}

// ── 2. The path ─────────────────────────────────────────────────────────

function Faces({ who, n }: { who: Viewer | null; n: number }): ReactNode {
  if (!who) return null;
  const face = (i: number) => (who.avatarUrl
    ? <img key={i} className="dev-ws-front-face" src={who.avatarUrl} alt="" />
    : <i key={i} className="dev-ws-front-face" style={{ background: swatchFor(who.username) }}>{who.username.charAt(0).toUpperCase()}</i>);
  return <span className="dev-ws-front-faces" aria-hidden="true">{Array.from({ length: Math.min(2, n) }, (_, i) => face(i))}</span>;
}

function Path({ slug, loading, dash, mergedPending, owed, filtered, thisWeek, onBoard, onStage, onBuilds, onNeeds, onWeek }: WorkshopFrontProps): ReactNode {
  const t = useMessages('project');
  const who = useViewer();
  const { view: slots } = useBotSlots(slug);
  const community = useCommunity(slug);
  const approvers = community && community.approval && Array.isArray(community.approval.approvers) ? community.approval.approvers : null;
  // A project whose rule is the reader's own yes (just yours): there is no
  // group to vote, so its third stop and its pill say yes, not vote.
  const yours = ruleIsYours(community as Parameters<typeof ruleIsYours>[0], approvers);
  const d = !loading ? dash : null;
  const builds = slots ? slots.slots.filter((entry) => entry.kind === 'build') : null;
  const stops: FrontStop[] = [
    { key: 'asked', n: d && typeof d.asked === 'number' ? d.asked : null, mine: d?.mine?.asked || 0 },
    {
      key: 'building',
      n: slots ? slotCounts(slots).building : null,
      mine: who && builds ? builds.filter((entry) => entry.askedBy && entry.askedBy === who.username).length : 0,
    },
    { key: 'votes', n: d ? d.votesWaiting : null, mine: d?.mine?.votes || 0 },
    { key: 'live', n: d && !mergedPending ? d.shippedWeek : null, atLeast: !!d?.partial, mine: d && !mergedPending ? d.mine?.live || 0 : 0 },
  ];
  const pill = owed > 0 && !loading;
  const open: Record<FrontStop['key'], () => void> = {
    asked: () => onStage('asked'),
    building: onBuilds,
    votes: () => onStage('votes'),
    // This week's log, whose head states the same number; with no week to
    // open, the board narrowed to what went live this week.
    live: () => (thisWeek ? onWeek(thisWeek) : onStage('shipped')),
  };
  const wordOf = (key: FrontStop['key']) => (key === 'votes' && yours
    ? t('project:workshop.front.path.votes.yours')
    : t(WORD[key]));
  return (
    <section className="dev-ws-front-path" data-ws-front="path">
      <div className="dev-ws-front-head">
        <h2 className="dev-ws-front-label">{t('project:workshop.front.path.title')}</h2>
        <button type="button" className="dev-ws-front-go" data-ws-all-open="" onClick={onBoard}>
          {filtered ? (
            <RichMessage
              id="project:workshop.front.path.boardFiltered"
              components={[
                <span className="dev-ws-filter-dot" data-ws-filtered="" aria-hidden="true" />,
                <span className="sr-only" />,
              ]}
            />
          ) : t('project:workshop.front.path.board')}
          <ChevronRightIcon className="dev-ws-front-chev" aria-hidden="true" />
        </button>
      </div>
      <div className="dev-ws-front-stops" data-ws-front-stops="">
        <span className="dev-ws-front-run" aria-hidden="true"><i /><i /><i /></span>
        {stops.map((stop) => {
          const Node = NODE[stop.key];
          const hasPill = stop.key === 'votes' && pill;
          const line = stopLine(stop, hasPill);
          return (
            <div key={stop.key} className="dev-ws-front-stop" data-ws-front-stop={stop.key} data-n={stop.n ?? undefined}>
              <button type="button" className="dev-ws-front-stop-door" onClick={open[stop.key]}>
                <span className="dev-ws-front-mine" data-ws-front-mine={stop.mine || undefined}>
                  {stop.mine ? (
                    <>
                      <Faces who={who} n={stop.mine} />
                      <span>{t('project:workshop.front.path.mine', { count: stop.mine })}</span>
                    </>
                  ) : null}
                </span>
                <span className="dev-ws-front-node" data-node={stop.key} aria-hidden="true"><Node /></span>
                <b className="dev-ws-front-word">{wordOf(stop.key)}</b>
                {line ? <span className="dev-ws-front-line">{t(line.id, line.values)}</span> : null}
              </button>
              {hasPill ? (
                <button type="button" className="dev-ws-front-pill" data-ws-front-pill="" onClick={onNeeds}>
                  {t(yours ? 'project:workshop.front.path.pillYours' : 'project:workshop.front.path.pill', { count: owed })}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="dev-ws-front-rule" data-ws-front-rule=""><ApprovalLine slug={slug} /></div>
    </section>
  );
}

// ── 3. Lately, and Live by week ─────────────────────────────────────────

/** How many changes Lately lists. */
export const LATELY_SHOWN = 3;

function Lately({ slug, loading, dash, mergedPending, since, thisWeek, pastWeeks, recentLive, openKey, onOpenItem, onWeek, onEarlier }: WorkshopFrontProps): ReactNode {
  const t = useMessages('project');
  const waiting = loading || mergedPending;
  const rows = (recentLive || []).filter((r) => !r.going).slice(0, LATELY_SHOWN);
  const fresh = since && thisWeek ? weekFresh(thisWeek).length : 0;
  // Nothing has gone live yet: Lately says so, and there are no weeks to draw.
  const never = !!dash && !waiting && dash.everShipped === false && !rows.length;
  const bars = weekBars(thisWeek, pastWeeks);
  // The weeks come with the digest, which can answer after the board: until
  // it does the card holds its place, its bars grey.
  const barsWaiting = waiting || (!bars.length && !!dash?.weeksPending);
  const drawWeeks = !never && (barsWaiting || bars.length > 0);
  const max = Math.max(1, ...bars.map((b) => b.n || 0));
  return (
    <div className="dev-ws-front-pair" data-ws-front="lately-pair" data-one={drawWeeks ? undefined : ''} data-never={never ? '' : undefined}>
      <section className="dev-ws-front-card" data-ws-front="lately">
        <div className="dev-ws-front-head">
          <h2 className="dev-ws-front-label">{t('project:workshop.front.lately.title')}</h2>
          {fresh ? <span className="dev-ws-front-aside" data-ws-front-fresh="">{t('project:workshop.front.lately.fresh', { count: fresh })}</span> : null}
          {thisWeek ? (
            <button type="button" className="dev-ws-front-go" data-ws-week={thisWeek.key} data-ws-week-all="" onClick={() => onWeek(thisWeek)}>
              {t('project:happened.allOfWeek')}
              <ChevronRightIcon className="dev-ws-front-chev" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {waiting ? (
          <ul className="dev-ws-front-list" aria-busy="true" aria-label={t('project:page.loading')}>
            {Array.from({ length: LATELY_SHOWN }, (_, i) => <li key={i} className="dev-ws-front-row" data-skeleton=""><span className="dev-ws-front-bone" /></li>)}
          </ul>
        ) : rows.length ? (
          <ul className="dev-ws-front-list">
            {rows.map((r) => {
              const ref: TopicRef = { kind: 'proposal', id: r.sessionId };
              const on = openKey === `proposal:${r.sessionId}`;
              return (
                <li key={r.key} className="dev-ws-front-row">
                  <a
                    className="dev-ws-front-row-link"
                    href={changeHref(slug, r.sessionId, r.prNumber)}
                    data-ws-front-live={r.key}
                    aria-current={on ? 'true' : undefined}
                    onClick={(event) => onOpenItem(event, ref)}
                  >
                    <CheckIcon className="dev-ws-front-tick" aria-hidden="true" />
                    <span>{r.title}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="dev-ws-front-none" data-ws-front-none="">{t('project:workshop.front.lately.none')}</p>
        )}
      </section>
      {drawWeeks ? (
        <section className="dev-ws-front-card dev-ws-front-weeks" data-ws-front="weeks">
          <div className="dev-ws-front-head">
            <h2 className="dev-ws-front-label">{t('project:workshop.front.weeks.title')}</h2>
            {pastWeeks.length ? (
              <button type="button" className="dev-ws-front-go" data-ws-front-earlier="" onClick={onEarlier}>
                {t('project:happened.earlierWeeks')}
                <ChevronRightIcon className="dev-ws-front-chev" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <div className="dev-ws-front-bars">
            {barsWaiting ? Array.from({ length: 3 }, (_, i) => (
              <span key={i} className="dev-ws-front-bar" data-skeleton=""><span className="dev-ws-front-bone" /></span>
            )) : bars.map((b) => {
              const label = b.now ? t('project:workshop.front.weeks.now') : weekName(b.week);
              const count = b.n === null ? null : b.atLeast ? `${b.n}+` : String(b.n);
              return (
                <button
                  key={b.week.key}
                  type="button"
                  className="dev-ws-front-bar"
                  data-ws-week={b.week.key}
                  data-now={b.now ? '' : undefined}
                  aria-label={b.n === null ? label : t(b.atLeast ? 'project:workshop.front.weeks.barAtLeast' : 'project:workshop.front.weeks.bar', { week: label, count: b.n })}
                  onClick={() => onWeek(b.week)}
                >
                  <span className="dev-ws-front-bar-label">{label}</span>
                  <span className="dev-ws-front-bar-track" aria-hidden="true">
                    {b.n ? <u style={{ inlineSize: `${Math.max(2, Math.round((b.n / max) * 100))}%` }} /> : null}
                  </span>
                  <b aria-hidden="true">{b.n ? count : ''}</b>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
