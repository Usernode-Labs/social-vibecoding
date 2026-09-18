import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { ArrowPathIcon, ArrowUpIcon, PlusIcon, SpinnerArcIcon } from '@/components/ui/icons';

import { GlobalChatResultBlock } from './renderers';
import {
  closeGlobalChat,
  loadOlderGlobalChatMessages,
  openGlobalChat,
  requestMoreSuggestions,
  sendGlobalChatMessage,
  startNewGlobalChat,
  stopGlobalChatTurn,
  useGlobalChatState,
} from './store';
import type { GlobalChatMessage, GlobalChatPresentation, GlobalChatSuggestion } from './types';

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

function Suggestions({
  suggestions,
  latest,
}: {
  suggestions: GlobalChatSuggestion[];
  latest: boolean;
}) {
  if (!suggestions.length && !latest) return null;
  return (
    <div className="global-chat-suggestions" aria-label="Suggested next steps">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion.id}
          type="button"
          onClick={() => void sendGlobalChatMessage(suggestion.prompt)}
        >
          {suggestion.label}
        </button>
      ))}
      {latest ? (
        <button
          type="button"
          className="global-chat-more-suggestions"
          onClick={() => void requestMoreSuggestions()}
        >
          More suggestions
        </button>
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
  const copy = presentation?.message ?? message.text;
  return (
    <article className="global-chat-turn global-chat-turn-assistant">
      {copy ? <p className="global-chat-assistant-copy">{copy}</p> : null}
      {presentation?.resultRefs?.map((id) => {
        const result = snapshot.results[id];
        return result ? <GlobalChatResultBlock key={id} result={result} /> : (
          <div key={id} className="global-chat-result-loading" aria-label="Loading result">
            <SpinnerArcIcon className="w-4 h-4 animate-spin" aria-hidden="true" />
          </div>
        );
      })}
      <Suggestions suggestions={presentation?.suggestions || []} latest={latest} />
    </article>
  );
}

function FirstUse({ presentation }: { presentation: GlobalChatPresentation }) {
  return (
    <section className="global-chat-first-use">
      <h3>{presentation.message}</h3>
      <Suggestions suggestions={presentation.suggestions} latest />
    </section>
  );
}

function Composer() {
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
        id="global-chat-composer"
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
  return (
    <section className="global-chat-unavailable">
      <h3>Connect OpenRouter to start</h3>
      <p>Global Chat uses the separate low-cost model configured in Settings.</p>
      <div className="global-chat-suggestions">
        <button type="button" onClick={() => closeGlobalChat('#settings/openrouter')}>Open Settings</button>
        <button type="button" onClick={() => closeGlobalChat()}>Use Classic</button>
      </div>
    </section>
  );
}

export function GlobalChatScreen() {
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
    <main
      id="global-chat-screen"
      className={`${snapshot.open ? 'flex' : 'hidden'} flex-1 min-h-0 overflow-hidden`}
      aria-label="Chat (experimental)"
    >
      <div className="global-chat-shell dc-lift dc-lift-strip">
        <header className="global-chat-toolbar">
          <div className="min-w-0">
            <h2>Chat <span>(experimental)</span></h2>
            <p>Classic remains the default.</p>
          </div>
          <BudgetLabel />
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
          {snapshot.bootstrap?.available && !snapshot.messages.length && snapshot.phase !== 'loading' ? (
            <FirstUse presentation={snapshot.bootstrap.firstUse} />
          ) : null}
          {snapshot.messages.map((message) => message.role === 'user' ? (
            <article key={message.id} className="global-chat-turn global-chat-turn-user">
              <p>{message.text}</p>
            </article>
          ) : (
            <AssistantTurn key={message.id} message={message} latest={message.id === latestAssistantId} />
          ))}
          {snapshot.activity ? (
            <div className="global-chat-activity">
              <SpinnerArcIcon className="w-4 h-4 animate-spin" aria-hidden="true" /> {snapshot.activity}
            </div>
          ) : null}
          {snapshot.error ? (
            <div className="global-chat-error" role="alert">
              <span>{snapshot.error}</span>
              <button type="button" onClick={() => void openGlobalChat()}><ArrowPathIcon className="w-4 h-4" aria-hidden="true" /> Retry</button>
            </div>
          ) : null}
        </div>

        <Composer />
      </div>
    </main>
  );
}

export { GlobalChatModeSwitch } from './mode-switch';
