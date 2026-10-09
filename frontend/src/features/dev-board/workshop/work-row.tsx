/**
 * The Workshop's row (#4457, #4486): one item, in one hairline-divided list.
 *
 * ONE ROW, THREE SURFACES. The Workshop tab's lists (Your work, Since your
 * last visit and a week's page), All items' board columns and its By
 * category lanes all draw this row now (#4486). The board and By category
 * used to draw the folded card (../card/fold.tsx), which wore a coloured
 * edge and a coloured glyph the column already said, named its author and
 * its provenance twice, and unfolded in place under a ⇕. A row here is:
 *
 *   - on the Workshop tab, a neutral tile (what kind of thing it is: the tab
 *     mixes requests, changes and live work in one list); none on the board,
 *     whose column says it;
 *   - the title, 15px;
 *   - one line in the board's words: "PR #4456 · evan · for #4452 and #4455
 *     · 4m ago", "#4417 · evan · 8h ago" (`rowWords`);
 *   - a tags line: on live work the card's own "✓ Live" bar at its words'
 *     width first, then the card's coloured category chip and its 💬 count
 *     (dev-card.tsx's own pieces, unchanged), then small tags for what is
 *     happening on it ("Picked up · zura", "Checks passed",
 *     AppView._workshopBrief), and on the Workshop tab a change's bar and
 *     Vote at the line's right end;
 *   - ☰, the card's own menu trigger with the card's own key, so
 *     `_toggleCardMenu`, the touch action sheet and every item in it work
 *     unchanged;
 *   - on the board, under all that, the card's status bar and Vote across
 *     the row (fold.tsx `RowBand`), except on live work.
 *
 * THE ROW OPENS THE ITEM'S PAGE. Its title is a real link to the page's
 * route, stretched over the row (app.css `.dev-ws-wrow-link::after`), so a
 * modified click, a middle click and "Open in new tab" are the browser's,
 * and on a phone a tap is that link: the page takes the screen. On a wide
 * window the Workshop catches the plain click and opens the same page in the
 * panel beside the list or the board (`onOpen`, ./side-panel.tsx). The chips,
 * the bar, Vote and ☰ sit above the stretched link, so each does its own job.
 *
 * THE HOOKS. A board row carries the item's `data-issue-row` and its
 * siblings, as the folded card it replaces did: the declared checks name an
 * item by them, and the Done column's scroll anchor and the attribute
 * popover's fallback anchor look items up by them. The delegated `#dev-body`
 * handler that opens a card full-screen on those hooks stands aside for a
 * click inside any row (`AppView._inFoldWrapper`), because the row's own
 * link does that job. The Workshop tab's rows carry none (`data-ws-open`
 * names the item instead), as they never have.
 */

import type { MouseEvent, ReactNode } from 'react';

import {
  BallotIcon, ChatBubbleTailIcon, CheckIcon, EyeIcon, LockIcon, PencilSquareIcon,
} from '@/components/ui/icons';

import { CategoryChip, ChatCount, ChecksBar, MenuTrigger, VoteButton } from '../card/dev-card';
import { itemHooks, openHref, RowBand, StatePill, voteSpecs } from '../card/fold';
import type { DevCardModel, ListRow, RowBrief, RowTag } from '../card/model';

export type CardRow = Extract<ListRow, { t: 'card' }>;

/**
 * Which surface draws the row. `list`: the Workshop tab's lists, with the
 * tile and the bar beside Vote on the tags line. `board`: All items' columns
 * and By category's lanes, with no tile and the card's bar across the row.
 */
export type RowVariant = 'list' | 'board';

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

/** The item's number as the board says it: "#4417", "PR #4456", "Vote #7". */
function numberWords(b: RowBrief): string {
  if (!b.n) return b.noun;
  if (b.kind === 'request') return `#${b.n}`;
  if (b.noun === 'Vote') return `Vote #${b.n}`;
  return `PR #${b.n}`;
}

/**
 * The row's one line, in the board's words (#4486): the number, who made it,
 * the requests a change is for (or a live one closed), and when.
 * "PR #4456 · evan · for #4452 and #4455 · 4m ago", "#4417 · evan · 8h ago",
 * "PR #4454 · evan · closed #4453 · 1h ago". The category and the replies
 * are the coloured chip and the 💬 count on the tags line, so they are not
 * said here too.
 */
export function rowWords(b: RowBrief): string {
  const parts: string[] = [numberWords(b)];
  if (b.by) parts.push(b.by);
  if (b.linked.length && b.kind !== 'live') parts.push(`for ${numbers(b.linked)}`);
  if (b.closed.length && b.kind === 'live') parts.push(`closed ${numbers(b.closed)}`);
  if (b.ago) parts.push(b.ago);
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
    <span className="dev-ws-tag" data-tone={t.tone} title={t.title}>
      {t.tone === 'run' ? <span className="dc-status-spinner-arc" aria-hidden="true" /> : null}
      {t.tone === 'ok' ? <CheckIcon aria-hidden="true" /> : null}
      {t.glyph === 'eye' ? <EyeIcon aria-hidden="true" /> : null}
      {t.glyph === 'lock' ? <LockIcon aria-hidden="true" /> : null}
      {t.label}
      {t.progress ? <ChecksBar progress={t.progress} /> : null}
    </span>
  );
}

/**
 * A change's vote on the Workshop tab (#4486): the card's own status pill,
 * with its own words ("0 of 1 approval"), at its words' width plus the 56px
 * the thin bar it replaces took (app.css `.dev-ws-wvote-state`), and the
 * card's own Vote button, at the right end of the tags line.
 */
function Votes({ card }: { card: DevCardModel }): ReactNode {
  const s = card.pill?.state || null;
  const specs = voteSpecs(card);
  if (!s && !specs) return null;
  return (
    <span className="dev-ws-wvote" data-ws-vote="">
      {s ? <StatePill s={s} className="dev-ws-wvote-state" /> : null}
      {specs ? <span className="dev-ws-wvote-btn"><VoteButton yes={specs.yes} no={specs.no} /></span> : null}
    </span>
  );
}

export function WorkRow({
  row, slug, on = false, onOpen, variant = 'list', category = true,
}: {
  row: CardRow;
  slug: string;
  /** Its page is open in the panel beside the list. */
  on?: boolean;
  /** A plain click on the row: the Workshop opens it beside the list, or lets the link go. */
  onOpen?: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
  variant?: RowVariant;
  /** Draw the card's category chip. By category's lanes pass false: the group is the category. */
  category?: boolean;
}): ReactNode {
  const b = row.brief;
  if (!b) return null;
  const card = row.card;
  const board = variant === 'board';
  const href = openHref(slug, card);
  const ref = topicRef(card);
  const Tile = TILE[b.kind] || PencilSquareIcon;
  const pill = card.pill?.state || null;
  // Live work leads its tags with the card's own bar at its words' width
  // ("✓ Live"), in place of the small Live tag the brief carries.
  const live = b.kind === 'live' && !!pill;
  const tags = live ? b.tags.filter((t) => t.label !== 'Live') : b.tags;
  const hasChip = category && (card.badges || []).some((x) => x && x.t === 'attr' && x.field === 'category');
  const hasChat = (card.chatCount || 0) > 0;
  const chip = hasChip ? <CategoryChip card={card} /> : null;
  const chat = hasChat ? <ChatCount card={card} /> : null;
  // The Workshop tab's bar and Vote ride the tags line; the board's ride
  // the band under it.
  const votes = !board && b.vote ? <Votes card={card} /> : null;
  const status = live || hasChip || hasChat || tags.length > 0 || !!votes;
  const menuKey = card.rail && card.rail.menuKey ? card.rail.menuKey : '';
  const specs = board && !live ? voteSpecs(card) : null;
  return (
    <div
      className={board ? 'dev-ws-wrow dev-ws-brow' : 'dev-ws-wrow'}
      data-ws-row={row.key}
      data-ws-kind={b.kind}
      data-ws-open={ref ? `${ref.kind}:${ref.id}` : undefined}
      data-on={on ? '1' : undefined}
      {...(board ? itemHooks(card) : {})}
    >
      {board ? null : <span className="dev-ws-wrow-tile" data-kind={b.kind} aria-hidden="true"><Tile aria-hidden="true" /></span>}
      <span className="dev-ws-wrow-main">
        {href ? (
          <a
            className="dev-ws-wrow-link"
            href={href}
            aria-current={on ? 'true' : undefined}
            onClick={ref && onOpen ? (e) => onOpen(e, ref) : undefined}
          >
            {card.title.text}
          </a>
        ) : <span className="dev-ws-wrow-link">{card.title.text}</span>}
        <span className="dev-ws-wrow-sub">{rowWords(b)}</span>
        {status ? (
          <span className="dev-ws-wrow-status">
            {live && pill ? <StatePill s={pill} className="dev-ws-wrow-live" /> : null}
            {chip}
            {chat}
            {tags.map((t) => <Tag key={`${t.label}:${t.tone}`} t={t} />)}
            {votes}
          </span>
        ) : null}
      </span>
      {menuKey ? <span className="dev-ws-wrow-menu"><MenuTrigger menuKey={menuKey} /></span> : null}
      {board && !live ? (
        <RowBand card={card} chips={false} trailing={specs ? <VoteButton yes={specs.yes} no={specs.no} /> : null} />
      ) : null}
    </div>
  );
}

/** A hairline-divided list of rows. */
export function WorkList({ rows, slug, openKey, onOpen, variant = 'list', category = true }: {
  rows: CardRow[];
  slug: string;
  /** `kind:id` of the item open in the panel, to highlight its row. */
  openKey?: string | null;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
  variant?: RowVariant;
  category?: boolean;
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
            on={!!openKey && !!ref && openKey === `${ref.kind}:${ref.id}`}
            onOpen={onOpen}
            variant={variant}
            category={category}
          />
        );
      })}
    </div>
  );
}
