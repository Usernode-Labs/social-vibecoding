/**
 * Homeroom mobile polish, item 05 (24 Nov 2026): what is new since your last
 * visit, the pure part. The list marks it three ways in each band
 * (./lists.tsx): a dot on every new row, the new rows first with a line in
 * the accent under the last of them ("New since 9:40"), and a count in the
 * band's heading ("2 new").
 *
 * YOUR LAST VISIT is kept on the server, per person, so a phone and a
 * computer agree (src/services/ai-visits.js): when it ended (`since`) and
 * what each band held then (`seen`). ./use-visit.ts reads it each time the
 * tab is shown and tells the server what the list holds while it is up.
 *
 * A ROW IS NEW when, since then:
 *   - it arrived in its band (it is not in that band's record): a vote or
 *     another ask in Needs you (an @ too, mobile 04), a thread in In
 *     progress, a change gone live or a thread otherwise finished in Done;
 *   - it moved stage inside In progress (its list and stage differ from the
 *     record's), as `moved` marks while the page is up (./model.ts
 *     movedSince), kept across visits;
 *   - it has messages you have not read (`unread`, thread-reads.js).
 * A first visit has nothing before it: nothing is new by this rule, and
 * there is no line and no count (unread rows keep their dot).
 *
 * Done holds the whole past, and only this week's part of it (Live this
 * week) was in view at the last visit. So one of History's older rows is new
 * only when it finished after `since` as well.
 *
 * A ROW'S IDENTITY, which the record is keyed by (the server's ?demo=1
 * answer names the demo rows the same way, ai-visits.js demoVisit):
 *   need:<kind>:<id>  a card of the Needs you feed (a vote, a decision)
 *   thread:<id>       a request's, a change's or a decision's thread
 *   root:<id>         a private thread, by its first message
 */
import { dayNumber, inZone, zonedDay } from '../../lib/time-zone';
import type { AiThread, WorkRow } from './model';

/** What each band held at a visit: a row's identity, and where it stood ('' when only being there counts). */
export interface VisitSeen {
  needs: Record<string, string>;
  busy: Record<string, string>;
  done: Record<string, string>;
}

/** The visit the marks are measured from. Null on a first visit, or until it is read. */
export interface LastVisit {
  since: string;
  seen: VisitSeen;
}

/** Pure: a Needs you row's identity: its feed card's, else its private thread's, else its thread's. */
export function needIdentity(row: Pick<WorkRow, 'key' | 'rootId' | 'threadId'>): string {
  if (row.key.startsWith('need:')) return row.key;
  if (row.rootId) return `root:${row.rootId}`;
  if (row.threadId) return `thread:${row.threadId}`;
  return row.key;
}

/** Pure: a thread's identity in In progress or Done: its private thread's (one marked done), else its thread's. */
export function threadIdentity(t: Pick<AiThread, 'threadId' | 'kind'> & { rootId?: number | null }): string {
  if (t.kind === 'private' && t.rootId) return `root:${t.rootId}`;
  return `thread:${t.threadId}`;
}

/** Pure: where a thread of In progress stands: its list and its stage, as ./model.ts standingsOf says it. */
export function standingOf(t: Pick<AiThread, 'group' | 'work'>): string {
  return `${t.group}:${t.work?.stage || ''}`;
}

/**
 * Pure: what the bands hold now, for the server to keep as this visit's
 * record: every row, whatever the project filter or a search shows, since a
 * row filtered out is still one the person has had in their list.
 */
export function visitSeen(rows: readonly WorkRow[], progress: readonly AiThread[], waiting: readonly AiThread[], live: readonly AiThread[]): VisitSeen {
  const seen: VisitSeen = { needs: {}, busy: {}, done: {} };
  for (const row of rows) seen.needs[needIdentity(row)] = '';
  for (const t of [...progress, ...waiting]) seen.busy[threadIdentity(t)] = standingOf(t);
  for (const t of live) seen.done[threadIdentity(t)] = '';
  return seen;
}

/** A row opened, as the visit's record learns it: its band, identity and where it stood. */
export type OpenedEntry = [band: keyof VisitSeen, identity: string, standing: string];

/**
 * Pure: a row opened during this visit, added to what the last visit saw, so
 * it stops being new: no dot, no share of the band's count, and it sits below
 * the "New since" line. `since` is left where it was, so the line keeps its
 * time for the whole visit. Null for a first visit, which marks nothing.
 */
export function withOpened(visit: LastVisit | null, band: keyof VisitSeen, identity: string, standing: string): LastVisit | null {
  if (!visit) return null;
  return { since: visit.since, seen: { ...visit.seen, [band]: { ...(visit.seen[band] || {}), [identity]: standing } } };
}

/** Pure: the record entry opening a Needs you row adds (its feed card, its private thread, or its thread). */
export function openedNeed(row: Pick<WorkRow, 'key' | 'rootId' | 'threadId'>): OpenedEntry {
  return ['needs', needIdentity(row), ''];
}

/** Pure: the record entry opening a thread adds: In progress keeps its list and stage, Done only that it is there. */
export function openedThread(t: Pick<AiThread, 'threadId' | 'kind' | 'group' | 'work'> & { rootId?: number | null }): OpenedEntry {
  if (t.group === 'next' || t.group === 'waiting') return ['busy', threadIdentity(t), standingOf(t)];
  return ['done', threadIdentity(t), ''];
}

/** Pure: the record entry opening a History row adds, by the identity its band is keyed by. */
export function openedHistory(row: { rootId?: number | null; threadId?: number | null }): OpenedEntry {
  return ['done', row.rootId ? `root:${row.rootId}` : `thread:${row.threadId}`, ''];
}

/** Pure: whether a record of what the bands held has nothing in it (a list not read yet). */
export function seenIsEmpty(seen: VisitSeen | null | undefined): boolean {
  return !seen || (!Object.keys(seen.needs).length && !Object.keys(seen.busy).length && !Object.keys(seen.done).length);
}

/** Pure: whether a Needs you row arrived since the last visit. */
export function arrivedInNeeds(visit: LastVisit | null, row: Pick<WorkRow, 'key' | 'rootId' | 'threadId'>): boolean {
  return !!visit && !Object.prototype.hasOwnProperty.call(visit.seen.needs || {}, needIdentity(row));
}

/** Pure: whether a thread of In progress arrived there, or moved stage, since the last visit. */
export function movedInProgress(visit: LastVisit | null, t: Pick<AiThread, 'threadId' | 'kind' | 'group' | 'work'> & { rootId?: number | null }): boolean {
  if (!visit) return false;
  const was = (visit.seen.busy || {})[threadIdentity(t)];
  return was === undefined || was !== standingOf(t);
}

/**
 * Pure: whether a row of Done finished since the last visit. `thisWeek`:
 * one of Live this week's, which the record had in view; else one of
 * History's, new only when it also finished after `since`.
 */
export function arrivedInDone(visit: LastVisit | null, identity: string, at: string | null | undefined, thisWeek: boolean): boolean {
  if (!visit || Object.prototype.hasOwnProperty.call(visit.seen.done || {}, identity)) return false;
  if (thisWeek) return true;
  const finished = new Date(String(at || '')).getTime();
  const since = new Date(visit.since).getTime();
  return Number.isFinite(finished) && Number.isFinite(since) && finished > since;
}

/** Pure: a band's rows with the new ones first, each run keeping the order it came in. */
export function newFirst<T extends { isNew?: boolean }>(rows: readonly T[]): T[] {
  return [...rows.filter((row) => row.isNew), ...rows.filter((row) => !row.isNew)];
}

/**
 * Pure: where a band's line goes: before the row that follows its last new
 * one, by key. Null when nothing in the band is new or every row is, so the
 * line is drawn only between new rows and seen ones.
 */
export function lineBefore<T extends { key: string; isNew?: boolean }>(rows: readonly T[]): string | null {
  let last = -1;
  rows.forEach((row, i) => { if (row.isNew) last = i; });
  return last >= 0 && last + 1 < rows.length ? rows[last + 1].key : null;
}

/** Pure: how many of a band's rows are new, folded or not. */
export function newCount(rows: readonly { isNew?: boolean }[]): number {
  return rows.filter((row) => row.isNew).length;
}

/**
 * Pure: the time the line names, in the reader's zone and language: the
 * time of day for a visit today ("9:40"), the weekday within the week
 * ("Mon"), else the date ("12 Nov"), with the year when it is another one.
 * '' when `since` cannot be read.
 */
export function sinceWords(since: string | null | undefined, locale: string | undefined, now = Date.now()): string {
  const d = new Date(String(since || ''));
  if (!Number.isFinite(d.getTime())) return '';
  const today = new Date(now);
  const days = dayNumber(today) - dayNumber(d);
  if (days <= 0) return d.toLocaleTimeString(locale, inZone({ hour: 'numeric', minute: '2-digit' }));
  if (days < 7) return d.toLocaleDateString(locale, inZone({ weekday: 'short' }));
  const other = zonedDay(d).year !== zonedDay(today).year;
  return d.toLocaleDateString(locale, inZone({ day: 'numeric', month: 'short', ...(other ? { year: 'numeric' } : {}) }));
}

/** Pure: a server answer as a last visit, or null (a first visit, or an answer that is not one). */
export function asLastVisit(answer: unknown): LastVisit | null {
  const a = answer as { since?: unknown; seen?: unknown } | null;
  if (!a || typeof a.since !== 'string' || !Number.isFinite(new Date(a.since).getTime())) return null;
  const s = a.seen as Partial<VisitSeen> | null;
  if (!s || typeof s !== 'object') return null;
  const band = (b: unknown) => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, string> : {});
  return { since: a.since, seen: { needs: band(s.needs), busy: band(s.busy), done: band(s.done) } };
}
