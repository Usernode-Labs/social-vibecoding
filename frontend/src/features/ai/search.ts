/**
 * THE TAB'S SEARCH, IN WHAT WAS SAID (13 Nov 2026). The search box narrowed
 * the rows on the page by title, number and project (./lines.ts). A tester
 * typed "improve" and was told nothing matched, although they had written
 * "I want to improve my app." to the bot. So the box also asks the server
 * for the person's own chat with Homeroom bot and its threads
 * (GET /api/ai/search, src/services/ai-search.js), and the messages that
 * match are listed under the threads that do, each a link to that message.
 *
 *   typing        one read, SEARCH_WAIT after the last key; an answer to a
 *                 question no longer asked is dropped
 *   while it reads nothing new is drawn: the last answer stays until the
 *                 next one arrives, so the list does not blink
 *   under two characters, or signed out: nothing is asked (`unasked`)
 *   a read that failed says so (`failed`), with a way to ask again
 *
 * The snippet arrives as plain text with the places the words were found
 * (`ranges`). `markParts` splits it there, and each face draws the marked
 * parts as <mark> elements: no markup is ever read from the answer.
 */
import { useCallback, useEffect, useState } from 'react';

/** A shorter query is not asked (the server's own floor, ai-search.js MIN_CHARS). */
export const SEARCH_MIN = 2;
/** The longest query asked (ai-search.js MAX_CHARS). */
export const SEARCH_MAX = 100;
/** How long after the last key the read is made, in milliseconds. */
export const SEARCH_WAIT = 250;

/** One message that matched, as the server sends it. */
export interface FoundRow {
  messageId: number;
  /** Its thread's first message; null when the answer names none (the tab then asks which, ./where.ts). */
  rootId: number | null;
  /** That thread's name, as the tab's list names it. */
  threadTitle: string | null;
  /** The person wrote it; otherwise Homeroom bot did. */
  mine: boolean;
  snippet: string;
  /** Where the words are in `snippet`: [start, end) pairs, in order. */
  ranges: [number, number][];
  at: string | null;
}

/**
 * What the search in messages knows about one query: `answered` (the rows
 * that matched, none included), `unasked` (too short, or nobody signed in:
 * the messages were not searched) or `failed` (the read did not come back).
 */
export interface Found {
  /** The query this is about, cleaned (cleanQuery). */
  q: string;
  rows: FoundRow[];
  /** There were more matches than the rows sent. */
  more: boolean;
  state: 'answered' | 'unasked' | 'failed';
}

/** Pure: what was typed, as the search asks it: one line, trimmed, SEARCH_MAX at most (ai-search.js cleanQuery). */
export function cleanQuery(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, SEARCH_MAX).trim();
}

/** Pure: the read for a query. */
export function searchPath(q: string, demo = false): string {
  const query = new URLSearchParams({ q });
  if (demo) query.set('demo', '1');
  return `/api/ai/search?${query.toString()}`;
}

const id = (value: unknown): number | null => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
);

/** Pure: the ranges that are inside `snippet`, in order, none overlapping the one before. */
function cleanRanges(ranges: unknown, snippet: string): [number, number][] {
  if (!Array.isArray(ranges)) return [];
  const out: [number, number][] = [];
  let from = 0;
  for (const range of ranges) {
    if (!Array.isArray(range)) continue;
    const [start, end] = range as unknown[];
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if ((start as number) < from || (end as number) <= (start as number) || (end as number) > snippet.length) continue;
    out.push([start as number, end as number]);
    from = end as number;
  }
  return out;
}

/** Pure: the server's answer for `q`, with anything that is not a row taken out. */
export function cleanFound(body: unknown, q: string): Found {
  const said = body && typeof body === 'object' ? body as { rows?: unknown; more?: unknown } : {};
  const rows: FoundRow[] = [];
  for (const raw of Array.isArray(said.rows) ? said.rows : []) {
    const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    const messageId = id(row?.messageId);
    if (!row || !messageId || typeof row.snippet !== 'string' || !row.snippet) continue;
    rows.push({
      messageId,
      rootId: id(row.rootId),
      threadTitle: typeof row.threadTitle === 'string' && row.threadTitle ? row.threadTitle : null,
      mine: row.mine === true,
      snippet: row.snippet,
      ranges: cleanRanges(row.ranges, row.snippet),
      at: typeof row.at === 'string' ? row.at : null,
    });
  }
  return { q, rows, more: said.more === true, state: 'answered' };
}

/** A run of a snippet: plain, or the words that were searched for. */
export interface MarkPart {
  text: string;
  hit: boolean;
}

/**
 * Pure: a snippet split at its ranges, so the found words can be drawn as
 * <mark> elements. A range outside the text, or one that starts before the
 * last one ended, is left unmarked rather than guessed at.
 */
export function markParts(snippet: string, ranges: readonly (readonly [number, number])[] | null | undefined): MarkPart[] {
  const text = String(snippet ?? '');
  const parts: MarkPart[] = [];
  let from = 0;
  for (const [start, end] of cleanRanges(ranges, text)) {
    if (start > from) parts.push({ text: text.slice(from, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    from = end;
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false });
  return parts;
}

/** Pure: the day a found message was written ("3 Nov"), with its year when that is another one. */
export function foundDay(at: string | null | undefined, locale: string | undefined, now: Date = new Date()): string {
  const d = new Date(String(at || ''));
  if (!Number.isFinite(d.getTime())) return '';
  const other = d.getFullYear() !== now.getFullYear();
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', ...(other ? { year: 'numeric' } : {}) });
}

/**
 * The messages that match what the search box says. `found` is null until
 * the first answer; while a later query is being read it is still the
 * answer before it (its `q` says which), so the page keeps what it drew.
 */
export function useBotSearch(query: string, { signedIn, demo }: { signedIn: boolean; demo: boolean }): {
  found: Found | null;
  retry: () => void;
} {
  const q = cleanQuery(query);
  const [found, setFound] = useState<Found | null>(null);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (!q) { setFound(null); return undefined; }
    if (q.length < SEARCH_MIN || !signedIn) {
      setFound({ q, rows: [], more: false, state: 'unasked' });
      return undefined;
    }
    // This effect is the question: once the query moves on (or the page
    // goes), its answer is nobody's.
    let asked = true;
    const stop = typeof AbortController === 'undefined' ? null : new AbortController();
    const timer = setTimeout(() => {
      void fetch(searchPath(q, demo), { credentials: 'same-origin', signal: stop?.signal })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)
        .then((body: unknown) => {
          if (!asked) return;
          setFound(body ? cleanFound(body, q) : { q, rows: [], more: false, state: 'failed' });
        });
    }, SEARCH_WAIT);
    return () => { asked = false; clearTimeout(timer); stop?.abort(); };
  }, [q, signedIn, demo, again]);
  const retry = useCallback(() => setAgain((n) => n + 1), []);
  return { found, retry };
}
