import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message } from "../../lib/i18n/react";
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
  if (outcome === 'live') return tr("core:value1_is_live_558192c9", { value1: appName });
  if (outcome === 'needs-secrets') return tr("core:almost_there_750a358a");
  if (outcome === 'failed') return tr("core:couldn_t_finish_value1_1f1b4d69", { value1: appName });
  if (mode === 'fork') return tr("core:remixing_value1_a4e3f0e9", { value1: appName });
  return mode === 'import' ? tr("core:importing_value1_29346477", { value1: appName }) : tr("core:creating_value1_aadd2bc7", { value1: appName });
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
      return tr("core:value1_is_set_up_homeroom_bot_is_building_its_fi_26ef8ba0", { value1: appName })
        + tr("core:and_will_message_you_when_it_s_ready_to_try_7410ba39");
    }
    if (builder === 'request') return tr("core:your_project_is_ready_its_first_request_is_waiti_b405b8ae");
    return tr("core:your_app_is_running_open_it_to_see_what_it_shipp_a589a244");
  }
  if (outcome === 'needs-secrets') {
    const keys = progress.missingSecrets || [];
    return keys.length
      ? tr("core:set_value1_and_your_app_will_finish_starting_034eb2fd", { value1: keys.join(', ') })
      : tr("core:set_the_required_secrets_and_your_app_will_finis_c29ccd4e");
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
      return tr("core:setup_stopped_before_your_app_was_running_retryi_6595de14");
    }
    const failed = CREATION_STEPS[states.indexOf('failed')]?.key;
    return failed === 'build'
      ? tr("core:the_build_didn_t_finish_try_again_or_ask_an_admi_e5a3039a")
      : tr("core:setup_didn_t_finish_try_again_or_ask_an_admin_63666f42");
  }
  return tr("core:this_usually_takes_under_a_minute_you_can_close__499623ab");
}

/** The last next step on a project that is Just you: the one vote is yours. */
const SOLO_APPROVE = () => tr("workshop:you_approve_it_and_it_goes_live_175d9d0d");

/** The three things to do next, once there is an app to do them to. */
const NEXT_STEPS = () => ([
  tr("core:open_your_app_and_try_what_it_shipped_with_671fda3a"),
  tr("core:describe_a_change_in_chat_and_a_coding_agent_wri_86bbaf54"),
  tr("core:collaborators_vote_it_in_and_it_goes_live_e7f385f9"),
] as const);

/**
 * What happens next, in the order it happens (#14). The fixed three lines
 * told somebody whose first version the Homeroom bot was already building
 * to open the starter and describe a change, and told somebody making a
 * project for just themselves that collaborators vote. Who builds from the
 * description decides the first two lines, and who the project is for the
 * last: on a Just me project the one vote is the creator's
 * (services/active-users.js counts its one member, so one Yes merges). A
 * fork (a "remix") always starts as Just you (POST /api/apps/:slug/fork), so
 * its last line is the Just me one. Exported and pure for
 * tests/create-progress-view.test.js.
 */
export function nextSteps({ builder = null, audience = null, mode = 'new' }: {
  builder?: Builder;
  audience?: Audience | null;
  mode?: 'new' | 'import' | 'fork';
} = {}): readonly string[] {
  if (mode === 'fork') return [NEXT_STEPS()[0], NEXT_STEPS()[1], SOLO_APPROVE()];
  const approve = audience === 'solo' ? SOLO_APPROVE()
    : audience ? tr("core:members_vote_it_in_and_it_goes_live_11f3e23a") : NEXT_STEPS()[2];
  if (builder === 'bot') {
    return [
      tr("core:homeroom_bot_builds_the_first_version_from_your__f7034c44"),
      tr("core:it_messages_you_in_your_chat_when_it_s_ready_and_aed60f06"),
      approve,
    ];
  }
  if (builder === 'request') {
    return [
      tr("core:your_description_is_the_project_s_first_request_ab4fad37"),
      tr("core:start_a_change_from_it_and_a_coding_agent_writes_98291a27"),
      approve,
    ];
  }
  return [NEXT_STEPS()[0], NEXT_STEPS()[1], approve];
}

/**
 * The two surfaces, keyed by `surface`. Every string a complete literal, for
 * the extractor. The pane's cards are `dark:bg-zinc-800` for the reason
 * create-app.tsx gives: the pane ground is darker than the page ground in
 * dark mode, and the language's zinc-900 card did not separate from it.
 */
const SURFACES = {
  card: {
    get title() { return tr("core:text_lg_font_bold_c67825c4"); },
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
    get title() { return tr("core:text_17px_font_semibold_text_zinc_900_dark_text__6a4f07fa"); },
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
  openLabel = tr("core:open_app_e51c6b48"),
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
          <summary className="cursor-pointer select-none font-medium text-zinc-600 dark:text-zinc-300"><Message id="core:details_45989de4" /></summary>
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
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2"><Message id="core:what_happens_next_8f9b77e6" /></p>
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
        <button type="button" id="create-progress-view-app" className={look.secondary} onClick={onViewApp}><Message id="core:open_app_e51c6b48" /></button>
      ) : null}

      <div className={look.actions}>
        <button
          type="button"
          id="create-progress-close"
          className={look.close}
          onClick={onClose}
        >
          <LocalizedValue render={() => (outcome === 'pending' ? tr("core:close_7d9eb7ac") : tr("core:done_11a6767d"))} />
        </button>
        {outcome === 'live' ? (
          <Button type="button" id="create-progress-primary" layout="flex" {...look.primary} onClick={onOpenApp}>
            {openLabel}
          </Button>
        ) : null}
        {outcome === 'needs-secrets' ? (
          <Button type="button" id="create-progress-primary" layout="flex" {...look.primary} onClick={onSetSecrets}><Message id="core:set_secrets_b123ebdd" /></Button>
        ) : null}
        {outcome === 'failed' ? (
          <Button type="button" id="create-progress-primary" layout="flex" {...look.primary} onClick={onRetry}><Message id="core:retry_942087cc" /></Button>
        ) : null}
      </div>
    </div>
  );
}
