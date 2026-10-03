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
 * It takes the store state and its callbacks and renders. The
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

export type Builder = 'bot' | 'request' | null;
/** services/communities.js's audiences, as the create dialog names them. */
export type Audience = 'solo' | 'invited' | 'open';

export interface CreateProgressProps {
  /** The name the user typed. Rendered as a text child — never markup. */
  appName: string;
  /** Which verb to use while the asynchronous provisioning is pending. */
  mode: 'new' | 'import' | 'fork';
  /**
   * Which ground the view is drawn on. `card` (the default) is the fork
   * dialog's white card, where the steps sit bare and the next-steps block
   * is a bordered inset. `pane` is the create dialog's grey pane ground
   * (#1910), where both become white cards floating on it and the actions
   * are pills, matching the form view that preceded them.
   */
  surface?: 'card' | 'pane';
  progress: CreationProgressState;
  /**
   * Who takes the project on from its description (#13, #14). `bot`: the
   * Homeroom bot builds its first version and says so in its DM. `request`:
   * the description is filed as the project's first request, for the group.
   * Null (an import, a fork): nothing is built from a description.
   */
  builder?: Builder;
  /** Who the project is for, which decides who approves its changes. Null for a fork. */
  audience?: Audience | null;
  /**
   * The live ending's primary label. "Open app" (the default) for the fork
   * dialog; the create dialog lands on the new project's own page instead
   * and says "Open project" (communities, stage 3).
   */
  openLabel?: string;
  onOpenApp: () => void;
  /**
   * #13: the bot case's way to the app itself. Its page says the first
   * version is being built (public/js/app-view.js, #15) and offers the
   * starter meanwhile, so it is worth a button beside the bot's DM.
   */
  onViewApp?: () => void;
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

function headline(
  outcome: CreationOutcome,
  mode: 'new' | 'import' | 'fork',
  appName: string,
): string {
  if (outcome === 'live') return `${appName} is live`;
  if (outcome === 'needs-secrets') return 'Almost there';
  if (outcome === 'failed') return `Couldn’t finish ${appName}`;
  if (mode === 'fork') return `Forking ${appName}`;
  return mode === 'import' ? `Importing ${appName}` : `Creating ${appName}`;
}

/**
 * The one line under the steps. It is the `aria-live` region, so it is
 * also what a screen reader hears as the state moves.
 */
function statusLine(
  progress: CreationProgressState,
  outcome: CreationOutcome,
  states: readonly StepState[] = [],
  { builder = null, appName = '' }: { builder?: Builder; appName?: string } = {},
): string {
  if (outcome === 'live') {
    // #13: what is running now is the starter. The bot's DM had just said
    // it would build the first version and send it to try, and this line
    // used to send the person off to "see what it shipped with".
    if (builder === 'bot') {
      return `${appName} is set up. Homeroom bot is building its first version from your description `
        + 'and will message you when it’s ready to try.';
    }
    if (builder === 'request') return 'Your project is ready. Its first request is waiting on its page.';
    return 'Your app is running. Open it to see what it shipped with.';
  }
  if (outcome === 'needs-secrets') {
    const keys = progress.missingSecrets || [];
    return keys.length
      ? `Set ${keys.join(', ')} and your app will finish starting.`
      : 'Set the required secrets and your app will finish starting.';
  }
  if (outcome === 'failed') {
    // QA 2026-09-24 Q32b: the broadcast reason is the server's own line
    // ("Build failed: ERROR: failed to connect to the docker API at
    // unix:///var/run/docker.sock…"), which is for whoever runs the server,
    // not for the person who asked for an app. The line says what happened
    // in plain words; the reason itself sits under Details below. When there
    // is none (a watchdog timeout, or a process that died before recording
    // one), say what we actually know rather than showing an empty box.
    if (!progress.errorReason) {
      return 'Setup stopped before your app was running. Retrying usually clears a transient failure.';
    }
    const failed = CREATION_STEPS[states.indexOf('failed')]?.key;
    return failed === 'build'
      ? 'The build didn’t finish. Try again, or ask an admin.'
      : 'Setup didn’t finish. Try again, or ask an admin.';
  }
  return 'This usually takes under a minute. You can close this and keep going. We’ll finish in the background and your app will appear in your apps.';
}

/** The three things to do next, once there is an app to do them to. */
const NEXT_STEPS = [
  'Open your app and try what it shipped with.',
  'Describe a change in chat, and a coding agent writes it.',
  'Collaborators vote it in, and it goes live.',
] as const;

/**
 * What happens next, in the order it happens (#14). The fixed three lines
 * told somebody whose first version the Homeroom bot was already building
 * to open the starter and describe a change, and told somebody making a
 * project for just themselves that collaborators vote. Who builds from the
 * description decides the first two lines, and who the project is for the
 * last: on a Just me project the one vote is the creator's
 * (services/active-users.js counts its one member, so one Yes merges). A
 * fork keeps the three lines it had. Exported and pure for
 * tests/create-progress-view.test.js.
 */
export function nextSteps({ builder = null, audience = null, mode = 'new' }: {
  builder?: Builder;
  audience?: Audience | null;
  mode?: 'new' | 'import' | 'fork';
} = {}): readonly string[] {
  if (mode === 'fork') return NEXT_STEPS;
  const approve = audience === 'solo' ? 'You approve it, and it goes live.'
    : audience ? 'Members vote it in, and it goes live.' : NEXT_STEPS[2];
  if (builder === 'bot') {
    return [
      'Homeroom bot builds the first version from your description.',
      'It messages you in your chat when it’s ready, and asks there if anything is unclear.',
      approve,
    ];
  }
  if (builder === 'request') {
    return [
      'Your description is the project’s first request.',
      'Start a change from it, and a coding agent writes it.',
      approve,
    ];
  }
  return [NEXT_STEPS[0], NEXT_STEPS[1], approve];
}

/**
 * The two surfaces, keyed by `surface`. Every string a complete literal, for
 * the extractor. The pane's cards are `dark:bg-zinc-800` for the reason
 * create-app.tsx gives: the pane ground is darker than the page ground in
 * dark mode, and the language's zinc-900 card did not separate from it.
 */
const SURFACES = {
  card: {
    title: 'text-lg font-bold',
    steps: 'space-y-2.5',
    // The dialog card is `bg-white dark:bg-zinc-900`, so an inset block
    // must not reach for that same dark tone — it would be invisible
    // against the card. This is the treatment the dialog's own segmented
    // pills used.
    next: 'rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 p-3',
    actions: 'flex gap-3',
    close: 'flex-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors',
    secondary: 'w-full rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors',
    primary: {} as const,
  },
  pane: {
    title: 'text-[17px] font-semibold text-zinc-900 dark:text-zinc-100',
    steps: 'space-y-2.5 rounded-2xl bg-white dark:bg-zinc-800 px-4 py-3',
    next: 'rounded-2xl bg-white dark:bg-zinc-800 px-4 py-3',
    actions: 'flex gap-2 pt-1',
    close: 'flex-1 h-11 rounded-full bg-white text-[15px] font-semibold text-zinc-900 shadow-sm '
      + 'hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 transition-colors',
    secondary: 'w-full h-11 rounded-full bg-white text-[15px] font-semibold text-zinc-900 shadow-sm '
      + 'hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 transition-colors',
    primary: { variant: 'pillAccent', size: 'pill' } as const,
  },
} as const;

export function CreateProgress({
  appName,
  mode,
  surface = 'card',
  progress,
  builder = null,
  audience = null,
  openLabel = 'Open app',
  onOpenApp,
  onViewApp,
  onRetry,
  onSetSecrets,
  onClose,
}: CreateProgressProps) {
  const outcome = outcomeOf(progress.status);
  const states = stepStates(progress);
  const look = SURFACES[surface];

  return (
    <div id="create-progress" className="space-y-4">
      <h2 id="create-progress-title" className={look.title}>
        {headline(outcome, mode, appName)}
      </h2>

      <ol id="create-progress-steps" className={look.steps}>
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
        {statusLine(progress, outcome, states, { builder, appName })}
      </p>

      {/*
          QA 2026-09-24 Q32b: the technical reason, one press away rather
          than in the headline copy. A native disclosure, so it needs no
          state and opens with the keyboard as well as a tap.
      */}
      {outcome === 'failed' && progress.errorReason ? (
        <details id="create-progress-details" className="text-xs text-zinc-500 dark:text-zinc-400">
          <summary className="cursor-pointer select-none font-medium text-zinc-600 dark:text-zinc-300">
            Details
          </summary>
          <p className="mt-1.5 font-mono break-words whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">
            {progress.errorReason}
          </p>
        </details>
      ) : null}

      {/*
          Next steps belong under a creation that is going somewhere. Under
          a failure they are noise — the only useful next step there is the
          Retry button below.
      */}
      {outcome === 'failed' ? null : (
        <div id="create-progress-next" className={look.next}>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">
            What happens next
          </p>
          <ol className="space-y-1.5">
            {nextSteps({ builder, audience, mode }).map((line, i) => (
              <li key={line} className="flex gap-2 text-sm text-zinc-600 dark:text-zinc-300">
                <span className="text-zinc-500 dark:text-zinc-500 tabular-nums">{i + 1}.</span>
                <span>{line}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/*
          #13: the bot is building the first version, so the primary act is
          its DM; the app is one press away too, above the footer.
      */}
      {outcome === 'live' && builder === 'bot' && onViewApp ? (
        <button type="button" id="create-progress-view-app" className={look.secondary} onClick={onViewApp}>
          Open app
        </button>
      ) : null}

      <div className={look.actions}>
        <button
          type="button"
          id="create-progress-close"
          className={look.close}
          onClick={onClose}
        >
          {outcome === 'pending' ? 'Close' : 'Done'}
        </button>
        {outcome === 'live' ? (
          <Button type="button" id="create-progress-primary" layout="flex" {...look.primary} onClick={onOpenApp}>
            {openLabel}
          </Button>
        ) : null}
        {outcome === 'needs-secrets' ? (
          <Button type="button" id="create-progress-primary" layout="flex" {...look.primary} onClick={onSetSecrets}>
            Set secrets
          </Button>
        ) : null}
        {outcome === 'failed' ? (
          <Button type="button" id="create-progress-primary" layout="flex" {...look.primary} onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}
