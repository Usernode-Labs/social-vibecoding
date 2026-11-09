/**
 * WHAT THE COLUMN BESIDE THE LIST SHOWS (3 Nov 2026, #6207/#6210/#6212/
 * #6215/#6218). One answer, read by everything that used to keep its own:
 *
 *   main            Main Chat
 *   thread <root>   one private thread, alone in the column
 *   page <route>    a request, a change or a decision, on its own page
 *                   (the side panel, drawn as the column)
 *   new             a blank thread from "+"
 *   null            nothing beside the lists: a phone's list, before the page
 *                   has mounted, or a desktop with nothing opened yet
 *
 * On a desktop `null` is where the page starts (6 Nov 2026, #6425): the bare
 * tab address is `null`, and `#homeroom-bot/main` is Main. The page
 * (./index.tsx) works the column out once from what holds it (the
 * Messages store's route, the side panel, the blank thread, a phone's level)
 * and every reader takes it from there:
 *
 *   the lit row         columnKey(column) === rowKey(row)
 *   the address         columnAddress(column)
 *   Main's attachment   attachmentFor(before, after, how)
 *
 * A row says where it goes (rowColumn), and every row goes to its own place:
 * a ▷ plan row to its request's page, the same place its Vote or Decide row
 * opens, never Main (B06 is gone with #6210).
 *
 * Pure; no React.
 */

import { BOT_TAB, botItemAddress, botItemFromRoute, botTabAddress } from './door';
import { detailAddress, type DetailKind } from './detail';

/** What is open beside the thread, as the address names it (#6230). */
export type ColumnDetail =
  | { kind: 'plan'; sessionId: number; version: number | null }
  | { kind: 'design'; version: number | null }
  | { kind: 'shots'; changeId: number };

export type Column =
  | { at: 'main'; detail?: ColumnDetail }
  | { at: 'thread'; rootId: number; detail?: ColumnDetail }
  | { at: 'page'; route: string; detail?: ColumnDetail }
  | { at: 'new'; detail?: ColumnDetail }
  | null;

/** Pure: a panel route as the column holds it, with no leading '#' or '/'. */
export function routeOf(href: string | null | undefined): string | null {
  const route = String(href || '').replace(/^#/, '').replace(/^\/+/, '').split('?')[0];
  return route ? route : null;
}

/** Pure: the one string two columns share when they show the same place. */
export function columnKey(column: Column): string | null {
  if (!column) return null;
  if (column.at === 'main') return 'main';
  if (column.at === 'thread') return `private:${column.rootId}`;
  if (column.at === 'page') return `page:${column.route}`;
  return 'new';
}

/** Pure: where a row of the lists goes: its private thread, else its page. */
export function rowColumn(row: { rootId?: number | null; href?: string | null }): Column {
  if (row.rootId) return { at: 'thread', rootId: row.rootId };
  const route = routeOf(row.href);
  return route ? { at: 'page', route } : null;
}

/** Pure: the key a row is lit by, the same as the column it opens. */
export function rowKey(row: { rootId?: number | null; href?: string | null }): string | null {
  return columnKey(rowColumn(row));
}

/**
 * Pure: the tab's address for what the column shows, so a reload reopens it.
 * A page has one when it is a request, a change or a decision (#6215); any
 * other page, a blank thread and nothing are the tab itself.
 */
export function columnAddress(column: Column): string {
  if (!column) return BOT_TAB;
  const base = columnAddressBase(column);
  const detail = column.detail;
  if (!detail) return base;
  const suffix = detailAddress(
    detail.kind as DetailKind,
    detail.kind === 'plan' ? { sessionId: detail.sessionId } : detail.kind === 'shots' ? { changeId: detail.changeId } : {},
    detail.kind === 'plan' || detail.kind === 'design' ? detail.version : null,
  );
  return suffix ? `${base}${suffix}` : base;
}

/** Pure: the tab's address for the column's place alone, with no detail suffix. */
function columnAddressBase(column: Column): string {
  if (!column) return BOT_TAB;
  if (column.at === 'main') return botTabAddress(null);
  if (column.at === 'thread') return botTabAddress({ threadRootId: column.rootId });
  if (column.at === 'page') {
    const item = botItemFromRoute(column.route);
    return item ? botItemAddress(item) : BOT_TAB;
  }
  return BOT_TAB;
}

/**
 * How the column came to show what it does: `row` (a row, Main Chat's row,
 * "+", the router's ask: anything this page opened) or `back` (the column's
 * own ×, which closed it).
 */
export type ColumnHow = 'row' | 'back';

/**
 * Pure (#6212): what Main's composer does with the item the list attached,
 * when the column goes from `before` to `after`.
 *
 *   'attach'  a page opened from the list: it becomes what a question is about
 *   'keep'    ‹ Main Chat back from that page: it stays, as designed (30 Oct)
 *   'clear'   anywhere else: the list's attachment comes off
 *   'none'    nothing changed
 *
 * The composer never lets the list clear or replace an item the person chose
 * themselves (../messages/composer.tsx `objectFrom`).
 */
export function attachmentFor(before: Column, after: Column, how: ColumnHow): 'attach' | 'keep' | 'clear' | 'none' {
  if (columnKey(before) === columnKey(after)) return 'none';
  if (after?.at === 'page') return 'attach';
  if (after?.at === 'main' && before?.at === 'page' && how === 'back') return 'keep';
  if (!after) return 'none';
  return 'clear';
}
