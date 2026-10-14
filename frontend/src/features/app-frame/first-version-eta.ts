/**
 * Run six (14 Oct 2026): the time a first version still has to go, on its
 * App tab, in place of the time it has run.
 *
 * The build line said "Building it · 2 min so far" and the step under way
 * in HOW IT'S GOING said nothing at all about time, while a first version
 * took about 23 minutes. The server now answers an estimate from the first
 * versions that went live lately (`first_version.estimate`,
 * services/first-version-eta.js): when the step under way usually ends
 * (`stepEtaAt`) and when the first version usually goes live (`etaAt`).
 * This counts down to them:
 *
 *   the line            Building it · about 15 min left
 *   the step under way  Building
 *
 * in whole minutes, never "0": the last minute is "about 1 min left". Once
 * the step under way runs past its own estimate, the step says "taking a
 * little longer than usual", rather than freezing at a number or counting
 * below zero; the next step brings a fresh estimate. Without an estimate
 * (too few first versions to go on) nothing is said about time left, and
 * the screen says what it said before.
 *
 * Run seven (14 Oct 2026, iPhone Safari, Club Votes):
 *
 *   ONE TIME PER SCREEN. The App tab said "Writing the plan · about 28 min
 *   left" on the line and "Writing the plan · about 17 min left" under the
 *   step under way: two times on one screen. With an estimate the step
 *   says its words only (stepOverrunNote), and the line keeps the time to
 *   live.
 *
 *   NOT LONGER UNTIL IT IS. Once the step under way ran past its estimate,
 *   the line said "taking a little longer than usual" with the later steps
 *   all still to come: 12 minutes before it went live, after a countdown
 *   that had been right to 2 minutes. Now the line goes on counting the
 *   later steps' usual time, as if the step under way ended now (leftNote),
 *   and says "taking a little longer than usual" only when no later step
 *   is left to count.
 */

import { t as translate } from '../../lib/i18n/runtime';
import { STEP_WORDS } from '../first-session/build-line-words.js';

export interface FirstVersionEstimate {
  /** The step under way the estimate starts from (a STEP_WORDS key). */
  step: keyof typeof STEP_WORDS;
  /** When that step usually ends. */
  stepEtaAt: string;
  /** When the first version usually goes live. */
  etaAt: string;
}

function time(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** The estimate in an answer, cleaned, or null. Pure. */
export function estimateOf(value: unknown): FirstVersionEstimate | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.step !== 'string' || !Object.prototype.hasOwnProperty.call(STEP_WORDS, v.step)) return null;
  const stepEnd = time(v.stepEtaAt);
  const end = time(v.etaAt);
  if (stepEnd == null || end == null || end < stepEnd) return null;
  return { step: v.step as FirstVersionEstimate['step'], stepEtaAt: v.stepEtaAt as string, etaAt: v.etaAt as string };
}

/** Whole minutes from `now` to `at` (ms), at least 1. Pure. */
export function minutesLeft(at: number, now: number): number {
  return Math.max(1, Math.round((at - now) / 60000));
}

/**
 * When the first version should be live, as the line counts to it at `now`
 * (ms): the estimate's `etaAt` while the step under way is within its usual
 * time; past it, `now` plus the later steps' usual time (`etaAt` less
 * `stepEtaAt`), as if the step under way ended now; null without an
 * estimate, or once no later step is left to count (under a minute):
 * then it is only taking longer (run seven, NOT LONGER UNTIL IT IS). Pure.
 */
export function liveAt(estimate: FirstVersionEstimate | null, now: number): number | null {
  if (!estimate || !Number.isFinite(now)) return null;
  const stepEnd = time(estimate.stepEtaAt);
  const end = time(estimate.etaAt);
  if (stepEnd == null || end == null) return null;
  if (now < stepEnd) return end;
  const rest = end - stepEnd;
  return rest >= 60000 ? now + rest : null;
}

/**
 * The words for the time left at `now` (ms): to the first version going
 * live, or with `step`, to the end of the step under way. "about 15 min
 * left"; null without an estimate. "taking a little longer than usual":
 * for the step, once it has run past its estimate; for the line, only once
 * no later step is left to count (liveAt), else the later steps' usual
 * time. Pure.
 */
export function leftNote(estimate: FirstVersionEstimate | null, now: number, { step = false }: { step?: boolean } = {}): string | null {
  if (!estimate || !Number.isFinite(now)) return null;
  const stepEnd = time(estimate.stepEtaAt);
  const end = time(estimate.etaAt);
  if (stepEnd == null || end == null) return null;
  if (step) {
    if (now >= stepEnd) return translate('onboarding:buildLine.longer');
    return translate('onboarding:buildLine.left', { count: minutesLeft(stepEnd, now) });
  }
  const live = liveAt(estimate, now);
  if (live == null) return translate('onboarding:buildLine.longer');
  return translate('onboarding:buildLine.left', { count: minutesLeft(live, now) });
}

/**
 * The note for the step `key` of the list, when the estimate is for it:
 * nothing while the step is within its usual time (the line says the time
 * to live, the one time on the screen), and "taking a little longer than
 * usual" once it has run past it (run seven, ONE TIME PER SCREEN). Pure.
 */
export function stepOverrunNote(estimate: FirstVersionEstimate | null, key: string, now: number): string | null {
  if (!estimate || estimate.step !== key || !Number.isFinite(now)) return null;
  const stepEnd = time(estimate.stepEtaAt);
  return stepEnd != null && now >= stepEnd ? leftNote(estimate, now, { step: true }) : null;
}

/** The lines that count down: the first version is being built or tested. */
export function countsDown(line: string | null): boolean {
  return line === 'building' || line === 'testing';
}

/**
 * The card's line note when the line names no stage (no `phase`): what the
 * build is adding and the time left ("Adding the tier rows · about 15 min
 * left"), else whichever there is, else how long it usually takes (a
 * member's "usually 10 to 25 min", which the estimate replaces). Pure.
 */
export function plainLineNote(caption: string | null, usual: string | null, left: string | null): string | null {
  if (caption && left) return translate('onboarding:buildLine.withNote', { line: caption, note: left });
  return caption || left || usual;
}
