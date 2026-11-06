/**
 * The Homeroom bot tab's History card (5 Nov 2026): your work in the past
 * tense, below Live this week. GET /api/ai/history reads the same threads the
 * lists above read, once they have left them (services/ai-history.js), so a
 * thread is in one place or the other and never both:
 *
 *   HISTORY
 *   ( All ) ( Changes ) ( Requests ) ( Votes ) ( Only you )
 *   [tile] Garden club
 *     ✓ #392  Watering reminders                    Live Oct 24
 *     ✕ #380  Sign in with a code                        Closed
 *     ☑       A new card picture              You: yes · passed
 *   [tile] Book swap · You left
 *     ✓ #31   Swap requests                          Live Oct 3
 *                Earlier months ⌄
 *
 * One list per project, newest project first (./model.ts byProject, as every
 * list on the page). No date headings split it: each row keeps the date it
 * ended (or went live) on its right. Rows are quiet as Live this week's are:
 * a finished thing gets no fill, and the word on the right is how it ended.
 * The project chips at
 * the top narrow it like the rest; its own chips pick a kind, which were Me ›
 * Your work's three tabs (Your changes, Your requests, Your votes), plus your
 * private threads with Homeroom bot. That screen is gone; its addresses land
 * here (./filter-address.ts historyAddress).
 *
 * This module is the card's pure part and the hook that reads it; ./lists.tsx
 * draws it. A row's words are phrases, translated where they are drawn.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { HistoryKind } from './filter-address';
import type { AiApp, Phrase } from './model';

export interface HistoryRow {
  key: string;
  threadId?: number;
  rootId?: number;
  number: number | null;
  title: string | null;
  app: AiApp | null;
  href: string | null;
  at: string | null;
  kind: HistoryKind;
  outcome: 'live' | 'closed' | 'shipped' | 'merged' | 'passed' | 'withdrawn' | 'done' | 'put_away' | 'filed_shipped' | 'filed_closed';
  by?: 'you' | 'bot';
  myVote?: 'yes' | 'no';
  decision?: boolean;
  /** A change with no request of its own: its number is its PR's. */
  change?: boolean;
  /** A private project they are no longer in: only what they made stays. */
  left?: boolean;
  /** A private thread filed as a request: that request's number. */
  resultRef?: number;
}

export interface HistoryPage {
  rows: HistoryRow[];
  next: string | null;
}

/** Pure: a day as History's rows say it, "Oct 24". */
export function shortDay(at: string | null | undefined, locale: string | undefined): string {
  const d = new Date(String(at || ''));
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

const VOTE_WORDS: Record<string, Record<'yes' | 'no', string>> = {
  merged: { yes: 'messages:ai.history.yesMerged', no: 'messages:ai.history.noMerged' },
  closed: { yes: 'messages:ai.history.yesClosed', no: 'messages:ai.history.noClosed' },
  passed: { yes: 'messages:ai.history.yesPassed', no: 'messages:ai.history.noPassed' },
  withdrawn: { yes: 'messages:ai.history.yesWithdrawn', no: 'messages:ai.history.noWithdrawn' },
};

/** Pure: the word on the right of a History row: how it ended, and how you voted. */
export function historyWords(row: HistoryRow, locale?: string): Phrase {
  if (row.kind === 'vote' && row.myVote) {
    const words = VOTE_WORDS[row.outcome] || VOTE_WORDS.closed;
    return { id: words[row.myVote] };
  }
  switch (row.outcome) {
    case 'live': return { id: 'messages:ai.history.live', values: { date: shortDay(row.at, locale) } };
    case 'shipped': return { id: 'messages:ai.history.shipped' };
    case 'passed': return { id: 'messages:ai.history.passed' };
    case 'withdrawn': return { id: 'messages:ai.history.withdrawn' };
    case 'done': return { id: 'messages:ai.history.done' };
    case 'put_away': return { id: 'messages:ai.history.putAway' };
    case 'filed_shipped': return { id: 'messages:ai.history.filedShipped', values: { number: row.resultRef || '' } };
    case 'filed_closed': return { id: 'messages:ai.history.filedClosed', values: { number: row.resultRef || '' } };
    default: return { id: 'messages:ai.history.closed' };
  }
}

/** Pure: a History row's whole line (its tooltip): its project and number, as the lists' rows say them. */
export function historyTooltip(row: HistoryRow): Phrase {
  const project = row.app?.name || row.app?.slug || '';
  if (!row.app) return { id: 'messages:ai.short.private' };
  if (row.number) {
    return row.change && row.app.changesOnGithub
      ? { id: 'messages:ai.history.wherePr', values: { project, number: row.number } }
      : { id: 'messages:ai.row.where', values: { project, number: row.number } };
  }
  return { id: 'messages:ai.row.project', values: { project } };
}

/** Pure: which glyph a History row wears (./lists.tsx draws it). */
export function historyGlyph(row: HistoryRow): 'live' | 'closed' | 'request' | 'vote' | 'private' {
  if (row.kind === 'solo') return 'private';
  if (row.kind === 'vote') return 'vote';
  if (row.kind === 'request') return 'request';
  return row.outcome === 'live' ? 'live' : 'closed';
}

/**
 * Pure: the read History's first page asks for. One project picked: the
 * server narrows to it (its pages are that project's); several: every row,
 * which the card narrows as the other lists are narrowed.
 */
export function historyPath(opts: { projects: readonly string[]; kind: HistoryKind | null; before?: string | null; demo?: boolean }): string {
  const query = new URLSearchParams();
  if (opts.projects.length === 1) query.set('project', opts.projects[0]);
  if (opts.kind) query.set('kind', opts.kind);
  if (opts.before) query.set('before', opts.before);
  if (opts.demo) query.set('demo', '1');
  const qs = query.toString();
  return `/api/ai/history${qs ? `?${qs}` : ''}`;
}

export interface HistoryState {
  rows: HistoryRow[];
  /** More to read, from here (Earlier months). */
  next: string | null;
  /** The first page has been read (until then the card says nothing). */
  ready: boolean;
  loading: boolean;
  failed: boolean;
  more: () => void;
  retry: () => void;
}

/**
 * The card's rows: read once the page is shown to somebody signed in, again
 * whenever the projects picked or the kind change, and again on each showing
 * (`showing`), since things finish while you are elsewhere. Earlier months
 * reads the next page and adds it under what is drawn. A read that fails says
 * so (`failed`) and keeps what was drawn.
 */
export function useHistory({ showing, signedIn, projects, kind, demo }: {
  showing: number;
  signedIn: boolean;
  projects: readonly string[];
  kind: HistoryKind | null;
  demo: boolean;
}): HistoryState {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [again, setAgain] = useState(0);
  const seq = useRef(0);
  const projectsKey = projects.join(',');
  const read = useCallback(async (before: string | null, mine: number): Promise<HistoryPage | null> => {
    try {
      const res = await fetch(historyPath({ projects, kind, before, demo }), { credentials: 'same-origin' });
      if (!res.ok) return null;
      const body = await res.json() as Partial<HistoryPage>;
      if (mine !== seq.current) return null;
      return { rows: Array.isArray(body.rows) ? body.rows : [], next: typeof body.next === 'string' ? body.next : null };
    } catch {
      return null;
    }
  }, [projectsKey, kind, demo]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!showing || !signedIn) return undefined;
    const mine = ++seq.current;
    setLoading(true);
    void read(null, mine).then((page) => {
      if (mine !== seq.current) return;
      setLoading(false);
      if (!page) { setFailed(true); setReady(true); return; }
      setFailed(false);
      setRows(page.rows);
      setNext(page.next);
      setReady(true);
    });
    return undefined;
  }, [showing, signedIn, read, again]);
  const more = useCallback(() => {
    if (!next || loading) return;
    const mine = seq.current;
    setLoading(true);
    void read(next, mine).then((page) => {
      if (mine !== seq.current) return;
      setLoading(false);
      if (!page) { setFailed(true); return; }
      setFailed(false);
      setRows((had) => {
        const seen = new Set(had.map((row) => row.key));
        return [...had, ...page.rows.filter((row) => !seen.has(row.key))];
      });
      setNext(page.next);
    });
  }, [next, loading, read]);
  const retry = useCallback(() => setAgain((n) => n + 1), []);
  return { rows, next, ready, loading, failed, more, retry };
}
