// The agent-session transcript as the screen draws it (#2779). Pure: the
// persisted rows (GET /api/agent-sessions/:id/messages) and the cards' live
// states (GET .../actions) in, view items out, so what the user sees is
// decided in one place a test can read.
//
// A conversation's rows come from three writers: the Mayor (user and
// assistant rows), the platform (conversation events: a change started,
// closed or switched, a card's outcome), and the changes it starts (status
// lines, the coding agent's completion, a preview going live). Each maps to
// one item kind.
//
// A change writes a coding-agent RUN as several rows: a start line
// ("Scouting the repo for context (…)…", "Spinning up coding agent…"), a
// running line, a progress row whose log grows as the agent works (its
// content is the fixed text "Claude Code progress" whatever agent runs, so it
// is recognised by its `progressLog`, never by its words), sometimes a raw
// log, and an end: the drafted spec for a scout, the completion for a build,
// or a failure or a stop. They are folded into ONE run item, which the screen
// draws as the dev chat's run card, captioned with the agent that actually
// ran (its `agentBackend`). A drafted spec is its own item after it.

import type { AgentAction, AgentActionStatus, AgentCard, AgentMessage } from './api';

export interface CardView {
  id: string;
  toolName: string;
  title: string;
  rows: Array<[string, string]>;
  status: AgentActionStatus;
  outcome: string | null;
}

export type TranscriptItem =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'mayor'; key: string; text: string; cards: CardView[]; quickReplies: string[]; wrapUp: boolean }
  | { kind: 'divider'; key: string; text: string; event: string }
  | { kind: 'note'; key: string; text: string; tone: 'ok' | 'error' | 'muted' }
  | RunItem
  | {
    kind: 'spec';
    key: string;
    changeId: number | null;
    version: number | null;
    lines: number | null;
    preview: string;
    text: string;
  }
  | { kind: 'preview'; key: string; text: string; url: string; prNumber: number | null; changeId: number | null };

export type RunMode = 'scout' | 'build' | 'sync';
export type RunStatus = 'running' | 'done' | 'no_changes' | 'failed' | 'stopped' | 'ended';

/** One coding-agent run on a change, folded from its rows. */
export interface RunItem {
  kind: 'run';
  key: string;
  changeId: number | null;
  mode: RunMode;
  /** The agent that ran, with its model: "Codex · glm-5.3-flash". */
  agent: string;
  status: RunStatus;
  /** Status lines the run wrote on its way (PR opened, preview building…). */
  steps: string[];
  /** The progress log, one line per step the agent reported. */
  log: string[];
  /** A build's own summary of what it did (markdown). */
  output: string | null;
  durationMs: number | null;
}

const DIVIDER_EVENTS = new Set(['change_started', 'change_switched', 'change_closed']);
const MAX_VALUE_CHARS = 140;

const FIELD_LABELS: Record<string, string> = {
  slug: 'App',
  title: 'Change',
  changeId: 'Change',
  proposalId: 'Proposal',
  number: 'Request',
  linkedIssues: 'Links',
  body: 'Details',
};

function clip(text: string, max = MAX_VALUE_CHARS) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function valueText(key: string, value: unknown): string | null {
  if (value == null || value === '') return null;
  if (key === 'changeId' || key === 'proposalId') return `#${value}`;
  if (key === 'number') return `Request #${value}`;
  if (key === 'linkedIssues' && Array.isArray(value)) {
    return value.length ? value.map((n) => `Request #${n}`).join(', ') : null;
  }
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return clip(JSON.stringify(value)); } catch { return null; }
}

function humanKey(key: string) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The rows a confirmation card shows: exactly the input it will run with. */
export function cardRows(input: Record<string, unknown>): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(input || {})) {
    const text = valueText(key, value);
    if (text) rows.push([humanKey(key), text]);
  }
  return rows;
}

function actionOutcome(action: AgentAction | undefined): string | null {
  if (!action || !action.result) return null;
  const structured = action.result.structured || null;
  const said = structured && (structured.nextStep || structured.message);
  if (typeof said === 'string' && said) return clip(said, 240);
  return action.result.text ? clip(action.result.text, 240) : null;
}

export function cardView(card: AgentCard, actions: Map<string, AgentAction>, now = Date.now()): CardView {
  const action = actions.get(card.id);
  let status: AgentActionStatus = action ? action.status : 'pending';
  if (status === 'pending' && new Date(card.expiresAt).getTime() <= now) status = 'expired';
  return {
    id: card.id,
    toolName: card.toolName,
    title: card.title || card.toolName,
    rows: cardRows(card.input),
    status,
    outcome: actionOutcome(action),
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [];
}

// ── Runs ───────────────────────────────────────────────────────────────

const RUN_START = /^(Scouting (?:the repo|on )|Spinning up coding agent|Starting OpenRouter|Handing this turn to|Syncing with main)/i;
const RUN_RUNNING = /^(Claude Code is (?:running|making changes)|(?:Codex|OpenRouter) is running|Scout reading the codebase)/i;

/** "claude-opus-5-5" → "Opus 5.5"; "z-ai/glm-5.3-flash" → "glm-5.3-flash". */
export function prettyModel(id: unknown): string {
  if (typeof id !== 'string' || !id) return '';
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id);
  if (claude) {
    const name = claude[1].charAt(0).toUpperCase() + claude[1].slice(1);
    return `${name} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  }
  return id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
}

/**
 * The agent a row says ran: Codex for an OpenRouter change (its runner is the
 * Codex CLI), Claude Code otherwise, or the user's own machine.
 */
export function agentLabel(meta: Record<string, unknown>): string {
  if (typeof meta.localAgentLabel === 'string' && meta.localAgentLabel) return `${meta.localAgentLabel} · your machine`;
  if (typeof meta.agentBackend !== 'string' && typeof meta.agentModel !== 'string') return '';
  const agent = meta.agentBackend === 'codex_openrouter' ? 'Codex' : 'Claude Code';
  const model = prettyModel(meta.agentModel);
  return model ? `${agent} · ${model}` : agent;
}

/** The start of a spec, clipped with its lines kept: it is rendered as markdown. */
function snippet(text: string, max = 280) {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function runModeOf(text: string): RunMode {
  if (/^Scout/i.test(text)) return 'scout';
  if (/^Syncing/i.test(text)) return 'sync';
  return 'build';
}

function finished(run: RunItem) {
  return run.status !== 'running';
}

/**
 * `liveRun`: a coding agent is running for this conversation right now. The
 * last unfinished run is then the running one; without it, a run that never
 * wrote its end (a restart, say) is drawn as ended rather than spinning.
 */
export function buildTranscript(
  messages: AgentMessage[],
  actions: AgentAction[] = [],
  now = Date.now(),
  { liveRun = false }: { liveRun?: boolean } = {},
): TranscriptItem[] {
  const byId = new Map(actions.map((action) => [action.id, action]));
  // The cards the transcript draws. A card's own outcome line says what its
  // action_result / action_dismissed note says, so the note is not repeated
  // under it (the note is there for the Mayor, which reads text).
  const drawn = new Set<string>();
  for (const row of messages) {
    const confirmations = (row.metadata || {} as Record<string, unknown>).confirmations;
    if (row.role === 'assistant' && Array.isArray(confirmations)) {
      for (const card of confirmations as AgentCard[]) if (card && typeof card.id === 'string') drawn.add(card.id);
    }
  }
  const items: TranscriptItem[] = [];
  // The run each change has open, until its end row arrives.
  const open = new Map<number, RunItem>();
  const startRun = (key: string, changeId: number, mode: RunMode, meta: Record<string, unknown>) => {
    const run: RunItem = {
      kind: 'run', key, changeId, mode, agent: agentLabel(meta), status: 'running',
      steps: [], log: [], output: null, durationMs: null,
    };
    items.push(run);
    open.set(changeId, run);
    return run;
  };
  const current = (changeId: number | null) => {
    if (changeId == null) return null;
    const run = open.get(changeId);
    return run && !finished(run) ? run : null;
  };
  for (const row of messages) {
    const meta = (row.metadata || {}) as Record<string, unknown>;
    const key = `m${row.id}`;
    if (row.role === 'user') {
      items.push({ kind: 'user', key, text: row.content });
      continue;
    }
    if (row.role === 'assistant') {
      const cards = Array.isArray(meta.confirmations)
        ? (meta.confirmations as AgentCard[]).filter((c) => c && typeof c.id === 'string').map((c) => cardView(c, byId, now))
        : [];
      items.push({
        kind: 'mayor',
        key,
        text: row.content || '',
        cards,
        quickReplies: stringList(meta.quickReplies),
        wrapUp: meta.wrapUp === true,
      });
      continue;
    }
    // System rows.
    const event = typeof meta.agentSessionEvent === 'string' ? meta.agentSessionEvent : null;
    if (event && DIVIDER_EVENTS.has(event)) {
      items.push({ kind: 'divider', key, text: row.content, event });
      continue;
    }
    if ((event === 'action_result' || event === 'action_dismissed')
      && typeof meta.actionId === 'string' && drawn.has(meta.actionId)) {
      continue;
    }
    if (event === 'action_result') {
      items.push({ kind: 'note', key, text: row.content, tone: meta.ok === false ? 'error' : 'ok' });
      continue;
    }
    if (event === 'turn_failed') {
      items.push({ kind: 'note', key, text: row.content, tone: 'error' });
      continue;
    }
    if (event) {
      items.push({ kind: 'note', key, text: row.content, tone: 'muted' });
      continue;
    }
    const text = (row.content || '').trim();
    const changeId = row.changeId;
    let run = current(changeId);
    const duration = typeof meta.durationMs === 'number' ? meta.durationMs : null;
    if (changeId != null && RUN_START.test(text)) {
      run = startRun(key, changeId, runModeOf(text), meta);
      continue;
    }
    if (changeId != null && RUN_RUNNING.test(text)) {
      if (!run) run = startRun(key, changeId, runModeOf(text), meta);
      if (!run.agent) run.agent = agentLabel(meta);
      continue;
    }
    if (Array.isArray(meta.progressLog)) {
      if (!run && changeId != null) run = startRun(key, changeId, 'build', meta);
      if (run) {
        run.log.push(...stringList(meta.progressLog));
        if (!run.agent) run.agent = agentLabel(meta);
        continue;
      }
    }
    if (typeof meta.ccLog === 'string') {
      if (run) {
        run.log.push(...meta.ccLog.split('\n').filter((line) => line.trim()));
        continue;
      }
    }
    if (typeof meta.ccOutput === 'string') {
      if (!run && changeId != null) run = startRun(key, changeId, 'build', meta);
      if (run) {
        run.mode = run.mode === 'sync' ? 'sync' : 'build';
        run.output = meta.ccOutput;
        run.durationMs = duration;
        run.status = meta.ccOutcome === 'error' ? 'failed' : meta.ccOutcome === 'no_changes' ? 'no_changes' : 'done';
        if (!run.agent) run.agent = agentLabel(meta);
        continue;
      }
    }
    if (meta.specVersion != null || typeof meta.specPreview === 'string') {
      if (run) {
        run.status = 'done';
        run.durationMs = duration;
      }
      const version = Number(meta.specVersion);
      const lines = Number(meta.specLines);
      items.push({
        kind: 'spec',
        key,
        changeId,
        version: Number.isInteger(version) && version > 0 ? version : null,
        lines: Number.isInteger(lines) && lines > 0 ? lines : null,
        preview: snippet(typeof meta.specPreview === 'string' ? meta.specPreview
          : typeof meta.scoutOutput === 'string' ? meta.scoutOutput : ''),
        text: row.content,
      });
      continue;
    }
    if (run && (meta.turnError || meta.stopLanding)) {
      // The end of the run; the sentence itself is still said below it.
      run.status = meta.turnError ? 'failed' : 'stopped';
      run.durationMs = duration;
    } else if (run && text && !(typeof meta.stagingUrl === 'string')) {
      // A step the run took on its way (a retry, the PR, the preview build).
      run.steps.push(text);
      continue;
    }
    if (typeof meta.stagingUrl === 'string' && /^https?:\/\//.test(meta.stagingUrl)) {
      items.push({
        kind: 'preview',
        key,
        text: row.content,
        url: meta.stagingUrl,
        prNumber: typeof meta.prNumber === 'number' ? meta.prNumber : null,
        changeId: row.changeId,
      });
      continue;
    }
    if (row.content && row.content.trim()) {
      items.push({ kind: 'note', key, text: row.content, tone: meta.turnError ? 'error' : 'muted' });
    }
  }
  // Only the newest unfinished run can be the one running now.
  const unfinished = items.filter((item): item is RunItem => item.kind === 'run' && item.status === 'running');
  unfinished.forEach((run, index) => {
    if (!liveRun || index !== unfinished.length - 1) run.status = 'ended';
  });
  return items;
}

/** A run's heading, in words. */
export function runHeading(run: Pick<RunItem, 'mode' | 'status'>): string {
  const scout = run.mode === 'scout';
  const sync = run.mode === 'sync';
  switch (run.status) {
    case 'running': return scout ? 'Writing the spec…' : sync ? 'Syncing with main…' : 'Building the change…';
    case 'done': return scout ? 'Wrote the spec' : sync ? 'Synced with main' : 'Built the change';
    case 'no_changes': return 'Made no changes';
    case 'failed': return scout ? 'The spec was not written' : sync ? 'Could not sync with main' : 'The build did not finish';
    case 'stopped': return scout ? 'Stopped writing the spec' : 'Stopped the build';
    default: return scout ? 'Spec run ended' : sync ? 'Sync ended' : 'Build ended';
  }
}

/** "1m 20s", "45s": how long a finished run took. */
export function durationLabel(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** Reply suggestions belong to the last thing said, and only while it is last. */
export function latestReplies(items: TranscriptItem[]): string[] {
  const last = items[items.length - 1];
  return last && last.kind === 'mayor' ? last.quickReplies : [];
}

const TOOL_ACTIVITY: Record<string, string> = {
  list_apps: 'Looking at apps',
  get_app: 'Reading the app',
  list_requests: 'Reading requests',
  get_request: 'Reading a request',
  get_proposal: 'Reading a proposal',
  list_my_proposals: 'Checking your proposals',
  get_change: 'Checking the change',
  get_platform_conventions: 'Reading the platform rules',
  web_fetch: 'Reading a web page',
  recheck_change: 'Re-running the checks',
  switch_active_change: 'Switching changes',
  set_focus_app: 'Changing the focus',
  get_prod_status: 'Reading production status',
  dispatch_scout: 'The coding agent is writing the spec',
  dispatch_coding_agent: 'The coding agent is building',
};

export function toolActivity(name: string): string {
  return TOOL_ACTIVITY[name] || 'Preparing a confirmation';
}

/** The active change's state, in the words the header pill uses. */
export function changeStatusLabel(status: string | null | undefined, busy = false): string {
  if (busy) return 'Building';
  switch (status) {
    // "paused" is the platform's bookkeeping, never a state of the work: it
    // pauses by itself when idle and resumes by itself when used.
    case 'active':
    case 'paused': return 'In progress';
    case 'promoted': return 'In vote';
    case 'merging': return 'Merging';
    case 'merged': return 'Merged';
    case 'archived': return 'Closed';
    default: return 'No active change';
  }
}
