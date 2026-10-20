/**
 * The change page's vote sheet, pinned above the tab bar.
 *
 * At rest it asks one thing: Yes or No, with "Not sure?" under them. Every
 * other way to look closer opens from there, one tap away and never in the
 * way: Ask privately, Discussion, Try it, About this change. After a vote the
 * sheet says what you said, with a large check to land on, and offers Undo
 * (the server takes the vote back while voting is open, DELETE
 * /api/sessions/:id/vote through `AppView.retractVote`) beside Next change.
 *
 * Votes go through the platform's own `AppView.castVote`, with the approval
 * epoch the server checks, so every other screen hears about them the usual
 * way. A No carries its line, which the server requires.
 */

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, ChatIcon, InfoCircleIcon, PlayIcon, SparklesIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { agoStamp } from '../../lib/timestamp';
import { changeHref } from '../../lib/change-href';
import { callAppView } from '../dev-board/card/fold';
import { FeedThread } from '../dev-board/card/feed-thread';
import { readAskStream } from '../dev-board/workshop/ask-stream';
import type { ReviewItem } from './model';

export type SheetState = 'ask' | 'unsure' | 'no' | 'voted' | 'askq' | 'talk' | 'try' | 'about' | 'more';
export type Vote = 'yes' | 'no';

/** The longest line a No may carry (the server's VOTE_REASON_MAX). */
export const NO_LINE_MAX = 280;

/** Whether the sheet covers the page (everything but its resting and voted states). */
export function sheetOpen(state: SheetState): boolean {
  return state !== 'ask' && state !== 'voted';
}

const Icon = {
  check: <CheckIcon aria-hidden="true" width={18} height={18} strokeWidth="2.2" />,
  x: <XIcon aria-hidden="true" width={18} height={18} strokeWidth="2.2" />,
  up: <ChevronUpIcon aria-hidden="true" width={16} height={16} />,
  back: <ChevronLeftIcon aria-hidden="true" width={22} height={22} strokeWidth="2.2" />,
  chev: <ChevronRightIcon aria-hidden="true" width={20} height={20} />,
  next: <ChevronRightIcon aria-hidden="true" width={18} height={18} strokeWidth="2.2" />,
  spark: <SparklesIcon aria-hidden="true" width={20} height={20} />,
  chat: <ChatIcon aria-hidden="true" width={20} height={20} />,
  play: <PlayIcon aria-hidden="true" width={20} height={20} />,
  info: <InfoCircleIcon aria-hidden="true" width={20} height={20} />,
};

type AskMsg = { who: 'you' | 'ai'; text: string; pending?: boolean };

export function VoteSheet({ item, vote, state, setState, onVote, onUndo, onNext, hasNext, maxHeight, fresh }: {
  item: ReviewItem;
  vote: Vote | null;
  state: SheetState;
  setState: (s: SheetState) => void;
  /** Cast a vote; resolves once the server has it (false: it did not take). */
  onVote: (vote: Vote, reason?: string) => Promise<boolean>;
  onUndo: () => Promise<boolean>;
  onNext: () => void;
  hasNext: boolean;
  maxHeight: number;
  /** The vote was cast this moment: the check draws itself in. */
  fresh: boolean;
}) {
  const t = useMessages('communities');
  const ref = useRef<HTMLElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState(false);
  const [asks, setAsks] = useState<AskMsg[]>([]);
  const [question, setQuestion] = useState('');
  const [copied, setCopied] = useState(false);

  // A new change starts with an empty line and no questions.
  useEffect(() => { setLine(''); setAsks([]); setQuestion(''); setCopied(false); }, [item.key]);

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

  const cast = async (v: Vote, reason?: string) => {
    if (busy) return;
    setBusy(true);
    try { await onVote(v, reason); } finally { setBusy(false); }
  };
  const undo = async () => {
    if (busy) return;
    setBusy(true);
    try { await onUndo(); } finally { setBusy(false); }
  };

  const grab = (
    <button
      type="button"
      className="rf-grab"
      aria-label={state === 'ask' ? t('communities:review.sheet.more') : t('communities:review.sheet.close')}
      onClick={() => setState(state === 'ask' ? 'unsure' : vote ? 'voted' : 'ask')}
    ><span /></button>
  );
  const yesNo = (pressedNo = false) => (
    <div className="rf-yn">
      <button type="button" className="rf-pill-btn" data-rf-vote="yes" disabled={busy} onClick={() => cast('yes')}>
        {Icon.check}<span>{item.approve ? t('communities:review.vote.approve') : t('communities:review.vote.yes')}</span>
      </button>
      <button
        type="button"
        className={pressedNo ? 'rf-pill-btn rf-pill-no' : 'rf-pill-btn'}
        data-rf-vote="no"
        aria-pressed={pressedNo}
        disabled={busy}
        onClick={() => setState('no')}
      >
        {Icon.x}<span>{item.approve ? t('communities:review.vote.dontApprove') : t('communities:review.vote.no')}</span>
      </button>
    </div>
  );
  const sub = (title: string) => (
    <div className="rf-sub">
      <button type="button" aria-label={t('communities:review.sheet.backToHelp')} onClick={() => setState('unsure')}>{Icon.back}</button>
      <h2>{title}</h2>
    </div>
  );
  const row = (to: SheetState, icon: ReactNode, title: string, line2: string) => (
    <button type="button" className="rf-row" data-rf-help={to} onClick={() => setState(to)}>
      <span className="rf-row-icon">{icon}</span>
      <span className="rf-row-text"><b>{title}</b><i>{line2}</i></span>
      {Icon.chev}
    </button>
  );
  const href = item.app ? changeHref(item.app.slug, item.id, item.number) : '';

  let body: ReactNode;
  if (state === 'more') {
    body = (
      <div className="rf-menu" role="menu">
        <a role="menuitem" className="rf-row rf-menu-row" href={href}>{t('communities:review.more.open')}</a>
        <button
          role="menuitem"
          type="button"
          className="rf-row rf-menu-row"
          onClick={() => {
            const url = `${location.origin}/${href}`;
            try { void navigator.clipboard?.writeText(url); } catch { /* nothing to copy into */ }
            setCopied(true);
          }}
        >{copied ? t('communities:review.more.copied') : t('communities:review.more.copy')}</button>
        <button role="menuitem" type="button" className="rf-row rf-menu-row rf-menu-cancel" onClick={() => setState(vote ? 'voted' : 'ask')}>
          {t('communities:review.more.cancel')}
        </button>
      </div>
    );
  } else if (vote && (state === 'ask' || state === 'voted')) {
    body = (
      <>
        <div className={fresh ? 'rf-said rf-fresh' : 'rf-said'} role="status" data-rf-said={vote}>
          <span className="rf-said-mark" aria-hidden="true">
            {vote === 'yes'
              ? <CheckIcon width={40} height={40} strokeWidth="2.4" />
              : <XIcon width={40} height={40} strokeWidth="2.4" />}
          </span>
          <h2>{vote === 'yes' ? t('communities:review.said.yes') : t('communities:review.said.no')}</h2>
        </div>
        <div className="rf-yn">
          <button type="button" className="rf-pill-btn" data-rf-undo="" disabled={busy} onClick={undo}>{t('communities:review.said.undo')}</button>
          <button type="button" className="rf-pill-btn rf-pill-primary" data-rf-next="" onClick={onNext}>
            <span>{hasNext ? t('communities:review.said.next') : t('communities:review.said.done')}</span>{Icon.next}
          </button>
        </div>
      </>
    );
  } else if (state === 'unsure') {
    body = (
      <>
        {yesNo()}
        <p className="rf-line">{t('communities:review.unsure.line')}</p>
        <nav aria-label={t('communities:review.unsure.label')}>
          {row('askq', Icon.spark, t('communities:review.unsure.ask.title'), t('communities:review.unsure.ask.line'))}
          {row('talk', Icon.chat, t('communities:review.unsure.talk.title'), t('communities:review.unsure.talk.line'))}
          {row('try', Icon.play, t('communities:review.unsure.try.title'), item.stagingUrl ? t('communities:review.unsure.try.line') : t('communities:review.unsure.try.none'))}
          {row('about', Icon.info, t('communities:review.unsure.about.title'), t('communities:review.unsure.about.line'))}
        </nav>
      </>
    );
  } else if (state === 'no') {
    const left = NO_LINE_MAX - line.length;
    body = (
      <form
        onSubmit={(e: FormEvent) => { e.preventDefault(); if (line.trim()) void cast('no', line.trim()); }}
      >
        {yesNo(true)}
        <label className="rf-ask-label" htmlFor="rf-no-line">{t('communities:review.no.ask')}</label>
        <textarea
          id="rf-no-line"
          className="rf-textarea"
          maxLength={NO_LINE_MAX}
          placeholder={item.author ? t('communities:review.no.placeholder', { name: item.author }) : t('communities:review.no.placeholderNoName')}
          value={line}
          onChange={(e) => setLine(e.target.value)}
        />
        {left < 40 ? <p className="rf-line rf-line-tight">{t('communities:review.no.left', { count: left })}</p> : null}
        <div className="rf-ends">
          <button type="button" className="rf-cancel" onClick={() => setState(vote ? 'voted' : 'ask')}>{t('communities:review.no.cancel')}</button>
          <button type="submit" className="rf-go" disabled={!line.trim() || busy}>{t('communities:review.no.send')}</button>
        </div>
      </form>
    );
  } else if (state === 'askq') {
    body = (
      <>
        {yesNo()}
        {sub(t('communities:review.unsure.ask.title'))}
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
        {yesNo()}
        {sub(t('communities:review.unsure.talk.title'))}
        <div className="rf-body rf-thread">
          <FeedThread slug={item.app.slug} type="session" refId={item.id} canPost />
        </div>
      </>
    );
  } else if (state === 'try') {
    body = (
      <>
        {yesNo()}
        {sub(t('communities:review.unsure.try.title'))}
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
  } else if (state === 'about') {
    body = (
      <>
        {yesNo()}
        {sub(t('communities:review.unsure.about.title'))}
        <div className="rf-body">
          {item.summary ? (
            <>
              <div className="rf-sect">{t('communities:review.about.what')}</div>
              <p className="rf-para">{item.summary}</p>
            </>
          ) : null}
          <div className="rf-sect">{t('communities:review.about.who')}</div>
          <div className="rf-facts">
            {item.author ? (
              <div><b>{t('communities:review.about.builtBy', { name: item.author })}</b>{item.at ? <small>{agoStamp(item.at).text}</small> : null}</div>
            ) : null}
            <div><b>{t('communities:review.about.inApp', { app: item.app.name })}</b>{item.number ? <small>{t('communities:review.about.number', { number: item.number })}</small> : null}</div>
          </div>
          <div className="rf-sect">{t('communities:review.about.deciding')}</div>
          <p className="rf-para">{t('communities:review.about.decidingLine')}</p>
          <a className="rf-link" href={href}>{t('communities:review.more.open')}</a>
        </div>
      </>
    );
  } else {
    body = (
      <>
        {yesNo()}
        <button type="button" className="rf-quiet" data-rf-unsure="" onClick={() => setState('unsure')}>
          <span>{t('communities:review.unsure.open')}</span>{Icon.up}
        </button>
      </>
    );
  }

  return (
    <section
      ref={ref}
      className="rf-sheet"
      aria-label={t('communities:review.sheet.label')}
      style={height == null ? undefined : { height }}
      data-rf-sheet={state}
    >
      <div className="rf-sheet-inner">
        {grab}
        {body}
      </div>
    </section>
  );
}
