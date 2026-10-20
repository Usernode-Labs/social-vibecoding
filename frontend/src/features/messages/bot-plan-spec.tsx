import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { firstSpecScreen, renderSpecHtml, useSpecFrames } from '../../lib/spec-html';
import { DrawnSide, PendingSide } from './bot-track';
import { MessageMarkdown } from './format';

/*
 * 20 Oct 2026: A COMPLICATED CHANGE'S PLAN, ON ITS CARD.
 *
 * The plan card (./bot-plan-view.tsx) asked its requester to say Build it to
 * a plan they could not see from it: the spec, with its before and after
 * screens, was only on the request, two taps away, and the card said so in a
 * note. Now the card shows it: the first screen the plan drew, before and
 * after (the small frames a request's track card draws, ./bot-track.tsx
 * DrawnSide), and "See the plan", which opens the whole plan in the card,
 * its User-facing half first, with the before and after viewer the request's
 * plan panel draws (lib/spec-html.ts). Build it stays under it.
 *
 * Read once, in an effect, from the version the card names (`plan.spec`).
 * The bot shares that version when it sends the plan (homeroom-bot.js
 * planBeforeBuilding), so its requester may read it
 * (GET /api/sessions/:id/specs/:version). A plan that cannot be read draws
 * nothing here: the request below still has it.
 */

export type PlanRead =
  | { state: 'reading' }
  | { state: 'gone' }
  | { state: 'read'; html: string | null; markdown: string };

/** The plan version a card names, read once per version. */
function usePlanRead(sessionId: number, version: number): PlanRead {
  const [read, setRead] = useState<PlanRead>({ state: 'reading' });
  useEffect(() => {
    let live = true;
    setRead({ state: 'reading' });
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/specs/${version}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json() as { spec?: { content?: unknown; content_html?: unknown } };
        const html = typeof body.spec?.content_html === 'string' && body.spec.content_html.trim() ? body.spec.content_html : null;
        const markdown = typeof body.spec?.content === 'string' ? body.spec.content : '';
        if (live) setRead(html || markdown.trim() ? { state: 'read', html, markdown } : { state: 'gone' });
      } catch {
        if (live) setRead({ state: 'gone' });
      }
    })();
    return () => { live = false; };
  }, [sessionId, version]);
  return read;
}

/** A piece of an HTML plan; its before and after screens are frames scaled to fit (lib/spec-html.ts). */
function HtmlPart({ html, className, role }: { html: string; className?: string; role?: string }) {
  const wrapper = useMemo(() => ({ __html: html }), [html]);
  const ref = useRef<HTMLDivElement>(null);
  useSpecFrames(ref, html);
  return <div ref={ref} className={className} role={role} dangerouslySetInnerHTML={wrapper} />;
}

// The plan as it reads in the card: the card's own text size, no inset of
// its own, and a table too wide for a phone scrolls inside it.
const DOC = 'mt-1 min-w-0 overflow-x-auto pb-1 text-[0.875rem] leading-[1.6] text-zinc-900 [overflow-wrap:anywhere] dark:text-zinc-100';

/**
 * The whole plan, opened under "See the plan": an HTML plan with the plan
 * panel's two tabs, User-facing first; a markdown plan as the chat draws
 * markdown.
 */
export function PlanDocument({ id, read, docKey }: {
  id?: string;
  read: Extract<PlanRead, { state: 'read' }>;
  /** Unique on the page: it names the screens viewer's radios. */
  docKey: string;
}) {
  const t = useMessages('messages');
  const doc = useMemo(() => (read.html ? renderSpecHtml(read.html, { key: docKey }) : null), [read.html, docKey]);
  const [tab, setTab] = useState<'user' | 'tech'>('user');
  if (!doc) {
    return <div id={id} className={DOC} data-bot-plan-doc="markdown"><MessageMarkdown content={read.markdown} /></div>;
  }
  if (!doc.split) return <div id={id} className={DOC} data-bot-plan-doc="html"><HtmlPart html={doc.html} /></div>;
  const half = tab === 'tech' ? doc.techHtml : doc.userHtml;
  const tabButton = (which: 'user' | 'tech', label: string) => (
    <button
      type="button"
      className={tab === which ? 'dc-spec-viewer-tab dc-spec-viewer-tab-active' : 'dc-spec-viewer-tab'}
      role="tab"
      aria-selected={tab === which}
      data-bot-plan-tab={which}
      onClick={() => setTab(which)}
    >{label}</button>
  );
  return (
    <div id={id} className={DOC} data-bot-plan-doc="html">
      {doc.preambleHtml ? <HtmlPart className="dc-spec-viewer-preamble" html={doc.preambleHtml} /> : null}
      <div className="dc-spec-viewer-tabs" role="tablist" aria-label={t('messages:bot.plan.spec.sections')}>
        {tabButton('user', t('messages:bot.plan.spec.tab.user'))}
        {tabButton('tech', t('messages:bot.plan.spec.tab.tech'))}
      </div>
      {half
        ? <HtmlPart role="tabpanel" html={half} />
        : <div role="tabpanel"><p className="dc-spec-tab-empty">{t('messages:bot.plan.spec.tabEmpty')}</p></div>}
    </div>
  );
}

// "See the plan": a row of the card, as its plan's lines are, in the
// accent an action takes (Change something's).
const SEE_ROW = 'mt-2 flex min-h-[44px] w-full items-center justify-between gap-2 text-left text-[0.9375rem] font-semibold text-violet-700 shadow-[inset_0_1px_0_var(--app-sheet-line)] hover:underline disabled:cursor-default disabled:no-underline disabled:opacity-60 dark:text-violet-300';

/**
 * A complicated change's plan on its card: the first screen it drew, before
 * and after, and "See the plan", which opens the whole of it here.
 */
export function PlanSpec({ sessionId, version }: { sessionId: number; version: number }) {
  const t = useMessages('messages');
  const read = usePlanRead(sessionId, version);
  const [open, setOpen] = useState(false);
  const docId = useId();
  const html = read.state === 'read' ? read.html : null;
  const screen = useMemo(() => (html ? firstSpecScreen(html) : null), [html]);
  if (read.state === 'gone') return null;
  const reading = read.state === 'reading';
  const sides = [
    { side: 'before' as const, label: t('messages:bot.track.pictures.before') },
    { side: 'after' as const, label: t('messages:bot.track.pictures.after') },
  ];
  return (
    <div className="mt-1 flex flex-col" data-bot-plan-spec={reading ? 'reading' : 'read'}>
      {reading || screen ? (
        <figure className="m-0 mt-2 grid grid-cols-2 gap-2" aria-busy={reading || undefined} data-bot-plan-pictures="">
          {sides.map(({ side, label }) => (
            <div key={side} className="flex min-w-0 flex-col gap-1">
              {screen ? <DrawnSide screen={screen} side={side} label={label} /> : <PendingSide />}
              <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{label}</span>
            </div>
          ))}
        </figure>
      ) : null}
      <button
        type="button"
        className={SEE_ROW}
        aria-expanded={open}
        aria-controls={open ? docId : undefined}
        disabled={reading}
        data-bot-plan-see=""
        onClick={() => setOpen((was) => !was)}
      >
        <span>{t(open ? 'messages:bot.plan.spec.hide' : 'messages:bot.plan.spec.see')}</span>
        <ChevronDownIcon className={open ? 'h-4 w-4 shrink-0 rotate-180' : 'h-4 w-4 shrink-0'} aria-hidden="true" />
      </button>
      {open && read.state === 'read'
        ? <PlanDocument id={docId} read={read} docKey={`bot-plan-${sessionId}-${version}`} />
        : null}
    </div>
  );
}
