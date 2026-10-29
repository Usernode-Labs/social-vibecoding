/**
 * The change page's vote, at its foot above the tab bar.
 *
 * At rest it is part of the page, not a sheet over it: one pair, Yes | No,
 * and Skip beside it. The row never moves. A tap on Yes counts at once; the
 * pair shows the choice (a filled thumb under it, with its mark), and Skip's
 * place becomes Next change, or Done on the last one. A tap on the other
 * answer changes the vote; a tap on your own answer takes it back (the server
 * takes a vote back while voting is open, DELETE /api/sessions/:id/vote
 * through `AppView.retractVote`).
 *
 * A No asks why before it is cast: tapping No raises a sheet with four short
 * answers and the optional one-line box, and Send counts the No with the
 * answer (and the line, when one is written) as its reason. Closing the sheet
 * counts nothing, and a Yes already cast stays. On a No cast elsewhere,
 * "Add a reason" opens the same sheet.
 *
 * Skip is not an answer: it turns the page. The next change slides in at
 * once, nothing is recorded, and the change keeps waiting in Needs you.
 * Help (Ask privately, Discussion, Try it) is in the bar's ⌄ card, under the
 * change in full; each opens here as a sheet over the page. Next carries how
 * many changes are still waiting after this one, as a quieter figure after
 * the word: the Communities tab's badge, said where you press to go on.
 *
 * Votes go through the platform's own `AppView.castVote`, with the approval
 * epoch the server checks, so every other screen hears about them the usual
 * way.
 */

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { CheckIcon, ChevronLeftIcon, SparklesIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { changeHref } from '../../lib/change-href';
import { callAppView } from '../dev-board/card/fold';
import { FeedThread } from '../dev-board/card/feed-thread';
import { readAskStream } from '../dev-board/workshop/ask-stream';
import type { ReviewItem } from './model';

/**
 * #6019: Discussion is the thread's. A change built for a request talks on
 * the request (#5007), so it opens there; a change of its own talks on
 * itself, and a decision on its governance row. Nothing is drawn until the
 * thread has said which, so the sheet never shows one stream and then
 * another.
 */
function ThreadTalk({ item }: { item: ReviewItem }): ReactNode {
  const own = item.kind === 'governance' ? { type: 'governance', ref: item.id } : { type: 'session', ref: item.id };
  const asks = item.kind === 'proposal' && !!item.number;
  const [anchor, setAnchor] = useState<{ type: string; ref: number } | null>(asks ? null : own);
  useEffect(() => {
    if (!asks) { setAnchor(own); return undefined; }
    let live = true;
    fetch(`/api/apps/${encodeURIComponent(item.app.slug)}/threads/${item.number}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!live) return;
        const lead = data && data.thread && data.thread.lead === 'request' ? Number(data.thread.number) : 0;
        setAnchor(lead > 0 ? { type: 'issue', ref: lead } : own);
      })
      .catch(() => { if (live) setAnchor(own); });
    return () => { live = false; };
  }, [item.app.slug, item.number, item.id, item.kind]);
  if (!anchor) return null;
  return <FeedThread slug={item.app.slug} type={anchor.type} refId={anchor.ref} canPost />;
}

export type SheetState = 'ask' | 'voted' | 'reason' | 'askq' | 'talk' | 'try';
export type Vote = 'yes' | 'no';

/** The longest line a No may carry (the server's VOTE_REASON_MAX). */
export const NO_LINE_MAX = 280;

/** The answers a No picks from; "Something else" takes the same optional line. */
export type NoChoice = 'notWorking' | 'approach' | 'notNeeded' | 'other';

/** Whether the sheet covers the page (everything but the vote row's own states). */
export function sheetOpen(state: SheetState): boolean {
  return state !== 'ask' && state !== 'voted';
}

const Icon = {
  check: <CheckIcon aria-hidden="true" width={18} height={18} strokeWidth="2.4" />,
  x: <XIcon aria-hidden="true" width={16} height={16} strokeWidth="2.4" />,
  back: <ChevronLeftIcon aria-hidden="true" width={22} height={22} strokeWidth="2.2" />,
  spark: <SparklesIcon aria-hidden="true" width={20} height={20} />,
};

type AskMsg = { who: 'you' | 'ai'; text: string; pending?: boolean };

export function VoteSheet({ item, vote, state, setState, onVote, onUndo, onNext, hasNext, maxHeight, left = 0, onSkip }: {
  item: ReviewItem;
  vote: Vote | null;
  state: SheetState;
  setState: (s: SheetState) => void;
  /** Cast a vote; resolves once the server has it (false: it did not take). */
  onVote: (vote: Vote, reason?: string) => Promise<boolean>;
  onUndo: () => Promise<boolean>;
  /** Next change, or Done on the last one: the flow decides where it goes. */
  onNext: () => void;
  hasNext: boolean;
  maxHeight: number;
  /** How many changes still wait after this one (Next's number). */
  left?: number;
  /** Turn the page: on to the next change, or the end, with nothing recorded. */
  onSkip: () => void;
}) {
  const t = useMessages('communities');
  const ref = useRef<HTMLElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [line, setLine] = useState('');
  // The answer a No picks from the reason list; the No is only sent with one.
  const [choice, setChoice] = useState<NoChoice | null>(null);
  // The reason sent with this change's No, shown where it was written.
  const [shared, setShared] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asks, setAsks] = useState<AskMsg[]>([]);
  const [question, setQuestion] = useState('');

  // A new change starts with an empty line, no answer and no questions.
  useEffect(() => { setLine(''); setChoice(null); setShared(null); setAsks([]); setQuestion(''); }, [item.key]);

  const whyChoices: { key: NoChoice; text: string }[] = [
    { key: 'notWorking', text: t('communities:review.why.notWorking') },
    { key: 'approach', text: t('communities:review.why.approach') },
    { key: 'notNeeded', text: t('communities:review.why.notNeeded') },
    { key: 'other', text: t('communities:review.why.other') },
  ];
  const choiceText = whyChoices.find((c) => c.key === choice)?.text || '';
  // The whole reason stays within the server's limit: the line gets what the
  // answer and its ": " leave.
  const lineMax = choice ? Math.max(0, NO_LINE_MAX - choiceText.length - 2) : NO_LINE_MAX;

  // The sheet grows and shrinks to what it holds, animated (app.css .rf-sheet).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const inner = el.firstElementChild as HTMLElement | null;
    if (!inner) return;
    setHeight(Math.min(maxHeight, inner.scrollHeight));
  });

  // Ask privately: this viewer's earlier questions about the change.
  useEffect(() => {
    if (state !== 'askq' || asks.length) return undefined;
    let live = true;
    const qs = `kind=proposal&ref=${encodeURIComponent(String(item.id))}`;
    fetch(`/api/apps/${encodeURIComponent(item.app.slug)}/workshop/ask/thread?${qs}`, {
      credentials: 'same-origin', headers: { accept: 'application/json' },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!live || !data || !Array.isArray(data.messages)) return;
        setAsks((cur) => (cur.length ? cur : data.messages.map((m: { who?: string; text?: string }) => ({
          who: m.who === 'ai' ? 'ai' as const : 'you' as const, text: String(m.text || ''),
        }))));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [state, item.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text || asks.some((m) => m.pending)) return;
    setQuestion('');
    setAsks((cur) => [...cur, { who: 'you', text }, { who: 'ai', text: t('communities:review.ask.reading'), pending: true }]);
    const tail = (msg: AskMsg) => setAsks((cur) => {
      if (!cur.length || !cur[cur.length - 1].pending) return cur;
      return [...cur.slice(0, -1), msg];
    });
    let answer = t('communities:review.ask.failed');
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(item.app.slug)}/workshop/ask`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ target: { kind: 'proposal', ref: item.id }, question: text }),
      });
      const stream = (res.headers.get('content-type') || '').includes('text/event-stream');
      if (!res.ok || !stream || !res.body) {
        const data = await res.json().catch(() => ({}));
        if (typeof data.error === 'string' && data.error.trim()) answer = data.error.trim();
      } else {
        const out = await readAskStream(res.body, (soFar) => tail({ who: 'ai', text: soFar, pending: true }));
        if (out.error) answer = out.error;
        else if (out.text.trim()) answer = out.text.trim();
      }
    } catch {
      answer = t('communities:review.ask.offline');
    }
    tail({ who: 'ai', text: answer });
  };

  const cast = async (v: Vote, reason?: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try { return await onVote(v, reason); } finally { setBusy(false); }
  };
  const undo = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (await onUndo()) { setShared(null); setLine(''); setChoice(null); }
    } finally { setBusy(false); }
  };
  // Your own answer again takes the vote back; the other one changes it. A
  // No asks why first: the vote is cast only when the reason sheet is sent.
  const tap = (v: Vote) => {
    if (vote === v) { void undo(); return; }
    if (v === 'yes') { setShared(null); void cast(v); return; }
    setChoice(null);
    setLine('');
    setState('reason');
  };
  const shareReason = async () => {
    if (!choice) return;
    const detail = line.replace(/\s+/g, ' ').trim();
    const text = (detail
      ? t('communities:review.why.withDetail', { choice: choiceText, detail })
      : choiceText).slice(0, NO_LINE_MAX);
    if (await cast('no', text)) setShared(text);
  };
  const rest = vote ? 'voted' : 'ask';

  const grab = (
    <button
      type="button"
      className="rf-grab"
      aria-label={t('communities:review.sheet.close')}
      onClick={() => setState(rest)}
    ><span /></button>
  );
  const pair = () => (
    <div className="rf-pair" role="radiogroup" aria-label={t('communities:review.sheet.label')} data-rf-voted={vote || undefined}>
      <span className="rf-pair-thumb" aria-hidden="true" />
      <button type="button" role="radio" aria-checked={vote === 'yes'} className="rf-pair-btn" data-rf-vote="yes" disabled={busy} onClick={() => tap('yes')}>
        <span className="rf-pair-mark">{Icon.check}</span>
        <span>{item.approve ? t('communities:review.vote.approve') : t('communities:review.vote.yes')}</span>
      </button>
      <span className="rf-pair-div" aria-hidden="true" />
      <button type="button" role="radio" aria-checked={vote === 'no'} className="rf-pair-btn" data-rf-vote="no" disabled={busy} onClick={() => tap('no')}>
        <span className="rf-pair-mark">{Icon.x}</span>
        <span>{item.approve ? t('communities:review.vote.dontApprove') : t('communities:review.vote.no')}</span>
      </button>
    </div>
  );
  // A help sheet's head: its back arrow closes it, back to the page.
  const sub = (title: string) => (
    <div className="rf-sub">
      <button type="button" aria-label={t('communities:review.sheet.close')} onClick={() => setState(rest)}>{Icon.back}</button>
      <h2>{title}</h2>
    </div>
  );
  const href = item.app ? changeHref(item.app.slug, item.id, item.number) : '';

  let body: ReactNode;
  if (state === 'askq') {
    body = (
      <>
        {pair()}
        {sub(t('communities:review.help.ask'))}
        <div className="rf-body">
          <p className="rf-note">{t('communities:review.ask.note')}</p>
          {asks.map((m, i) => (m.who === 'you'
            ? <div key={i} className="rf-me">{m.text}</div>
            : <div key={i} className="rf-ai"><small>{Icon.spark}<span>{t('communities:review.ask.who')}</span></small><p>{m.text}</p></div>))}
          {asks.length ? null : (
            <div className="rf-chips">
              <button type="button" className="rf-chip" onClick={() => ask(t('communities:review.ask.q1'))}>{t('communities:review.ask.q1')}</button>
              <button type="button" className="rf-chip" onClick={() => ask(t('communities:review.ask.q2'))}>{t('communities:review.ask.q2')}</button>
            </div>
          )}
        </div>
        <form className="rf-ask-form" onSubmit={(e: FormEvent) => { e.preventDefault(); void ask(question); }}>
          <input
            aria-label={t('communities:review.ask.placeholder')}
            placeholder={t('communities:review.ask.placeholder')}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button type="submit" className="rf-go" disabled={!question.trim()}>{t('communities:review.ask.send')}</button>
        </form>
      </>
    );
  } else if (state === 'talk') {
    body = (
      <>
        {pair()}
        {sub(t('communities:review.help.talk'))}
        <div className="rf-body rf-thread">
          <ThreadTalk item={item} />
        </div>
      </>
    );
  } else if (state === 'try') {
    body = (
      <>
        {pair()}
        {sub(t('communities:review.help.try'))}
        <div className="rf-body">
          {item.stagingUrl ? (
            <>
              <p className="rf-note">{t('communities:review.try.note')}</p>
              <button
                type="button"
                className="rf-go rf-go-wide"
                data-rf-try=""
                onClick={() => callAppView('ensureStaging', item.id, item.stagingUrl, null, { app: { slug: item.app.slug, name: item.app.name } })}
              >{t('communities:review.try.open')}</button>
            </>
          ) : (
            <>
              <p className="rf-note">{t('communities:review.try.none')}</p>
              <a className="rf-link" href={href}>{t('communities:review.more.open')}</a>
            </>
          )}
        </div>
      </>
    );
  } else if (state === 'reason') {
    // A No asks why before it is cast: four short answers, then the optional
    // line. Send stays off until an answer is picked; closing counts nothing.
    body = (
      <>
        <h2 className="rf-why-head">{t('communities:review.why.title')}</h2>
        <div className="rf-chips" role="radiogroup" aria-label={t('communities:review.why.title')}>
          {whyChoices.map((c) => (
            <button
              key={c.key}
              type="button"
              role="radio"
              aria-checked={choice === c.key}
              className="rf-chip"
              data-rf-why-choice={c.key}
              onClick={() => setChoice(c.key)}
            >{c.text}</button>
          ))}
        </div>
        <p className="rf-line">{t('communities:review.why.detailLabel')}</p>
        <form className="rf-ask-form" onSubmit={(e: FormEvent) => { e.preventDefault(); void shareReason(); }}>
          <input
            aria-label={t('communities:review.why.detailLabel')}
            placeholder={item.author ? t('communities:review.no.placeholder', { name: item.author }) : t('communities:review.no.placeholderNoName')}
            maxLength={lineMax}
            value={line}
            onChange={(e) => setLine(e.target.value)}
          />
          <button type="submit" className="rf-go" disabled={!choice || busy}>{t('communities:review.no.send')}</button>
        </form>
      </>
    );
  } else {
    // At rest: the row on the page. The room above it is kept for a No's
    // reason, so nothing moves when one appears.
    let why: ReactNode = null;
    if (vote === 'no' && shared) {
      why = <span className="rf-why-said" data-rf-why-said="">&ldquo;{shared}&rdquo;</span>;
    } else if (vote === 'no') {
      // A No cast elsewhere has no known line; this opens the same sheet.
      why = (
        <button type="button" className="rf-why-add" data-rf-why="" onClick={() => { setChoice(null); setLine(''); setState('reason'); }}>
          {t('communities:review.reason.add')}
        </button>
      );
    }
    body = (
      <div className="rf-vote">
        <div className={why ? 'rf-why' : 'rf-why rf-why-off'}>{why}</div>
        <div className="rf-vrow">
          {pair()}
          <button
            type="button"
            className="rf-morph"
            data-rf-morph={vote ? 'next' : 'skip'}
            data-rf-next={vote ? '' : undefined}
            data-rf-skip={vote ? undefined : ''}
            aria-label={vote ? (hasNext ? t('communities:review.said.nextLeft', { count: left }) : t('communities:review.said.done')) : t('communities:review.vote.skipLabel')}
            onClick={vote ? onNext : onSkip}
          >
            <span className="rf-morph-in rf-morph-skip" aria-hidden="true">{t('communities:review.vote.skip')}</span>
            <span className="rf-morph-in rf-morph-next" aria-hidden="true">
              <span>{hasNext ? t('communities:review.said.nextShort') : t('communities:review.said.done')}</span>
              {hasNext && left > 0 ? <span className="rf-count" data-rf-count="" aria-hidden="true">{left > 99 ? '99+' : left}</span> : null}
            </span>
          </button>
        </div>
        <p className="sr-only" role="status" data-rf-said={vote || undefined}>
          {vote === 'yes' ? t('communities:review.said.yes') : vote === 'no' ? t('communities:review.said.no') : ''}
        </p>
      </div>
    );
  }

  const open = sheetOpen(state);
  return (
    <section
      ref={ref}
      className={open ? 'rf-sheet' : 'rf-sheet rf-sheet-rest'}
      aria-label={t('communities:review.sheet.label')}
      style={height == null ? undefined : { height }}
      data-rf-sheet={state}
    >
      <div className="rf-sheet-inner">
        {open ? grab : null}
        {body}
      </div>
    </section>
  );
}
