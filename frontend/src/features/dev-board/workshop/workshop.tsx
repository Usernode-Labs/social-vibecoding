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

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from '@/components/ui/icons';

import { agoStamp } from '../../../lib/timestamp';
import { useStoreState } from '../../../lib/use-store-state';
import { devWorkshopStore } from '../card/cards-store';
import { DevCard } from '../card/dev-card';
import { DevKanban } from '../card/dev-kanban';
import { DevActionsRow } from '../actions-row';
import { useDevActions } from '../actions-store';
import { CardRowView, callAppView } from '../card/fold';
import type { DevWorkshopView, WorkshopTheme } from '../card/model';
import { CardSkeleton } from '../card/skeleton';
import { ProgressRing } from '@/components/ui/progress-ring';
import { useWorkshopGroup } from './group-mode-store';

type SortKey = 'people' | 'activity' | 'open';

/** The swatch a name gets everywhere (feed-thread's rule, kept in step). */
function swatchFor(name: string): string {
  const palette = ['#0a6ee0', '#8e44ad', '#1f8a4c', '#b4620a', '#c0392b', '#0e7c86', '#6d4c41'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
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
  // Which paragraph is at the top of the page. Without this the two states
  // are indistinguishable on screen — a model that has never run and one
  // whose call is failing both leave the derived sentence up there, and the
  // only way to tell was to read the database.
  if (written) {
    parts.push('The summary at the top was written by the model on the same pass.');
  } else if (meta.digestError) {
    // The failure that used to be a log line and a day of silence. Naming
    // it here is what turned "could something be up with the summarizer?"
    // from a question about the database into one the page answers.
    parts.push(`The model\u2019s summary could not be written (${meta.digestError}); it is retried within the hour, and the sentence at the top is worked out from the board meanwhile.`);
  } else {
    parts.push('The summary at the top is worked out from the board; the model writes one on the next pass.');
  }
  const c = meta.coverage;
  if (c && c.pending) parts.push(`${c.pending} new ${c.pending === 1 ? 'card is' : 'cards are'} being placed.`);
  if (c && c.unplaced) {
    parts.push(`${c.unplaced} ${c.unplaced === 1 ? 'card did' : 'cards did'} not fit a category and ${c.unplaced === 1 ? 'waits' : 'wait'} for the next draft.`);
  }
  if (meta.lastError) parts.push(`The last attempt failed (${meta.lastError}); it is retried shortly.`);
  return parts.join(' ');
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
 * call failed. Same relationship the category grouping has to the themes.
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
function DashTiles({ d }: { d: Dash }): ReactNode {
  const cells: { key: string; n: number; label: string; cls?: string; title?: string }[] = [
    { key: 'open', n: d.open, label: d.open === 1 ? 'open item' : 'open items' },
    {
      key: 'shipped',
      n: d.shippedWeek,
      label: 'shipped this week',
      cls: d.shippedWeek ? 'dev-ws-dash-good' : undefined,
      title: d.partial ? 'At least this many: the merged history is longer than the page loaded.' : undefined,
    },
    {
      key: 'votes',
      n: d.votesWaiting,
      label: d.votesWaiting === 1 ? 'waiting on a vote' : 'waiting on votes',
      cls: d.votesWaiting ? 'dev-ws-dash-warn' : undefined,
    },
    { key: 'unclaimed', n: d.unclaimed, label: 'with nobody on them' },
  ];
  return (
    <div className="dev-ws-dash" data-ws-dash="">
      {cells.map((c) => (
        <span
          key={c.key}
          className={c.cls ? `dev-ws-dash-cell ${c.cls}` : 'dev-ws-dash-cell'}
          data-ws-dash-cell={c.key}
          title={c.title}
        >
          <b>{c.key === 'shipped' && d.partial && c.n ? `${c.n}+` : c.n}</b>
          {c.label}
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
/** "Aug 25 – Aug 31" for a window whose `endMs` is the Monday after it. */
function weekRange(startMs: number, endMs: number): string {
  const fmt = (ms: number) => new Date(ms)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  // `endMs` is EXCLUSIVE — the next Monday — so the caption names the Sunday
  // before it. Captioning a Monday–Sunday week with two Mondays is the kind
  // of off-by-one a reader notices and cannot explain.
  return `${fmt(startMs)} – ${fmt(endMs - 86400000)}`;
}

/**
 * The weeks, as a walk backwards from now.
 *
 * All three windows used to be drawn at once, and three was the whole
 * history the lander could hold: a reader who wanted the week before last
 * had nowhere to go, and a reader who wanted none of them still paid three
 * cards of vertical space before reaching the board.
 *
 * So the present is the default — `Open`, the one entry that is not a week
 * at all — and everything earlier is one step behind a button. Each press
 * reveals the next-oldest window ABOVE the stack, which keeps the column in
 * the order a timeline is read (oldest at the top, now at the bottom) and
 * keeps the thing you came for at the same place on the screen however far
 * back you have walked.
 *
 * The walk ends where the server's lines end. When the server has also said
 * when the app's first week was (`firstWeek`) and the walk has reached it,
 * the pane says so — otherwise running out of lines is silent, because "no
 * more written yet" and "no more to write" are different facts and only one
 * of them is the app's beginning.
 */
function WeekWalk({ weeks, firstWeek }: { weeks: Dash['weeks']; firstWeek: number | null }): ReactNode {
  // How many entries from the END of the list are on screen. The list is
  // oldest-first, so one means `open` alone.
  const [shown, setShown] = useState(1);
  if (!weeks.length) return null;
  const drawn = weeks.slice(Math.max(0, weeks.length - shown));
  const more = weeks.length - drawn.length;
  const oldest = drawn[0];
  const atStart = !more && !!firstWeek && !!oldest && oldest.startMs === firstWeek;
  return (
    <div className="dev-ws-cards" data-ws-cards="">
      {more ? (
        <button
          type="button"
          className="dev-ws-week-more"
          data-ws-week-more=""
          onClick={() => setShown(shown + 1)}
        >
          {/* Pointing UP, because that is where the window it reveals
              appears. It is `ChevronDownIcon` turned over in CSS — the same
              trick `.dev-ws-lane-title > .dev-ws-chev` already uses — rather
              than a 22nd icon for one caret. */}
          <ChevronDownIcon className="dev-ws-week-chev" aria-hidden="true" />
          Show past week
        </button>
      ) : null}
      {atStart ? (
        <p className="dev-ws-week-note" data-ws-week-start="">The first week this app had any activity.</p>
      ) : null}
      {drawn.map((w) => (
        <article key={w.key} className="dev-ws-card" data-ws-card={w.key}>
          <h4 className="dev-ws-card-title">
            {w.title}
            {/* The dates only where the NAME stops being one. "This week" and
                "Last week" are unambiguous to anyone reading them on the day;
                "4 weeks ago" is a count the reader would otherwise have to do
                the arithmetic for. */}
            {w.startMs && w.key.startsWith('week:')
              ? <span className="dev-ws-card-range">{weekRange(w.startMs, w.endMs)}</span>
              : null}
          </h4>
          <p className="dev-ws-card-line">{w.line}</p>
        </article>
      ))}
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
  return bits.length ? bits.join(', ') : `${s.rows.length} things moved`;
}

/**
 * The vote badge: a ring, beside the heading whose lane it counts.
 *
 * It was "4 to vote on" in the warning tint, which stated a debt. The ring
 * says the same population as PROGRESS — how many of the app's open
 * proposals this viewer has answered — using the primitive the home
 * screen's Challenges block uses.
 *
 * A ring alone is a fraction with no subject: "0/5" does not say what the
 * five are, and a reader should not have to hover a donut to find out. So
 * the words are still there — as the LANE'S NOTE (`voteWords` below), in
 * the place "Free to take, if you want to try solving an issue." occupies
 * one lane down. Both lanes then have the same shape: a heading, a line
 * saying what the lane is offering, and the deck. The ring and the words
 * used to sit together up in the strip head, which put the subject of one
 * lane above a heading that belonged to both.
 *
 * There is no × any more. A count that can be closed is a count somebody
 * stops seeing while it is still true, and this one is the whole reason the
 * pane exists.
 */
function voteWords(owed: number): string {
  return `${owed} ${owed === 1 ? 'proposal needs' : 'proposals need'} your vote`;
}

function VoteRing({ owed, total }: { owed: number; total: number }): ReactNode {
  const done = Math.max(0, total - owed);
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <ProgressRing
      className="dev-ws-vote-ring"
      pct={pct}
      label={`${done}/${total}`}
      title={`${done} of ${total} open proposals voted on`}
      arcClassName={owed ? 'stroke-amber-500' : 'stroke-emerald-500'}
    />
  );
}

/**
 * One offer at a time, paged sideways.
 *
 * "Needs your vote" and "Nobody has picked this up" were vertical lists with
 * a "N more" button under each, so a viewer owing four votes read a column
 * four cards tall before reaching anything else — and the pane's whole claim
 * is that it holds what you could do in five minutes, which is ONE thing.
 * Paged, the strip is a constant height whatever it holds, and the count is
 * in the control rather than in the scroll.
 *
 * It is a real horizontal SCROLLER, not a swap of one rendered row:
 *
 *   - every row stays in the DOM, so the two legacy fillers keep finding
 *     their hosts (`_wireFeedComments` observes `.dev-feed-comments` and
 *     `_fillKudosHosts` fills `[data-kudos-host]`) and the `?shot=` deep
 *     link can still name a row that is not the visible one;
 *   - a touch drag pages it for free, with `scroll-snap`, which is the
 *     gesture the surface already invites on a phone.
 *
 * The buttons drive `scrollTo` and the index is read back from the scroll
 * position, so a swipe and a press cannot disagree about which card is up.
 */
function RowPager({
  rows, scope, title, titleExtra, note, slug, canPost, openKey, onToggle,
}: {
  rows: DevWorkshopView['votes']['rows'];
  scope: string;
  /** The lane's heading. The pager owns it, because the control rides it. */
  title: string;
  /** A badge that belongs to the heading itself, after the words. */
  titleExtra?: ReactNode;
  /** The line under the heading, where a lane has one. */
  note?: string;
  slug: string;
  canPost: boolean;
  openKey: string;
  onToggle: (key: string) => void;
}): ReactNode {
  const trackRef = useRef<HTMLDivElement>(null);
  const [i, setI] = useState(0);
  const cards = rows.filter((r) => r.t === 'card');
  if (!cards.length) return null;
  const go = (n: number) => {
    const t = trackRef.current;
    const at = Math.max(0, Math.min(cards.length - 1, n));
    setI(at);
    if (t) t.scrollTo({ left: at * t.clientWidth, behavior: 'smooth' });
  };
  const onScroll = () => {
    const t = trackRef.current;
    if (!t || !t.clientWidth) return;
    const at = Math.round(t.scrollLeft / t.clientWidth);
    if (at !== i) setI(Math.max(0, Math.min(cards.length - 1, at)));
  };
  return (
    <>
      {/* The control rides the HEADING, not the space under the deck. Below
          the card it was a free-floating row of three small things with a
          card above and a heading below, belonging to neither; on the
          heading it is plainly the control FOR this lane, and the deck and
          the lane under it stay one block. */}
      <div className="dev-ws-lane-head">
        <h4 className="dev-ws-lane-title">
          <span className="dev-ws-dot" aria-hidden="true"></span>{title}
          {titleExtra}
        </h4>
        {cards.length > 1 ? (
          <div className="dev-ws-pager-ctl" data-ws-pager-ctl="">
            <button
              type="button"
              className="dev-ws-pager-btn"
              aria-label="Previous"
              disabled={i === 0}
              onClick={() => go(i - 1)}
            ><ChevronLeftIcon className="dev-ws-pager-chev" aria-hidden="true" /></button>
            <span className="dev-ws-pager-n">{`${Math.min(i + 1, cards.length)} of ${cards.length}`}</span>
            <button
              type="button"
              className="dev-ws-pager-btn"
              aria-label="Next"
              disabled={i >= cards.length - 1}
              onClick={() => go(i + 1)}
            ><ChevronRightIcon className="dev-ws-pager-chev" aria-hidden="true" /></button>
          </div>
        ) : null}
      </div>
      {note ? <p className="dev-ws-lane-note">{note}</p> : null}
      <div className="dev-ws-pager" data-ws-pager={scope}>
        <div className="dev-ws-pager-track" ref={trackRef} onScroll={onScroll}>
          {cards.map((row) => (
            <div className="dev-ws-pager-item" key={row.key}>
              <CardRowView
                row={row}
                slug={slug}
                canPost={canPost}
                open={openKey === row.key}
                onToggle={() => onToggle(row.key)}
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export function DevWorkshop(): ReactNode {
  const v = useStoreState(devWorkshopStore);
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
  const [sinceOpen, setSinceOpen] = useState(false);
  // "N more of yours" reveals them HERE. It used to set a board filter and
  // navigate, which left the lander and changed the view mode to read a list
  // the strip was already showing the top of. The vote and free-to-take
  // lanes had the same toggle and no longer need one: they are paged decks
  // now (RowPager), which hold every row without a reveal.
  const [allMine, setAllMine] = useState(false);
  // Which pane is under the tabs. Lives in a module-global store rather than
  // here, because app-view.js has to read it: `_rerenderWorkshop()` publishes
  // the kanban view model only when the stage pane is up. See
  // ./group-mode-store.ts.
  const group = useWorkshopGroup();
  // The toolbar's props reach this root through a store, not a prop — the
  // Workshop is a separate React root from the frame that receives them. See
  // ../actions-store.ts.
  const actions = useDevActions();

  const themes = useMemo(() => sortThemes(v.themes, sortKey), [v.themes, sortKey]);
  // Named categories only — "Not yet grouped" is a holding pen, not one of
  // them. Counted here so the label can agree with itself: it read
  // "1 themes" before, which is the kind of thing a reader trusts a screen
  // slightly less for.
  const countOfThemes = themes.filter((t) => !t.ungrouped).length;
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
  const openSig = Object.values(openRows).join('|') + (sinceOpen ? '|since' : '');
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    callAppView('_wireFeedComments', host);
    callAppView('_fillKudosHosts', host);
  }, [openSig, v]);

  if (v.loading) return <div ref={hostRef}><CardSkeleton n={4} label="Loading the workshop" /></div>;
  const nextUp = v.nextUp && v.nextUp.t === 'card' ? v.nextUp : null;
  const slug = v.slug || '';
  const canPost = !!v.canPost;

  return (
    <div ref={hostRef} className="dev-ws">
      {v.emptyNote ? (
        <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
          {v.emptyNote.filtered ? (
            'Nothing here matches the current search and filters.'
          ) : (
            <>
              {v.emptyNote.loadFailed ? "Couldn't load open issues right now. " : ''}
              {'Nothing on the board yet. Press '}
              <span className="font-medium text-violet-700 dark:text-violet-400">+</span>
              {' to propose a change or file an issue.'}
            </>
          )}
        </div>
      ) : null}

      {/* ── One pane: where the app is, and what moved while you were away ──
          These were two strips asking one question. The description leads —
          the app says what it is about the way a theme does — and the personal
          line sits under it, because "what changed for me" only means anything
          against "what this is". Both hooks ride on the one section now. */}
      {v.dashboard ? (
        <section
          className="dev-ws-strip"
          data-ws-dashboard=""
        >
          <div className="dev-ws-strip-head">
            <span className="dev-ws-eyebrow">Where the app is</span>
            {v.since && v.since.shipped
              ? <span className="dev-ws-pill dev-ws-pill-good">{`${v.since.shipped} shipped since`}</span>
              : null}
          </div>
          <DashTiles d={v.dashboard} />
          {/* The weeks, newest on screen and the rest one press away. The
              derived sentence is still the fallback for a board that has
              never had a line written for it — see summarise(). */}
          {v.dashboard.weeks.length
            ? <WeekWalk weeks={v.dashboard.weeks} firstWeek={v.dashboard.firstWeek} />
            : summarise(v.dashboard)
              ? <p className="dev-ws-strip-text">{summarise(v.dashboard)}</p>
              : null}
          {/* "Since your last visit" used to sit here, under the numbers.
              It moved into "What needs you" (below): it is not a fact about
              the app, it is a list of things addressed to THIS reader, which
              is what that pane is for. */}
        </section>
      ) : null}

      {/* ── Yours, first ──
          The first question a returning member has is about their OWN work,
          and the lander answered every other one before it: what the app is
          doing, what the group needs, what nobody has picked up. A
          half-finished session of theirs was somewhere down inside a theme,
          under a heading about the theme. */}
      {v.mine && v.mine.rows.length ? (
        <section className="dev-ws-strip" data-ws-mine="">
          <div className="dev-ws-strip-head">
            <span className="dev-ws-eyebrow">What you are working on</span>
          </div>
          <div className="dev-ws-lane" data-ws-lane="mine">
            {(allMine ? v.mine.rows : v.mine.rows.slice(0, v.mine.shown)).map((row) => (row.t === 'card' ? (
              <CardRowView
                key={row.key}
                row={row}
                slug={slug}
                canPost={canPost}
                open={openRows.mine === row.key}
                onToggle={() => toggleRow('mine', row.key)}
              />
            ) : null))}
            {v.mine.rows.length > v.mine.shown ? (
              <button
                type="button"
                className="gc-vote-btn dev-ws-lane-btn"
                aria-expanded={allMine}
                data-ws-mine-more=""
                onClick={() => setAllMine(!allMine)}
              >
                {allMine ? 'Show fewer' : `${v.mine.count - v.mine.shown} more of yours`}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── One pane: what needs a person ──
          Voting on somebody else's work and picking up nobody's are the same
          offer — "here is what you could do with five minutes" — and they were
          two containers saying it twice. */}
      {v.votes.rows.length || nextUp || v.since ? (
        <section
          className="dev-ws-strip"
          data-ws-votes=""
          data-ws-next={nextUp ? '' : undefined}
          data-ws-since={v.since ? '' : undefined}
        >
          {/* The eyebrow alone. The ring and its sentence used to sit here,
              which put one lane's subject above a heading that covers two —
              they are the vote lane's, and they live on it now. */}
          <div className="dev-ws-strip-head">
            <span className="dev-ws-eyebrow">What needs you</span>
          </div>
          {v.votes.rows.length ? (
            <div className="dev-ws-lane" data-ws-lane="votes">
              {/* Paged, not listed — and paged over EVERY owed row, so the
                  "N more waiting on you" toggle that used to sit under the
                  first three is gone: the control beside the heading already
                  says how many there are and is the way to reach them. */}
              <RowPager
                rows={v.votes.rows}
                scope="votes"
                title="Needs your vote"
                titleExtra={v.votes.total
                  ? <VoteRing owed={v.votes.count} total={v.votes.total} />
                  : null}
                note={v.votes.count ? voteWords(v.votes.count) : undefined}
                slug={slug}
                canPost={canPost}
                openKey={openRows.votes || ''}
                onToggle={(key) => toggleRow('votes', key)}
              />
            </div>
          ) : null}
          {nextUp ? (
            <div className="dev-ws-lane" data-ws-lane="next">
              {/* The heading states the fact; the line under it makes the
                  offer. "Why not give it a try?" did both at once and coaxed
                  while it did — a lander does not need to wheedle. Both are
                  the pager's to draw now, because the paging control sits on
                  the heading row.

                  The suggestion is the first card, then the rest of the
                  free-to-take issues — one deck rather than a card plus a
                  "Show N more" list under it (#1934's reveal, turned
                  sideways). */}
              <RowPager
                rows={[nextUp, ...(v.nextMore || [])]}
                scope="next"
                title="Nobody has picked this up"
                note="Free to take, if you want to try solving an issue."
                slug={slug}
                canPost={canPost}
                openKey={openRows.next || ''}
                onToggle={(key) => toggleRow('next', key)}
              />
            </div>
          ) : null}
          {/* ── What moved while you were away ──
              This was a line under the tiles in the pane above, which is
              where it was first written and the wrong place for it: the
              dashboard answers "what is this app", and a list of things that
              changed for YOU is the same kind of thing as a vote you owe.
              It sits under the offers, folded, because it is the one item
              here that is a record rather than a request. */}
          {v.since ? (
            <div className="dev-ws-lane" data-ws-lane="since">
              <button
                type="button"
                className="dev-ws-since-btn"
                data-ws-since-btn=""
                aria-expanded={sinceOpen}
                disabled={!v.since.rows.length}
                onClick={() => setSinceOpen(!sinceOpen)}
              >
                {`Since your last visit, ${relTime(v.since.baseline)}: ${sinceWords(v.since)}`}
                {v.since.rows.length
                  ? <span className="dev-ws-since-n">{sinceOpen ? 'Hide' : `Show ${v.since.rows.length}`}</span>
                  : null}
              </button>
              {sinceOpen ? v.since.rows.map((row) => (row.t === 'card' ? (
                <CardRowView
                  key={row.key}
                  row={row}
                  slug={slug}
                  canPost={canPost}
                  open={openRows.since === row.key}
                  onToggle={() => toggleRow('since', row.key)}
                />
              ) : null)) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {v.discussion && v.discussion.t === 'card' ? (
        <div className="dev-ws-discussion"><DevCard model={v.discussion.card} /></div>
      ) : null}

      {themes.length ? (
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
              The search, the filters and the "+" used to sit in the frame's
              chrome above the scroller, two strips away from the list they
              narrow. They belong WITH it — and with the tab strip, because
              "which grouping" and "narrowed to what" are one question asked
              twice. Both pin together: filtering a long list is exactly what
              you are doing when you are scrolled down, and a tab strip that
              scrolled away would leave no way back to the other pane.

              THE TABS LEAD, and the order is the argument: they decide what
              the search is searching. With the search above them the control
              that sets the scope sat under the control that acts within it,
              and the pane had to be read bottom-up to be understood. Leading
              with the switch also gives the head a title bar — the two-state
              choice, then the tools for whichever state you picked. */}
          <div className="dev-ws-pane-head">
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
            <DevActionsRow
              illustrationApp={actions.illustrationApp}
              canManageIllustration={actions.canManageIllustration}
              selfHosted={actions.selfHosted}
              readOnly={actions.readOnly}
              canCollaborate={actions.canCollaborate}
              showsMembers={actions.showsMembers}
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
          ) : (
          <>
          <div className="dev-ws-sort">
            <span className="dev-ws-eyebrow">
              {`${countOfThemes} ${countOfThemes === 1 ? 'category' : 'categories'}`}
              {v.meta.source === 'category' ? ' · grouped by category for now' : ''}
              {v.meta.source === 'demo' ? ' · staging demo grouping' : ''}
              {v.meta.pending
                ? (v.meta.pendingStage === 'placement'
                  ? ' · placing new cards…'
                  : (v.meta.source === 'ai' ? ' · re-drafting categories…' : ' · drafting categories…'))
                : ''}
            </span>
            <div className="dev-ws-sort-opts" role="group" aria-label="Order categories">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className="dev-ws-chip"
                  aria-pressed={sortKey === s.key}
                  onClick={() => setSortKey(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="dev-ws-themes">
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
                    ? `The last attempt to draft categories failed (${v.meta.lastError}). Items stay grouped by their voted category until the next attempt.`
                    : 'No AI model is configured, so items are grouped by their voted category.'}
          </div>
          </>
          )}
          </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
