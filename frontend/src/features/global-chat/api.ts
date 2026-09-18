import type {
  GlobalChatBootstrap,
  GlobalChatMessagePage,
  GlobalChatModelCatalog,
  GlobalChatPresentation,
  GlobalChatProfile,
  GlobalChatResult,
  GlobalChatThread,
  GlobalChatTurnEvent,
  GlobalChatUsage,
} from './types';

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

export async function bootstrap(signal?: AbortSignal): Promise<GlobalChatBootstrap> {
  return json(await fetch('/api/global-chat/bootstrap', {
    credentials: 'same-origin', cache: 'no-store', signal,
  }));
}

export async function messages(
  threadId: string,
  options: { before?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<GlobalChatMessagePage> {
  const query = new URLSearchParams();
  if (options.before) query.set('before', options.before);
  if (options.limit) query.set('limit', String(options.limit));
  const suffix = query.size ? `?${query.toString()}` : '';
  return json(await fetch(`/api/global-chat/threads/${encodeURIComponent(threadId)}/messages${suffix}`, {
    credentials: 'same-origin', cache: 'no-store', signal: options.signal,
  }));
}

export async function createThread(): Promise<{
  thread: GlobalChatThread;
  firstUse: GlobalChatPresentation;
}> {
  return json(await fetch('/api/global-chat/threads', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
  }));
}

export async function confirmAction(
  token: string,
  threadId: string,
  client: Record<string, string>,
): Promise<{
  ok: true;
  presentation: GlobalChatPresentation;
  results: GlobalChatResult[];
  message: unknown;
}> {
  return json(await fetch(`/api/global-chat/actions/${encodeURIComponent(token)}/confirm`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, client }),
  }));
}

export async function profile(signal?: AbortSignal): Promise<{
  profile: GlobalChatProfile;
  usage: GlobalChatUsage;
}> {
  return json(await fetch('/api/me/global-chat', {
    credentials: 'same-origin', cache: 'no-store', signal,
  }));
}

export async function models(
  reasoningEffort: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<GlobalChatModelCatalog> {
  const query = new URLSearchParams({ reasoningEffort });
  if (options.refresh) query.set('refresh', '1');
  return json(await fetch(`/api/me/global-chat/models?${query.toString()}`, {
    credentials: 'same-origin', cache: 'no-store', signal: options.signal,
  }));
}

export async function saveProfile(patch: Partial<Pick<
  GlobalChatProfile,
  'model' | 'reasoningEffort' | 'spendCapUsd'
>>): Promise<{ profile: GlobalChatProfile; usage: GlobalChatUsage }> {
  return json(await fetch('/api/me/global-chat', {
    method: 'PATCH',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }));
}

export async function usage(signal?: AbortSignal): Promise<{
  globalChat: GlobalChatUsage;
  overallAllowance: {
    configured: boolean;
    limitUsd?: number | null;
    remainingUsd?: number | null;
    spentUsd?: number | null;
    reset?: string | null;
  };
}> {
  return json(await fetch('/api/me/global-chat/usage', {
    credentials: 'same-origin', cache: 'no-store', signal,
  }));
}

function clientMetadata() {
  const native = (window as unknown as { usernode?: { isNative?: boolean; platform?: string } }).usernode;
  let surface = 'web';
  if (native?.isNative) surface = /android/i.test(native.platform || '') ? 'native_android' : 'native_ios';
  return {
    surface,
    viewport: window.matchMedia('(max-width: 767px)').matches ? 'compact' : 'regular',
    classicReturnPath: window.location.hash || '#home',
  };
}

function runtimeContext() {
  const app = window.App;
  const globals = window as unknown as {
    Theme?: { get?: () => string };
    DevAlerts?: { enabled?: () => boolean };
    DevConsole?: { getMode?: () => string };
  };
  const theme = globals.Theme?.get?.();
  const devAlerts = globals.DevAlerts?.enabled?.();
  const devConsoleMode = globals.DevConsole?.getMode?.();
  let adminPreview = false;
  try { adminPreview = localStorage.getItem('viewAsNonAdmin') === '1'; } catch {}
  return {
    locale: navigator.language || 'en',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    ...(app?.currentApp ? { activeAppSlug: app.currentApp } : {}),
    clientSettings: {
      ...(['system', 'light', 'dark'].includes(theme || '') ? { theme } : {}),
      ...(typeof devAlerts === 'boolean'
        ? { devAlerts }
        : {}),
      ...(['always', 'errors-only'].includes(devConsoleMode || '') ? { devConsoleMode } : {}),
      adminPreview,
    },
  };
}

/** Parse an SSE response without relying on EventSource, which cannot POST. */
export async function streamTurn({
  threadId,
  text,
  more = false,
  topic,
  signal,
  onEvent,
}: {
  threadId: string;
  text?: string;
  more?: boolean;
  topic?: string;
  signal?: AbortSignal;
  onEvent: (event: GlobalChatTurnEvent) => void;
}): Promise<void> {
  const endpoint = more
    ? `/api/global-chat/threads/${encodeURIComponent(threadId)}/more-suggestions`
    : `/api/global-chat/threads/${encodeURIComponent(threadId)}/turns`;
  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(more
      ? { topic: topic || undefined, client: clientMetadata(), context: runtimeContext() }
      : { text, client: clientMetadata(), context: runtimeContext() }),
    signal,
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Global Chat request failed (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  function dispatch() {
    if (!dataLines.length) { eventName = 'message'; return; }
    try {
      const parsed = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
      onEvent({ type: eventName, ...parsed });
    } catch {
      // A malformed server event is ignored instead of becoming executable UI.
    }
    eventName = 'message';
    dataLines = [];
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : (lines.pop() || '');
    for (const line of lines) {
      if (!line) dispatch();
      else if (line.startsWith('event:')) eventName = line.slice(6).trim() || 'message';
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (done) break;
  }
  if (buffer) {
    if (buffer.startsWith('event:')) eventName = buffer.slice(6).trim() || 'message';
    else if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart());
  }
  dispatch();
}

export { clientMetadata };
