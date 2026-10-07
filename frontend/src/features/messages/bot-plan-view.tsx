import { useId, useState, type ReactNode } from 'react';

import type { HomeroomBotPlan } from './types';

/*
 * B6: a first version's plan, before anything is built.
 *
 * Homeroom bot reads a new project's description and sends its creator the
 * plan first: 3 to 5 plain lines of what the first version will do, up to
 * two choices with the suggested answer already picked, then Build it and
 * Change something. Nothing is built until Build it. The same card is drawn
 * in the creator's chat with the bot (./bot-plan.tsx) and on the project's
 * App tab while its first version waits (../app-frame/app-status.tsx), and
 * both send the tap to the same endpoint, which decides it once
 * (services/homeroom-bot-dm.js decidePlanTap).
 *
 * A CHOICE IS NOT A SEND. Each question is one quiet single choice, its
 * suggested answer picked from the start, and nothing goes anywhere until
 * Build it, which takes the answers picked; a question left alone goes with
 * its suggested answer. Change something is the card's owner's to wire: in
 * the chat it quotes the card in the composer, on the App tab it opens the
 * chat to do the same.
 *
 * #4046: IN THE CHAT IT IS THE ONE PLACE A STEP COUNT SHOWS. Its host passes
 * `progress`: "Step 3 of 7" over a thin bar while the plan waits, then
 * "Step 4 of 7 · Build it · 10 to 25 min" once Build it is
 * pressed, when the card folds to its title and the answers it went with.
 * The request's activity card is not drawn beside it (./bot-plan.tsx
 * planLayout), so nothing is said twice.
 *
 * Once its buttons go, the card says why in one quiet line: built (when no
 * progress says so), replaced by a newer plan (its lines fold away), stopped
 * after a week with no tap (its lines stay), changes asked for, or no longer
 * needed. Under it, a host may add a `footer`.
 *
 * Pure: no store, so the App tab draws it without the Messages screen.
 */

export type PlanCardState = 'open' | 'built' | 'replaced' | 'stopped' | 'changing' | 'closed';

/** What the line under a card that is no longer open says. */
export const PLAN_STATE_LINES: Record<Exclude<PlanCardState, 'open' | 'replaced'>, string> = {
  built: 'You chose Build it',
  stopped: 'I stopped waiting on this plan. Reply to pick it up again.',
  changing: 'You asked for changes. A new plan is on its way.',
  closed: 'No longer needed.',
};

/**
 * #4046: how far along the plan's request is, at the top of the card: its
 * line, and the step it is at of how many, for the bar (null: no bar).
 */
export interface PlanProgress {
  line: string;
  step: number | null;
  of: number | null;
}

export interface PlanCardViewProps {
  appName: string;
  plan: HomeroomBotPlan;
  state: PlanCardState;
  /** Built: the answer each choice went with, in order. */
  choices?: string[];
  /** Build it was pressed here and is on its way. */
  busy?: boolean;
  /** Build it, with the answer picked for each choice (null for one left alone). */
  onBuild?: (answers: Array<string | null>) => void;
  onChange?: () => void;
  /** The chat's card, or the App tab's. */
  surface?: 'messages' | 'app';
  /** #4046: the step its request is at, drawn at the top (the chat's only). */
  progress?: PlanProgress | null;
  /** Drawn last, inside the card. */
  footer?: ReactNode;
}

// Complete literals only: Tailwind's extractor reads source text.
const SURFACES = {
  messages: 'mt-1 flex max-w-[480px] flex-col rounded-[20px] bg-[color:var(--messages-surface)] px-4 pb-3 pt-4 text-left shadow-[inset_0_0_0_1px_var(--app-sheet-line)]',
  app: 'flex w-full max-w-sm flex-col rounded-[20px] bg-[color:var(--dc-sheet-solid)] px-4 pb-3 pt-4 text-left shadow-[inset_0_0_0_1px_var(--app-sheet-line)]',
} as const;

// One answer of a choice, picked or not.
const ANSWER_ROW = {
  first: 'flex min-h-[40px] cursor-pointer items-center gap-2.5 px-3 py-2 text-[0.9375rem] leading-5 text-zinc-900 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-[color:var(--accent)] dark:text-zinc-100',
  next: 'flex min-h-[40px] cursor-pointer items-center gap-2.5 px-3 py-2 text-[0.9375rem] leading-5 text-zinc-900 shadow-[inset_0_1px_0_var(--app-sheet-line)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-[color:var(--accent)] dark:text-zinc-100',
} as const;

export function PlanCardView({
  appName, plan, state, choices = [], busy = false, onBuild, onChange, surface = 'messages', progress = null, footer = null,
}: PlanCardViewProps) {
  const [picked, setPicked] = useState<Array<string | null>>(() => plan.questions.map(() => null));
  const uid = useId();
  const open = state === 'open' && !busy;
  const shown: PlanCardState = busy ? 'built' : state;
  // Built: the answers it went with. Pressed here, the ones picked (or
  // suggested) until the server's own come back.
  const chosen = busy
    ? plan.questions.map((q, i) => picked[i] || q.answers[0] || null)
    : shown === 'built' ? choices : [];
  // The App tab's card keeps its words until it goes (#4053).
  const title = surface === 'app' ? `Here’s my plan for ${appName}:` : `My plan for ${appName}`;
  const stepped = progress && progress.step && progress.of ? { step: progress.step, of: progress.of } : null;

  function choose(index: number, answer: string) {
    setPicked((current) => current.map((value, i) => (i === index ? answer : value)));
  }

  return (
    <div className={SURFACES[surface]} role="group" aria-label={`Plan for ${appName}`} data-bot-plan={shown}>
      {progress ? (
        <div className="mb-3.5 flex flex-col gap-1.5" data-bot-plan-progress="">
          {/* One line, whatever the width: an ellipsis is the last resort (owner, 7 October). */}
          <span className="min-w-0 truncate text-[0.8125rem] leading-4 text-zinc-500 dark:text-zinc-400" role="status" data-bot-plan-progress-line="">{progress.line}</span>
          {stepped ? (
            <span
              className="block h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700"
              role="progressbar"
              aria-label={`Step ${stepped.step} of ${stepped.of}`}
              aria-valuemin={0}
              aria-valuemax={stepped.of}
              aria-valuenow={stepped.step}
            >
              <span
                className="block h-full rounded-full bg-[color:var(--accent)]"
                style={{ width: `${Math.round((Math.min(stepped.step, stepped.of) / stepped.of) * 1000) / 10}%` }}
              />
            </span>
          ) : null}
        </div>
      ) : null}
      <div className={`text-[1.0625rem] font-bold leading-[1.375rem] ${shown === 'replaced' ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-900 dark:text-zinc-100'}`}>
        {title}
      </div>
      {shown === 'replaced' ? (
        <p className="messages-bot-answered">Replaced by a newer plan</p>
      ) : shown === 'built' ? (
        chosen.some(Boolean) ? (
          <ul className="mt-1 flex flex-col text-sm leading-5 text-zinc-500 dark:text-zinc-400" data-bot-plan-chosen="">
            {chosen.map((answer, i) => (answer ? <li key={plan.questions[i]?.question || i}>{answer}</li> : null))}
          </ul>
        ) : null
      ) : (
        <ul className="mt-2.5 flex flex-col gap-[5px] text-[0.9375rem] leading-5 text-zinc-900 dark:text-zinc-100">
          {plan.bullets.map((bullet) => (
            <li key={bullet} className="flex items-start gap-2.5">
              <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-500" />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      )}
      {open ? plan.questions.map((q, index) => (
        <div key={q.question} className={index === 0 ? 'mt-3.5 pt-3 shadow-[inset_0_1px_0_var(--app-sheet-line)]' : 'mt-3'}>
          <p id={`${uid}-q${index}`} className="text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{q.question}</p>
          <div role="radiogroup" aria-labelledby={`${uid}-q${index}`} className="mt-2 flex flex-col overflow-hidden rounded-[14px] bg-zinc-50 dark:bg-white/[0.06]">
            {q.answers.map((answer, j) => {
              const on = (picked[index] || q.answers[0]) === answer;
              return (
                <label key={answer} className={j === 0 ? ANSWER_ROW.first : ANSWER_ROW.next} data-bot-answer={j === 0 ? 'default' : 'other'}>
                  <input
                    type="radio"
                    className="sr-only"
                    name={`${uid}-q${index}`}
                    value={answer}
                    checked={on}
                    onChange={() => choose(index, answer)}
                  />
                  {on ? (
                    <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)]">
                      <span className="h-2 w-2 rounded-full bg-[color:var(--accent-ink)]" />
                    </span>
                  ) : (
                    <span aria-hidden="true" className="h-5 w-5 shrink-0 rounded-full ring-[1.5px] ring-inset ring-zinc-300 dark:ring-zinc-600" />
                  )}
                  <span className={on ? 'font-semibold' : 'font-normal'}>{answer}</span>
                </label>
              );
            })}
          </div>
        </div>
      )) : null}
      {open ? (
        <>
          <button
            type="button"
            className="mt-3.5 h-[50px] w-full rounded-full bg-[color:var(--accent)] text-[1.0625rem] font-semibold text-[color:var(--accent-ink)] hover:bg-[color:var(--accent-light)]"
            data-bot-plan-build=""
            onClick={() => onBuild?.(picked)}
          >Build it</button>
          <button
            type="button"
            className="mt-0.5 h-9 w-full text-[0.9375rem] font-medium text-violet-700 hover:underline dark:text-violet-300"
            data-bot-plan-change=""
            onClick={() => onChange?.()}
          >Change something</button>
        </>
      ) : null}
      {shown !== 'open' && shown !== 'replaced' && !(shown === 'built' && progress)
        ? <p className="messages-bot-answered" role="status">{PLAN_STATE_LINES[shown]}</p> : null}
      {footer}
    </div>
  );
}
