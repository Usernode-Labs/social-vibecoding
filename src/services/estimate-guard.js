'use strict';

/**
 * Monotonicity guard for the experimental AI progress estimate (#892).
 *
 * THE PROBLEM IT SOLVES. Across 3,775 consecutive guess-to-guess
 * transitions in the production accuracy dataset, 64.7% pushed the
 * projected finish time LATER — by a median of exactly one minute, i.e.
 * every minute that passed, the finish line moved a minute further away, so
 * the countdown read "~2m left" indefinitely. 22.4% showed the remaining
 * number literally increase from the previous reading, so the user watched
 * the countdown tick UP. This holds the projection steady between refreshes
 * and only lets it move later for a stated reason.
 *
 * IT ALWAYS YIELDS A NUMBER. Every branch returns a positive
 * `displayedRemainingSeconds` — there is no overrun flag, no bail-out after
 * N extensions, and no open-ended "taking longer than expected" state. A run
 * that keeps outliving its estimate simply keeps getting extended by the
 * `expired` cause on each subsequent tick, which is the honest behaviour and
 * always produces a time. The extension rate is observable on the admin
 * dashboard (slip_reason histogram, laterRate) rather than being suppressed
 * by a counter.
 *
 * IT IS NOT CALIBRATION. The guard can only ever output the raw candidate,
 * the held previous projection, or the fixed floor. It never scales, blends
 * or derives a third number from the model's guess — calibration lives in
 * the prompt inputs (see RUN_LENGTH_PRIORS in llm.js). The RAW model value
 * is always what gets recorded in `predicted_remaining_seconds`; this
 * function's output goes to the separate `displayed_remaining_seconds`.
 *
 * Pure and dependency-free so tests/ai-progress-estimate.test.js can
 * property-check it directly.
 */

// The floor. Chosen to match the countdown's 30s rounding granularity and to
// be shorter than the 60s estimator tick, so a floored reading is replaced
// quickly rather than sitting there. This is what stops the display sticking
// at zero while waiting for the next guess.
const MIN_DISPLAY_REMAINING_S = 30;

// A candidate finish this much later than the held projection is treated as
// a trivial wobble and accepted rather than counted as an extension — the
// model re-answering "about four minutes" one tick later shouldn't register
// as the finish line moving.
const WOBBLE_GRACE_MS = 30_000;

// Null-preserving numeric coercion. `Number(null)` is 0 and `Number('')` is
// 0, which would silently turn "no projection yet" into "a projection that
// expired in 1970" and "the model declined a number" into "the model said
// zero seconds" — so absence is rejected before coercion, not after.
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * @param {object} input
 * @param {number|null} input.projectedFinishAt  Held projection (epoch ms), null on the first tick.
 * @param {number|null} input.previousRemainingSeconds  Raw value behind the held projection.
 * @param {number|null} input.remainingSeconds   RAW model guess for this tick (may be null).
 * @param {number} input.estimatedAt             When this guess was made (epoch ms).
 * @param {number} input.now                     Current wall clock (epoch ms).
 * @param {boolean} [input.newPhaseSinceLast]    Did a new phase marker land since the last accepted guess?
 * @returns {{displayedRemainingSeconds:number, projectedFinishAt:number,
 *            clamped:boolean, floored:boolean, slipReason:(string|null)}}
 */
function applyMonotonicityGuard(input) {
  const o = input || {};
  const now = num(o.now) == null ? Date.now() : num(o.now);
  const estimatedAt = num(o.estimatedAt) == null ? now : num(o.estimatedAt);
  const held = num(o.projectedFinishAt);
  const prevRemaining = num(o.previousRemainingSeconds);
  const raw = num(o.remainingSeconds);

  let chosenFinishAt;
  let clamped = false;
  let slipReason = null;

  if (raw == null || raw < 0) {
    // The model declined a number (rare — the schema requires the key and the
    // prompt insists on one). Keep running the held projection down; with no
    // held projection there is nothing to run down, so the floor applies.
    chosenFinishAt = held == null ? now : held;
  } else {
    const candidate = estimatedAt + raw * 1000;
    if (held == null || candidate <= held + WOBBLE_GRACE_MS) {
      // First guess of the run, moving the finish EARLIER, or a trivial
      // wobble — always accepted. Earlier is never suspicious.
      chosenFinishAt = candidate;
    } else if (now >= held) {
      // The projection already ran out and the run is still going. It MUST
      // extend — this is the branch that keeps a long run showing a real,
      // growing estimate instead of a frozen clock.
      slipReason = 'expired';
      chosenFinishAt = candidate;
    } else if (o.newPhaseSinceLast) {
      // The run moved to a new stage since the last accepted guess; a
      // re-scoped estimate is legitimate.
      slipReason = 'new_phase';
      chosenFinishAt = candidate;
    } else if (prevRemaining != null && prevRemaining > 0 && raw >= 2 * prevRemaining) {
      // A substantial deliberate revision (the model at least doubled its
      // view), as opposed to the one-minute-per-minute treadmill.
      slipReason = 'revision';
      chosenFinishAt = candidate;
    } else {
      // No cause: hold the existing projection rather than resetting the
      // clock. This is the treadmill fix.
      clamped = true;
      chosenFinishAt = held;
    }
  }

  // Floor, unconditionally, at the end of EVERY branch. This is the
  // "never sticks at zero" rule and the reason the function's contract is
  // "always a positive number of seconds".
  let displayed = Math.round((chosenFinishAt - now) / 1000);
  let floored = false;
  if (!(displayed > MIN_DISPLAY_REMAINING_S)) {
    displayed = MIN_DISPLAY_REMAINING_S;
    floored = true;
    // Re-anchor so the client counts down from the floored value instead of
    // from a target already in the past.
    chosenFinishAt = now + displayed * 1000;
  }

  return {
    displayedRemainingSeconds: displayed,
    projectedFinishAt: chosenFinishAt,
    clamped,
    floored,
    slipReason,
  };
}

module.exports = { applyMonotonicityGuard, MIN_DISPLAY_REMAINING_S, WOBBLE_GRACE_MS };
