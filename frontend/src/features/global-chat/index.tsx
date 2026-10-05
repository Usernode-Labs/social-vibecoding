import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { RichMessage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';

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
    <Localized element={<span className="global-chat-budget" title={catalogText("community:global_chat_spend_this_month_and_overall_openrou_2e24e5ef")}><Message after={" "} id="community:chat_460b3a7d" />{spent}{cap ? ` / ${cap}` : ''}<LocalizedValue render={() => (remaining ? tr("community:value1_left_dd048b18", { value1: remaining }) : '')} />
    </span>} messages={{"title":"community:global_chat_spend_this_month_and_overall_openrou_2e24e5ef"}} />
  );
}

function TurnProgress({ progress }: { progress: GlobalChatProgress }) {
  useUiLanguage();
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsedMs = Math.max(progress.elapsedMs, clock - progress.startedAt);
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return (
    <Localized element={<section className="global-chat-progress" aria-label={catalogText("community:global_chat_progress_59723007")}>
      <div className="global-chat-progress-current">
        <SpinnerArcIcon className="w-4 h-4 animate-spin" aria-hidden="true" />
        <span>{progress.message}</span>
        <time><RichMessage id="community:sentence_e46818576648" values={{ value1: seconds }} /></time>
      </div>
      <details>
        <summary><Message id="community:activity_38da1505" /></summary>
        <div className="global-chat-progress-details">
          {progress.model ? <p><RichMessage id="community:sentence_82f287830bb2" values={{ value1: progress.model }} /></p> : null}
          {progress.reasoningEffort ? <p><RichMessage id="community:sentence_d012a3d02997" values={{ value1: progress.reasoningEffort }} /></p> : null}
          {progress.attempt && progress.attempt > 1 ? <p><RichMessage id="community:sentence_c2eb3198fef7" values={{ value1: progress.attempt }} /></p> : null}
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
                  <LocalizedValue render={() => (operation.durationMs != null
                    ? tr("community:value1_s_00cf3855", { value1: (operation.durationMs / 1000).toFixed(1) })
                    : '')} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
    </section>} messages={{"aria-label":"community:global_chat_progress_59723007"}} />
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
  useUiLanguage();
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
    <Localized element={<div aria-label={catalogText("community:suggested_next_steps_00286bda")} className="global-chat-suggestions">
      {suggestions.map((suggestion) => (
        <LocalizedDynamic element={<button
          key={suggestion.id}
          type="button"
          aria-haspopup={suggestion.relatedSuggestions?.length ? 'menu' : undefined}
          aria-expanded={related?.id === suggestion.id || undefined}
          title={suggestion.relatedSuggestions?.length ? tr("community:hold_for_related_options_0b7ba22f") : undefined}
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
        </button>} resolve={() => ({ "title": suggestion.relatedSuggestions?.length ? tr("community:hold_for_related_options_0b7ba22f") : undefined })} />
      ))}
      {latest ? (
        <button
          type="button"
          className="global-chat-more-suggestions"
          onClick={() => void requestMoreSuggestions(context)}
        ><Message id="community:more_suggestions_f9048bba" /></button>
      ) : null}
      {related?.relatedSuggestions?.length ? (
        <LocalizedDynamic element={<div
          className="global-chat-related-suggestions"
          role="menu"
          aria-label={tr("community:more_options_for_value1_98095a61", { value1: related.label })}
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
        </div>} resolve={() => ({ get "aria-label"() { return tr("community:more_options_for_value1_98095a61", { value1: related.label }); } })} />
      ) : null}
    </div>} messages={{"aria-label":"community:suggested_next_steps_00286bda"}} />
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
          <Localized element={<div key={id} className="global-chat-result-loading" aria-label={catalogText("community:loading_result_9f43a300")}>
            <SpinnerArcIcon className="w-4 h-4 animate-spin" aria-hidden="true" />
          </div>} messages={{"aria-label":"community:loading_result_9f43a300"}} />
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
      <p className="global-chat-suggestion-hint"><Message id="community:hold_an_option_for_related_suggestions_eef5dd9b" /></p>
      <Suggestions
        suggestions={presentation.suggestions}
        latest
        context={presentation.suggestionContext}
      />
    </section>
  );
}

function Composer({ id }: { id: string }) {
  useUiLanguage();
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
    // `platform-safe-bar` (app.css, the safe-area contract at the top of the
    // file): this form is the bottom of a column that reaches the viewport,
    // and on a phone #global-chat-screen keeps the platform tab bar up — so
    // the bar has to clear whichever of the tab bar and the home-indicator
    // strip is taller. It cleared the strip alone, and "Ask Homeroom…" sat
    // under the tab bar. The transcript above no longer reserves that band:
    // the composer is always below it, so the band is the composer's to
    // clear, once (the rule Messages' thread follows for its own composer).
    <form className="global-chat-composer platform-safe-bar" onSubmit={submit}>
      <Localized element={<LocalizedDynamic element={<textarea
        id={id}
        ref={textarea}
        rows={1}
        maxLength={12_000}
        value={value}
        disabled={!snapshot.bootstrap?.available || snapshot.phase === 'loading'}
        placeholder={snapshot.bootstrap?.available ? tr("community:ask_homeroom_eb01e374") : tr("community:openrouter_is_required_350e6861")} aria-label={catalogText("community:message_global_chat_3f4c7744")}
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
      />} resolve={() => ({ "placeholder": snapshot.bootstrap?.available ? tr("community:ask_homeroom_eb01e374") : tr("community:openrouter_is_required_350e6861") })} />} messages={{"aria-label":"community:message_global_chat_3f4c7744"}} />
      <LocalizedDynamic element={<button
        type={sending ? 'button' : 'submit'}
        className="global-chat-send"
        disabled={!sending && !value.trim()}
        aria-label={sending ? tr("community:stop_response_d5ca579c") : tr("community:send_message_93a26b1e")}
        title={sending ? tr("community:stop_cae7d57b") : tr("community:send_f6f4688f")}
        // The field keeps focus through the press, so the keyboard and the
        // composer stay where the tap landed (lib/keyboard-open.ts).
        onMouseDown={(event) => event.preventDefault()}
        onClick={sending ? stopGlobalChatTurn : undefined}
      >
        {sending ? <span className="global-chat-stop-mark" aria-hidden="true" /> : <ArrowUpIcon className="w-5 h-5" aria-hidden="true" />}
      </button>} resolve={() => ({ "aria-label": sending ? tr("community:stop_response_d5ca579c") : tr("community:send_message_93a26b1e"), "title": sending ? tr("community:stop_cae7d57b") : tr("community:send_f6f4688f") })} />
    </form>
  );
}

function Unavailable() {
  const snapshot = useGlobalChatState();
  const disabled = snapshot.bootstrap?.unavailableReason === 'global_chat_disabled';
  return (
    <section className="global-chat-unavailable">
      <h3><LocalizedValue render={() => (disabled ? tr("community:enable_global_chat_to_start_5ea6248f") : tr("community:free_form_chat_needs_openrouter_e95bbf8e"))} /></h3>
      <p><LocalizedValue render={() => (disabled
        ? tr("community:global_chat_is_an_optional_experimental_feature_4bd8b033")
        : tr("community:the_direct_options_below_still_work_without_it_69033459"))} /></p>
      <div className="global-chat-suggestions">
        <button type="button" onClick={() => closeGlobalChat(disabled ? '#settings/global-chat' : '#settings/openrouter')}><Message id="community:open_settings_3f940108" /></button>
        <button type="button" onClick={() => closeGlobalChat()}><Message id="community:use_classic_56268536" /></button>
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
 * The pane's one addition, `headerAction`, closes the toolbar: the Messages
 * full-width toggle, which every discussion pane carries in that place.
 */
export function GlobalChatPanel({ embedded = false, headerAction = null }: { embedded?: boolean; headerAction?: ReactNode }) {
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
          <h2><RichMessage id="community:sentence_9fd899c9ba0c" components={[<span />]} /></h2>
          <p><Message id="community:saved_in_messages_9ca89a80" /></p>
        </div>
        <BudgetLabel />
        {embedded ? null : (
          <Localized element={<button aria-label={catalogText("community:close_chat_3b14c5dc")} title={catalogText("community:close_chat_3b14c5dc")}
            type="button"
            className="global-chat-new"
            onClick={() => closeGlobalChat()}
          >
            <XIcon className="w-4 h-4" aria-hidden="true" />
            <span><Message id="community:close_7d9eb7ac" /></span>
          </button>} messages={{"aria-label":"community:close_chat_3b14c5dc","title":"community:close_chat_3b14c5dc"}} />
        )}
        <Localized element={<button aria-label={catalogText("community:start_a_new_chat_61025e4f")} title={catalogText("community:new_chat_db18382a")}
          type="button"
          className="global-chat-new"
          disabled={snapshot.phase === 'sending'}
          onClick={() => void startNewGlobalChat()}
        >
          <PlusIcon className="w-4 h-4" aria-hidden="true" />
          <span><Message id="community:new_18fdd549" /></span>
        </button>} messages={{"aria-label":"community:start_a_new_chat_61025e4f","title":"community:new_chat_db18382a"}} />
        {headerAction}
      </header>

      {/* No `platform-safe-scroll`: the composer below clears the tab bar and
          the home-indicator strip (see Composer), so reserving the band here
          too put it on the wrong element — a blank band at the end of the
          transcript — and, on a desktop, zeroed the transcript's own 18px of
          bottom padding with the class's `!important` 0px. */}
      <div ref={scroll} className="global-chat-transcript" aria-live="polite">
        {snapshot.hasMoreHistory ? (
          <button type="button" className="global-chat-history" onClick={() => void loadOlderGlobalChatMessages()}><Message id="community:earlier_messages_561a197a" /></button>
        ) : null}
        {snapshot.phase === 'booting' || (snapshot.phase === 'loading' && !snapshot.messages.length) ? (
          <div className="global-chat-loading"><SpinnerArcIcon className="w-5 h-5 animate-spin" aria-hidden="true" /><Message before={" "} id="community:loading_ba3bbbe1" /></div>
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
            <button type="button" onClick={() => void retryLastGlobalChatRequest()}><ArrowPathIcon className="w-4 h-4" aria-hidden="true" /><Message before={" "} id="community:retry_942087cc" /></button>
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
    <Localized element={<main
      ref={screenRef}
      id="global-chat-screen"
      className="hidden flex flex-1 min-h-0 overflow-hidden" aria-label={catalogText("community:chat_experimental_7ca69a8d")}
    >
      {snapshot.host === 'messages' ? null : <GlobalChatPanel />}
    </main>} messages={{"aria-label":"community:chat_experimental_7ca69a8d"}} />
  );
}

export { useGlobalChatState } from './store';
