/**
 * N4 (newcomer run four, 12-13 Oct 2026): HOW IT'S GOING, under a first
 * version's thumbnail on its App tab while Homeroom bot makes it.
 *
 * In run four the build line said "Building it" for 36 minutes, through the
 * spec, the build and two review rounds, and the build agent's last phrase
 * ("Adding the ballot bar") stood the whole time. Now the line names the
 * stage it is at (../first-session/build-line.tsx phaseLine), and this lists
 * every step, in order (services/homeroom-bot-progress.js
 * firstVersionSteps, `first_version.steps`):
 *
 *   Plan written · Screens drawn · Building · Checking the screens ·
 *   Testing · Live
 *
 * A grouped list in the house style: the small-caps label over the plane's
 * card, rows 15 over 13. A done step is a quiet check and the time it took
 * ("3 min"; none under a minute: zero says nothing), with no fill: a done
 * thing is never the loudest thing on screen. The step under way turns, its
 * line saying what it is doing now (the review's round, the build's
 * "Adding …") and how long it still has to go ("about 12 min left", run six:
 * ./first-version-eta.ts), or, with no estimate to go on, how long it has
 * run ("7 min so far"). The rest are hollow and say nothing. A review that
 * did not run is left out. No accent: nothing here asks the viewer for
 * anything.
 */

import type { ReactNode } from 'react';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { CheckIcon, SpinnerRingIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { soFarNote, useNow } from '../first-session/build-line';
import { STEP_WORDS, phaseOf, stepsOf } from '../first-session/build-line-words.js';
import { type FirstVersionEstimate, stepLeftNote } from './first-version-eta';

export type FirstVersionStep = { key: keyof typeof STEP_WORDS; state: 'done' | 'now' | 'next'; minutes?: number; since?: string };

/**
 * Pure: the line under one step's title, in the language on screen, at
 * `now` (ms): how long a done step took; for the step under way, what it is
 * doing (the review's round, the build's phrase) and how long it still has
 * to go by `estimate`, else for how long it has run; nothing for a step
 * still to come.
 */
export function stepNote(step: FirstVersionStep, now: number, { phase = null, caption = null, estimate = null }: { phase?: unknown; caption?: string | null; estimate?: FirstVersionEstimate | null } = {}): string | null {
  if (step.state === 'done') return step.minutes ? translate('onboarding:buildLine.step.took', { count: step.minutes }) : null;
  if (step.state !== 'now') return null;
  const p = phaseOf(phase) as { key: string; round: number | null; rounds: number | null } | null;
  const doing = step.key === 'check' && p && p.key === 'checking'
    ? translate('onboarding:buildLine.step.round', { round: p.round || 1, rounds: p.rounds || p.round || 1 })
    : step.key === 'build' && p && p.key === 'writing'
      ? translate('onboarding:buildLine.phase.writing')
      : step.key === 'build' && caption ? caption : null;
  const time = stepLeftNote(estimate, step.key, now) || soFarNote(step.since, now);
  if (doing && time) return translate('onboarding:buildLine.withNote', { line: doing, note: time });
  return doing || time;
}

function Marker({ state }: { state: FirstVersionStep['state'] }): ReactNode {
  if (state === 'done') return <CheckIcon className="h-5 w-5 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />;
  if (state === 'now') return <SpinnerRingIcon className="h-5 w-5 shrink-0 animate-spin text-zinc-500 motion-reduce:animate-none dark:text-zinc-400" aria-hidden="true" />;
  return <span aria-hidden="true" className="h-5 w-5 shrink-0 rounded-full ring-[1.5px] ring-inset ring-zinc-300 dark:ring-zinc-600" />;
}

// The titles: the step under way in the ink, the others quiet.
const TITLE = {
  done: 'font-normal text-zinc-500 dark:text-zinc-400',
  now: '',
  next: 'font-normal text-zinc-500 dark:text-zinc-400',
} as const;

/** The list, or nothing when the answer has no steps to list. */
export function FirstVersionSteps({ steps: raw, phase = null, caption = null, estimate = null }: {
  steps: unknown; phase?: unknown; caption?: string | null; estimate?: FirstVersionEstimate | null;
}): ReactNode {
  const t = useMessages('onboarding');
  const now = useNow();
  const steps = stepsOf(raw) as FirstVersionStep[];
  if (!steps.length) return null;
  return (
    <section data-app-first-version-steps="" className="w-full max-w-[342px] text-left">
      <SectionHeader className="px-1 pb-1.5 pt-4">{t('onboarding:buildLine.stepsLabel')}</SectionHeader>
      <GroupedList tone="plane" className="mx-0">
        {steps.map((step) => (
          <ListRow
            key={step.key}
            data-step={step.key}
            data-step-state={step.state}
            inset="text"
            chevron={false}
            leading={<Marker state={step.state} />}
            title={t(STEP_WORDS[step.key])}
            titleClassName={TITLE[step.state]}
            subtitle={stepNote(step, now, { phase, caption, estimate })}
            {...(step.state === 'now' ? { 'aria-current': 'step' as const } : {})}
          />
        ))}
      </GroupedList>
    </section>
  );
}
