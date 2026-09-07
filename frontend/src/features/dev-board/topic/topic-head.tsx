/**
 * `#gc-thread-head` — the opened topic's card and everything under it.
 *
 * `_renderTopicHead` used to build this whole region as one `innerHTML`
 * string and then bind four handlers into it per paint. It publishes a
 * `{ card, body }` view model now (../card/model.ts and ./model.ts) and
 * mounts this once per paint; the handlers are closures.
 *
 * ── What stays another owner's ────────────────────────────────────────
 *
 * Three sinks, each rendered by React with `dangerouslySetInnerHTML` from a
 * string the MODEL carries, because the markup is another renderer's and is
 * already sanitised where it is built:
 *
 * - an issue's body and a proposal's summary — `DevChat.renderMarkdown`,
 *   the same pipeline the dev chat and the group chat's transcript use.
 * - the before/after tiles — `AppView.visualsTilesHtml`, which four other
 *   surfaces still call (the admin gallery, the dev chat's "Changes ready"
 *   card, and its own tests), so it stays a string builder.
 *
 * And two genuine controller hosts, rendered once, empty, with a constant
 * className: `#dev-issue-comments` (features/dev-board/issue-comments.tsx
 * mounts into it) and `[data-transcript-body]`, which
 * public/js/session-transcript.js fills on expand.
 */

import { Fragment } from 'react';
import type { MouseEvent, ReactNode } from 'react';

import { useStoreState } from '../../../lib/use-store-state';
import { DevCard, ActionButton } from '../card/dev-card';
import { topicHeadStore } from './topic-store';
import type {
  ChecksVerdict,
  CheckRow,
  NoteBox,
  NoteTone,
  ProposalDetails,
  RosterView,
  TextRun,
  TopicBody,
  TranscriptSection,
} from './model';

function call(fn: string, ...args: unknown[]): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn](...args);
}

/**
 * The four tints, as complete literals — Tailwind's extractor is a regex
 * over source text, so a class assembled from a hue would compile to
 * nothing.
 */
const TONE: Record<NoteTone, string> = {
  neutral: 'border-zinc-300/40 dark:border-zinc-700/60 bg-zinc-500/5 text-zinc-600 dark:text-zinc-400',
  ok: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-500',
  warn: 'border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-500',
  error: 'border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400',
};

/** A prose run, with its `font-medium` spans. See ./model.ts's `TextRun`. */
function Runs({ parts }: { parts: TextRun[] }): ReactNode {
  return (
    <>
      {parts.map((r, i) => (typeof r === 'string'
        ? <Fragment key={i}>{r}</Fragment>
        : <span key={i} className="font-medium">{r.b}</span>))}
    </>
  );
}

function Spinner(): ReactNode {
  return <span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>;
}

/** The shared bordered note — see ./model.ts's header for what it replaced. */
export function NoteBoxView({ box }: { box: NoteBox }): ReactNode {
  return (
    <div className={`mt-2 rounded border px-2 py-1.5 ${TONE[box.tone]}`} data-note={box.key}>
      <div className="font-medium">{box.spinner ? <Spinner /> : null}{box.heading}</div>
      {box.rows.map((r, i) => (r.t === 'list'
        ? (
          <ul key={i} className={r.cls || 'mt-1 ml-4 list-disc space-y-0.5'}>
            {r.items.map((it, j) => (
              <li key={j} className={(it.kind || it.mono) ? 'font-mono text-[0.7rem] break-all' : undefined}>
                {it.kind ? <span className="opacity-70">{`[${it.kind}] `}</span> : null}
                {it.code ? <code className="font-mono">{it.code}</code> : null}
                {it.text ? (it.code ? `: ${it.text}` : it.text) : null}
                {it.source ? <span className="opacity-60">{` (${it.source})`}</span> : null}
              </li>
            ))}
          </ul>
        )
        : (
          <div key={i} className={r.weight === 'foot' ? 'mt-1 opacity-80' : 'mt-0.5 opacity-90'}>
            <Runs parts={r.parts} />
          </div>
        )))}
      {box.action ? <div className="mt-1"><ActionButton a={box.action} /></div> : null}
    </div>
  );
}

function CheckRowView({ r }: { r: CheckRow }): ReactNode {
  return (
    <>
      <li className={r.advisory ? 'opacity-70' : undefined}>
        <span className={`${r.pass ? 'text-emerald-700 dark:text-emerald-400' : (r.advisory ? 'text-zinc-500 dark:text-zinc-400' : 'text-red-700 dark:text-red-400')} font-medium`}>
          {r.pass ? '✓' : '✗'}
        </span>
        {` ${r.name} `}
        {r.path ? <span className="opacity-60 font-mono">{r.path}</span> : null}
        {r.advisory ? <span className="rounded bg-zinc-500/10 px-1 text-[0.65rem] opacity-70">advisory</span> : null}
      </li>
      {!r.pass ? (
        <>
          <div className="ml-4 opacity-90">{r.reason || 'failed'}</div>
          {r.errors && r.errors.length ? (
            <ul className="ml-6 list-disc space-y-0.5">
              {r.errors.map((e, i) => (
                <li key={i} className="font-mono text-[0.7rem] break-all opacity-90">
                  <span className="opacity-70">{`[${e.kind}] `}</span>
                  {e.message}
                  {e.source ? <span className="opacity-60">{` (${e.source})`}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** The checks verdict: its rows nest, and its passes fold away. */
export function ChecksVerdictView({ v }: { v: ChecksVerdict }): ReactNode {
  const passList = v.passes.length ? (
    <ul className="mt-1 ml-1 space-y-0.5">
      {v.passes.map((r) => <CheckRowView key={r.key} r={r} />)}
    </ul>
  ) : null;
  return (
    <div className={`mt-2 rounded border px-2 py-1.5 ${v.failing ? TONE.warn : TONE.ok}`}>
      <div className="font-medium">{v.heading}</div>
      <div className="mt-0.5 opacity-80">{v.summary}</div>
      {v.failures.length ? (
        <ul className="mt-1 ml-1 space-y-0.5">
          {v.failures.map((r) => <CheckRowView key={r.key} r={r} />)}
        </ul>
      ) : null}
      {v.foldPasses ? (
        <details className="mt-1">
          <summary className="cursor-pointer opacity-80">{`Show ${v.passes.length} passing checks`}</summary>
          {passList}
        </details>
      ) : passList}
      {v.advisoryNote ? <div className="mt-1 opacity-80">{v.advisoryNote}</div> : null}
      {v.checkedNote ? <div className="mt-1 opacity-80">{v.checkedNote}</div> : null}
      {v.baseNote ? <div className="mt-1 opacity-80" data-checks-base="superseded">{v.baseNote}</div> : null}
      {v.fixNote ? <div className="mt-1 opacity-80">{v.fixNote}</div> : null}
      {v.action ? <ActionButton a={v.action} /> : null}
    </div>
  );
}

function Roster({ r }: { r: RosterView }): ReactNode {
  if (r.phase === 'hidden') return null;
  return (
    <span className="dev-ledger-roster">
      {r.phase === 'loading' ? 'Loading votes…' : (
        <>
          <span className="dev-ledger-yes">{`${r.yes!.label}:`}</span>
          {` ${r.yes!.names} `}
          <span className="dev-ledger-no">{`${r.no!.label}:`}</span>
          {` ${r.no!.names}`}
          <span className="dev-ledger-needs">{r.needs}</span>
        </>
      )}
    </span>
  );
}

/**
 * The "Where it stands" sheet: one row per fact, in the bar's tones. Built
 * by app-view.js (`_topicLedgerRows`) from the same reason, checks, roster
 * and note builders the four boxes used to draw from — this only draws.
 */
export function LedgerView({ d }: { d: ProposalDetails }): ReactNode {
  if (!d.ledger || !d.ledger.length) return null;
  return (
    <section className="dev-topic-sheet dev-topic-ledger" data-topic-sheet="ledger">
      <h4 className="dev-topic-h">Where it stands</h4>
      <div className="dev-ledger">
        {d.ledger.map((r) => (
          <div key={r.key} className={`dev-ledger-row dev-ledger-${r.tone}`} data-note={r.key} {...(r.attrs || {})}>
            <span className="dev-ledger-dot" aria-hidden="true">{r.spinner ? <Spinner /> : LEDGER_GLYPH[r.tone]}</span>
            <span className="dev-ledger-k">
              {r.label}
              {r.sub ? <small>{r.sub}</small> : null}
            </span>
            <span className="dev-ledger-v">
              {r.text.length ? <span className="dev-ledger-text"><Runs parts={r.text} /></span> : null}
              {r.roster ? <Roster r={r.roster} /> : null}
              {(r.foot || []).map((f, i) => <span key={i} className="dev-ledger-foot"><Runs parts={f} /></span>)}
              {(r.warnFoot || []).map((f, i) => (
                <span key={`w${i}`} className="dev-ledger-foot dev-ledger-foot-warn text-amber-800 dark:text-amber-400"><Runs parts={f} /></span>
              ))}
              {r.list && r.list.length ? (
                <ul className="dev-ledger-list">
                  {r.list.map((it, j) => (
                    <li key={j} className={(it.kind || it.mono) ? 'font-mono' : undefined}>
                      {it.kind ? <span className="opacity-70">{`[${it.kind}] `}</span> : null}
                      {it.code ? <code className="font-mono">{it.code}</code> : null}
                      {it.text ? (it.code ? `: ${it.text}` : it.text) : null}
                      {it.source ? <span className="opacity-60">{` (${it.source})`}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {r.fails && r.fails.length ? (
                <ul className="dev-ledger-fails">
                  {r.fails.map((c) => <CheckRowView key={c.key} r={c} />)}
                </ul>
              ) : null}
              {(r.actions && r.actions.length) || (r.passes && r.passes.length) ? (
                <span className="dev-ledger-ops">
                  {(r.actions || []).map((a) => <ActionButton key={a.key} a={a} />)}
                  {r.passes && r.passes.length ? (
                    <details className="dev-ledger-passes">
                      <summary className="gc-vote-btn dev-ledger-passes-btn">{`${r.passes.length} passing`}</summary>
                      <ul className="dev-ledger-fails">
                        {r.passes.map((c) => <CheckRowView key={c.key} r={c} />)}
                      </ul>
                    </details>
                  ) : null}
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      {d.helpHint ? (
        <div className="dev-ledger-help voting-help-hint">
          {'Merges are decided by votes over time · '}
          <button type="button" className="voting-help-link" data-voting-help="">How voting works</button>
          {d.help ? (
            <button
              type="button"
              className="voting-help-btn"
              data-voting-help=""
              aria-label="How voting and merges work"
              title="How voting and merges work"
            >?</button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const LEDGER_GLYPH: Record<string, string> = {
  bad: '✕', warn: '!', ok: '✓', vote: '✓', mute: '·', progress: '◐',
};

export function ProposalBody({ b }: { b: NonNullable<TopicBody['proposalBody']> }): ReactNode {
  return (
    <details
      className="dev-topic-details"
      open={b.open}
      onToggle={(e) => {
        if (b.id != null) call('_setProposalBodyOpen', b.id, e.currentTarget.open);
      }}
    >
      <summary className="dev-topic-details-summary">
        Full proposal details
      </summary>
      {/* DevChat.renderMarkdown's output — sanitised where it is built, and
          the same pipeline the issue body above uses. */}
      <div
        className="dev-issue-body dev-topic-details-body"
        dangerouslySetInnerHTML={{ __html: b.html }}
      />
    </details>
  );
}

function Transcript({ t }: { t: TranscriptSection }): ReactNode {
  // "Fork this chat" is painted INSIDE the body, after its fetch, by
  // `_transcriptActionsHtml` — so it cannot be a child's onClick. The
  // section delegates, which is what `_renderTopicHead` bound here per
  // paint before.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest?.('[data-fork-chat]') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    e.preventDefault();
    call('forkSharedChat', parseInt(btn.dataset.forkChat || '', 10), btn);
  };
  return (
    <div className="st-section" data-transcript-section={t.id} onClick={onClick}>
      <button
        type="button"
        className="st-section-head"
        data-transcript-toggle={t.id}
        aria-expanded={t.expanded}
        onClick={() => call('toggleTranscript', t.id)}
      >
        <span className="st-caret" aria-hidden="true"></span>
        <span data-transcript-label="">{t.label}</span>
        <span className="st-readonly-tag">read-only</span>
      </button>
      {/* The BODY is public/js/session-transcript.js's — a controller host,
          rendered once with a constant className and never looked inside. */}
      <div className="st-body" data-transcript-body={t.id} hidden={!t.expanded}></div>
    </div>
  );
}

export function TopicHead(): ReactNode {
  const { card, body } = useStoreState(topicHeadStore);
  if (!card || !body) return null;
  const a = body.actions;
  // The About sheet: the words (summary or issue body), the before/after
  // tiles — open, they are the most useful thing on the page for a voter —
  // the full PR body as a disclosure line, and a session's note.
  const aboutHtml = body.summaryHtml || body.issueBodyHtml || null;
  const tiles = a && a.visuals ? a.visuals : null;
  const hasAbout = !!(aboutHtml || tiles || body.proposalBody || body.note);
  return (
    <div className="dev-topic">
      <div className="dev-topic-sheet dev-topic-card" data-topic-sheet="card">
        <DevCard model={card} />
      </div>
      {body.details ? <LedgerView d={body.details} /> : null}
      {hasAbout ? (
        <section className="dev-topic-sheet dev-topic-about" data-topic-sheet="about">
          <h4 className="dev-topic-h">{body.aboutTitle || 'About'}</h4>
          {/* DevChat.renderMarkdown's output — sanitised where it is built. */}
          {aboutHtml ? <div className="dev-topic-about-body" dangerouslySetInnerHTML={{ __html: aboutHtml }} /> : null}
          {tiles ? (
            <div className="dev-topic-visuals" data-visuals-scope="1">
              {/* AppView.visualsTilesHtml's markup — four other surfaces
                  still call it, so it stays a string builder. */}
              <div className="usn-visuals-body" dangerouslySetInnerHTML={{ __html: tiles.tilesHtml }} />
            </div>
          ) : null}
          {body.proposalBody ? <ProposalBody b={body.proposalBody} /> : null}
          {body.note ? <div className="dev-topic-note">{body.note}</div> : null}
        </section>
      ) : null}
      {body.transcript ? (
        <section className="dev-topic-sheet dev-topic-transcript" data-topic-sheet="transcript">
          <Transcript t={body.transcript} />
        </section>
      ) : null}
      {/* The GitHub thread's host (issue-comments.tsx mounts into it), last
          so app.css can run it into the Discussion sheet below the head. */}
      {body.comments ? <div id="dev-issue-comments" className="dev-topic-sheet dev-topic-comments"></div> : null}
    </div>
  );
}
