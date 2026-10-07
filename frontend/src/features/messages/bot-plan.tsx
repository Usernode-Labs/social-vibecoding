import { useEffect, useState } from 'react';

import { InfoCircleIcon } from '@/components/ui/icons';

import * as api from './api';
import { ACTIVITY_OUTCOME_LABELS, isActivityMessage, isMovedActivity } from './bot-activity';
import { ensureBotActivity, useBotActivity } from './bot-activity-store';
import { botMeta, requestPlace } from './bot-question';
import { PlanCardView, type PlanCardState, type PlanProgress } from './bot-plan-view';
import { BotHeadWords, botHead } from './bot-head-card';
import { MessageMarkdown } from './format';
import { NotifyMe, notifyMeChosen } from './notify-me';
import { answerBotQuestion, scopeKey, setReply } from './store';
import type { ConversationMessage, HomeroomBotActivity, HomeroomBotMeta } from './types';

/*
 * B6: two kinds of bot message that stand in place of their words, as the
 * activity card does (./message-row.tsx): their words still say the same for
 * the inbox, the push and search.
 *
 * A PLAN (kind `plan`): a first version's plan, waiting for Build it
 * (./bot-plan-view.tsx). Build it is decided on the server, once, from any
 * device (api.decideBotAction with the choices picked); Change something
 * quotes the card in the composer, and the reply is read by the bot, never
 * posted on the request.
 *
 * #4046: THE PLAN CARRIES ITS REQUEST'S STEP. A first version's activity
 * card begins when its request is queued, above the plan, and Build it moves
 * it under the plan (services/homeroom-bot-activity.js cardUnderPlan). The
 * chat drew both: "Step 3 of 7 · Write a plan" on the card, the plan under
 * it, then the card again under the plan once it was built. Now the plan is
 * the one place its step shows (planLayout below): a card above its plan is
 * not drawn, the plan reads that card's state for the line at its top
 * (planProgress), and the card Build it moved under the plan is drawn as one
 * line, "I'll message you here when it's ready to try.", with "Notify me when
 * it's ready" under it while it is being built (BotPlanFollowUp).
 *
 * #4046: ONE SET OF SUGGESTIONS. While a plan or a question offers its own
 * answers, the bot's generic questions to tap (its hello's "How long will
 * this take?" and the rest) are not drawn (planLayout `answersOpen`); they
 * come back once it is answered.
 *
 * TWO QUESTIONS (a `question` carrying `questions`): a request the bot has
 * two questions about, answered together. Each is a row of answers to tap,
 * the suggested one marked; Build it sends the answers as one message
 * quoting the card (the way a tapped answer has always gone, and so posted
 * on the request's public discussion, which the note says), with the
 * suggested answer for any left alone. Something else quotes it for answers
 * of one's own. One question keeps BotQuestion's one tap (./bot-question.tsx).
 */

/** What the card Build it moved under its plan says, in place of its card. */
export const PLAN_FOLLOW_UP_WORDS = 'I’ll message you here when it’s ready to try.';

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

function capitalized(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * Pure (#4046): how long a step usually takes, as the plan's line says it:
 * "10 to 25 min", or "about 3 min". Short, so the line stays on one line at
 * 375px (owner, 7 October); the activity card keeps its own words
 * (./bot-activity.tsx typicalText).
 */
export function planTime(range?: { from: number; to: number } | null): string | null {
  if (!range || !(range.to > 0)) return null;
  return range.from >= range.to ? `about ${range.to} min` : `${range.from} to ${range.to} min`;
}

/**
 * Pure (#4046): the line at the top of a plan in `state`, from its request's
 * activity card (`card`, as the reads have it), or null for none. While the
 * plan waits: "Step 3 of 7". Once built: "Step 4 of 7 · Build it · 10 to 25
 * min" (the step, its name, how long it usually takes: one line on a phone,
 * planTime), or how it ended. A plan that stopped waiting says so in its
 * own line instead.
 */
export function planProgress(card: HomeroomBotActivity | null | undefined, state: PlanCardState): PlanProgress | null {
  if (!card || (state !== 'open' && state !== 'built')) return null;
  if (card.state === 'done') {
    return state === 'built' && card.outcome ? { line: ACTIVITY_OUTCOME_LABELS[card.outcome], step: null, of: null } : null;
  }
  const stepped = card.step && card.of ? { step: card.step, of: card.of } : null;
  if (state === 'open') return stepped ? { line: `Step ${stepped.step} of ${stepped.of}`, ...stepped } : null;
  const what = stepped
    ? `Step ${stepped.step} of ${stepped.of}${card.stepName ? ` · ${card.stepName}` : ''}`
    : capitalized(card.doing || 'working on it');
  const time = planTime(card.typicalMinutes);
  return { line: time ? `${what} · ${time}` : what, step: stepped?.step ?? null, of: stepped?.of ?? null };
}

/**
 * Pure (#4046): whether a bot message offers its own answers to pick now: a
 * plan waiting for Build it, or an open question.
 */
export function offersAnswers(message: ConversationMessage): boolean {
  const meta = botMeta(message);
  if (!meta || message.deleted || meta.status !== 'open') return false;
  if (meta.kind === 'plan') return isPlanMessage(message) && planState(meta) === 'open';
  return meta.kind === 'question';
}

/** How a transcript draws its plans and the activity cards of their requests (planLayout). */
export interface PlanLayout {
  /** Activity cards a plan of their request comes after: the plan carries their step. */
  hidden: ReadonlySet<number>;
  /** A request's newest plan, waiting or built, by message id: the card whose state it reads. */
  cardOf: ReadonlyMap<number, number>;
  /** Activity cards under their request's built plan: drawn as one line (BotPlanFollowUp). */
  underPlan: ReadonlySet<number>;
  /** A plan or a question offers its own answers: the bot's generic questions to tap give way. */
  answersOpen: boolean;
}

export const NO_PLAN_LAYOUT: PlanLayout = { hidden: new Set(), cardOf: new Map(), underPlan: new Set(), answersOpen: false };

/** A bot message's request, as "app#number", or null. */
function requestKey(meta: HomeroomBotMeta): string | null {
  const app = meta.appSlug || meta.appName;
  const n = Number(meta.issueNumber);
  return app && Number.isInteger(n) && n > 0 ? `${app}#${n}` : null;
}

/**
 * Pure (#4046): how the transcript `messages` draws its plans (see THE PLAN
 * CARRIES ITS REQUEST'S STEP above), by message id. Only the bot's own
 * messages count; a card Build it moved is left out already
 * (isMovedActivity). For each request with a plan:
 *
 *   - an activity card before its plan is not drawn: the plan carries it,
 *     and neither is one after a plan that still waits for Build it;
 *   - one after its plan, once that plan is built, is the card that follows
 *     the build: drawn as one line under it;
 *   - the newest plan, waiting or built, reads the newest card's state.
 */
export function planLayout(messages: readonly ConversationMessage[]): PlanLayout {
  const plans = new Map<string, ConversationMessage>();
  const cards = new Map<string, number[]>();
  let answersOpen = false;
  for (const message of messages) {
    const meta = botMeta(message);
    if (!meta || message.deleted || !(message.id > 0)) continue;
    if (offersAnswers(message)) answersOpen = true;
    const key = requestKey(meta);
    if (!key) continue;
    if (isPlanMessage(message)) {
      const newest = plans.get(key);
      if (!newest || message.id > newest.id) plans.set(key, message);
    } else if (isActivityMessage(message) && !isMovedActivity(message)) {
      cards.set(key, [...(cards.get(key) || []), message.id]);
    }
  }
  if (!plans.size) return answersOpen ? { ...NO_PLAN_LAYOUT, answersOpen } : NO_PLAN_LAYOUT;
  const hidden = new Set<number>();
  const underPlan = new Set<number>();
  const cardOf = new Map<number, number>();
  for (const [key, plan] of plans) {
    const ids = cards.get(key) || [];
    const state = planState(botMeta(plan) as HomeroomBotMeta);
    for (const id of ids) {
      if (id < plan.id || state === 'open') hidden.add(id);
      else if (state === 'built') underPlan.add(id);
    }
    const newest = Math.max(0, ...ids);
    if (newest && (state === 'open' || state === 'built')) cardOf.set(plan.id, newest);
  }
  return { hidden, cardOf, underPlan, answersOpen };
}

/** Put the card in the composer's reply bar, and the caret after it. */
function quote(message: ConversationMessage, conversationId: number) {
  setReply(scopeKey(conversationId, null), message);
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('.messages-composer-input')?.focus({ preventScroll: true });
  });
}

export function BotPlanCard({ message, conversationId, cardId = null }: {
  message: ConversationMessage;
  conversationId: number;
  /** #4046: its request's activity card, whose step it carries (planLayout). */
  cardId?: number | null;
}) {
  const meta = botMeta(message);
  const [pressed, setPressed] = useState(false);
  const activity = useBotActivity();
  useEffect(() => { if (cardId) ensureBotActivity(); }, [cardId]);
  if (!meta?.plan) return null;
  const actionId = meta.actionId;

  function build(answers: Array<string | null>) {
    if (!actionId) return;
    setPressed(true);
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
      progress={planProgress(cardId ? activity.cards.get(cardId) : null, planState(meta, pressed))}
    />
  );
}

/**
 * #4046: the activity card Build it moved under its plan (planLayout
 * `underPlan`), drawn as one line in the bot's voice: the plan above carries
 * its step. While it is being built, "Notify me when it's ready" is under it
 * (./notify-me.tsx), unless this account chose already on this device.
 * Tapped, it turns grey and says "We'll notify you".
 */
export function BotPlanFollowUp({ message }: { message: ConversationMessage }) {
  const activity = useBotActivity();
  const userId = typeof window !== 'undefined' ? Number(window.App?.user?.id) || null : null;
  // Decided when it is drawn: an account that chose here is not asked again.
  const [offer] = useState(() => !notifyMeChosen(userId));
  useEffect(() => { ensureBotActivity(); }, []);
  const card = activity.cards.get(message.id);
  return (
    <div data-bot-plan-follow-up={card?.state || 'pending'}>
      {/* Drawn as the bot's words are (./format.tsx MessageMarkdown). */}
      <div className="messages-markdown gc-msg-content"><p>{PLAN_FOLLOW_UP_WORDS}</p></div>
      {offer && card?.state !== 'done' ? <div className="mt-2"><NotifyMe userId={userId} /></div> : null}
    </div>
  );
}

export function BotTwoQuestions({ message, conversationId }: { message: ConversationMessage; conversationId: number }) {
  const meta = botMeta(message);
  const questions = meta?.questions || [];
  const [picked, setPicked] = useState<Array<string | null>>(() => questions.map(() => null));
  const [sent, setSent] = useState<string | null>(null);
  if (!meta || questions.length < 2) return null;
  // #4097: the lead's request line is the request's card, as in any row.
  const head = meta.lead ? botHead(meta.lead, meta) : null;
  const open = meta.status === 'open' && !sent;
  const answered = meta.status === 'answered' ? (meta.answer || sent) : sent;

  function build() {
    const text = questions.map((q, i) => `${q.question} ${picked[i] || q.answers[0]}`).join('\n');
    setSent(text);
    void answerBotQuestion(message, text).catch(() => setSent(null));
  }

  return (
    <div className="messages-bot-question" data-bot-question={meta.status || 'open'} data-bot-questions="2">
      {head ? <BotHeadWords head={head} objects={message.objects} />
        : meta.lead ? <MessageMarkdown content={meta.lead} appSlug={meta.appSlug} /> : null}
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
                {j === 0 ? <span className="messages-bot-default">suggested</span> : null}
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
        <div className="mt-2.5 messages-bot-answers" role="group" aria-label="Actions">
          <button type="button" className="messages-bot-primary" data-bot-answer="build" onClick={build}>Build it</button>
          <button type="button" className="messages-bot-other" onClick={() => quote(message, conversationId)}>Something else</button>
        </div>
      ) : null}
      {answered ? <p className="messages-bot-answered whitespace-pre-line">{`You answered:\n${answered}`}</p> : null}
      {meta.status === 'closed' && !answered ? <p className="messages-bot-answered">No longer needed.</p> : null}
      {open || sent ? (
        <p className="messages-bot-note">
          <InfoCircleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{`Your answers are posted on ${requestPlace(meta)}’s public discussion, where the group can see them.`}</span>
        </p>
      ) : null}
    </div>
  );
}
