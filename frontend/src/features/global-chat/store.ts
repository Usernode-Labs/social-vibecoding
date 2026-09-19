import { useSyncExternalStore } from 'react';

import * as api from './api';
import type {
  GlobalChatBootstrap,
  GlobalChatMessage,
  GlobalChatPresentation,
  GlobalChatResult,
  GlobalChatThread,
} from './types';

type Phase = 'idle' | 'booting' | 'loading' | 'ready' | 'sending' | 'error';

export interface GlobalChatState {
  open: boolean;
  phase: Phase;
  bootstrap: GlobalChatBootstrap | null;
  threads: GlobalChatThread[];
  messages: GlobalChatMessage[];
  results: Record<string, GlobalChatResult>;
  hasMoreHistory: boolean;
  before: string | null;
  error: string;
  activity: string;
  overallAllowance: {
    configured: boolean;
    limitUsd?: number | null;
    remainingUsd?: number | null;
    spentUsd?: number | null;
    reset?: string | null;
  } | null;
  dismissedConfirmations: Record<string, true>;
  consumedConfirmations: Record<string, true>;
  clientActionStates: Record<string, 'running' | 'done' | 'error'>;
}

const INITIAL_STATE: GlobalChatState = {
  open: false,
  phase: 'idle',
  bootstrap: null,
  threads: [],
  messages: [],
  results: {},
  hasMoreHistory: false,
  before: null,
  error: '',
  activity: '',
  overallAllowance: null,
  dismissedConfirmations: {},
  consumedConfirmations: {},
  clientActionStates: {},
};

let state = INITIAL_STATE;
const listeners = new Set<() => void>();
let bootstrapPromise: Promise<GlobalChatBootstrap | null> | null = null;
let loadedThreadId: string | null = null;
let activeAbort: AbortController | null = null;
let navigationVersion = 0;

function publish(next: Partial<GlobalChatState> | ((current: GlobalChatState) => Partial<GlobalChatState>)) {
  const patch = typeof next === 'function' ? next(state) : next;
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function resultsById(results: GlobalChatResult[], current = state.results) {
  const next = { ...current };
  for (const result of results || []) if (result?.id) next[result.id] = result;
  return next;
}

function errorText(error: unknown, fallback = 'Global Chat could not complete that request.') {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useGlobalChatState() {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL_STATE);
}

export function getGlobalChatState() {
  return state;
}

export async function initializeGlobalChat({ force = false } = {}): Promise<GlobalChatBootstrap | null> {
  if (state.bootstrap && !force) return state.bootstrap;
  if (bootstrapPromise && !force) return bootstrapPromise;
  publish({ phase: state.open ? 'booting' : state.phase, error: '' });
  bootstrapPromise = api.bootstrap().then((value) => {
    const selected = state.open && state.bootstrap?.thread
      ? value.threads.find((thread) => thread.id === state.bootstrap?.thread?.id)
        || state.bootstrap.thread
      : value.thread;
    const next = { ...value, thread: selected };
    publish({
      bootstrap: next,
      threads: value.threads,
      phase: state.open ? 'loading' : 'idle',
    });
    return next;
  }).catch((error) => {
    // A boot-time 401 is expected before app.js has established the session.
    // sv:authed retries it; keep Classic untouched and do not surface a dead
    // feature error in the header.
    if (state.open) publish({ phase: 'error', error: errorText(error, 'Global Chat is unavailable.') });
    return null;
  }).finally(() => {
    bootstrapPromise = null;
  });
  return bootstrapPromise;
}

function mergeThread(
  threads: GlobalChatThread[],
  thread: GlobalChatThread,
  { first = false } = {},
): GlobalChatThread[] {
  const existing = threads.findIndex((item) => item.id === thread.id);
  if (existing < 0) return first ? [thread, ...threads] : [...threads, thread];
  const next = [...threads];
  next[existing] = thread;
  if (!first || existing === 0) return next;
  next.splice(existing, 1);
  return [thread, ...next];
}

function selectThread(thread: GlobalChatThread, { first = false } = {}) {
  publish((current) => {
    const threads = mergeThread(current.threads, thread, { first });
    return {
      threads,
      bootstrap: current.bootstrap
        ? { ...current.bootstrap, thread, threads }
        : current.bootstrap,
    };
  });
}

async function loadThread(thread: GlobalChatThread, version: number) {
  if (loadedThreadId === thread.id) {
    if (version === navigationVersion) publish({ phase: 'ready', error: '' });
    return;
  }
  publish({
    phase: 'loading',
    messages: [],
    results: {},
    hasMoreHistory: false,
    before: null,
    error: '',
  });
  try {
    const page = await api.messages(thread.id, { limit: 40 });
    if (version !== navigationVersion
        || state.bootstrap?.thread?.id !== thread.id) return;
    loadedThreadId = thread.id;
    publish({
      phase: 'ready',
      messages: page.messages,
      results: resultsById(page.results, {}),
      hasMoreHistory: page.hasMore,
      before: page.before,
      error: '',
    });
  } catch (error) {
    if (version !== navigationVersion
        || state.bootstrap?.thread?.id !== thread.id) return;
    publish({ phase: 'error', error: errorText(error, 'Could not load this chat.') });
  }
}

/**
 * Resolve a durable chat route. The shell owns visibility and history; this
 * store owns the selected thread and its transcript. A bare #chat resumes the
 * most recent session (or creates the first one), while #chat/<uuid> resolves
 * that exact owned thread so reloads and copied links are stable.
 */
export async function openGlobalChat({ threadId = null }: {
  threadId?: string | null;
} = {}) {
  const version = ++navigationVersion;
  publish({ open: true, phase: state.bootstrap ? 'loading' : 'booting', error: '' });
  const boot = await initializeGlobalChat();
  if (version !== navigationVersion) return;
  if (!boot?.profiles.globalChat.enabled) {
    publish({ phase: 'ready' });
    return;
  }
  try {
    let thread = threadId
      ? state.threads.find((item) => item.id === threadId) || null
      : boot.thread;
    if (threadId && !thread) thread = (await api.thread(threadId)).thread;
    if (version !== navigationVersion) return;
    if (!thread) {
      const created = await api.createThread();
      if (version !== navigationVersion) return;
      thread = created.thread;
      if (state.bootstrap) {
        publish((current) => ({
          bootstrap: current.bootstrap
            ? { ...current.bootstrap, firstUse: created.firstUse }
            : current.bootstrap,
        }));
      }
    }
    const previousThreadId = state.bootstrap?.thread?.id;
    if (previousThreadId && previousThreadId !== thread.id && activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    selectThread(thread, { first: !state.threads.some((item) => item.id === thread.id) });
    if (window.location.hash === '#chat') {
      try {
        history.replaceState(null, '', `#chat/${encodeURIComponent(thread.id)}`);
      } catch { /* the selected session still works without canonicalising */ }
    }
    await loadThread(thread, version);
  } catch (error) {
    if (version !== navigationVersion) return;
    publish({ phase: 'error', error: errorText(error, 'Could not load this chat.') });
  }
  if (version !== navigationVersion) return;
  void refreshGlobalChatUsage();
  requestAnimationFrame(() => document.getElementById('global-chat-composer')?.focus());
}

export function deactivateGlobalChat() {
  navigationVersion += 1;
  if (activeAbort) activeAbort.abort();
  activeAbort = null;
  publish({ open: false, phase: state.bootstrap ? 'ready' : 'idle', activity: '', error: '' });
}

export function closeGlobalChat(classicPath?: string | null) {
  navigationVersion += 1;
  if (activeAbort) activeAbort.abort();
  activeAbort = null;

  const aliases: Record<string, string> = {
    '#browse': '#apps',
    '#challenges': '#leaderboard/challenges',
    '#dev': '#workshop',
  };
  const requested = classicPath || '#home';
  const target = aliases[requested] || requested;
  requestAnimationFrame(() => {
    if (target === '#home') {
      window.App?.navigateHome?.();
      return;
    }
    if (!/^#[A-Za-z0-9][A-Za-z0-9_./?=&%-]*$/.test(target)) return;
    if (window.location.hash === target) {
      const restore = window.App?.restoreFromHash;
      if (typeof restore === 'function') restore.call(window.App);
    } else {
      window.location.hash = target;
    }
  });
}

function appendOptimisticUser(text: string) {
  const title = text.replace(/\s+/g, ' ').trim().slice(0, 120) || 'New chat';
  const message: GlobalChatMessage = {
    id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    threadId: state.bootstrap?.thread?.id || '',
    role: 'user',
    text,
    payload: { kind: 'local' },
    createdAt: new Date().toISOString(),
    pending: true,
  };
  publish((current) => {
    const selected = current.bootstrap?.thread;
    if (!selected) return { messages: [...current.messages, message] };
    const thread = {
      ...selected,
      title: selected.title === 'New chat' ? title : selected.title,
      busy: true,
      updatedAt: new Date().toISOString(),
    };
    const threads = mergeThread(current.threads, thread, { first: true });
    return {
      messages: [...current.messages, message],
      threads,
      bootstrap: current.bootstrap
        ? { ...current.bootstrap, thread, threads }
        : current.bootstrap,
    };
  });
}

function setThreadBusy(threadId: string, busy: boolean) {
  publish((current) => {
    const indexed = current.threads.find((thread) => thread.id === threadId);
    const selected = current.bootstrap?.thread?.id === threadId
      ? current.bootstrap.thread
      : null;
    const source = indexed || selected;
    if (!source) return {};
    const thread = { ...source, busy };
    const threads = mergeThread(current.threads, thread);
    return {
      threads,
      bootstrap: current.bootstrap
        ? {
          ...current.bootstrap,
          thread: selected ? thread : current.bootstrap.thread,
          threads,
        }
        : current.bootstrap,
    };
  });
}

async function runTurn({ text, more = false, topic }: {
  text: string;
  more?: boolean;
  topic?: string;
}) {
  const boot = state.bootstrap || await initializeGlobalChat();
  if (!boot || state.phase === 'sending') return;
  const thread = boot.thread;
  if (!boot.profiles.globalChat.enabled || !thread) {
    publish({ error: 'Enable experimental Global Chat in Settings first.' });
    return;
  }
  if (!boot.available) {
    publish({ error: 'Add or claim an OpenRouter key in Settings to use Global Chat.' });
    return;
  }
  appendOptimisticUser(more ? 'More suggestions' : text);
  const controller = new AbortController();
  activeAbort = controller;
  publish({ phase: 'sending', activity: 'Thinking…', error: '' });
  let completed = false;
  try {
    await api.streamTurn({
      threadId: thread.id,
      text,
      more,
      topic,
      signal: controller.signal,
      onEvent(event) {
        if (event.type === 'tool.started') {
          publish((current) => current.bootstrap?.thread?.id === thread.id
            ? { activity: 'Working…' }
            : {});
        } else if (event.type === 'confirmation.required') {
          publish((current) => current.bootstrap?.thread?.id === thread.id
            ? { activity: 'Preparing confirmation…' }
            : {});
        } else if (event.type === 'result.attached' && event.result) {
          const attached = event.result as GlobalChatResult;
          publish((current) => current.bootstrap?.thread?.id === thread.id
            ? { results: resultsById([attached], current.results) }
            : {});
          if (clientAction(attached)?.transport === 'local_setting') {
            void runGlobalChatClientAction(attached);
          }
        } else if (event.type === 'turn.completed') {
          completed = true;
          const message = event.message as GlobalChatMessage | undefined;
          const presentation = event.presentation as GlobalChatPresentation | undefined;
          const assistant: GlobalChatMessage = message || {
            id: `assistant-${Date.now()}`,
            threadId: thread.id,
            role: 'assistant',
            text: presentation?.message || '',
            payload: { kind: more ? 'more_suggestions' : 'user_turn', presentation },
            createdAt: new Date().toISOString(),
          };
          publish((current) => current.bootstrap?.thread?.id === thread.id
            ? {
              phase: 'ready',
              activity: '',
              messages: [
                ...current.messages.map((item) => item.pending ? { ...item, pending: false } : item),
                assistant,
              ],
            }
            : {});
        } else if (event.type === 'turn.failed') {
          completed = true;
          const message = typeof event.message === 'string' ? event.message : 'That request could not be completed.';
          publish((current) => current.bootstrap?.thread?.id === thread.id
            ? {
              phase: 'error',
              activity: '',
              error: message,
              messages: current.messages.map((item) => item.pending ? { ...item, pending: false } : item),
            }
            : {});
        }
      },
    });
    if (!completed && !controller.signal.aborted) {
      publish((current) => current.bootstrap?.thread?.id === thread.id
        ? {
          phase: 'error',
          activity: '',
          error: 'The response ended before it was complete.',
          messages: current.messages.map((item) => item.pending ? { ...item, pending: false } : item),
        }
        : {});
    }
  } catch (error) {
    publish((current) => current.bootstrap?.thread?.id === thread.id
      ? {
        phase: controller.signal.aborted ? 'ready' : 'error',
        activity: '',
        ...(controller.signal.aborted ? {} : { error: errorText(error) }),
        messages: current.messages.map((item) => item.pending ? { ...item, pending: false } : item),
      }
      : {});
  } finally {
    if (activeAbort === controller) activeAbort = null;
    setThreadBusy(thread.id, false);
    void refreshGlobalChatThreads();
    void refreshGlobalChatUsage();
  }
}

export async function sendGlobalChatMessage(text: string) {
  const value = text.trim();
  if (!value || value.length > 12_000) return;
  await runTurn({ text: value });
}

export async function requestMoreSuggestions(topic?: string) {
  await runTurn({ text: 'More suggestions', more: true, topic });
}

export function stopGlobalChatTurn() {
  activeAbort?.abort();
}

export async function loadOlderGlobalChatMessages() {
  const threadId = state.bootstrap?.thread?.id;
  if (!threadId || !state.before || state.phase === 'loading') return;
  publish({ phase: 'loading', error: '' });
  try {
    const page = await api.messages(threadId, { before: state.before, limit: 40 });
    if (state.bootstrap?.thread?.id !== threadId) return;
    publish((current) => ({
      phase: 'ready',
      messages: [...page.messages, ...current.messages],
      results: resultsById(page.results, current.results),
      hasMoreHistory: page.hasMore,
      before: page.before,
    }));
  } catch (error) {
    if (state.bootstrap?.thread?.id !== threadId) return;
    publish({ phase: 'error', error: errorText(error, 'Could not load earlier messages.') });
  }
}

export async function startNewGlobalChat() {
  const version = ++navigationVersion;
  if (activeAbort) activeAbort.abort();
  activeAbort = null;
  publish({ phase: 'loading', error: '' });
  try {
    const created = await api.createThread();
    if (version !== navigationVersion) {
      void refreshGlobalChatThreads();
      return;
    }
    loadedThreadId = created.thread.id;
    publish((current) => ({
      phase: 'ready',
      threads: mergeThread(current.threads, created.thread, { first: true }),
      bootstrap: current.bootstrap
        ? {
          ...current.bootstrap,
          thread: created.thread,
          threads: mergeThread(current.threads, created.thread, { first: true }),
          firstUse: created.firstUse,
        }
        : current.bootstrap,
      messages: [],
      results: {},
      hasMoreHistory: false,
      before: null,
      dismissedConfirmations: {},
      consumedConfirmations: {},
      clientActionStates: {},
    }));
    const target = `#chat/${encodeURIComponent(created.thread.id)}`;
    if (window.location.hash === target) {
      const restore = window.App?.restoreFromHash;
      if (typeof restore === 'function') restore.call(window.App);
    } else {
      window.location.hash = target;
    }
    requestAnimationFrame(() => document.getElementById('global-chat-composer')?.focus());
  } catch (error) {
    if (version !== navigationVersion) return;
    publish({ phase: 'error', error: errorText(error, 'Could not start a new chat.') });
  }
}

export function dismissConfirmation(resultId: string) {
  publish((current) => ({
    dismissedConfirmations: { ...current.dismissedConfirmations, [resultId]: true },
  }));
}

export async function confirmGlobalChatAction(result: GlobalChatResult, token: string) {
  const threadId = state.bootstrap?.thread?.id;
  if (!threadId || !token || state.consumedConfirmations[result.id]) return;
  publish({ activity: 'Applying…', error: '' });
  try {
    const response = await api.confirmAction(token, threadId, api.clientMetadata());
    publish((current) => current.bootstrap?.thread?.id === threadId
      ? {
        phase: 'ready',
        activity: '',
        consumedConfirmations: { ...current.consumedConfirmations, [result.id]: true },
        results: resultsById(response.results, current.results),
        messages: [...current.messages, response.message as GlobalChatMessage],
      }
      : {});
    const pending = response.results.find((item) => clientAction(item));
    if (pending) await runGlobalChatClientAction(pending);
  } catch (error) {
    publish((current) => current.bootstrap?.thread?.id === threadId
      ? {
        phase: 'error',
        activity: '',
        error: errorText(error, 'That action could not be completed.'),
      }
      : {});
  } finally {
    void refreshGlobalChatUsage();
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function clientAction(result: GlobalChatResult): Record<string, unknown> | null {
  const authoritative = object(result.authoritativeResult);
  const wrapped = object(authoritative?.data);
  const payload = object(wrapped?.data) || wrapped || authoritative;
  return payload?.state === 'client_action_required' ? object(payload.action) : null;
}

function clientActionUrl(action: Record<string, unknown>): string {
  const template = String(action.pathTemplate || '');
  if (!template.startsWith('/') || template.startsWith('//') || template.includes('://')) {
    throw new Error('That browser action is unavailable.');
  }
  const input = object(action.input) || {};
  const pathParameters = object(input.pathParameters) || {};
  const path = template.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, name: string) => {
    const value = pathParameters[name];
    if (value == null) throw new Error('That browser action is missing its target.');
    return encodeURIComponent(String(value));
  });
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error('That browser action is unavailable.');
  const query = Array.isArray(input.query) ? input.query : [];
  for (const entry of query) {
    const pair = object(entry);
    if (typeof pair?.name === 'string' && typeof pair.value === 'string') {
      url.searchParams.append(pair.name, pair.value);
    }
  }
  return `${url.pathname}${url.search}`;
}

async function drainResponse(body: ReadableStream<Uint8Array> | null) {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (!(await reader.read()).done) {
      // Development turns publish their durable progress through the existing
      // session channels. Draining only prevents response backpressure after
      // this surface has handed navigation back to the Classic session view.
    }
  } finally {
    reader.releaseLock();
  }
}

function applyLocalSetting(action: Record<string, unknown>) {
  const setting = String(action.setting || '');
  const value = action.value;
  const globals = window as unknown as {
    Theme?: { set?: (mode: string) => void };
    DevAlerts?: {
      setEnabled?: (enabled: boolean) => void;
      _unlockAudio?: () => void;
      requestNotifyPermission?: () => void;
    };
    DevConsole?: {
      setMode?: (mode: string) => void;
      MODE_ALWAYS?: string;
      MODE_ERRORS_ONLY?: string;
    };
  };
  if (setting === 'theme' && typeof value === 'string'
      && ['system', 'light', 'dark'].includes(value)) {
    globals.Theme?.set?.(value);
    return;
  }
  if (setting === 'devAlerts' && typeof value === 'boolean') {
    globals.DevAlerts?.setEnabled?.(value);
    if (value) {
      globals.DevAlerts?._unlockAudio?.();
      globals.DevAlerts?.requestNotifyPermission?.();
    }
    return;
  }
  if (setting === 'devConsoleMode' && typeof value === 'string'
      && ['always', 'errors-only'].includes(value)) {
    globals.DevConsole?.setMode?.(value === 'always'
      ? globals.DevConsole.MODE_ALWAYS || 'always'
      : globals.DevConsole.MODE_ERRORS_ONLY || 'errors-only');
    return;
  }
  if (setting === 'adminPreview' && typeof value === 'boolean') {
    if (value) localStorage.setItem('viewAsNonAdmin', '1');
    else localStorage.removeItem('viewAsNonAdmin');
    window.location.reload();
    return;
  }
  throw new Error('That local setting is unavailable.');
}

export async function runGlobalChatClientAction(result: GlobalChatResult) {
  const action = clientAction(result);
  if (!action || state.clientActionStates[result.id] === 'running') return;
  if (action.transport === 'navigation') {
    closeGlobalChat(result.classicPath);
    return;
  }
  publish((current) => ({
    clientActionStates: { ...current.clientActionStates, [result.id]: 'running' },
  }));
  try {
    if (action.transport === 'local_setting') {
      applyLocalSetting(action);
      publish((current) => ({
        clientActionStates: { ...current.clientActionStates, [result.id]: 'done' },
      }));
      return;
    }
    const url = clientActionUrl(action);
    const method = String(action.method || 'GET').toUpperCase();
    const transport = String(action.transport || '');
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      throw new Error('That browser action is unavailable.');
    }
    if (method === 'GET') {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else {
      const input = object(action.input) || {};
      const response = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input.body ?? {}),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `Action failed (${response.status}).`);
      }
      if (transport === 'development_handoff') {
        publish((current) => ({
          clientActionStates: { ...current.clientActionStates, [result.id]: 'done' },
        }));
        closeGlobalChat(result.classicPath || String(action.classicPath || '#workshop'));
        void drainResponse(response.body);
        return;
      }
      await response.json().catch(() => ({}));
    }
    publish((current) => ({
      clientActionStates: { ...current.clientActionStates, [result.id]: 'done' },
    }));
  } catch (error) {
    publish((current) => ({
      error: errorText(error, 'That browser action could not be completed.'),
      clientActionStates: { ...current.clientActionStates, [result.id]: 'error' },
    }));
  }
}

export async function refreshGlobalChatUsage() {
  if (!state.bootstrap) return;
  try {
    const current = await api.usage();
    publish((snapshot) => ({
      overallAllowance: current.overallAllowance,
      bootstrap: snapshot.bootstrap
        ? { ...snapshot.bootstrap, usage: current.globalChat }
        : snapshot.bootstrap,
    }));
  } catch {
    // Usage is an affordance, not a reason to fail an otherwise valid turn.
  }
}

export async function refreshGlobalChatThreads() {
  if (!state.bootstrap?.profiles.globalChat.enabled) return;
  try {
    const response = await api.threads();
    publish((current) => {
      const selectedId = current.bootstrap?.thread?.id;
      const selected = response.threads.find((thread) => thread.id === selectedId)
        || current.bootstrap?.thread
        || response.threads[0]
        || null;
      return {
        threads: response.threads,
        bootstrap: current.bootstrap
          ? { ...current.bootstrap, thread: selected, threads: response.threads }
          : current.bootstrap,
      };
    });
  } catch {
    // The transcript remains usable when its Improve index cannot refresh.
  }
}

export const globalChatController = {
  open: openGlobalChat,
  route: (threadId?: string | null) => openGlobalChat({ threadId }),
  close: closeGlobalChat,
  deactivate: deactivateGlobalChat,
  isOpen: () => state.open,
  send: sendGlobalChatMessage,
};

if (typeof window !== 'undefined') {
  const host = (window.UsernodeReact ||= {});
  host.globalChat = globalChatController;
}
