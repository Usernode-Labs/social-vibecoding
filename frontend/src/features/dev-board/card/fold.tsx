/**
 * What a board row borrows from the card: the item's hooks, the link to its
 * page, the status pill, the live tally and the vote specs.
 *
 * The card used to have two sizes here, a one-line row that unfolded in
 * place into the full card with its comment tail and reply box (#1787,
 * #1884). Nothing unfolds any more: a board row (../workshop/work-row.tsx)
 * opens the item's page (#4486), and the last way to draw the full card on
 * the board, `?cards=open`, is gone. What the rows still need from the card
 * lives in this module, so a row and the card cannot drift apart on it.
 *
 * ── The item's hooks ─────────────────────────────────────────────────
 *
 * Every row carries `data-issue-row` / `data-proposal-row` / `data-gov-row`
 * / `data-shared-session-row` / `data-session-chip`, and things key off
 * them: the declared checks name items by them, the live chat-count bump
 * and the flash-after-action look them up.
 */

import type { ReactNode } from 'react';

import { t } from '../../../lib/i18n/runtime';

import { Badge, useSavedVote } from './dev-card';
import type { ActionSpec, BadgeSpec, DevCardModel, StatusPillState } from './model';
import { pillWithSavedVote, shownPill, votedSide } from './model';

/**
 * Call an AppView method by name. Returns whatever it returned (undefined
 * when there is no such method), so a caller that needs the outcome, such as
 * the Needs-you deck waiting on `castVote`, can have it.
 */
export function callAppView(fn: string, ...args: unknown[]): unknown {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') return av[fn](...args);
  return undefined;
}

/**
 * The hooks the delegated `#dev-body` handler opens a card full-screen on,
 * and the ones the checks and the lookups name an item by — see the header.
 */
const ITEM_HOOKS = [
  'data-issue-row', 'data-proposal-row', 'data-gov-row',
  'data-shared-session-row', 'data-session-chip', 'data-discussion-row',
];

export function itemHooks(card: DevCardModel): Record<string, string> {
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
  // #6439: a vote to close a request is decided on the request's page.
  if (a['data-close-request']) return `#app/${slug}/dev/issues/${a['data-close-request']}`;
  if (a['data-gov-row']) return `#app/${slug}/dev/governance/${a['data-gov-row']}`;
  if (a['data-shared-session-row']) return `#app/${slug}/dev/proposals/${a['data-shared-session-row']}`;
  if (a['data-session-chip']) return `#app/${slug}/dev/proposals/${a['data-session-chip']}`;
  return null;
}

/** How many of the card's own chips ride along on a row. */
export const ROW_BADGE_MAX = 3;

/**
 * A row's band: the card's status row and facts row in one —
 * a chip of the composite pill's state, the state chips, and the vote
 * button at the right end, where the card's bar puts it. One line, clipped,
 * for the same reason the card's rows are: a band that wrapped would push
 * every row under it out of rhythm. (The message count is the meta line's,
 * with the tags, at both sizes.)
 *
 * The composite pill used to be flattened to `pill.state.label` and printed in
 * `.dev-ws-row-meta`, in the same muted grey the author's name wears — so
 * "Conflicts with main · 9 files", which is the one fact that decides whether
 * a proposal can merge at all, read like a byline. It has carried a `tone` all
 * along; this spends it.
 *
 * A `chipBtn` is rendered as a plain `chip`: a chip that swallowed the click
 * to do something else would make the row open its page sometimes and not
 * others; the real control is on the item's page, one tap away.
 */
export function flatBadge(b: BadgeSpec): BadgeSpec {
  return b.t === 'chipBtn'
    ? { t: 'chip', key: b.key, cls: b.cls, label: b.label, title: b.title, spinner: b.spinner, data: b.data }
    : b;
}

/**
 * The card's status pill as the row draws it: the bar's own words in the
 * bar's own tone ("0 of 1 approval", "✓ Live", "Merge conflict"), from the
 * card's `statusPillState`, so its words and tones follow the card's
 * precedence unchanged. The board's row draws it across the row in
 * `RowBand`; the Workshop tab's row and a live row draw it on their tags
 * line at its words' width (#4486, workshop/work-row.tsx).
 */
export function StatePill({ s, className }: { s: StatusPillState; className?: string }): ReactNode {
  return (
    <span className={`dev-ws-row-state dev-ws-row-state-${s.tone}${className ? ` ${className}` : ''}`} title={s.title}>{s.label}</span>
  );
}

/**
 * The final counted vote of a change that is live (#6075): "3 yes · 1 no" (or "1/2 yes"
 * when it went live short of its threshold), read beside its "✓ Live" pill. The yes count is compared with the
 * threshold snapshotted at merge time (`StatusPillState.majority`, which
 * `statusPillState` already falls back to the live majority for legacy
 * rows); the no votes are shown only when there were some. A row with no
 * counted votes (an imported pull request) has no tally — it never reads
 * "0/1". History only: nothing here is a vote the viewer can cast again.
 */
export function liveTally(s: StatusPillState | null): { text: string; title: string } | null {
  if (!s || s.tier !== 0 || (s.key !== 'deployed' && s.key !== 'merged')) return null;
  const yes = Math.max(0, s.yes || 0);
  const no = Math.max(0, s.no || 0);
  if (yes + no <= 0) return null;
  const needed = s.majority > 0 ? s.majority : 1;
  // V05 (audit, 2 Nov 2026): with the yes it needed, or more, the count
  // stands alone ("2 yes"); "2/1 yes" read as more votes than possible.
  // What it needed stays in the title.
  const passed = yes >= needed;
  const text = no > 0
    ? (passed ? t('project:card.tally.passedNo', { yes, no }) : t('project:card.tally.yesNo', { yes, needed, no }))
    : (passed ? t('project:card.tally.passed', { yes }) : t('project:card.tally.yes', { yes, needed }));
  return { text, title: t('project:card.tally.title', { yes, no, needed }) };
}

/** The live tally beside a "✓ Live" pill, or nothing. */
export function LiveTally({ s }: { s: StatusPillState | null }): ReactNode {
  const tally = liveTally(s);
  if (!tally) return null;
  return <span className="dev-ws-wrow-tally" title={tally.title}>{tally.text}</span>;
}

export function RowBand({ card, trailing, chips: withChips = true }: {
  card: DevCardModel;
  trailing?: ReactNode;
  /**
   * The card's state chips after the bar. The board's row (#4486) passes
   * false: what those chips say is the row's tags (`_workshopBrief`), on the
   * line above, so the band is the bar and Vote alone.
   */
  chips?: boolean;
}): ReactNode {
  const s = shownPill(card);
  // #7101: a vote this page has just saved is newer than the read the row
  // came from, so the approvals count is corrected in place until the next
  // read carries it. An uncounted or advisory vote moves the face, not the
  // count (dev-card.tsx VoteButton reads the same store for its face).
  const specs = voteSpecs(card);
  const savedSide = useSavedVote(specs ? specs.yes : null);
  const afterVote = pillWithSavedVote(
    s,
    specs ? (votedSide(specs.yes) || votedSide(specs.no)) : null,
    specs && (specs.yes.uncounted || specs.yes.advisory) ? null : savedSide,
    t,
  );
  // The state chips only: the tags and the linked-issue chips are the meta
  // line's (metaLineNodes), on the row as on the card.
  // `meta` chips (the status tags) ride the row's META line, which is
  // metaLineNodes' — the same seam as the card. The band is the bar, the
  // remaining state chips and the vote.
  const chips = withChips ? (card.badges || [])
    .filter((b) => b && b.t !== 'attr' && b.t !== 'issueChip' && !(b.t === 'chip' && b.meta))
    .slice(0, ROW_BADGE_MAX) : [];
  if (!afterVote && !chips.length && !trailing) return null;
  return (
    <span className="dev-ws-row-band">
      {afterVote ? <StatePill s={afterVote} /> : null}
      {chips.map((b) => <Badge key={b.key} b={flatBadge(b)} />)}
      {trailing ? <span className="dev-ws-row-trailing" onClick={(e) => e.stopPropagation()}>{trailing}</span> : null}
    </span>
  );
}

/** The card's Yes/No vote specs, when it carries a vote (the dense card's rule). */
export function voteSpecs(card: DevCardModel): { yes: ActionSpec; no: ActionSpec } | null {
  const yes = card.actions.find((a) => /\bgc-vote-btn-yes\b/.test(a.cls || ''));
  const no = card.actions.find((a) => /\bgc-vote-btn-no\b/.test(a.cls || ''));
  return yes && no ? { yes, no } : null;
}
