'use strict';

/**
 * Per-app creation-phase tracker.
 *
 * `apps.status` has no intermediate value between `'creating'` and its
 * terminal ones (`'running'` / `'awaiting_secrets'` / `'error'`), so the
 * row cannot say WHICH part of `createApp` is currently running. This
 * map carries that one extra bit — `slug → { phase, startedAt }` — so
 * the create dialog can tick its four steps off as they actually
 * happen instead of guessing on a timer.
 *
 * Why a sibling of `app-deploy-status.js` and not a field on it?
 * Two reasons, and the first is the load-bearing one:
 *
 *   1. `app-deploy-status` broadcasts through the UNSCOPED
 *      `broadcastGlobal`. A brand-new app may be view-private, and its
 *      name and slug are not public until it is. Creation phases
 *      therefore go out through `ws.pushAppCreationPhase`, which uses
 *      `broadcastGlobalScoped` exactly as `pushAppStatusUpdate` does.
 *   2. The semantics differ: that module tracks a PRODUCTION REDEPLOY
 *      of an app that already exists and is a boolean (`deploying`);
 *      this one tracks the one-shot creation of an app that does not
 *      exist yet and is an ordered position within it.
 *
 * Why in-memory and not a DB column? Same answer `app-deploy-status`
 * gives: `apps.status` is load-bearing elsewhere (URL computation in
 * routes/apps.js gates on `status='running'`), and adding values to it
 * would ripple through every consumer of the status vocabulary for
 * what is a transient display detail.
 *
 * Why no persistence across restarts? If the platform restarts
 * mid-creation the `createApp` job dies with it — there is nothing left
 * to report a phase for. The creation watchdog in routes/apps.js flips
 * the stranded row to `'error'`, and until it does, a missing phase
 * reads as "in progress, step unknown", which is exactly true.
 */

// Creation is watchdogged at CREATION_TIMEOUT_MS (5 minutes) in
// routes/apps.js. Anything still claiming a phase well past that is an
// orphan from a process that died mid-run rather than a genuinely slow
// build, and we would rather report nothing than spin a step forever.
const PHASE_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * The ordered vocabulary, one entry per numbered block in `createApp`:
 *
 *   database   → per-app Postgres database + dedicated role
 *   repository → GitHub repo create + template push (or import)
 *   build      → clone the working tree and build the image
 *   deploy     → start the container and wire up routing
 *
 * The dialog renders these in order and treats every phase before the
 * current one as done, so the order here IS the step list.
 */
const PHASES = ['database', 'repository', 'build', 'deploy'];

// slug → { phase, startedAt: ISO }
const _state = new Map();

/**
 * Record that `slug` has reached `phase`.
 *
 * `startedAt` marks the start of CREATION, not of the phase — it is the
 * age used for the stale gate below, so it must not be pushed forward
 * every time a step advances.
 */
function markPhase(slug, phase) {
  if (!slug || !PHASES.includes(phase)) return;
  const prev = _state.get(slug);
  _state.set(slug, {
    phase,
    startedAt: prev ? prev.startedAt : new Date().toISOString(),
  });
}

/** Forget `slug` — creation reached a terminal status. */
function clear(slug) {
  if (!slug) return;
  _state.delete(slug);
}

/** The current phase for `slug`, or null when there is none to report. */
function read(slug) {
  if (!slug) return null;
  const entry = _state.get(slug);
  if (!entry) return null;
  // Don't auto-delete on the stale path: `createApp`'s try/finally owns
  // the lifecycle, and pretending the entry is gone is enough to unstick
  // the UI.
  const age = Date.now() - new Date(entry.startedAt).getTime();
  if (age > PHASE_STALE_AFTER_MS) return null;
  return { ...entry };
}

module.exports = { markPhase, clear, read, PHASES, PHASE_STALE_AFTER_MS };
