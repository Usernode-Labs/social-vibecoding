/**
 * `#dev-workshop` — the Dev screen's lander, as the only React writer below
 * that host. The host ELEMENT stays app-view.js's (`_repaintDevBody`
 * creates it inside #dev-body); everything under it renders from
 * `devWorkshopStore`, which `AppView._workshopView()` publishes on every
 * board repaint.
 *
 * ── What it replaced ─────────────────────────────────────────────────
 *
 * The Activity feed: the board's cards newest-first, each with a comment
 * preview and a reply box. A stream is the right shape for "what just
 * happened" and the wrong one for "what is this project about", and the
 * second question is the one a newcomer and a returning member both ask
 * first. So the lander groups the SAME cards by theme — what the work is
 * about, drafted by a model and corrected by the group — and keeps the
 * feed's two answers as strips above the themes: proposals waiting on this
 * viewer's vote, and what changed since they were last here.
 *
 * ── The row is the card, folded ──────────────────────────────────────
 *
 * A theme lists its items as one-line rows. Tapping a row unfolds it into
 * the Activity entry it always was — the dense card, the GitHub comment
 * preview and the app's own thread with its reply box (./card/feed-thread.tsx)
 * — so a reply from here lands in the same thread the Board and the topic
 * page show. One row per theme is open at a time, because a theme with
 * every row unfolded is the stream this replaced. The row, the open sheet
 * and the fold between them are ../card/fold.tsx's, shared with the Board's
 * columns, which fold their cards the same way now.
 *
 * Two slots inside an unfolded row stay legacy-FILLED, rendered here once,
 * empty, with constant classNames — the same seam the feed had:
 *
 * - `.dev-feed-comments[data-comments-for]` — `AppView._wireFeedComments`
 *   fills each when its entry scrolls into view. Rows unfold AFTER the
 *   publish, so the component re-wires the host from an effect (a call by
 *   name, like the footer buttons make).
 * - `[data-kudos-host]` inside merged cards — `_fillKudosHosts` + Kudos.
 *
 * Both sizes carry the item's `data-issue-row` / `data-proposal-row` hooks,
 * and the delegated `#dev-body` handler stands aside for clicks inside a
 * fold wrapper (see fold.tsx's header); the item's full-screen route is the
 * link on the open card.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  ArrowUpIcon,
  BallotIcon,
  ChatBubbleTailIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  DescriptionIcon,
  EllipsisHorizontalIcon,
  HandRaisedIcon,
  PlayIcon,
  SparklesIcon,
  SpeechCheckIcon,
  Squares2X2Icon,
} from '@/components/ui/icons';

import { Html } from '../../../lib/html';
import { agoStamp } from '../../../lib/timestamp';
import { useStoreState } from '../../../lib/use-store-state';
import { Improve } from '../../improve/improve-controller.js';
import { improveStore } from '../../improve/improve-store.js';
import { swatchFor } from '../../messages/format';
import { devWorkshopStore } from '../card/cards-store';
import { DevKanban } from '../card/dev-kanban';
import { DevActionsRow, DevPlusMenu } from '../actions-row';
import { useDevActions } from '../actions-store';
import { CardRowView, callAppView, openHref } from '../card/fold';
import { FeedThread } from '../card/feed-thread';
import type { DevCardModel, DevWorkshopView, ListRow, WorkshopTheme } from '../card/model';
import { CardSkeleton } from '../card/skeleton';
import { ProgressRing } from '@/components/ui/progress-ring';
import { useWorkshopGroup } from './group-mode-store';
import { AppWorkshopScope } from '../../workshop/workshop-chrome';
import { ApprovalRules, CommunityCard, ShareItCard, canMakePrivate, confirmMakePrivate, useCommunity } from './community-card';
import { WorkshopNotices } from './notices';
import { ChannelCard, NeedsCard, NothingToVote, owesVote, WorkshopDoor, YourWorkCard } from './hub-cards';
import { SinceSummaryCard } from './since-summary-card';
import { PageBack } from './page-back';
import { readAskStream } from './ask-stream';
import {
  commitDistance,
  swipeAxis,
  swipeProgress,
  swipeSide,
  swipeVerdict,
  type SwipeAxis,
  type SwipeSide,
} from './swipe-vote';

export type SortKey = 'people' | 'activity' | 'open';
type TabKey = 'status' | 'workshop' | 'needs' | 'all';

/**
 * "Since your last visit", week by week, on the Workshop page.
 *
 * It used to be two things on two tabs: the hub's list of what moved since
 * you were last here, and the Workshop tab's walk of weekly summaries. They
 * answer one question, so they are one list now: each WEEK is a heading
 * with its summary line, and what moved in it is nested under it, new
 * first and what you have already seen folded into one row.
 *
 * Three new rows a week are on screen and the rest of that week's are one
 * press away ("N more new"), because the question a returning member asks
 * is "did anything happen", which three rows answer. The weeks that hold
 * something new are open on arrival; `Show older` steps back one week at a
 * time from there, past what is loaded down to the project's first week
 * (#3293), whose heading and line are the history even where no row is.
 *
 * #2183 carries over: the baseline is only a line across one list, so a
 * quiet visit, or a visit just after Clear, still has somewhere to look
 * (the seen rows, folded under their week), and `Show older` disables
 * rather than leaves when there is nothing further back.
 */
const SINCE_FIRST = 3;

/** The since list with nothing in it: a first visit's, which still has weeks. */
const EMPTY_SINCE: NonNullable<DevWorkshopView['since']> = {
  baseline: 0, through: 0, total: 0, shipped: 0, opened: 0, proposed: 0, rows: [], seen: { total: 0, rows: [] },
};

/**
 * THE PAGES OF A PROJECT: its HUB, and three pages that open from it.
 *
 * The hub is the community's page: the hero, what landed since you were last
 * here, your work, the channel, and a door each to Needs you and the
 * Workshop. Anything longer than a glance is a page with a way back:
 *
 *   - Workshop, from its door: your work in full, since your last visit week
 *     by week, All items' summary, and the approval rules;
 *   - Needs you, from its door: one decision per screen;
 *   - All items, from the Workshop's All items card: the whole board.
 *
 * There is no tab strip any more. The hub and the Workshop were two tabs,
 * and the hub read as a second Workshop, seven cards long; with doors it is
 * short enough to take in, and each page is where its door says. The keys
 * and the `?ws=` deep links are the ones the tabs had.
 */

/**
 * The tab the page should open on now (AppView._workshopTab: a `?ws=` link,
 * else the one last chosen), or null where AppView is not there to ask.
 */
export function freshTab(): TabKey | null {
  const tab = callAppView('_workshopTab');
  return tab === 'status' || tab === 'workshop' || tab === 'needs' || tab === 'all' ? tab : null;
}

/** Where a page's back button goes: All items to the Workshop, the rest to the hub. */
export function pageParent(tab: TabKey): TabKey {
  return tab === 'all' ? 'workshop' : 'status';
}

/** A page's own title, in its back bar. */
export function pageTitle(tab: TabKey): string {
  if (tab === 'needs') return 'Needs you';
  if (tab === 'all') return 'All items';
  return 'Workshop';
}

// The shared ago ladder (#1808) — this file used to carry its own, with a
// 90-second "just now" and a 48-hour bucket that read "36h ago" where every
// other surface said "1d ago". Both call sites drop it into a SENTENCE, so
// the degraded form lands as "drafted Jun 16" rather than "drafted 84d ago",
// which is the point.
//
// The epoch guard stays: these two take a millisecond number that is 0 when
// the thing never happened, and `agoStamp(0)` is a 1970 date, not nothing.
function relTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return agoStamp(ms).text;
}

function Lane({
  lane, slug, canPost, openKey, onToggle, themeId,
}: {
  lane: WorkshopTheme['lanes'][number];
  slug: string;
  canPost: boolean;
  openKey: string | null;
  onToggle: (key: string) => void;
  themeId: string;
}): ReactNode {
  // "Shipped this week" is the one lane that is a RECORD rather than a
  // question — nothing in it needs anybody — so a theme opens on the work
  // that still wants someone and keeps the record one tap away (#1787). The
  // hook runs before the early return below, because a hook may not be
  // conditional; the lane still renders nothing when it holds nothing.
  const collapsible = lane.key === 'shipped';
  const [laneOpen, setLaneOpen] = useState(!collapsible);
  if (!lane.rows.length && !lane.more) return null;
  const total = lane.rows.length + lane.more;
  return (
    <div className={`dev-ws-lane dev-ws-lane-${lane.key}`} data-ws-lane={lane.key}>
      {collapsible ? (
        <h4
          className="dev-ws-lane-title"
          role="button"
          tabIndex={0}
          aria-expanded={laneOpen}
          onClick={() => setLaneOpen(!laneOpen)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLaneOpen(!laneOpen); } }}
        >
          <span className="dev-ws-dot" aria-hidden="true"></span>{lane.title}
          <span className="dev-ws-lane-n">{total}</span>
          <ChevronRightIcon className="dev-ws-chev" aria-hidden="true" />
        </h4>
      ) : (
        <h4 className="dev-ws-lane-title"><span className="dev-ws-dot" aria-hidden="true"></span>{lane.title}</h4>
      )}
      {!laneOpen ? null : lane.rows.map((row) => (row.t === 'card' ? (
        <CardRowView
          key={row.key}
          row={row}
          slug={slug}
          canPost={canPost}
          open={openKey === row.key}
          onToggle={() => onToggle(row.key)}
        />
      ) : null))}
      {laneOpen && lane.more ? <div className="dev-ws-more">{`+${lane.more} more in this lane`}</div> : null}
    </div>
  );
}

function Faces({ people }: { people: string[] }): ReactNode {
  const shown = people.slice(0, 4);
  const extra = people.length - shown.length;
  const [open, setOpen] = useState(false);
  if (!people.length) return null;
  return (
    <span className="dev-ws-faces-wrap">
      <button
        type="button"
        className="dev-ws-faces"
        aria-label={`Who is involved: ${people.join(', ')}`}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        {shown.map((p) => (
          <span key={p} className="dev-ws-face" style={{ backgroundColor: swatchFor(p) }} title={p}>
            {p.slice(0, 1).toUpperCase()}
          </span>
        ))}
        {extra > 0 ? <span className="dev-ws-face dev-ws-face-more">{`+${extra}`}</span> : null}
      </button>
      {open ? (
        <span className="dev-ws-roster" role="tooltip">
          {people.map((p) => <span key={p} className="dev-ws-roster-row">{p}</span>)}
        </span>
      ) : null}
    </span>
  );
}

function ThemeCard({
  theme, slug, canPost, open, onToggle, openKey, onToggleRow,
}: {
  theme: WorkshopTheme;
  slug: string;
  canPost: boolean;
  open: boolean;
  onToggle: () => void;
  openKey: string | null;
  onToggleRow: (key: string) => void;
}): ReactNode {
  const c = theme.counts;
  const openItems = c.open + c.underway + c.review;
  const chips: ReactNode[] = [];
  if (c.fresh) chips.push(<span key="fresh" className="dev-ws-cnt dev-ws-cnt-fresh"><b>{`+${c.fresh}`}</b> new</span>);
  if (c.review) chips.push(<span key="review" className="dev-ws-cnt dev-ws-cnt-review"><span className="dev-ws-dot"></span><b>{c.review}</b> in review</span>);
  if (c.underway) chips.push(<span key="underway" className="dev-ws-cnt dev-ws-cnt-underway"><span className="dev-ws-dot"></span><b>{c.underway}</b> underway</span>);
  chips.push(<span key="open" className="dev-ws-cnt"><span className="dev-ws-dot"></span><b>{c.open}</b> open</span>);
  if (c.shipped) chips.push(<span key="shipped" className="dev-ws-cnt dev-ws-cnt-shipped"><span className="dev-ws-dot"></span><b>{c.shipped}</b> shipped this week</span>);

  // `counts` rather than `rows.length`: the lane caps its rows at
  // WORKSHOP_LANE_MAX, so a theme with twelve underway used to report eight.
  const bits: string[] = [];
  if (c.underway) bits.push(`${c.underway} underway`);
  if (c.review) bits.push(`${c.review} in review`);
  const quietDays = theme.lastActive ? Math.floor((Date.now() - theme.lastActive) / 86400000) : null;
  const hidden = theme.lanes.reduce((n, l) => n + l.more, 0);
  // "nobody building yet" said something this cannot know. The condition is
  // only that nothing is in flight RIGHT NOW — a theme that shipped a dozen
  // changes and has a quiet week reads identically to one nobody has ever
  // touched, and the "yet" told newcomers the second story about both. What
  // the data actually supports is the present tense, so that is what it says;
  // where the theme shipped something this week it can say that instead, which
  // is the same fact with the history the old line was inventing.
  const idle = c.shipped
    ? `${c.shipped} shipped this week, nothing in flight now`
    : (quietDays != null && quietDays > 14 ? `quiet for ${quietDays} days` : 'nothing in flight right now');
  const foot = `${theme.people.length} involved · ${bits.length ? bits.join(' · ') : idle}`;

  return (
    <article
      className={open ? 'dev-ws-theme dev-ws-theme-open' : 'dev-ws-theme'}
      data-ws-theme={theme.id}
      data-ws-ungrouped={theme.ungrouped ? '1' : undefined}
    >
      <div
        className="dev-ws-theme-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        {/* The model picks the glyph, so it means the part of the product
            rather than hashing to a stable-but-arbitrary one. With none —
            an older row, or an answer the sanitiser rejected — the theme's
            initial on its own swatch, which is the treatment `Faces` already
            uses and reads as deliberate where a random emoji would not. */}
        <div className="dev-ws-theme-name">
          {theme.icon
            ? <span className="dev-ws-theme-icon" aria-hidden="true">{theme.icon}</span>
            : (
              <span
                className="dev-ws-theme-icon dev-ws-theme-icon-letter"
                aria-hidden="true"
                style={{ backgroundColor: swatchFor(theme.name) }}
              >{theme.name.slice(0, 1).toUpperCase()}</span>
            )}
          {theme.name}
        </div>
        {/* Two stats, not one: how many people, and how big. `counts` is
            incremented before the lane cap in the publisher, so this is the
            theme's real size and not what happens to be drawn. SHIPPED is
            excluded on purpose — the question the number answers is "how
            much is left in here", and work that landed is not left. */}
        <div className="dev-ws-theme-people">
          <span className="dev-ws-stat"><b>{theme.people.length}</b>{theme.people.length === 1 ? 'person' : 'people'}</span>
          <span className="dev-ws-stat"><b>{openItems}</b>{openItems === 1 ? 'item' : 'items'}</span>
        </div>
        {theme.saying ? (
          <p className="dev-ws-theme-say">{theme.saying}</p>
        ) : (theme.description ? <p className="dev-ws-theme-say">{theme.description}</p> : null)}
        <div className="dev-ws-theme-counts">{chips}</div>
        <div className="dev-ws-theme-foot">
          <Faces people={theme.people} />
          <span className="flex-1 min-w-0 truncate">{foot}</span>
          <ChevronRightIcon className="dev-ws-chev" aria-hidden="true" />
        </div>
      </div>
      {open ? (
        <div className="dev-ws-theme-body">
          {theme.lanes.map((lane) => (
            <Lane
              key={lane.key}
              lane={lane}
              slug={slug}
              canPost={canPost}
              openKey={openKey}
              onToggle={onToggleRow}
              themeId={theme.id}
            />
          ))}
          {/* The whole theme on the Board, at the bottom of the theme rather
              than under whichever lane happened to overflow: the filter it
              applies is the theme's, not a lane's. */}
          <div className="dev-ws-theme-more">
            {hidden ? <span>{`+${hidden} not shown · `}</span> : null}
            <button type="button" className="dev-ws-link" onClick={() => callAppView('openBoardForTheme', theme.id)}>
              Open on Board ›
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/**
 * The footnote under the model's grouping: when the themes were drafted and
 * on what schedule, then how much of the board they hold right now — cards
 * on their way into a theme, cards the placer could not fit, and the last
 * failure if there was one. Each is a fact the viewer can see on the page
 * ("placing…" markers, the trailing group), so the note names it.
 */
function aiFootnote(meta: DevWorkshopView['meta'], written: boolean): string {
  const drafted = meta.discoveredAt ? Date.parse(meta.discoveredAt) : NaN;
  const parts: string[] = [
    Number.isFinite(drafted)
      ? `Categories were drafted ${relTime(drafted)} and are re-drafted daily, or sooner when a tenth of the board changes.`
      : 'Categories are drafted from the board and re-drafted daily, or sooner when a tenth of the board changes.',
  ];
  const c = meta.coverage;
  if (c && c.pending) parts.push(`${c.pending} new ${c.pending === 1 ? 'card is' : 'cards are'} being placed.`);
  if (c && c.unplaced) {
    parts.push(`${c.unplaced} ${c.unplaced === 1 ? 'card did' : 'cards did'} not fit a category and ${c.unplaced === 1 ? 'waits' : 'wait'} for the next draft.`);
  }
  if (meta.lastError) parts.push(`The last attempt failed (${meta.lastError}); it is retried shortly.`);
  return parts.join(' ');
}

/**
 * Which paragraph is at the top of the page, and why.
 *
 * This used to be two clauses of the category footnote under the list,
 * which worked while the summary and the themes were on one scroll. They are
 * two TABS now, and an explanation of the summary sitting on the screen that
 * does not contain the summary explains nothing — so it moved to the
 * dashboard it is about.
 *
 * Without it the two failure states are indistinguishable on screen: a model
 * that has never run and one whose call keeps failing both leave the derived
 * sentence up there, and the only way to tell them apart was to read the
 * database.
 */
function digestNote(meta: DevWorkshopView['meta'], written: boolean): string {
  // The healthy case says NOTHING. It said "Written by the model on its last
  // pass over the board" — provenance under every board that was working,
  // answering a question nobody had asked and costing a line to do it.
  if (written) return '';
  if (meta.digestError) {
    // The failure that used to be a log line and a day of silence. Naming it
    // here is what turned "could something be up with the summarizer?" from a
    // question about the database into one the page answers.
    return `The model\u2019s summary could not be written (${meta.digestError}); it is retried within the hour, and this is worked out from the board meanwhile.`;
  }
  return 'Worked out from the board; the model writes one on the next pass.';
}

/**
 * The no-items note, drawn where the items would have been.
 *
 * Two screens say it — the hub under its hero, and the All items pane under
 * its toolbar — and the second of those is the fix for #2090. The pane
 * used to be gated on having a theme to draw, so a search that matched
 * nothing unmounted the whole pane: the grouping tabs, the "+", and the
 * toolbar whose host the search field lives in. The one control that could
 * undo the search left the screen with the rows, and the viewer was stuck on
 * a board they could not widen back out. Now the pane stays, and this note
 * takes the rows' place beneath the box it is talking about.
 *
 * ── It says only what the screen can do ──────────────────────────────
 *
 * It read "Press + to propose a change or file an issue", and both halves had
 * stopped being true: the "+" was only in All items' search row, so on
 * Current status it pointed at nothing on screen, and it has had no propose
 * row since New change moved to Improve (#1490) and then to the Homeroom
 * menu (#2740 review), where it is "Start a new change" under Agent sessions
 * since the UI overhaul — an owner decision this note does not undo. The "+"
 * became the hero's ⋯, on the hub, so the note names what it holds (and, on
 * All items, where it is), and sends "make one yourself" to the row that
 * does it, by the name the header gives that menu ("Homeroom menu", the
 * mark's own aria-label).
 *
 * Gated on the same facts as what it names: "import a PR" only where the ⋯
 * carries that row (`canCollaborate`), and nothing to press at all for a
 * read-only viewer, whose ⋯ holds Fork alone and whose menu has no Start a
 * new change (both from `AppView.readOnly`, the flag that row and the ⋯'s
 * writable rows are each gated on).
 *
 * UNDER THE START-HERE BANNER it stops at the ⋯. On the hub an empty
 * board is nearly always an app nobody has started, and #2573's banner right
 * above the note carries its own Start a new change button — so sending the reader
 * to the Homeroom menu for the same button would be the note talking past
 * the screen it is on. All items has no banner, so there it says the whole
 * thing.
 */
function EmptyNote({ filtered, loadFailed, underStartHere = false, onHub = false }: {
  filtered: boolean;
  loadFailed: boolean;
  underStartHere?: boolean;
  /** Drawn on the hub, under the hero whose ⋯ it names. */
  onHub?: boolean;
}): ReactNode {
  const { readOnly, canCollaborate } = useDevActions();
  const where = onHub ? '' : ' on the hub';
  const adds = canCollaborate ? ' to ask for a change or import a PR' : ' to ask for a change';
  const start = underStartHere ? '.' : '; to make one yourself, use Start a new change in the Homeroom menu.';
  return (
    <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2" data-ws-empty="">
      {filtered ? (
        'Nothing here matches the current search and filters.'
      ) : (
        <>
          {loadFailed ? "Couldn't load open issues right now. " : ''}
          {readOnly ? 'Nothing on the board yet.' : (
            <>
              {'Nothing on the board yet. Press '}
              <span className="font-medium text-violet-700 dark:text-violet-400">⋯</span>
              {where + adds + start}
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * #2573 — the start-here prompt, at the very top of Current status.
 *
 * ── When it is up ───────────────────────────────────────────────────────
 *
 * One state only: nothing open AND nothing ever landed. Both halves are
 * needed, and neither alone is this state. An app with no open items that
 * has shipped a hundred changes is FINISHED, not unstarted, and offering it
 * a "start working on this app" prompt reads as though the page had not
 * looked; an app with nothing shipped but a full board has already been
 * started, by whoever filed those. `everShipped` is the whole Done column,
 * not `shippedWeek` — see the model — because a quiet week on a busy app
 * zeroes the week count and would otherwise put this banner on it.
 *
 * There was a third condition, `meta.filtered`, because `dashboard.open`
 * used to count only the entries that survived the shared filter bar, so a
 * search matching nothing read as "no open items" on a board with plenty.
 * The search and filters narrow All items alone now (#2915) and the count is
 * the whole app's, so the two conditions above are the whole claim.
 *
 * ── Why the button is not a second "Start a new change" ─────────────────
 *
 * It is `Improve.startSession()`, the one the Homeroom menu's Start a new
 * change row calls (it was the Improve panel's New change) — imported, not re-implemented, so the navigate-then-create
 * sequence that entry point owns (features/improve/improve-controller.js)
 * can never drift from this copy of it. The gate is the same store field the
 * panel gates that row on, for the same reason: a viewer who may not start a
 * change from the panel must not be offered one here. They still get the
 * heading and the line, which say what the app's state IS — that part is not
 * a write action.
 *
 * The surface is `.dev-ws-strip` and its heading classes, unchanged, so the
 * prompt is another pane of this tab rather than a second visual language;
 * both themes come from the tokens every strip beside it already reads. The
 * action is the shell's own primary Button, which is the violet accent in
 * light and dark alike.
 */
function StartHereBanner(): ReactNode {
  const readOnly = useStoreState(improveStore).readOnly;
  return (
    <section className="dev-ws-strip" data-ws-start-here="">
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">Start working on this app</span>
      </div>
      <p className="dev-ws-strip-text">
        Nothing is open and nothing has shipped yet. The first change is yours to start.
      </p>
      {readOnly ? null : (
        <Button
          type="button"
          data-ws-start-here-btn=""
          size="sm"
          className="self-start"
          onClick={() => Improve.startSession()}
        >
          Start a new change
        </Button>
      )}
    </section>
  );
}

function sortThemes(themes: WorkshopTheme[], key: SortKey): WorkshopTheme[] {
  const list = themes.slice();
  const real = list.filter((t) => !t.ungrouped);
  const tail = list.filter((t) => t.ungrouped);
  if (key === 'people') real.sort((a, b) => (b.people.length - a.people.length) || (b.lastActive - a.lastActive));
  if (key === 'activity') real.sort((a, b) => (b.lastActive - a.lastActive) || (b.people.length - a.people.length));
  if (key === 'open') real.sort((a, b) => (b.counts.open - a.counts.open) || (b.lastActive - a.lastActive));
  return real.concat(tail);
}

// THE ORDER HOLDS BETWEEN SORTS. The list was re-sorted on every refetch, so
// a vote, a verdict or a new card anywhere on the board could move the theme
// the reader was looking at — the largest layout shift measured on the
// Workshop was a card dropping 255 px when a draft became a proposal and its
// theme's counts moved. A chip press (or the first paint) sorts; a refetch
// keeps every theme where it was, drops the ones that are gone and adds new
// ones at the end, above "Not yet grouped".
export type HeldThemeOrder = { key: SortKey; ids: string[] } | null;
export function orderThemesStable(held: HeldThemeOrder, themes: WorkshopTheme[], key: SortKey): WorkshopTheme[] {
  const sorted = sortThemes(themes, key);
  if (!held || held.key !== key) return sorted;
  const byId = new Map(themes.map((t) => [t.id, t]));
  const kept = held.ids.map((id) => byId.get(id)).filter((t): t is WorkshopTheme => !!t);
  const keptIds = new Set(kept.map((t) => t.id));
  const all = kept.concat(sorted.filter((t) => !keptIds.has(t.id)));
  return all.filter((t) => !t.ungrouped).concat(all.filter((t) => t.ungrouped));
}
function useStableThemeOrder(themes: WorkshopTheme[], key: SortKey): WorkshopTheme[] {
  const held = useRef<HeldThemeOrder>(null);
  return useMemo(() => {
    const ordered = orderThemesStable(held.current, themes, key);
    held.current = { key, ids: ordered.map((t) => t.id) };
    return ordered;
  }, [themes, key]);
}

// A chip press re-sorts, and the themes slide to their new places rather than
// jumping there (FLIP: the positions are read on the press, before the
// re-render, and each card animates from its old place to its new one).
function useThemeReorderMotion(listRef: { current: HTMLElement | null }, themes: WorkshopTheme[]) {
  const from = useRef<Map<string, number> | null>(null);
  const capture = () => {
    const list = listRef.current;
    if (!list || typeof window === 'undefined'
      || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    const tops = new Map<string, number>();
    list.querySelectorAll<HTMLElement>(':scope > [data-ws-theme]').forEach((el) => {
      tops.set(el.dataset.wsTheme || '', el.getBoundingClientRect().top);
    });
    from.current = tops;
  };
  useLayoutEffect(() => {
    const tops = from.current;
    from.current = null;
    const list = listRef.current;
    if (!tops || !list) return;
    list.querySelectorAll<HTMLElement>(':scope > [data-ws-theme]').forEach((el) => {
      const was = tops.get(el.dataset.wsTheme || '');
      if (was == null || typeof el.animate !== 'function') return;
      const dy = was - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) return;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
        { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    });
  }, [themes, listRef]);
  return capture;
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'people', label: 'By people' },
  { key: 'activity', label: 'By activity' },
  { key: 'open', label: 'By open items' },
];

type Dash = NonNullable<DevWorkshopView['dashboard']>;

/** The rate, as a sentence: this week's merges against last week's. */
function pace(d: Dash): string {
  const n = d.shippedWeek;
  const p = d.shippedPrevWeek;
  // ── Why a partial history states no rate ──────────────────────────
  //
  // Both weeks are counted from the SAME page of merged history, and when
  // there is more behind it the earlier week is the one more likely to fall
  // off the end. So a truncated page reads as a drought that never happened:
  // an app merging twenty changes a week was told "20 landed this week, the
  // first in a fortnight", which is not a hedge away from true, it is
  // backwards. `At least` was already on the COUNT and it was never enough,
  // because the fault is in the COMPARISON.
  //
  // With a partial page the honest sentence is the floor and nothing else.
  if (d.partial) {
    if (!n) return 'Nothing has landed this week.';
    return `At least ${n} ${n === 1 ? 'change' : 'changes'} landed this week.`;
  }
  if (!n && !p) return 'Nothing has landed in the last fortnight.';
  if (!p) return `${n} ${n === 1 ? 'change' : 'changes'} landed this week, the first in a fortnight.`;
  if (n > p) return `${n} landed this week, up from ${p} the week before.`;
  if (n < p) return `${n} landed this week, down from ${p} the week before.`;
  return `${n} landed this week, the same as the week before.`;
}

/**
 * The app in two sentences, written by the model on the same reconcile that
 * drafted the themes — from the same board snapshot, so the paragraph and the
 * grouping under it can never describe different boards. `describe()` below is
 * what runs when there is none: no model configured, no draft yet, or that one
 * call failed. Same relationship the voted-category fallback has to the themes.
 */
/**
 * The four numbers, as tiles.
 *
 * They were prose ("58 open items across 11 themes... 4 proposals are waiting
 * on votes and 19 open items have nobody on them"), which is the slowest
 * possible way to read four integers and the reason the paragraph never got
 * to say anything else. A tile is scanned; a clause has to be parsed.
 *
 * These four and not others: they are the ones somebody arriving asks. How
 * much is open, is it moving, is anything blocked on ME, and is anything
 * going begging. `themes` and `people` are already on screen — the sort bar
 * counts the themes, and every theme header carries its own roster.
 *
 * "Shipped this week" wears a `+` when the merged history is paged, because
 * the number is then a floor and not a total. That is the same fact `pace()`
 * refuses to compare on, said in one character.
 */

/**
 * The four figures.
 *
 * ── ONE ROW, NOT FOUR CARDS ──
 * They were four floating tiles inside the pane, each with its own fill,
 * hairline and drop shadow, sitting above a fifth box holding the summary
 * line — six surfaces inside one surface, which is what made the pane read
 * as a stack of things rather than one answer. They are one ruled row now:
 * hairlines between the figures, no fill of their own, on the pane's own
 * ground. Two up on a phone and four across from 420px, which is the
 * breakpoint they already used.
 *
 * ── THE ORDER IS AN ARGUMENT ──
 * The backlog, then the part of it nobody has taken, then the decision
 * waiting on you, then what actually landed. It reads as a progression and
 * it ends on the one number that says the app is moving. The old order —
 * open, shipped, votes, unclaimed — put the outcome second and buried the
 * unclaimed count at the end, away from the total it qualifies.
 *
 * ── THE MARK CARRIES THE TONE; THE COLOUR RIDES ALONG ──
 * Tone was a colour on the integer alone — a green `6`, an amber `3` — which
 * is state in hue and nothing else, unreadable to anyone who cannot separate
 * the two. A dot beside the label carries it now, and BECAUSE it does, the
 * number is free to take the colour as well: redundant rather than
 * load-bearing is the whole difference. Only the two figures that are a CALL
 * wear either: a zero is not a warning, and "nobody on them" is a fact about
 * the backlog rather than an alarm, so both stay in text ink.
 */
function DashTiles({ d }: { d: Dash }): ReactNode {
  const cells: { key: string; n: number; label: string; tone?: string; title?: string }[] = [
    { key: 'open', n: d.open, label: d.open === 1 ? 'open item' : 'open items' },
    { key: 'unclaimed', n: d.unclaimed, label: 'nobody on them' },
    {
      key: 'votes',
      n: d.votesWaiting,
      label: d.votesWaiting === 1 ? 'waiting on a vote' : 'waiting on votes',
      tone: d.votesWaiting ? 'warn' : undefined,
    },
    {
      key: 'shipped',
      n: d.shippedWeek,
      label: 'shipped this week',
      tone: d.shippedWeek ? 'good' : undefined,
      title: d.partial
        ? 'At least this many: the merged history is longer than the page loaded.'
        : 'This calendar week, counted from Monday 00:00 UTC.',
    },
  ];
  return (
    <div className="dev-ws-dash" data-ws-dash="">
      {cells.map((c) => (
        <span
          key={c.key}
          className={c.tone ? `dev-ws-dash-cell dev-ws-dash-cell-${c.tone}` : 'dev-ws-dash-cell'}
          data-ws-dash-cell={c.key}
          title={c.title}
        >
          <b>{c.key === 'shipped' && d.partial && c.n ? `${c.n}+` : c.n}</b>
          <span className="dev-ws-dash-label">
            {/* A GRID in app.css, not an inline run: the label wraps at phone
                widths, and a centred mark floated to the middle of a two-line
                label while its second line ran back underneath the dot. */}
            {c.tone ? <i className={`dev-ws-dash-dot dev-ws-dash-dot-${c.tone}`} aria-hidden="true" /> : null}
            <span>{c.label}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * The three cards: what landed last week, what has landed this week, what
 * the open work is about — one model-written line each, under a title.
 *
 * They replaced a single paragraph that was answering all three questions at
 * once, and answering them badly: asked to cover a week, its meaning and the
 * work in flight inside 100 words, the model picked a headline and
 * generalised from the top of its list. Three fields give each window its own
 * sentence and its own budget, and — the half that actually fixed the
 * accuracy — its own complete input, fetched per calendar week rather than
 * filtered out of a board snapshot that was capped at a hundred merges.
 *
 * A window that held nothing gets no card, which is what the empty string
 * from the server means. All three empty is not a card set at all (the
 * client's normaliser returns null), so the pane falls through to the
 * paragraph and then to the derived sentence, and never renders an empty box.
 */
/**
 * "Aug 25", in UTC like the weeks themselves — and "Aug 25, 2025" for a day
 * outside the current year. #3293 walks back to the project's start, which
 * for a project over a year old passes a second Aug 25; a range is an
 * absolute fact only while it names one week.
 */
function weekDate(ms: number): string {
  const d = new Date(ms);
  const other = d.getUTCFullYear() !== new Date().getUTCFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC', ...(other ? { year: 'numeric' } : {}),
  });
}

/**
 * "Aug 25 – Aug 31" for a window whose `endMs` is the Monday after it, and
 * "Sep 14 → now" for the one that has not finished.
 *
 * THE LIVE WINDOW IS NOT A RANGE OF TWO DATES. Its `endMs` is the current
 * instant, so the completed-week arithmetic named yesterday and the caption
 * read "Sep 14 – Sep 15" on a Tuesday — a two-day week, and a range whose
 * right end moves every midnight for no reason the reader can see. It runs
 * from its Monday to NOW, so that is what it says.
 */
function weekRange(startMs: number, endMs: number, live?: boolean): string {
  if (live) return `${weekDate(startMs)} → now`;
  // `endMs` is EXCLUSIVE — the next Monday — so the caption names the Sunday
  // before it. Captioning a Monday–Sunday week with two Mondays is the kind
  // of off-by-one a reader notices and cannot explain.
  return `${weekDate(startMs)} – ${weekDate(endMs - 86400000)}`;
}

type CardRow = Extract<ListRow, { t: 'card' }>;

/** One week of the since list: its heading, its line, and what moved in it. */
export interface SinceWeek {
  key: string;
  /** "This week" for the live window; '' for the rest, which are their dates. */
  title: string;
  startMs: number;
  endMs: number;
  live: boolean;
  /** The week's summary (the digest's line for it), or '' where there is none. */
  line: string;
  counts: Dash['weeks'][number]['counts'];
  /** Moved since the viewer's last visit, newest first. */
  fresh: CardRow[];
  /** Moved before it, which they have seen. */
  seen: CardRow[];
}

const WEEK_MS = 7 * 86400000;

/** The Monday 00:00 UTC a moment falls in: the weeks' own anchor (AppView._weekStart). */
export function mondayUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * 86400000;
}

/**
 * The since list, filed by week, newest week first.
 *
 * The weeks are the digest's (`dashboard.weeks`, back to the project's
 * first), each with its line, whether or not anything in the list moved in
 * it: a week's heading and line are its history. A row whose week the
 * digest has no line for (a week in which nothing landed, which the digest
 * skips, or a board with no digest at all) gets a heading of its own dates
 * and no line. Rows file by `at`, the moment they moved, clamped to now so a
 * server clock a moment ahead cannot open a week that has not started.
 */
export function sinceWeeks(
  since: NonNullable<DevWorkshopView['since']>,
  weeks: Dash['weeks'] | null | undefined,
  nowMs: number,
): SinceWeek[] {
  const byStart = new Map<number, SinceWeek>();
  const thisMonday = mondayUtc(nowMs);
  for (const w of weeks || []) {
    const start = mondayUtc(w.startMs);
    if (byStart.has(start)) continue;
    byStart.set(start, {
      key: w.key,
      title: w.title,
      startMs: start,
      endMs: w.endMs,
      live: w.key === 'thisWeek',
      line: w.line || '',
      counts: w.counts || null,
      fresh: [],
      seen: [],
    });
  }
  const file = (row: ListRow, side: 'fresh' | 'seen') => {
    if (row.t !== 'card') return;
    const at = Math.min(Number(row.at) || nowMs, nowMs);
    const start = mondayUtc(at);
    let week = byStart.get(start);
    if (!week) {
      const live = start >= thisMonday;
      week = {
        key: `week:${start}`,
        title: live ? 'This week' : '',
        startMs: start,
        endMs: live ? nowMs : start + WEEK_MS,
        live,
        line: '',
        counts: null,
        fresh: [],
        seen: [],
      };
      byStart.set(start, week);
    }
    week[side].push(row);
  };
  for (const row of since.rows) file(row, 'fresh');
  for (const row of since.seen.rows) file(row, 'seen');
  return [...byStart.values()].sort((a, b) => b.startMs - a.startMs);
}

/**
 * What a week's unfolded state is remembered by: its Monday. Not `key`,
 * which is `week:<Monday>` while the week is built from rows alone and
 * becomes `thisWeek` / `lastWeek` when the digest's weeks ride in behind the
 * board's data. Keyed by `key`, a week opened in between snapped shut as
 * they landed. Both constructions share the `mondayUtc` start.
 */
export function sinceWeekStateKey(week: Pick<SinceWeek, 'startMs'>): string {
  return String(week.startMs);
}

/** How many weeks the list opens with: every week holding something new, and at least one. */
export function sinceWeeksOpen(weeks: SinceWeek[]): number {
  let last = -1;
  weeks.forEach((w, i) => { if (w.fresh.length) last = i; });
  return Math.min(weeks.length, Math.max(1, last + 1));
}

/**
 * One week of the since list: its heading (ONE NAMED WINDOW, THE REST
 * DATED, as the walk had it: "This week" wears its range as a gloss, every
 * other week is its dates), its summary line, and under them what moved in
 * it, nested so the rows read as the line's evidence. The seen rows are one
 * row, "Seen before", until it is pressed.
 */
export function SinceWeekBlock({ week, slug, canPost, openKey, onToggleRow, allNew, onAllNew, seenOpen, onSeen }: {
  week: SinceWeek;
  slug: string;
  canPost: boolean;
  openKey: string | null;
  onToggleRow: (key: string) => void;
  allNew: boolean;
  onAllNew: () => void;
  seenOpen: boolean;
  onSeen: () => void;
}): ReactNode {
  const fresh = allNew ? week.fresh : week.fresh.slice(0, SINCE_FIRST);
  const moreNew = week.fresh.length - fresh.length;
  const row = (r: CardRow) => (
    <CardRowView
      key={r.key}
      row={r}
      slug={slug}
      canPost={canPost}
      open={openKey === r.key}
      onToggle={() => onToggleRow(r.key)}
    />
  );
  return (
    <div className="dev-ws-since-week" data-ws-since-week={week.key}>
      <h4 className="dev-ws-since-week-head">
        {week.title ? (
          <>
            {week.title}
            <span className="dev-ws-card-range">{weekRange(week.startMs, week.endMs, week.live)}</span>
          </>
        ) : <span className="dev-ws-card-dates">{weekRange(week.startMs, week.endMs)}</span>}
        {/* What landed in the whole week, where the server can stand behind
            the figure: a footnote to the line, not a second count of the list. */}
        {week.counts && week.counts.closed ? (
          <span className="dev-ws-since-week-n">
            {week.counts.partial ? `${week.counts.closed}+` : week.counts.closed} landed
          </span>
        ) : null}
      </h4>
      {week.line ? <p className="dev-ws-since-week-line" data-ws-since-week-line="">{week.line}</p> : null}
      {week.fresh.length || week.seen.length ? (
        <div className="dev-ws-since-nest">
          {fresh.map(row)}
          {moreNew > 0 ? (
            <button type="button" className="dev-ws-since-fold dev-ws-since-fold-new" data-ws-since-more-new="" onClick={onAllNew}>
              <span className="dev-ws-since-fold-label">{moreNew} more new</span>
              <ChevronRightIcon className="dev-ws-since-fold-chev" aria-hidden="true" />
            </button>
          ) : null}
          {week.seen.length && !seenOpen ? (
            <button type="button" className="dev-ws-since-fold" data-ws-since-seen-fold="" onClick={onSeen}>
              <CheckIcon className="dev-ws-since-fold-check" aria-hidden="true" />
              <span className="dev-ws-since-fold-label">
                {week.fresh.length ? `${week.seen.length} more you have seen` : `${week.seen.length} you have seen`}
              </span>
              <ChevronDownIcon className="dev-ws-since-fold-chev" aria-hidden="true" />
            </button>
          ) : null}
          {week.seen.length && seenOpen ? (
            <>
              <div className="dev-ws-since-seen" data-ws-since-seen="">
                <span className="dev-ws-since-seen-label">Seen before</span>
                <span className="dev-ws-since-seen-n">{week.seen.length}</span>
              </div>
              {week.seen.map(row)}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The paragraph, for a board whose row predates the cards. `d.summary` is the
 * three lines flattened, which is all a row last written under the previous
 * digest prompt has; `describe` is the derived sentence under that again.
 */
function summarise(d: Dash): string {
  return d.summary || describe(d);
}

/**
 * The derived sentence — what the pane says when the model has not written
 * one.
 *
 * Round four cut this down to the two things the tiles cannot show and let
 * it return an EMPTY string when it could say neither, on the reasoning that
 * a blank beats prose repeating the numbers directly above it. That was
 * right about the duplication and wrong about the outcome: the model
 * paragraph is written on a reconcile pass, an app can sit for a long time
 * without one, and what a reader actually got was a pane with a heading, four
 * tiles and nothing that reads like a sentence — which looks like a broken
 * feature rather than a deliberate silence.
 *
 * So the full sentence is back, as the FALLBACK only. When the model has
 * written a paragraph that paragraph stands alone and states no counts (the
 * prompt spends most of its length on that). When it has not, this repeats
 * two of the tiles and is worth it, because the alternative is a blank.
 *
 * The footnote at the bottom of the lander says which of the two is on
 * screen, so "the summarizer looks broken" and "no draft yet" are
 * distinguishable without reading the database.
 */
function describe(d: Dash): string {
  const parts: string[] = [];
  const scale = `${d.open} open ${d.open === 1 ? 'item' : 'items'}`
    + (d.themes ? ` across ${d.themes} ${d.themes === 1 ? 'category' : 'categories'}` : '');
  parts.push(d.busiest ? `${scale}, most of the movement in ${d.busiest}.` : `${scale}.`);
  parts.push(pace(d));
  const waiting: string[] = [];
  if (d.votesWaiting) {
    waiting.push(`${d.votesWaiting} ${d.votesWaiting === 1 ? 'proposal is' : 'proposals are'} waiting on votes`);
  }
  if (d.unclaimed) {
    waiting.push(`${d.unclaimed} open ${d.unclaimed === 1 ? 'item has nobody on it' : 'items have nobody on them'}`);
  }
  if (waiting.length) parts.push(`${waiting.join(' and ').replace(/^./, (c) => c.toUpperCase())}.`);
  return parts.join(' ');
}

/** "1 change landed, 2 new proposals" — what moved while you were away. */
function sinceWords(s: NonNullable<DevWorkshopView['since']>): string {
  if (!s.rows.length) return 'nothing has changed';
  const bits = [
    s.shipped ? `${s.shipped} ${s.shipped === 1 ? 'change' : 'changes'} landed` : null,
    s.opened ? `${s.opened} new ${s.opened === 1 ? 'issue' : 'issues'}` : null,
    s.proposed ? `${s.proposed} new ${s.proposed === 1 ? 'proposal' : 'proposals'}` : null,
  ].filter(Boolean);
  // `total`, not `rows.length`: the rows are capped for drawing and this
  // sentence describes the whole population the head counts.
  return bits.length ? bits.join(', ') : `${s.total} ${s.total === 1 ? 'thing' : 'things'} moved`;
}

/* ═══════════════════════════════════════════════════════════════════════
 * `Needs you` — a feed of decisions.
 *
 * ── What it is ───────────────────────────────────────────────────────
 *
 * One item fills the screen: a proposal owed a vote, or an issue nobody has
 * picked up. A swipe (a wheel, an arrow key) snaps to the next, and nothing
 * inside an item scrolls. Everything that acts on the item or says more
 * about it is a button on a RAIL at the right edge — Vote, comments, Ask,
 * Try it, More — and each opens a sheet over the item rather than a page
 * away from it. The shape is the short-video feed's, because its two claims
 * are the ones this screen makes: one thing at a time, and the thing you
 * look at is the whole screen.
 *
 * ── The item, top to bottom ──────────────────────────────────────────
 *
 * A progress line and an eyebrow that says what kind of item this is and
 * where you are ("1 / 59"); the TITLE; the plain-language SUMMARY under it as
 * the sub-hero (`pr_summary_md`, or an issue's own words); the PICTURE, when
 * the checks shot one (see BeforeAfter); and a CAPTION with who, when, and
 * the state chips. The text sits at the top so the picture can take the
 * rest — a proposal with captures is mostly its picture.
 *
 * ── The rail ─────────────────────────────────────────────────────────
 *
 * ONE rail, for the item in view, rather than one per item: the buttons stay
 * where the thumb learned they are while the items move under them. Vote is
 * one control that opens the question — Yes and No live on its sheet, with
 * the tally — because a thumbs-up on a rail reads as "like", and this is not
 * that. More is the card's own ⋯ menu: the same `data-card-menu` hook the
 * Board's cards carry, so `_openCardMenu` finds it and the entries are
 * exactly the card's (Open session, Withdraw, Explore in dev chat, View PR
 * on GitHub…). Try it is the card's Preview affordance under a name that
 * says what it does.
 *
 * ── Sheets on a phone; panels and a popover on a wide window ─────────
 *
 * The same markup, placed by app.css. Below 700px a sheet rises from the
 * floor over a scrim and the tab pill hides under it. Above, Ask and the
 * comments take a PANEL beside the rail and the stage slides over, so the
 * item stays readable while you use them, and Vote is a popover on its own
 * button. `useMediaFlag(WIDE_QUERY)` is that breakpoint in the other language; the keys
 * (↑ ↓ move, V vote, A ask, C comments, T try it, M more) work everywhere
 * and are only LISTED on the wide layout, where a keyboard is likely.
 *
 * ── After a vote ─────────────────────────────────────────────────────
 *
 * Nothing advances on its own. The row leaves the queue on the click
 * (#2031), so the feed PINS a copy of it in place — the eyebrow becomes the
 * confirmation and the Vote button a tick — until you move on; a card that
 * vanished under the press read as a mis-tap. Moving to another item drops
 * the pin, and the scroller re-syncs to the row you are on BY KEY, so a row
 * leaving above you never shifts what you are reading.
 *
 * ── Swipe to vote, on a phone (#3052) ────────────────────────────────
 *
 * Below 700px a proposal card the viewer can vote on also answers to a
 * SIDEWAYS drag: right is Yes, left is No, and a faint "Yes" or "No" fades
 * in as the card travels. Short of the threshold it snaps back and nothing
 * is sent; past it the card waits at the line while `answer()` runs, which
 * is the Vote sheet's own path: castVote asks a No for its line, and a
 * dismissed prompt casts nothing. The axis is picked once per press
 * (./swipe-vote.ts), so an upward drag still pages, a tap is still a tap,
 * and the wide layout never sees any of it. The Vote sheet's buttons stay
 * the way to vote without a gesture.
 *
 * ── The end card (#2172) ─────────────────────────────────────────────
 *
 * One card PAST the last item, always: the swipe that would have hit the
 * end of the scroller lands on a summary instead — how many decisions this
 * pass answered, how many were passed over and are still waiting above,
 * and the way back to the lander. It is one more snap point in the same
 * scroller, not a footer, so on a phone it arrives the way every item did.
 * With nothing in the queue it is the whole screen, which is what the
 * empty state already was. The counter and the progress line count only
 * the decisions ("3 / 7"); the end card is where you are once they are
 * behind you. `?shot=needs-end` opens on it, for the declared check.
 *
 * ── Two rules kept from the deck this replaces ───────────────────────
 *
 * The ask thread loads in an EFFECT, never in render — a first paint that
 * differs from the shipped markup is a hydration mismatch, a console error
 * and a failed check — and the composer is written once (`sendBtn`) so its
 * two homes cannot drift. Every item stays in the DOM, so the legacy comment
 * filler (`_wireFeedComments`) can find its hosts.
 * ═══════════════════════════════════════════════════════════════════════ */

type QueueRow = Extract<DevWorkshopView['queue'][number], { t: 'card' }>;
type SheetKind = 'vote' | 'description' | 'ask' | 'comments';
type Side = 'before' | 'after';

/** One turn in the ask box. `pending` is the answer still being written. */
type AskMsg = { who: 'you' | 'ai'; text: string; pending?: boolean; failed?: boolean };

/**
 * The classes for one turn. Complete literals, never assembled from parts:
 * Tailwind's extractor is a regex over source text, and `dev-ws-ask-*` is
 * hand-written CSS whose rules an editor greps for the same way.
 */
function askMsgClass(m: AskMsg): string {
  if (m.who === 'you') return 'dev-ws-ask-msg dev-ws-ask-you';
  if (m.pending) return 'dev-ws-ask-msg dev-ws-ask-ai dev-ws-ask-pending';
  if (m.failed) return 'dev-ws-ask-msg dev-ws-ask-ai dev-ws-ask-failed';
  return 'dev-ws-ask-msg dev-ws-ask-ai';
}

/**
 * A fact's tone, twice: as a chip on the Description sheet and as one word
 * of the card's facts line. Complete literals, as above.
 */
function chipTone(tone: string | undefined): string {
  switch (tone) {
    case 'ok': return 'dev-ws-chip dev-ws-chip-ok';
    case 'progress': return 'dev-ws-chip dev-ws-chip-progress';
    case 'warn': case 'attention': return 'dev-ws-chip dev-ws-chip-warn';
    case 'blocked': case 'reject': return 'dev-ws-chip dev-ws-chip-blocked';
    case 'info': return 'dev-ws-chip dev-ws-chip-info';
    default: return 'dev-ws-chip';
  }
}
function factTone(tone: string | undefined): string {
  switch (tone) {
    case 'ok': return 'dev-ws-fact dev-ws-fact-ok';
    case 'progress': return 'dev-ws-fact dev-ws-fact-progress';
    case 'warn': case 'attention': return 'dev-ws-fact dev-ws-fact-warn';
    case 'blocked': case 'reject': return 'dev-ws-fact dev-ws-fact-blocked';
    default: return 'dev-ws-fact';
  }
}

/** The key legend for an item of this kind: the keys it answers to. */
function legendFor(kind: QueueRow['kind'] | 'done'): Array<[string[], string]> {
  const keys: Array<[string[], string]> = [[['↑', '↓'], 'move']];
  // The end card answers to the move keys alone.
  if (kind === 'done') return keys;
  if (kind === 'vote') keys.push([['V'], 'vote']);
  keys.push([['D'], 'description'], [['A'], 'ask'], [['C'], 'comments']);
  if (kind === 'vote') keys.push([['T'], 'try it']);
  keys.push([['M'], 'more']);
  return keys;
}

/**
 * The item's facts: how you voted, where the vote stands, what the card's
 * status pill says, and the category or priority when one is set. Four at
 * most. The card sets them as ONE line at its foot (they were a row of
 * chips, two rows on a phone, under a by-line that looked like one more
 * numbered change); the Description sheet has them in full, as chips.
 */
type Fact = { key: string; tone: string | undefined; text: string };
function factsFor(row: QueueRow, voted: string | null): Fact[] {
  const out: Fact[] = [];
  const st = row.card.pill ? row.card.pill.state : null;
  if (row.kind === 'vote' && st) {
    if (voted) out.push({ key: 'voted', tone: 'ok', text: `You voted ${voted}` });
    out.push({ key: 'tally', tone: undefined, text: `${st.yes} of ${st.majority} yes` });
    if (st.label && !/^Vote\b/.test(st.label)) out.push({ key: 'state', tone: st.tone, text: st.label });
  }
  for (const b of row.card.badges) {
    if (b.t === 'attr' && (b.field === 'category' || b.field === 'priority') && b.label.text) {
      out.push({ key: b.key, tone: 'info', text: b.label.text });
    }
  }
  return out.slice(0, 4);
}

/** The line under the vote question: where the vote stands, and what follows. */
function tallyLine(row: QueueRow): string {
  const st = row.card.pill ? row.card.pill.state : null;
  if (!st) return '';
  const said = `${st.yes} of ${st.majority} have said yes so far.`;
  return st.label && !/^Vote\b/.test(st.label) ? `${said} ${st.label}.` : said;
}

/* ── The picture: two stills, cropped to what changed ───────────────── */

type Geo = { w: number; h: number; box: { x: number; y: number; w: number; h: number } | null };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}

function visualSrc(id: string, protectedShots = false): string {
  return protectedShots ? id : `/visuals/${id}`;
}

/**
 * Where the two stills differ, as a box in the image's own pixels.
 *
 * Both sides are drawn at 320px wide and compared pixel for pixel — a small
 * job, and the region it finds is what the item shows near actual size. Null
 * box means "show the whole page": the sides are missing or differently
 * sized, they are identical, or the change covers most of the page (a theme,
 * a redesign), where a crop would frame nothing.
 */
async function diffPair(before: string | null, after: string | null, protectedShots = false): Promise<Geo> {
  const [a, b] = await Promise.all([
    before ? loadImage(visualSrc(before, protectedShots)) : Promise.resolve(null),
    after ? loadImage(visualSrc(after, protectedShots)) : Promise.resolve(null),
  ]);
  const main = b || a;
  if (!main) throw new Error('no still');
  const w = main.naturalWidth;
  const h = main.naturalHeight;
  if (!a || !b || a.naturalWidth !== w || a.naturalHeight !== h || !w || !h) return { w, h, box: null };
  const k = Math.min(1, 320 / w);
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const pixels = (img: HTMLImageElement): Uint8ClampedArray | null => {
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, cw, ch);
    return ctx.getImageData(0, 0, cw, ch).data;
  };
  const pa = pixels(a);
  const pb = pixels(b);
  if (!pa || !pb) return { w, h, box: null };
  let x0 = cw; let y0 = ch; let x1 = -1; let y1 = -1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const p = (y * cw + x) * 4;
      const d = Math.abs(pa[p] - pb[p]) + Math.abs(pa[p + 1] - pb[p + 1]) + Math.abs(pa[p + 2] - pb[p + 2]);
      if (d > 48) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { w, h, box: null };
  const box = { x: x0 / k, y: y0 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k };
  if (box.w * box.h > 0.6 * w * h) return { w, h, box: null };
  return { w, h, box };
}

/**
 * The item's picture: the two stills the checks shot, CROPPED TO THE CHANGE.
 *
 * The captures are 1280×800 desktop stills (capture/capture.js), and at a
 * phone's width a whole page is a third of its size — unreadable, whatever
 * the arrangement. So the region that differs is what fills the box, near
 * actual size, with an outline around it and a Before / After switch inside
 * it; when the change is the whole page the outline goes and the page fits
 * the box instead. "Full page" opens the platform's comparison overlay
 * (`openVisualComparison`), which reads the pair off the button's data-*.
 *
 * The diff runs in an EFFECT, and only for the item in view and its two
 * neighbours (`near`) — never for the fifty behind them.
 */
function BeforeAfter({ v, near, onFull }: {
  v: NonNullable<QueueRow['visuals']>;
  near: boolean;
  onFull: (el: HTMLElement) => void;
}): ReactNode {
  const viewRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<Side>(v.after ? 'after' : 'before');
  const [geo, setGeo] = useState<Geo | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!near || geo || failed) return undefined;
    let live = true;
    diffPair(v.before, v.after, v.protected === true)
      .then((g) => { if (live) setGeo(g); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [near, geo, failed, v.before, v.after, v.protected]);
  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    const measure = () => setView((cur) => (
      cur.w === el.clientWidth && cur.h === el.clientHeight ? cur : { w: el.clientWidth, h: el.clientHeight }
    ));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (failed) return null;
  const id = side === 'after' ? v.after : v.before;
  let style: { width: number; height: number; transform: string } | null = null;
  let spot: { left: number; top: number; width: number; height: number } | null = null;
  let cropped = false;
  if (geo && view.w && view.h) {
    const { w, h, box } = geo;
    if (box) {
      const pad = 24;
      const scale = Math.min(1, view.w / (box.w + pad * 2), view.h / (box.h + pad * 2));
      const sw = w * scale;
      const sh = h * scale;
      // On an axis the still overflows, slide it so the change is centred
      // (clamped to the still's edges); on one it does not, centre the still.
      const tx = sw <= view.w ? (view.w - sw) / 2 : Math.max(view.w - sw, Math.min(0, view.w / 2 - (box.x + box.w / 2) * scale));
      const ty = sh <= view.h ? (view.h - sh) / 2 : Math.max(view.h - sh, Math.min(0, view.h / 2 - (box.y + box.h / 2) * scale));
      style = { width: w, height: h, transform: `translate(${tx}px, ${ty}px) scale(${scale})` };
      spot = { left: box.x * scale + tx, top: box.y * scale + ty, width: box.w * scale, height: box.h * scale };
      cropped = sw > view.w + 1 || sh > view.h + 1;
    } else {
      const scale = Math.min(view.w / w, view.h / h);
      style = { width: w, height: h, transform: `translate(${(view.w - w * scale) / 2}px, ${(view.h - h * scale) / 2}px) scale(${scale})` };
    }
  }
  // The switch and the way out sit in a bar ABOVE the picture, never on it:
  // laid over the still they covered the very corner a change often is.
  return (
    <div className="dev-ws-media" data-ws-media="">
      <div className="dev-ws-media-bar">
        {v.before && v.after ? (
          <div className="dev-ws-seg" role="group" aria-label="Before or after">
            <button type="button" className="dev-ws-seg-btn" aria-pressed={side === 'before'} onClick={() => setSide('before')}>Before</button>
            <button type="button" className="dev-ws-seg-btn" aria-pressed={side === 'after'} onClick={() => setSide('after')}>After</button>
          </div>
        ) : (
          <span className="dev-ws-seg dev-ws-seg-one">{v.after ? 'After' : 'Before'}</span>
        )}
      <button
        type="button"
        className="dev-ws-media-full"
        data-before-png={v.before || undefined}
        data-after-png={v.after || undefined}
        data-before-webm={v.beforeWebm || undefined}
        data-after-webm={v.afterWebm || undefined}
        data-path={v.path}
        data-viewport={v.mobile ? 'mobile' : undefined}
        data-side={side}
        data-shots={v.protected ? 'true' : undefined}
        data-before-url={v.protected ? (v.before || undefined) : undefined}
        data-head-url={v.protected ? (v.after || undefined) : undefined}
        data-claim={v.protected ? (v.claim || v.path) : undefined}
        onClick={(e) => onFull(e.currentTarget)}
      >
        {cropped ? 'Cropped · Full page ↗' : 'Full page ↗'}
      </button>
      </div>
      <div className="dev-ws-media-view" ref={viewRef}>
        {id && style ? (
          <img
            className="dev-ws-media-img"
            src={visualSrc(id, v.protected === true)}
            alt={side === 'after' ? 'After the change' : 'Before the change'}
            style={style}
            draggable={false}
          />
        ) : null}
        {spot ? <span className="dev-ws-media-spot" style={spot} aria-hidden="true" /> : null}
        {geo ? null : <span className="dev-ws-media-wait" aria-hidden="true" />}
      </div>
    </div>
  );
}

type ShotScreen = NonNullable<NonNullable<QueueRow['visuals']>['screens']>[number];
type Box = { x: number; y: number; w: number; h: number };

const isPhoneScreen = (screen: ShotScreen) => /phone|mobile/i.test(screen.viewport);

/**
 * The screen this reader sees: a phone's on a phone, a desktop one on a wide
 * window, whichever the run has when it has only one.
 */
function pickScreen(screens: ShotScreen[], wide: boolean): ShotScreen | null {
  return screens.find((s) => (wide ? !isPhoneScreen(s) : isPhoneScreen(s))) || screens[0] || null;
}

/** A region's rectangle on one side: its box, or a line where it begins. */
function regionRect(region: ShotScreen['regions'][number], side: Side): { box: Box; line: boolean } | null {
  const box = side === 'before' ? region.b : region.a;
  if (box && box.length === 4) return { box: { x: box[0], y: box[1], w: box[2], h: box[3] }, line: false };
  const mark = side === 'before' ? region.bMark : region.aMark;
  if (region.n > 0 && mark && mark.length === 3) return { box: { x: mark[0], y: mark[1], w: mark[2], h: 0 }, line: true };
  return null;
}

/**
 * The item's picture when its before & after run worked out its screens:
 * ONE screen, at the reader's own size, cropped to the areas the run found
 * different and outlined there, numbered as the declared changes are (the
 * proposal's own card draws the same outlines, services/shots-diff.js). The
 * changes it shows are listed under it in a line or two each; the full words
 * are in the Description sheet. Tap the picture, or the switch above it, to
 * flip between after and before.
 *
 * The outlines are drawn in the VIEW's pixels over the scaled still, not
 * inside it, so a line and a number stay crisp at any scale. Nothing loads
 * until the item is in view or next to it (`near`).
 */
function ShotsPicture({ v, near, wide }: {
  v: NonNullable<QueueRow['visuals']>;
  near: boolean;
  wide: boolean;
}): ReactNode {
  const viewRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<Side>('after');
  const [view, setView] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    const measure = () => setView((cur) => (
      cur.w === el.clientWidth && cur.h === el.clientHeight ? cur : { w: el.clientWidth, h: el.clientHeight }
    ));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const screen = pickScreen(v.screens || [], wide);
  if (!screen) return null;
  const W = screen.width;
  const H = Math.max(screen.before.height, screen.after.height);
  // The crop: every outlined area on either side, so a flip never moves it.
  const rects = screen.regions.flatMap((r) => [regionRect(r, 'before'), regionRect(r, 'after')])
    .filter((r): r is { box: Box; line: boolean } => !!r);
  let place: { scale: number; tx: number; ty: number } | null = null;
  if (view.w && view.h) {
    const pad = 16;
    const x0 = rects.length ? Math.max(0, Math.min(...rects.map((r) => r.box.x)) - pad) : 0;
    const y0 = rects.length ? Math.max(0, Math.min(...rects.map((r) => r.box.y)) - pad) : 0;
    const x1 = rects.length ? Math.min(W, Math.max(...rects.map((r) => r.box.x + r.box.w)) + pad) : W;
    const y1 = rects.length ? Math.min(H, Math.max(...rects.map((r) => r.box.y + Math.max(r.box.h, 2))) + pad) : H;
    const box = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    const scale = Math.min(1, view.w / box.w, view.h / box.h);
    const sw = W * scale;
    const sh = H * scale;
    const tx = sw <= view.w ? (view.w - sw) / 2 : Math.max(view.w - sw, Math.min(0, view.w / 2 - (box.x + box.w / 2) * scale));
    const ty = sh <= view.h ? (view.h - sh) / 2 : Math.max(view.h - sh, Math.min(0, view.h / 2 - (box.y + box.h / 2) * scale));
    place = { scale, tx, ty };
  }
  const flip = () => setSide((s) => (s === 'after' ? 'before' : 'after'));
  const shown = new Set(screen.changes);
  const changes = (v.changes || []).filter((c) => shown.has(c.n));
  const sideShot = (which: Side) => {
    const shot = which === 'before' ? screen.before : screen.after;
    return (
      <span
        key={which}
        className={which === 'before' ? 'dev-ws-shot-side dev-ws-shot-before' : 'dev-ws-shot-side dev-ws-shot-after'}
        style={place ? { width: W, height: shot.height, transform: `translate(${place.tx}px, ${place.ty}px) scale(${place.scale})` } : undefined}
      >
        {near && place ? <img src={shot.url} alt={which === 'after' ? 'After the change' : 'Before the change'} draggable={false} /> : null}
      </span>
    );
  };
  const outlines = (which: Side) => (place ? screen.regions.map((r, k) => {
    const rect = regionRect(r, which);
    if (!rect) return null;
    const p = place as { scale: number; tx: number; ty: number };
    const style = {
      left: rect.box.x * p.scale + p.tx,
      top: rect.box.y * p.scale + p.ty,
      width: rect.box.w * p.scale,
      height: rect.line ? 0 : rect.box.h * p.scale,
    };
    const cls = rect.line
      ? (which === 'before' ? 'dev-ws-shot-mark dev-ws-shot-on-before' : 'dev-ws-shot-mark dev-ws-shot-on-after')
      : r.n > 0
        ? (which === 'before' ? 'dev-ws-shot-box dev-ws-shot-on-before' : 'dev-ws-shot-box dev-ws-shot-on-after')
        : (which === 'before' ? 'dev-ws-shot-box dev-ws-shot-box-other dev-ws-shot-on-before' : 'dev-ws-shot-box dev-ws-shot-box-other dev-ws-shot-on-after');
    // The number sits on the outline's corner, pulled back inside the
    // picture when the outline meets its edge, so it is never cut in half.
    const badge = {
      left: Math.max(-9, 2 - style.left),
      top: Math.min(Math.max(-9, 2 - style.top), view.h - 22 - style.top),
    };
    return (
      <span key={`${which}-${k}`} className={cls} style={style} aria-hidden="true">
        {r.n > 0 ? <span className="dev-ws-shot-n" style={badge}>{r.n}</span> : null}
      </span>
    );
  }) : null);
  const size = isPhoneScreen(screen) ? 'Phone' : screen.viewport.charAt(0).toUpperCase() + screen.viewport.slice(1);
  return (
    <div className="dev-ws-media dev-ws-media-shots" data-ws-media="" data-ws-shots="" data-side={side}>
      <div className="dev-ws-media-bar">
        <div className="dev-ws-seg" role="group" aria-label="Before or after">
          <button type="button" className="dev-ws-seg-btn dev-ws-seg-before" aria-pressed={side === 'before'} onClick={() => setSide('before')}>Before</button>
          <button type="button" className="dev-ws-seg-btn dev-ws-seg-after" aria-pressed={side === 'after'} onClick={() => setSide('after')}>After</button>
        </div>
        <span className="dev-ws-media-size">{size}</span>
      </div>
      <div
        className="dev-ws-media-view"
        ref={viewRef}
        role="button"
        tabIndex={0}
        aria-label={side === 'after' ? 'Show before the change' : 'Show after the change'}
        onClick={flip}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } }}
      >
        {sideShot('before')}
        {sideShot('after')}
        {outlines('before')}
        {outlines('after')}
        {near && place ? null : <span className="dev-ws-media-wait" aria-hidden="true" />}
      </div>
      {changes.length ? (
        <ol className="dev-ws-shot-changes">
          {changes.map((c) => (
            <li key={c.n} className="dev-ws-shot-change">
              <span className="dev-ws-shot-n">{c.n}</span>
              <span className="dev-ws-shot-text">{c.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/* ── One item of the feed ────────────────────────────────────────────── */

/**
 * Who and when, for an item: a proposal's author, or an issue's number and
 * who filed it. On the card it sits over the title, where it reads as the
 * author; at the foot, its round avatar looked like one more numbered change
 * beside the picture's. The Description sheet draws the same line.
 */
function ItemBy({ row }: { row: QueueRow }): ReactNode {
  const isVote = row.kind === 'vote';
  return (
    <p className="dev-ws-item-by">
      {row.who ? (
        <span className="dev-ws-item-avatar" style={{ background: swatchFor(row.who) }} aria-hidden="true">
          {row.who.slice(0, 1).toUpperCase()}
        </span>
      ) : null}
      <span>
        {isVote ? (
          <>{row.who ? <b>{row.who}</b> : 'Proposed'}{row.ago ? ` · ${row.who ? 'proposed ' : ''}${row.ago}` : ''}</>
        ) : (
          <>
            {row.number != null ? <b>{`#${row.number}`}</b> : null}
            {row.who ? <>{row.number != null ? ' · filed by ' : 'Filed by '}<b>{row.who}</b></> : null}
            {row.ago ? ` · ${row.ago}` : ''}
          </>
        )}
      </span>
    </p>
  );
}

/**
 * memo(): the feed holds the Ask sheet's draft and its streamed answer, so it
 * renders on every keystroke and every token of an answer, and none of that
 * is any item's business. Every prop is a primitive, a row off the publish,
 * or a callback the feed keeps stable (`openFull`, `onDescribe`), so an item
 * renders again only when something it draws changed.
 */
const FeedItem = memo(function FeedItem({ row, index, count, tint, near, voted, wide, swipe, slug, onFull, onDescribe, railClear }: {
  row: QueueRow;
  index: number;
  count: number;
  /** 'a' or 'b': the row's own, for life (see `tintFor` in NeedsFeed). */
  tint: 'a' | 'b';
  near: boolean;
  voted: string | null;
  wide: boolean;
  /** Takes the sideways swipe to vote (see `useSwipeVote`). */
  swipe: boolean;
  slug: string;
  onFull: (el: HTMLElement) => void;
  /** Opens the Description sheet, which the facts line is a door to. */
  onDescribe: () => void;
  /**
   * On a phone, how far down the item the rail's first button starts (0
   * until measured, and on a wide window, where the rail stands beside the
   * card). Above it the by-line and title take the item's full width.
   */
  railClear: number;
}): ReactNode {
  const isVote = row.kind === 'vote';
  const href = openHref(slug, row.card);
  const title = row.card.title.text || row.card.title.title;
  const facts = factsFor(row, voted);
  const summary = isVote ? row.summary : (row.body || null);
  const pct = Math.max(2, Math.round(((index + 1) / Math.max(1, count)) * 100));
  // A run that worked out its screens IS the summary: the picture takes the
  // paragraph's room, and the words are one tap away in Description.
  const shots = !!(row.visuals && row.visuals.screens && row.visuals.screens.length);
  // THE HEAD TAKES THE FULL WIDTH WHEN IT ENDS ABOVE THE RAIL. The rail sits
  // at the item's foot on a phone, so on most screens the by-line, title and
  // summary are nowhere near it, and keeping its lane free only wrapped them
  // early. Measured laid out wide, before paint, in two steps: the summary
  // too if it ends above the rail ('all'), else the title alone ('title'),
  // else the item keeps the lane (a short screen, a long title).
  const itemRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const [head, setHead] = useState<'all' | 'title' | 'none'>('all');
  useLayoutEffect(() => { setHead('all'); }, [railClear, title, summary, shots]);
  useLayoutEffect(() => {
    if (!railClear || head === 'none') return;
    const item = itemRef.current;
    const last = head === 'all' ? (summaryRef.current || titleRef.current) : titleRef.current;
    if (!item || !last) return;
    if (last.getBoundingClientRect().bottom - item.getBoundingClientRect().top > railClear - 12) {
      setHead(head === 'all' ? 'title' : 'none');
    }
  });
  return (
    <section
      ref={itemRef}
      className="dev-ws-item"
      data-ws-item={row.key}
      data-ws-kind={row.kind}
      data-ws-tint={tint}
      data-ws-swipeable={swipe ? '' : undefined}
      data-ws-head={railClear && head !== 'none' ? head : undefined}
    >
      <div className="dev-ws-item-progress" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
      <div className="dev-ws-item-top">
        {voted ? (
          <span className="dev-ws-item-done" data-ws-item-done="">
            <CheckIcon className="dev-ws-item-tick" aria-hidden="true" />
            {`Voted ${voted} · ${wide ? 'press ↓ or scroll' : 'swipe up'} for the next`}
          </span>
        ) : (
          <span className="dev-ws-eyebrow">{isVote ? 'Proposal · needs your vote' : 'Open issue · nobody on it'}</span>
        )}
        <span className="dev-ws-item-of">{`${index + 1} / ${count}`}</span>
      </div>
      <ItemBy row={row} />
      {/* The title is the headline and the door to the full card: its own
          page, with the checks, the thread and every affordance the card
          has. Same route the Board's rows open. */}
      <h2 className="dev-ws-item-title" ref={titleRef}>{href ? <a href={href}>{title}</a> : title}</h2>
      {shots ? null : summary ? (
        <p className="dev-ws-item-summary" ref={summaryRef}>{summary}</p>
      ) : (
        <p className="dev-ws-item-summary dev-ws-item-nosummary" ref={summaryRef}>
          {isVote ? 'No plain-language summary was written for this change.' : 'This issue has no description.'}
        </p>
      )}
      {shots && row.visuals ? <ShotsPicture v={row.visuals} near={near} wide={wide} />
        : row.visuals ? <BeforeAfter v={row.visuals} near={near} onFull={onFull} />
          : <div className="dev-ws-item-spacer" aria-hidden="true" />}
      <div className="dev-ws-item-caption">
        {facts.length ? (
          <button type="button" className="dev-ws-item-facts" data-ws-facts="" aria-haspopup="dialog" onClick={onDescribe}>
            {facts.map((f) => <span key={f.key} className={factTone(f.tone)}>{f.text}</span>)}
          </button>
        ) : null}
      </div>
      {/* The swipe's two hints, last so the item's reading order is
          untouched. Hidden until a drag fades one in (app.css), and
          aria-hidden: the Vote sheet's buttons are the accessible way. */}
      {swipe ? <span className="dev-ws-swipe-hint dev-ws-swipe-yes" aria-hidden="true">Yes</span> : null}
      {swipe ? <span className="dev-ws-swipe-hint dev-ws-swipe-no" aria-hidden="true">No</span> : null}
    </section>
  );
});

/**
 * The scroll position the end card is keyed under (see `curKeyRef` in
 * NeedsFeed): a row key names an item, and this names the slot after them.
 */
const END_KEY = 'done';

/**
 * `?shot=needs-end`: open the feed ON the end card. The declared check's
 * route, and the only way to a state that otherwise takes a swipe past
 * every item. Read at mount, guarded for the vm the tests render in.
 */
function wantsEnd(): boolean {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return false;
  try { return new URLSearchParams(window.location.search).get('shot') === 'needs-end'; } catch { return false; }
}

/** "3 proposals", "1 proposal": a count with its noun. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The end of the feed: one card past the last item, and the only place a
 * total appears.
 *
 * `acted` is what this pass answered, `left` what it passed over (still in
 * the feed, above), and `leftVotes` the proposals among those, so the ring
 * can say where the viewer stands against `total` — everything they could
 * vote on, answered or not. The headline is one of three: the pass had
 * things in it and answered them all, it left some waiting, or there was
 * nothing to begin with.
 */
function DoneItem({ total, acted, left, leftVotes, onDone, onBack }: {
  total: number;
  acted: number;
  left: number;
  leftVotes: number;
  onDone: () => void;
  onBack: () => void;
}): ReactNode {
  const done = Math.max(0, Math.min(total, total - leftVotes));
  const line = left > 0 ? 'That’s it for now.' : (acted > 0 ? 'That’s it!' : 'You’re all caught up.');
  const parts: string[] = [];
  if (acted > 0) parts.push(`You voted on ${plural(acted, 'proposal', 'proposals')} this time.`);
  if (left > 0) parts.push(`${left} ${left === 1 ? 'is' : 'are'} still waiting on you above.`);
  else if (acted > 0) parts.push('Nothing else needs you right now.');
  else parts.push('Every proposal you can vote on has your answer, and every open issue has somebody on it.');
  return (
    <section
      className="dev-ws-item dev-ws-needs-done"
      data-ws-item={END_KEY}
      data-ws-kind="done"
      data-ws-done-acted={acted}
      data-ws-done-left={left}
    >
      {total ? (
        <ProgressRing
          className="dev-ws-done-ring"
          pct={Math.round((done / total) * 100)}
          label={`${done}/${total}`}
          title={done === total ? `All ${total} open proposals voted on` : `${done} of ${total} open proposals voted on`}
          arcClassName={done === total ? 'stroke-emerald-500' : undefined}
        />
      ) : null}
      <p className="dev-ws-needs-done-line">{line}</p>
      <p className="dev-ws-needs-done-sub">{parts.join(' ')}</p>
      <button type="button" className="dev-ws-done-cta" onClick={onDone}>See what changed this week</button>
      {left > 0 ? (
        <button type="button" className="dev-ws-done-back" data-ws-done-back="" onClick={onBack}>
          Back to the first one waiting
        </button>
      ) : null}
    </section>
  );
}

/* ── Swipe to vote (#3052) ───────────────────────────────────────────── */

/**
 * Which rows take the swipe: a proposal whose Yes and No both cast a vote.
 * A governance item carries no pair here and an issue's "Let's take it" is
 * not a vote, so neither is swiped. NeedsFeed narrows it further to the
 * phone layout and to a card not already answered.
 */
function canSwipeVote(row: QueueRow): boolean {
  return row.kind === 'vote' && !!(row.yes && row.yes.act) && !!(row.no && row.no.act);
}

/**
 * What the gesture asks of the feed, read at the moment of asking, so the
 * listeners below never close over a stale row. `can` is asked on the press;
 * `commit` once the drag has crossed the line, and it calls `settled` when
 * the card may go back to rest (the vote is on its way, or it was not cast).
 */
interface SwipeVoteHandle {
  can: (key: string) => boolean;
  commit: (key: string, which: SwipeSide, settled: () => void) => void;
}

/** The spring back's length in app.css, and a little over. */
const SWIPE_REST_MS = 320;

/**
 * The kit's gesture arbiter, through PlatformUI (`gestures()`): one owner per
 * finger, shared with the kit's own recognizers, the Dev scroller's
 * pull-to-refresh among them. Null where the kit is not loaded.
 */
type GestureArbiter = { claim: (seq: string | number, token: unknown) => boolean };
function gestureArbiter(): GestureArbiter | null {
  const ui = (typeof window !== 'undefined' ? window.PlatformUI : undefined) as
    { gestures?: () => GestureArbiter | null } | undefined;
  try {
    const g = ui && typeof ui.gestures === 'function' ? ui.gestures() : null;
    return g && typeof g.claim === 'function' ? g : null;
  } catch {
    return null;
  }
}
const SWIPE_VOTE_TOKEN = 'workshop-swipe-vote';

/**
 * The sideways drag on a Needs-you card, as native pointer listeners on the
 * feed's scroller.
 *
 * VERTICAL STAYS THE BROWSER'S. The card says `touch-action: pan-y`
 * (app.css), so a drag that starts upward is still the scroller's snap
 * paging, which takes the touch with a `pointercancel`, and one that starts
 * sideways is left to this. A press decides once, at `SWIPE_LOCK_PX`
 * (./swipe-vote.ts): until then it is still a tap, and a `y` verdict lets go
 * of it for good. A mouse drag on a narrow window goes the same way; the
 * wide layout binds nothing.
 *
 * THE CARD MOVES BY CUSTOM PROPERTIES, not by state: a render per pointer
 * move would re-render the feed, and `FeedItem` is memo()'d to avoid exactly
 * that. `data-ws-swiping` is up while the finger is down (no transition, no
 * text selection); `data-ws-swipe` says which hint is showing; both are
 * taken off once the card is back at rest, so a card nobody touched carries
 * no transform. How far it moves, and whether it moves at all where motion
 * is unwelcome, is app.css's decision.
 *
 * PAST THE LINE the card waits there, its hint at full strength, until
 * `commit` settles. For a No that is the whole of the "What's not working
 * for you?" prompt, so the reader can see what they are giving a reason
 * for, and a cancel springs it back with nothing sent. A sideways drag
 * never also clicks what it started on: the one click it would produce with
 * a mouse is swallowed.
 */
function useSwipeVote(
  scrollRef: { current: HTMLElement | null },
  enabled: boolean,
  handleRef: { current: SwipeVoteHandle },
) {
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!enabled || !scroller || typeof window === 'undefined') return undefined;
    let drag: {
      id: number; el: HTMLElement; key: string;
      x0: number; y0: number; width: number; axis: SwipeAxis | null;
    } | null = null;
    // The card waiting at the line while its vote is asked for.
    let held: HTMLElement | null = null;
    let swallow = false;
    let restTimer = 0;
    let resting: HTMLElement | null = null;

    const paint = (el: HTMLElement, x: number, p: number, side: SwipeSide | null) => {
      el.style.setProperty('--ws-swipe-x', `${Math.round(x)}px`);
      el.style.setProperty('--ws-swipe-p', p.toFixed(3));
      if (side) el.setAttribute('data-ws-swipe', side);
    };
    const clear = (el: HTMLElement) => {
      el.removeAttribute('data-ws-swiping');
      el.removeAttribute('data-ws-swipe');
      el.style.removeProperty('--ws-swipe-x');
      el.style.removeProperty('--ws-swipe-p');
    };
    // Cut a spring back short: the card about to move again keeps its
    // properties, any other is cleaned at once.
    const stopResting = (keep: HTMLElement | null) => {
      window.clearTimeout(restTimer);
      if (resting && resting !== keep) clear(resting);
      resting = null;
    };
    // Back to rest: to zero first, so app.css's transition runs, then clean.
    const rest = (el: HTMLElement) => {
      stopResting(el);
      el.removeAttribute('data-ws-swiping');
      paint(el, 0, 0, null);
      resting = el;
      restTimer = window.setTimeout(() => {
        if (resting === el) clear(el);
        resting = null;
      }, SWIPE_REST_MS);
    };

    const onDown = (e: PointerEvent) => {
      if (held || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      // A new primary press means the last one is over, whether or not its
      // end reached this scroller (a mouse let go outside it, before a lock).
      if (drag) {
        if (drag.axis === 'x') rest(drag.el);
        drag = null;
      }
      const t = e.target as Element | null;
      const el = t && typeof t.closest === 'function' ? t.closest<HTMLElement>('[data-ws-swipeable]') : null;
      if (!el || !scroller.contains(el)) return;
      const key = el.getAttribute('data-ws-item') || '';
      if (!handleRef.current.can(key)) return;
      drag = { id: e.pointerId, el, key, x0: e.clientX, y0: e.clientY, width: el.clientWidth, axis: null };
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x0;
      if (!drag.axis) {
        const axis = swipeAxis(dx, e.clientY - drag.y0);
        if (!axis) return;
        // Upward or downward: the feed's own gesture. Let go of this press.
        if (axis === 'y') { drag = null; return; }
        // Sideways: claim the finger at the lock, as the kit asks of an app
        // gesture, and back off if a kit recognizer already has it. The
        // arbiter lets go by itself on pointerup and pointercancel.
        const g = gestureArbiter();
        if (g && !g.claim(e.pointerType === 'touch' ? 'touch' : e.pointerId, SWIPE_VOTE_TOKEN)) { drag = null; return; }
        drag.axis = axis;
        stopResting(drag.el);
        drag.el.setAttribute('data-ws-swiping', '');
        try { drag.el.setPointerCapture(e.pointerId); } catch { /* still tracked while over the card */ }
        // A mouse drag that began on text had started a selection.
        const sel = window.getSelection ? window.getSelection() : null;
        if (sel && !sel.isCollapsed) sel.removeAllRanges();
      }
      paint(drag.el, dx, swipeProgress(dx, drag.width), swipeSide(dx));
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { el, key, width, axis } = drag;
      const dx = e.clientX - drag.x0;
      drag = null;
      if (axis !== 'x') return;
      swallow = true;
      window.setTimeout(() => { swallow = false; }, 0);
      const which = swipeVerdict(dx, width);
      if (!which) { rest(el); return; }
      held = el;
      el.removeAttribute('data-ws-swiping');
      paint(el, which === 'yes' ? commitDistance(width) : -commitDistance(width), 1, which);
      let done = false;
      handleRef.current.commit(key, which, () => {
        if (done) return;
        done = true;
        if (held === el) held = null;
        rest(el);
      });
    };
    const onCancel = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { el, axis } = drag;
      drag = null;
      if (axis === 'x') rest(el);
    };
    const onClick = (e: MouseEvent) => {
      if (!swallow) return;
      swallow = false;
      e.preventDefault();
      e.stopPropagation();
    };
    // A mouse drag that began on the title's link or the picture would
    // otherwise start the browser's own drag and cancel this one.
    const onDragStart = (e: DragEvent) => { if (drag) e.preventDefault(); };

    scroller.addEventListener('pointerdown', onDown);
    scroller.addEventListener('pointermove', onMove);
    scroller.addEventListener('pointerup', onUp);
    scroller.addEventListener('pointercancel', onCancel);
    scroller.addEventListener('click', onClick, true);
    scroller.addEventListener('dragstart', onDragStart);
    return () => {
      scroller.removeEventListener('pointerdown', onDown);
      scroller.removeEventListener('pointermove', onMove);
      scroller.removeEventListener('pointerup', onUp);
      scroller.removeEventListener('pointercancel', onCancel);
      scroller.removeEventListener('click', onClick, true);
      scroller.removeEventListener('dragstart', onDragStart);
      stopResting(null);
      scroller.querySelectorAll<HTMLElement>('[data-ws-swipe], [data-ws-swiping]').forEach(clear);
      drag = null;
      held = null;
    };
  }, [enabled, scrollRef, handleRef]);
}

/* ── The feed ────────────────────────────────────────────────────────── */

function NeedsFeed({ rows, total, models, slug, canPost, onDone }: {
  rows: DevWorkshopView['queue'];
  total: number;
  models: DevWorkshopView['models'];
  slug: string;
  canPost: boolean;
  onDone: () => void;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the route asked to open on the end card. Read once, at mount:
  // the URL does not change for the life of the feed, and a state seed is
  // the one place a render-time read of it is evaluated once.
  const [endOnOpen] = useState(wantsEnd);
  // Which slot is in view: an item's index, or `n` for the end card. The
  // `?shot=needs-end` route opens on the end card, so the seed is the count
  // of rows the publish already holds (the re-sync below corrects it by key
  // when rows land later).
  const [at, setAt] = useState(() => (endOnOpen ? rows.filter((r) => r.t === 'card').length : 0));
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  // The sheet on its way out. It stays mounted, marked `data-ws-leaving`,
  // for as long as app.css's leave animation runs, then is dropped.
  const [leaving, setLeaving] = useState<SheetKind | null>(null);
  // Whether the on-screen keyboard is up. The kit measures it and app.css
  // lifts the sheet's floor by `--un-kb-inset` on its own; this is only the
  // flag `[data-ws-kb]` needs to give the card the short sheet's full height.
  const [kbUp, setKbUp] = useState(false);
  // Answered here, this session: the pinned row's confirmation.
  const [answered, setAnswered] = useState<Record<string, string>>({});
  // QA 2026-09-24 Q3: votes on their way, by row. Set when castVote commits
  // to sending (the line is in hand), cleared when the server answers. The
  // ref is the re-entry guard, read synchronously by a second press; the
  // state is what the rail button draws from.
  const [sending, setSending] = useState<Record<string, string>>({});
  const sendingRef = useRef<Set<string>>(new Set());
  // The pins, keyed by row, with the index each held when it was answered.
  // A ref with a version counter rather than state, because a pin is set in
  // the same breath as the vote and read back in the very next publish.
  const pinsRef = useRef<Map<string, { row: QueueRow; index: number }>>(new Map());
  const [pinsVersion, setPinsVersion] = useState(0);
  // Which row the reader is ON, by key — the thing the list is re-synced to
  // when rows leave or arrive above it. `END_KEY` is the end card, the slot
  // after every row, and it is the seed when the route asked for it.
  const curKeyRef = useRef<string | null>(endOnOpen ? END_KEY : null);
  // Still owed the instant scroll to the end card (the effect below): true
  // until the scroller has a height to scroll by.
  const endScrollRef = useRef<boolean>(endOnOpen);
  const moreRef = useRef<HTMLButtonElement>(null);
  const commentsRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const wide = useMediaFlag(WIDE_QUERY);
  // How far down an item the rail starts, on a phone (see FeedItem's head).
  const [railClear, setRailClear] = useState(0);

  // Keyed by row, so moving to the next proposal does not carry the last
  // one's conversation with it.
  const [threads, setThreads] = useState<Record<string, AskMsg[]>>({});
  const [draft, setDraft] = useState('');
  // Which row has a question in flight. Keyed like the threads rather than a
  // bare boolean: the feed still moves while an answer is coming, and an
  // answer that lands after you have moved on belongs to the row it was
  // asked about.
  const [asking, setAsking] = useState<Record<string, boolean>>({});
  // Which rows have had their stored thread fetched. Marked BEFORE the
  // request goes out, so moving away and back does not fire a second one.
  // A REF, NOT STATE: as state it would be a dependency of the effect that
  // writes it, and the effect would tear itself down on every write.
  const loadedRef = useRef<Set<string>>(new Set());
  // Which model answers. The dev session's own list and its own default —
  // see `_workshopModels`.
  const [model, setModel] = useState<string>(() => models.selected || '');

  const items = useMemo<QueueRow[]>(() => {
    const live = rows.filter((r): r is QueueRow => r.t === 'card');
    const have = new Set(live.map((r) => r.key));
    const out = live.slice();
    for (const [key, pin] of pinsRef.current) {
      if (!have.has(key)) out.splice(Math.min(pin.index, out.length), 0, pin.row);
    }
    return out;
  }, [rows, pinsVersion]);
  const n = items.length;
  // `n + 1` slots: the items, then the end card (#2172). `i === n` is the
  // end card, and `row` is null there.
  const i = Math.min(at, n);
  const row = i < n ? items[i] : null;
  // What the pass amounts to, for the end card: answered here this session
  // (the pinned rows), and passed over (still in the feed, unanswered).
  const acted = items.filter((r) => !!answered[r.key]).length;
  const left = n - acted;
  const leftVotes = items.filter((r) => r.kind === 'vote' && !answered[r.key]).length;
  /**
   * Each row's tint, decided the first time it is seen and kept for life.
   * The tints alternate so a swipe reads as a new item, and a row seen for
   * the first time takes the opposite of the row before it, so a list seen
   * whole alternates perfectly and a row that arrives later still differs
   * from its neighbour above. Keyed on the index of the moment instead, a
   * row leaving above the one in view would flip every tint after it, and
   * the card in front of the reader would change colour for nothing.
   */
  const tintRef = useRef<Map<string, 'a' | 'b'>>(new Map());
  const tints = useMemo<Array<'a' | 'b'>>(() => {
    const seen = tintRef.current;
    const out: Array<'a' | 'b'> = [];
    let prev: 'a' | 'b' | null = null;
    for (const r of items) {
      let tint = seen.get(r.key);
      if (!tint) { tint = prev === 'a' ? 'b' : 'a'; seen.set(r.key, tint); }
      out.push(tint);
      prev = tint;
    }
    return out;
  }, [items]);
  const voted = row ? answered[row.key] || null : null;

  /**
   * Stay on the row you were on when the list changes under you.
   *
   * A layout effect, so the scroll position is corrected in the same frame
   * the rows shift: a row leaving ABOVE the current one would otherwise slide
   * the next row into view for a paint. By key, because indexes are what the
   * change moves.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const key = curKeyRef.current;
    if (key) {
      const idx = key === END_KEY ? items.length : items.findIndex((r) => r.key === key);
      if (idx >= 0) {
        if (idx !== at) {
          setAt(idx);
          // INSTANTLY. The scroller has `scroll-behavior: smooth`, which
          // applies to this assignment too, so the correction would ANIMATE
          // from where the shifted rows left the view to where the row is —
          // a card sliding through for a third of a second, which is the
          // "reset" a viewer saw. Off for the one assignment, then back.
          if (el && el.clientHeight) {
            el.style.scrollBehavior = 'auto';
            el.scrollTop = idx * el.clientHeight;
            el.style.scrollBehavior = '';
          }
        }
        return;
      }
    }
    // The end card is a place to BE only once there are rows to be past:
    // with none, the key stays unset, so the first rows to land are what the
    // reader opens on rather than the card after them.
    const clamped = Math.min(at, items.length);
    curKeyRef.current = items[clamped] ? items[clamped].key : null;
    if (clamped !== at) setAt(clamped);
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The `?shot=needs-end` open: the seed put `at` on the end card, and this
   * puts the scroller there in the same frame, instantly (see the re-sync
   * above for why not smoothly). Once — but on the first publish that finds
   * the scroller laid out, not necessarily the first render, because a
   * scroller with no height yet has nothing to scroll by. After that, rows
   * landing later are the re-sync's job, which follows `END_KEY` to wherever
   * the end moves.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!endScrollRef.current || !el || !el.clientHeight) return;
    endScrollRef.current = false;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = items.length * el.clientHeight;
    el.style.scrollBehavior = '';
  }, [items]);

  const landOn = (idx: number) => {
    const c = Math.min(Math.max(idx, 0), items.length);
    curKeyRef.current = items[c] ? items[c].key : (items.length ? END_KEY : null);
    setAt(c);
    // A sheet stays with its item: arriving on the end card closes it, so
    // the way back up shows the card and not a panel about the row above.
    if (c >= items.length && sheet) { setLeaving(null); setSheet(null); }
  };
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || !el.clientHeight) return;
    const idx = Math.round(el.scrollTop / el.clientHeight);
    if (idx !== at) landOn(idx);
  };
  /**
   * Moving through the feed by a press rather than a swipe. No wrap: the
   * ends are the ends, and the counter says which one you are at.
   */
  const go = (delta: number) => {
    const el = scrollRef.current;
    const idx = Math.min(Math.max(i + delta, 0), n);
    if (idx === i) return;
    if (el && el.clientHeight) el.scrollTo({ top: idx * el.clientHeight, behavior: 'smooth' });
    landOn(idx);
  };

  const closeSheet = () => {
    if (!sheet) return;
    setLeaving(sheet);
    setSheet(null);
  };
  const toggleSheet = (kind: SheetKind) => {
    if (sheet === kind) { closeSheet(); return; }
    setLeaving(null);
    setSheet(kind);
  };
  // The leave animation's length, then the sheet is gone. Nothing to wait
  // for where motion is unwelcome — app.css runs no animation there.
  useEffect(() => {
    if (!leaving) return undefined;
    const still = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = window.setTimeout(() => setLeaving(null), still ? 0 : 220);
    return () => window.clearTimeout(t);
  }, [leaving]);
  // THE KEYBOARD. A fixed sheet is laid out against the layout viewport, which
  // the on-screen keyboard does not shrink — so on a phone the card's floor,
  // and the field on it, sat under the keys. app.css lifts that floor by
  // `--un-kb-inset`, and the kit maintains it from ONE visualViewport tracker
  // for the whole page.
  //
  // This screen used to measure the viewport itself, which is how it ended up
  // with its own `innerHeight - vv.height - vv.offsetTop` — the expression
  // #1938 proved wrong on iOS, where `innerHeight` collapses to the visual
  // viewport and the result goes negative. `Math.max(0, …)` turned that into a
  // confident zero, so the sheet simply never lifted on an iPhone and nothing
  // looked broken enough to notice. Reading the kit's number is what stops a
  // fourth copy of that arithmetic drifting out of step with the other three.
  //
  // What is left is the part CSS cannot do: the sheet got shorter, so the
  // field inside it has to be scrolled back into view. `un-kb` lands on <html>
  // from the kit's own rAF, so this observes the class rather than racing it
  // through a second viewport listener. Only while a sheet is up, and only
  // below the breakpoint: a panel on a wide window is not fixed at all.
  useEffect(() => {
    if (!sheet || wide || typeof document === 'undefined') return undefined;
    const docEl = document.documentElement;
    const sync = () => {
      const up = docEl.classList.contains('un-kb');
      setKbUp((cur) => (cur === up ? cur : up));
      if (!up) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && active.closest('.dev-ws-sheet-modal')) active.scrollIntoView({ block: 'nearest' });
    };
    const observer = new MutationObserver(sync);
    observer.observe(docEl, { attributes: true, attributeFilter: ['class'] });
    sync();
    return () => {
      observer.disconnect();
      setKbUp(false);
    };
  }, [sheet, wide]);

  /**
   * Answering the item: a vote, or taking an issue. The row is pinned BEFORE
   * the act, because the act's publish removes it from the queue, and the
   * pin is what keeps it on screen with its confirmation.
   *
   * QA 2026-09-24 Q3: THE CONFIRMATION WAITS FOR THE SERVER. The card used
   * to be marked answered here, before `castVote` had even asked for a No's
   * line, so cancelling "What's not working for you?" left "Voted no · press
   * ↓ for the next" on a card nothing had been sent for, and a reload put it
   * back. `castVote` resolves true only once the server has the vote: until
   * then the rail says it is sending, a cancel leaves the card exactly as it
   * was (and drops a pin this press added), and a refusal or a network
   * failure is reported by `castVote`'s own toast.
   *
   * `settled` is the swipe's (#3052): called once the vote is on its way or
   * was not cast, whichever comes first, so a card held at the line goes
   * back as soon as the prompt closes. The swipe only reaches a vote row
   * with both acts and none in flight (`swipeHandle` checks), which is the
   * one path below that calls it.
   */
  const answer = (which: 'yes' | 'no', settled?: () => void) => {
    if (!row) return;
    const spec = which === 'yes' ? row.yes : row.no;
    if (!spec) return;
    if (row.kind !== 'vote' || !spec.act) {
      closeSheet();
      if (spec.act) callAppView(spec.act.fn, ...(spec.act.args as unknown[]));
      return;
    }
    const key = row.key;
    if (sendingRef.current.has(key)) return;
    sendingRef.current.add(key);
    // PINNED FOR THE SESSION, not until the next move. The vote makes the
    // row leave `rows` (it is no longer owed), and the pin keeps it in its
    // slot, so nothing under the viewer shifts: a row leaving ABOVE the
    // one in view moves every index after it, and with it the counter,
    // and the scroll position has to be corrected under the reader. The
    // pins used to go once the next card had settled, which was exactly
    // when that correction was most visible — the card you had just
    // arrived on re-numbered and slid.
    const pinnedHere = !pinsRef.current.has(row.key);
    if (pinnedHere) {
      pinsRef.current.set(row.key, { row, index: at });
      setPinsVersion((v) => v + 1);
    }
    closeSheet();
    // castVote(sessionId, vote, expectedEpoch, opts): the model leaves the
    // epoch out when the row has none, so the slots are padded to put the
    // options bag fourth (VoteButton's VOTE_ARITY does the same).
    const args = [...(spec.act.args as unknown[])];
    while (args.length < 3) args.push(null);
    const onSend = () => {
      setSending((cur) => ({ ...cur, [key]: which }));
      if (settled) settled();
    };
    Promise.resolve(callAppView(spec.act.fn, ...args, { onSend }))
      .catch(() => false)
      .then((ok) => {
        sendingRef.current.delete(key);
        setSending((cur) => {
          if (!(key in cur)) return cur;
          const next = { ...cur };
          delete next[key];
          return next;
        });
        if (ok === true) {
          setAnswered((cur) => ({ ...cur, [key]: which }));
        } else if (pinnedHere) {
          pinsRef.current.delete(key);
          setPinsVersion((v) => v + 1);
        }
        if (settled) settled();
      });
  };
  /**
   * The swipe's way in (#3052): the card in view, when it is one the viewer
   * can vote on and has not answered here, with no vote of its own already
   * on the way. A commit that finds that no longer true (the feed moved, a
   * press got there first) lets the card go rather than leaving it held.
   */
  const swipeOk = (key: string) => !!(row && row.key === key && canSwipeVote(row)
    && !answered[key] && !sendingRef.current.has(key));
  const swipeHandle = useRef<SwipeVoteHandle>({ can: () => false, commit: (_k, _w, settled) => settled() });
  useLayoutEffect(() => {
    swipeHandle.current = {
      can: swipeOk,
      commit: (key, which, settled) => {
        if (!swipeOk(key)) { settled(); return; }
        answer(which, settled);
      },
    };
  });
  useSwipeVote(scrollRef, !wide, swipeHandle);

  /**
   * Where the rail starts, measured down from the top of the item in view:
   * the items fill the scroller, so the scroller's top is theirs. Again when
   * the rail changes (an issue has no Try it) or anything resizes. Nothing on
   * a wide window, where the rail stands beside the card.
   */
  useLayoutEffect(() => {
    const rail = railRef.current;
    const sc = scrollRef.current;
    if (wide || !rail || !sc || typeof ResizeObserver !== 'function') {
      setRailClear(0);
      return undefined;
    }
    const measure = () => {
      const v = Math.round(rail.getBoundingClientRect().top - sc.getBoundingClientRect().top);
      setRailClear((cur) => (cur === v ? cur : Math.max(0, v)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(rail);
    ro.observe(sc);
    return () => ro.disconnect();
  }, [wide, row ? row.key : null, row ? row.kind : null]); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = row ? (row.card.rail.preview || row.card.actionPreview || null) : null;
  const canTry = !!(preview && preview.state === 'live');
  const tryIt = () => {
    if (preview && preview.state === 'live') callAppView('swapToStagingForSession', preview.sessionId, preview.url);
  };
  // The facts line on a card opens the Description sheet. Stable, like
  // openFull below, so handing it to the memo()'d items costs no render.
  const describe = useCallback(() => {
    setLeaving(null);
    setSheet('description');
  }, []);
  // Stable, so the memo()'d items it is handed to skip a render of the feed.
  const openFull = useCallback((el: HTMLElement) => callAppView(
    el.dataset.shots === 'true' ? 'openShotsComparison' : 'openVisualComparison',
    el,
  ), []);
  const menuKey = row ? row.card.rail.menuKey : undefined;
  // The card's own page, offered under More as "Open card": here the item IS
  // the screen, so there is no card face to tap for it (app-view.js's
  // _toggleCardMenu reads it off the trigger).
  const cardHref = row ? openHref(slug, row.card) : null;
  // What is rendered: the open sheet, or the one still leaving. Never on
  // the end card, which has no item for a sheet to be about.
  const shown = row ? (sheet || leaving) : null;
  // `inert` too: a sheet on its way out takes no focus, and app.css lets taps
  // through it, so the next tap lands on what it is uncovering.
  const leavingAttr = !sheet && leaving ? { 'data-ws-leaving': '', inert: true } : {};
  const commentCount = row ? (row.card.chatCount || 0) : 0;
  const descFacts = row ? factsFor(row, voted) : [];
  const descChanges = row && row.visuals && row.visuals.changes ? row.visuals.changes : [];

  /**
   * The keys. Every one is also a button on the rail, so nothing is ONLY a
   * key; they are listed on the wide layout, where a keyboard is likely.
   * Ignored while a field has focus — typing "v" in the ask box is typing.
   * No dependency list on purpose: the handler closes over this render's
   * state, and re-binding is cheaper than a stale row.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (k === 'Escape') { if (sheet) { closeSheet(); e.preventDefault(); } return; }
      if (k === 'ArrowDown' || k === 'j' || k === 'J') { go(1); e.preventDefault(); return; }
      if (k === 'ArrowUp' || k === 'k' || k === 'K') { go(-1); e.preventDefault(); return; }
      if (!row) return;
      if ((k === 'v' || k === 'V') && row.kind === 'vote') { toggleSheet('vote'); return; }
      if ((k === 'y' || k === 'Y') && sheet === 'vote') { answer('yes'); return; }
      if ((k === 'n' || k === 'N') && sheet === 'vote') { answer('no'); return; }
      if (k === 'd' || k === 'D') { toggleSheet('description'); return; }
      if (k === 'a' || k === 'A') { toggleSheet('ask'); return; }
      if (k === 'c' || k === 'C') { toggleSheet('comments'); return; }
      if ((k === 't' || k === 'T') && canTry) { tryIt(); return; }
      if ((k === 'm' || k === 'M') && moreRef.current) moreRef.current.click();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // The comments sheet's GitHub thread is filled by the legacy observer, so
  // it is pointed at the sheet each time one opens.
  useLayoutEffect(() => {
    if (sheet !== 'comments') return;
    const host = commentsRef.current;
    if (host) callAppView('_wireFeedComments', host);
  }, [sheet, row ? row.key : null]); // eslint-disable-line react-hooks/exhaustive-deps

  const target = row ? row.askAbout || null : null;
  const thread = row ? threads[row.key] || [] : [];
  const engaged = thread.length > 0;
  const inFlight = !!(row && asking[row.key]);

  /**
   * Bring back what this viewer already asked about this item. In an effect
   * and never in render — the shell's rule for a stateful island. It never
   * overwrites a thread that already has turns in it.
   */
  useEffect(() => {
    if (!row || sheet !== 'ask' || !target || loadedRef.current.has(row.key)) return undefined;
    const key = row.key;
    const { kind, ref } = target;
    let live = true;
    loadedRef.current.add(key);
    const qs = `kind=${encodeURIComponent(kind)}&ref=${encodeURIComponent(String(ref))}`;
    fetch(`/api/apps/${encodeURIComponent(slug)}/workshop/ask/thread?${qs}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!live || !data || !Array.isArray(data.messages) || !data.messages.length) return;
        setThreads((cur) => {
          if (cur[key] && cur[key].length) return cur;
          return {
            ...cur,
            [key]: data.messages.map((m: { who?: string; text?: string }) => ({
              who: m.who === 'ai' ? 'ai' as const : 'you' as const,
              text: String(m.text || ''),
            })),
          };
        });
      })
      // A thread that will not load is a pane with no history in it, which
      // is the state it opens in anyway.
      .catch(() => {});
    return () => { live = false; };
    // PRIMITIVES ONLY: `target` is an object off the view model, and a
    // republish that rebuilds it would otherwise tear the effect down.
  }, [slug, sheet, row ? row.key : null, target ? target.kind : null, target ? target.ref : null]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Send one question and write the answer in under it. THE ROW IS CAPTURED,
   * not read back at resolve time: the feed keeps moving while an answer is
   * on its way, and an answer about item A appended to item B's thread is
   * worse than no answer at all.
   */
  const ask = async () => {
    const q = draft.trim();
    if (!row || !q || !target || inFlight) return;
    const key = row.key;
    const sending = row;
    const prior = threads[key] || [];
    setThreads((cur) => ({
      ...cur,
      [key]: [...prior, { who: 'you', text: q }, { who: 'ai', text: 'Reading the change…', pending: true }],
    }));
    setAsking((cur) => ({ ...cur, [key]: true }));
    setDraft('');

    // Writes the trailing bubble in place: the LAST one on this row's
    // thread, and only while it is still pending.
    const writeTail = (patch: AskMsg) => setThreads((cur) => {
      const t = cur[key];
      if (!t || !t.length) return cur;
      const last = t.length - 1;
      if (!t[last].pending) return cur;
      const next = t.slice();
      next[last] = patch;
      return { ...cur, [key]: next };
    });

    let text: string;
    let failed = false;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/workshop/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        credentials: 'same-origin',
        // No transcript rides along. The server keeps this viewer's own
        // thread and reads it back itself, so the history cannot be
        // rewritten by whoever is asking.
        body: JSON.stringify({ target: sending.askAbout, question: q, model: model || undefined }),
      });
      // A refusal the server could make BEFORE opening the stream is still
      // ordinary JSON with a real status, so that shape is handled first.
      const isStream = (res.headers.get('content-type') || '').includes('text/event-stream');
      if (!res.ok || !isStream || !res.body) {
        const data = await res.json().catch(() => ({}));
        failed = true;
        // The server's own sentence wherever it wrote one: it is the only
        // thing that can say WHICH of "out of allowance", "too many at once"
        // and "no model is configured" happened.
        text = (typeof data.error === 'string' && data.error.trim())
          ? data.error.trim()
          : 'That did not go through. Try asking again.';
      } else {
        const parsed = await readAskStream(res.body, (sofar) => {
          writeTail({ who: 'ai', text: sofar, pending: true });
        });
        if (parsed.error) {
          failed = true;
          text = parsed.error;
        } else if (parsed.text.trim()) {
          text = parsed.text.trim();
        } else {
          failed = true;
          text = 'That did not go through. Try asking again.';
        }
      }
    } catch {
      failed = true;
      text = 'That did not go through. Check your connection and try again.';
    }

    writeTail({ who: 'ai', text, failed });
    setAsking((cur) => {
      const next = { ...cur };
      delete next[key];
      return next;
    });
  };

  /**
   * ONE send circle, rendered in one of two places: the resting line while
   * the composer is a single row, the controls row once it opens. Written
   * once so the disabled rule and the classes cannot drift between the two.
   */
  const sendBtn = (
    <button
      type="submit"
      className="dc-send-btn dc-circle-send dev-ws-ask-send"
      aria-label="Ask"
      disabled={!draft.trim() || !target || inFlight}
    ><ArrowUpIcon className="dev-ws-ask-send-icon" aria-hidden="true" /></button>
  );

  /**
   * Moving by a press. On a phone the swipe is the move and app.css hides
   * these; on a wide window they sit under the rail and do what the wheel
   * does. Disabled at the ends rather than wrapping: the end card is the
   * last slot, so Next goes dark there. Written once, because the rail on
   * the end card is these alone (see below).
   */
  const moveRow = (
    <div className="dev-ws-move" data-ws-move-row="">
      <button type="button" className="dev-ws-move-btn" data-ws-move="prev" aria-label="Previous" disabled={i <= 0} onClick={() => go(-1)}>
        <ChevronUpIcon className="dev-ws-move-icon" aria-hidden="true" />
      </button>
      <button type="button" className="dev-ws-move-btn" data-ws-move="next" aria-label="Next" disabled={i >= n} onClick={() => go(1)}>
        <ChevronDownIcon className="dev-ws-move-icon" aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <div
      className="dev-ws-needs"
      data-ws-needs=""
      data-ws-sheet={shown || undefined}
      data-ws-kb={kbUp ? '' : undefined}
    >
      {/* THE FEED. A real scroll container with snap points, not a swap of one
          rendered card: every row stays in the DOM (the legacy fillers find
          their hosts, a deep link can name a row that is not in view), a
          drag pages it with `scroll-snap`, and the index is read back from
          the scroll position so a swipe and a press cannot disagree. */}
      <div className="dev-ws-needs-scroll" data-ws-feed="" ref={scrollRef} onScroll={onScroll}>
        {items.map((r, k) => (
          <FeedItem
            key={r.key}
            row={r}
            index={k}
            count={n}
            tint={tints[k]}
            near={Math.abs(k - i) <= 1}
            voted={answered[r.key] || null}
            wide={wide}
            swipe={!wide && canSwipeVote(r) && !answered[r.key]}
            slug={slug}
            onFull={openFull}
            onDescribe={describe}
            railClear={wide ? 0 : railClear}
          />
        ))}
        {/* ALWAYS, after the last item: the swipe past the end lands here.
            With no items it is the whole screen. */}
        <DoneItem
          total={total}
          acted={acted}
          left={left}
          leftVotes={leftVotes}
          onDone={onDone}
          onBack={() => go(items.findIndex((r) => !answered[r.key]) - i)}
        />
      </div>

      {row ? (
        <aside className="dev-ws-rail" data-ws-rail="" aria-label="This item" ref={railRef}>
          {row.kind === 'vote' ? (
            <button
              type="button"
              className={voted ? 'dev-ws-rail-btn dev-ws-rail-vote is-on' : 'dev-ws-rail-btn dev-ws-rail-vote'}
              data-ws-rail-btn="vote"
              aria-haspopup="dialog"
              aria-expanded={sheet === 'vote'}
              disabled={!voted && !!sending[row.key]}
              onClick={() => toggleSheet('vote')}
            >
              <span className="dev-ws-rail-ic">{voted ? <CheckIcon aria-hidden="true" /> : <BallotIcon aria-hidden="true" />}</span>
              <span className="dev-ws-rail-lab">{voted ? `Voted ${voted}` : (sending[row.key] ? 'Sending…' : 'Vote')}</span>
              <kbd className="dev-ws-rail-key" aria-hidden="true">V</kbd>
            </button>
          ) : (
            <button
              type="button"
              className="dev-ws-rail-btn dev-ws-rail-take"
              data-ws-rail-btn="take"
              disabled={!row.yes}
              onClick={() => answer('yes')}
            >
              <span className="dev-ws-rail-ic"><HandRaisedIcon aria-hidden="true" /></span>
              <span className="dev-ws-rail-lab">Take it</span>
            </button>
          )}
          {/* Everything the card leaves out, the way a short video's words
              open under it: the summary, the changes in their own words and
              the facts in full. Second, because it is read before a vote. */}
          <button
            type="button"
            className="dev-ws-rail-btn dev-ws-rail-description"
            data-ws-rail-btn="description"
            aria-haspopup="dialog"
            aria-expanded={sheet === 'description'}
            onClick={() => toggleSheet('description')}
          >
            <span className="dev-ws-rail-ic"><DescriptionIcon aria-hidden="true" /></span>
            <span className="dev-ws-rail-lab">Description</span>
            <kbd className="dev-ws-rail-key" aria-hidden="true">D</kbd>
          </button>
          <button
            type="button"
            className="dev-ws-rail-btn dev-ws-rail-comments"
            data-ws-rail-btn="comments"
            aria-haspopup="dialog"
            aria-expanded={sheet === 'comments'}
            onClick={() => toggleSheet('comments')}
          >
            <span className="dev-ws-rail-ic"><ChatBubbleTailIcon aria-hidden="true" /></span>
            <span className="dev-ws-rail-lab">{commentCount ? String(commentCount) : 'Comments'}</span>
            <kbd className="dev-ws-rail-key" aria-hidden="true">C</kbd>
          </button>
          <button
            type="button"
            className="dev-ws-rail-btn dev-ws-rail-ask"
            data-ws-rail-btn="ask"
            aria-haspopup="dialog"
            aria-expanded={sheet === 'ask'}
            onClick={() => toggleSheet('ask')}
          >
            <span className="dev-ws-rail-ic"><SparklesIcon aria-hidden="true" /></span>
            <span className="dev-ws-rail-lab">Ask</span>
            <kbd className="dev-ws-rail-key" aria-hidden="true">A</kbd>
          </button>
          {row.kind === 'vote' ? (
            <button
              type="button"
              className="dev-ws-rail-btn dev-ws-rail-try"
              data-ws-rail-btn="try"
              disabled={!canTry}
              title={preview && preview.state !== 'live' ? preview.title : undefined}
              onClick={tryIt}
            >
              <span className="dev-ws-rail-ic"><PlayIcon aria-hidden="true" /></span>
              <span className="dev-ws-rail-lab">Try it</span>
              <kbd className="dev-ws-rail-key" aria-hidden="true">T</kbd>
            </button>
          ) : null}
          {/* The card's own ⋯ menu, on the rail. Same hook, same class, so
              the delegated handler and the declared checks find it. */}
          <button
            ref={moreRef}
            type="button"
            className="dev-ws-rail-btn dev-ws-rail-more dev-card-menu-btn"
            data-ws-rail-btn="more"
            data-card-menu={menuKey}
            data-card-menu-open={cardHref || undefined}
            disabled={!menuKey && !cardHref}
            aria-haspopup="true"
            aria-label="More actions"
          >
            <span className="dev-ws-rail-ic"><EllipsisHorizontalIcon aria-hidden="true" /></span>
            <span className="dev-ws-rail-lab">More</span>
            <kbd className="dev-ws-rail-key" aria-hidden="true">M</kbd>
          </button>
          {moveRow}
          {/* The vote: the question, where it stands, and the two answers. A
              sheet from the floor on a phone, a popover on this button on a
              wide window (app.css). Decide later closes it. */}
          {row.kind === 'vote' && shown === 'vote' ? (
            <div className="dev-ws-sheet-modal dev-ws-sheet-vote" data-ws-sheet="vote" role="dialog" aria-label={row.ask} {...leavingAttr}>
              <button type="button" className="dev-ws-scrim" aria-label="Close" onClick={closeSheet} />
              <div className="dev-ws-sheet-card">
                <span className="dev-ws-sheet-handle" aria-hidden="true" />
                <p className="dev-ws-ask-q">{row.ask}</p>
                <p className="dev-ws-vote-sub">{tallyLine(row)}</p>
                <div className="dev-ws-answer-row">
                  <button type="button" className="dev-ws-answer-btn dev-ws-answer-yes" data-ws-answer-btn="yes" disabled={!row.yes} onClick={() => answer('yes')}>Vote yes</button>
                  <button type="button" className="dev-ws-answer-btn dev-ws-answer-no" data-ws-answer-btn="no" disabled={!row.no} onClick={() => answer('no')}>Vote no</button>
                </div>
                <button type="button" className="dev-ws-vote-later" onClick={closeSheet}>Decide later</button>
                <p className="dev-ws-keys-hint" aria-hidden="true">Y yes · N no · Esc close</p>
              </div>
            </div>
          ) : null}
        </aside>
      ) : (
        /* THE END CARD'S RAIL: the move pair alone, so the way back up is
           where the thumb learned it is, and on a wide window the stage
           keeps its width rather than re-centring when the rail goes. On a
           phone the pair is hidden (app.css) and the rail draws nothing.
           Only once there are rows to go back to: an empty queue has no
           rail, as before. */
        n ? (
          <aside className="dev-ws-rail dev-ws-rail-end" data-ws-rail="" aria-label="The end of the feed">
            {moveRow}
          </aside>
        ) : null
      )}

      {/* The keys, listed once, where a keyboard is likely (app.css). Only
          the keys this item answers to: an issue has no vote and nothing
          to try, so those two are left off rather than listed and dead.
          Each pair is one child with one text run, so the prerender never
          emits two adjacent text nodes (React #418). */}
      {row || n ? (
        <p className="dev-ws-keys" aria-hidden="true">
          {legendFor(row ? row.kind : 'done').map(([keys, word]) => (
            <span key={word} className="dev-ws-key">
              {keys.map((k) => <kbd key={k}>{k}</kbd>)}
              {` ${word}`}
            </span>
          ))}
        </p>
      ) : null}

      {/* ── Ask: the private Q&A with the model, about the item in view ──
          A sheet on a phone, a panel beside the rail on a wide window. The
          composer is the dev session's own (`.dc-card`), as far as this pane
          needs it — see the note on `sendBtn`. */}
      {row && shown === 'ask' ? (
      <div className="dev-ws-sheet-modal dev-ws-sheet-ask" data-ws-sheet="ask" role="dialog" aria-label="Ask about this item" {...leavingAttr}>
      <button type="button" className="dev-ws-scrim" aria-label="Close" onClick={closeSheet} />
      <section className="dev-ws-ask dev-ws-sheet-card" data-ws-ask="">
        <span className="dev-ws-sheet-handle" aria-hidden="true" />
        <div className="dev-ws-sheet-head">
          <span><span className="dev-ws-sheet-title">{row.kind === 'vote' ? 'Ask about this change' : 'Ask about this issue'}</span><span className="dev-ws-sheet-sub">private to you</span></span>
          <button type="button" className="dev-ws-sheet-x" onClick={closeSheet}>Close</button>
        </div>
        <div className="dev-ws-ask-log" data-ws-ask-log="">
          {engaged ? thread.map((m, k) => (
            <p
              key={k}
              className={askMsgClass(m)}
              /* The answer is the one thing here nobody in this app wrote,
                 so it is announced. Polite, not assertive. */
              aria-live={m.who === 'ai' ? 'polite' : undefined}
            >
              {m.text}
            </p>
          )) : (
            <p className="dev-ws-ask-hint">
              {target ? 'Ask what this changes, who it affects, or what happens if it goes in. Answered from what the platform knows about it.' : 'There are no details to ask about on this one.'}
            </p>
          )}
        </div>
        <form
          className="dev-ws-ask-composer dc-card"
          onSubmit={(e) => { e.preventDefault(); ask(); }}
        >
          <label className="sr-only" htmlFor="dev-ws-ask-input">Ask about this change</label>
          {/* THE FIELD on a line of its own; the controls row is under it. */}
          <div className="dev-ws-ask-line">
            <input
              id="dev-ws-ask-input"
              className="dev-ws-ask-input"
              type="text"
              value={draft}
              placeholder={
                !target ? 'No details to ask about on this one'
                  : inFlight ? 'Reading the change…'
                    : 'Ask a question…'
              }
              disabled={!target || inFlight}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          {/* THE CONTROLS ROW is there at every width: the model picker, and
              the send circle as the card's last thing. It used to wait for a
              tap on the field on a phone, and a picker behind a tap nobody
              knows to make is a picker nobody uses. */}
          <div className="dev-ws-ask-row">
            {models.list.length ? (
              <span className="dev-ws-ask-model" data-ws-ask-model="">
                <label className="sr-only" htmlFor="dev-ws-ask-model-select">Model</label>
                <select
                  id="dev-ws-ask-model-select"
                  className="dc-model-select dc-model-name"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {models.list.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <ChevronDownIcon className="dev-ws-ask-model-chev" aria-hidden="true" />
              </span>
            ) : null}
            {/* `margin-left: auto` in app.css, so the circle is at the card's
                right edge whether or not the model picker is beside it. */}
            {sendBtn}
          </div>
        </form>
      </section>
      </div>
      ) : null}

      {/* ── Comments: the app's own thread, and an issue's GitHub thread ──
          The thread component is the one the unfolded rows use; the GitHub
          slot is the legacy filler's host, pointed at this sheet when it
          opens. */}
      {row && shown === 'comments' ? (
      <div className="dev-ws-sheet-modal dev-ws-sheet-comments" data-ws-sheet="comments" role="dialog" aria-label="Comments" {...leavingAttr}>
      <button type="button" className="dev-ws-scrim" aria-label="Close" onClick={closeSheet} />
      <section className="dev-ws-sheet-card" data-ws-comments="">
        <span className="dev-ws-sheet-handle" aria-hidden="true" />
        <div className="dev-ws-sheet-head">
          <span><span className="dev-ws-sheet-title">{commentCount ? `${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}` : 'Comments'}</span><span className="dev-ws-sheet-sub">{row.kind === 'vote' ? 'on this change' : 'on this issue'}</span></span>
          <button type="button" className="dev-ws-sheet-x" onClick={closeSheet}>Close</button>
        </div>
        <div className="dev-ws-sheet-body" ref={commentsRef}>
          {row.commentsFor != null ? <div className="dev-feed-comments" data-comments-for={row.commentsFor} /> : null}
          {row.thread ? (
            <FeedThread slug={slug} type={row.thread.type} refId={row.thread.ref} canPost={canPost} />
          ) : null}
          {!row.thread && row.commentsFor == null ? <p className="dev-ws-ask-hint">No comments yet.</p> : null}
        </div>
      </section>
      </div>
      ) : null}

      {/* ── Description: what the card leaves out ──
          The title, who and when, the facts as chips, the declared changes
          in their own words, and the summary as its own page renders it. */}
      {row && shown === 'description' ? (
      <div className="dev-ws-sheet-modal dev-ws-sheet-description" data-ws-sheet="description" role="dialog" aria-label="Description" {...leavingAttr}>
      <button type="button" className="dev-ws-scrim" aria-label="Close" onClick={closeSheet} />
      <section className="dev-ws-sheet-card" data-ws-description="">
        <span className="dev-ws-sheet-handle" aria-hidden="true" />
        <div className="dev-ws-sheet-head">
          <span><span className="dev-ws-sheet-title">Description</span></span>
          <button type="button" className="dev-ws-sheet-x" onClick={closeSheet}>Close</button>
        </div>
        <div className="dev-ws-sheet-body">
          <h3 className="dev-ws-desc-title">{row.card.title.text || row.card.title.title}</h3>
          <ItemBy row={row} />
          {descFacts.length ? (
            <div className="dev-ws-item-chips">
              {descFacts.map((f) => <span key={f.key} className={chipTone(f.tone)}>{f.text}</span>)}
            </div>
          ) : null}
          {descChanges.length ? (
            <div className="dev-ws-desc-part">
              <h4 className="dev-ws-desc-head">What changes</h4>
              <ol className="dev-ws-shot-changes dev-ws-desc-changes">
                {descChanges.map((c) => (
                  <li key={c.n} className="dev-ws-shot-change">
                    <span className="dev-ws-shot-n">{c.n}</span>
                    <span>{c.text}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          <div className="dev-ws-desc-part">
            <h4 className="dev-ws-desc-head">{row.kind === 'vote' ? 'Summary' : 'The issue'}</h4>
            {row.descriptionHtml ? (
              <Html className="dev-ws-desc-body" html={row.descriptionHtml} />
            ) : (
              <p className="dev-ws-ask-hint">{row.kind === 'vote' ? 'No plain-language summary was written for this change.' : 'This issue has no description.'}</p>
            )}
          </div>
          {cardHref ? <a className="dev-ws-desc-open" href={cardHref}>{row.kind === 'vote' ? 'Open the proposal' : 'Open the issue'}</a> : null}
        </div>
      </section>
      </div>
      ) : null}
    </div>
  );
}

/**
 * The grouping strip — "By category" / "By stage".
 *
 * ONE NODE, RENDERED IN ONE OF TWO PLACES. Below 768px it is a row of
 * the pane's sticky head, full width, as it has always been. From 768px up it
 * moves into `.dev-ws-ear` — a surface hanging off the pane's top-right
 * corner, beside the lander's tab pill — and app.css shrinks it to its labels
 * there. Rendered in ONE place at a time rather than twice with one hidden:
 * `[data-ws-group]` is what the declared checks and `querySelector` reach
 * for, and a hidden twin is the copy they would find first.
 */
function GroupStrip({ group }: { group: string }): ReactNode {
  return (
    <div className="dev-ws-group" role="tablist" aria-label="Group the board by">
      <button
        type="button"
        role="tab"
        className="dev-ws-group-tab"
        data-ws-group="category"
        aria-selected={group === 'category'}
        onClick={() => callAppView('_setWorkshopGroup', 'category')}
      >
        By category
      </button>
      <button
        type="button"
        role="tab"
        className="dev-ws-group-tab"
        data-ws-group="stage"
        aria-selected={group === 'stage'}
        onClick={() => callAppView('_setWorkshopGroup', 'stage')}
      >
        By stage
      </button>
    </div>
  );
}

/**
 * The breakpoint, in one place. app.css's `@media (min-width: 700px)` block is
 * the same decision written in the other language, and the two move together:
 * above it the tab strip is a segmented control at the head of the column and
 * the feed's sheets are panels beside it; below it the strip is a bar stuck to
 * the floor and the sheets rise from it, stopping above the keyboard.
 */
const WIDE_QUERY = '(min-width: 700px)';

/**
 * The OTHER breakpoint, and it is deliberately not that one.
 *
 * From 768px up the grouping strip leaves the pane head and sits beside the
 * tab pill as an ear on the pane's top-right corner (app.css, "The grouping
 * strip as an EAR"). 768 rather than 700 because the reading column tops out
 * at 760px there: above it the row has exactly one appearance — a 444px pill,
 * a 233px ear, 83px of air — at every width, and below it the two would close
 * on each other through a 60px band before the rail breakpoint took the pill
 * away. Those three numbers are measured, not chosen.
 */
const EAR_QUERY = '(min-width: 768px)';

/** `matchMedia` where there is one — the vm the tests render in has none. */
function matchesQuery(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

/**
 * Is this the wide layout?
 *
 * READ AT MOUNT, not in an effect. Nothing here is prerendered: the Workshop
 * mounts client-side
 * into a host `_repaintDevBody()` creates, so there is no first paint to
 * disagree with, and the component's own header says so. The seed matters
 * because the composer's resting state differs by width: a collapsed frame
 * followed a tick later by an expanded one is a flash on every visit to the
 * Needs-you tab.
 *
 * The effect is still there for the CROSSING — a rotated phone, a resized
 * window — which the seed alone cannot see.
 */
function useMediaFlag(query: string): boolean {
  const [on, setOn] = useState(() => matchesQuery(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(query);
    const apply = () => setOn(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [query]);
  return on;
}

/**
 * The air between the tab pill and the ear, once the ear claims the rest.
 *
 * The two surfaces are level and adjacent, so this is the seam between them
 * rather than a layout gap — the same 10px the ear spends on its own
 * horizontal padding, so the distance from the pill to the first label reads
 * as one step.
 */
const EAR_GAP_PX = 10;

/**
 * Everything `useEarInset` publishes, so the teardown cannot miss one.
 *
 * They are all derived from the same measurement and all read by app.css; a
 * stale one left on the host would be inherited by the next crossing, which
 * is why this is a list rather than four remove calls written out.
 */
const EAR_PROPS = ['--dev-ws-ear-left', '--dev-ws-group-w', '--dev-ws-head-top'];

/**
 * QA 2026-09-24 Q7: where the pinned strip's band reaches, as offsets from the
 * nav's own edges to the pane's. Zero on By category, where the nav and the
 * pane are the same reading column; negative on By stage, where the pane goes
 * full-bleed and the band has to cover the board columns either side of the
 * column, or the cards scroll past the strip in plain view. Cleared with the
 * ear's below the breakpoint, and on a tab with no pane, so the band falls
 * back to the nav's own width there.
 */
const BAND_PROPS = ['--dev-ws-band-left', '--dev-ws-band-right'];

/** The ear's own horizontal padding (`padding: 5px 10px`, app.css). */
const EAR_PAD_X = 10;

/** The column gap between the tab strip and the pane below it (`.dev-ws`). */
const WS_GAP_PX = 10;

/**
 * The narrowest the ear is allowed to be, which is what its labels need.
 *
 * Measured: "By category" + "By stage" plus the rail's padding come to 233px.
 * The clamp matters at the bottom of the ear's range — just above 768px the
 * pill is 444px of a 760px column, so the honest answer for `left` would
 * leave the ear 306px, but a longer translation of either label (or a user
 * font scale) narrows that fast. Past the clamp the ear stops growing
 * leftward and keeps its content rather than crushing it; `right: 0` is never
 * given up, so the pane's right edge is still tracked.
 */
const EAR_MIN_PX = 240;

/**
 * WHY THE SURFACE MAY GROW AND THE LABELS MAY NOT.
 *
 * The ear's right edge is the pane's, in CSS (`right: 0` on a child of the
 * head), so on By stage — where the pane goes full-bleed — the surface grows
 * with it. For one round it was measured off the tab strip's column instead,
 * to stop it "shifting right with the pane growth"; that held the ear at a
 * fixed 306px and needed three more custom properties to put the pane's
 * outline back to the right of it.
 *
 * What makes the simpler anchor work now is that the TABS no longer share the
 * surface (`flex: 0 0 auto`, app.css). Sharing it is what made a full-bleed
 * pane produce 268px and 348px tabs — a title bar with a label in it — and
 * what the retired width cap existed to prevent. With the labels hugging at
 * the surface's left end, the control sits at the same coordinates under
 * either grouping and only the surface behind it changes width, so there is
 * nothing left for a cap to catch.
 *
 * The cost is deliberate: on By category the labels no longer fill their
 * surface, leaving empty ear to the right of "By stage".
 */

/**
 * Stretch the ear leftward to meet the tab pill.
 *
 * The ear used to hug its two labels, which left a wide band of dead space
 * between it and the pill — 83px at the narrow end and the same at every
 * width, because both boxes were content-sized inside a column that tops out
 * at 760px. It now spans from just clear of the pill to the pane's right
 * edge, and the two tabs share that width (`flex: 1 1 0` in app.css).
 *
 * WHY THIS IS MEASURED RATHER THAN WRITTEN IN CSS. The pill is
 * `.dev-ws-tabtrack` inside `.dev-ws-tabs`, and the ear is a child of the
 * pane: different subtrees, so no selector can hand one the other's width.
 * The nav is left-aligned on the same reading column as the pane (see the
 * `justify-content: flex-start` note in app.css), which is what makes the
 * pill's right edge the ear's left bound in the first place — but its width
 * is three text labels, so only a measurement knows it.
 *
 * NO FEEDBACK LOOP HERE, unlike the filter strip's measurement: the ear is
 * absolutely positioned and therefore out of flow, so its width cannot
 * change the pill's or the pane's. The observer watches the two boxes it
 * reads and writes a property neither of them consults.
 *
 * The value lands as a custom property on `.dev-ws` and is inherited by the
 * ear, so React renders no style of its own — the same rule the rest of the
 * shell follows for anything written at runtime.
 */
function useEarInset(
  bar: HTMLElement | null,
  hostRef: React.RefObject<HTMLDivElement | null>,
  earUp: boolean,
): void {
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    // Down at phone width the strip is back in the pane head and the ear does
    // not exist. Clear the property rather than leave a stale number on the
    // host for the next crossing to inherit.
    if (!earUp || !bar) {
      for (const k of EAR_PROPS) host.style.removeProperty(k);
      for (const k of BAND_PROPS) host.style.removeProperty(k);
      return undefined;
    }
    const track = bar.querySelector<HTMLElement>('.dev-ws-tabtrack');
    const pane = host.querySelector<HTMLElement>('[data-ws-pane]');
    if (!track || !pane) {
      for (const k of BAND_PROPS) host.style.removeProperty(k);
      return undefined;
    }
    const measure = () => {
      const t = track.getBoundingClientRect();
      const n = bar.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      if (!t.width || !n.width || !p.width) return;
      // ONE NUMBER LEFT. The ear's right edge is the pane's, in CSS, so only
      // its left bound needs measuring: reach the pill, unless that would
      // leave the surface narrower than the two labels — then stop and let
      // the seam widen instead. `right` and the two the pane's outline used
      // to need went with the column anchoring that produced them.
      const wanted = Math.max(0, t.right - p.left + EAR_GAP_PX);
      const left = Math.min(wanted, Math.max(0, p.width - EAR_MIN_PX));
      host.style.setProperty('--dev-ws-ear-left', `${Math.round(left)}px`);
      // HOW WIDE THE TABS ARE, and it is the same number under both
      // groupings — which is the whole point. They fill the ear on By
      // category, where the surface stops at the reading column; on By stage
      // the SURFACE grows with the full-bleed pane and the tabs keep the size
      // they had, rather than stretching to 268px apiece or shrinking to their
      // labels.
      //
      // So it is measured to the NAV's right edge rather than the pane's. The
      // nav keeps the reading column in both groupings and the ear's left edge
      // sits beside the pill in both, so this is one width: 286px at 1280,
      // whether the ear around it is 306px or 562px.
      const groupW = Math.max(0, Math.round(n.right - (p.left + left) - EAR_PAD_X * 2));
      host.style.setProperty('--dev-ws-group-w', `${groupW}px`);
      // WHERE THE HEAD COMES TO REST, which is under the pinned tab strip
      // rather than at the top of the scroller. Both stick, so the offset has
      // to be the strip's own height — three text labels and a glyph, so a
      // measurement again rather than a literal — plus the column gap between
      // them. Pinned too high, the head would slide under the strip; too low
      // and a band of the list shows through between the two.
      host.style.setProperty('--dev-ws-head-top', `${Math.round(n.height) + WS_GAP_PX}px`);
      // The band behind the pinned strip spans the PANE, not the nav (see
      // BAND_PROPS). Offsets from the nav's edges, which is the box the
      // band's pseudo-element is positioned in.
      host.style.setProperty('--dev-ws-band-left', `${Math.round(p.left - n.left)}px`);
      host.style.setProperty('--dev-ws-band-right', `${Math.round(n.right - p.right)}px`);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    // The pane too: By category is the reading column and By stage is the
    // full-bleed card, so the right edge this is measured back from moves
    // when the grouping does.
    ro.observe(pane);
    return () => ro.disconnect();
    // NO DEPENDENCY ARRAY, deliberately: this runs after EVERY render, and a
    // narrow one is what broke it. With `[bar, hostRef, earUp]` the effect
    // could not re-run on a grouping switch, so the number measured against
    // the 760px column — where the pane's left edge is 260 at 1280 — was
    // still in force once By stage made the pane full-bleed and moved that
    // edge to 4. The ear then began 250px further left than it should and
    // overlapped the tab pill.
    //
    // It is also what covers a pane or a pill that arrives AFTER the first
    // run (the observer is attached to whatever is there at the time) and any
    // viewport change the observed boxes do not register, since a centred
    // column can MOVE without changing size and a ResizeObserver reports
    // size alone.
    //
    // The cost is one observer teardown and setup per render of the Workshop,
    // which re-renders on data changes rather than on a timer. Correctness
    // over that: the version with deps shipped a visible bug.
  });
}

/**
 * QA 2026-09-24 Q7: IS THE TAB STRIP PINNED?
 *
 * Above 700px the strip is `position: sticky` at the scroller's top, and the
 * pane head pins under it. What scrolled past them showed: the strip had no
 * z-index, so the pane (positioned, and later in the tree) painted OVER it and
 * the tabs went under the cards, and the air around the pill (the gap to the
 * ear, the 10px down to the head, the board columns either side of the column
 * on By stage) had nothing behind it. app.css now stacks the strip above the
 * cards and draws a band behind it, but only while it is pinned: at rest the
 * pill sits on the page beside the ear, and a band there would swallow the
 * ear's shape.
 *
 * Pinned means the tab body has started to slide up under the strip: at rest
 * the body starts one column gap below it, and it only comes closer once the
 * strip has stuck and the page keeps scrolling. Measured, rather than read off
 * a scrollTop, because which element scrolls depends on the shell (the dev
 * frame's own scroller, or the document on a touch browser); a capturing
 * listener on the document hears a scroll from either.
 *
 * The attribute is written straight onto the host, like useEarInset's
 * properties: it changes on scroll, and a React state for it would re-render
 * the whole Workshop, board included, on the frame the strip sticks.
 */
function usePinnedStrip(
  bar: HTMLElement | null,
  hostRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  tab: string,
): void {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    if (!enabled || !bar || typeof document === 'undefined') {
      host.removeAttribute('data-ws-pinned');
      return undefined;
    }
    let frame = 0;
    const check = () => {
      frame = 0;
      const body = host.querySelector<HTMLElement>(':scope > .dev-ws-tabbody');
      if (!body) return;
      const pinned = body.getBoundingClientRect().top < bar.getBoundingClientRect().bottom + WS_GAP_PX - 0.5;
      if (pinned !== host.hasAttribute('data-ws-pinned')) host.toggleAttribute('data-ws-pinned', pinned);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    check();
    return () => {
      document.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
      host.removeAttribute('data-ws-pinned');
    };
  }, [bar, hostRef, enabled, tab]);
}

export function DevWorkshop(): ReactNode {
  const v = useStoreState(devWorkshopStore);
  // THE OPEN APP'S NAME AND ARTWORK, for the hero and the channel below. The
  // same store the header's own tile draws from, so the two cannot disagree
  // about which app this is, and no second fetch: the controller publishes
  // both `app_icon_*` columns here already.
  const app = useStoreState(improveStore);
  const hostRef = useRef<HTMLDivElement>(null);
  const [sortKey, setSortKey] = useState<SortKey>('people');
  // Which themes are unfolded, keyed by id. The FIRST theme opens by
  // default: a lander whose every theme is shut is a list of headings.
  // Seeded once the first real publish lands, then the viewer's.
  // Seeded FROM the publish, not from an effect: `autoExpand` is how the
  // `?shot=` deep links reach a theme now that every one starts shut, and an
  // effect would paint the closed state first. Nothing hydrates this component
  // — it mounts client-side into a legacy host and is absent from the
  // prerendered shell — so there is no mismatch to cause. The effect below
  // still handles the case where the themes land after the first paint.
  const [openThemes, setOpenThemes] = useState<Record<string, boolean> | null>(
    () => (v.autoExpand ? { [v.autoExpand.theme]: true } : null),
  );
  // At most one unfolded row per theme (and one for the since strip).
  const [openRows, setOpenRows] = useState<Record<string, string>>(
    () => (v.autoExpand && v.autoExpand.key ? { [v.autoExpand.theme]: v.autoExpand.key } : {}),
  );
  // HOW FAR THE SINCE LIST IS OPEN, on the Workshop page (see SINCE_FIRST):
  // the weeks past the ones it opens with, and which weeks have their extra
  // new rows or their seen rows unfolded. Held here because Clear folds all
  // of it back at once, and the legacy fillers re-run when any of it moves.
  const [sinceExtra, setSinceExtra] = useState(0);
  const [sinceAllNew, setSinceAllNew] = useState<Record<string, boolean>>({});
  const [sinceSeen, setSinceSeen] = useState<Record<string, boolean>>({});
  // Whether the hub's Your work shows every row or its first two.
  const [workAll, setWorkAll] = useState(false);
  // Which of the three tabs is up. Seeded from the publish so a `?ws=` deep
  // link paints the right one on the FIRST frame rather than showing Current
  // status and then swapping — the same reason `openThemes` is seeded from
  // `autoExpand` rather than from an effect.
  // A CALLBACK REF, NOT `useRef`, AND THAT IS THE WHOLE BUG IT FIXES. While the
  // board is loading this component returns a skeleton, so the bar does not
  // exist: the marker's effect ran, found nothing and returned. When the data
  // landed and the bar finally rendered, a `useRef` had not changed — refs are
  // stable — so the effect never re-ran and the marker was never measured. The
  // selection was simply invisible the first time the Workshop was opened.
  //
  // State re-renders when the node arrives, which wakes the effect exactly
  // then.
  const [bar, setBar] = useState<HTMLElement | null>(null);
  // Seeded from a FRESH read of the remembered tab, not from the publish: the
  // store keeps the last view published, so a page opened again (Back, or a
  // door that has just set the hub) would otherwise open on a tab the viewer
  // has since left. The first render is the loading skeleton either way, so
  // the prerendered page is unchanged; the publish is the fallback where
  // AppView is not there to ask.
  const [tab, setTab] = useState<TabKey>(() => freshTab() || v.tab || 'status');
  // Moving between the hub and its pages, remembered the way a tab press
  // always was (AppView._setWorkshopTab), and back to the top: a page opened
  // from a door lower down should start at its own head.
  const openTab = (next: TabKey) => {
    setTab(next);
    callAppView('_setWorkshopTab', next);
    try { window.scrollTo?.({ top: 0 }); } catch { /* no window to scroll */ }
  };
  // ...AND AGAIN WHEN THE PUBLISH LANDS, which is what the seed alone could
  // not do. The seed runs against whatever the store holds AT MOUNT, and that
  // is EMPTY_WORKSHOP_VIEW: the module publishes `_workshopView()` after its
  // data load, so on a cold open `v.tab` is undefined in that first frame and
  // the deep link was dropped on the floor. `autoExpand` has carried the same
  // late-arrival effect since it shipped, for exactly this reason — which is
  // why `?shot=themes` worked on staging while `?ws=all` silently did not,
  // and why 25 declared checks failed on a route that reads correctly.
  //
  // ONCE, guarded by the ref. `v.tab` is read from the URL, so it never
  // changes for the life of the page, while `_rerenderWorkshop()` republishes
  // on every data change: without the guard each republish would yank a
  // reader who had tapped another tab back to the deep-linked one.
  const deepTabApplied = useRef<boolean>(!!v.tab || !!freshTab());
  useEffect(() => {
    if (deepTabApplied.current || !v.tab) return;
    deepTabApplied.current = true;
    setTab(v.tab);
  }, [v.tab]);
  // A DOOR TO THIS PROJECT'S HUB, pressed while its page is already open —
  // the logo menu's "Go to community hub" changes no address, so no route
  // runs. AppView._landOnHub says so; a door to another project is not ours.
  useEffect(() => {
    const onDoor = (event: Event) => {
      const door = (event as CustomEvent<{ slug: string | null; tab: TabKey } | null>).detail;
      if (!door || (door.slug && door.slug !== v.slug)) return;
      setTab(door.tab);
      try { window.scrollTo?.({ top: 0 }); } catch { /* no window to scroll */ }
    };
    window.addEventListener('usernode:workshop-tab', onDoor);
    return () => window.removeEventListener('usernode:workshop-tab', onDoor);
  }, [v.slug]);
  // Which pane is under the tabs. Lives in a module-global store rather than
  // here, because app-view.js has to read it: `_rerenderWorkshop()` publishes
  // the kanban view model only when the stage pane is up. See
  // ./group-mode-store.ts.
  const group = useWorkshopGroup();
  // Where the grouping strip renders: beside the tab pill from 768px up, in
  // the pane's sticky head below it. See `EAR_QUERY` and `GroupStrip`.
  const earUp = useMediaFlag(EAR_QUERY);
  // ...and how wide it is: from just clear of the pill to the pane's right
  // edge, which only a measurement knows. See `useEarInset`.
  useEarInset(bar, hostRef, earUp);
  // QA 2026-09-24 Q7: whether the strip is pinned, for app.css's band behind
  // it. Only where the strip is sticky at all. See `usePinnedStrip`.
  const stripSticks = useMediaFlag(WIDE_QUERY);
  usePinnedStrip(bar, hostRef, stripSticks, tab);
  // The toolbar's props reach this root through a store, not a prop — the
  // Workshop is a separate React root from the frame that receives them. See
  // ../actions-store.ts.
  const actions = useDevActions();

  const themes = useStableThemeOrder(v.themes, sortKey);
  const themesRef = useRef<HTMLDivElement | null>(null);
  const captureThemeTops = useThemeReorderMotion(themesRef, themes);
  // The eyebrow over the theme list: the count, then whatever the grouping
  // itself has to report. Named categories only — "Not yet grouped" is a
  // holding pen, not one of them — and counted here so the label can agree
  // with itself: it read "1 themes" before, which is the kind of thing a
  // reader trusts a screen slightly less for.
  const countOfThemes = themes.filter((t) => !t.ungrouped).length;
  const groupingNote = [
    `${countOfThemes} ${countOfThemes === 1 ? 'category' : 'categories'}`,
    v.meta.source === 'category' ? 'grouped by category for now' : '',
    v.meta.source === 'demo' ? 'staging demo grouping' : '',
    v.meta.pending
      ? (v.meta.pendingStage === 'placement'
        ? 'placing new cards…'
        : (v.meta.source === 'ai' ? 're-drafting categories…' : 'drafting categories…'))
      : '',
  ].filter(Boolean).join(' · ');
  // Every theme starts SHUT. The first one used to open itself, on the
  // reasoning that a lander whose every theme is closed is a list of
  // headings — but a list of headings is exactly what this screen is for,
  // and opening one of them for you spends the top of the page on whichever
  // theme happened to sort first rather than on the shape of the whole board.
  const isOpen = (id: string) => !!(openThemes && openThemes[id]);
  const toggleTheme = (id: string) => {
    setOpenThemes((cur) => ({ ...(cur || {}), [id]: !(cur && cur[id]) }));
  };
  const toggleRow = (scope: string, key: string) => {
    setOpenRows((cur) => (cur[scope] === key ? { ...cur, [scope]: '' } : { ...cur, [scope]: key }));
  };

  // The since list's controls (#2183). `Show older` steps back a week;
  // `Clear` moves the baseline to now (AppView owns the stamp and its
  // storage, and republishes) and folds everything back to how it opened, so
  // what the reader dismissed is under its week's "seen" row rather than
  // gone. #2240: it is live whenever there is something to fold, new rows
  // or not.
  const sinceUnfolded = sinceExtra > 0
    || Object.values(sinceAllNew).some(Boolean)
    || Object.values(sinceSeen).some(Boolean);
  const clearSince = () => {
    if (!v.since) return;
    setSinceExtra(0);
    setSinceAllNew({});
    setSinceSeen({});
    setOpenRows((cur) => ({ ...cur, since: '' }));
    callAppView('_workshopClearSince', slug, v.since.through);
  };

  // A deep link that names a row (the ?shot= captures): open its theme and
  // unfold it once, on the publish that carries it.
  const autoKey = v.autoExpand ? `${v.autoExpand.theme}:${v.autoExpand.key}` : null;
  useEffect(() => {
    if (!v.autoExpand) return;
    const { theme, key } = v.autoExpand;
    setOpenThemes((cur) => ({ ...(cur || {}), [theme]: true }));
    // `?shot=themes` names a theme and no row: the lanes are the subject, and
    // every row in them stays folded.
    if (key) setOpenRows((cur) => ({ ...cur, [theme]: key }));
  }, [autoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The two legacy fillers, re-run whenever the set of unfolded entries
  // changes — see the header. `_wireFeedComments` replaces its observer, so
  // calling it again is idempotent; `_fillKudosHosts` skips filled hosts.
  // A layout effect, so a merged card's kudos pill is in its band on the
  // card's first frame rather than popping in after it (dev-kanban.tsx has
  // the same note).
  const openSig = `${Object.values(openRows).join('|')}|since:${sinceExtra}:${Object.keys(sinceAllNew).join(',')}:${Object.keys(sinceSeen).join(',')}|work:${workAll}`;
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    callAppView('_wireFeedComments', host);
    callAppView('_fillKudosHosts', host);
  }, [openSig, v]);

  // The project's community record — the hero, the hub's cards and the hub
  // tab's own label all read it. Before the loading return: it is a hook.
  const community = useCommunity(v.slug || '');
  // Looking in rather than taking part: the hub says "Recently" to them.
  const outsider = !!community && !community.is_member;

  if (v.loading) return <div ref={hostRef}><CardSkeleton n={4} label="Loading the workshop" /></div>;
  const nextUp = v.nextUp && v.nextUp.t === 'card' ? v.nextUp : null;
  const slug = v.slug || '';
  const canPost = !!v.canPost;
  // #2573's start-here banner: nothing open and nothing ever shipped. (All
  // items' search no longer narrows the count, so it is not a condition:
  // #2915.) Named once because the empty note under it reads it too — see
  // EmptyNote.
  const startHere = !!(v.dashboard && v.dashboard.open === 0 && !v.dashboard.everShipped);

  /* ── The back bar, on a page ──
     THE HUB HAS NO BAR. It is the project's page, and what it opens are
     doors on it; a strip of tabs over it made the hub one of two peers, and
     it read as a second Workshop. A page (the Workshop, Needs you, All items)
     leads with a bar holding its way back and its name.

     THE BAR KEEPS THE STRIP'S BOX: `.dev-ws-tabs` with its track, which is
     what the pinned header and the grouping ear on All items are measured
     against (useEarInset, usePinnedStrip), so both keep working unchanged,
     and the ear sits level with the back button where it sat level with the
     tabs. It LEADS the markup, so focus order and reading order agree. */
  const railNode = tab === 'status' ? null : (
    <div ref={setBar} className="dev-ws-tabs dev-ws-pagebar" data-ws-pagebar="">
      <div className="dev-ws-tabtrack">
        <PageBack
          label={tab === 'all' ? 'Workshop' : (app.name || community?.name || slug)}
          title={pageTitle(tab)}
          onBack={() => openTab(pageParent(tab))}
        />
      </div>
    </div>
  );

  // The Workshop page's since list, filed by week. A first visit has no
  // baseline and so nothing new, but the weeks and their lines are still
  // the history, so they are drawn without the list's own controls.
  const sinceList = v.since || EMPTY_SINCE;
  const weeks = tab === 'workshop' ? sinceWeeks(sinceList, v.dashboard ? v.dashboard.weeks : null, Date.now()) : [];
  const weeksOpen = Math.min(weeks.length, sinceWeeksOpen(weeks) + sinceExtra);
  const firstWeek = v.dashboard ? v.dashboard.firstWeek : null;

  return (
    <div
      ref={hostRef}
      className="dev-ws"
      data-ws-tab={tab}
    >
      {/* WHICH WORKSHOP YOU ARE IN, and the way to another (#2718 review):
          the panel of your other projects, and All, which is the way back
          up.

          ITS CONTROL IS THE HEADER'S, AT EVERY WIDTH (#3295). The app's tile
          and name in the bar open it (features/header/header-title.tsx). A
          phone has had that since #2768; a desktop kept a chip of its own
          here, on a row above the tabs or, on a wide window, beside them
          (#2837), and the owner asked for it in the header there too. So
          only the panel renders here, and only once it is open.

          ABOVE THE BAR in the markup, so the panel drops down over the page
          rather than under it, right under the header that opened it. */}
      {slug ? <AppWorkshopScope slug={slug} /> : null}
      {railNode}
      {/* Everything but the bar lives in here. It is what carries the
          clearance under the last card: a sticky bar overlays whatever is
          beneath it while you scroll, so the content needs a bar's worth of
          empty space at its end or the final card can never be read clear of
          it. Above 700px the bar is not sticky and overlays nothing, so
          app.css takes the clearance back off. */}
      <div className="dev-ws-tabbody">
      {tab === 'status' ? (
      <>
      {/* ── The hero: what this is, who it is for, Join (communities) ──
          FIRST ON THE PAGE. A person arriving from Discover or a shared link
          met four numbers about the code before the thing's own name; the
          page now leads with identity, the way a profile does, and the
          hub's own cards follow. See ./community-card.tsx.

          THE ⋯ IS THE HERO'S. It closed the tab strip, and with the strip
          gone it sits beside Invite at the end of the members row: the
          project's own menu, on the project's own card. It is ONE node
          (`DevPlusMenu`, ../actions-row.tsx) rendered here and nowhere else
          on this surface, which is what keeps `#dev-plus-btn` /
          `#dev-plus-menu` unique for `_wirePlusMenu`; it wires itself on
          mount, so arriving after the hero's read is no problem. */}
      {slug ? (
        <CommunityCard
          slug={slug}
          name={app.name || undefined}
          iconUrl={app.iconUrl}
          iconEmoji={app.iconEmoji}
          canOpenApp={!actions.selfHosted}
          menu={(
            <DevPlusMenu
              illustrationApp={actions.illustrationApp}
              canManageIllustration={actions.canManageIllustration}
              selfHosted={actions.selfHosted}
              readOnly={actions.readOnly}
              canCollaborate={actions.canCollaborate}
              showsMembers={actions.showsMembers}
              inHero
              // A public community's "Make it private" is the ⋯'s, not a
              // hero button (./community-card.tsx confirmMakePrivate).
              onMakePrivate={canMakePrivate(community)
                ? () => { void confirmMakePrivate(slug, app.name || community?.name || slug); }
                : null}
            />
          )}
        />
      ) : null}
      {/* #2573: ABOVE the empty note, because the two answer different
          questions on the same screen. The note says what the board holds;
          this says what to do about an app nobody has started on, and the
          product decision put it at the top of the page. See
          StartHereBanner for the three conditions. */}
      {startHere ? <StartHereBanner /> : null}
      {v.emptyNote ? (
        <EmptyNote
          filtered={!!v.emptyNote.filtered}
          loadFailed={v.emptyNote.loadFailed}
          underStartHere={startHere}
          onHub
        />
      ) : null}

      {/* ── The hub, top to bottom: what landed, yours, the room, the doors ──
          What landed since you were last here, in a sentence or two, then
          your own work when you have some, then the channel, then a door to
          Needs you when a vote is owed (a quiet "Nothing more to vote on"
          line when none is) and one to the Workshop. See
          ./since-summary-card.tsx and ./hub-cards.tsx. */}
      {slug ? <SinceSummaryCard slug={slug} since={v.since ? v.since.baseline : 0} /> : null}
      {v.mine && v.mine.rows.length ? (
        <YourWorkCard
          rows={v.mine.rows}
          slug={slug}
          canPost={canPost}
          openKey={openRows.mine || null}
          onToggleRow={(key) => toggleRow('mine', key)}
          all={workAll}
          onAll={() => setWorkAll(!workAll)}
        />
      ) : null}
      {/* A project that is just yours has nobody to talk to yet: no channel
          card, and a Share it card at the foot instead, which is how it
          grows (./community-card.tsx ShareItCard). */}
      {slug && community?.audience !== 'solo' ? <ChannelCard slug={slug} name={app.name || slug} data={community} /> : null}
      {owesVote(v.queue)
        ? <NeedsCard queue={v.queue} canPost={canPost} onOpen={() => openTab('needs')} />
        : <NothingToVote queue={v.queue} onOpen={() => openTab('needs')} />}
      <WorkshopDoor open={v.dashboard ? v.dashboard.open : 0} filtered={!!v.meta.filtered} onOpen={() => openTab('workshop')} />
      {slug ? <ShareItCard slug={slug} name={app.name || undefined} /> : null}
      </>
      ) : null}

      {/* ── THE WORKSHOP PAGE: your work, what changed, what is open ──
          Everything that was the Workshop tab and the hub's catch-up, as one
          page behind the hub's door: your own work in full, what moved since
          your last visit filed under each week's summary, All items' numbers
          and its one line (whose head opens All items itself), and the
          approval rule every change goes through. */}
      {tab === 'workshop' ? (
      <>
      {/* ── Lately in this project ──
          What changed about the project itself — this week's card, and
          settings changed in the last week — which used to be lines in its
          channel. Only when there is something to say (./notices.tsx). */}
      {slug ? <WorkshopNotices slug={slug} /> : null}
      {/* ── Your work, in full ──
          A returning member's own work gets a pane of its own: a
          half-finished session of theirs was somewhere down inside a theme,
          under a heading about the theme. It LEADS the Workshop page: the
          hub shows its first two rows, and this is where its door goes. */}
      {v.mine && (v.mine.rows.length || v.mine.viewer) ? (
        <section className="dev-ws-strip" data-ws-mine="">
          <div className="dev-ws-head">
            <span className="dev-ws-head-title">Your work</span>
            {v.mine.count ? <span className="dev-ws-head-n">{v.mine.count}</span> : null}
          </div>
          <div className="dev-ws-lane" data-ws-lane="mine">
            {/* #2182: the strip does not leave when the viewer has nothing
                underway. It says so instead, so the pane keeps one shape
                and the place your work will appear is always the same.

                The way in is START A NEW CHANGE, by the name the Homeroom
                menu gives it. This said "start something from the + button",
                and the "+" has no propose row — starting a change is that
                menu's, an owner decision (#2740 review) — so
                the line sent a viewer to a menu that could not do what it
                promised. A read-only viewer has neither door, so is told
                the fact and nothing to press — and so is a viewer under the
                start-here banner, whose Start a new change is at the top of this
                very tab and whose board has no open item to pick up. */}
            {!v.mine.rows.length ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400" data-ws-mine-empty="">
                {actions.readOnly || startHere
                  ? 'You have no work going on.'
                  : 'You have no work going on. Pick up an open item in All items, or use Start a new change in the Homeroom menu.'}
              </p>
            ) : null}
            {/* IN FULL on the Workshop tab: the whole of your own work is
                on screen here, so nothing of it waits behind a reveal. */}
            {v.mine.rows.map((row) => (row.t === 'card' ? (
              <CardRowView
                key={row.key}
                row={row}
                slug={slug}
                canPost={canPost}
                open={openRows.mine === row.key}
                onToggle={() => toggleRow('mine', row.key)}
              />
            ) : null))}
            {/* THE SAME CONTROL AS THE OTHER TWO. This was a left-aligned
                grey pill (`gc-vote-btn`) while "Show past week" and "Show
                older" — which do the identical thing one pane up and one
                pane down — were centred muted text with a caret. Three
                spellings of one gesture. It is `.dev-ws-reveal` now, and the
                caret turns over when there is nothing left to reveal, which
                is what that class already does for the since list.
                Its hit area is `touch-target-32`, not the kit's 44px one the
                other two carry (QA 2026-09-24 Q19): it sits 4px under the
                last row, and a 44px box would take that row's bottom edge. */}

          </div>
        </section>
      ) : null}

      {/* ── Since your last visit, week by week ──
          The hub's list of what moved and the walk of weekly summaries, as
          one list (see SINCE_FIRST): each week's line, and what moved in it
          under it. A person who has not joined reads "Recently", as does a
          first visit, which has no last visit to be since. */}
      {v.since || weeks.length ? (
        <section className="dev-ws-strip" data-ws-since="">
          {/* Clear rides the far end of the heading row, as "Mark all read"
              rides the notifications sheet's title row: an action on the
              list, drawn small, and disabled rather than absent when there is
              nothing to fold so the row does not reflow. */}
          <div className="dev-ws-since-head" data-ws-since-head="">
            <span className="dev-ws-since-label">{v.since && !outsider ? 'Since your last visit' : 'Recently'}</span>
            {v.since ? (
              <>
                {/* THE WHOLE POPULATION, not the page of it that is drawn.
                    Zero says nothing: a quiet visit or a Clear shows no pill. */}
                {v.since.total > 0 ? <span className="dev-ws-since-n">{v.since.total}</span> : null}
                <button
                  type="button"
                  className="dev-ws-since-clear un-touch-target"
                  data-ws-since-clear=""
                  disabled={!v.since.rows.length && !sinceUnfolded}
                  onClick={clearSince}
                >
                  Clear
                </button>
              </>
            ) : null}
          </div>
          {v.since && v.since.rows.length ? (
            <p className="dev-ws-since-sum" data-ws-since-sum="">{sinceWords(v.since)}</p>
          ) : null}
          {v.since && !v.since.rows.length ? (
            <p className="dev-ws-week-note" data-ws-since-none="">
              Nothing has changed since you were last here.
            </p>
          ) : null}
          {weeks.slice(0, weeksOpen).map((w) => {
            const at = sinceWeekStateKey(w);
            return (
              <SinceWeekBlock
                key={at}
                week={w}
                slug={slug}
                canPost={canPost}
                openKey={openRows.since || null}
                onToggleRow={(key) => toggleRow('since', key)}
                allNew={!!sinceAllNew[at]}
                onAllNew={() => setSinceAllNew((cur) => ({ ...cur, [at]: true }))}
                seenOpen={!!sinceSeen[at]}
                onSeen={() => setSinceSeen((cur) => ({ ...cur, [at]: true }))}
              />
            );
          })}
          {/* ALWAYS DRAWN, and disabled rather than absent at the far end:
              a control that is sometimes there is one nobody learns to reach
              for. Pointing DOWN, at where the week it reveals appears. */}
          <button
            type="button"
            className="dev-ws-reveal dev-ws-since-more un-touch-target"
            data-ws-since-more=""
            disabled={weeksOpen >= weeks.length}
            onClick={() => setSinceExtra(sinceExtra + 1)}
          >
            <ChevronDownIcon className="dev-ws-reveal-chev" aria-hidden="true" />
            Show older
          </button>
          {/* The floor. `firstWeek` is the project's beginning, which the
              server names beside a complete history (#3293), so the note
              says when that was; without it, only that this is as far back
              as the list reaches, and only once somebody has walked there. */}
          {weeks.length && weeksOpen >= weeks.length && firstWeek ? (
            <p className="dev-ws-week-note" data-ws-week-start="">
              {`This project started the week of ${weekDate(firstWeek)}.`}
            </p>
          ) : null}
          {weeks.length && weeksOpen >= weeks.length && !firstWeek && sinceExtra > 0 ? (
            <p className="dev-ws-week-note" data-ws-week-end="">That is as far back as the list goes.</p>
          ) : null}
        </section>
      ) : null}

      {v.dashboard ? (
        <section
          className="dev-ws-strip"
          data-ws-dashboard=""
        >
          {/* THE HEADING IS A SENTENCE, NOT AN EYEBROW. Three all-caps
              labels and one sentence-case header were doing the same job in
              four different weights, and the caps one is the weaker of the
              two: it reads as a tag on a box rather than a name for what is
              in it. Every section on this tab wears this now, so the only
              thing that distinguishes them is what they hold. */}
          <div className="dev-ws-head">
            <span className="dev-ws-head-title">All items</span>
            <button
              type="button"
              className="dev-ws-hub-open dev-ws-head-end un-touch-target"
              data-ws-all-open=""
              onClick={() => openTab('all')}
            >
              See all
              {/* #2915: A SEARCH OR FILTER IS WAITING ON ALL ITEMS. It
                  narrows that page alone, so from here it is out of sight,
                  and this dot is what says it is still on. The dot is
                  decoration; the words join the button's name. */}
              {v.meta.filtered ? (
                <>
                  <span className="dev-ws-filter-dot" data-ws-filtered="" aria-hidden="true" />
                  <span className="sr-only"> (filtered)</span>
                </>
              ) : null}
              <ChevronRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
          <DashTiles d={v.dashboard} />
          {/* THE LEAD PARAGRAPH. It was the first card of the week walk,
              titled "Open issues" — so the pane's one always-visible
              sentence lived inside a control about history, and the button
              under it opened on This week. It is not a window; it does not
              sit in a list of windows. The derived sentence is still the
              fallback for a board that has never had a line written for it
              — see summarise(). */}
          {/* PRECEDENCE, unchanged from when this was the walk's first card:
              the model's own line, then the flattened paragraph a row
              written under the previous prompt still holds, then the
              sentence derived from the counts. The fallbacks only apply
              when there is NO walk — a board whose `open` window is empty
              but whose weeks are not has a summary already, and dropping
              the paragraph in above it would state the same thing twice. */}
          {v.dashboard.openLine || (!v.dashboard.weeks.length && summarise(v.dashboard)) ? (
            <>
              {/* THE HEADING THE WALK'S FIRST CARD USED TO WEAR. It was
                  titled "Open issues" while it was a window in the walk;
                  promoting the line to a paragraph dropped the title with
                  it, and left the pane's one always-visible sentence with
                  nothing saying what it is about.

                  A HEADING, not a prose prefix. The model's line is written
                  to stand alone at about twelve words, so "Open items
                  include …" in front of it produces a sentence with two
                  subjects. It also puts this block in the same shape as the
                  windows below — a heading, then its line — while its
                  missing rule and missing dates keep it from reading as one
                  of them. */}
              <div className="dev-ws-lead-head">
                <span className="dev-ws-lead-title">Open items</span>
              </div>
              <p className="dev-ws-open-line" data-ws-open-line="">
                {v.dashboard.openLine || summarise(v.dashboard)}
              </p>
              {/* The note belongs to whichever sentence is on screen, and
                  with no walk below there is nothing else to hang it on.
                  This is the very case it exists for: "no draft yet" and
                  "the call keeps failing" both leave the derived sentence up
                  there and are otherwise indistinguishable. */}

            </>
          ) : null}
          {/* Why the lines are what they are, when something is wrong with
              them: no draft yet, or the call keeps failing. It rode the
              walk while there was one; it is about every line on the page. */}
          {digestNote(v.meta, !!(v.dashboard.cards || v.dashboard.summary)) ? (
            <p className="dev-ws-digest-note" data-ws-digest-note="">
              {digestNote(v.meta, !!(v.dashboard.cards || v.dashboard.summary))}
            </p>
          ) : null}
          {/* THE WEEKS ARE NOT HERE ANY MORE. They were a walk under this
              paragraph ("Show past week"), and Since your last visit was a
              list on the hub: one question in two places. Each week's line
              heads what moved in it now, in the since list above. */}
        </section>
      ) : null}

      {/* ── Approval rules: how a change gets in ──
          The last thing on the page, under the work it governs. It was the
          hero's last line. */}
      {slug ? <ApprovalRules slug={slug} /> : null}
      </>
      ) : null}

      {tab === 'needs' ? (
        <NeedsFeed
          rows={v.queue}
          total={v.votes.total}
          models={v.models}
          slug={slug}
          canPost={canPost}
          onDone={() => openTab('status')}
        />
      ) : null}
      {/* WHENEVER THE TAB IS UP, not only while there is a theme to draw. This
          was `tab === 'all' && themes.length`, and the second half was #2090:
          a search that matched nothing emptied `themes`, the whole pane went
          with them, and the search box — a node of the toolbar the pane's
          head renders — was gone before it could be cleared. The pane is the
          tab; its body is what may be empty (see EmptyNote). */}
      {tab === 'all' ? (
        <>
          {/* ── The two ways to read the same board ──────────────────────
              The eyebrow here used to say "12 categories" and nothing else:
              a count of a grouping the viewer had no say in. The grouping is
              a CHOICE, so it is a control. "By stage" is not a second board
              — it renders the very same <DevKanban/> the Board view mode
              does, from the same published view model (../card/cards-store),
              nested under the summary rather than replacing it. Everything
              above stays put under either tab, which is the whole point:
              the tiles, the three summary lines, the votes waiting on you
              and the general discussion are facts about the app, not about
              how you happen to be sorting it. */}
          <section className="dev-ws-pane" data-ws-pane="">
          {/* ── The sticky head: the controls that act on what is below ──
              The search and the filters used to sit in the frame's chrome
              above the scroller, two strips away from the list they narrow.
              (So did the "+", which is not a narrowing control: it adds to
              the board and manages the app, so it is the hub's ⋯ now.) They
              belong WITH the list — and with the back bar, because
              "which grouping" and "narrowed to what" are one question asked
              twice. Both pin together: filtering a long list is exactly what
              you are doing when you are scrolled down, and a bar that
              scrolled away would leave no way back.

              THE TABS LEAD, and the order is the argument: they decide what
              the search is searching. With the search above them the control
              that sets the scope sat under the control that acts within it,
              and the pane had to be read bottom-up to be understood. Leading
              with the switch also gives the head a title bar — the two-state
              choice, then the tools for whichever state you picked. */}
          <div className="dev-ws-pane-head">
          {/* THE EAR, on a wide window: the grouping strip on its own surface
              at the pane's top-right corner, level with the tab pill.

              A CHILD OF THE HEAD, not of the pane, and that is what makes it
              travel. The head PINS while the list scrolls under it, and the
              ear hangs off the head's top edge (`bottom: 100%`) — so an ear
              anchored to the pane would have scrolled away and left the
              pinned controls with their own grouping tabs gone. The head is
              positioned, so it is the containing block; unscrolled, its top
              edge IS the pane's top edge, which is why this reads exactly as
              it did when the pane owned it.

              Rendered only when it is up, so the strip below is the same one
              node moved rather than a second copy of it. */}
          {earUp ? (
            <div className="dev-ws-ear" data-ws-ear="">
              <GroupStrip group={group} />
            </div>
          ) : null}
          {/* NO TITLE LINE HERE. The head used to open with an "All items"
              eyebrow, on the argument that the tabs named the CHOICE without
              naming what the choice was being made about. The selected TAB
              says it — it is the thing reading "All items", right above this
              — so the eyebrow was the same word twice, one line apart, and
              the head now leads with the tools. */}
          {/* The strip's narrow home. Above the breakpoint it is in the ear
              instead — one node, two places. */}
          {earUp ? null : <GroupStrip group={group} />}
            {/* The search and the filters. NOT the ⋯: that is the hub's, in
                its hero, so the row draws none of its own. */}
            <DevActionsRow
              illustrationApp={actions.illustrationApp}
              canManageIllustration={actions.canManageIllustration}
              selfHosted={actions.selfHosted}
              readOnly={actions.readOnly}
              canCollaborate={actions.canCollaborate}
              showsMembers={actions.showsMembers}
              withPlus={false}
            />
          </div>
          {/* The pane's face is painted by its two PARTS, not by the pane —
              see app.css. A fill on the pane with a second one on the sticky
              head stacked 50% on 50% and drew a lighter band across the
              controls; giving head and body the same fill on the same
              backdrop makes them the same colour by construction. */}
          <div className="dev-ws-pane-body">
          {group === 'stage' ? (
            <div className="dev-ws-board" data-ws-stage="">
              <DevKanban />
            </div>
          ) : !themes.length ? (
            /* The rows' place, under the controls that emptied it. `filtered`
               is the live filter state rather than `emptyNote`'s: that note
               is about the BOARD having no entries, and a board whose every
               open item a search has hidden still has them, so it stays null
               while the theme list is bare. The stage pane needs none of
               this — the columns say "No matching cards" for themselves. */
            <EmptyNote filtered={v.meta.filtered} loadFailed={!!(v.emptyNote && v.emptyNote.loadFailed)} />
          ) : (
          <>
          <div className="dev-ws-sort">
            {groupingNote ? <span className="dev-ws-eyebrow">{groupingNote}</span> : null}
            <div className="dev-ws-sort-opts" role="group" aria-label="Order categories">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className="dev-ws-chip"
                  aria-pressed={sortKey === s.key}
                  onClick={() => { if (s.key !== sortKey) captureThemeTops(); setSortKey(s.key); }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="dev-ws-themes" ref={themesRef}>
            {themes.map((t) => (
              <ThemeCard
                key={t.id}
                theme={t}
                slug={slug}
                canPost={canPost}
                open={isOpen(t.id)}
                onToggle={() => toggleTheme(t.id)}
                openKey={openRows[t.id] || null}
                onToggleRow={(key) => toggleRow(t.id, key)}
              />
            ))}
          </div>
          {/* Four honest states for the fallback, because the first cut said
              "once an AI model is available" while the model was mid-draft —
              and, on the model's grouping, when it was drafted and how much
              of the board it holds. */}
          <div className="dev-ws-foot-note">
            {v.meta.source === 'ai'
              ? aiFootnote(v.meta, !!(v.dashboard && (v.dashboard.cards || v.dashboard.summary)))
              : v.meta.source === 'demo'
                ? 'Staging demo grouping: in production the categories are drafted by the model from the board.'
                : v.meta.pending
                  ? 'Categories are being drafted from the board now. They replace this grouping when they land.'
                  : v.meta.lastError
                    ? `The last attempt to draft categories failed (${v.meta.lastError}). Items stay grouped by the categories the group has voted for until the next attempt.`
                    : 'No AI model is configured, so items are grouped by the categories the group has voted for.'}
          </div>
          </>
          )}
          </div>
          </section>
        </>
      ) : null}


      </div>
    </div>
  );
}
