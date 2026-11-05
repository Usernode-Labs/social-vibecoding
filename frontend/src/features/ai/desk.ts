/**
 * YOUR WORK ON ONE PROJECT, as the Homeroom bot tab counts it (5 Nov 2026).
 * The tab is the desk for everything of yours (./index.tsx); a project's
 * Workshop and its Hub no longer keep lists of their own of the same work.
 * Each draws one row, "Your work", that says how much of yours there is on
 * the project and opens the tab narrowed to it (./filter-address.ts
 * projectTabAddress):
 *
 *   [bot] Your work                     Needs you: 2 · In progress: 1  ›
 *         Next: Dark mode
 *
 * The counts are the tab's own, read from the same two lists the tab reads
 * (GET /api/ai/work and the Needs you feed for the threads you are in) and
 * worked out by the same functions (./model.ts needsYou, inProgress,
 * upNext), so the row and the page it opens never disagree. They were
 * counted by AppView from the board's own buckets, which named different
 * things (a change up for a vote was "in progress" there, Waiting here).
 *
 * The two reads are shared by every row on screen and kept for a short
 * while, and dropped when Homeroom bot's work moves
 * (`homeroom-bot-work-changed`, public/js/app.js). Nothing is read in the
 * first render, which is the prerender's.
 */

import { useEffect, useState } from 'react';

import { inProgress, needsYou, upNext, type AiWork, type NeedItem, type Phrase } from './model';

export interface DeskSummary {
  /** The lists have been read (until then the row says nothing of counts). */
  ready: boolean;
  /** Rows of Needs you that ask something of you (a pill). */
  needs: number;
  /** Being worked on. */
  progress: number;
  /** Waiting on somebody else. */
  waiting: number;
  /** The first thing you owe, by its title. */
  first: string | null;
}

export const EMPTY_DESK: DeskSummary = { ready: false, needs: 0, progress: 0, waiting: 0, first: null };

/** Pure: one project's share of the tab's lists. */
export function deskOf(slug: string, needs: NeedItem[] | null, work: AiWork | null): DeskSummary {
  if (!work || !needs) return EMPTY_DESK;
  const here = (row: { app: { slug: string } | null }) => row.app?.slug === slug;
  const owed = needsYou(needs, work).filter(here).filter((row) => row.pill);
  return {
    ready: true,
    needs: owed.length,
    progress: inProgress(needs, work).filter(here).length,
    waiting: upNext(needs, work).filter(here).length,
    first: owed[0]?.title || null,
  };
}

/**
 * Pure: the row's count, in the tab's own words ("Needs you: 2 · In
 * progress: 1", ./model.ts heroWords): each half only above zero, Waiting
 * only when nothing else is, and nothing at all for none.
 */
export function deskWords(d: DeskSummary): Phrase | null {
  if (!d.ready) return null;
  if (d.needs > 0 && d.progress > 0) return { id: 'project:workshop.desk.both', values: { needs: d.needs, progress: d.progress } };
  if (d.needs > 0) return { id: 'project:workshop.desk.needs', values: { needs: d.needs } };
  if (d.progress > 0) return { id: 'project:workshop.desk.progress', values: { progress: d.progress } };
  if (d.waiting > 0) return { id: 'project:workshop.desk.waiting', values: { waiting: d.waiting } };
  return null;
}

/** Pure: the row's second line: the first thing you owe, or that there is nothing of yours. */
export function deskLine(d: DeskSummary): Phrase | null {
  if (!d.ready) return null;
  if (d.first) return { id: 'project:workshop.desk.next', values: { title: d.first } };
  if (d.progress + d.waiting > 0) return null;
  return { id: 'project:workshop.desk.empty' };
}

const KEEP_MS = 20000;
let kept: { at: number; read: Promise<{ work: AiWork | null; needs: NeedItem[] | null }> } | null = null;

function demo(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1';
}

async function json<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { credentials: 'same-origin' });
    return res.ok ? (await res.json()) as T : null;
  } catch {
    return null;
  }
}

/** The tab's two lists, read once for every row on screen, and kept a little while. */
export function readDesk(now = Date.now()): Promise<{ work: AiWork | null; needs: NeedItem[] | null }> {
  if (kept && now - kept.at < KEEP_MS) return kept.read;
  const qs = demo() ? '?demo=1' : '';
  const read = Promise.all([
    json<AiWork>(`/api/ai/work${qs}`),
    json<{ items?: NeedItem[] }>(`/api/workshop/needs-feed?in=threads${qs ? '&demo=1' : ''}`),
  ]).then(([work, feed]) => ({ work, needs: feed ? (Array.isArray(feed.items) ? feed.items : []) : null }));
  kept = { at: now, read };
  return read;
}

/** Drop the kept lists: the next row to ask reads them again. */
export function forgetDesk(): void {
  kept = null;
}

if (typeof window !== 'undefined') {
  window.addEventListener('homeroom-bot-work-changed', forgetDesk);
}

/** One project's Your work, for a row: read after mount, again when the project changes. */
export function useDesk(slug: string | null | undefined): DeskSummary {
  const [summary, setSummary] = useState<DeskSummary>(EMPTY_DESK);
  useEffect(() => {
    if (!slug || typeof window === 'undefined' || !(window as any).App?.user) return undefined;
    let live = true;
    void readDesk().then(({ work, needs }) => {
      if (live) setSummary(deskOf(slug, needs, work));
    });
    return () => { live = false; };
  }, [slug]);
  return summary;
}
