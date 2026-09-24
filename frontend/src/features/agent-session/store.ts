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
//
// A conversation New change opens is UNSENT (`draft`, addressed `new`): no
// row exists until its first message, so opening and leaving it leaves
// nothing behind in Messages. The first send creates the session with what
// the draft carried (the hint, the model picked while it was unsent), swaps
// the address for the session's own in place, and posts the message.

import { useSyncExternalStore } from 'react';

import * as api from './api';
import type {
  AgentAction,
  AgentCard,
  AgentChoice,
  AgentHint,
  AgentMessage,
  AgentSession,
  AgentTurnEvent,
  ModelCatalog,
} from './api';
import { sameChoice } from './model-choice';
import { toolActivity } from './transcript';

export type AgentSessionHost = 'screen' | 'messages';

/** A conversation's id, or `new` for the one not sent yet. */
export type AgentSessionTarget = number | 'new';

/** An unsent conversation: what it is about, and the model picked for it. */
export interface AgentDraft {
  hint: AgentHint | null;
  focusApp: AgentSession['focusApp'];
  focusContext: Record<string, unknown>;
  agent: AgentChoice | null;
}

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

/** The spec viewer over the conversation: one change's spec, one version. */
export interface SpecSheetState {
  changeId: number;
  /** The version on screen; null is the latest. */
  version: number | null;
  versions: number[];
  text: string;
  phase: 'loading' | 'ready' | 'error';
  error: string;
  /**
   * Which half of a two-half spec is showing (the platform's convention, see
   * public/js/spec-sections.js): the plain-language half first, as the dev
   * chat's viewer does. Kept across a version switch, reset for another change.
   */
  tab: SpecTab;
}

export type SpecTab = 'user' | 'tech';

export interface AgentSessionState {
  open: boolean;
  host: AgentSessionHost;
  id: number | null;
  session: AgentSession | null;
  /** Set while the conversation on screen is unsent (`id` is null). */
  draft: AgentDraft | null;
  messages: AgentMessage[];
  actions: AgentAction[];
  phase: 'idle' | 'loading' | 'ready' | 'error';
  error: string;
  turn: LiveTurn;
  drawerOpen: boolean;
  deciding: string | null;
  sessions: AgentSession[];
  sessionsLoaded: boolean;
  /** The picker's options, read once per page. */
  catalog: ModelCatalog | null;
  /** A pick on its way to the server. */
  choosing: boolean;
  /** A message the server refused, handed back to the composer to send again. */
  returnedText: string | null;
  specSheet: SpecSheetState | null;
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
  draft: null,
  messages: [],
  actions: [],
  phase: 'idle',
  error: '',
  turn: IDLE_TURN,
  drawerOpen: false,
  deciding: null,
  sessions: [],
  sessionsLoaded: false,
  catalog: null,
  choosing: false,
  returnedText: null,
  specSheet: null,
};

let state: AgentSessionState = INITIAL_STATE;
const listeners = new Set<() => void>();
let navigation = 0;
let turnAbort: AbortController | null = null;
let events: EventSource | null = null;
let eventFilter: string | null = null;
const seen = new Set<string>();
// The hint the next `new` open starts from: undefined when nothing has been
// prepared (a reload of `#agent/new`, or the same draft routed again).
let pendingHint: AgentHint | null | undefined;
let catalogRequest: Promise<void> | null = null;

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

/**
 * The lists (Recents, the mark's menu, Messages) read the same session as
 * the screen: reading it marked it seen, and a turn that just ended is no
 * longer working, so their mark follows the conversation on screen at once.
 */
function withListed(current: AgentSessionState, session: AgentSession): AgentSession[] {
  return current.sessions.map((s) => (s.id === session.id ? session : s));
}

async function refreshSession(id: number) {
  const { session } = await api.getSession(id);
  if (state.id !== id) return;
  publish((current) => ({ session, sessions: withListed(current, session) }));
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
  id: AgentSessionTarget;
  host?: AgentSessionHost;
  drawer?: boolean;
}) {
  if (id === 'new') return openDraft(host);
  const version = ++navigation;
  const same = state.id === id && state.open;
  publish({
    open: true,
    host,
    id,
    phase: same ? state.phase : 'loading',
    error: '',
    drawerOpen: drawer || (same ? state.drawerOpen : false),
    ...(same ? {} : { session: null, draft: null, messages: [], actions: [], turn: IDLE_TURN, specSheet: null }),
  });
  syncTitle();
  if (same) return;
  seen.clear();
  closeEvents();
  try {
    const [{ session, turn }] = await Promise.all([api.getSession(id), refreshMessages(id), refreshActions(id)]);
    if (version !== navigation) return;
    publish((current) => ({ session, phase: 'ready', sessions: withListed(current, session) }));
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

/**
 * Where to start the next unsent conversation from. Called by New change
 * (startAgentSession) in this document, and by the side panel's own document
 * with the hint the top window handed it.
 */
export function prepareAgentDraft(hint: AgentHint | null | undefined) {
  pendingHint = hint || null;
}

/**
 * Show an unsent conversation. A freshly prepared hint starts a new draft;
 * routing the one already on screen again (a resize, a same-address
 * restore) keeps it, typed model pick included.
 */
function openDraft(host: AgentSessionHost) {
  const version = ++navigation;
  const fresh = pendingHint !== undefined;
  if (!fresh && state.open && state.id === null && state.draft) {
    publish({ host });
    syncTitle();
    return;
  }
  const hint = fresh ? (pendingHint || null) : null;
  pendingHint = undefined;
  seen.clear();
  closeEvents();
  const draft: AgentDraft = {
    hint,
    focusApp: null,
    focusContext: hint && hint.entry ? { entry: hint.entry } : {},
    agent: null,
  };
  publish({
    open: true,
    host,
    id: null,
    session: null,
    draft,
    messages: [],
    actions: [],
    phase: 'ready',
    error: '',
    drawerOpen: false,
    specSheet: null,
    turn: IDLE_TURN,
  });
  syncTitle();
  if (!hint || !(hint.slug || hint.issueNumber || hint.proposalId)) return;
  // What it is about, resolved as creating it would resolve it, written
  // nowhere. A failure only leaves the bar saying "Any app".
  void api.previewDraft(hint).then((preview) => {
    if (version !== navigation || state.draft?.hint !== hint) return;
    publish((current) => ({
      draft: current.draft ? { ...current.draft, focusApp: preview.focusApp, focusContext: preview.focusContext } : null,
    }));
  }).catch(() => {});
}

/** The screen or pane stopped showing this conversation. A running turn goes on server-side. */
export function deactivateAgentSession() {
  navigation += 1;
  closeEvents();
  if (turnAbort) turnAbort.abort();
  turnAbort = null;
  publish({ open: false, drawerOpen: false, specSheet: null, turn: IDLE_TURN });
}

/** Where a conversation lives: beside the inbox on a desktop, its own screen on a phone (app.js swaps). */
export function agentSessionAddress(id: AgentSessionTarget) {
  return `#messages/agent/${id}`;
}

/**
 * The unsent conversation became session `id`: give the page the session's
 * own address in place, so a reload, Back or Expand finds it, and let the
 * router hear it (its same-id checks make that a no-op for this store).
 */
function adoptAddress(id: number) {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash;
  const next = /^#agent\/new(?:\/|$)/.test(hash)
    ? `#agent/${id}`
    : /^#messages\/agent\/new(?:\/|$)/.test(hash) ? agentSessionAddress(id) : null;
  if (!next) return;
  try {
    window.history.replaceState(window.history.state, '', next);
  } catch {
    return;
  }
  const restore = window.App?.restoreFromHash;
  if (typeof restore === 'function') restore.call(window.App);
}

/**
 * THE SIDE PANEL (desktop): while an app runs on its App tab, a conversation
 * opens in the panel beside it instead of replacing it, as a change or a
 * thread does (frontend/src/features/side-panel/). False whenever that is not
 * the moment — no app on screen, a narrow window, or this IS the panel's own
 * document, where the address below is followed in place.
 */
function sidePanelTakes(hash: string, agentHint?: AgentHint | null): boolean {
  const panel = (window as unknown as {
    UsernodeReact?: { sidePanel?: { take?: (route: string, hint?: { agentHint?: AgentHint | null } | null) => boolean } };
  }).UsernodeReact?.sidePanel;
  try {
    return !!panel?.take?.(hash.replace(/^#/, ''), agentHint !== undefined ? { agentHint } : null);
  } catch {
    return false;
  }
}

function go(hash: string, agentHint?: AgentHint | null) {
  if (sidePanelTakes(hash, agentHint)) return;
  if (window.location.hash === hash) {
    const restore = window.App?.restoreFromHash;
    if (typeof restore === 'function') restore.call(window.App);
  } else {
    window.location.hash = hash;
  }
}

/**
 * Start a conversation from an entry point, carrying what it knows (the app,
 * a request, a proposal) as the hint, and open it UNSENT — in the side panel
 * when an app is running beside it, where the hint rides into the panel's own
 * document. Nothing is created here: the first message creates the session,
 * in whichever document is showing it.
 */
export function startAgentSession(hint: AgentHint | null = null) {
  prepareAgentDraft(hint);
  if (sidePanelTakes(agentSessionAddress('new'), hint)) {
    // The panel's document starts the draft; this one has nothing to open.
    pendingHint = undefined;
    return;
  }
  // Already showing an unsent conversation: the address may not change, and
  // then no router pass would pick the new hint up. Start it here.
  if (state.open && state.id === null && state.draft) openDraft(state.host);
  go(agentSessionAddress('new'));
}

export function closeAgentSession() {
  deactivateAgentSession();
  go(state.host === 'messages' ? '#messages' : '#messages');
}

// ── Talking ────────────────────────────────────────────────────────────

/**
 * Create the session an unsent conversation stands for, with what it carried.
 * Its id, or null when the create was refused (said on screen, and the draft
 * stays as it was).
 */
async function createFromDraft(draft: AgentDraft): Promise<number | null> {
  try {
    const session = await api.createSession(draft.hint, draft.agent);
    publish((current) => ({ sessions: [session, ...current.sessions.filter((s) => s.id !== session.id)] }));
    // Still on screen: this is the conversation now. Left meanwhile: it
    // still gets its message, it just is not what the screen shows.
    if (state.open && state.draft === draft) {
      publish({ id: session.id, session, draft: null, phase: 'ready' });
      syncTitle();
      adoptAddress(session.id);
    }
    return session.id;
  } catch (error) {
    if (state.draft === draft) publish({ error: errorText(error, 'Could not start an agent session.') });
    return null;
  }
}

export async function sendAgentMessage(text: string) {
  const draft = state.id ? null : state.draft;
  const message = text.trim();
  if ((!state.id && !draft) || !message || state.turn.running) return;
  publish({ error: '' });
  patchTurn({ running: true, phase: 'mayor', pendingUserText: message, startedAt: Date.now(), streamText: '', cards: [] });
  const id = draft ? await createFromDraft(draft) : state.id;
  if (!id) {
    if (draft && state.draft === draft) publish({ turn: IDLE_TURN, returnedText: message });
    return;
  }
  const abort = new AbortController();
  // A conversation the viewer left while it was being created still gets its
  // message, but its stream is not this screen's to stop.
  if (state.id === id) turnAbort = abort;
  try {
    await api.sendTurn(id, message, { signal: abort.signal, onEvent: (event) => handleEvent(id, event) });
  } catch (error) {
    if (abort.signal.aborted) return;
    const busy = (error as { body?: { busy?: boolean } }).body?.busy;
    publish({ error: busy ? 'The Mayor is already answering in this conversation.' : errorText(error, 'The Mayor could not take that message.') });
    // Refused before it was recorded: the text goes back to the composer
    // rather than vanishing with the pending bubble.
    publish({ turn: IDLE_TURN, ...(state.id === id ? { returnedText: message } : {}) });
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

/** The composer took a refused message back. */
export function clearReturnedText() {
  if (state.returnedText !== null) publish({ returnedText: null });
}

export async function stopAgentTurn() {
  const id = state.id;
  if (!id || !state.turn.running) return;
  patchTurn({ stopping: true });
  try {
    const answer = await api.stopTurn(id);
    if (!answer.stopped && answer.reason === 'wrap_up_not_stoppable') patchTurn({ stopping: false });
    if (!answer.stopped && answer.reason === 'no_active_turn') {
      // Nothing is running here to send a `done`: settle from the server.
      patchTurn({ stopping: false });
      const { session } = await api.getSession(id);
      if (state.id !== id) return;
      publish((current) => ({ session, sessions: withListed(current, session) }));
      if (!session.busy && !turnAbort) {
        publish({ turn: IDLE_TURN });
        closeEvents();
        void refreshAll(id).catch(() => {});
      }
    }
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

// ── The spec viewer ────────────────────────────────────────────────────

let specRequest = 0;

/**
 * Open a change's spec over the conversation: the version a spec card names,
 * or the latest. The text is the change's own (GET /api/sessions/:id/spec and
 * /specs/:version), so it is what the change page's viewer shows.
 */
export async function openSpec(changeId: number, version: number | null = null) {
  const ticket = ++specRequest;
  const same = state.specSheet?.changeId === changeId ? state.specSheet : null;
  const tab: SpecTab = same ? same.tab : 'user';
  publish({
    drawerOpen: false,
    specSheet: { changeId, version, versions: same ? same.versions : [], text: '', phase: 'loading', error: '', tab },
  });
  try {
    const { spec, versions } = await api.getSpec(changeId);
    const numbers = versions.map((v) => Number(v.version)).filter((v) => Number.isInteger(v) && v > 0);
    const newest = numbers.length ? Math.max(...numbers) : null;
    const text = version != null && version !== newest ? await api.getSpecVersion(changeId, version) : spec;
    if (ticket !== specRequest) return;
    publish((current) => ({
      specSheet: { changeId, version: version ?? newest, versions: numbers, text, phase: 'ready', error: '', tab: current.specSheet?.tab ?? tab },
    }));
  } catch (error) {
    if (ticket !== specRequest) return;
    publish((current) => ({
      specSheet: current.specSheet
        ? { ...current.specSheet, phase: 'error', error: errorText(error, 'Could not load the spec.') }
        : null,
    }));
  }
}

export function closeSpec() {
  specRequest += 1;
  publish({ specSheet: null });
}

/** Switch the open spec between its plain-language and technical halves. No fetch. */
export function setSpecTab(tab: SpecTab) {
  const next: SpecTab = tab === 'tech' ? 'tech' : 'user';
  publish((current) => (current.specSheet && current.specSheet.tab !== next
    ? { specSheet: { ...current.specSheet, tab: next } }
    : {}));
}

// ── The model ──────────────────────────────────────────────────────────

/** Read the picker's options once per page; a failed read is retried on the next open. */
export function loadModelCatalog(): Promise<void> {
  if (state.catalog) return Promise.resolve();
  if (!catalogRequest) {
    catalogRequest = api.loadModelCatalog()
      .then((catalog) => { publish({ catalog }); })
      .catch(() => {})
      .finally(() => { catalogRequest = null; });
  }
  return catalogRequest;
}

/**
 * The picker. On an unsent conversation the pick is held and sent with the
 * first message; on a session it is saved now and applies from the Mayor's
 * next turn and the active change's next build, so it may be made mid-turn.
 */
export async function chooseAgent(choice: AgentChoice) {
  if (!state.id && state.draft) {
    if (!sameChoice(state.draft.agent, choice)) publish({ draft: { ...state.draft, agent: choice } });
    return;
  }
  const id = state.id;
  if (!id || state.choosing) return;
  if (sameChoice(state.session?.agent || null, choice)) return;
  publish({ choosing: true, error: '' });
  try {
    const session = await api.setAgentChoice(id, choice);
    if (state.id === id) publish({ session });
  } catch (error) {
    if (state.id === id) publish({ error: errorText(error, 'Could not change the model.') });
  } finally {
    publish({ choosing: false });
  }
}

// ── The list, for Messages ─────────────────────────────────────────────

// One of the user's conversations started or finished a turn, or was read in
// another tab (the server's `agent_session_changed`, routed by app.js). The
// lists redraw their marks from a fresh read; a burst of events is one read.
let listTimer: ReturnType<typeof setTimeout> | null = null;
export function agentSessionListChanged() {
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    void loadAgentSessions();
  }, 250);
}

export async function loadAgentSessions() {
  try {
    const sessions = await api.listSessions();
    publish({ sessions, sessionsLoaded: true });
  } catch {
    publish({ sessionsLoaded: true });
  }
}

export const agentSessionController = {
  open: (id: AgentSessionTarget, options: { host?: AgentSessionHost } = {}) => openAgentSession({ id, host: options.host }),
  route: (id: AgentSessionTarget, options: { drawer?: boolean } = {}) => openAgentSession({ id, host: 'screen', drawer: !!options.drawer }),
  start: (hint: AgentHint | null = null) => startAgentSession(hint),
  prepareDraft: prepareAgentDraft,
  deactivate: deactivateAgentSession,
  isOpen: () => state.open,
  /** The conversation on screen: its id, `new` while it is unsent, or null. */
  currentId: (): AgentSessionTarget | null => (state.id ?? (state.draft ? 'new' : null)),
  refreshList: loadAgentSessions,
  listChanged: agentSessionListChanged,
};

if (typeof window !== 'undefined') {
  const host = (window.UsernodeReact ||= {});
  host.agentSession = agentSessionController;
}
