// Agent sessions (#2779): the conversation screen's state. Module-level, read
// through useSyncExternalStore like the other islands' stores, with a
// controller published on window.UsernodeReact.agentSession for the classic
// router (public/js/app.js) and the entry points that start a conversation.
//
// Two sources of truth, deliberately kept apart:
//   - what the server has persisted (the session, its rows, its cards),
//     which is re-read after anything that changes it;
//   - what a turn is doing right now (streamed text, the tool it is running,
//     the coding agent's latest progress line), which only lives until the
//     turn's rows are persisted.

import { useSyncExternalStore } from 'react';

import * as api from './api';
import type {
  AgentAction,
  AgentCard,
  AgentHint,
  AgentMessage,
  AgentSession,
  AgentTurnEvent,
} from './api';
import { toolActivity } from './transcript';

export type AgentSessionHost = 'screen' | 'messages';

export interface LiveTurn {
  running: boolean;
  phase: 'mayor' | 'cc' | 'mayor2' | null;
  stopping: boolean;
  streamText: string;
  activity: string;
  progress: string;
  startedAt: number | null;
  cards: AgentCard[];
  pendingUserText: string | null;
}

export interface AgentSessionState {
  open: boolean;
  host: AgentSessionHost;
  id: number | null;
  session: AgentSession | null;
  messages: AgentMessage[];
  actions: AgentAction[];
  phase: 'idle' | 'loading' | 'ready' | 'error';
  error: string;
  turn: LiveTurn;
  drawerOpen: boolean;
  deciding: string | null;
  sessions: AgentSession[];
  sessionsLoaded: boolean;
}

const IDLE_TURN: LiveTurn = {
  running: false,
  phase: null,
  stopping: false,
  streamText: '',
  activity: '',
  progress: '',
  startedAt: null,
  cards: [],
  pendingUserText: null,
};

export const INITIAL_STATE: AgentSessionState = {
  open: false,
  host: 'screen',
  id: null,
  session: null,
  messages: [],
  actions: [],
  phase: 'idle',
  error: '',
  turn: IDLE_TURN,
  drawerOpen: false,
  deciding: null,
  sessions: [],
  sessionsLoaded: false,
};

let state: AgentSessionState = INITIAL_STATE;
const listeners = new Set<() => void>();
let navigation = 0;
let turnAbort: AbortController | null = null;
let events: EventSource | null = null;
let eventFilter: string | null = null;
const seen = new Set<string>();

function publish(patch: Partial<AgentSessionState> | ((current: AgentSessionState) => Partial<AgentSessionState>)) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function patchTurn(patch: Partial<LiveTurn>) {
  publish((current) => ({ turn: { ...current.turn, ...patch } }));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAgentSessionState() {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL_STATE);
}

export function getAgentSessionState() {
  return state;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Whether new work starts in an agent session for this viewer (#2779): the
 * per-user experimental flag, as /api/auth/me reported it. Only STARTING
 * reads it; a conversation that already exists opens either way.
 */
export function agentSessionsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return window.App?.user?.agentSessionsEnabled === true;
}

export function composerId(host: AgentSessionHost) {
  return host === 'messages' ? 'agent-session-pane-composer' : 'agent-session-composer';
}

function syncTitle() {
  if (!state.open || state.host !== 'screen') return;
  const title = state.session?.title || 'New session';
  try { window.App?.setHeaderTitle?.(title); } catch { /* the bar keeps its last title */ }
}

// ── Reading ────────────────────────────────────────────────────────────

async function refreshSession(id: number) {
  const { session } = await api.getSession(id);
  if (state.id !== id) return;
  publish({ session });
  syncTitle();
}

async function refreshMessages(id: number) {
  const all: AgentMessage[] = [];
  let after = 0;
  // A conversation can outgrow one page; follow the cursor to the end.
  for (let page = 0; page < 20; page += 1) {
    const { messages, nextAfter } = await api.getMessages(id, after);
    all.push(...messages);
    if (!nextAfter) break;
    after = nextAfter;
  }
  if (state.id !== id) return;
  publish({ messages: all });
}

async function refreshActions(id: number) {
  const actions = await api.getActions(id);
  if (state.id !== id) return;
  publish({ actions });
}

async function refreshAll(id: number) {
  await Promise.all([refreshSession(id), refreshMessages(id), refreshActions(id)]);
}

// ── The live stream ────────────────────────────────────────────────────

function closeEvents() {
  if (events) {
    try { events.close(); } catch { /* already closed */ }
  }
  events = null;
  eventFilter = null;
}

/**
 * Follow the conversation's bus (GET .../events) — for a turn this tab did
 * not start: one already running when the screen opened, or the Mayor's
 * follow-up after a confirmed card. `turnId` narrows it to that turn's
 * events, so the tail of an earlier turn still in the buffer is ignored.
 */
function followEvents(id: number, turnId: string | null = null) {
  closeEvents();
  if (typeof EventSource === 'undefined') return;
  eventFilter = turnId ? `${turnId.slice(0, 8)}-` : null;
  const source = new EventSource(`/api/agent-sessions/${id}/events`, { withCredentials: true });
  events = source;
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as AgentTurnEvent;
      if (eventFilter && typeof event._seq === 'string' && !event._seq.startsWith(eventFilter)) return;
      handleEvent(id, event);
    } catch { /* malformed frame */ }
  };
}

export function handleEvent(id: number, event: AgentTurnEvent) {
  if (state.id !== id) return;
  if (typeof event._seq === 'string') {
    if (seen.has(event._seq)) return;
    seen.add(event._seq);
  }
  const fromChange = event.changeId != null;
  switch (event.type) {
    case 'phase': {
      const phase = event.phase === 'cc' || event.phase === 'mayor2' ? event.phase : 'mayor';
      patchTurn({
        running: true,
        phase,
        streamText: phase === 'mayor2' ? '' : state.turn.streamText,
        activity: phase === 'cc' ? 'The coding agent is working' : '',
        startedAt: phase === 'cc' ? Date.now() : (state.turn.startedAt || Date.now()),
        progress: phase === 'cc' ? '' : state.turn.progress,
      });
      break;
    }
    case 'token':
      if (!fromChange && typeof event.text === 'string') patchTurn({ running: true, streamText: state.turn.streamText + event.text });
      break;
    case 'tool':
      if (event.state === 'running') patchTurn({ activity: toolActivity(String(event.name || '')) });
      else if (state.turn.phase !== 'cc') patchTurn({ activity: '' });
      break;
    case 'confirmation_required':
      if (event.card && typeof event.card === 'object') patchTurn({ cards: [...state.turn.cards, event.card as AgentCard] });
      break;
    case 'status':
    case 'cc_progress':
      if (typeof event.text === 'string' && event.text.trim()) patchTurn({ progress: event.text.trim() });
      if (event.type === 'status' && fromChange) void refreshMessages(id).catch(() => {});
      break;
    case 'staging_ready':
    case 'staging_failed':
    case 'pr_created':
    case 'pr_updated':
    case 'spec_updated':
    case 'checks_ready':
    case 'active_change':
    case 'focus_app':
      void refreshSession(id).catch(() => {});
      if (fromChange) void refreshMessages(id).catch(() => {});
      break;
    case 'mayor_reasoning':
      patchTurn({ streamText: '', cards: [], pendingUserText: null });
      void Promise.all([refreshMessages(id), refreshActions(id)]).catch(() => {});
      break;
    case 'stopping':
      patchTurn({ stopping: true });
      break;
    case 'stopped':
      if (!fromChange) patchTurn({ stopping: false });
      break;
    case 'error':
      if (!fromChange) {
        publish({ error: typeof event.error === 'string' ? event.error : 'The Mayor could not finish this turn.' });
        patchTurn({ pendingUserText: null });
      }
      break;
    case 'done':
      if (fromChange) break;
      publish({ turn: IDLE_TURN });
      closeEvents();
      void refreshAll(id).catch(() => {});
      break;
    default:
      break;
  }
}

// ── Opening and closing ────────────────────────────────────────────────

export async function openAgentSession({ id, host = 'screen', drawer = false }: {
  id: number;
  host?: AgentSessionHost;
  drawer?: boolean;
}) {
  const version = ++navigation;
  const same = state.id === id && state.open;
  publish({
    open: true,
    host,
    id,
    phase: same ? state.phase : 'loading',
    error: '',
    drawerOpen: drawer || (same ? state.drawerOpen : false),
    ...(same ? {} : { session: null, messages: [], actions: [], turn: IDLE_TURN }),
  });
  syncTitle();
  if (same) return;
  seen.clear();
  closeEvents();
  try {
    const [{ session, turn }] = await Promise.all([api.getSession(id), refreshMessages(id), refreshActions(id)]);
    if (version !== navigation) return;
    publish({ session, phase: 'ready' });
    syncTitle();
    if (session.busy) {
      patchTurn({ running: true, phase: turn ? turn.phase : 'mayor', startedAt: Date.now() });
      followEvents(id);
    }
  } catch (error) {
    if (version !== navigation) return;
    publish({ phase: 'error', error: errorText(error, 'Could not load this agent session.') });
  }
}

/** The screen or pane stopped showing this conversation. A running turn goes on server-side. */
export function deactivateAgentSession() {
  navigation += 1;
  closeEvents();
  if (turnAbort) turnAbort.abort();
  turnAbort = null;
  publish({ open: false, drawerOpen: false, turn: IDLE_TURN });
}

/** Where a conversation lives: beside the inbox on a desktop, its own screen on a phone (app.js swaps). */
export function agentSessionAddress(id: number) {
  return `#messages/agent/${id}`;
}

function go(hash: string) {
  if (window.location.hash === hash) {
    const restore = window.App?.restoreFromHash;
    if (typeof restore === 'function') restore.call(window.App);
  } else {
    window.location.hash = hash;
  }
}

/**
 * Start a conversation from an entry point, carrying what it knows (the app,
 * a request, a proposal) as the hint, and open it. An optional first message
 * is sent straight away.
 */
export async function startAgentSession(hint: AgentHint | null = null, { message = null }: { message?: string | null } = {}) {
  try {
    const session = await api.createSession(hint);
    publish((current) => ({ sessions: [session, ...current.sessions.filter((s) => s.id !== session.id)] }));
    go(agentSessionAddress(session.id));
    if (message && message.trim()) {
      // The route opens the conversation first; the message follows it.
      setTimeout(() => { void sendAgentMessage(message); }, 0);
    }
    return session;
  } catch (error) {
    window.PlatformUI?.toast?.(errorText(error, 'Could not start an agent session.'));
    return null;
  }
}

export function closeAgentSession() {
  deactivateAgentSession();
  go(state.host === 'messages' ? '#messages' : '#messages');
}

// ── Talking ────────────────────────────────────────────────────────────

export async function sendAgentMessage(text: string) {
  const id = state.id;
  const message = text.trim();
  if (!id || !message || state.turn.running) return;
  publish({ error: '' });
  patchTurn({ running: true, phase: 'mayor', pendingUserText: message, startedAt: Date.now(), streamText: '', cards: [] });
  const abort = new AbortController();
  turnAbort = abort;
  try {
    await api.sendTurn(id, message, { signal: abort.signal, onEvent: (event) => handleEvent(id, event) });
  } catch (error) {
    if (abort.signal.aborted) return;
    const busy = (error as { body?: { busy?: boolean } }).body?.busy;
    publish({ error: busy ? 'The Mayor is already answering in this conversation.' : errorText(error, 'The Mayor could not take that message.') });
    publish({ turn: IDLE_TURN });
    if (busy) followEvents(id);
  } finally {
    if (turnAbort === abort) turnAbort = null;
    // The stream can end without a `done` (a dropped connection): settle
    // from what the server has persisted.
    if (state.id === id && state.turn.running && !events) {
      followEvents(id);
    }
    void refreshAll(id).catch(() => {});
  }
}

export async function stopAgentTurn() {
  const id = state.id;
  if (!id || !state.turn.running) return;
  patchTurn({ stopping: true });
  try {
    const answer = await api.stopTurn(id);
    if (!answer.stopped && answer.reason === 'wrap_up_not_stoppable') patchTurn({ stopping: false });
  } catch (error) {
    patchTurn({ stopping: false });
    publish({ error: errorText(error, 'Could not stop the Mayor.') });
  }
}

export async function decideCard(actionId: string, decision: 'confirm' | 'dismiss') {
  const id = state.id;
  if (!id || state.deciding) return;
  publish({ deciding: actionId, error: '' });
  try {
    if (decision === 'confirm') {
      const outcome = await api.confirmAction(id, actionId);
      if (outcome.followUp && outcome.followUp.turnId) {
        patchTurn({ running: true, phase: 'mayor', startedAt: Date.now() });
        followEvents(id, outcome.followUp.turnId);
      }
    } else {
      await api.dismissAction(id, actionId);
    }
  } catch (error) {
    publish({ error: errorText(error, 'That did not go through.') });
  } finally {
    publish({ deciding: null });
    void refreshAll(id).catch(() => {});
  }
}

export async function switchActiveChange(changeId: number) {
  const id = state.id;
  if (!id) return;
  try {
    const session = await api.switchChange(id, changeId);
    publish({ session, drawerOpen: false });
    void refreshMessages(id).catch(() => {});
  } catch (error) {
    publish({ error: errorText(error, 'Could not switch to that change.') });
  }
}

export function setDrawerOpen(open: boolean) {
  publish({ drawerOpen: open });
}

// ── The list, for Messages ─────────────────────────────────────────────

export async function loadAgentSessions() {
  try {
    const sessions = await api.listSessions();
    publish({ sessions, sessionsLoaded: true });
  } catch {
    publish({ sessionsLoaded: true });
  }
}

export const agentSessionController = {
  open: (id: number, options: { host?: AgentSessionHost } = {}) => openAgentSession({ id, host: options.host }),
  route: (id: number, options: { drawer?: boolean } = {}) => openAgentSession({ id, host: 'screen', drawer: !!options.drawer }),
  start: (hint: AgentHint | null = null, options: { message?: string | null } = {}) => startAgentSession(hint, options),
  deactivate: deactivateAgentSession,
  isOpen: () => state.open,
  currentId: () => state.id,
  refreshList: loadAgentSessions,
};

if (typeof window !== 'undefined') {
  const host = (window.UsernodeReact ||= {});
  host.agentSession = agentSessionController;
}
