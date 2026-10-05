import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
import { useState } from 'react';

import { InfoCircleIcon } from '@/components/ui/icons';

import * as api from './api';
import { botMeta, requestPlace } from './bot-question';
import { PlanCardView, type PlanCardState } from './bot-plan-view';
import { MessageMarkdown } from './format';
import { NotifyMe, notifyMeChosen } from './notify-me';
import { answerBotQuestion, scopeKey, setReply } from './store';
import type { ConversationMessage, HomeroomBotMeta } from './types';

/*
 * B6: two kinds of bot message that stand in place of their words, as the
 * activity card does (./message-row.tsx): their words still say the same for
 * the inbox, the push and search.
 *
 * A PLAN (kind `plan`): a first version's plan, waiting for Build it
 * (./bot-plan-view.tsx). Build it is decided on the server, once, from any
 * device (api.decideBotAction with the choices tapped); Change something
 * quotes the card in the composer, and the reply is read by the bot, never
 * posted on the request. Pressed here, the card then offers "Notify me when
 * it's ready" (./notify-me.tsx), unless this account chose already on this
 * device.
 *
 * TWO QUESTIONS (a `question` carrying `questions`): a request the bot has
 * two questions about, answered together. Each is a row of answers to tap,
 * the suggested one marked; Build it sends the answers as one message
 * quoting the card (the way a tapped answer has always gone, and so posted
 * on the request's public discussion, which the note says), with the
 * suggested answer for any left alone. Something else quotes it for answers
 * of one's own. One question keeps BotQuestion's one tap (./bot-question.tsx).
 */

/** Whether a message is a plan the bot drew as its card. */
export function isPlanMessage(message: ConversationMessage): boolean {
  const meta = botMeta(message);
  return !!meta && meta.kind === 'plan' && !!meta.plan && !message.deleted;
}

/** Whether a message asks two questions at once. */
export function isTwoQuestions(message: ConversationMessage): boolean {
  const meta = botMeta(message);
  return !!meta && meta.kind === 'question' && (meta.questions?.length || 0) > 1 && !message.deleted;
}

/** Pure: a plan card's state, from its message (and a Build it pressed here, until the update lands). */
export function planState(meta: HomeroomBotMeta, pressed = false): PlanCardState {
  if (meta.status === 'answered' || pressed) return 'built';
  if (meta.replaced) return 'replaced';
  if (meta.stopped) return 'stopped';
  if (meta.changing) return 'changing';
  if (meta.status === 'closed' || !meta.actionId) return 'closed';
  return 'open';
}

/** Put the card in the composer's reply bar, and the caret after it. */
function quote(message: ConversationMessage, conversationId: number) {
  setReply(scopeKey(conversationId, null), message);
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('.messages-composer-input')?.focus({ preventScroll: true });
  });
}

export function BotPlanCard({ message, conversationId }: { message: ConversationMessage; conversationId: number }) {
  useUiLanguage();
  const meta = botMeta(message);
  const [pressed, setPressed] = useState(false);
  const [offerNotify, setOfferNotify] = useState(false);
  if (!meta?.plan) return null;
  const actionId = meta.actionId;
  const userId = typeof window !== 'undefined' ? Number(window.App?.user?.id) || null : null;

  function build(answers: Array<string | null>) {
    if (!actionId) return;
    setPressed(true);
    setOfferNotify(!notifyMeChosen(userId));
    // A refusal (decided on another device, or the plan was replaced) brings
    // nothing back here: the card's own update says what happened.
    void api.decideBotAction(actionId, 'build', answers.map((a) => a || '')).catch(() => setPressed(false));
  }

  return (
    <PlanCardView
      appName={meta.appName || meta.appSlug || 'your project'}
      plan={meta.plan}
      state={planState(meta)}
      choices={meta.choices}
      busy={pressed && meta.status !== 'answered'}
      onBuild={build}
      onChange={() => quote(message, conversationId)}
      footer={pressed && offerNotify ? <NotifyMe userId={userId} /> : null}
    />
  );
}

export function BotTwoQuestions({ message, conversationId }: { message: ConversationMessage; conversationId: number }) {
  useUiLanguage();
  const meta = botMeta(message);
  const questions = meta?.questions || [];
  const [picked, setPicked] = useState<Array<string | null>>(() => questions.map(() => null));
  const [sent, setSent] = useState<string | null>(null);
  if (!meta || questions.length < 2) return null;
  const open = meta.status === 'open' && !sent;
  const answered = meta.status === 'answered' ? (meta.answer || sent) : sent;

  function build() {
    const text = questions.map((q, i) => `${q.question} ${picked[i] || q.answers[0]}`).join('\n');
    setSent(text);
    void answerBotQuestion(message, text).catch(() => setSent(null));
  }

  return (
    <div className="messages-bot-question" data-bot-question={meta.status || 'open'} data-bot-questions="2">
      {meta.lead ? <MessageMarkdown content={meta.lead} appSlug={meta.appSlug} /> : null}
      {open ? questions.map((q, index) => (
        <div key={q.question} className="mt-2.5">
          <p className="text-[0.9375rem] font-medium text-zinc-900 dark:text-zinc-100">{q.question}</p>
          <div className="mt-1.5 messages-bot-answers" role="group" aria-label={q.question}>
            {q.answers.map((answer, j) => (
              <button
                key={answer}
                type="button"
                aria-pressed={picked[index] === answer}
                data-bot-answer={j === 0 ? 'default' : 'other'}
                onClick={() => setPicked((current) => current.map((value, i) => (i === index ? answer : value)))}
              >
                <span>{answer}</span>
                {j === 0 ? <span className="messages-bot-default"><Message id="community:suggested_8ad70375" /></span> : null}
              </button>
            ))}
          </div>
        </div>
      )) : (
        <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-[0.9375rem] text-zinc-900 dark:text-zinc-100">
          {questions.map((q) => <li key={q.question}>{q.question}</li>)}
        </ol>
      )}
      {open ? (
        <Localized element={<div className="mt-2.5 messages-bot-answers" role="group" aria-label={catalogText("community:actions_ff8059dc")}>
          <button type="button" className="messages-bot-primary" data-bot-answer="build" onClick={build}><Message id="community:build_it_5e383207" /></button>
          <button type="button" className="messages-bot-other" onClick={() => quote(message, conversationId)}><Message id="community:something_else_cc728431" /></button>
        </div>} messages={{"aria-label":"community:actions_ff8059dc"}} />
      ) : null}
      {answered ? <p className="messages-bot-answered whitespace-pre-line"><LocalizedValue render={() => (tr("community:you_answered_value1_ddf5f998", { value1: answered }))} /></p> : null}
      {meta.status === 'closed' && !answered ? <p className="messages-bot-answered"><Message id="community:no_longer_needed_ace70031" /></p> : null}
      {open || sent ? (
        <p className="messages-bot-note">
          <InfoCircleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span><LocalizedValue render={() => (tr("community:your_answers_are_posted_on_value1_s_public_discu_9905b828", { value1: requestPlace(meta) }))} /></span>
        </p>
      ) : null}
    </div>
  );
}
