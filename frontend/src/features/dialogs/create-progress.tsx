/**
 * The create dialog's progress view.
 *
 * `POST /api/apps` returns 201 with the row still in `'creating'`, so
 * "created" is the START of the interesting part, not the end of it.
 * Before this the dialog closed on the 201 and left a one-line toast;
 * now it stays open and reports the four steps `createApp` actually
 * walks through, then resolves into one of three endings.
 *
 * ── Why this component is pure ────────────────────────────────────────
 *
 * It takes the store state and four callbacks and renders. The
 * subscription, the WS wiring and the `GET /api/apps/:slug` poll all
 * live in the parent (create-app.tsx). That split is what lets
 * tests/create-progress-view.test.js render every outcome — including
 * the awkward ones, a failure with no reason and a creation whose phases
 * were never heard — in Node, where effects do not run at all.
 *
 * ── Why no new shell dialog ───────────────────────────────────────────
 *
 * This subtree renders only after the user submits, so it is absent from
 * the prerender pass and adds nothing to public/index.html. That keeps
 * `tests/baselines/shell-markup.json`, the id inventory and the 338
 * declared dapp.json selectors untouched — a separate tenth dialog would
 * have needed entries in all three.
 */

import { CheckIcon, SpinnerArcIcon, WarningTriangleIcon, XIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';

import {
  CREATION_STEPS,
  outcomeOf,
  stepStates,
  type CreationProgressState,
  type CreationOutcome,
  type StepState,
} from './creation-progress-store.js';

export interface CreateProgressProps {
  /** The name the user typed. Rendered as a text child — never markup. */
  appName: string;
  /** Which verb to use: an import is not a creation. */
  mode: 'new' | 'import';
  progress: CreationProgressState;
  onOpenApp: () => void;
  onRetry: () => void;
  onSetSecrets: () => void;
  onClose: () => void;
}

/** The glyph for one step, keyed by its state. */
function StepGlyph({ state }: { state: StepState }) {
  if (state === 'done') {
    return <CheckIcon className="h-4 w-4 text-violet-500" aria-hidden="true" />;
  }
  if (state === 'active') {
    return <SpinnerArcIcon className="h-4 w-4 animate-spin text-violet-500" aria-hidden="true" />;
  }
  if (state === 'failed') {
    return <XIcon className="h-4 w-4 text-red-500" aria-hidden="true" />;
  }
  // Idle: an empty ring, so the row still occupies the same box and the
  // list does not reflow as steps light up.
  return (
    <span
      className="h-4 w-4 rounded-full border border-zinc-300 dark:border-zinc-700"
      aria-hidden="true"
    />
  );
}

const STEP_LABEL_CLASS: Record<StepState, string> = {
  done: 'text-zinc-500 dark:text-zinc-400',
  active: 'text-zinc-900 dark:text-zinc-100 font-medium',
  failed: 'text-red-600 dark:text-red-400 font-medium',
  idle: 'text-zinc-400 dark:text-zinc-600',
};

function headline(outcome: CreationOutcome, mode: 'new' | 'import', appName: string): string {
  if (outcome === 'live') return `${appName} is live`;
  if (outcome === 'needs-secrets') return 'Almost there';
  if (outcome === 'failed') return `Couldn’t finish ${appName}`;
  return mode === 'import' ? `Importing ${appName}` : `Creating ${appName}`;
}

/**
 * The one line under the steps. It is the `aria-live` region, so it is
 * also what a screen reader hears as the state moves.
 */
function statusLine(progress: CreationProgressState, outcome: CreationOutcome): string {
  if (outcome === 'live') {
    return 'Your app is running. Open it to see what it shipped with.';
  }
  if (outcome === 'needs-secrets') {
    const keys = progress.missingSecrets || [];
    return keys.length
      ? `Set ${keys.join(', ')} and your app will finish starting.`
      : 'Set the required secrets and your app will finish starting.';
  }
  if (outcome === 'failed') {
    // The broadcast reason is a concise one-liner (the full build log
    // stays behind the gated app payload). When there is none — a
    // watchdog timeout, or a process that died before recording one —
    // say what we actually know rather than showing an empty box.
    return progress.errorReason
      || 'Setup stopped before your app was running. Retrying usually clears a transient failure.';
  }
  return 'This usually takes under a minute. You can close this and keep going. We’ll finish in the background and your app will appear in your apps.';
}

/** The three things to do next, once there is an app to do them to. */
const NEXT_STEPS = [
  'Open your app and try what it shipped with.',
  'Describe a change in chat, and a coding agent writes it.',
  'Collaborators vote it in, and it goes live.',
];

export function CreateProgress({
  appName,
  mode,
  progress,
  onOpenApp,
  onRetry,
  onSetSecrets,
  onClose,
}: CreateProgressProps) {
  const outcome = outcomeOf(progress.status);
  const states = stepStates(progress);

  return (
    <div id="create-progress" className="space-y-4">
      <h2 id="create-progress-title" className="text-lg font-bold">
        {headline(outcome, mode, appName)}
      </h2>

      <ol id="create-progress-steps" className="space-y-2.5">
        {CREATION_STEPS.map((step, i) => (
          <li
            key={step.key}
            data-step={step.key}
            data-state={states[i]}
            className="flex items-center gap-2.5 text-sm"
          >
            <StepGlyph state={states[i]} />
            <span className={STEP_LABEL_CLASS[states[i]]}>{step.label}</span>
          </li>
        ))}
      </ol>

      <p
        id="create-progress-status"
        aria-live="polite"
        className={
          outcome === 'failed'
            ? 'text-sm text-red-600 dark:text-red-400'
            : 'text-sm text-zinc-500 dark:text-zinc-400'
        }
      >
        {outcome === 'failed' || outcome === 'needs-secrets' ? (
          <WarningTriangleIcon
            className="inline-block h-4 w-4 mr-1.5 -mt-0.5"
            aria-hidden="true"
          />
        ) : null}
        {statusLine(progress, outcome)}
      </p>

      {/*
          Next steps belong under a creation that is going somewhere. Under
          a failure they are noise — the only useful next step there is the
          Retry button below.
      */}
      {outcome === 'failed' ? null : (
        <div
          id="create-progress-next"
          // The dialog card is `bg-white dark:bg-zinc-900`, so an inset
          // block must not reach for that same dark tone — it would be
          // invisible against the card. This is the treatment the
          // dialog's own segmented pills already use.
          className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 p-3"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">
            What happens next
          </p>
          <ol className="space-y-1.5">
            {NEXT_STEPS.map((line, i) => (
              <li key={line} className="flex gap-2 text-sm text-zinc-600 dark:text-zinc-300">
                <span className="text-zinc-500 dark:text-zinc-500 tabular-nums">{i + 1}.</span>
                <span>{line}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          id="create-progress-close"
          className="flex-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
          onClick={onClose}
        >
          {outcome === 'pending' ? 'Close' : 'Done'}
        </button>
        {outcome === 'live' ? (
          <Button type="button" id="create-progress-primary" layout="flex" onClick={onOpenApp}>
            Open app
          </Button>
        ) : null}
        {outcome === 'needs-secrets' ? (
          <Button type="button" id="create-progress-primary" layout="flex" onClick={onSetSecrets}>
            Set secrets
          </Button>
        ) : null}
        {outcome === 'failed' ? (
          <Button type="button" id="create-progress-primary" layout="flex" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}
