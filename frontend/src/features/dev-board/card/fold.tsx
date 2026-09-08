/**
 * The card, folded — and the fold that opens it.
 *
 * One item on the Dev screen has two sizes: the one-line ROW (icon, title,
 * number and author, a mini status band, the vote button where there is
 * one) and the dense CARD the Board has always drawn. The Workshop's lanes
 * introduced the row and the fold between them (#1787); the Board's columns
 * use the same fold now, so a column of forty items is forty rows and the
 * one you tapped, rather than forty cards. This module is where both
 * surfaces get them from, so the two can never drift apart.
 *
 * ── Either the row or the card, never both ───────────────────────────
 *
 * `CardRowView` renders ONE of the two. The row is a compressed
 * representation of the card, so opening it swaps it for the card whole
 * rather than growing a hybrid with the row as a head and the card
 * de-chromed under it (#1799 did that; it read as a third object belonging
 * to neither size). The open card carries an "Open card" toggle at the end
 * of its facts line that reveals the topic screen's own sections under it,
 * and an "Open on its own page" link for the item's full-screen route.
 *
 * ── The item's hooks stay on, at both sizes ──────────────────────────
 *
 * Every card carries `data-issue-row` / `data-proposal-row` / `data-gov-row`
 * / `data-shared-session-row` / `data-session-chip`, and things key off
 * them: the declared checks name items by them, the live chat-count bump
 * and the flash-after-action look them up. The folded row carries the same
 * hook, so an item is findable whichever size it is at.
 *
 * What those hooks USED to do on a click is open the item full-screen,
 * through `AppView._wireDevBody`'s delegated handler on `#dev-body`. That
 * handler now stands aside for any click inside a `.dev-ws-rowwrap`: the
 * fold owns its clicks, and the full-screen route is the link on the open
 * card. The Workshop used to get the same effect by stripping the hooks off
 * the open card's model (`withoutOpenHooks`) — necessary then, because this
 * component renders through a portal whose React root sits ABOVE
 * `#dev-body`, so a synthetic `stopPropagation` here would have run after
 * the delegated handler had already navigated. Having the handler check for
 * the wrapper does the same job without the model losing what the checks
 * select on.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { Badge, CardIcon, DevCard, edgeFor, VoteButton } from './dev-card';
import { FeedThread } from './feed-thread';
import type { ActionSpec, BadgeSpec, DevCardModel, ListRow } from './model';
import { TopicBodySections } from '../topic/topic-head';
import type { TopicBody } from '../topic/model';

export type CardRow = Extract<ListRow, { t: 'card' }>;

/** Like `callAppView`, but for the calls that answer with a view model. */
export function readAppView<T>(fn: string, ...args: unknown[]): T | null {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (!av || typeof av[fn] !== 'function') return null;
  try {
    return av[fn](...args) as T;
  } catch {
    return null;
  }
}

export function callAppView(fn: string, ...args: unknown[]): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn](...args);
}

/**
 * The hooks the delegated `#dev-body` handler opens a card full-screen on,
 * and the ones the checks and the lookups name an item by. The folded row
 * carries them too — see the header.
 */
const ITEM_HOOKS = [
  'data-issue-row', 'data-proposal-row', 'data-gov-row',
  'data-shared-session-row', 'data-session-chip', 'data-discussion-row',
];

function itemHooks(card: DevCardModel): Record<string, string> {
  const a = card.attrs || {};
  const out: Record<string, string> = {};
  for (const k of ITEM_HOOKS) if (a[k] != null) out[k] = String(a[k]);
  return out;
}

/**
 * Where "Open" leads: the card's own full-screen route, read off the hooks
 * the delegated handler reads, so the two can never disagree.
 */
export function openHref(slug: string, card: DevCardModel): string | null {
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
export function numberOf(card: DevCardModel): string | null {
  for (const m of card.meta) {
    if (m.t === 'link' && /^(?:PR)?#\d+$/.test(m.s)) return m.s;
  }
  return null;
}

/** The author from the meta line: the first plain text part. */
export function authorOf(card: DevCardModel): string | null {
  for (const m of card.meta) if (m.t === 'text') return m.s;
  return null;
}

/** How many of the card's own chips ride along on a folded row. */
export const ROW_BADGE_MAX = 3;

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
export function flatBadge(b: BadgeSpec): BadgeSpec {
  return b.t === 'chipBtn'
    ? { t: 'chip', key: b.key, cls: b.cls, label: b.label, title: b.title, spinner: b.spinner, data: b.data }
    : b;
}

export function RowBand({ card }: { card: DevCardModel }): ReactNode {
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
 * One folded row: a disclosure. It carries the item's own hooks
 * (`data-issue-row` and its siblings), and the delegated card-open handler
 * leaves it alone because it sits inside a `.dev-ws-rowwrap` — see the
 * header.
 *
 * A `div` with the button role rather than a `<button>`, because the vote
 * strip's rows carry the card's Vote button INSIDE them (`trailing`), and
 * a button cannot contain a button. The trailing control stops its clicks
 * from reaching the row; Enter and Space on the row itself toggle it.
 */
export function FoldedRow({
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
      {...itemHooks(c)}
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
          {row.placing ? <span className="dev-ws-placing" title="Being placed into a category">placing…</span> : null}
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
 * The open row: the SAME card the Board draws, at the size the Board draws
 * it, with the comment slot and the thread under it where the row carries
 * them (the Workshop's rows do; the Board's do not).
 *
 * It used to be a hybrid — the compressed row stayed above and this card had
 * its head, meta line and status band hidden so as not to repeat it — which
 * made the open state a third object belonging to neither. The row is a
 * compressed representation OF this card, so opening one swaps it for the
 * card whole rather than growing a chimera.
 */
export function UnfoldedRow({
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
  // No chevron on the open card. It is the Board's "this opens" mark at the
  // card's right edge, and inside a fold a click on the card FOLDS it; the
  // way out is the link under the card. The row it folds to wears none
  // either, so nothing on the item promises a destination it does not have.
  const card: DevCardModel = { ...row.card, rail: { ...row.card.rail, chevron: false } };
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
      <DevCard model={card} statusLead={openBtn} />
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

/** The card's Yes/No vote specs, when it carries a vote (the dense card's rule). */
export function voteSpecs(card: DevCardModel): { yes: ActionSpec; no: ActionSpec } | null {
  const yes = card.actions.find((a) => /\bgc-vote-btn-yes\b/.test(a.cls || ''));
  const no = card.actions.find((a) => /\bgc-vote-btn-no\b/.test(a.cls || ''));
  return yes && no ? { yes, no } : null;
}

/**
 * One card, in whichever size it is currently at: the head, and — when it is
 * open — the body under it, inside the same sheet.
 *
 * This was five near-identical copies (one per Workshop strip) plus a
 * `VoteRow` that differed only in passing the vote button down. The vote
 * button belongs to every row now (see `FoldedRow`), so the copies had
 * nothing left to differ about — and the Board's columns are a sixth caller.
 */
export function CardRowView({
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
