import { useSyncExternalStore } from 'react';

import * as api from './api';
import type {
  GlobalChatBootstrap,
  GlobalChatMessage,
  GlobalChatPresentation,
  GlobalChatProgress,
  GlobalChatProgressOperation,
  GlobalChatResult,
  GlobalChatThread,
  GlobalChatSuggestion,
} from './types';

type Phase = 'idle' | 'booting' | 'loading' | 'ready' | 'sending' | 'error';

type RetryRequest =
  | { kind: 'turn'; text: string }
  | { kind: 'more'; text: string; topic?: string }
  | {
    kind: 'direct';
    label: string;
    suggestionId?: string;
    actionId?: string;
    parameters?: Record<string, string>;
    targetLabel?: string;
  };

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
  retryRequest: RetryRequest | null;
  activity: string;
  progress: GlobalChatProgress | null;
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
  retryRequest: null,
  activity: '',
  progress: null,
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

function eventString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function eventNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function progressOperations(value: unknown): GlobalChatProgressOperation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const toolCallId = eventString(item.toolCallId);
    const capabilityId = eventString(item.capabilityId);
    const title = eventString(item.title);
    if (!toolCallId || !capabilityId || !title) return [];
    return [{
      toolCallId,
      capabilityId,
      title,
      risk: eventString(item.risk) || undefined,
      status: 'planned' as const,
    }];
  });
}

function applyProgressEvent(event: Record<string, unknown>) {
  publish((current) => {
    const existing = current.progress || {
      phase: 'understanding',
      message: 'Understanding your request…',
      model: null,
      reasoningEffort: null,
      elapsedMs: 0,
      startedAt: Date.now(),
      steps: [],
      operations: [],
    };
    const phase = eventString(event.phase, existing.phase);
    const message = eventString(event.message, existing.message);
    const elapsedMs = eventNumber(event.elapsedMs, existing.elapsedMs);
    const last = existing.steps.at(-1);
    const steps = last?.phase === phase && last.message === message
      ? existing.steps
      : [...existing.steps, { phase, message, elapsedMs }].slice(-12);
    const announced = progressOperations(event.operations);
    return {
      activity: message,
      progress: {
        ...existing,
        phase,
        message,
        elapsedMs,
        model: eventString(event.model) || existing.model,
        reasoningEffort: eventString(event.reasoningEffort) || existing.reasoningEffort,
        attempt: eventNumber(event.attempt, existing.attempt || 1),
        steps,
        operations: announced.length ? announced : existing.operations,
      },
    };
  });
}

function applyToolProgress(event: Record<string, unknown>, status: GlobalChatProgressOperation['status']) {
  const toolCallId = eventString(event.toolCallId);
  const capabilityId = eventString(event.capabilityId);
  if (!toolCallId || !capabilityId) return;
  publish((current) => {
    if (!current.progress) return {};
    const existing = current.progress.operations.find((item) => item.toolCallId === toolCallId);
    const operation: GlobalChatProgressOperation = {
      toolCallId,
      capabilityId,
      title: eventString(event.title, existing?.title || capabilityId),
      risk: existing?.risk,
      status,
      ...(eventNumber(event.durationMs) ? { durationMs: eventNumber(event.durationMs) } : {}),
    };
    const operations = current.progress.operations.some((item) => item.toolCallId === toolCallId)
      ? current.progress.operations.map((item) => item.toolCallId === toolCallId ? operation : item)
      : [...current.progress.operations, operation];
    return { progress: { ...current.progress, operations } };
  });
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

function numericMessageId(value: string | null | undefined): bigint {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function lastPersistedMessageId(messages: GlobalChatMessage[]) {
  return messages.reduce((latest, message) => {
    const id = numericMessageId(message.id);
    return id > latest ? id : latest;
  }, 0n);
}

function shownSuggestionIds() {
  const ids = new Set<string>();
  for (const suggestion of state.bootstrap?.firstUse.suggestions || []) ids.add(suggestion.id);
  for (const message of state.messages) {
    const presentation = message.payload?.presentation as GlobalChatPresentation | undefined;
    for (const suggestion of presentation?.suggestions || []) ids.add(suggestion.id);
  }
  return [...ids];
}

function mergePersistedMessages(current: GlobalChatMessage[], incoming: GlobalChatMessage[]) {
  const withoutOptimistic = current.filter((message) => !message.pending);
  const ids = new Set(withoutOptimistic.map((message) => message.id));
  return [
    ...withoutOptimistic,
    ...incoming.filter((message) => !ids.has(message.id)),
  ];
}

async function recoverInterruptedTurn(
  threadId: string,
  afterMessageId: bigint,
  signal: AbortSignal,
  retryRequest: RetryRequest,
) {
  const deadline = Date.now() + 55_000;
  let inactivePolls = 0;
  const restore = (page: Awaited<ReturnType<typeof api.messages>>) => {
    if (state.bootstrap?.thread?.id !== threadId) return false;
    const newer = page.messages.filter(
      (message) => numericMessageId(message.id) > afterMessageId,
    );
    const assistant = [...newer].reverse().find((message) => message.role === 'assistant');
    if (!assistant) return false;
    const failed = assistant.payload?.kind === 'turn_error'
      || assistant.payload?.kind === 'direct_action_error';
    publish((current) => current.bootstrap?.thread?.id === threadId
      ? {
        phase: failed ? 'error' : 'ready',
        activity: '',
        progress: null,
        error: failed ? assistant.text : '',
        retryRequest: failed ? retryRequest : null,
        messages: mergePersistedMessages(current.messages, newer),
        results: resultsById(page.results, current.results),
      }
      : {});
    return true;
  };
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const page = await api.messages(threadId, { limit: 20, signal });
      if (restore(page)) return true;
      const status = await api.turnStatus(threadId, signal);
      if (!status.active) {
        // Close the race where the assistant is committed after the first
        // message read but immediately before the lease is released. Two
        // inactive samples also cover a disconnect just before claimTurn.
        const finalPage = await api.messages(threadId, { limit: 20, signal });
        if (restore(finalPage)) return true;
        inactivePolls += 1;
        if (inactivePolls >= 2) return false;
      } else {
        inactivePolls = 0;
      }
    } catch (error) {
      if (signal.aborted) return false;
      // A short network interruption is exactly why this recovery path
      // exists. Keep polling until the durable turn completes or times out.
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return false;
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
    retryRequest: null,
    progress: null,
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
      retryRequest: null,
      progress: null,
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
  publish({
    open: true,
    phase: state.bootstrap ? 'loading' : 'booting',
    error: '',
    retryRequest: null,
  });
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
      void api.cancelTurn(previousThreadId).catch(() => {});
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
  const activeThreadId = activeAbort ? state.bootstrap?.thread?.id : null;
  navigationVersion += 1;
  if (activeAbort) activeAbort.abort();
  activeAbort = null;
  if (activeThreadId) void api.cancelTurn(activeThreadId).catch(() => {});
  publish({
    open: false,
    phase: state.bootstrap ? 'ready' : 'idle',
    activity: '',
    progress: null,
    error: '',
    retryRequest: null,
  });
}

export function closeGlobalChat(classicPath?: string | null) {
  deactivateGlobalChat();

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
  // Curated More pages are zero-model server actions and remain useful before
  // an OpenRouter key is configured. Once those pages are exhausted, the
  // server returns the normal model-unavailable explanation for generated
  // suggestions. Free-form turns still require a configured model up front.
  if (!boot.available && !more) {
    publish({ error: 'Add or claim an OpenRouter key in Settings to use Global Chat.' });
    return;
  }
  const messageBoundary = lastPersistedMessageId(state.messages);
  const retryRequest: RetryRequest = more
    ? { kind: 'more', text, ...(topic ? { topic } : {}) }
    : { kind: 'turn', text };
  appendOptimisticUser(more ? 'More suggestions' : text);
  const controller = new AbortController();
  activeAbort = controller;
  publish({
    phase: 'sending',
    activity: more ? 'Loading options…' : 'Thinking…',
    progress: more ? null : {
      phase: 'understanding',
      message: 'Understanding your request…',
      model: boot.profiles.globalChat.model,
      reasoningEffort: boot.profiles.globalChat.reasoningEffort,
      elapsedMs: 0,
      startedAt: Date.now(),
      steps: [{
        phase: 'understanding',
        message: 'Understanding your request…',
        elapsedMs: 0,
      }],
      operations: [],
    },
    error: '',
    retryRequest: null,
  });
  let completed = false;
  try {
    await api.streamTurn({
      threadId: thread.id,
      text,
      more,
      topic,
      shownSuggestionIds: more ? shownSuggestionIds() : undefined,
      signal: controller.signal,
      onEvent(event) {
        if (event.type === 'turn.progress') {
          applyProgressEvent(event);
        } else if (event.type === 'tool.started') {
          applyToolProgress(event, 'running');
          publish((current) => current.bootstrap?.thread?.id === thread.id
            ? { activity: eventString(event.title, 'Working…') }
            : {});
        } else if (event.type === 'tool.completed') {
          applyToolProgress(event, event.status === 'failed' ? 'failed' : 'completed');
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
              progress: null,
              messages: [
                ...current.messages.map((item) => item.pending ? { ...item, pending: false } : item),
                assistant,
              ],
            }
            : {});
        } else if (event.type === 'turn.failed') {
          completed = true;
          const message = typeof event.message === 'string' ? event.message : 'That request could not be completed.';
          const assistantMessage = event.assistantMessage as GlobalChatMessage | null | undefined;
          publish((current) => current.bootstrap?.thread?.id === thread.id
            ? {
              phase: 'error',
              activity: '',
              progress: null,
              error: message,
              retryRequest,
              messages: [
                ...current.messages.map((item) => item.pending ? { ...item, pending: false } : item),
                ...(assistantMessage ? [assistantMessage] : []),
              ],
            }
            : {});
        }
      },
    });
    if (!completed && !controller.signal.aborted) {
      publish((current) => current.bootstrap?.thread?.id === thread.id
        ? { activity: 'Reconnecting…', progress: current.progress ? {
          ...current.progress,
          phase: 'reconnecting',
          message: 'Reconnecting to the saved turn…',
        } : null }
        : {});
      completed = await recoverInterruptedTurn(
        thread.id, messageBoundary, controller.signal, retryRequest,
      );
      if (!completed && !controller.signal.aborted) {
        publish((current) => current.bootstrap?.thread?.id === thread.id
          ? {
            phase: 'error',
            activity: '',
            progress: null,
            error: 'The connection was interrupted before an answer was saved. Please try again.',
            retryRequest,
            messages: current.messages.map((item) => item.pending ? { ...item, pending: false } : item),
          }
          : {});
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      publish((current) => current.bootstrap?.thread?.id === thread.id
        ? {
          phase: 'ready',
          activity: '',
          progress: null,
          messages: current.messages.map((item) => item.pending ? { ...item, pending: false } : item),
        }
        : {});
    } else if (!completed) {
      // A broken fetch/read rejects instead of reaching the clean-EOF branch
      // above, but the server may still be finishing the same durable turn.
      // Recover it in exactly the same way before showing a retry error.
      publish((current) => current.bootstrap?.thread?.id === thread.id
        ? { activity: 'Reconnecting…', progress: current.progress ? {
          ...current.progress,
          phase: 'reconnecting',
          message: 'Reconnecting to the saved turn…',
        } : null }
        : {});
      completed = await recoverInterruptedTurn(
        thread.id, messageBoundary, controller.signal, retryRequest,
      );
      if (!completed && !controller.signal.aborted) {
        publish((current) => current.bootstrap?.thread?.id === thread.id
          ? {
            phase: 'error',
            activity: '',
            progress: null,
            error: errorText(error),
            retryRequest,
            messages: current.messages.map((item) => item.pending ? { ...item, pending: false } : item),
          }
          : {});
      }
    }
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

async function runDirectAction({
  label,
  suggestionId,
  actionId,
  parameters,
  targetLabel,
}: {
  label: string;
  suggestionId?: string;
  actionId?: string;
  parameters?: Record<string, string>;
  targetLabel?: string;
}) {
  const boot = state.bootstrap || await initializeGlobalChat();
  if (!boot || state.phase === 'sending') return;
  const thread = boot.thread;
  if (!boot.profiles.globalChat.enabled || !thread) {
    publish({ error: 'Enable experimental Global Chat in Settings first.' });
    return;
  }
  const messageBoundary = lastPersistedMessageId(state.messages);
  const retryRequest: RetryRequest = {
    kind: 'direct',
    label,
    ...(suggestionId ? { suggestionId } : {}),
    ...(actionId ? { actionId } : {}),
    ...(parameters ? { parameters } : {}),
    ...(targetLabel ? { targetLabel } : {}),
  };
  appendOptimisticUser(label);
  const controller = new AbortController();
  activeAbort = controller;
  publish({
    phase: 'sending', activity: 'Loading…', progress: null, error: '', retryRequest: null,
  });
  try {
    const response = await api.executeDirectAction(thread.id, {
      ...(suggestionId ? { suggestionId } : { actionId }),
      parameters,
      targetLabel,
      shownSuggestionIds: shownSuggestionIds(),
    }, controller.signal);
    publish((current) => current.bootstrap?.thread?.id === thread.id
      ? {
        phase: 'ready',
        activity: '',
        error: '',
        retryRequest: null,
        messages: mergePersistedMessages(current.messages, [
          response.userMessage,
          response.message,
        ]),
        results: resultsById(response.results, current.results),
      }
      : {});
  } catch (error) {
    if (controller.signal.aborted) {
      publish((current) => current.bootstrap?.thread?.id === thread.id
        ? {
          phase: 'ready',
          activity: '',
          messages: current.messages.map((item) => item.pending ? { ...item, pending: false } : item),
        }
        : {});
    } else {
      publish((current) => current.bootstrap?.thread?.id === thread.id
        ? { activity: 'Reconnecting…' }
        : {});
      const recovered = await recoverInterruptedTurn(
        thread.id,
        messageBoundary,
        controller.signal,
        retryRequest,
      );
      if (!recovered && !controller.signal.aborted) {
        publish((current) => current.bootstrap?.thread?.id === thread.id
          ? {
            phase: 'error',
            activity: '',
            error: errorText(error, 'That direct action could not be completed.'),
            retryRequest,
            messages: current.messages.map((item) => item.pending ? { ...item, pending: false } : item),
          }
          : {});
      }
    }
  } finally {
    if (activeAbort === controller) activeAbort = null;
    setThreadBusy(thread.id, false);
    void refreshGlobalChatThreads();
    void refreshGlobalChatUsage();
  }
}

export async function selectGlobalChatSuggestion(suggestion: GlobalChatSuggestion) {
  if (suggestion.actionId) {
    await runDirectAction(suggestion.parameters || suggestion.targetLabel
      ? {
        label: suggestion.label,
        actionId: suggestion.actionId,
        parameters: suggestion.parameters,
        targetLabel: suggestion.targetLabel || undefined,
      }
      : { label: suggestion.label, suggestionId: suggestion.id });
    return;
  }
  await sendGlobalChatMessage(suggestion.prompt);
}

export async function executeGlobalChatResultAction(
  label: string,
  actionId: string,
  parameters: Record<string, string>,
  targetLabel?: string,
) {
  await runDirectAction({ label, actionId, parameters, targetLabel });
}

export async function loadGlobalChatInlineResults(
  actionId: string,
  parameters: Record<string, string>,
  targetLabel?: string,
) {
  const threadId = state.bootstrap?.thread?.id;
  if (!threadId) throw new Error('Open a Global Chat first.');
  const response = await api.executeInlineAction(threadId, {
    actionId,
    parameters,
    targetLabel,
  });
  return response.results;
}

export async function requestMoreSuggestions(topic?: string) {
  await runTurn({ text: 'More suggestions', more: true, topic });
}

export async function retryLastGlobalChatRequest() {
  const request = state.retryRequest;
  if (!request) {
    await openGlobalChat();
    return;
  }
  publish({ error: '', retryRequest: null });
  if (request.kind === 'direct') {
    await runDirectAction(request);
    return;
  }
  await runTurn({
    text: request.text,
    more: request.kind === 'more',
    ...(request.kind === 'more' && request.topic ? { topic: request.topic } : {}),
  });
}

export function stopGlobalChatTurn() {
  const threadId = activeAbort ? state.bootstrap?.thread?.id : null;
  activeAbort?.abort();
  activeAbort = null;
  if (threadId) void api.cancelTurn(threadId).catch(() => {});
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
  const activeThreadId = activeAbort ? state.bootstrap?.thread?.id : null;
  if (activeAbort) activeAbort.abort();
  activeAbort = null;
  if (activeThreadId) void api.cancelTurn(activeThreadId).catch(() => {});
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

export async function removeGlobalChatThread(threadId: string) {
  const target = state.threads.find((thread) => thread.id === threadId) || null;
  const selected = state.bootstrap?.thread?.id === threadId;
  const wasOpen = state.open;
  const hadLocalTurn = selected && !!activeAbort;

  if (selected) {
    navigationVersion += 1;
    activeAbort?.abort();
    activeAbort = null;
  }
  if (target?.busy || hadLocalTurn) {
    await api.cancelTurn(threadId).catch(() => {});
  }
  await api.deleteThread(threadId);

  const remaining = state.threads.filter((thread) => thread.id !== threadId);
  const nextThread = selected
    ? remaining[0] || null
    : state.bootstrap?.thread || remaining[0] || null;
  if (loadedThreadId === threadId) loadedThreadId = null;
  publish((current) => ({
    threads: remaining,
    ...(selected ? {
      phase: wasOpen && nextThread ? 'loading' : 'ready',
      messages: [],
      results: {},
      hasMoreHistory: false,
      before: null,
      activity: '',
      error: '',
      dismissedConfirmations: {},
      consumedConfirmations: {},
      clientActionStates: {},
    } : {}),
    bootstrap: current.bootstrap
      ? { ...current.bootstrap, thread: nextThread, threads: remaining }
      : current.bootstrap,
  }));

  if (!selected || !wasOpen) return;
  if (!nextThread) {
    closeGlobalChat();
    return;
  }
  window.location.hash = `#chat/${encodeURIComponent(nextThread.id)}`;
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
