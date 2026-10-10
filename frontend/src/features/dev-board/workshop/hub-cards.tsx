/**
 * The project hub's own cards. The hub is the first of the project page's
 * places (Hub, Needs you, Workshop, then #general and its topics:
 * ./project-places.tsx, #4417), and it is the project's summary for the
 * people in it. Under the hero (./community-card.tsx: what it is, who it is
 * for and who is around this week), top to bottom:
 *
 *   FOR YOU, one card of doors, a row each, each opening its place: Needs
 *   you (the first vote you owe "and 3 more", "4 to vote"), Your work (the
 *   first of yours in flight, "1 in progress") and the Discussion (#general
 *   and its last line). ForYouCard.
 *   RECENTLY LIVE, the last three changes that went live, each as its after
 *   shot, its title, and who made it and when. RecentlyLive.
 *
 * What landed since your last visit and your work in full are the Workshop
 * place's; how a change gets in is its Approval rules card. The hub points
 * at them rather than drawing them twice.
 *
 * A project Homeroom bot is still building gets its FIRST VERSION card
 * first, right under the hero: where the build stands, and the way to the
 * bot's chat when the bot waits on its maker (FirstVersionCard below).
 *
 * ── A project nobody else is in ────────────────────────────────────────
 *
 * Evan, 5 Oct 2026, on a brand-new project of his own: "The initial hub if
 * no one has joined is really sad." It read "Just you", "Nothing more to
 * vote on." and "Your work · No work in progress." Nobody else can put a
 * vote up there, so the vote line says nothing (`alone` in NothingToVote),
 * an empty Your work leaves the hub while something else on it already says
 * what is next (hubWorkEmpty). A project with people in it keeps both.
 *
 * ── The channel lives on the page ──────────────────────────────────────
 *
 * A project's channel was a row in Messages (#2718 review). Messages is
 * people and agents now, and the channel is the community's own room, its
 * Discussion (./project-discussion.tsx), so the hub's door to it says the
 * last thing said there. A viewer who may not talk here (a view-public,
 * collab-private app) gets no row: no door that refuses them.
 *
 * ── Island rules ───────────────────────────────────────────────────────
 *
 * The lander mounts client-side into a legacy host and has no server render,
 * so these read the shared community record (./community-card.tsx's
 * useCommunity) and draw nothing until it has answered.
 */

import { useEffect, useId, useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { SectionHeader, ListRow } from '@/components/ui/grouped-list';
import { IconTile } from '@/components/ui/icon-tile';
import { BallotIcon, BoardIcon, ChatIcon, CheckIcon, ChevronRightIcon, ClockIcon } from '@/components/ui/icons';
import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { agoStamp } from '../../../lib/timestamp';
import { changeHref } from '../../../lib/change-href';
import { type BuildLineState, buildLineOf } from '../../first-session/build-line';
import { useTourRunning } from '../../first-session/tour-running';
import { ThumbRow } from '../../first-session/sketch-card';
import { open as openConversation, openBot } from '../../messages/store';
import type { DevWorkshopView, ListRow as BoardRow } from '../card/model';
import { isNeedsSeen, needsRowKey, useNeedsSeen } from '../../workshop/needs-seen';
import { reloadCommunity, type CommunityPayload, type HubFirstVersion } from './community-card';

/** How often the hub reads the project again while its first version is being built. */
export const FIRST_VERSION_POLL_MS = 15000;

/**
 * #4053: the build line, the server's for this viewer (`line`, from
 * homeroom-bot-dm.js firstVersionState), so the hub says exactly what the
 * made screen and the App tab say: "Building it", never "Step 4 of 7: Build
 * it", which read as an instruction to the person looking at it. Step
 * numbers stay in Homeroom bot's chat.
 */
export function firstVersionLine(fv: HubFirstVersion): BuildLineState {
  return buildLineOf(fv.line) || (fv.ready ? 'ready' : 'planning');
}

/**
 * The one thing the card offers, for whoever reads it (#4045), or null:
 *
 *   review    its plan waits for their Build it      the person who started it
 *   answer    Homeroom bot asked them a question     the person who started it
 *   see       its plan waits, read only (#4074)      a member who did not start it
 *   try       built and up for approval              everyone
 *   open      live, in the project's first week      everyone
 *
 * A card with a button hides its build line (the owner, 6 Oct 2026): "Your
 * plan is ready to review" over "Review the plan" said one thing twice, so
 * the button says it and the app's own line sits under its name. See the
 * plan is a quiet link beside the line, not a button, so "Planning it"
 * stays.
 */
export type FirstVersionAction = 'review' | 'answer' | 'see' | 'try' | 'open';

export function firstVersionAction(fv: HubFirstVersion): FirstVersionAction | null {
  const line = firstVersionLine(fv);
  if (line === 'live') return 'open';
  if (fv.ready) return fv.session_id ? 'try' : null;
  if (fv.waits_on === 'plan') return 'review';
  if (fv.waits_on === 'question') return 'answer';
  if (fv.plan && fv.plan.bullets && fv.plan.bullets.length) return 'see';
  return null;
}

/** The button's words by action: message ids, read when the card renders. */
const ACTION_WORDS: Record<Exclude<FirstVersionAction, 'see'>, string> = {
  review: 'project:hub.firstVersion.review',
  answer: 'project:hub.firstVersion.answer',
  try: 'project:hub.firstVersion.tryIt',
  open: 'project:hub.firstVersion.openApp',
};

/**
 * FIRST VERSION (#4045): the project's thumbnail drawn small, its icon on
 * its colour and its name (../../first-session/sketch-card.tsx ThumbRow),
 * with ONE more line and at most one thing to do (firstVersionAction). With
 * nothing to tap, the line is the build line the made screen and the App
 * tab draw ("Building it", ../../first-session/build-line.tsx), the
 * server's for this viewer (GET /api/apps/:slug/community `first_version`).
 * With a button, the button says where it is and the card has no line: the
 * project's own description sits once, under the hub's people row (the
 * owner, 8 Oct 2026).
 *
 *   Review the plan, Answer the question   open the maker's chat with
 *                                          Homeroom bot, where it is answered
 *   See the plan                           the plan, read only (./plan-page.tsx)
 *   Try it                                 the version to try, as its message
 *                                          in the chat opens it
 *   Open app                               the app, once it is live
 *
 * No "First version" heading, no step count and no note under it: the
 * thumbnail is what it is, and one line says where it is. Nothing for a
 * project the bot is not building, or once its first version is live and
 * the project's first week is over.
 *
 * While the first-session tour runs (../../first-session/tour-running.ts)
 * there is no Review the plan: the card shows the build line, "Homeroom bot
 * is working on it", and the tour's last card is what names the plan
 * (requests #4391, #4393). After the tour, it is as above.
 *
 * No event marks each step, so while the card is on screen the record is
 * read again every FIRST_VERSION_POLL_MS, as the App tab and the made screen
 * read theirs (AppView._recheckFirstVersion, made.tsx).
 */
export function FirstVersionCard({ slug, data, emoji = null, onSeePlan }: {
  slug: string;
  data: CommunityPayload | null;
  /** The project's icon, as the page already knows it (improveStore). */
  emoji?: string | null;
  /** Opens the plan, read only (./workshop.tsx's 'plan' page). */
  onSeePlan?: () => void;
}): ReactNode {
  const fv = data?.first_version || null;
  const ref = useRef<HTMLElement | null>(null);
  const building = !!fv && fv.line !== 'live';
  useEffect(() => {
    if (!building || !slug) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!ref.current || !ref.current.getClientRects().length) return;
      void reloadCommunity(slug);
    }, FIRST_VERSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [building, slug]);
  // While the first-session tour runs, its last card is what names the plan
  // (../../first-session/tour-running.ts): no Review the plan here, only the
  // build line saying the bot is on it.
  const touring = useTourRunning();
  const t = useMessages('project');
  if (!fv) return null;
  const asked = firstVersionAction(fv);
  const held = touring && asked === 'review';
  const line: BuildLineState = held ? 'working' : firstVersionLine(fv);
  const action = held ? null : asked;
  const press = () => {
    if (action === 'review' || action === 'answer') {
      if (fv.conversation_id) openConversation(fv.conversation_id);
      else void openBot();
    } else if (action === 'try' && fv.session_id) {
      (window as any).AppView?.tryFirstVersion?.(slug, fv.session_id);
    } else if (action === 'open') {
      (window as any).App?.openAppTab?.(slug, 'app');
    }
  };
  const button = action && action !== 'see';
  return (
    <section ref={ref} className="dev-ws-strip dev-ws-hub-first" data-ws-first-version={line}>
      <div className="dev-ws-hub-first-row">
        <ThumbRow
          name={data?.name || slug}
          colorKey={slug}
          emoji={emoji}
          line={button ? null : line}
        />
        {action === 'see' ? (
          <button
            type="button"
            className="dev-ws-hub-first-see un-touch-target"
            data-ws-first-version-plan=""
            onClick={onSeePlan}
          >
            {t('project:hub.firstVersion.seePlan')}
          </button>
        ) : null}
      </div>
      {button && action ? (
        action === 'open' ? (
          <button type="button" className="dev-ws-open-app dev-ws-hub-first-open" data-ws-first-version-action="open" onClick={press}>
            {t(ACTION_WORDS.open)}
          </button>
        ) : (
          <Button
            type="button"
            layout="full"
            variant="pillAccent"
            size="pill"
            ink="solid"
            data-ws-first-version-action={action}
            onClick={press}
          >
            {t(ACTION_WORDS[action])}
          </Button>
        )
      ) : null}
    </section>
  );
}

/** Whether the queue holds a vote the viewer owes: the hub's Needs you door
    is drawn only then. */
export const owesVote = (queue: DevWorkshopView['queue']): boolean => queue.some((row) => row.kind === 'vote');

/**
 * NO VOTE OWED (#3408): in the Needs you card's place, one quiet line that
 * says so, instead of a card whose whole content was that nothing waits.
 * When requests nobody has picked up are open (`unclaimed`, the view
 * model's `dashboard.unclaimed`) the line names them, and that phrase is the
 * way to them: the Workshop, where the work is (Needs you is votes alone).
 *
 * ON A PROJECT NOBODY ELSE IS IN (`alone`) there is nobody to put a vote up,
 * so "Nothing more to vote on." is a zero, and a zero says nothing: the line
 * is not drawn, or it is the requests alone when there are some.
 */
export function NothingToVote({ unclaimed, onOpen, alone = false }: {
  /** Open requests nobody has picked up. */
  unclaimed: number;
  onOpen: () => void;
  /** Nobody but one person is in the project (hubAlone), or it is in its
      first week (#4045), when nothing has been up for a vote yet: the
      zero says nothing either way. */
  alone?: boolean;
}): ReactNode {
  const t = useMessages('project');
  const claims = Math.max(0, Number(unclaimed) || 0);
  if (alone && !claims) return null;
  return (
    <p className="dev-ws-week-note" data-ws-hub-needs-none="">
      {!claims ? t('project:hub.needs.none') : (
        // One message either way: alone, the requests are the whole line;
        // otherwise they follow "Nothing more to vote on", inside the same sentence.
        <RichMessage
          id={alone ? 'project:hub.needs.requestsAlone' : 'project:hub.needs.noneButRequests'}
          values={{ count: claims }}
          components={[
            <button type="button" className="dev-ws-link un-touch-target" onClick={onOpen} data-ws-hub-needs-requests="" />,
          ]}
        />
      )}
    </p>
  );
}

/**
 * Whether nobody but one person is in the project: Just you, or a
 * community whose one member is still alone in it. Not before the read has
 * answered, so nothing is taken off the hub on a guess.
 */
export function hubAlone(data: Pick<CommunityPayload, 'audience' | 'member_count'> | null | undefined): boolean {
  return !!data && (data.audience === 'solo' || (Number(data.member_count) || 0) <= 1);
}

/**
 * What the hub's Your work says with nothing in progress, or null when it
 * leaves the hub.
 *
 *   'plain'  "No work in progress." (#3489): a project with people in it,
 *            where the place your work appears stays put
 *   null     a project in its first week (#4045), or one nobody else is
 *            in while something else on the hub already says what is
 *            next: its first version being built, the start-here banner,
 *            or nothing a read-only viewer can start
 *   'bot'    nobody else is in it and Homeroom bot builds here for you: to
 *            change something, tell it (`mine.bot`, AppView._botDoor)
 *   'menu'   nobody else is in it: the ⋯ is where a change is asked for
 */
export type WorkEmpty = 'plain' | 'bot' | 'menu' | null;

export function hubWorkEmpty({ alone, building, startHere, readOnly, bot, firstWeek = false }: {
  alone: boolean;
  building: boolean;
  startHere: boolean;
  readOnly: boolean;
  bot: boolean;
  /** #4045: in a project's first week an empty Your work is left out:
      it shows once you have some. */
  firstWeek?: boolean;
}): WorkEmpty {
  if (firstWeek) return null;
  if (!alone) return 'plain';
  if (building || startHere || readOnly) return null;
  return bot ? 'bot' : 'menu';
}

/* ── For you ─────────────────────────────────────────────────────────── */

/** A row's label over its card: SectionHeader, set for the hub's column. */
const HUB_HEAD = 'px-1 pb-0 pt-2';

/** The Needs you tile while a vote is owed: the accent, which asks for you. */
const OWED_TILE = 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300';

/**
 * NEEDS YOU, as the card's first row: the first vote you owe and how many
 * more ("Builder login…, and 3 more"), "4 to vote", opening the queue — one
 * decision per screen, as it always was. The queue also carries requests
 * nobody has claimed, which are the group's to pick up rather than yours to
 * answer, so they are not counted here.
 *
 * #3526: THE COUNT IS WHAT YOU HAVE NOT SEEN. A vote swiped past in the feed
 * unanswered is left out of it, as the band's count leaves it out
 * (../../workshop/needs-seen.ts), and the first title is the first vote you
 * have not seen. The row stays while any vote is owed, seen or not: with
 * nothing new it says how many skipped ones are still open instead.
 */
function NeedsRow({ queue, slug, canPost, onOpen }: {
  queue: DevWorkshopView['queue'];
  slug: string;
  canPost: boolean;
  onOpen: () => void;
}): ReactNode {
  const t = useMessages('project');
  useNeedsSeen();
  const votes = queue.filter((row) => row.kind === 'vote');
  const fresh = votes.filter((row) => !isNeedsSeen(slug, needsRowKey(row)));
  const skipped = votes.length - fresh.length;
  const first = fresh.find((row) => row.t === 'card') || null;
  const count = fresh.length;
  const title = first && first.t === 'card' ? first.card.title.text || first.card.title.title : '';
  const sub = count && title ? (
    <span data-ws-hub-needs-first="">
      {count > 1 ? t('project:hub.forYou.needs.firstAndMore', { title, count: count - 1 }) : title}
    </span>
  ) : !count && skipped ? (
    <span data-ws-hub-needs-skipped="">{t('project:hub.needs.skipped', { count: skipped })}</span>
  ) : undefined;
  return (
    <div className="dev-ws-foryou-item" data-ws-hub-needs="" data-ws-hub-needs-votes={String(count)}>
      <ListRow
        as="button"
        inset="none"
        className="dev-ws-foryou-row"
        data-ws-hub-needs-open=""
        onClick={onOpen}
        leading={<IconTile size="xs" className={count ? OWED_TILE : undefined}><BallotIcon aria-hidden="true" /></IconTile>}
        title={t('project:hub.needs.title')}
        subtitle={sub}
        trailing={count ? <span className="dev-ws-foryou-pill">{t('project:hub.needs.toVote', { count })}</span> : undefined}
      />
      {count && !canPost ? (
        <p className="dev-ws-hub-needs-join" data-ws-hub-needs-join="">{t('project:hub.needs.joinToVote')}</p>
      ) : null}
    </div>
  );
}

/**
 * YOUR WORK, as the card's second row: the first of your items in flight
 * (newest activity first, the Workshop's order) and how many there are,
 * opening the Workshop, where they are listed in full. With nothing in
 * progress it says so (#3489) in hubWorkEmpty's words: on a project nobody
 * else is in, how to change something instead, and its row then opens the
 * chat with Homeroom bot where the bot builds for you. No row for a visitor,
 * who has no work to have none of, nor when hubWorkEmpty leaves it out.
 */
function WorkRow({ mine, empty, onOpen }: {
  mine: DevWorkshopView['mine'] | null | undefined;
  empty: WorkEmpty;
  onOpen: () => void;
}): ReactNode {
  const t = useMessages('project');
  const cards = (mine?.rows || []).filter((row): row is Extract<BoardRow, { t: 'card' }> => row.t === 'card');
  if (!cards.length && !(mine?.viewer && empty)) return null;
  const first = cards[0] || null;
  const toBot = !first && empty === 'bot';
  const sub = first ? (
    <span
      data-ws-mine-first={first.key}
      // The viewer's own session (#1887): `?shot=mine-session` leads with one.
      data-ws-mine-session={first.card.attrs && first.card.attrs['data-session-chip'] ? '' : undefined}
    >
      {first.card.title.text || first.card.title.title}
    </span>
  ) : empty === 'bot' ? (
    <span data-ws-mine-empty="bot">{t('project:hub.work.emptyBot')}</span>
  ) : empty === 'menu' ? (
    <span data-ws-mine-empty="menu">
      <RichMessage id="project:hub.work.emptyMenu" components={[<span className="font-medium text-violet-700 dark:text-violet-400" />]} />
    </span>
  ) : (
    <span data-ws-mine-empty="">{t('project:hub.work.empty')}</span>
  );
  return (
    <ListRow
      as="button"
      inset="none"
      className="dev-ws-foryou-row"
      data-ws-mine-card=""
      data-ws-mine-open={toBot ? 'bot' : 'workshop'}
      onClick={toBot ? () => { void openBot(); } : onOpen}
      leading={<IconTile size="xs"><BoardIcon aria-hidden="true" /></IconTile>}
      title={t('project:hub.work.title')}
      subtitle={sub}
      trailing={cards.length ? (
        <span className="dev-ws-foryou-count">{t('project:hub.forYou.work.inProgress', { count: cards.length })}</span>
      ) : undefined}
    />
  );
}

/**
 * THE DISCUSSION, as the card's last row: the channel's name and the last
 * thing said in it, "@kempis: enjoy the weekend guys · 4h ago", opening the
 * Discussion place (./project-discussion.tsx), where the room is whole. How
 * much there is new since you last read it is its one pill. With nothing
 * said yet it asks for the first word (#4045). No row without a channel
 * this viewer may talk in, or on a project that is just yours: nobody to
 * talk to yet (its Share it card is how it grows).
 */
function DiscussionRow({ name, data, onOpen }: {
  name: string;
  data: CommunityPayload | null;
  onOpen: () => void;
}): ReactNode {
  const t = useMessages('project');
  const channel = data?.channel;
  if (!data || !channel || data.audience === 'solo') return null;
  // The newest line with words in it: a message that is only a picture or a
  // file has none to quote, so it is named by who sent it.
  const recent = (channel.recent || []).map((m) => ({ content: m.content, by: m.by, at: m.created_at }));
  if (!recent.length && channel.last_at) recent.push({ content: channel.last_message || '', by: channel.last_by, at: channel.last_at });
  const words = (m: { content: string | null }) => String(m.content || '').replace(/\s+/g, ' ').trim();
  const last = [...recent].reverse().find((m) => words(m)) || recent[recent.length - 1] || null;
  const unread = Number(channel.unread_count) || 0;
  const line = last ? words(last) : '';
  const ago = last && last.at ? agoStamp(last.at).text : '';
  const sub = last ? (
    <span data-ws-channel-last="">
      {line && last.by ? t('project:hub.forYou.discussion.lastBy', { username: last.by, message: line, ago })
        : line ? t('project:hub.forYou.discussion.last', { message: line, ago })
          : last.by ? t('project:hub.forYou.discussion.postedBy', { username: last.by, ago })
            : t('project:hub.forYou.discussion.posted', { ago })}
    </span>
  ) : (
    <span data-ws-channel-empty="">{t('project:hub.channel.sayHi', { project: name })}</span>
  );
  return (
    <ListRow
      as="button"
      inset="none"
      className="dev-ws-foryou-row"
      data-ws-channel="preview"
      data-ws-channel-open=""
      data-ws-channel-handle={channel.handle || undefined}
      onClick={onOpen}
      leading={<IconTile size="xs"><ChatIcon aria-hidden="true" /></IconTile>}
      title={(
        <RichMessage
          id="project:hub.forYou.discussion.title"
          values={{ handle: channel.handle || 'general' }}
          components={[<span className="dev-ws-foryou-handle" />]}
        />
      )}
      subtitle={sub}
      trailing={unread > 0 ? (
        <span className="dev-ws-foryou-pill" data-ws-channel-unread={String(unread)}>
          {t('project:hub.channel.unread', { count: unread, shown: unread > 99 ? '99+' : String(unread) })}
        </span>
      ) : undefined}
    />
  );
}

/**
 * FOR YOU: what on this project is the viewer's, one card of doors under its
 * label — Needs you, Your work, the Discussion — each row a door to its
 * place, at most one pill on it, 15 over 13. With no vote owed, Needs you is
 * the quiet line that says so (NothingToVote, #3408), or nothing on a
 * project nobody else is in. Nothing at all when no row has anything to say.
 */
export function ForYouCard({
  slug, name, queue, unclaimed, mine, workEmpty, alone, data, canPost, onNeeds, onWork, onDiscussion,
}: {
  slug: string;
  /** The project's name, for the Discussion's first word. */
  name: string;
  queue: DevWorkshopView['queue'];
  /** Open requests nobody has picked up (the view model's
      `dashboard.unclaimed`): Needs you is votes alone, so with no vote
      owed its quiet line names them and opens the Workshop. */
  unclaimed: number;
  mine: DevWorkshopView['mine'] | null | undefined;
  /** What Your work says with nothing in progress (hubWorkEmpty). */
  workEmpty: WorkEmpty;
  /** Nobody else is in it, or it is in its first week: no zeros. */
  alone: boolean;
  data: CommunityPayload | null;
  canPost: boolean;
  onNeeds: () => void;
  onWork: () => void;
  onDiscussion: () => void;
}): ReactNode {
  const t = useMessages('project');
  const headId = useId();
  const owes = owesVote(queue);
  const claims = Math.max(0, Number(unclaimed) || 0);
  const needs = owes || !alone || claims > 0;
  const cards = (mine?.rows || []).some((row) => row.t === 'card');
  const work = cards || !!(mine?.viewer && workEmpty);
  const talk = !!(data && data.channel && data.audience !== 'solo');
  if (!needs && !work && !talk) return null;
  return (
    <section className="dev-ws-hub-section" data-ws-hub-for-you="" aria-labelledby={headId}>
      <SectionHeader id={headId} className={HUB_HEAD}>{t('project:hub.forYou.title')}</SectionHeader>
      <div className="dev-ws-strip dev-ws-foryou">
        {owes
          ? <NeedsRow queue={queue} slug={slug} canPost={canPost} onOpen={onNeeds} />
          : <NothingToVote unclaimed={claims} onOpen={onWork} alone={alone} />}
        <WorkRow mine={mine} empty={workEmpty} onOpen={onWork} />
        <DiscussionRow name={name} data={data} onOpen={onDiscussion} />
      </div>
    </section>
  );
}

/* ── Recently live ───────────────────────────────────────────────────── */

/** How many of the newest changes Recently live draws. */
export const RECENT_LIVE_SHOWN = 3;

/**
 * RECENTLY LIVE: the last three changes that went live, newest first
 * (AppView._workshopRecentLive), each a door to its page: its after shot
 * when the checks took one (else a plain tile), its title, and who made it
 * and when it went live — "Homeroom bot · 1h ago" — or that it is going
 * live now. The label's door, "All in Workshop", opens the Workshop, where
 * what landed is listed week by week. Three across on a wide window; on a
 * phone a row that scrolls sideways. Nothing when nothing has merged.
 */
export function RecentlyLive({ slug, rows, onAll }: {
  slug: string;
  rows: DevWorkshopView['recentLive'];
  onAll: () => void;
}): ReactNode {
  const t = useMessages('project');
  const headId = useId();
  const list = (rows || []).slice(0, RECENT_LIVE_SHOWN);
  if (!slug || !list.length) return null;
  return (
    <section className="dev-ws-hub-section" data-ws-hub-recent="" aria-labelledby={headId}>
      <div className="dev-ws-hub-sechead">
        <SectionHeader id={headId} className={HUB_HEAD}>{t('project:hub.recent.title')}</SectionHeader>
        <button type="button" className="dev-ws-hub-open un-touch-target" data-ws-recent-all="" onClick={onAll}>
          {t('project:hub.recent.all')}
          <ChevronRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="dev-ws-strip dev-ws-recent">
        <ul className="dev-ws-recent-list">
          {list.map((r) => {
            const ago = r.at ? agoStamp(r.at) : null;
            const meta = r.going
              ? (r.who ? t('project:hub.recent.byGoing', { who: r.who }) : t('project:hub.recent.going'))
              : r.who && ago && ago.text ? t('project:hub.recent.byAgo', { who: r.who, ago: ago.text })
                : r.who || (ago ? ago.text : '');
            return (
              <li key={r.key} className="dev-ws-recent-item">
                <a
                  className="dev-ws-recent-card"
                  href={changeHref(slug, r.sessionId, r.prNumber)}
                  data-ws-recent-item={r.key}
                  data-ws-recent-going={r.going ? '' : undefined}
                >
                  <span className="dev-ws-recent-pic" data-ws-recent-pic={r.picture ? 'shot' : 'plain'} aria-hidden="true">
                    {r.picture ? (
                      <img src={r.picture} alt="" loading="lazy" draggable={false} />
                    ) : r.going ? (
                      <ClockIcon className="dev-ws-recent-glyph" aria-hidden="true" />
                    ) : (
                      <CheckIcon className="dev-ws-recent-glyph" aria-hidden="true" />
                    )}
                  </span>
                  <span className="dev-ws-recent-title">{r.title}</span>
                  {meta ? (
                    <span className={r.going ? 'dev-ws-recent-meta dev-ws-recent-going' : 'dev-ws-recent-meta'} title={ago ? ago.title : undefined}>
                      {meta}
                    </span>
                  ) : null}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

