/**
 * `#dc-session-list`'s rows, as the only React writer below that host.
 *
 * The host itself stays `renderChatView`'s — it writes the element, with the
 * scroll geometry the pane depends on — so this is the same
 * host-is-mine/children-are-React's seam the four composer strips use.
 *
 * ── The empty state is a THIRD state ──────────────────────────────────
 *
 * `rows: null` means "not published yet" and draws nothing; `rows: []` is
 * the real "no sessions" pitch. Collapsing them would flash that pitch for
 * one frame on every chat-view render, which is exactly when a returning
 * user is least in the mood to be told what a dev session is.
 *
 * ── A button's pending label is component state ───────────────────────
 *
 * Each action flashed its own text ("Pausing…", "Worker freed") by writing
 * `btn.textContent` and then letting the re-render replace the row. The
 * handler returns a flash label (or null) now and the row holds it until the
 * next publish, which is the same behaviour without a second writer.
 */

import { useState, type ReactNode } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { sessionListStore } from './session-list-store';
import type { SessionAction, SessionListState, SessionRow } from './session-list-store';

/**
 * Complete literals — Tailwind's extractor is a regex over source text.
 *
 * Every one of these is PAIRED. The list predates light mode and shipped
 * `text-zinc-300` titles on `hover:bg-zinc-800/50` rows, which read as grey
 * on grey the moment the shell got a light theme — the same
 * dark-only-token problem this run has been fixing everywhere else, in the
 * other direction.
 */
const STATUS_TONE: Record<SessionRow['statusTone'], string> = {
  active: 'text-emerald-600 dark:text-emerald-400',
  promoted: 'text-violet-600 dark:text-violet-400',
  paused: 'text-zinc-500 dark:text-zinc-400',
  other: 'text-zinc-500',
};

const ACTION_TONE: Record<SessionAction['tone'], string> = {
  quiet: 'text-zinc-500 dark:text-zinc-400 hover:text-emerald-600 dark:hover:text-emerald-400',
  go: 'text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300',
  danger: 'text-zinc-500 dark:text-zinc-400 hover:text-red-500 dark:hover:text-red-400',
};

/** The class each action carried, by key — kept so the hooks stay stable. */
const ACTION_CLASS: Record<SessionAction['key'], string> = {
  pause: 'dc-pause-btn',
  free: 'dc-pause-btn',
  resume: 'dc-pause-btn',
  archive: 'dc-archive-btn',
  unarchive: 'dc-unarchive-btn',
};

async function call(fn: string, args: unknown[]): Promise<string | null> {
  const dc = typeof window !== 'undefined' ? (window as any).DevChat : null;
  if (!dc || typeof dc[fn] !== 'function') return null;
  return (await dc[fn](...args)) || null;
}

function ActionButton({ a }: { a: SessionAction }): ReactNode {
  const [pending, setPending] = useState<string | null>(null);
  return (
    <button
      type="button"
      className={`${ACTION_CLASS[a.key]} text-xs ${ACTION_TONE[a.tone]}`}
      disabled={!!pending}
      {...(a.title ? { title: a.title } : null)}
      onClick={async (e) => {
        e.stopPropagation();
        if (pending) return;
        setPending(a.busy);
        // A null answer means the row is about to be replaced (or was
        // restored on failure) — either way the label goes back.
        setPending(await call(a.fn, a.args));
      }}
    >
      {pending || a.label}
    </button>
  );
}

function Row({ row }: { row: SessionRow }): ReactNode {
  return (
    <div
      className="dc-session-item px-3 py-2 cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800/50 flex items-center gap-2"
      data-id={row.id}
      onClick={() => { void call('openSessionFromList', [row.id]); }}
    >
      <span className={`text-xs ${STATUS_TONE[row.statusTone]} font-mono`}>{row.status}</span>
      <span className="text-sm text-zinc-800 dark:text-zinc-300 flex-1 truncate" title={row.branch}>{row.title}</span>
      {row.busy ? (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-500 shrink-0">
          <span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>
          {'working…'}
        </span>
      ) : null}
      {row.pr ? (
        <a
          href={row.pr.url}
          target="_blank"
          rel="noopener"
          className="text-xs text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
          onClick={(e) => e.stopPropagation()}
        >{`PR#${row.pr.number}`}</a>
      ) : null}
      {row.actions.map((a) => <ActionButton key={a.key} a={a} />)}
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{row.date}</span>
    </div>
  );
}

function EmptyPitch(): ReactNode {
  return (
    <div className="text-center px-6 py-12">
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
        Want to change this app? Just ask.
      </p>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3 max-w-xs mx-auto">
        {"Describe what you'd like different in plain English — an AI writes the code and opens a "
          + 'real pull request. No coding required. The app’s users then vote it in.'}
      </p>
      <p className="text-xs text-zinc-500 dark:text-zinc-500">
        {'Hit '}
        <span className="font-medium text-emerald-600 dark:text-emerald-400">+ New Session</span>
        {' above to start, e.g. '}
        <span className="italic">&quot;make the header dark blue&quot;</span>
        {'.'}
      </p>
    </div>
  );
}

export function SessionListView({ rows }: SessionListState): ReactNode {
  if (!rows) return null;
  if (!rows.length) return <EmptyPitch />;
  return <>{rows.map((row) => <Row key={row.id} row={row} />)}</>;
}

export function SessionList(): ReactNode {
  return <SessionListView {...useStoreState<SessionListState>(sessionListStore)} />;
}
