// Where an agent session's work gets built (#2779 follow-up): here, by the
// Mayor on Homeroom credits, or handed to Claude Code or Codex on the web,
// which build on the person's own plan and push to their fork.
//
// THE PICKER in the session bar is always there, not only when the credits
// run out: "Build: Homeroom". Its two other rows open the walkthrough for
// handing the conversation's change to that agent. The conversation itself
// keeps building here (the Mayor's dispatch has no venue), so the picker
// does not change label; what a hand-off builds comes back as an update to
// the change's proposal, or as a new proposal when there is no change yet.
//
// THE WALKTHROUGH is the dev chat's own (#1049): its steps come from
// public/js/dev-flow-select.js `steps()` over GET
// /api/apps/:slug/dev-flow/status, so the two cannot describe a hand-off
// differently. Only the drawing is React's: link GitHub, fork the app,
// connect Homeroom in the Claude or ChatGPT account the agent runs as, then
// copy the instructions. Every step reads the server's status, so closing
// the dialog mid-way and coming back resumes where it was.
//
// THE CREDITS CARD replaces the raw error line when the platform credits
// refuse a message (429 `budget_exceeded`). Its copy and its rows are
// public/js/credit-options.js's, the one source for the dev chat's card and
// banner: the two web hand-offs first, then your own API key and the rest a
// non-developer can follow.

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';
import { ChevronDownIcon } from '@/components/ui/icons';

import { ChatgptSetupSteps, ClaudeSetupSteps } from '../settings/connector-setup-steps';
import * as api from './api';
import type { AgentChange, AgentSession, HandoffStatus } from './api';
import {
  closeHandoff,
  dismissCredits,
  openHandoff,
  useAgentSessionState,
  type CreditsRefusal,
  type HandoffAgent,
} from './store';

export const AGENT_LABELS: Record<HandoffAgent, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

/** The chat product whose account the agent signs in as, where the connector lives. */
export const AGENT_PRODUCT: Record<HandoffAgent, 'Claude' | 'ChatGPT'> = {
  'claude-code': 'Claude',
  codex: 'ChatGPT',
};

const AGENT_URL: Record<HandoffAgent, string> = {
  'claude-code': 'https://claude.ai/code',
  codex: 'https://chatgpt.com/codex',
};

export interface HandoffTarget {
  slug: string;
  appName: string | null;
  /** The change the hand-off continues, or null for new work on the app. */
  change: { id: number; kind: 'session' | 'proposal'; prNumber: number | null } | null;
}

/**
 * What a hand-off from this conversation works on: its active change while
 * that can still be revised (in progress, or up for a vote), else new work on
 * the change's app or the conversation's app. Null with no app at all, which
 * is the one case there is nothing to hand over yet.
 */
export function handoffTarget(about: {
  activeChange?: AgentChange | null;
  focusApp?: AgentSession['focusApp'] | null;
} | null): HandoffTarget | null {
  const change = about?.activeChange || null;
  if (change && change.appSlug) {
    const kind = change.status === 'active' || change.status === 'paused' ? 'session'
      : change.status === 'promoted' ? 'proposal' : null;
    return {
      slug: change.appSlug,
      appName: change.appName || null,
      change: kind ? { id: change.id, kind, prNumber: change.prNumber || null } : null,
    };
  }
  const focus = about?.focusApp || null;
  if (focus && focus.slug) return { slug: focus.slug, appName: focus.name || null, change: null };
  return null;
}

/** The picker's rows: where this conversation's work can be built. */
export const VENUE_ROWS: Array<{ id: 'homeroom' | HandoffAgent; label: string; title: string }> = [
  {
    id: 'homeroom',
    label: 'Homeroom (here)',
    title: 'The Mayor builds it in this conversation, on your Homeroom credits.',
  },
  {
    id: 'claude-code',
    label: 'Claude Code on the web',
    title: 'Claude Code builds it on your own Claude plan and pushes to your fork. No Homeroom credits.',
  },
  {
    id: 'codex',
    label: 'Codex on the web',
    title: 'Codex builds it on your own ChatGPT plan and pushes to your fork. No Homeroom credits.',
  },
];

/** The session bar's "Build: Homeroom": the kit's menu, anchored to it. */
export function VenuePicker({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      data-agent-session-venue
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
      title="Where this change is built"
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={(event) => {
        const menu = window.PlatformUI?.menu;
        if (open || typeof menu !== 'function') return;
        setOpen(true);
        void menu.call(window.PlatformUI, {
          anchorEl: event.currentTarget,
          title: 'Where should this be built?',
          items: VENUE_ROWS.map((row) => ({
            label: row.label,
            title: row.title,
            handler: () => { if (row.id !== 'homeroom') openHandoff(row.id); },
          })),
        }).finally(() => setOpen(false));
      }}
    >
      <span className="font-normal text-zinc-500 dark:text-zinc-400">Build:</span>
      Homeroom
      <ChevronDownIcon width={12} height={12} aria-hidden="true" />
    </button>
  );
}

// ── The walkthrough ────────────────────────────────────────────────────

interface FlowAction { action: string; label: string; primary?: boolean; href?: string }
interface FlowStep { key: string; title: string; state: 'done' | 'current' | 'todo'; detail: string; actions: FlowAction[] }

interface DevFlowSelectApi {
  steps(status: HandoffStatus, agent: HandoffAgent): FlowStep[];
  unavailableNote(reason: string | null | undefined): string;
}

function devFlowSelect(): DevFlowSelectApi | null {
  const api = typeof window === 'undefined' ? null : (window as unknown as { DevFlowSelect?: DevFlowSelectApi }).DevFlowSelect;
  return api && typeof api.steps === 'function' ? api : null;
}

/** The walkthrough's steps for this status, or [] where the module is absent. */
export function handoffSteps(status: HandoffStatus | null, agent: HandoffAgent): FlowStep[] {
  const flow = devFlowSelect();
  if (!flow || !status || status.available === false) return [];
  try { return flow.steps(status, agent) || []; } catch { return []; }
}

const ACTION = 'inline-flex items-center rounded-full border border-violet-300 px-3 py-1 text-sm font-semibold text-violet-700 '
  + 'hover:bg-violet-50 disabled:opacity-60 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/40';
const ACTION_PRIMARY = 'inline-flex items-center rounded-full bg-violet-600 px-3 py-1 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60';

function lead(agent: HandoffAgent, target: HandoffTarget | null): string {
  const label = AGENT_LABELS[agent];
  const product = AGENT_PRODUCT[agent];
  const lands = target?.change
    ? `its work comes back as an update to ${target.change.prNumber ? `PR #${target.change.prNumber}` : 'this change'}`
    : `its work comes back as a new proposal${target?.appName ? ` on ${target.appName}` : ''}`;
  return `${label} builds on your own ${product} plan and pushes to your fork of the app; ${lands}. No Homeroom credits.`;
}

export function HandoffDialog() {
  const snapshot = useAgentSessionState();
  const agent = snapshot.handoff;
  const about = snapshot.session || snapshot.draft;
  const target = handoffTarget(about ? {
    activeChange: snapshot.session?.activeChange || null,
    focusApp: about.focusApp || null,
  } : null);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [status, setStatus] = useState<HandoffStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connector, setConnector] = useState(false);
  const [revision, setRevision] = useState(0);
  const targetKey = target ? `${target.slug}:${target.change ? `${target.change.kind}:${target.change.id}` : 'new'}` : null;

  useEffect(() => {
    const el = dialog.current;
    if (!el || !agent) return undefined;
    if (!el.open) {
      try { el.showModal(); } catch { el.setAttribute('open', ''); }
    }
    return () => { try { el.close(); } catch { /* already closed */ } };
  }, [!!agent]);

  useEffect(() => {
    if (!agent || !target) return undefined;
    let live = true;
    setError('');
    void api.handoffStatus(target.slug, target.change ? { id: target.change.id, kind: target.change.kind } : null)
      .then((next) => { if (live) setStatus(next); })
      .catch((failure) => { if (live) setError(failure instanceof Error ? failure.message : 'Could not check where the hand-off stands.'); });
    return () => { live = false; };
  }, [agent, targetKey, revision]);

  if (!agent) return null;
  const label = AGENT_LABELS[agent];
  const product = AGENT_PRODUCT[agent];
  const steps = handoffSteps(status, agent);
  const unavailable = status && status.available === false
    ? (devFlowSelect()?.unavailableNote(status.reason) || 'Handing work to Claude Code or Codex is unavailable right now.')
    : '';

  const act = async (action: FlowAction) => {
    setNotice('');
    if (action.action === 'refresh') { setRevision((n) => n + 1); return; }
    if (action.action === 'link-connector') { setConnector(true); return; }
    if (action.action === 'copy') {
      const text = status && typeof status.instructions === 'string' ? status.instructions : '';
      const ok = text ? await window.PlatformUI?.copyText?.(text) : false;
      setNotice(ok ? `Copied. Paste it into a new ${label} session.` : 'Could not copy. Open "Instructions" below and copy them by hand.');
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-label={`Build with ${label}`}
      className="m-auto w-[calc(100%-2rem)] max-w-lg max-h-[85dvh] overflow-y-auto rounded-xl border-0 bg-transparent p-0 text-sm text-zinc-900 backdrop:bg-black/60 dark:text-zinc-100"
      data-agent-session-handoff={agent}
      onCancel={(event) => { event.preventDefault(); closeHandoff(); }}
      onClick={(event) => { if (event.target === event.currentTarget) closeHandoff(); }}
    >
      <DialogCard size="lg" className="mx-0 max-w-none space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">{`Build with ${label}`}</h2>
          <Button variant="neutral" ink="neutral" onClick={() => closeHandoff()}>Close</Button>
        </div>
        <div className="flex gap-1 rounded-full bg-zinc-100 p-1 dark:bg-zinc-800" role="group" aria-label="Which agent builds this">
          {(['claude-code', 'codex'] as HandoffAgent[]).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={id === agent}
              className={`flex-1 rounded-full px-3 py-1 text-sm font-semibold ${id === agent ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-300'}`}
              onClick={() => { setConnector(false); setNotice(''); openHandoff(id); }}
            >
              {AGENT_PRODUCT[id]}
            </button>
          ))}
        </div>
        {target ? <p className="leading-relaxed text-zinc-600 dark:text-zinc-300">{lead(agent, target)}</p> : (
          <p className="leading-relaxed text-zinc-600 dark:text-zinc-300" data-agent-session-handoff-empty>
            There is nothing to hand over yet. Tell the Mayor which app to change first, then come back here.
          </p>
        )}
        {error ? <p role="alert" className="text-red-700 dark:text-red-300">{error}</p> : null}
        {notice ? <p role="status" className="text-emerald-700 dark:text-emerald-400">{notice}</p> : null}
        {target && !status && !error ? <p role="status" className="text-zinc-500 dark:text-zinc-400">Checking where you are…</p> : null}
        {unavailable ? <p className="text-zinc-600 dark:text-zinc-300" data-agent-session-handoff-unavailable>{unavailable}</p> : null}
        {steps.length ? (
          <ol className="space-y-3" data-agent-session-handoff-steps>
            {steps.map((step, index) => (
              <li key={step.key} className="flex gap-3" data-agent-session-handoff-step={step.key} data-state={step.state}>
                <span
                  aria-hidden="true"
                  className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${step.state === 'done'
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                    : step.state === 'current' ? 'bg-violet-600 text-white' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}`}
                >
                  {step.state === 'done' ? '✓' : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`font-semibold ${step.state === 'todo' ? 'text-zinc-500 dark:text-zinc-400' : ''}`}>{step.title}</p>
                  <p className="mt-0.5 leading-snug text-zinc-600 dark:text-zinc-300">{step.detail}</p>
                  {step.actions.length ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {step.actions.map((action) => (action.href ? (
                        <a
                          key={action.action}
                          className={action.primary ? ACTION_PRIMARY : ACTION}
                          href={action.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-agent-session-handoff-action={action.action}
                          onClick={() => { if (action.action !== 'open-agent') window.setTimeout(() => setRevision((n) => n + 1), 4000); }}
                        >
                          {action.label}
                        </a>
                      ) : (
                        <button
                          key={action.action}
                          type="button"
                          className={action.primary ? ACTION_PRIMARY : ACTION}
                          data-agent-session-handoff-action={action.action}
                          onClick={() => void act(action)}
                        >
                          {action.label}
                        </button>
                      )))}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : null}
        {connector ? (
          <section className="space-y-3 rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/60" data-agent-session-handoff-connector={product}>
            <p className="font-semibold">{`Add the Homeroom connector in ${product}`}</p>
            <p className="text-zinc-600 dark:text-zinc-300">
              {`Your MCP server URL: `}
              <code className="break-all rounded bg-white px-1 py-0.5 text-xs dark:bg-zinc-900">{typeof window === 'undefined' ? '/mcp' : `${window.location.origin}/mcp`}</code>
            </p>
            {product === 'ChatGPT' ? <ChatgptSetupSteps /> : <ClaudeSetupSteps />}
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {`Then start a new ${product} conversation: one you already had open will not see a connector added after it started.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={ACTION_PRIMARY} onClick={() => { setConnector(false); setRevision((n) => n + 1); }}>
                I&rsquo;ve added it. Check again
              </button>
              <a className={ACTION} href="#settings/connectors" onClick={() => closeHandoff()}>More connector settings</a>
            </div>
          </section>
        ) : null}
        {status && typeof status.instructions === 'string' && status.instructions ? (
          <details className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <summary className="cursor-pointer font-semibold">Instructions</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-zinc-700 dark:text-zinc-300" data-agent-session-handoff-instructions>{status.instructions}</pre>
          </details>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <a className="text-sm font-semibold text-violet-700 hover:underline dark:text-violet-300" href={AGENT_URL[agent]} target="_blank" rel="noopener noreferrer">
            {`Open ${label}`}
          </a>
          <button type="button" className={ACTION} onClick={() => closeHandoff()}>Keep building here</button>
        </div>
      </DialogCard>
    </dialog>
  );
}

// ── Out of credits ─────────────────────────────────────────────────────

interface CreditRow {
  id: string;
  title: string;
  blurb: string;
  cta: string;
  flow?: string | null;
  hash?: string | null;
  developer?: boolean;
}

interface CreditOptionsApi {
  creditState(snapshot: unknown): Record<string, unknown>;
  options(state: Record<string, unknown>): CreditRow[];
  lead(state: Record<string, unknown>): string;
  introFor(list: CreditRow[]): string;
}

function creditOptions(): CreditOptionsApi | null {
  const co = typeof window === 'undefined' ? null : (window as unknown as { CreditOptions?: CreditOptionsApi }).CreditOptions;
  return co && typeof co.options === 'function' ? co : null;
}

/**
 * The card's copy and rows: credit-options.js over the viewer's allowance,
 * this refusal and what this account can use. The developer routes (a CLI
 * lease, importing your own pull request) are the dev chat's, which build a
 * session rather than this conversation, so they are left out here.
 */
export function creditsView(refusal: CreditsRefusal, context: {
  budget?: unknown;
  hasApiKey?: boolean;
  externalFlowsAvailable?: boolean;
  co?: CreditOptionsApi | null;
} = {}): { lead: string; intro: string; rows: CreditRow[] } {
  const co = context.co === undefined ? creditOptions() : context.co;
  if (!co) return { lead: refusal.error || 'Your Homeroom credits are used up.', intro: '', rows: [] };
  const state = {
    ...co.creditState(context.budget || null),
    hasApiKey: !!context.hasApiKey,
    externalFlowsAvailable: !!context.externalFlowsAvailable,
    verificationRequired: refusal.verificationRequired,
    canCollaborate: true,
    error: refusal.error,
  };
  const rows = co.options(state).filter((row) => !row.developer);
  return { lead: co.lead(state), intro: rows.length ? co.introFor(rows) : '', rows };
}

function viewerContext() {
  if (typeof window === 'undefined') return {};
  const w = window as unknown as {
    AiCredit?: { Budget?: { state?: unknown } };
    Settings?: { state?: { hasApiKey?: boolean } };
    App?: { user?: { externalFlowsAvailable?: boolean } | null };
  };
  return {
    budget: w.AiCredit?.Budget?.state || null,
    hasApiKey: !!w.Settings?.state?.hasApiKey,
    externalFlowsAvailable: w.App?.user?.externalFlowsAvailable === true,
  };
}

export function CreditsCardView({ refusal, view }: { refusal: CreditsRefusal; view: ReturnType<typeof creditsView> }): ReactNode {
  return (
    <section
      className="rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30"
      data-agent-session-credits
      role="alert"
    >
      <p className="font-semibold text-zinc-900 dark:text-zinc-100">{view.lead}</p>
      {refusal.error && refusal.error !== view.lead ? (
        <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{refusal.error}</p>
      ) : null}
      {view.intro ? <p className="mt-3 text-sm font-medium text-zinc-700 dark:text-zinc-200">{view.intro}</p> : null}
      <ul className="mt-2 space-y-2">
        {view.rows.map((row) => (
          <li key={row.id} className="rounded-xl bg-white p-3 dark:bg-zinc-900" data-agent-session-credits-option={row.id}>
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{row.title}</p>
            <p className="mt-0.5 text-sm leading-snug text-zinc-600 dark:text-zinc-300">{row.blurb}</p>
            <div className="mt-2">
              {row.flow === 'claude-code' || row.flow === 'codex' ? (
                <button type="button" className={ACTION_PRIMARY} onClick={() => openHandoff(row.flow as HandoffAgent)}>
                  {row.cta}
                </button>
              ) : row.hash ? (
                <a className={ACTION} href={row.hash}>{row.cta}</a>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className="mt-3 text-sm font-semibold text-zinc-600 hover:underline dark:text-zinc-300" onClick={() => dismissCredits()}>
        Dismiss
      </button>
    </section>
  );
}

export function CreditsCard({ refusal }: { refusal: CreditsRefusal }) {
  return <CreditsCardView refusal={refusal} view={creditsView(refusal, viewerContext())} />;
}
