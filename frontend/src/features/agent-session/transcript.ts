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
  | { kind: 'agent'; key: string; outcome: 'success' | 'no_changes' | 'error'; summary: string; changeId: number | null }
  | { kind: 'preview'; key: string; text: string; url: string; prNumber: number | null; changeId: number | null };

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

export function buildTranscript(
  messages: AgentMessage[],
  actions: AgentAction[] = [],
  now = Date.now(),
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
    if (typeof meta.ccOutput === 'string') {
      const outcome = meta.ccOutcome === 'error' ? 'error' : meta.ccOutcome === 'no_changes' ? 'no_changes' : 'success';
      items.push({ kind: 'agent', key, outcome, summary: clip(meta.ccOutput, 600), changeId: row.changeId });
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
  return items;
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
    case 'active': return 'In progress';
    case 'paused': return 'Parked';
    case 'promoted': return 'In vote';
    case 'merging': return 'Merging';
    case 'merged': return 'Merged';
    case 'archived': return 'Closed';
    default: return 'No active change';
  }
}
