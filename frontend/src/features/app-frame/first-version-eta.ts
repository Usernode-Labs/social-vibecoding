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
 *                       about 12 min left
 *
 * in whole minutes, never "0": the last minute is "about 1 min left". Once
 * the step under way runs past its own estimate both say "taking a little
 * longer than usual", rather than freezing at a number or counting below
 * zero; the next step brings a fresh estimate. Without an estimate (too few
 * first versions to go on) nothing is said about time left, and the screen
 * says what it said before.
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
 * The words for the time left at `now` (ms): to the first version going
 * live, or with `step`, to the end of the step under way. "about 15 min
 * left"; "taking a little longer than usual" once the step under way has
 * run past its estimate; null without an estimate. Pure.
 */
export function leftNote(estimate: FirstVersionEstimate | null, now: number, { step = false }: { step?: boolean } = {}): string | null {
  if (!estimate || !Number.isFinite(now)) return null;
  const stepEnd = time(estimate.stepEtaAt);
  const end = time(estimate.etaAt);
  if (stepEnd == null || end == null) return null;
  if (now >= stepEnd) return translate('onboarding:buildLine.longer');
  return translate('onboarding:buildLine.left', { count: minutesLeft(step ? stepEnd : end, now) });
}

/** The note for the step `key` of the list, when the estimate is for it. Pure. */
export function stepLeftNote(estimate: FirstVersionEstimate | null, key: string, now: number): string | null {
  return estimate && estimate.step === key ? leftNote(estimate, now, { step: true }) : null;
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
