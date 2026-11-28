/**
 * ALL ITEMS AS ONE LIST (28 Nov 2026). The board's second view: the same
 * items its four columns hold, read as what needs you, what waits on other
 * people, what is in progress and what is done, in the Homeroom bot tab's
 * short rows. This file is its arithmetic: which group each row is in.
 *
 * Two sources, and neither is copied:
 *
 *   the board     the four columns' rows, as AppView publishes them for the
 *                 columns (../card/cards-store, already through the filter
 *                 bar). Every row here is one of those rows.
 *   your work     the Homeroom bot tab's own lists for this project
 *                 (../../ai/desk.ts readDesk, ../../ai/lines.ts useAiLines),
 *                 which say what needs YOU by the tab's rules.
 *
 * NEEDS YOU is the tab's Needs you for this project, each drawn as its
 * board row where it has one, then every other vote the board says the
 * viewer can cast (the tab lists a vote only in a thread they are in).
 * WAITING ON OTHERS is a request Homeroom bot handed to a person who is not
 * the viewer. IN PROGRESS is the rest of what is open: being made, waiting
 * for approval, not started. DONE is the Done column.
 *
 * ONE ROW A THREAD. The columns draw a request under Underway and the
 * change made for it under Waiting for approval. Here the request's row
 * gives way to its change's, and only then: a request with no change or
 * session row of its own on the list keeps its row, so nothing the columns
 * show is missing here.
 *
 * Pure; no React, no catalog. The component words what this decides.
 */

import type { ListRow } from '../card/model';
import { topicRef, type CardRow, type TopicRef } from '../workshop/work-row';

export type BoardCol = 'issues' | 'inprogress' | 'inreview' | 'done';
export const BOARD_COLS: readonly BoardCol[] = ['issues', 'inprogress', 'inreview', 'done'];

/** One card row of the board, with where it came from and which thread it is. */
export interface Entry {
  key: string;
  col: BoardCol;
  row: CardRow;
  /** The thread it belongs to: its request's (`r:18`), else its own. */
  thread: string;
  ref: TopicRef | null;
}

/** A row of the tab's Needs you for this project, as much of it as placing it takes. */
export interface YourNeed<L> {
  key: string;
  /** The thread its page is (./model.ts threadOfHref), or null for a private thread. */
  thread: string | null;
  /** It asks for a vote (the Needs you feed's proposal, decision or pick). */
  vote: boolean;
  line: L;
}

/** What a row ends in: the model's half of it. */
export type RowEnd =
  /** The tab's own verb for it ("Vote", "Fix it", "Review plan"): the line's. */
  | { kind: 'line' }
  /** A vote the board says the viewer can cast. */
  | { kind: 'vote' }
  /** A request of the viewer's own that waits on them, with the tab's lists not read. */
  | { kind: 'yours'; why: string | null }
  /** A request that waits on somebody else. */
  | { kind: 'waits'; why: string | null; who: string }
  /** Where the board's row says it stands (its tag or its pill), or nothing. */
  | { kind: 'row' }
  /** Live. */
  | { kind: 'tick' };

export interface Item<L> {
  key: string;
  entry: Entry | null;
  line: L | null;
  end: RowEnd;
}

export interface Groups<L> {
  needs: Item<L>[];
  others: Item<L>[];
  /** In progress, in three runs: being made, waiting for approval, not started. */
  making: Item<L>[];
  review: Item<L>[];
  backlog: Item<L>[];
  done: Item<L>[];
}

const isCard = (row: ListRow): row is CardRow => row.t === 'card';

/** Pure: the thread a board row belongs to. */
export function threadOfRow(row: CardRow, ref: TopicRef | null = topicRef(row.card)): string {
  const b = row.brief;
  if (b && b.kind === 'request' && b.n) return `r:${b.n}`;
  // A vote to close a request is decided on the request's page.
  if (ref && ref.kind === 'issue') return `r:${ref.id}`;
  if (ref && ref.kind === 'gov') return `g:${ref.id}`;
  if (b && b.kind !== 'live' && b.linked.length) return `r:${b.linked[0]}`;
  if (ref) return `c:${ref.id}`;
  return `k:${row.key}`;
}

/** Pure: the board's card rows, column by column, in the order the columns draw them. */
export function entriesOf(cols: readonly { key: string; rows: readonly ListRow[] }[]): Entry[] {
  const out: Entry[] = [];
  for (const col of cols) {
    if (!BOARD_COLS.includes(col.key as BoardCol)) continue;
    for (const row of col.rows) {
      if (!isCard(row) || !row.brief) continue;
      const ref = topicRef(row.card);
      out.push({ key: row.key, col: col.key as BoardCol, row, thread: threadOfRow(row, ref), ref });
    }
  }
  return out;
}

/** Pure: a column's rows that are not cards or dividers (its archived sessions, a note): drawn as they are. */
export function restOf(cols: readonly { key: string; rows: readonly ListRow[] }[], key: BoardCol): ListRow[] {
  const col = cols.find((c) => c.key === key);
  return col ? col.rows.filter((row) => row.t !== 'card' && row.t !== 'divider') : [];
}

/**
 * Pure: one row a thread. A request's row is left out when a change or a
 * session for it has a row of its own among the open columns, and only then.
 */
export function onePerThread(entries: readonly Entry[]): Entry[] {
  const covered = new Set<number>();
  for (const e of entries) {
    const b = e.row.brief!;
    if (e.col === 'done' || b.kind === 'request') continue;
    for (const n of b.linked) covered.add(Number(n));
  }
  return entries.filter((e) => {
    const b = e.row.brief!;
    return !(e.col !== 'done' && b.kind === 'request' && b.n != null && covered.has(Number(b.n)));
  });
}

/**
 * Pure: the thread a page address names, as the board keys its rows:
 * `#app/<slug>/dev/issues/18` is the request's, `…/dev/changes/41` the
 * thread of the change the board numbers 41, `…/dev/governance/7` the
 * decision's. Null for another project's page or any other address.
 */
export function threadOfHref(href: string | null | undefined, slug: string, entries: readonly Entry[]): string | null {
  const match = /^#?\/?app\/([^/?#]+)\/dev\/(issues|changes|governance|proposals|sessions|shared)\/(\d{1,10})/.exec(String(href || ''));
  if (!match) return null;
  let named = match[1];
  try { named = decodeURIComponent(named); } catch { /* as written */ }
  if (named !== slug) return null;
  const n = Number(match[3]);
  if (match[2] === 'issues') return `r:${n}`;
  if (match[2] === 'governance') return `g:${n}`;
  const byNumber = match[2] === 'changes';
  const found = entries.find((e) => {
    const b = e.row.brief!;
    if (b.kind === 'request' || b.kind === 'vote') return false;
    return byNumber ? Number(b.n) === n : !!e.ref && e.ref.kind === 'proposal' && e.ref.id === n;
  });
  return found ? found.thread : `c:${byNumber ? `n${n}` : n}`;
}

/** Pure: the row of a thread a need is drawn as: the one asking for a vote when the need is a vote, else its first. */
function rowFor(thread: string, vote: boolean, open: readonly Entry[]): Entry | null {
  const rows = open.filter((e) => e.thread === thread);
  if (!rows.length) return null;
  if (vote) return rows.find((e) => e.row.brief!.vote?.ask) || rows.find((e) => !!e.row.brief!.vote) || rows[0];
  return rows[0];
}

/**
 * Pure: the four groups.
 *
 * `needs` is the tab's Needs you for this project, in the tab's order, or
 * null while it has not been read (then a request of the viewer's own that
 * waits on them is still Needs you's, by the board's own word for it).
 * `filtering` is the filter bar narrowing the board: then only rows the
 * board still shows are listed, so a need with no row of its own (a private
 * thread) waits for the filter to clear.
 */
export function groupAll<L>({ entries, needs, filtering = false }: {
  entries: readonly Entry[];
  needs: readonly YourNeed<L>[] | null;
  filtering?: boolean;
}): Groups<L> {
  const kept = onePerThread(entries);
  const open = kept.filter((e) => e.col !== 'done');
  const taken = new Set<string>();
  const out: Groups<L> = { needs: [], others: [], making: [], review: [], backlog: [], done: [] };

  for (const need of needs || []) {
    const entry = need.thread ? rowFor(need.thread, need.vote, open.filter((e) => !taken.has(e.key))) : null;
    if (entry) {
      // The board is pushed every vote and every check; the tab's lists are
      // read now and then. Where the board says no vote is asked of the
      // viewer (they voted a moment ago, or it is being checked again), the
      // row stays where the board has it.
      const vote = entry.row.brief!.vote;
      if (need.vote && vote && !vote.ask) continue;
      taken.add(entry.key);
      out.needs.push({ key: need.key, entry, line: need.line, end: { kind: 'line' } });
    } else if (!filtering) {
      out.needs.push({ key: need.key, entry: null, line: need.line, end: { kind: 'line' } });
    }
  }
  for (const e of open) {
    if (taken.has(e.key)) continue;
    const b = e.row.brief!;
    if (b.vote?.ask) {
      taken.add(e.key);
      out.needs.push({ key: e.key, entry: e, line: null, end: { kind: 'vote' } });
    } else if (b.kind === 'request' && b.waits && b.mine && needs === null) {
      taken.add(e.key);
      out.needs.push({ key: e.key, entry: e, line: null, end: { kind: 'yours', why: b.waits.why } });
    }
  }
  for (const e of open) {
    if (taken.has(e.key)) continue;
    const b = e.row.brief!;
    if (b.kind === 'request' && b.waits && !b.mine) {
      out.others.push({ key: e.key, entry: e, line: null, end: { kind: 'waits', why: b.waits.why, who: b.waits.who } });
      continue;
    }
    const item: Item<L> = { key: e.key, entry: e, line: null, end: { kind: 'row' } };
    if (e.col === 'inprogress') out.making.push(item);
    else if (e.col === 'inreview') out.review.push(item);
    else out.backlog.push(item);
  }
  for (const e of kept) {
    if (e.col === 'done') out.done.push({ key: e.key, entry: e, line: null, end: { kind: 'tick' } });
  }
  return out;
}

/** Pure: how many rows In progress holds, its three runs together. */
export function progressCount<L>(g: Groups<L>): number {
  return g.making.length + g.review.length + g.backlog.length;
}

/** How many not-started requests In progress shows before "Show all". */
export const BACKLOG_FIRST = 4;
