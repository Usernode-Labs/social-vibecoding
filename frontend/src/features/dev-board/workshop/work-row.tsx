/**
 * The Workshop tab's one kind of row (#4457): a quiet line about an item —
 * its title, one line in words, small status tags, and its votes where the
 * item asks for one — that opens the item's page in one tap.
 *
 * ── Why one row, not the folded card ──────────────────────────────────
 *
 * The card rows said "you" three times (the author, an @evan chip, "Picked
 * up · you"), carried a coloured edge, a coloured icon, a category chip and
 * a 💬 badge, and unfolded the whole card in place. This row is for READING
 * a list and choosing from it: the category and the reply count are words in
 * its second line, nothing unfolds, and the one action is Vote, on the rows
 * that ask for it. All items and Needs you keep their card rows for now —
 * this row replaces them in a later change.
 *
 * The item's own hooks stay on the anchor (`data-issue-row` and its
 * siblings), because the declared checks and the live updates find an item
 * by them. The vote button is the card's own `VoteButton`, inside a span
 * that stops the click from reaching the link.
 */

import type { MouseEvent, ReactNode } from 'react';

import { VoteButton } from '../card/dev-card';
import { itemHooks, openHref, voteSpecs, type CardRow } from '../card/fold';
import type { DevCardModel, MetaPart } from '../card/model';

/** The facts the words line names, read off the card. */
export interface WorkFacts {
  /** "Change" (a proposal or a session), "Request" (an issue), "Decision" (governance). */
  kind: string;
  /** The item's number, as the screen shows it ("Change #4456"). */
  n: number | null;
  /** The requests the change is for ("for #4455 and #4452"). */
  forIssues: number[];
  /** Who made it, when the row carries one ("by snait"). */
  author: string | null;
  /** The category chip's name, now a word ("Communities & projects"). */
  category: string | null;
  /** The reply count, now a word ("3 replies"). */
  replies: number | null;
}

/** Which kind an item is, from the hooks it carries — the screen's words. */
export function workKind(card: DevCardModel): string {
  const a = card.attrs || {};
  if (a['data-issue-row'] != null) return 'Request';
  if (a['data-gov-row'] != null) return 'Decision';
  if (a['data-proposal-row'] != null || a['data-shared-session-row'] != null
    || a['data-session-chip'] != null) return 'Change';
  return '';
}

/** The item's number: the "#N" of the card's meta line, else the hook id. */
function numberFrom(card: DevCardModel): number | null {
  for (const p of (card.meta || []) as MetaPart[]) {
    const m = /#(\d+)/.exec(p && typeof p.s === 'string' ? p.s : '');
    if (m) return parseInt(m[1], 10) || null;
  }
  const a = card.attrs || {};
  const hook = a['data-issue-row'] || a['data-proposal-row'] || a['data-gov-row']
    || a['data-shared-session-row'] || a['data-session-chip'];
  const n = parseInt(String(hook), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The requests a change is for: its "Closes #N" chips. */
function forIssuesOf(card: DevCardModel): number[] {
  const out: number[] = [];
  for (const b of [...(card.linked || []), ...(card.badges || [])]) {
    if (b && (b.t === 'issueChip' || b.t === 'issueLink')) {
      const n = Number(b.n);
      if (Number.isFinite(n) && n > 0 && out.indexOf(n) === -1) out.push(n);
    }
  }
  return out;
}

/** The category chip's name, from the card's metadata chips. */
function categoryOf(card: DevCardModel): string | null {
  for (const b of card.badges || []) {
    if (b && b.t === 'attr' && b.field === 'category') {
      const label = b.label;
      const s = typeof label === 'string' ? label : (label && label.text) || '';
      return s || null;
    }
  }
  return null;
}

/** The author: what the row carries, else the card's own words. */
function authorOf(card: DevCardModel, who?: string | null): string | null {
  if (who) return who;
  for (const p of (card.meta || []) as MetaPart[]) {
    if (!p || p.t !== 'text' || typeof p.s !== 'string') continue;
    const s = p.s;
    if (/ago$/.test(s)) continue;
    if (/^(imported from GitHub|built with |platform maintenance|Failing:)/.test(s)) continue;
    if (/ is working on this$/.test(s)) continue;
    return s;
  }
  return null;
}

/** The card's facts, in one pass. */
export function workFacts(card: DevCardModel, who?: string | null): WorkFacts {
  return {
    kind: workKind(card),
    n: numberFrom(card),
    forIssues: forIssuesOf(card),
    author: authorOf(card, who),
    category: categoryOf(card),
    replies: card.chatCount && card.chatCount > 0 ? card.chatCount : null,
  };
}

/**
 * The words line: "Change #4456 · yours · for #4455 and #4452", "Change
 * #4447 · by snait · for #4402", "Request #4417 · Communities & projects ·
 * 3 replies". The facts the old card spent chips and badges on.
 */
export function workLine(facts: WorkFacts, own?: boolean): string {
  const parts: string[] = [];
  if (facts.kind && facts.n) parts.push(`${facts.kind} #${facts.n}`);
  else if (facts.n) parts.push(`#${facts.n}`);
  if (own) parts.push('yours');
  else if (facts.author) parts.push(`by ${facts.author}`);
  if (facts.kind === 'Request' && facts.category) parts.push(facts.category);
  if (facts.forIssues.length) {
    const ns = facts.forIssues.map((n) => `#${n}`);
    const list = ns.length <= 1
      ? ns.join('')
      : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`;
    parts.push(`for ${list}`);
  }
  if (facts.kind === 'Request' && facts.replies) parts.push(`${facts.replies} replies`);
  else if (facts.replies) parts.push(`${facts.replies} replies`);
  return parts.join(' · ');
}

/** One small status tag: what is happening on the item. */
export interface WorkTag {
  label: string;
  /** Green only for "Live"; everything settled is grey. */
  tone: 'ok' | 'neutral';
}

/**
 * The status tags: the pill's state (without a leading "✓ ") and up to two
 * of the card's state chips. " · you" trailing a state ("Picked up · you")
 * goes — the list already knows whose row it is. At most three.
 */
export function workTags(card: DevCardModel): WorkTag[] {
  const out: WorkTag[] = [];
  const push = (raw?: string | null) => {
    if (!raw) return;
    const label = String(raw).replace(/^✓\s*/, '').replace(/\s·\syou$/, '').trim();
    if (!label || out.some((t) => t.label === label)) return;
    if (out.length >= 3) return;
    out.push({ label, tone: label === 'Live' ? 'ok' : 'neutral' });
  };
  const s = card.pill && card.pill.state;
  if (s) push(s.label);
  const chips = (card.badges || [])
    .filter((b) => b && b.t !== 'attr' && b.t !== 'issueChip' && !(b.t === 'chip' && b.meta))
    .slice(0, 2);
  for (const b of chips) push(b.label);
  return out;
}

/** The votes a row carries: one part per yes it needs, and whether yours is wanted. */
export interface WorkVotes {
  /** How many yes votes the change needs. */
  need: number;
  /** How many it has. */
  yes: number;
  /** The viewer has not voted, so the count is the one that asks for them. */
  wanted: boolean;
  /** The vote button's two specs, from the card itself. */
  yes: Parameters<typeof VoteButton>[0]['yes'];
  no: Parameters<typeof VoteButton>[0]['no'];
}

export function workVotes(card: DevCardModel): WorkVotes | null {
  const specs = voteSpecs(card);
  if (!specs) return null;
  const s = card.pill && card.pill.state;
  return {
    need: Math.max(1, Number(s && s.majority) || 1),
    yes: Math.max(0, Number(s && s.yes) || 0),
    wanted: !/\bgc-vote-active\b/.test(String(specs.yes.cls || ''))
      && !/\bgc-vote-active\b/.test(String(specs.no.cls || '')),
    yes: specs.yes,
    no: specs.no,
  };
}

/**
 * A request that one of the changes here is FOR shows once, as that change:
 * an issue row whose number a change row's "Closes #N" names is dropped.
 */
export function dedupeWork(rows: CardRow[]): CardRow[] {
  const covered = new Set<number>();
  for (const row of rows) {
    if (!row || row.t !== 'card') continue;
    if (workKind(row.card) !== 'Change') continue;
    for (const n of forIssuesOf(row.card)) covered.add(n);
  }
  return rows.filter((row) => {
    if (!row || row.t !== 'card') return true;
    if (workKind(row.card) !== 'Request') return true;
    const a = row.card.attrs || {};
    const n = parseInt(String(a['data-issue-row']), 10);
    return !(Number.isFinite(n) && covered.has(n));
  });
}

/** The row's votes: the bar's parts, the count, and the card's own Vote button. */
function WorkVotesView({ votes }: { votes: WorkVotes }): ReactNode {
  const segs = Math.min(Math.max(votes.need, 1), 4);
  return (
    <span
      className="dev-ws-work-votes"
      // The row is a link; a click on the vote controls is the vote's, and
      // must not open the item underneath it.
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <span className="dev-ws-work-segs" aria-hidden="true">
        {Array.from({ length: segs }, (_, i) => (
          <i key={i} className={i < votes.yes ? 'dev-ws-work-seg dev-ws-work-seg-yes' : 'dev-ws-work-seg'} />
        ))}
      </span>
      <span
        className={votes.wanted ? 'dev-ws-work-vcount dev-ws-work-vcount-wanted' : 'dev-ws-work-vcount'}
      >
        {`${votes.yes} of ${votes.need} yes`}
      </span>
      <VoteButton yes={votes.yes} no={votes.no} />
    </span>
  );
}

/**
 * One row of the work list. A real `<a href>` to the item's page — a plain
 * click opens it beside the list through `onOpen` (the panel on a computer,
 * the page itself on a phone), and a modified click is the browser's.
 */
export function WorkRow({ row, slug, own, current, onOpen }: {
  row: CardRow;
  slug: string;
  /** The viewer's own work: the words line says "yours", not "by …". */
  own?: boolean;
  /** The row whose item is open in the panel beside the list. */
  current?: boolean;
  /** Where a plain click goes: `AppView.openWorkRow`. */
  onOpen?: (href: string) => void;
}): ReactNode {
  const c = row.card;
  const href = openHref(slug, c);
  if (!href) return null;
  const facts = workFacts(c, row.who);
  const tags = workTags(c);
  const votes = workVotes(c);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    const nav = (window as unknown as { NavLink?: { isNativeClick?: (ev: unknown) => boolean } }).NavLink;
    if (nav?.isNativeClick?.(e)) return;
    if (!onOpen) return;
    e.preventDefault();
    onOpen(href);
  };
  return (
    <a
      className="dev-ws-work-row"
      data-ws-work-row={row.key}
      href={href}
      aria-current={current ? 'true' : undefined}
      {...itemHooks(c)}
      onClick={onClick}
    >
      <span className="dev-ws-work-tile" aria-hidden="true" />
      <span className="dev-ws-work-body">
        <span className="dev-ws-work-title">{c.title.text}</span>
        <span className="dev-ws-work-line">{workLine(facts, own)}</span>
        {tags.length || votes ? (
          <span className="dev-ws-work-tags">
            {tags.map((t) => (
              <span
                key={t.label}
                className={t.tone === 'ok' ? 'dev-ws-work-tag dev-ws-work-tag-live' : 'dev-ws-work-tag'}
              >
                {t.label}
              </span>
            ))}
            {votes ? <WorkVotesView votes={votes} /> : null}
          </span>
        ) : null}
      </span>
      <span className="dev-ws-work-chev" aria-hidden="true">›</span>
    </a>
  );
}
