// Agent sessions (#2779, docs/agent-sessions.md): the HTTP surface the
// conversation screen reads and writes. Every route is owner-scoped on the
// server (src/routes/agent-sessions.js); nothing here decides access.

export interface AgentChange {
  id: number;
  appSlug: string | null;
  appName: string | null;
  status: string | null;
  title: string | null;
  prNumber: number | null;
  stagingUrl?: string | null;
  checkState?: string | null;
}

export interface AgentSession {
  id: number;
  title: string | null;
  status: 'open' | 'archived';
  focusApp: { id: number; slug: string | null; name: string | null } | null;
  focusContext: Record<string, unknown>;
  activeChange: AgentChange | null;
  changes?: AgentChange[];
  busy: boolean;
  lastActivityAt: string | null;
  createdAt: string | null;
}

export interface AgentTurnState {
  phase: 'mayor' | 'cc' | 'mayor2';
  stopping: boolean;
  changeId: number | null;
}

export interface AgentMessage {
  id: number;
  changeId: number | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string | null;
}

export interface AgentCard {
  id: string;
  toolName: string;
  title: string;
  input: Record<string, unknown>;
  expiresAt: string;
}

export type AgentActionStatus = 'pending' | 'running' | 'done' | 'failed' | 'dismissed' | 'expired';

export interface AgentAction {
  id: string;
  toolName: string;
  title: string;
  status: AgentActionStatus;
  result: { ok?: boolean; text?: string; structured?: Record<string, unknown> | null } | null;
  expiresAt: string;
}

export interface AgentTurnEvent {
  type: string;
  _seq?: string;
  [key: string]: unknown;
}

export interface ChangeDetail {
  id: number;
  status?: string;
  staging_url?: string | null;
  pr_number?: number | null;
  pr_url?: string | null;
  checks_state?: string | null;
  [key: string]: unknown;
}

export interface AgentHint {
  slug?: string;
  issueNumber?: number;
  proposalId?: number;
  entry?: string;
}

async function json<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    const error = new Error(body.error || fallback) as Error & { status?: number; body?: unknown };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function request(path: string, init: RequestInit = {}) {
  return fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
  });
}

export async function createSession(hint: AgentHint | null): Promise<AgentSession> {
  const body = await json<{ session: AgentSession }>(
    await request('/api/agent-sessions', { method: 'POST', body: JSON.stringify(hint ? { hint } : {}) }),
    'Could not start an agent session.',
  );
  return body.session;
}

export async function listSessions(): Promise<AgentSession[]> {
  const body = await json<{ sessions: AgentSession[] }>(await request('/api/agent-sessions'), 'Could not load agent sessions.');
  return body.sessions || [];
}

export async function getSession(id: number): Promise<{ session: AgentSession; turn: AgentTurnState | null }> {
  return json(await request(`/api/agent-sessions/${id}`), 'Could not load this agent session.');
}

export async function getMessages(id: number, after = 0): Promise<{ messages: AgentMessage[]; nextAfter: number | null }> {
  return json(await request(`/api/agent-sessions/${id}/messages?after=${after}&limit=200`), 'Could not load the conversation.');
}

export async function getActions(id: number): Promise<AgentAction[]> {
  const body = await json<{ actions: AgentAction[] }>(await request(`/api/agent-sessions/${id}/actions`), 'Could not load confirmations.');
  return body.actions || [];
}

export async function confirmAction(id: number, actionId: string) {
  return json<{ status: string; result: AgentAction['result']; followUp: { turnId: string } | null }>(
    await request(`/api/agent-sessions/${id}/actions/${encodeURIComponent(actionId)}/confirm`, { method: 'POST' }),
    'That confirmation did not go through.',
  );
}

export async function dismissAction(id: number, actionId: string) {
  return json<{ ok: boolean }>(
    await request(`/api/agent-sessions/${id}/actions/${encodeURIComponent(actionId)}/dismiss`, { method: 'POST' }),
    'Could not dismiss that confirmation.',
  );
}

export async function switchChange(id: number, changeId: number): Promise<AgentSession> {
  const body = await json<{ session: AgentSession }>(
    await request(`/api/agent-sessions/${id}/active-change`, { method: 'POST', body: JSON.stringify({ changeId }) }),
    'Could not switch to that change.',
  );
  return body.session;
}

export async function stopTurn(id: number): Promise<{ stopped: boolean; reason?: string; changeId?: number | null }> {
  const body = await json<{ stopped: boolean; reason?: string; changeId?: number | null }>(
    await request(`/api/agent-sessions/${id}/stop`, { method: 'POST' }),
    'Could not stop the Mayor.',
  );
  // A running build belongs to its change: that change's own stop route
  // confirms the kill (and escalates), as it does from a classic session.
  if (!body.stopped && body.reason === 'dispatch_running' && body.changeId) {
    await request(`/api/sessions/${body.changeId}/stop`, { method: 'POST', body: '{}' }).catch(() => null);
  }
  return body;
}

export async function getChange(changeId: number): Promise<ChangeDetail | null> {
  const response = await request(`/api/sessions/${changeId}`);
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { session?: ChangeDetail } | ChangeDetail | null;
  if (!body) return null;
  return (body as { session?: ChangeDetail }).session || (body as ChangeDetail);
}

/**
 * Read a server-sent event stream from a fetch response. The agent turn
 * writes `data: {json}` frames whose JSON carries its own `type`; an
 * `event:` line, when present, names it instead.
 */
export async function readEventStream(
  response: Response,
  onEvent: (event: AgentTurnEvent) => void,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];
  const dispatch = () => {
    if (!dataLines.length) { eventName = ''; return; }
    try {
      const parsed = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
      onEvent({ ...parsed, type: eventName || String(parsed.type || 'message') });
    } catch {
      // A malformed frame is dropped rather than rendered.
    }
    eventName = '';
    dataLines = [];
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : (lines.pop() || '');
    for (const line of lines) {
      if (!line) dispatch();
      else if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (done) break;
  }
  if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart());
  dispatch();
}

/** POST a turn and stream its events. Throws with the server's answer when it refuses. */
export async function sendTurn(
  id: number,
  message: string,
  { signal, onEvent }: { signal?: AbortSignal; onEvent: (event: AgentTurnEvent) => void },
): Promise<void> {
  const response = await fetch(`/api/agent-sessions/${id}/turns`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message }),
    signal,
  });
  if (!response.ok) {
    await json(response, 'The Mayor could not take that message.');
    return;
  }
  await readEventStream(response, onEvent);
}
