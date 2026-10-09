import { useId, useState, type ReactNode } from 'react';

import { CheckIcon, InfoCircleIcon } from '@/components/ui/icons';
import { ProgressRing } from '@/components/ui/progress-ring';

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
 * `progress`, drawn as one quiet line under the title: "Step 3 of 7" while
 * the plan waits, then "Step 4 of 7 · Build it · 10 to 25 min" once Build it
 * is pressed. A calm hierarchy (owner, 7 October): the title first, the step
 * in words with no bar, each line of the plan a row with no dot. The
 * request's activity card is not drawn beside it (./bot-plan.tsx
 * planLayout), so nothing is said twice.
 *
 * #4197: once Build it is pressed, each question stays as a small label
 * with the answer it went with under it, filled as the tapped answer was but
 * no longer a button (AnsweredChoices), and the line under it is a check and
 * "Building it" (left out when `progress` already says where the build is).
 * #4227: while the build runs (`building`; by default, while Build it pressed
 * here is on its way) the check is the activity card's spinner instead.
 * Until the server's update lands, the answers are the ones tapped here (a
 * question left alone shows its suggested answer, as the server decides it),
 * so they never blink away.
 *
 * Once its buttons go, the card says why in one quiet line: built, replaced
 * by a newer plan (its lines fold away), stopped after a week with no tap
 * (its lines stay), changes asked for, or no longer needed. Under it, a
 * host may add a `footer`: the chat's "Notify me when it's ready", right
 * after Build it is pressed there (./notify-me.tsx).
 *
 * #4488: THE SAME CARD ASKS ABOUT A COMPLICATED CHANGE (`plan.complicated`)
 * to a project that already exists: its requester sees the plan before it
 * is built. Its spec, with the before and after screens, is on the request,
 * whose card the chat draws under this one, and what they ask to change is
 * posted there for the group to see; one quiet note says both.
 *
 * Pure: no store, so the App tab draws it without the Messages screen.
 */

/** #4488: the note under a complicated change's plan while it waits. */
export const COMPLICATED_PLAN_NOTE = 'Its before and after screens are on the request below. What you ask to change is posted there, where the group can see it.';

export type PlanCardState = 'open' | 'built' | 'replaced' | 'stopped' | 'changing' | 'closed';

/** What the line under a card that is no longer open says. */
export const PLAN_STATE_LINES: Record<Exclude<PlanCardState, 'open' | 'replaced'>, string> = {
  built: 'Building it',
  stopped: 'I stopped waiting on this plan. Reply to pick it up again.',
  changing: 'You asked for changes. A new plan is on its way.',
  closed: 'No longer needed.',
};

/**
 * #4046: how far along the plan's request is, under the card's title: its
 * line, and the step it is at of how many (null when it cannot be counted).
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
  /** #4227: its build is running now; left out, while `busy`. */
  building?: boolean;
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

/** #4197: a question that was answered, and the answer it went with. */
export interface AnsweredChoice {
  question: string;
  answer: string;
}

/**
 * #4197: answered questions, each its words as a small label over the
 * answer as a filled chip: the tapped answer's look, but not a button.
 * Shared by the plan card and the bot's questions (./bot-plan.tsx,
 * ./bot-question.tsx).
 */
export function AnsweredChoices({ items, className = '' }: { items: AnsweredChoice[]; className?: string }) {
  if (!items.length) return null;
  return (
    <dl className={className ? `messages-bot-choices ${className}` : 'messages-bot-choices'} data-bot-answered="">
      {items.map((item, index) => (
        <div key={index}>
          <dt className="messages-bot-choice-label">{item.question}</dt>
          <dd><span className="messages-bot-chosen">{item.answer}</span></dd>
        </div>
      ))}
    </dl>
  );
}

/** #4197: the line under a plan once Build it is pressed: a check, or the spinner while it builds, then its words. */
export function DoneLine({ children, spinning = false }: { children: ReactNode; spinning?: boolean }) {
  return (
    <p className="messages-bot-answered messages-bot-done" role="status" data-bot-plan-building={spinning ? '' : undefined}>
      {spinning ? (
        <ProgressRing pct={0} title="Building" spinning className="h-4 w-4" trackClassName="dark:stroke-zinc-700" aria-hidden="true" />
      ) : (
        <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <span>{children}</span>
    </p>
  );
}

// Complete literals only: Tailwind's extractor reads source text.
const SURFACES = {
  messages: 'mt-1 flex max-w-[480px] flex-col rounded-[20px] bg-[color:var(--messages-surface)] px-4 pb-3 pt-4 text-left shadow-[inset_0_0_0_1px_var(--app-sheet-line)]',
  app: 'flex w-full max-w-sm flex-col rounded-[20px] bg-[color:var(--dc-sheet-solid)] px-4 pb-3 pt-4 text-left shadow-[inset_0_0_0_1px_var(--app-sheet-line)]',
} as const;

// #4046 (owner, 7 October): in the chat each line of the plan is a row of
// its own, as a grouped list draws rows (15px over a 22px line, 12px above
// and below, a hairline between), with no dot before it: the same as PR 5's
// plan page for members. No side padding, so the rows line up with the
// card's text. The App tab's card keeps its dots (#4053).
const PLAN_ROW = {
  first: 'py-3 text-[0.9375rem] leading-[22px] text-zinc-900 dark:text-zinc-100',
  next: 'py-3 text-[0.9375rem] leading-[22px] text-zinc-900 shadow-[inset_0_1px_0_var(--app-sheet-line)] dark:text-zinc-100',
} as const;

// One answer of a choice, picked or not: a 44px row with no side padding, so
// its radio lines up with the card's text, and a hairline between rows.
const ANSWER_ROW = {
  first: 'flex min-h-[44px] cursor-pointer items-center gap-2.5 py-2 text-[0.9375rem] leading-5 text-zinc-900 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-[color:var(--accent)] dark:text-zinc-100',
  next: 'flex min-h-[44px] cursor-pointer items-center gap-2.5 py-2 text-[0.9375rem] leading-5 text-zinc-900 shadow-[inset_0_1px_0_var(--app-sheet-line)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-[color:var(--accent)] dark:text-zinc-100',
} as const;

export function PlanCardView({
  appName, plan, state, choices = [], busy = false, building, onBuild, onChange, surface = 'messages', progress = null, footer = null,
}: PlanCardViewProps) {
  const [picked, setPicked] = useState<Array<string | null>>(() => plan.questions.map(() => null));
  // Build it pressed on this card: its picks stand in until `choices` land.
  const [builtHere, setBuiltHere] = useState(false);
  const uid = useId();
  const open = state === 'open' && !busy;
  const shown: PlanCardState = busy ? 'built' : state;
  const went = choices.length ? choices
    : builtHere || busy ? plan.questions.map((q, i) => picked[i] || q.answers[0] || '') : [];
  const answered: AnsweredChoice[] = shown === 'built'
    ? plan.questions.flatMap((q, i) => (went[i] ? [{ question: q.question, answer: went[i] }] : []))
    : [];
  // The App tab's card keeps its words until it goes (#4053).
  const title = surface === 'app' ? `Here’s my plan for ${appName}:` : `My plan for ${appName}`;

  function choose(index: number, answer: string) {
    setPicked((current) => current.map((value, i) => (i === index ? answer : value)));
  }

  return (
    <div className={SURFACES[surface]} role="group" aria-label={`Plan for ${appName}`} data-bot-plan={shown}>
      <div className={`text-[1.0625rem] font-bold leading-[1.375rem] ${shown === 'replaced' ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-900 dark:text-zinc-100'}`}>
        {title}
      </div>
      {progress ? (
        // The step, in words, under the title: one line whatever the width,
        // an ellipsis the last resort (owner, 7 October).
        <div className="mt-0.5 flex min-w-0" data-bot-plan-progress="">
          <span className="min-w-0 truncate text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" role="status" data-bot-plan-progress-line="">{progress.line}</span>
        </div>
      ) : null}
      {shown === 'replaced' ? (
        <p className="messages-bot-answered">Replaced by a newer plan</p>
      ) : shown === 'built' ? (
        <AnsweredChoices items={answered} className="mt-2" />
      ) : surface === 'messages' ? (
        <ul className="mt-1 flex flex-col" data-bot-plan-lines="">
          {plan.bullets.map((bullet, i) => (
            <li key={bullet} className={i === 0 ? PLAN_ROW.first : PLAN_ROW.next}>{bullet}</li>
          ))}
        </ul>
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
          <div role="radiogroup" aria-labelledby={`${uid}-q${index}`} className="mt-1 flex flex-col">
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
      {open && plan.complicated ? (
        <p className="messages-bot-note mt-2.5" data-bot-plan-note="">
          <InfoCircleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{COMPLICATED_PLAN_NOTE}</span>
        </p>
      ) : null}
      {open ? (
        <>
          <button
            type="button"
            className="mt-3 h-[50px] w-full rounded-full bg-[color:var(--accent)] text-[1.0625rem] font-semibold text-[color:var(--accent-ink)] hover:bg-[color:var(--accent-light)]"
            data-bot-plan-build=""
            onClick={() => { setBuiltHere(true); onBuild?.(picked); }}
          >Build it</button>
          <button
            type="button"
            className="mt-0.5 h-9 w-full text-[0.9375rem] font-medium text-violet-700 hover:underline dark:text-violet-300"
            data-bot-plan-change=""
            onClick={() => onChange?.()}
          >Change something</button>
        </>
      ) : null}
      {shown === 'built' ? (progress ? null : <DoneLine spinning={building ?? busy}>{PLAN_STATE_LINES.built}</DoneLine>)
        : shown !== 'open' && shown !== 'replaced' ? <p className="messages-bot-answered" role="status">{PLAN_STATE_LINES[shown]}</p> : null}
      {footer}
    </div>
  );
}
