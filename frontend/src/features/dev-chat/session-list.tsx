import { getLanguage } from "../../lib/i18n/runtime";
import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { RichMessage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message } from "../../lib/i18n/react";
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

import { useState, type KeyboardEvent, type ReactNode } from 'react';

import { messageStamp } from '../../lib/timestamp';
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
  active: 'text-emerald-700 dark:text-emerald-400',
  promoted: 'text-violet-700 dark:text-violet-400',
  paused: 'text-zinc-500 dark:text-zinc-400',
  other: 'text-zinc-500 dark:text-zinc-400',
};

const ACTION_TONE: Record<SessionAction['tone'], string> = {
  quiet: 'text-zinc-500 dark:text-zinc-400 hover:text-emerald-600 dark:hover:text-emerald-400',
  go: 'text-emerald-700 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300',
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

/**
 * One action button's click: the busy label while the call runs, then its
 * answer. A null answer means the row is about to be replaced (or was
 * restored on failure) — either way the label goes back. A handler that
 * THROWS restores it too: without this the button sat on its busy label,
 * disabled, until the next publish, which a failed call never sends.
 */
export async function runSessionAction(
  a: Pick<SessionAction, 'fn' | 'args' | 'busy'>,
  setPending: (label: string | null) => void,
): Promise<void> {
  setPending(a.busy);
  let flash: string | null = null;
  try {
    flash = await call(a.fn, a.args);
  } catch (err) {
    console.warn(`[session-list] ${a.fn} failed`, err);
  } finally {
    setPending(flash);
  }
}

function ActionButton({ a }: { a: SessionAction }): ReactNode {
  useUiLanguage();
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
        await runSessionAction(a, setPending);
      }}
    >
      {pending || a.label}
    </button>
  );
}

/**
 * A row that opens a session IS a button (#1918, #2989): in the tab order,
 * and Enter/Space open it like a click. The keys act only when the ROW has
 * focus, so the nested PR link and action buttons keep their own Enter/Space.
 * The row's visible text runs status, title, PR number, action labels and a
 * time together, so it names itself after the session instead.
 *
 * The new attributes render BEFORE `class`: tests pin `class="dc-session-item…"
 * data-id="7"` and `data-id="8"><span`, i.e. data-id stays last.
 */
function Row({ row }: { row: SessionRow }): ReactNode {
  const open = () => { void call('openSessionFromList', [row.id]); };
  return (
    <LocalizedDynamic element={<div
      role="button"
      tabIndex={0}
      aria-label={tr("workshop:open_session_value1_value2_902d250d", { value1: row.title, value2: row.status })}
      className="dc-session-item px-3 py-2 cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800/50 flex items-center gap-2"
      data-id={row.id}
      onClick={open}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <span className={`text-xs ${STATUS_TONE[row.statusTone]} font-mono`}>{row.status}</span>
      <span className="text-sm text-zinc-800 dark:text-zinc-300 flex-1 truncate" title={row.branch}>{row.title}</span>
      {row.busy ? (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-700 shrink-0 dark:text-emerald-400"><RichMessage id="workshop:sentence_43fb2fd0ead3" components={[<span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true" />]} /></span>
      ) : null}
      {row.pr ? (
        <a
          href={row.pr.url}
          target="_blank"
          rel="noopener"
          className="text-xs text-violet-700 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
          onClick={(e) => e.stopPropagation()}
        ><LocalizedValue render={() => (tr("workshop:pr_value1_8d7f966f", { value1: row.pr?.number || '' }))} /></a>
      ) : null}
      {row.actions.map((a) => <ActionButton key={a.key} a={a} />)}
      <SessionDate createdAt={row.createdAt} />
    </div>} resolve={() => ({ get "aria-label"() { return tr("workshop:open_session_value1_value2_902d250d", { value1: row.title, value2: row.status }); } })} />
  );
}

/**
 * #1808: when the session was opened. It read `toLocaleDateString()` — a
 * bare "9/9/2026", so two sessions started the same afternoon were
 * indistinguishable and one started at midnight was ambiguous by a day.
 * Form A, so today's sessions (nearly all of them, in a list capped at a
 * handful) still spend the row's last column on a time alone.
 */
function SessionDate({ createdAt }: { createdAt: string }) {
  const stamp = messageStamp(createdAt);
  if (!stamp.text) return null;
  return (
    <time
      className="text-xs text-zinc-500 dark:text-zinc-400"
      dateTime={createdAt}
      title={stamp.title}
    >{stamp.text}</time>
  );
}

function EmptyPitch(): ReactNode {
  return (
    <div className="text-center px-6 py-12">
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"><Message id="workshop:want_to_change_this_app_just_ask_5bd5f0cd" /></p>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3 max-w-xs mx-auto">
        {tr("workshop:describe_what_you_d_like_different_in_plain_engl_5a074ef4")}
      </p>
      <p className="text-xs text-zinc-500 dark:text-zinc-500"><RichMessage id="workshop:sentence_777cf83ea78a" components={[<span className="font-medium text-emerald-700 dark:text-emerald-400" />, <span className="italic" />]} /></p>
    </div>
  );
}

/**
 * The list's last row when it left finished sessions out: one quiet line,
 * the same weight as a row's own actions, that reads the whole history.
 */
function OlderRow({ older }: { older: number }): ReactNode {
  useUiLanguage();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className="dc-session-older w-full px-3 py-2 text-left text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
      disabled={pending}
      onClick={async () => {
        if (pending) return;
        setPending(true);
        await call('showOlderSessions', []);
        setPending(false);
      }}
    >
      <LocalizedValue render={() => (pending ? tr("workshop:loading_ba3bbbe1") : tr("workshop:message_375f94f9bcfc", { value1: older.toLocaleString(getLanguage()), count: older }))} />
    </button>
  );
}

export function SessionListView({ rows, older = 0 }: SessionListState): ReactNode {
  if (!rows) return null;
  if (!rows.length && !older) return <EmptyPitch />;
  const listed = rows.map((row) => <Row key={row.id} row={row} />);
  if (!older) return <>{listed}</>;
  return <>{listed}<OlderRow older={older} /></>;
}

export function SessionList(): ReactNode {
  useUiLanguage();
  return <SessionListView {...useStoreState<SessionListState>(sessionListStore)} />;
}
