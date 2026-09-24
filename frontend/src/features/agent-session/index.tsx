import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  SparklesIcon,
  SpinnerArcIcon,
  XIcon,
} from '@/components/ui/icons';

import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { Attached } from '../dev-chat/transcript';
import { nowStore, type TranscriptRow } from '../dev-chat/transcript-store';
import type { AgentChange, AgentSession } from './api';
import {
  choiceFromValue,
  choiceValue,
  effectiveChoice,
  effortOptions,
  offersReasoning,
  pickerOptions,
} from './model-choice';
import {
  buildTranscript,
  cardView,
  changeStatusLabel,
  durationLabel,
  latestReplies,
  runHeading,
  type CardView,
  type RunItem,
  type TranscriptItem,
} from './transcript';
import {
  chooseAgent,
  clearReturnedText,
  closeSpec,
  composerId,
  decideCard,
  loadModelCatalog,
  openAgentSession,
  openSpec,
  sendAgentMessage,
  setDrawerOpen,
  stopAgentTurn,
  switchActiveChange,
  useAgentSessionState,
} from './store';

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
  const render = window.DevChat?.renderMarkdown;
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
    case 'paused': return 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';
    case 'active': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200';
    default: return 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';
  }
}

function changeRef(change: AgentChange) {
  return change.prNumber ? `PR #${change.prNumber}` : `Change ${change.id}`;
}

// ── Header ─────────────────────────────────────────────────────────────

/** What the conversation is about: the session's, or the unsent draft's. */
type About = Pick<AgentSession, 'focusApp' | 'focusContext'> | null;

function SessionBar({ session, about, embedded }: { session: AgentSession | null; about: About; embedded: boolean }) {
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
          <p className="mb-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">Mayor</p>
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
      return (
        <section className="rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900" data-agent-session-preview>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{item.text}</p>
          <a
            className="mt-2 inline-flex rounded-full border border-violet-300 px-3 py-1 text-sm font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/40"
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open preview{item.prNumber ? ` · PR #${item.prNumber}` : ''}
          </a>
        </section>
      );
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
 * A change's spec over the conversation, read-only, any saved version. The
 * change page's own viewer keeps sharing and mentions; this is for reading
 * what the scout wrote without leaving the conversation.
 */
function SpecSheet() {
  const snapshot = useAgentSessionState();
  const sheet = snapshot.specSheet;
  const html = useMemo(() => (sheet && sheet.text ? markdown(sheet.text, false) : null), [sheet?.text]);
  if (!sheet) return null;
  const change = [snapshot.session?.activeChange, ...(snapshot.session?.changes || [])]
    .find((c) => c && c.id === sheet.changeId) || null;
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
          {sheet.phase === 'ready' && sheet.text ? (
            html
              ? <div className="dc-msg-content text-[15px] leading-relaxed text-zinc-900 dark:text-zinc-100" data-agent-session-spec-text dangerouslySetInnerHTML={{ __html: html }} />
              : <pre className="whitespace-pre-wrap text-sm text-zinc-900 dark:text-zinc-100" data-agent-session-spec-text>{sheet.text}</pre>
          ) : null}
        </div>
      </section>
    </div>
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
  return (
    <>
      {turn.pendingUserText ? (
        <div className="flex justify-end opacity-80">
          <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-100 px-4 py-2.5 text-[15px] text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">{turn.pendingUserText}</p>
        </div>
      ) : null}
      {turn.streamText || turn.cards.length ? (
        <article>
          <p className="mb-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">Mayor</p>
          {turn.streamText ? <MayorText text={turn.streamText} /> : null}
          {turn.cards.map((card) => <Card key={card.id} card={cardView(card, actions)} live />)}
        </article>
      ) : null}
      {turn.running && !(runShown && turn.phase === 'cc') ? (
        <div
          className="flex items-center gap-2 rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
          data-agent-session-activity={turn.phase || 'mayor'}
          aria-live="polite"
        >
          <SpinnerArcIcon className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            {turn.stopping ? 'Stopping…' : (turn.phase === 'cc' ? (turn.progress || turn.activity || 'The coding agent is working') : (turn.activity || (turn.phase === 'mayor2' ? 'Wrapping up' : 'Thinking')))}
          </span>
          {turn.phase === 'cc' ? <span className="shrink-0 tabular-nums text-xs text-zinc-500">{Math.floor(seconds / 60)}m {seconds % 60}s</span> : null}
        </div>
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
 * The conversation's model (./model-choice.ts): Claude Code on an Anthropic
 * model, or Codex on an OpenRouter model with its reasoning effort where the
 * model offers one. The dev chat picker's look (`dc-model-select`). Usable at
 * any time: what is running finishes on the model it started with, and the
 * line beside the control says so while a turn runs.
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
  const running = snapshot.turn.running && !!snapshot.session;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-1" data-agent-session-model>
      <span className="dc-venue-detail-inline">
        <select
          className="dc-model-select rounded text-[13px] text-zinc-900 focus:outline-none focus:ring-2 focus:ring-violet-500 dark:text-zinc-100"
          aria-label="Model"
          value={choiceValue(current)}
          disabled={disabled}
          onChange={(event) => {
            const next = choiceFromValue(event.currentTarget.value, catalog, current);
            if (next) void chooseAgent(next);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} title={option.title || undefined}>{option.label}</option>
          ))}
        </select>
        <ChevronDownIcon className="dc-model-caret" width={14} height={14} aria-hidden="true" />
      </span>
      {reasoning ? (
        <span className="dc-venue-detail-inline">
          <select
            className="dc-model-select rounded text-[13px] text-zinc-600 focus:outline-none focus:ring-2 focus:ring-violet-500 dark:text-zinc-300"
            aria-label="Reasoning effort"
            value={current.reasoningEffort || ''}
            disabled={disabled}
            onChange={(event) => void chooseAgent({ ...current, reasoningEffort: event.currentTarget.value || null })}
          >
            {effortOptions(catalog).map((option) => (
              <option key={option.value} value={option.value}>{`Thinking: ${option.label}`}</option>
            ))}
          </select>
          <ChevronDownIcon className="dc-model-caret" width={14} height={14} aria-hidden="true" />
        </span>
      ) : null}
      {running ? (
        <span className="whitespace-nowrap text-[11px] text-zinc-500 dark:text-zinc-400" data-agent-session-model-note>
          applies from your next message
        </span>
      ) : null}
    </div>
  );
}

function Composer({ id }: { id: string }) {
  const snapshot = useAgentSessionState();
  const [value, setValue] = useState('');
  const running = snapshot.turn.running;
  const archived = snapshot.session?.status === 'archived';
  const returned = snapshot.returnedText;

  // A message the server refused comes back here, unless something new has
  // been typed since.
  useEffect(() => {
    if (returned == null) return;
    setValue((current) => current || returned);
    clearReturnedText();
  }, [returned]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = value.trim();
    if (!text || running) return;
    setValue('');
    void sendAgentMessage(text);
  }

  return (
    // `platform-safe-bar` on the outer box: its padding clears the tab bar
    // (a phone keeps it up on this screen) and the home-indicator strip, so
    // the bordered field above it never sits under either.
    <div className="platform-safe-bar shrink-0 px-3 pt-1">
    <form
      className="agent-session-composer flex flex-col gap-1 rounded-2xl border border-zinc-200 bg-white p-2 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
      onSubmit={submit}
    >
      <textarea
        id={id}
        rows={1}
        maxLength={20_000}
        value={value}
        disabled={archived || snapshot.phase === 'loading'}
        placeholder={archived ? 'This session is archived.' : 'Describe a change to any app in plain English. No coding needed.'}
        aria-label="Message the Mayor"
        className="max-h-36 min-h-[2.5rem] w-full resize-none bg-transparent px-2 py-2 text-[15px] text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
        onChange={(event) => {
          setValue(event.target.value);
          event.currentTarget.style.height = 'auto';
          event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 144)}px`;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1"><ModelPicker /></div>
      <Button
        type={running ? 'button' : 'submit'}
        data-agent-session-send={running ? 'stop' : 'send'}
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

export function AgentSessionPanel({ embedded = false }: { embedded?: boolean }) {
  const snapshot = useAgentSessionState();
  const scroll = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    if (!scroll.current) return;
    scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [items.length, snapshot.turn.streamText, snapshot.turn.running, snapshot.turn.cards.length]);

  return (
    <div className={`relative flex min-h-0 flex-1 flex-col ${embedded ? '' : 'dc-lift dc-lift-strip'}`} data-agent-session-panel={embedded ? 'messages' : 'screen'}>
      <SessionBar session={snapshot.session} about={about} embedded={embedded} />
      <div ref={scroll} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4" aria-live="polite">
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
      <SpecSheet />
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
