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
    <div className={`mt-2 rounded border px-2 py-1.5 ${TONE[box.tone]}`}>
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
      {v.fixNote ? <div className="mt-1 opacity-80">{v.fixNote}</div> : null}
      {v.action ? <ActionButton a={v.action} /> : null}
    </div>
  );
}

function Roster({ r }: { r: RosterView }): ReactNode {
  if (r.phase === 'hidden') return null;
  return (
    <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
      {r.phase === 'loading' ? 'Loading votes…' : (
        <>
          <span className="text-emerald-700 font-medium dark:text-emerald-400">{`${r.yes!.label}:`}</span>
          {` ${r.yes!.names} `}
          <span className="text-red-400 font-medium">{`${r.no!.label}:`}</span>
          {` ${r.no!.names}`}
          <span className="text-zinc-500 dark:text-zinc-400">{r.needs}</span>
        </>
      )}
    </div>
  );
}

function DetailsView({ d }: { d: ProposalDetails }): ReactNode {
  const meta: ReactNode[] = [];
  d.meta.forEach((m, i) => {
    if (i) meta.push(' · ');
    meta.push(m.href
      ? (
        <a key={i} href={m.href} target="_blank" rel="noopener" className="text-violet-700 hover:underline dark:text-violet-400">
          <Runs parts={m.parts} />
        </a>
      )
      : <span key={i}><Runs parts={m.parts} /></span>);
  });
  return (
    <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 px-1">
      <div>
        {meta}
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
      {d.notes.map((n) => (
        <div key={n.key} className={n.tone === 'warn'
          ? 'text-xs text-amber-800 dark:text-amber-400 mt-1'
          : 'text-xs text-zinc-500 dark:text-zinc-400 mt-1'}>
          <Runs parts={n.parts} />
        </div>
      ))}
      {d.linked.length ? (
        <div className="mt-1 flex flex-wrap gap-1 items-center">
          <span>Linked issues:</span>
          {d.linked.map((l) => (
            <a
              key={l.n}
              href={l.href}
              className="dev-badge font-mono bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400"
              title={`Open issue #${l.n}`}
            >{`#${l.n}`}</a>
          ))}
        </div>
      ) : null}
      {d.blocks.map((b, i) => (b.t === 'checks'
        ? <ChecksVerdictView key={`checks:${i}`} v={b.v} />
        : <NoteBoxView key={b.box.key} box={b.box} />))}
      {d.roster ? <Roster r={d.roster} /> : null}
      {d.helpHint ? (
        <div className="voting-help-hint mt-1">
          {'Merges are decided by votes over time. '}
          <button type="button" className="voting-help-link" data-voting-help="">How voting works</button>
        </div>
      ) : null}
      {d.explicitNote ? <div className="text-xs text-amber-800 dark:text-amber-400 mt-1">{d.explicitNote}</div> : null}
      {d.lockedNote ? <div className="text-xs text-amber-800 mt-1 dark:text-amber-300">{d.lockedNote}</div> : null}
    </div>
  );
}

/**
 * #1370's "Full proposal details". The `<details>` is uncontrolled — its
 * `open` is a DEFAULT, and the toggle reports back to app-view.js, which is
 * what remembers it across the head's frequent repaints. Controlling it
 * would fight the browser's own disclosure animation for no gain, since the
 * model is republished from the same flag.
 */
export function ProposalBody({ b }: { b: NonNullable<TopicBody['proposalBody']> }): ReactNode {
  return (
    <details
      className="border border-zinc-200 dark:border-zinc-800 rounded-xl mt-2 overflow-hidden"
      open={b.open}
      onToggle={(e) => {
        if (b.id != null) call('_setProposalBodyOpen', b.id, e.currentTarget.open);
      }}
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
        Full proposal details
      </summary>
      {/* DevChat.renderMarkdown's output — sanitised where it is built, and
          the same pipeline the issue body above uses. */}
      <div
        className="dev-issue-body text-xs text-zinc-600 dark:text-zinc-300 border-t border-zinc-200 dark:border-zinc-800 p-3"
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
  return (
    <>
      <DevCard model={card} />
      {a && (a.pills.length || a.reasons || a.visuals) ? (
        <div className="dev-detail-actions">
          {a.pills.length ? (
            <div className="gc-card-actions">
              {a.pills.map((p) => <ActionButton key={p.key} a={p} />)}
            </div>
          ) : null}
          {a.reasons ? (
            <div className="dev-detail-reasons">
              <div className="dev-detail-reasons-head">{a.reasons.heading}</div>
              <ul className="dev-detail-reasons-list">
                {a.reasons.items.map((r) => (
                  <li key={r.key} className={r.soft ? 'dev-detail-reason-soft' : 'dev-detail-reason-hard'}>
                    <span className="dev-detail-reason-label">{r.label}</span>
                    {` ${r.detail}`}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {a.visuals ? (
            <div className="mt-2" data-visuals-scope="1">
              <button
                type="button"
                className="gc-vote-btn"
                aria-expanded={a.visuals.open}
                onClick={() => call('toggleVisuals', a.visuals!.sessionId)}
              >{a.visuals.open ? 'Hide before/after' : 'Show before/after'}</button>
              {/* AppView.visualsTilesHtml's markup — four other surfaces
                  still call it, so it stays a string builder. The inert
                  <template> the toggle used to copy from is gone: open is a
                  model field, so closed simply renders nothing. */}
              <div
                className="usn-visuals-body"
                dangerouslySetInnerHTML={{ __html: a.visuals.open ? a.visuals.tilesHtml : '' }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {body.issueBodyHtml ? (
        <div
          className="dev-issue-body text-xs text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 mt-2"
          dangerouslySetInnerHTML={{ __html: body.issueBodyHtml }}
        />
      ) : null}
      {body.comments ? <div id="dev-issue-comments" className="mt-2"></div> : null}
      {body.summaryHtml ? (
        <div
          className="dev-issue-body text-xs text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 mt-2"
          dangerouslySetInnerHTML={{ __html: body.summaryHtml }}
        />
      ) : null}
      {body.proposalBody ? <ProposalBody b={body.proposalBody} /> : null}
      {body.details ? <DetailsView d={body.details} /> : null}
      {body.note ? <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 px-1">{body.note}</div> : null}
      {body.transcript ? <Transcript t={body.transcript} /> : null}
    </>
  );
}
