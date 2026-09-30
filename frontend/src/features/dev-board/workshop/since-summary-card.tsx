/**
 * The top of a project's hub: what landed since you were last here, in a
 * sentence or two.
 *
 * ── What it says ───────────────────────────────────────────────────────
 *
 * GET /api/apps/:slug/since-summary?since=<ms> answers for the viewer's last
 * visit (the stamp this device keeps, AppView._workshopBaseline), floored to
 * a window many members share (services/since-summary.js):
 *
 *   - `ai`: Claude's one or two sentences about what the window's merged
 *     changes were about, with "AI summary" on the head so nobody takes it
 *     for a person's words;
 *   - `list`: three or fewer changes, their own titles, which are shorter
 *     than any sentence about them (and what the card falls back to when
 *     the model is off or failed);
 *   - `none`: nothing landed, and the card is not drawn at all.
 *
 * The head names the window's start the way a person would ("Since
 * yesterday", "Since Monday", "Since Sep 12") and the count is the window's,
 * so what it says and what it covers agree.
 *
 * "Week by week", with a chevron, sits at the card's top-right corner like
 * the hub's other doors: it is the way to the Workshop page, where the
 * window is listed week by week.
 *
 * ── Dismissing it ──────────────────────────────────────────────────────
 *
 * The × hides it until something newer lands: this device remembers the
 * newest change the dismissed line covered (`sinceSummaryDismissed:<slug>`,
 * beside the visit stamp it is measured from), and a line whose newest
 * change is later comes back. Per device, like the visit stamp itself.
 *
 * ── Island rules ───────────────────────────────────────────────────────
 *
 * The fetch and the dismissal read both run in an effect, and nothing is
 * drawn until the fetch answers: the card appears rather than a skeleton,
 * because on most visits there is nothing to say.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { ChevronRightIcon, XIcon } from '@/components/ui/icons';

export type SinceSummary =
  | { state: 'none' }
  | { state: 'list'; windowStart: number; headAt: number; count: number; items: Array<{ pr: number | null; title: string }> }
  | { state: 'ai'; windowStart: number; headAt: number; count: number; text: string };

export const DISMISS_KEY = 'sinceSummaryDismissed';

const DAY_MS = 24 * 60 * 60 * 1000;
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * "Since yesterday": the window's start in the viewer's own calendar.
 * Today is "Since earlier today"; the last week is its weekday; anything
 * older is its date.
 */
export function sinceLabel(windowStart: number, now: number = Date.now()): string {
  const start = new Date(windowStart);
  const days = Math.round((midnight(new Date(now)) - midnight(start)) / DAY_MS);
  if (days <= 0) return 'Since earlier today';
  if (days === 1) return 'Since yesterday';
  if (days < 7) return `Since ${start.toLocaleDateString(undefined, { weekday: 'long' })}`;
  return `Since ${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function readDismissed(slug: string): number {
  try {
    return Number(window.localStorage.getItem(`${DISMISS_KEY}:${slug}`)) || 0;
  } catch {
    return 0;
  }
}

function writeDismissed(slug: string, headAt: number): void {
  try {
    window.localStorage.setItem(`${DISMISS_KEY}:${slug}`, String(headAt));
  } catch { /* private mode: dismissed for this page only */ }
}

/** Whether a staging demo link asked for the fixed line. */
function demoAsked(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1';
  } catch {
    return false;
  }
}

export function SinceSummaryCard({ slug, since, onMore }: {
  slug: string;
  /** The viewer's last visit, epoch ms; 0 on a first visit. */
  since: number;
  /** The way to the whole of it, week by week (the Workshop page). */
  onMore?: () => void;
}): ReactNode {
  const [data, setData] = useState<SinceSummary | null>(null);
  const [dismissed, setDismissed] = useState(0);

  useEffect(() => {
    setData(null);
    if (!slug) return undefined;
    const demo = demoAsked();
    if (!since && !demo) return undefined;
    setDismissed(readDismissed(slug));
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const q = `since=${encodeURIComponent(String(since || 0))}${demo ? '&demo=1' : ''}`;
    fetch(`/api/apps/${encodeURIComponent(slug)}/since-summary?${q}`, ctl ? { signal: ctl.signal } : undefined)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (body && typeof body.state === 'string') setData(body as SinceSummary); })
      .catch(() => { /* no card: the hub reads the same without it */ });
    return () => { ctl?.abort(); };
  }, [slug, since]);

  if (!data || data.state === 'none' || !data.count) return null;
  if (dismissed && data.headAt <= dismissed) return null;

  const label = sinceLabel(data.windowStart);
  const dismiss = () => {
    writeDismissed(slug, data.headAt);
    setDismissed(data.headAt);
  };
  return (
    <section className="dev-ws-strip dev-ws-since-card" data-ws-since-summary={data.state} aria-label={label}>
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">{label}</span>
        <span className="dev-ws-since-card-n">{plural(data.count, 'change', 'changes')}</span>
        {data.state === 'ai' ? <span className="dev-ws-since-card-tag">AI summary</span> : null}
        <button
          type="button"
          className="dev-ws-since-card-x un-touch-target"
          aria-label="Dismiss this summary"
          title="Dismiss this summary"
          data-ws-since-summary-dismiss=""
          onClick={dismiss}
        >
          <XIcon className="dev-ws-since-card-x-glyph" aria-hidden="true" />
        </button>
        {onMore ? (
          <button type="button" className="dev-ws-link dev-ws-since-card-more un-touch-target" data-ws-since-summary-more="" onClick={onMore}>
            Week by week
            <ChevronRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {data.state === 'ai' ? (
        <p className="dev-ws-since-card-text" data-ws-since-summary-text="">{data.text}</p>
      ) : (
        <ul className="dev-ws-since-card-list" data-ws-since-summary-list="">
          {data.items.map((item, i) => (
            <li key={item.pr ?? `i${i}`} className="dev-ws-since-card-item">{item.title}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
