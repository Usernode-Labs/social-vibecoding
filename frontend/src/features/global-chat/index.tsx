import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  ArrowPathIcon,
  ArrowUpIcon,
  PlusIcon,
  SpinnerArcIcon,
  XIcon,
} from '@/components/ui/icons';

import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { GlobalChatResultBlock } from './renderers';
import {
  closeGlobalChat,
  globalChatComposerId,
  loadOlderGlobalChatMessages,
  openGlobalChat,
  requestMoreSuggestions,
  retryLastGlobalChatRequest,
  selectGlobalChatSuggestion,
  sendGlobalChatMessage,
  startNewGlobalChat,
  stopGlobalChatTurn,
  useGlobalChatState,
} from './store';
import type {
  GlobalChatItemSelection,
  GlobalChatMessage,
  GlobalChatPresentation,
  GlobalChatProgress,
  GlobalChatSuggestion,
} from './types';

function dollars(value: string | number | null | undefined) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return `$${amount < 0.01 && amount > 0 ? amount.toFixed(4) : amount.toFixed(2)}`;
}

function BudgetLabel() {
  const snapshot = useGlobalChatState();
  const usage = snapshot.bootstrap?.usage;
  if (!usage) return null;
  const spent = dollars(usage.spentUsd) || '$0.00';
  const cap = dollars(usage.capUsd);
  const remaining = dollars(snapshot.overallAllowance?.remainingUsd);
  return (
    <span className="global-chat-budget" title="Global Chat spend this month and overall OpenRouter allowance">
      Chat {spent}{cap ? ` / ${cap}` : ''}{remaining ? ` · ${remaining} left` : ''}
    </span>
  );
}

function TurnProgress({ progress }: { progress: GlobalChatProgress }) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsedMs = Math.max(progress.elapsedMs, clock - progress.startedAt);
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return (
    <section className="global-chat-progress" aria-label="Global Chat progress">
      <div className="global-chat-progress-current">
        <SpinnerArcIcon className="w-4 h-4 animate-spin" aria-hidden="true" />
        <span>{progress.message}</span>
        <time>{seconds}s</time>
      </div>
      <details>
        <summary>Activity</summary>
        <div className="global-chat-progress-details">
          {progress.model ? <p>Model: {progress.model}</p> : null}
          {progress.reasoningEffort ? <p>Reasoning: {progress.reasoningEffort} effort</p> : null}
          {progress.attempt && progress.attempt > 1 ? <p>Attempt: {progress.attempt}</p> : null}
          {progress.steps.length ? (
            <ol>
              {progress.steps.map((step, index) => (
                <li key={`${step.phase}:${index}`}>{step.message}</li>
              ))}
            </ol>
          ) : null}
          {progress.operations.length ? (
            <ul>
              {progress.operations.map((operation) => (
                <li key={operation.toolCallId} data-status={operation.status}>
                  {operation.title}
                  {operation.durationMs != null
                    ? ` · ${(operation.durationMs / 1000).toFixed(1)}s`
                    : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
    </section>
  );
}

function Suggestions({
  suggestions,
  latest,
  context,
}: {
  suggestions: GlobalChatSuggestion[];
  latest: boolean;
  context?: string;
}) {
  const [related, setRelated] = useState<GlobalChatSuggestion | null>(null);
  const holdTimer = useRef<number | null>(null);
  const held = useRef(false);

  function clearHold() {
    if (holdTimer.current != null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }

  function beginHold(suggestion: GlobalChatSuggestion) {
    clearHold();
    if (!suggestion.relatedSuggestions?.length) return;
    held.current = false;
    holdTimer.current = window.setTimeout(() => {
      held.current = true;
      setRelated(suggestion);
      holdTimer.current = null;
    }, 450);
  }

  function choose(suggestion: GlobalChatSuggestion) {
    clearHold();
    if (held.current) {
      held.current = false;
      return;
    }
    setRelated(null);
    void selectGlobalChatSuggestion(suggestion);
  }

  if (!suggestions.length && !latest) return null;
  return (
    <div className="global-chat-suggestions" aria-label="Suggested next steps">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion.id}
          type="button"
          aria-haspopup={suggestion.relatedSuggestions?.length ? 'menu' : undefined}
          aria-expanded={related?.id === suggestion.id || undefined}
          title={suggestion.relatedSuggestions?.length ? 'Hold for related options' : undefined}
          onPointerDown={(event) => {
            if (event.button === 0) beginHold(suggestion);
          }}
          onPointerUp={clearHold}
          onPointerCancel={clearHold}
          onPointerLeave={clearHold}
          onContextMenu={(event) => {
            if (!suggestion.relatedSuggestions?.length) return;
            event.preventDefault();
            clearHold();
            setRelated(suggestion);
          }}
          onKeyDown={(event) => {
            if (!suggestion.relatedSuggestions?.length) return;
            if (event.key === 'ArrowDown' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              setRelated(suggestion);
            }
          }}
          onClick={() => choose(suggestion)}
        >
          {suggestion.label}
        </button>
      ))}
      {latest ? (
        <button
          type="button"
          className="global-chat-more-suggestions"
          onClick={() => void requestMoreSuggestions(context)}
        >
          More suggestions
        </button>
      ) : null}
      {related?.relatedSuggestions?.length ? (
        <div
          className="global-chat-related-suggestions"
          role="menu"
          aria-label={`More options for ${related.label}`}
        >
          {related.relatedSuggestions.map((suggestion) => (
            <button
              key={`${related.id}:${suggestion.id}`}
              type="button"
              role="menuitem"
              onClick={() => choose(suggestion)}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AssistantTurn({
  message,
  latest,
}: {
  message: GlobalChatMessage;
  latest: boolean;
}) {
  const snapshot = useGlobalChatState();
  const presentation = message.payload?.presentation as GlobalChatPresentation | undefined;
  const itemSelection = presentation?.itemSelection as GlobalChatItemSelection | undefined;
  const copy = presentation?.message ?? message.text;
  return (
    <article className="global-chat-turn global-chat-turn-assistant">
      {copy ? <p className="global-chat-assistant-copy">{copy}</p> : null}
      {presentation?.resultRefs?.map((id) => {
        const result = snapshot.results[id];
        return result ? (
          <GlobalChatResultBlock key={id} result={result} itemSelection={itemSelection} />
        ) : (
          <div key={id} className="global-chat-result-loading" aria-label="Loading result">
            <SpinnerArcIcon className="w-4 h-4 animate-spin" aria-hidden="true" />
          </div>
        );
      })}
      {!itemSelection ? (
        <Suggestions
          suggestions={presentation?.suggestions || []}
          latest={latest}
          context={presentation?.suggestionContext}
        />
      ) : null}
    </article>
  );
}

function FirstUse({ presentation }: { presentation: GlobalChatPresentation }) {
  return (
    <section className="global-chat-first-use">
      <h3>{presentation.message}</h3>
      <p className="global-chat-suggestion-hint">Hold an option for related suggestions.</p>
      <Suggestions
        suggestions={presentation.suggestions}
        latest
        context={presentation.suggestionContext}
      />
    </section>
  );
}

function Composer({ id }: { id: string }) {
  const snapshot = useGlobalChatState();
  const [value, setValue] = useState('');
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const sending = snapshot.phase === 'sending';

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const prompt = value.trim();
    if (!prompt || sending) return;
    setValue('');
    if (textarea.current) textarea.current.style.height = '';
    void sendGlobalChatMessage(prompt);
  }

  return (
    <form className="global-chat-composer" onSubmit={submit}>
      <textarea
        id={id}
        ref={textarea}
        rows={1}
        maxLength={12_000}
        value={value}
        disabled={!snapshot.bootstrap?.available || snapshot.phase === 'loading'}
        placeholder={snapshot.bootstrap?.available ? 'Ask Homeroom…' : 'OpenRouter is required'}
        aria-label="Message Global Chat"
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
      <button
        type={sending ? 'button' : 'submit'}
        className="global-chat-send"
        disabled={!sending && !value.trim()}
        aria-label={sending ? 'Stop response' : 'Send message'}
        title={sending ? 'Stop' : 'Send'}
        onClick={sending ? stopGlobalChatTurn : undefined}
      >
        {sending ? <span className="global-chat-stop-mark" aria-hidden="true" /> : <ArrowUpIcon className="w-5 h-5" aria-hidden="true" />}
      </button>
    </form>
  );
}

function Unavailable() {
  const snapshot = useGlobalChatState();
  const disabled = snapshot.bootstrap?.unavailableReason === 'global_chat_disabled';
  return (
    <section className="global-chat-unavailable">
      <h3>{disabled ? 'Enable Global Chat to start' : 'Free-form chat needs OpenRouter'}</h3>
      <p>{disabled
        ? 'Global Chat is an optional experimental feature.'
        : 'The direct options below still work without it.'}</p>
      <div className="global-chat-suggestions">
        <button type="button" onClick={() => closeGlobalChat(disabled ? '#settings/global-chat' : '#settings/openrouter')}>Open Settings</button>
        <button type="button" onClick={() => closeGlobalChat()}>Use Classic</button>
      </div>
    </section>
  );
}

/**
 * The chat itself — toolbar, transcript and composer — drawn on either of
 * its two surfaces (#2813): its own screen at `#chat/<id>`, or the Messages
 * pane beside the inbox on a desktop. One component, so the two cannot
 * drift; `embedded` changes only what is the surface's rather than the
 * chat's — the pane's composer id (ids are document-wide) and the Close
 * button, which the pane does not need because the inbox is right there.
 */
export function GlobalChatPanel({ embedded = false }: { embedded?: boolean }) {
  const snapshot = useGlobalChatState();
  const scroll = useRef<HTMLDivElement | null>(null);
  const assistantIds = useMemo(() => snapshot.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.id), [snapshot.messages]);
  const latestAssistantId = assistantIds.at(-1) || null;

  useEffect(() => {
    if (!snapshot.open || !scroll.current) return;
    scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snapshot.open, snapshot.messages.length, Object.keys(snapshot.results).length, snapshot.activity]);

  return (
    <div className={embedded ? 'global-chat-shell global-chat-embedded' : 'global-chat-shell dc-lift dc-lift-strip'}>
      <header className="global-chat-toolbar">
        <div className="min-w-0">
          <h2>Chat <span>(experimental)</span></h2>
          <p>Saved in Messages.</p>
        </div>
        <BudgetLabel />
        {embedded ? null : (
          <button
            type="button"
            className="global-chat-new"
            onClick={() => closeGlobalChat()}
            aria-label="Close chat"
            title="Close chat"
          >
            <XIcon className="w-4 h-4" aria-hidden="true" />
            <span>Close</span>
          </button>
        )}
        <button
          type="button"
          className="global-chat-new"
          disabled={snapshot.phase === 'sending'}
          onClick={() => void startNewGlobalChat()}
          aria-label="Start a new chat"
          title="New chat"
        >
          <PlusIcon className="w-4 h-4" aria-hidden="true" />
          <span>New</span>
        </button>
      </header>

      <div ref={scroll} className="global-chat-transcript platform-safe-scroll" aria-live="polite">
        {snapshot.hasMoreHistory ? (
          <button type="button" className="global-chat-history" onClick={() => void loadOlderGlobalChatMessages()}>
            Earlier messages
          </button>
        ) : null}
        {snapshot.phase === 'booting' || (snapshot.phase === 'loading' && !snapshot.messages.length) ? (
          <div className="global-chat-loading"><SpinnerArcIcon className="w-5 h-5 animate-spin" aria-hidden="true" /> Loading…</div>
        ) : null}
        {snapshot.bootstrap && !snapshot.bootstrap.available ? <Unavailable /> : null}
        {snapshot.bootstrap && !snapshot.messages.length && snapshot.phase !== 'loading' ? (
          <FirstUse presentation={snapshot.bootstrap.firstUse} />
        ) : null}
        {snapshot.messages.map((message) => message.role === 'user' ? (
          <article key={message.id} className="global-chat-turn global-chat-turn-user">
            <p>{message.text}</p>
          </article>
        ) : (
          <AssistantTurn key={message.id} message={message} latest={message.id === latestAssistantId} />
        ))}
        {snapshot.progress ? <TurnProgress progress={snapshot.progress} /> : snapshot.activity ? (
          <div className="global-chat-activity">
            <SpinnerArcIcon className="w-4 h-4 animate-spin" aria-hidden="true" /> {snapshot.activity}
          </div>
        ) : null}
        {snapshot.error ? (
          <div className="global-chat-error" role="alert">
            <span>{snapshot.error}</span>
            <button type="button" onClick={() => void retryLastGlobalChatRequest()}><ArrowPathIcon className="w-4 h-4" aria-hidden="true" /> Retry</button>
          </div>
        ) : null}
      </div>

      <Composer id={globalChatComposerId(embedded ? 'messages' : 'screen')} />
    </div>
  );
}

export function GlobalChatScreen() {
  const snapshot = useGlobalChatState();
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'global-chat-screen', false);

  // app.js normally dispatches the route after authentication. On a cold
  // deep link the boot-screen hint can reveal this island before that bridge
  // exists, so hydration also resolves the address once as a race-safe seam.
  useEffect(() => {
    if (snapshot.open || !window.location.hash.startsWith('#chat')) return;
    const encoded = window.location.hash.slice(1).split('/')[1] || null;
    let threadId: string | null = null;
    try { threadId = encoded ? decodeURIComponent(encoded) : null; } catch { return; }
    void openGlobalChat({ threadId });
  }, [snapshot.open]);

  // While the Messages pane is drawing the chat (#2813) this screen is
  // hidden and draws nothing: one transcript on the page, not a second copy
  // of it behind the first. The host starts as 'screen', so the prerendered
  // markup — and hydration — are exactly what they were.
  return (
    <main
      ref={screenRef}
      id="global-chat-screen"
      className="hidden flex flex-1 min-h-0 overflow-hidden"
      aria-label="Chat (experimental)"
    >
      {snapshot.host === 'messages' ? null : <GlobalChatPanel />}
    </main>
  );
}

export { useGlobalChatState } from './store';
