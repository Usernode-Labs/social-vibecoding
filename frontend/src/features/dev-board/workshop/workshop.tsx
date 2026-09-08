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
import { Badge, CardIcon, DevCard, edgeFor, VoteButton } from '../card/dev-card';
import type { ActionSpec, BadgeSpec } from '../card/model';
import { FeedThread } from '../card/feed-thread';
import { TopicBodySections } from '../topic/topic-head';
import type { DevCardModel, DevWorkshopView, ListRow, WorkshopTheme } from '../card/model';
import type { TopicBody } from '../topic/model';
import { CardSkeleton } from '../card/skeleton';
import { ProgressRing } from '@/components/ui/progress-ring';
import { XIcon } from '@/components/ui/icons';

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

/** Like `callAppView`, but for the calls that answer with a view model. */
function readAppView<T>(fn: string, ...args: unknown[]): T | null {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (!av || typeof av[fn] !== 'function') return null;
  try {
    return av[fn](...args) as T;
  } catch {
    return null;
  }
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

/**
 * The card's number from its meta line, when it has one.
 *
 * An issue's reads `#1575` and a proposal's reads `PR#1540`, and this used to
 * match only the first — so every proposal row on the lander was missing the
 * one identifier people actually cite it by, while the card it folds from
 * carried it. The two sizes disagreeing about whether an item HAS a number
 * is the kind of difference that makes them read as two objects.
 */
function numberOf(card: DevCardModel): string | null {
  for (const m of card.meta) {
    if (m.t === 'link' && /^(?:PR)?#\d+$/.test(m.s)) return m.s;
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
      // The hover fill comes from the CARD's own utilities, so the two sizes
      // of one item cannot drift apart on it. app.css keeps the border.
      className={`dev-ws-row hover:bg-zinc-50 dark:hover:bg-zinc-800${open ? ' dev-ws-row-open' : ''}`}
      aria-expanded={open}
      // The card's own left edge, from the card's own function, so the two
      // sizes can never key off different state.
      data-edge={edgeFor(c)}
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
      {/* No chevron. It promises a destination, and this row has none: the
          whole surface is a toggle that unfolds the card in place. A theme
          header still wears one, because that is what it does. */}
    </div>
  );
}

/**
 * The hooks the delegated `#dev-body` handler opens a card full-screen on.
 * They come off the model for the OPEN card, and only there — see below.
 */
const OPEN_HOOKS = [
  'data-issue-row', 'data-proposal-row', 'data-gov-row',
  'data-shared-session-row', 'data-session-chip', 'data-discussion-row',
];

/**
 * The open row: the SAME card the Board draws, at the size the Board draws
 * it, with the comment slot and the thread under it.
 *
 * It used to be a hybrid — the compressed row stayed above and this card had
 * its head, meta line and status band hidden so as not to repeat it — which
 * made the open state a third object belonging to neither. The row is a
 * compressed representation OF this card, so opening one swaps it for the
 * card whole rather than growing a chimera.
 *
 * ── Why the hooks come off ────────────────────────────────────────────
 *
 * `AppView._wireDevBody`'s click handler is bound on `#dev-body` itself and
 * opens the item full-screen when the click lands inside `[data-issue-row]`
 * (or its four siblings). This component renders through a PORTAL, so React's
 * listener sits at the shell's root — above `#dev-body` — and a synthetic
 * `stopPropagation` here would run after that handler had already navigated.
 * Removing the attributes is what actually stops it: `closest()` finds
 * nothing, the handler falls through, and the wrapper's own click can toggle.
 * The full-screen route is not lost — it is the "Open card" link below, whose
 * href is read off the model before the hooks are stripped.
 */
function withoutOpenHooks(card: DevCardModel): DevCardModel {
  const attrs: Record<string, string> = { ...(card.attrs || {}) };
  for (const k of OPEN_HOOKS) delete attrs[k];
  return { ...card, attrs };
}

function UnfoldedRow({
  row, slug, canPost,
}: { row: CardRow; slug: string; canPost: boolean }): ReactNode {
  // ── "Open card" opens it HERE ──────────────────────────────────────
  //
  // It was a link out to the item's own screen, which meant the lander's
  // whole promise — one item, two sizes, in place — ended at the one control
  // that had more to show. There is a third size now and it is still the same
  // object: the card, and under it every section that screen draws (the
  // ledger, the About sheet with its before/after tiles, the transcript),
  // from `AppView._topicViewFor` via `_workshopCardBody`.
  //
  // Built on demand rather than published with the row: the view model for
  // one of these is the expensive half of the topic screen, and a lander
  // showing forty rows would build forty of them to draw none. Held in state
  // so it survives re-renders, and dropped when the card is closed.
  const [detail, setDetail] = useState<TopicBody | null>(null);
  const key = row.card.key;
  useEffect(() => { setDetail(null); }, [key]);
  const toggleDetail = () => {
    setDetail(detail ? null : readAppView<TopicBody>('_workshopCardBody', key));
  };
  // The one thing the fold still cannot do: the item's own page, for a link
  // somebody wants to share. It moved off the sheet's own strip and onto the
  // card's meta line, which is where the topic screen puts GitHub too.
  const href = openHref(slug, row.card);
  const openBtn = (
    <button
      type="button"
      className="gc-vote-btn dev-ws-open-btn"
      aria-expanded={!!detail}
      data-ws-open-card={row.key}
      onClick={toggleDetail}
    >{detail ? 'Close card' : 'Open card'}</button>
  );
  return (
    <div className="dev-feed-entry dev-ws-sheet" data-ws-sheet={row.key}>
      <DevCard model={withoutOpenHooks(row.card)} statusLead={openBtn} />
      {detail ? (
        <div className="dev-ws-detail" data-ws-detail={row.key}>
          <TopicBodySections body={detail} />
        </div>
      ) : null}
      {row.commentsFor != null ? (
        <div className="dev-feed-comments" data-comments-for={String(row.commentsFor)}></div>
      ) : null}
      {row.thread && slug ? (
        <FeedThread slug={slug} type={row.thread.type} refId={row.thread.ref} canPost={canPost} />
      ) : null}
      {href ? (
        <div className="dev-ws-sheet-actions">
          <a href={href} className="dev-ws-link">Open on its own page ›</a>
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
  // EITHER the compressed row OR the card — never both. The two are one item
  // at two sizes, and drawing them together is what made the open state read
  // as a panel hanging off a row.
  //
  // Clicking the open card closes it. Everything interactive inside it is
  // excluded by the same guard the delegated handler uses, plus the thread's
  // composer and the chips that are real buttons: a click on Vote, on the ⋯,
  // on "Closes #12" or in the reply box must do its own job and nothing else.
  //
  // The handler goes on the wrapper rather than on a div around the sheet:
  // the sheet is a DIRECT child of `.dev-ws-rowwrap-open`, and a declared
  // check selects it that way. An intermediate element to hang onClick on
  // is invisible in a diff and breaks that selector.
  return (
    <div
      className={open ? 'dev-ws-rowwrap dev-ws-rowwrap-open' : 'dev-ws-rowwrap'}
      onClick={open ? (e) => {
        const el = e.target as HTMLElement | null;
        // Controls do their own job. So do the three REGIONS below the card:
        // with a ledger, a thread and a comment list open under it there is a
        // lot of prose to land on, and collapsing the whole item because
        // somebody selected a word in it is not a fold, it is losing their
        // place.
        if (el && el.closest(
          'a, button, input, textarea, select, form, [data-attr-chip], [data-issue-chip],'
          + ' .dev-ws-detail, .dev-feed-thread, .dev-feed-comments',
        )) return;
        onToggle();
      } : undefined}
    >
      {open ? (
        <UnfoldedRow row={row} slug={slug} canPost={canPost} />
      ) : (
        <FoldedRow row={row} open={open} onToggle={onToggle} />
      )}
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

function summarise(d: Dash): string {
  return d.summary || describe(d);
}

/**
 * The app, described rather than counted — what is LEFT to say once the tiles
 * have said the numbers.
 *
 * This used to be the whole pane's text: "63 open items across 11 themes,
 * most of the movement in X. 20 landed this week... 4 proposals are waiting
 * on votes and 19 open items have nobody on them." Every count in it is now a
 * tile directly above, so repeating them in prose is worse than saying
 * nothing: a reader who has already read "58 open" gets no second fact, and
 * the sentence buries the one thing that is not a tile.
 *
 * What is left is the two things a tile cannot show — where the movement is,
 * and whether the week is faster or slower than the last. When neither can be
 * said honestly this returns an EMPTY string and the paragraph is not
 * rendered at all. That is the right outcome, not a hole: the tiles are the
 * state, and an app with no model configured should not get a sentence
 * fabricated for it out of the same four numbers.
 */
function describe(d: Dash): string {
  const parts: string[] = [];
  if (d.busiest) parts.push(`Most of the movement is in ${d.busiest}.`);
  const trend = paceTrend(d);
  if (trend) parts.push(trend);
  return parts.join(' ');
}

/**
 * The week-over-week read, and only when there IS one to give.
 *
 * `pace()` above is the full sentence, kept for the theme footers and for
 * anywhere the count is not already on screen. Here the count is a tile, so
 * this returns the COMPARISON alone and nothing when the history cannot
 * support one.
 */
function paceTrend(d: Dash): string {
  if (d.partial) return '';
  const n = d.shippedWeek;
  const p = d.shippedPrevWeek;
  if (!n && !p) return 'Nothing has landed in the last fortnight.';
  if (!p) return n ? 'It is the first week in a fortnight anything landed.' : '';
  if (n > p) return `That is up from ${p} the week before.`;
  if (n < p) return `That is down from ${p} the week before.`;
  return 'That is the same as the week before.';
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
 * "What needs you", closed until the number moves.
 *
 * The pane used to state a debt — "4 to vote on", in the warning tint, with
 * no way to put it down. A ring says the same thing as PROGRESS, which is
 * what the home screen's Challenges block does with the same primitive: the
 * fraction is how many of the app's open proposals this viewer has answered,
 * so a board where you have voted on six of seven reads as nearly finished
 * rather than as one more thing owed.
 *
 * The dismissal stores the OWED COUNT, not a boolean. Closing it at four
 * means "not these four"; the pane returns by itself the moment that number
 * changes, which is the only moment it has something new to say. Per account
 * and per app, and every storage access is wrapped — Safari throws on
 * storage in private mode, and a lander is not worth a boot error.
 */
const NEEDS_YOU_KEY = 'usernode:ws-needs-you-dismissed:';

function needsYouKey(slug: string, viewerId: number | null | undefined): string | null {
  return slug && viewerId != null ? `${NEEDS_YOU_KEY}${slug}:${viewerId}` : null;
}

function readNeedsYouDismissed(slug: string, viewerId: number | null | undefined): number | null {
  const key = needsYouKey(slug, viewerId);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : Number(raw);
  } catch {
    return null;
  }
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
  // "N more waiting on you" reveals them HERE. It used to set a board filter
  // and navigate, which left the lander and changed the view mode to read a
  // list the strip was already showing the top of.
  const [allVotes, setAllVotes] = useState(false);
  const [allMine, setAllMine] = useState(false);
  // The owed count this viewer last closed the pane at, or -1 for "not
  // closed". Seeded from storage on mount rather than in the initialiser:
  // the slug arrives with the publish, and reading storage during the first
  // render of a component that also serves the prerendered shell is exactly
  // the hydration trap AGENTS.md warns about.
  const [needsYouHidden, setNeedsYouHidden] = useState<number>(-1);
  const viewerId = v.viewerId;
  useEffect(() => {
    const stored = readNeedsYouDismissed(v.slug || '', viewerId);
    setNeedsYouHidden(stored == null ? -1 : stored);
  }, [v.slug, viewerId]);

  const themes = useMemo(() => sortThemes(v.themes, sortKey), [v.themes, sortKey]);
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
          <DashTiles d={v.dashboard} />
          {summarise(v.dashboard)
            ? <p className="dev-ws-strip-text">{summarise(v.dashboard)}</p>
            : null}
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
      {(v.votes.rows.length || nextUp) && needsYouHidden !== v.votes.count ? (
        <section
          className="dev-ws-strip"
          data-ws-votes=""
          data-ws-next={nextUp ? '' : undefined}
        >
          <div className="dev-ws-strip-head">
            <span className="dev-ws-eyebrow">What needs you</span>
            <span className="dev-ws-needs-end">
              {v.votes.total ? <VoteRing owed={v.votes.count} total={v.votes.total} /> : null}
              <button
                type="button"
                className="dev-ws-needs-close"
                data-ws-needs-close=""
                aria-label="Hide this until something changes"
                title="Hide this until something changes"
                onClick={() => {
                  const key = needsYouKey(slug, v.viewerId);
                  if (key) { try { localStorage.setItem(key, String(v.votes.count)); } catch { /* private mode */ } }
                  setNeedsYouHidden(v.votes.count);
                }}
              >
                <XIcon className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </span>
          </div>
          {v.votes.rows.length ? (
            <div className="dev-ws-lane" data-ws-lane="votes">
              <h4 className="dev-ws-lane-title"><span className="dev-ws-dot" aria-hidden="true"></span>Needs your vote</h4>
              {(allVotes ? v.votes.rows : v.votes.rows.slice(0, v.votes.shown)).map((row) => (row.t === 'card' ? (
                <CardRowView
                  key={row.key}
                  row={row}
                  slug={slug}
                  canPost={canPost}
                  open={openRows.votes === row.key}
                  onToggle={() => toggleRow('votes', row.key)}
                />
              ) : null))}
              {v.votes.rows.length > v.votes.shown ? (
                <button
                  type="button"
                  className="gc-vote-btn dev-ws-lane-btn"
                  aria-expanded={allVotes}
                  data-ws-votes-more=""
                  onClick={() => setAllVotes(!allVotes)}
                >
                  {allVotes
                    ? 'Show fewer'
                    : `${v.votes.count - v.votes.shown} more waiting on you`}
                </button>
              ) : null}
            </div>
          ) : null}
          {nextUp ? (
            <div className="dev-ws-lane" data-ws-lane="next">
              {/* The heading states the fact; the line under it makes the
                  offer. "Why not give it a try?" did both at once and coaxed
                  while it did — a lander does not need to wheedle. */}
              <h4 className="dev-ws-lane-title"><span className="dev-ws-dot" aria-hidden="true"></span>Nobody has picked this up</h4>
              <p className="dev-ws-lane-note">Free to take, if you want to try solving an issue.</p>
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
