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
 * every row unfolded is the stream this replaced.
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
 * Opening a card full-screen is the delegated `#dev-body` handler's, exactly
 * as on the Board: the unfolded card carries its `data-issue-row` /
 * `data-proposal-row` hooks and the compact row deliberately does not.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ChevronRightIcon } from '@/components/ui/icons';

import { useStoreState } from '../../../lib/use-store-state';
import { devWorkshopStore } from '../card/cards-store';
import { Badge, CardIcon, DevCard, VoteButton } from '../card/dev-card';
import type { ActionSpec, BadgeSpec } from '../card/model';
import { FeedThread } from '../card/feed-thread';
import type { DevCardModel, DevWorkshopView, ListRow, WorkshopTheme } from '../card/model';
import { CardSkeleton } from '../card/skeleton';

type CardRow = Extract<ListRow, { t: 'card' }>;
type SortKey = 'people' | 'activity' | 'open';

/** The swatch a name gets everywhere (feed-thread's rule, kept in step). */
function swatchFor(name: string): string {
  const palette = ['#0a6ee0', '#8e44ad', '#1f8a4c', '#b4620a', '#c0392b', '#0e7c86', '#6d4c41'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function relTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 90) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function callAppView(fn: string, ...args: unknown[]): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn](...args);
}

/**
 * Where "Open" leads: the card's own full-screen route, read off the hooks
 * the delegated handler reads, so the two can never disagree.
 */
function openHref(slug: string, card: DevCardModel): string | null {
  const a = card.attrs || {};
  if (!slug) return null;
  if (a['data-issue-row']) return `#app/${slug}/dev/issues/${a['data-issue-row']}`;
  if (a['data-proposal-row']) return `#app/${slug}/dev/proposals/${a['data-proposal-row']}`;
  if (a['data-gov-row']) return `#app/${slug}/dev/governance/${a['data-gov-row']}`;
  if (a['data-shared-session-row']) return `#app/${slug}/dev/shared/${a['data-shared-session-row']}`;
  if (a['data-session-chip']) return `#app/${slug}/dev/sessions/${a['data-session-chip']}`;
  return null;
}

/** The `#N` from the meta line, when the card has one. */
function numberOf(card: DevCardModel): string | null {
  for (const m of card.meta) {
    if (m.t === 'link' && /^#\d+$/.test(m.s)) return m.s;
  }
  return null;
}

/** The author from the meta line: the first plain text part. */
function authorOf(card: DevCardModel): string | null {
  for (const m of card.meta) if (m.t === 'text') return m.s;
  return null;
}

/** How many of the card's own chips ride along on a folded row. */
const ROW_BADGE_MAX = 3;

/**
 * The folded row's status band — a MINI of the dense card's own
 * (`.dev-card-badges.dev-card-status`), built from the same two model fields,
 * and clipped to one line for the same reason: a band that wrapped would push
 * every row under it out of rhythm.
 *
 * The composite pill used to be flattened to `pill.state.label` and printed in
 * `.dev-ws-row-meta`, in the same muted grey the author's name wears — so
 * "Conflicts with main · 9 files", which is the one fact that decides whether
 * a proposal can merge at all, read like a byline. It has carried a `tone` all
 * along; this spends it.
 *
 * A `chipBtn` is rendered as a plain `chip`. The row's whole surface is the
 * disclosure, and a chip that swallowed the click to do something else would
 * make the card open sometimes and not others; the real control is still on
 * the card, one tap away.
 */
function flatBadge(b: BadgeSpec): BadgeSpec {
  return b.t === 'chipBtn'
    ? { t: 'chip', key: b.key, cls: b.cls, label: b.label, title: b.title, spinner: b.spinner, data: b.data }
    : b;
}

function RowBand({ card }: { card: DevCardModel }): ReactNode {
  const s = card.pill?.state || null;
  const linked = card.linked || [];
  const chips = (card.badges || []).filter(Boolean).slice(0, ROW_BADGE_MAX);
  if (!s && !linked.length && !chips.length) return null;
  return (
    <span className="dev-ws-row-band">
      {s ? (
        <span className={`dev-ws-row-state dev-ws-row-state-${s.tone}`} title={s.title}>{s.label}</span>
      ) : null}
      {linked.map((b) => <Badge key={b.key} b={flatBadge(b)} />)}
      {chips.map((b) => <Badge key={b.key} b={flatBadge(b)} />)}
    </span>
  );
}

/**
 * One folded row: a disclosure, and one that carries NO `data-issue-row`,
 * so the delegated card-open handler never mistakes it for a card.
 *
 * A `div` with the button role rather than a `<button>`, because the vote
 * strip's rows carry the card's Vote button INSIDE them (`trailing`), and
 * a button cannot contain a button. The trailing control stops its clicks
 * from reaching the row; Enter and Space on the row itself toggle it.
 */
function FoldedRow({
  row, open, onToggle,
}: { row: CardRow; open: boolean; onToggle: () => void }): ReactNode {
  const c = row.card;
  const n = numberOf(c);
  const by = authorOf(c);
  // The vote control belongs to the ROW, on every row that has one — not just
  // the ones in the vote strip. It used to ride in the dense card's status
  // band for a row inside a theme, which meant opening that row moved the
  // control from nowhere to somewhere while "Closes #N" moved the other way:
  // two objects, which is what this stops being. Now the head is identical
  // folded and open, and nothing travels.
  const specs = voteSpecs(c);
  const trailing = specs ? <VoteButton yes={specs.yes} no={specs.no} /> : null;
  return (
    <div
      role="button"
      tabIndex={0}
      className={open ? 'dev-ws-row dev-ws-row-open' : 'dev-ws-row'}
      aria-expanded={open}
      data-ws-row={row.key}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
      }}
    >
      {c.icon ? <CardIcon spec={{ ...c.icon, small: true }} /> : null}
      <span className="dev-ws-row-main">
        <span className="dev-ws-row-title">
          {c.title.text}
          {row.fresh ? <span className="dev-ws-new">new</span> : null}
          {row.placing ? <span className="dev-ws-placing" title="Being placed into a theme">placing…</span> : null}
        </span>
        <span className="dev-ws-row-meta">
          {n ? <span className="font-mono">{n}</span> : null}
          {by ? <span>{by}</span> : null}
        </span>
        <RowBand card={c} />
      </span>
      {c.chatCount ? <span className="dev-ws-row-chat" title={`${c.chatCount} replies`}>{`💬 ${c.chatCount}`}</span> : null}
      {trailing ? <span className="dev-ws-row-trailing" onClick={(e) => e.stopPropagation()}>{trailing}</span> : null}
      <ChevronRightIcon className="dev-ws-chev" aria-hidden="true" />
    </div>
  );
}

/**
 * The unfolded row: the Activity entry, byte-compatible with the feed's —
 * `.dev-feed-entry` wraps the dense card, the GitHub preview slot and the
 * app thread, so app.css's sheet treatment and the module's two fillers
 * find exactly the markup they expect.
 */
function UnfoldedRow({
  row, slug, canPost,
}: { row: CardRow; slug: string; canPost: boolean }): ReactNode {
  const href = openHref(slug, row.card);
  return (
    <div className="dev-feed-entry dev-ws-sheet" data-ws-sheet={row.key}>
      <DevCard model={row.card} />
      {row.commentsFor != null ? (
        <div className="dev-feed-comments" data-comments-for={String(row.commentsFor)}></div>
      ) : null}
      {row.thread && slug ? (
        <FeedThread slug={slug} type={row.thread.type} refId={row.thread.ref} canPost={canPost} />
      ) : null}
      {/* No Collapse button: the head above is the toggle, in both directions,
          and a second control that only ever undoes the first one is a thing
          to learn rather than a thing to use. What is left here is the one
          action the fold cannot do — leaving for the card's own page. */}
      {href ? (
        <div className="dev-ws-sheet-actions">
          <a href={href} className="dev-ws-link">Open card ›</a>
        </div>
      ) : null}
    </div>
  );
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

/** The card's Yes/No vote specs, when it carries a vote (the dense card's rule). */
function voteSpecs(card: DevCardModel): { yes: ActionSpec; no: ActionSpec } | null {
  const yes = card.actions.find((a) => /\bgc-vote-btn-yes\b/.test(a.cls || ''));
  const no = card.actions.find((a) => /\bgc-vote-btn-no\b/.test(a.cls || ''));
  return yes && no ? { yes, no } : null;
}

/**
 * One card, in whichever size it is currently at: the head, and — when it is
 * open — the body under it, inside the same sheet.
 *
 * This was five near-identical copies (one per strip) plus a `VoteRow` that
 * differed only in passing the vote button down. The vote button belongs to
 * every row now (see `FoldedRow`), so the copies had nothing left to differ
 * about.
 */
function CardRowView({
  row, slug, canPost, open, onToggle,
}: { row: CardRow; slug: string; canPost: boolean; open: boolean; onToggle: () => void }): ReactNode {
  return (
    <div className={open ? 'dev-ws-rowwrap dev-ws-rowwrap-open' : 'dev-ws-rowwrap'}>
      <FoldedRow row={row} open={open} onToggle={onToggle} />
      {open ? <UnfoldedRow row={row} slug={slug} canPost={canPost} /> : null}
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
function aiFootnote(meta: DevWorkshopView['meta']): string {
  const drafted = meta.discoveredAt ? Date.parse(meta.discoveredAt) : NaN;
  const parts: string[] = [
    Number.isFinite(drafted)
      ? `Themes were drafted ${relTime(drafted)} and are re-drafted daily, or sooner when a tenth of the board changes.`
      : 'Themes are drafted from the board and re-drafted daily, or sooner when a tenth of the board changes.',
  ];
  const c = meta.coverage;
  if (c && c.pending) parts.push(`${c.pending} new ${c.pending === 1 ? 'card is' : 'cards are'} being placed.`);
  if (c && c.unplaced) {
    parts.push(`${c.unplaced} ${c.unplaced === 1 ? 'card did' : 'cards did'} not fit a theme and ${c.unplaced === 1 ? 'waits' : 'wait'} for the next draft.`);
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
  // The merged history is paged, so with more behind it these are floors.
  const at = d.partial ? 'At least ' : '';
  if (!n && !p) return 'Nothing has landed in the last fortnight.';
  if (!p) return `${at}${n} ${n === 1 ? 'change' : 'changes'} landed this week, the first in a fortnight.`;
  if (n > p) return `${at}${n} landed this week, up from ${p} the week before.`;
  if (n < p) return `${at}${n} landed this week, down from ${p} the week before.`;
  return `${at}${n} landed this week, the same as the week before.`;
}

/**
 * The app, described rather than counted.
 *
 * This pane used to read "63 open · 4 waiting on votes · 20 shipped this week"
 * — three numbers and no sentence, which tells a reader the size of the board
 * and nothing about it. A theme earns its place on this screen by SAYING what
 * it is about; the app itself was the one thing on the lander that did not, so
 * it now gets the same treatment in the same shape: what there is, how fast it
 * is moving, and what is waiting on a person.
 *
 * Still derived, not written by a model — the numbers were always the answer,
 * they were just never put in a sentence.
 */
function describe(d: Dash): string {
  const parts: string[] = [];
  const scale = `${d.open} open ${d.open === 1 ? 'item' : 'items'}`
    + (d.themes ? ` across ${d.themes} ${d.themes === 1 ? 'theme' : 'themes'}` : '');
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

export function DevWorkshop(): ReactNode {
  const v = useStoreState(devWorkshopStore);
  const hostRef = useRef<HTMLDivElement>(null);
  const [sortKey, setSortKey] = useState<SortKey>('people');
  // Which themes are unfolded, keyed by id. The FIRST theme opens by
  // default: a lander whose every theme is shut is a list of headings.
  // Seeded once the first real publish lands, then the viewer's.
  const [openThemes, setOpenThemes] = useState<Record<string, boolean> | null>(null);
  // At most one unfolded row per theme (and one for the since strip).
  const [openRows, setOpenRows] = useState<Record<string, string>>({});
  const [sinceOpen, setSinceOpen] = useState(false);

  const themes = useMemo(() => sortThemes(v.themes, sortKey), [v.themes, sortKey]);
  const firstId = themes.length ? themes[0].id : null;
  const isOpen = (id: string) => (openThemes ? !!openThemes[id] : id === firstId);
  const toggleTheme = (id: string) => {
    setOpenThemes((cur) => {
      const base = cur || (firstId ? { [firstId]: true } : {});
      return { ...base, [id]: !base[id] };
    });
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
    setOpenThemes((cur) => ({ ...(cur || (firstId ? { [firstId]: true } : {})), [theme]: true }));
    setOpenRows((cur) => ({ ...cur, [theme]: key }));
  }, [autoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The two legacy fillers, re-run whenever the set of unfolded entries
  // changes — see the header. `_wireFeedComments` replaces its observer, so
  // calling it again is idempotent; `_fillKudosHosts` skips filled hosts.
  const openSig = Object.values(openRows).join('|') + (sinceOpen ? '|since' : '');
  useEffect(() => {
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
          data-ws-since={v.since ? '' : undefined}
          data-ws-dashboard=""
        >
          <div className="dev-ws-strip-head">
            <span className="dev-ws-eyebrow">Where the app is</span>
            {v.since && v.since.shipped
              ? <span className="dev-ws-pill dev-ws-pill-good">{`${v.since.shipped} shipped since`}</span>
              : null}
          </div>
          <p className="dev-ws-strip-text">{describe(v.dashboard)}</p>
          {v.since ? (
            <p className="dev-ws-since-line">
              <span>{`Since your last visit, ${relTime(v.since.baseline)}: ${sinceWords(v.since)}`}</span>
              {v.since.rows.length ? (
                <button
                  type="button"
                  className="gc-vote-btn"
                  aria-expanded={sinceOpen}
                  onClick={() => setSinceOpen(!sinceOpen)}
                >{sinceOpen ? 'Hide' : `Show ${v.since.rows.length}`}</button>
              ) : null}
            </p>
          ) : null}
          {v.since && sinceOpen ? (
            <div className="dev-ws-lane" data-ws-lane="since">
              {v.since.rows.map((row) => (row.t === 'card' ? (
                <CardRowView
                  key={row.key}
                  row={row}
                  slug={slug}
                  canPost={canPost}
                  open={openRows.since === row.key}
                  onToggle={() => toggleRow('since', row.key)}
                />
              ) : null))}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ── One pane: what needs a person ──
          Voting on somebody else's work and picking up nobody's are the same
          offer — "here is what you could do with five minutes" — and they were
          two containers saying it twice. */}
      {v.votes.rows.length || nextUp ? (
        <section
          className="dev-ws-strip"
          data-ws-votes=""
          data-ws-next={nextUp ? '' : undefined}
        >
          <div className="dev-ws-strip-head">
            <span className="dev-ws-eyebrow">What needs you</span>
            {v.votes.count
              ? <span className="dev-ws-pill dev-ws-pill-warn">{`${v.votes.count} to vote on`}</span>
              : null}
          </div>
          {v.votes.rows.length ? (
            <div className="dev-ws-lane" data-ws-lane="votes">
              <h4 className="dev-ws-lane-title"><span className="dev-ws-dot" aria-hidden="true"></span>Needs your vote</h4>
              {v.votes.rows.map((row) => (row.t === 'card' ? (
                <CardRowView
                  key={row.key}
                  row={row}
                  slug={slug}
                  canPost={canPost}
                  open={openRows.votes === row.key}
                  onToggle={() => toggleRow('votes', row.key)}
                />
              ) : null))}
              {v.votes.count > v.votes.rows.length ? (
                <button type="button" className="gc-vote-btn dev-ws-lane-btn" onClick={() => callAppView('openBoardNeedingVote')}>
                  {`${v.votes.count - v.votes.rows.length} more waiting on you ›`}
                </button>
              ) : null}
            </div>
          ) : null}
          {nextUp ? (
            <div className="dev-ws-lane" data-ws-lane="next">
              <h4 className="dev-ws-lane-title"><span className="dev-ws-dot" aria-hidden="true"></span>Nobody on this one yet</h4>
              <CardRowView
                row={nextUp}
                slug={slug}
                canPost={canPost}
                open={openRows.next === nextUp.key}
                onToggle={() => toggleRow('next', nextUp.key)}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {v.discussion && v.discussion.t === 'card' ? (
        <div className="dev-ws-discussion"><DevCard model={v.discussion.card} /></div>
      ) : null}

      {themes.length ? (
        <>
          <div className="dev-ws-sort">
            <span className="dev-ws-eyebrow">
              {`${themes.filter((t) => !t.ungrouped).length} themes`}
              {v.meta.source === 'category' ? ' · grouped by category for now' : ''}
              {v.meta.source === 'demo' ? ' · staging demo grouping' : ''}
              {v.meta.pending
                ? (v.meta.pendingStage === 'placement'
                  ? ' · placing new cards…'
                  : (v.meta.source === 'ai' ? ' · re-drafting themes…' : ' · drafting themes…'))
                : ''}
            </span>
            <div className="dev-ws-sort-opts" role="group" aria-label="Order themes">
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
              ? aiFootnote(v.meta)
              : v.meta.source === 'demo'
                ? 'Staging demo grouping: in production the themes are drafted by the model from the board.'
                : v.meta.pending
                  ? 'Themes are being drafted from the board now. They replace this grouping when they land.'
                  : v.meta.lastError
                    ? `The last attempt to draft themes failed (${v.meta.lastError}). Items stay grouped by their voted category until the next attempt.`
                    : 'No AI model is configured, so items are grouped by their voted category.'}
          </div>
        </>
      ) : null}
    </div>
  );
}
