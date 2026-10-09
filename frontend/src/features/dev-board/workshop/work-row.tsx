/**
 * The Workshop tab's row (#4457): one item, in one hairline-divided list.
 *
 * It replaces the folded card on the Workshop tab's own lists (Your work,
 * Since your last visit and a week's page). The folded card said "you" three
 * times on your own work (the author, an @ chip, "Picked up · you"), wore a
 * coloured edge, a coloured glyph, a category chip and a 💬 badge, and
 * unfolded in place under a ⇕. A row here is:
 *
 *   - a neutral tile (what kind of thing it is, nothing more);
 *   - the title, 15px, at most two lines;
 *   - one line in words: "Change #4456 · yours · for #4455 and #4452",
 *     "Request #4417 · Communities & projects · 3 replies";
 *   - a status line: small tags for what is happening on it, and on a change
 *     up for a vote its votes (one part per Yes it needs, the count, and the
 *     card's own Vote button, so the vote is the existing one);
 *   - a › that says the row opens.
 *
 * THE ROW OPENS THE ITEM'S PAGE. Its title is a real link to the page's
 * route, stretched over the row (app.css `.dev-ws-wrow-link::after`), so a
 * modified click, a middle click and "Open in new tab" are the browser's,
 * and on a phone a tap is that link: the page takes the screen, with its
 * "‹ Workshop" chip. On a wide window the Workshop catches the plain click
 * and opens the same page in the panel beside the list (`onOpen`,
 * ./side-panel.tsx). The Vote button sits above the stretched link, so it
 * does its own job.
 *
 * Nothing here carries `data-issue-row` and its siblings: those are what
 * the Board's delegated handler opens a card full-screen on, and this row's
 * click is its own. `data-ws-open` names the item instead.
 */

import type { MouseEvent, ReactNode } from 'react';

import {
  BallotIcon, ChatBubbleTailIcon, CheckIcon, ChevronRightIcon, EyeIcon, PencilSquareIcon,
} from '@/components/ui/icons';

import { VoteButton } from '../card/dev-card';
import { openHref, voteSpecs } from '../card/fold';
import type { DevCardModel, ListRow, RowBrief, RowTag } from '../card/model';

export type CardRow = Extract<ListRow, { t: 'card' }>;

/** Which page a row opens: the kind `AppView.openTopic` takes, and its id. */
export interface TopicRef {
  kind: 'issue' | 'proposal' | 'gov';
  id: number;
}

/** The item a card is about, read off the hooks the Board's handler reads. */
export function topicRef(card: DevCardModel): TopicRef | null {
  const a = card.attrs || {};
  const num = (v: string | undefined) => {
    const n = parseInt(String(v || ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  if (num(a['data-issue-row'])) return { kind: 'issue', id: num(a['data-issue-row']) };
  if (num(a['data-gov-row'])) return { kind: 'gov', id: num(a['data-gov-row']) };
  const change = num(a['data-proposal-row']) || num(a['data-shared-session-row']) || num(a['data-session-chip']);
  return change ? { kind: 'proposal', id: change } : null;
}

/** "#4455", "#4455 and #4452", "#1, #2 and #3". */
function numbers(list: number[]): string {
  const s = list.map((n) => `#${n}`);
  if (s.length < 2) return s.join('');
  return `${s.slice(0, -1).join(', ')} and ${s[s.length - 1]}`;
}

/**
 * The row's one line in words. `inMine` is Your work, where a request you
 * are on needs no "yours": the list is yours. A change keeps it, beside the
 * requests it is for, which is what tells it apart from them.
 */
export function rowWords(b: RowBrief, inMine = false): string {
  const parts: string[] = [b.n ? `${b.noun} #${b.n}` : b.noun];
  const who = b.mine ? 'yours' : b.by;
  if (who && !(inMine && b.mine && b.kind === 'request')) parts.push(who);
  if (b.kind === 'request' && b.category) parts.push(b.category);
  if (b.linked.length && b.kind !== 'live') parts.push(`for ${numbers(b.linked)}`);
  if (b.closed.length && b.kind === 'live') parts.push(`closed ${numbers(b.closed)}`);
  if (b.replies) parts.push(`${b.replies} ${b.replies === 1 ? 'reply' : 'replies'}`);
  return parts.join(' · ');
}

const TILE: Record<RowBrief['kind'], typeof CheckIcon> = {
  request: ChatBubbleTailIcon,
  change: PencilSquareIcon,
  live: CheckIcon,
  vote: BallotIcon,
};

function Tag({ t }: { t: RowTag }): ReactNode {
  return (
    <span className="dev-ws-tag" data-tone={t.tone}>
      {t.fill ? <span className="dev-chip-fill" style={{ width: `${t.fill.pct}%` }} aria-hidden="true" /> : null}
      {t.tone === 'run' ? <span className="dc-status-spinner-arc" aria-hidden="true" /> : null}
      {t.tone === 'ok' ? <CheckIcon aria-hidden="true" /> : null}
      {t.glyph === 'eye' ? <EyeIcon aria-hidden="true" /> : null}
      {t.label}
      {t.fill ? <span className="sr-only">{`${t.fill.ran} of ${t.fill.expected}`}</span> : null}
    </span>
  );
}

/** A change's votes: one part per Yes it needs, the count, and Vote. */
function Votes({ vote, card }: { vote: NonNullable<RowBrief['vote']>; card: DevCardModel }): ReactNode {
  const need = Math.max(1, vote.need);
  const done = vote.yes >= need;
  const specs = voteSpecs(card);
  return (
    <span className="dev-ws-wvote" data-ws-vote="">
      <span className="dev-ws-wvote-bar" data-done={done ? '1' : '0'} role="img" aria-label={`${vote.yes} of ${need} yes`}>
        {Array.from({ length: Math.min(need, 12) }, (_, i) => (
          <span key={i} className="dev-ws-wvote-cell" data-on={i < vote.yes ? '1' : undefined} />
        ))}
      </span>
      <span className="dev-ws-wvote-n" data-ask={vote.ask && !done ? '1' : undefined}>{`${vote.yes} of ${need} yes`}</span>
      {specs ? <span className="dev-ws-wvote-btn"><VoteButton yes={specs.yes} no={specs.no} /></span> : null}
    </span>
  );
}

export function WorkRow({ row, slug, inMine = false, on = false, onOpen }: {
  row: CardRow;
  slug: string;
  inMine?: boolean;
  /** Its page is open in the panel beside the list. */
  on?: boolean;
  /** A plain click on the row: the Workshop opens it beside the list, or lets the link go. */
  onOpen?: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
}): ReactNode {
  const b = row.brief;
  if (!b) return null;
  const href = openHref(slug, row.card);
  const ref = topicRef(row.card);
  const Tile = TILE[b.kind] || PencilSquareIcon;
  const status = b.tags.length > 0 || !!b.vote;
  return (
    <div
      className="dev-ws-wrow"
      data-ws-row={row.key}
      data-ws-kind={b.kind}
      data-ws-open={ref ? `${ref.kind}:${ref.id}` : undefined}
      data-on={on ? '1' : undefined}
    >
      <span className="dev-ws-wrow-tile" data-kind={b.kind} aria-hidden="true"><Tile aria-hidden="true" /></span>
      <span className="dev-ws-wrow-main">
        {href ? (
          <a
            className="dev-ws-wrow-link"
            href={href}
            aria-current={on ? 'true' : undefined}
            onClick={ref && onOpen ? (e) => onOpen(e, ref) : undefined}
          >
            {row.card.title.text}
          </a>
        ) : <span className="dev-ws-wrow-link">{row.card.title.text}</span>}
        <span className="dev-ws-wrow-sub">{rowWords(b, inMine)}</span>
        {status ? (
          <span className="dev-ws-wrow-status">
            {b.tags.map((t) => <Tag key={`${t.label}:${t.tone}`} t={t} />)}
            {b.vote ? <Votes vote={b.vote} card={row.card} /> : null}
          </span>
        ) : null}
      </span>
      {href ? <ChevronRightIcon className="dev-ws-wrow-chev" aria-hidden="true" /> : null}
    </div>
  );
}

/** A hairline-divided list of rows. */
export function WorkList({ rows, slug, inMine, openKey, onOpen }: {
  rows: CardRow[];
  slug: string;
  inMine?: boolean;
  /** `kind:id` of the item open in the panel, to highlight its row. */
  openKey?: string | null;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
}): ReactNode {
  return (
    <div className="dev-ws-wlist">
      {rows.map((r) => {
        const ref = topicRef(r.card);
        return (
          <WorkRow
            key={r.key}
            row={r}
            slug={slug}
            inMine={inMine}
            on={!!openKey && !!ref && openKey === `${ref.kind}:${ref.id}`}
            onOpen={onOpen}
          />
        );
      })}
    </div>
  );
}
