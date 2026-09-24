import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { Button } from '@/components/ui/button';
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  DraftEditIcon,
  DraftSendIcon,
  DraftTrashIcon,
  SaveDraftIcon,
  SparklesIcon,
  SpinnerArcIcon,
  XIcon,
} from '@/components/ui/icons';

import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { Attached } from '../dev-chat/transcript';
import { nowStore, type TranscriptRow } from '../dev-chat/transcript-store';
import type { AgentChange, AgentSession, SavedDraft } from './api';
import {
  choiceFromValue,
  choiceValue,
  effectiveChoice,
  effortOptions,
  effortValue,
  offersReasoning,
  pickerOptions,
  type PickerOption,
} from './model-choice';
import {
  buildTranscript,
  checksSummary,
  cardView,
  changeStatusLabel,
  durationLabel,
  latestReplies,
  runHeading,
  type CardView,
  type PreviewItem,
  type RunItem,
  type TranscriptItem,
} from './transcript';
import {
  chooseAgent,
  clearReturnedText,
  closeSpec,
  composerId,
  decideCard,
  deleteSavedDraft,
  editSavedDraft,
  loadModelCatalog,
  openAgentSession,
  openSpec,
  sendAgentMessage,
  setDrawerOpen,
  setSpecTab,
  setPaneTab,
  dockPreview,
  openPreview,
  proposeChange,
  retryStaging,
  PREVIEW_SLOT_ID,
  saveComposerDraft,
  sendSavedDraft,
  stopAgentTurn,
  switchActiveChange,
  useAgentSessionState,
  type PaneTab,
  type PreviewPaneState,
  type SpecSheetState,
  type SpecTab,
} from './store';
import {
  PREVIEW_MIN_WIDTH,
  SPEC_DEFAULT_WIDTH,
  SPEC_MIN_WIDTH,
  SPEC_WIDTH_STEP,
  clampSpecWidth,
  readSpecWidth,
  splitSpec,
  useSidePaneBeside,
  useWideEnoughForSpec,
  writeSpecWidth,
  type SpecSplit,
} from './spec-layout';
import { readUnsent, writeUnsent } from './unsent';

// Agent sessions (#2779, docs/agent-sessions.md "UI surfaces"): one
// conversation with the Mayor that works on any app. Drawn on two surfaces,
// like Global Chat: its own screen (#agent/<id>, a phone's only surface) and
// the Messages pane beside the inbox on a desktop (#messages/agent/<id>).
// One panel, so the two cannot drift. New change opens it UNSENT at `new`
// (the store's `draft`): the same panel, with nothing created until the
// first message.
//
// React owns every node below the screen root; no legacy module writes into
// it. The first render is the hidden, empty root the prerendered shell
// ships, and everything loads in effects.

function markdown(text: string, breaks = true): string | null {
  const render = typeof window === 'undefined' ? null : window.DevChat?.renderMarkdown;
  if (typeof render !== 'function') return null;
  try { return render(text, { breaks }); } catch { return null; }
}

function MayorText({ text }: { text: string }) {
  const html = useMemo(() => markdown(text), [text]);
  if (html) {
    // renderMarkdown is the dev chat's sanitizer (marked + DOMPurify).
    return <div className="dc-msg-content text-[15px] leading-relaxed text-zinc-900 dark:text-zinc-100" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-zinc-900 dark:text-zinc-100">{text}</p>;
}

function appInitial(name: string | null | undefined) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

function AppMark({ name }: { name: string | null | undefined }) {
  return (
    <span aria-hidden="true" className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-violet-600 text-[11px] font-semibold text-white">
      {appInitial(name)}
    </span>
  );
}

function statusTone(status: string | null | undefined) {
  switch (status) {
    case 'promoted': return 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-200';
    case 'merged': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200';
    // A paused change is an active one whose worker was released (#2779
    // follow-up); it looks the same.
    case 'active':
    case 'paused': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200';
    default: return 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';
  }
}

function changeRef(change: AgentChange) {
  return change.prNumber ? `PR #${change.prNumber}` : `Change ${change.id}`;
}

// ── Header ─────────────────────────────────────────────────────────────

/** What the conversation is about: the session's, or the unsent draft's. */
type About = Pick<AgentSession, 'focusApp' | 'focusContext'> | null;

function SessionBar({ session, about, embedded, action }: {
  session: AgentSession | null;
  about: About;
  embedded: boolean;
  /** The pane's own control at the bar's end — Messages' full-width toggle. */
  action?: ReactNode;
}) {
  const snapshot = useAgentSessionState();
  const active = session?.activeChange || null;
  const building = snapshot.turn.running && snapshot.turn.phase === 'cc';
  const count = session?.changes?.length || 0;
  return (
    <div className={`flex items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800 ${embedded ? 'flex-wrap' : ''}`} data-agent-session-bar>
      {embedded ? (
        <div className="mr-auto min-w-0 basis-full sm:basis-auto">
          <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">{session?.title || 'New session'}</h2>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            Agent session{about?.focusApp?.name ? ` · started from ${about.focusApp.name}` : ''}
          </p>
        </div>
      ) : null}
      <span
        data-agent-session-focus
        className="inline-flex min-w-0 max-w-[10rem] items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-800 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200"
        title="The app this conversation is about when a request does not name one. The Mayor moves it when you ask."
      >
        {about?.focusApp ? <AppMark name={about.focusApp.name} /> : null}
        <span className="truncate">{about?.focusApp?.name || 'Any app'}</span>
      </span>
      <span
        data-agent-session-change-pill
        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(active?.status)}`}
      >
        {active ? `${changeStatusLabel(active.status, building)}${active.prNumber ? ` · PR #${active.prNumber}` : ''}` : 'No change yet'}
      </span>
      <button
        type="button"
        data-agent-session-changes-button
        className={`${embedded ? '' : 'ml-auto '}inline-flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800`}
        onClick={() => setDrawerOpen(true)}
        disabled={!session}
        aria-haspopup="dialog"
      >
        Changes · {count}
      </button>
      {action}
    </div>
  );
}

// ── Transcript pieces ──────────────────────────────────────────────────

function Card({ card, live = false }: { card: CardView; live?: boolean }) {
  const snapshot = useAgentSessionState();
  const deciding = snapshot.deciding === card.id;
  const pending = card.status === 'pending';
  return (
    <section
      className={`agent-session-card mt-3 rounded-2xl border bg-white p-4 dark:bg-zinc-900 ${pending ? 'border-violet-300 dark:border-violet-800' : 'border-zinc-200 dark:border-zinc-800'}`}
      aria-label={`Confirm: ${card.title}`}
      data-agent-session-card={card.status}
    >
      {pending ? <p className="mb-1 text-xs font-semibold text-violet-700 dark:text-violet-300">Needs your OK</p> : null}
      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{card.title}</h3>
      {card.rows.length ? (
        <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
          {card.rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
              <dd className="min-w-0 break-words text-zinc-900 dark:text-zinc-100">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {pending && !live ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            data-agent-session-confirm
            layout="iconRow"
            variant="pillAccent"
            disabledStyle="dim"
            disabled={!!snapshot.deciding}
            onClick={() => void decideCard(card.id, 'confirm')}
          >
            {deciding ? <SpinnerArcIcon className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Confirm
          </Button>
          <Button
            type="button"
            data-agent-session-dismiss
            variant="pillNeutral"
            disabledStyle="dim"
            ink="neutral"
            disabled={!!snapshot.deciding}
            onClick={() => void decideCard(card.id, 'dismiss')}
          >
            Not now
          </Button>
        </div>
      ) : null}
      {live ? <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">Waiting for the Mayor to finish…</p> : null}
      {card.status === 'running' ? (
        <p className="mt-3 inline-flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300"><SpinnerArcIcon className="h-4 w-4 animate-spin" aria-hidden="true" /> Running…</p>
      ) : null}
      {card.status === 'done' ? (
        <p className="mt-3 inline-flex items-start gap-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
          <CheckIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> Confirmed{card.outcome ? ` · ${card.outcome}` : ''}
        </p>
      ) : null}
      {card.status === 'failed' ? (
        <p className="mt-3 text-sm font-semibold text-red-700 dark:text-red-300">Did not go through{card.outcome ? `: ${card.outcome}` : '.'}</p>
      ) : null}
      {card.status === 'dismissed' ? <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Dismissed. Nothing was changed.</p> : null}
      {card.status === 'expired' ? <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">This confirmation expired. Ask again for a fresh one.</p> : null}
    </section>
  );
}

function Item({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end" data-agent-session-user>
          <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-100 px-4 py-2.5 text-[15px] text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">{item.text}</p>
        </div>
      );
    case 'mayor':
      return (
        <article data-agent-session-mayor>
          <p className="mb-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
            Mayor
            {item.cost ? (
              <span className="font-normal text-zinc-500 dark:text-zinc-400" data-agent-session-reply-cost>{` · ${item.cost}`}</span>
            ) : null}
          </p>
          {item.text ? <MayorText text={item.text} /> : null}
          {item.cards.map((card) => <Card key={card.id} card={card} />)}
        </article>
      );
    case 'divider':
      return (
        <div className="flex items-center gap-3 py-1 text-xs text-zinc-500 dark:text-zinc-400" data-agent-session-divider={item.event}>
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          <span className="max-w-[80%] text-center font-semibold">{item.text}</span>
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        </div>
      );
    case 'note':
      return (
        <p
          className={`text-sm ${item.tone === 'error' ? 'text-red-700 dark:text-red-300' : item.tone === 'ok' ? 'text-emerald-700 dark:text-emerald-300' : 'text-zinc-500 dark:text-zinc-400'}`}
          data-agent-session-note={item.tone}
        >
          {item.text}
        </p>
      );
    case 'run':
      return <RunCard run={item} />;
    case 'spec':
      return <SpecCard item={item} />;
    case 'preview':
      return <PreviewCard item={item} />;
    default:
      return null;
  }
}

/**
 * A coding-agent run, as the dev chat draws one: its `Attached` card, a
 * status line that opens in place onto the run's log, or onto a build's own
 * summary of what it did. The caption names the agent that ran. The running
 * run carries the turn's live progress line and clock.
 */
export function RunCard({ run }: { run: RunItem }) {
  const snapshot = useAgentSessionState();
  const running = run.status === 'running';
  const html = useMemo(() => (run.output ? markdown(run.output) : null), [run.output]);
  const duration = durationLabel(run.durationMs);
  const logText = [...run.steps, ...run.log].join('\n');
  const row: Extract<TranscriptRow, { t: 'attached' }> = {
    t: 'attached',
    key: run.key,
    details: { persistId: `agent-run-${run.key}`, defaultOpen: false },
    icon: running ? 'spinner' : run.status === 'failed' || run.status === 'stopped' ? 'flag' : 'check',
    text: runHeading(run),
    caption: run.agent || undefined,
    elapsed: running
      ? (snapshot.turn.startedAt ? { kind: 'since', since: snapshot.turn.startedAt } : null)
      : duration ? { kind: 'fixed', label: `(took ${duration})` } : null,
    stamp: '',
    progress: running && snapshot.turn.progress
      ? { current: snapshot.turn.progress, steps: run.log.length, phase: '', estimate: '', countdownTo: null, cohortSince: null }
      : undefined,
    body: html
      ? { kind: 'md', html }
      : { kind: 'log', persistId: `agent-run-log-${run.key}`, text: run.output || logText || (running ? 'Starting…' : 'No output.') },
  };
  return (
    <div data-agent-session-run={run.status} data-agent-session-run-mode={run.mode}>
      <Attached r={row} />
    </div>
  );
}

const CARD_BUTTON = 'inline-flex rounded-full border border-violet-300 px-3 py-1 text-sm font-semibold text-violet-700 '
  + 'hover:bg-violet-50 disabled:opacity-60 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/40';
const CARD_PRIMARY = 'inline-flex rounded-full bg-violet-600 px-3 py-1 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60';
const CHECK_TONE: Record<string, string> = {
  passing: 'text-green-700 dark:text-green-400',
  failing: 'text-red-700 dark:text-red-300',
  running: 'text-zinc-500 dark:text-zinc-400',
  error: 'text-amber-700 dark:text-amber-300',
};

function findChange(session: AgentSession | null, changeId: number | null): AgentChange | null {
  if (!session || changeId == null) return null;
  return [session.activeChange, ...(session.changes || [])].find((change) => change && change.id === changeId) || null;
}

/**
 * A change's staging build, as a card (#2779 follow-up). The newest one of a
 * change is live:
 *   - deployed: Open preview (in the side pane on a wide screen, a new tab
 *     otherwise), View change (its card), and Propose to group while it has
 *     not been proposed; then "In vote" with the proposal.
 *   - failed: why, and Retry (a rebuild; its result writes the next card).
 * It says where the change's checks stand, because they gate merge. An older
 * card is "Superseded by a newer preview" and offers nothing: its build is
 * gone or stale.
 */
export function PreviewCard({ item }: { item: PreviewItem }) {
  const snapshot = useAgentSessionState();
  const wide = useWideEnoughForSpec();
  const action = snapshot.changeAction && snapshot.changeAction.changeId === item.changeId ? snapshot.changeAction.kind : null;
  return (
    <PreviewCardView
      item={item}
      change={findChange(snapshot.session, item.changeId)}
      wide={wide}
      action={action}
      busy={!!snapshot.changeAction}
    />
  );
}

/** The card itself, from plain props (a test renders it without a store). */
export function PreviewCardView({ item, change, wide, action, busy }: {
  item: PreviewItem;
  change: AgentChange | null;
  wide: boolean;
  action: 'propose' | 'retry' | null;
  busy: boolean;
}) {
  const prNumber = item.prNumber || change?.prNumber || null;
  const heading = `${item.failed ? 'Staging build failed' : 'Staging deployed'}${prNumber ? ` · PR #${prNumber}` : ''}`;
  if (item.superseded) {
    return (
      <section className="rounded-2xl border border-zinc-200 px-3 py-2 dark:border-zinc-800" data-agent-session-preview="superseded">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{heading} · Superseded by a newer preview</p>
      </section>
    );
  }
  const checks = checksSummary(change?.checkState, change?.checkFailing);
  const changeHref = change && change.appSlug && item.changeId != null
    ? `#app/${encodeURIComponent(change.appSlug)}/dev/proposals/${item.changeId}`
    : null;
  const inVote = change && (change.status === 'promoted' || change.status === 'merging');
  const merged = change && change.status === 'merged';
  const proposable = change && (change.status === 'active' || change.status === 'paused');
  return (
    <section
      className="rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
      data-agent-session-preview={item.failed ? 'failed' : 'deployed'}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className={`text-sm font-medium ${item.failed ? 'text-red-700 dark:text-red-300' : 'text-zinc-800 dark:text-zinc-100'}`}>{heading}</p>
        {inVote || merged ? (
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700 dark:bg-violet-950/60 dark:text-violet-300" data-agent-session-preview-status>
            {merged ? 'Merged' : 'In vote'}
          </span>
        ) : null}
        {checks ? (
          <span className={`ml-auto inline-flex items-center gap-1 text-xs ${CHECK_TONE[checks.key]}`} data-agent-session-checks={checks.key}>
            {checks.key === 'running'
              ? <SpinnerArcIcon className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              : checks.key === 'passing' ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
            {checks.text}
          </span>
        ) : null}
      </div>
      {item.failed && item.error ? <p className="mt-1 line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">{item.error}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {item.failed ? (
          item.changeId != null ? (
            <button type="button" className={CARD_BUTTON} disabled={busy} onClick={() => void retryStaging(item.changeId as number)} data-agent-session-preview-retry>
              {action === 'retry' ? 'Retrying…' : 'Retry'}
            </button>
          ) : null
        ) : item.url ? (
          wide && item.changeId != null ? (
            <button
              type="button"
              className={CARD_BUTTON}
              onClick={() => openPreview({ changeId: item.changeId as number, url: item.url as string, prNumber })}
              data-agent-session-preview-open
            >
              Open preview
            </button>
          ) : (
            <a className={CARD_BUTTON} href={item.url} target="_blank" rel="noopener noreferrer" data-agent-session-preview-open>
              Open preview
            </a>
          )
        ) : null}
        {changeHref ? (
          <a className={CARD_BUTTON} href={changeHref} data-agent-session-preview-change>
            {inVote ? 'View proposal' : 'View change'}
          </a>
        ) : null}
        {proposable && item.changeId != null ? (
          <button type="button" className={CARD_PRIMARY} disabled={busy} onClick={() => void proposeChange(item.changeId as number)} data-agent-session-preview-propose>
            {action === 'propose' ? 'Proposing…' : 'Propose to group'}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** A spec the scout drafted: the dev chat's spec card, opening the viewer over the conversation. */
export function SpecCard({ item }: { item: Extract<TranscriptItem, { kind: 'spec' }> }) {
  const snippet = useMemo(() => (item.preview ? markdown(item.preview, false) : null), [item.preview]);
  const open = () => { if (item.changeId) void openSpec(item.changeId, item.version); };
  const title = `Spec${item.version ? ` v${item.version}` : ''}${item.lines ? ` · ${item.lines} lines` : ''}`;
  return (
    <div
      className="dc-spec-preview-card"
      data-agent-session-spec={item.version ?? 'latest'}
      role="button"
      tabIndex={0}
      aria-label={`Open ${title}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
    >
      <div className="dc-spec-preview-header">
        <span className="dc-spec-preview-title">{title}</span>
        <span className="dc-spec-preview-cta">View full spec →</span>
      </div>
      {snippet
        ? <div className="dc-spec-preview-snippet" dangerouslySetInnerHTML={{ __html: snippet }} />
        : item.preview ? <div className="dc-spec-preview-snippet">{item.preview}</div> : null}
    </div>
  );
}

/**
 * A change's spec, read-only, any saved version. The change page's own
 * viewer keeps sharing and mentions; this is for reading what the scout wrote
 * without leaving the conversation.
 *
 * ONE VIEW, TWO FRAMES (./spec-layout.ts): beside the conversation from
 * 1024px up, with a divider that drags; a sheet over it below that. Both show
 * the same header and body, so the frame is the only thing the window width
 * decides.
 */
function SpecMarkdown({ text, tagged = false }: { text: string; tagged?: boolean }) {
  const html = useMemo(() => markdown(text, false), [text]);
  const tag = tagged ? { 'data-agent-session-spec-text': '' } : {};
  return html
    ? <div className="dc-msg-content text-[15px] leading-relaxed text-zinc-900 dark:text-zinc-100" {...tag} dangerouslySetInnerHTML={{ __html: html }} />
    : <pre className="whitespace-pre-wrap text-sm text-zinc-900 dark:text-zinc-100" {...tag}>{text}</pre>;
}

function SpecTabButton({ tab, active, label, onTab }: {
  tab: SpecTab;
  active: SpecTab;
  label: string;
  onTab: (tab: SpecTab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active === tab}
      className={active === tab ? 'dc-spec-viewer-tab dc-spec-viewer-tab-active' : 'dc-spec-viewer-tab'}
      data-spec-tab={tab}
      onClick={() => onTab(tab)}
    >
      {label}
    </button>
  );
}

/**
 * The spec's text: the dev chat viewer's two tabs when it has both halves —
 * the title and summary above them, the plain-language half first — and the
 * whole document otherwise. Same classes as that viewer, so the two read alike.
 */
export function SpecBody({ text, tab, split, onTab }: {
  text: string;
  tab: SpecTab;
  split: SpecSplit | null;
  onTab: (tab: SpecTab) => void;
}) {
  if (!split) return <SpecMarkdown text={text} tagged />;
  const half = tab === 'tech' ? split.technical : split.userFacing;
  return (
    <>
      {split.preamble ? <div className="dc-spec-viewer-preamble"><SpecMarkdown text={split.preamble} /></div> : null}
      <div className="dc-spec-viewer-tabs" role="tablist" aria-label="Spec sections">
        <SpecTabButton tab="user" active={tab} label="User-facing" onTab={onTab} />
        <SpecTabButton tab="tech" active={tab} label="Technical" onTab={onTab} />
      </div>
      <div role="tabpanel" data-agent-session-spec-half={tab}>
        {half ? <SpecMarkdown text={half} tagged /> : <p className="dc-spec-tab-empty">Nothing in this section.</p>}
      </div>
    </>
  );
}

function SpecContent({ sheet }: { sheet: SpecSheetState }) {
  const snapshot = useAgentSessionState();
  const split = useMemo(() => (sheet.text ? splitSpec(sheet.text) : null), [sheet.text]);
  const change = [snapshot.session?.activeChange, ...(snapshot.session?.changes || [])]
    .find((c) => c && c.id === sheet.changeId) || null;
  return (
    <>
      <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">Spec</h2>
          {change ? <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{change.title || changeRef(change)}{change.appName ? ` · ${change.appName}` : ''}</p> : null}
        </div>
        {sheet.versions.length > 1 ? (
          <span className="dc-venue-detail-inline">
            <select
              className="dc-model-select rounded text-[13px] text-zinc-900 focus:outline-none focus:ring-2 focus:ring-violet-500 dark:text-zinc-100"
              aria-label="Spec version"
              value={sheet.version ?? ''}
              onChange={(event) => void openSpec(sheet.changeId, Number(event.currentTarget.value))}
            >
              {sheet.versions.map((v) => <option key={v} value={v}>{`v${v}`}</option>)}
            </select>
            <ChevronDownIcon className="dc-model-caret" width={14} height={14} aria-hidden="true" />
          </span>
        ) : sheet.version ? <span className="text-xs font-semibold text-zinc-500">{`v${sheet.version}`}</span> : null}
        <button type="button" className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Close" onClick={closeSpec}>
          <XIcon className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {sheet.phase === 'loading' ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500"><SpinnerArcIcon className="h-5 w-5 animate-spin" aria-hidden="true" /> Loading…</div>
        ) : null}
        {sheet.phase === 'error' ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{sheet.error}</p> : null}
        {sheet.phase === 'ready' && !sheet.text ? <p className="text-sm text-zinc-500 dark:text-zinc-400">This change has no spec yet.</p> : null}
        {sheet.phase === 'ready' && sheet.text ? <SpecBody text={sheet.text} tab={sheet.tab} split={split} onTab={setSpecTab} /> : null}
      </div>
    </>
  );
}

/** Below 1024px, and in the side panel: the spec over the conversation, as a sheet. */
function SpecSheet({ sheet }: { sheet: SpecSheetState }) {
  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-zinc-950/30"
      data-agent-session-spec-sheet={sheet.changeId}
      onClick={(event) => { if (event.target === event.currentTarget) closeSpec(); }}
    >
      <section
        role="dialog"
        aria-label="Spec"
        className="platform-safe-bar mt-auto flex max-h-[92%] w-full flex-col rounded-t-3xl bg-white shadow-xl dark:bg-zinc-900 sm:mt-0 sm:h-full sm:max-h-none sm:rounded-none"
      >
        <SpecContent sheet={sheet} />
      </section>
    </div>
  );
}

/** Spec | Preview, when the side pane holds both. */
function PaneTabs({ tab }: { tab: PaneTab }) {
  const button = (key: PaneTab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === key}
      data-agent-session-pane-tab={key}
      className={tab === key
        ? 'border-b-2 border-violet-600 px-3 py-2 text-sm font-semibold text-zinc-900 dark:border-violet-400 dark:text-zinc-100'
        : 'border-b-2 border-transparent px-3 py-2 text-sm font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'}
      onClick={() => setPaneTab(key)}
    >
      {label}
    </button>
  );
  return (
    <div role="tablist" aria-label="Side pane" className="flex shrink-0 gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
      {button('spec', 'Spec')}
      {button('preview', 'Preview')}
    </div>
  );
}

/**
 * From 1024px up: the side pane beside the conversation, behind a divider
 * that drags (and moves with the arrow keys). It holds the spec, a change's
 * staging preview, or both as tabs.
 *
 * THE WIDTH is the dev chat viewer's remembered one, clamped so the chat keeps
 * 320px beside the 4px divider; `max-w` holds the same ceiling when the window
 * narrows after the drag. A preview renders a real app's screen, so while one
 * is open the floor is the dev chat staging panel's 320px, not the spec's 280.
 *
 * THE PREVIEW is the platform's own (AppView.ensureStaging): its fixed
 * overlay is pinned over this pane's slot, the way it is pinned beside the
 * dev chat, so sign-in, Full screen and the dev console are the same ones. The
 * slot stays mounted while the Spec tab shows (hidden, so the overlay shrinks
 * to nothing and the preview keeps its state).
 */
function SidePane({ sheet, preview, tab, containerRef }: {
  sheet: SpecSheetState | null;
  preview: PreviewPaneState | null;
  tab: PaneTab;
  containerRef: { current: HTMLDivElement | null };
}) {
  const floor = preview ? PREVIEW_MIN_WIDTH : SPEC_MIN_WIDTH;
  const [width, setWidth] = useState(SPEC_DEFAULT_WIDTH);
  const paneRef = useRef<HTMLElement | null>(null);
  const containerWidth = () => containerRef.current?.getBoundingClientRect().width ?? null;
  useEffect(() => { setWidth(clampSpecWidth(readSpecWidth(), containerWidth(), floor)); }, [floor]);
  const showing: PaneTab = sheet && preview ? tab : (preview ? 'preview' : 'spec');

  // The platform's preview opens over the slot once the slot is on screen,
  // and again only for another preview.
  const previewKey = preview ? `${preview.changeId}:${preview.url}` : null;
  useEffect(() => {
    if (preview) dockPreview(preview);
  }, [previewKey]);
  // The overlay follows the slot's size on its own; a move without a resize
  // (the tab strip appearing, the list stepping aside) needs a nudge.
  useEffect(() => {
    if (preview) window.AppView?._syncStagingDockGeometry?.();
  }, [width, showing, !!sheet, previewKey]);

  const commit = (next: number) => {
    const clamped = clampSpecWidth(next, containerWidth(), floor);
    setWidth(clamped);
    return clamped;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = paneRef.current?.getBoundingClientRect().width ?? width;
    let latest = startWidth;
    event.preventDefault();
    try { handle.setPointerCapture(event.pointerId); } catch { /* moves still arrive on the handle */ }
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    // An iframe swallows pointer moves: the preview's, while the drag runs.
    const frame = document.getElementById('staging-iframe');
    if (frame) frame.style.pointerEvents = 'none';
    // Dragging right narrows the pane: its left edge is the divider.
    const onMove = (move: PointerEvent) => { latest = commit(startWidth - (move.clientX - startX)); };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      try { handle.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (frame) frame.style.pointerEvents = '';
      writeSpecWidth(latest);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    writeSpecWidth(commit(width + (event.key === 'ArrowLeft' ? SPEC_WIDTH_STEP : -SPEC_WIDTH_STEP)));
  };

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={showing === 'preview' ? 'Resize the preview' : 'Resize the spec'}
        aria-valuenow={width}
        aria-valuemin={floor}
        tabIndex={0}
        className="w-1 shrink-0 cursor-col-resize touch-none bg-zinc-200 transition-colors hover:bg-violet-500 focus-visible:bg-violet-500 focus-visible:outline-none dark:bg-zinc-800"
        data-agent-session-spec-resizer
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
      <aside
        ref={paneRef}
        aria-label={showing === 'preview' ? 'Preview' : 'Spec'}
        className={`flex min-h-0 ${preview ? 'min-w-[320px]' : 'min-w-[280px]'} max-w-[calc(100%-324px)] shrink-0 flex-col bg-white dark:bg-zinc-900`}
        style={{ width }}
        data-agent-session-side-pane={showing}
      >
        {sheet && preview ? <PaneTabs tab={showing} /> : null}
        {sheet && showing === 'spec' ? (
          <div
            className="flex min-h-0 flex-1 flex-col"
            data-agent-session-spec-sheet={sheet.changeId}
            data-agent-session-spec-beside=""
          >
            <SpecContent sheet={sheet} />
          </div>
        ) : null}
        {preview ? (
          <div
            id={PREVIEW_SLOT_ID}
            className={showing === 'preview' ? 'min-h-0 flex-1' : 'hidden'}
            data-agent-session-preview-slot={preview.changeId}
          />
        ) : null}
      </aside>
    </>
  );
}

/**
 * The Mayor at work, as a conversation shows someone typing (#2779
 * follow-up): its name and three dots where its reply will appear, and what
 * it is doing beside them when that is known ("Reading the app", "Wrapping
 * up", the coding agent's progress with its clock). Once it has said
 * something the dots follow the words. Not a box across the pane: the old
 * full-width bubble read as a message of its own.
 */
function TypingDots() {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1" aria-hidden="true" data-agent-session-typing>
      <span className="agent-session-typing-dot block h-1.5 w-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500" />
      <span className="agent-session-typing-dot block h-1.5 w-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500" />
      <span className="agent-session-typing-dot block h-1.5 w-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500" />
    </span>
  );
}

function LiveTurn({ runShown }: { runShown: boolean }) {
  const snapshot = useAgentSessionState();
  const turn = snapshot.turn;
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!turn.running) return undefined;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [turn.running]);
  if (!turn.running && !turn.pendingUserText) return null;
  const actions = new Map(snapshot.actions.map((action) => [action.id, action]));
  const seconds = turn.startedAt ? Math.max(0, Math.round((clock - turn.startedAt) / 1000)) : 0;
  // A running build draws its own card with the progress and the clock.
  const working = turn.running && !(runShown && turn.phase === 'cc');
  const said = !!(turn.streamText || turn.cards.length);
  const status = turn.stopping
    ? 'Stopping…'
    : turn.phase === 'cc'
      ? (turn.progress || turn.activity || 'The coding agent is working')
      : (turn.activity || (turn.phase === 'mayor2' ? 'Wrapping up' : ''));
  return (
    <>
      {turn.pendingUserText ? (
        <div className="flex justify-end opacity-80">
          <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-100 px-4 py-2.5 text-[15px] text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">{turn.pendingUserText}</p>
        </div>
      ) : null}
      {said || working ? (
        <article data-agent-session-live>
          <p className="mb-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">Mayor</p>
          {turn.streamText ? <MayorText text={turn.streamText} /> : null}
          {turn.cards.map((card) => <Card key={card.id} card={cardView(card, actions)} live />)}
          {working ? (
            <div
              className={`flex min-w-0 items-center gap-2 text-[13px] text-zinc-500 dark:text-zinc-400 ${said ? 'mt-2' : ''}`}
              data-agent-session-activity={turn.phase || 'mayor'}
              aria-live="polite"
            >
              <TypingDots />
              {status ? <span className="min-w-0 truncate">{status}</span> : <span className="sr-only">The Mayor is thinking</span>}
              {turn.phase === 'cc' ? <span className="shrink-0 tabular-nums text-xs">{Math.floor(seconds / 60)}m {seconds % 60}s</span> : null}
            </div>
          ) : null}
        </article>
      ) : null}
    </>
  );
}

function EmptyState({ about }: { about: About }) {
  const app = about?.focusApp?.name || null;
  return (
    <section className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center" data-agent-session-empty>
      <span className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
        <SparklesIcon className="h-6 w-6" aria-hidden="true" />
      </span>
      <h3 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">New agent session</h3>
      <p className="mt-1 max-w-sm text-sm text-zinc-600 dark:text-zinc-300">
        {app ? <>Started from <strong>{app}</strong>. </> : null}
        Ask for a change on any app. The Mayor plans it, builds it, and puts it up for a vote when you say so.
      </p>
    </section>
  );
}

// The first things to say, from where the conversation was opened: a
// request or a proposal the user was looking at comes first.
function starters(about: About) {
  const app = about?.focusApp?.name || null;
  const context = (about?.focusContext || {}) as { issueNumber?: number; proposalId?: number };
  const first = context.issueNumber
    ? [`Work on request #${context.issueNumber}`]
    : context.proposalId
      ? ['Tell me about this proposal']
      : [];
  return [
    ...first,
    app ? `What's open on ${app}?` : 'What could I work on?',
    'Add a feature',
    'Fix a bug',
  ].slice(0, 3);
}

function Replies({ replies }: { replies: string[] }) {
  const snapshot = useAgentSessionState();
  if (!replies.length || snapshot.turn.running) return null;
  return (
    <div className="flex gap-2 overflow-x-auto px-4 pb-2" data-agent-session-replies>
      {replies.map((reply) => (
        <button
          key={reply}
          type="button"
          className="shrink-0 rounded-full border border-violet-200 bg-white px-3 py-1.5 text-sm text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950/40"
          onClick={() => void sendAgentMessage(reply)}
        >
          {reply}
        </button>
      ))}
    </div>
  );
}

/**
 * A picker control that reads "Label: Item" while closed and lists the items
 * with "(default)" after the default one while open. A native select shows
 * the chosen option's own text when closed, so that text is drawn beside it
 * instead: the select lies transparent over the shown line and keeps the
 * focus, the keyboard and the platform's own list. The shown line is the dev
 * chat picker's (`dc-model-select`).
 *
 * A model's cost rides along as the dev chat's does (#2570): its note and
 * "about $X for a typical change" after its name in the open list (the
 * chosen one's cost is drawn beside the control by ModelPicker).
 */
export function LabeledSelect({ label, ariaLabel, value, options, disabled, muted = false, onChange, dataKey }: {
  label: string;
  ariaLabel: string;
  value: string;
  options: PickerOption[];
  disabled: boolean;
  muted?: boolean;
  onChange: (value: string) => void;
  dataKey: string;
}) {
  const selected = options.find((option) => option.value === value) || null;
  const tone = muted ? 'text-zinc-600 dark:text-zinc-300' : 'text-zinc-900 dark:text-zinc-100';
  return (
    <span className="dc-venue-detail-inline rounded focus-within:ring-2 focus-within:ring-violet-500" data-agent-session-picker={dataKey}>
      <span className={`dc-model-select text-[13px] ${tone}`} aria-hidden="true" data-agent-session-picker-shown>
        {`${label}: ${selected ? selected.label : ''}`}
      </span>
      <ChevronDownIcon className="dc-model-caret" width={14} height={14} aria-hidden="true" />
      <select
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} title={option.title || undefined}>
            {`${option.label}${option.detail ? ` · ${option.detail}` : ''}${option.isDefault ? ' (default)' : ''}`}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * The conversation's model (./model-choice.ts): Claude Code on an Anthropic
 * model, or Codex on an OpenRouter model with its thinking level where the
 * model offers one. Usable at any time: what is running finishes on the model
 * it started with, and the next message runs on the new one.
 */
function ModelPicker() {
  const snapshot = useAgentSessionState();
  useEffect(() => { void loadModelCatalog(); }, []);
  const catalog = snapshot.catalog;
  const explicit = snapshot.session ? (snapshot.session.agent || null) : (snapshot.draft?.agent || null);
  const current = effectiveChoice(explicit, catalog);
  const options = pickerOptions(catalog, current);
  if (!options.length || !current) return null;
  const archived = snapshot.session?.status === 'archived';
  const disabled = archived || snapshot.choosing || snapshot.phase === 'loading';
  const reasoning = offersReasoning(current, catalog);
  const value = choiceValue(current);
  const cost = options.find((option) => option.value === value)?.cost || '';
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-1" data-agent-session-model>
      <span className="inline-flex min-w-0 items-baseline gap-1">
        <LabeledSelect
          label="Model"
          ariaLabel="Model"
          dataKey="model"
          value={value}
          options={options}
          disabled={disabled}
          onChange={(picked) => {
            const next = choiceFromValue(picked, catalog, current);
            if (next) void chooseAgent(next);
          }}
        />
        {cost ? (
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400" data-agent-session-model-cost>{cost}</span>
        ) : null}
      </span>
      {reasoning ? (
        <LabeledSelect
          label="Thinking Level"
          ariaLabel="Thinking level"
          dataKey="thinking"
          muted
          value={effortValue(current, catalog)}
          options={effortOptions(catalog)}
          disabled={disabled}
          onChange={(value) => void chooseAgent({ ...current, reasoningEffort: value || null })}
        />
      ) : null}
    </div>
  );
}

const BUSY_PLACEHOLDER = 'The Mayor is working. Type your next message and save it for later.';
const SAVE_TITLE = 'Save this as a draft (Enter). It stays here until you send it';

/**
 * The saved drafts above the composer (the dev chat's #798 list, per account):
 * each can be sent once the Mayor is free, put back in the box to reword, or
 * deleted. Sending is always a tap here, never automatic.
 */
export function SavedDrafts({ drafts, busy, onSend, onEdit }: {
  drafts: SavedDraft[];
  busy: boolean;
  onSend: (draft: SavedDraft) => void;
  onEdit: (draft: SavedDraft) => void;
}) {
  if (!drafts.length) return null;
  const button = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors '
    + 'hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent '
    + 'dark:text-zinc-400 dark:hover:bg-zinc-800';
  return (
    <section
      aria-label="Saved drafts"
      className="mb-2 max-h-40 overflow-y-auto rounded-2xl bg-zinc-100 p-1.5 dark:bg-zinc-800/70"
      data-agent-session-drafts={drafts.length}
    >
      <p className="flex flex-wrap items-baseline gap-x-1.5 px-2 pb-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className="font-semibold uppercase tracking-wide">{`Saved drafts (${drafts.length})`}</span>
        <span>· on all your devices</span>
        {busy ? <span className="ml-auto">sending unlocks when the Mayor finishes</span> : null}
      </p>
      <ul className="flex flex-col gap-1">
        {drafts.map((draft) => (
          <li
            key={draft.id}
            className="flex items-center gap-0.5 rounded-xl bg-white py-0.5 pl-3 pr-0.5 dark:bg-zinc-900"
            data-agent-session-draft={draft.id}
          >
            <span className="min-w-0 flex-1 truncate text-sm text-zinc-700 dark:text-zinc-200" title={draft.text}>{draft.text}</span>
            <button
              type="button"
              className={`${button} hover:text-emerald-700 dark:hover:text-emerald-400`}
              aria-label="Send this draft"
              title={busy ? 'The Mayor is still working. You can send this when it finishes' : 'Send this draft now'}
              disabled={busy}
              data-agent-session-draft-send
              onClick={() => onSend(draft)}
            >
              <DraftSendIcon width={16} height={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${button} hover:text-violet-700 dark:hover:text-violet-300`}
              aria-label="Edit this draft"
              title="Put this draft back in the box to edit"
              data-agent-session-draft-edit
              onClick={() => onEdit(draft)}
            >
              <DraftEditIcon width={16} height={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${button} hover:text-red-700 dark:hover:text-red-300`}
              aria-label="Delete this draft"
              title="Delete this draft"
              data-agent-session-draft-delete
              onClick={() => deleteSavedDraft(draft.id)}
            >
              <DraftTrashIcon width={16} height={16} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The message box. Its ONE button follows the dev chat's (#798, #810):
 * Send while the Mayor is free; while it works, Stop with nothing typed and
 * a green Save with something typed, which parks the text as a saved draft
 * (Enter does the same) so nothing typed mid-turn can leak into the running
 * turn. What is typed and not sent is kept for the conversation (./unsent.ts).
 *
 * THE OUTLINE IS THE CARD'S, as on Messages' composer (#1954, #2882, #2387):
 * `.agent-session-composer:focus-within` rings the whole card, and the field
 * inside draws no edge of its own in any engine (public/css/app.css).
 */
function Composer({ id }: { id: string }) {
  const snapshot = useAgentSessionState();
  const [value, setValue] = useState('');
  const input = useRef<HTMLTextAreaElement | null>(null);
  const running = snapshot.turn.running;
  const archived = snapshot.session?.status === 'archived';
  const returned = snapshot.returnedText;
  const target = snapshot.id ?? (snapshot.draft ? 'new' : null);
  // Save needs something typed, and a turn not already stopping: Stop hands
  // the message back to the box, and the button must stay Stop under the
  // same click rather than become a Save that the click then submits.
  const saving = running && !snapshot.turn.stopping && !!value.trim();

  const update = (next: string) => {
    setValue(next);
    if (target != null) writeUnsent(target, next);
  };

  // The conversation's unsent text, back after a reload or a switch.
  useEffect(() => {
    if (target != null) setValue(readUnsent(target));
  }, [target]);

  // A message the server refused, or a Stop, hands its text back, unless
  // something new has been typed since.
  useEffect(() => {
    if (returned == null) return;
    if (!value.trim()) update(returned);
    clearReturnedText();
  }, [returned]);

  // The field grows with what it holds, typed or put back.
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 144)}px`;
  }, [value]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = value.trim();
    if (!text) return;
    if (running) {
      if (saveComposerDraft(text)) update('');
      return;
    }
    update('');
    void sendAgentMessage(text);
  }

  const onSendDraft = (draft: SavedDraft) => {
    if (running) return;
    const typed = value;
    update('');
    void sendSavedDraft(draft.id, typed);
  };
  const onEditDraft = (draft: SavedDraft) => {
    const text = editSavedDraft(draft.id, value);
    if (text == null) return;
    update(text);
    input.current?.focus();
  };

  const kind = saving ? 'save' : running ? 'stop' : 'send';
  return (
    // `platform-safe-bar` on the outer box: its padding clears the tab bar
    // (a phone keeps it up on this screen) and the home-indicator strip, so
    // the bordered field above it never sits under either.
    <div className="platform-safe-bar shrink-0 px-3 pt-1">
    <SavedDrafts drafts={snapshot.drafts} busy={running} onSend={onSendDraft} onEdit={onEditDraft} />
    <form
      className="agent-session-composer flex flex-col gap-1 rounded-2xl border border-zinc-200 bg-white p-2 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
      onSubmit={submit}
    >
      <textarea
        ref={input}
        id={id}
        rows={1}
        maxLength={20_000}
        value={value}
        disabled={archived || snapshot.phase === 'loading'}
        placeholder={archived
          ? 'This session is archived.'
          : running ? BUSY_PLACEHOLDER : 'Describe a change to any app in plain English. No coding needed.'}
        aria-label="Message the Mayor"
        className="agent-session-composer-input max-h-36 min-h-[2.5rem] w-full resize-none bg-transparent px-2 py-2 text-[15px] text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
        onChange={(event) => update(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1"><ModelPicker /></div>
      {kind === 'save' ? (
        <Button
          key="save"
          type="submit"
          data-agent-session-send="save"
          variant="unstyled"
          size="icon"
          ink="solid"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-600 hover:bg-emerald-700"
          aria-label="Save as draft"
          title={SAVE_TITLE}
        >
          <SaveDraftIcon width={20} height={20} aria-hidden="true" />
        </Button>
      ) : (
        <Button
          key="send"
          type={running ? 'button' : 'submit'}
          data-agent-session-send={kind}
          variant={running ? 'pillDanger' : 'pillAccent'}
          disabledStyle="dim"
          size="icon"
          ink={running ? 'dangerTint' : 'solid'}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center"
          disabled={running ? (snapshot.turn.stopping || snapshot.turn.phase === 'mayor2') : !value.trim()}
          aria-label={running ? 'Stop' : 'Send'}
          title={running ? (snapshot.turn.phase === 'mayor2' ? 'The wrap-up cannot be stopped' : 'Stop') : 'Send'}
          onClick={running ? () => void stopAgentTurn() : undefined}
        >
          {running ? <span className="h-3.5 w-3.5 rounded-sm bg-current" aria-hidden="true" /> : <ArrowUpIcon className="h-5 w-5" aria-hidden="true" />}
        </Button>
      )}
      </div>
    </form>
    </div>
  );
}

// ── The changes drawer ─────────────────────────────────────────────────

function ChangesDrawer({ session }: { session: AgentSession }) {
  const active = session.activeChange;
  const others = (session.changes || []).filter((change) => !active || change.id !== active.id);
  const closed = new Set(['merged', 'archived']);
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col justify-end bg-zinc-950/30 sm:items-end sm:justify-stretch"
      data-agent-session-drawer
      onClick={(event) => { if (event.target === event.currentTarget) setDrawerOpen(false); }}
    >
      <section
        role="dialog"
        aria-label="Changes in this session"
        className="platform-safe-bar max-h-[85%] w-full overflow-y-auto rounded-t-3xl bg-white p-4 shadow-xl dark:bg-zinc-900 sm:h-full sm:max-h-none sm:max-w-sm sm:rounded-none"
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Changes in this session</h2>
          <button type="button" className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Close" onClick={() => setDrawerOpen(false)}>
            <XIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Active</h3>
        {active ? (
          <div className="rounded-2xl bg-zinc-50 p-3 dark:bg-zinc-800/60" data-agent-session-active-change>
            <div className="flex items-start gap-2">
              <AppMark name={active.appName} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-zinc-900 dark:text-zinc-100">{active.title || changeRef(active)}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{active.appName || active.appSlug} · {changeRef(active)}{active.prNumber ? ` (change ${active.id})` : ''}</p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${statusTone(active.status)}`}>{changeStatusLabel(active.status)}</span>
            </div>
            {active.checkState ? <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">Checks: {active.checkState}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {active.stagingUrl ? (
                <a className="rounded-full bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500" href={active.stagingUrl} target="_blank" rel="noopener noreferrer">Open preview</a>
              ) : null}
              <button
                type="button"
                data-agent-session-open-spec
                className="rounded-full bg-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-100"
                onClick={() => void openSpec(active.id)}
              >
                Spec
              </button>
              {active.appSlug ? (
                <a
                  className="rounded-full bg-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-100"
                  href={`#app/${encodeURIComponent(active.appSlug)}/dev/proposals/${active.id}`}
                >
                  Proposal page
                </a>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No active change. Ask the Mayor to start one.</p>
        )}
        {others.length ? (
          <>
            <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Earlier in this session</h3>
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {others.map((change) => (
                <li key={change.id} className="flex items-center gap-2 py-2" data-agent-session-earlier-change={change.id}>
                  <AppMark name={change.appName} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{change.title || changeRef(change)}</p>
                    <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{change.appName || change.appSlug} · {changeRef(change)}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${statusTone(change.status)}`}>{changeStatusLabel(change.status)}</span>
                  {!closed.has(change.status || '') ? (
                    <button type="button" className="shrink-0 text-sm font-semibold text-violet-700 hover:underline dark:text-violet-300" onClick={() => void switchActiveChange(change.id)}>
                      Switch to
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </div>
  );
}

// ── The panel and the screen ───────────────────────────────────────────

/**
 * `headerAction` is a surface's addition to the session bar, drawn at its
 * end: the Messages pane passes its full-width toggle, which every
 * discussion pane carries in that place.
 */
export function AgentSessionPanel({ embedded = false, headerAction = null }: { embedded?: boolean; headerAction?: ReactNode }) {
  const snapshot = useAgentSessionState();
  const scroll = useRef<HTMLDivElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  // The side pane beside the chat (the spec, a preview, or both), or the
  // spec over it (./spec-layout.ts). False until mounted, so the first
  // render is the one the prerender printed.
  const beside = useSidePaneBeside(embedded ? 'messages' : 'screen');
  const liveRun = snapshot.turn.running && snapshot.turn.phase === 'cc';
  const items = useMemo(
    () => buildTranscript(snapshot.messages, snapshot.actions, Date.now(), { liveRun }),
    [snapshot.messages, snapshot.actions, liveRun],
  );
  const runShown = items.some((item) => item.kind === 'run' && item.status === 'running');

  // The run card's clock is the dev chat's (`nowStore`), whose heartbeat only
  // beats inside the dev chat's own transcript; beat it here while a run is
  // on screen.
  useEffect(() => {
    if (!runShown) return undefined;
    const beat = () => nowStore.set({ now: Date.now() });
    beat();
    const timer = window.setInterval(beat, 1000);
    return () => window.clearInterval(timer);
  }, [runShown]);
  const replies = latestReplies(items);
  const empty = snapshot.phase === 'ready' && !items.length && !snapshot.turn.running && !snapshot.turn.pendingUserText;
  const about: About = snapshot.session || snapshot.draft;

  // Follow new output only while the reader is at the bottom (the dev chat's
  // rule): scrolling up to read is not undone by the next token. Opening a
  // conversation, or sending in it, goes back to the bottom.
  const stick = useRef(true);
  const onScroll = () => {
    const el = scroll.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => { stick.current = true; }, [snapshot.id]);
  useEffect(() => { if (snapshot.turn.pendingUserText) stick.current = true; }, [snapshot.turn.pendingUserText]);
  useEffect(() => {
    if (!scroll.current || !stick.current) return;
    scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snapshot.id, items.length, snapshot.turn.streamText, snapshot.turn.running, snapshot.turn.cards.length, snapshot.turn.pendingUserText]);
  // The transcript shrinks when something grows under it (the saved drafts,
  // a taller message box): a reader at the bottom stays there.
  useEffect(() => {
    const el = scroll.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={root} className={`relative flex min-h-0 flex-1 ${embedded ? '' : 'dc-lift dc-lift-strip'}`} data-agent-session-panel={embedded ? 'messages' : 'screen'}>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-agent-session-chat>
        <SessionBar session={snapshot.session} about={about} embedded={embedded} action={headerAction} />
        <div ref={scroll} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4" aria-live="polite" onScroll={onScroll}>
          {snapshot.phase === 'loading' ? (
            <div className="flex items-center gap-2 text-sm text-zinc-500"><SpinnerArcIcon className="h-5 w-5 animate-spin" aria-hidden="true" /> Loading…</div>
          ) : null}
          {empty ? <EmptyState about={about} /> : null}
          {items.map((item) => <Item key={item.key} item={item} />)}
          <LiveTurn runShown={runShown} />
          {snapshot.error ? (
            <p role="alert" className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{snapshot.error}</p>
          ) : null}
        </div>
        <Replies replies={empty ? starters(about) : replies} />
        <Composer id={composerId(embedded ? 'messages' : 'screen')} />
        {snapshot.drawerOpen && snapshot.session ? <ChangesDrawer session={snapshot.session} /> : null}
      </div>
      {beside ? (
        <SidePane sheet={snapshot.specSheet} preview={snapshot.preview} tab={snapshot.paneTab} containerRef={root} />
      ) : snapshot.specSheet ? <SpecSheet sheet={snapshot.specSheet} /> : null}
    </div>
  );
}

export function AgentSessionScreen() {
  const snapshot = useAgentSessionState();
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'agent-session-screen', false);

  // A cold deep link can reveal this island before app.js has routed it;
  // resolve the address once after hydration, the way Global Chat does.
  useEffect(() => {
    if (snapshot.open || !window.location.hash.startsWith('#agent/')) return;
    const [segment, section] = window.location.hash.slice('#agent/'.length).split('/');
    if (segment === 'new') {
      void openAgentSession({ id: 'new', host: 'screen' });
      return;
    }
    const id = Number(segment);
    if (Number.isSafeInteger(id) && id > 0) void openAgentSession({ id, host: 'screen', drawer: section === 'changes' });
  }, [snapshot.open]);

  return (
    <main
      ref={screenRef}
      id="agent-session-screen"
      className="hidden flex flex-1 min-h-0 overflow-hidden"
      aria-label="Agent session"
    >
      {snapshot.open && snapshot.host === 'screen' ? <AgentSessionPanel /> : null}
    </main>
  );
}

export { useAgentSessionState } from './store';
