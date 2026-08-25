/**
 * The create dialog's progress model.
 *
 * `POST /api/apps` returns 201 with the row still in `'creating'` — the
 * provisioning runs async server-side. The dialog used to close on that
 * 201 and leave a one-line toast behind; it now stays open and narrates
 * the four steps `createApp` actually walks through.
 *
 * ── Where the updates come from ───────────────────────────────────────
 *
 * `services/app-creator.js` reports each phase over the EXISTING
 * `app_status` WS message (`ws.pushAppCreationPhase`), which
 * `App.handleAppStatusUpdate` in public/js/app.js already receives. That
 * file is a classic script and cannot import from this bundle, so it
 * writes through the `window.UsernodeReact` bridge at the bottom — the
 * same seam every chunk-H store uses.
 *
 * A page loaded (or reloaded) mid-creation has no broadcasts to replay,
 * so the dialog also seeds itself once from `GET /api/apps/:slug`, which
 * serves the same phase out of the server-side in-memory store.
 *
 * ── Why the branching lives here and not in the JSX ───────────────────
 *
 * The awkward cases are the ones worth pinning: a phase we never heard
 * (the platform process restarted mid-run), a failure that has to say
 * WHICH step died, and `awaiting_secrets`, which is a stop rather than a
 * failure. Keeping `stepStates` pure means tests/creation-progress-store.test.js
 * can assert all of them in Node, without a browser.
 *
 * @typedef {'database'|'repository'|'build'|'deploy'} CreationPhase
 * @typedef {'pending'|'live'|'needs-secrets'|'failed'} CreationOutcome
 * @typedef {'idle'|'active'|'done'|'failed'} StepState
 * @typedef {{ slug: string|null, status: string|null, phase: CreationPhase|null,
 *             url: string|null, errorReason: string|null,
 *             missingSecrets: string[]|null }} CreationProgressState
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * The four steps, in the order `createApp` runs them. This list IS the
 * step list the dialog renders, and its keys are the phase vocabulary
 * `services/app-creation-phase.js` validates against — keep the two in
 * sync.
 */
export const CREATION_STEPS = [
  { key: 'database', label: 'Setting up your database' },
  { key: 'repository', label: 'Preparing the repository' },
  { key: 'build', label: 'Building your app' },
  { key: 'deploy', label: 'Going live' },
];

export const INITIAL_CREATION_PROGRESS = /** @type {CreationProgressState} */ ({
  slug: null,
  status: null,
  phase: null,
  url: null,
  errorReason: null,
  missingSecrets: null,
});

export const creationProgressStore = createStore(INITIAL_CREATION_PROGRESS);

/**
 * Start following `slug`, discarding whatever the previous creation left
 * behind. Called when the dialog switches to its progress view.
 */
export function watchCreation(slug) {
  creationProgressStore.set({
    ...INITIAL_CREATION_PROGRESS,
    slug: slug || null,
    status: 'creating',
  });
}

/** Stop following anything — the dialog closed. */
export function stopWatchingCreation() {
  creationProgressStore.set({ ...INITIAL_CREATION_PROGRESS });
}

/**
 * Fold one `app_status` broadcast in.
 *
 * Broadcasts for other apps are dropped: the global socket carries every
 * app the viewer can see, and another app going live must not tick this
 * dialog's steps. Fields absent from the payload are LEFT ALONE rather
 * than nulled — the terminal messages carry no `phase`, and the failure
 * view needs the last one to say which step died.
 */
export function publishAppStatus(data) {
  if (!data || !data.slug) return;
  const state = creationProgressStore.get();
  if (!state.slug || data.slug !== state.slug) return;
  creationProgressStore.set({
    status: data.status || state.status,
    phase: data.phase || state.phase,
    url: data.url || state.url,
    errorReason: data.errorReason || state.errorReason,
    missingSecrets: data.missingSecrets || state.missingSecrets,
  });
}

/**
 * What the dialog shows for a server status.
 *
 * An unrecognised status reads as 'pending' on purpose: the status
 * vocabulary is not constrained by the schema, and inventing a failure
 * screen for a value we simply do not know about is the worse error.
 */
export function outcomeOf(status) {
  if (status === 'running') return 'live';
  if (status === 'awaiting_secrets') return 'needs-secrets';
  if (status === 'error') return 'failed';
  return 'pending';
}

/**
 * The per-step display state, one entry per CREATION_STEPS row.
 *
 * @returns {StepState[]}
 */
export function stepStates({ phase, status }) {
  const outcome = outcomeOf(status);
  if (outcome === 'live') return CREATION_STEPS.map(() => 'done');

  const at = CREATION_STEPS.findIndex((s) => s.key === phase);
  // No phase to place: a platform process that restarted mid-run, or a
  // creation so fast every broadcast was missed. Claiming progress we
  // cannot see would be worse than showing none — the headline and the
  // reason line carry the state instead.
  if (at < 0) return CREATION_STEPS.map(() => 'idle');

  return CREATION_STEPS.map((_, i) => {
    if (i < at) return 'done';
    if (i > at) return 'idle';
    if (outcome === 'failed') return 'failed';
    // 'needs-secrets' stops between the repository and build steps, so
    // the step that reported itself genuinely finished. It is a gate,
    // not a failure.
    if (outcome === 'needs-secrets') return 'done';
    return 'active';
  });
}

/**
 * Ask the server where `slug` has got to, and fold the answer in.
 *
 * The WS broadcasts are the fast path; this is the one that survives a
 * socket that dropped right before the terminal event, which would
 * otherwise leave a step spinning forever. It is also what fills the
 * first paint, before any broadcast has had time to arrive.
 *
 * `fetchImpl` is injected so the field renaming below — the route calls
 * the phase `creationPhase` and buries the failure reason inside
 * `lastFailure`, and neither name matches this store's — is testable in
 * Node. A poll that fails changes nothing and never throws: the next one
 * is seconds away, and the socket may well beat it.
 */
export async function fetchCreationProgress(slug, fetchImpl) {
  if (!slug) return;
  try {
    const res = await fetchImpl(`/api/apps/${encodeURIComponent(slug)}`);
    if (!res || !res.ok) return;
    const body = await res.json();
    const app = body && body.app;
    if (!app) return;
    publishAppStatus({
      slug,
      status: app.status,
      phase: app.creationPhase,
      url: app.url,
      errorReason: app.lastFailure ? app.lastFailure.reason : null,
      missingSecrets: app.missingSecrets,
    });
  } catch {
    /* see the note above — a failed poll is a no-op, not an error state */
  }
}

if (typeof window !== 'undefined') {
  const w = /** @type {any} */ (window);
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.appCreationProgress = {
    publish: (data) => publishAppStatus(data),
  };
}
